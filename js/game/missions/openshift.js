/* Track: OpenShift */
(function (IG) {
  'use strict';
  const HOME = '/home/operator';
  const API = 'https://api.ocp.lab.local:6443';
  const APPS = 'apps.ocp.lab.local';

  function ocp(w, B, o = {}) {
    w.features.add('ocp');
    const cl = B.cluster(w, {
      name: 'ocp', server: API, openshift: true, appsDomain: APPS, context: false, namespaces: o.namespaces || [],
      users: { developer: { password: 'developer' }, kubeadmin: { password: 'not-for-training', admin: true } },
      nodes: [{ name: 'worker-0.ocp.lab.local' }, { name: 'worker-1.ocp.lab.local' }, { name: 'worker-2.ocp.lab.local' }], subnet: 3,
    });
    B.files(w, { [HOME + '/runbook/openshift.md']: IG.t(`# OpenShift 訓練クラスタ\n\n- API     : {0}\n- ユーザー: developer / developer   ※訓練用\n- アプリの公開 URL: http://<route名>-<project名>.{1}\n\n## 基本\n- oc login {2} -u developer -p developer\n- oc new-project <name>       # namespace に相当\n- oc new-app <image> --name=<name>\n- oc expose service/<name>    # Route を作って外部公開\n`, { 0: API, 1: APPS, 2: API }) });
    return cl;
  }

  IG.registerMission({
    id: 'ocp-01', track: 'ocp', order: 1, difficulty: 1, par: 360, xp: 140,
    title: 'はじめての OpenShift', summary: 'ログイン → プロジェクト作成 → new-app → Route で公開',
    story: [
      'CoreLab のアプリ基盤は Red Hat OpenShift です。開発者向けのセルフサービス機能がそろっています。',
      'まずは練習として、hello アプリ（registry.lab.local/demo/hello:1.0）を自分のプロジェクト hello-dev にデプロイし、Route で外部に公開してみましょう。',
      '接続情報は ~/runbook/openshift.md にあります。',
    ],
    cwd: HOME,
    setup(w, B) {
      ocp(w, B);
      w.addImage('registry.lab.local/demo/hello:1.0', { kind: 'app', app: 'hello', port: 8080, root: false, version: '1.0.0', message: 'Hello OpenShift!' });
    },
    objectives: [
      { title: 'ログインしてプロジェクトを作る', detail: 'developer でログインし、プロジェクト hello-dev を作成する',
        hints: ['`cat ~/runbook/openshift.md` → `oc login https://api.ocp.lab.local:6443 -u developer -p developer`', '`oc new-project hello-dev`'],
        check: w => { const c = w.clusters.ocp; return !!(c.get('Namespace', null, 'hello-dev') && c.projectsOf.developer && c.projectsOf.developer.has('hello-dev')); } },
      { title: 'アプリをデプロイする', detail: 'hello イメージから Deployment と Service を作る',
        hints: ['oc new-app はイメージから Deployment と Service をまとめて作ってくれます。', '`oc new-app registry.lab.local/demo/hello:1.0 --name=hello` → `oc get pods`'],
        check: w => { const c = w.clusters.ocp; return c.list('Deployment', 'hello-dev').some(d => /demo\/hello/.test(d.spec.template.spec.containers[0].image) && c.healthy('hello-dev', d.metadata.name)); } },
      { title: 'Route で公開して確認する', detail: 'Route を作り、その URL に curl して 200 を得る',
        hints: ['`oc expose service/hello` で Route ができます。`oc get route` で HOST を確認。', '`curl -s http://hello-hello-dev.apps.ocp.lab.local/`'],
        check: (w, c) => c.http(h => h.ok && h.host.endsWith('.' + APPS) && h.target && h.target.ns === 'hello-dev') },
    ],
    solution: ['cat ~/runbook/openshift.md', `oc login ${API} -u developer -p developer`, 'oc new-project hello-dev', 'oc new-app registry.lab.local/demo/hello:1.0 --name=hello', 'oc get pods', 'oc expose service/hello', 'oc get route', 'curl -s http://hello-hello-dev.apps.ocp.lab.local/'],
    debrief: {
      points: [
        'OpenShift の「プロジェクト」は namespace に権限設定などを加えたもの。開発者は自分のプロジェクトを作れる。',
        'oc は kubectl の上位互換。kubectl の操作（get / describe / logs / apply）はそのまま使える。',
        'Route は OpenShift 独自の外部公開の仕組み（Ingress 相当）。ホスト名が自動で払い出される。',
      ],
      commands: [['oc login <api> -u <user>', 'ログイン'], ['oc new-project <name>', 'プロジェクト作成'], ['oc new-app <image>', 'Deployment + Service 作成'], ['oc expose service/<name>', 'Route 作成'], ['oc status', '全体像を表示']],
    },
  });

  IG.registerMission({
    id: 'ocp-02', track: 'ocp', order: 2, difficulty: 3, par: 540, xp: 240,
    title: 'root で動かないコンテナ', summary: 'SCC で CrashLoopBackOff になる nginx を非 root イメージに置き換える',
    story: [
      'Kubernetes で動いていた社内 Wiki のフロントエンド（公式 nginx イメージ）を OpenShift に移したところ、CrashLoopBackOff になりました。',
      '同僚は「anyuid を付ければ動くよ」と言いますが、あなたの権限（developer）ではできませんし、セキュリティ的にも推奨されません。',
      'ログで原因を確かめ、OpenShift の流儀で動くように直してください。マニフェストは ~/manifests/frontend.yaml です。',
    ],
    cwd: HOME,
    setup(w, B) {
      const cl = ocp(w, B, { namespaces: ['web'] });
      cl.projectsOf.developer = new Set(['web']);
      const d = B.deploy('frontend', 'web', { image: 'nginx:1.27', port: 80, replicas: 2 });
      const s = B.svc('frontend', 'web', { port: 80, targetPort: 80 });
      const r = B.route('frontend', 'web', {});
      B.apply(cl, d, s, r);
      w.addContext(`web/api-ocp-lab-local:6443/developer`, 'ocp', 'web', 'developer');
      B.files(w, { [HOME + '/manifests/frontend.yaml']: [d, s, r].map(B.yaml).join('---\n') });
    },
    objectives: [
      { title: 'ログで原因を確かめる', detail: 'CrashLoopBackOff の Pod のログを読む',
        hints: ['`oc get pods` → `oc logs <pod名>`（`oc logs deploy/frontend` でも可）。', 'Permission denied は「root 前提のイメージをランダム UID で動かした」ときの典型的なエラーです。'],
        check: (w, c) => c.ran(/\b(oc|kubectl|k)\s+logs\b/) },
      { title: '非 root イメージで起動する', detail: 'nginxinc/nginx-unprivileged:1.27（8080 番で待ち受け）に置き換える',
        hints: ['~/manifests/frontend.yaml の image を `nginxinc/nginx-unprivileged:1.27`、containerPort を 8080 に変更します（`vi ~/manifests/frontend.yaml`）。', '`oc apply -f ~/manifests/frontend.yaml` → `oc get pods` で 2/2 Running を確認。'],
        check: w => { const c = w.clusters.ocp; const d = c.get('Deployment', 'web', 'frontend'); return /nginx-unprivileged/.test(d.spec.template.spec.containers[0].image) && c.healthy('web', 'frontend', 2) && !c.anyuid.size; } },
      { title: 'Route 経由で表示を確認する', detail: 'http://frontend-web.apps.ocp.lab.local/ が 200 を返す',
        hints: ['Pod が動いても 503 が返るなら、Service の targetPort（80 のまま？）を疑いましょう。', 'Service の targetPort も 8080 にして apply → `curl -s http://frontend-web.apps.ocp.lab.local/`'],
        check: (w, c) => c.http(h => h.ok && h.host === 'frontend-web.' + APPS) },
    ],
    solution: ['oc get pods', 'oc logs deploy/frontend', 'oc adm policy add-scc-to-user anyuid -z default', "sed -i 's#image: nginx:1.27#image: nginxinc/nginx-unprivileged:1.27#' ~/manifests/frontend.yaml", "sed -i 's/containerPort: 80$/containerPort: 8080/' ~/manifests/frontend.yaml", "sed -i 's/targetPort: 80$/targetPort: 8080/' ~/manifests/frontend.yaml", 'oc apply -f ~/manifests/frontend.yaml', 'oc get pods', 'curl -s http://frontend-web.apps.ocp.lab.local/'],
    debrief: {
      points: [
        'OpenShift は既定の SCC（restricted-v2）で、コンテナを「ランダムな UID・root 権限なし」で動かす。root 前提のイメージは書き込み権限で失敗する。',
        'anyuid の付与は最後の手段。まず非 root 対応イメージ（nginx-unprivileged、UBI ベースなど）を選ぶ。',
        '非 root は 1024 未満のポートを使えないので 8080 などで待ち受ける。Service の targetPort も合わせる。',
      ],
      commands: [['oc logs <pod>', 'ログ確認'], ['oc get pod <pod> -o yaml', 'securityContext / SCC 注釈'], ['oc apply -f file', '反映'], ['oc get route', '公開 URL']],
    },
  });
})(globalThis.IG = globalThis.IG || {});
