# pico2_aprs BLE Web クライアント 実装計画

## Context

pico2_aprs(Raspberry Pi Pico 2 W の APRS トラッカー)を Android の Chrome から BLE(Web Bluetooth)で操作する Web アプリを新しく作る。
仕様の正は `klaNath/pico2_aprs` の `docs/ble-protocol.md`(proto 1。版は `docs/spec-src` のピンが示す)。設計の背景は `docs/ble-control.md` にある。
アプリにモックを組み込み、実機なしでも開発と確認ができるようにする。
インターネット上にはデータを永続的に置かない(サーバーや DB を使わない)。端末内(localStorage など)への保存は許可されている。

決定事項(ユーザー回答):

- Vite + TypeScript。素の DOM と小さな自作の状態管理を使い、UI フレームワークは使わない
- GitHub Pages + PWA(オフラインで起動できる)
- 局の位置は、簡易レーダーをオフラインで表示する(自局を中心に、距離と方位で描く)
- アプリ内モック(`?mock=1`、または接続画面の「Demo」ボタン)
- UI は英語のみ
- TNC2 を詳細に解析する(Mic-E の完全なデコード、圧縮位置、気象データ、テレメトリ、メッセージ、オブジェクト/アイテム、`<0xHH>` を UTF-8 に戻す)
- 設定画面はハイブリッド(schema を基本にし、既知の項目には専用の入力部品を使う)
- 端末への保存: UI の設定は localStorage。受信履歴はメモリに置き、件数に上限を設ける。手動でエクスポート(JSON/TNC2 ログのダウンロード)できる

## 開発環境

- Node.js は LTS(nvm など)。`npm ci` で依存を入れ、`npm run spec` で仕様書のサブモジュールを用意する(コマンドは CLAUDE.md)
- モックでの確認: `npm run dev` を起動し、`http://localhost:5173/?mock=1` を PC の Chrome で開く(モバイル幅にして全画面を操作する)
- 実機 BLE の確認(3 通り):
  - Android の Chrome: `adb reverse tcp:5173 tcp:5173` のあと、端末で `http://localhost:5173/` を開く(localhost は HTTPS と同じ扱いで Web Bluetooth が使える)。`chrome://inspect` か、`adb forward tcp:9222 localabstract:chrome_devtools_remote` で DevTools を使える
  - Web Bluetooth が使えるデスクトップの Chromium(Linux では `chrome://flags/#enable-experimental-web-platform-features` が必要なことがある)
  - 本機リポジトリの `tools/ble_cli.py`(bleak)で、アプリを介さずに相手の動きを確かめる
- 個人の開発環境(SSH、ホスト名、鍵、端末の設定)は、このリポジトリに書かない

## 構成

```
pico2_aprs_webclient/
  index.html, vite.config.ts, tsconfig.json, package.json
  public/ manifest.webmanifest, icons/
  src/
    main.ts                 起動、ルーティング(タブ)
    protocol/
      types.ts              §6〜§9 のメッセージ型(Hello, Status, Rx, Tx, Station, Schema, Err ...)
      framing.ts            LineAssembler(TextDecoder stream で \n ごとに切る)、encodeLine と 20 バイト単位の分割
    transport/
      transport.ts          interface Transport { connect, disconnect, write(bytes), onData, onDisconnect }
      webBluetooth.ts       NUS: requestDevice(サービス UUID で絞る)/ getDevices による再接続 / startNotifications
      mockTransport.ts      疑似デバイス: 設定の検証(§9.1 の範囲)、全部か無しかの set、status を 5 秒ごと、rx を不定期に送る
    client/
      deviceClient.ts       id の採番、要求と応答の対応、タイムアウト、hello の再送(認証前は捨てられるため)、
                            proto の確認、接続後の流れ(§6.2)、イベントの配信、書き込みの直列化
    aprs/
      tnc2.ts               SRC>DST,PATH:info の分解、<0xHH> → バイト列 → UTF-8
      parse.ts              データ種別ごとの解析(! = / @ ; ) : > T _ ` ')
      mice.ts               宛先と情報フィールドから緯度経度、速度、コース、メッセージを得る
      compressed.ts, weather.ts, telemetry.ts
      symbols.ts            主要なシンボルの名前表(画像は持たず、文字と色で表す)
      geo.ts                距離と方位(大圏)
    store/
      state.ts              接続状態、status、局の表(stations.list と rx で更新)、rx/tx のログ(リングバッファ、上限は設定で変えられる)
      prefs.ts              localStorage のラッパー(try/catch。テーマ、ログの上限、レーダーの縮尺)
    ui/
      connectView.ts        接続、ペアリングの案内(LCD に出るパスキー)、再接続、エラー表示
      statusView.ts         tx_ready を大きく表示、fix/sats/位置、sw、next_beacon_s、lvl_db メーター、sd、dropped
      feedView.ts           rx/tx を時系列で表示。解析結果を開くと詳細が見える
      stationsView.ts       局の一覧(距離、方位、last_s、count、lvl)
      radarView.ts          SVG のレーダー(自局が中心、対数または線形の縮尺、局をタップすると詳細)
      settingsView.ts       schema から作るフォーム + 既知の項目の専用部品、差分だけを 1 回の settings.set で送る、
                            err invalid を key ごとに表示、reset の確認、tx_enabled を true にするときの確認ダイアログ
      widgets/              共通の部品(秒の入力、path エディタ、シンボル選択、トグル)
    styles/                 CSS 変数でライト/ダーク、モバイル優先
  tests/                    Vitest
  .github/workflows/deploy.yml   GitHub Pages への配信(Actions)
