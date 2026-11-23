// Firebase の共通初期化（クラウド同期と晩ごはんAIの両方から使う）

export const FIREBASE_VERSION = "13.2.0";
export const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

let appPromise = null;

// firebase-config.js が未設定（null）なら null を返す。
// SDK が読み込めない（オフラインなど）ときは例外を投げる。
export function loadFirebaseApp() {
  if (!appPromise) {
    appPromise = (async () => {
      let firebaseConfig = null;
      try {
        ({ firebaseConfig } = await import("./firebase-config.js"));
      } catch (error) {
        console.info("firebase-config.js が読み込めないため、Firebase はオフです", error);
        return null;
      }

      if (!firebaseConfig) return null;

      const { initializeApp } = await import(`${SDK}/firebase-app.js`);
      return initializeApp(firebaseConfig);
    })();

    // 失敗したら次回やり直せるようにする
    appPromise.catch(() => {
      appPromise = null;
    });
  }

  return appPromise;
}
