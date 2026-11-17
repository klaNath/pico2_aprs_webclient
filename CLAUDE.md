# pico2_aprs_webclient

pico2_aprs(Pico 2 W の APRS トラッカー)を Android Chrome から BLE(Web Bluetooth)で操作する Web アプリ。
サーバーなしの静的ファイル(Vite + TypeScript、PWA、GitHub Pages)。UI は英語のみ。

## 再開ワード

ユーザーが「**作業2を再開**」(または「再開」)と言ったら:
1. `docs/HANDOFF.md` を読む(現状、決定事項、次にやること)
2. `npm run spec` で最新の仕様書を `docs/spec/` に取得し、`docs/spec/SOURCE.txt` と `docs/spec/ble-protocol.md` のバージョンを前回(HANDOFF.md に記録)と比べて、変更があれば報告する
3. `docs/plan.md` の「作業の順序」に従って、HANDOFF.md の「次にやること」から進める

## 決まりごと

- **仕様の正は `klaNath/pico2_aprs` の `docs/ble-protocol.md`**。変わる可能性があるので、リポジトリにはコピーせず `npm run spec` で取得する(`docs/spec/` は git 管理外)。仕様と食い違う実装をしない。仕様側に不足があれば、ユーザーに伝える
- **送信の安全**: `tx_ready` は常に見える場所に表示する。`tx_enabled` を true にする、callsign を変える、reset するときは確認ダイアログを出す。`mice_message` は 0〜6 だけ選べる
- テストデータのコールサインは Q1 で始まる架空のもの(`Q1TEST` など)を使う
- Web 上(サーバー、DB、オブジェクトストレージ)には永続データを置かない。端末内(localStorage、Cookie)への保存は可
- TypeScript は 6.0 系に固定(`typescript-eslint` が 7.x に未対応)。`--force` や `--legacy-peer-deps` で回避しない
- 秘密鍵、トークンをコミットしない。リポジトリは非公開。公開する前に `docs/plan.md` のホスト名やポートを消す

## コマンド

`npm run dev`(`-- --host 127.0.0.1 --port 5173 --strictPort` を付けると VS Code が自動でポートを転送する)/ `test` / `lint` / `typecheck` / `format` / `build` / `spec`
