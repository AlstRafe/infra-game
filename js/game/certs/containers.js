/* Certification catalogue: Docker / コンテナ と Harbor（レジストリ）。
 * 出題範囲は各認定機関の公式ページから（2026-10 時点）。公式に配点がない試験は主題数で等分。 */
IG.registerCerts({
  topic: "docker",
  certs: [
    {
      id: "dca",
      name: "Docker Certified Associate",
      code: "DCA",
      org: "Mirantis",
      level: "associate",
      url: "https://training.mirantis.com/certification/dca-certification-exam/",
      note: "公式サイトに配点の内訳が掲載されていないため、出題領域を均等配分として扱っています",
      domains: [
        { name: "Orchestration（Swarm / Kubernetes）", weight: 25, units: ["docker:#swarm", "k8s:1", "k8s:2"] },
        {
          name: "Image Creation, Management, and Registry",
          weight: 20,
          units: ["docker:2", "docker:4", "harbor:1", "harbor:#ops"],
        },
        { name: "Installation and Configuration", weight: 15, units: ["docker:#ops", "docker:5"] },
        { name: "Networking", weight: 15, units: ["docker:#net", "docker:3"] },
        { name: "Security", weight: 15, units: ["docker:#hardening", "docker:4", "harbor:3"] },
        { name: "Storage and Volumes", weight: 10, units: ["docker:3", "docker:5"] },
      ],
    },
    {
      id: "ex188",
      name: "Red Hat Certified Developer in Cloud-native Applications",
      code: "EX188",
      org: "Red Hat",
      level: "associate",
      url: "https://www.redhat.com/en/services/training/ex188-red-hat-certified-specialist-containers-exam",
      note: "RHEL 10・Podman v5・OCP 4.22 ベースの実技試験",
      domains: [
        { name: "Implement images using Podman and Containerfile", weight: 25, units: ["docker:2", "docker:#podman"] },
        { name: "Manage images", weight: 20, units: ["docker:4", "docker:#podman", "harbor:1"] },
        { name: "Run containers locally using Podman", weight: 20, units: ["docker:1", "docker:#podman"] },
        { name: "Run multi-container applications with Podman", weight: 20, units: ["docker:3", "docker:#podman"] },
        { name: "Troubleshoot containerized applications", weight: 15, units: ["docker:3", "docker:#ops"] },
      ],
    },
  ],
});

IG.registerCerts({
  topic: "harbor",
  note: "Harbor にはベンダー資格がありません（CNCF の Graduated プロジェクト）。レジストリとサプライチェーンを問う他資格の該当分野を、ここから対策できます。",
  certs: [
    {
      id: "cks-supply",
      name: "CKS のサプライチェーン分野（Harbor 関連の対策）",
      code: "CKS (Supply Chain)",
      org: "CNCF",
      level: "professional",
      url: "https://training.linuxfoundation.org/certification/certified-kubernetes-security-specialist/",
      note: "CKS 全体は Kubernetes 分野に掲載。ここではレジストリ・イメージに関わる分野を抜き出しています",
      domains: [
        { name: "Minimize base image footprint", weight: 20, units: ["docker:4", "docker:#hardening"] },
        {
          name: "Understand your supply chain（SBOM / CI/CD / artifact repositories）",
          weight: 30,
          units: ["harbor:#supplychain", "harbor:5"],
        },
        {
          name: "Secure your supply chain（permitted registries, sign and validate artifacts）",
          weight: 30,
          units: ["harbor:4", "harbor:#supplychain"],
        },
        { name: "Static analysis of workloads and images", weight: 20, units: ["harbor:3", "harbor:#supplychain"] },
      ],
    },
  ],
});
