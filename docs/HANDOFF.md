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

## 作業 4 の結果(完了。モックで確認済み)

`?mock=1`(または接続画面の「Demo」)で全画面が動く。`?fast=1` でモックの受信が 0.3〜0.9 秒ごとになり、`?debug=1` で `window.__app` が使える(確認用。dev サーバーか `VITE_ENABLE_DEBUG=1` のビルドだけ)。

- 土台: `src/store/state.ts`(`App`: client、feed(上限は prefs の `logLimit`)、stations)、`src/store/prefs.ts`(localStorage、try/catch、値の検証つき)、`src/ui/view.ts`(`View` = `el` + `render()`。render は差分更新。1 秒ごとと状態変化で呼ばれる)、`dom.ts`、`format.ts`、`dialog.ts`(`confirmDialog`)、`header.ts`(TX バッジ。接続していないとき、status が古いときは「TX ?」。古い ready を出さない)、`connectView.ts`(パスキーの案内つき)、`statusView.ts`
- Feed(`feedView.ts`、純粋関数は `feedFormat.ts`): 古い順、`seq` で差分追加、DOM は最新 300 行まで、詳細の展開、フィルター(方向、種別、発信元)、Clear、JSON / TNC2 ログの書き出し(保持している全件)
- Stations / Radar(`stationList.ts`、`radarGeometry.ts`、`stationDetail.ts`): 並べ替えとフィルター、SVG のレーダー(対数/線形、範囲 5〜500 km、点は形と色で区別、範囲外は縁に表示)
- Settings(`settingsView.ts`、`settingsForm.ts`、`widgets/`): schema から作るフォームと既知項目の専用部品。保存は Save だけ(差分を 1 回で送る)。確認が要る変更(callsign の変更、`tx_enabled: true`)と Reset は `confirmDialog` を通り、見せた値と送る値は同じ(`executeSave`)。`mice_message` は 0〜6 の選択肢のみ。App preferences(テーマ、フィードの保存件数)と About
- テスト 29 ファイル 878 件(レビューの修正後)。`npm run typecheck`、`lint`、`test`、`build` が通る。画面は Chromium(DevTools プロトコル)で、ライト/ダーク、幅 360 と 412 を確認した

### 作業 4 の敵対的レビューと修正(完了)

3 つのサブエージェントで UI を敵対的にレビューし(Settings と送信の安全、Feed/Stations/Radar、土台と横断)、見つかった High 3 件と Medium の大半を直した。Critical はなく、**確認なしで送信できる経路は見つからなかった**。決めたこと:

- **SSID の変更は常に確認する**(`tx_ready` や `tx_enabled` に関係なく。`SettingsRisk` に `"ssid"`)。確認の順序は callsign → ssid → tx_enable
- **切断中は読み取り専用で使える**: 切断後も feed と stations が残り、タブが使える(Feed の書き出しも)。Status の先頭に接続カード。Settings は入力と Save/Reset が無効(App preferences と About は使える)
- 局の位置は `position` と Mic-E のパケットからだけ採る(オブジェクト、サードパーティ、ステータスのグリッドでは動かさない)
- 受信履歴は、Clear したときと、別の端末(Demo と実機を含む)に接続したときだけ消える。`app.disconnectKind`("user"|"link")、`app.recentErrors`(`deviceError` は `notice` に入れない)、`connectWith(transport: Transport, mock)` は public(作業 5 で使う。接続の試行は直列化済み)
- `client.statusStale` は時計でも判定する。`tx_ready` が欠けた status は「TX ?」。Demo はヘッダーに DEMO、TX は SIMULATED で、実機の TX READY と見分けられる
- 設定の保存と Reset の流れは DOM を使わない `settingsController.ts` と `executeSave`/`executeReset`(`settingsForm.ts`)にあり、確認を迂回できないことをテストと変異テストで確かめた。デバイスから来る schema の `pattern` は実行しない(ReDoS 対策。表示するだけ)
- Radar のタップは最近傍の選択。Stations は行にフォーカスがある間などは並び順を固定する。Feed の Clear は確認つき、TNC2 ログは既定で rx だけ、JSON はデバイスのキーを `msg` にネスト(`version` 1)
- `index.html` に厳しい CSP(インラインなし)。`vite.config.ts` は `npm run dev` のときだけ CSP の meta を外す(作業 6 で PWA の設定を足すときにマージする)。`public/theme-init.js` は FOUC 対策。`.prettierignore` で `npm run format` が `docs/spec-src` に触れない
- `window.__app`(`?debug=1`)は、dev サーバーか `VITE_ENABLE_DEBUG=1` を付けたビルドだけ。通常の `npm run build` では出ない

### 作業 4 の未解決・未確認

