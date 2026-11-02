# CoreLab — インフラ運用トレーニングゲーム

Kubernetes・Docker・Harbor・OpenShift・AWS の「よくある障害」を、ブラウザの中の本物そっくりなターミナルで解決しながら学ぶゲームです。クリアするほど XP が貯まってランクが上がり、ホーム画面の「あなたのデータセンター」のラックが稼働していきます。

- インストール不要・オフラインで動作（外部 CDN も不使用）
- すべての操作はブラウザ内のシミュレーション。実際のクラスタ・クラウド・ネットワークには一切接続しません
- 表示されるホスト名・IP・ログ・脆弱性・顧客データ・パスワードはすべて訓練用の架空データです
- 日本語・한국어・English (UK)・中文（台灣）。画面右上の地球のアイコンで切り替えます（ミッション・学習問題・資格・コマンド辞典まですべて）

## 起動

`index.html` をブラウザで開くだけで遊べます。ローカルサーバーで動かす場合:

```bash
python -m http.server 8123
```

→ http://localhost:8123/

開発用に全ミッションを解放するには URL に `?unlock=all` を付けます（例: `http://localhost:8123/?unlock=all`）。言語は `?lang=ko` / `?lang=en-GB` / `?lang=zh-TW` / `?lang=ja` でも選べます。

## ミッション（19 本 + フリーラボ）

| トラック   | ミッション                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Linux 基礎 | 初日の当番（grep/パイプ）・Web サーバーが起動しない（ssh/systemctl/journalctl/nginx -t）                                     |
| Docker     | はじめてのコンテナ・Compose が立ち上がらない・イメージをビルドせよ                                                           |
| Harbor     | 社内レジストリへ push・脆弱性ポリシーに止められた・private イメージを pull せよ（robot + imagePullSecret）                   |
| Kubernetes | キャパシティ復旧・Service に繋がらない・悪いリリースを戻せ・設定が足りない Pod・Pending から抜け出せ・ノードのディスクが満杯 |
| OpenShift  | はじめての OpenShift（login/new-project/new-app/Route）・root で動かないコンテナ（SCC）                                      |
| AWS        | EKS クラスタにつなげ・HTTPS が届かない（SG）・S3 公開事故を止めろ                                                            |

各トラックは順番に解放されます。★3 = ヒントなし＆目標時間内。

## ラーニング（学習問題と資格対策）

画面上部の「ラーニング」から、分野ごとの学習問題に進めます。ミッションの目標欄からも、その回に必要な知識の問題集へ直接飛べます（戻るとミッションは続きから再開し、離れていた時間はタイムに加算されません）。

- **6 分野 × 5 段階**: 入門 → 基礎 → 実務 → 応用 → エキスパート（Linux / Docker / Harbor / Kubernetes / OpenShift / AWS）
- **資格対策の補講 24 本**: 段階別では扱いきれない試験範囲（シェルスクリプト、SELinux、Ansible、Swarm、Podman、CKA のクラスタ構築、サプライチェーン、AWS の監視・設計など）
- **全 333 問**: 選択式とコマンド記述式。1 問ごとに解説と、公式ドキュメントへの出典リンクが付きます
- **資格 60 試験**: 公式の出題範囲（ドメインと配点）を掲載し、各ドメインにどの問題集が対応しているかとカバー率を表示。配点に応じて出題する模擬試験つき
  - Linux: LFCA / LFCS / RHCSA(EX200) / RHCE(EX294) / LPIC-1〜3 / LinuC レベル1〜3 / CompTIA Linux+
  - コンテナ: DCA / EX188、レジストリは CKS のサプライチェーン分野に対応
  - Kubernetes: KCNA / KCSA / CKAD / CKA / CKS / CKNE / CNPA / CNPE と CNCF の関連認定（CAPA・CCA・KCA・ICA・PCA・OTCA・CGOA）
  - OpenShift: EX180 / EX280 / EX380 / EX288 / EX282 / EX316 / EX156 / EX336 / EX370 / EX430 / EX432 / EX378 / EX267
  - AWS: CLF-C02 / SAA-C03 / SOA-C03 / DVA-C02 / SAP-C02 / DOP-C02 / SCS-C03 / ANS-C01 / AIF-C01 / AIB-C01 / AIP-C01 / MLA-C02 / DEA-C01

AI・機械学習や言語フレームワークなど、このゲームの範囲外のドメインは「範囲外」と明示しています（カバー率には含めません）。合格すると XP とバッジが得られ、ミッションと同じキャリアに積み上がります。

## コマンド辞典（検索と関連）

画面上部の「コマンド辞典」、またはどの画面でも <kbd>Ctrl</kbd>+<kbd>K</kbd>（<kbd>/</kbd>・右上の ⌕）で開けます。ミッション中に開いても環境はそのままで、使用例の「入力」でターミナルに入ります。

