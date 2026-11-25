// Kalender AI献立提案（画面側）
//
// 気分と苦手な食べ物を api/menu.js に送り、AIが考えた献立を3つ表示する。
// APIキーはサーバー側にだけあり、ここでは「ログインした本人の証明（IDトークン）」だけを送る。

const DISLIKES_KEY = "kalender-food-dislikes-v1";

const K = window.Kalender;
const box = document.getElementById("aiMenuBox");
const form = document.getElementById("aiMenuForm");
const requestInput = document.getElementById("aiMenuRequest");
const dislikesInput = document.getElementById("aiMenuDislikes");
const button = document.getElementById("aiMenuButton");
const note = document.getElementById("aiMenuNote");
const list = document.getElementById("aiMenuList");

function setNote(text) {
  note.textContent = text;
  note.classList.toggle("hidden", !text);
}

function showMenus(menus) {
  list.replaceChildren();
  menus.forEach(menu => {
    const item = document.createElement("li");

    const name = document.createElement("strong");
    name.textContent = menu.name;
    item.append(name);

    if (menu.why) {
      const why = document.createElement("p");
      why.textContent = menu.why;
      item.append(why);
    }
    if (menu.tip) {
      const tip = document.createElement("p");
      tip.className = "muted";
      tip.textContent = `💡 ${menu.tip}`;
      item.append(tip);
    }
    list.append(item);
  });
}

// ログイン状態に合わせて、ボタンを使えるかどうか切り替える
function updateLoginState(loggedIn) {
  button.disabled = !loggedIn;
  if (!loggedIn) {
    setNote("上の「Googleでログイン」をすると使えます");
  } else if (note.textContent.startsWith("上の")) {
    setNote("");
  }
}

async function start() {
  if (!K || !box) return;

  let aiEndpoint = null;
  try {
    ({ aiEndpoint } = await import("./ai-config.js"));
  } catch (error) {
    return;
  }
  if (!aiEndpoint) return; // 未設定なら欄ごと出さない

  box.classList.remove("hidden");

  try {
    dislikesInput.value = localStorage.getItem(DISLIKES_KEY) || "";
  } catch (error) {
    // 保存できない環境では毎回入力するだけ
  }

  updateLoginState(Boolean(K.isLoggedIn && K.isLoggedIn()));
  window.addEventListener("kalender-auth", event => updateLoginState(event.detail.loggedIn));

  form.addEventListener("submit", async event => {
    event.preventDefault();

    const token = K.getIdToken ? await K.getIdToken() : null;
    if (!token) {
      updateLoginState(false);
      return;
    }

    try {
      localStorage.setItem(DISLIKES_KEY, dislikesInput.value.trim());
    } catch (error) {
      // 保存できなくても提案はできる
    }

    button.disabled = true;
    button.textContent = "考え中…";
    setNote("");

    try {
      const response = await fetch(aiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          request: requestInput.value,
          dislikes: dislikesInput.value
        })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNote(data.error || "うまくいきませんでした。もう一度試してください");
        return;
      }
      showMenus(data.menus || []);
    } catch (error) {
      console.error(error);
      setNote("通信できませんでした。ネットにつながっているか確認してください");
    } finally {
      button.disabled = false;
      button.textContent = "提案してもらう";
    }
  });
}

start();
