/* A bash-compatible interpreter (subset large enough for day-to-day ops work):
 * lexer → parser (AST) → expansion (brace, tilde, parameter, command substitution,
 * arithmetic, word splitting, pathname) → execution with fd-level redirections.
 * Control flow: if/elif/else, for (list & C-style), while/until, case, functions,
 * { } groups, ( ) subshells, [[ ]], (( )), &&, ||, !, pipelines, background &. */
(function (IG) {
  'use strict';

  class Incomplete extends Error {}
  class BashSyntax extends Error {}
  class Flow { constructor(kind, n = 1, code = 0) { this.kind = kind; this.n = n; this.code = code; } }
  // stdin is a consumable stream so `while read` loops and `cat` share one input
  const mkIn = (data, tty) => ({ data: String(data || ''), pos: 0, tty: !!tty });
  const readAll = s => { if (!s) return ''; const t = s.data.slice(s.pos); s.pos = s.data.length; return t; };

  const OPS = ['&&', '||', ';;', '<<<', '<<-', '<<', '>>', '>&', '<&', '&>>', '&>', '|&', '>|', '|', '&', ';', '(', ')', '<', '>'];
  const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '{', '}', '!', '[[', ']]', 'select']);

  /* ================================================================ lexer */
  function lex(src) {
    const toks = [];
    const heredocs = [];
    let i = 0;
    const n = src.length;
    const prevIsWordish = () => { const t = toks[toks.length - 1]; return t && t.t === 'w' && !RESERVED.has(t.v); };
    // scan a balanced construct starting after `open`, returning index after the close
    function balanced(j, open, close) {
      let depth = 1;
      while (j < n) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === "'" && open !== '{') { const k = src.indexOf("'", j + 1); if (k < 0) throw new Incomplete(); j = k + 1; continue; }
        if (c === '"') { j = dquote(j + 1); continue; }
        if (c === '`') { const k = src.indexOf('`', j + 1); if (k < 0) throw new Incomplete(); j = k + 1; continue; }
        if (c === '$' && src[j + 1] === '(') { j = balanced(j + 2, '(', ')'); continue; }
        if (c === '$' && src[j + 1] === '{') { j = balanced(j + 2, '{', '}'); continue; }
        if (c === open && open !== '{') depth++;
        else if (c === close) { depth--; if (!depth) return j + 1; }
        j++;
      }
      throw new Incomplete();
    }
    function dquote(j) {
      while (j < n) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '"') return j + 1;
        if (c === '$' && src[j + 1] === '(') { j = balanced(j + 2, '(', ')'); continue; }
        if (c === '$' && src[j + 1] === '{') { j = balanced(j + 2, '{', '}'); continue; }
        if (c === '`') { const k = src.indexOf('`', j + 1); if (k < 0) throw new Incomplete(); j = k + 1; continue; }
        j++;
      }
      throw new Incomplete();
    }
    function readHeredocs() {
      // i points just after a newline
      for (const h of heredocs.splice(0)) {
        const lines = [];
        for (;;) {
          if (i >= n) throw new Incomplete();
          let e = src.indexOf('\n', i);
          if (e < 0) e = n;
          let line = src.slice(i, e);
          i = e + 1;
          const cmp = h.strip ? line.replace(/^\t+/, '') : line;
          if (cmp === h.delim) break;
          lines.push(h.strip ? line.replace(/^\t+/, '') : line);
          if (e === n) throw new Incomplete();
        }
        h.tok.body = lines.length ? lines.join('\n') + '\n' : '';
      }
    }
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '\n') { toks.push({ t: 'nl' }); i++; if (heredocs.length) readHeredocs(); continue; }
      if (c === '#' ) { while (i < n && src[i] !== '\n') i++; continue; }
      // (( arithmetic command ))
      if (c === '(' && src[i + 1] === '(' && !prevIsWordish()) {
        const end = balanced(i + 2, '(', ')');
        if (src[end] !== ')') { /* not arithmetic: treat as subshell */ } else { toks.push({ t: 'arith', v: src.slice(i + 2, end - 1) }); i = end + 1; continue; }
      }
      // io number: 2> 2>> 1>&2 etc.
      const io = src.slice(i).match(/^(\d)(?=[<>])/);
      if (io) { i += 1; const op = OPS.find(o => src.startsWith(o, i)); toks.push({ t: 'op', v: op, fd: Number(io[1]) }); i += op.length; if (op === '<<' || op === '<<-') pendingHeredoc(op); continue; }
      const op = OPS.find(o => src.startsWith(o, i));
      if (op) {
        toks.push({ t: 'op', v: op });
        i += op.length;
        if (op === '<<' || op === '<<-') pendingHeredoc(op);
        continue;
      }
      // word
      const s = i;
      while (i < n) {
        const d = src[i];
        if (d === ' ' || d === '\t' || d === '\n' || '|&;()<>'.includes(d)) break;
        if (d === '\\') { if (i + 1 >= n) throw new Incomplete(); i += 2; continue; }
        if (d === "'") { const k = src.indexOf("'", i + 1); if (k < 0) throw new Incomplete(); i = k + 1; continue; }
        if (d === '"') { i = dquote(i + 1); continue; }
        if (d === '`') { const k = src.indexOf('`', i + 1); if (k < 0) throw new Incomplete(); i = k + 1; continue; }
        if (d === '$' && src[i + 1] === '(') { i = balanced(i + 2, '(', ')'); continue; }
        if (d === '$' && src[i + 1] === '{') { i = balanced(i + 2, '{', '}'); continue; }
        i++;
      }
      toks.push({ t: 'w', v: src.slice(s, i) });
    }
    if (heredocs.length) throw new Incomplete();
    return toks;

    function pendingHeredoc(op) {
      // delimiter word follows
      while (src[i] === ' ' || src[i] === '\t') i++;
      const s = i;
      while (i < n && !/[\s|&;()<>]/.test(src[i])) {
        if (src[i] === "'") { const k = src.indexOf("'", i + 1); i = k < 0 ? n : k + 1; continue; }
        if (src[i] === '"') { const k = src.indexOf('"', i + 1); i = k < 0 ? n : k + 1; continue; }
        i++;
      }
      const raw = src.slice(s, i);
      if (!raw) throw new BashSyntax("syntax error near unexpected token `newline'");
      const tok = { t: 'w', v: raw, heredoc: true };
      toks.push(tok);
      heredocs.push({ tok, delim: raw.replace(/['"\\]/g, ''), strip: op === '<<-' });
      tok.quotedDelim = /['"\\]/.test(raw);
    }
  }

  /* ================================================================ parser */
  function parse(src) {
    const toks = lex(src);
    let p = 0;
    const peek = () => toks[p];
    const isW = (t, v) => t && t.t === 'w' && (v === undefined || t.v === v);
    const isOp = (t, v) => t && t.t === 'op' && (v === undefined || t.v === v);
    const skipNl = () => { while (peek() && peek().t === 'nl') p++; };
    const err = t => new BashSyntax(`syntax error near unexpected token \`${t ? (t.t === 'nl' ? 'newline' : t.v) : 'newline'}'`);
    const expectW = v => { skipNl(); const t = peek(); if (!isW(t, v)) { if (!t) throw new Incomplete(); throw err(t); } p++; };

    function list(stops) {
      const items = [];
      skipNl();
      while (peek()) {
        const t = peek();
        if (stops && isW(t) && stops.includes(t.v)) break;
        if (isOp(t, ')') || isOp(t, ';;')) break;
        if (isW(t, '}') && stops && stops.includes('}')) break;
        const node = andOr();
        let op = ';';
        const nx = peek();
        if (isOp(nx, ';') || isOp(nx, '&')) { op = nx.v; p++; }
        else if (nx && nx.t === 'nl') { p++; }
        else if (nx && !(stops && isW(nx) && stops.includes(nx.v)) && !isOp(nx, ')') && !isOp(nx, ';;')) throw err(nx);
        items.push({ node, op });
        skipNl();
      }
      return { type: 'list', items };
    }
    function andOr() {
      const first = pipeline();
      const rest = [];
      while (isOp(peek(), '&&') || isOp(peek(), '||')) {
        const op = peek().v; p++;
        skipNl();
        if (!peek()) throw new Incomplete();
        rest.push({ op, node: pipeline() });
      }
      return rest.length ? { type: 'andor', first, rest } : first;
    }
    function pipeline() {
      let bang = false;
      if (isW(peek(), '!')) { bang = true; p++; }
      const cmds = [command()];
      const errPipe = [];
      while (isOp(peek(), '|') || isOp(peek(), '|&')) {
        errPipe.push(peek().v === '|&'); p++;
        skipNl();
        if (!peek()) throw new Incomplete();
        cmds.push(command());
      }
      return cmds.length > 1 || bang ? { type: 'pipe', cmds, bang, errPipe } : cmds[0];
    }
    function redirs(node) {
      while (isOp(peek()) && ['<', '>', '>>', '>|', '<<', '<<-', '<<<', '>&', '<&', '&>', '&>>'].includes(peek().v)) {
        const op = peek(); p++;
        const target = peek();
        if (!target || target.t !== 'w') { if (!target) throw new Incomplete(); throw err(target); }
        p++;
        node.redirs.push({ op: op.v, fd: op.fd, target: target.v, body: target.body, quoted: target.quotedDelim });
      }
      return node;
    }
    function command() {
      const t = peek();
      if (!t) throw new Incomplete();
      if (t.t === 'arith') { p++; return redirs({ type: 'arith', expr: t.v, redirs: [] }); }
      if (isOp(t, '(')) { p++; const body = list([]); if (!isOp(peek(), ')')) { if (!peek()) throw new Incomplete(); throw err(peek()); } p++; return redirs({ type: 'subshell', body, redirs: [] }); }
      if (isW(t)) {
        switch (t.v) {
          case '{': { p++; const body = list(['}']); expectW('}'); return redirs({ type: 'group', body, redirs: [] }); }
          case 'if': {
            p++;
            const clauses = [];
            let cond = list(['then']); expectW('then');
            let body = list(['elif', 'else', 'fi']);
            clauses.push({ cond, body });
            let els = null;
            for (;;) {
              skipNl();
              const k = peek();
              if (!k) throw new Incomplete();
              if (isW(k, 'elif')) { p++; cond = list(['then']); expectW('then'); body = list(['elif', 'else', 'fi']); clauses.push({ cond, body }); continue; }
              if (isW(k, 'else')) { p++; els = list(['fi']); expectW('fi'); break; }
              if (isW(k, 'fi')) { p++; break; }
              throw err(k);
            }
            return redirs({ type: 'if', clauses, els, redirs: [] });
          }
          case 'while': case 'until': {
            p++;
            const cond = list(['do']); expectW('do');
            const body = list(['done']); expectW('done');
            return redirs({ type: 'while', until: t.v === 'until', cond, body, redirs: [] });
          }
          case 'for': case 'select': {
            p++;
            if (peek() && peek().t === 'arith') {
              const parts = peek().v.split(';'); p++;
              if (isOp(peek(), ';')) p++;
              skipNl();
              const open = peek();
              let body;
              if (isW(open, '{')) { p++; body = list(['}']); expectW('}'); } else { expectW('do'); body = list(['done']); expectW('done'); }
              return redirs({ type: 'cfor', init: parts[0] || '', cond: parts[1] || '', step: parts[2] || '', body, redirs: [] });
            }
            const v = peek(); if (!isW(v)) { if (!v) throw new Incomplete(); throw err(v); } p++;
            let words = null;
            skipNlIfIn();
            if (isW(peek(), 'in')) { p++; words = []; while (isW(peek())) { words.push(peek().v); p++; } }
            if (isOp(peek(), ';')) p++;
            skipNl();
            expectW('do');
            const body = list(['done']); expectW('done');
            return redirs({ type: 'for', name: v.v, words, body, redirs: [] });
          }
          case 'case': {
            p++;
            const w = peek(); if (!isW(w)) { if (!w) throw new Incomplete(); throw err(w); } p++;
            skipNl(); expectW('in');
            const items = [];
            for (;;) {
              skipNl();
              const k = peek();
              if (!k) throw new Incomplete();
              if (isW(k, 'esac')) { p++; break; }
              if (isOp(k, '(')) p++;
              const pats = [];
              for (;;) { const pt = peek(); if (!isW(pt)) { if (!pt) throw new Incomplete(); throw err(pt); } pats.push(pt.v); p++; if (isOp(peek(), '|')) { p++; continue; } break; }
              if (!isOp(peek(), ')')) { if (!peek()) throw new Incomplete(); throw err(peek()); }
              p++;
              const body = list(['esac']);
              items.push({ pats, body });
              if (isOp(peek(), ';;')) p++;
            }
            return redirs({ type: 'case', word: w.v, items, redirs: [] });
          }
          case 'function': {
            p++;
            const nm = peek(); p++;
            if (isOp(peek(), '(')) { p++; if (!isOp(peek(), ')')) throw err(peek()); p++; }
            skipNl();
            return { type: 'func', name: nm.v, body: command() };
          }
          case '[[': {
            p++;
            const words = [];
            while (peek() && !isW(peek(), ']]')) {
              const k = peek();
              if (k.t === 'nl') throw err(k);
              words.push(k.t === 'op' ? { op: k.v } : k.v); p++;
            }
            if (!peek()) throw new Incomplete();
            p++;
            return redirs({ type: 'cond', words, redirs: [] });
          }
          default:
            if (['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}', 'in'].includes(t.v)) throw err(t);
        }
        // function definition name() { ... }
        if (isOp(toks[p + 1], '(') && isOp(toks[p + 2], ')') && /^[\w.:-]+$/.test(t.v)) {
          p += 3; skipNl();
          return { type: 'func', name: t.v, body: command() };
        }
      }
      const node = { type: 'simple', assigns: [], words: [], redirs: [] };
      for (;;) {
        const k = peek();
        if (!k) break;
        if (isOp(k) && ['<', '>', '>>', '>|', '<<', '<<-', '<<<', '>&', '<&', '&>', '&>>'].includes(k.v)) { redirs(node); continue; }
        if (k.t !== 'w') break;
        if (!node.words.length && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(k.v)) {
          // array assignment a=(x y) arrives as word "a=" followed by "(" ... ")"
          if (k.v.endsWith('=') && isOp(toks[p + 1], '(')) {
            p += 2; const vals = [];
            while (peek() && !isOp(peek(), ')')) { if (peek().t === 'w') vals.push(peek().v); p++; }
            if (!peek()) throw new Incomplete();
            p++;
            node.assigns.push({ raw: k.v, array: vals });
            continue;
          }
          node.assigns.push({ raw: k.v }); p++; continue;
        }
        node.words.push(k.v); p++;
      }
      if (!node.words.length && !node.assigns.length && !node.redirs.length) throw err(peek());
      return node;
    }
    function skipNlIfIn() { let q = p; while (toks[q] && toks[q].t === 'nl') q++; if (isW(toks[q], 'in')) p = q; }

    const ast = list(null);
    if (p < toks.length) throw err(toks[p]);
    return ast;
  }

  /* ================================================================ helpers */
  function globRe(pat, anchored = true) {
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '\\') { re += '\\' + (pat[++i] || '\\'); continue; }
      if (c === '*') re += '.*';
      else if (c === '?') re += '.';
      else if (c === '[') {
        const j = pat.indexOf(']', i + 2);
        if (j < 0) { re += '\\['; continue; }
        let cls = pat.slice(i + 1, j);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        cls = cls.replace(/\[:(\w+):\]/g, (m, k) => ({ alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', punct: '!-\\/:-@\\[-`{-~' })[k] || '');
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = j;
      } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    return new RegExp(anchored ? '^' + re + '$' : re);
  }
  function hasGlob(s) { return /[*?[]/.test(s); }

  /* ================================================================ arithmetic */
  function arith(expr, get, set) {
    const s = expr;
    let i = 0;
    const ws = () => { while (/\s/.test(s[i] || '')) i++; };
    const num = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
    function primary() {
      ws();
      if (s[i] === '(') { i++; const v = comma(); ws(); i++; return v; }
      if (s[i] === '!') { i++; return primary() ? 0 : 1; }
      if (s[i] === '~') { i++; return ~primary(); }
      if (s[i] === '-' && s[i + 1] !== '-') { i++; return -primary(); }
      if (s[i] === '+' && s[i + 1] !== '+') { i++; return +primary(); }
      if ((s[i] === '+' || s[i] === '-') && s[i + 1] === s[i]) { const op = s[i]; i += 2; ws(); const m = s.slice(i).match(/^\$?[A-Za-z_]\w*/); i += m[0].length; const name = m[0].replace('$', ''); const v = num(get(name)) + (op === '+' ? 1 : -1); set(name, String(v)); return v; }
      let m = s.slice(i).match(/^(0x[0-9a-fA-F]+|\d+#[0-9a-zA-Z]+|\d+)/);
      if (m) { i += m[0].length; if (m[0].includes('#')) { const [b, d] = m[0].split('#'); return parseInt(d, Number(b)); } return m[0].startsWith('0x') ? parseInt(m[0], 16) : /^0\d/.test(m[0]) ? parseInt(m[0], 8) : Number(m[0]); }
      m = s.slice(i).match(/^\$?\{?([A-Za-z_]\w*)\}?/);
      if (m) {
        i += m[0].length; ws();
        const name = m[1];
        if ((s[i] === '+' || s[i] === '-') && s[i + 1] === s[i]) { i += 2; const old = num(get(name)); set(name, String(old + (s[i - 1] === '+' ? 1 : -1))); return old; }
        const am = s.slice(i).match(/^(\*\*=|<<=|>>=|[-+*/%&|^]=|=(?!=))/);
        if (am) { i += am[0].length; const r = assign(); const cur = num(get(name)); const v = am[0] === '=' ? r : binop(am[0].slice(0, -1), cur, r); set(name, String(v)); return v; }
        const raw = get(name);
        return /^-?\d+$/.test(String(raw).trim()) ? Number(raw) : raw === '' || raw == null ? 0 : arith(String(raw), get, set);
      }
      if (i >= s.length) return 0;
      throw new Error(`syntax error: operand expected (error token is "${s.slice(i)}")`);
    }
    function binop(op, a, b) {
      switch (op) {
        case '**': return a ** b; case '*': return a * b;
        case '/': if (!b) throw new Error('division by 0 (error token is "' + b + '")'); return Math.trunc(a / b);
        case '%': if (!b) throw new Error('division by 0'); return a % b;
        case '+': return a + b; case '-': return a - b; case '<<': return a << b; case '>>': return a >> b;
        case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      }
      return 0;
    }
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<=', '>=', '<', '>'], ['<<', '>>'], ['+', '-'], ['*', '/', '%'], ['**']];
    function level(k) {
      if (k >= LEVELS.length) return primary();
      let a = level(k + 1);
      for (;;) {
        ws();
        const op = LEVELS[k].find(o => s.startsWith(o, i) && !(o === '|' && s[i + 1] === '|') && !(o === '&' && s[i + 1] === '&') && !(o === '<' && s[i + 1] === '<') && !(o === '>' && s[i + 1] === '>') && !(o === '*' && s[i + 1] === '*') && !(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(o) && s[i + o.length] === '=' && s[i + o.length + 1] !== '='));
        if (!op) return a;
        i += op.length;
        const b = op === '**' ? level(k) : level(k + 1);
        switch (op) {
          case '||': a = a || b ? 1 : 0; break; case '&&': a = a && b ? 1 : 0; break;
          case '==': a = a === b ? 1 : 0; break; case '!=': a = a !== b ? 1 : 0; break;
          case '<=': a = a <= b ? 1 : 0; break; case '>=': a = a >= b ? 1 : 0; break; case '<': a = a < b ? 1 : 0; break; case '>': a = a > b ? 1 : 0; break;
          default: a = binop(op, a, b);
        }
      }
    }
    function ternary() { const c = level(0); ws(); if (s[i] === '?') { i++; const a = assign(); ws(); i++; const b = assign(); return c ? a : b; } return c; }
    function assign() { return ternary(); }
    function comma() { let v = assign(); ws(); while (s[i] === ',') { i++; v = assign(); ws(); } return v; }
    const v = comma();
    ws();
    if (i < s.length) throw new Error(`syntax error in expression (error token is "${s.slice(i)}")`);
    return Math.trunc(v);
  }

  /* ================================================================ interpreter */
  class Interp {
    constructor(shell) { this.sh = shell; this.steps = 0; }

    // ---------------- expansion
    brace(word) {
      // find first unquoted {..} with comma or range
      let depth = 0, q = null, start = -1;
      for (let i = 0; i < word.length; i++) {
        const c = word[i];
        if (q) { if (c === q && word[i - 1] !== '\\') q = null; continue; }
        if (c === '\\') { i++; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === '$' && word[i + 1] === '{') { let d = 1; i += 2; while (i < word.length && d) { if (word[i] === '{') d++; if (word[i] === '}') d--; i++; } i--; continue; }
        if (c === '{') { if (depth === 0) start = i; depth++; }
        else if (c === '}' && depth) {
          depth--;
          if (depth === 0 && start >= 0) {
            const inner = word.slice(start + 1, i);
            const pre = word.slice(0, start), post = word.slice(i + 1);
            const range = inner.match(/^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/);
            let parts = null;
            if (range) {
              const num = /\d/.test(range[1]);
              const a = num ? Number(range[1]) : range[1].charCodeAt(0), b = num ? Number(range[2]) : range[2].charCodeAt(0);
              const step = Math.abs(Number(range[3] || 1)) || 1;
              parts = [];
              const width = num && /^-?0\d/.test(range[1]) ? range[1].length : 0;
              for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) { parts.push(num ? String(v).padStart(width, '0') : String.fromCharCode(v)); if (parts.length > 10000) break; }
            } else {
              const items = []; let d = 0, s = 0, qq = null;
              for (let j = 0; j < inner.length; j++) { const ch = inner[j]; if (qq) { if (ch === qq) qq = null; continue; } if (ch === "'" || ch === '"') { qq = ch; continue; } if (ch === '{') d++; else if (ch === '}') d--; else if (ch === ',' && !d) { items.push(inner.slice(s, j)); s = j + 1; } }
              items.push(inner.slice(s));
              if (items.length > 1) parts = items;
            }
            if (parts) return parts.flatMap(x => this.brace(pre + x + post));
            start = -1;
          }
        }
      }
      return [word];
    }
    // Expand one raw word into fields.
    expand(raw, opt = {}) {
      const words = opt.noBrace ? [raw] : this.brace(raw);
      const out = [];
      for (const w of words) out.push(...this.expandOne(w, opt));
      return out;
    }
    expandOne(raw, opt) {
      const sh = this.sh;
      const fields = [];
      let cur = null; // {chars:[], quoted:bool}
      const ensure = () => { if (!cur) cur = { s: '', g: '', quoted: false }; return cur; };
      const pushLit = (text, quoted) => { const c = ensure(); c.s += text; c.g += quoted ? text.replace(/[*?[\]\\]/g, '\\$&') : text; if (quoted) c.quoted = true; };
      const pushExp = (text, quoted) => {
        if (quoted || opt.split === false) { pushLit(text, quoted); return; }
        const ifs = sh.getVar('IFS') ?? ' \t\n';
        const parts = ifs === '' ? [text] : text.split(new RegExp('[' + ifs.replace(/[\]\\^-]/g, '\\$&') + ']+'));
        parts.forEach((part, k) => {
          if (k > 0) { if (cur) fields.push(cur); cur = null; }
          if (part === '' && (k === 0 || k === parts.length - 1)) { if (k === 0 && /^\s/.test(text) && cur) { fields.push(cur); cur = null; } return; }
          pushLit(part, false);
        });
      };
      let i = 0;
      const s = raw;
      const atStart = () => !cur || (cur.s === '' && !cur.quoted);
      while (i < s.length) {
        const c = s[i];
        if (c === "'") { const j = s.indexOf("'", i + 1); pushLit(s.slice(i + 1, j), true); ensure().quoted = true; i = j + 1; continue; }
        if (c === '\\') { pushLit(s[i + 1] || '', true); i += 2; continue; }
        if (c === '"') {
          ensure().quoted = true;
          i++;
          while (i < s.length && s[i] !== '"') {
            const d = s[i];
            if (d === '\\' && '"\\$`\n'.includes(s[i + 1])) { if (s[i + 1] !== '\n') pushLit(s[i + 1], true); i += 2; continue; }
            if (d === '$' || d === '`') {
              const r = this.dollar(s, i, true);
              if (r.atFields) { // "$@"
                r.atFields.forEach((f, k) => { if (k > 0) { fields.push(cur); cur = { s: '', g: '', quoted: true }; } pushLit(f, true); });
                if (!r.atFields.length && cur && cur.s === '') cur.dropIfEmpty = true;
              } else pushLit(r.value, true);
              i = r.end; continue;
            }
            pushLit(d, true); i++;
          }
          i++;
          continue;
        }
        if (c === '$' || c === '`') {
          const r = this.dollar(s, i, false);
          if (r.atFields) r.atFields.forEach((f, k) => { if (k > 0 && cur) { fields.push(cur); cur = null; } pushExp(f, false); });
          else if (r.literal) pushLit(r.value, false);
          else pushExp(r.value, false);
          i = r.end; continue;
        }
        if (c === '~' && atStart() && opt.tilde !== false) {
          const m = s.slice(i).match(/^~([A-Za-z_][\w-]*)?(?=\/|$|:)/);
          if (m) {
            const home = m[1] ? (sh.host.users[m[1]] ? sh.host.users[m[1]].home : null) : sh.getVar('HOME');
            if (home !== null && home !== undefined) { pushLit(home, true); i += m[0].length; continue; }
          }
        }
        pushLit(c, false);
        if (c === '=' && opt.assign) { /* allow ~ after = */ }
        i++;
      }
      if (cur) fields.push(cur);
      const result = [];
      for (const f of fields) {
        if (f.dropIfEmpty && f.s === '') continue;
        if (opt.glob !== false && sh.opts.noglob !== true && /(^|[^\\])[*?[]/.test(f.g) && hasGlob(f.s)) {
          const hits = this.glob(f.g);
          if (hits.length) { result.push(...hits); continue; }
        }
        if (f.s === '' && !f.quoted) continue;
        result.push(f.s);
      }
      return result;
    }
    glob(pattern) {
      const sh = this.sh;
      const fs = sh.vfs();
      const abs = pattern.startsWith('/');
      const parts = pattern.split('/').filter((x, k) => x !== '' || k === 0);
      let bases = [abs ? '/' : ''];
      for (let k = abs ? 1 : 0; k < parts.length; k++) {
        const part = parts[k];
        const next = [];
        const last = k === parts.length - 1;
        for (const b of bases) {
          const dir = b === '' ? sh.cwd : b.startsWith('/') ? b : IG.VFS.norm(b, sh.cwd);
          if (!/(^|[^\\])[*?[]/.test(part)) {
            const lit = part.replace(/\\(.)/g, '$1');
            const cand = (b === '' ? '' : b === '/' ? '/' : b + '/') + lit;
            if (fs.exists(IG.VFS.norm(cand, sh.cwd)) || fs.lexists(IG.VFS.norm(cand, sh.cwd))) next.push(cand);
            continue;
          }
          if (!fs.isDir(dir)) continue;
          const re = globRe(part);
          for (const c of fs.children(dir)) {
            if (c.name.startsWith('.') && !part.startsWith('.')) continue;
            if (!re.test(c.name)) continue;
            if (!last && !c.dir && !(c.link && fs.isDir(c.path))) continue;
            next.push((b === '' ? '' : b === '/' ? '/' : b + '/') + c.name);
          }
        }
        bases = next;
        if (!bases.length) break;
      }
      return bases.sort();
    }
    // Parse a $-expression or backquote at s[i]; returns {value, end, atFields?}
    dollar(s, i, inQuotes) {
      const sh = this.sh;
      if (s[i] === '`') {
        const j = s.indexOf('`', i + 1);
        return { value: this.capture(s.slice(i + 1, j).replace(/\\([`$\\])/g, '$1')), end: j + 1 };
      }
      const c = s[i + 1];
      if (c === '(' && s[i + 2] === '(') {
        let d = 2, j = i + 3;
        while (j < s.length && d) { if (s[j] === '(') d++; else if (s[j] === ')') d--; j++; }
        const expr = s.slice(i + 3, j - 2);
        return { value: String(this.arith(this.expandText(expr))), end: j };
      }
      if (c === '(') {
        let d = 1, j = i + 2, q = null;
        while (j < s.length && d) { const ch = s[j]; if (q) { if (ch === q) q = null; } else if (ch === "'" || ch === '"') q = ch; else if (ch === '(') d++; else if (ch === ')') d--; j++; }
        return { value: this.capture(s.slice(i + 2, j - 1)), end: j };
      }
      if (c === '{') {
        let d = 1, j = i + 2;
        while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
        const inner = s.slice(i + 2, j - 1);
        if (/^(@|\*)$/.test(inner) || /^\w+\[@\]$/.test(inner)) {
          const vals = inner === '@' || inner === '*' ? sh.positional() : sh.arrayGet(inner.replace('[@]', ''));
          if (inner.endsWith('@') && inQuotes) return { atFields: vals, end: j };
          return { value: vals.join(inQuotes && inner.endsWith('*') ? ((sh.getVar('IFS') ?? ' ')[0] || '') : ' '), end: j };
        }
        return { value: this.param(inner), end: j };
      }
      const m = s.slice(i + 1).match(/^([A-Za-z_]\w*|[0-9]|[?#$!@*\-])/);
      if (!m) return { value: '$', end: i + 1, literal: true };
      const name = m[1];
      if (name === '@' && inQuotes) return { atFields: sh.positional(), end: i + 2 };
      if (name === '@' || name === '*') return { value: sh.positional().join(' '), end: i + 2 };
      const v = sh.special(name);
      if (v === undefined && sh.opts.nounset) throw new Error(`${name}: unbound variable`);
      return { value: v ?? '', end: i + 1 + name.length };
    }
    expandText(t) { // expand $vars inside arithmetic / here-doc without splitting
      let out = '', i = 0;
      while (i < t.length) {
        if (t[i] === '\\' && i + 1 < t.length && '$`\\'.includes(t[i + 1])) { out += t[i + 1]; i += 2; continue; }
        if (t[i] === '$' || t[i] === '`') { const r = this.dollar(t, i, true); out += r.atFields ? r.atFields.join(' ') : r.value; i = r.end; continue; }
        out += t[i++];
      }
      return out;
    }
    param(inner) {
      const sh = this.sh;
      let m;
      if ((m = inner.match(/^#([A-Za-z_]\w*|[0-9@*#?])$/))) { if (m[1] === '@' || m[1] === '*') return String(sh.positional().length); return String((sh.special(m[1]) ?? '').length); }
      if ((m = inner.match(/^#([A-Za-z_]\w*)\[[@*]\]$/))) return String(sh.arrayGet(m[1]).length);
      if ((m = inner.match(/^!([A-Za-z_]\w*)$/))) return sh.special(sh.special(m[1]) || '') ?? '';
      m = inner.match(/^([A-Za-z_]\w*|[0-9]+|[?#$!@*\-])(\[(.*?)\])?(.*)$/s);
      if (!m) throw new Error(`\${${inner}}: bad substitution`);
      const name = m[1], idx = m[3], rest = m[4];
      let val = idx !== undefined ? sh.arrayGet(name)[Number(this.arith(idx))] : sh.special(name);
      const unset = val === undefined;
      if (rest === '') { if (unset && sh.opts.nounset) throw new Error(`${name}: unbound variable`); return val ?? ''; }
      const op = rest.match(/^(:?[-=+?])(.*)$/s);
      if (op) {
        const nullish = op[1].startsWith(':') ? unset || val === '' : unset;
        const word = () => this.expandText(op[2].replace(/^["']|["']$/g, ''));
        switch (op[1].replace(':', '')) {
          case '-': return nullish ? word() : val;
          case '=': if (nullish) { const v = word(); sh.setVar(name, v); return v; } return val;
          case '+': return nullish ? '' : word();
          case '?': if (nullish) throw new Error(`${name}: ${op[2] || 'parameter null or not set'}`); return val;
        }
      }
      val = val ?? '';
      if ((m = rest.match(/^(##?|%%?)(.*)$/s))) {
        const pat = this.expandText(m[2]);
        const re = globRe(pat, false);
        if (m[1][0] === '#') {
          let best = -1;
          for (let k = 0; k <= val.length; k++) if (globRe(pat).test(val.slice(0, k))) { best = k; if (m[1] === '#') break; }
          return best < 0 ? val : val.slice(best);
        }
        let best = -1;
        for (let k = val.length; k >= 0; k--) if (globRe(pat).test(val.slice(k))) { best = k; if (m[1] === '%') break; }
        void re;
        return best < 0 ? val : val.slice(0, best);
      }
      if ((m = rest.match(/^\/(\/?)([^/]*)(?:\/(.*))?$/s))) {
        const re = globRe(this.expandText(m[2]), false);
        const rep = this.expandText(m[3] || '');
        return val.replace(new RegExp(re.source, m[1] ? 'g' : ''), () => rep);
      }
      if ((m = rest.match(/^:\s*(-?\d+)(?::(-?\d+))?$/))) {
        let off = Number(m[1]); if (off < 0) off = Math.max(0, val.length + off);
        if (m[2] === undefined) return val.slice(off);
        const len = Number(m[2]);
        return len < 0 ? val.slice(off, val.length + len) : val.substr(off, len);
      }
      if (rest === '^^') return val.toUpperCase();
      if (rest === ',,') return val.toLowerCase();
      if (rest === '^') return val.charAt(0).toUpperCase() + val.slice(1);
      if (rest === ',') return val.charAt(0).toLowerCase() + val.slice(1);
      throw new Error(`\${${inner}}: bad substitution`);
    }
    arith(expr) { return arith(expr, n => this.sh.special(n) ?? '', (n, v) => this.sh.setVar(n, v)); }
    capture(src) {
      const sub = this.sh.subshell();
      const buf = { text: '' };
      try {
        const ast = parse(src);
        sub.interp.run(ast, { stdin: mkIn(''), fd: { 1: { buf }, 2: this.io ? this.io.fd[2] : { term: 'err' } } });
      } catch (e) {
        if (e instanceof Flow && e.kind === 'exit') { /* $(exit 3) */ this.sh.lastCode = e.code; }
        else if (!(e instanceof Flow)) this.sh.writeErr(`bash: ${e.message}\n`);
      }
      this.sh.lastCode = sub.lastCode;
      return buf.text.replace(/\n+$/, '');
    }

    // ---------------- execution
    run(node, io) {
      const prev = this.io;
      this.io = io;
      try { return this.exec(node, io); } finally { this.io = prev; }
    }
    step() {
      if (++this.steps > 20000) throw new Flow('abort', 0, 130);
    }
    exec(node, io) {
      const sh = this.sh;
      this.step();
      switch (node.type) {
        case 'list': {
          let code = 0;
          for (const it of node.items) {
            if (it.op === '&') { code = this.background(it.node, io); continue; }
            code = this.exec(it.node, io);
            sh.lastCode = code;
            if (sh.opts.errexit && code !== 0 && !this.inCond) throw new Flow('exit', 0, code);
          }
          return code;
        }
        case 'andor': {
          let code = this.condExec(node.first, io, node.rest.length > 0);
          for (const r of node.rest) {
            if ((r.op === '&&' && code === 0) || (r.op === '||' && code !== 0)) code = this.condExec(r.node, io, r !== node.rest[node.rest.length - 1]);
          }
          sh.lastCode = code;
          return code;
        }
        case 'pipe': return this.pipe(node, io);
        case 'simple': return this.simple(node, io);
        case 'func': sh.funcs[node.name] = node.body; return 0;
        default: return this.withRedirs(node, io, rio => this.compound(node, rio));
      }
    }
    condExec(node, io, inCond) { const was = this.inCond; this.inCond = inCond || was; try { return this.exec(node, io); } finally { this.inCond = was; } }
    compound(node, io) {
      const sh = this.sh;
      switch (node.type) {
        case 'group': return this.exec(node.body, io);
        case 'subshell': {
          const sub = sh.subshell();
          try { return sub.interp.run(node.body, io); } catch (e) { if (e instanceof Flow && e.kind === 'exit') return e.code; throw e; }
        }
        case 'if': {
          for (const c of node.clauses) if (this.condExec(c.cond, io, true) === 0) return this.exec(c.body, io);
          return node.els ? this.exec(node.els, io) : 0;
        }
        case 'while': {
          let code = 0;
          for (;;) {
            this.step();
            const c = this.condExec(node.cond, io, true);
            if (node.until ? c === 0 : c !== 0) break;
            try { code = this.exec(node.body, io); } catch (e) { if (this.loopFlow(e)) { if (e.kind === 'break') break; continue; } throw e; }
          }
          return code;
        }
        case 'for': {
          const words = node.words === null ? sh.positional() : node.words.flatMap(w => this.expand(w));
          let code = 0;
          for (const w of words) {
            sh.setVar(node.name, w);
            try { code = this.exec(node.body, io); } catch (e) { if (this.loopFlow(e)) { if (e.kind === 'break') break; continue; } throw e; }
          }
          return code;
        }
        case 'cfor': {
          let code = 0;
          if (node.init.trim()) this.arith(node.init);
          for (;;) {
            this.step();
            if (node.cond.trim() && !this.arith(node.cond)) break;
            try { code = this.exec(node.body, io); } catch (e) { if (this.loopFlow(e)) { if (e.kind === 'break') break; if (node.step.trim()) this.arith(node.step); continue; } throw e; }
            if (node.step.trim()) this.arith(node.step);
          }
          return code;
        }
        case 'case': {
          const word = this.expand(node.word, { split: false, glob: false }).join(' ');
          for (const it of node.items) {
            if (it.pats.some(p => globRe(this.expand(p, { split: false, glob: false }).join(' ')).test(word))) return this.exec(it.body, io);
          }
          return 0;
        }
        case 'cond': {
          const code = this.condExpr(node.words) ? 0 : 1;
          return code;
        }
        case 'arith': {
          try { return this.arith(node.expr) ? 0 : 1; } catch (e) { sh.writeTo(io, 2, `bash: ((: ${node.expr}: ${e.message}\n`); return 1; }
        }
      }
      return 0;
    }
    loopFlow(e) {
      if (!(e instanceof Flow) || (e.kind !== 'break' && e.kind !== 'continue')) return false;
      if (e.n > 1) { e.n--; throw e; }
      return true;
    }
    background(node, io) {
      const sh = this.sh;
      const job = sh.addJob(node);
      sh.writeTo(io, 2, `[${job.n}] ${job.pid}\n`);
      try { this.exec(node, io); } catch (e) { if (!(e instanceof Flow)) throw e; }
      job.done = true;
      sh.setVar('!', String(job.pid));
      return 0;
    }
    pipe(node, io) {
      const sh = this.sh;
      let input = io.stdin;
      let code = 0;
      const codes = [];
      node.cmds.forEach((c, k) => {
        const last = k === node.cmds.length - 1;
        const buf = { text: '' };
        const fd = last ? io.fd : Object.assign({}, io.fd, { 1: { buf } }, node.errPipe[k] ? { 2: { buf } } : {});
        const sub = !last && sh.opts.lastpipe !== true ? this : this; // simplified: same shell state
        try { code = sub.exec(c, { stdin: input, fd }); } catch (e) { if (e instanceof Flow && e.kind === 'exit') code = e.code; else throw e; }
        codes.push(code);
        input = mkIn(buf.text);
      });
      if (sh.opts.pipefail) code = codes.reverse().find(c => c !== 0) || 0;
      if (node.bang) code = code === 0 ? 1 : 0;
      sh.setVar('PIPESTATUS', codes.join(' '));
      return code;
    }
    // apply redirections for compound commands
    withRedirs(node, io, fn) {
      if (!node.redirs || !node.redirs.length) return fn(io);
      const rio = this.redirect(node.redirs, io);
      if (rio.error) { this.sh.writeTo(io, 2, rio.error); return 1; }
      return fn(rio);
    }
    redirect(redirs, io) {
      const sh = this.sh;
      const fd = Object.assign({}, io.fd);
      let stdin = io.stdin;
      for (const r of redirs) {
        if (r.op === '<<' || r.op === '<<-') { stdin = mkIn(r.quoted ? r.body : this.expandText(r.body)); continue; }
        if (r.op === '<<<') { stdin = mkIn(this.expand(r.target, { split: false, glob: false }).join(' ') + '\n'); continue; }
        const tw = this.expand(r.target, { split: false });
        if (tw.length !== 1) return { error: `bash: ${r.target}: ambiguous redirect\n` };
        const target = tw[0];
        const n = r.fd ?? (r.op.startsWith('<') ? 0 : 1);
        if (r.op === '>&' || r.op === '<&') {
          if (target === '-') { fd[n] = { null: true }; continue; }
          if (/^\d$/.test(target)) { fd[n] = fd[Number(target)] || { term: Number(target) === 2 ? 'err' : 'out' }; continue; }
          // >&file  means &>file
          const f = sh.openFile(target, false);
          if (f.error) return f;
          fd[1] = f; fd[2] = f; continue;
        }
        if (r.op === '<') {
          const p = sh.resolve(target);
          const fs = sh.vfs();
          if (!fs.exists(p)) return { error: `bash: ${target}: No such file or directory\n` };
          if (fs.isDir(p)) return { error: `bash: ${target}: Is a directory\n` };
          if (!sh.canRead(p)) return { error: `bash: ${target}: Permission denied\n` };
          stdin = mkIn(fs.read(p) || '');
          continue;
        }
        const f = sh.openFile(target, r.op === '>>' || r.op === '&>>');
        if (f.error) return f;
        if (r.op === '&>' || r.op === '&>>') { fd[1] = f; fd[2] = f; } else fd[n] = f;
      }
      return { stdin, fd };
    }
    simple(node, io) {
      const sh = this.sh;
      // expand words
      let words;
      try {
        words = node.words.flatMap((w, k) => (k === 0 && /^[A-Za-z_][\w-]*$/.test(w) && sh.aliases[w] && !this.aliasDepth ? this.aliasExpand(w) : this.expand(w)));
      } catch (e) {
        if (e instanceof Flow) throw e;
        sh.writeTo(io, 2, `bash: ${e.message}\n`); return 1;
      }
      const assigns = [];
      try {
        for (const a of node.assigns) {
          const m = a.raw.match(/^([A-Za-z_]\w*)(\[[^\]]*\])?(\+?)=(.*)$/s);
          if (a.array) { assigns.push({ name: m[1], array: a.array.flatMap(x => this.expand(x)) }); continue; }
          const val = this.expand(m[4], { split: false, glob: false, assign: true }).join('') || '';
          assigns.push({ name: m[1], idx: m[2] ? this.arith(m[2].slice(1, -1)) : null, value: m[3] ? (sh.special(m[1]) || '') + val : val });
        }
      } catch (e) { if (e instanceof Flow) throw e; sh.writeTo(io, 2, `bash: ${e.message}\n`); return 1; }
      const rio = this.redirect(node.redirs, io);
      if (rio.error) { sh.writeTo(io, 2, rio.error); return 1; }
      if (!words.length) {
        for (const a of assigns) {
          if (sh.readonly.has(a.name)) { sh.writeTo(io, 2, `bash: ${a.name}: readonly variable\n`); return 1; }
          if (a.array) sh.arraySet(a.name, a.array); else if (a.idx !== null && a.idx !== undefined) { const arr = sh.arrayGet(a.name).slice(); arr[a.idx] = a.value; sh.arraySet(a.name, arr); } else sh.setVar(a.name, a.value);
        }
        return node.words.length ? sh.lastCode : 0;
      }
      if (sh.opts.xtrace) sh.writeTo(rio, 2, '+ ' + words.map(w => (/[\s'"]/.test(w) ? `'${w}'` : w)).join(' ') + '\n');
      // temporary env for this command
      const saved = assigns.map(a => [a.name, sh.vars[a.name], sh.exported.has(a.name)]);
      for (const a of assigns) { sh.vars[a.name] = a.value; sh.exported.add(a.name); }
      try { return sh.invoke(words, rio); }
      finally { for (const [n, v, e] of saved) { if (v === undefined) delete sh.vars[n]; else sh.vars[n] = v; if (!e) sh.exported.delete(n); } }
    }
    aliasExpand(w) {
      const sh = this.sh;
      this.aliasDepth = (this.aliasDepth || 0) + 1;
      try {
        const ast = parse(sh.aliases[w]);
        const first = ast.items[0] && ast.items[0].node;
        if (first && first.type === 'simple' && ast.items.length === 1) return first.words.flatMap(x => this.expand(x));
        return this.expand(w);
      } finally { this.aliasDepth--; }
    }

    // ---------------- [[ ]] and test
    condExpr(words) {
      const toks = [];
      for (const w of words) {
        if (typeof w === 'object') { toks.push({ op: w.op }); continue; }
        toks.push({ w, val: null });
      }
      let i = 0;
      const val = t => (t.val !== null ? t.val : (t.val = this.expand(t.w, { split: false, glob: false }).join(' ')));
      const self = this;
      function orE() { let v = andE(); while (toks[i] && toks[i].op === '||') { i++; const r = andE(); v = v || r; } return v; }
      function andE() { let v = notE(); while (toks[i] && toks[i].op === '&&') { i++; const r = notE(); v = v && r; } return v; }
      function notE() { if (toks[i] && toks[i].w === '!') { i++; return !notE(); } return prim(); }
      function prim() {
        const t = toks[i];
        if (!t) return false;
        if (t.op === '(') { i++; const v = orE(); i++; return v; }
        if (t.w && /^-[a-zA-Z]$/.test(t.w) && toks[i + 1] && !(toks[i + 2] && toks[i + 2].w && BIN.includes(toks[i + 2].w))) { i += 2; return self.sh.unaryTest(t.w, val(toks[i - 1])); }
        const l = toks[i]; i++;
        const opT = toks[i];
        const op = opT ? (opT.op || opT.w) : null;
        if (op && (BIN.includes(op) || op === '<' || op === '>')) {
          i++;
          const r = toks[i]; i++;
          const L = val(l);
          if (op === '==' || op === '=' || op === '!=') {
            const pat = r.w && !/^["']/.test(r.w) ? self.expand(r.w, { split: false, glob: false }).join(' ') : null;
            const ok = pat !== null ? globRe(pat).test(L) : L === val(r);
            return op === '!=' ? !ok : ok;
          }
          if (op === '=~') {
            const raw = r.w;
            let src = raw.replace(/\\(.)/g, '$1');
            if (/^["']/.test(raw)) src = self.expand(raw, { split: false, glob: false }).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            else src = self.expandText(src);
            let m;
            try { m = L.match(new RegExp(src)); } catch (e) { return false; }
            self.sh.arraySet('BASH_REMATCH', m ? [...m].map(x => x ?? '') : []);
            return !!m;
          }
          return self.sh.binaryTest(op, L, val(r));
        }
        return val(l) !== '';
      }
      return orE();
    }
  }
  const BIN = ['=', '==', '!=', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef'];

  IG.bash = { lex, parse, Interp, Flow, Incomplete, BashSyntax, globRe, arith, mkIn, readAll };
})(globalThis.IG = globalThis.IG || {});
