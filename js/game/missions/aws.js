/* Track: AWS */
(function (IG) {
  "use strict";
  const HOME = "/home/operator";
  const SG = "sg-0a1b2c3d4e5f00001";

  function aws(w) {
    w.features.add("aws");
    w.aws = new IG.AWS(w, {});
    return w.aws;
  }

  IG.registerMission({
    id: "aws-01",
    track: "aws",
    order: 1,
    difficulty: 1,
    par: 360,
    xp: 140,
    title: "EKS クラスタにつなげ",
    summary: "AWS CLI で認証を確認し、kubeconfig を作って EKS を操作する",
    story: [
      "今日から本番 EKS（prod-eks）の当番に入ります。踏み台には AWS CLI と kubectl が入っていますが、kubectl はまだどこにも接続していません。",
      "「今の認証情報が誰なのか」を確かめてから kubeconfig を作り、クラスタを操作できるようにしてください。",
      "ついでに、昨夜のメンテで 0 台に縮退したままの shop/web を 2 台に戻してほしいとのことです。",
    ],
    cwd: HOME,
    setup(w, B) {
      const A = aws(w);
      w.features.add("k8s");
      const cl = B.cluster(w, {
        name: "prod-eks",
        flavor: "eks",
        server: "https://4F2A1C9B7D3E.gr7.ap-northeast-1.eks.amazonaws.com",
        context: false,
        namespaces: ["shop"],
        nodes: [
          { name: "ip-10-0-1-23.ap-northeast-1.compute.internal" },
          { name: "ip-10-0-2-117.ap-northeast-1.compute.internal" },
          { name: "ip-10-0-3-41.ap-northeast-1.compute.internal" },
        ],
      });
      A.eks["prod-eks"] = {
        name: "prod-eks",
        clusterName: "prod-eks",
        version: "1.30",
        status: "ACTIVE",
        endpoint: cl.server,
      };
      B.apply(
        cl,
        B.deploy("web", "shop", { image: "nginx:1.27", port: 80, replicas: 0 }),
        B.svc("web", "shop", { port: 80, targetPort: 80, type: "LoadBalancer" }),
      );
      B.files(w, {
        [HOME + "/handover.txt"]: IG.t(
          "引き継ぎ\n- 本番 EKS: prod-eks（ap-northeast-1）\n- kubeconfig は aws eks update-kubeconfig で作成する\n- shop/web は 2 台が正常\n",
        ),
      });
    },
    objectives: [
      {
        title: "認証情報を確認する",
        detail: "今使っている AWS の IAM 主体を確認する",
        hints: ["「自分は誰？」は STS に聞きます。", "`aws sts get-caller-identity`"],
        check: (w, c) => c.ran(/aws\s+sts\s+get-caller-identity/),
      },
      {
        title: "kubeconfig を作ってノードを確認",
        detail: "update-kubeconfig で接続し、kubectl get nodes が通る",
        hints: [
          "`aws eks list-clusters` でクラスタ名を確認。",
          "`aws eks update-kubeconfig --name prod-eks --region ap-northeast-1` → `kubectl get nodes`",
        ],
        check: (w, c) =>
          !!w.kube.current &&
          w.currentCluster().name === "prod-eks" &&
          c.order(/update-kubeconfig/, /\bget\s+(no|nodes?)\b/),
      },
      {
        title: "shop/web を 2 台に戻す",
        detail: "web Deployment を 2/2 Ready にする",
        hints: [
          "`kubectl get deploy -n shop` で READY 0/0 を確認。",
          "`kubectl scale deploy/web -n shop --replicas=2`",
        ],
        check: (w) => w.clusters["prod-eks"].healthy("shop", "web", 2),
      },
    ],
    solution: [
      "aws sts get-caller-identity",
      "aws eks list-clusters",
      "aws eks update-kubeconfig --name prod-eks --region ap-northeast-1",
      "kubectl get nodes",
      "kubectl get deploy -n shop",
      "kubectl scale deploy/web -n shop --replicas=2",
    ],
    debrief: {
      points: [
        "作業前に aws sts get-caller-identity で「どのアカウントの誰か」を確認する。本番と検証の取り違えを防ぐ基本動作。",
        "EKS の kubeconfig は aws eks update-kubeconfig が生成し、認証は IAM（aws eks get-token）で行われる。",
        "kubectl config get-contexts / use-context で接続先クラスタを切り替えられる。",
      ],
      commands: [
        ["aws sts get-caller-identity", "認証主体の確認"],
        ["aws eks update-kubeconfig --name n", "kubeconfig 作成"],
        ["kubectl config current-context", "接続先確認"],
        ["kubectl scale deploy/x --replicas=N", "台数変更"],
      ],
    },
  });

  IG.registerMission({
    id: "aws-02",
    track: "aws",
    order: 2,
    difficulty: 2,
    par: 480,
    xp: 200,
    title: "HTTPS が届かない",
    summary: "セキュリティグループを調べて 443 を開け、SSH の全開放を塞ぐ",
    story: [
      "社内ポータルを EC2（corp-portal）に移行しました。http では見えるのに、https:// だとタイムアウトするそうです。",
      "さらにセキュリティ監査から「SSH(22) がインターネット全体に公開されている」と指摘が来ています。",
      "セキュリティグループを確認し、HTTPS を通しつつ、SSH はオフィス（198.51.100.0/24）からだけに絞ってください。",
    ],
    cwd: HOME,
    setup(w) {
      const A = aws(w);
      A.addSG({
        id: SG,
        name: "corp-portal-sg",
        description: "corp portal web server",
        ingress: [
          { proto: "tcp", from: 80, to: 80, cidrs: ["0.0.0.0/0"] },
          { proto: "tcp", from: 22, to: 22, cidrs: ["0.0.0.0/0"] },
        ],
      });
      A.addSG({ id: "sg-0f9e8d7c6b5a40002", name: "default", description: "default VPC security group", ingress: [] });
      A.addInstance({
        id: "i-0c0ffee1234567890",
        name: "corp-portal",
        privateIp: "10.0.1.50",
        publicIp: "203.0.113.10",
        listen: [80, 443, 22],
        sgIds: [SG],
        body: IG.t("<!doctype html><title>CoreLab Portal</title><h1>CoreLab 社内ポータル (EC2)</h1>"),
      });
      A.addInstance({
        id: "i-0badc0de987654321",
        name: "batch-worker",
        privateIp: "10.0.2.71",
        publicIp: null,
        state: "stopped",
        sgIds: ["sg-0f9e8d7c6b5a40002"],
      });
      w.hosts.bastion.vfs.write(
        HOME + "/audit/finding-0042.txt",
        IG.t(
          "指摘: corp-portal-sg で tcp/22 が 0.0.0.0/0 に許可されている\n対応: 送信元をオフィスのグローバル IP 帯 198.51.100.0/24 に限定すること\n（この踏み台の送信元 IP: 198.51.100.20）\n",
        ),
        { mkdirs: true },
      );
    },
    objectives: [
      {
        title: "セキュリティグループを調べる",
        detail: "インスタンスに付いている SG の受信ルールを確認する",
        hints: [
          "`aws ec2 describe-instances` で corp-portal の SecurityGroups を確認。--query で絞り込むと見やすくなります。",
          `\`aws ec2 describe-security-groups --group-ids ${SG}\``,
        ],
        check: (w, c) => c.ran(/describe-security-groups/),
      },
      {
        title: "HTTPS を開けて表示を確認",
        detail: "tcp/443 を 0.0.0.0/0 から許可し、https://203.0.113.10/ に curl する",
        hints: [
          `\`aws ec2 authorize-security-group-ingress --group-id ${SG} --protocol tcp --port 443 --cidr 0.0.0.0/0\``,
          "`curl -sk https://203.0.113.10/`（-k は訓練用の自己署名証明書を許可）",
        ],
        check: (w, c) => c.http((h) => h.ok && h.host === "203.0.113.10" && h.port === 443),
      },
      {
        title: "SSH をオフィスからだけにする",
        detail: "22 番の 0.0.0.0/0 を削除し、198.51.100.0/24 を許可する（踏み台から締め出されない順番で）",
        hints: [
          "先にオフィス帯を許可してから全開放を消すと安全です。",
          `\`aws ec2 authorize-security-group-ingress --group-id ${SG} --protocol tcp --port 22 --cidr 198.51.100.0/24\` → \`aws ec2 revoke-security-group-ingress --group-id ${SG} --protocol tcp --port 22 --cidr 0.0.0.0/0\``,
        ],
        check: (w) => {
          const sg = w.aws.sgs[SG];
          const r22 = sg.ingress.filter((r) => r.from <= 22 && r.to >= 22);
          return (
            r22.length > 0 &&
            r22.every((r) => !r.cidrs.includes("0.0.0.0/0")) &&
            r22.some((r) => r.cidrs.includes("198.51.100.0/24"))
          );
        },
      },
    ],
    solution: [
      "aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,Tags[0].Value,PublicIpAddress,SecurityGroups[0].GroupId]' --output text",
      `aws ec2 describe-security-groups --group-ids ${SG}`,
      `aws ec2 authorize-security-group-ingress --group-id ${SG} --protocol tcp --port 443 --cidr 0.0.0.0/0`,
      "curl -sk https://203.0.113.10/",
      `aws ec2 authorize-security-group-ingress --group-id ${SG} --protocol tcp --port 22 --cidr 198.51.100.0/24`,
      `aws ec2 revoke-security-group-ingress --group-id ${SG} --protocol tcp --port 22 --cidr 0.0.0.0/0`,
    ],
    debrief: {
      points: [
        "セキュリティグループはステートフルなホワイトリスト。許可が無い通信は「拒否」ではなく応答なし（タイムアウト）になる。",
        "タイムアウト＝経路上のファイアウォール（SG/NACL）を疑う、Connection refused＝相手まで届いたがポートが閉じている、と切り分けられる。",
        "管理ポート（22/3389）を 0.0.0.0/0 に開けない。送信元を絞るか SSM Session Manager を使う。",
      ],
      commands: [
        ["aws ec2 describe-security-groups", "受信ルール確認"],
        ["aws ec2 authorize-security-group-ingress", "ルール追加"],
        ["aws ec2 revoke-security-group-ingress", "ルール削除"],
        ["--query '…' --output text", "必要な列だけ表示"],
      ],
    },
  });

  IG.registerMission({
    id: "aws-03",
    track: "aws",
    order: 3,
    difficulty: 2,
    par: 420,
    xp: 200,
    title: "S3 公開事故を止めろ",
    summary: "誤って公開された S3 バケットを Block Public Access で閉じる",
    story: [
      "【緊急】顧客データのエクスポート置き場（corelab-customer-exports）が、インターネットから誰でも読める状態だと通報がありました。",
      "まず本当に外から読めるのかを確認し、すぐに公開をブロックしてください。",
      "※ データはすべて架空の訓練用です。",
    ],
    cwd: HOME,
    setup(w) {
      const A = aws(w);
      A.addBucket({
        name: "corelab-customer-exports",
        policyPublic: true,
        objects: {
          "2026-10/customers.csv":
            "id,name,email,plan\n1001,Sample Taro,taro@example.com,gold\n1002,Sample Hanako,hanako@example.com,silver\n1003,Test Jiro,jiro@example.com,bronze\n",
        },
      });
      const s = A.addBucket({ name: "corelab-static-assets", objects: { "logo.svg": "<svg/>" } });
      s.pab = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
    },
    objectives: [
      {
        title: "外から読めることを確認する",
        detail: "オブジェクトの URL に認証なしで curl し、読めてしまうことを確認",
        hints: [
          "`aws s3 ls s3://corelab-customer-exports/ --recursive` の代わりに、まず `aws s3 ls s3://corelab-customer-exports/2026-10/` でキーを確認。",
          "URL は https://<バケット>.s3.ap-northeast-1.amazonaws.com/<キー> です: `curl -s https://corelab-customer-exports.s3.ap-northeast-1.amazonaws.com/2026-10/customers.csv`",
        ],
        check: (w, c) => c.http((h) => h.status === 200 && h.host.startsWith("corelab-customer-exports.")),
      },
      {
        title: "Block Public Access を有効にする",
        detail: "バケットの 4 項目すべてを true にする",
        hints: [
          "s3api の put-public-access-block を使います。",
          "`aws s3api put-public-access-block --bucket corelab-customer-exports --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`",
        ],
        check: (w) => Object.values(w.aws.buckets["corelab-customer-exports"].pab).every(Boolean),
      },
      {
        title: "閉じたことを確認する",
        detail: "もう一度 curl して 403 になることを確認",
        hints: ['ステータスコードだけ見るなら `curl -s -o /dev/null -w "%{http_code}" <URL>`'],
        check: (w, c) =>
          c.ranSince(1, /curl/) &&
          (c.lastHttp((h) => h.host.startsWith("corelab-customer-exports.")) || {}).status === 403,
      },
    ],
    solution: [
      "aws s3 ls",
      "aws s3 ls s3://corelab-customer-exports/2026-10/",
      "aws s3api get-bucket-policy-status --bucket corelab-customer-exports",
      "curl -s https://corelab-customer-exports.s3.ap-northeast-1.amazonaws.com/2026-10/customers.csv",
      "aws s3api put-public-access-block --bucket corelab-customer-exports --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
      'curl -s -o /dev/null -w "%{http_code}" https://corelab-customer-exports.s3.ap-northeast-1.amazonaws.com/2026-10/customers.csv',
    ],
    debrief: {
      points: [
        "Block Public Access はバケットポリシーや ACL より優先される「安全装置」。事故時はまずこれで止血する。",
        "止血のあとは、公開ポリシーの削除（delete-bucket-policy）、アクセスログ（CloudTrail / サーバーアクセスログ）の確認、関係者への報告へ。",
        "アカウント全体で Block Public Access を有効にしておけば、そもそも事故が起きにくい。",
      ],
      commands: [
        ["aws s3 ls s3://bucket/prefix/", "オブジェクト一覧"],
        ["aws s3api get-bucket-policy-status", "公開状態"],
        ["aws s3api put-public-access-block", "公開ブロック"],
        ['curl -w "%{http_code}"', "ステータスだけ表示"],
      ],
    },
  });

  // Free lab: every system available, no objectives.
  IG.registerMission({
    id: "sandbox",
    track: null,
    order: 0,
    difficulty: 0,
    par: 0,
    xp: 0,
    sandbox: true,
    title: "フリーラボ",
    summary: "すべての環境がそろった自由練習場。壊しても大丈夫。",
    story: [
      "ミッションの制約なしで自由にコマンドを試せる練習場です。",
      "Kubernetes（training-cluster）、Docker、Harbor（dev01 / Training2026）、AWS（EC2・S3・EKS）が使えます。",
      "Linux 練習用に `ssh lab-ubuntu`（Ubuntu 24.04・未フォーマットの追加ディスク付き）と `ssh lab-rhel`（RHEL 9）を用意しています。sudo・apt/dnf・systemctl・ufw/firewalld・parted/LVM/mkfs/fstab・ACL などを自由に試せます。対応範囲は docs/LINUX-COVERAGE.md にまとめています。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.addHost("lab-ubuntu", {
        user: "ubuntu",
        ip: "10.0.1.70",
        osVersion: "24.04",
        disks: [{ name: "nvme1n1", sizeGiB: 20 }],
      });
      w.addHost("lab-rhel", {
        os: "rhel",
        user: "ec2-user",
        ip: "10.0.1.71",
        disks: [{ name: "nvme1n1", sizeGiB: 10 }],
      });
      ["docker", "harbor", "k8s", "aws"].forEach((f) => w.features.add(f));
      w.harbor = new IG.Harbor(w, { host: "harbor.lab.local", users: { dev01: { password: "Training2026" } } });
      w.harbor.createProject("sandbox", { public: true, members: ["dev01"] });
      const A = aws(w);
      A.addSG({ id: SG, name: "lab-web-sg", ingress: [{ proto: "tcp", from: 80, to: 80, cidrs: ["0.0.0.0/0"] }] });
      A.addInstance({
        id: "i-0123456789abcdef0",
        name: "lab-web",
        privateIp: "10.0.1.60",
        publicIp: "203.0.113.60",
        listen: [80, 443],
        sgIds: [SG],
      });
      A.addBucket({ name: "corelab-sandbox", objects: { "hello.txt": "hello from S3\n" } });
      const cl = B.cluster(w, {
        name: "training-cluster",
        server: "https://10.0.0.10:6443",
        namespaces: ["lab"],
        ns: "lab",
        nodes: [{ name: "cp-1", role: "control-plane" }, { name: "worker-1" }, { name: "worker-2" }],
      });
      B.apply(
        cl,
        B.deploy("hello", "lab", { image: "nginx:1.27", port: 80, replicas: 2 }),
        B.svc("hello", "lab", { port: 80, targetPort: 80 }),
      );
      B.files(w, {
        [HOME + "/README.md"]: IG.t(
          '# フリーラボ\n\n例:\n  kubectl get all\n  kubectl create deployment web --image=nginx:1.27 --replicas=3\n  kubectl expose deployment web --port=80\n  kubectl run tmp --rm -it --image=curlimages/curl -- curl -s http://web\n  docker run -d --name web -p 8080:80 nginx:1.27\n  aws ec2 describe-instances --output text --query "Reservations[].Instances[].InstanceId"\n',
        ),
        [HOME + "/app/Dockerfile"]: "FROM nginx:1.27\nCOPY index.html /usr/share/nginx/html/index.html\n",
        [HOME + "/app/index.html"]: "<h1>My first image</h1>\n",
      });
    },
    objectives: [],
    solution: [],
    debrief: { points: [], commands: [] },
  });
})((globalThis.IG = globalThis.IG || {}));
