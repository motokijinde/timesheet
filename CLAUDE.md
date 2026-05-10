# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

社内の勤務時間報告を簡略化するための個人用 PWA。スマホでボタンをポチるだけで「出社/在宅で開始」「作業を終了する」を記録し、Teams 用のテキストをクリップボードにコピー、同時に Google スプレッドシートへ同期する。

詳細は [`README.md`](./README.md) を参照。

## アーキテクチャ

3 層構成。**ビルドパイプラインは無く、ファイルを直接編集する**。

```
[ブラウザ / iOS ホーム画面の PWA]
  index.html + script.js + style.css + sw.js  ←  静的ホスティング (例: GitHub Pages)
        │  fetch (GET=取得 / POST=書込)、応答は JSON ({ ok, ... })
        ▼
[Google Apps Script ウェブアプリ]   ← code.gas をデプロイ
        │  SpreadsheetApp
        ▼
[Google スプレッドシート]   ← ユーザーごとに 1 シート
```

- **`index.html` / `style.css` / `script.js`**: フロント本体。フレームワーク無しのバニラ JS。
- **`sw.js`**: Service Worker。 HTML は network-first、その他のアセットは stale-while-revalidate。 GAS API (`script.google.com/macros`) はバイパス + オフライン時は `{ ok:false, error:'offline' }` JSON を返す。
- **`manifest.json` / `icon.png`**: PWA インストール用。
- **`code.gas`**: Google Apps Script 側の `doGet`/`doPost`。ローカルでは実行されない。Apps Script エディタに貼って「ウェブアプリとしてデプロイ」する。

### データフロー上の重要な前提

1. **POST は CORS (mode: 通常) で JSON 応答を読む**。 `Content-Type: text/plain` で送ることで preflight を回避しつつ `{ok: true/false, error?}` を解釈する。 失敗 (HTTP エラー or ok=false) ならキューを `failed` 状態にして指数バックオフで再送する。
2. **同期キュー (`syncQueue`) は `localStorage` に永続化** されている。 各エントリは `{ id, user, date, payload, status, retryCount, lastError? }` 形式。 同じ日付への未処理リクエストは新しいもので上書き。 `online` イベントで `failed` → `pending` に戻して即時再送する。
3. **キュー owner 検証**: `syncQueue` の各エントリに作成時のユーザー名 (`user`) が記録されており、 送信時に `currentUser !== item.user` なら破棄する。 ログアウト忘れ → 別ユーザーログイン時の誤送信を防ぐ。
4. **キャッシュフォールバック**: 通信失敗時は `cached_work_data` (本体) と `cached_holidays` (年跨ぎ累積祝日マップ) をマージし、 さらに `syncQueue` を上に重ねて表示する。 サーバー値とローカル変更がぶつかったら **ローカル優先**。
5. **ログアウト時に localStorage を全消去** する (`STORAGE_KEYS` に登録された全キー)。 `cached_work_data` `cached_holidays` `work_sync_queue` `work_last_viewed_month` も含めて消す。
6. **祝日は GAS が `holidays-jp.github.io` API から取得** し、 表示中の年 ±1 をマージしてレスポンスに含める。 フロントは別キャッシュ (`cached_holidays`) で年跨ぎオフラインに対応する。
7. **認証は `?p=<APP_PASS>&u=<user>` (GET) または ボディの `password` (POST)**。 `code.gas` は `PropertiesService.getScriptProperties().getProperty('APP_PASS')` を優先し、 未設定時のみ `FALLBACK_PASS` 定数を使う。
8. **スプレッドシートはユーザー名でシートを分ける**。 列は `[日付, 場所, 開始, 終了, 休暇種別]` の 5 列固定 (`SHEET_HEADER`)。 列 A は `yyyy-MM-dd` 表示形式に固定。
9. **休暇種別は `VACATION_TYPES` 定数で集中管理**。 全日 (`有給休暇` 等 6 種類) と半休 (`午前半休`/`午後半休`) を列挙し、 フロント (`script.js`) と GAS (`code.gas`) の両方に同名の定数がある。

## よく使う開発フロー

### フロントの動作確認

ビルドは不要。Service Worker の登録条件 (`http://localhost` または `https://` 必須) を満たすため、ローカルでは簡易サーバを立てる:

```sh
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

### Service Worker のキャッシュを更新

アセット (`index.html` / `script.js` / `style.css`) を編集したら **`sw.js:CACHE_VERSION` をバンプする**。 SW は HTML だけ network-first にしているため、HTML の変更は比較的すぐ届くが、JS/CSS の変更を確実に届けるためにはバージョンバンプが必要。

新 SW がアクティブになると `script.js` の `controllerchange` ハンドラが自動的に `location.reload()` を呼び、 ユーザー操作なしで最新版に切り替わる。

### バックエンド (`code.gas`) の更新

1. Google Apps Script エディタを開く (対象スプレッドシートの「拡張機能 → Apps Script」)。
2. `code.gas` の中身を貼り直す。
3. 「デプロイ → デプロイを管理 → 編集 → 新しいバージョン」で公開。 URL は変わらないため `script.js:GAS_URL` は通常編集不要。
4. 初回のみ「スクリプトのプロパティ」で `APP_PASS` を設定する。 (省略時は `FALLBACK_PASS = 'passwd'`)
5. 動作確認は実機 (またはローカルサーバ経由) から。 デプロイ直後はコールドスタートで遅い (`LOAD_TIMEOUT_MS = 15_000` を設定している理由)。

### パスワードを変えるとき

Apps Script のスクリプトプロパティ画面で `APP_PASS` を上書きする。 フロント側はユーザーがログイン画面で入力した値を `localStorage` に保存するだけなので、コード変更は不要。

### 休暇種別を変えるとき

`script.js:VACATION_TYPES` と `code.gas:VACATION_TYPES` を同時に更新する。 既存スプレッドシートの E 列にある旧文字列との互換が必要なら、移行スクリプトを別途用意するか配列に追記する。

## 注意点

- **テスト・リンタ・ビルドツールは無い**。導入されていない物を勝手に追加しない。
- **`script.js` は単一ファイルで完結している**。モジュール分割や bundler 導入は要件外。
- **POST は CORS で JSON を読み、 `mode: "no-cors"` は使わない**。 これにより GAS 側のエラー (`{ok:false, error:...}`) が検出できる。 旧コードは `no-cors` を使っていたので動作が変わっている点に注意。
- **`GAS_URL` はリポジトリにそのまま含まれている**。 `APP_PASS` は Properties Service に置くこと。 リポジトリを公開する/共有する際は要注意。
- 祝日 API の取得失敗時は空オブジェクトを返す (`code.gas:getHolidays_`)。 祝日表示が消えただけでは原因切り分けにならないため、Apps Script のログを確認する。
- innerHTML を使った描画は **削除済み**。 カレンダー要素は `el_()` ヘルパー経由で `textContent` で組み立てる。 新しい動的描画を入れるときも、ユーザー入力や外部 API 由来の文字列を直接 innerHTML に流し込まないこと (XSS 対策)。

## 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [`README.md`](./README.md) | アーキテクチャ・データモデル・API 仕様・運用手順 (本ドキュメントも兼ねる) |
