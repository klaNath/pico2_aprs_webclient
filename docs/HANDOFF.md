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
- deviceClient は要求を 1 つずつ送る(`busy` は id がないため、送信中の 1 件を 500 ms 後に 1 回だけ再送)。hello は 3 秒間隔で最大 5 回。書き込みは 1 行ずつ直列。`setSettings` は差分だけを 1 回で送り、差分がなければ何も送らない(ただし `tx_enabled` は指定があれば常に送る)。切断時は待っている要求を `disconnected` で失敗させる
- 自動再接続とバックオフは作業 5(webBluetooth 側)で扱う。確認ダイアログ(tx_enabled、callsign、reset)は作業 4 の UI で作る
- テストは作業 2 の時点で 120 件(framing、types、mockDevice、deviceClient)。`tsconfig.json` の `include` に `tests` を足し、`tests/sanity.test.ts` を消した。`npm run typecheck`、`lint`、`test`、`build` が通る
- 雛形のサンプル(`src/counter.ts`、`src/main.ts`、`src/style.css`、`src/assets/`)は、作業 4 で UI に置き換えるときに消す
- 仕様のピンは f6e3364(上の「仕様書の版」と同じ)

## 仕様 v0.2 → v0.3 で変わったこと(反映済み)

- 本機の BLE 層が実機で確かめられた(Android の nRF Connect、Windows の bleak)。§2、§3、§5.2 が確定。名前は `PicoAPRS-XXXX`(MAC の下位 2 バイト、大文字の 16 進。表示には使うが絞り込みには使わない)、アドレスは固定、広告間隔は 100 ms。接続中は広告しない(別の端末が接続中だと見つからない)
- §5.2: アプリ → 本機の書き込みは **20 バイト以下で固定**(U4 は解消。`MAX_WRITE_BYTES = 20` のまま)。作業 5 の `webBluetooth.ts` では `writeValueWithResponse` で、1 回ごとに完了を待って書く。本機からの通知は最大 244 バイト
- §6.2: 認証が済むとすぐに最初の `status` が送られるため、通知の開始前なら取りこぼす。**接続の流れに `status` の要求を足した**(`start()` は hello → status → schema → get → stations の順。テスト済み)
- §10.1(U8): 開発 PC(Windows 11、Bluetooth 4.0)では、続けて届く通知が途中から止まり、Windows の Bluetooth を入れ直すまで直らない。本機の問題ではなく、Android では起きない。**実機の試験は Android で行う**(Windows の Chrome での確認は、Bluetooth 5.x のアダプターで試すまで保留)
- 解消した項目: U1、U4、U7(認証前のコマンドは `err` を返さず黙って捨てる)。メッセージの処理(§6〜§9)は変わっていない

## 作業 3 の結果(完了)

`src/aprs/` に TNC2 / APRS パーサーを作った。入口は `parseAprs(rx.tnc2): AprsPacket`(`parse.ts`)。例外を投げず、読めないものは `data.type === "unknown"`(`reason` つき)になる。結果の型は `types.ts`、位置は `packetPosition(packet)`(thirdparty の inner も再帰。`status` のグリッドは返さない)、グリッド込みは `packetLatLon(p)`(`approximate` つき)、気象は `packetWeather(p)`、問題の理由は `packetProblem(p)` で取る(気象は `position.weather` と `type:"weather"`、理由は `AprsPacket.error` と `data.reason` に分かれているため)。

- ファイル: `tnc2.ts`(ヘッダーの分解、`<0xHH>` → バイト → UTF-8、`splitCall`)、`parse.ts`(入口、位置、オブジェクト/アイテム、メッセージ、ステータス)、`mice.ts`、`compressed.ts`(圧縮位置、`base91`、`makeSymbol`)、`weather.ts`、`telemetry.ts`(`T#`、PARM/UNIT/EQNS/BITS、`applyEqns`、圧縮テレメトリ)、`timestamp.ts`(`resolveTimestamp(ts, 受信時刻)`)、`symbols.ts`(`symbolName`、`symbolInfo` の category は vehicle/person/fixed/digi/weather/other)、`geo.ts`(`distanceM`、`bearingDeg`、`cardinal`、`formatLatLon`、`gridToLatLon`)、`types.ts`(計画にはなかった。型の共有用)
- 単位はメートル法(km/h、m、°C、mm、hPa、m/s)。情報フィールドはバイト列として解析し、コメント、メッセージ、ステータスだけを文字列として読む(厳密な UTF-8 → 末尾の切れた UTF-8 を落とす → 明らかに日本語の Shift_JIS → Latin-1 の順。方針は `tnc2.ts` 冒頭のコメント)。位置は緯度 90° 以下、経度 180° 以下、分 60 未満、日時は暦の範囲を検査し、外れたら unknown(圧縮位置も clamp せず unknown)
- Mic-E は本機の送信例(§8.3)を手計算で確かめて、テストの根拠にした(`tests/aprs/mice.test.ts` のコメント)。メッセージは `MICE_MESSAGES`(`src/protocol/settings.ts`)を再利用
- 制限(意図したもの): 印字可能な `<0x41>` は `A` と区別できない(仕様上)。圧縮形式の気象は風向(cs の course)だけ読み、風速は単位が不明なので読まない(本文の `s` は雪量)。Mic-E の機種コード(`>`、`]` など)は文字を `typeCode` に残すだけで、機種名にはしない。Mic-E の高度(`ccc}`)は typeCode の直後に固定、DAO は Mic-E でも使う。カスタムと標準が混在する Mic-E は位置を返し `message` は null。`/A=` は符号を含む 6 桁(`-00100`)で、複数あれば最初の 1 つだけ
- テストは `tests/aprs/`(11 ファイル)。全体で 17 ファイル、449 件。`npm run typecheck`、`lint`、`test`、`build` が通る。堅牢性のテストは、サンプルの全プレフィックスと、文字置換や Mic-E を含む固定シードの乱数 2,000 行で、例外がないことに加え、`reason` が internal error でないこと、数値が有限、緯度経度と日時が範囲内という不変条件を確かめる
- API の変更(レビュー後): `Symbol` → `AprsSymbol`、`bulletin` は boolean、`replyAck`、`PathEntry.qConstruct`、`eqns` は `(Eqn|undefined)[]`、Mic-E の `message` は `null` がありうる。小文字のコールサインは正規化しない(比較は `toUpperCase()`)

