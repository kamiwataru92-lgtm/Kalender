// Kalender AI献立提案 API（Vercel のサーバーレス関数）
//
// ブラウザ → この関数 → Claude API の順に呼ばれる。
// Claude の APIキーはこの関数の中（Vercel の環境変数）にだけ置き、ブラウザには出さない。
//
// 守りの仕組み
//   1. Firebase でログインした人だけが使える（IDトークンを検証する）
//   2. 決めたサイト（ALLOWED_ORIGIN）からの呼び出しだけを受け付ける
//   3. 入力の長さと、AIの返答の長さに上限をつける
//
// Vercel の環境変数（設定方法は AI_SETUP.md）
//   ANTHROPIC_API_KEY   Claude の APIキー（必須）
//   FIREBASE_PROJECT_ID Firebase のプロジェクトID（例：kalender-abab5）（必須）
//   ALLOWED_ORIGIN      呼び出しを許すサイト（例：https://kamiwataru92-lgtm.github.io）
//   ANTHROPIC_MODEL     使うモデル（省略時は claude-haiku-5-5）

import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

const MAX_INPUT = 200; // 1項目あたりの最大文字数

function setCors(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || "";
  const origin = req.headers.origin || "";
  if (allowed && origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ログインした本人かどうかを、Firebase の IDトークンで確かめる
async function verifyUser(req) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!projectId || !token) return null;

  try {
    const { payload } = await jwtVerify(token, GOOGLE_KEYS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId
    });
    return payload.sub ? payload : null;
  } catch (error) {
    return null;
  }
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_INPUT);
}

function buildPrompt({ request, dislikes }) {
  return [
    "あなたは大学生向けの献立アドバイザーです。",
    "一人暮らしの大学生が、手軽に作れるか、近所で買える食事を3つ提案してください。",
    "",
    `今日の気分・状況：${request || "特になし"}`,
    `苦手な食べ物・避けたいもの：${dislikes || "特になし"}`,
    "",
    "ルール：",
    "- 苦手な食べ物は絶対に使わない",
    "- 気分・状況に合わせる（例：筋トレ中ならたんぱく質を多めに）",
    "- 料理名は短く、理由とひとことポイントは各40文字以内",
    "",
    '次のJSONだけを返してください（前後に説明を書かない）：',
    '{"menus":[{"name":"料理名","why":"おすすめの理由","tip":"作り方や買い方のひとこと"}]}'
  ].join("\n");
}

// AIの返答からJSONを取り出す（前後に余計な文があっても読めるように）
function parseMenus(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const data = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(data.menus)) return null;
    return data.menus.slice(0, 3).map(menu => ({
      name: clean(menu.name),
      why: clean(menu.why),
      tip: clean(menu.tip)
    })).filter(menu => menu.name);
  } catch (error) {
    return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST で呼び出してください" });
    return;
  }

  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    res.status(403).json({ error: "このサイトからは使えません" });
    return;
  }

  const user = await verifyUser(req);
  if (!user) {
    res.status(401).json({ error: "ログインしてから使ってください" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "サーバーにAPIキーが設定されていません" });
    return;
  }

  const body = typeof req.body === "string" ? safeJSON(req.body) : (req.body || {});
  const input = { request: clean(body.request), dislikes: clean(body.dislikes) };

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
        max_tokens: 600,
        messages: [{ role: "user", content: buildPrompt(input) }]
      })
    });

    if (!response.ok) {
      console.error("Claude API error", response.status, await response.text());
      res.status(502).json({ error: "AIに接続できませんでした。少し待ってからもう一度試してください" });
      return;
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("");

    const menus = parseMenus(text);
    if (!menus || !menus.length) {
      res.status(502).json({ error: "AIの返事を読み取れませんでした。もう一度試してください" });
      return;
    }

    res.status(200).json({ menus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "エラーが起きました。もう一度試してください" });
  }
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return {};
  }
}
