/* CoreLab core utilities: clock, formatting, YAML subset, virtual filesystem.
 * Everything under js/core, js/sim and js/game is DOM-free so it can run in Node (see tests/). */
(function (IG) {
  "use strict";

  // Simulation clock. Tests advance `offset` to skip transient states such as ContainerCreating.
  IG.clock = {
    offset: 0,
    now() {
      return Date.now() + this.offset;
    },
  };

  const SAFE = "bcdfghjklmnpqrstvwxz2456789";

  const util = {
    hash(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    },
    // Kubernetes-like random-looking but deterministic suffix.
    suffix(seed, len = 5) {
      let h = util.hash(seed),
        s = "";
      for (let i = 0; i < len; i++) {
        s += SAFE[h % SAFE.length];
        h = Math.floor(h / SAFE.length) ^ util.hash(seed + i);
        h >>>= 0;
      }
      return s;
    },
    hex(seed, len = 12) {
      let s = "";
      for (let i = 0; s.length < len; i++)
        s += util
          .hash(seed + ":" + i)
          .toString(16)
          .padStart(8, "0");
      return s.slice(0, len);
    },
    clone(v) {
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    isObj(v) {
      return v !== null && typeof v === "object" && !Array.isArray(v);
    },
    // Strategic-merge-ish patch: maps merge, arrays of named objects merge by name, null deletes.
    merge(target, patch) {
      if (!util.isObj(patch)) return util.clone(patch);
      const out = util.isObj(target) ? util.clone(target) : {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) {
          delete out[k];
          continue;
        }
        if (Array.isArray(v) && Array.isArray(out[k]) && v.every((x) => util.isObj(x) && x.name)) {
          const arr = out[k].slice();
          for (const item of v) {
            const i = arr.findIndex((x) => x && x.name === item.name);
            if (i >= 0) arr[i] = util.merge(arr[i], item);
            else arr.push(util.clone(item));
          }
          out[k] = arr;
        } else if (util.isObj(v)) out[k] = util.merge(out[k], v);
        else out[k] = util.clone(v);
      }
      return out;
    },
    table(headers, rows) {
      const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? "")));
      const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || "").length)));
      return all
        .map((r) =>
          r
            .map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3)))
            .join("")
            .trimEnd(),
        )
        .join("\n");
    },
    age(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 120) return s + "s";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      if (h < 48) return h + "h";
      return Math.floor(h / 24) + "d";
    },
    cpu(q) {
      // -> millicores
      if (q === undefined || q === null || q === "") return 0;
      const s = String(q);
      return s.endsWith("m") ? parseFloat(s) : Math.round(parseFloat(s) * 1000);
    },
    mem(q) {
      // -> MiB
      if (q === undefined || q === null || q === "") return 0;
      const m = String(q).match(/^([\d.]+)\s*([KMGT]i?)?$/);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      const f = {
        Ki: 1 / 1024,
        Mi: 1,
        Gi: 1024,
        Ti: 1048576,
        K: 1e3 / 1048576,
        M: 1e6 / 1048576,
        G: 1e9 / 1048576,
        T: 1e12 / 1048576,
      }[m[2]];
      return f ? n * f : n / 1048576;
    },
    human(bytes) {
      // du/df style
      const u = ["", "K", "M", "G", "T"];
      let i = 0,
        n = bytes;
      while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
      }
      if (i === 0) return String(Math.round(n));
      return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + u[i];
    },
    b64(s) {
      if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(s)));
      return Buffer.from(s, "utf8").toString("base64");
    },
    unb64(s) {
      try {
        if (typeof atob === "function") return decodeURIComponent(escape(atob(s.trim())));
        return Buffer.from(s.trim(), "base64").toString("utf8");
      } catch (e) {
        return null;
      }
    },
    escapeHtml(text) {
      return String(text).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
      );
    },
    // Tiny argv parser. `valueFlags` lists flags that take a value; repeated flags become arrays.
    args(argv, valueFlags = []) {
      const vf = new Set(valueFlags);
      const pos = [],
        flags = {},
        rest = [];
      const set = (k, v) => {
        if (k in flags && vf.has(k)) flags[k] = [].concat(flags[k], v);
        else flags[k] = v;
      };
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") {
          rest.push(...argv.slice(i + 1));
          break;
        }
        if (a.startsWith("--") && a.length > 2) {
          const eq = a.indexOf("=");
          if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
          else if (vf.has(a.slice(2)) && i + 1 < argv.length) set(a.slice(2), argv[++i]);
          else set(a.slice(2), true);
        } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
          const k = a.slice(1, 2);
          if (vf.has(k)) {
            if (a.length > 2) set(k, a.slice(a[2] === "=" ? 3 : 2));
            else if (i + 1 < argv.length) set(k, argv[++i]);
            else set(k, "");
          } else for (const ch of a.slice(1)) set(ch, true);
        } else pos.push(a);
      }
      return { pos, flags, rest };
    },
    first(v) {
      return Array.isArray(v) ? v[v.length - 1] : v;
    },
    list(v) {
      return v === undefined ? [] : [].concat(v);
    },
  };
  IG.util = util;

  /* ---------------------------------------------------------------- YAML (subset) */
  class YAMLError extends Error {
    constructor(msg, line) {
      super(line ? `yaml: line ${line}: ${msg}` : `yaml: ${msg}`);
      this.line = line;
    }
  }

  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === q && s[i - 1] !== "\\") q = null;
        continue;
      }
      if (c === '"' || c === "'") {
        if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c;
        continue;
      }
      if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
    }
    return s.trimEnd();
  }

  const isSeq = (t) => t === "-" || t.startsWith("- ");

  function splitKey(t) {
    if (t[0] === '"' || t[0] === "'") {
      const end = t.indexOf(t[0], 1);
      if (end < 0) return null;
      const after = t.slice(end + 1);
      if (after === ":" || after.startsWith(": ")) return [t.slice(1, end), after.slice(1).trim()];
      return null;
    }
    if (t[0] === "[" || t[0] === "{") return null;
    const m = t.match(/^([^\s][^:]*?|[^\s]+?):(?:\s+(.*))?$/);
    if (!m) return null;
    if (/^[a-z]+:\/\//i.test(t) && !/^[^:]+:\s/.test(t)) return null;
    return [m[1].trim(), (m[2] || "").trim()];
  }

  function parseFlow(src, line) {
    let i = 0;
    const ws = () => {
      while (i < src.length && /\s/.test(src[i])) i++;
    };
    function value() {
      ws();
      if (src[i] === "[") {
        i++;
        const arr = [];
        ws();
        if (src[i] === "]") {
          i++;
          return arr;
        }
        for (;;) {
          arr.push(value());
          ws();
          if (src[i] === ",") {
            i++;
            continue;
          }
          if (src[i] === "]") {
            i++;
            return arr;
          }
          throw new YAMLError("did not find expected ',' or ']'", line);
        }
      }
      if (src[i] === "{") {
        i++;
        const obj = {};
        ws();
        if (src[i] === "}") {
          i++;
          return obj;
        }
        for (;;) {
          ws();
          let key = value();
          ws();
          if (src[i] !== ":") throw new YAMLError("did not find expected ':'", line);
          i++;
          obj[String(key)] = value();
          ws();
          if (src[i] === ",") {
            i++;
            continue;
          }
          if (src[i] === "}") {
            i++;
            return obj;
          }
          throw new YAMLError("did not find expected ',' or '}'", line);
        }
      }
      if (src[i] === '"' || src[i] === "'") {
        const q = src[i];
        let j = i + 1,
          out = "";
        while (j < src.length) {
          if (q === '"' && src[j] === "\\") {
            out += src[j] + src[j + 1];
            j += 2;
            continue;
          }
          if (src[j] === q) {
            if (q === "'" && src[j + 1] === "'") {
              out += "'";
              j += 2;
              continue;
            }
            break;
          }
          out += src[j++];
        }
        i = j + 1;
        return q === '"' ? JSON.parse('"' + out + '"') : out;
      }
      let j = i;
      while (j < src.length && !/[,\]}]/.test(src[j]) && !(src[j] === ":" && /\s/.test(src[j + 1] || " "))) j++;
      const raw = src.slice(i, j).trim();
      i = j;
      return scalar(raw, line);
    }
    const v = value();
    ws();
    if (i < src.length) throw new YAMLError("did not find expected <document end>", line);
    return v;
  }

  function scalar(t, line) {
    if (t === "") return null;
    if (t[0] === '"') {
      const m = t.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (!m) throw new YAMLError("found unexpected end of stream", line);
      return JSON.parse('"' + m[1] + '"');
    }
    if (t[0] === "'") {
      const m = t.match(/^'((?:[^']|'')*)'$/);
      if (!m) throw new YAMLError("found unexpected end of stream", line);
      return m[1].replace(/''/g, "'");
    }
    if (t[0] === "[" || t[0] === "{") return parseFlow(t, line);
    if (/^(~|null|Null|NULL)$/.test(t)) return null;
    if (/^(true|True|TRUE)$/.test(t)) return true;
    if (/^(false|False|FALSE)$/.test(t)) return false;
    if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return parseFloat(t);
    return t;
  }

  class Parser {
    constructor(lines) {
      this.L = lines;
      this.i = 0;
    }
    peek() {
      while (this.i < this.L.length && this.L[this.i].blank) this.i++;
      return this.L[this.i];
    }
    node(indent) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) return null;
      if (isSeq(ln.text)) return this.seq(ln.indent);
      if (splitKey(ln.text)) return this.map(ln.indent);
      this.i++;
      const v = scalar(ln.text, ln.n);
      const nx = this.peek();
      if (nx && nx.indent >= indent && typeof v === "string") throw new YAMLError("could not find expected ':'", nx.n);
      return v;
    }
    map(ind) {
      const obj = {};
      for (;;) {
        const ln = this.peek();
        if (!ln || ln.indent < ind) break;
        if (ln.indent > ind) throw new YAMLError("mapping values are not allowed in this context", ln.n);
        if (isSeq(ln.text)) throw new YAMLError("did not find expected key", ln.n);
        const kv = splitKey(ln.text);
        if (!kv) throw new YAMLError("could not find expected ':'", ln.n);
        this.i++;
        obj[kv[0]] = this.value(kv[1], ind, ln);
      }
      return obj;
    }
    value(rest, ind, ln) {
      if (rest === "") {
        const nx = this.peek();
        if (nx && (nx.indent > ind || (nx.indent === ind && isSeq(nx.text)))) return this.node(nx.indent);
        return null;
      }
      if (/^[|>][-+]?\d*$/.test(rest)) return this.block(rest, ind);
      return scalar(rest, ln.n);
    }
    block(header, ind) {
      const out = [];
      let content = null;
      while (this.i < this.L.length) {
        const ln = this.L[this.i];
        if (ln.blank) {
          out.push("");
          this.i++;
          continue;
        }
        if (ln.rawIndent <= ind) break;
        if (content === null) content = ln.rawIndent;
        out.push(ln.raw.slice(content));
        this.i++;
      }
      while (out.length && out[out.length - 1] === "" && header.includes("+") === false) out.pop();
      let text = header[0] === ">" ? out.join("\n").replace(/([^\n])\n(?!\n)/g, "$1 ") : out.join("\n");
      if (!header.includes("-")) text += "\n";
      return text;
    }
    seq(ind) {
      const arr = [];
      for (;;) {
        const ln = this.peek();
        if (!ln || ln.indent < ind) break;
        if (ln.indent > ind) throw new YAMLError("did not find expected '-' indicator", ln.n);
        if (!isSeq(ln.text)) break;
        const after = ln.text === "-" ? "" : ln.text.slice(1);
        const body = after.trim();
        if (body === "") {
          this.i++;
          const nx = this.peek();
          arr.push(nx && nx.indent > ind ? this.node(nx.indent) : null);
          continue;
        }
        const itemIndent = ind + 1 + (after.length - after.trimStart().length);
        this.L[this.i] = {
          indent: itemIndent,
          rawIndent: itemIndent,
          text: body,
          raw: " ".repeat(itemIndent) + body,
          n: ln.n,
        };
        if (isSeq(body)) arr.push(this.seq(itemIndent));
        else if (splitKey(body)) arr.push(this.map(itemIndent));
        else {
          this.i++;
          arr.push(scalar(body, ln.n));
        }
      }
      return arr;
    }
  }

  function lex(chunk) {
    return chunk.map(({ raw, n }) => {
      if (/^ *\t/.test(raw)) throw new YAMLError("found character that cannot start any token", n);
      const s = stripComment(raw);
      if (!s.trim()) return { blank: true, raw, n };
      const indent = s.match(/^ */)[0].length;
      return { indent, rawIndent: indent, text: s.trim(), raw, n };
    });
  }

  IG.yaml = {
    YAMLError,
    parseAll(text) {
      const raw = String(text).replace(/\r\n?/g, "\n").split("\n");
      const docs = [];
      let cur = [];
      raw.forEach((r, i) => {
        if (/^---(\s|$)/.test(r)) {
          docs.push(cur);
          cur = [];
          const rest = r.slice(3).trim();
          if (rest) cur.push({ raw: rest, n: i + 1 });
        } else if (/^\.\.\.\s*$/.test(r)) {
          docs.push(cur);
          cur = [];
        } else cur.push({ raw: r, n: i + 1 });
      });
      docs.push(cur);
      const out = [];
      for (const d of docs) {
        const lines = lex(d);
        if (lines.every((l) => l.blank)) continue;
        const p = new Parser(lines);
        const first = p.peek();
        const v = p.node(first.indent);
        const left = p.peek();
        if (left)
          throw new YAMLError(
            left.indent > first.indent
              ? "mapping values are not allowed in this context"
              : "did not find expected <document start>",
            left.n,
          );
        out.push(v);
      }
      return out;
    },
    parse(text) {
      return IG.yaml.parseAll(text)[0] ?? null;
    },
    stringify(v) {
      return dump(v, 0);
    },
  };

  function needsQuote(s) {
    return (
      s === "" ||
      /^\s|\s$/.test(s) ||
      /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) ||
      /: |\s#|:$/.test(s) ||
      /^(true|false|null|~|yes|no|on|off|y|n)$/i.test(s) ||
      /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)
    );
  }
  function scalarOut(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v !== "string") return String(v);
    return needsQuote(v) ? JSON.stringify(v) : v;
  }
  function dump(v, ind) {
    const pad = " ".repeat(ind);
    if (Array.isArray(v)) {
      if (!v.length) return pad + "[]\n";
      return v
        .map((item) => {
          if (util.isObj(item) && Object.keys(item).length) return pad + "- " + dump(item, ind + 2).slice(ind + 2);
          if (Array.isArray(item) && item.length) return pad + "-\n" + dump(item, ind + 2);
          if (util.isObj(item)) return pad + "- {}\n";
          return pad + "- " + scalarOut(item) + "\n";
        })
        .join("");
    }
    if (util.isObj(v)) {
      return Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => {
          const key = pad + (needsQuote(k) ? JSON.stringify(k) : k) + ":";
          if (Array.isArray(x)) return x.length ? key + "\n" + dump(x, ind) : key + " []\n";
          if (util.isObj(x)) return Object.keys(x).length ? key + "\n" + dump(x, ind + 2) : key + " {}\n";
          if (typeof x === "string" && x.includes("\n")) {
            const body = x.endsWith("\n") ? x.slice(0, -1) : x;
            return (
              key +
              (x.endsWith("\n") ? " |\n" : " |-\n") +
              body
                .split("\n")
                .map((l) => (l ? pad + "  " + l : ""))
                .join("\n") +
              "\n"
            );
          }
          return key + " " + scalarOut(x) + "\n";
        })
        .join("");
    }
    return pad + scalarOut(v) + "\n";
  }

  /* ---------------------------------------------------------------- Virtual filesystem
   * Inode-like nodes with type, mode, owner, group, mtime; symlinks; special files.
   * Paths are absolute and normalized. Permission checks live in the shell layer. */
  class VFS {
    constructor(spec = {}) {
      this.nodes = new Map();
      this.clock = spec.clock || (() => (IG.clock ? IG.clock.now() : Date.now()));
      this.ownerFor = spec.ownerFor || (() => ["root", "root"]);
      this.nodes.set("/", {
        type: "d",
        mode: 0o755,
        owner: "root",
        group: "root",
        mtime: this.clock() - 400 * 86400e3,
      });
      for (const d of spec.dirs || []) this.mkdirp(d);
      for (const [p, c] of Object.entries(spec.files || {})) {
        if (typeof c === "string") this.write(p, c, { mkdirs: true });
        else this.write(p, c.content || "", Object.assign({ mkdirs: true }, c));
      }
    }
    static norm(path, cwd = "/", home = "/home/operator") {
      if (!path) return cwd;
      let raw = String(path).replace(/^~(?=\/|$)/, home);
      if (!raw.startsWith("/")) raw = cwd.replace(/\/$/, "") + "/" + raw;
      const stack = [];
      for (const piece of raw.split("/")) {
        if (!piece || piece === ".") continue;
        if (piece === "..") stack.pop();
        else stack.push(piece);
      }
      return "/" + stack.join("/");
    }
    static parent(p) {
      return p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/";
    }
    static base(p) {
      return p.split("/").filter(Boolean).pop() || "/";
    }

    // Resolve symlinks in every component. Returns the real path (may not exist) or null on loop.
    real(p, followLast = true) {
      let parts = p.split("/").filter(Boolean);
      let cur = "/";
      let hops = 0;
      for (let i = 0; i < parts.length; i++) {
        const next = cur === "/" ? "/" + parts[i] : cur + "/" + parts[i];
        const n = this.nodes.get(next);
        if (n && n.type === "l" && (followLast || i < parts.length - 1)) {
          if (++hops > 40) return null;
          const target = VFS.norm(n.target, cur);
          parts = target
            .split("/")
            .filter(Boolean)
            .concat(parts.slice(i + 1));
          cur = "/";
          i = -1;
          continue;
        }
        cur = next;
      }
      return cur;
    }
    node(p, follow = true) {
      const r = this.real(p, follow);
      return r ? this.nodes.get(r) || null : null;
    }
    lnode(p) {
      return this.node(p, false);
    }
    isDir(p) {
      const n = this.node(p);
      return !!n && n.type === "d";
    }
    isFile(p) {
      const n = this.node(p);
      return !!n && n.type === "f";
    }
    isLink(p) {
      const n = this.lnode(p);
      return !!n && n.type === "l";
    }
    exists(p) {
      return !!this.node(p);
    }
    lexists(p) {
      return !!this.lnode(p);
    }
    read(p) {
      const n = this.node(p);
      return n && n.type === "f" ? n.content : undefined;
    }
    fileSize(n) {
      return n.type === "f" ? (n.size ?? n.content.length) : n.type === "l" ? n.target.length : 4096;
    }
    size(p) {
      const r = this.real(p, false);
      const n = r && this.nodes.get(r);
      if (!n) return 0;
      if (n.type !== "d") return this.fileSize(n);
      let total = 0;
      const pre = r === "/" ? "/" : r + "/";
      for (const [k, v] of this.nodes) if (k.startsWith(pre) && v.type !== "d") total += this.fileSize(v);
      return total;
    }
    write(p, content, opt = {}) {
      const r = this.real(p) || p;
      const parent = VFS.parent(r);
      if (!this.isDir(parent)) {
        if (opt.mkdirs) this.mkdirp(parent, opt);
        else throw new Error("ENOENT");
      }
      const prev = this.nodes.get(r);
      if (prev && prev.type === "d") throw new Error("EISDIR");
      const [o, g] = this.ownerFor(r);
      const text = String(content);
      const node = prev
        ? prev
        : {
            type: "f",
            mode: opt.mode ?? (/\.sh$/.test(r) ? 0o755 : 0o644),
            owner: opt.owner || o,
            group: opt.group || opt.owner || g,
          };
      node.type = "f";
      node.content = opt.append && prev ? prev.content + text : text;
      node.size =
        opt.size !== undefined
          ? opt.size
          : opt.append && prev && prev.size !== undefined
            ? prev.size + text.length
            : undefined;
      if (opt.mode !== undefined && prev) node.mode = opt.mode;
      node.mtime = opt.mtime || this.clock();
      this.nodes.set(r, node);
      if (!prev) this.inherit(node, parent);
      return node;
    }
    // a parent directory's default ACL applies to new entries (the umask is then ignored)
    inherit(node, parentPath) {
      const d = this.nodes.get(this.real(parentPath) || parentPath);
      if (!d || !d.dacl) return;
      const a = d.dacl,
        dir = node.type === "d",
        req = dir ? 7 : 6;
      node.acl = { u: Object.assign({}, a.u), g: Object.assign({}, a.g), g0: a.g0 };
      node.mode = (node.mode & ~0o777) | ((a.u0 & req) << 6) | ((a.mask & req) << 3) | (a.o & req);
      if (dir) node.dacl = JSON.parse(JSON.stringify(a));
    }
    mkdirp(p, opt = {}) {
      const parts = p.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur += "/" + part;
        const real = this.real(cur);
        const n = this.nodes.get(real);
        if (n && n.type !== "d") throw new Error("ENOTDIR");
        if (!n) {
          const [o, g] = this.ownerFor(real);
          const last = cur.length + 0 === p.replace(/\/+$/, "").length || real === this.real(p);
          // like `mkdir -p -m`: requested mode applies to the final directory only
          const mode =
            last && opt.mode !== undefined
              ? opt.mode
              : real === "/tmp"
                ? 0o1777
                : real === "/root"
                  ? 0o700
                  : (opt.parentMode ?? 0o755);
          const dn = {
            type: "d",
            mode,
            owner: (last || opt.ownParents) && opt.owner ? opt.owner : o,
            group: (last || opt.ownParents) && (opt.group || opt.owner) ? opt.group || opt.owner : g,
            mtime: opt.mtime || this.clock(),
          };
          this.nodes.set(real, dn);
          this.inherit(dn, VFS.parent(real));
        }
        cur = real;
      }
    }
    symlink(target, p, opt = {}) {
      const parent = VFS.parent(p);
      if (!this.isDir(parent)) throw new Error("ENOENT");
      if (this.lexists(p)) throw new Error("EEXIST");
      const [o, g] = this.ownerFor(p);
      this.nodes.set(p, {
        type: "l",
        target,
        mode: 0o777,
        owner: opt.owner || o,
        group: opt.group || opt.owner || g,
        mtime: this.clock(),
      });
    }
    remove(p, recursive) {
      const r = this.real(VFS.parent(p)) + (p === "/" ? "" : "/" + VFS.base(p));
      const key = r.replace(/^\/\//, "/");
      const n = this.nodes.get(key);
      if (!n) throw new Error("ENOENT");
      if (n.type !== "d") {
        this.nodes.delete(key);
        return;
      }
      const kids = this.children(key);
      if (kids.length && !recursive) throw new Error("ENOTEMPTY");
      const pre = key + "/";
      for (const k of [...this.nodes.keys()]) if (k === key || k.startsWith(pre)) this.nodes.delete(k);
    }
    rename(from, to) {
      const src = this.real(VFS.parent(from)) + "/" + VFS.base(from);
      const s = src.replace(/^\/\//, "/");
      if (!this.nodes.has(s)) throw new Error("ENOENT");
      const pre = s + "/";
      const moves = [...this.nodes.entries()].filter(([k]) => k === s || k.startsWith(pre));
      for (const [k] of moves) this.nodes.delete(k);
      for (const [k, v] of moves) this.nodes.set(to + k.slice(s.length), v);
    }
    chmod(p, mode) {
      const n = this.node(p);
      if (!n) throw new Error("ENOENT");
      n.mode = (n.mode & ~0o7777) | (mode & 0o7777);
      n.ctime = this.clock();
    }
    chown(p, owner, group, follow = true) {
      const n = follow ? this.node(p) : this.lnode(p);
      if (!n) throw new Error("ENOENT");
      if (owner) n.owner = owner;
      if (group) n.group = group;
    }
    touch(p, t) {
      const n = this.node(p);
      if (n) n.mtime = t || this.clock();
    }
    stat(p, follow = true) {
      const r = this.real(p, follow);
      const n = r && this.nodes.get(r);
      return n ? Object.assign({ path: r, size: this.fileSize(n) }, n) : null;
    }
    children(dir) {
      const d = this.real(dir) || dir;
      const out = [];
      for (const [k, n] of this.nodes) {
        if (k === d || VFS.parent(k) !== d || k === "/") continue;
        out.push({
          name: VFS.base(k),
          path: k,
          dir: n.type === "d",
          link: n.type === "l",
          node: n,
          size: this.fileSize(n),
        });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    walk(dir) {
      const d = this.real(dir) || dir;
      const pre = d === "/" ? "/" : d + "/";
      return [...this.nodes.keys()].filter((k) => k !== d && k.startsWith(pre)).sort();
    }
  }
  IG.VFS = VFS;

  /* ---------------------------------------------------------------- hashes (md5 / sha1 / sha256 over UTF-8) */
  function utf8(s) {
    return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, "utf8"));
  }
  function hexOf(words, le) {
    return words
      .map((w) => {
        const h = (w >>> 0).toString(16).padStart(8, "0");
        return le ? h.match(/../g).reverse().join("") : h;
      })
      .join("");
  }
  function pad(bytes, le) {
    const len = bytes.length,
      bits = len * 8;
    const total = ((len + 9 + 63) >> 6) << 6;
    const b = new Uint8Array(total);
    b.set(bytes);
    b[len] = 0x80;
    const hi = Math.floor(bits / 2 ** 32),
      lo = bits >>> 0;
    const dv = new DataView(b.buffer);
    if (le) {
      dv.setUint32(total - 8, lo, true);
      dv.setUint32(total - 4, hi, true);
    } else {
      dv.setUint32(total - 8, hi);
      dv.setUint32(total - 4, lo);
    }
    return dv;
  }
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  IG.hash = {
    sha256(str) {
      const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
      ];
      const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      const dv = pad(utf8(str), false);
      const W = new Array(64);
      for (let o = 0; o < dv.byteLength; o += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
        for (let i = 16; i < 64; i++) {
          const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
          const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
          W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
          const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
          const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
          h = g;
          g = f;
          f = e;
          e = (d + t1) | 0;
          d = c;
          c = b;
          b = a;
          a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
        H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0;
        H[7] = (H[7] + h) | 0;
      }
      return hexOf(H);
    },
    sha1(str) {
      const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
      const dv = pad(utf8(str), false);
      const W = new Array(80);
      for (let o = 0; o < dv.byteLength; o += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
        for (let i = 16; i < 80; i++) W[i] = rotl(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
        let [a, b, c, d, e] = H;
        for (let i = 0; i < 80; i++) {
          const [f, k] =
            i < 20
              ? [(b & c) | (~b & d), 0x5a827999]
              : i < 40
                ? [b ^ c ^ d, 0x6ed9eba1]
                : i < 60
                  ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
                  : [b ^ c ^ d, 0xca62c1d6];
          const t = (rotl(a, 5) + f + e + k + W[i]) | 0;
          e = d;
          d = c;
          c = rotl(b, 30);
          b = a;
          a = t;
        }
        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
      }
      return hexOf(H);
    },
    md5(str) {
      const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
        20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
        10, 15, 21,
      ];
      const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
      const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
      const dv = pad(utf8(str), true);
      for (let o = 0; o < dv.byteLength; o += 64) {
        const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(o + i * 4, true));
        let [a, b, c, d] = H;
        for (let i = 0; i < 64; i++) {
          let f, g;
          if (i < 16) {
            f = (b & c) | (~b & d);
            g = i;
          } else if (i < 32) {
            f = (d & b) | (~d & c);
            g = (5 * i + 1) % 16;
          } else if (i < 48) {
            f = b ^ c ^ d;
            g = (3 * i + 5) % 16;
          } else {
            f = c ^ (b | ~d);
            g = (7 * i) % 16;
          }
          const t = d;
          d = c;
          c = b;
          b = (b + rotl((a + f + K[i] + M[g]) | 0, S[i])) | 0;
          a = t;
        }
        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
      }
      return hexOf(H, true);
    },
  };
})((globalThis.IG = globalThis.IG || {}));
