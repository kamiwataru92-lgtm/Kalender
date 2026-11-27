// Kalender Appleカレンダー読み込み（画面側）
//
// 登録した iCloud の公開カレンダーのリンクを api/calendar.js に送り、
// 期間内の予定を受け取って index.html に渡す（表示は index.html 側）。
// サーバーは AI献立提案と同じ Vercel（ai-config.js の URL）を使う。

const K = window.Kalender;
const RETRY_MS = 60 * 1000; // 自動での読み込み直しは、最短でもこの間隔をあける

let endpoint = null;
let running = null;
let lastAttempt = 0;
let lastKey = "";

async function refresh(force = false) {
  if (!K || !endpoint) return;
  if (running) return running;

  const { urls, from, to } = K.appleRequest();
  if (urls.length === 0) return;

  // 同じ内容を何度も読みに行かない（失敗が続いたときに連打しないため）
  const key = JSON.stringify({ urls, from, to });
  if (!force && key === lastKey && Date.now() - lastAttempt < RETRY_MS) return;

  // ログインの仕組みがまだ準備中なら、ログイン結果の通知（kalender-auth）を待つ
  if (!K.isLoggedIn) return;

  if (!K.isLoggedIn()) {
    K.setAppleStatus("login");
    return;
  }

  lastAttempt = Date.now();
  lastKey = key;

  running = (async () => {
    K.setAppleStatus("loading");
    try {
      const token = await K.getIdToken();
      if (!token) {
        K.setAppleStatus("login");
        return;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ urls, from, to })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        K.setAppleStatus("error", data.error || "読み込めませんでした。少し待ってからもう一度試してください");
        return;
      }

      K.setAppleData({ from, to, calendars: data.calendars || [] });
    } catch (error) {
      console.error(error);
      K.setAppleStatus("error", "通信できませんでした。ネットにつながっているか確認してください");
    } finally {
      running = null;
    }
  })();

  return running;
}

async function start() {
  if (!K) return;

  let aiEndpoint = null;
  try {
    ({ aiEndpoint } = await import("./ai-config.js"));
  } catch (error) {
    // 設定ファイルが読めない
  }

  if (!aiEndpoint) {
    K.setAppleStatus("unavailable");
    return;
  }

  // 例：https://kalender-xxxx.vercel.app/api/menu → https://kalender-xxxx.vercel.app/api/calendar
  endpoint = new URL("calendar", aiEndpoint).toString();
  K.refreshApple = refresh;

  window.addEventListener("kalender-auth", event => {
    if (event.detail.loggedIn) refresh(true);
    else if (K.appleRequest().urls.length) K.setAppleStatus("login");
  });

  // アプリに戻ってきたとき、古ければ読み込み直す
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && K.needsAppleRefresh()) refresh();
  });

  // ログインがもう済んでいる場合
  if (K.needsAppleRefresh()) refresh(true);
}

start();
