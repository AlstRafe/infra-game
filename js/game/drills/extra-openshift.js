/* Exam-oriented extra packs for OpenShift (EX180 / EX280 / EX288 / EX380 / EX316 / EX430 / EX432 を補う).
 * Sources: docs.redhat.com (OCP 4.x), Red Hat product documentation. */
(function () {
  const base = "https://docs.redhat.com/en/documentation/openshift_container_platform/4.16/html/";
  IG.addExtras({
    topic: "ocp",
    refs: {
      storage: ["OCP 4.16 Storage（PV / StorageClass / ODF）", base + "storage"],
      logging: ["OCP 4.16 Logging", base + "logging"],
      gitops: [
        "Red Hat OpenShift GitOps documentation",
        "https://docs.redhat.com/en/documentation/red_hat_openshift_gitops/",
      ],
      pipelines: [
        "Red Hat OpenShift Pipelines documentation",
        "https://docs.redhat.com/en/documentation/red_hat_openshift_pipelines/",
      ],
      backupdoc: ["OCP 4.16 Backup and restore（OADP）", base + "backup_and_restore"],
      virt: ["OCP 4.16 Virtualization", base + "virtualization"],
      acs: [
        "Red Hat Advanced Cluster Security for Kubernetes",
        "https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/",
      ],
      acm: [
        "Red Hat Advanced Cluster Management for Kubernetes",
        "https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/",
      ],
      scaling: ["OCP 4.16 Scalability and performance", base + "scalability_and_performance"],
      postinstall: ["OCP 4.16 Postinstallation configuration", base + "postinstallation_configuration"],
    },
    extras: [
      {
        id: "declarative",
        title: "宣言的な管理と自己サービス（EX280）",
        goal: "マニフェスト・クォータ・テンプレートでプロジェクトを管理できる",
        refs: ["cli", "apps", "auth", "postinstall"],
        points: [
          "`oc create -f` / `oc apply -f` / `oc get -o yaml` / `oc patch` / `oc set` を使い、手作業を再現可能にする",
          "`oc new-project` を一般ユーザーに許可するのは self-provisioner ロール（外すと管理者のみが作成）",
          "Namespace ごとの上限は ResourceQuota と LimitRange。新規 Project の既定は Project テンプレートで設定",
          "アプリの雛形は Template（`oc process -f tpl.yaml -p NAME=app | oc apply -f -`）",
          "Operator は Subscription で導入（1 つの Namespace か全クラスタ）。`oc get csv` で導入済みを確認",
        ],
        qs: [
          {
            q: "一般ユーザーが自分でプロジェクトを作れないようにするには？",
            c: [
              "self-provisioner クラスタロールの割り当てを外す",
              "すべてのユーザーを削除する",
              "ResourceQuota を 0 にする",
              "oc new-project コマンドを無効化する",
            ],
            x: "`oc adm policy remove-cluster-role-from-group self-provisioner system:authenticated:oauth` のように外します。",
            r: "auth",
          },
          {
            q: "プロジェクト内で使えるメモリ・CPU・Pod 数の合計を制限するリソースは？",
            c: ["ResourceQuota", "LimitRange", "SCC", "Route"],
            x: "コンテナ単位の既定値・上下限は LimitRange。両方を組み合わせるのが定番です。",
            r: "postinstall",
          },
          {
            q: "稼働中の Deployment のイメージを宣言的に差し替えるコマンドは？",
            c: [
              "oc set image deployment/web web=registry/app:1.2",
              "oc edit pod web",
              "oc delete pod -l app=web",
              "oc rsh deployment/web",
            ],
            x: "`oc set env` `oc set resources` も同様に、マニフェストを部分的に更新します。",
            r: "cli",
          },
          {
            q: "Operator が導入されているかを確認するコマンドは？",
            c: ["oc get csv（ClusterServiceVersion）", "oc get templates", "oc get builds", "oc get scc"],
            x: "OLM は Subscription → InstallPlan → CSV の流れで導入します。",
            r: "operators",
          },
        ],
      },
      {
        id: "storage",
        title: "ストレージとバックアップ（EX280 / EX370）",
        goal: "永続ボリュームを与え、アプリをバックアップ・復元できる",
        refs: ["storage", "backupdoc", "cli"],
        points: [
          "Kubernetes と同じ PVC / StorageClass。ODF（OpenShift Data Foundation）は内部モードで Ceph ベースのストレージを提供",
          "ODF が提供するのは RBD（ブロック・RWO）・CephFS（共有・RWX）・オブジェクト（RGW / NooBaa）",
          "`oc set volume deployment/app --add --claim-name=data --mount-path=/var/lib/data` でボリュームを追加",
          "バックアップは OADP（Velero ベース）: 対象 Namespace・保存先（S3 互換）・スケジュールを宣言する",
          "復元前に Namespace の状態と PV の回収ポリシーを確認する",
        ],
        qs: [
          {
            q: "複数の Pod（異なるノード）から同じボリュームに書き込みたい。ODF で選ぶのは？",
            c: [
              "CephFS ベースの共有ファイルストレージ（RWX）",
              "RBD ベースのブロックストレージ（RWO）",
              "オブジェクトストレージのみ",
              "emptyDir",
            ],
            x: "アクセスモード RWX に対応しているのは共有ファイルシステムです。",
            r: "storage",
          },
          {
            q: "Deployment `app` に PVC `data` を /var/lib/data としてマウントするコマンドは？",
            c: [
              "oc set volume deployment/app --add --claim-name=data --mount-path=/var/lib/data",
              "oc create pvc data --mount=/var/lib/data",
              "oc patch pv data",
              "oc rsh deployment/app mount",
            ],
            x: "マニフェストを直接編集してもよいですが、試験では `oc set volume` が速い定番です。",
            r: "cli",
          },
          {
            q: "OpenShift でアプリとその永続データをバックアップする仕組みは？",
            c: [
              "OADP（OpenShift API for Data Protection、Velero ベース）",
              "etcd のスナップショットのみ",
              "oc get -o yaml の保存だけ",
              "MachineConfig",
            ],
            x: "etcd バックアップはクラスタ状態の保護で、アプリのデータは OADP で保護します。",
            r: "backupdoc",
          },
        ],
      },
      {
        id: "observe",
        title: "監視・ログ・GitOps・Pipelines（EX380 / EX288）",
        goal: "クラスタの可観測性と継続的デリバリを構成できる",
        refs: ["monitoring", "logging", "gitops", "pipelines", "builds"],
        points: [
          "ログは Logging Operator（収集 Vector → 保存 Loki）。`oc logs` は Pod 単体、横断検索はコンソールの Logs",
          "監視はプラットフォーム用 Prometheus ＋ユーザーワークロード監視。警報は Alertmanager",
          "GitOps（Argo CD）: Application リソースで Git のパスとクラスタを結び、差分を自動同期（selfHeal・prune）",
          "Pipelines（Tekton）: Task / Pipeline / PipelineRun。ビルドからデプロイまでをクラスタ内で実行",
          "BuildConfig のトリガー: ConfigChange・ImageChange・Webhook（Git の push で自動ビルド）",
        ],
        qs: [
          {
            q: "OpenShift のログ収集・保存を担う現在の推奨の組み合わせは？",
            c: ["Vector（収集）と Loki（保存）", "Fluentd と Elasticsearch", "Promtail と Prometheus", "journald のみ"],
            x: "以前の Fluentd / Elasticsearch 構成は非推奨となり、Vector / Loki が推奨です。",
            r: "logging",
          },
          {
            q: "Argo CD の Application で `selfHeal: true` を設定すると？",
            c: [
              "クラスタ上の差分（手作業の変更）を検出して Git の状態へ自動的に戻す",
              "Git を自動でコミットする",
              "失敗した Pod を再起動する",
              "イメージを自動更新する",
            ],
            x: "`prune: true` は Git から消えたリソースをクラスタからも削除します。",
            r: "gitops",
          },
          {
            q: "Git への push でビルドを自動実行したい。BuildConfig に設定するのは？",
            c: [
              "Webhook トリガー（GitHub / Generic）",
              "ConfigChange トリガーのみ",
              "CronJob",
              "ImageChange トリガーのみ",
            ],
            x: "ImageChange はベースイメージの更新、ConfigChange は BuildConfig 自体の変更で起動します。",
            r: "builds",
          },
          {
            q: "OpenShift Pipelines（Tekton）の構成要素の対応として正しいものは？",
            c: [
              "Task（手順の集まり）→ Pipeline（Task の並び）→ PipelineRun（実行）",
              "Pipeline → Task → Job",
              "Stage → Step → Build",
              "Playbook → Role → Task",
            ],
            x: "すべて Kubernetes のカスタムリソースとして表現されます。",
            r: "pipelines",
          },
        ],
      },
      {
        id: "platform",
        title: "仮想化・マルチクラスタ・セキュリティ製品",
        goal: "OpenShift Virtualization・ACM・ACS の役割を説明できる",
        refs: ["virt", "acm", "acs", "scaling"],
        points: [
          "OpenShift Virtualization（KubeVirt）: VM を VirtualMachine リソースとして、Pod と同じ基盤で動かす",
          "VM のライブマイグレーション・スナップショット・テンプレート、他ハイパーバイザーからの移行（MTV）",
          "ACM（Advanced Cluster Management）: 複数クラスタの作成・インポート・ポリシー配布・観測を一元化",
          "ACS（Advanced Cluster Security）: 脆弱性管理・ポリシー（ビルド / デプロイ / ランタイム）・ネットワークセグメンテーション・コンプライアンス",
          "スケールと性能: ノードのチューニング（Node Tuning Operator）・Pod の分散（topologySpreadConstraints）",
        ],
        qs: [
          {
            q: "OpenShift Virtualization で仮想マシンはどのように表されるか？",
            c: [
              "VirtualMachine というカスタムリソースとして、Pod と同じクラスタ上で動く",
              "別のハイパーバイザー製品として独立して動く",
              "コンテナイメージに変換される",
              "ノードごとの設定ファイルとして管理される",
            ],
            x: "VM も oc で宣言的に管理でき、ネットワークやストレージの仕組みを共有します。",
            r: "virt",
          },
          {
            q: "複数の OpenShift クラスタへ同じポリシーを配布し、準拠状況をまとめて見たい。使う製品は？",
            c: [
              "Red Hat Advanced Cluster Management（ACM）",
              "Advanced Cluster Security（ACS）",
              "OpenShift GitOps のみ",
              "OpenShift Virtualization",
            ],
            x: "ACM の Policy / Placement でクラスタ群に適用し、Governance の画面で確認します。",
            r: "acm",
          },
          {
            q: "ACS のポリシーが効く段階の組み合わせとして正しいものは？",
            c: [
              "ビルド（イメージ検査）・デプロイ（アドミッション）・ランタイム（実行中の挙動）",
              "ビルドのみ",
              "ランタイムのみ",
              "ネットワークのみ",
            ],
            x: "同じポリシーを CI・アドミッション・実行時の 3 段階で適用できるのが特徴です。",
            r: "acs",
          },
        ],
      },
    ],
  });
})();
