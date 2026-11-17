# pico2_aprs BLE Web クライアント 実装計画

## Context

pico2_aprs(Raspberry Pi Pico 2 W の APRS トラッカー)を Android の Chrome から BLE(Web Bluetooth)で操作する Web アプリを新しく作る。
仕様の正は `klaNath/pico2_aprs` の `docs/ble-protocol.md`(v0.3 / proto 1)。設計の背景は `docs/ble-control.md` にある。
本機の BLE 層(§2〜§5.2)はまだ実装されていない(暫定)ので、アプリにモックを組み込み、実機なしで開発を進める。
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

## 開発環境(Raspberry Pi 5 で開発し、Windows の VS Code から Remote-SSH で使う)

構成:
```
[Windows 11: VS Code + Remote-SSH, Chrome] ──SSH :<port>──> [Pi 5: <user>@<host>]
      │  VS Code がポート 5173 を転送する                                  Node.js(nvm)/ Vite dev server / Claude Code
      └─ USB ── [Android: adb reverse tcp:5173]                           デスクトップ + Chromium + BlueZ(内蔵 BT)
```
- ソースは Pi 5 の `~/src/pico2_aprs_webclient` に置く。この計画は `docs/plan.md` にコピーして引き継ぐ
- モックを使った確認: Windows の Chrome で、転送された `http://localhost:5173/?mock=1` を開く
- 実機 BLE の確認: Pi 5 の Chromium(Web Bluetooth)、Pi 5 で動かす `tools/ble_cli.py`(bleak)、Android(adb reverse)の 3 通り

### Pi 5 の現状(2026-11-17 に SSH で調べた結果)
| 項目 | 状態 |
|---|---|
| OS | Debian 13 trixie(Raspberry Pi のカーネル 6.12.75+rpt-rpi-2712)、aarch64、メモリ 8GB、SSD 459GB(2% 使用) |
| sshd | Port <port>、PasswordAuthentication no。ホスト鍵 ED25519 `<host-key-fingerprint>` |
| sudo | パスワードなしで使える |
| 起動ターゲット | multi-user.target(ヘッドレス、デスクトップなし) |
| Node.js | Debian の nodejs v20.19.2(サポート終了)、npm なし → 使わない |
| git | 2.47.3。user.name と user.email は未設定 |
| gh / Chromium / Claude Code | なし |
| Bluetooth | `/boot/firmware/config.txt` の `dtoverlay=disable-bt` で無効。bluetooth.service は enabled だが inactive。rfkill なし |
| python3 | 3.13.5 |

### セットアップ手順(順に行う)

**S0. Windows 側の SSH(利用者)**
- 秘密鍵 `<path to the private key>` を `%USERPROFILE%\.ssh\` に移す(プロジェクトのフォルダに置くと、コミットや同期で漏れるおそれがある。Windows の OpenSSH は ACL も確かめる)
- `%USERPROFILE%\.ssh\config` に次を足す:
  ```
  Host <host>
    HostName <host>.local
    Port <port>
    User <user>
    IdentityFile ~/.ssh/id_ed25519_<key-name>
    IdentitiesOnly yes
  ```
- `ssh <host> uname -a` で接続できることを確かめる(初回はホスト鍵の指紋が上の値と一致するか見る)

**S1. 基本パッケージ(Claude が SSH で行う)**
- `sudo apt update && sudo apt full-upgrade -y`
- `sudo apt install -y git curl ca-certificates build-essential rfkill python3-venv`

**S2. Bluetooth を有効にする(再起動を伴うので、実行前に利用者に伝える)**
- `config.txt` を `config.txt.bak-20261117` に退避する → `dtoverlay=disable-bt` を `#dtoverlay=disable-bt` にする
- `sudo usermod -aG bluetooth <user>`
- 再起動する → `hciconfig`/`bluetoothctl show` でコントローラーが出ること、`systemctl is-active bluetooth` が active であること、`rfkill list` でブロックされていないことを確かめる

**S3. デスクトップと Chromium**
- Raspberry Pi のデスクトップのメタパッケージを入れる(trixie での名前を `apt-cache search` で確かめてから。Bookworm では `raspberrypi-ui-mods`。Wayland/labwc の構成)と、Chromium(`chromium` か `chromium-browser`。どちらか確かめる)
- `sudo systemctl set-default graphical.target`。自動ログインは任意で、`raspi-config` で設定する
- 画面の見方: モニターを直接つなぐか、VNC(`raspi-config` → Interface → VNC、wayvnc)か Raspberry Pi Connect。SSH ポートは <port> のまま変えない
- Chromium の Web Bluetooth: Linux 版では `chrome://flags/#enable-experimental-web-platform-features` が必要な場合がある。入れたバージョンで確かめる。passkey は Chromium/BlueZ のダイアログで入力する

**S4. Node.js(nvm、sudo は不要)**
- nvm の公式インストールスクリプトをバージョンを指定して実行する → `nvm install --lts` → `nvm alias default lts/*`
- `node -v` / `npm -v`。Debian の nodejs v20 は残しておいてもよい(PATH の先頭が nvm になっていることを確かめる)

**S5. GitHub CLI と git**
- cli.github.com の公式 apt リポジトリを登録する → `sudo apt install gh`
- `gh auth login`(利用者が対話的に行う。HTTPS と git の認証にも使う)
- `git config --global user.name klaNath`
- `git config --global user.email <ID>+klaNath@users.noreply.github.com`(ID は `gh api user --jq .id` で得る)
- `git config --global init.defaultBranch main`

**S6. VS Code Remote-SSH と Claude Code**
- Windows の VS Code に「Remote - SSH」を入れ → `<host>` に接続する(VS Code Server の arm64 版が自動で入る)
- リモート側に Claude Code、ESLint、Prettier の拡張を入れ、Claude Code にログインする
- `mkdir -p ~/src/pico2_aprs_webclient` → VS Code でこのフォルダを開く

**S7. 実機確認の補助(作業 5 までに)**
- Pi 5: `python3 -m venv ~/venv/ble && ~/venv/ble/bin/pip install bleak`(本機リポジトリの `tools/ble_cli.py` 用)
- Windows: `winget install Google.PlatformTools`(adb)。Android の USB デバッグを有効にし、`chrome://inspect` を使う

確認の条件(セットアップが終わったとき):
- Pi 5 で `node -v` が LTS、`gh auth status` が OK、`bluetoothctl show` が Powered: yes
- Pi 5 のデスクトップで Chromium が起動する
- Windows の VS Code から Remote-SSH で `~/src/pico2_aprs_webclient` を開き、そこで Claude Code が動く

## 構成

```
~/src/pico2_aprs_webclient/   (Pi 5)
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

0. 開発環境のセットアップ(上の S0〜S6。S7 は作業 5 までに)
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
