# pico2_aprs_webclient

pico2_aprs(Pico 2 W の APRS トラッカー)を Android Chrome から BLE(Web Bluetooth)で操作する Web アプリ。
サーバーなしの静的ファイル(Vite + TypeScript、PWA、GitHub Pages)。UI は英語のみ。

## 再開ワード

ユーザーが「**作業2を再開**」(または「再開」)と言ったら:

1. `docs/HANDOFF.md` を読む(現状、決定事項、次にやること)
2. `npm run spec` で仕様書のサブモジュールを用意し(clone 直後は必須)、続けて `npm run spec:update` で最新のコミットに進められるか確認する。ピンが動いたら、`git -C docs/spec-src log --oneline <旧>..<新>` と差分で変更点を確認して報告し、実装に反映してから、新しいピンをコミットする
3. `docs/plan.md` の「作業の順序」に従って、HANDOFF.md の「次にやること」から進める

## 決まりごと

- **仕様の正は `klaNath/pico2_aprs` の `docs/ble-protocol.md`**(背景は `docs/ble-control.md`)。リポジトリには git サブモジュール `docs/spec-src`(ブランチ `main` を追跡、コミットでピン留め、sparse-checkout で 2 ファイルだけ)として入れてある。読む場所: `docs/spec-src/docs/ble-protocol.md`。仕様と食い違う実装をしない。仕様側に不足があれば、ユーザーに伝える。**サブモジュールの中を編集しない**(仕様の変更は `pico2_aprs` 側で行う)

## 仕様書の取得と更新

- clone 直後: 普通に `git clone <url>` したあと `npm run spec` を一度実行する。`--recurse-submodules` は使わない(`pico2_aprs` 自身のサブモジュール `third_party/*` まで取ってしまう。sparse-checkout の設定も clone ごとに必要なので、結局 `npm run spec` が要る)
- 最新に進める: `npm run spec:update`(ピンを追跡ブランチの先頭に動かす)→ 変更を確認 → `git add docs/spec-src && git commit`
- 実体は `scripts/setup-spec.sh`
- **送信の安全**: `tx_ready` は常に見える場所に表示する。`tx_enabled` を true にする、callsign を変える、reset するときは確認ダイアログを出す。`mice_message` は 0〜6 だけ選べる
- テストデータのコールサインは Q1 で始まる架空のもの(`Q1TEST` など)を使う
- Web 上(サーバー、DB、オブジェクトストレージ)には永続データを置かない。端末内(localStorage、Cookie)への保存は可
- TypeScript は 6.0 系に固定(`typescript-eslint` が 7.x に未対応)。`--force` や `--legacy-peer-deps` で回避しない
- 秘密鍵、トークンをコミットしない。リポジトリは公開(2026-11-19)。ホスト名、SSH のポート、鍵の名前、端末や実機の識別子(コールサイン、Bluetooth アドレス、広告名の末尾)、個人の開発環境の記述をコミットしない

## コマンド

`npm run dev`(`-- --host 127.0.0.1 --port 5173 --strictPort` を付けると VS Code が自動でポートを転送する)/ `test` / `lint` / `typecheck` / `format` / `build` / `spec` / `spec:update`
