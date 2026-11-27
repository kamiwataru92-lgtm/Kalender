// Kalender Appleカレンダー読み込み API（Vercel のサーバーレス関数）
//
// iCloud の「公開カレンダー」は、ブラウザから直接は読めない（CORS）ため、ここで代わりに読み込み、
// 期間内の予定を JSON にして返す。
//
// 守りの仕組み
//   1. Firebase でログインした人だけが使える（IDトークンを検証する）
//   2. 決めたサイト（ALLOWED_ORIGIN）からの呼び出しだけを受け付ける
//   3. 読みに行けるのは iCloud（*.icloud.com）の https だけ。ほかのサイトには行かない
//   4. 一度に読むカレンダーの数・期間・大きさに上限をつける
//
// 使う環境変数は api/menu.js と同じ（FIREBASE_PROJECT_ID、ALLOWED_ORIGIN）。追加の設定は不要。

import { createRemoteJWKSet, jwtVerify } from "jose";
import { parseCalendar } from "./_ical.js";

const GOOGLE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

const MAX_CALENDARS = 5;
const MAX_DAYS = 400;
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

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

// webcal:// も https:// に直し、iCloud のアドレスだけを通す
export function normalizeCalendarUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim().replace(/^webcals?:\/\//i, "https://"));
  } catch (error) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (host !== "icloud.com" && !host.endsWith(".icloud.com")) return null;
  return url.toString();
}

function isDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

async function fetchCalendar(startUrl) {
  let url = startUrl;

  // iCloud は別のサーバー（pXX-caldav.icloud.com）へ案内することがあるので、
  // リダイレクトは自分でたどり、行き先が iCloud のときだけついていく
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "text/calendar, */*" }
    });

    if (response.status >= 300 && response.status < 400) {
      const next = normalizeCalendarUrl(new URL(response.headers.get("location") || "", url).toString());
      if (!next) throw new Error("redirect-blocked");
      url = next;
      continue;
    }

    return readBody(response);
  }

  throw new Error("too-many-redirects");
}

async function readBody(response) {
  if (!response.ok) {
    const error = new Error(`http-${response.status}`);
    error.status = response.status;
    throw error;
  }

  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_BYTES) throw new Error("too-large");

  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("too-large");
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not-calendar");
  return text;
}

function errorMessage(error) {
  if (error?.status === 404 || error?.status === 403) {
    return "カレンダーが見つかりません。公開をやめたか、リンクが変わった可能性があります";
  }
  if (error?.name === "TimeoutError") return "iCloudからの応答がありませんでした";
  if (error?.message === "not-calendar") return "カレンダーのリンクではないようです";
  if (error?.message === "too-large") return "カレンダーが大きすぎて読み込めません";
  return "読み込めませんでした";
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

  const body = typeof req.body === "string" ? safeJSON(req.body) : (req.body || {});
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, MAX_CALENDARS) : [];
  const { from, to } = body;

  if (!isDateString(from) || !isDateString(to) || from > to) {
    res.status(400).json({ error: "期間の指定が正しくありません" });
    return;
  }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) {
    res.status(400).json({ error: "期間が長すぎます" });
    return;
  }

  const calendars = await Promise.all(
    urls.map(async raw => {
      const url = normalizeCalendarUrl(raw);
      if (!url) {
        return { url: String(raw || ""), ok: false, error: "iCloudの公開カレンダーのリンクではありません" };
      }

      try {
        const ics = await fetchCalendar(url);
        const { name, events } = parseCalendar(ics, from, to);
        return { url: String(raw), ok: true, name, events };
      } catch (error) {
        console.error("calendar fetch failed", error?.message || error);
        return { url: String(raw), ok: false, error: errorMessage(error) };
      }
    })
  );

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ calendars });
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return {};
  }
}
