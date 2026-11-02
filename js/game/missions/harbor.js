/* Track: Harbor */
(function (IG) {
  "use strict";
  const HOME = "/home/operator";
  const HOST = "harbor.lab.local";
  const APP_PY =
    'import os\nfrom flask import Flask, jsonify\n\napp = Flask(__name__)\nPORT = int(os.environ.get("PORT", "8000"))\n\n@app.get("/health")\ndef health():\n    return jsonify(status="ok")\n\nif __name__ == "__main__":\n    app.run(host="0.0.0.0", port=PORT)\n';
  const RUNBOOK = IG.t(
    `# 社内レジストリ（Harbor）利用手順\n\n- URL       : https://{0}\n- ユーザー  : dev01\n- パスワード: Training2026   ※訓練用の架空の値\n- 命名規則  : {1}/<プロジェクト>/<リポジトリ>:<タグ>\n- プロジェクトは先に作成が必要（既定は private）\n- push 時に自動で脆弱性スキャン（Trivy）が走る\n\n## よく使うコマンド\n- docker login {2} -u <user> -p <password>\n- harbor project list / harbor project create <name>\n- harbor artifact list <project>/<repo>\n- harbor artifact vulnerabilities <project>/<repo>:<tag>\n`,
    { 0: HOST, 1: HOST, 2: HOST },
  );
  function harbor(w, extra = {}) {
    w.features.add("harbor");
    w.harbor = new IG.Harbor(w, {
      host: HOST,
      users: Object.assign(
        { admin: { password: "not-for-training", admin: true }, dev01: { password: "Training2026" } },
        extra,
      ),
    });
    w.addImage("python:3.8", w.catalog["python:3.8"]);
    return w.harbor;
  }

  IG.registerMission({
    id: "harbor-01",
    track: "harbor",
    order: 1,
    difficulty: 1,
    par: 300,
    xp: 120,
    title: "社内レジストリへ push",
    summary: "Harbor にログインしてプロジェクトを作り、イメージを push する",
    story: [
      "前回ビルドした shop-api:1.0 を本番クラスタで使うには、クラスタから取得できるレジストリに置く必要があります。",
      "CoreLab では Docker Hub ではなく、社内の Harbor を使うルールです。",
      "手順書 ~/runbook/harbor.md を見ながら、shop プロジェクトに push してください。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.features.add("docker");
      harbor(w);
      B.files(w, {
        [HOME + "/runbook/harbor.md"]: RUNBOOK,
        [HOME + "/shop-api/Dockerfile"]:
          'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app.py .\nENV PORT=8000\nCMD ["python", "app.py"]\n',
        [HOME + "/shop-api/requirements.txt"]: "flask==3.0.3\n",
        [HOME + "/shop-api/app.py"]: APP_PY,
      });
      B.sh(w, "docker build -t shop-api:1.0 .", HOME + "/shop-api");
    },
    objectives: [
      {
        title: "Harbor にログインする",
        detail: "手順書の認証情報で docker login する",
        hints: [
          "`cat ~/runbook/harbor.md` に URL と認証情報があります。",
          `\`docker login ${HOST} -u dev01 -p Training2026\``,
        ],
        check: (w) => !!w.docker.logins[HOST],
      },
      {
        title: "shop プロジェクトを作る",
        detail: "Harbor 上に push 先のプロジェクトを作成する",
        hints: [
          "Harbor ではプロジェクトが無いと push できません。`harbor project list` で現状を確認。",
          "`harbor project create shop`",
        ],
        check: (w) => !!w.harbor.projects.shop,
      },
      {
        title: "push してスキャン結果を見る",
        detail: `${HOST}/shop/shop-api:1.0 を push し、artifact 一覧で脆弱性を確認`,
        hints: [
          "push するにはレジストリ名入りのタグが必要です: `docker tag shop-api:1.0 harbor.lab.local/shop/shop-api:1.0`",
          "`docker push harbor.lab.local/shop/shop-api:1.0` → `harbor artifact list shop/shop-api`",
        ],
        check: (w, c) => {
          const p = w.harbor.projects.shop;
          return (
            !!(p && p.repos["shop-api"] && p.repos["shop-api"]["1.0"]) && c.ran(/harbor\s+artifacts?\s+(list|ls|vuln)/)
          );
        },
      },
    ],
    solution: [
      "cat ~/runbook/harbor.md",
      `docker login ${HOST} -u dev01 -p Training2026`,
      "harbor project create shop",
      `docker tag shop-api:1.0 ${HOST}/shop/shop-api:1.0`,
      `docker push ${HOST}/shop/shop-api:1.0`,
      "harbor artifact list shop/shop-api",
    ],
    debrief: {
      points: [
        "イメージ名の先頭がレジストリのホスト名。無い場合は Docker Hub として扱われる。",
        "Harbor はプロジェクト単位で公開範囲・メンバー・ポリシー（脆弱性ブロックなど）を管理する。",
        "push 時の自動スキャンで、本番に出す前に脆弱性を把握できる。",
      ],
      commands: [
        ["docker login <registry>", "レジストリ認証"],
        ["docker tag SRC DST", "別名（レジストリ付き）を付ける"],
        ["docker push <ref>", "アップロード"],
        ["harbor artifact list p/r", "タグとスキャン結果"],
      ],
    },
  });

  IG.registerMission({
    id: "harbor-02",
    track: "harbor",
    order: 2,
    difficulty: 2,
    par: 480,
    xp: 200,
    title: "脆弱性ポリシーに止められた",
    summary: "Critical 脆弱性で pull が拒否されたイメージを、ベース更新で作り直す",
    story: [
      "本番クラスタの shop-api が ImagePullBackOff のまま起動しません。",
      "Harbor の shop プロジェクトには「Critical 以上の脆弱性があるイメージは pull 禁止」というポリシーが入っています。",
      "原因を確かめ、安全なベースイメージで 1.1 を作り直してデプロイを更新してください。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.features.add("docker");
      w.features.add("k8s");
      const H = harbor(w);
      H.createProject("shop", { public: true, preventVul: "critical", members: ["dev01"] });
      B.files(w, {
        [HOME + "/runbook/harbor.md"]: RUNBOOK,
        [HOME + "/shop-api/Dockerfile"]:
          'FROM python:3.8\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app.py .\nENV PORT=8000\nCMD ["python", "app.py"]\n',
        [HOME + "/shop-api/requirements.txt"]: "flask==3.0.3\n",
        [HOME + "/shop-api/app.py"]: APP_PY,
      });
      B.sh(w, `docker build -t ${HOST}/shop/shop-api:1.0 .`, HOME + "/shop-api");
      H.addArtifact("shop", "shop-api", "1.0", w.docker.findImage(`${HOST}/shop/shop-api:1.0`).meta, { pulls: 3 });
      w.docker.images = [];
      const cl = B.cluster(w, {
        name: "prod",
        server: "https://10.0.0.10:6443",
        namespaces: ["shop"],
        ns: "shop",
        nodes: [{ name: "worker-1" }, { name: "worker-2" }],
      });
      const dep = B.deploy("shop-api", "shop", { image: `${HOST}/shop/shop-api:1.0`, port: 8000, replicas: 2 });
      B.apply(cl, dep, B.svc("shop-api", "shop", { port: 80, targetPort: 8000 }));
      B.files(w, { [HOME + "/manifests/shop-api.yaml"]: B.yaml(dep) });
    },
    objectives: [
      {
        title: "止められた理由を確認する",
        detail: "Pod のイベント、または Harbor のスキャン結果から原因を確かめる",
        hints: [
          "`kubectl get pods` → `kubectl describe pod <pod名>` の Events を読みます。",
          `Harbor 側は \`docker login ${HOST} -u dev01 -p Training2026\` の後 \`harbor artifact vulnerabilities shop/shop-api:1.0\` で一覧できます。`,
        ],
        check: (w, c) => c.ran(/describe\s+(po|pods?)\b|get\s+(ev|events)\b|harbor\s+artifacts?\s+vuln/),
      },
      {
        title: "安全なベースで 1.1 を push",
        detail: "Dockerfile のベースを python:3.12-slim に変え、1.1 として push（Critical 0 件）",
        hints: [
          "`cd ~/shop-api` で Dockerfile の FROM を python:3.12-slim に（`vi Dockerfile`）。",
          `\`docker build -t ${HOST}/shop/shop-api:1.1 .\` → \`docker push ${HOST}/shop/shop-api:1.1\`（push 前に docker login が必要）。`,
        ],
        check: (w) => {
          const t = (w.harbor.projects.shop.repos["shop-api"] || {})["1.1"];
          return !!(t && t.scan && t.scan.critical === 0);
        },
      },
      {
        title: "デプロイを 1.1 に更新する",
        detail: "shop-api Deployment のイメージを 1.1 にして 2/2 Ready にする",
        hints: [
          "イメージだけ差し替えるなら kubectl set image が手軽です。",
          `\`kubectl set image deploy/shop-api shop-api=${HOST}/shop/shop-api:1.1\`（または ~/manifests/shop-api.yaml を直して apply）。`,
        ],
        check: (w) => {
          const cl = w.clusters.prod;
          const d = cl.get("Deployment", "shop", "shop-api");
          return d && /:1\.1$/.test(d.spec.template.spec.containers[0].image) && cl.healthy("shop", "shop-api", 2);
        },
      },
    ],
    solution: [
      "kubectl get pods",
      "kubectl get events",
      `docker login ${HOST} -u dev01 -p Training2026`,
      "harbor artifact vulnerabilities shop/shop-api:1.0",
      "cd ~/shop-api",
      "sed -i 's/python:3.8/python:3.12-slim/' Dockerfile",
      `docker build -t ${HOST}/shop/shop-api:1.1 .`,
      `docker push ${HOST}/shop/shop-api:1.1`,
      `kubectl set image deploy/shop-api shop-api=${HOST}/shop/shop-api:1.1`,
      "kubectl rollout status deploy/shop-api",
    ],
    debrief: {
      points: [
        "脆弱性の大半はアプリではなくベースイメージ（OS パッケージ・ランタイム）から来る。slim や最新パッチ版を選ぶだけで激減する。",
        "Harbor の「脆弱なイメージの実行を防止」は pull 時にブロックするので、クラスタ側では ImagePullBackOff として現れる。",
        "例外（CVE 許可リスト）で逃げる前に、まずベース更新で直せないか検討する。",
      ],
      commands: [
        ["harbor artifact vulnerabilities p/r:t", "脆弱性一覧"],
        ["kubectl describe pod <pod>", "Events で失敗理由"],
        ["kubectl set image deploy/x c=img", "イメージ差し替え"],
        ["kubectl rollout status deploy/x", "更新完了待ち"],
      ],
    },
  });

  IG.registerMission({
    id: "harbor-03",
    track: "harbor",
    order: 3,
    difficulty: 3,
    par: 600,
    xp: 250,
    title: "private イメージを pull せよ",
    summary: "robot アカウントと imagePullSecret でプライベートプロジェクトから取得する",
    story: [
      "決済ゲートウェイ（payments/gateway）は機密性の高いイメージなので、Harbor の private プロジェクトに置かれています。",
      "新しいクラスタにデプロイしたところ、Pod が ImagePullBackOff で起動しません。",
      "個人のパスワードをクラスタに置くのは禁止です。pull 専用の robot アカウントを使って解決してください。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.features.add("k8s");
      const H = harbor(w);
      H.createProject("payments", { public: false, members: ["dev01"] });
      H.addArtifact("payments", "gateway", "2.1", {
        kind: "app",
        app: "gateway",
        port: 8080,
        version: "2.1.0",
        size: "96MB",
        vulns: { critical: 0, high: 0, medium: 1, low: 9 },
        base: "python:3.12-slim",
      });
      const cl = B.cluster(w, {
        name: "prod",
        server: "https://10.0.0.10:6443",
        namespaces: ["payments"],
        ns: "payments",
        nodes: [{ name: "worker-1" }, { name: "worker-2" }],
      });
      const dep = B.deploy("gateway", "payments", { image: `${HOST}/payments/gateway:2.1`, port: 8080, replicas: 2 });
      B.apply(cl, dep, B.svc("gateway", "payments", { port: 80, targetPort: 8080 }));
      B.files(w, {
        [HOME + "/runbook/harbor.md"]:
          RUNBOOK +
          IG.t(
            "\n## クラスタから private プロジェクトを pull するには\n- プロジェクト単位の robot アカウント（pull 権限のみ）を作る: harbor robot create <name> --project <project>\n- その認証情報で docker-registry 型の Secret を作り、Pod の imagePullSecrets に指定する\n- 注意: robot 名には $ が含まれるのでシェルではシングルクォートで囲む\n",
          ),
        [HOME + "/manifests/gateway.yaml"]: B.yaml(dep),
      });
    },
    objectives: [
      {
        title: "pull 失敗の理由を確認する",
        detail: "Pod の Events からエラー内容を読む",
        hints: [
          "`kubectl get pods` で状態を確認。",
          "`kubectl describe pod <pod名>` の Events に 401 Unauthorized が出ています。",
        ],
        check: (w, c) => c.ran(/describe\s+(po|pods?)\b|get\s+(ev|events)\b/),
      },
      {
        title: "robot アカウントで pull 用 Secret を作る",
        detail: "payments の pull 権限だけを持つ robot を作り、docker-registry Secret にする",
        hints: [
          `\`harbor login ${HOST} -u dev01 -p Training2026\` → \`harbor robot create puller --project payments\` で Secret が表示されます。`,
          `\`kubectl create secret docker-registry harbor-pull --docker-server=${HOST} --docker-username='robot$payments+puller' --docker-password=<表示されたSecret>\`（$ を含むのでシングルクォート必須）`,
        ],
        check: (w) => {
          const cl = w.clusters.prod;
          return cl.list("Secret", "payments").some((s) => {
            if (s.type !== "kubernetes.io/dockerconfigjson") return false;
            const a = cl.pullAuths("payments", { imagePullSecrets: [{ name: s.metadata.name }] })[HOST];
            const id = a && w.harbor.auth(a.username, a.password);
            return !!(id && id.robot && w.harbor.can(id, "payments", "pull"));
          });
        },
      },
      {
        title: "gateway を起動する",
        detail: "Deployment に imagePullSecrets を設定し 2/2 Ready にする",
        hints: [
          "Pod テンプレートの spec に imagePullSecrets を追加します。~/manifests/gateway.yaml を編集して apply するか、patch を使います。",
          '`kubectl patch deploy gateway -p \'{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"harbor-pull"}]}}}}\'`',
        ],
        check: (w) => w.clusters.prod.healthy("payments", "gateway", 2),
      },
    ],
    solution: [
      "kubectl get pods",
      "kubectl get events",
      `harbor login ${HOST} -u dev01 -p Training2026`,
      "harbor robot create puller --project payments",
      (w) =>
        `kubectl create secret docker-registry harbor-pull --docker-server=${HOST} --docker-username='robot$payments+puller' --docker-password=${w.harbor.robotSecret("payments", "puller")}`,
      `kubectl patch deploy gateway -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"harbor-pull"}]}}}}'`,
      "kubectl get pods",
    ],
    debrief: {
      points: [
        "private レジストリからの pull には、Pod（または ServiceAccount）に imagePullSecrets が必要。",
        "人のアカウントではなく、プロジェクト単位・権限最小（pull のみ）の robot アカウントを使う。漏えい時の影響範囲が小さく、失効も簡単。",
        "シェルでは $ が変数展開される。robot$… のような値は必ずシングルクォートで囲む。",
      ],
      commands: [
        ["harbor robot create n --project p", "robot 作成"],
        ["kubectl create secret docker-registry …", "pull 用 Secret"],
        ["kubectl patch deploy …", "部分更新"],
        ["kubectl describe pod", "Events で 401 を確認"],
      ],
    },
  });
})((globalThis.IG = globalThis.IG || {}));
