/* Game layer: tracks, mission registry, play sessions (objective checks, hints, scoring),
 * career progress (XP, ranks, badges) persisted through an injected storage. DOM-free. */
(function (IG) {
  "use strict";
  const U = IG.util;

  // name: track title · short: tight spaces · label: the product name (filters, dictionary)
  IG.tracks = [
    {
      id: "basics",
      name: IG.t("Linux 基礎"),
      short: "Linux",
      label: "Linux",
      color: "#8fa3b8",
      icon: "❯_",
      blurb: IG.t("端末操作・権限・ディスク・サービス・ファイアウォール"),
    },
    {
      id: "docker",
      name: "Docker",
      short: "Docker",
      label: "Docker",
      color: "#2496ed",
      icon: "🐳",
      blurb: IG.t("コンテナの起動・ビルド・Compose"),
    },
    {
      id: "harbor",
      name: "Harbor",
      short: "Harbor",
      label: "Harbor",
      color: "#4cae4c",
      icon: "⚓",
      blurb: IG.t("レジストリ・脆弱性スキャン・pull 認証"),
    },
    {
      id: "k8s",
      name: "Kubernetes",
      short: "K8s",
      label: "Kubernetes",
      color: "#4f7cf0",
      icon: "☸",
      blurb: IG.t("Pod・Service・ロールアウト・ノード障害"),
    },
    {
      id: "ocp",
      name: "OpenShift",
      short: "OCP",
      label: "OpenShift",
      color: "#e5484d",
      icon: "⛭",
      blurb: IG.t("プロジェクト・Route・SCC"),
    },
    {
      id: "aws",
      name: "AWS",
      short: "AWS",
      label: "AWS",
      color: "#f5a524",
      icon: "☁",
      blurb: IG.t("EKS 接続・セキュリティグループ・S3"),
    },
  ];
  IG.ranks = [
    { xp: 0, name: IG.t("見習いオペレーター"), en: "Trainee" },
    { xp: 300, name: IG.t("ジュニアオペレーター"), en: "Junior Operator" },
    { xp: 900, name: IG.t("オペレーター"), en: "Operator" },
    { xp: 1800, name: "SRE", en: "Site Reliability Engineer" },
    { xp: 3000, name: IG.t("シニア SRE"), en: "Senior SRE" },
    { xp: 4500, name: IG.t("プラットフォームアーキテクト"), en: "Platform Architect" },
    { xp: 6500, name: IG.t("インフラレジェンド"), en: "Infra Legend" },
  ];
  IG.badges = {
    first: { name: IG.t("初出動"), icon: "🚨", desc: IG.t("最初のミッションをクリア") },
    flawless: { name: IG.t("ノーヒント"), icon: "🎯", desc: IG.t("ヒントなしで ★3 クリア") },
    speed: { name: IG.t("神速対応"), icon: "⚡", desc: IG.t("目標時間の半分以内でクリア") },
    basics: { name: IG.t("ターミナル使い"), icon: "❯_", desc: IG.t("Linux 基礎トラックを完走") },
    docker: { name: IG.t("コンテナ職人"), icon: "🐳", desc: IG.t("Docker トラックを完走") },
    harbor: { name: IG.t("ハーバーマスター"), icon: "⚓", desc: IG.t("Harbor トラックを完走") },
    k8s: { name: IG.t("クラスタの航海士"), icon: "☸", desc: IG.t("Kubernetes トラックを完走") },
    ocp: { name: IG.t("OpenShift パイロット"), icon: "⛭", desc: IG.t("OpenShift トラックを完走") },
    aws: { name: IG.t("クラウドレンジャー"), icon: "☁", desc: IG.t("AWS トラックを完走") },
    all: { name: IG.t("データセンター完成"), icon: "🏆", desc: IG.t("全ミッションをクリア") },
  };
  IG.missions = [];
  IG.registerMission = (m) => {
    const defaults = { difficulty: 1, par: 300, xp: 100, objectives: [], debrief: { points: [], commands: [] } };
    IG.missions.push(Object.assign({}, defaults, IG.i18n.deep(m)));
  };
  IG.missionsOf = (track) => IG.missions.filter((m) => m.track === track).sort((a, b) => a.order - b.order);
  IG.mission = (id) => IG.missions.find((m) => m.id === id);

  /* ------------------------------------------------------------ mission-building helpers */
  IG.build = {
    cluster(w, o) {
      const c = w.addCluster(new IG.k8s.Cluster(w, o));
      if (o.context !== false)
        w.addContext(o.contextName || o.name, o.name, o.ns || "default", o.user || "admin", o.current !== false);
      return c;
    },
    deploy(name, ns, o = {}) {
      const labels = o.labels || { app: name };
      const c = { name: o.container || name, image: o.image };
      if (o.port) c.ports = [{ containerPort: o.port }];
      if (o.env)
        c.env = Object.entries(o.env).map(([k, v]) =>
          typeof v === "object" ? Object.assign({ name: k }, v) : { name: k, value: String(v) },
        );
      if (o.envFrom) c.envFrom = o.envFrom;
      if (o.resources) c.resources = o.resources;
      if (o.readiness) c.readinessProbe = o.readiness;
      const spec = { containers: [c] };
      if (o.pullSecrets) spec.imagePullSecrets = o.pullSecrets.map((n) => ({ name: n }));
      return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: Object.assign(
          { name, namespace: ns, labels: Object.assign({}, labels) },
          o.annotations ? { annotations: o.annotations } : {},
        ),
        spec: {
          replicas: o.replicas ?? 1,
          selector: { matchLabels: Object.assign({}, o.selector || labels) },
          template: { metadata: { labels: Object.assign({}, labels) }, spec },
        },
      };
    },
    svc(name, ns, o = {}) {
      return {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name, namespace: ns, labels: { app: name } },
        spec: Object.assign({
          type: o.type || "ClusterIP",
          selector: o.selector || { app: name },
          ports: [
            {
              name: o.portName || "http",
              port: o.port || 80,
              targetPort: o.targetPort ?? o.port ?? 80,
              protocol: "TCP",
            },
          ],
        }),
      };
    },
    route(name, ns, o = {}) {
      const r = {
        apiVersion: "route.openshift.io/v1",
        kind: "Route",
        metadata: { name, namespace: ns, labels: { app: name } },
        spec: { to: { kind: "Service", name: o.service || name } },
      };
      if (o.host) r.spec.host = o.host;
      if (o.tls) r.spec.tls = { termination: "edge", insecureEdgeTerminationPolicy: "Redirect" };
      return r;
    },
    yaml(obj) {
      const c = U.clone(obj);
      if (c.metadata) {
        for (const k of ["creationTimestamp", "uid", "resourceVersion", "generation"]) delete c.metadata[k];
      }
      return IG.yaml.stringify(c);
    },
    // Run shell commands during setup (e.g. `docker compose up -d`) on a throwaway shell.
    sh(w, line, cwd) {
      const s = new IG.Shell(w);
      if (cwd) s.frame.cwd = cwd;
      return s.exec(line);
    },
    apply(cluster, ...objs) {
      for (const o of objs) cluster.apply(IG.util.clone(o), o.metadata.namespace || "default");
    },
    files(w, files, host = "bastion") {
      for (const [p, c] of Object.entries(files))
        w.hosts[host].vfs.write(p, typeof c === "string" ? c : c.content || "", {
          mkdirs: true,
          size: typeof c === "string" ? undefined : c.size,
        });
    },
  };

  /* ------------------------------------------------------------ session */
  class Session {
    constructor(mission) {
      this.m = mission;
      const w = (this.world = new IG.World());
      w.bootstrap = true;
      mission.setup(w, IG.build);
      w.reconcile();
      w.bootstrap = false;
      this.shell = new IG.Shell(w);
      if (mission.cwd) this.shell.frame.cwd = mission.cwd;
      this.lines = [];
      this.done = mission.objectives.map(() => false);
      this.doneAt = mission.objectives.map(() => null);
      this.doneLine = mission.objectives.map(() => 0);
      this.hintsShown = mission.objectives.map(() => 0);
      this.hintsUsed = 0;
      this.startedAt = IG.clock.now();
      this.completed = false;
      this.gaveUp = false;
      this.result = null;
    }
    ctx() {
      const self = this;
      return {
        ran: (re) => self.lines.some((l) => re.test(l)),
        ranAfter: (re, after) => self.lines.slice(after).some((l) => re.test(l)),
        ranSince: (objIndex, re) =>
          self.done[objIndex] && self.lines.slice(self.doneLine[objIndex]).some((l) => re.test(l)),
        order: (reA, reB) => {
          const a = self.lines.findIndex((l) => reA.test(l));
          return a >= 0 && self.lines.slice(a + 1).some((l) => reB.test(l));
        },
        http: (pred) => self.world.httpLog.some(pred),
        lastHttp: (pred) => {
          const l = self.world.httpLog.filter(pred);
          return l[l.length - 1];
        },
        file: (path, host = "bastion") => self.world.hosts[host].vfs.read(path),
        cluster: (name) => (name ? self.world.clusters[name] : Object.values(self.world.clusters)[0]),
        lines: self.lines,
      };
    }
    run(line) {
      const res = this.shell.exec(line);
      if (res.incomplete) return { res, newly: [], completed: false };
      // ANSI colour codes are for the terminal view only; checks and tests see plain text
      if (res.out) res.out = res.out.replace(/\x1b\[[\d;]*m(\x1b\[K)?/g, "");
      if (String(line).trim()) this.lines.push(String(line).trim());
      this.world.reconcile();
      const newly = this.evaluate();
      return { res, newly, completed: this.completed && newly.includes("complete") };
    }
    evaluate() {
      const newly = [];
      if (this.completed) return newly;
      const ctx = this.ctx();
      this.m.objectives.forEach((o, i) => {
        if (this.done[i]) return;
        let pass;
        try {
          pass = !!o.check(this.world, ctx);
        } catch (e) {
          pass = false;
        }
        if (pass) {
          this.done[i] = true;
          this.doneAt[i] = IG.clock.now();
          this.doneLine[i] = this.lines.length;
          newly.push(i);
        }
      });
      if (this.m.objectives.length && this.done.every(Boolean)) {
        this.completed = true;
        this.finish();
        newly.push("complete");
      }
      return newly;
    }
    hint(i) {
      const o = this.m.objectives[i];
      const n = this.hintsShown[i];
      if (!o || n >= o.hints.length) return null;
      this.hintsShown[i]++;
      if (!this.completed) this.hintsUsed++;
      return o.hints[n];
    }
    elapsed() {
      return Math.round(((this.result ? this.result.endedAt : IG.clock.now()) - this.startedAt) / 1000);
    }
    finish() {
      const time = Math.round((IG.clock.now() - this.startedAt) / 1000);
      let stars = 3;
      if (this.hintsUsed > 0) stars--;
      if (this.hintsUsed > 2 || time > this.m.par) stars--;
      stars = Math.max(1, stars);
      if (this.gaveUp) stars = 0;
      this.result = {
        stars,
        time,
        hints: this.hintsUsed,
        xp: stars ? Math.round(this.m.xp * (0.5 + stars / 6)) : 0,
        endedAt: IG.clock.now(),
        fast: time <= this.m.par / 2,
      };
      return this.result;
    }
    giveUp() {
      this.gaveUp = true;
    }
    solution() {
      return (this.m.solution || []).map((s) => (typeof s === "function" ? s(this.world) : s));
    }
  }
  IG.Session = Session;

  /* ------------------------------------------------------------ progress */
  const KEY = "corelab.progress.v2";
  class Progress {
    constructor(storage) {
      this.storage = storage;
      this.data = { xp: 0, missions: {}, badges: [], seenIntro: false, created: Date.now() };
      try {
        const raw = storage && storage.getItem(KEY);
        if (raw) Object.assign(this.data, JSON.parse(raw));
      } catch (e) {
        /* storage unavailable */
      }
    }
    save() {
      try {
        this.storage && this.storage.setItem(KEY, JSON.stringify(this.data));
      } catch (e) {
        /* ignore */
      }
    }
    reset() {
      this.data = { xp: 0, missions: {}, badges: [], seenIntro: true, created: Date.now() };
      this.save();
    }
    stars(id) {
      return (this.data.missions[id] || {}).stars || 0;
    }
    cleared(id) {
      return this.stars(id) > 0;
    }
    unlocked(m, all) {
      if (all) return true;
      const list = IG.missionsOf(m.track);
      const i = list.indexOf(m);
      return i <= 0 || this.cleared(list[i - 1].id);
    }
    rank(xp = this.data.xp) {
      let idx = 0;
      IG.ranks.forEach((r, i) => {
        if (xp >= r.xp) idx = i;
      });
      const cur = IG.ranks[idx],
        next = IG.ranks[idx + 1];
      return { idx, cur, next, pct: next ? Math.round(((xp - cur.xp) / (next.xp - cur.xp)) * 100) : 100 };
    }
    record(m, result) {
      const prev = this.data.missions[m.id] || { stars: 0, xp: 0 };
      const before = this.rank();
      const gain = Math.max(0, result.xp - (prev.xp || 0));
      this.data.missions[m.id] = {
        stars: Math.max(prev.stars || 0, result.stars),
        xp: Math.max(prev.xp || 0, result.xp),
        best: Math.min(prev.best || Infinity, result.time),
        plays: (prev.plays || 0) + 1,
        last: Date.now(),
      };
      this.data.xp += gain;
      const newBadges = [];
      const give = (id) => {
        if (!this.data.badges.includes(id)) {
          this.data.badges.push(id);
          newBadges.push(id);
        }
      };
      if (result.stars > 0) give("first");
      if (result.stars === 3 && result.hints === 0) give("flawless");
      if (result.fast && result.stars > 0) give("speed");
      if (IG.missionsOf(m.track).every((x) => this.cleared(x.id))) give(m.track);
      // the free lab has no objectives and is never cleared, so it does not count
      if (IG.missions.every((x) => x.sandbox || this.cleared(x.id))) give("all");
      this.save();
      const after = this.rank();
      return { gain, newBadges, rankUp: after.idx > before.idx ? after.cur : null };
    }
    /* A backup of the progress as a file (書き出す), and reading one back (読み込む), e.g. on another
     * device. Reading merges: the better result of each mission, drill and exam is kept, so nothing
     * already earned here is lost; XP is worked out again from the merged results. */
    export() {
      const doc = { app: "corelab", version: 2, exported: new Date(IG.clock.now()).toISOString(), progress: this.data };
      return JSON.stringify(doc, null, 2) + "\n";
    }
    import(text) {
      let doc;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        return { error: "json" };
      }
      const d = doc && doc.app === "corelab" ? doc.progress : null;
      const isMap = (x) => x == null || (typeof x === "object" && !Array.isArray(x));
      if (!d || typeof d.xp !== "number" || !isMap(d.missions) || !Array.isArray(d.badges || []))
        return { error: "format" };
      if (![d.drills, d.exams].every(isMap)) return { error: "format" };
      const mine = this.data;
      const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
      const merge = (into, from, best) => {
        for (const [k, r] of Object.entries(from || {})) {
          if (!r || typeof r !== "object" || ["__proto__", "constructor", "prototype"].includes(k)) continue;
          const a = into[k] || {};
          into[k] = Object.assign({}, a, {
            plays: Math.max(num(a.plays), num(r.plays)),
            last: Math.max(num(a.last), num(r.last)),
          });
          if (best === "time") {
            into[k].stars = Math.min(3, Math.max(num(a.stars), num(r.stars)));
            into[k].xp = Math.max(num(a.xp), num(r.xp));
            into[k].best = Math.min(num(a.best, Infinity), num(r.best, Infinity));
            if (!Number.isFinite(into[k].best)) delete into[k].best;
          } else {
            into[k].best = Math.max(num(a.best), num(r.best));
            into[k].passed = !!(a.passed || r.passed);
          }
        }
        return into;
      };
      merge(mine.missions, d.missions, "time");
      if (d.drills) mine.drills = merge(mine.drills || {}, d.drills, "score");
      if (d.exams) mine.exams = merge(mine.exams || {}, d.exams, "score");
      const known = new Set(Object.keys(IG.badges));
      for (const b of d.badges || []) if (known.has(b) && !mine.badges.includes(b)) mine.badges.push(b);
      mine.seenIntro = true;
      mine.created = Math.min(num(mine.created, Date.now()), num(d.created, Date.now()));
      mine.xp = Math.max(mine.xp, Progress.xpOf(mine));
      this.save();
      return { cleared: IG.missions.filter((m) => this.cleared(m.id)).length, xp: mine.xp };
    }
    // XP the results are worth: each mission's best, and the first pass of each drill and exam
    static xpOf(data) {
      let xp = 0;
      for (const r of Object.values(data.missions || {})) xp += Number(r.xp) || 0;
      for (const [key, r] of Object.entries(data.drills || {}))
        if (r.passed && IG.drillXp) xp += IG.drillXp(key.split(":")[1].startsWith("#") ? null : key.split(":")[1]);
      for (const r of Object.values(data.exams || {})) if (r.passed && IG.examXp) xp += IG.examXp;
      return xp;
    }
    trackProgress(track) {
      const list = IG.missionsOf(track);
      return { done: list.filter((m) => this.cleared(m.id)).length, total: list.length };
    }
  }
  IG.Progress = Progress;
})((globalThis.IG = globalThis.IG || {}));