- **コマンド名でも「やりたいこと」でも**: `ss`、`k get pods`、`ポートを使っているプロセス`、`消したい ファイル`、`CrashLoopBackOff` などで検索。言い換え（消したい→削除、重い→CPU/負荷）や助詞の違いを吸収します
- **558 コマンド + 175 レシピ**: Linux（LPIC/LFCS の範囲とシェル組み込み・制御構文）、Docker、Harbor、kubectl、oc、aws。シミュレータで動かないが実務で必要なもの（helm・trivy・git など）も「実機のみ」として収録
- **関連をたどれる**: 各コマンドに書式・使用例・主なオプション・関連コマンド・一緒に使われるコマンド・そのコマンドを使うレシピ・学習問題・ミッション・公式ドキュメント
- **ターミナルからも同じ辞典**: `man <コマンド>` / `<コマンド> --help` / `whatis` が全コマンドに対応し、`apropos <やりたいこと>`（`man -k`）は日本語でも探せます
- 早見表（ミッション右側）・学習問題の「出てくるコマンド」・クリア画面のコマンド表も辞典につながっています

## シミュレータが扱えるもの（抜粋）

- **Linux（Ubuntu 22.04/24.04・RHEL 9）**: bash 互換シェル（変数展開・`$(...)`・ヒアドキュメント・関数・ループ・`[[ ]]`・リダイレクト・履歴・Tab 補完）、権限（所有者・umask・sudo・ACL・chattr）、ユーザー管理、systemd/journalctl、apt/dnf、ネットワーク（ip/ss/ufw/firewalld/nmcli/netplan）、ストレージ（parted・LVM・mkfs・fstab・スワップ・オンライン拡張）など約 300 コマンド。対応範囲と再現できないものは [docs/LINUX-COVERAGE.md](docs/LINUX-COVERAGE.md) を参照
- **kubectl / oc**: get（-o wide/yaml/json/name/jsonpath, -l, -A, --show-labels）・describe・logs・apply/create/delete/edit/patch・scale・set image/env・rollout status/history/undo/restart・exec・run --rm・expose・top・cordon/drain・config。OpenShift は login・new-project・new-app・expose（Route）・SCC
- **Kubernetes の挙動**: スケジューラ（requests・taint・DiskPressure）、イメージ pull（存在しないタグ・401・Harbor ポリシー）、ConfigMap/Secret 参照、RollingUpdate（失敗時に旧 Pod を残す）、Service/Endpoints（selector・targetPort）、readinessProbe
- **docker**: run/ps/logs/exec/build（Dockerfile 解析・BuildKit 風出力）/tag/push/pull/login、`docker compose up/ps/logs/down`（サービス名 DNS）
- **harbor**: プロジェクト・自動スキャン・脆弱性一覧・脆弱性ブロック・robot アカウント
- **aws**: sts・ec2（インスタンス・SG の追加/削除）・s3/s3api（Block Public Access）・eks update-kubeconfig、`--query`（JMESPath サブセット）/`--output text`

## 開発者向け

```
index.html            画面構造（スクリプトの読み込み順もここが正）
css/app.css           テーマ・レイアウト・レスポンシブ
js/core/util.js       共通処理・YAML パーサ/シリアライザ・仮想ファイルシステム
js/core/i18n.js       言語の選択と翻訳（IG.t・IG.i18n.deep・言語メニュー。下の「言語」を参照）
js/i18n/<言語>/*.js   翻訳（ko / en-GB / zh-TW。ui・sim・missions・learn・ref の 5 ファイル）
js/sim/               シミュレーションモデル（DOM 非依存）
  images.js           イメージカタログとコンテナ起動判定
  world.js            1 ミッション分の世界（ホスト・クラスタ・HTTP 経路解決）
  k8s.js              Kubernetes/OpenShift クラスタ（reconcile・Pod 状態計算）
  docker.js harbor.js aws.js   各サービスのモデル + CLI
js/cmd/bash.js        bash の字句解析・構文木・展開・実行
js/cmd/shell.js       シェル本体（コマンド実行・権限・ssh/sudo のスタック・Tab 補完）
js/cmd/coreutils.js textproc.js sysutils.js storage.js netutils.js extras.js   Linux コマンド群
js/cmd/kubectl.js     kubectl / oc
js/game/engine.js     トラック・ランク・バッジ・セッション（目標判定/採点）・進捗保存
js/game/learn.js      ラーニング層（段階・問題集・資格カタログ・ドリル/模擬試験の実行と採点）
js/game/drills/*.js   学習問題（段階別は <分野>.js、資格対策の補講は extra-<分野>.js）
js/game/certs/*.js    資格カタログ（試験コード・公式 URL・出題範囲と配点・対応する問題集）
js/game/missions/*.js ミッション定義（データ駆動）
js/ui/datacenter.js   アイソメトリックのデータセンター描画（Canvas 2D）
js/ref/cmdref.js      コマンド辞典の本体（登録・検索・関連づけ・apropos。DOM 非依存）
js/ref/<分野>.js      辞典のデータ（linux.js / linux-tasks.js / docker.js / harbor.js / k8s.js / openshift.js / aws.js）
js/ui/ref.js          辞典の画面部品（#/ref のページと Ctrl+K の検索で共用）
js/ui/app.js          画面制御（ホーム・ミッション・ターミナル・エディタ）
portal.json           サイト一覧（Home Page）の CoreLab カードに出す「すぐ遊べるミッション」
og.png                リンクを貼ったときのプレビュー画像（1200×630。index.html の og:image）/ apple-touch-icon.png ホーム画面のアイコン
tests/run-solutions.js 全ミッションの模範解答を自動プレイして解けることを検証（portal.json のミッションも確認）
tests/run-linux.js    Linux シミュレータの回帰テスト（実機の出力・エラー・終了コードと照合）
tests/run-learn.js    学習問題・資格カタログの検証（出典・配点・採点・模擬試験・進捗）
tests/run-ref.js      コマンド辞典の検証（全コマンドの収録・リンク・全使用例の実行・検索品質・man/apropos）
tests/run-i18n.js     翻訳の検証（訳のない文・{名前} の欠け・各言語で全ミッションが解けるか・portal.json）
```

