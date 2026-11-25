// Kalender クラウド同期（Firebase Authentication + Cloud Firestore）
//
// データの置き場所：users/{ログインしたユーザーのID}/data/{保存キー}
//   { json: "<localStorage と同じ JSON 文字列>", updatedAt: <サーバー時刻> }
//
// 画面は今までどおり localStorage のデータで動き、ログイン中だけ
// 保存のたびにクラウドへ書き込み、ほかの端末の変更をリアルタイムで受け取る。

const FIREBASE_VERSION = "10.14.1";
const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
const SYNCED_USER_KEY = "kalender-sync-uid-v1";

const K = window.Kalender;
const syncBar = document.getElementById("syncBar");
const syncText = document.getElementById("syncText");
const loginButton = document.getElementById("loginButton");
const logoutButton = document.getElementById("logoutButton");
const choiceDialog = document.getElementById("syncChoice");

function setStatus(text) {
  syncText.textContent = text;
}

function readMarker() {
  try {
    return localStorage.getItem(SYNCED_USER_KEY);
  } catch (error) {
    return null;
  }
}

function writeMarker(uid) {
  try {
    localStorage.setItem(SYNCED_USER_KEY, uid);
  } catch (error) {
    // 次回も「はじめての同期」として扱われるだけ
  }
}

// クラウドと端末の両方にデータがあるとき、どちらを使うか聞く
function askDirection() {
  return new Promise(resolve => {
    const buttons = choiceDialog.querySelectorAll("button");

    const onClick = event => {
      buttons.forEach(button => button.removeEventListener("click", onClick));
      choiceDialog.removeEventListener("cancel", onCancel);
      choiceDialog.close();
      resolve(event.currentTarget.value);
    };

    // Esc などで閉じたら安全なほう（クラウドを使う）
    const onCancel = () => {
      buttons.forEach(button => button.removeEventListener("click", onClick));
      resolve("download");
    };

    buttons.forEach(button => button.addEventListener("click", onClick));
    choiceDialog.addEventListener("cancel", onCancel, { once: true });
    choiceDialog.showModal();
  });
}

