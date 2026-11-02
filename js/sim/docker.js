/* Docker Engine + docker CLI + docker compose simulation (runs on the bastion host). */
(function (IG) {
  "use strict";
  const U = IG.util;
  IG.commands = IG.commands || {};
  const ok = (out) => ({ out, code: 0 });
  const fail = (out, code = 1) => ({ out, code, err: true });

  class Docker {
    constructor(world) {
      this.world = world;
      this.images = [];
      this.containers = [];
      this.logins = {};
      this.networks = ["bridge", "host", "none"];
      this.seq = 1;
    }
    get enabled() {
      return this.world.features.has("docker");
    }
    norm(ref) {
      const p = IG.images.parse(ref);
      return p.host ? p.full : p.short;
    }
    findImage(ref) {
      if (!ref) return null;
      const key = this.norm(ref);
      return (
        this.images.find((i) => i.ref === key) ||
        this.images.find((i) => i.id.startsWith(ref.replace(/^sha256:/, "")) && ref.length >= 4) ||
        null
      );
    }
    addLocal(ref, meta, created) {
      const key = this.norm(ref);
      this.images = this.images.filter((i) => i.ref !== key);
      const img = {
        ref: key,
        id: meta.imageId || IG.images.id(key + (meta.buildSeed || "")),
        meta,
        created: created || this.world.stamp(),
      };
      this.images.push(img);
      return img;
    }
    pull(ref) {
      const r = this.world.pullImage(ref, this.logins);
      if (!r.ok) return r;
      const meta = U.clone(r.meta);
      meta.imageId = IG.images.id(this.norm(ref));
      return { ok: true, image: this.addLocal(ref, meta, this.world.now() - 12 * 86400e3) };
    }
    byName(name) {
      return this.containers.find((c) => c.name === name || c.id.startsWith(name)) || null;
    }
    resolveInNet(host, network) {
      if (!network || network === "bridge") return null;
      return (
        this.containers.find(
          (c) => c.network === network && c.status === "running" && (c.service === host || c.name === host),
        ) || null
      );
    }
    start(c) {
      const rt = IG.runtime.evaluate(c.meta, {
        env: c.env,
        resolveHost: (h) => !!this.resolveInNet(h, c.network),
        command: c.cmd && c.cmd.length ? c.cmd : null,
      });
      c.startedAt = this.world.stamp();
      c.rt = rt;
      c.logs = c.logs.concat(rt.logs || []);
      if (rt.ok) {
        c.status = "running";
        c.exitCode = null;
      } else {
        c.status = "exited";
        c.exitCode = rt.exitCode;
        c.finishedAt = this.world.now() + 800;
      }
      return c;
    }
    create(o) {
      const id = U.hex("ctr:" + o.name + this.seq++ + this.world.now(), 64);
      const c = Object.assign(
        {
          id,
          status: "created",
          logs: [],
          access: [],
          ports: [],
          env: {},
          network: "bridge",
          created: this.world.stamp(),
          cmd: [],
        },
        o,
      );
      c.env = Object.assign({}, o.image.meta.env || {}, o.env || {});
      c.imageRef = o.image.ref;
      c.meta = o.image.meta;
      this.containers.push(c);
      return c;
    }
    portInUse(port, except) {
      return this.containers.find(
        (c) => c !== except && c.status === "running" && c.ports.some((p) => p.host === port),
      );
    }
    statusText(c) {
      const ago = (ms) => {
        const s = Math.max(1, Math.floor(ms / 1000));
        return s < 60
          ? `${s} seconds`
          : s < 3600
            ? `${Math.floor(s / 60)} minute${s < 120 ? "" : "s"}`
            : s < 172800
              ? `${Math.floor(s / 3600)} hours`
              : `${Math.floor(s / 86400)} days`;
      };
      if (c.status === "running") return `Up ${ago(this.world.now() - c.startedAt)}`;
      if (c.status === "exited")
        return `Exited (${c.exitCode}) ${ago(this.world.now() - (c.finishedAt || c.startedAt))} ago`;
      return "Created";
    }
    portsText(c) {
      return c.status !== "running" ? "" : c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(", ");
    }
    respond(c, req) {
      if (c.status !== "running") return null;
      const r = IG.runtime.respond(c.meta, req.path, { instance: c.id.slice(0, 12) });
      if (!r) return { error: "curl: (52) Empty reply from server", target: { kind: "container", name: c.name } };
      c.access.push(
        `172.17.0.1 - - [${new Date(this.world.now()).toUTCString()}] "${req.method} ${req.path} HTTP/1.1" ${r.status} ${r.body.length} "-" "curl/8.5.0"`,
      );
      return Object.assign({ target: { kind: "container", name: c.name } }, r);
    }
    hostHttp(req) {
      if (!this.enabled)
        return {
          error: `curl: (7) Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server`,
        };
      const c = this.containers.find((x) => x.status === "running" && x.ports.some((p) => p.host === req.port));
      if (!c)
        return {
          error: `curl: (7) Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server`,
        };
      const map = c.ports.find((p) => p.host === req.port);
      if (c.rt.port !== map.container)
        return {
          error: "curl: (56) Recv failure: Connection reset by peer",
          target: { kind: "container", name: c.name },
        };
      return this.respond(c, req);
    }
    containerNetHttp(req, name) {
      const from = this.byName(name);
      if (!from) return null;
      const target =
        req.host === "localhost" || req.host === "127.0.0.1" ? from : this.resolveInNet(req.host, from.network);
      if (!target) return null;
      if (target.rt.port !== req.port)
        return {
          error: `curl: (7) Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server`,
        };
      return this.respond(target, req);
    }

    /* ------------------------------------------------------------ build */
    build(ctxDir, dockerfilePath, tag, vfs) {
      const lines = [];
      const text = vfs.read(dockerfilePath);
      if (text === undefined)
        return {
          error: `ERROR: failed to solve: failed to read dockerfile: open ${IG.VFS.base(dockerfilePath)}: no such file or directory`,
        };
      const instrs = [];
      let buf = "",
        startLine = 0;
      text.split("\n").forEach((raw, i) => {
        const l = raw.replace(/\r$/, "");
        if (!buf && (/^\s*#/.test(l) || !l.trim())) return;
        if (!buf) startLine = i + 1;
        if (l.endsWith("\\")) {
          buf += l.slice(0, -1) + " ";
          return;
        }
        buf += l;
        const m = buf.trim().match(/^(\w+)\s*(.*)$/);
        instrs.push({ op: m[1].toUpperCase(), arg: m[2].trim(), line: startLine, raw: buf.trim() });
        buf = "";
      });
      const known = [
        "FROM",
        "RUN",
        "CMD",
        "COPY",
        "ADD",
        "WORKDIR",
        "ENV",
        "EXPOSE",
        "USER",
        "ENTRYPOINT",
        "ARG",
        "LABEL",
        "HEALTHCHECK",
        "VOLUME",
      ];
      const bad = instrs.find((x) => !known.includes(x.op));
      if (bad)
        return {
          error: `ERROR: failed to solve: dockerfile parse error on line ${bad.line}: unknown instruction: ${bad.raw.split(/\s/)[0]}`,
        };
      if (!instrs.length || (instrs[0].op !== "FROM" && instrs[0].op !== "ARG"))
        return { error: "ERROR: failed to solve: no build stage in current context" };
      const from = instrs.find((x) => x.op === "FROM");
      const baseRef = from.arg.split(/\s+/)[0];
      const pull = this.world.pullImage(baseRef, this.logins);
      const p = IG.images.parse(baseRef);
      const fq = p.host ? p.full : "docker.io/library/" + p.short;
      const steps = instrs.filter(
        (x) =>
          !["ARG", "LABEL", "EXPOSE", "ENV", "CMD", "ENTRYPOINT", "USER", "HEALTHCHECK", "VOLUME"].includes(x.op) ||
          x.op === "FROM",
      );
      const total = steps.length;
      const head = [
        ` => [internal] load build definition from ${IG.VFS.base(dockerfilePath)}`.padEnd(78) + "0.0s",
        ` => => transferring dockerfile: ${text.length}B`.padEnd(78) + "0.0s",
        ` => [internal] load metadata for ${fq}`.padEnd(78) + "1.3s",
        ` => [internal] load .dockerignore`.padEnd(78) + "0.0s",
      ];
      if (!pull.ok) {
        return {
          error: `[+] Building 1.4s (3/3) FINISHED\n${head.slice(0, 3).join("\n")}\nERROR: failed to solve: ${baseRef}: failed to resolve source metadata for ${fq}: ${fq}: not found`,
        };
      }
      const meta = U.clone(pull.meta);
      meta.env = Object.assign({}, meta.env || {});
      let workdir = "/";
      const copied = {};
      let cmd = null;
      let n = 0;
      lines.push(...head);
      for (const ins of instrs) {
        if (ins.op === "FROM") {
          n++;
          lines.push(` => [${n}/${total}] FROM ${fq}@${IG.images.digest(baseRef).slice(0, 23)}...`.padEnd(78) + "2.8s");
          continue;
        }
        if (ins.op === "WORKDIR") {
          workdir = IG.VFS.norm(ins.arg, workdir);
          n++;
          lines.push(` => [${n}/${total}] WORKDIR ${ins.arg}`.padEnd(78) + "0.1s");
          continue;
        }
        if (ins.op === "ENV") {
          const m = ins.arg.match(/^(\w+)(?:=|\s+)(.*)$/);
          if (m)
            for (const pair of ins.arg.includes("=") ? ins.arg.match(/(\w+)=("[^"]*"|\S+)/g) : [`${m[1]}=${m[2]}`]) {
              const i = pair.indexOf("=");
              meta.env[pair.slice(0, i)] = pair.slice(i + 1).replace(/^"|"$/g, "");
            }
          continue;
        }
        if (ins.op === "EXPOSE") {
          meta.expose = Number(ins.arg.split(/[\s/]/)[0]);
          continue;
        }
        if (ins.op === "USER") {
          meta.root = /^(root|0)$/.test(ins.arg);
          continue;
        }
        if (ins.op === "CMD" || ins.op === "ENTRYPOINT") {
          try {
            cmd = /^\[/.test(ins.arg) ? JSON.parse(ins.arg) : ins.arg.split(/\s+/);
          } catch (e) {
            cmd = ins.arg.split(/\s+/);
          }
          continue;
        }
        if (ins.op === "COPY" || ins.op === "ADD") {
          n++;
          const parts = ins.arg.split(/\s+/).filter((x) => !x.startsWith("--"));
          const dest = parts.pop();
          const label = ` => [${n}/${total}] ${ins.op} ${ins.arg}`;
          for (const src of parts) {
            const abs = IG.VFS.norm(src, ctxDir);
            if (!abs.startsWith(ctxDir === "/" ? "/" : ctxDir) || !vfs.exists(abs)) {
              lines.push(
                " => ERROR" + label.slice(3).padEnd(71) + "0.0s",
                "------",
                ` > [${n}/${total}] ${ins.op} ${ins.arg}:`,
                "------",
                `${IG.VFS.base(dockerfilePath)}:${ins.line}`,
                "--------------------",
                `  ${String(ins.line).padStart(2)} | >>> ${ins.raw}`,
                "--------------------",
                `ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref ${U.hex(src, 8)}-${U.hex(src + 1, 4)}::${U.hex(src + 2, 24)}: "/${src.replace(/^\.\//, "")}": not found`,
              );
              return { error: `[+] Building 4.2s (${n + 3}/${total + 4}) FINISHED\n` + lines.join("\n") };
            }
            const destAbs = IG.VFS.norm(dest, workdir);
            const add = (file, target) => {
              copied[target] = vfs.read(file);
            };
            if (vfs.isDir(abs))
              for (const f of vfs.walk(abs)) {
                if (vfs.isFile(f))
                  add(f, IG.VFS.norm(f.slice(abs.length + 1), dest.endsWith("/") || dest === "." ? destAbs : destAbs));
              }
            else
              add(
                abs,
                dest.endsWith("/") || dest === "." || parts.length > 1
                  ? destAbs.replace(/\/$/, "") + "/" + IG.VFS.base(abs)
                  : destAbs,
              );
          }
          lines.push(label.padEnd(78) + "0.0s");
          continue;
        }
        if (ins.op === "RUN") {
          n++;
          if (/requirements?\.txt/.test(ins.arg)) {
            const req = Object.keys(copied).find((f) => /requirements?\.txt$/.test(f));
            if (!req) {
              lines.push(
                " => ERROR" + ` [${n}/${total}] RUN ${ins.arg}`.slice(0).padEnd(71) + "1.1s",
                "------",
                ` > [${n}/${total}] RUN ${ins.arg}:`,
                "ERROR: Could not open requirements file: [Errno 2] No such file or directory: 'requirements.txt'",
                "------",
                `ERROR: failed to solve: process "/bin/sh -c ${ins.arg}" did not complete successfully: exit code: 1`,
              );
              return { error: `[+] Building 5.0s (${n + 3}/${total + 4}) FINISHED\n` + lines.join("\n") };
            }
          }
          lines.push(
            ` => [${n}/${total}] RUN ${ins.arg}`.slice(0, 74).padEnd(78) +
              (3 + (U.hash(ins.arg) % 60) / 10).toFixed(1) +
              "s",
          );
        }
      }
      // Derive runtime behaviour from what was copied.
      const src = Object.entries(copied);
      if (meta.kind === "runtime") {
        meta.kind = cmd ? "app" : "tool";
        meta.app = IG.images
          .parse(tag || "app")
          .name.split("/")
          .pop();
        meta.portEnv = "PORT";
        const code = src
          .filter(([f]) => /\.(py|js)$/.test(f))
          .map(([, c]) => c)
          .join("\n");
        const pm = code.match(/["']PORT["']\s*,\s*["']?(\d+)/) || code.match(/port\s*=\s*(\d+)/i);
        meta.port = pm ? Number(pm[1]) : 8000;
        meta.requiresEnv = [...new Set([...code.matchAll(/os\.environ\[["'](\w+)["']\]/g)].map((m) => m[1]))];
        meta.hostEnv = meta.requiresEnv.filter((k) => /_HOST$/.test(k));
        meta.version = (IG.images.parse(tag || "x:1.0.0").tag || "1.0.0").replace(/^latest$/, "1.0.0");
        meta.vulns = Object.assign({}, meta.vulns, { low: (meta.vulns.low || 0) + 2 });
        if (cmd) {
          const file = cmd.find((x) => /\.(py|js)$/.test(x));
          if (file && !copied[IG.VFS.norm(file, workdir)]) meta.cmdMissing = file;
          meta.entry = file;
          meta.cmd = cmd;
        }
      } else if (meta.kind === "web") {
        const index = src.find(([f]) =>
          /\/usr\/share\/nginx\/html\/index\.html$|\/usr\/local\/apache2\/htdocs\/index\.html$/.test(f),
        );
        if (index) meta.body = index[1];
      }
      meta.buildSeed = U.hex(JSON.stringify(src) + baseRef + JSON.stringify(meta.env), 8);
      meta.imageId = IG.images.id((tag || "dangling") + meta.buildSeed);
      meta.base = IG.images.parse(baseRef).short;
      meta.size = meta.size;
      const ref = tag || `<none>:${meta.imageId.slice(0, 6)}`;
      const img = this.addLocal(ref, meta);
      const name = tag
        ? IG.images.parse(tag).host
          ? IG.images.parse(tag).full
          : "docker.io/library/" + IG.images.parse(tag).short
        : null;
      lines.push(
        " => exporting to image".padEnd(78) + "0.4s",
        " => => exporting layers".padEnd(78) + "0.3s",
        ` => => writing image sha256:${U.hex("sha" + img.id, 64)} 0.0s`,
      );
      if (name) lines.push(` => => naming to ${name}`.padEnd(78) + "0.0s");
      return {
        out:
          `[+] Building ${(8 + (U.hash(text) % 40) / 10).toFixed(1)}s (${total + 4}/${total + 4}) FINISHED${" ".repeat(30)}docker:default\n` +
          lines.join("\n"),
        image: img,
      };
    }

    /* ------------------------------------------------------------ compose */
    loadCompose(ctx, file) {
      const dir = ctx.cwd;
      const candidates = file
        ? [ctx.resolve(file)]
        : ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].map(
            (f) => dir.replace(/\/$/, "") + "/" + f,
          );
      const path = candidates.find((p) => ctx.vfs.isFile(p));
      if (!path) return { error: "no configuration file provided: not found" };
      let doc;
      try {
        doc = IG.yaml.parse(ctx.vfs.read(path));
      } catch (e) {
        return { error: `${path}: ${e.message}` };
      }
      if (!doc || !U.isObj(doc.services)) return { error: `${IG.VFS.base(path)}: services must be a mapping` };
      const project = (doc.name || IG.VFS.base(IG.VFS.parent(path))).toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const services = [];
      for (const [name, s] of Object.entries(doc.services)) {
        if (!U.isObj(s)) return { error: `services.${name} must be a mapping` };
        const known = [
          "image",
          "build",
          "ports",
          "environment",
          "env_file",
          "depends_on",
          "restart",
          "command",
          "container_name",
          "volumes",
          "networks",
          "healthcheck",
          "expose",
        ];
        const unknown = Object.keys(s).find((k) => !known.includes(k));
        if (unknown)
          return { error: `validating ${path}: services.${name} additional properties '${unknown}' not allowed` };
        let env = {};
        if (Array.isArray(s.environment))
          for (const kv of s.environment) {
            const i = String(kv).indexOf("=");
            env[String(kv).slice(0, i)] = String(kv).slice(i + 1);
          }
        else if (U.isObj(s.environment))
          for (const [k, v] of Object.entries(s.environment)) env[k] = v === null ? "" : String(v);
        const ports = (s.ports || []).map((p) => {
          const parts = String(p).split(":");
          return { host: Number(parts[parts.length - 2] || parts[0]), container: Number(parts[parts.length - 1]) };
        });
        const deps = Array.isArray(s.depends_on)
          ? s.depends_on
          : U.isObj(s.depends_on)
            ? Object.keys(s.depends_on)
            : [];
        services.push({
          name,
          image: s.image,
          build: s.build,
          env,
          ports,
          deps,
          command: s.command,
          containerName: s.container_name,
        });
      }
      // order by depends_on
      const ordered = [],
        seen = new Set();
      const visit = (s) => {
        if (seen.has(s.name)) return;
        seen.add(s.name);
        for (const d of s.deps) {
          const t = services.find((x) => x.name === d);
          if (t) visit(t);
        }
        ordered.push(s);
      };
      services.forEach(visit);
      return { path, project, services: ordered, dir: IG.VFS.parent(path) };
    }
  }

  /* ------------------------------------------------------------ CLI */
  const VF = [
    "name",
    "p",
    "publish",
    "e",
    "env",
    "t",
    "tag",
    "f",
    "file",
    "u",
    "username",
    "password",
    "tail",
    "network",
    "env-file",
    "format",
    "filter",
    "w",
    "workdir",
    "platform",
    "entrypoint",
    "restart",
    "n",
  ];
  function docker(argv, ctx) {
    const w = ctx.world,
      D = w.docker;
    if (!D || !D.enabled)
      return fail(
        IG.t(
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n\nℹ このミッションの踏み台では Docker を使いません。",
        ),
      );
    if (ctx.pod)
      return fail(
        `OCI runtime exec failed: exec failed: unable to start container process: exec: "docker": executable file not found in $PATH: unknown`,
        126,
      );
    const sub = argv[0];
    const rest = argv.slice(1);
    switch (sub) {
      case undefined:
      case "help":
      case "--help":
        return ok(
          "Usage:  docker [OPTIONS] COMMAND\n\nCommon Commands:\n  run         Create and run a new container from an image\n  exec        Execute a command in a running container\n  ps          List containers\n  build       Build an image from a Dockerfile\n  pull        Download an image from a registry\n  push        Upload an image to a registry\n  images      List images\n  login       Log in to a registry\n  logout      Log out from a registry\n  version     Show the Docker version information\n  info        Display system-wide information\n\nManagement / other:\n  compose     Docker Compose (up, down, ps, logs, restart, config)\n  logs, start, stop, restart, rm, rmi, tag, inspect, network ls",
        );
      case "version":
        return ok(
          "Client: Docker Engine - Community\n Version:           27.3.1\n API version:       1.47\n Go version:        go1.22.7\n\nServer: Docker Engine - Community\n Engine:\n  Version:          27.3.1\n  API version:      1.47 (minimum version 1.24)\n containerd:\n  Version:          1.7.22",
        );
      case "info":
        return ok(
          `Client: Docker Engine - Community\n Version:    27.3.1\n Context:    default\n\nServer:\n Containers: ${D.containers.length}\n  Running: ${D.containers.filter((c) => c.status === "running").length}\n  Stopped: ${D.containers.filter((c) => c.status !== "running").length}\n Images: ${D.images.length}\n Server Version: 27.3.1\n Storage Driver: overlay2\n Cgroup Driver: systemd\n Kernel Version: 5.15.0-1066-aws\n Operating System: Ubuntu 22.04.4 LTS\n Registry: https://index.docker.io/v1/${Object.keys(D.logins).length ? "\n Logged in registries: " + Object.keys(D.logins).join(", ") : ""}`,
        );
      case "ps": {
        const a = U.args(rest, VF);
        const list = D.containers.filter((c) => a.flags.a || a.flags.all || c.status === "running");
        if (a.flags.q) return ok(list.map((c) => c.id.slice(0, 12)).join("\n"));
        return ok(
          U.table(
            ["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"],
            list.map((c) => [
              c.id.slice(0, 12),
              c.imageRef,
              `"${cmdText(c)}"`,
              createdText(w, c.created),
              D.statusText(c),
              D.portsText(c),
              c.name,
            ]),
          ),
        );
      }
      case "images":
      case "image": {
        if (sub === "image" && rest[0] === "ls") rest.shift();
        if (sub === "image" && rest[0] && rest[0] !== "ls")
          return docker([rest[0] === "rm" ? "rmi" : rest[0], ...rest.slice(1)], ctx);
        return ok(
          U.table(
            ["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"],
            D.images
              .slice()
              .sort((x, y) => y.created - x.created)
              .map((i) => {
                const p = i.ref.lastIndexOf(":");
                return [i.ref.slice(0, p), i.ref.slice(p + 1), i.id, createdText(w, i.created), i.meta.size || "120MB"];
              }),
          ),
        );
      }
      case "pull": {
        const ref = rest.find((x) => !x.startsWith("-"));
        if (!ref) return fail('"docker pull" requires exactly 1 argument.');
        const p = IG.images.parse(ref);
        const r = D.pull(ref);
        if (!r.ok)
          return fail(
            `Error response from daemon: ${r.reason === "notfound" ? `manifest for ${p.full} not found: manifest unknown: manifest unknown` : r.error}`,
          );
        w.emit(`docker pull ${p.full}`);
        return ok(
          `${p.tag}: Pulling from ${p.host ? p.name : "library/" + p.name}\n${U.hex(ref, 12)}: Pull complete\n${U.hex(ref + "b", 12)}: Pull complete\nDigest: ${IG.images.digest(ref)}\nStatus: Downloaded newer image for ${p.host ? p.full : p.short}\n${p.host ? p.full : "docker.io/library/" + p.short}`,
        );
      }
      case "run":
        return dockerRun(rest, ctx);
      case "start":
      case "stop":
      case "restart":
      case "kill": {
        if (!rest.length) return fail(`"docker ${sub}" requires at least 1 argument.`);
        const out = [];
        for (const n of rest.filter((x) => !x.startsWith("-"))) {
          const c = D.byName(n);
          if (!c) return fail(`Error response from daemon: No such container: ${n}`);
          if (sub === "stop" || sub === "kill") {
            if (c.status === "running") {
              c.status = "exited";
              c.exitCode = sub === "kill" ? 137 : 0;
              c.finishedAt = w.now();
            }
          } else {
            const clash = c.ports.map((p) => D.portInUse(p.host, c)).find(Boolean);
            if (clash)
              return fail(
                `Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${c.ports.find((p) => D.portInUse(p.host, c)).host} failed: port is already allocated\nError: failed to start containers: ${n}`,
              );
            c.logs = [];
            D.start(c);
          }
          w.emit(`docker ${sub} ${c.name} → ${c.status}`, c.status === "running" || sub !== "start" ? "INFO" : "WARN");
          out.push(n);
        }
        return ok(out.join("\n"));
      }
      case "rm": {
        const a = U.args(rest, VF);
        const out = [];
        for (const n of a.pos) {
          const c = D.byName(n);
          if (!c) return fail(`Error response from daemon: No such container: ${n}`);
          if (c.status === "running" && !a.flags.f && !a.flags.force)
            return fail(
              `Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`,
            );
          D.containers = D.containers.filter((x) => x !== c);
          out.push(n);
        }
        return ok(out.join("\n"));
      }
      case "rmi": {
        const a = U.args(rest, VF);
        const out = [];
        for (const r of a.pos) {
          const img = D.findImage(r);
          if (!img) return fail(`Error response from daemon: No such image: ${r}`);
          const user = D.containers.find((c) => c.imageRef === img.ref);
          if (user && !a.flags.f)
            return fail(
              `Error response from daemon: conflict: unable to remove repository reference "${r}" (must force) - container ${user.id.slice(0, 12)} is using its referenced image ${img.id}`,
            );
          D.images = D.images.filter((i) => i !== img);
          out.push(`Untagged: ${img.ref}`, `Deleted: sha256:${U.hex("sha" + img.id, 64)}`);
        }
        return ok(out.join("\n"));
      }
      case "logs": {
        const a = U.args(rest, VF);
        const c = D.byName(a.pos[0] || "");
        if (!c) return fail(`Error response from daemon: No such container: ${a.pos[0] || ""}`);
        let lines = c.logs.concat(c.access);
        const tail = U.first(a.flags.tail || a.flags.n);
        if (tail) lines = lines.slice(-Number(tail));
        return ok(
          lines.join("\n") + (a.flags.f ? IG.t("\nℹ -f（フォロー）は未対応のため現在までのログを表示しました。") : ""),
        );
      }
      case "inspect": {
        const n = rest.find((x) => !x.startsWith("-"));
        const c = D.byName(n || "");
        if (c)
          return ok(
            JSON.stringify(
              [
                {
                  Id: c.id,
                  Created: new Date(c.created).toISOString(),
                  State: { Status: c.status, Running: c.status === "running", ExitCode: c.exitCode || 0 },
                  Image: "sha256:" + U.hex("sha" + c.meta.imageId, 64),
                  Name: "/" + c.name,
                  Config: {
                    Image: c.imageRef,
                    Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`),
                    Cmd: c.cmd.length ? c.cmd : c.meta.cmd || null,
                    ExposedPorts: c.meta.port ? { [`${c.meta.port}/tcp`]: {} } : {},
                  },
                  NetworkSettings: {
                    Networks: { [c.network]: { IPAddress: "172.18.0." + (2 + D.containers.indexOf(c)) } },
                    Ports: Object.fromEntries(
                      c.ports.map((p) => [`${p.container}/tcp`, [{ HostIp: "0.0.0.0", HostPort: String(p.host) }]]),
                    ),
                  },
                },
              ],
              null,
              4,
            ),
          );
        const img = D.findImage(n || "");
        if (img)
          return ok(
            JSON.stringify(
              [
                {
                  Id: "sha256:" + U.hex("sha" + img.id, 64),
                  RepoTags: [img.ref],
                  Created: new Date(img.created).toISOString(),
                  Config: {
                    Env: Object.entries(img.meta.env || {}).map(([k, v]) => `${k}=${v}`),
                    Cmd: img.meta.cmd || null,
                    ExposedPorts:
                      img.meta.expose || img.meta.port ? { [`${img.meta.expose || img.meta.port}/tcp`]: {} } : {},
                    User: img.meta.root === false ? "101" : "",
                  },
                },
              ],
              null,
              4,
            ),
          );
        return fail(`Error: No such object: ${n}`);
      }
      case "exec": {
        const a = U.args(rest, VF);
        const c = D.byName(a.pos[0] || "");
        if (!c) return fail(`Error response from daemon: No such container: ${a.pos[0] || ""}`);
        if (c.status !== "running") return fail(`Error response from daemon: container ${c.id} is not running`);
        const cmd = a.pos.slice(1);
        if (!cmd.length) return fail('"docker exec" requires at least 2 arguments.');
        if (/^(\/bin\/)?(ba)?sh$/.test(cmd[0]) && cmd.length === 1)
          return fail(
            IG.t(`ℹ 対話シェルは未対応です。例: docker exec {0} env / docker exec {1} curl -s http://localhost:{2}/`, {
              0: c.name,
              1: c.name,
              2: c.rt.port,
            }),
          );
        return ctx.shell.runArgv(cmd[0] === "sh" && cmd[1] === "-c" ? IG.shellWords(cmd.slice(2).join(" ")) : cmd, {
          container: { name: c.name, env: c.env },
        });
      }
      case "tag": {
        const [src, dst] = rest;
        if (!src || !dst) return fail('"docker tag" requires exactly 2 arguments.');
        const img = D.findImage(src);
        if (!img) return fail(`Error response from daemon: No such image: ${src}`);
        D.addLocal(dst, U.clone(img.meta), img.created).id = img.id;
        return ok("");
      }
      case "login": {
        const a = U.args(rest, VF);
        const host = a.pos[0] || "docker.io";
        const u = U.first(a.flags.u || a.flags.username);
        let p = U.first(a.flags.p || a.flags.password);
        if (a.flags["password-stdin"]) p = (ctx.stdin || "").trim();
        if (!u || !p)
          return fail(
            IG.t(
              "ℹ 対話入力は未対応です。docker login <registry> -u <user> -p <password>（または --password-stdin）を使ってください。",
            ),
          );
        const warn =
          a.flags.p || a.flags.password
            ? "WARNING! Using --password via the CLI is insecure. Use --password-stdin.\n"
            : "";
        if (w.harbor && host === w.harbor.host) {
          if (!w.harbor.auth(u, p))
            return fail(
              `${warn}Error response from daemon: Get "https://${host}/v2/": unauthorized: authentication required`,
            );
          D.logins[host] = { username: u, password: p };
          w.emit(`docker login ${host} as ${u}`);
          return ok(
            `${warn}WARNING! Your password will be stored unencrypted in /home/operator/.docker/config.json.\nConfigure a credential helper to remove this warning. See\nhttps://docs.docker.com/engine/reference/commandline/login/#credential-stores\n\nLogin Succeeded`,
          );
        }
        return fail(
          IG.t(
            `{0}Error response from daemon: Get "https://{1}/v2/": dial tcp: lookup {2}: no such host\n\nℹ この訓練環境はインターネットに出られません。社内レジストリ（Harbor）を使ってください。`,
            { 0: warn, 1: host === "docker.io" ? "registry-1.docker.io" : host, 2: host },
          ),
        );
      }
      case "logout": {
        const host = rest[0] || "docker.io";
        delete D.logins[host];
        return ok(`Removing login credentials for ${host}`);
      }
      case "push": {
        const ref = rest.find((x) => !x.startsWith("-"));
        if (!ref) return fail('"docker push" requires exactly 1 argument.');
        const img = D.findImage(ref);
        const p = IG.images.parse(ref);
        if (!img)
          return fail(
            `An image does not exist locally with the tag: ${p.host ? p.full.replace(/:latest$/, "") : p.name}`,
          );
        if (!p.host)
          return fail(
            IG.t(
              `The push refers to repository [docker.io/library/{0}]\n{1}: Preparing\ndenied: requested access to the resource is denied\n\nℹ Docker Hub ではなく社内レジストリに push するには、先に docker tag で <registry>/<project>/<repo>:<tag> 形式の名前を付けます。`,
              { 0: p.name, 1: U.hex(ref, 12) },
            ),
          );
        if (!w.harbor || p.host !== w.harbor.host)
          return fail(
            `The push refers to repository [${p.host}/${p.name}]\nGet "https://${p.host}/v2/": dial tcp: lookup ${p.host}: no such host`,
          );
        const r = w.harbor.push(p, D.logins[p.host], img.meta);
        const layers = [U.hex(ref + "l1", 12), U.hex(ref + "l2", 12), U.hex(img.meta.base || "base", 12)];
        if (!r.ok)
          return fail(
            `The push refers to repository [${p.host}/${p.name}]\n${layers.map((l) => l + ": Preparing").join("\n")}\n${r.error}`,
          );
        w.emit(`docker push ${p.full} (${r.digest.slice(0, 19)}…)`);
        return ok(
          `The push refers to repository [${p.host}/${p.name}]\n${layers.map((l, i) => l + (i === 2 && r.mounted ? ": Mounted from library/base" : ": Pushed")).join("\n")}\n${p.tag}: digest: ${r.digest} size: 1789`,
        );
      }
      case "build":
      case "buildx": {
        const args = sub === "buildx" ? rest.slice(1) : rest;
        const a = U.args(args, VF);
        const ctxPath = a.pos[0];
        if (!ctxPath)
          return fail(
            "ERROR: \"docker buildx build\" requires exactly 1 argument.\nSee 'docker buildx build --help'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -",
          );
        const dir = ctx.resolve(ctxPath);
        if (!ctx.vfs.isDir(dir)) return fail(`ERROR: unable to prepare context: path "${ctxPath}" not found`);
        const df = U.first(a.flags.f || a.flags.file);
        const tag = U.first(a.flags.t || a.flags.tag);
        const r = D.build(dir, df ? ctx.resolve(df) : dir.replace(/\/$/, "") + "/Dockerfile", tag, ctx.vfs);
        if (r.error) return fail(r.error);
        w.emit(`docker build → ${tag || "<none>"}`);
        return ok(r.out);
      }
      case "network":
        if (rest[0] === "ls")
          return ok(
            U.table(
              ["NETWORK ID", "NAME", "DRIVER", "SCOPE"],
              D.networks.map((n) => [
                U.hex("net" + n, 12),
                n,
                n === "host" ? "host" : n === "none" ? "null" : "bridge",
                "local",
              ]),
            ),
          );
        return fail(IG.t("ℹ docker network は ls のみ対応しています。"));
      case "compose":
        return compose(rest, ctx);
      case "stats":
      case "top":
      case "system":
        return fail(IG.t(`ℹ docker {0} はこのシミュレータでは未対応です。`, { 0: sub }));
      default:
        return fail(`docker: '${sub}' is not a docker command.\nSee 'docker --help'`);
    }
  }

  function cmdText(c) {
    const parts = c.cmd.length
      ? c.cmd
      : c.meta.cmd ||
        (c.meta.kind === "web" ? ["/docker-entrypoint.…"] : c.meta.kind === "db" ? ["docker-entrypoint.s…"] : ["sh"]);
    const t = parts.join(" ");
    return t.length > 22 ? t.slice(0, 21) + "…" : t;
  }
  function createdText(w, at) {
    const s = Math.max(1, Math.floor((w.now() - at) / 1000));
    return s < 60
      ? `${s} seconds ago`
      : s < 3600
        ? `${Math.floor(s / 60)} minutes ago`
        : s < 172800
          ? `${Math.floor(s / 3600)} hours ago`
          : `${Math.floor(s / 86400)} days ago`;
  }

  function dockerRun(rest, ctx) {
    const w = ctx.world,
      D = w.docker;
    // options stop at the image name
    const opts = [],
      cmd = [];
    let image = null;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (image) {
        cmd.push(x);
        continue;
      }
      if (x.startsWith("-")) {
        opts.push(x);
        const key = x.replace(/^-+/, "").split("=")[0];
        if (
          !x.includes("=") &&
          [
            "name",
            "p",
            "publish",
            "e",
            "env",
            "network",
            "env-file",
            "restart",
            "w",
            "workdir",
            "entrypoint",
            "platform",
            "v",
            "volume",
            "m",
            "memory",
          ].includes(key)
        )
          opts.push(rest[++i]);
        continue;
      }
      image = x;
    }
    if (!image) return fail("\"docker run\" requires at least 1 argument.\nSee 'docker run --help'.");
    const a = U.args(opts, VF.concat(["v", "volume", "m", "memory"]));
    const name =
      U.first(a.flags.name) ||
      ["eager", "quirky", "brave", "calm", "zen"][U.hash(image + D.seq) % 5] +
        "_" +
        ["turing", "hopper", "lovelace", "ritchie", "torvalds"][U.hash(image + D.seq + 1) % 5];
    if (D.containers.find((c) => c.name === name)) {
      const ex = D.containers.find((c) => c.name === name);
      return fail(
        `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${ex.id}". You have to remove (or rename) that container to be able to reuse that name.\nSee 'docker run --help'.`,
      );
    }
    const ports = [];
    for (const p of U.list(a.flags.p || a.flags.publish)) {
      const parts = String(p).split(":");
      if (parts.length < 2 || parts.some((x) => !/^\d+$/.test(x.replace("/tcp", ""))))
        return fail(
          IG.t(
            `docker: invalid publish opts format (should be name=value but no = found)\nℹ -p <ホスト側ポート>:<コンテナ側ポート> の形式で指定します（例: -p 8080:80）`,
          ),
        );
      ports.push({
        host: Number(parts[parts.length - 2]),
        container: Number(parts[parts.length - 1].replace("/tcp", "")),
      });
    }
    const env = {};
    for (const kv of U.list(a.flags.e || a.flags.env)) {
      const i = kv.indexOf("=");
      if (i < 0) continue;
      env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    for (const f of U.list(a.flags["env-file"])) {
      const content = ctx.vfs.read(ctx.resolve(f));
      if (content === undefined) return fail(`docker: open ${f}: no such file or directory.`);
      for (const line of content.split("\n")) {
        const m = line.match(/^\s*([A-Za-z_]\w*)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    }
    const out = [];
    let img = D.findImage(image);
    if (!img) {
      const p = IG.images.parse(image);
      out.push(`Unable to find image '${p.host ? p.full : p.short}' locally`);
      const r = D.pull(image);
      if (!r.ok)
        return fail(
          out
            .concat(
              `docker: Error response from daemon: ${r.reason === "notfound" ? `manifest for ${p.full} not found: manifest unknown: manifest unknown` : r.error}.\nSee 'docker run --help'.`,
            )
            .join("\n"),
        );
      out.push(
        `${p.tag}: Pulling from ${p.host ? p.name : "library/" + p.name}`,
        `${U.hex(image, 12)}: Pull complete`,
        `Digest: ${IG.images.digest(image)}`,
        `Status: Downloaded newer image for ${p.host ? p.full : p.short}`,
      );
      img = r.image;
    }
    for (const p of ports) {
      const clash = D.portInUse(p.host);
      if (clash) {
        const c = D.create({ name, image: img, env, ports, network: U.first(a.flags.network) || "bridge", cmd });
        return fail(
          out
            .concat(
              `${c.id}\ndocker: Error response from daemon: driver failed programming external connectivity on endpoint ${name} (${U.hex(name, 64)}): Bind for 0.0.0.0:${p.host} failed: port is already allocated.`,
            )
            .join("\n"),
        );
      }
    }
    const c = D.create({ name, image: img, env, ports, network: U.first(a.flags.network) || "bridge", cmd });
    D.start(c);
    w.emit(
      `docker run ${name} (${img.ref}) → ${c.status}`,
      c.status === "running" || c.meta.kind === "tool" ? "INFO" : "WARN",
    );
    if (a.flags.rm && c.status !== "running") D.containers = D.containers.filter((x) => x !== c);
    if (!a.flags.d && !a.flags.detach) {
      if (c.meta.kind === "tool") {
        if (cmd.length) {
          const r = ctx.shell.runArgv(cmd, { container: { name: c.name, env: c.env } });
          return { out: out.concat(r.out).filter(Boolean).join("\n"), code: r.code };
        }
        return ok(out.join("\n"));
      }
      if (c.status !== "running") return { out: out.concat(c.logs).join("\n"), code: c.exitCode };
      return ok(
        out
          .concat(
            c.logs,
            "",
            IG.t(
              `ℹ フォアグラウンド実行はシミュレータでは保持できないため、バックグラウンド（-d 相当）で起動しました。`,
            ),
          )
          .join("\n"),
      );
    }
    return ok(out.concat(c.id).join("\n"));
  }

  function compose(rest, ctx) {
    const w = ctx.world,
      D = w.docker;
    const a = U.args(rest, VF);
    const sub = a.pos[0];
    if (!sub)
      return ok(
        "Usage:  docker compose [OPTIONS] COMMAND\n\nCommands:\n  up        Create and start containers (-d)\n  down      Stop and remove containers, networks\n  ps        List containers (-a for all)\n  logs      View output from containers\n  restart   Restart service containers\n  config    Parse, resolve and render compose file",
      );
    const cfg = D.loadCompose(ctx, U.first(a.flags.f || a.flags.file));
    if (cfg.error) return fail(cfg.error);
    const net = `${cfg.project}_default`;
    const cname = (s) => s.containerName || `${cfg.project}-${s.name}-1`;
    const mine = () => D.containers.filter((c) => c.project === cfg.project);
    const only = a.pos.slice(1);
    const targets = cfg.services.filter((s) => !only.length || only.includes(s.name));
    switch (sub) {
      case "config":
        return ok(
          IG.yaml
            .stringify({
              name: cfg.project,
              services: Object.fromEntries(
                cfg.services.map((s) => [
                  s.name,
                  Object.assign(
                    {},
                    s.image ? { image: s.image } : { build: s.build },
                    Object.keys(s.env).length ? { environment: s.env } : {},
                    s.ports.length
                      ? {
                          ports: s.ports.map((p) => ({
                            mode: "ingress",
                            target: p.container,
                            published: String(p.host),
                            protocol: "tcp",
                          })),
                        }
                      : {},
                    s.deps.length ? { depends_on: s.deps } : {},
                  ),
                ]),
              ),
              networks: { default: { name: net } },
            })
            .trimEnd(),
        );
      case "up": {
        const lines = [],
          kept = new Set();
        if (!D.networks.includes(net)) {
          D.networks.push(net);
          lines.push(` ✔ Network ${net}  Created`);
        }
        for (const s of targets) {
          let img;
          if (s.build) {
            const dir = IG.VFS.norm(typeof s.build === "string" ? s.build : s.build.context || ".", cfg.dir);
            const r = D.build(
              dir,
              dir.replace(/\/$/, "") + "/" + ((s.build && s.build.dockerfile) || "Dockerfile"),
              s.image || `${cfg.project}-${s.name}`,
              ctx.vfs,
            );
            if (r.error) return fail(r.error);
            img = r.image;
          } else {
            img = D.findImage(s.image);
            if (!img) {
              const r = D.pull(s.image);
              if (!r.ok)
                return fail(
                  `${lines.join("\n")}\n ✘ ${s.name} Error  ${r.error}\nError response from daemon: pull access denied for ${s.image}`,
                );
              img = r.image;
              lines.push(` ✔ ${s.name} Pulled`);
            }
          }
          const existing = D.containers.find((c) => c.name === cname(s));
          const same =
            existing &&
            existing.imageRef === img.ref &&
            JSON.stringify(existing.env) === JSON.stringify(Object.assign({}, img.meta.env || {}, s.env)) &&
            JSON.stringify(existing.ports) === JSON.stringify(s.ports);
          if (same && existing.status === "running") {
            lines.push(` ✔ Container ${cname(s)}  Running`);
            kept.add(cname(s));
            continue;
          }
          if (existing) D.containers = D.containers.filter((c) => c !== existing);
          for (const p of s.ports) {
            const clash = D.portInUse(p.host);
            if (clash)
              return fail(
                `${lines.join("\n")}\nError response from daemon: driver failed programming external connectivity on endpoint ${cname(s)}: Bind for 0.0.0.0:${p.host} failed: port is already allocated`,
              );
          }
          const c = D.create({
            name: cname(s),
            image: img,
            env: s.env,
            ports: s.ports,
            network: net,
            project: cfg.project,
            service: s.name,
            cmd: s.command ? [].concat(s.command) : [],
          });
          D.start(c);
          lines.push(` ✔ Container ${cname(s)}  ${existing ? "Recreated" : "Created"}`);
        }
        const started = targets.map((s) => D.byName(cname(s))).filter(Boolean);
        started.filter((c) => !kept.has(c.name)).forEach((c) => lines.push(` ✔ Container ${c.name}  Started`));
        w.emit(
          `docker compose up (${cfg.project}): ${started.map((c) => `${c.service}=${c.status}`).join(", ")}`,
          started.every((c) => c.status === "running") ? "INFO" : "WARN",
        );
        const head = `[+] Running ${lines.length}/${lines.length}`;
        let txt = [head, ...lines].join("\n");
        if (!a.flags.d && !a.flags.detach)
          txt += IG.t(
            "\nℹ フォアグラウンド実行は保持できないため -d 相当で起動しました。ログは docker compose logs で確認できます。",
          );
        return ok(txt);
      }
      case "down": {
        const cs = mine();
        D.containers = D.containers.filter((c) => c.project !== cfg.project);
        D.networks = D.networks.filter((n) => n !== net);
        return ok(
          `[+] Running ${cs.length + 1}/${cs.length + 1}\n${cs.map((c) => ` ✔ Container ${c.name}  Removed`).join("\n")}\n ✔ Network ${net}  Removed`,
        );
      }
      case "ps": {
        const cs = mine().filter((c) => a.flags.a || a.flags.all || c.status === "running");
        return ok(
          U.table(
            ["NAME", "IMAGE", "COMMAND", "SERVICE", "CREATED", "STATUS", "PORTS"],
            cs.map((c) => [
              c.name,
              c.imageRef,
              `"${cmdText(c)}"`,
              c.service,
              createdText(w, c.created),
              D.statusText(c),
              D.portsText(c),
            ]),
          ),
        );
      }
      case "logs": {
        const cs = mine().filter((c) => !only.length || only.includes(c.service));
        if (!cs.length) return ok("");
        const width = Math.max(...cs.map((c) => c.name.length));
        return ok(cs.flatMap((c) => c.logs.concat(c.access).map((l) => `${c.name.padEnd(width)}  | ${l}`)).join("\n"));
      }
      case "restart":
      case "start":
      case "stop": {
        const cs = mine().filter((c) => !only.length || only.includes(c.service));
        for (const c of cs) {
          if (sub === "stop") {
            c.status = "exited";
            c.exitCode = 0;
          } else {
            c.logs = [];
            D.start(c);
          }
        }
        return ok(
          `[+] ${sub === "stop" ? "Stopping" : "Restarting"} ${cs.length}/${cs.length}\n${cs.map((c) => ` ✔ Container ${c.name}  ${sub === "stop" ? "Stopped" : "Started"}`).join("\n")}`,
        );
      }
      default:
        return fail(`unknown docker command: "compose ${sub}"`);
    }
  }

  IG.Docker = Docker;
  IG.commands.docker = docker;
  IG.commands["docker-compose"] = (argv, ctx) => compose(argv, ctx);
  IG.dockerVerbs = [
    "run",
    "ps",
    "images",
    "pull",
    "push",
    "build",
    "tag",
    "login",
    "logout",
    "logs",
    "exec",
    "start",
    "stop",
    "restart",
    "rm",
    "rmi",
    "inspect",
    "compose",
    "version",
    "info",
    "network",
  ];
})((globalThis.IG = globalThis.IG || {}));
