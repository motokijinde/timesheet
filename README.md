# 勤務報告ポチるだけ

スマホからボタン 1 タップで勤怠を記録できる個人用 PWA。
打刻した時刻を Google スプレッドシートに保存しつつ、Teams 報告用テキストをクリップボードへコピーします。

- バニラ JS + PWA + Google Apps Script + Google スプレッドシート
- ビルドツール / 依存パッケージなし
- オフライン耐性 (Service Worker キャッシュ + 同期キュー)

## クイックスタート

詳細な手順は [`docs.md` の「初回セットアップ」](./docs.md#6-初回セットアップ) を参照。

1. Google スプレッドシートを新規作成し、`拡張機能 → Apps Script` を開く。
2. 本リポジトリの [`code.gas`](./code.gas) を貼り付け、`スクリプトプロパティ` に `APP_PASS` を設定。
3. `デプロイ → ウェブアプリ` で公開し、ウェブアプリ URL をコピー。
4. [`script.js`](./script.js) 冒頭の `GAS_URL` を貼り替える。
5. `index.html` 一式を任意の静的ホスティング (GitHub Pages 等) に配置。
6. iPhone でアクセスし、Safari の「ホーム画面に追加」で PWA としてインストール。

## ローカルでの動作確認

```sh
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

Service Worker は HTTPS または `localhost` でしか動かないため、`file://` で開かないこと。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [`docs.md`](./docs.md) | アーキテクチャ・データモデル・API 仕様・運用手順 |
| [`CLAUDE.md`](./CLAUDE.md) | Claude Code (AI アシスタント) 向け運用メモ |
| [`code-review.md`](./code-review.md) | コード解析レポート (リファクタ前) |
| [`fix-plan.md`](./fix-plan.md) | リファクタの修正計画書 |
