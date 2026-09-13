// 終学活ノート — 文字起こしの中継サーバー
// Supabase Edge Function（関数名: transcribe）にこのまま貼りつけてください。
//
// やっていること: アプリから送られてきた30秒ぶんの音を、
// 音声認識の会社へ横流しして、返ってきた文字だけをアプリに返す。
// APIキーはこのサーバーの中だけにあり、アプリ側からは見えません。
//
// 使う環境変数（Secrets）
//   APP_PASS        … 自分で決める合言葉（アプリの設定にも同じものを入れる）
//   DEEPGRAM_KEY    … Deepgram のAPIキー
//   ASSEMBLYAI_KEY  … AssemblyAI のAPIキー
//   OPENAI_KEY      … OpenAI のAPIキー（使うときだけ）
//   OPENAI_MODEL    … 省略可。既定は gpt-4o-mini-transcribe

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-engine, x-pass, x-test, x-token, x-state, x-shot, x-id, x-train, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });

function extOf(type: string) {
  if (type.includes("mp4") || type.includes("m4a")) return "mp4";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  return "webm";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTで送ってください" }, 405);

  // 貼り付けのときに紛れこむ前後の空白・改行を落とす
  const env = (n: string) => (Deno.env.get(n) ?? "").trim();

  const PASS = env("APP_PASS");
  if (PASS && (req.headers.get("x-pass") ?? "").trim() !== PASS) {
    return json({ error: "合言葉がちがいます" }, 401);
  }

  const DG = env("DEEPGRAM_KEY");
  const AAI = env("ASSEMBLYAI_KEY");
  const OAI = env("OPENAI_KEY");

  // つながるか試す（鍵が本当に通るところまで確かめる）
  if (req.headers.get("x-test") === "1") {
    const checks: Record<string, unknown>[] = [];

    const look = async (
      id: string,
      key: string,
      name: string,
      probe: () => Promise<Response>,
    ) => {
      if (!key) {
        checks.push({ id, ok: false, msg: `${name} が登録されていません`, len: 0, tail: "" });
        return;
      }
      try {
        const r = await probe();
        checks.push({
          id,
          ok: r.ok,
          msg: r.ok ? "鍵は有効です" : `鍵が拒否されました（${r.status}）`,
          len: key.length,
          tail: key.slice(-4),
        });
      } catch (e) {
        checks.push({ id, ok: false, msg: `確かめられません（${String(e)}）`, len: key.length, tail: key.slice(-4) });
      }
    };

    await look("deepgram", DG, "DEEPGRAM_KEY", () =>
      fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${DG}` } }));
    await look("assemblyai", AAI, "ASSEMBLYAI_KEY", () =>
      fetch("https://api.assemblyai.com/v2/transcript?limit=1", { headers: { authorization: AAI } }));
    await look("openai", OAI, "OPENAI_KEY", () =>
      fetch("https://api.openai.com/v1/models?limit=1", { headers: { Authorization: `Bearer ${OAI}` } }));

    return json({
      ok: true,
      ready: checks.filter((c) => c.ok).map((c) => c.id),
      checks,
    });
  }

  // リアルタイム用の使い捨て合鍵を発行する
  // （アプリはこれでDeepgramに直接つなぐ。1分で期限切れになるので漏れても安全）
  if (req.headers.get("x-token") === "1") {
    if (!DG) return json({ error: "DEEPGRAM_KEY が登録されていません" }, 400);
    const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${DG}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    const d = await r.json();
    if (!r.ok) {
      return json({ error: d?.err_msg ?? `合鍵をもらえません（Deepgram ${r.status}）` }, 502);
    }
    return json({ access_token: d.access_token, expires_in: d.expires_in });
  }

  // ---------------- 端末どうしの同期 ----------------
  // Supabaseが自動で用意する鍵を使い、この関数の中だけでストレージを読み書きする
  const SB = env("SUPABASE_URL");
  const SRK = env("SUPABASE_SERVICE_ROLE_KEY");
  const BUCKET = "gakkatsu";

  const sbHead = () => ({ Authorization: `Bearer ${SRK}`, apikey: SRK });

  async function ensureBucket() {
    try {
      await fetch(`${SB}/storage/v1/bucket`, {
        method: "POST",
        headers: { ...sbHead(), "content-type": "application/json" },
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
      });
    } catch { /* すでにあるときはそのまま */ }
  }
  async function objGet(path: string): Promise<string | null> {
    const r = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, { headers: sbHead() });
    return r.ok ? await r.text() : null;
  }
  async function objPut(path: string, body: string): Promise<boolean> {
    const url = `${SB}/storage/v1/object/${BUCKET}/${path}`;
    const h = { ...sbHead(), "content-type": "text/plain;charset=utf-8", "x-upsert": "true" };
    let r = await fetch(url, { method: "POST", headers: h, body });
    if (!r.ok) r = await fetch(url, { method: "PUT", headers: h, body });
    return r.ok;
  }

  const st = req.headers.get("x-state");
  if (st) {
    if (!SB || !SRK) return json({ error: "この関数からストレージを使えません" }, 500);
    if (st === "get") {
      const t = await objGet("state.json");
      if (!t) return json({ t: 0, json: "" });
      try { return json(JSON.parse(t)); } catch { return json({ t: 0, json: "" }); }
    }
    if (st === "put") {
      await ensureBucket();
      const body = await req.text();
      return (await objPut("state.json", body))
        ? json({ ok: true })
        : json({ error: "預かれませんでした" }, 502);
    }
    return json({ error: "x-state は get か put です" }, 400);
  }

  const sh = req.headers.get("x-shot");
  if (sh) {
    if (!SB || !SRK) return json({ error: "この関数からストレージを使えません" }, 500);
    const id = (req.headers.get("x-id") ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
    if (!id) return json({ error: "写真のIDがありません" }, 400);
    if (sh === "get") return json({ d: (await objGet(`shots/${id}`)) ?? "" });
    if (sh === "put") {
      await ensureBucket();
      const d = await req.text();
      return (await objPut(`shots/${id}`, d)) ? json({ ok: true }) : json({ error: "預かれませんでした" }, 502);
    }
    return json({ error: "x-shot は get か put です" }, 400);
  }

  // ---------------- 電車の運行情報 ----------------
  // 各社の公開ページをサーバー側で読んで、状態だけを返す。
  // ブラウザから直接は読めない（CORS）ため、ここを通す。
  if (req.headers.get("x-train") === "1") {
    const strip = (h: string) =>
      h.replace(/<script[\s\S]*?<\/script>/g, " ")
       .replace(/<style[\s\S]*?<\/style>/g, " ")
       .replace(/<[^>]+>/g, " ")
       .replace(/\s+/g, " ");
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (gakkatsu-note personal)" } });
      if (!r.ok) throw new Error(String(r.status));
      return strip(await r.text());
    };
    const out: Record<string, unknown> = {};

    try {
      const t = await get("https://top.meitetsu.co.jp/em/");
      const calm = /遅れはございません|平常(通り|運転)/.test(t);
      out.meitetsu = { ok: true, calm, text: t.slice(0, 300).trim() };
    } catch (e) {
      out.meitetsu = { ok: false, error: String(e) };
    }

    try {
      const t = await get("https://www.kotsu.city.nagoya.jp/rp/emergency/");
      const lines: Record<string, string> = {};
      for (const nm of ["東山線", "名城線", "鶴舞線", "桜通線", "上飯田線"]) {
        const m = t.match(new RegExp(nm + "[^。]{0,40}?(平常運行|運行遅れ|運行中止|運転見合わせ)"));
        if (m) lines[nm] = m[1];
      }
      const when = t.match(/(\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})\s*現在/);
      out.subway = { ok: true, lines, when: when ? when[1] : "" };
    } catch (e) {
      out.subway = { ok: false, error: String(e) };
    }

    return json({ ok: true, ...out });
  }

  // ---------------- ここから音声 ----------------
  const engine = req.headers.get("x-engine") ?? "deepgram";
  const type = req.headers.get("content-type") ?? "audio/webm";
  const audio = new Uint8Array(await req.arrayBuffer());
  if (audio.byteLength < 1000) return json({ error: "音が短すぎます" }, 400);

  try {
    // ---------------- Deepgram ----------------
    if (engine === "deepgram") {
      if (!DG) return json({ error: "DEEPGRAM_KEY が登録されていません" }, 400);
      const url =
        "https://api.deepgram.com/v1/listen" +
        "?model=nova-3&language=ja&smart_format=true&punctuate=true";
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Token ${DG}`, "Content-Type": type },
        body: audio,
      });
      const d = await r.json();
      if (!r.ok) return json({ error: d?.err_msg ?? `Deepgram ${r.status}` }, 502);
      const text = d?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      return json({ text, engine });
    }

    // ---------------- OpenAI ----------------
    if (engine === "openai") {
      if (!OAI) return json({ error: "OPENAI_KEY が登録されていません" }, 400);
      const fd = new FormData();
      fd.append("file", new Blob([audio], { type }), `audio.${extOf(type)}`);
      fd.append("model", env("OPENAI_MODEL") || "gpt-4o-mini-transcribe");
      fd.append("language", "ja");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OAI}` },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) return json({ error: d?.error?.message ?? `OpenAI ${r.status}` }, 502);
      return json({ text: d.text ?? "", engine });
    }

    // ---------------- AssemblyAI ----------------
    if (engine === "assemblyai") {
      if (!AAI) return json({ error: "ASSEMBLYAI_KEY が登録されていません" }, 400);

      const up = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: { authorization: AAI },
        body: audio,
      });
      const u = await up.json();
      if (!up.ok) return json({ error: u?.error ?? `AssemblyAI ${up.status}` }, 502);

      const cr = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: AAI, "content-type": "application/json" },
        body: JSON.stringify({ audio_url: u.upload_url, language_code: "ja" }),
      });
      const c = await cr.json();
      if (!cr.ok) return json({ error: c?.error ?? `AssemblyAI ${cr.status}` }, 502);

      // できあがるまで待つ。短い音ほど早く終わるので、細かく見に行く
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 600 : 400));
        const pr = await fetch(`https://api.assemblyai.com/v2/transcript/${c.id}`, {
          headers: { authorization: AAI },
        });
        const p = await pr.json();
        if (p.status === "completed") return json({ text: p.text ?? "", engine });
        if (p.status === "error") return json({ error: p.error ?? "AssemblyAI エラー" }, 502);
      }
      return json({ error: "時間内に終わりませんでした" }, 504);
    }

    return json({ error: `知らないエンジンです: ${engine}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
