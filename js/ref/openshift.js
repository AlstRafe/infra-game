/* コマンド辞典: OpenShift（oc）。doc は Red Hat 公式の OpenShift CLI リファレンス（OCP 4.16）。 */
(function (IG) {
  'use strict';
  const OC = 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.16/html/cli_tools/openshift-cli-oc';
  const o = (n, cat, en, ja, syn, ex, rel, k, more) => Object.assign({ n, cat, doc: OC, en, ja, syn, ex, rel, k }, more || {});
  IG.registerCommands({
    topic: 'ocp',
    cats: { login: 'ログイン・プロジェクト', app: 'アプリの作成・公開', admin: '管理（oc adm）', debug: '調査' },
    cmds: [
      o('oc', 'app', 'OpenShift Client', 'OpenShift の CLI。kubectl のサブコマンド（get / describe / logs / apply …）はすべて oc でも同じように使え、プロジェクト・Route・ビルドなど OpenShift 固有の操作が加わる。', 'oc [command] [TYPE] [NAME] [flags]', [['oc get pods', 'kubectl get pods と同じ'], ['oc status', 'プロジェクトの概要']], 'kubectl, oc login, oc new-app', 'openshift ocp'),
      o('oc login', 'login', 'Log in to a server', 'クラスタにログインする。トークンでのログインも可。', 'oc login [URL] -u USER -p PASSWORD | --token=TOKEN', [['oc login https://api.ocp.lab.local:6443 -u dev -p <password>', 'ユーザーとパスワード'], ['oc login --token=sha256~xxxx --server=https://api.ocp.lab.local:6443', 'トークン（Web コンソールからコピー）']], 'oc whoami, oc logout, oc project', 'ログイン 認証 接続'),
      o('oc logout', 'login', 'End the current server session', 'ログアウトする（トークンを無効化）。', 'oc logout', [['oc logout', 'ログアウト']], 'oc login', 'ログアウト'),
      o('oc whoami', 'login', 'Return information about the current session', '今のユーザーを表示する。--show-server で接続先、-t でトークン。', 'oc whoami [--show-server] [-t]', [['oc whoami --show-server', 'ユーザーと接続先'], ['oc whoami -t', 'トークン（API 呼び出しに使う）']], 'oc login, oc project', 'ユーザー 自分 接続先'),
      o('oc project', 'login', 'Switch to another project', '作業するプロジェクト（Namespace）を切り替える・表示する。', 'oc project [NAME]', [['oc project', '今のプロジェクト'], ['oc project shop', '切り替え']], 'oc projects, oc new-project', 'プロジェクト 切り替え namespace'),
      o('oc projects', 'login', 'Display existing projects', '自分が見られるプロジェクトの一覧。', 'oc projects', [['oc projects', '一覧']], 'oc project', 'プロジェクト 一覧'),
      o('oc new-project', 'login', 'Request a new project', 'プロジェクトを作って切り替える。', 'oc new-project NAME [--display-name=...] [--description=...]', [['oc new-project shop --display-name="Shop"', '作成']], 'oc project, oc new-app', 'プロジェクト 作成'),
      o('oc new-app', 'app', 'Create a new application', 'イメージ・ソースコード・テンプレートからアプリ（Deployment と Service）を一度に作る。', 'oc new-app (IMAGE | IMAGESTREAM | TEMPLATE | PATH | URL ...) [--name=NAME]', [['oc new-app harbor.lab.local/shop/web:1.5 --name=web', 'イメージから'], ['oc new-app https://github.com/example/app.git --name=app', 'ソースから（S2I ビルド）']], 'oc expose, oc status, kubectl get', 'アプリ 作成 デプロイ'),
      o('oc expose', 'app', 'Expose a replicated application as a service or route', 'Service から Route を作り、クラスタ外へ公開する。', 'oc expose service/NAME [--hostname=HOST]', [['oc expose service/web', 'Route を作成'], ['oc get route web', '公開 URL を確認']], 'oc create route edge, kubectl get, kubectl expose', '公開 route url 外部'),
      o('oc create route edge', 'app', 'Create a route that uses edge TLS termination', 'TLS（HTTPS）付きの Route を作る。Router で TLS を終端する。', 'oc create route edge [NAME] --service=SERVICE [--hostname=HOST] [--insecure-policy=Redirect]', [['oc create route edge web --service=web --insecure-policy=Redirect', 'HTTPS で公開し http はリダイレクト']], 'oc expose', 'https tls route 公開', { nosim: true }),
      o('oc status', 'debug', 'Show a high level overview of the current project', 'プロジェクトの全体像（Service・Deployment・Route のつながりと問題点）を表示する。', 'oc status [--suggest]', [['oc status --suggest', '問題と対処の提案付き']], 'kubectl get, kubectl describe', '概要 状態 全体'),
      o('oc rsh', 'debug', 'Start a shell session in a container', 'Pod のコンテナでシェルを開く（oc exec -it … -- sh の短縮）。', 'oc rsh [POD | TYPE/NAME] [COMMAND]', [['oc rsh deploy/web', 'シェルに入る']], 'kubectl exec, oc debug', 'シェル 中に入る', { nosim: true }),
      o('oc adm policy add-scc-to-user', 'admin', 'Add a security context constraint to users or a service account', 'ServiceAccount に SCC（Pod に許すセキュリティ設定）を与える。root で動くイメージが起動しないときに（最小限に）。', 'oc adm policy add-scc-to-user SCC -z SERVICEACCOUNT [-n NS]', [['oc adm policy add-scc-to-user anyuid -z legacy-app -n shop', 'legacy-app SA に anyuid']], 'oc get scc, kubectl describe', 'scc 権限 root 起動しない permission denied'),
      o('oc get scc', 'admin', 'List security context constraints', 'SCC の一覧（restricted-v2 / anyuid / privileged …）。', 'oc get scc', [['oc get scc', '一覧'], ['oc describe pod web-xxxxx | grep scc', 'Pod に適用された SCC']], 'oc adm policy add-scc-to-user', 'scc セキュリティ', { nosim: true }),
      o('oc debug', 'debug', 'Launch a new instance of a pod for debugging', 'デバッグ用の Pod を起動する。node/NAME でノードのホストに入れる。', 'oc debug (TYPE/NAME | node/NAME)', [['oc debug node/worker-1', 'ノードを調べる（chroot /host）'], ['oc debug deploy/web', '同じ設定のデバッグ Pod']], 'oc rsh, kubectl debug', 'デバッグ ノード 調査', { nosim: true }),
      o('oc adm must-gather', 'admin', 'Launch a new instance of a pod for gathering debug information', 'サポートに渡す診断情報を一括収集する。', 'oc adm must-gather [--dest-dir=DIR]', [['oc adm must-gather --dest-dir=./mg', '収集']], 'oc adm top', '診断 サポート 収集', { nosim: true }),
      o('oc adm top', 'admin', 'Show usage statistics of resources on the server', 'ノード・Pod の使用量を表示する。', 'oc adm top node | pod', [['oc adm top node', 'ノードの使用量']], 'kubectl top', 'cpu メモリ 使用量', { nosim: true }),
      o('oc start-build', 'app', 'Start a new build', 'BuildConfig からビルドを開始する。', 'oc start-build BUILDCONFIG [--follow]', [['oc start-build app --follow', 'ビルドしてログを追う']], 'oc new-app, kubectl logs', 'ビルド s2i', { nosim: true }),
    ],
    tasks: [
      { q: 'OpenShift にログインしてプロジェクトを選ぶ', k: '接続 namespace 切り替え', do: [['oc login https://api.ocp.lab.local:6443 -u dev -p <password>', 'ログイン'], ['oc projects', '使えるプロジェクト'], ['oc project shop', '切り替え'], ['oc whoami --show-server', '誰でどこに入っているか確認']] },
      { q: 'イメージからアプリを作って外部に公開する', k: 'デプロイ route url new-app', do: [['oc new-project shop', 'プロジェクト作成'], ['oc new-app harbor.lab.local/shop/web:1.5 --name=web', 'アプリ作成'], ['oc expose service/web', 'Route で公開'], ['oc get route web', 'URL を確認']] },
      { q: 'HTTPS で公開する Route を作る', k: 'tls edge 証明書', do: [['oc create route edge web --service=web --insecure-policy=Redirect', 'Router で TLS 終端'], ['oc get route web', '確認']] },
      { q: 'root で動くイメージが起動しない（SCC）', k: 'permission denied crashloop anyuid restricted', do: [['oc describe pod <pod>', 'Events と適用された SCC'], ['oc logs <pod>', 'Permission denied などのエラー'], ['oc adm policy add-scc-to-user anyuid -z <sa> -n shop', '最終手段として SA に anyuid（本来はイメージを非 root 対応に）']], note: 'OpenShift は既定でランダムな UID で動かす。イメージ側で非 root 対応（グループ 0 に書き込み権限）するのが本筋。' },
      { q: 'プロジェクト全体の状態と問題を確認する', k: '概要 何が壊れている', do: [['oc status --suggest', '全体像と提案'], ['oc get pods', 'Pod の状態'], ['oc get events --sort-by=.lastTimestamp', '最近の出来事']] },
      { q: 'OpenShift のノードを調べる', k: 'ノード 障害 debug', do: [['oc get nodes', '状態'], ['oc debug node/worker-1', 'ノードに入る（chroot /host）'], ['oc adm top node', '使用量']] },
    ],
    cheat: [['oc login <api> -u <user> -p <pw>', 'ログイン'], ['oc new-project <name>', 'プロジェクト作成'], ['oc new-app <image> --name=<n>', 'アプリ作成'], ['oc expose service/<n>', 'Route 作成'], ['oc get route', '公開 URL']],
  });
})(globalThis.IG = globalThis.IG || {});