### テスト

```bash
node tests/run-solutions.js          # 全ミッション
node tests/run-solutions.js k8s-03 -v # 1 本を出力付きで
node tests/run-linux.js              # Linux の回帰テスト（約 400 件）
node tests/run-linux.js lvm -v       # 名前に lvm を含むケースだけ
node tests/run-learn.js              # 学習問題と資格カタログ
node tests/run-learn.js -v           # 資格ごとのカバー率つき
node tests/run-ref.js                # コマンド辞典（約 1,150 の使用例をシミュレータで実行）
node tests/run-i18n.js               # 3 言語の翻訳（ko / en-GB / zh-TW）
node tests/run-i18n.js en-GB -v      # 1 言語だけ、全件表示
```

各ミッションについて「開始時点で目標が未達成であること」と「模範解答で全目標を達成できること」を確認します。ミッションやシミュレータを変更したら必ず実行してください。

### 書式とチェック

Home Page・News Site と同じ書式です（1 行 120 字・ダブルクォート・LF。`.editorconfig` と `.prettierrc.json` は 3 リポジトリで同じファイル）。VS Code は推奨拡張（EditorConfig・Prettier・ESLint）を入れると保存時に整形します。

```bash
npm install       # 初回だけ（Prettier と ESLint。ゲーム自体はパッケージ不要）
npm run format    # Prettier で整形
npm run lint      # 整形済みかの確認と ESLint（警告 0 件まで）
npm test          # 上のテストをすべて
```

GitHub に push すると Actions（`.github/workflows/ci.yml`）が `npm test` と `npm run lint`（警告 0 件まで）を通します。VM は master を 1 分以内に配信するので、赤くなったらすぐ直してください。

index.html（本文が翻訳を引くキー）と js/ref・js/i18n（1 行 1 項目の表）は整形しません（`.prettierignore`）。

### コマンド辞典への追加

`js/ref/<分野>.js` の `IG.registerCommands({...})` に足します。書式は `js/ref/cmdref.js` 冒頭のコメントを参照してください。

```js
c('ss', 'net', 8, 'another utility to investigate sockets',          // 名前・分類・man のセクション・man の NAME 行
  '待ち受け中のポート・接続を表示する（netstat の後継）。',             // 説明（最初の文が一覧と apropos に出ます）
  'ss [options] [ FILTER ]',                                          // 書式
  [['sudo ss -tlnp', '待ち受け中の TCP ポートとプロセス']],           // 使用例（3 つ目に 1 を書くと「実機のみ」）
  'netstat, lsof, ip', 'ポート 待ち受け 接続 確認'),                  // 関連コマンド・検索用の言い換え
```

- シミュレータで動かないコマンドは `{ nosim: true }`、別名は `same('egrep', 'grep', 1, '…')`
- 「やりたいこと」は `tasks: [{ q: '〜する', k: '言い換え', do: [['コマンド', '説明']], note: '…' }]`
- シミュレータに新しいコマンドを足したら辞典にも登録してください（`node tests/run-ref.js` の coverage が確認します）
- 使用例は自動でシミュレータ実行され、未対応のオプションや存在しない関連コマンドはテストで検出されます

### 学習問題の追加