- 作業 5 で確認すること: `requestDevice` はクリックの中で同期的に呼ぶ(`connectWith` の `await` の後だと、Chrome のユーザー操作の有効期間(約 5 秒)を超えうる)。自動再接続は `App`/同じ `DeviceClient` の `start()` 再呼び出しで作る(置き場所はコメントにある)。`Transport` に `deviceId`(`BluetoothDevice.id`)を入れる
- Android 実機で未確認: 戻るボタン(タブは `#hash` と `pushState`)、pull-to-refresh の抑止、`proto_mismatch` と `handshaking` の画面
- 未対応(Low): `theme-color` はアプリ内のテーマ選択に連動しない。ヘッダーの callsign は、保存の直後は次の `status`(最大 5 秒)まで古い。Reset の結果で `tx_enabled` が true になりうる(Reset の確認と、結果が true のときの警告で扱っている)
- 公開前: `docs/HANDOFF.md` と `docs/plan.md` にホスト名、SSH ポート、鍵のファイル名がある(履歴にも残る。CLAUDE.md が消すと指示しているのは plan.md だけ)。公開するなら、履歴を書き換えるか、新しいリポジトリで公開する。サブモジュールの URL は非公開の可能性がある。`npm audit` は開発時のツールだけ(成果物には入らない)
- 仕様側(`pico2_aprs`)に伝えるべき点(Issue は未作成): §8.4 の `station.src` はオブジェクトでは「オブジェクト名」、§8.2 の `rx.src` は常に送信局で、`stations.list` と rx から局を作るときにキーの意味が食い違う

### 画面を確認する方法(この環境)

この環境の Chromium は `http://127.0.0.1` のページを読み込めない。`VITE_ENABLE_DEBUG=1 npx vite build --base=./ --outDir <dir> --emptyOutDir` で作り、`file://` で開く。DevTools プロトコルでスクリーンショットとコンソールを取る(スクリプトはスクラッチにあり、リポジトリにはない。必要なら `tools/` に入れる)。

## 作業 5 の結果(実装済み。実機で一部確認済み)

- `src/transport/webBluetooth.ts`: `WebBluetoothTransport`(NUS。`connect()` は `gatt.connect` → サービス → TX/RX → `startNotifications` まで済んで resolve。初回のペアリングは TX の通知開始で起きる想定なので、パスキー入力の間 `connect()` は待つ。`disconnect()` は待っている `connect()` と書き込みを reject させる。書き込みは `writeValueWithResponse` で 20 バイト以下、通知はコピーして渡す)。`requestTrackerDevice`(NUS の UUID で絞る。名前では絞らない)、`knownTrackerDevices`(`getDevices`)
- `App`(`state.ts`): `connectBluetooth()` はチューザーをクリックの中で同期的に開く(`await` の前)。チューザーの取り消しはエラーにしない。`connectDevice(device)`、`loadKnownDevices()`/`knownDevices`(起動時に読む。接続カードに「Reconnect to PicoAPRS-XXXX」)
- 自動再接続: リンクが切れたら(利用者の切断ではないとき)同じ `DeviceClient` で `start()` をやり直す(§10)。待ち時間は 1, 2, 4, 8, 16 秒、以後 30 秒。20 回で諦めて案内を出す。`proto_mismatch` では止める。利用者の切断と新しい接続で止まる。`app.reconnect`(`attempt`、次の試行の時刻)、`reconnectNow()`。ヘッダーに「Reconnecting…」、接続カードに残り秒数と「Reconnect now」「Cancel」
- テスト: 偽の GATT(`MockDevice` につないだもの)で `DeviceClient` の §6.2 の流れ、書き込みが 20 バイト以下で 1 つずつ、UTF-8 の分割、ペアリング中の取り消し、リンク切れ、同じ transport での再接続を確かめる(`tests/webBluetooth.test.ts`)。再接続とチューザーは `tests/appReconnect.test.ts`。全体で 32 ファイル 906 件
- Pi 5 の BlueZ でスキャンしたが、2026-11-18 の時点では近くに広告中のトラッカーはなかった

### 実機確認の結果(2026-11-18。Android 11、Chrome 157。adb は Wi-Fi 経由、`adb reverse` で dev サーバーに接続)

