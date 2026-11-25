# 🍳 AI献立提案の設定（Gemini API + Vercel）

「生活」タブに、気分や苦手な食べ物を入れるとAIが献立を3つ提案してくれる欄を追加します。
所要時間は20分ほどです。設定するまでは、この欄は表示されません。

## しくみ

```
ブラウザ（GitHub Pages の Kalender）
   │  気分・苦手な食べ物 + ログインの証明（Firebase の IDトークン）
   ▼
api/menu.js（Vercel で動く小さなサーバー）
   │  APIキーはここだけに置く
   ▼
Gemini API
```

APIキーをブラウザ側のコードに書くと、誰でも見られて勝手に使われてしまいます。
そのため、キーは Vercel の中だけに置き、ログインした本人からの呼び出しだけを受け付けます。

---

## 1. Gemini の APIキーを作る

1. <https://aistudio.google.com/> を開いて Google アカウントでログイン
2. 「Get API key」→「APIキーを作成」でキーを作ってコピーする
3. 無料枠の範囲なら支払い設定は不要です

> ⚠️ キーは GitHub やチャットに貼らないでください。次の Vercel の画面にだけ入れます。
>
> 無料枠では、送った内容が Google のサービス改善に使われます。気分や苦手な食べ物以外の個人的なことは入れないようにしましょう。

## 2. Vercel に api/menu.js を公開する

1. <https://vercel.com/> を開き、「Continue with GitHub」でログイン
2. 「Add New…」→「Project」→ このリポジトリ（Kalender）の「Import」
3. 「Framework Preset」は **Other** のまま
4. 「Environment Variables」に次の3つを追加（使うモデルを変えたいときは `GEMINI_MODEL` も追加。省略時は `gemini-3.8-flash`）

| Name | Value |
| --- | --- |
| `GEMINI_API_KEY` | 手順1でコピーしたキー |
| `FIREBASE_PROJECT_ID` | `kalender-abab5` |
| `ALLOWED_ORIGIN` | `https://kamiwataru92-lgtm.github.io` |

5. 「Deploy」を押す
6. 完成したら表示される URL（例：`https://kalender-xxxx.vercel.app`）をコピーする

## 3. アプリに URL を入れる

GitHub でこのリポジトリの [`ai-config.js`](ai-config.js) を開いて ✏️ で編集し、

```js
export const aiEndpoint = null;
```

を次のように書き換えてコミットします（URL の最後に `/api/menu` を付ける）。

```js
export const aiEndpoint = "https://kalender-xxxx.vercel.app/api/menu";
```

## 4. 試す

1. いつもの Kalender（`https://kamiwataru92-lgtm.github.io/Kalender/`）を開く
2. 「Googleでログイン」でログインする
3. 「生活」タブの一番下「🍳 ごはん提案（AI）」に気分を入れて「提案してもらう」

## うまくいかないとき

| 表示 | 原因と対処 |
| --- | --- |
| 欄が出てこない | `ai-config.js` がまだ `null`。手順3をやり直す |
| ログインしてから使ってください | ログインしていないか、`FIREBASE_PROJECT_ID` が違う |
| このサイトからは使えません | `ALLOWED_ORIGIN` の綴りが違う（最後に `/` を付けない） |
| サーバーにAPIキーが設定されていません | `GEMINI_API_KEY` が未設定。設定後に Vercel で「Redeploy」 |
| AIに接続できませんでした | キーが間違っている、無料枠の回数制限、またはモデル名が古い（Vercel の「Logs」にエラーの中身が出ます） |

環境変数を変えたら、Vercel の「Deployments」から **Redeploy** すると反映されます。
