/* Image catalog and container runtime behaviour shared by Docker and Kubernetes simulations.
 * All image data is fictional teaching data (vulnerability counts, sizes, digests). */
(function (IG) {
  "use strict";
  const U = IG.util;

  const V = (critical, high, medium, low) => ({ critical, high, medium, low });
  const NGINX_ROOT_FAIL = [
    "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
    '2026/10/24 01:12:09 [warn] 1#1: the "user" directive makes sense only if the master process runs with super-user privileges, ignored in /etc/nginx/nginx.conf:2',
    'nginx: [emerg] mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)',
  ];

  // Base catalog: "public" images reachable from every simulated host.
  const base = {
    "nginx:1.27": {
      kind: "web",
      port: 80,
      root: true,
      size: "192MB",
      vulns: V(0, 1, 5, 22),
      server: "nginx/1.27.2",
      rootFailLog: NGINX_ROOT_FAIL,
    },
    "nginx:1.25": {
      kind: "web",
      port: 80,
      root: true,
      size: "187MB",
      vulns: V(1, 6, 14, 30),
      server: "nginx/1.25.5",
      rootFailLog: NGINX_ROOT_FAIL,
    },
    "nginxinc/nginx-unprivileged:1.27": {
      kind: "web",
      port: 8080,
      root: false,
      size: "193MB",
      vulns: V(0, 1, 5, 22),
      server: "nginx/1.27.2",
    },
    "httpd:2.4": {
      kind: "web",
      port: 80,
      root: true,
      size: "148MB",
      vulns: V(0, 2, 6, 19),
      server: "Apache/2.4.62",
      rootFailLog: [
        "(13)Permission denied: AH00072: make_sock: could not bind to address [::]:80",
        "AH00015: Unable to open logs",
      ],
    },
    "redis:7": { kind: "cache", port: 6379, root: false, size: "117MB", vulns: V(0, 0, 2, 11) },
    "postgres:16": {
      kind: "db",
      port: 5432,
      root: true,
      size: "432MB",
      vulns: V(0, 1, 4, 25),
      requiresEnv: ["POSTGRES_PASSWORD"],
      missingEnvLog: [
        "Error: Database is uninitialized and superuser password is not specified.",
        "       You must specify POSTGRES_PASSWORD to a non-empty value for the",
        '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".',
      ],
      startLogs: [
        "PostgreSQL init process complete; ready for start up.",
        "LOG:  database system is ready to accept connections",
      ],
    },
    "busybox:1.36": { kind: "tool", size: "4.3MB", vulns: V(0, 0, 0, 1) },
    "alpine:3.20": { kind: "tool", size: "7.8MB", vulns: V(0, 0, 0, 0) },
    "curlimages/curl:8.10.1": { kind: "tool", size: "22MB", vulns: V(0, 0, 0, 0) },
    "python:3.8": { kind: "runtime", runtime: "python", size: "997MB", vulns: V(4, 27, 63, 140) },
    "python:3.12-slim": { kind: "runtime", runtime: "python", size: "124MB", vulns: V(0, 0, 3, 19) },
    "node:20-alpine": { kind: "runtime", runtime: "node", size: "135MB", vulns: V(0, 0, 1, 2) },
  };
  const aliases = {
    "nginx:latest": "nginx:1.27",
    "nginx:stable": "nginx:1.27",
    "httpd:latest": "httpd:2.4",
    "redis:latest": "redis:7",
    "postgres:latest": "postgres:16",
    "busybox:latest": "busybox:1.36",
    "alpine:latest": "alpine:3.20",
    "nginxinc/nginx-unprivileged:latest": "nginxinc/nginx-unprivileged:1.27",
    "python:latest": "python:3.12-slim",
    "python:3.12": "python:3.12-slim",
    "curlimages/curl:latest": "curlimages/curl:8.10.1",
  };

  IG.images = {
    baseCatalog() {
      const out = {};
      for (const [ref, meta] of Object.entries(base))
        out[ref] = Object.assign({ ref, vulns: V(0, 0, 0, 0) }, U.clone(meta));
      return out;
    },
    aliases,
    // Parse "host/path/name:tag" into parts. Docker Hub library images have no host.
    parse(ref) {
      let r = String(ref || "").trim();
      let digest = null;
      if (r.includes("@")) [r, digest] = r.split("@");
      const slash = r.indexOf("/");
      let host = null;
      if (slash > 0 && /[.:]|^localhost$/.test(r.slice(0, slash))) {
        host = r.slice(0, slash);
        r = r.slice(slash + 1);
      }
      const colon = r.lastIndexOf(":");
      let name = r,
        tag = "latest";
      if (colon > 0) {
        name = r.slice(0, colon);
        tag = r.slice(colon + 1);
      }
      if (host === "docker.io") {
        host = null;
        name = name.replace(/^library\//, "");
      }
      return { host, name, tag, digest, short: `${name}:${tag}`, full: (host ? host + "/" : "") + `${name}:${tag}` };
    },
    id(ref) {
      return U.hex("img:" + ref, 12);
    },
    digest(ref) {
      return "sha256:" + U.hex("digest:" + ref, 64);
    },
  };

  /* Runtime: decide whether a container built from `meta` starts, given env and platform. */
  IG.runtime = {
    evaluate(meta, opts = {}) {
      const env = Object.assign({}, meta.env || {}, opts.env || {});
      const crash = (code, logs) => ({ ok: false, exitCode: code, logs, reason: "Error" });
      if (meta.kind === "tool" && !opts.command)
        return { ok: false, completed: true, exitCode: 0, logs: [], reason: "Completed" };
      if (meta.cmdMissing)
        return crash(2, [`python: can't open file '/app/${meta.cmdMissing}': [Errno 2] No such file or directory`]);
      for (const k of meta.requiresEnv || []) {
        if (!env[k]) {
          return crash(
            1,
            meta.missingEnvLog || [
              "Traceback (most recent call last):",
              `  File "/app/${meta.entry || "app.py"}", line 7, in <module>`,
              `    ${k.toLowerCase()} = os.environ["${k}"]`,
              "                 ~~~~~~~~~~^^^^^^^^^^^^",
              `KeyError: '${k}'`,
            ],
          );
        }
      }
      for (const k of meta.hostEnv || []) {
        if (env[k] && opts.resolveHost && !opts.resolveHost(env[k])) {
          return crash(1, [
            `${new Date(IG.clock.now()).toISOString()} INFO starting ${meta.app || "app"}`,
            `psycopg.OperationalError: could not translate host name "${env[k]}" to address: Name or service not known`,
          ]);
        }
      }
      if (opts.openshift && meta.root && !opts.anyuid)
        return crash(1, meta.rootFailLog || ["exec /entrypoint.sh: permission denied"]);
      const port = meta.portEnv && env[meta.portEnv] ? Number(env[meta.portEnv]) : meta.port;
      const logs = meta.startLogs ? meta.startLogs.slice() : defaultStart(meta, port);
      return { ok: true, port, logs };
    },
    // HTTP response for a request that reached a running container.
    respond(meta, path, ctx = {}) {
      const p = (path || "/").split("?")[0];
      if (meta.kind === "web") {
        if (p === "/" || p === "/index.html") {
          return {
            status: 200,
            server: meta.server,
            body:
              meta.body ||
              "<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and working.</p>\n</body>\n</html>",
          };
        }
        return {
          status: 404,
          server: meta.server,
          body: "<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n</body>\n</html>",
        };
      }
      if (meta.kind === "app") {
        const name = meta.app || "app";
        if (p === "/health" || p === "/healthz" || p === "/readyz")
          return { status: 200, body: JSON.stringify({ status: "ok", service: name, instance: ctx.instance || name }) };
        if (p === "/")
          return {
            status: 200,
            body: JSON.stringify({
              service: name,
              version: meta.version || "1.0.0",
              instance: ctx.instance || name,
              message: meta.message || "hello from " + name,
            }),
          };
        return { status: 404, body: JSON.stringify({ error: "not found", path: p }) };
      }
      return null; // non-HTTP service
    },
  };

  function defaultStart(meta, port) {
    if (meta.kind === "web")
      return [
        "/docker-entrypoint.sh: Configuration complete; ready for start up",
        `${meta.server ? meta.server.split("/")[0] : "web"}: listening on 0.0.0.0:${port}`,
      ];
    if (meta.kind === "cache") return ["* Ready to accept connections tcp"];
    if (meta.kind === "app")
      return [`INFO  starting ${meta.app || "app"} ${meta.version || ""}`.trim(), `INFO  listening on 0.0.0.0:${port}`];
    return [];
  }
})((globalThis.IG = globalThis.IG || {}));