```

PWA は `vite-plugin-pwa` を使う(precache のみ。実行時に外部へ取りに行くものはない)。

## 実装の要点(仕様から)

- フレーミング: 送るときは UTF-8 に変換して 20 バイト以下に分け、`writeValueWithResponse` で、1 回ごとに完了を待って順に書く(§5.2。Web Bluetooth は MTU を教えないので 20 バイトで固定。定数 `MAX_WRITE_BYTES` にしてある)
- 受けるときは notification をつなげて `\n` で切り、各行を JSON.parse する。失敗した行は捨ててログに残す
- 接続後: 通知を開始し、`hello` を送る(応答がなければ 3 秒間隔で数回再送する)。proto が 1 でなければ止めて利用者に伝える。そのあと schema → get → stations.list の順に送る
- 未知のキーや未知の kind は無視し、`other` として扱う。欠けたキーは undefined として扱う
- `busy` を受けたら、少し待って同じ要求を再送する(1 回だけ)
- 切断: `gattserverdisconnected` で、自動再接続を指数バックオフで試み、§6.2 の流れを最初からやり直す
- 安全: tx_ready は常に見える場所(ヘッダーのバッジ)に表示する。tx_enabled を true にするとき、callsign を変えるとき、reset のときは確認ダイアログを出す。mice_message は 0〜6 だけ選べる
- 受信件数の上限(既定 500)、局の表の上限(本機と同じく 64 以上でもよい)。描画は requestAnimationFrame で間引く

## 作業の順序

0. 開発環境を用意する(上の「開発環境」)
1. 雛形を作る(Vite、TS、ESLint/Prettier、Vitest、PWA、Pages の workflow)。`git init`
2. `protocol/` と `client/`、それに `mockTransport` を作る。ここまでは Vitest で検証する(行の分割、id の対応、再送、全部か無しか)
3. `aprs/` パーサーを作り、Vitest で検証する。テストデータの局名は仕様の注意どおり Q1 で始まる架空のコールサインを使う
4. UI: ヘッダーとステータス → フィード → 局の一覧 → レーダー → 設定 の順。モックで動作を確かめる
5. `webBluetooth.ts` を作る。Chrome(PC)で実機または ble_cli 相当の相手と確かめる。U3(ペアリングダイアログが出るか)の結果によっては、案内の文面を変える
6. PWA と Pages への配信、Android の Chrome での確認

## 検証

- `npm run test`: framing、deviceClient(mock を使う)、TNC2/Mic-E/圧縮位置/気象/テレメトリのパーサー
- `npm run dev` から `http://localhost:5173/?mock=1` を開く。PC の Chrome でモバイル幅にして全画面を操作する。settings.set の差分送信、invalid の表示、確認ダイアログを確かめる
- `npm run build && npm run preview` でオフライン起動を確かめる(DevTools の Offline)
- 本機の BLE 層ができたら、Android の Chrome で次を確かめる: ペアリング(パスキー)、再接続、rx の連続受信、dropped の表示
