# 勤務報告ポチるだけ

社内の勤務時間報告を、 スマホからボタン 1 タップで記録できる個人用 PWA。 打刻した時刻を Google スプレッドシートに保存しつつ、 Teams 報告用テキストをクリップボードへコピーします。

- スタック: バニラ JS PWA + Google Apps Script + Google スプレッドシート
- ホスティング: 任意の静的ホスティング (GitHub Pages / 社内 nginx 等)
- フレームワーク・依存パッケージ: なし (ファイルを編集してそのまま配信)

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [全体アーキテクチャ](#2-全体アーキテクチャ)
3. [データモデル](#3-データモデル)
4. [データフロー](#4-データフロー)
5. [セキュリティモデル](#5-セキュリティモデル)
6. [初回セットアップ](#6-初回セットアップ)
7. [日常運用 / 開発フロー](#7-日常運用--開発フロー)
8. [API 仕様 (GAS エンドポイント)](#8-api-仕様-gas-エンドポイント)
9. [ローカルストレージ仕様](#9-ローカルストレージ仕様)
10. [トラブルシューティング](#10-トラブルシューティング)
11. [既知の制限と将来の改善](#11-既知の制限と将来の改善)
12. [関連ドキュメント](#12-関連ドキュメント)

---

## 1. プロジェクト概要

### 1.1 機能

- **ワンタップ打刻**: 「出社で開始」「在宅で開始」「作業を終了する」の 3 ボタンで現在時刻を記録。 同時に Teams 報告用文字列をクリップボードへコピー。
- **カレンダー編集**: 日付セルをタップして時刻・場所・休暇区分を個別に編集。
- **休暇 / 半休**: 「欠勤/休暇」と「半休」 2 種類の状態をシートに保存。
- **祝日表示**: `holidays-jp.github.io/api` 経由で日本の祝日を背景色 + 名称で表示。
- **オフライン耐性**: ネット切断中の操作はローカルキューに溜め、復帰後に自動同期。
- **Excel エクスポート**: 当月分の TSV をクリップボードへコピーし、Excel に貼り付けて報告書化。
- **PWA**: ホーム画面追加でアプリのように起動。 通信が無くてもキャッシュから起動できる。

### 1.2 ファイル構成

```
timesheet/
├── index.html        # 画面構造 (ログイン画面 / メイン画面 / 編集モーダル)
├── script.js         # フロント全機能 (バニラ JS、約 700 行)
├── style.css         # スタイル (CSS 変数 + シングルファイル)
├── sw.js             # Service Worker (キャッシュ戦略)
├── manifest.json     # PWA マニフェスト
├── icon.png          # 192x192 / 512x512 兼用アイコン
├── code.gas          # Google Apps Script のソース (Apps Script エディタに貼る)
├── README.md         # 本ドキュメント (セットアップ + 仕様まとめ)
└── CLAUDE.md         # AI アシスタント向け運用メモ
```

---

## 2. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│ ブラウザ / iOS ホーム画面 PWA                          │
│                                                     │
│  ┌──────────────┐    ┌──────────────┐               │
│  │  index.html  │ ── │  script.js   │ ── localStorage
│  │  style.css   │    └──────┬───────┘    (キャッシュ│
│  └──────┬───────┘           │             + キュー) │
│         │                   │                       │
│         │  キャッシュ       │  fetch                │
│         ▼                   ▼                       │
│  ┌──────────────┐    ┌──────────────┐               │
│  │  Service     │    │   GAS API    │               │
│  │  Worker      │    │  ?p, u, year │               │
│  │  (sw.js)     │    └──────┬───────┘               │
│  └──────────────┘           │                       │
└─────────────────────────────┼───────────────────────┘
                              │
                  HTTPS (CORS 許可済)
                              │
              ┌───────────────▼───────────────┐
              │ Google Apps Script Web App    │
              │  doGet / doPost (code.gas)    │
              └───────────────┬───────────────┘
                              │ SpreadsheetApp
                              ▼
              ┌───────────────────────────────┐
              │ Google スプレッドシート         │
              │  ユーザーごとに 1 シート         │
              │  [日付, 場所, 開始, 終了, 休暇種別] │
              └───────────────────────────────┘
```

### 2.1 コンポーネントの責務

| コンポーネント | 責務 |
|---|---|
| `index.html` | DOM 構造とフォーム要素。 UI ロジックは持たない。 |
| `script.js` | 状態管理・サーバ通信・楽観的 UI・カレンダー描画・キュー管理。 |
| `style.css` | 視覚スタイル。 z-index は CSS 変数で集中管理。 |
| `sw.js` | アセットキャッシュ + GAS API バイパス + オフラインフォールバック。 |
| `code.gas` | GAS 認証・シート CRUD・祝日 API 呼び出し・JSON レスポンス整形。 |
| Google スプレッドシート | データの正本 (Source of Truth)。 ユーザーごとに 1 シート。 |

### 2.2 ビルド工程

なし。 `script.js` を直接編集して配信する。 ローカル動作確認は `python3 -m http.server 8000` 等で十分。

---

## 3. データモデル

### 3.1 スプレッドシート (1 ユーザー = 1 シート)

| 列 | ヘッダー | 値の例 | 説明 |
|---|---|---|---|
| A | 日付 | `2026-05-10` | `YYYY-MM-DD` で固定。 新規シート作成時に表示形式を固定する。 |
| B | 場所 | `出社` / `在宅` / `新横浜` 等 | 任意文字列。 休暇日は空。 |
| C | 開始 | `09:00` | `HH:mm` (秒は不要)。 |
| D | 終了 | `18:00` | `HH:mm`。 |
| E | 休暇種別 | `有給休暇` / `午前半休` / 空 等 | 休暇 / 半休の判定はこの列のみで行う。 |

**休暇種別の文字列定義** (`script.js` の `VACATION_TYPES`、`code.gas` の `VACATION_TYPES` で同期):

- 全日扱い: `有給休暇`、`特別休暇`、`病気休暇`、`慶弔休暇`、`その他休暇`、`欠勤`
- 半休扱い: `午前半休`、`午後半休`

### 3.2 フロント側 entry オブジェクト

`currentData` の値は次のオブジェクト。 サーバ応答もこれと同じ形を返す。

```ts
type Entry = {
    place: string;          // 勤務場所 (休暇日は "")
    start: string;          // "HH:mm"
    end: string;            // "HH:mm"
    vacationType: string;   // 休暇種別 (上記文字列のいずれか or "")
    isAbsent: boolean;      // 全日休暇か
    isHalfDay: boolean;     // 半休か
    isHoliday: boolean;     // 祝日か (サーバが付与)
    holidayName: string;    // 祝日名 (祝日のみ)
    absenceReason: string;  // フロント互換のため残している (= vacationType)
};
```

### 3.3 同期キューエントリ

```ts
type QueueItem = {
    id: number;            // Date.now() ベース
    user: string;          // 作成時のユーザー名 (owner 検証用)
    date: string;          // "YYYY-MM-DD"
    payload: Payload;      // syncToGAS の引数
    status: 'pending' | 'failed';
    retryCount: number;    // 自動再送回数 (0 から MAX_RETRY_ATTEMPTS まで)
    lastError?: string;    // 直近の失敗メッセージ (UI tooltip 用)
};
```

---

## 4. データフロー

### 4.1 ログイン → データ取得

```
[ユーザーがログインボタン]
        │
        ▼
login() ──── localStorage に user/pass を保存
        │
        ▼
showApp()
  ├── 最後に閲覧した月を localStorage から復元
  ├── キャッシュ + キュー overlay で即時描画 (空白回避)
  └── loadData() を非同期実行
        │
        ▼
loadData()
  ├─ オフライン → loadFromCacheWithQueueOverlay_() で表示
  └─ オンライン → GAS GET → JSON 解析
                    ├─ ok=false, error=forbidden → ログイン画面に戻す
                    ├─ ok=true → currentData 更新 + applySyncQueueOverlay_ + persistCaches_
                    └─ 失敗 → キャッシュフォールバック
```

### 4.2 編集 → 同期

```
[編集モーダル / クイック打刻]
        │
        ▼
syncToGAS(payload)
  ├── 楽観的に currentData を更新
  ├── persistCaches_() でキャッシュ保存 (祝日は別キャッシュにも累積)
  ├── syncQueue に { user, date, payload, status:'pending' } を追加
  │     (同じ date の旧 pending は除去 = 上書き戦略)
  └── processQueue() を呼ぶ
        │
        ▼
processQueue() (排他制御)
  loop while pendings:
    ├─ owner !== currentUser → discard
    ├─ オフライン → break (online イベント待ち)
    └─ POST to GAS
         ├─ ok=true → キューから除去
         └─ 失敗 → status='failed', retryCount++, バックオフ後に再 promote
              （ループは中断せず continue。失敗した日付は failed として
               pending フィルタから外れるので、他日の pending をブロックしない）
```

### 4.3 リトライ・自動再送

| トリガー | 動作 |
|---|---|
| `online` イベント | failed → pending に一括戻し、`retryCount` リセット、processQueue 起動。 |
| 自動バックオフ | 失敗ごとに `RETRY_BASE_DELAY_MS * 2^(retryCount-1)` 後に promote (最大 `MAX_RETRY_ATTEMPTS` 回)。 |
| ⚠️ アイコンタップ | `retrySync(id)` が retryCount=0 にリセット + pending に戻して即時再送。 |

### 4.4 削除フロー

`syncToGAS({ date, isDelete: true })` で削除リクエストをキューに積む。

- ローカル: 祝日の日は祝日情報のみ残し、それ以外は完全に削除。
- GAS: 該当行を `sheet.deleteRow` で削除。 祝日情報はクライアント側 (mergeHolidaysIntoData_) で再生成されるため、表示は復元される。

---

## 5. セキュリティモデル

### 5.1 認証

- 共有パスワード方式。 GAS 側で `APP_PASS` (Properties Service 推奨) と照合する。
- パスワードは `localStorage` に平文保存される。 共用デバイスでは利用しないこと。
- ユーザー名は GAS 側でシート名として扱われる。 任意文字列が許可されており、**ユーザー間の認可分離は実装されていない** (パスワードを知っていれば他人のシートにもアクセス可能)。

### 5.2 既知の脅威と緩和

| 脅威 | 現状の緩和策 | 残リスク |
|---|---|---|
| パスワード漏洩 | 推測困難なランダム文字列の使用を強く推奨。 Properties Service 経由でコードから分離。 | リポジトリ公開時はリスク有。 |
| ユーザーなりすまし | 同上 | パスワード共有ゆえ、本質的に信頼ベース。 |
| XSS | カレンダー描画は `textContent` ベース。 `innerHTML` での未エスケープ挿入はゼロ。 | datalist 経由の入力にも影響なし。 |
| クエリ文字列の漏洩 | GET でパスワードを送る現状は妥協 (HTTPS 内のみで有効)。 プロキシログ・履歴に残る可能性は残存。 | 将来 POST へ統合する余地あり。 |
| 共用デバイスでのデータ流出 | ログアウト時に localStorage を全消去。 キューには owner を持たせて他ユーザーへの誤送信を防止。 | 他ユーザーがログアウトせずデバイスを譲った場合は守れない。 |
| Service Worker による古いコード固定 | Network-first (HTML) + stale-while-revalidate (アセット)。 controllerchange で自動 reload。 | キャッシュ世代は CACHE_VERSION 依存。 |

### 5.3 セキュリティ上やってはいけないこと

- リポジトリを公開リポジトリに置いたまま `FALLBACK_PASS` を本物のパスワードで上書きすること。
- `GAS_URL` を SNS 等に貼ること (URL + パスワードがあれば全データを操作可能)。
- 共用デバイスでログアウトせず帰宅すること。

---

## 6. 初回セットアップ

### 6.1 Google スプレッドシート

1. 任意の Google アカウントで新規スプレッドシートを作成。
2. シート名は何でもよい (タブとして「Sheet1」が残っていても問題なし。 ユーザーごとのシートが自動生成される)。
3. 所有者は「自分」のままでよい (誰かと共有する必要はなし)。

### 6.2 Google Apps Script

1. スプレッドシートのメニュー: `拡張機能 → Apps Script`。
2. `Code.gs` の中身をすべて消し、本リポジトリの [`code.gas`](./code.gas) の中身を貼り付ける。
3. 左サイドの歯車「⚙ プロジェクトの設定」 → 「スクリプト プロパティ」 → `APP_PASS` というキーで強パスワードを設定。 (未設定でも動くが本番では必ず設定)
4. メニュー: `デプロイ → 新しいデプロイ → 種類: ウェブアプリ`。
   - 説明: 任意 (例: `v1`)
   - 次のユーザーとして実行: `自分`
   - アクセスできるユーザー: `全員` (匿名アクセスを許可しないと PWA からアクセスできない)
5. 「デプロイ」をクリックし、表示された **ウェブアプリ URL をコピー**。
6. 初回のみ Google アカウントの認可フローが走るので承認する (`高度な設定 → 安全でないページに移動 → 許可`)。

### 6.3 フロントエンドの設定

1. [`script.js`](./script.js) の冒頭 `GAS_URL` を、上で取得したウェブアプリ URL に貼り替える。
2. リポジトリを任意の静的ホスティング (GitHub Pages / Cloudflare Pages / Netlify / 社内 nginx 等) にデプロイ。
3. iPhone で URL を開き、Safari の「共有 → ホーム画面に追加」で PWA としてインストール。

### 6.4 動作確認

- 任意のユーザー名と、6.2 で設定した APP_PASS でログインできること。
- 「出社で開始」をタップ → 当日のセルに ▶ 09:00 と表示される (初回はキャッシュなし & コールドスタートで 5〜10 秒かかる)。
- スプレッドシートを開くと、ユーザー名のタブが自動生成され、行が追加されている。

---

## 7. 日常運用 / 開発フロー

### 7.1 ローカルでの動作確認

Service Worker の登録は HTTPS または `localhost` 必須なので、簡易サーバを立てる:

```sh
cd /path/to/timesheet
python3 -m http.server 8000
# http://localhost:8000 を開く
```

`file://` で開くと Service Worker が動かないので注意。

### 7.2 静的ファイルの更新

1. `index.html` / `script.js` / `style.css` / `sw.js` のいずれかを編集。
2. `sw.js` の `CACHE_VERSION` を必ずバンプ (例: `2.0.0` → `2.0.1`)。
3. 配信先に push。
4. 開いている PWA は次回起動時に新しい SW を取得し、自動的にリロードされる (`controllerchange` ハンドラ)。

### 7.3 GAS の更新

**コードを編集・保存する**

1. [script.google.com](https://script.google.com) にアクセスするか、スプレッドシートのメニュー `拡張機能 → Apps Script` を開く。
2. エディタ上の既存コードを全選択 (`Ctrl+A` / `⌘+A`) して削除し、リポジトリの `code.gas` の中身を貼り付ける。
3. `Ctrl+S` (Mac: `⌘+S`) で保存する。

**デプロイを更新する**

> ⚠️ **コードを保存しただけでは Web アプリに反映されない。** 以下の「デプロイ更新」が必須。

4. 右上の「デプロイ」ボタン → **「デプロイを管理」** をクリック。
5. 既存デプロイの右にある **鉛筆アイコン（編集）** をクリック。
6. 「バージョン」を **「新しいバージョン」** に変更してから「デプロイ」。
7. ウェブアプリ URL は変わらない。 `script.js` の `GAS_URL` は触らない。
8. 動作確認は実機 PWA から。 デプロイ直後はコールドスタートで 5〜10 秒かかる場合がある。

> ⚠️ **「新規デプロイ」は絶対に選ばない**。 新規デプロイすると別 URL が発行され、フロントの `GAS_URL` も書き換える羽目になる。

**スクリプトプロパティ (`APP_PASS`) を設定する**

初回または値を変えるとき:

1. スクリプトエディタの左サイドバーの **歯車アイコン ⚙️（プロジェクトの設定）** をクリック。
2. 下にスクロールして「スクリプト プロパティ」セクションを見つける。
3. 「スクリプト プロパティを追加」をクリック。
4. プロパティ名に `APP_PASS`、値に設定したいパスワードを入力して保存。

### 7.4 パスワード変更

1. Apps Script の `スクリプト プロパティ` で `APP_PASS` を新しい値に更新。
2. PWA でログアウト → 新パスワードでログイン。

### 7.5 ユーザー追加

ログイン画面で新しいユーザー名 + 共通パスワードでログインすると、初回 POST 時に新しいシートが自動生成される。 別途の事前作業は不要。

---

## 8. API 仕様 (GAS エンドポイント)

### 8.1 共通

- ベース URL: `script.google.com/macros/s/<ID>/exec`
- 認証: クエリ `p=<APP_PASS>` (GET) または ボディ `password` (POST)
- レスポンス Content-Type: `application/json`
- レスポンス共通形:
  - 成功: `{ "ok": true, ... }`
  - 失敗: `{ "ok": false, "error": "<code>" }`

### 8.2 GET /exec

ユーザーの全勤怠 + (年-1, 年, 年+1) の祝日マップを返す。

**Query Parameters**

| 名前 | 必須 | 例 | 説明 |
|---|---|---|---|
| `p` | ✅ | `secret123` | APP_PASS と一致しなければ `forbidden`。 |
| `u` | ✅ | `taro` | 対象ユーザー (= シート名)。 |
| `year` | – | `2026` | 祝日マージ用の基準年。 省略時は現在年。 |
| `t` | – | `1715300000000` | キャッシュバスター (任意)。 |

**レスポンス例 (200)**

```json
{
    "ok": true,
    "data": {
        "2026-05-03": {
            "place": "",
            "start": "",
            "end": "",
            "vacationType": "",
            "isAbsent": false,
            "isHalfDay": false,
            "isHoliday": true,
            "holidayName": "憲法記念日",
            "absenceReason": ""
        },
        "2026-05-10": {
            "place": "出社",
            "start": "09:00",
            "end": "18:00",
            "vacationType": "",
            "isAbsent": false,
            "isHalfDay": false,
            "isHoliday": false,
            "holidayName": "",
            "absenceReason": ""
        }
    }
}
```

**エラー**

| `error` | 状況 |
|---|---|
| `forbidden` | パスワード不一致 / `u` 未指定 |
| その他文字列 | 内部エラー (例外メッセージ) |

### 8.3 POST /exec

1 日分の勤怠を作成 / 更新 / 削除する。

**Request**

- Content-Type: `text/plain` (CORS preflight 回避のため。 ボディは JSON)
- Body 例:

```json
{
    "password": "secret123",
    "user": "taro",
    "date": "2026-05-10",
    "place": "出社",
    "start": "09:00",
    "end": "18:00",
    "isAbsent": false,
    "isHalfDay": false,
    "halfDayType": ""
}
```

削除時:

```json
{
    "password": "secret123",
    "user": "taro",
    "date": "2026-05-10",
    "isDelete": true
}
```

**バリデーション**

- リクエスト Body が JSON として解析できない → `invalid-json`
- `password` 不一致 → `forbidden`
- `user` または `date` 欠落 → `missing-fields`
- `isHalfDay=true` だが `halfDayType` が `'morning'`/`'afternoon'` のいずれでもない → `halfDayType-required`
- `isAbsent=true` で `place` が空 → `absent-reason-required` (フロントでもバリデーションするので通常は到達しない)
- 上記以外の例外 → `error` フィールドに例外メッセージそのまま (`String(err.message)`)

**レスポンス**

```json
{ "ok": true }
```

---

## 9. ローカルストレージ仕様

`STORAGE_KEYS` (script.js) で集中管理されているキー:

| キー | 用途 | 例 |
|---|---|---|
| `work_user_name` | ログインユーザー名 | `taro` |
| `work_user_pass` | パスワード (平文) | `secret123` |
| `cached_work_data` | サーバ応答 + 楽観的更新の最新スナップショット | `{ "2026-05-10": { ... } }` |
| `cached_holidays` | 祝日マップ (年跨ぎ累積) | `{ "2026-01-01": "元日" }` |
| `work_sync_queue` | 未送信 / 失敗キュー | `[{ id, user, date, payload, status, retryCount }]` |
| `work_last_viewed_month` | 最後に閲覧した月 (`YYYY-MM`) | `2026-05` |

ログアウト時は `Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k))` で全消去される。

---

## 10. トラブルシューティング

### 10.1 「ログインに失敗しました」とアラートが出る

- パスワードが GAS の `APP_PASS` と一致していない。 Apps Script のスクリプトプロパティを確認。
- Properties Service 未設定の場合は `code.gas:FALLBACK_PASS` (`'passwd'`) と一致する必要がある。

### 10.2 「データの取得に失敗しました: invalid-response」が出る

- GAS から返ってきた応答が JSON として解析できない (= plain text "Forbidden" や HTML エラーページ)。
- 一番ありがちな原因は **GAS が古いコードのままで再デプロイされていない** こと。 §7.3 の手順で再デプロイする。
- DevTools の Network タブで `script.google.com/macros/...` のレスポンスを直接確認すると、原因の切り分けが確実。

### 10.3 「データの取得に失敗しました: server-error」が出る

- GAS が JSON は返したが `ok` フィールドがない (= 旧版コード)。 §7.3 の手順で再デプロイする。

### 10.4 編集が反映されないままアプリを閉じてしまった

- 通信が成功していれば、別端末でログインしても反映される (スプレッドシートが正本)。
- 通信失敗中の場合は `localStorage.work_sync_queue` に残る。 オンライン復帰 + アプリ起動で自動再送される。

### 10.5 同じ日のセルに ⚠️ がついて消えない

- リトライ上限 (`MAX_RETRY_ATTEMPTS = 5`) を超過。 セルをタップで手動再送される。
- 連続して失敗する場合は GAS 側のエラーログ (Apps Script エディタ → 「実行数」) を確認。

### 10.6 アプリの修正が反映されない

- `sw.js:CACHE_VERSION` をバンプし忘れている。 必ず変更すること。
- iOS Safari では一度ホームアイコンから起動してから、Safari でも同じ URL を開くと SW 更新が促進されることがある。

### 10.7 祝日が表示されない

- GAS の `holidays-jp.github.io` への通信が失敗している。 `getHolidays_()` が `{}` を返すと祝日全消滅。
- 推奨: Apps Script のログで `holidays fetch failed` を確認、 24 時間でキャッシュは切れるので翌日改善することも多い。

### 10.8 月送りで前年の祝日が消える

- 現行コードでは修正済 (祝日キャッシュを別キーで累積)。 古いコードではキャッシュ全体が上書きされていた。

### 10.9 GAS デプロイ後に URL が変わってしまった

- 「新規デプロイ」を選ぶと別 URL が発行される。 既存 URL 維持には「デプロイを管理 → 編集 → 新しいバージョン」 の手順が必要 (§7.3)。
- もし URL が変わってしまった場合は `script.js:GAS_URL` を新 URL に書き換えて再配信。 ついでに `sw.js:CACHE_VERSION` もバンプ。

---

## 11. 既知の制限と将来の改善

本ドキュメント時点で残存している制限・トレードオフをまとめます。

| 区分 | 内容 | 影響 |
|---|---|---|
| セキュリティ | パスワードは全ユーザー共通 | パスワードを知っていれば他人のシートも読み書きできる。 共有運用前提では問題、個人用なら受容。 |
| セキュリティ | パスワードを localStorage に平文保存 | XSS が無くなったため経路は限定されるが、共用デバイスで物理的にアクセスされた場合は漏洩する。 |
| 認証 | クエリ文字列にパスワードを乗せる GET | プロキシログ等への残存リスクが残る。 |
| パフォーマンス | カレンダーをフル再描画 | 月 30 件の編集中は若干カクつく。 差分更新は未実装。 |
| パフォーマンス | GAS doGet がシート全件読み出し | 数千行を超えると遅くなる。 年フィルタ未実装。 |
| データモデル | 場所と休暇理由が同一カラムを兼用 | UI で datalist を切替えて区別。 構造は保守者にとって直感的でない。 |
| アクセシビリティ | 色のみで土日祝を区別 | 色覚特性により判別しづらい。 ARIA / 祝日ラベルで部分的に補っているのみ。 |
| UX | アラート連発を減らしきれていない | データ取得失敗等は alert のままなのでカクつく。 |

将来の方向性 (優先順):

1. **ユーザー単位認証への移行**: シートに所有者メールを記録し、 `Session.getActiveUser()` と照合する。 同時に GAS のアクセス制御を「ドメイン内のみ」へ絞る。
2. **データモデル分離**: `place` と `absenceReason` を別列に分け、UI も切り替え式へ。
3. **差分レンダリング**: 仮想 DOM 風 or 単純な日セル単位差分更新でカレンダー再描画コストを削減。
4. **PWA 更新通知 UI**: `controllerchange` で自動 reload せず、ユーザーに「新バージョンあり」を出す。
5. **フォーカストラップ + キーボード操作**: モーダル内 Tab トラップを実装。

---

## 12. 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Claude Code (AI アシスタント) 向け作業ガイド |