## 敵対的レビューと修正(2026-11-18、作業 1〜3 が対象)

サブエージェントによる敵対的レビューで High 6 件、Medium 約 18 件が見つかり、すべて修正した(回帰テストつき)。要点:

- クライアント: `setSettings` は検証して送る(NaN、`mice_message` 0〜6 以外、小文字/空白つき callsign は `invalid` で拒否)。`callsign` の変更・null、`tx_enabled: true` は `setSettings(values, { confirmed })` に確認種別が必須(`client.requiredConfirmations(values)` で得る。足りなければ `confirmation_required`)。`resetSettings({ confirmed: true })` も引数が必須。`settings.set`/`reset` の結果が不明なときはキャッシュを無効化して再取得する。リスナーの例外は握りつぶさず `console.error`。書き込みは 20 バイト以下を `MockTransport` も検査。`LineAssembler` は 16 KB 上限、送信行は 512 バイト上限
- UI が使う API: `client.statusStale`(15 秒、イベント `statusStale` もある。`tx_ready` の古い値を出さない)、`lastStatusAt`、`lastError`(`start()` 失敗)、`lastDisconnectReason`、`settingsKnown`、`dispose()`。`Transport.onData`/`onDisconnect` は解除関数を返す。`tsconfig` に `web-bluetooth`、`strict`、`noUncheckedIndexedAccess` を追加
- 仕様側への指摘(`pico2_aprs` 側で検討してほしい): (1) 書き込みがチャンクの途中で失敗したとき、本機側に行の断片が残る。空行で破棄するなどの再同期の手段がない (2) `busy` で落とされた行が部分的にでも処理されたか、再送が安全か(`settings.set` が冪等か)の記載がない (3) §9.1 の `callsign` が小文字を拒否するのか変換するのか不明(`path` は変換と明記) (4) `callsign` が null のときの `status.call` の値がない (5) 最初の書き込みがパスキー入力の完了までブロックするか(U3)が未確認
- 未確認のまま残した点: 圧縮気象の cs の風速の単位、雪量 `s` の単位、シンボル表は WB4APR のマスターリスト(http://www.aprs.org/symbols/symbolsX.txt、2015-11-25)と全 194 行を機械的に突き合わせ済み(割り当ての有無はすべて一致。画像のチャート https://blog.thelifeofkenneth.com/2017/01/aprs-symbol-look-up-table.html も参考にした)。AVAIL/TBD/予約のコードは未登録(`known:false`)で、旧気象コード(副表の `* : B F G J b p {`)と主表の `0`〜`9`(番号つきの丸)だけは意図して残した。オーバーレイの定義(`symbols-new.txt`)は未対応。日本語コメントの文字コード判定は、Windows-1252 のスマートクォートが 2 つ以上あると Shift_JIS と誤検知しうる

## 次にやること(作業 4: UI)

plan.md の構成と「作業の順序」4 に従う。ヘッダーとステータス → フィード → 局の一覧 → レーダー → 設定 の順。モック(`?mock=1`、接続画面の「Demo」)で確かめる。

- 土台: `DeviceClient`(`src/client/`)と `MockTransport`(`src/transport/mock/`)。UI は `client.on("status" | "rx" | "tx" | "stations" | "settings" | ...)` を購読する。雛形の `src/main.ts`、`counter.ts`、`style.css`、`src/assets/` はここで置き換える
- フィードの詳細は `parseAprs(rx.tnc2)`、局の一覧の距離と方位は `geo.ts`(自局は `status` の `lat`/`lon`)、レーダーの色は `symbolInfo().category`
- 安全(CLAUDE.md): `tx_ready` を常に見える場所に表示する。`tx_enabled` を true にするとき、callsign を変えるとき、reset のときは確認ダイアログを出す。`mice_message` は 0〜6 だけ選べる(`MICE_MESSAGES`)
- 設定画面は schema を基本に、既知の項目(`KNOWN_SETTINGS`)には専用の部品を使う。差分だけを `client.setSettings()` で 1 回送る(押したときだけ。キー入力ごとに送らない)。確認が要る変更は `requiredConfirmations()` → ダイアログ → `setSettings(values, { confirmed })` の順

その後は plan.md の順(作業 5: Web Bluetooth → 6: PWA と Pages)。

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
