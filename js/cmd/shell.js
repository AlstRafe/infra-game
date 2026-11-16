/* Shell session: login stack (ssh/su/sudo -i), variables, functions, aliases, jobs, history,
 * shell builtins, command dispatch (PATH, packages, scripts, permissions) and Tab completion.
 * Parsing/expansion/execution live in bash.js; Linux commands in coreutils.js / sysutils.js. */
(function (IG) {
  "use strict";
  const VFS = IG.VFS;
  const B = IG.bash;
  IG.commands = IG.commands || {};
  const C = IG.commands;

  const nl = (t) => (t && !t.endsWith("\n") ? t + "\n" : t || "");
  // Normalize any command result to {stdout, stderr, code, ...extras}
  function norm(r) {
    if (r === undefined || r === null) return { stdout: "", stderr: "", code: 0 };
    if (typeof r === "string") return { stdout: nl(r), stderr: "", code: 0 };
    if ("stdout" in r || "stderr" in r) return Object.assign({ stdout: "", stderr: "", code: 0 }, r);
    const text = nl(r.out || "");
    return Object.assign({}, r, r.err ? { stdout: "", stderr: text } : { stdout: text, stderr: "" }, {
      code: r.code || 0,
    });
  }
  IG.shellNorm = norm;

  const POD_CMDS = [
    "curl",
    "wget",
    "env",
    "printenv",
    "hostname",
    "cat",
    "ls",
    "echo",
    "printf",
    "nslookup",
    "dig",
    "whoami",
    "id",
    "ping",
    "head",
    "tail",
    "grep",
    "wc",
    "sleep",
    "date",
    "pwd",
    "true",
    "false",
    "exit",
    "ps",
    "uname",
    "sh",
    "bash",
    "sort",
    "awk",
    "sed",
    "cut",
    "tr",
    "test",
    "[",
    "nc",
    "df",
    "du",
    "find",
    "mkdir",
    "touch",
    "rm",
    "cp",
    "mv",
    "tee",
    "xargs",
    "seq",
    "base64",
    "md5sum",
    "sha256sum",
    "stat",
    "uniq",
    "basename",
    "dirname",
  ];

  class Shell {
    constructor(world, opt = {}) {
      this.world = world;
      const h = world.hosts.bastion;
      this.stack = [{ host: "bastion", user: h.user, cwd: h.home, prev: h.home }];
      this.vars = {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
        SHELL: "/bin/bash",
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
        HISTSIZE: "1000",
        EDITOR: "vi",
        PS1: "\\u@\\h:\\w\\$ ",
      };
      this.exported = new Set(["PATH", "SHELL", "LANG", "TERM", "EDITOR"]);
      this.readonly = new Set();
      this.arrays = {};
      this.funcs = {};
      this.aliases = {
        ls: "ls --color=auto",
        grep: "grep --color=auto",
        ll: "ls -alF",
        la: "ls -A",
        l: "ls -CF",
        k: "kubectl",
      };
      this.history = [];
      this.jobs = [];
      this.opts = {};
      this.posStack = [[]];
      this.localStack = [];
      this.lastCode = 0;
      this.euid = null; // set by sudo during a command
      this.chunks = [];
      this.interp = new B.Interp(this);
      this.started = world.now();
      this.dirStack = [];
      Object.assign(this.vars, opt.env || {});
    }
    /* ---------------- identity & location */
    get frame() {
      return this.stack[this.stack.length - 1];
    }
    get host() {
      return this.world.hosts[this.frame.host];
    }
    get cwd() {
      return this.over ? "/" : this.frame.cwd;
    }
    get user() {
      return this.over ? "root" : this.euid || this.frame.user;
    }
    get root() {
      return this.user === "root";
    }
    set root(v) {
      this.euid = v ? "root" : null;
    }
    home(user = this.user) {
      const u = this.host.users[user];
      return u ? u.home : "/";
    }
    prompt() {
      const f = this.frame,
        h = this.host;
      const home = this.home(f.user);
      const p =
        f.cwd === home ? "~" : f.cwd.startsWith(home + "/") && home !== "/" ? "~" + f.cwd.slice(home.length) : f.cwd;
      if (h.os === "rhel")
        return `[${f.user}@${h.name} ${p === "~" ? "~" : VFS.base(f.cwd)}]${f.user === "root" ? "#" : "$"}`;
      return `${f.user}@${h.name}:${p}${f.user === "root" ? "#" : "$"}`;
    }
    resolve(p) {
      return VFS.norm(p, this.cwd, this.home());
    }
    vfs() {
      return this.over ? this.podFs() : this.host.vfs;
    }
    podFs() {
      if (this.over._fs) return this.over._fs;
      const x = this.over.pod || this.over.container;
      const name = this.over.pod ? this.over.pod.pod : this.over.container.name;
      const ns = this.over.pod ? this.over.pod.ns : null;
      this.over._fs = new VFS({
        files: {
          "/etc/hostname": name + "\n",
          "/etc/resolv.conf": ns
            ? `search ${ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`
            : "nameserver 127.0.0.11\noptions ndots:0\n",
          "/etc/hosts": `127.0.0.1\tlocalhost\n${(x && x.ip) || "172.18.0.3"}\t${name}\n`,
          "/etc/os-release":
            'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
          "/etc/passwd": "root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
        },
        dirs: ["/app", "/tmp", "/var/log", "/usr/bin", "/root"],
      });
      return this.over._fs;
    }
    canRead(p) {
      return this.over ? true : this.host.canRead(this.user, p);
    }
    canWrite(p) {
      return this.over ? p.startsWith("/tmp") || p.startsWith("/app") : this.host.canWriteFile(this.user, p);
    }
    canDelete(p) {
      return this.over ? true : this.host.canDelete(this.user, p);
    }
    writable(p) {
      return this.canWrite(p);
    } // legacy name

    /* ---------------- variables */
    special(name) {
      const f = this.frame;
      switch (name) {
        case "?":
          return String(this.lastCode);
        case "$":
          return String(4242 + this.stack.length);
        case "#":
          return String(this.positional().length);
        case "0":
          return this.scriptName || "bash";
        case "-":
          return "himBHs";
        case "RANDOM":
          return String(Math.floor(Math.random() * 32768));
        case "SECONDS":
          return String(Math.floor((this.world.now() - this.started) / 1000));
        case "PWD":
          return this.cwd;
        case "OLDPWD":
          return f.prev;
        case "HOME":
          return this.vars.HOME !== undefined && this.vars.HOME !== this.home(f.user) && this.homeOverride
            ? this.vars.HOME
            : this.home(this.over ? "root" : f.user);
        case "USER":
        case "LOGNAME":
          return this.over ? "root" : f.user;
        case "HOSTNAME":
          return this.over ? (this.over.pod ? this.over.pod.pod : this.over.container.name) : this.host.name;
        case "UID":
          return String((this.host.users[f.user] || { uid: 0 }).uid);
        case "EUID":
          return String((this.host.users[this.user] || { uid: 0 }).uid);
        case "BASH_VERSION":
          return "5.1.16(1)-release";
        case "SHLVL":
          return String(this.stack.length);
        case "PPID":
          return "4211";
        case "BASHPID":
          return String(4242 + this.stack.length);
        case "LINENO":
          return "1";
      }
      if (/^\d+$/.test(name)) return this.positional()[Number(name) - 1];
      if (this.over && this.over.pod && name in this.over.pod.env) return this.over.pod.env[name];
      if (this.over && this.over.container && name in this.over.container.env) return this.over.container.env[name];
      if (name in this.arrays) return this.arrays[name][0];
      return this.vars[name];
    }
    getVar(n) {
      return this.special(n);
    }
    setVar(n, v) {
      if (this.readonly.has(n)) throw new Error(`${n}: readonly variable`);
      if (n === "HOME") this.homeOverride = true;
      delete this.arrays[n];
      this.vars[n] = String(v);
    }
    arrayGet(n) {
      return this.arrays[n] || (this.vars[n] !== undefined ? [this.vars[n]] : []);
    }
    arraySet(n, vals) {
      this.arrays[n] = vals.slice();
      delete this.vars[n];
    }
    positional() {
      return this.posStack[this.posStack.length - 1];
    }
    envObj() {
      const e = {};
      for (const k of this.exported) {
        const v = this.special(k);
        if (v !== undefined) e[k] = v;
      }
      for (const k of ["HOME", "USER", "LOGNAME", "PWD", "HOSTNAME", "SHLVL", "OLDPWD"]) {
        const v = this.special(k);
        if (v !== undefined) e[k] = v;
      }
      e.SSH_CONNECTION = "198.51.100.20 51522 " + this.host.ip + " 22";
      return e;
    }

    /* ---------------- output */
    sinkWrite(sink, text) {
      if (!text) return;
      if (!sink || sink.term) {
        this.chunks.push({ text, stream: sink && sink.term === "err" ? "err" : "out" });
        return;
      }
      if (sink.null) return;
      if (sink.buf) {
        sink.buf.text += text;
        if (sink.buf.text.length > 2e6) throw new B.Flow("abort", 0, 1);
        return;
      }
      if (sink.file) {
        const fs = sink.fs;
        const n = fs.node(sink.file);
        if (n && !n.dev) {
          n.content += text;
          n.size = undefined;
          n.mtime = this.world.now();
        }
      }
    }
    writeTo(io, fd, text) {
      this.sinkWrite((io && io.fd && io.fd[fd]) || { term: fd === 2 ? "err" : "out" }, text);
    }
    writeErr(text) {
      this.chunks.push({ text, stream: "err" });
    }
    openFile(target, append) {
      if (target === "/dev/null") return { null: true };
      if (target === "/dev/stdout" || target === "/dev/tty") return { term: "out" };
      if (target === "/dev/stderr") return { term: "err" };
      const p = this.resolve(target);
      const fs = this.vfs();
      if (fs.isDir(p)) return { error: `bash: ${target}: Is a directory\n` };
      const real = fs.real(p) || p;
      if (!fs.isDir(VFS.parent(real))) return { error: `bash: ${target}: No such file or directory\n` };
      const attrs = (fs.lnode(real) || {}).attrs || "";
      if (/i/.test(attrs) || (/a/.test(attrs) && !append))
        return { error: `bash: ${target}: Operation not permitted\n` }; // chattr +i / +a
      if (!this.canWrite(real)) return { error: `bash: ${target}: Permission denied\n` };
      if (!fs.exists(real) || !append)
        fs.write(
          real,
          "",
          fs.exists(real)
            ? {}
            : { owner: this.user, group: this.over ? "root" : this.host.primaryGroup(this.user), mode: 0o664 & ~0o002 },
        );
      return { file: real, fs };
    }

    /* ---------------- top level */
    // Run a full command line. Returns {out, code, err, chunks, clear?, editor?, incomplete?}
    exec(line, over = null) {
      const raw = String(line);
      if (!raw.trim()) return { out: "", code: 0, chunks: [] };
      const prevOver = this.over,
        prevChunks = this.chunks;
      this.over = over;
      this.chunks = [];
      this.pendingClear = false;
      this.pendingEditor = null;
      let src = raw;
      if (!over) {
        // job completion notices from earlier background jobs
        for (const j of this.jobs.filter((x) => x.done && !x.reported)) {
          j.reported = true;
          this.chunks.push({ text: `[${j.n}]+  Done                    ${j.cmd}\n`, stream: "out" });
        }
        this.jobs = this.jobs.filter((j) => !j.reported);
        const h = this.histExpand(raw);
        if (h.error) {
          this.chunks.push({ text: h.error + "\n", stream: "err" });
          return this.finish(prevOver, prevChunks, 1);
        }
        if (h.changed) this.chunks.push({ text: h.line + "\n", stream: "out" });
        src = h.line;
      }
      let ast;
      try {
        ast = B.parse(src);
      } catch (e) {
        if (e instanceof B.Incomplete) {
          this.over = prevOver;
          this.chunks = prevChunks;
          return { incomplete: true, out: "", code: 0, chunks: [] };
        }
        if (!over) this.pushHistory(src);
        this.chunks.push({ text: `bash: ${e.message}\n`, stream: "err" });
        return this.finish(prevOver, prevChunks, 2);
      }
      if (!over) this.pushHistory(src);
      let code;
      this.interp.steps = 0;
      try {
        code = this.interp.run(ast, { stdin: B.mkIn("", true), fd: { 1: { term: "out" }, 2: { term: "err" } } });
      } catch (e) {
        if (e instanceof B.Flow) {
          if (e.kind === "exit") {
            code = e.code;
            this.logoutFrame();
          } else if (e.kind === "abort") {
            this.chunks.push({
              text: IG.t("ℹ 実行ステップ数か出力量の上限に達したため中断しました（無限ループの可能性）。\n"),
              stream: "err",
            });
            code = 130;
          } else if (e.kind === "return") code = e.code;
          else code = 0;
        } else {
          this.chunks.push({ text: `bash: ${e.message}\n`, stream: "err" });
          if (typeof console !== "undefined" && !(e instanceof B.BashSyntax)) console.error(e);
          code = 1;
        }
      }
      this.lastCode = code;
      this.euid = null;
      return this.finish(prevOver, prevChunks, code);
    }
    finish(prevOver, prevChunks, code) {
      const chunks = this.chunks;
      this.over = prevOver;
      this.chunks = prevChunks;
      const text = chunks.map((c) => c.text).join("");
      const res = {
        out: text.replace(/\n$/, ""),
        code,
        err: chunks.length > 0 && chunks.every((c) => c.stream === "err"),
        chunks,
      };
      if (this.pendingClear) res.clear = true;
      if (this.pendingEditor) res.editor = this.pendingEditor;
      this.pendingClear = false;
      this.pendingEditor = null;
      return res;
    }
    pushHistory(line) {
      const l = line.trim();
      if (!l || l.startsWith(" ")) return;
      if (this.history[this.history.length - 1] !== l) this.history.push(l);
    }
    histExpand(line) {
      if (!line.includes("!")) return { line, changed: false };
      let changed = false,
        err = null,
        q = null;
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && q !== '"') q = q === "'" ? null : "'";
        else if (c === '"' && q !== "'") q = q === '"' ? null : '"';
        if (
          c !== "!" ||
          q === "'" ||
          i + 1 >= line.length ||
          /[\s=(]/.test(line[i + 1]) ||
          line[i - 1] === "\\" ||
          line[i - 1] === "["
        ) {
          out += c;
          continue;
        }
        const rest = line.slice(i + 1);
        let m, rep, len;
        const H = this.history;
        if (rest[0] === "!") {
          rep = H[H.length - 1];
          len = 1;
        } else if (rest[0] === "$") {
          const last = H[H.length - 1] || "";
          rep = last.trim().split(/\s+/).pop();
          len = 1;
        } else if ((m = rest.match(/^-?\d+/))) {
          const n = Number(m[0]);
          rep = n < 0 ? H[H.length + n] : H[n - 1];
          len = m[0].length;
        } else if ((m = rest.match(/^[A-Za-z_][\w./-]*/))) {
          rep = [...H].reverse().find((h) => h.startsWith(m[0]));
          len = m[0].length;
        } else {
          out += c;
          continue;
        }
        if (rep === undefined || rep === null) {
          err = `bash: !${rest.slice(0, len)}: event not found`;
          break;
        }
        out += rep;
        i += len;
        changed = true;
      }
      return err ? { error: err } : { line: out, changed };
    }
    logoutFrame() {
      if (this.stack.length > 1) {
        const f = this.stack.pop();
        const back = this.frame;
        this.chunks.push({
          text: f.host !== back.host ? `logout\nConnection to ${f.host} closed.\n` : "logout\n",
          stream: "out",
        });
      } else this.chunks.push({ text: IG.t("ℹ 踏み台（bastion）からはログアウトできません。\n"), stream: "err" });
    }
    // child=true models a new process (bash script / bash -c): only exported variables survive,
    // functions and aliases are not inherited. child=false is a ( ) / $( ) subshell.
    subshell(child = false) {
      const s = Object.create(Shell.prototype);
      Object.assign(s, this);
      s.stack = this.stack.map((f) => Object.assign({}, f));
      s.vars = child
        ? Object.fromEntries([...this.exported].filter((k) => k in this.vars).map((k) => [k, this.vars[k]]))
        : Object.assign({}, this.vars);
      s.exported = new Set(this.exported);
      s.arrays = child ? {} : Object.assign({}, this.arrays);
      s.funcs = child ? {} : Object.assign({}, this.funcs);
      s.aliases = child ? {} : Object.assign({}, this.aliases);
      s.opts = child ? {} : Object.assign({}, this.opts);
      s.posStack = [this.positional().slice()];
      s.localStack = [];
      s.parentShell = this;
      s.interp = new B.Interp(s);
      s.interp.steps = this.interp.steps;
      Object.defineProperty(s, "chunks", {
        get: () => this.chunks,
        set: (v) => {
          this.chunks = v;
        },
        configurable: true,
      });
      return s;
    }
    addJob(node) {
      const n = (this.jobs.length ? Math.max(...this.jobs.map((j) => j.n)) : 0) + 1;
      const job = {
        n,
        pid: 5000 + Math.floor(Math.random() * 4000),
        cmd: this.history[this.history.length - 1]
          ? this.history[this.history.length - 1].replace(/\s*&\s*$/, "")
          : "job",
        done: false,
        node,
      };
      this.jobs.push(job);
      return job;
    }

    /* ---------------- legacy single-command API (used by kubectl exec, docker exec, tests) */
    runArgv(argv, over = null, stdin = "") {
      const prevOver = this.over,
        prevChunks = this.chunks;
      if (over) this.over = over;
      this.chunks = [];
      const b1 = { text: "" },
        b2 = { text: "" };
      let code;
      try {
        code = this.invoke(argv, { stdin: B.mkIn(stdin), fd: { 1: { buf: b1 }, 2: { buf: b2 } } });
      } catch (e) {
        if (e instanceof B.Flow) code = e.code;
        else {
          b2.text += `${argv[0]}: ${e.message}\n`;
          code = 1;
        }
      }
      const extra = this.chunks.map((c) => c.text).join("");
      this.over = prevOver;
      this.chunks = prevChunks;
      const out = (b1.text + b2.text + extra).replace(/\n$/, "");
      return { out, code, err: !b1.text && !!(b2.text || extra) };
    }

    /* ---------------- dispatch */
    invoke(argv, io) {
      let [name, ...args] = argv;
      if (name === undefined) return 0;
      if (this.over) {
        const base = name.split("/").pop();
        if (!POD_CMDS.includes(base) && !BUILTINS[base] && !this.funcs[base]) {
          this.writeTo(
            io,
            2,
            `OCI runtime exec failed: exec failed: unable to start container process: exec: "${name}": executable file not found in $PATH: unknown\ncommand terminated with exit code 126\n`,
          );
          return 126;
        }
        name = base;
      }
      if (this.funcs[name] && !name.includes("/")) return this.callFunc(name, args, io);
      if (BUILTINS[name]) return BUILTINS[name](args, io, this);
      // explicit path → script or /usr/bin/<cmd>
      if (name.includes("/")) return this.execPath(name, args, io);
      // PATH lookup for user scripts (e.g. ~/bin, /usr/local/bin)
      const found = this.which(name);
      if (found && !found.registered) return this.execPath(found.path, args, io, name);
      const fn = C[name];
      if (!fn || (!this.host.hasCommand(name) && !this.over)) return this.notFound(name, io);
      return this.runCommand(name, fn, args, io);
    }
    runCommand(name, fn, args, io) {
      const self = this;
      const stdin = io.stdin;
      const ctx = {
        world: this.world,
        shell: this,
        host: this.host,
        vfs: this.vfs(),
        cwd: this.cwd,
        io,
        name,
        get stdin() {
          return B.readAll(stdin);
        },
        hasStdin: !!(stdin && !stdin.tty && stdin.data.length > stdin.pos),
        env: this.over ? (this.over.pod ? this.over.pod.env : this.over.container.env) : this.envObj(),
        resolve: (p) => this.resolve(p),
        pod: this.over && this.over.pod,
        container: this.over && this.over.container,
        root: this.root,
        user: this.user,
        from: this.from(),
        euid: this.user,
        editor: (req) => {
          self.pendingEditor = req;
        },
        clear: () => {
          self.pendingClear = true;
        },
        out: (t) => this.writeTo(io, 1, t),
        err: (t) => this.writeTo(io, 2, t),
      };
      let r;
      const selfHelp = ["kubectl", "k", "oc", "docker", "docker-compose", "aws", "harbor", "bash", "sh"];
      if (args.includes("--help") && !selfHelp.includes(name) && IG.manpages) {
        const help = IG.manpages.help(name);
        this.writeTo(
          io,
          1,
          (help ||
            IG.t(`Usage: {0} [OPTION]... [ARG]...\nℹ このシミュレータには {1} の詳しいヘルプを収録していません。`, {
              0: name,
              1: name,
            })) + "\n",
        );
        return 0;
      }
      if (
        args.includes("--version") &&
        [
          "ls",
          "cat",
          "cp",
          "mv",
          "rm",
          "grep",
          "sed",
          "awk",
          "sort",
          "tar",
          "curl",
          "ssh",
          "systemctl",
          "find",
          "gzip",
          "date",
        ].includes(name)
      ) {
        const v =
          {
            grep: "grep (GNU grep) 3.7",
            sed: "sed (GNU sed) 4.8",
            awk: "GNU Awk 5.1.0, API: 3.0",
            tar: "tar (GNU tar) 1.34",
            curl: "curl 7.81.0 (x86_64-pc-linux-gnu) libcurl/7.81.0 OpenSSL/3.0.2",
            ssh: "OpenSSH_8.9p1 Ubuntu-3ubuntu0.10, OpenSSL 3.0.2 15 Mar 2022",
            systemctl: "systemd 249 (249.11-0ubuntu3.12)",
            find: "find (GNU findutils) 4.8.0",
            gzip: "gzip 1.10",
          }[name] || `${name} (GNU coreutils) 8.32`;
        this.writeTo(io, name === "ssh" ? 2 : 1, v + "\n");
        return 0;
      }
      try {
        r = fn(args, ctx);
      } catch (e) {
        if (e instanceof B.Flow) throw e;
        if (typeof console !== "undefined") console.error(e);
        r = { stdout: "", stderr: `${name}: internal simulator error: ${e.message}\n`, code: 1 };
      }
      const n = norm(r);
      // files with chattr +i / +a fail with EPERM ("Operation not permitted"), not EACCES
      if (n.stderr && n.stderr.includes("Permission denied") && !this.over)
        n.stderr = n.stderr.replace(/'?([^\s':]+)'?: Permission denied/g, (m, p) =>
          /[ia]/.test((this.vfs().lnode(this.resolve(p)) || {}).attrs || "")
            ? m.replace("Permission denied", "Operation not permitted")
            : m,
        );
      if (n.stdout) this.writeTo(io, 1, n.stdout);
      if (n.stderr) this.writeTo(io, 2, n.stderr);
      if (n.editor) this.pendingEditor = n.editor;
      if (n.clear) this.pendingClear = true;
      return n.code;
    }
    from() {
      if (this.over && this.over.pod)
        return { kind: "pod", cluster: this.over.pod.cluster, ns: this.over.pod.ns, pod: this.over.pod.pod };
      if (this.over && this.over.container) return { kind: "container", container: this.over.container.name };
      return { kind: "host", host: this.host.name };
    }
    notFound(name, io) {
      const pkg = IG.linux.CMD_PKG[name];
      const h = this.host;
      if (h.os === "rhel") {
        this.writeTo(io, 2, `bash: ${name}: command not found\n`);
        return 127;
      }
      if (pkg) {
        const snap = {
          kubectl: "sudo snap install kubectl",
          aws: "sudo snap install aws-cli",
          tree: "sudo snap install tree",
        }[name];
        this.writeTo(
          io,
          2,
          `Command '${name}' not found, but can be installed with:\n${snap ? snap + "  # version 1.31.0, or\n" : ""}sudo apt install ${pkg}\n`,
        );
        return 127;
      }
      const all = Object.keys(Object.assign({}, BUILTINS, C)).filter((c) => h.hasCommand(c));
      const near = all.filter((c) => c.length > 1 && lev(c, name) === 1).slice(0, 3);
      if (near.length)
        this.writeTo(
          io,
          2,
          `Command '${name}' not found, did you mean:\n${near.map((c) => `  command '${c}' from deb ${IG.linux.CMD_PKG[c] || "coreutils"}`).join("\n")}\nTry: sudo apt install <deb name>\n`,
        );
      else this.writeTo(io, 2, `${name}: command not found\n`);
      return 127;
    }
    which(name) {
      const fs = this.vfs();
      for (const dir of (this.special("PATH") || "").split(":")) {
        if (!dir) continue;
        const p = dir.replace(/\/$/, "") + "/" + name;
        const n = fs.node(p);
        if (n && n.type === "f" && n.mode & 0o111) return { path: p, registered: !!C[name] && n.content === "\x7fELF" };
      }
      return null;
    }
    execPath(path, args, io, asName) {
      const fs = this.vfs();
      const p = this.resolve(path);
      const n = fs.node(p);
      const shown = asName || path;
      if (!n) {
        this.writeTo(io, 2, `bash: ${shown}: No such file or directory\n`);
        return 127;
      }
      if (n.type === "d") {
        this.writeTo(io, 2, `bash: ${shown}: Is a directory\n`);
        return 126;
      }
      if (!this.over && !this.host.allowed(this.user, n, "x")) {
        this.writeTo(io, 2, `bash: ${shown}: Permission denied\n`);
        return 126;
      }
      if (n.content === "\x7fELF") {
        const base = VFS.base(p);
        const fn = C[base] || (BUILTINS[base] && ((a, ctx) => ({ code: BUILTINS[base](a, ctx.io, this) })));
        if (fn) return C[base] ? this.runCommand(base, fn, args, io) : BUILTINS[base](args, io, this);
        this.writeTo(io, 2, `bash: ${shown}: cannot execute binary file: Exec format error\n`);
        return 126;
      }
      if (!this.over && !this.host.allowed(this.user, n, "r")) {
        this.writeTo(io, 2, `/bin/bash: ${shown}: Permission denied\n`);
        return 126;
      }
      return this.runScript(n.content, [shown, ...args], io);
    }
    runScript(text, argv, io, opt = {}) {
      const first = text.split("\n")[0] || "";
      if (/^#!/.test(first) && !/\b(ba)?sh\b/.test(first)) {
        const interp = first
          .replace(/^#!\s*/, "")
          .replace(/^\/usr\/bin\/env\s+/, "")
          .split(/\s+/)[0];
        this.writeTo(
          io,
          2,
          IG.t(`ℹ {0} スクリプトの実行はこのシミュレータでは未対応です（bash / sh スクリプトのみ実行できます）。\n`, {
            0: VFS.base(interp),
          }),
        );
        return 126;
      }
      let ast;
      try {
        ast = B.parse(text);
      } catch (e) {
        const msg = e instanceof B.Incomplete ? "syntax error: unexpected end of file" : e.message;
        this.writeTo(io, 2, `${argv[0]}: line ${text.split("\n").length}: ${msg}\n`);
        return 2;
      }
      if (opt.noexec) return 0;
      const sub = opt.source ? this : this.subshell(true);
      const prevName = sub.scriptName;
      sub.scriptName = argv[0];
      sub.posStack.push(argv.slice(1));
      if (opt.xtrace) sub.opts.xtrace = true;
      try {
        return sub.interp.run(ast, io);
      } catch (e) {
        if (e instanceof B.Flow && (e.kind === "exit" || e.kind === "return")) return e.code;
        throw e;
      } finally {
        sub.posStack.pop();
        sub.scriptName = prevName;
        if (!opt.source) this.lastCode = sub.lastCode;
      }
    }
    callFunc(name, args, io) {
      this.posStack.push(args);
      this.localStack.push({});
      try {
        return this.interp.exec(this.funcs[name], io);
      } catch (e) {
        if (e instanceof B.Flow && e.kind === "return") return e.code;
        throw e;
      } finally {
        this.posStack.pop();
        const locals = this.localStack.pop();
        for (const [k, v] of Object.entries(locals)) {
          if (v === undefined) delete this.vars[k];
          else this.vars[k] = v;
        }
      }
    }

    /* ---------------- tests ([ ], [[ ]]) */
    unaryTest(op, a) {
      const fs = this.vfs();
      const p = this.resolve(a);
      const n = fs.node(p);
      switch (op) {
        case "-e":
        case "-a":
          return !!n;
        case "-f":
          return !!n && n.type === "f";
        case "-d":
          return !!n && n.type === "d";
        case "-L":
        case "-h":
          return fs.isLink(p);
        case "-s":
          return !!n && fs.fileSize(n) > 0;
        case "-r":
          return !!n && this.canRead(p);
        case "-w":
          return !!n && (this.over || this.host.allowed(this.user, n, "w"));
        case "-x":
          return !!n && (this.over || this.host.allowed(this.user, n, "x"));
        case "-z":
          return a === "";
        case "-n":
          return a !== "";
        case "-b":
        case "-c":
          return !!n && !!n.dev && op === "-c";
        case "-p":
        case "-S":
          return false;
        case "-t":
          return a === "0" || a === "1";
        case "-O":
          return !!n && n.owner === this.user;
        case "-G":
          return !!n && this.host.inGroup(this.user, n.group);
        case "-v":
          return this.special(a) !== undefined;
        case "-k":
          return !!n && !!(n.mode & 0o1000);
        case "-u":
          return !!n && !!(n.mode & 0o4000);
        case "-g":
          return !!n && !!(n.mode & 0o2000);
      }
      throw new Error(`${op}: unary operator expected`);
    }
    binaryTest(op, a, b) {
      const num = (x) => {
        if (!/^\s*-?\d+\s*$/.test(x)) throw new Error(`${x}: integer expression expected`);
        return Number(x);
      };
      switch (op) {
        case "=":
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case "<":
          return a < b;
        case ">":
          return a > b;
        case "-eq":
          return num(a) === num(b);
        case "-ne":
          return num(a) !== num(b);
        case "-lt":
          return num(a) < num(b);
        case "-le":
          return num(a) <= num(b);
        case "-gt":
          return num(a) > num(b);
        case "-ge":
          return num(a) >= num(b);
        case "-nt":
        case "-ot": {
          const fs = this.vfs();
          const x = fs.node(this.resolve(a)),
            y = fs.node(this.resolve(b));
          if (!x || !y) return op === "-nt" ? !!x : !!y;
          return op === "-nt" ? x.mtime > y.mtime : x.mtime < y.mtime;
        }
        case "-ef":
          return this.vfs().real(this.resolve(a)) === this.vfs().real(this.resolve(b));
      }
      throw new Error(`${op}: binary operator expected`);
    }
    // POSIX test / [ evaluation
    test(args) {
      let i = 0;
      const self = this;
      function orE() {
        let v = andE();
        while (args[i] === "-o") {
          i++;
          v = andE() || v;
        }
        return v;
      }
      function andE() {
        let v = notE();
        while (args[i] === "-a") {
          i++;
          v = notE() && v;
        }
        return v;
      }
      function notE() {
        if (args[i] === "!") {
          i++;
          return !notE();
        }
        return prim();
      }
      function prim() {
        if (args[i] === "(") {
          i++;
          const v = orE();
          if (args[i] !== ")") throw new Error("`)' expected");
          i++;
          return v;
        }
        const a = args[i];
        if (a === undefined) return false;
        if (
          /^-[a-zA-Z]$/.test(a) &&
          i + 1 < args.length &&
          !["=", "!=", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef", "<", ">", "=="].includes(
            args[i + 1],
          )
        ) {
          i += 2;
          return self.unaryTest(a, args[i - 1]);
        }
        if (
          i + 2 <= args.length - 1 &&
          ["=", "==", "!=", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef", "<", ">"].includes(
            args[i + 1],
          )
        ) {
          i += 3;
          return self.binaryTest(args[i - 2], a, args[i - 1]);
        }
        i++;
        return a !== "";
      }
      const v = orE();
      if (i < args.length) throw new Error(`${args[i]}: unexpected operator`);
      return v;
    }

    /* ---------------- completion */
    complete(line) {
      const endsSpace = /\s$/.test(line);
      const parts = line.trim() ? line.trim().split(/\s+/) : [];
      const cur = endsSpace ? "" : parts.pop() || "";
      let prev = parts;
      // complete after a pipe / && / ;
      const sep = prev
        .map((p, k) => (/^(\||&&|\|\||;|sudo)$/.test(p) ? k : -1))
        .filter((k) => k >= 0)
        .pop();
      if (sep !== undefined) prev = prev.slice(sep + 1);
      let cands;
      const w = this.world;
      const cl = w.currentCluster();
      const ctxNs = () => {
        const i = prev.findIndex((p) => p === "-n" || p === "--namespace");
        return i >= 0 ? prev[i + 1] : (w.context() || {}).namespace || "default";
      };
      const resourceNames = (type, ns) => {
        if (!cl) return [];
        const T = {
          po: "pods",
          pod: "pods",
          pods: "pods",
          deploy: "deployments",
          deployment: "deployments",
          deployments: "deployments",
          svc: "services",
          service: "services",
          services: "services",
          cm: "configmaps",
          configmap: "configmaps",
          configmaps: "configmaps",
          secret: "secrets",
          secrets: "secrets",
          ns: "namespaces",
          namespace: "namespaces",
          namespaces: "namespaces",
          no: "nodes",
          node: "nodes",
          nodes: "nodes",
          route: "routes",
          routes: "routes",
          ep: "services",
          endpoints: "services",
        }[type];
        if (T === "pods") return cl.pods.filter((p) => p.ns === ns).map((p) => p.name);
        if (T === "nodes") return cl.nodes.map((n) => n.name);
        const K = {
          deployments: "Deployment",
          services: "Service",
          configmaps: "ConfigMap",
          secrets: "Secret",
          namespaces: "Namespace",
          routes: "Route",
        }[T];
        return K ? cl.list(K, K === "Namespace" ? null : ns).map((o) => o.metadata.name) : [];
      };
      if (!prev.length) {
        if (cur.includes("/")) cands = this.pathCands(cur, true);
        else
          cands = Object.keys(BUILTINS)
            .concat(
              Object.keys(C).filter((c) => this.host.hasCommand(c) && !c.includes("_")),
              Object.keys(this.aliases),
              Object.keys(this.funcs),
            )
            .filter((c) => !/^(k|\[)$/.test(c) || c === "k");
      } else {
        const cmd = prev[0];
        const pos = prev
          .slice(1)
          .filter(
            (p, i, arr) =>
              !p.startsWith("-") && !["-n", "--namespace", "-o", "-f", "-l", "-c", "-u"].includes(arr[i - 1]),
          );
        if ((cmd === "kubectl" || cmd === "k" || cmd === "oc") && !cur.startsWith("-")) {
          const verbs = cmd === "oc" ? IG.ocVerbs : IG.kubectlVerbs;
          if (prev[prev.length - 1] === "-n" || prev[prev.length - 1] === "--namespace")
            cands = cl ? cl.list("Namespace").map((n) => n.metadata.name) : [];
          else if (prev[prev.length - 1] === "-f") cands = null;
          else if (!pos.length) cands = verbs;
          else if (pos[0] === "rollout" && pos.length === 1) cands = ["status", "history", "undo", "restart"];
          else if (pos[0] === "config" && pos.length === 1)
            cands = ["current-context", "get-contexts", "use-context", "set-context", "view"];
          else if (pos[0] === "create" && pos.length === 1)
            cands = ["deployment", "configmap", "secret", "namespace", "service"];
          else if (pos[0] === "set" && pos.length === 1) cands = ["image", "env"];
          else if (["logs", "exec"].includes(pos[0]) && pos.length === 1)
            cands = resourceNames("pods", ctxNs()).concat(resourceNames("deploy", ctxNs()).map((n) => "deploy/" + n));
          else if (["cordon", "uncordon", "drain"].includes(pos[0])) cands = resourceNames("nodes");
          else if (
            ["get", "describe", "delete", "edit", "scale", "label", "patch", "expose", "rollout", "top"].includes(
              pos[0],
            )
          ) {
            const rest = pos[0] === "rollout" ? pos.slice(2) : pos.slice(1);
            if (cur.includes("/")) {
              const [t] = cur.split("/");
              cands = resourceNames(t, ctxNs()).map((n) => t + "/" + n);
            } else if (!rest.length)
              cands =
                pos[0] === "top"
                  ? ["nodes", "pods"]
                  : pos[0] === "scale" || pos[0] === "rollout"
                    ? ["deployment", "deploy/"]
                    : [
                        "pods",
                        "deployments",
                        "services",
                        "endpoints",
                        "configmaps",
                        "secrets",
                        "nodes",
                        "namespaces",
                        "events",
                        "replicasets",
                        "all",
                      ].concat(cl && cl.openshift ? ["routes"] : []);
            else cands = resourceNames(rest[0], ctxNs());
          } else cands = null;
        } else if (cmd === "docker" && !cur.startsWith("-")) {
          if (!pos.length) cands = IG.dockerVerbs;
          else if (pos[0] === "compose" && pos.length === 1) cands = ["up", "down", "ps", "logs", "restart", "config"];
          else if (["logs", "start", "stop", "restart", "rm", "exec", "inspect"].includes(pos[0]))
            cands = w.docker ? w.docker.containers.map((c) => c.name) : [];
          else if (["push", "tag", "rmi", "run"].includes(pos[0]))
            cands = w.docker ? w.docker.images.map((i) => i.ref) : [];
          else cands = null;
        } else if (cmd === "aws" && !cur.startsWith("-")) {
          const ops = {
            ec2: [
              "describe-instances",
              "describe-security-groups",
              "authorize-security-group-ingress",
              "revoke-security-group-ingress",
              "start-instances",
              "stop-instances",
            ],
            s3: ["ls", "cp", "mb"],
            s3api: [
              "get-public-access-block",
              "put-public-access-block",
              "get-bucket-policy",
              "get-bucket-policy-status",
              "delete-bucket-policy",
              "list-buckets",
            ],
            eks: ["list-clusters", "describe-cluster", "update-kubeconfig"],
            sts: ["get-caller-identity"],
            configure: ["list", "get", "set"],
          };
          cands = !pos.length ? Object.keys(ops) : pos.length === 1 ? ops[pos[0]] || [] : null;
        } else if (cmd === "harbor") {
          const sub = {
            project: ["list", "create", "view"],
            repo: ["list"],
            artifact: ["list", "scan", "vulnerabilities"],
            robot: ["create", "list"],
          };
          cands = !pos.length
            ? ["login", "project", "repo", "artifact", "robot"]
            : pos.length === 1
              ? sub[pos[0]] || []
              : null;
        } else if (cmd === "systemctl" || cmd === "service") {
          const acts = [
            "status",
            "start",
            "stop",
            "restart",
            "reload",
            "enable",
            "disable",
            "is-active",
            "is-enabled",
            "list-units",
            "list-unit-files",
            "daemon-reload",
            "cat",
            "show",
            "mask",
            "unmask",
          ];
          cands =
            cmd === "service"
              ? pos.length
                ? ["status", "start", "stop", "restart", "reload"]
                : Object.keys(this.host.services)
              : !pos.length
                ? acts
                : Object.keys(this.host.services).map((s) => s + (cur.endsWith(".") ? ".service" : ""));
        } else if (cmd === "journalctl" && prev[prev.length - 1] === "-u") cands = Object.keys(this.host.services);
        else if (cmd === "apt" || cmd === "apt-get")
          cands = !pos.length
            ? ["update", "upgrade", "install", "remove", "purge", "list", "search", "show", "autoremove"]
            : ["install", "show"].includes(pos[0])
              ? Object.keys(IG.linux.PKG)
              : pos[0] === "remove" || pos[0] === "purge"
                ? [...this.host.pkgs]
                : null;
        else if (cmd === "ssh" || cmd === "scp")
          cands = cur.includes(":")
            ? null
            : Object.values(w.hosts)
                .filter((h) => h.sshable && h.name !== this.host.name)
                .map((h) => h.name + (cmd === "scp" ? ":" : ""));
        else if (["su", "id", "groups", "usermod", "userdel", "passwd", "chage"].includes(cmd))
          cands = Object.keys(this.host.users).filter((u) => this.host.users[u].uid >= 1000 || u === "root");
        else if (["kill", "pkill", "killall"].includes(cmd))
          cands =
            cmd === "kill"
              ? null
              : [...new Set(this.host.processes().map((p) => p.cmd.split(/[\s:]/)[0].split("/").pop()))];
        else if (["man", "which", "type", "help", "whatis", "whereis", "info"].includes(cmd))
          cands = Object.keys(BUILTINS).concat(Object.keys(C));
        else if (cmd === "cd" || cmd === "pushd" || cmd === "rmdir")
          cands = this.pathCands(cur).filter((c) => c.endsWith("/"));
        else cands = null;
      }
      if (cands === null || (cands && cands.length === 0 && prev.length)) cands = this.pathCands(cur);
      let opts = [...new Set(cands)].filter((c) => c.startsWith(cur)).sort();
      if (!opts.length && cur.startsWith("$"))
        opts = Object.keys(this.vars)
          .concat(["HOME", "USER", "PWD", "HOSTNAME"])
          .map((v) => "$" + v)
          .filter((v) => v.startsWith(cur));
      if (!opts.length) return { line, options: [] };
      const prefix = opts.reduce((p, c) => {
        while (!c.startsWith(p)) p = p.slice(0, -1);
        return p;
      }, opts[0]);
      const base = line.slice(0, line.length - cur.length);
      if (opts.length === 1)
        return { line: base + opts[0] + (opts[0].endsWith("/") || opts[0].endsWith(":") ? "" : " "), options: [] };
      return {
        line: base + prefix,
        options: opts.map((o) =>
          o.includes("/") && !o.endsWith("/")
            ? o.slice(o.lastIndexOf("/", o.length - 2) + 1)
            : o.endsWith("/") && o.slice(0, -1).includes("/")
              ? o.slice(o.slice(0, -1).lastIndexOf("/") + 1)
              : o,
        ),
      };
    }
    pathCands(cur, execOnly) {
      const fs = this.vfs();
      const dirPart = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/") + 1) : "";
      const dir = this.resolve(dirPart || ".");
      if (!fs.isDir(dir)) return [];
      const base = cur.slice(dirPart.length);
      return fs
        .children(dir)
        .filter(
          (c) =>
            (!c.name.startsWith(".") || base.startsWith(".")) &&
            (!execOnly || c.dir || fs.isDir(c.path) || c.node.mode & 0o111),
        )
        .map((c) => dirPart + c.name + (c.dir || (c.link && fs.isDir(c.path)) ? "/" : ""));
    }
  }

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  /* ================================================================ printf / echo escapes */
  const ESCAPE = /\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|[abefnrtv\\c'"])/g;
  // backslash escapes of echo -e, printf's format and %b. \c: nothing after it is printed (stop: no more output)
  function escapes(s, forEcho) {
    const cut = [...s.matchAll(ESCAPE)].find((m) => m[1] === "c");
    const out = (cut ? s.slice(0, cut.index) : s).replace(ESCAPE, (m, e) => {
      if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
      if (e[0] === "u") return String.fromCharCode(parseInt(e.slice(1), 16));
      if (/^[0-7]/.test(e))
        return forEcho && e[0] !== "0" ? m : String.fromCharCode(parseInt(e.replace(/^0/, "") || "0", 8));
      return {
        "a": "\x07",
        "b": "\b",
        "e": "\x1b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "v": "\v",
        "\\": "\\",
        "'": "'",
        '"': '"',
      }[e];
    });
    return { text: out, stop: !!cut };
  }
  function printf(fmt, args) {
    let out = "";
    let ai = 0;
    const errs = [];
    const next = () => (ai < args.length ? args[ai++] : undefined);
    let stopped = false; // \c in the format or in a %b argument
    const once = () => {
      let i = 0;
      while (i < fmt.length) {
        const c = fmt[i];
        if (c === "\\") {
          const m = fmt.slice(i).match(/^\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|.|$)/);
          const e = m[1] ? escapes(m[0]) : { text: "\\", stop: false }; // a lone \ at the end stays
          out += e.text;
          if ((stopped = e.stop)) return;
          i += m[0].length;
          continue;
        }
        if (c !== "%") {
          out += c;
          i++;
          continue;
        }
        const m = fmt.slice(i).match(/^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sdiufFeEgGxXocb%q])/);
        if (!m) {
          out += c;
          i++;
          continue;
        }
        i += m[0].length;
        let [, flags, width, prec, conv] = m;
        if (conv === "%") {
          out += "%";
          continue;
        }
        if (width === "*") width = next();
        if (prec === "*") prec = next();
        const raw = next();
        let v;
        switch (conv) {
          case "s":
            v = raw ?? "";
            if (prec !== undefined) v = v.slice(0, Number(prec));
            break;
          case "q":
            v = raw === undefined ? "''" : /^[\w./:@-]+$/.test(raw) ? raw : "'" + raw.replace(/'/g, "'\\''") + "'";
            break;
          case "b": {
            const e = escapes(raw ?? "");
            v = e.text;
            stopped = e.stop;
            break;
          }
          case "c":
            v = (raw ?? "").charAt(0);
            break;
          case "d":
          case "i":
          case "u": {
            const s = raw ?? "0";
            let n = /^'./.test(s) ? s.charCodeAt(1) : parseInt(s, /^0x/i.test(s) ? 16 : 10);
            if (isNaN(n)) {
              errs.push(`printf: ${s}: invalid number`);
              n = 0;
            }
            v = String(Math.trunc(n));
            if (flags.includes("+") && n >= 0) v = "+" + v;
            else if (flags.includes(" ") && n >= 0) v = " " + v;
            break;
          }
          case "x":
          case "X":
          case "o": {
            const n = parseInt(raw ?? "0", 10) || 0;
            v = n.toString(conv === "o" ? 8 : 16);
            if (conv === "X") v = v.toUpperCase();
            if (flags.includes("#") && n) v = (conv === "o" ? "0" : conv === "x" ? "0x" : "0X") + v;
            break;
          }
          default: {
            const n = parseFloat(raw ?? "0") || 0;
            const p = prec === undefined ? 6 : Number(prec);
            v =
              conv === "f" || conv === "F"
                ? n.toFixed(p)
                : conv === "e" || conv === "E"
                  ? n.toExponential(p).replace(/e([+-])(\d)$/, "e$10$2")
                  : String(Number(n.toPrecision(p || 1)));
            if (conv === "E" || conv === "G") v = v.toUpperCase();
            if (flags.includes("+") && n >= 0) v = "+" + v;
          }
        }
        const W = Number(width || 0);
        if (v.length < W)
          v = flags.includes("-")
            ? v.padEnd(W)
            : flags.includes("0") && /[diufFeEgGxXo]/.test(conv)
              ? v[0] === "-"
                ? "-" + v.slice(1).padStart(W - 1, "0")
                : v.padStart(W, "0")
              : v.padStart(W);
        out += v;
        if (stopped) return;
      }
    };
    // The format is used again while arguments are left, but only if it takes some: printf '%%d' 5 prints once.
    let used;
    do {
      used = ai;
      once();
    } while (!stopped && ai < args.length && ai > used);
    return { out, errs };
  }
  IG.printfFmt = printf;
  IG.escapes = escapes;

  /* ================================================================ builtins */
  const ok = (sh, io, text) => {
    sh.writeTo(io, 1, text);
    return 0;
  };
  const er = (sh, io, text, code = 1) => {
    sh.writeTo(io, 2, text.endsWith("\n") ? text : text + "\n");
    return code;
  };
  const BUILTINS = {
    "cd"(a, io, sh) {
      if (sh.over) return er(sh, io, "sh: cd: not supported in exec");
      a = a.filter((x) => x !== "-P" && x !== "-L" && x !== "--");
      if (a.length > 1) return er(sh, io, "bash: cd: too many arguments");
      let target = a[0];
      if (target === undefined || target === "~") target = sh.special("HOME");
      if (target === "-") target = sh.frame.prev;
      const p = sh.resolve(target);
      const fs = sh.vfs();
      if (!fs.exists(p)) return er(sh, io, `bash: cd: ${a[0]}: No such file or directory`);
      if (!fs.isDir(p)) return er(sh, io, `bash: cd: ${a[0]}: Not a directory`);
      const n = fs.node(p);
      if (!sh.host.traversable(sh.user, p + "/x") || !sh.host.allowed(sh.user, n, "x"))
        return er(sh, io, `bash: cd: ${a[0]}: Permission denied`);
      sh.frame.prev = sh.frame.cwd;
      sh.frame.cwd = fs.isLink(p) ? p : p;
      if (a[0] === "-") ok(sh, io, sh.frame.cwd + "\n");
      return 0;
    },
    "pwd"(a, io, sh) {
      return ok(sh, io, (a.includes("-P") ? sh.vfs().real(sh.cwd) : sh.cwd) + "\n");
    },
    "echo"(a, io, sh) {
      let n = false,
        e = false;
      while (a.length && /^-[neE]+$/.test(a[0])) {
        if (a[0].includes("n")) n = true;
        if (a[0].includes("e")) e = true;
        if (a[0].includes("E")) e = false;
        a = a.slice(1);
      }
      let t = a.join(" ");
      if (e) {
        const r = escapes(t, true);
        t = r.text;
        if (r.stop) n = true;
      }
      return ok(sh, io, t + (n ? "" : "\n"));
    },
    "printf"(a, io, sh) {
      if (a[0] === "-v") {
        const r = printf(a[2] || "", a.slice(3));
        sh.setVar(a[1], r.out);
        return 0;
      }
      if (!a.length) return er(sh, io, "printf: usage: printf [-v var] format [arguments]", 2);
      const r = printf(a[0], a.slice(1));
      sh.writeTo(io, 1, r.out);
      if (r.errs.length) {
        er(sh, io, r.errs.join("\n"));
        return 1;
      }
      return 0;
    },
    "export"(a, io, sh) {
      if (!a.length || a[0] === "-p") {
        return ok(
          sh,
          io,
          [...sh.exported]
            .sort()
            .map((k) => `declare -x ${k}="${sh.special(k) ?? ""}"`)
            .join("\n") + "\n",
        );
      }
      for (const kv of a.filter((x) => x !== "-n")) {
        const i = kv.indexOf("=");
        const k = i > 0 ? kv.slice(0, i) : kv;
        if (!/^[A-Za-z_]\w*$/.test(k)) {
          er(sh, io, `bash: export: \`${kv}': not a valid identifier`);
          continue;
        }
        if (i > 0) sh.setVar(k, kv.slice(i + 1));
        if (a.includes("-n")) sh.exported.delete(k);
        else sh.exported.add(k);
      }
      return 0;
    },
    "unset"(a, io, sh) {
      for (const k of a.filter((x) => !/^-[fv]$/.test(x))) {
        if (sh.readonly.has(k)) {
          er(sh, io, `bash: unset: ${k}: cannot unset: readonly variable`);
          continue;
        }
        if (a.includes("-f")) delete sh.funcs[k];
        else {
          delete sh.vars[k];
          delete sh.arrays[k];
          sh.exported.delete(k);
          delete sh.funcs[k];
        }
      }
      return 0;
    },
    "set"(a, io, sh) {
      if (!a.length)
        return ok(
          sh,
          io,
          Object.keys(sh.vars)
            .sort()
            .map((k) => `${k}=${/[\s'"$]/.test(sh.vars[k]) ? `'${sh.vars[k]}'` : sh.vars[k]}`)
            .join("\n") + "\n",
        );
      const map = { e: "errexit", x: "xtrace", u: "nounset", f: "noglob", v: "verbose" };
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (x === "--") {
          sh.posStack[sh.posStack.length - 1] = a.slice(i + 1);
          break;
        }
        if (x === "-o" || x === "+o") {
          const name = a[++i];
          if (!name)
            return ok(
              sh,
              io,
              ["errexit", "nounset", "pipefail", "xtrace", "noglob"]
                .map((o) => `${o.padEnd(15)}${sh.opts[o] ? "on" : "off"}`)
                .join("\n") + "\n",
            );
          sh.opts[name] = x === "-o";
          continue;
        }
        if (/^[-+][euxfv]+$/.test(x)) {
          for (const ch of x.slice(1)) sh.opts[map[ch]] = x[0] === "-";
          continue;
        }
        sh.posStack[sh.posStack.length - 1] = a.slice(i);
        break;
      }
      return 0;
    },
    "shift"(a, io, sh) {
      const n = Number(a[0] || 1);
      const p = sh.positional();
      if (n > p.length) return 1;
      sh.posStack[sh.posStack.length - 1] = p.slice(n);
      return 0;
    },
    "local"(a, io, sh) {
      const scope = sh.localStack[sh.localStack.length - 1];
      if (!scope) return er(sh, io, "bash: local: can only be used in a function");
      for (const kv of a.filter((x) => !x.startsWith("-"))) {
        const i = kv.indexOf("=");
        const k = i > 0 ? kv.slice(0, i) : kv;
        if (!(k in scope)) scope[k] = sh.vars[k];
        sh.vars[k] = i > 0 ? kv.slice(i + 1) : "";
      }
      return 0;
    },
    "declare"(a, io, sh) {
      const flags = a.filter((x) => /^[-+]\w+$/.test(x)).join("");
      const rest = a.filter((x) => !/^[-+]\w+$/.test(x));
      if (flags.includes("f") && !rest.length)
        return ok(
          sh,
          io,
          Object.keys(sh.funcs)
            .map((f) => `${f} () \n{ ... }`)
            .join("\n") + "\n",
        );
      if (!rest.length)
        return ok(
          sh,
          io,
          Object.entries(sh.vars)
            .map(([k, v]) => `declare ${sh.exported.has(k) ? "-x" : "--"} ${k}="${v}"`)
            .join("\n") + "\n",
        );
      for (const kv of rest) {
        const i = kv.indexOf("=");
        const k = i > 0 ? kv.slice(0, i) : kv;
        const scope = sh.localStack[sh.localStack.length - 1];
        if (scope && !(k in scope) && !flags.includes("g")) scope[k] = sh.vars[k];
        if (i > 0) sh.setVar(k, flags.includes("i") ? String(sh.interp.arith(kv.slice(i + 1))) : kv.slice(i + 1));
        else if (!(k in sh.vars) && !flags.includes("a")) sh.vars[k] = "";
        if (flags.includes("a") && i < 0) sh.arraySet(k, []);
        if (flags.includes("x")) sh.exported.add(k);
        if (flags.includes("r")) sh.readonly.add(k);
      }
      return 0;
    },
    "readonly"(a, io, sh) {
      for (const kv of a) {
        const i = kv.indexOf("=");
        const k = i > 0 ? kv.slice(0, i) : kv;
        if (i > 0) sh.setVar(k, kv.slice(i + 1));
        sh.readonly.add(k);
      }
      return 0;
    },
    "return"(a, io, sh) {
      throw new B.Flow("return", 1, a[0] !== undefined ? Number(a[0]) & 255 : sh.lastCode);
    },
    "exit"(a, io, sh) {
      const code = a[0] !== undefined ? Number(a[0]) & 255 : sh.lastCode;
      if (sh.over) return code;
      throw new B.Flow("exit", 1, code);
    },
    "logout"(a, io, sh) {
      return BUILTINS.exit(a, io, sh);
    },
    "break"(a) {
      throw new B.Flow("break", Number(a[0] || 1));
    },
    "continue"(a) {
      throw new B.Flow("continue", Number(a[0] || 1));
    },
    "source"(a, io, sh) {
      if (!a[0])
        return er(sh, io, "bash: source: filename argument required\nsource: usage: source filename [arguments]", 2);
      const p = sh.resolve(a[0]);
      const fs = sh.vfs();
      if (!fs.isFile(p)) return er(sh, io, `bash: ${a[0]}: No such file or directory`);
      if (!sh.canRead(p)) return er(sh, io, `bash: ${a[0]}: Permission denied`);
      let text = fs.read(p);
      text = text.replace(/case \$- in[\s\S]*?esac\n/, ""); // interactive guard in .bashrc
      return sh.runScript(text, [a[0], ...a.slice(1)], io, { source: true });
    },
    "alias"(a, io, sh) {
      if (!a.length || a[0] === "-p")
        return ok(
          sh,
          io,
          Object.entries(sh.aliases)
            .sort()
            .map(([k, v]) => `alias ${k}='${v}'`)
            .join("\n") + "\n",
        );
      let code = 0;
      for (const d of a) {
        const i = d.indexOf("=");
        if (i > 0) sh.aliases[d.slice(0, i)] = d.slice(i + 1);
        else if (sh.aliases[d]) ok(sh, io, `alias ${d}='${sh.aliases[d]}'\n`);
        else {
          er(sh, io, `bash: alias: ${d}: not found`);
          code = 1;
        }
      }
      return code;
    },
    "unalias"(a, io, sh) {
      if (a[0] === "-a") {
        sh.aliases = {};
        return 0;
      }
      for (const k of a) {
        if (!sh.aliases[k]) return er(sh, io, `bash: unalias: ${k}: not found`);
        delete sh.aliases[k];
      }
      return 0;
    },
    "history"(a, io, sh) {
      if (a[0] === "-c") {
        sh.history.length = 0;
        return 0;
      }
      const n = Number(a[0]) || sh.history.length;
      const start = Math.max(0, sh.history.length - n);
      return ok(
        sh,
        io,
        sh.history
          .slice(start)
          .map((h, i) => `${String(start + i + 1).padStart(5)}  ${h}`)
          .join("\n") + "\n",
      );
    },
    "type"(a, io, sh) {
      let code = 0;
      const tflag = a.includes("-t"),
        all = a.includes("-a");
      for (const x of a.filter((y) => !y.startsWith("-"))) {
        const lines = [];
        if (sh.aliases[x]) lines.push(tflag ? "alias" : `${x} is aliased to \`${sh.aliases[x]}'`);
        if (
          [
            "if",
            "then",
            "else",
            "fi",
            "for",
            "while",
            "do",
            "done",
            "case",
            "esac",
            "function",
            "until",
            "[[",
          ].includes(x)
        )
          lines.push(tflag ? "keyword" : `${x} is a shell keyword`);
        if (sh.funcs[x]) lines.push(tflag ? "function" : `${x} is a function`);
        if (BUILTINS[x]) lines.push(tflag ? "builtin" : `${x} is a shell builtin`);
        const w = sh.which(x);
        if (w && (!w.registered || sh.host.hasCommand(x))) lines.push(tflag ? "file" : `${x} is ${w.path}`);
        if (!lines.length) {
          er(sh, io, `bash: type: ${x}: not found`);
          code = 1;
          continue;
        }
        ok(sh, io, (all ? lines : lines.slice(0, 1)).join("\n") + "\n");
      }
      return code;
    },
    "command"(a, io, sh) {
      if (a[0] === "-v" || a[0] === "-V") {
        let code = 0;
        for (const x of a.slice(1)) {
          if (sh.aliases[x]) {
            ok(sh, io, a[0] === "-v" ? `alias ${x}='${sh.aliases[x]}'\n` : `${x} is aliased to \`${sh.aliases[x]}'\n`);
            continue;
          }
          if (BUILTINS[x] || sh.funcs[x]) {
            ok(sh, io, a[0] === "-v" ? x + "\n" : `${x} is a shell builtin\n`);
            continue;
          }
          const w = sh.which(x);
          if (w && (!w.registered || sh.host.hasCommand(x)))
            ok(sh, io, a[0] === "-v" ? w.path + "\n" : `${x} is ${w.path}\n`);
          else code = 1;
        }
        return code;
      }
      const [name, ...rest] = a;
      if (!name) return 0;
      if (BUILTINS[name]) return BUILTINS[name](rest, io, sh);
      const saved = sh.funcs[name];
      delete sh.funcs[name];
      try {
        return sh.invoke(a, io);
      } finally {
        if (saved) sh.funcs[name] = saved;
      }
    },
    "builtin"(a, io, sh) {
      if (!a.length) return 0;
      const f = BUILTINS[a[0]];
      if (!f) return er(sh, io, `bash: builtin: ${a[0]}: not a shell builtin`);
      return f(a.slice(1), io, sh);
    },
    "test"(a, io, sh) {
      try {
        return sh.test(a) ? 0 : 1;
      } catch (e) {
        return er(sh, io, `bash: test: ${e.message}`, 2);
      }
    },
    "["(a, io, sh) {
      if (a[a.length - 1] !== "]") return er(sh, io, "bash: [: missing `]'", 2);
      try {
        return sh.test(a.slice(0, -1)) ? 0 : 1;
      } catch (e) {
        return er(sh, io, `bash: [: ${e.message}`, 2);
      }
    },
    "true"() {
      return 0;
    },
    "false"() {
      return 1;
    },
    ":"() {
      return 0;
    },
    "read"(a, io, sh) {
      let raw = false,
        prompt = "",
        arr = null,
        delim = "\n",
        nchars = 0,
        silent = false;
      const names = [];
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (x === "-r") raw = true;
        else if (x === "-p") prompt = a[++i];
        else if (x === "-a") arr = a[++i];
        else if (x === "-d") delim = a[++i] || "\0";
        else if (x === "-n") nchars = Number(a[++i]);
        else if (x === "-s") silent = true;
        else if (x === "-t") i++;
        else names.push(x);
      }
      void silent;
      const s = io.stdin;
      if (!s || (s.tty && s.pos >= s.data.length)) {
        if (prompt) sh.writeTo(io, 2, prompt);
        return er(
          sh,
          io,
          IG.t(
            '\nℹ 対話的な入力待ちは再現できません。パイプ・ヒアドキュメント・<<< で値を渡してください（例: read x <<< "value"）。',
          ),
        );
      }
      if (s.pos >= s.data.length) return 1;
      let end = nchars ? Math.min(s.pos + nchars, s.data.length) : s.data.indexOf(delim, s.pos);
      const eof = end < 0;
      if (eof) end = s.data.length;
      let line = s.data.slice(s.pos, end);
      s.pos = end + (eof || nchars ? 0 : 1);
      if (!raw) line = line.replace(/\\(.)/g, "$1");
      const ifs = sh.special("IFS") ?? " \t\n";
      if (arr) {
        sh.arraySet(arr, line.trim().split(/\s+/).filter(Boolean));
        return eof && !line ? 1 : 0;
      }
      if (!names.length) names.push("REPLY");
      const fields =
        names.length === 1
          ? [ifs.includes(" ") ? line.replace(/^[ \t]+|[ \t]+$/g, "") : line]
          : (() => {
              const parts = [];
              let rest = ifs.includes(" ") ? line.replace(/^[ \t]+/, "") : line;
              const sep = new RegExp(`[${ifs.replace(/[\]\\^-]/g, "\\$&")}]${ifs.includes(" ") ? "+" : ""}`);
              for (let k = 0; k < names.length - 1; k++) {
                const m = rest.match(sep);
                if (!m) {
                  parts.push(rest);
                  rest = "";
                  continue;
                }
                parts.push(rest.slice(0, m.index));
                rest = rest.slice(m.index + m[0].length);
              }
              parts.push(ifs.includes(" ") ? rest.replace(/[ \t]+$/, "") : rest);
              return parts;
            })();
      names.forEach((n, k) => sh.setVar(n, fields[k] ?? ""));
      return eof ? 1 : 0;
    },
    "eval"(a, io, sh) {
      const src = a.join(" ");
      if (!src.trim()) return 0;
      try {
        return sh.interp.exec(B.parse(src), io);
      } catch (e) {
        if (e instanceof B.Flow) throw e;
        return er(sh, io, `bash: eval: ${e.message}`, 2);
      }
    },
    "exec"(a, io, sh) {
      if (!a.length) return 0;
      const code = sh.invoke(a, io);
      throw new B.Flow("exit", 1, code);
    },
    "jobs"(a, io, sh) {
      return ok(
        sh,
        io,
        sh.jobs
          .map(
            (j, k) =>
              `[${j.n}]${k === sh.jobs.length - 1 ? "+" : "-"}  ${j.done ? "Done" : "Running"}                    ${j.cmd}\n`,
          )
          .join(""),
      );
    },
    "fg"(a, io, sh) {
      const j = sh.jobs[sh.jobs.length - 1];
      if (!j) return er(sh, io, "bash: fg: current: no such job");
      ok(sh, io, j.cmd + "\n");
      sh.jobs = sh.jobs.filter((x) => x !== j);
      return 0;
    },
    "bg"(a, io, sh) {
      const j = sh.jobs[sh.jobs.length - 1];
      if (!j) return er(sh, io, "bash: bg: current: no such job");
      return er(sh, io, `bash: bg: job ${j.n} already in background`);
    },
    "wait"() {
      return 0;
    },
    "disown"(a, io, sh) {
      sh.jobs = [];
      return 0;
    },
    "let"(a, io, sh) {
      let v = 0;
      try {
        for (const e of a) v = sh.interp.arith(e);
      } catch (e) {
        return er(sh, io, `bash: let: ${e.message}`);
      }
      return v ? 0 : 1;
    },
    "umask"(a, io, sh) {
      if (a[0] && /^[0-7]{3,4}$/.test(a[0])) {
        sh.umask = parseInt(a[0], 8);
        return 0;
      }
      return ok(
        sh,
        io,
        (a.includes("-S") ? "u=rwx,g=rx,o=rx" : (sh.umask ?? 0o002).toString(8).padStart(4, "0")) + "\n",
      );
    },
    "hash"() {
      return 0;
    },
    "shopt"(a, io, sh) {
      if (!a.length)
        return ok(
          sh,
          io,
          "autocd         \toff\ncdspell        \toff\nextglob        \ton\nglobstar       \toff\nnullglob       \toff\n",
        );
      return 0;
    },
    "trap"() {
      return 0;
    },
    "times"(a, io, sh) {
      return ok(sh, io, "0m0.012s 0m0.008s\n0m0.104s 0m0.061s\n");
    },
    "ulimit"(a, io, sh) {
      if (a.includes("-a"))
        return ok(
          sh,
          io,
          "real-time non-blocking time  (microseconds, -R) unlimited\ncore file size              (blocks, -c) 0\ndata seg size               (kbytes, -d) unlimited\nscheduling priority                 (-e) 0\nfile size                   (blocks, -f) unlimited\npending signals                     (-i) 31335\nmax locked memory           (kbytes, -l) 1009212\nmax memory size             (kbytes, -m) unlimited\nopen files                          (-n) 1024\npipe size                (512 bytes, -p) 8\nPOSIX message queues         (bytes, -q) 819200\nreal-time priority                  (-r) 0\nstack size                  (kbytes, -s) 8192\ncpu time                   (seconds, -t) unlimited\nmax user processes                  (-u) 31335\nvirtual memory              (kbytes, -v) unlimited\nfile locks                          (-x) unlimited\n",
        );
      return ok(sh, io, a.includes("-n") ? "1024\n" : "unlimited\n");
    },
    "pushd"(a, io, sh) {
      const prev = sh.cwd;
      const code = BUILTINS.cd(a, { fd: { 1: { null: true }, 2: io.fd[2] } }, sh);
      if (code) return code;
      sh.dirStack.unshift(prev);
      return ok(sh, io, [sh.cwd, ...sh.dirStack].join(" ") + "\n");
    },
    "popd"(a, io, sh) {
      if (!sh.dirStack.length) return er(sh, io, "bash: popd: directory stack empty");
      const d = sh.dirStack.shift();
      sh.frame.prev = sh.frame.cwd;
      sh.frame.cwd = d;
      return ok(sh, io, [sh.cwd, ...sh.dirStack].join(" ") + "\n");
    },
    "dirs"(a, io, sh) {
      return ok(sh, io, [sh.cwd, ...sh.dirStack].join(" ") + "\n");
    },
    "help"(a, io, sh) {
      if (a[0]) {
        const e = IG.cmdref && IG.cmdref.get(a[0]);
        if (e && (e.builtin || BUILTINS[a[0]])) return ok(sh, io, IG.manpages.help(a[0]) + "\n");
        return er(
          sh,
          io,
          `bash: help: no help topics match \`${a[0]}'.  Try \`help help' or \`man -k ${a[0]}' or \`info ${a[0]}'.`,
        );
      }
      return ok(
        sh,
        io,
        IG.manpages ? IG.manpages.overview(sh.world.features) : "GNU bash, version 5.1.16(1)-release\n",
      );
    },
  };
  BUILTINS.typeset = BUILTINS.declare;
  BUILTINS["."] = BUILTINS.source;

  Shell.BUILTINS = BUILTINS; // read by tests/run-ref.js (every command has a dictionary entry)
  IG.Shell = Shell;
  IG.shellBuiltins = BUILTINS;
  IG.shellWords = (line) => {
    try {
      const ast = B.parse(line);
      const n = ast.items[0] && ast.items[0].node;
      if (n && n.type === "simple") {
        return n.words.map((w) => w.replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1"));
      }
    } catch (e) {
      /* fallthrough */
    }
    return line.split(/\s+/).filter(Boolean);
  };
})((globalThis.IG = globalThis.IG || {}));
