# 引き継ぎ(2026-11-17 時点)

開発を Windows の Claude Code から Raspberry Pi 5(Remote-SSH)に移すためのメモ。計画の全体は [plan.md](plan.md)。

## 完了したこと

- 計画の策定と、ユーザーとの合意(plan.md の「決定事項」)
- Pi 5 のセットアップ: apt 更新、Bluetooth 有効化(`disable-bt` をコメントアウト、`config.txt.bak-20261117` に退避)、デスクトップ + Chromium 156、nvm + Node v26.13.1 / npm 11.20.0、GitHub CLI、bleak の venv(`~/venv/ble`)
- git: user.name は klaNath、user.email は GitHub の noreply。`gh auth login` 済み(HTTPS)
- 雛形(作業 1): Vite 8 + TS 6.0.3 + vitest 5 + vite-plugin-pwa 2 + eslint 10 + prettier。typecheck、test、lint、build が通ることを確認済み
- 非公開リポジトリ https://github.com/klaNath/pico2_aprs_webclient に push 済み(main)
- 仕様書は git サブモジュール `docs/spec-src`(`klaNath/pico2_aprs` の `main` を追跡、sparse-checkout で ble-protocol.md と ble-control.md のみ)。取得と更新は `npm run spec` / `npm run spec:update`(`scripts/setup-spec.sh`)

## 仕様書の版(前回確認したもの)

- ble-protocol.md: v0.3(2026-11-17)、proto 1。サブモジュールのピン f6e3364(`klaNath/pico2_aprs` の `main` ブランチ。2026-11-18 に追跡先を `radio-interface-schematic` から `main` に変えた)。読む場所は `docs/spec-src/docs/`
- 再開時に `npm run spec:update` を実行し、ピンが動いたら(`git -C docs/spec-src log` と差分で)変更点を確認してから実装に反映する。新しいピンは親リポジトリでコミットする(特に §4 のペアリング(暫定)と §11 の未確定項目 U2、U3、U5、U6、U8)

## 作業 2 の結果(完了)

- `src/protocol/`(types、framing、settings)、`src/transport/transport.ts`、`src/transport/mock/`(mockDevice = 時間に依存しない疑似デバイス、mockTransport = 認証前の書き込みを捨てる、status 5 秒ごと、rx、`busyOnNextLine`、`simulateDisconnect`)、`src/client/`(deviceClient、emitter)
- deviceClient は要求を 1 つずつ送る(`busy` は id がないため、送信中の 1 件を 500 ms 後に 1 回だけ再送)。hello は 3 秒間隔で最大 5 回。書き込みは 1 行ずつ直列。`setSettings` は差分だけを 1 回で送り、差分がなければ何も送らない。切断時は待っている要求を `disconnected` で失敗させる
- 自動再接続とバックオフは作業 5(webBluetooth 側)で扱う。確認ダイアログ(tx_enabled、callsign、reset)は作業 4 の UI で作る
- テスト 120 件(framing、types、mockDevice、deviceClient)。`tsconfig.json` の `include` に `tests` を足し、`tests/sanity.test.ts` を消した。`npm run typecheck`、`lint`、`test`、`build` が通る
- 雛形のサンプル(`src/counter.ts`、`src/main.ts`、`src/style.css`、`src/assets/`)は、作業 4 で UI に置き換えるときに消す
- 仕様のピンは 37c2408 のまま(再開時に `spec:update` で最新と確認済み)

## 仕様 v0.2 → v0.3 で変わったこと(反映済み)

- 本機の BLE 層が実機で確かめられた(Android の nRF Connect、Windows の bleak)。§2、§3、§5.2 が確定。名前は `PicoAPRS-XXXX`(MAC の下位 2 バイト、大文字の 16 進。表示には使うが絞り込みには使わない)、アドレスは固定、広告間隔は 100 ms。接続中は広告しない(別の端末が接続中だと見つからない)
- §5.2: アプリ → 本機の書き込みは **20 バイト以下で固定**(U4 は解消。`MAX_WRITE_BYTES = 20` のまま)。作業 5 の `webBluetooth.ts` では `writeValueWithResponse` で、1 回ごとに完了を待って書く。本機からの通知は最大 244 バイト
- §6.2: 認証が済むとすぐに最初の `status` が送られるため、通知の開始前なら取りこぼす。**接続の流れに `status` の要求を足した**(`start()` は hello → status → schema → get → stations の順。テスト済み)
- §10.1(U8): 開発 PC(Windows 11、Bluetooth 4.0)では、続けて届く通知が途中から止まり、Windows の Bluetooth を入れ直すまで直らない。本機の問題ではなく、Android では起きない。**実機の試験は Android で行う**(Windows の Chrome での確認は、Bluetooth 5.x のアダプターで試すまで保留)
- 解消した項目: U1、U4、U7(認証前のコマンドは `err` を返さず黙って捨てる)。メッセージの処理(§6〜§9)は変わっていない

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
- 仕様の未確定項目: U3(Chrome でペアリングダイアログが出るか。Web アプリから試すのは初めて)、U2(Device Information Service)、U5(`hello` にファームウェアの版を入れるか)、U6(`settings.set` の保存中に受信がどれだけ欠けるか)、U8(Bluetooth 5.x の Windows で通知が止まる問題が出ないか)
- GitHub Pages の公開設定は、作業 6 のとき。非公開リポジトリで Pages を使えるプランかどうか確認する