- できた: チューザーにトラッカーが出る(NUS の UUID で絞って見つかる)→ 接続 → Status、Settings(実機の値が入る)、Feed、Stations、Radar が実機のデータで開く。Settings は読むだけで、書き込みは試していない(実機の送信設定があるため)
- **U3(ペアリング)**: パスキー入力のダイアログは **Chrome ではなく Android が出す**。しかも自動では開かず、通知「ペア設定リクエスト」をタップすると開く(Chrome が前面で画面が点いていても同じ)。パスキーは LCD の 6 桁を利用者が入力した。ログ(logcat)では、TX の `startNotifications`(CCCD の書き込み)が成功した約 90 ms 後に SMP が始まっている。TX の通知開始には認証が要らないという回答(Issue #5 のファームウェア側の返信)と合う。つまり引き金は最初の書き込み(`hello`)だと思われるが、どの呼び出しで起きたかは直接は確かめていない。パスキー入力を待つ間、`connect()` は resolve 済みで、アプリは「Connected. Reading the tracker's state…」のまま固まらず待てた
- 結合済みの端末の再接続: アプリを再読み込みして接続し直すと、パスキーなしで ready になった
- **この Chrome では `navigator.bluetooth.getDevices` が `undefined`**。「Reconnect to NAME」のボタンは出ず、再読み込みのあとは毎回チューザーを開く。想定内(フラグが要る)
- 初回の接続(未結合)は 2 回のうち 1 回目が失敗した。`gatt.connect()` が `NetworkError`(Connection attempt failed)。logcat ではリンク確立の約 1.2 秒後に切断理由 `0x08`(supervision timeout)で、GATT 133。2 回目は成功した。再現するかと原因は未確認
- 約 1 時間後に端末の画面が Disconnected になっていた。原因(トラッカーの電源、距離、端末のスリープ)は記録していない。自動再接続が 20 回で諦めた可能性がある(未確認)
- アプリの挙動で気づいたこと: 接続中や受信フィードがあるとき、リロードで `beforeunload` の警告が出る(意図した動作)。Settings の保存バーが小さい画面で隠していたので、約 290px から約 110px にした
- 実機の値(コールサイン、アドレスなど)はこのファイルにも Issue にも書かない

## 次にやること(作業 5 の実機確認の続き → 作業 6)

### Android の Chrome で確かめる(利用者の操作が要る。済んだ項目は上の結果)

手順: トラッカーの電源を入れ(ほかの端末とつながっていないこと。接続中は広告しない)、Pi 5 で `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` を起動し、`adb reverse tcp:5173 tcp:5173`(Windows の場合は VS Code の転送ポートを経由。`adb` は S7)。Android の Chrome で `http://localhost:5173/` を開く(localhost は HTTPS と同じ扱いで Web Bluetooth が使える。dev サーバーは CSP の meta を外す)。端末のロックは私からは解除できない。画面は `adb exec-out screencap -p` で撮れ、DevTools は `adb forward tcp:9222 localabstract:chrome_devtools_remote` で使える(`pkill -f` は自分のシェルを巻き込むので使わない)

残り:

1. **自動再接続を実機で**: トラッカーを離す/電源を切る → 「Reconnecting…」→ 戻すと自動で ready になるか。1 時間後に切れていたこと(上)の原因も見る
2. 初回の接続の失敗(GATT 133、supervision timeout)が再現するか。結合を両側で消してから数回試す
3. 間違ったパスキー、ダイアログの取り消し、ペアリングを OS 側で削除した後の挙動(Issue #5 のテスト計画)
4. 接続後の rx の連続受信、`dropped`、Settings の書き込み(Q1 のテスト用コールサインに替えられる環境で)、schema の読み込み時間
5. `connectView.ts` の案内文(`PAIRING_HINT`)に「通知の『ペア設定リクエスト』をタップする」を足す(Android のとき)。戻るボタンと pull-to-refresh の抑止(作業 4 の未確認)も確かめる
6. 仕様側: Issue #5 にファームウェア側の返信がある(`docs/ble-protocol.md` 0.4 §4、ブランチ `ble-issues-1-6`)。60 秒以内に認証されないと切られ、パスキー待ちの目安になる。アプリの `hello` の再送(3 秒 × 5 回)は、リンクが切れるか 60 秒たつまで続ける案。`npm run spec:update` でピンを進めて確認する(まだ進めていない)

### 作業 6(PWA と Pages)

plan.md の順。`vite.config.ts`(dev だけ CSP を外すプラグインがある)に `vite-plugin-pwa` を足す。`base` は Pages のサブパス(相対)。manifest とアイコン(`public/` は Vite の雛形のまま)、`registerType` は `prompt`(接続中に勝手に再読み込みしない)。CSP に `worker-src 'self'` と `manifest-src 'self'` は入れてある。非公開リポジトリで Pages が使えるかを確かめる。公開する場合はサブモジュールの URL(非公開)を README に書く。

## 環境の注意

- ソースは Pi 5 の `~/src/pico2_aprs_webclient`。Node は nvm 経由(非対話のシェルでは `. ~/.nvm/nvm.sh` が必要)
- Bluetooth は Powered: yes。rfkill は `/usr/sbin/rfkill`(PATH にない)
- sshd は Port <port>、パスワード認証なし。Windows 側の鍵は `~/.ssh/id_ed25519_<key-name>`、ホスト名は `<host>`(config に設定)
- Pi 5 は graphical.target。画面の見方(モニター直結 / VNC / Raspberry Pi Connect)は未決定
- npm audit の警告 4 件は、ビルド時のみの依存(vite-plugin-pwa → workbox-build → glob)。成果物には入らない

## 未確認・未決定

- Pi 5 の Chromium で Web Bluetooth が使えるか(フラグが必要かもしれない)
- 仕様の未確定項目: U3(Chrome での結果は「実機確認の結果」に書いた。間違ったパスキーと取り消しは未確認なので Issue #5 は開いたまま)、U2(Device Information Service)、U5(`hello` にファームウェアの版を入れるか)、U6(`settings.set` の保存中に受信がどれだけ欠けるか)、U8(Bluetooth 5.x の Windows で通知が止まる問題が出ないか)
- GitHub Pages の公開設定は、作業 6 のとき。非公開リポジトリで Pages を使えるプランかどうか確認する
