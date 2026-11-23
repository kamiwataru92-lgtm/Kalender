// 晩ごはんAI（Firebase AI Logic 経由で Gemini を呼ぶ）
//
// API キーはページに書かず、Firebase プロジェクト側で管理される。
// 画面側（index.html）は window.Kalender.dinnerAI.suggest(prompt) を呼ぶだけ。

import { loadFirebaseApp, SDK } from "./firebase-init.js";

// 上から順に試す（使えないモデルや上限に達したモデルは次へ）
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];

let modelsPromise = null;

async function loadModels() {
  const app = await loadFirebaseApp();
  if (!app) {
    throw new Error("Firebase が設定されていないため、AIを使えません。");
  }

  const { getAI, getGenerativeModel, GoogleAIBackend, Schema } = await import(`${SDK}/firebase-ai.js`);
  const ai = getAI(app, { backend: new GoogleAIBackend() });

  const stringList = description => Schema.array({ items: Schema.string(), description });

  const responseSchema = Schema.object({
    properties: {
      suggestions: Schema.array({
        description: "晩ごはんの提案（3つ）",
        items: Schema.object({
          properties: {
            name: Schema.string({ description: "料理名" }),
            minutes: Schema.integer({ description: "調理時間（分）" }),
            costYen: Schema.integer({ description: "買い足す食材の費用の目安（円）。家にあるもので作れるなら0" }),
            reason: Schema.string({ description: "おすすめの理由（1文）" }),
            haveIngredients: stringList("家にある食材のうち使うもの"),
            buyIngredients: stringList("買い足す必要がある食材"),
            steps: stringList("作り方（3〜6ステップ、各1文）")
          }
        })
      })
    }
  });

  return MODELS.map(name => ({
    name,
    model: getGenerativeModel(ai, {
      model: name,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema
      }
    })
  }));
}

function statusOf(error) {
  return error?.customErrorData?.status;
}

function friendlyError(error) {
  const code = String(error?.code || "");
  const status = statusOf(error);

  if (!navigator.onLine || code.includes("fetch-error")) {
    return "ネットにつながっていないようです。";
  }
  if (code.includes("api-not-enabled") || status === 403) {
    return "Firebase の AI Logic（Gemini API）がまだ有効になっていません。設定手順を確認してください。";
  }
  if (status === 429) {
    return "Gemini の無料枠の上限に達しました。少し時間をおいてから試してください。";
  }
  return "提案を作れませんでした。もう一度試してください。" + (code ? `（${code}）` : "");
}

async function suggest(prompt) {
  if (!modelsPromise) {
    modelsPromise = loadModels();
    modelsPromise.catch(() => {
      modelsPromise = null;
    });
  }

  let models;
  try {
    models = await modelsPromise;
  } catch (error) {
    console.error("晩ごはんAIの準備に失敗しました", error);
    throw new Error(error.message?.startsWith("Firebase が") ? error.message : friendlyError(error));
  }

  let lastError = null;

  for (const { name, model } of models) {
    try {
      const result = await model.generateContent(prompt);
      const data = JSON.parse(result.response.text());
      return { model: name, suggestions: Array.isArray(data.suggestions) ? data.suggestions : [] };
    } catch (error) {
      console.warn(`${name} での提案に失敗しました`, error);
      lastError = error;

      // モデルが無い・混んでいる・上限 → 次のモデルで再挑戦
      const status = statusOf(error);
      if (status === 404 || status === 429 || status === 500 || status === 503 || error instanceof SyntaxError) {
        continue;
      }
      break;
    }
  }

  throw new Error(friendlyError(lastError));
}

if (window.Kalender) {
  window.Kalender.dinnerAI = { suggest };
}
