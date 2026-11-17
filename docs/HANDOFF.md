# 引き継ぎ(2026-11-17 時点)

開発を Windows の Claude Code から Raspberry Pi 5(Remote-SSH)に移すためのメモ。計画の全体は [plan.md](plan.md)。

## 完了したこと

- 計画の策定と、ユーザーとの合意(plan.md の「決定事項」)
- Pi 5 のセットアップ: apt 更新、Bluetooth 有効化(`disable-bt` をコメントアウト、`config.txt.bak-20261117` に退避)、デスクトップ + Chromium 156、nvm + Node v26.13.1 / npm 11.20.0、GitHub CLI、bleak の venv(`~/venv/ble`)
- git: user.name は klaNath、user.email は GitHub の noreply。`gh auth login` 済み(HTTPS)
- 雛形(作業 1): Vite 8 + TS 6.0.3 + vitest 5 + vite-plugin-pwa 2 + eslint 10 + prettier。typecheck、test、lint、build が通ることを確認済み
- 非公開リポジトリ https://github.com/klaNath/pico2_aprs_webclient に push 済み(main)
- 仕様書は git サブモジュール `docs/spec-src`(`klaNath/pico2_aprs` の `radio-interface-schematic` を追跡、sparse-checkout で ble-protocol.md と ble-control.md のみ)。取得と更新は `npm run spec` / `npm run spec:update`(`scripts/setup-spec.sh`)

## 仕様書の版(前回確認したもの)

- ble-protocol.md: v0.2(2026-11-16)、proto 1。サブモジュールのピン 37c2408(`klaNath/pico2_aprs` の `radio-interface-schematic` ブランチ)。読む場所は `docs/spec-src/docs/`
- 再開時に `npm run spec:update` を実行し、ピンが動いたら(`git -C docs/spec-src log` と差分で)変更点を確認してから実装に反映する。新しいピンは親リポジトリでコミットする(特に §2〜§5.2 の暫定部分と §11 の未確定項目 U1〜U7)

## 作業 2 の結果(完了)

- `src/protocol/`(types、framing、settings)、`src/transport/transport.ts`、`src/transport/mock/`(mockDevice = 時間に依存しない疑似デバイス、mockTransport = 認証前の書き込みを捨てる、status 5 秒ごと、rx、`busyOnNextLine`、`simulateDisconnect`)、`src/client/`(deviceClient、emitter)
- deviceClient は要求を 1 つずつ送る(`busy` は id がないため、送信中の 1 件を 500 ms 後に 1 回だけ再送)。hello は 3 秒間隔で最大 5 回。書き込みは 1 行ずつ直列。`setSettings` は差分だけを 1 回で送り、差分がなければ何も送らない。切断時は待っている要求を `disconnected` で失敗させる
- 自動再接続とバックオフは作業 5(webBluetooth 側)で扱う。確認ダイアログ(tx_enabled、callsign、reset)は作業 4 の UI で作る
- テスト 120 件(framing、types、mockDevice、deviceClient)。`tsconfig.json` の `include` に `tests` を足し、`tests/sanity.test.ts` を消した。`npm run typecheck`、`lint`、`test`、`build` が通る
- 雛形のサンプル(`src/counter.ts`、`src/main.ts`、`src/style.css`、`src/assets/`)は、作業 4 で UI に置き換えるときに消す
- 仕様のピンは 37c2408 のまま(再開時に `spec:update` で最新と確認済み)

## 次にやること(作業 3)

`aprs/` パーサーを作り、Vitest で検証する。plan.md の構成(tnc2、parse、mice、compressed、weather、telemetry、symbols、geo)と「作業の順序」の 3 を参照。テストデータの局名は Q1 で始まる架空のコールサインにする。

その後は plan.md の順(作業 4: UI → 5: Web Bluetooth → 6: PWA と Pages)。

## 環境の注意

- ソースは Pi 5 の `~/src/pico2_aprs_webclient`。Node は nvm 経由(非対話のシェルでは `. ~/.nvm/nvm.sh` が必要)
- Bluetooth は Powered: yes。rfkill は `/usr/sbin/rfkill`(PATH にない)
- sshd は Port <port>、パスワード認証なし。Windows 側の鍵は `~/.ssh/id_ed25519_<key-name>`、ホスト名は `<host>`(config に設定)
- Pi 5 は graphical.target。画面の見方(モニター直結 / VNC / Raspberry Pi Connect)は未決定
- npm audit の警告 4 件は、ビルド時のみの依存(vite-plugin-pwa → workbox-build → glob)。成果物には入らない

## 未確認・未決定

- Pi 5 の Chromium で Web Bluetooth が使えるか(フラグが必要かもしれない)
- Android での実機確認(adb、`chrome://inspect`)は、作業 5 までに用意する(Windows に `winget install Google.PlatformTools`)
- 仕様の未確定項目 U1〜U7(ペアリングダイアログが Android Chrome で出るか、など)は、本機の BLE 層ができるまで確定しない
- GitHub Pages の公開設定は、作業 6 のとき。非公開リポジトリで Pages を使えるプランかどうか確認する
