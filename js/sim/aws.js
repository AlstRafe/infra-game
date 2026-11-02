/* AWS simulation: STS identity, EC2 instances + security groups, S3 buckets with Block Public
 * Access, EKS clusters (update-kubeconfig), plus a subset of the aws CLI v2 with --query. */
(function (IG) {
  "use strict";
  const U = IG.util;
  IG.commands = IG.commands || {};
  const ok = (out) => ({ out, code: 0 });
  const fail = (out, code = 1) => ({ out, code, err: true });
  const USAGE =
    "usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help\n";

  function ipToInt(ip) {
    return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  }
  function inCidr(ip, cidr) {
    const [net, bits] = cidr.split("/");
    const b = Number(bits);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false;
    const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
  }

  class AWS {
    constructor(world, o = {}) {
      this.world = world;
      this.account = o.account || "123456789012";
      this.region = o.region || "ap-northeast-1";
      this.userName = o.userName || "operator";
      this.instances = [];
      this.sgs = {};
      this.buckets = {};
      this.eks = {};
    }
    get enabled() {
      return this.world.features.has("aws");
    }
    arn(kind, rest) {
      return `arn:aws:${kind}:${this.region}:${this.account}:${rest}`;
    }
    addSG(sg) {
      this.sgs[sg.id] = Object.assign({ vpc: "vpc-0a1b2c3d4e5f60718", ingress: [], description: sg.name }, sg);
      return this.sgs[sg.id];
    }
    addInstance(i) {
      const inst = Object.assign(
        {
          type: "t3.small",
          state: "running",
          az: this.region + "a",
          ami: "ami-0d52744d6551d851e",
          listen: [],
          sgIds: [],
          launched: this.world.now() - 21 * 86400e3,
        },
        i,
      );
      inst.publicDns = inst.publicIp
        ? `ec2-${inst.publicIp.replace(/\./g, "-")}.${this.region}.compute.amazonaws.com`
        : "";
      this.instances.push(inst);
      return inst;
    }
    addBucket(b) {
      this.buckets[b.name] = Object.assign(
        {
          region: this.region,
          objects: {},
          pab: {
            BlockPublicAcls: false,
            IgnorePublicAcls: false,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false,
          },
          policyPublic: false,
          created: this.world.now() - 90 * 86400e3,
        },
        b,
      );
      return this.buckets[b.name];
    }
    bucketPublic(b) {
      return b.policyPublic && !b.pab.RestrictPublicBuckets;
    }
    dns(name) {
      const i = this.instances.find((x) => x.publicDns === name);
      if (i) return i.publicIp;
      if (/\.amazonaws\.com$/.test(name)) return "52.219." + (U.hash(name) % 200) + "." + (U.hash(name + 1) % 200);
      return null;
    }
    http(req, from) {
      const srcIp =
        from.kind === "host" && this.world.hosts[from.host]
          ? this.world.hosts[from.host].publicIp || this.world.hosts[from.host].ip
          : "10.0.1.20";
      const inst = this.instances.find((x) => x.publicIp === req.host || x.publicDns === req.host);
      if (inst) {
        const timeout = {
          error: `curl: (28) Failed to connect to ${req.host} port ${req.port} after 10002 ms: Timeout was reached`,
          target: { kind: "ec2", id: inst.id },
        };
        if (inst.state !== "running") return timeout;
        const allowed = inst.sgIds.some((id) =>
          (this.sgs[id] ? this.sgs[id].ingress : []).some(
            (r) =>
              (r.proto === "-1" || r.proto === "tcp") &&
              req.port >= r.from &&
              req.port <= r.to &&
              r.cidrs.some((c) => inCidr(srcIp, c)),
          ),
        );
        if (!allowed) return timeout;
        if (!inst.listen.includes(req.port))
          return {
            error: `curl: (7) Failed to connect to ${req.host} port ${req.port} after 4 ms: Couldn't connect to server`,
            target: { kind: "ec2", id: inst.id },
          };
        if (req.port === 22)
          return {
            error: IG.t("curl: (1) Received HTTP/0.9 when not allowed\nℹ 22番は SSH です（SSH-2.0-OpenSSH_9.6）。"),
            target: { kind: "ec2", id: inst.id },
          };
        const r = IG.runtime.respond({ kind: "web", server: "nginx/1.26.2", body: inst.body }, req.path);
        return Object.assign({ target: { kind: "ec2", id: inst.id } }, r);
      }
      let m = req.host.match(/^([a-z0-9.-]+)\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com$/);
      let bucket, key;
      if (m && m[1] !== "s3") {
        bucket = m[1];
        key = req.path.replace(/^\//, "").split("?")[0];
      } else if (/^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(req.host)) {
        const parts = req.path.replace(/^\//, "").split("/");
        bucket = parts.shift();
        key = parts.join("/");
      }
      if (bucket !== undefined) {
        const b = this.buckets[bucket];
        const xml = (code, msg) =>
          `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${msg}</Message><RequestId>${U.hex(req.path, 16).toUpperCase()}</RequestId></Error>`;
        if (!b)
          return {
            status: 404,
            body: xml("NoSuchBucket", "The specified bucket does not exist"),
            target: { kind: "s3", bucket },
          };
        if (!this.bucketPublic(b))
          return { status: 403, body: xml("AccessDenied", "Access Denied"), target: { kind: "s3", bucket } };
        if (!key)
          return {
            status: 200,
            body: `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${bucket}</Name>${Object.keys(
              b.objects,
            )
              .map((k) => `<Contents><Key>${k}</Key></Contents>`)
              .join("")}</ListBucketResult>`,
            target: { kind: "s3", bucket },
          };
        if (!(key in b.objects))
          return {
            status: 404,
            body: xml("NoSuchKey", "The specified key does not exist."),
            target: { kind: "s3", bucket },
          };
        return { status: 200, body: b.objects[key], target: { kind: "s3", bucket } };
      }
      return null;
    }
  }

  /* ------------------------------------------------------------ mini JMESPath for --query */
  function jmes(data, expr) {
    let s = expr.trim(),
      i = 0;
    const peek = () => s[i],
      eat = (c) => {
        if (s[i] === c) {
          i++;
          return true;
        }
        return false;
      };
    const ws = () => {
      while (s[i] === " ") i++;
    };
    function ident() {
      ws();
      let j = i;
      if (s[i] === '"') {
        j = s.indexOf('"', i + 1);
        const id = s.slice(i + 1, j);
        i = j + 1;
        return id;
      }
      while (j < s.length && /[\w-]/.test(s[j])) j++;
      const id = s.slice(i, j);
      i = j;
      return id;
    }
    function literal() {
      ws();
      if (s[i] === "'") {
        const j = s.indexOf("'", i + 1);
        const v = s.slice(i + 1, j);
        i = j + 1;
        return v;
      }
      if (s[i] === "`") {
        const j = s.indexOf("`", i + 1);
        const v = JSON.parse(s.slice(i + 1, j));
        i = j + 1;
        return v;
      }
      return undefined;
    }
    function expression(cur, projected) {
      let projection = projected;
      for (;;) {
        ws();
        const c = peek();
        if (c === ".") {
          i++;
          ws();
          if (peek() === "[" || peek() === "{") continue;
          const id = ident();
          cur = projection
            ? cur.map((x) => (x == null ? undefined : x[id])).filter((x) => x !== undefined)
            : cur == null
              ? undefined
              : cur[id];
          continue;
        }
        if (c === "[") {
          i++;
          ws();
          if (eat("]")) {
            const base = projection ? cur : [cur];
            cur = projection ? base.flatMap((x) => (Array.isArray(x) ? x : [x])) : Array.isArray(cur) ? cur.flat() : [];
            projection = true;
            continue;
          }
          if (eat("*")) {
            eat("]");
            cur = projection ? cur.flat() : Array.isArray(cur) ? cur : [];
            projection = true;
            continue;
          }
          if (peek() === "?") {
            i++;
            const lhsStart = i;
            let depth = 0;
            while (i < s.length && !(depth === 0 && s[i] === "]")) {
              if (s[i] === "[") depth++;
              if (s[i] === "]") depth--;
              i++;
            }
            const cond = s.slice(lhsStart, i);
            i++;
            const m = cond.match(/^\s*(.+?)\s*(==|!=)\s*(.+?)\s*$/);
            const arr = projection ? cur.flat() : cur || [];
            cur = arr.filter((x) => {
              if (!m) return !!jmes(x, cond);
              const l = jmes(x, m[1]);
              const r = /^'|^`/.test(m[3])
                ? m[3].startsWith("'")
                  ? m[3].slice(1, -1)
                  : JSON.parse(m[3].slice(1, -1))
                : jmes(x, m[3]);
              return m[2] === "==" ? l === r : l !== r;
            });
            projection = true;
            continue;
          }
          if (/\d|-/.test(peek())) {
            let j = i;
            while (/[\d-]/.test(s[j])) j++;
            const n = Number(s.slice(i, j));
            i = j;
            eat("]");
            const pick = (a) => (Array.isArray(a) ? a[n < 0 ? a.length + n : n] : undefined);
            cur = projection ? cur.map(pick) : pick(cur);
            continue;
          }
          const items = [];
          const startI = i;
          for (;;) {
            const sub = takeUntil([",", "]"]);
            items.push(sub);
            if (s[i] === ",") {
              i++;
              continue;
            }
            i++;
            break;
          }
          void startI;
          const sel = (x) => items.map((e) => jmes(x, e));
          cur = projection ? cur.map(sel) : sel(cur);
          continue;
        }
        if (c === "{") {
          i++;
          const pairs = [];
          for (;;) {
            ws();
            const k = ident();
            ws();
            eat(":");
            const v = takeUntil([",", "}"]);
            pairs.push([k, v]);
            if (s[i] === ",") {
              i++;
              continue;
            }
            i++;
            break;
          }
          const sel = (x) => Object.fromEntries(pairs.map(([k, v]) => [k, jmes(x, v)]));
          cur = projection ? cur.map(sel) : sel(cur);
          continue;
        }
        if (c === "|") {
          i++;
          projection = false;
          continue;
        }
        if (c === undefined) return cur;
        if (/[\w"]/.test(c)) {
          const id = ident();
          cur = projection
            ? cur.map((x) => (x == null ? undefined : x[id])).filter((x) => x !== undefined)
            : cur == null
              ? undefined
              : cur[id];
          continue;
        }
        const lit = literal();
        if (lit !== undefined) return lit;
        i++;
      }
    }
    function takeUntil(stops) {
      ws();
      let j = i,
        depth = 0,
        q = null;
      while (j < s.length) {
        const ch = s[j];
        if (q) {
          if (ch === q) q = null;
        } else if (ch === "'" || ch === "`") q = ch;
        else if ("[{(".includes(ch)) depth++;
        else if ("]})".includes(ch)) {
          if (depth === 0 && stops.includes(ch)) break;
          depth--;
        } else if (depth === 0 && stops.includes(ch)) break;
        j++;
      }
      const sub = s.slice(i, j).trim();
      i = j;
      return sub;
    }
    try {
      return expression(data, false);
    } catch (e) {
      return null;
    }
  }
  function toText(v) {
    if (v == null) return "None";
    if (!Array.isArray(v) && typeof v !== "object") return String(v);
    if (Array.isArray(v) && v.every((x) => !Array.isArray(x) && (typeof x !== "object" || x === null)))
      return v.map((x) => (x == null ? "None" : String(x))).join("\t");
    if (Array.isArray(v)) return v.map(toText).join("\n");
    return Object.values(v).map(toText).join("\t");
  }

  /* ------------------------------------------------------------ CLI */
  const VF = [
    "region",
    "output",
    "query",
    "profile",
    "instance-ids",
    "group-ids",
    "group-names",
    "group-id",
    "protocol",
    "port",
    "cidr",
    "ip-permissions",
    "bucket",
    "public-access-block-configuration",
    "name",
    "filters",
    "key",
    "policy",
    "role-arn",
    "alias",
  ];
  function aws(argv, ctx) {
    const w = ctx.world,
      A = w.aws;
    if (argv[0] === "--version") return ok("aws-cli/2.18.5 Python/3.12.6 Linux/5.15.0-1066-aws exe/x86_64.ubuntu.22");
    if (!A || !A.enabled)
      return fail(
        IG.t(
          '\nUnable to locate credentials. You can configure credentials by running "aws configure".\n\nℹ このミッションでは AWS を使いません。',
        ),
      );
    if (ctx.pod) return fail('OCI runtime exec failed: exec: "aws": executable file not found in $PATH: unknown', 126);
    // multi-value flags like --instance-ids a b
    const multi = new Set(["instance-ids", "group-ids", "group-names"]);
    const norm = [];
    for (let i = 0; i < argv.length; i++) {
      norm.push(argv[i]);
      const k = argv[i].replace(/^--/, "");
      if (argv[i].startsWith("--") && multi.has(k)) {
        const vals = [];
        while (argv[i + 1] && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
        norm.push(vals.join(","));
      }
    }
    const a = U.args(norm, VF);
    const [svc, op] = a.pos;
    const q = U.first(a.flags.query);
    const outFmt = U.first(a.flags.output) || "json";
    const out = (obj) => {
      let v = q ? jmes(obj, q.replace(/^['"]|['"]$/g, "")) : obj;
      if (outFmt === "text") return ok(toText(v));
      if (outFmt === "table")
        return ok(JSON.stringify(v, null, 4) + IG.t("\n\nℹ --output table は未対応のため JSON で表示しました。"));
      return ok(v === undefined ? "" : JSON.stringify(v, null, 4));
    };
    const need = (...names) => {
      const miss = names.filter((n) => !a.flags[n]);
      return miss.length
        ? fail(USAGE + `aws: error: the following arguments are required: ${miss.map((n) => "--" + n).join(", ")}`, 252)
        : null;
    };
    const opErr = (code, opName, msg) =>
      fail(`\nAn error occurred (${code}) when calling the ${opName} operation: ${msg}`, 254);
    if (!svc || svc === "help")
      return ok(
        IG.t(
          "AWS CLI (simulated subset)\n\n  aws sts get-caller-identity\n  aws configure list | get region | set region <r>\n  aws ec2 describe-instances | describe-security-groups | authorize-security-group-ingress | revoke-security-group-ingress | start-instances | stop-instances\n  aws s3 ls | cp | mb\n  aws s3api get-public-access-block | put-public-access-block | get-bucket-policy | get-bucket-policy-status | delete-bucket-policy\n  aws eks list-clusters | describe-cluster | update-kubeconfig\n\n共通: --query '<JMESPath>' --output json|text",
        ),
      );
    switch (svc) {
      case "configure": {
        if (op === "list" || !op)
          return ok(
            `      Name                    Value             Type    Location\n      ----                    -----             ----    --------\n   profile                <not set>             None    None\naccess_key     ****************7QXA shared-credentials-file    \nsecret_key     ****************r2Lk shared-credentials-file    \n    region           ${A.region.padEnd(16)}      config-file    ~/.aws/config`,
          );
        if (op === "get") return a.pos[2] === "region" ? ok(A.region) : ok("");
        if (op === "set") {
          if (a.pos[2] === "region" && a.pos[3]) A.region = a.pos[3];
          return ok("");
        }
        return fail(USAGE + `aws: error: argument operation: Invalid choice: '${op}'`, 252);
      }
      case "sts":
        if (op === "get-caller-identity") {
          w.flags.awsWhoami = true;
          return out({
            UserId: "AIDA" + U.hex("uid", 17).toUpperCase(),
            Account: A.account,
            Arn: `arn:aws:iam::${A.account}:user/${A.userName}`,
          });
        }
        return fail(
          USAGE + `aws: error: argument operation: Invalid choice, valid choices are:\n\nget-caller-identity`,
          252,
        );
      case "ec2":
        return ec2(op, a, A, w, out, need, opErr);
      case "s3":
        return s3(a, A, w, ctx);
      case "s3api":
        return s3api(op, a, A, w, out, need, opErr);
      case "eks": {
        if (op === "list-clusters") return out({ clusters: Object.keys(A.eks) });
        if (op === "describe-cluster") {
          const e = need("name");
          if (e) return e;
          const c = A.eks[U.first(a.flags.name)];
          if (!c)
            return opErr(
              "ResourceNotFoundException",
              "DescribeCluster",
              `No cluster found for name: ${U.first(a.flags.name)}.`,
            );
          return out({
            cluster: {
              name: c.name,
              arn: A.arn("eks", "cluster/" + c.name),
              version: c.version,
              endpoint: c.endpoint,
              status: c.status,
              platformVersion: "eks.12",
              resourcesVpcConfig: {
                vpcId: "vpc-0a1b2c3d4e5f60718",
                endpointPublicAccess: false,
                endpointPrivateAccess: true,
              },
            },
          });
        }
        if (op === "update-kubeconfig") {
          const e = need("name");
          if (e) return e;
          const name = U.first(a.flags.name);
          const region = U.first(a.flags.region) || A.region;
          const c = A.eks[name];
          if (!c || region !== A.region)
            return opErr("ResourceNotFoundException", "DescribeCluster", `No cluster found for name: ${name}.`);
          const arn = A.arn("eks", "cluster/" + name);
          const existed = !!w.kube.contexts[arn];
          w.addContext(arn, c.clusterName, "default", arn);
          const kc = ctx.host.home + "/.kube/config";
          ctx.vfs.write(
            kc,
            IG.yaml.stringify({
              "apiVersion": "v1",
              "kind": "Config",
              "clusters": [
                {
                  cluster: { "server": c.endpoint, "certificate-authority-data": "LS0tLS1CRUdJTi...(training)" },
                  name: arn,
                },
              ],
              "contexts": [{ context: { cluster: arn, user: arn }, name: arn }],
              "current-context": arn,
              "users": [
                {
                  name: arn,
                  user: {
                    exec: {
                      apiVersion: "client.authentication.k8s.io/v1beta1",
                      command: "aws",
                      args: ["--region", region, "eks", "get-token", "--cluster-name", name, "--output", "json"],
                    },
                  },
                },
              ],
            }),
            { mkdirs: true },
          );
          w.emit(`kubeconfig updated for EKS ${name}`);
          return ok(`${existed ? "Updated context" : "Added new context"} ${arn} to ${ctx.host.home}/.kube/config`);
        }
        return fail(
          USAGE +
            `aws: error: argument operation: Invalid choice, valid choices are:\n\ndescribe-cluster | list-clusters | update-kubeconfig`,
          252,
        );
      }
      default:
        return fail(
          USAGE +
            `aws: error: argument command: Invalid choice, valid choices are:\n\nconfigure | ec2 | eks | s3 | s3api | sts`,
          252,
        );
    }
  }

  function parsePerm(a) {
    if (a.flags["ip-permissions"]) {
      const raw = U.first(a.flags["ip-permissions"]);
      let p;
      try {
        p = JSON.parse(raw);
        p = Array.isArray(p) ? p[0] : p;
      } catch (e) {
        const m = {};
        raw.replace(/(\w+)=([^,[]+|\[[^\]]*\])/g, (_, k, v) => {
          m[k] = v;
        });
        p = {
          IpProtocol: m.IpProtocol,
          FromPort: Number(m.FromPort),
          ToPort: Number(m.ToPort),
          IpRanges: [...String(m.IpRanges || "").matchAll(/CidrIp=([\d./]+)/g)].map((x) => ({ CidrIp: x[1] })),
        };
      }
      return {
        proto: String(p.IpProtocol),
        from: Number(p.FromPort),
        to: Number(p.ToPort),
        cidrs: (p.IpRanges || []).map((r) => r.CidrIp),
      };
    }
    const port = String(U.first(a.flags.port) || "");
    const [from, to] = port.includes("-") ? port.split("-").map(Number) : [Number(port), Number(port)];
    return { proto: String(U.first(a.flags.protocol) || "tcp"), from, to, cidrs: [U.first(a.flags.cidr)] };
  }
  function sgJson(sg) {
    return {
      Description: sg.description,
      GroupName: sg.name,
      GroupId: sg.id,
      OwnerId: "123456789012",
      VpcId: sg.vpc,
      IpPermissions: sg.ingress.map((r) => ({
        IpProtocol: r.proto,
        FromPort: r.from,
        ToPort: r.to,
        IpRanges: r.cidrs.map((c) => Object.assign({ CidrIp: c }, r.desc ? { Description: r.desc } : {})),
        Ipv6Ranges: [],
        PrefixListIds: [],
        UserIdGroupPairs: [],
      })),
      IpPermissionsEgress: [
        {
          IpProtocol: "-1",
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          Ipv6Ranges: [],
          PrefixListIds: [],
          UserIdGroupPairs: [],
        },
      ],
      Tags: [{ Key: "Name", Value: sg.name }],
    };
  }
  function ec2(op, a, A, w, out, need, opErr) {
    switch (op) {
      case "describe-instances": {
        let list = A.instances;
        const ids = U.first(a.flags["instance-ids"]);
        if (ids) {
          const want = String(ids).split(",");
          const missing = want.find((id) => !A.instances.some((i) => i.id === id));
          if (missing)
            return opErr(
              "InvalidInstanceID.NotFound",
              "DescribeInstances",
              `The instance ID '${missing}' does not exist`,
            );
          list = list.filter((i) => want.includes(i.id));
        }
        return out({
          Reservations: list.map((i) => ({
            ReservationId: "r-" + U.hex(i.id, 17),
            OwnerId: A.account,
            Instances: [
              {
                InstanceId: i.id,
                ImageId: i.ami,
                InstanceType: i.type,
                LaunchTime: new Date(i.launched).toISOString(),
                Placement: { AvailabilityZone: i.az },
                PrivateIpAddress: i.privateIp,
                PublicIpAddress: i.state === "running" ? i.publicIp : undefined,
                PublicDnsName: i.state === "running" ? i.publicDns : "",
                State: { Code: i.state === "running" ? 16 : 80, Name: i.state },
                SecurityGroups: i.sgIds.map((id) => ({ GroupId: id, GroupName: A.sgs[id] ? A.sgs[id].name : id })),
                SubnetId: "subnet-0f1e2d3c4b5a69788",
                VpcId: "vpc-0a1b2c3d4e5f60718",
                Tags: [{ Key: "Name", Value: i.name }].concat(i.tags || []),
              },
            ],
          })),
        });
      }
      case "describe-security-groups": {
        let list = Object.values(A.sgs);
        const ids = U.first(a.flags["group-ids"]);
        const names = U.first(a.flags["group-names"]);
        if (ids) {
          const want = String(ids).split(",");
          const missing = want.find((id) => !A.sgs[id]);
          if (missing)
            return opErr(
              "InvalidGroup.NotFound",
              "DescribeSecurityGroups",
              `The security group '${missing}' does not exist`,
            );
          list = list.filter((s) => want.includes(s.id));
        }
        if (names) list = list.filter((s) => String(names).split(",").includes(s.name));
        w.flags.sgDescribed = true;
        return out({ SecurityGroups: list.map(sgJson) });
      }
      case "authorize-security-group-ingress":
      case "revoke-security-group-ingress": {
        const e = need("group-id");
        if (e) return e;
        const sg = A.sgs[U.first(a.flags["group-id"])];
        const opName =
          op === "authorize-security-group-ingress" ? "AuthorizeSecurityGroupIngress" : "RevokeSecurityGroupIngress";
        if (!sg)
          return opErr(
            "InvalidGroup.NotFound",
            opName,
            `The security group '${U.first(a.flags["group-id"])}' does not exist`,
          );
        const p = parsePerm(a);
        if (!p.cidrs[0] || isNaN(p.from))
          return fail(USAGE + "aws: error: --port and --cidr (or --ip-permissions) are required", 252);
        if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(p.cidrs[0]))
          return opErr("InvalidParameterValue", opName, `CIDR block ${p.cidrs[0]} is malformed`);
        const same = (r) => r.proto === p.proto && r.from === p.from && r.to === p.to;
        if (op === "authorize-security-group-ingress") {
          const dup = sg.ingress.find((r) => same(r) && r.cidrs.includes(p.cidrs[0]));
          if (dup)
            return opErr(
              "InvalidPermission.Duplicate",
              opName,
              `the specified rule "peer: ${p.cidrs[0]}, TCP, from port: ${p.from}, to port: ${p.to}, ALLOW" already exists`,
            );
          sg.ingress.push({ proto: p.proto, from: p.from, to: p.to, cidrs: [p.cidrs[0]] });
          w.emit(
            `SG ${sg.id}: allow ${p.proto}/${p.from} from ${p.cidrs[0]}`,
            p.cidrs[0] === "0.0.0.0/0" && p.from === 22 ? "WARN" : "INFO",
          );
          return ok(
            JSON.stringify(
              {
                Return: true,
                SecurityGroupRules: [
                  {
                    SecurityGroupRuleId: "sgr-" + U.hex(sg.id + p.from + p.cidrs[0], 17),
                    GroupId: sg.id,
                    GroupOwnerId: A.account,
                    IsEgress: false,
                    IpProtocol: p.proto,
                    FromPort: p.from,
                    ToPort: p.to,
                    CidrIpv4: p.cidrs[0],
                  },
                ],
              },
              null,
              4,
            ),
          );
        }
        const rule = sg.ingress.find((r) => same(r) && r.cidrs.includes(p.cidrs[0]));
        if (!rule)
          return opErr(
            "InvalidPermission.NotFound",
            opName,
            `The specified rule does not exist in this security group.`,
          );
        rule.cidrs = rule.cidrs.filter((c) => c !== p.cidrs[0]);
        sg.ingress = sg.ingress.filter((r) => r.cidrs.length);
        w.emit(`SG ${sg.id}: revoked ${p.proto}/${p.from} from ${p.cidrs[0]}`);
        return ok(JSON.stringify({ Return: true }, null, 4));
      }
      case "start-instances":
      case "stop-instances": {
        const e = need("instance-ids");
        if (e) return e;
        const ids = String(U.first(a.flags["instance-ids"])).split(",");
        const res = [];
        for (const id of ids) {
          const i = A.instances.find((x) => x.id === id);
          if (!i)
            return opErr(
              "InvalidInstanceID.NotFound",
              op === "start-instances" ? "StartInstances" : "StopInstances",
              `The instance ID '${id}' does not exist`,
            );
          const prev = i.state;
          i.state = op === "start-instances" ? "running" : "stopped";
          res.push({
            InstanceId: id,
            CurrentState: {
              Code: op === "start-instances" ? 0 : 64,
              Name: op === "start-instances" ? "pending" : "stopping",
            },
            PreviousState: { Code: prev === "running" ? 16 : 80, Name: prev },
          });
          w.emit(`EC2 ${id} ${i.state}`);
        }
        return out({ [op === "start-instances" ? "StartingInstances" : "StoppingInstances"]: res });
      }
      default:
        return fail(
          USAGE +
            `aws: error: argument operation: Invalid choice, valid choices are:\n\nauthorize-security-group-ingress | describe-instances | describe-security-groups | revoke-security-group-ingress | start-instances | stop-instances`,
          252,
        );
    }
  }
  function s3(a, A, w, ctx) {
    const [, op, p1, p2] = a.pos;
    const parse = (s) => {
      const m = String(s || "").match(/^s3:\/\/([^/]+)\/?(.*)$/);
      return m ? { bucket: m[1], key: m[2] } : null;
    };
    if (op === "ls") {
      if (!p1)
        return ok(
          Object.values(A.buckets)
            .map((b) => `${new Date(b.created).toISOString().replace("T", " ").slice(0, 19)} ${b.name}`)
            .join("\n"),
        );
      const t = parse(p1);
      const b = t && A.buckets[t.bucket];
      if (!b)
        return fail(
          `\nAn error occurred (NoSuchBucket) when calling the ListObjectsV2 operation: The specified bucket does not exist`,
          254,
        );
      return ok(
        Object.entries(b.objects)
          .filter(([k]) => k.startsWith(t.key))
          .map(
            ([k, v]) =>
              `${new Date(b.created + 86400e3).toISOString().replace("T", " ").slice(0, 19)} ${String(v.length).padStart(10)} ${k}`,
          )
          .join("\n"),
      );
    }
    if (op === "mb") {
      const t = parse(p1);
      if (!t) return fail('\nParameter validation failed:\nInvalid bucket name ""', 252);
      if (A.buckets[t.bucket])
        return fail(
          `make_bucket failed: s3://${t.bucket} An error occurred (BucketAlreadyOwnedByYou) when calling the CreateBucket operation: Your previous request to create the named bucket succeeded and you already own it.`,
        );
      const b = A.addBucket({ name: t.bucket, created: w.now() });
      b.pab = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
      return ok(`make_bucket: ${t.bucket}`);
    }
    if (op === "cp") {
      const src = parse(p1),
        dst = parse(p2);
      if (!src && dst) {
        const b = A.buckets[dst.bucket];
        const content = ctx.vfs.read(ctx.resolve(p1));
        if (content === undefined) return fail(`\nThe user-provided path ${p1} does not exist.`, 255);
        if (!b)
          return fail(
            `upload failed: ${p1} to ${p2} An error occurred (NoSuchBucket) when calling the PutObject operation: The specified bucket does not exist`,
          );
        const key = !dst.key || dst.key.endsWith("/") ? dst.key + IG.VFS.base(ctx.resolve(p1)) : dst.key;
        b.objects[key] = content;
        return ok(`upload: ${p1} to s3://${dst.bucket}/${key}`);
      }
      if (src && !dst) {
        const b = A.buckets[src.bucket];
        if (!b || !(src.key in b.objects))
          return fail(
            `fatal error: An error occurred (404) when calling the HeadObject operation: Key "${src.key}" does not exist`,
          );
        const target = ctx.resolve(p2 === "." || !p2 ? IG.VFS.base("/" + src.key) : p2);
        ctx.vfs.write(ctx.vfs.isDir(target) ? target + "/" + IG.VFS.base("/" + src.key) : target, b.objects[src.key]);
        return ok(`download: s3://${src.bucket}/${src.key} to ${p2 || "./" + IG.VFS.base("/" + src.key)}`);
      }
      return fail(IG.t("ℹ aws s3 cp は <ローカル> → s3://… または s3://… → <ローカル> の形式のみ対応しています。"));
    }
    return fail(USAGE + `aws: error: argument subcommand: Invalid choice, valid choices are:\n\nls | cp | mb`, 252);
  }
  function s3api(op, a, A, w, out, need, opErr) {
    const bname = U.first(a.flags.bucket);
    const b = bname && A.buckets[bname];
    const opName = op
      ? op
          .split("-")
          .map((s) => s[0].toUpperCase() + s.slice(1))
          .join("")
      : "";
    const noBucket = () => opErr("NoSuchBucket", opName, "The specified bucket does not exist");
    switch (op) {
      case "get-public-access-block": {
        const e = need("bucket");
        if (e) return e;
        if (!b) return noBucket();
        if (!Object.values(b.pab).some(Boolean))
          return opErr(
            "NoSuchPublicAccessBlockConfiguration",
            "GetPublicAccessBlock",
            "The public access block configuration was not found",
          );
        return out({ PublicAccessBlockConfiguration: Object.assign({}, b.pab) });
      }
      case "put-public-access-block": {
        const e = need("bucket", "public-access-block-configuration");
        if (e) return e;
        if (!b) return noBucket();
        const raw = U.first(a.flags["public-access-block-configuration"]);
        let cfg = {};
        try {
          cfg = JSON.parse(raw);
        } catch (err) {
          raw.replace(/(\w+)=(true|false)/gi, (_, k, v) => {
            cfg[k] = v.toLowerCase() === "true";
          });
        }
        const keys = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"];
        const bad = Object.keys(cfg).find((k) => !keys.includes(k));
        if (bad)
          return fail(
            `\nParameter validation failed:\nUnknown parameter in PublicAccessBlockConfiguration: "${bad}", must be one of: ${keys.join(", ")}`,
            252,
          );
        for (const k of keys) b.pab[k] = !!cfg[k];
        w.emit(
          `S3 ${b.name}: Block Public Access = ${keys.map((k) => (b.pab[k] ? "✓" : "✗")).join("")}`,
          keys.every((k) => b.pab[k]) ? "INFO" : "WARN",
        );
        return ok("");
      }
      case "get-bucket-policy": {
        const e = need("bucket");
        if (e) return e;
        if (!b) return noBucket();
        if (!b.policyPublic && !b.policy)
          return opErr("NoSuchBucketPolicy", "GetBucketPolicy", "The bucket policy does not exist");
        return out({
          Policy: JSON.stringify(
            b.policy || {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "PublicRead",
                  Effect: "Allow",
                  Principal: "*",
                  Action: "s3:GetObject",
                  Resource: `arn:aws:s3:::${b.name}/*`,
                },
              ],
            },
          ),
        });
      }
      case "get-bucket-policy-status": {
        const e = need("bucket");
        if (e) return e;
        if (!b) return noBucket();
        return out({ PolicyStatus: { IsPublic: A.bucketPublic(b) } });
      }
      case "delete-bucket-policy": {
        const e = need("bucket");
        if (e) return e;
        if (!b) return noBucket();
        b.policyPublic = false;
        b.policy = null;
        w.emit(`S3 ${b.name}: bucket policy deleted`);
        return ok("");
      }
      case "list-buckets":
        return out({
          Buckets: Object.values(A.buckets).map((x) => ({
            Name: x.name,
            CreationDate: new Date(x.created).toISOString(),
          })),
          Owner: { DisplayName: "operator", ID: U.hex("owner", 64) },
        });
      default:
        return fail(
          USAGE +
            `aws: error: argument operation: Invalid choice, valid choices are:\n\ndelete-bucket-policy | get-bucket-policy | get-bucket-policy-status | get-public-access-block | list-buckets | put-public-access-block`,
          252,
        );
    }
  }

  IG.AWS = AWS;
  IG.awsJmes = jmes;
  IG.commands.aws = aws;
})((globalThis.IG = globalThis.IG || {}));
