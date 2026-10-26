/* コマンド辞典: Harbor（レジストリ）と周辺のサプライチェーンツール。
 * harbor コマンドは公式 CLI（goharbor/harbor-cli）の書式に沿ったシミュレータの一部実装。doc は goharbor.io の公式文書。 */
(function (IG) {
  'use strict';
  const H = 'https://goharbor.io/docs/main/';
  const h = (n, cat, path, en, ja, syn, ex, rel, k, more) => Object.assign({ n, cat, doc: /^https/.test(path) ? path : H + path, en, ja, syn, ex, rel, k }, more || {});
  IG.registerCommands({
    topic: 'harbor',
    cats: { cli: 'Harbor CLI', supply: 'サプライチェーン・署名' },
    cmds: [
      h('harbor', 'cli', 'https://github.com/goharbor/harbor-cli', 'Official Harbor CLI', 'Harbor（社内コンテナレジストリ）を操作する CLI。プロジェクト・リポジトリ・脆弱性スキャン・robot アカウントを扱う。', 'harbor COMMAND [SUBCOMMAND] [flags]', [['harbor project list', 'プロジェクト一覧'], ['harbor help', '使い方']], 'harbor project list, harbor artifact list, docker login', 'レジストリ harbor'),
      h('harbor login', 'cli', 'working-with-projects/working-with-images/pulling-pushing-images/', 'Log in to Harbor registry', 'Harbor にログインする（CLI 用）。イメージの push/pull は docker login。', 'harbor login <host> -u <user> -p <password>', [['harbor login harbor.lab.local -u admin -p <password>', 'ログイン']], 'docker login, harbor project list', 'ログイン 認証'),
      h('harbor project list', 'cli', 'working-with-projects/create-projects/', 'List projects', 'プロジェクトの一覧（公開/非公開、リポジトリ数）を表示する。', 'harbor project list', [['harbor project list', '一覧']], 'harbor project create, harbor repo list', 'プロジェクト 一覧 公開'),
      h('harbor project create', 'cli', 'working-with-projects/create-projects/', 'Create a project', 'プロジェクトを作る。--prevent-vul で一定以上の脆弱性があるイメージの pull を禁止できる。', 'harbor project create <name> [--public] [--prevent-vul critical|high]', [['harbor project create shop --prevent-vul critical', 'Critical があるイメージは pull 禁止']], 'harbor project list, harbor project view', 'プロジェクト 作成 脆弱性 防止'),
      h('harbor project view', 'cli', 'working-with-projects/project-configuration/', 'Get project details', 'プロジェクトの設定（公開・脆弱性ポリシー・自動スキャン）を表示する。', 'harbor project view <name>', [['harbor project view shop', '設定を確認']], 'harbor project list', 'プロジェクト 設定'),
      h('harbor repo list', 'cli', 'working-with-projects/working-with-images/', 'List repositories in a project', 'プロジェクト内のリポジトリ（イメージ名）を一覧する。', 'harbor repo list <project>', [['harbor repo list shop', '一覧']], 'harbor artifact list', 'リポジトリ イメージ 一覧'),
      h('harbor artifact list', 'cli', 'working-with-projects/working-with-images/', 'List artifacts', 'リポジトリのタグ（アーティファクト）と、サイズ・スキャン結果を一覧する。', 'harbor artifact list <project>/<repo>', [['harbor artifact list shop/web', 'タグとスキャン状況']], 'harbor artifact scan, harbor artifact vulnerabilities, docker pull', 'タグ 一覧 スキャン'),
      h('harbor artifact scan', 'cli', 'administration/vulnerability-scanning/', 'Scan an artifact', 'イメージの脆弱性スキャン（Trivy）を実行する。', 'harbor artifact scan <project>/<repo>:<tag>', [['harbor artifact scan shop/web:1.5', 'スキャン']], 'harbor artifact vulnerabilities', '脆弱性 スキャン cve'),
      h('harbor artifact vulnerabilities', 'cli', 'administration/vulnerability-scanning/', 'Show vulnerabilities of an artifact', 'スキャン結果の脆弱性（CVE・深刻度・修正版）を一覧する。', 'harbor artifact vulnerabilities <project>/<repo>:<tag>', [['harbor artifact vulnerabilities shop/web:1.4', 'どの CVE が何で直るか']], 'harbor artifact scan, docker build', '脆弱性 cve 深刻度 修正'),
      h('harbor robot create', 'cli', 'working-with-projects/project-configuration/create-robot-accounts/', 'Create a robot account', 'CI や Kubernetes の pull 用に、権限を絞った robot アカウントを作る。', 'harbor robot create <name> --project <project> [--permissions pull,push]', [['harbor robot create k8s-pull --project shop --permissions pull', 'pull 専用']], 'harbor robot list, kubectl create secret docker-registry', 'robot アカウント 認証 pull ci'),
      h('harbor robot list', 'cli', 'working-with-projects/project-configuration/create-robot-accounts/', 'List robot accounts', 'robot アカウントの一覧。', 'harbor robot list', [['harbor robot list', '一覧']], 'harbor robot create', 'robot 一覧'),
      { n: 'trivy', cat: 'supply', doc: 'https://trivy.dev/latest/docs/', en: 'Scanner for vulnerabilities in container images, file systems, and Git repositories', ja: 'イメージやファイルの脆弱性・設定ミスをスキャンする（Harbor の既定スキャナ）。', syn: 'trivy [command] [target]', ex: [['trivy image --severity HIGH,CRITICAL shop/web:1.5', '高・重大のみ'], ['trivy fs --scanners vuln,secret .', 'ソースの脆弱性と秘密情報']], rel: 'harbor artifact scan', k: '脆弱性 スキャン cks', nosim: true },
      { n: 'cosign', cat: 'supply', doc: 'https://docs.sigstore.dev/cosign/signing/overview/', en: 'Container Signing, Verification and Storage in an OCI registry', ja: 'イメージに署名・検証する（Sigstore）。', syn: 'cosign [command]', ex: [['cosign sign --key cosign.key harbor.lab.local/shop/web:1.5', '署名'], ['cosign verify --key cosign.pub harbor.lab.local/shop/web:1.5', '検証']], rel: 'harbor, trivy', k: '署名 検証 サプライチェーン', nosim: true },
    ],
    tasks: [
      { q: 'Harbor のプロジェクトとイメージを確認する', k: 'レジストリ 中身 タグ', do: [['harbor project list', 'プロジェクト'], ['harbor repo list shop', 'リポジトリ'], ['harbor artifact list shop/web', 'タグとスキャン結果']] },
      { q: 'イメージの脆弱性を調べる', k: 'cve スキャン セキュリティ 深刻度', do: [['harbor artifact scan shop/web:1.5', 'スキャン実行'], ['harbor artifact vulnerabilities shop/web:1.5', 'CVE と修正バージョン']], note: 'ベースイメージを修正版に上げて再ビルド → 新しいタグで push → 再スキャン、が基本の流れ。' },
      { q: '脆弱性のあるイメージを pull させない', k: 'ポリシー 防止 prevent', do: [['harbor project create shop --prevent-vul critical', '作成時に設定'], ['harbor project view shop', '設定を確認']] },
      { q: 'Kubernetes から Harbor のイメージを pull できるようにする', k: 'imagepullbackoff 認証 robot pull secret', do: [['harbor robot create k8s-pull --project shop --permissions pull', 'pull 専用の robot'], ['kubectl create secret docker-registry harbor-pull --docker-server=harbor.lab.local --docker-username=<robot名> --docker-password=<token> -n shop', 'Secret を作る'], ['kubectl patch serviceaccount default -n shop -p \'{"imagePullSecrets":[{"name":"harbor-pull"}]}\'', 'ServiceAccount に付ける']] },
      { q: 'CI からイメージを push する認証を用意する', k: 'robot パイプライン 自動化', do: [['harbor robot create ci-push --project shop --permissions pull,push', 'push 権限の robot'], ['echo "$TOKEN" | docker login harbor.lab.local -u <robot名> --password-stdin', 'CI でログイン']] },
    ],
    cheat: [['docker login harbor.lab.local -u <user> -p <pw>', 'レジストリ認証'], ['harbor project list', 'プロジェクト一覧'], ['harbor artifact list <p>/<r>', 'タグとスキャン結果'], ['harbor artifact vulnerabilities <p>/<r>:<t>', '脆弱性一覧'], ['harbor robot create <n> --project <p>', 'robot 作成']],
  });
})(globalThis.IG = globalThis.IG || {});