`js/game/drills/` で `IG.registerDrills({...})`（段階別 5 本）または `IG.addExtras({...})`（資格対策の補講）を呼びます。

```js
IG.addExtras({
  topic: "k8s",
  refs: { helm: ["Helm Docs", "https://helm.sh/docs/"] }, // 出典（公式ドキュメント）
  extras: [
    {
      id: "workloads",
      title: "ワークロードとパッケージ",
      goal: "到達目標",
      refs: ["helm"],
      points: ["要点…"],
      qs: [
        { q: "設問", c: ["正解", "誤り1", "誤り2"], x: "解説", r: "helm" }, // 選択式（c[0] が正解）
        { q: "設問", a: "helm rollback web", ok: [/^helm rollback web$/], x: "解説", r: "helm" }, // 記述式
      ],
    },
  ],
});
```

段階別の問題集に `missions: ['k8s-01']` を書くと、そのミッションの「必要な知識」に表示されます。資格は `js/game/certs/` で `IG.registerCerts({...})` に公式の出題範囲（配点の合計は 100）と対応する問題集（`'<分野>:<段階>'` または `'<分野>:#<補講 id>'`）を書きます。追加したら `index.html` の `<script>` に足し、`node tests/run-learn.js` を実行してください。

### ミッションの追加

`js/game/missions/` のファイルで `IG.registerMission({...})` を呼ぶだけです。

```js
IG.registerMission({
  id: "k8s-07",
  track: "k8s",
  order: 7,
  difficulty: 2,
  par: 420,
  xp: 180,
  title: "タイトル",
  summary: "一覧に出る一行説明",
  story: ["ブリーフィング本文…"],
  setup(w, B) {
    // w = IG.World, B = IG.build ヘルパー
    const cl = B.cluster(w, { name: "training-cluster", namespaces: ["demo"], ns: "demo" });
    w.addImage("registry.lab.local/demo/app:1.0", { kind: "app", app: "app", port: 8080 });
    B.apply(cl, B.deploy("app", "demo", { image: "registry.lab.local/demo/app:1.0", port: 8080, replicas: 2 }));
    B.files(w, { "/home/operator/manifests/app.yaml": "..." });
  },
  objectives: [
    {
      title: "目標",
      detail: "説明",
      hints: ["ヒント1", "ヒント2 `コマンド`"],
      check: (w, c) => c.cluster().healthy("demo", "app", 2),
    }, // c.ran(/re/), c.http(fn), c.file(path) など
  ],
  solution: ["kubectl get pods", "..."], // テストで自動実行される模範解答
  debrief: { points: ["学び"], commands: [["kubectl …", "説明"]] },
});
```

新しいファイルを作ったら `index.html` の `<script>` に追加してください（テストも同じ順序で読み込みます）。

### 言語

文はすべて日本語で書き、表示するときにその日本語を各言語の訳（`js/i18n/<言語>/*.js` の `"日本語": "訳"`）で引き当てます。訳がない文は日本語のまま出ます。

- コードの文は `IG.t('〜を表示する')`、差し込みは `IG.t('{n} 件', { n })`（画面のコードでは `T(...)`）
- ミッション・学習問題・辞典のデータは登録時に `IG.i18n.deep()` が訳すので、そのまま日本語で書けばよい。`id`・`solution`・`cmd`・`a`・`ok` などターミナルに打つ値は訳しません（一覧は `js/core/i18n.js` の `KEEP`）
- `index.html` の文は起動時に訳します。中にタグを含む文は要素に `data-i18n` を付けて丸ごと 1 文にします
- 選んだ言語は Cookie `lang` に入り、Home Page の他のサイトと共有されます（単体で開いたときは localStorage にも保存）

日本語の文を足したり変えたりしたら、ko / en-GB / zh-TW の 3 ファイルすべてに同じ日本語をキーにした訳を足し、`node tests/run-i18n.js` を実行してください（訳のない文を一覧します）。表記は en-GB が英国式（centre・licence・optimise）、zh-TW が台湾の用語（伺服器・連接埠・映像倉庫）、`{名前}` とコマンド・パス・コードは訳さずそのまま。辞典の検索語（`k`）は各言語の言い換えを空白区切りで書きます。

## ロードマップ

- 3D 化: `IG.DC.sceneFromWorld()` / `sceneFromProgress()` が返すシーン（ゾーン・ラック・ユニット・リンク）は描画方式に依存しないデータです。将来は Three.js などの 3D レンダラに差し替えて、Steam の Data Center のようにデータセンター内を歩き回れる形を目指します。
- ミッション追加（NetworkPolicy・PV/PVC・HPA・Ingress・IAM・Terraform など）
- 時間経過で悪化するインシデント（SLA ゲージ）・ランダム障害モード