async function start() {
  if (!K) return;

  let firebaseConfig = null;
  try {
    ({ firebaseConfig } = await import("./firebase-config.js"));
  } catch (error) {
    console.info("firebase-config.js が読み込めないため、クラウド同期はオフです", error);
    return;
  }

  if (!firebaseConfig) return; // 未設定：この端末だけで使う

  syncBar.classList.remove("hidden");
  setStatus("☁️ 読み込み中…");

  let app, auth, fs;
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`)
    ]);

    app = appMod.initializeApp(firebaseConfig);
    auth = authMod;
    fs = fsMod;
  } catch (error) {
    console.error("Firebase を読み込めませんでした", error);
    setStatus("☁️ 同期を開始できませんでした（オフラインかも）");
    return;
  }

  const authInstance = auth.getAuth(app);
  authInstance.languageCode = "ja";

  // AI献立提案（ai-menu.js）が「ログインした本人の証明」をもらうための窓口
  K.isLoggedIn = () => Boolean(authInstance.currentUser);
  K.getIdToken = async () => (authInstance.currentUser ? authInstance.currentUser.getIdToken() : null);

  // オフライン中の変更も IndexedDB に残し、つながったら送る
  let db;
  try {
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({
        tabManager: fs.persistentMultipleTabManager()
      })
    });
  } catch (error) {
    console.warn("オフライン保存が使えないため、通常モードで同期します", error);
    db = fs.getFirestore(app);
  }

  let unsubscribe = null;

  loginButton.addEventListener("click", async () => {
    const provider = new auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(authInstance, provider);
    } catch (error) {
      if (
        error.code === "auth/popup-blocked" ||
        error.code === "auth/operation-not-supported-in-this-environment"
      ) {
        await auth.signInWithRedirect(authInstance, provider);
        return;
      }
      if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
        console.error(error);
        alert("ログインできませんでした。\n" + (error.code || error.message));
      }
    }
  });

  logoutButton.addEventListener("click", async () => {
    if (!confirm("ログアウトしますか？\nこの端末のデータはそのまま残り、同期だけ止まります。")) return;
    await auth.signOut(authInstance);
  });

  // リダイレクトでログインしたときのエラーを拾う
  auth.getRedirectResult(authInstance).catch(error => {
    console.error(error);
    alert("ログインできませんでした。\n" + (error.code || error.message));
  });

  auth.onAuthStateChanged(authInstance, async user => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    K.setCloudSaver(null);
    window.dispatchEvent(new CustomEvent("kalender-auth", { detail: { loggedIn: Boolean(user) } }));

    if (!user) {
      setStatus("☁️ ログインするとスマホとPCで同期できます");
      loginButton.classList.remove("hidden");
      logoutButton.classList.add("hidden");
      return;
    }

    loginButton.classList.add("hidden");
    logoutButton.classList.remove("hidden");
    setStatus("☁️ 同期の準備中…");

    try {
      await connect(user);
      setStatus(`☁️ 同期オン（${user.email || "ログイン中"}）`);
    } catch (error) {
      console.error("同期に失敗しました", error);
      setStatus("☁️ 同期に失敗しました。再読み込みしてください");
    }
  });

  async function connect(user) {
    const col = fs.collection(db, "users", user.uid, "data");

    // クラウドの現在のデータ
    const snapshot = await fs.getDocs(col);
    const cloud = {};
    snapshot.forEach(docSnap => {
      const json = docSnap.data().json;
      if (K.SYNC_KEYS.includes(docSnap.id) && typeof json === "string") {
        cloud[docSnap.id] = json;
      }
    });

    const cloudEmpty = Object.keys(cloud).length === 0;
    const firstTimeHere = readMarker() !== user.uid;

    let direction = "download";
    if (cloudEmpty) {
      direction = "upload";
    } else if (firstTimeHere && K.hasLocalData()) {
      direction = await askDirection();
    }

    if (direction === "upload") {
      // この端末のデータをクラウドへ
      const batch = fs.writeBatch(db);
      K.SYNC_KEYS.forEach(key => {
        const json = K.getLocal(key);
        if (json !== null) {
          batch.set(fs.doc(col, key), { json, updatedAt: fs.serverTimestamp() });
        } else if (key in cloud) {
          batch.delete(fs.doc(col, key));
        }
      });
      await batch.commit();
    } else {
      // クラウドのデータをこの端末へ
      if (firstTimeHere && K.hasLocalData()) {
        K.backupLocal();
      }

      const changes = { ...cloud };
      const toUpload = [];

      K.SYNC_KEYS.forEach(key => {
        if (key in cloud) return;
        if (firstTimeHere) {
          changes[key] = null; // クラウドに無いものは消して揃える
        } else {
          const json = K.getLocal(key);
          if (json !== null) toUpload.push([key, json]); // クラウドに無いものは送る
        }
      });

      K.applyRemote(changes);

      if (toUpload.length) {
        const batch = fs.writeBatch(db);
        toUpload.forEach(([key, json]) => {
          batch.set(fs.doc(col, key), { json, updatedAt: fs.serverTimestamp() });
        });
        await batch.commit();
      }
    }

    writeMarker(user.uid);

    // 以後の保存はクラウドにも書く
    K.setCloudSaver((key, json) => {
      fs.setDoc(fs.doc(col, key), { json, updatedAt: fs.serverTimestamp() }).catch(error => {
        console.error(`${key} をクラウドに保存できませんでした`, error);
        setStatus("☁️ クラウドに保存できませんでした。再読み込みしてください");
      });
    });

    // ほかの端末の変更をリアルタイムで受け取る
    unsubscribe = fs.onSnapshot(
      col,
      snap => {
        const changes = {};
        snap.docChanges().forEach(change => {
          // 自分の書き込み（まだ送信中）は無視
          if (change.doc.metadata.hasPendingWrites) return;
          if (!K.SYNC_KEYS.includes(change.doc.id)) return;

          if (change.type === "removed") {
            changes[change.doc.id] = null;
          } else if (typeof change.doc.data().json === "string") {
            changes[change.doc.id] = change.doc.data().json;
          }
        });

        if (Object.keys(changes).length) {
          K.applyRemote(changes);
        }
      },
      error => {
        console.error("リアルタイム同期が止まりました", error);
        setStatus("☁️ 同期が止まりました。再読み込みしてください");
      }
    );
  }
}

start();
