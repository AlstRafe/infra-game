/* Exam-oriented extra packs for Harbor / registry operations.
 * Harbor 自体のベンダー資格はないため、CKS のサプライチェーン分野・KCSA のプラットフォーム
 * セキュリティ分野・DCA の image management 分野に対応する内容を扱う。
 * Sources: goharbor.io, OCI specifications, sigstore, CNCF Security TAG. */
IG.addExtras({
  topic: 'harbor',
  refs: {
    cosign: ['Sigstore Cosign documentation', 'https://docs.sigstore.dev/cosign/signing/overview/'],
    notation: ['Notary Project / Notation documentation', 'https://notaryproject.dev/docs/'],
    trivy: ['Trivy documentation', 'https://trivy.dev/latest/docs/'],
    cyclonedx: ['CycloneDX specification', 'https://cyclonedx.org/specification/overview/'],
    slsa: ['SLSA — Supply-chain Levels for Software Artifacts', 'https://slsa.dev/spec/v1.0/levels'],
    k8sadmission: ['Admission Controllers Reference (Kubernetes)', 'https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/'],
    api: ['Using the Harbor API Explorer', 'https://goharbor.io/docs/main/working-with-projects/using-api-explorer/'],
    logs: ['Access Project Logs', 'https://goharbor.io/docs/main/working-with-projects/project-configuration/access-project-logs/'],
    labels: ['Create Labels', 'https://goharbor.io/docs/main/working-with-projects/working-with-images/create-labels/'],
    retag: ['Retagging Images', 'https://goharbor.io/docs/main/working-with-projects/working-with-images/retagging-images/'],
    deletetag: ['Deleting Tags', 'https://goharbor.io/docs/main/working-with-projects/working-with-images/deleting-tags/'],
  },
  extras: [
    {
      id: 'supplychain', title: 'サプライチェーンセキュリティ（CKS / KCSA 対応）', goal: '署名・SBOM・ポリシーでイメージの信頼性を担保できる',
      refs: ['cosign', 'notation', 'trivy', 'cyclonedx', 'slsa', 'k8sadmission', 'sign'],
      points: [
        'サプライチェーンの守り: 信頼できるベース → 再現可能なビルド → 署名 → SBOM → スキャン → 許可レジストリの制限 → ランタイム検知',
        '署名は Cosign（Sigstore）や Notation（Notary Project）。署名も OCI artifact としてレジストリに保存される',
        'キーレス署名は OIDC の身元（CI のワークフロー）に紐づく短命な証明書を使い、透明性ログに記録する',
        'SBOM（SPDX / CycloneDX）があると、新しい CVE が出たときに影響範囲を即座に特定できる',
        'クラスタ側では アドミッション（Kyverno / Gatekeeper / ACS）で「署名済み・許可レジストリ・スキャン済み」を強制',
        'SLSA はビルドの改ざん耐性をレベルで表す枠組み（来歴 = provenance の記録が鍵）',
      ],
      qs: [
        { q: 'イメージに署名しておくと防げるのは？', c: ['レジストリやネットワークの途中でイメージがすり替えられても、検証で検知できる', 'イメージに含まれる脆弱性そのもの', 'コンテナの権限昇格', 'ディスクの枯渇'], x: '署名は「出所と完全性」の保証で、中身の脆弱性はスキャンで見ます。両方必要です。', r: 'cosign' },
        { q: 'Cosign のキーレス署名の仕組みは？', c: ['CI の OIDC 身元から短命な証明書を発行し、署名を透明性ログに記録する', '署名鍵をイメージに同梱する', 'レジストリのパスワードで署名する', '署名を行わずハッシュだけを保存する'], x: '長期の秘密鍵を管理せずに済み、「どのワークフローが署名したか」を検証できます。', r: 'cosign' },
        { q: 'クラスタに「署名されたイメージ以外は入れない」を強制する場所は？', c: ['アドミッションコントローラ（Kyverno / Gatekeeper / ACS のポリシー）', 'kubelet の設定ファイルのみ', 'NetworkPolicy', 'RBAC の Role'], x: 'レジストリ側の制御（Harbor の署名強制）と、クラスタ側のアドミッションの二重で担保します。', r: 'k8sadmission' },
        { q: '新たに公表された CVE が自社の全イメージに影響するかを素早く調べるのに役立つのは？', c: ['各イメージの SBOM と、レジストリの定期再スキャン結果', 'イメージのタグ一覧', 'Pod のログ', 'ノードの CPU 使用率'], x: 'SBOM に依存コンポーネントとバージョンが記録されているため、照合で影響範囲が分かります。', r: 'cyclonedx' },
        { q: 'SLSA が主に扱う対象は？', c: ['ビルド過程の改ざん耐性と来歴（provenance）の記録', 'コンテナの実行時権限', 'ネットワークの暗号化', 'ログの保持期間'], x: '「誰が・どのソースから・どの環境でビルドしたか」を検証可能にする枠組みです。', r: 'slsa' },
      ],
    },
    {
      id: 'ops', title: 'レジストリ運用（DCA: Image Creation and Registry）', goal: 'タグ設計・API・監査でレジストリを運用できる',
      refs: ['api', 'logs', 'labels', 'retag', 'deletetag', 'pushpull', 'quota', 'immutability'],
      points: [
        'タグ設計: `latest` に依存しない。`1.2.3` と、必要なら `1.2` / `1`、CI ではコミットハッシュも付ける',
        'ダイジェスト（`@sha256:…`）で参照すると内容が固定される。本番のマニフェストはダイジェスト固定が最も安全',
        'Harbor の REST API（API Explorer）でプロジェクト作成・スキャン・削除を自動化できる',
        'ラベルでイメージを分類（例: approved / deprecated）し、保持ルールと組み合わせる',
        '監査: プロジェクトのログで push / pull / delete を確認。robot アカウントごとの利用状況を追う',
        '容量管理: クォータ → 保持ルール（retention）→ GC の順で設計する',
      ],
      qs: [
        { q: '本番デプロイで `app:latest` を使うことの問題は？', c: ['同じ名前で中身が変わるため、どのイメージが動いているか特定できず再現もできない', 'pull が遅くなる', 'スキャンができない', 'レジストリの容量が増える'], x: 'バージョンタグかダイジェストで固定します。ロールバック時にも効いてきます。', r: 'pushpull' },
        { q: 'Harbor で、リリース済みタグを書き換え不能にしつつ古い開発タグを自動整理したい。組み合わせは？', c: ['リリースタグに不変ルール、開発タグに保持ルール（＋GC）', '保持ルールだけを設定する', 'クォータだけを設定する', 'robot アカウントを分ける'], x: '不変ルールは上書きを拒否し、保持ルールは古いタグを削除します。実容量は GC で回収します。', r: 'immutability' },
        { q: 'Harbor の操作（プロジェクト作成・スキャン起動・削除）を CI から自動化する方法は？', c: ['Harbor の REST API を robot アカウントの資格情報で呼ぶ', 'Web UI の操作を記録する', 'docker CLI だけで行う', 'データベースを直接更新する'], x: 'API Explorer で仕様を確認できます。DB の直接操作は壊すため禁物です。', r: 'api' },
        { q: '誰がいつイメージを削除したかを確認したいとき、Harbor で見る場所は？', c: ['プロジェクトのログ（監査ログ）', 'Pod のログ', 'GC のジョブ結果のみ', 'Trivy のスキャン結果'], x: 'push / pull / delete などの操作が記録されます。保持期間の設定も確認しておきます。', r: 'logs' },
      ],
    },
  ],
});
