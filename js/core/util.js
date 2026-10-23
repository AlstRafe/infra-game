/* CoreLab core utilities: clock, formatting, YAML subset, virtual filesystem.
 * Everything under js/core, js/sim and js/game is DOM-free so it can run in Node (see tests/). */
(function (IG) {
  'use strict';

  // Simulation clock. Tests advance `offset` to skip transient states such as ContainerCreating.
  IG.clock = { offset: 0, now() { return Date.now() + this.offset; } };

  const SAFE = 'bcdfghjklmnpqrstvwxz2456789';

  const util = {
    hash(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    },
    // Kubernetes-like random-looking but deterministic suffix.
    suffix(seed, len = 5) {
      let h = util.hash(seed), s = '';
      for (let i = 0; i < len; i++) { s += SAFE[h % SAFE.length]; h = Math.floor(h / SAFE.length) ^ util.hash(seed + i); h >>>= 0; }
      return s;
    },
    hex(seed, len = 12) {
      let s = '';
      for (let i = 0; s.length < len; i++) s += util.hash(seed + ':' + i).toString(16).padStart(8, '0');
      return s.slice(0, len);
    },
    clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); },
    // Strategic-merge-ish patch: maps merge, arrays of named objects merge by name, null deletes.
    merge(target, patch) {
      if (!util.isObj(patch)) return util.clone(patch);
      const out = util.isObj(target) ? util.clone(target) : {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) { delete out[k]; continue; }
        if (Array.isArray(v) && Array.isArray(out[k]) && v.every(x => util.isObj(x) && x.name)) {
          const arr = out[k].slice();
          for (const item of v) {
            const i = arr.findIndex(x => x && x.name === item.name);
            if (i >= 0) arr[i] = util.merge(arr[i], item); else arr.push(util.clone(item));
          }
          out[k] = arr;
        } else if (util.isObj(v)) out[k] = util.merge(out[k], v);
        else out[k] = util.clone(v);
      }
      return out;
    },
    table(headers, rows) {
      const all = [headers, ...rows].map(r => r.map(c => String(c ?? '')));
      const w = headers.map((_, i) => Math.max(...all.map(r => (r[i] || '').length)));
      return all.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join('').trimEnd()).join('\n');
    },
    age(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 120) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 48) return h + 'h';
      return Math.floor(h / 24) + 'd';
    },
    cpu(q) { // -> millicores
      if (q === undefined || q === null || q === '') return 0;
      const s = String(q);
      return s.endsWith('m') ? parseFloat(s) : Math.round(parseFloat(s) * 1000);
    },
    mem(q) { // -> MiB
      if (q === undefined || q === null || q === '') return 0;
      const m = String(q).match(/^([\d.]+)\s*([KMGT]i?)?$/);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      const f = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1048576, K: 1e3 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, T: 1e12 / 1048576 }[m[2]];
      return f ? n * f : n / 1048576;
    },
    human(bytes) { // du/df style
      const u = ['', 'K', 'M', 'G', 'T'];
      let i = 0, n = bytes;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      if (i === 0) return String(Math.round(n));
      return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + u[i];
    },
    b64(s) {
      if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
      return Buffer.from(s, 'utf8').toString('base64');
    },
    unb64(s) {
      try {
        if (typeof atob === 'function') return decodeURIComponent(escape(atob(s.trim())));
        return Buffer.from(s.trim(), 'base64').toString('utf8');
      } catch (e) { return null; }
    },
    escapeHtml(text) {
      return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    // Tiny argv parser. `valueFlags` lists flags that take a value; repeated flags become arrays.
    args(argv, valueFlags = []) {
      const vf = new Set(valueFlags);
      const pos = [], flags = {}, rest = [];
      const set = (k, v) => {
        if (k in flags && vf.has(k)) flags[k] = [].concat(flags[k], v); else flags[k] = v;
      };
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
        if (a.startsWith('--') && a.length > 2) {
          const eq = a.indexOf('=');
          if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
          else if (vf.has(a.slice(2)) && i + 1 < argv.length) set(a.slice(2), argv[++i]);
          else set(a.slice(2), true);
        } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
          const k = a.slice(1, 2);
          if (vf.has(k)) {
            if (a.length > 2) set(k, a.slice(a[2] === '=' ? 3 : 2));
            else if (i + 1 < argv.length) set(k, argv[++i]);
            else set(k, '');
          } else for (const ch of a.slice(1)) set(ch, true);
        } else pos.push(a);
      }
      return { pos, flags, rest };
    },
    first(v) { return Array.isArray(v) ? v[v.length - 1] : v; },
    list(v) { return v === undefined ? [] : [].concat(v); },
  };
  IG.util = util;

  /* ---------------------------------------------------------------- YAML (subset) */
  class YAMLError extends Error {
    constructor(msg, line) { super(line ? `yaml: line ${line}: ${msg}` : `yaml: ${msg}`); this.line = line; }
  }

  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
    }
    return s.trimEnd();
  }

  const isSeq = t => t === '-' || t.startsWith('- ');

  function splitKey(t) {
    if (t[0] === '"' || t[0] === "'") {
      const end = t.indexOf(t[0], 1);
      if (end < 0) return null;
      const after = t.slice(end + 1);
      if (after === ':' || after.startsWith(': ')) return [t.slice(1, end), after.slice(1).trim()];
      return null;
    }
    if (t[0] === '[' || t[0] === '{') return null;
    const m = t.match(/^([^\s][^:]*?|[^\s]+?):(?:\s+(.*))?$/);
    if (!m) return null;
    if (/^[a-z]+:\/\//i.test(t) && !/^[^:]+:\s/.test(t)) return null;
    return [m[1].trim(), (m[2] || '').trim()];
  }

  function parseFlow(src, line) {
    let i = 0;
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    function value() {
      ws();
      if (src[i] === '[') {
        i++; const arr = []; ws();
        if (src[i] === ']') { i++; return arr; }
        for (;;) {
          arr.push(value()); ws();
          if (src[i] === ',') { i++; continue; }
          if (src[i] === ']') { i++; return arr; }
          throw new YAMLError("did not find expected ',' or ']'", line);
        }
      }
      if (src[i] === '{') {
        i++; const obj = {}; ws();
        if (src[i] === '}') { i++; return obj; }
        for (;;) {
          ws();
          let key = value();
          ws();
          if (src[i] !== ':') throw new YAMLError("did not find expected ':'", line);
          i++;
          obj[String(key)] = value(); ws();
          if (src[i] === ',') { i++; continue; }
          if (src[i] === '}') { i++; return obj; }
          throw new YAMLError("did not find expected ',' or '}'", line);
        }
      }
      if (src[i] === '"' || src[i] === "'") {
        const q = src[i]; let j = i + 1, out = '';
        while (j < src.length) {
          if (q === '"' && src[j] === '\\') { out += src[j] + src[j + 1]; j += 2; continue; }
          if (src[j] === q) { if (q === "'" && src[j + 1] === "'") { out += "'"; j += 2; continue; } break; }
          out += src[j++];
        }
        i = j + 1;
        return q === '"' ? JSON.parse('"' + out + '"') : out;
      }
      let j = i;
      while (j < src.length && !/[,\]}]/.test(src[j]) && !(src[j] === ':' && /\s/.test(src[j + 1] || ' '))) j++;
      const raw = src.slice(i, j).trim(); i = j;
      return scalar(raw, line);
    }
    const v = value(); ws();
    if (i < src.length) throw new YAMLError('did not find expected <document end>', line);
    return v;
  }

  function scalar(t, line) {
    if (t === '') return null;
    if (t[0] === '"') {
      const m = t.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (!m) throw new YAMLError('found unexpected end of stream', line);
      return JSON.parse('"' + m[1] + '"');
    }
    if (t[0] === "'") {
      const m = t.match(/^'((?:[^']|'')*)'$/);
      if (!m) throw new YAMLError('found unexpected end of stream', line);
      return m[1].replace(/''/g, "'");
    }
    if (t[0] === '[' || t[0] === '{') return parseFlow(t, line);
    if (/^(~|null|Null|NULL)$/.test(t)) return null;
    if (/^(true|True|TRUE)$/.test(t)) return true;
    if (/^(false|False|FALSE)$/.test(t)) return false;
    if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return parseFloat(t);
    return t;
  }

  class Parser {
    constructor(lines) { this.L = lines; this.i = 0; }
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
      if (nx && nx.indent >= indent && typeof v === 'string') throw new YAMLError('could not find expected \':\'', nx.n);
      return v;
    }
    map(ind) {
      const obj = {};
      for (;;) {
        const ln = this.peek();
        if (!ln || ln.indent < ind) break;
        if (ln.indent > ind) throw new YAMLError('mapping values are not allowed in this context', ln.n);
        if (isSeq(ln.text)) throw new YAMLError("did not find expected key", ln.n);
        const kv = splitKey(ln.text);
        if (!kv) throw new YAMLError("could not find expected ':'", ln.n);
        this.i++;
        obj[kv[0]] = this.value(kv[1], ind, ln);
      }
      return obj;
    }
    value(rest, ind, ln) {
      if (rest === '') {
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
        if (ln.blank) { out.push(''); this.i++; continue; }
        if (ln.rawIndent <= ind) break;
        if (content === null) content = ln.rawIndent;
        out.push(ln.raw.slice(content));
        this.i++;
      }
      while (out.length && out[out.length - 1] === '' && header.includes('+') === false) out.pop();
      let text = header[0] === '>' ? out.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ') : out.join('\n');
      if (!header.includes('-')) text += '\n';
      return text;
    }
    seq(ind) {
      const arr = [];
      for (;;) {
        const ln = this.peek();
        if (!ln || ln.indent < ind) break;
        if (ln.indent > ind) throw new YAMLError("did not find expected '-' indicator", ln.n);
        if (!isSeq(ln.text)) break;
        const after = ln.text === '-' ? '' : ln.text.slice(1);
        const body = after.trim();
        if (body === '') {
          this.i++;
          const nx = this.peek();
          arr.push(nx && nx.indent > ind ? this.node(nx.indent) : null);
          continue;
        }
        const itemIndent = ind + 1 + (after.length - after.trimStart().length);
        this.L[this.i] = { indent: itemIndent, rawIndent: itemIndent, text: body, raw: ' '.repeat(itemIndent) + body, n: ln.n };
        if (isSeq(body)) arr.push(this.seq(itemIndent));
        else if (splitKey(body)) arr.push(this.map(itemIndent));
        else { this.i++; arr.push(scalar(body, ln.n)); }
      }
      return arr;
    }
  }

  function lex(chunk) {
    return chunk.map(({ raw, n }) => {
      if (/^ *\t/.test(raw)) throw new YAMLError('found character that cannot start any token', n);
      const s = stripComment(raw);
      if (!s.trim()) return { blank: true, raw, n };
      const indent = s.match(/^ */)[0].length;
      return { indent, rawIndent: indent, text: s.trim(), raw, n };
    });
  }

  IG.yaml = {
    YAMLError,
    parseAll(text) {
      const raw = String(text).replace(/\r\n?/g, '\n').split('\n');
      const docs = []; let cur = [];
      raw.forEach((r, i) => {
        if (/^---(\s|$)/.test(r)) { docs.push(cur); cur = []; const rest = r.slice(3).trim(); if (rest) cur.push({ raw: rest, n: i + 1 }); }
        else if (/^\.\.\.\s*$/.test(r)) { docs.push(cur); cur = []; }
        else cur.push({ raw: r, n: i + 1 });
      });
      docs.push(cur);
      const out = [];
      for (const d of docs) {
        const lines = lex(d);
        if (lines.every(l => l.blank)) continue;
        const p = new Parser(lines);
        const first = p.peek();
        const v = p.node(first.indent);
        const left = p.peek();
        if (left) throw new YAMLError(left.indent > first.indent ? 'mapping values are not allowed in this context' : 'did not find expected <document start>', left.n);
        out.push(v);
      }
      return out;
    },
    parse(text) { return IG.yaml.parseAll(text)[0] ?? null; },
    stringify(v) { return dump(v, 0); },
  };

  function needsQuote(s) {
    return s === '' || /^\s|\s$/.test(s) || /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) || /: |\s#|:$/.test(s) ||
      /^(true|false|null|~|yes|no|on|off|y|n)$/i.test(s) || /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s);
  }
  function scalarOut(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v !== 'string') return String(v);
    return needsQuote(v) ? JSON.stringify(v) : v;
  }
  function dump(v, ind) {
    const pad = ' '.repeat(ind);
    if (Array.isArray(v)) {
      if (!v.length) return pad + '[]\n';
      return v.map(item => {
        if (util.isObj(item) && Object.keys(item).length) return pad + '- ' + dump(item, ind + 2).slice(ind + 2);
        if (Array.isArray(item) && item.length) return pad + '-\n' + dump(item, ind + 2);
        if (util.isObj(item)) return pad + '- {}\n';
        return pad + '- ' + scalarOut(item) + '\n';
      }).join('');
    }
    if (util.isObj(v)) {
      return Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
        const key = pad + (needsQuote(k) ? JSON.stringify(k) : k) + ':';
        if (Array.isArray(x)) return x.length ? key + '\n' + dump(x, ind) : key + ' []\n';
        if (util.isObj(x)) return Object.keys(x).length ? key + '\n' + dump(x, ind + 2) : key + ' {}\n';
        if (typeof x === 'string' && x.includes('\n')) {
          const body = x.endsWith('\n') ? x.slice(0, -1) : x;
          return key + (x.endsWith('\n') ? ' |\n' : ' |-\n') + body.split('\n').map(l => (l ? pad + '  ' + l : '')).join('\n') + '\n';
        }
        return key + ' ' + scalarOut(x) + '\n';
      }).join('');
    }
    return pad + scalarOut(v) + '\n';
  }

  /* ---------------------------------------------------------------- Virtual filesystem */
  class VFS {
    constructor(spec = {}) {
      this.files = new Map();
      this.dirs = new Set(['/']);
      for (const d of spec.dirs || []) this.mkdirp(d);
      for (const [p, c] of Object.entries(spec.files || {})) {
        if (typeof c === 'string') this.write(p, c, { mkdirs: true });
        else this.write(p, c.content || '', { mkdirs: true, size: c.size });
      }
    }
    static norm(path, cwd = '/', home = '/home/operator') {
      if (!path) return cwd;
      let raw = path.replace(/^~(?=\/|$)/, home);
      if (!raw.startsWith('/')) raw = cwd.replace(/\/$/, '') + '/' + raw;
      const stack = [];
      for (const piece of raw.split('/')) {
        if (!piece || piece === '.') continue;
        if (piece === '..') stack.pop(); else stack.push(piece);
      }
      return '/' + stack.join('/');
    }
    static parent(p) { return p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/'; }
    static base(p) { return p.split('/').filter(Boolean).pop() || '/'; }
    isDir(p) { return this.dirs.has(p); }
    isFile(p) { return this.files.has(p); }
    exists(p) { return this.isDir(p) || this.isFile(p); }
    read(p) { const e = this.files.get(p); return e ? e.content : undefined; }
    size(p) {
      if (this.isFile(p)) { const e = this.files.get(p); return e.size ?? e.content.length; }
      let n = 0;
      for (const [fp, e] of this.files) if (fp.startsWith(p === '/' ? '/' : p + '/')) n += e.size ?? e.content.length;
      return n;
    }
    write(p, content, opt = {}) {
      const parent = VFS.parent(p);
      if (!this.isDir(parent)) { if (opt.mkdirs) this.mkdirp(parent); else throw new Error('ENOENT'); }
      if (this.isDir(p)) throw new Error('EISDIR');
      this.files.set(p, { content: String(content), size: opt.size });
    }
    mkdirp(p) {
      const parts = p.split('/').filter(Boolean);
      let cur = '';
      for (const part of parts) { cur += '/' + part; if (this.files.has(cur)) throw new Error('ENOTDIR'); this.dirs.add(cur); }
    }
    remove(p, recursive) {
      if (this.isFile(p)) { this.files.delete(p); return; }
      if (!this.isDir(p)) throw new Error('ENOENT');
      const kids = this.children(p);
      if (kids.length && !recursive) throw new Error('ENOTEMPTY');
      const prefix = p + '/';
      for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
      for (const d of [...this.dirs]) if (d === p || d.startsWith(prefix)) this.dirs.delete(d);
    }
    children(dir) {
      const out = new Map();
      for (const d of this.dirs) if (d !== dir && VFS.parent(d) === dir) out.set(VFS.base(d), { name: VFS.base(d), path: d, dir: true });
      for (const f of this.files.keys()) if (VFS.parent(f) === dir) out.set(VFS.base(f), { name: VFS.base(f), path: f, dir: false, size: this.size(f) });
      return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    walk(dir) {
      const prefix = dir === '/' ? '/' : dir + '/';
      return [...[...this.dirs].filter(d => d.startsWith(prefix)), ...[...this.files.keys()].filter(f => f.startsWith(prefix))].sort();
    }
  }
  IG.VFS = VFS;
})(globalThis.IG = globalThis.IG || {});
