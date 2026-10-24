# CoreLab — インフラ運用トレーニングゲーム

Kubernetes・Docker・Harbor・OpenShift・AWS の「よくある障害」を、ブラウザの中の本物そっくりなターミナルで解決しながら学ぶゲームです。クリアするほど XP が貯まってランクが上がり、ホーム画面の「あなたのデータセンター」のラックが稼働していきます。

- インストール不要・オフラインで動作（外部 CDN も不使用）
- すべての操作はブラウザ内のシミュレーション。実際のクラスタ・クラウド・ネットワークには一切接続しません
- 表示されるホスト名・IP・ログ・脆弱性・顧客データ・パスワードはすべて訓練用の架空データです

## 起動

`index.html` をブラウザで開くだけで遊べます。ローカルサーバーで動かす場合:

```bash
python -m http.server 8123
```

→ http://localhost:8123/

開発用に全ミッションを解放するには URL に `?unlock=all` を付けます（例: `http://localhost:8123/?unlock=all`）。

## ミッション（19 本 + フリーラボ）

| トラック | ミッション |
| --- | --- |
| Linux 基礎 | 初日の当番（grep/パイプ）・Web サーバーが起動しない（ssh/systemctl/journalctl/nginx -t） |
| Docker | はじめてのコンテナ・Compose が立ち上がらない・イメージをビルドせよ |
| Harbor | 社内レジストリへ push・脆弱性ポリシーに止められた・private イメージを pull せよ（robot + imagePullSecret） |
| Kubernetes | キャパシティ復旧・Service に繋がらない・悪いリリースを戻せ・設定が足りない Pod・Pending から抜け出せ・ノードのディスクが満杯 |
| OpenShift | はじめての OpenShift（login/new-project/new-app/Route）・root で動かないコンテナ（SCC） |
| AWS | EKS クラスタにつなげ・HTTPS が届かない（SG）・S3 公開事故を止めろ |

各トラックは順番に解放されます。★3 = ヒントなし＆目標時間内。

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
js/game/missions/*.js ミッション定義（データ駆動）
js/ui/datacenter.js   アイソメトリックのデータセンター描画（Canvas 2D）
js/ui/app.js          画面制御（ホーム・ミッション・ターミナル・エディタ）
portal.json           サイト一覧（Home Page）の CoreLab カードに出す「すぐ遊べるミッション」
tests/run-solutions.js 全ミッションの模範解答を自動プレイして解けることを検証（portal.json のミッションも確認）
tests/run-linux.js    Linux シミュレータの回帰テスト（実機の出力・エラー・終了コードと照合）
```

### テスト

```bash
node tests/run-solutions.js          # 全ミッション
node tests/run-solutions.js k8s-03 -v # 1 本を出力付きで
node tests/run-linux.js              # Linux の回帰テスト（約 400 件）
node tests/run-linux.js lvm -v       # 名前に lvm を含むケースだけ
```

各ミッションについて「開始時点で目標が未達成であること」と「模範解答で全目標を達成できること」を確認します。ミッションやシミュレータを変更したら必ず実行してください。

### ミッションの追加

`js/game/missions/` のファイルで `IG.registerMission({...})` を呼ぶだけです。

```js
IG.registerMission({
  id: 'k8s-07', track: 'k8s', order: 7, difficulty: 2, par: 420, xp: 180,
  title: 'タイトル', summary: '一覧に出る一行説明',
  story: ['ブリーフィング本文…'],
  setup(w, B) {                       // w = IG.World, B = IG.build ヘルパー
    const cl = B.cluster(w, { name: 'training-cluster', namespaces: ['demo'], ns: 'demo' });
    w.addImage('registry.lab.local/demo/app:1.0', { kind: 'app', app: 'app', port: 8080 });
    B.apply(cl, B.deploy('app', 'demo', { image: 'registry.lab.local/demo/app:1.0', port: 8080, replicas: 2 }));
    B.files(w, { '/home/operator/manifests/app.yaml': '...' });
  },
  objectives: [
    { title: '目標', detail: '説明', hints: ['ヒント1', 'ヒント2 `コマンド`'],
      check: (w, c) => c.cluster().healthy('demo', 'app', 2) },  // c.ran(/re/), c.http(fn), c.file(path) など
  ],
  solution: ['kubectl get pods', '...'],   // テストで自動実行される模範解答
  debrief: { points: ['学び'], commands: [['kubectl …', '説明']] },
});
```

新しいファイルを作ったら `index.html` の `<script>` に追加してください（テストも同じ順序で読み込みます）。

## ロードマップ

- 3D 化: `IG.DC.sceneFromWorld()` / `sceneFromProgress()` が返すシーン（ゾーン・ラック・ユニット・リンク）は描画方式に依存しないデータです。将来は Three.js などの 3D レンダラに差し替えて、Steam の Data Center のようにデータセンター内を歩き回れる形を目指します。
- ミッション追加（NetworkPolicy・PV/PVC・HPA・Ingress・IAM・Terraform など）
- 時間経過で悪化するインシデント（SLA ゲージ）・ランダム障害モード
