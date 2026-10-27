/* Track: Kubernetes */
(function (IG) {
  'use strict';
  const HOME = '/home/operator';
  const M = HOME + '/lab/manifests';

  function training(w, B, o = {}) {
    w.features.add('k8s');
    return B.cluster(w, Object.assign({
      name: 'training-cluster', server: 'https://10.0.0.10:6443', ns: o.ns || 'core', namespaces: o.namespaces || ['core'],
      nodes: o.nodes || [{ name: 'cp-1', role: 'control-plane' }, { name: 'worker-1' }, { name: 'worker-2' }],
    }, o.cluster || {}));
  }
  function core(w, B, cl) {
    w.addImage('registry.lab.local/core/amf:1.0', { kind: 'app', app: 'amf', port: 8080, version: '1.0.4', size: '74MB' });
    w.addImage('registry.lab.local/core/smf-voice:1.0', { kind: 'app', app: 'smf-voice', port: 8080, version: '1.0.2', size: '81MB' });
    const amf = B.deploy('amf', 'core', { image: 'registry.lab.local/core/amf:1.0', port: 8080, replicas: 2 });
    const smf = B.deploy('smf-voice', 'core', { image: 'registry.lab.local/core/smf-voice:1.0', port: 8080, replicas: 1 });
    return { amf, smf };
  }
  const fromPodOk = (c, svc) => c.http(h => h.ok && h.from === 'pod' && h.host.startsWith(svc) && /health/.test(h.path));

  IG.registerMission({
    id: 'k8s-01', track: 'k8s', order: 1, difficulty: 1, par: 300, xp: 120,
    title: 'キャパシティを復旧せよ', summary: 'Deployment のレプリカ数をマニフェストで直し、Pod 間の疎通を確認する',
    story: [
      '通信コアの音声セッション管理（smf-voice）は、冗長化のため 2 台構成で動かす決まりです。',
      'しかし監視によると、現在 1 台しか動いていません。誰かがマニフェストを書き換えたようです。',
      'クラスタの状態を確認し、マニフェストを直して apply、最後に AMF から疎通確認をしてください。',
    ],
    cwd: HOME,
    setup(w, B) {
      const cl = training(w, B);
      const { amf, smf } = core(w, B, cl);
      const svc = B.svc('smf-voice', 'core', { port: 8080, targetPort: 8080 });
      B.apply(cl, amf, smf, svc);
      B.files(w, { [M + '/smf-voice-deployment.yaml']: B.yaml(smf), [M + '/amf-deployment.yaml']: B.yaml(amf), [M + '/smf-voice-service.yaml']: B.yaml(svc), [HOME + '/lab/README.md']: IG.t('# lab\n\nクラスタ: training-cluster（kubectl の既定 namespace は core）\nマニフェストは manifests/ 配下。変更は必ずファイルを直してから kubectl apply -f で反映すること（GitOps 準拠）。\n') });
    },
    objectives: [
      { title: 'クラスタの状態を確認する', detail: 'ノードと Pod の一覧を見る',
        hints: ['kubectl get <種類> で一覧を表示します。種類は nodes, pods など。', '`kubectl get nodes` と `kubectl get pods`（既定 namespace は core）'],
        check: (w, c) => c.ran(/\bget\s+(no|nodes?)\b/) && c.ran(/\bget\s+(po|pods?|all)\b/) },
      { title: 'マニフェストを 2 レプリカにして apply', detail: 'lab/manifests/smf-voice-deployment.yaml の replicas を 2 にして適用',
        hints: ['`vi lab/manifests/smf-voice-deployment.yaml` で replicas を 2 に（または `sed -i \'s/replicas: 1/replicas: 2/\' …`）。', '`kubectl apply -f lab/manifests/smf-voice-deployment.yaml` → `kubectl get deploy` で 2/2 を確認。'],
        check: (w, c) => { let f; try { f = IG.yaml.parse(c.file(M + '/smf-voice-deployment.yaml')); } catch (e) { return false; } const cl = c.cluster(); return f && f.spec && f.spec.replicas === 2 && cl.get('Deployment', 'core', 'smf-voice').spec.replicas === 2 && cl.healthy('core', 'smf-voice', 2); } },
      { title: 'AMF から疎通確認する', detail: 'AMF の Pod の中から smf-voice の /health に curl する',
        hints: ['クラスタ内の Service 名はクラスタの外（この踏み台）からは名前解決できません。Pod の中から実行します。', '`kubectl exec deploy/amf -- curl -s http://smf-voice:8080/health`'],
        check: (w, c) => fromPodOk(c, 'smf-voice') },
    ],
    solution: ['kubectl get nodes', 'kubectl get pods', "sed -i 's/replicas: 1/replicas: 2/' ~/lab/manifests/smf-voice-deployment.yaml", 'kubectl apply -f ~/lab/manifests/smf-voice-deployment.yaml', 'kubectl exec deploy/amf -- curl -s http://smf-voice:8080/health'],
    debrief: {
      points: [
        'Deployment は「あるべき Pod 数（replicas）」を宣言し、コントローラが実際の数を合わせ続ける。',
        'kubectl scale でも直せるが、マニフェストを直さないと次の apply で元に戻る。ファイルを正とする運用（GitOps）が基本。',
        'Service 名（smf-voice）の DNS はクラスタ内でだけ引ける。疎通確認は Pod の中から行う。',
      ],
      commands: [['kubectl get nodes / pods', '一覧'], ['kubectl apply -f file.yaml', '宣言を反映'], ['kubectl get deploy', 'READY 数を確認'], ['kubectl exec deploy/x -- curl …', 'Pod 内からコマンド実行']],
    },
  });

  IG.registerMission({
    id: 'k8s-02', track: 'k8s', order: 2, difficulty: 2, par: 420, xp: 160,
    title: 'Service に繋がらない', summary: 'Endpoints が空・ポート違いの Service を調べて直す',
    story: [
      'smf-voice の Pod は 2 台とも Running なのに、AMF からの通信がすべて失敗しています。',
      '昨日 Service のマニフェストを「整理した」という変更が入ったようです。',
      'Service と Endpoints を調べ、どこが壊れているのかを見つけて直してください。',
    ],
    cwd: HOME,
    setup(w, B) {
      const cl = training(w, B);
      const { amf, smf } = core(w, B, cl);
      smf.spec.replicas = 2;
      const svc = B.svc('smf-voice', 'core', { port: 8080, targetPort: 9090, selector: { app: 'smf-voce' } });
      B.apply(cl, amf, smf, svc);
      B.files(w, { [M + '/smf-voice-deployment.yaml']: B.yaml(smf), [M + '/amf-deployment.yaml']: B.yaml(amf), [M + '/smf-voice-service.yaml']: B.yaml(svc) });
    },
    objectives: [
      { title: 'Service と Endpoints を調べる', detail: 'Service がどの Pod に転送しているかを確認する',
        hints: ['Service が転送先として認識している Pod の IP は Endpoints に出ます。', '`kubectl get svc,ep` や `kubectl describe svc smf-voice`。Pod のラベルは `kubectl get pods --show-labels`。'],
        check: (w, c) => c.ran(/get\s+\S*\b(ep|endpoints)\b|describe\s+(svc|services?)\b/) },
      { title: 'Service のマニフェストを直して apply', detail: 'selector と targetPort を正しい値にする',
        hints: ['selector は Pod のラベル（app=smf-voice）と完全一致が必要です。綴りをよく見て。', 'アプリは 8080 番で待ち受けています。targetPort も 8080 に直し、`kubectl apply -f lab/manifests/smf-voice-service.yaml`。'],
        check: (w, c) => { const cl = c.cluster(); const s = cl.get('Service', 'core', 'smf-voice'); return s && s.spec.selector.app === 'smf-voice' && cl.endpoints(s).length >= 2 && cl.targetFor(cl.endpoints(s)[0].pod, s.spec.ports[0].targetPort) === 8080; } },
      { title: 'AMF から疎通確認する', detail: 'AMF の Pod から smf-voice の /health が 200 になることを確認',
        hints: ['K8s-01 と同じ確認方法です。', '`kubectl exec deploy/amf -- curl -s http://smf-voice:8080/health`'],
        check: (w, c) => fromPodOk(c, 'smf-voice') },
    ],
    solution: ['kubectl get svc,ep', 'kubectl get pods --show-labels', "sed -i 's/smf-voce/smf-voice/' ~/lab/manifests/smf-voice-service.yaml", "sed -i 's/targetPort: 9090/targetPort: 8080/' ~/lab/manifests/smf-voice-service.yaml", 'kubectl apply -f ~/lab/manifests/smf-voice-service.yaml', 'kubectl get ep', 'kubectl exec deploy/amf -- curl -s http://smf-voice:8080/health'],
    debrief: {
      points: [
        'Service → Pod の対応はラベルセレクタで決まる。1 文字違うだけで Endpoints は <none> になる。',
        'port は Service が受けるポート、targetPort は Pod（コンテナ）側のポート。アプリの待ち受けと一致させる。',
        '「Pod は Running なのに繋がらない」ときは get ep → describe svc の順に見るのが早い。',
      ],
      commands: [['kubectl get svc,ep', 'Service と転送先'], ['kubectl describe svc x', 'selector / targetPort'], ['kubectl get pods --show-labels', 'Pod のラベル']],
    },
  });

  IG.registerMission({
    id: 'k8s-03', track: 'k8s', order: 3, difficulty: 2, par: 360, xp: 160,
    title: '悪いリリースを戻せ', summary: '存在しないタグで止まったロールアウトを rollout undo で戻す',
    story: [
      '15 分前、checkout サービスの 2.4.0 がリリースされました。ところが新しい Pod が起動せず、ロールアウトが途中で止まっています。',
      '古い Pod が残っているのでサービスはかろうじて動いていますが、時間の問題です。',
      'まずは前のバージョンに戻してサービスを安定させてください（原因究明はその後で）。',
    ],
    cwd: HOME,
    setup(w, B) {
      const cl = training(w, B, { ns: 'shop', namespaces: ['shop'] });
      w.addImage('registry.lab.local/shop/checkout:2.3.0', { kind: 'app', app: 'checkout', port: 8080, version: '2.3.0' });
      const v1 = B.deploy('checkout', 'shop', { image: 'registry.lab.local/shop/checkout:2.3.0', port: 8080, replicas: 3, annotations: { 'kubernetes.io/change-cause': 'release 2.3.0' } });
      B.apply(cl, v1, B.svc('checkout', 'shop', { port: 80, targetPort: 8080 }));
      const v2 = IG.util.clone(v1);
      v2.spec.template.spec.containers[0].image = 'registry.lab.local/shop/checkout:2.4.0';
      v2.metadata.annotations['kubernetes.io/change-cause'] = 'release 2.4.0';
      B.apply(cl, v2);
    },
    objectives: [
      { title: '異常を確認する', detail: 'Pod の状態とロールアウト履歴を確認する',
        hints: ['`kubectl get pods` で STATUS が ImagePullBackOff の Pod がいます。', '`kubectl rollout history deploy/checkout` で過去のリビジョンが見られます。'],
        check: (w, c) => c.ran(/\bget\s+(po|pods?|all)\b|describe\s+(po|pods?)/) && c.ran(/rollout\s+(history|status)/) },
      { title: '前のリビジョンに戻す', detail: 'checkout を 2.3.0 に戻し、3/3 Ready にする',
        hints: ['ロールバックは 1 コマンドです。', '`kubectl rollout undo deploy/checkout`'],
        check: (w, c) => { const cl = c.cluster(); const d = cl.get('Deployment', 'shop', 'checkout'); return /:2\.3\.0$/.test(d.spec.template.spec.containers[0].image) && cl.healthy('shop', 'checkout', 3); } },
      { title: 'ロールアウト完了を確認する', detail: '戻した後に rollout status で完了を確認する',
        hints: ['`kubectl rollout status deploy/checkout`'],
        check: (w, c) => c.ranSince(1, /rollout\s+status/) },
    ],
    solution: ['kubectl get pods', 'kubectl rollout history deploy/checkout', 'kubectl rollout undo deploy/checkout', 'kubectl rollout status deploy/checkout'],
    debrief: {
      points: [
        'RollingUpdate は新しい Pod が Ready にならない限り古い Pod を全部は消さない（maxUnavailable / maxSurge）。だからサービスが即死しなかった。',
        'rollout undo は直前のリビジョンのテンプレートを新しいリビジョンとして適用する。history で番号を確認でき、--to-revision で指定も可能。',
        '障害対応は「まず戻す（復旧）→ 落ち着いて原因究明」の順。今回の原因は存在しないタグ（2.4.0）の指定。',
      ],
      commands: [['kubectl rollout history deploy/x', 'リビジョン一覧'], ['kubectl rollout undo deploy/x', 'ロールバック'], ['kubectl rollout status deploy/x', '完了確認']],
    },
  });

  IG.registerMission({
    id: 'k8s-04', track: 'k8s', order: 4, difficulty: 2, par: 420, xp: 180,
    title: '設定が足りない Pod', summary: 'CreateContainerConfigError の原因となる ConfigMap と Secret を作る',
    story: [
      '新しい通知サービス notify をデプロイしましたが、Pod が CreateContainerConfigError のまま動きません。',
      'アプリの設定値は ConfigMap、パスワードは Secret から読む設計です。手順書 ~/runbook/notify.md に値が書いてあります。',
      '足りない設定を作成して notify を起動してください。',
    ],
    cwd: HOME,
    setup(w, B) {
      const cl = training(w, B, { ns: 'ops', namespaces: ['ops'] });
      w.addImage('registry.lab.local/ops/notify:3.0', { kind: 'app', app: 'notify', port: 8080, version: '3.0.1', requiresEnv: ['SMTP_HOST', 'SMTP_PASSWORD'] });
      const d = B.deploy('notify', 'ops', { image: 'registry.lab.local/ops/notify:3.0', port: 8080, replicas: 2, envFrom: [{ configMapRef: { name: 'notify-config' } }], env: { SMTP_PASSWORD: { valueFrom: { secretKeyRef: { name: 'notify-secret', key: 'smtp-password' } } } } });
      B.apply(cl, d);
      B.files(w, { [HOME + '/runbook/notify.md']: IG.t('# notify 設定値\n\n## ConfigMap: notify-config\n- SMTP_HOST = mail.lab.local\n- SMTP_PORT = 587\n\n## Secret: notify-secret\n- smtp-password = not-a-real-password   ※訓練用の架空の値\n\n作成例:\n  kubectl create configmap <名前> --from-literal=KEY=VALUE ...\n  kubectl create secret generic <名前> --from-literal=key=value\n'), [HOME + '/manifests/notify.yaml']: B.yaml(d) });
    },
    objectives: [
      { title: '起動できない理由を確認する', detail: 'Pod の Events から足りないリソースを特定する',
        hints: ['`kubectl get pods` → `kubectl describe pod <pod名>`', 'Events に「configmap "notify-config" not found」のようなメッセージが出ます。'],
        check: (w, c) => c.ran(/describe\s+(po|pods?)\b|get\s+(ev|events)\b/) },
      { title: 'ConfigMap と Secret を作る', detail: '手順書どおりに notify-config と notify-secret を作成する',
        hints: ['`cat ~/runbook/notify.md`', '`kubectl create configmap notify-config --from-literal=SMTP_HOST=mail.lab.local --from-literal=SMTP_PORT=587` と `kubectl create secret generic notify-secret --from-literal=smtp-password=not-a-real-password`'],
        check: (w, c) => { const cl = c.cluster(); const cm = cl.get('ConfigMap', 'ops', 'notify-config'); const s = cl.get('Secret', 'ops', 'notify-secret'); return !!(cm && cm.data && cm.data.SMTP_HOST && s && s.data && s.data['smtp-password']); } },
      { title: 'notify を起動する', detail: 'notify が 2/2 Ready になることを確認',
        hints: ['ConfigMap / Secret ができれば kubelet が自動で再試行します。', '`kubectl get pods` で Running を確認（すぐなら数秒待ってもう一度）。'],
        check: (w, c) => c.cluster().healthy('ops', 'notify', 2) },
    ],
    solution: ['kubectl get pods', 'kubectl get events', 'cat ~/runbook/notify.md', 'kubectl create configmap notify-config --from-literal=SMTP_HOST=mail.lab.local --from-literal=SMTP_PORT=587', 'kubectl create secret generic notify-secret --from-literal=smtp-password=not-a-real-password', 'kubectl get pods'],
    debrief: {
      points: [
        '設定値は ConfigMap、秘密情報は Secret に分けてイメージから切り離す（同じイメージを環境ごとに使い回せる）。',
        '参照先が無いと Pod は CreateContainerConfigError で止まる。作れば自動で再試行される。',
        'Secret の値は base64 で「符号化」されているだけで暗号化ではない。RBAC と保存時暗号化で守る。',
      ],
      commands: [['kubectl create configmap n --from-literal=K=V', 'ConfigMap 作成'], ['kubectl create secret generic n --from-literal=k=v', 'Secret 作成'], ['kubectl get secret n -o yaml', '中身（base64）を確認']],
    },
  });

  IG.registerMission({
    id: 'k8s-05', track: 'k8s', order: 5, difficulty: 2, par: 420, xp: 180,
    title: 'Pending から抜け出せ', summary: '大きすぎるリソース要求でスケジュールされない Pod を直す',
    story: [
      '分析チームのレポート生成ジョブ（report）が、何時間も Pending のままです。',
      'ノードには十分な空きがあるはずなのに、なぜ配置されないのでしょうか。',
      '理由を調べ、マニフェスト ~/manifests/report.yaml を直して起動させてください。',
    ],
    cwd: HOME,
    setup(w, B) {
      const cl = training(w, B, { ns: 'analytics', namespaces: ['analytics'] });
      w.addImage('registry.lab.local/analytics/report:1.4', { kind: 'app', app: 'report', port: 8080, version: '1.4.0' });
      const d = B.deploy('report', 'analytics', { image: 'registry.lab.local/analytics/report:1.4', port: 8080, replicas: 1, resources: { requests: { cpu: '500m', memory: '16Gi' }, limits: { memory: '16Gi' } } });
      B.apply(cl, d);
      B.files(w, { [HOME + '/manifests/report.yaml']: B.yaml(d), [HOME + '/manifests/NOTE.txt']: IG.t('report の実測メモリ使用量: ピーク 380Mi 前後（2026-10 計測）\n') });
    },
    objectives: [
      { title: 'Pending の理由を確認する', detail: 'スケジューラが Pod を配置できない理由を読む',
        hints: ['`kubectl describe pod <pod名>` の Events に FailedScheduling が出ます。', 'ノードの割り当て可能量は `kubectl describe node worker-1` の Allocatable で分かります。'],
        check: (w, c) => c.ran(/describe\s+(po|pods?)\b|get\s+(ev|events)\b/) },
      { title: 'リソース要求を現実的な値にする', detail: 'memory の requests/limits を 1Gi 以下にして apply',
        hints: ['NOTE.txt によると実際の使用量は 380Mi 程度。16Gi はノード（8Gi）より大きいので絶対に入りません。', '`sed -i \'s/16Gi/512Mi/g\' ~/manifests/report.yaml` → `kubectl apply -f ~/manifests/report.yaml`'],
        check: (w, c) => { const d = c.cluster().get('Deployment', 'analytics', 'report'); const r = d.spec.template.spec.containers[0].resources || {}; return IG.util.mem((r.requests || {}).memory) <= 1024 && IG.util.mem((r.limits || {}).memory || '0') <= 1024; } },
      { title: 'report を起動する', detail: 'report が 1/1 Ready になる',
        hints: ['apply 後に `kubectl get pods` で確認しましょう。'],
        check: (w, c) => c.cluster().healthy('analytics', 'report', 1) },
    ],
    solution: ['kubectl get pods', 'kubectl describe pods', "sed -i 's/16Gi/512Mi/g' ~/manifests/report.yaml", 'kubectl apply -f ~/manifests/report.yaml', 'kubectl get pods'],
    debrief: {
      points: [
        'スケジューラは「requests の合計」がノードの Allocatable に収まるかで配置先を決める。実使用量ではない。',
        'requests が大きすぎると Pending、小さすぎるとノードが過密になり OOMKill の原因に。実測に基づいて設定する。',
        'FailedScheduling のメッセージ（Insufficient memory など）が最重要の手がかり。',
      ],
      commands: [['kubectl describe pod x', 'FailedScheduling を確認'], ['kubectl describe node n', 'Allocatable / Allocated'], ['kubectl top pods', '実使用量']],
    },
  });

  IG.registerMission({
    id: 'k8s-06', track: 'k8s', order: 6, difficulty: 3, par: 600, xp: 260,
    title: 'ノードのディスクが満杯', summary: 'DiskPressure のノードに SSH して原因ファイルを片付け、Pod を配置させる',
    story: [
      '決済バッチ（billing）の Pod が配置されず、夜間処理に間に合わない恐れがあります。',
      'worker-1 は他のサービスで CPU が埋まっており、worker-2 に置くしかありません。',
      'しかし worker-2 は何かがおかしいようです。ノードに入って調べ、安全に復旧してください。',
    ],
    cwd: HOME,
    setup(w, B) {
      const journal = { kubelet: ['Oct 23 18:02:11 worker-2 kubelet[1290]: I1023 18:02:11.104 kubelet.go:2412] "Starting kubelet"', 'Oct 23 23:40:55 worker-2 kubelet[1290]: W1023 23:40:55.871 eviction_manager.go:300] "Eviction manager: threshold met" signal="nodefs.available" observed="3.9Gi" threshold="15%"'] };
      w.addHost('worker-1', { user: 'ubuntu', ip: '10.0.1.12', services: { kubelet: 'active', containerd: 'active' }, baseUsedGiB: 14, motd: 'worker-1 (training-cluster)' });
      w.addHost('worker-2', {
        user: 'ubuntu', ip: '10.0.1.13', services: { kubelet: 'active', containerd: 'active' }, baseUsedGiB: 8, journal, motd: 'worker-2 (training-cluster)\n\n  Usage of /:   92.3% of 50GB   ⚠',
        files: {
          '/var/log/app/debug.log': { content: IG.t('2026-10-23T23:59:59Z DEBUG dump request payload size=1048576 (repeated)\n…（中略）…\n'), size: 38 * 1024 ** 3 },
          '/var/log/app/app.log': { content: '2026-10-23T23:59:59Z INFO billing-agent heartbeat\n', size: 12 * 1024 ** 2 },
          '/var/log/syslog': { content: 'Oct 24 00:00:01 worker-2 CRON[4412]: (root) CMD (logrotate /etc/logrotate.conf)\n', size: 84 * 1024 ** 2 },
          '/etc/logrotate.d/app': IG.t('# TODO: debug.log もローテーション対象に入れる\n/var/log/app/app.log {\n    daily\n    rotate 7\n    compress\n}\n'),
          '/home/ubuntu/NOTE.txt': IG.t('先週 debug ログを一時的に有効化した（戻し忘れ注意）— 佐藤\n'),
        },
      });
      const cl = training(w, B, {
        ns: 'finance', namespaces: ['finance'],
        nodes: [{ name: 'cp-1', role: 'control-plane' }, { name: 'worker-1', cpu: 2000, host: 'worker-1' }, { name: 'worker-2', cpu: 2000, host: 'worker-2' }],
      });
      w.addImage('registry.lab.local/finance/ledger:5.2', { kind: 'app', app: 'ledger', port: 8080 });
      w.addImage('registry.lab.local/finance/billing:7.0', { kind: 'app', app: 'billing', port: 8080 });
      B.apply(cl, B.deploy('ledger', 'finance', { image: 'registry.lab.local/finance/ledger:5.2', port: 8080, replicas: 3, resources: { requests: { cpu: '600m', memory: '512Mi' } } }));
      B.apply(cl, B.deploy('billing', 'finance', { image: 'registry.lab.local/finance/billing:7.0', port: 8080, replicas: 2, resources: { requests: { cpu: '500m', memory: '256Mi' } } }));
    },
    objectives: [
      { title: '問題のノードを特定する', detail: 'Pending の理由とノードの状態（Conditions / Taints）を確認する',
        hints: ['`kubectl get pods -o wide` と `kubectl describe pod <billing の Pod>` で FailedScheduling の理由を読みます。', '`kubectl describe node worker-2` の Conditions と Taints を見ましょう。'],
        check: (w, c) => c.ran(/describe\s+(no|nodes?)\b/) },
      { title: 'worker-2 のディスクを空ける', detail: 'SSH して容量を食っているファイルを特定し、安全に片付ける（使用率 85% 未満へ）',
        hints: ['`ssh worker-2` → `df -h` で使用率、`sudo du -sh /var/log/*` で大きいディレクトリを探します。', '巨大な debug.log は書き込み中の可能性があるので、削除より `sudo truncate -s 0 /var/log/app/debug.log` が安全です。'],
        check: w => w.hosts['worker-2'].diskPct() < 85 },
      { title: 'billing を起動させる', detail: 'billing が 2/2 Ready になる',
        hints: ['ディスクが空くと DiskPressure が解除され、スケジューラが Pod を配置します。', '踏み台に戻って（exit）`kubectl get pods -o wide` で確認。'],
        check: (w, c) => c.cluster().healthy('finance', 'billing', 2) },
    ],
    solution: ['kubectl get pods -o wide', 'kubectl describe node worker-2', 'ssh worker-2', 'df -h', 'sudo du -sh /var/log/*', 'sudo du -sh /var/log/app/*', 'sudo truncate -s 0 /var/log/app/debug.log', 'df -h', 'exit', 'kubectl get pods -o wide'],
    debrief: {
      points: [
        'kubelet はディスク使用率がしきい値を超えると DiskPressure を立て、ノードに taint を付けて新しい Pod を受け付けなくする。',
        '書き込み中のログを rm してもプロセスが掴んでいる限り容量は戻らないことがある。truncate や logrotate（copytruncate）を使う。',
        '再発防止: デバッグログを戻す、logrotate の対象に入れる、ディスク使用率を監視する。',
      ],
      commands: [['kubectl describe node n', 'Conditions / Taints'], ['df -h', 'ファイルシステム使用率'], ['du -sh /path/*', 'どこが大きいか'], ['truncate -s 0 file', '中身だけ空にする']],
    },
  });
})(globalThis.IG = globalThis.IG || {});
