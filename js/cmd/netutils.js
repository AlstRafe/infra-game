/* Networking: ip ifconfig route arp netstat ss ping traceroute tracepath dig nslookup host curl
 * wget nc telnet ssh scp rsync ssh-keygen ssh-copy-id ufw iptables firewall-cmd tcpdump nmap. */
(function (IG) {
  "use strict";
  const U = IG.util;
  const VFS = IG.VFS;
  const C = (IG.commands = IG.commands || {});
  const opts = (...a) => IG.cliOpts(...a);
  const out = () => IG.cliOut();
  const join = (l) => (l.length ? l.join("\n") + "\n" : "");
  const root = (ctx) => ctx.user === "root";

  /* ---------------- helpers */
  function ifaces(ctx) {
    const h = ctx.host;
    const list = [
      {
        name: "lo",
        idx: 1,
        flags: "LOOPBACK,UP,LOWER_UP",
        mtu: 65536,
        mac: "00:00:00:00:00:00",
        ip: "127.0.0.1",
        prefix: 8,
        type: "loopback",
        state: "UNKNOWN",
      },
      {
        name: h.os === "rhel" ? "ens5" : "eth0",
        idx: 2,
        flags: "BROADCAST,MULTICAST,UP,LOWER_UP",
        mtu: 9001,
        mac: h.mac,
        ip: h.ip,
        prefix: 24,
        type: "ether",
        state: "UP",
      },
    ];
    if (h.name === "bastion" && ctx.world.features.has("docker"))
      list.push({
        name: "docker0",
        idx: 3,
        flags: "NO-CARRIER,BROADCAST,MULTICAST,UP",
        mtu: 1500,
        mac: "02:42:" + U.hex("d0", 8).match(/../g).join(":"),
        ip: "172.17.0.1",
        prefix: 16,
        type: "ether",
        state: "DOWN",
      });
    return list;
  }
  function resolve(ctx, name) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name;
    return ctx.world.resolveName(name, ctx.from);
  }
  // target host object for an IP / name (Linux hosts only)
  function hostFor(ctx, name) {
    const w = ctx.world;
    const ip = resolve(ctx, name);
    return Object.values(w.hosts).find((h) => h.name === name || (ip && (h.ip === ip || h.publicIp === ip))) || null;
  }
  IG.tcpConnect = (...a) => tcpConnect(...a);
  function tcpConnect(ctx, name, port) {
    // returns {ok} | {refused} | {timeout} | {unresolved}
    const w = ctx.world;
    if (/^(localhost|127\.0\.0\.1)$/.test(name)) {
      const s = ctx.host.sockets().find((x) => x.port === port && x.proto.startsWith("tcp"));
      return s ? { ok: true, ip: "127.0.0.1", svc: s.svc } : { refused: true, ip: "127.0.0.1" };
    }
    const ip = resolve(ctx, name);
    if (!ip) return { unresolved: true };
    const h = hostFor(ctx, name);
    if (h) {
      if (h !== ctx.host && !h.firewallAllows(port, "tcp", ctx.host.ip)) return { timeout: true, ip };
      const s = h
        .sockets()
        .find((x) => x.port === port && x.proto.startsWith("tcp") && (h === ctx.host || !x.addr.startsWith("127.")));
      return s ? { ok: true, ip, svc: s.svc, host: h } : { refused: true, ip };
    }
    // other simulated endpoints: reuse the HTTP router to decide reachability
    const r = w.route(
      { scheme: port === 443 ? "https" : "http", host: name, port, path: "/", method: "HEAD" },
      ctx.from,
    );
    if (!r) return { timeout: true, ip };
    if (r.error && /Timeout/.test(r.error)) return { timeout: true, ip };
    if (r.error && /Couldn't connect|refused/.test(r.error)) return { refused: true, ip };
    return { ok: true, ip };
  }
  const SVC_NAME = {
    22: "ssh",
    80: "http",
    443: "https",
    53: "domain",
    3306: "mysql",
    5432: "postgresql",
    6379: "redis",
    6443: "sun-sr-https",
    8080: "http-alt",
    10250: "*",
  };

  /* ================================================================ ip / ifconfig / route */
  C.ip = (argv, ctx) => {
    const flags = argv.filter((a) => /^-/.test(a));
    const pos = argv.filter((a) => !/^-/.test(a));
    const obj = pos[0] || "help";
    const sub = pos[1] || "show";
    const br = flags.some((f) => /^-br(ief)?$/.test(f));
    const v4 = flags.includes("-4");
    const ifs = ifaces(ctx);
    const h = ctx.host;
    if (/^(set|add|del|delete|change|replace|flush)$/.test(sub) || /^(set|add|del)$/.test(pos[2] || ""))
      return root(ctx)
        ? {
            stdout: "",
            stderr: IG.t(
              "ℹ ネットワーク設定の変更はこのシミュレータでは保持しません（netplan / nmcli での恒久設定も未対応）。\n",
            ),
            code: 1,
          }
        : { stdout: "", stderr: "RTNETLINK answers: Operation not permitted\n", code: 2 };
    if (/^a(ddr(ess)?)?$/.test(obj)) {
      const sel =
        pos[2] === "dev"
          ? ifs.filter((i) => i.name === pos[3])
          : pos[1] && pos[1] !== "show"
            ? ifs.filter((i) => i.name === pos[1])
            : ifs;
      if (br)
        return join(
          sel.map(
            (i) =>
              `${i.name.padEnd(16)} ${i.state.padEnd(14)} ${i.ip}/${i.prefix} ${i.name === "lo" ? "::1/128" : "fe80::" + i.mac.slice(-8).replace(/:/g, "") + "/64"}`,
          ),
        );
      return join(
        sel.flatMap((i) =>
          [
            `${i.idx}: ${i.name}: <${i.flags}> mtu ${i.mtu} qdisc ${i.name === "lo" ? "noqueue" : "mq"} state ${i.state} group default qlen 1000`,
            `    link/${i.type} ${i.mac} brd ${i.type === "loopback" ? "00:00:00:00:00:00" : "ff:ff:ff:ff:ff:ff"}`,
            `    inet ${i.ip}/${i.prefix} ${i.name === "lo" ? "scope host lo" : `${i.name === "docker0" ? "brd 172.17.255.255" : "metric 100 brd 10.0.1.255"} scope global ${i.name === "docker0" ? "" : "dynamic "}${i.name}`}`,
            `       valid_lft ${i.name === "eth0" || i.name === "ens5" ? "3172sec preferred_lft 3172sec" : "forever preferred_lft forever"}`,
          ].concat(
            v4
              ? []
              : [
                  `    inet6 ${i.name === "lo" ? "::1/128 scope host" : `fe80::${i.mac.slice(-8).replace(/:/g, "")}/64 scope link`}`,
                  "       valid_lft forever preferred_lft forever",
                ],
          ),
        ),
      );
    }
    if (/^l(ink)?$/.test(obj))
      return join(
        ifs.flatMap((i) =>
          br
            ? [`${i.name.padEnd(16)} ${i.state.padEnd(14)} ${i.mac} <${i.flags}>`]
            : [
                `${i.idx}: ${i.name}: <${i.flags}> mtu ${i.mtu} qdisc ${i.name === "lo" ? "noqueue" : "mq"} state ${i.state} mode DEFAULT group default qlen 1000`,
                `    link/${i.type} ${i.mac} brd ${i.type === "loopback" ? "00:00:00:00:00:00" : "ff:ff:ff:ff:ff:ff"}`,
              ],
        ),
      );
    if (/^r(oute)?$/.test(obj)) {
      const dev = ifs[1].name;
      if (sub === "get") {
        const ip = resolve(ctx, pos[2]) || pos[2];
        return `${ip} via 10.0.1.1 dev ${dev} src ${h.ip} uid ${(h.users[ctx.user] || { uid: 0 }).uid} \n    cache `;
      }
      return join(
        [
          `default via 10.0.1.1 dev ${dev} proto dhcp src ${h.ip} metric 100`,
          `10.0.0.2 via 10.0.1.1 dev ${dev} proto dhcp src ${h.ip} metric 100`,
          `10.0.1.0/24 dev ${dev} proto kernel scope link src ${h.ip} metric 100`,
          `10.0.1.1 dev ${dev} proto dhcp scope link src ${h.ip} metric 100`,
        ].concat(
          ifs.find((i) => i.name === "docker0")
            ? ["172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown"]
            : [],
        ),
      );
    }
    if (/^n(eigh(bour)?)?$/.test(obj))
      return `10.0.1.1 dev ${ifs[1].name} lladdr 0a:ff:${U.hex("gw", 8).match(/../g).join(":")} REACHABLE`;
    if (obj === "help" || obj === "-h")
      return "Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neigh | ... }\n       OPTIONS := { -4 | -6 | -br[ief] | -s[tatistics] | -c[olor] }";
    return { stdout: "", stderr: `Object "${obj}" is unknown, try "ip help".\n`, code: 1 };
  };
  C.ifconfig = (argv, ctx) =>
    join(
      ifaces(ctx).flatMap((i) => [
        `${i.name}: flags=${i.name === "lo" ? 73 : 4163}<${i.flags.replace("LOWER_UP", "RUNNING")}>  mtu ${i.mtu}`,
        `        inet ${i.ip}  netmask ${i.prefix === 8 ? "255.0.0.0" : i.prefix === 16 ? "255.255.0.0" : "255.255.255.0"}${i.name === "lo" ? "" : "  broadcast " + i.ip.replace(/\.\d+$/, ".255")}`,
        `        ${i.type === "loopback" ? "loop  txqueuelen 1000  (Local Loopback)" : `ether ${i.mac}  txqueuelen 1000  (Ethernet)`}`,
        `        RX packets ${100000 + (U.hash(i.name) % 900000)}  bytes ${U.hash(i.name + 1) % 900000000} (${U.hash(i.name + 1) % 900}.0 MB)`,
        `        TX packets ${90000 + (U.hash(i.name + 2) % 900000)}  bytes ${U.hash(i.name + 3) % 400000000} (${U.hash(i.name + 3) % 400}.0 MB)`,
        "",
      ]),
    );
  C.route = (argv, ctx) =>
    `Kernel IP routing table\nDestination     Gateway         Genmask         Flags Metric Ref    Use Iface\n0.0.0.0         10.0.1.1        0.0.0.0         UG    100    0        0 ${ifaces(ctx)[1].name}\n10.0.1.0        0.0.0.0         255.255.255.0   U     100    0        0 ${ifaces(ctx)[1].name}`;
  C.arp = (argv, ctx) =>
    `Address                  HWtype  HWaddress           Flags Mask            Iface\n_gateway                 ether   0a:ff:${U.hex("gw", 8).match(/../g).join(":")}   C                     ${ifaces(ctx)[1].name}`;

  /* ================================================================ ss / netstat */
  function socketRows(ctx, f) {
    const h = ctx.host;
    const rows = [];
    const showProc = f.p && root(ctx);
    for (const s of h.sockets()) {
      const udp = s.proto.startsWith("udp");
      if ((f.t && !f.u && udp) || (f.u && !f.t && !udp)) continue;
      if (!f.l && !f.a) continue;
      const local = (s.addr === "[::]" ? "[::]" : s.addr === "0.0.0.0" ? "0.0.0.0" : s.addr) + ":" + s.port;
      const same = rows.find((r) => r.local === local && r.proto === (udp ? "udp" : "tcp"));
      if (same) {
        same.users.push(`("${s.proc}",pid=${s.pid},fd=${6 + same.users.length})`);
        continue;
      }
      rows.push({
        proto: udp ? "udp" : "tcp",
        state: udp ? "UNCONN" : "LISTEN",
        local,
        peer: s.addr.includes(":") || s.addr.startsWith("[") ? "[::]:*" : "0.0.0.0:*",
        users: showProc || (f.p && s.pid && ctx.user !== "root" && false) ? [`("${s.proc}",pid=${s.pid},fd=6)`] : [],
        recvq: 0,
        sendq: udp ? 0 : s.svc === "nginx" ? 511 : 128,
        pid: s.pid,
        proc: s.proc,
      });
      if (s.svc === "nginx" && showProc)
        rows[rows.length - 1].users.push(`("nginx",pid=${s.pid + 1},fd=6)`, `("nginx",pid=${s.pid + 2},fd=6)`);
    }
    if (!f.l && (f.t || !f.u))
      ctx.shell.stack
        .filter((x) => x.host === h.name && !x.via)
        .forEach(() =>
          rows.push({
            proto: "tcp",
            state: "ESTAB",
            local: `${h.ip}:22`,
            peer: "198.51.100.20:51522",
            users: showProc ? [`("sshd",pid=4201,fd=4)`] : [],
            recvq: 0,
            sendq: 0,
          }),
        );
    return rows;
  }
  C.ss = (argv, ctx) => {
    const fl = new Set(
      argv
        .filter((a) => /^-\w+$/.test(a))
        .join("")
        .replace(/-/g, "")
        .split(""),
    );
    const f = { t: fl.has("t"), u: fl.has("u"), l: fl.has("l"), a: fl.has("a"), n: fl.has("n"), p: fl.has("p") };
    if (fl.has("s"))
      return `Total: ${180 + ctx.host.sockets().length}\nTCP:   ${8 + ctx.host.sockets().length} (estab 1, closed 2, orphaned 0, timewait 2)\n\nTransport Total     IP        IPv6\nRAW\t  1         0         1        \nUDP\t  4         3         1        \nTCP\t  ${6 + ctx.host.sockets().length}         ${4 + ctx.host.sockets().length}         2        \nINET\t  ${11 + ctx.host.sockets().length}         ${7 + ctx.host.sockets().length}         4        \nFRAG\t  0         0         0        `;
    if (!f.t && !f.u) {
      f.t = true;
      f.u = true;
      if (!f.l && !f.a) {
        f.u = false;
      }
    }
    let rows = socketRows(ctx, f);
    const filter = argv.filter((a) => !a.startsWith("-")).join(" ");
    const m = filter.match(/(sport|dport)\s*(=|==|eq)\s*:(\w+)/);
    if (m) {
      const port = /^\d+$/.test(m[3]) ? m[3] : Object.keys(SVC_NAME).find((k) => SVC_NAME[k] === m[3]);
      rows = rows.filter((r) => (m[1] === "sport" ? r.local : r.peer).endsWith(":" + port));
    }
    const name = (addr) =>
      f.n ? addr : addr.replace(/:(\d+)$/, (x, p) => ":" + (SVC_NAME[p] && SVC_NAME[p] !== "*" ? SVC_NAME[p] : p));
    const showNetid = f.t && f.u;
    const head =
      (showNetid ? "Netid " : "") +
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port" +
      (f.p ? "Process" : "");
    return join(
      [head].concat(
        rows.map(
          (r) =>
            (showNetid ? r.proto.padEnd(6) : "") +
            r.state.padEnd(7) +
            String(r.recvq).padEnd(7) +
            String(r.sendq).padEnd(7) +
            name(r.local).padStart(18) +
            "  " +
            name(r.peer).padEnd(18) +
            (r.users.length ? "users:(" + r.users.join(",") + ")" : ""),
        ),
      ),
    );
  };
  C.netstat = (argv, ctx) => {
    const fl = new Set(
      argv
        .filter((a) => /^-\w+$/.test(a))
        .join("")
        .replace(/-/g, "")
        .split(""),
    );
    if (fl.has("r")) return C.route([], ctx);
    if (fl.has("i"))
      return `Kernel Interface table\nIface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg\n${ifaces(ctx)[1].name}      9001  1023441      0      0 0        894112      0      0      0 BMRU\nlo       65536    12011      0      0 0         12011      0      0      0 LRU`;
    const f = { t: fl.has("t"), u: fl.has("u"), l: fl.has("l"), a: fl.has("a"), n: fl.has("n"), p: fl.has("p") };
    if (!f.t && !f.u) {
      f.t = true;
      f.u = true;
    }
    const rows = socketRows(ctx, f);
    const pid = (r) => (f.p ? (root(ctx) && r.pid ? `${r.pid}/${r.proc}`.slice(0, 19) : "-") : "");
    return join(
      [
        `Active Internet connections (${f.l ? "only servers" : f.a ? "servers and established" : "w/o servers"})`,
        "Proto Recv-Q Send-Q Local Address           Foreign Address         State       " +
          (f.p ? "PID/Program name    " : ""),
      ]
        .concat(
          rows.map((r) =>
            `${(r.proto + (r.local.startsWith("[") ? "6" : "")).padEnd(5)} ${String(r.recvq).padStart(6)} ${String(0).padStart(6)} ${r.local
              .replace("[::]", ":::")
              .replace(/^0\.0\.0\.0/, "0.0.0.0")
              .padEnd(
                23,
              )} ${r.peer.replace("[::]:*", ":::*").padEnd(23)} ${(r.proto === "udp" ? "" : r.state === "ESTAB" ? "ESTABLISHED" : "LISTEN").padEnd(11)} ${pid(r)}`.trimEnd(),
          ),
        )
        .concat(
          f.p && !root(ctx)
            ? [
                "(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)",
              ]
            : [],
        ),
    );
  };

  /* ================================================================ reachability */
  C.ping = (argv, ctx) => {
    const { f, pos } = opts(argv, "cWiws", []);
    const host = pos[0];
    if (!host) return { stdout: "", stderr: "ping: usage error: Destination address required\n", code: 1 };
    const ip = resolve(ctx, host);
    if (!ip)
      return {
        stdout: "",
        stderr: `ping: ${host}: ${/\./.test(host) ? "Name or service not known" : "Temporary failure in name resolution"}\n`,
        code: 2,
      };
    const n = Number(f.c || 4);
    const target = hostFor(ctx, host);
    const ec2 = ctx.world.aws && ctx.world.aws.instances.find((i) => i.publicIp === ip || i.privateIp === ip);
    const blocked =
      (ec2 &&
        !(ec2.sgIds || []).some((id) =>
          (ctx.world.aws.sgs[id] || { ingress: [] }).ingress.some((r) => r.proto === "icmp" || r.proto === "-1"),
        )) ||
      /^(8\.8\.|1\.1\.1\.)/.test(ip) ||
      (target && target.os === "rhel" && target.svcState("firewalld") === "active" && false);
    const label = host === ip ? ip : `${host} (${ip})`;
    if (blocked)
      return {
        stdout: `PING ${label} 56(84) bytes of data.\n\n--- ${host} ping statistics ---\n${n} packets transmitted, 0 received, 100% packet loss, time ${n * 1000 - 1}ms\n\n`,
        stderr: ec2
          ? IG.t(
              "ℹ ICMP がセキュリティグループで許可されていない可能性があります（ping が通らなくても HTTP は通ることがあります）。\n",
            )
          : IG.t("ℹ この訓練環境はインターネットに出られません。\n"),
        code: 1,
      };
    const rows = Array.from(
      { length: Math.min(n, 20) },
      (_, i) =>
        `64 bytes from ${host === ip ? ip : `${host} (${ip})`}: icmp_seq=${i + 1} ttl=${target === ctx.host || /^127\./.test(ip) ? 64 : 63} time=${(0.2 + (U.hash(ip + i) % 90) / 100).toFixed(3)} ms`,
    );
    return `PING ${label} 56(84) bytes of data.\n${rows.join("\n")}\n\n--- ${host} ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss, time ${n * 1000 - 998}ms\nrtt min/avg/max/mdev = 0.231/0.512/0.902/0.188 ms`;
  };
  C.tracepath = (argv, ctx) => {
    const host = argv.filter((a) => !a.startsWith("-"))[0];
    const ip = host && resolve(ctx, host);
    if (!ip) return { stdout: "", stderr: `${host}: Name or service not known\n`, code: 2 };
    const internal = /^10\./.test(ip);
    return internal
      ? ` 1?: [LOCALHOST]                      pmtu 9001\n 1:  ${host === ip ? ip : `${host}`}                                    0.512ms reached\n     Resume: pmtu 9001 hops 1 back 1 `
      : ` 1?: [LOCALHOST]                      pmtu 9001\n 1:  ip-10-0-1-1.ap-northeast-1.compute.internal          0.402ms\n 2:  no reply\n 3:  no reply\n     Too many hops: pmtu 9001\n     Resume: pmtu 9001 `;
  };
  C.traceroute = (argv, ctx) => {
    const host = argv.filter((a) => !a.startsWith("-"))[0];
    const ip = host && resolve(ctx, host);
    if (!ip)
      return {
        stdout: "",
        stderr: `${host}: Name or service not known\nCannot handle "host" cmdline arg \`${host}' on position 1 (argc 1)\n`,
        code: 2,
      };
    const internal = /^10\./.test(ip);
    return `traceroute to ${host} (${ip}), 30 hops max, 60 byte packets\n${internal ? ` 1  ${host} (${ip})  0.412 ms  0.388 ms  0.371 ms` : ` 1  _gateway (10.0.1.1)  0.302 ms  0.281 ms  0.270 ms\n 2  * * *\n 3  * * *`}`;
  };
  function dnsAnswer(ctx, name) {
    const w = ctx.world;
    // dig/host/nslookup do not use /etc/hosts — query the DNS view directly
    const from = ctx.from.kind === "host" ? { kind: "dns" } : ctx.from;
    const ip = w.resolveName(name, from);
    return ip;
  }
  C.dig = (argv, ctx) => {
    const short = argv.includes("+short");
    const server = (argv.find((a) => a.startsWith("@")) || "").slice(1);
    const type = (argv.find((a) => /^(A|AAAA|MX|NS|TXT|CNAME|SOA|PTR|ANY)$/i.test(a)) || "A").toUpperCase();
    const name =
      argv.find(
        (a) =>
          !a.startsWith("@") &&
          !a.startsWith("+") &&
          !a.startsWith("-") &&
          !/^(A|AAAA|MX|NS|TXT|CNAME|SOA|PTR|ANY)$/i.test(a),
      ) || ".";
    if (server && !/^(10\.|127\.)/.test(server))
      return {
        stdout: `;; communications error to ${server}#53: timed out\n;; communications error to ${server}#53: timed out\n\n; <<>> DiG 9.18.28-0ubuntu0.22.04.1-Ubuntu <<>> ${argv.join(" ")}\n;; global options: +cmd\n;; no servers could be reached\n`,
        stderr: "",
        code: 9,
      };
    const ip = type === "A" ? dnsAnswer(ctx, name) : null;
    if (short) return ip ? ip : "";
    const srv = server || (ctx.host.os === "ubuntu" ? "127.0.0.53" : "10.0.0.2");
    return `\n; <<>> DiG 9.18.28-0ubuntu0.22.04.1-Ubuntu <<>> ${argv.join(" ")}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${ip || type !== "A" ? "NOERROR" : "NXDOMAIN"}, id: ${10000 + (U.hash(name) % 50000)}\n;; flags: qr rd ra; QUERY: 1, ANSWER: ${ip ? 1 : 0}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; OPT PSEUDOSECTION:\n; EDNS: version: 0, flags:; udp: 65494\n;; QUESTION SECTION:\n;${name}.\t\t\tIN\t${type}\n${ip ? `\n;; ANSWER SECTION:\n${name}.\t\t30\tIN\tA\t${ip}\n` : ""}\n;; Query time: 1 msec\n;; SERVER: ${srv}#53(${srv}) (UDP)\n;; WHEN: ${IG.strftime("%a %b %d %T UTC %Y", ctx.world.now())}\n;; MSG SIZE  rcvd: ${ip ? 59 : 43}`;
  };
  C.nslookup = (argv, ctx) => {
    const name = argv.filter((a) => !a.startsWith("-"))[0];
    if (!name)
      return {
        stdout: "",
        stderr: IG.t("ℹ 対話モードは未対応です。nslookup <名前> の形で使ってください。\n"),
        code: 1,
      };
    const server = ctx.pod
      ? "10.96.0.10"
      : ctx.container
        ? "127.0.0.11"
        : ctx.host.os === "ubuntu"
          ? "127.0.0.53"
          : "10.0.0.2";
    const ip = ctx.pod || ctx.container ? ctx.world.resolveName(name, ctx.from) : dnsAnswer(ctx, name);
    if (!ip)
      return {
        stdout: `Server:\t\t${server}\nAddress:\t${server}#53\n\n** server can't find ${name}: NXDOMAIN\n`,
        stderr: "",
        code: 1,
      };
    let fq = name;
    if (ctx.pod && !name.includes(".")) fq = `${name}.${ctx.pod.ns}.svc.cluster.local`;
    else if (ctx.pod && name.split(".").length === 2) fq = `${name}.svc.cluster.local`;
    return `Server:\t\t${server}\nAddress:\t${server}#53\n\nNon-authoritative answer:\nName:\t${fq}\nAddress: ${ip}`;
  };
  C.host = (argv, ctx) => {
    const name = argv.filter((a) => !a.startsWith("-"))[0];
    if (!name)
      return {
        stdout: "",
        stderr:
          "Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]\n            [-R number] [-m flag] [-p port] hostname [server]\n",
        code: 1,
      };
    const ip = dnsAnswer(ctx, name);
    return ip ? `${name} has address ${ip}` : { stdout: `Host ${name} not found: 3(NXDOMAIN)\n`, stderr: "", code: 1 };
  };

  /* ================================================================ curl / wget */
  const REASON = {
    200: "OK",
    201: "Created",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    412: "Precondition Failed",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  C.curl = (argv, ctx) => {
    const { f, pos } = opts(argv, "oXHdwumAeT", [
      "output",
      "request",
      "header",
      "data",
      "data-raw",
      "write-out",
      "user",
      "max-time",
      "connect-timeout",
      "user-agent",
      "resolve",
      "cacert",
      "cert",
      "key",
    ]);
    const url = pos[0];
    if (!url)
      return { stdout: "", stderr: "curl: try 'curl --help' or 'curl --manual' for more information\n", code: 2 };
    const head = f.I || f.head;
    const method = f.X || f.request || (head ? "HEAD" : f.d || f.data || f["data-raw"] ? "POST" : "GET");
    const t0 = Date.now();
    const r = ctx.world.http(/^\w+:\/\//.test(url) ? url : "http://" + url, ctx.from, { method });
    const silent = f.s || f.silent;
    const showErr = f.S || f["show-error"];
    if (r.error) {
      const code = Number((r.error.match(/curl: \((\d+)\)/) || [])[1] || 1);
      let msg = r.error;
      if ((f["max-time"] || f.m || f["connect-timeout"]) && code === 28)
        msg = msg.replace(/after \d+ ms/, `after ${Number(f["max-time"] || f.m || f["connect-timeout"]) * 1000} ms`);
      if (silent && !showErr)
        return {
          stdout: "",
          stderr: IG.t(`ℹ curl が失敗しました（exit {0}）。-s を外すとエラー内容が表示されます。\n`, { 0: code }),
          code,
        };
      return { stdout: "", stderr: msg + "\n", code };
    }
    const ctype = /^[{[]/.test(r.body)
      ? "application/json"
      : /^<\?xml/.test(r.body)
        ? "application/xml"
        : /^<(!doctype|html)/i.test(r.body)
          ? "text/html"
          : "text/plain";
    const headers =
      `HTTP/1.1 ${r.status} ${REASON[r.status] || ""}\r\n${r.server ? `Server: ${r.server}\r\n` : ""}Date: ${new Date(ctx.world.now()).toUTCString()}\r\nContent-Type: ${ctype}${ctype.startsWith("text") ? "; charset=utf-8" : ""}\r\nContent-Length: ${r.body.length}\r\nConnection: keep-alive\r\n\r\n`.replace(
        /\r/g,
        "",
      );
    let body = head ? "" : r.body;
    let so = "";
    let se = "";
    if (f.v || f.verbose) {
      const m = url.match(/^(?:(\w+):\/\/)?([^/:]+)(?::(\d+))?(.*)$/);
      const port = m[3] || (m[1] === "https" ? 443 : 80);
      se +=
        `*   Trying ${resolve(ctx, m[2]) || m[2]}:${port}...\n* Connected to ${m[2]} (${resolve(ctx, m[2]) || m[2]}) port ${port} (#0)\n> ${method} ${m[4] || "/"} HTTP/1.1\n> Host: ${m[2]}${m[3] ? ":" + m[3] : ""}\n> User-Agent: curl/7.81.0\n> Accept: */*\n>\n` +
        headers
          .trim()
          .split("\n")
          .map((l) => "< " + l)
          .join("\n") +
        "\n<\n";
    }
    if (f.i || f.include || head) so += headers;
    const o = f.o || f.output;
    if (f.O || o) {
      const name = o || url.split("?")[0].split("/").pop() || "index.html";
      if (name !== "/dev/null") {
        const p = ctx.resolve(name);
        if (!ctx.shell.canWrite(p))
          return { stdout: "", stderr: "curl: (23) Failure writing output to destination\n", code: 23 };
        ctx.vfs.write(p, body, { owner: ctx.user });
      }
      if (!silent)
        se += `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100  ${String(body.length).padStart(5)}  100  ${String(body.length).padStart(5)}    0     0   ${String(150000 + (U.hash(url) % 90000)).padStart(6)}      0 --:--:-- --:--:-- --:--:--  ${150000 + (U.hash(url) % 90000)}\n`;
      body = "";
    }
    so += body;
    if (body && !body.endsWith("\n") && !(f.w || f["write-out"])) so += "\n";
    const wo = f.w || f["write-out"];
    if (wo)
      so += String(wo)
        .replace(/%\{http_code\}|%\{response_code\}/g, r.status)
        .replace(/%\{time_total\}/g, ((Date.now() - t0) / 1000 + 0.004).toFixed(6))
        .replace(/%\{size_download\}/g, head ? 0 : r.body.length)
        .replace(/%\{remote_ip\}/g, resolve(ctx, url.replace(/^\w+:\/\//, "").split(/[:/]/)[0]) || "")
        .replace(/%\{content_type\}/g, ctype)
        .replace(/\\n/g, "\n");
    if ((f.f || f.fail) && r.status >= 400)
      return {
        stdout: "",
        stderr: silent && !showErr ? "" : `curl: (22) The requested URL returned error: ${r.status}\n`,
        code: 22,
      };
    return { stdout: so, stderr: se, code: 0 };
  };
  C.wget = (argv, ctx) => {
    const { f, pos } = opts(argv, "OPT", ["output-document", "timeout"]);
    const url = pos[0];
    if (!url) return { stdout: "", stderr: "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n", code: 1 };
    const full = /^\w+:\/\//.test(url) ? url : "http://" + url;
    const host = full.replace(/^\w+:\/\//, "").split(/[:/]/)[0];
    const ip = resolve(ctx, host);
    const quiet = f.q || f.quiet;
    let log = `--${IG.strftime("%F %T", ctx.world.now())}--  ${full}\n`;
    if (!ip)
      return {
        stdout: "",
        stderr: quiet
          ? ""
          : log +
            `Resolving ${host} (${host})... failed: Name or service not known.\nwget: unable to resolve host address ‘${host}’\n`,
        code: 4,
      };
    log += `Resolving ${host} (${host})... ${ip}\nConnecting to ${host} (${host})|${ip}|:${(full.match(/:(\d+)/) || [])[1] || (full.startsWith("https") ? 443 : 80)}... `;
    const r = ctx.world.http(full, ctx.from, { method: f.spider ? "HEAD" : "GET" });
    if (r.error)
      return {
        stdout: "",
        stderr: quiet
          ? ""
          : log +
            (/Timeout/.test(r.error) ? "failed: Connection timed out.\nRetrying.\n" : "failed: Connection refused.\n"),
        code: 4,
      };
    log += `connected.\nHTTP request sent, awaiting response... ${r.status} ${REASON[r.status] || ""}\n`;
    if (r.status >= 400)
      return {
        stdout: "",
        stderr: quiet
          ? ""
          : log + `${IG.strftime("%F %T", ctx.world.now())} ERROR ${r.status}: ${REASON[r.status] || ""}.\n\n`,
        code: 8,
      };
    if (f.spider)
      return {
        stdout: "",
        stderr: quiet
          ? ""
          : log +
            "Length: unspecified [text/html]\nRemote file exists and could contain further links,\nbut recursion is disabled -- not retrieving.\n\n",
        code: 0,
      };
    const target = f.O || f["output-document"];
    if (target === "-")
      return {
        stdout: r.body + (r.body.endsWith("\n") ? "" : "\n"),
        stderr: quiet ? "" : log + `Length: ${r.body.length}\nSaving to: ‘STDOUT’\n\n`,
        code: 0,
      };
    let name = target || full.split("?")[0].replace(/\/$/, "").split("/").pop() || "index.html";
    if (!target && !/\./.test(name) && full.replace(/^\w+:\/\/[^/]+/, "") === "") name = "index.html";
    const p = ctx.resolve(name);
    let finalName = name;
    if (!target && ctx.vfs.exists(p)) {
      let k = 1;
      while (ctx.vfs.exists(p + "." + k)) k++;
      finalName = name + "." + k;
    }
    if (!ctx.shell.canWrite(ctx.resolve(finalName)))
      return {
        stdout: "",
        stderr: `${finalName}: Permission denied\n\nCannot write to ‘${finalName}’ (Permission denied).\n`,
        code: 3,
      };
    ctx.vfs.write(ctx.resolve(finalName), r.body, { owner: ctx.user });
    return {
      stdout: "",
      stderr: quiet
        ? ""
        : log +
          `Length: ${r.body.length} (${(r.body.length / 1024).toFixed(1)}K) [text/html]\nSaving to: ‘${finalName}’\n\n${finalName.padEnd(18)} 100%[===================>]   ${r.body.length}  --.-KB/s    in 0s      \n\n${IG.strftime("%F %T", ctx.world.now())} (14.2 MB/s) - ‘${finalName}’ saved [${r.body.length}/${r.body.length}]\n\n`,
      code: 0,
    };
  };

  /* ================================================================ nc / telnet */
  C.nc = (argv, ctx) => {
    const fl = new Set(
      argv
        .filter((a) => /^-[a-zA-Z]+$/.test(a))
        .join("")
        .replace(/-/g, "")
        .split(""),
    );
    const pos = argv.filter((a, i) => !/^-/.test(a) && !/^-w$/.test(argv[i - 1]));
    if (fl.has("l"))
      return {
        stdout: "",
        stderr: IG.t(
          "ℹ nc -l（待ち受け）はこのシミュレータでは未対応です。待ち受け中のポートは ss -tlnp で確認できます。\n",
        ),
        code: 1,
      };
    const [host, portSpec] = pos;
    if (!host || !portSpec)
      return {
        stdout: "",
        stderr:
          "usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]\n\t  [-m minttl] [-O length] [-P proxy_username] [-p source_port]\n\t  [-q seconds] [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit]\n\t  [-w timeout] [-X proxy_protocol] [-x proxy_address[:port]]\n\t  [destination] [port]\n",
        code: 1,
      };
    const ports = portSpec.includes("-")
      ? (([a, b]) => Array.from({ length: Math.min(200, b - a + 1) }, (_, k) => a + k))(portSpec.split("-").map(Number))
      : [Number(portSpec)];
    const o = out();
    let anyOk = false;
    for (const port of ports) {
      const r = tcpConnect(ctx, host, port);
      const ipS = r.ip || host;
      if (r.unresolved) {
        o.e(`nc: getaddrinfo for host "${host}" port ${port}: Name or service not known`);
        return o.r();
      }
      if (r.ok) {
        anyOk = true;
        if (fl.has("z") || fl.has("v"))
          o.e(
            `Connection to ${host} (${ipS}) ${port} port [tcp/${SVC_NAME[port] && SVC_NAME[port] !== "*" ? SVC_NAME[port] : "*"}] succeeded!`,
            0,
          );
        if (!fl.has("z")) {
          if (r.svc === "ssh" || r.svc === "sshd") o.o("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10\n");
          else if (ctx.hasStdin) {
            const req = ctx.stdin;
            const m = req.match(/^(GET|HEAD|POST) (\S+)/);
            if (m) {
              const res = ctx.world.http(`http://${host}:${port}${m[2]}`, ctx.from, { method: m[1] });
              if (res.status)
                o.o(
                  `HTTP/1.1 ${res.status} ${REASON[res.status] || ""}\r\n${res.server ? "Server: " + res.server + "\r\n" : ""}Content-Length: ${res.body.length}\r\n\r\n${m[1] === "HEAD" ? "" : res.body}\n`.replace(
                    /\r/g,
                    "",
                  ),
                );
            }
          }
        }
      } else if (fl.has("v") || ports.length === 1) {
        if (r.timeout)
          o.e(
            `nc: connect to ${host} (${ipS}) port ${port} (tcp) ${argv.includes("-w") ? "timed out: Operation now in progress" : "failed: Connection timed out"}`,
            1,
          );
        else o.e(`nc: connect to ${host} (${ipS}) port ${port} (tcp) failed: Connection refused`, 1);
      }
    }
    o.code = anyOk ? 0 : 1;
    return o.r();
  };
  C.netcat = C.nc;
  C.telnet = (argv, ctx) => {
    const [host, p] = argv.filter((a) => !a.startsWith("-"));
    if (!host) return { stdout: "", stderr: IG.t("ℹ telnet <ホスト> <ポート> の形式で使ってください。\n"), code: 1 };
    const port = Number(p || 23);
    const r = tcpConnect(ctx, host, port);
    if (r.unresolved)
      return { stdout: "", stderr: `telnet: could not resolve ${host}/${port}: Name or service not known\n`, code: 1 };
    if (r.timeout)
      return {
        stdout: `Trying ${r.ip}...\n`,
        stderr: `telnet: Unable to connect to remote host: Connection timed out\n`,
        code: 1,
      };
    if (r.refused)
      return {
        stdout: `Trying ${r.ip}...\n`,
        stderr: `telnet: Unable to connect to remote host: Connection refused\n`,
        code: 1,
      };
    return IG.t(
      `Trying {0}...\nConnected to {1}.\nEscape character is '^]'.\n{2}Connection closed by foreign host.\nℹ 接続確認だけを行いました（対話入力は再現していません）。`,
      { 0: r.ip, 1: host, 2: r.svc === "ssh" || r.svc === "sshd" ? "SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10\n" : "" },
    );
  };

  /* ================================================================ ssh family */
  // ~/.ssh/config: Host <alias> / HostName / User
  function sshConfig(ctx, alias) {
    const txt = ctx.vfs.read(ctx.shell.home() + "/.ssh/config") || "";
    let cur = null;
    const res = {};
    for (const raw of txt.split("\n")) {
      const m = raw.trim().match(/^(\w+)\s+(.+)$/);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (k === "host") {
        cur = m[2].split(/\s+/).some((p) => IG.bash.globRe(p).test(alias));
        continue;
      }
      if (cur && !(k in res)) res[k] = m[2].trim();
    }
    return res;
  }
  function parseTarget(s, ctx) {
    const m = String(s).match(/^(?:([^@]+)@)?([^:]+)(?::(.*))?$/);
    const cfg = sshConfig(ctx, m[2]);
    return {
      user: m[1] || cfg.user || ctx.user,
      host: cfg.hostname && !Object.values(ctx.world.hosts).some((h) => h.name === m[2]) ? cfg.hostname : m[2],
      path: m[3],
    };
  }
  function sshAuth(ctx, t) {
    const w = ctx.world;
    const h = Object.values(w.hosts).find(
      (x) =>
        x.name === t.host ||
        x.ip === t.host ||
        x.publicIp === t.host ||
        (resolve(ctx, t.host) && x.ip === resolve(ctx, t.host)),
    );
    if (!h) {
      const ec2 =
        w.aws && w.aws.instances.find((i) => i.publicIp === t.host || i.publicDns === t.host || i.privateIp === t.host);
      if (ec2)
        return {
          error: IG.t(
            `ssh: connect to host {0} port 22: Connection timed out\nℹ この訓練では EC2 へのログインは扱いません。AWS CLI で調査してください。`,
            { 0: t.host },
          ),
          code: 255,
        };
      const ip = resolve(ctx, t.host);
      if (ip) return { error: `ssh: connect to host ${t.host} port 22: Connection timed out`, code: 255 };
      return {
        error: `ssh: Could not resolve hostname ${t.host}: ${t.host.includes(".") ? "Name or service not known" : "Temporary failure in name resolution"}`,
        code: 255,
      };
    }
    if (h === ctx.host && t.user === ctx.user) return { host: h, same: true };
    if (!h.sshable) return { error: `ssh: connect to host ${t.host} port 22: Connection refused`, code: 255 };
    const sshd = h.svcState("ssh") === "active" || h.svcState("sshd") === "active";
    if (!sshd) return { error: `ssh: connect to host ${t.host} port 22: Connection refused`, code: 255 };
    if (h !== ctx.host && !h.firewallAllows(22, "tcp", ctx.host.ip))
      return { error: `ssh: connect to host ${t.host} port 22: Connection timed out`, code: 255 };
    const u = h.users[t.user];
    if (!u || u.locked || /nologin|false/.test(u.shell))
      return { error: `${t.user}@${t.host}: Permission denied (publickey).`, code: 255 };
    if (t.user === "root")
      return {
        error: IG.t(
          `{0}@{1}: Permission denied (publickey).\nℹ PermitRootLogin prohibit-password のため root で直接ログインできません。一般ユーザーで入って sudo を使います。`,
          { 0: t.user, 1: t.host },
        ),
        code: 255,
      };
    // key-based: login user is pre-authorized; others need ssh-copy-id
    const ak = h.vfs.read(u.home + "/.ssh/authorized_keys") || "";
    const myPub = ctx.vfs.read(ctx.shell.home() + "/.ssh/id_ed25519.pub") || "";
    const authorized = t.user === h.user || (myPub && ak.includes(myPub.trim().split(" ")[1] || "@@"));
    if (!authorized) return { error: `${t.user}@${t.host}: Permission denied (publickey).`, code: 255 };
    return { host: h, user: t.user };
  }
  function knownHost(ctx, h) {
    const kh = ctx.shell.home() + "/.ssh/known_hosts";
    const cur = ctx.vfs.read(kh) || "";
    if (cur.includes(h.name + " ")) return "";
    if (ctx.vfs.isDir(ctx.shell.home() + "/.ssh"))
      ctx.vfs.write(kh, cur + `${h.name} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${U.hex("hk" + h.name, 40)}\n`, {
        owner: ctx.user,
        mode: 0o644,
      });
    return `Warning: Permanently added '${h.name}' (ED25519) to the list of known hosts.\n`;
  }
  C.ssh = (argv, ctx) => {
    if (ctx.pod || ctx.container) return { stdout: "", stderr: "sh: ssh: not found\n", code: 127 };
    const { f, pos } = opts(argv, "ipolLFJ", []);
    if (!pos[0])
      return {
        stdout: "",
        stderr:
          "usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]\n           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]\n           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]\n           [-i identity_file] [-J [user@]host[:port]] [-L address]\n           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]\n           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]\n           [-w local_tun[:remote_tun]] destination [command [argument ...]]\n",
        code: 255,
      };
    const t = parseTarget(pos[0], ctx);
    if (f.l) t.user = f.l;
    if (f.p && Number(f.p) !== 22)
      return { stdout: "", stderr: `ssh: connect to host ${t.host} port ${f.p}: Connection refused\n`, code: 255 };
    const a = sshAuth(ctx, t);
    if (a.error) return { stdout: "", stderr: a.error + "\n", code: a.code };
    const h = a.host;
    const warn = knownHost(ctx, h);
    h.authLog(
      `sshd[${4400 + (U.hash(t.user) % 99)}]: Accepted publickey for ${t.user} from ${ctx.host.ip} port ${50000 + (U.hash(h.name) % 9999)} ssh2: ED25519 SHA256:${U.b64(U.hex("fp" + t.user, 32)).slice(0, 43)}`,
    );
    const sh = ctx.shell;
    const remoteCmd = pos.slice(1).join(" ");
    if (remoteCmd) {
      sh.stack.push({ host: h.name, user: t.user, cwd: h.users[t.user].home, prev: h.users[t.user].home });
      try {
        const r = sh.exec(remoteCmd);
        return {
          stdout: r.chunks
            .filter((c) => c.stream === "out")
            .map((c) => c.text)
            .join(""),
          stderr:
            warn +
            r.chunks
              .filter((c) => c.stream === "err")
              .map((c) => c.text)
              .join(""),
          code: r.code,
        };
      } finally {
        sh.stack.pop();
      }
    }
    sh.stack.push({ host: h.name, user: t.user, cwd: h.users[t.user].home, prev: h.users[t.user].home });
    const motd =
      h.motd ||
      (h.os === "rhel"
        ? "Register this system with Red Hat Insights: insights-client --register\nCreate an account or view all your systems at https://red.ht/insights-dashboard"
        : `Welcome to ${h.osPretty} (GNU/Linux ${h.kernel} x86_64)\n\n * Documentation:  https://help.ubuntu.com\n * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro`);
    return {
      stdout: `${warn}${motd}\nLast login: ${IG.strftime("%a %b %e %T %Y", ctx.world.now() - 86400e3 * 2)} from ${ctx.host.ip}\n`,
      stderr: "",
      code: 0,
    };
  };
  function remoteFs(ctx, spec) {
    const t = parseTarget(spec, ctx);
    if (t.path === undefined)
      return { local: true, path: ctx.resolve(spec), vfs: ctx.vfs, host: ctx.host, user: ctx.user, label: spec };
    const a = sshAuth(ctx, t);
    if (a.error) return { error: a.error };
    const home = a.host.users[t.user].home;
    return {
      local: false,
      path: VFS.norm(t.path || ".", home, home),
      vfs: a.host.vfs,
      host: a.host,
      user: t.user,
      label: spec,
    };
  }
  function copyTree(src, dst, recursive, preserve) {
    const n = src.vfs.node(src.path);
    if (n.type === "d") {
      if (!recursive) return `${src.label}: not a regular file`;
      const target = dst.vfs.isDir(dst.path) ? dst.path + "/" + VFS.base(src.path) : dst.path;
      dst.vfs.mkdirp(target, { owner: dst.user, group: dst.host.primaryGroup(dst.user) });
      for (const k of src.vfs.children(src.path)) {
        const e = copyTree(
          Object.assign({}, src, { path: k.path, label: k.name }),
          Object.assign({}, dst, { path: target }),
          recursive,
          preserve,
        );
        if (e) return e;
      }
      return null;
    }
    if (!src.host.canRead(src.user, src.path)) return `${src.label}: Permission denied`;
    const target = dst.vfs.isDir(dst.path) ? dst.path + "/" + VFS.base(src.path) : dst.path;
    if (!dst.host.canWriteFile(dst.user, target))
      return `dest open "${target}": Permission denied\nscp: failed to upload file ${src.label} to ${dst.label}`;
    dst.vfs.write(
      target,
      n.content,
      Object.assign(
        { size: n.size, owner: dst.user, group: dst.host.primaryGroup(dst.user) },
        preserve ? { mode: n.mode, mtime: n.mtime } : { mode: n.mode & 0o777 },
      ),
    );
    return null;
  }
  C.scp = (argv, ctx) => {
    const { f, pos } = opts(argv, "iPo", []);
    if (pos.length < 2)
      return {
        stdout: "",
        stderr:
          "usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]\n           [-i identity_file] [-J destination] [-l limit]\n           [-o ssh_option] [-P port] [-S program] source ... target\n",
        code: 1,
      };
    const dst = remoteFs(ctx, pos[pos.length - 1]);
    if (dst.error) return { stdout: "", stderr: dst.error + "\n", code: 255 };
    const o = out();
    for (const s of pos.slice(0, -1)) {
      const src = remoteFs(ctx, s);
      if (src.error) {
        o.e(src.error, 255);
        continue;
      }
      if (!src.vfs.exists(src.path)) {
        o.e(`scp: ${src.local ? s : src.path}: No such file or directory`);
        continue;
      }
      const err = copyTree(src, dst, f.r, f.p);
      if (err) {
        o.e("scp: " + err.replace(/^scp: /, ""));
        continue;
      }
      const size = src.vfs.size(src.path);
      if (!f.q)
        o.o(
          `${VFS.base(src.path).padEnd(40)} 100% ${String(size).padStart(5)}   ${(size / 1024 + 120).toFixed(1)}KB/s   00:00    \n`,
        );
    }
    ctx.world.reconcile();
    return o.r();
  };
  C.rsync = (argv, ctx) => {
    const fl = new Set(
      argv
        .filter((a) => /^-[a-zA-Z]+$/.test(a))
        .join("")
        .replace(/-/g, "")
        .split(""),
    );
    const pos = argv.filter((a) => !a.startsWith("-"));
    if (pos.length < 2)
      return {
        stdout: "",
        stderr: IG.t(
          "rsync  version 3.2.7  protocol version 31\nℹ rsync -av <コピー元> <コピー先> の形式で使ってください（host:path でリモート指定可）。\n",
        ),
        code: 1,
      };
    const dst = remoteFs(ctx, pos[pos.length - 1]);
    if (dst.error)
      return {
        stdout: "",
        stderr:
          dst.error +
          "\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]\nrsync error: unexplained error (code 255) at io.c(232) [sender=3.2.7]\n",
        code: 255,
      };
    const o = out();
    o.o("sending incremental file list\n");
    let total = 0;
    for (const s of pos.slice(0, -1)) {
      const src = remoteFs(ctx, s.replace(/\/$/, ""));
      if (src.error || !src.vfs.exists(src.path)) {
        o.e(`rsync: [sender] link_stat "${src.path || s}" failed: No such file or directory (2)`, 23);
        continue;
      }
      const contents = s.endsWith("/");
      const recursive = fl.has("a") || fl.has("r");
      const items = src.vfs.isDir(src.path)
        ? contents
          ? src.vfs.children(src.path).map((c) => c.path)
          : [src.path]
        : [src.path];
      if (!dst.vfs.exists(dst.path) && (items.length > 1 || contents)) dst.vfs.mkdirp(dst.path, { owner: dst.user });
      for (const it of items) {
        const err = copyTree(
          Object.assign({}, src, { path: it, label: VFS.base(it) }),
          dst,
          recursive,
          fl.has("a") || fl.has("p"),
        );
        if (err) {
          o.e("rsync: " + err, 23);
          continue;
        }
        total += src.vfs.size(it);
        if (fl.has("v")) {
          o.o((src.vfs.isDir(it) ? VFS.base(it) + "/" : VFS.base(it)) + "\n");
          if (src.vfs.isDir(it))
            for (const k of src.vfs.walk(it))
              o.o(VFS.base(it) + k.slice(it.length) + (src.vfs.isDir(k) ? "/" : "") + "\n");
        }
      }
    }
    o.o(
      `\nsent ${total + 211} bytes  received ${38 + pos.length * 4} bytes  ${((total + 249) * 2).toFixed(2)} bytes/sec\ntotal size is ${total}  speedup is ${(total / (total + 249) || 0.01).toFixed(2)}\n`,
    );
    ctx.world.reconcile();
    return o.r();
  };
  C["ssh-keygen"] = (argv, ctx) => {
    const { f } = opts(argv, "tbfNClE", []);
    const home = ctx.shell.home();
    const type = f.t || "ed25519";
    const file = f.f ? ctx.resolve(f.f) : `${home}/.ssh/id_${type}`;
    const fp = `SHA256:${U.b64(U.hex(file + type, 32)).slice(0, 43)}`;
    if (f.l) {
      const pub = ctx.vfs.read(file.endsWith(".pub") ? file : file + ".pub");
      if (!pub) return { stdout: "", stderr: `${file} is not a public key file.\n`, code: 255 };
      return `${type === "rsa" ? 3072 : 256} ${fp} ${pub.trim().split(" ")[2] || ""} (${type.toUpperCase()})`;
    }
    if (f.R)
      return `# Host ${f.R} found: line 1\n${home}/.ssh/known_hosts updated.\nOriginal contents retained as ${home}/.ssh/known_hosts.old`;
    const o = out();
    o.o(`Generating public/private ${type} key pair.\n`);
    if (!f.f) o.o(`Enter file in which to save the key (${file}): \n`);
    if (ctx.vfs.exists(file)) {
      o.o(`${file} already exists.\nOverwrite (y/n)? `);
      if (!/^y/i.test(ctx.stdin.trim())) {
        o.o("\n");
        o.code = 1;
        return o.r();
      }
      o.o("\n");
    }
    if (f.N === undefined) o.o("Enter passphrase (empty for no passphrase): \nEnter same passphrase again: \n");
    ctx.vfs.mkdirp(VFS.parent(file), { owner: ctx.user, mode: 0o700 });
    const comment = f.C || `${ctx.user}@${ctx.host.hostname}`;
    const body = U.b64(U.hex(file + "priv" + Math.random(), 48));
    ctx.vfs.write(
      file,
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g).join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
      { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user), mode: 0o600 },
    );
    const pub =
      type === "rsa"
        ? `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ${U.hex(file + "rsa", 60)} ${comment}\n`
        : `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${U.hex(file + "pub" + body.slice(0, 6), 40)} ${comment}\n`;
    ctx.vfs.write(file + ".pub", pub, { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user), mode: 0o644 });
    o.o(
      `Your identification has been saved in ${file}\nYour public key has been saved in ${file}.pub\nThe key fingerprint is:\n${fp} ${comment}\nThe key's randomart image is:\n+--[${type.toUpperCase()} ${type === "rsa" ? 3072 : 256}]--+\n|      .o+=*o.    |\n|     . +=B+o     |\n|      o.*O+ .    |\n|     . +=+.=     |\n|      +.S+o .    |\n|     . o+=..     |\n|      .Eo.o      |\n|       o.+.      |\n|       .=o.      |\n+----[SHA256]-----+\n`,
    );
    return o.r();
  };
  C["ssh-copy-id"] = (argv, ctx) => {
    const { f, pos } = opts(argv, "ip", []);
    const t = parseTarget(pos[0] || "", ctx);
    const keyFile = f.i
      ? ctx.resolve(f.i.endsWith(".pub") ? f.i : f.i + ".pub")
      : ctx.shell.home() + "/.ssh/id_ed25519.pub";
    const pub = ctx.vfs.read(keyFile);
    if (!pub)
      return {
        stdout: "",
        stderr: `/usr/bin/ssh-copy-id: ERROR: failed to open ID file '${keyFile.replace(/\.pub$/, "")}': No such file\n\t(to install the contents of '${keyFile}' anyway, look at the -f option)\n`,
        code: 1,
      };
    const h = Object.values(ctx.world.hosts).find((x) => x.name === t.host || x.ip === t.host);
    if (!h || !h.users[t.user])
      return {
        stdout: "",
        stderr: `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${keyFile}"\n${t.user}@${t.host}: Permission denied (publickey).\n`,
        code: 1,
      };
    const ak = h.users[t.user].home + "/.ssh/authorized_keys";
    h.vfs.mkdirp(h.users[t.user].home + "/.ssh", { owner: t.user, mode: 0o700 });
    const cur = h.vfs.read(ak) || "";
    if (cur.includes(pub.trim()))
      return {
        stdout: "",
        stderr: `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${keyFile}"\n/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed\n\n/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.\n\t\t(if you think this is a mistake, you may want to use -f option)\n\n`,
        code: 0,
      };
    if (t.user !== h.user)
      return {
        stdout: "",
        stderr: IG.t(
          `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "{0}"\n{1}@{2}'s password: \nℹ 初回はパスワード認証が必要ですが、この訓練環境ではパスワード入力を再現できません。サーバー側で管理者が authorized_keys に公開鍵を追記する手順で代替してください。\n`,
          { 0: keyFile, 1: t.user, 2: t.host },
        ),
        code: 1,
      };
    h.vfs.write(ak, cur + pub, { owner: t.user, mode: 0o600 });
    return {
      stdout: `\nNumber of key(s) added: 1\n\nNow try logging into the machine, with:   "ssh '${t.user}@${t.host}'"\nand check to make sure that only the key(s) you wanted were added.\n\n`,
      stderr: `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${keyFile}"\n/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed\n/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys\n`,
      code: 0,
    };
  };

  /* ================================================================ firewalls */
  C.ufw = (argv, ctx) => {
    const h = ctx.host;
    if (h.os === "rhel")
      return {
        stdout: "",
        stderr: IG.t("bash: ufw: command not found\nℹ RHEL 系のファイアウォールは firewall-cmd（firewalld）です。\n"),
        code: 127,
      };
    if (!root(ctx)) return { stdout: "", stderr: "ERROR: You need to be root to run this script\n", code: 1 };
    const u = h.firewall.ufw;
    const force = argv.includes("--force");
    const a = argv.filter((x) => x !== "--force" && x !== "--dry-run");
    const ruleStr = (r) =>
      `${(r.app || (r.port ? r.port + (r.proto ? "/" + r.proto : "") : "Anywhere")).padEnd(27)}${(r.action.toUpperCase() + (r.dir === "out" ? " OUT" : " IN")).padEnd(12)}${r.from || "Anywhere"}`;
    const listing = (verbose, numbered) =>
      `Status: ${u.enabled ? "active" : "inactive"}${u.enabled && verbose ? "\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip" : ""}${
        u.enabled
          ? `\n\n${numbered ? "     " : ""}To                         Action      From\n${numbered ? "     " : ""}--                         ------      ----\n` +
            u.rules.map((r, i) => (numbered ? `[${String(i + 1).padStart(2)}] ` : "") + ruleStr(r)).join("\n") +
            (u.rules.length ? "\n" : "") +
            u.rules
              .filter((r) => !r.from || r.from === "Anywhere")
              .map(
                (r, i) =>
                  (numbered ? `[${String(u.rules.length + i + 1).padStart(2)}] ` : "") +
                  ruleStr(
                    Object.assign({}, r, {
                      port: r.port ? r.port + (r.proto ? "/" + r.proto : "") + " (v6)" : undefined,
                      app: r.app ? r.app + " (v6)" : undefined,
                      proto: "",
                      from: "Anywhere (v6)",
                    }),
                  ),
              )
              .join("\n")
          : ""
      }`;
    const cmd = a[0];
    switch (cmd) {
      case "status":
        return listing(a[1] === "verbose", a[1] === "numbered");
      case "enable": {
        const sshOk = u.rules.some((r) => r.action !== "deny" && (r.port === "22" || r.app === "OpenSSH"));
        if (!force && ctx.shell.stack.some((s) => s.host === h.name && !s.via) && h.name !== "bastion") {
          const ans = ctx.stdin.trim();
          if (!/^y/i.test(ans))
            return {
              stdout: "Command may disrupt existing ssh connections. Proceed with operation (y|n)? Aborted\n",
              stderr: ctx.hasStdin
                ? ""
                : IG.t(
                    "ℹ 確認に応答できないため中断しました。sudo ufw --force enable か、echo y | sudo ufw enable を使います。\n",
                  ),
              code: 0,
            };
        }
        u.enabled = true;
        h.enabled.ufw = true;
        ctx.world.emit(`${h.hostname}: ufw enabled${sshOk ? "" : " (SSH not allowed!)"}`, sshOk ? "INFO" : "WARN");
        return (
          (force ? "" : "Command may disrupt existing ssh connections. Proceed with operation (y|n)? ") +
          "Firewall is active and enabled on system startup" +
          (sshOk ? "" : IG.t("\nℹ 注意: 22/tcp（OpenSSH）を許可していないため、新しい SSH 接続は遮断されます。"))
        );
      }
      case "disable":
        u.enabled = false;
        return "Firewall stopped and disabled on system startup";
      case "reset":
        if (!force && !/^y/i.test(ctx.stdin.trim()))
          return "Resetting all rules to installed defaults. Proceed with operation (y|n)? Aborted";
        u.enabled = false;
        u.rules = [];
        return `Backing up 'user.rules' to '/etc/ufw/user.rules.${IG.strftime("%Y%m%d_%H%M%S", ctx.world.now())}'\nBacking up 'before.rules' to '/etc/ufw/before.rules.${IG.strftime("%Y%m%d_%H%M%S", ctx.world.now())}'`;
      case "reload":
        return u.enabled ? "Firewall reloaded" : "Firewall not enabled (skipping reload)";
      case "app":
        return a[1] === "list"
          ? "Available applications:\n  OpenSSH" +
              (h.pkgs.has("nginx") ? "\n  Nginx Full\n  Nginx HTTP\n  Nginx HTTPS" : "") +
              (h.pkgs.has("apache2") ? "\n  Apache\n  Apache Full\n  Apache Secure" : "")
          : { stdout: "", stderr: "ERROR: Invalid syntax\n", code: 1 };
      case "allow":
      case "deny":
      case "reject":
      case "limit": {
        const rest = a.slice(1);
        const r = { action: cmd, dir: rest[0] === "out" ? "out" : "in" };
        const words = rest.filter((x) => x !== "in" && x !== "out");
        if (words[0] === "from") {
          r.from = words[1];
          const pi = words.indexOf("port");
          if (pi >= 0) r.port = words[pi + 1];
          const pr = words.indexOf("proto");
          if (pr >= 0) r.proto = words[pr + 1];
        } else if (/^\d+(:\d+)?(\/(tcp|udp))?$/.test(words[0] || "")) {
          const [p, pr] = words[0].split("/");
          r.port = p;
          r.proto = pr;
        } else if (words[0] && /^(OpenSSH|Nginx Full|Nginx HTTP|Nginx HTTPS|Apache|Apache Full)$/.test(words.join(" ")))
          r.app = words.join(" ");
        else if (/^(ssh|http|https)$/.test(words[0] || "")) {
          r.port = { ssh: "22", http: "80", https: "443" }[words[0]];
          r.proto = "tcp";
        } else
          return {
            stdout: "",
            stderr: `ERROR: ${words[0] ? `Could not find a profile matching '${words.join(" ")}'` : "Invalid syntax"}\n`,
            code: 1,
          };
        if (
          u.rules.some(
            (x) =>
              x.action === r.action && x.port === r.port && x.app === r.app && x.from === r.from && x.proto === r.proto,
          )
        )
          return "Skipping adding existing rule\nSkipping adding existing rule (v6)";
        u.rules.push(r);
        return r.from && r.from !== "any" ? "Rule added" : "Rules updated\nRules updated (v6)";
      }
      case "delete": {
        if (/^\d+$/.test(a[1] || "")) {
          const i = Number(a[1]) - 1;
          if (!u.rules[i]) return { stdout: "", stderr: "ERROR: Could not find rule '" + a[1] + "'\n", code: 1 };
          const r = u.rules[i];
          if (!force && !/^y/i.test(ctx.stdin.trim()))
            return IG.t(
              `Deleting:\n {0} {1}\nProceed with operation (y|n)? Aborted\nℹ sudo ufw --force delete {2} で確認を省略できます。`,
              { 0: r.action, 1: r.port || r.app, 2: a[1] },
            );
          u.rules.splice(i, 1);
          return "Rule deleted";
        }
        const act = a[1];
        const spec = a.slice(2).join(" ");
        const idx = u.rules.findIndex(
          (r) =>
            r.action === act &&
            ((r.port && r.port + (r.proto ? "/" + r.proto : "") === spec) || r.port === spec || r.app === spec),
        );
        if (idx < 0) return "Could not delete non-existent rule\nCould not delete non-existent rule (v6)";
        u.rules.splice(idx, 1);
        return "Rule deleted\nRule deleted (v6)";
      }
      case "default":
        return `Default ${a[2] || "incoming"} policy changed to '${a[1]}'\n(be sure to update your rules accordingly)`;
      case "logging":
        return `Logging ${a[1] === "off" ? "disabled" : "enabled"}`;
      default:
        return {
          stdout: "",
          stderr: `ERROR: Invalid syntax\n\nUsage: ufw COMMAND\n\nCommands:\n enable                          enables the firewall\n disable                         disables the firewall\n status                          show firewall status\n allow ARGS                      add allow rule\n deny ARGS                       add deny rule\n delete RULE|NUM                 delete RULE\n`,
          code: 1,
        };
    }
  };
  C.iptables = (argv, ctx) => {
    const h = ctx.host;
    if (!root(ctx))
      return {
        stdout: "",
        stderr:
          "iptables v1.8.7 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)\n\n",
        code: 4,
      };
    const R = h.firewall.iptables;
    const val = (k) => {
      const i = argv.indexOf(k);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const listing = (chainSel) =>
      ["INPUT", "FORWARD", "OUTPUT"]
        .filter((c) => !chainSel || c === chainSel)
        .map(
          (c) =>
            `Chain ${c} (policy ACCEPT${argv.includes("-v") ? " 0 packets, 0 bytes" : ""})\n${argv.includes("--line-numbers") ? "num  " : ""}target     prot opt source               destination         \n` +
            R.filter((r) => r.chain === c)
              .map(
                (r, i) =>
                  `${argv.includes("--line-numbers") ? String(i + 1).padEnd(5) : ""}${r.target.padEnd(10)} ${(r.proto || "all").padEnd(4)} --  ${(r.src || (argv.includes("-n") ? "0.0.0.0/0" : "anywhere")).padEnd(20)} ${(argv.includes("-n") ? "0.0.0.0/0" : "anywhere").padEnd(20)}${r.dport ? `${r.proto || "tcp"} dpt:${argv.includes("-n") ? r.dport : { 22: "ssh", 80: "http", 443: "https" }[r.dport] || r.dport}` : ""}`,
              )
              .join("\n"),
        )
        .join("\n\n");
    if (argv.includes("-L")) return listing(val("-L") && !val("-L").startsWith("-") ? val("-L") : null);
    if (argv.includes("-S"))
      return (
        "-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n" +
        join(
          R.map(
            (r) =>
              `-A ${r.chain}${r.proto ? " -p " + r.proto : ""}${r.src ? " -s " + r.src : ""}${r.dport ? " -m " + r.proto + " --dport " + r.dport : ""} -j ${r.target}`,
          ),
        )
      );
    if (argv.includes("-F")) {
      h.firewall.iptables = [];
      return "";
    }
    for (const op of ["-A", "-I", "-D"]) {
      if (!argv.includes(op)) continue;
      const rule = { chain: val(op), proto: val("-p"), src: val("-s"), dport: val("--dport"), target: val("-j") };
      if (!rule.target)
        return {
          stdout: "",
          stderr:
            "iptables v1.8.7 (nf_tables): unknown option\nTry `iptables -h' or 'iptables --help' for more information.\n",
          code: 2,
        };
      if (op === "-D") {
        const i = R.findIndex((r) => r.chain === rule.chain && r.dport === rule.dport && r.target === rule.target);
        if (i < 0)
          return { stdout: "", stderr: "iptables: Bad rule (does a matching rule exist in that chain?).\n", code: 1 };
        R.splice(i, 1);
        return "";
      }
      if (op === "-I") R.unshift(rule);
      else R.push(rule);
      ctx.world.emit(
        `${h.hostname}: iptables ${op} ${rule.chain} ${rule.dport ? "dport " + rule.dport + " " : ""}-j ${rule.target}`,
        /DROP|REJECT/.test(rule.target) ? "WARN" : "INFO",
      );
      return (
        IG.t(
          "ℹ iptables のルールは即時反映されますが、再起動で消えます（永続化は iptables-persistent / netfilter-persistent）。\n",
        ).replace(/^/, "") && ""
      );
    }
    return {
      stdout: "",
      stderr:
        "iptables v1.8.7 (nf_tables): no command specified\nTry `iptables -h' or 'iptables --help' for more information.\n",
      code: 2,
    };
  };
  C["firewall-cmd"] = (argv, ctx) => {
    const h = ctx.host;
    if (h.svcState("firewalld") !== "active") return { stdout: "", stderr: "FirewallD is not running\n", code: 252 };
    const fw = h.firewall.firewalld;
    fw.perm = fw.perm || { ports: fw.ports.slice(), services: fw.services.slice() };
    const perm = argv.includes("--permanent");
    const tgt = perm ? fw.perm : fw;
    const val = (k) => (argv.find((a) => a.startsWith(k + "=")) || "").split("=")[1];
    const mutating = argv.some((a) => /^--(add|remove)-|^--reload|^--set/.test(a));
    if (mutating && !root(ctx))
      return {
        stdout: "",
        stderr: "Authorization failed.\n    Make sure polkit agent is running or run the application as superuser.\n",
        code: 252,
      };
    if (argv.includes("--state")) return "running";
    if (argv.includes("--get-default-zone")) return "public";
    if (argv.includes("--get-active-zones")) return `public\n  interfaces: ens5`;
    if (argv.includes("--reload")) {
      fw.ports = fw.perm.ports.slice();
      fw.services = fw.perm.services.slice();
      return "success";
    }
    if (argv.includes("--list-all"))
      return `public (active)\n  target: default\n  icmp-block-inversion: no\n  interfaces: ens5\n  sources: \n  services: ${tgt.services.join(" ")}\n  ports: ${tgt.ports.join(" ")}\n  protocols: \n  forward: yes\n  masquerade: no\n  forward-ports: \n  source-ports: \n  icmp-blocks: \n  rich rules: `;
    if (argv.includes("--list-services")) return tgt.services.join(" ");
    if (argv.includes("--list-ports")) return tgt.ports.join(" ");
    const add = (kind, v) => {
      if (!v) return null;
      if (kind === "port" && !/^\d+(-\d+)?\/(tcp|udp)$/.test(v))
        return { stdout: "", stderr: `Error: INVALID_PORT: ${v}\n`, code: 103 };
      const list = kind === "port" ? tgt.ports : tgt.services;
      if (
        kind === "service" &&
        !["ssh", "http", "https", "cockpit", "dhcpv6-client", "mysql", "postgresql", "dns", "ntp"].includes(v)
      )
        return { stdout: "", stderr: `Error: INVALID_SERVICE: '${v}' not among existing services\n`, code: 101 };
      if (list.includes(v)) return { stdout: "success\n", stderr: `Warning: ALREADY_ENABLED: ${v}\n`, code: 0 };
      list.push(v);
      return "success";
    };
    const rem = (kind, v) => {
      const list = kind === "port" ? tgt.ports : tgt.services;
      const i = list.indexOf(v);
      if (i < 0) return { stdout: "success\n", stderr: `Warning: NOT_ENABLED: ${v}\n`, code: 0 };
      list.splice(i, 1);
      return "success";
    };
    if (val("--add-port")) return add("port", val("--add-port"));
    if (val("--add-service")) return add("service", val("--add-service"));
    if (val("--remove-port")) return rem("port", val("--remove-port"));
    if (val("--remove-service")) return rem("service", val("--remove-service"));
    return {
      stdout: "",
      stderr: IG.t(
        "usage: see firewall-cmd man page\nℹ --state / --list-all / --add-port=80/tcp [--permanent] / --add-service=http / --reload に対応しています。\n",
      ),
      code: 2,
    };
  };
  C.tcpdump = (argv, ctx) => {
    if (!root(ctx))
      return {
        stdout: "",
        stderr:
          "tcpdump: eth0: You don't have permission to capture on that device\n(socket: Operation not permitted)\n",
        code: 1,
      };
    const n = argv.includes("-c") ? Number(argv[argv.indexOf("-c") + 1]) : 5;
    const pkts = Array.from(
      { length: n },
      (_, i) =>
        `${IG.strftime("%T", ctx.world.now() + i * 120)}.${String(100000 + (U.hash("p" + i) % 899999))} IP 198.51.100.20.51522 > ${ctx.host.hostname}.ssh: Flags [P.], seq ${1000 + i * 36}:${1036 + i * 36}, ack ${4000 + i * 52}, win 501, length 36`,
    );
    return {
      stdout: join(pkts),
      stderr: `tcpdump: verbose output suppressed, use -v[v]... for full protocol decode\nlistening on ${ctx.host.os === "rhel" ? "ens5" : "eth0"}, link-type EN10MB (Ethernet), snapshot length 262144 bytes\n${n} packets captured\n${n + 2} packets received by filter\n0 packets dropped by kernel\n`,
      code: 0,
    };
  };
  C.nmap = (argv, ctx) => {
    const host = argv.filter((a) => !a.startsWith("-")).pop();
    const ip = host && resolve(ctx, host);
    if (!ip)
      return {
        stdout: `Starting Nmap 7.94 ( https://nmap.org ) at ${IG.strftime("%F %R UTC", ctx.world.now())}\nFailed to resolve "${host}".\nWARNING: No targets were specified, so 0 hosts scanned.\nNmap done: 0 IP addresses (0 hosts up) scanned in 0.03 seconds\n`,
        stderr: "",
        code: 0,
      };
    const ports = [22, 80, 443, 3306, 5432, 6379, 8080, 9090, 10250];
    const open = ports.map((p) => [p, tcpConnect(ctx, host, p)]).filter(([, r]) => r.ok);
    return `Starting Nmap 7.94 ( https://nmap.org ) at ${IG.strftime("%F %R UTC", ctx.world.now())}\nNmap scan report for ${host} (${ip})\nHost is up (0.00041s latency).\nNot shown: ${1000 - open.length} closed tcp ports (conn-refused)\nPORT     STATE SERVICE\n${open.map(([p]) => `${(p + "/tcp").padEnd(8)} open  ${SVC_NAME[p] && SVC_NAME[p] !== "*" ? SVC_NAME[p] : "unknown"}`).join("\n")}\n\nNmap done: 1 IP address (1 host up) scanned in 0.11 seconds`;
  };
})((globalThis.IG = globalThis.IG || {}));
