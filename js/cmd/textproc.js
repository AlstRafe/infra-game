/* Text processing: grep sed awk sort uniq cut paste tr rev nl column fold comm diff cmp
 * expr bc jq xargs find shuf. Regex dialects (BRE/ERE/POSIX classes) are translated to JS. */
(function (IG) {
  "use strict";
  const VFS = IG.VFS;
  const C = (IG.commands = IG.commands || {});
  const opts = (...a) => IG.cliOpts(...a);
  const out = () => IG.cliOut();
  const inputs = (...a) => IG.readInputs(...a);
  const lines = (t) => {
    const l = String(t).split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
  };
  const join = (l) => (l.length ? l.join("\n") + "\n" : "");
  const tty = (ctx) => !!(ctx.io && ctx.io.fd && ctx.io.fd[1] && ctx.io.fd[1].term);

  /* ---------------- POSIX regex → JS */
  const CLASSES = {
    alpha: "A-Za-z",
    digit: "0-9",
    alnum: "A-Za-z0-9",
    upper: "A-Z",
    lower: "a-z",
    space: " \\t\\n\\r\\f\\v",
    blank: " \\t",
    punct: "!-\\/:-@\\[-`{-~",
    xdigit: "0-9A-Fa-f",
    print: " -~",
    graph: "!-~",
    cntrl: "\\x00-\\x1f",
  };
  function posix(src, ere) {
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === "[") {
        // bracket expression copied with class translation
        let j = i + 1;
        if (src[j] === "^") j++;
        if (src[j] === "]") j++;
        while (j < src.length && src[j] !== "]") {
          if (src[j] === "[" && src[j + 1] === ":") {
            const k = src.indexOf(":]", j);
            j = k < 0 ? j + 1 : k + 2;
            continue;
          }
          j++;
        }
        let body = src.slice(i + 1, j);
        body = body
          .replace(/\[:(\w+):\]/g, (m, k) => CLASSES[k] || "")
          .replace(/\\/g, "\\\\")
          .replace(/^(\^?)\]/, "$1\\]");
        out += "[" + body + "]";
        i = j;
        continue;
      }
      if (c === "\\") {
        const n = src[i + 1];
        i++;
        if (n === undefined) {
          out += "\\\\";
          break;
        }
        if (!ere && "|+?(){}".includes(n)) out += n;
        else if (/[<>]/.test(n)) out += "\\b";
        else if (n === "w" || n === "W" || n === "s" || n === "S" || n === "b" || n === "B" || /\d/.test(n))
          out += "\\" + n;
        else out += "\\" + n;
        continue;
      }
      if (!ere && "|+?(){}".includes(c)) {
        out += "\\" + c;
        continue;
      }
      if (!ere && c === "*" && (out === "" || out === "^")) {
        out += "\\*";
        continue;
      }
      out += c;
    }
    return out;
  }
  IG.posixRe = posix;
  function mkRe(src, { ere, fixed, icase, word, line, g, perl } = {}) {
    let s = fixed ? src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : perl ? src : posix(src, ere);
    if (word) s = `(?<![A-Za-z0-9_])(?:${s})(?![A-Za-z0-9_])`;
    if (line) s = `^(?:${s})$`;
    return new RegExp(s, (icase ? "i" : "") + (g ? "g" : ""));
  }

  /* ================================================================ grep */
  function grep(argv, ctx, mode) {
    const { f, pos } = opts(argv, "efABCmd", [
      "regexp",
      "file",
      "include",
      "exclude",
      "exclude-dir",
      "color",
      "colour",
      "max-count",
      "after-context",
      "before-context",
      "context",
      "label",
      "directories",
    ]);
    const o = out();
    const ere = mode === "E" || f.E || f["extended-regexp"];
    const fixed = mode === "F" || f.F || f["fixed-strings"];
    const perl = f.P || f["perl-regexp"];
    let pats = [];
    for (const a of argv.reduce(
      (acc, x, i) =>
        x === "-e" || x === "--regexp"
          ? acc.concat(argv[i + 1])
          : /^-e./.test(x)
            ? acc.concat(x.slice(2))
            : /^--regexp=/.test(x)
              ? acc.concat(x.slice(9))
              : acc,
      [],
    ))
      pats.push(a);
    if (f.f || f.file) {
      const t = ctx.vfs.read(ctx.resolve(f.f || f.file));
      if (t === undefined) {
        o.e(`grep: ${f.f || f.file}: No such file or directory`, 2);
        return o.r();
      }
      pats.push(...lines(t));
    }
    let files = pos.slice();
    if (!pats.length) {
      if (!files.length) {
        o.e("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.", 2);
        return o.r();
      }
      pats = lines(files.shift());
      if (!pats.length) pats = [""];
    }
    let re, reG;
    try {
      const src = pats
        .map((p) => (fixed ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : perl ? p : posix(p, ere)))
        .map((p) => `(?:${p})`)
        .join("|");
      const icase = f.i || f["ignore-case"] || f.y;
      re = mkRe(src, { perl: true, icase, word: f.w || f["word-regexp"], line: f.x || f["line-regexp"] });
      reG = new RegExp(re.source, re.flags + "g");
    } catch (e) {
      o.e(`grep: Invalid regular expression`, 2);
      return o.r();
    }
    const recursive = f.r || f.R || f.recursive || f["dereference-recursive"];
    const fs = ctx.vfs;
    if (recursive) {
      const roots = files.length ? files : ["."];
      files = [];
      const inc = f.include ? IG.bash.globRe(f.include) : null,
        exc = f.exclude ? IG.bash.globRe(f.exclude) : null,
        excd = f["exclude-dir"] ? IG.bash.globRe(f["exclude-dir"]) : null;
      for (const r of roots) {
        const p = ctx.resolve(r);
        if (fs.isFile(p)) {
          files.push(r);
          continue;
        }
        if (!fs.exists(p)) {
          files.push(r);
          continue;
        }
        for (const k of fs.walk(p)) {
          if (!fs.isFile(k)) continue;
          const rel = k.slice(p.length + 1);
          if (
            excd &&
            rel
              .split("/")
              .slice(0, -1)
              .some((d) => excd.test(d))
          )
            continue;
          const base = VFS.base(k);
          if (inc && !inc.test(base)) continue;
          if (exc && exc.test(base)) continue;
          files.push(
            (r === "." && !files.length && roots.length === 1 && !r.endsWith("/") ? "" : r.replace(/\/$/, "") + "/") +
              rel,
          );
        }
      }
      files = files.map((x) => (x.startsWith("/") || roots.some((r) => x.startsWith(r)) ? x : x));
    }
    const showName = !f.h && (f.H || files.length > 1 || recursive);
    const color =
      f.color === "always" ||
      f.colour === "always" ||
      ((f.color === "auto" || f.colour === "auto" || f.color === true) && tty(ctx));
    const C_ = {
      m: "\x1b[01;31m\x1b[K",
      f: "\x1b[35m\x1b[K",
      n: "\x1b[32m\x1b[K",
      s: "\x1b[36m\x1b[K",
      e: "\x1b[m\x1b[K",
    };
    const A = Number(f.A || f["after-context"] || f.C || f.context || 0),
      Bc = Number(f.B || f["before-context"] || f.C || f.context || 0);
    const max = f.m || f["max-count"] ? Number(f.m || f["max-count"]) : Infinity;
    const invert = f.v || f["invert-match"];
    let any = false,
      total = 0;
    const srcs = files.length ? files : ["-"];
    const name = (n) => (n === "-" ? "(standard input)" : n);
    for (const file of srcs) {
      let text;
      if (file === "-") text = ctx.stdin;
      else {
        const p = ctx.resolve(file);
        if (!fs.exists(p)) {
          if (!f.s) o.e(`grep: ${file}: No such file or directory`, 2);
          else o.code = 2;
          continue;
        }
        if (fs.isDir(p)) {
          if (!f.s && !recursive) o.e(`grep: ${file}: Is a directory`, 2);
          continue;
        }
        if (!ctx.shell.canRead(p)) {
          if (!f.s) o.e(`grep: ${file}: Permission denied`, 2);
          continue;
        }
        text = fs.read(p);
        if (/[\x00]|^\x7fELF|^\x1f\x8b/.test(text.slice(0, 16))) {
          if (re.test(text)) {
            o.o(`grep: ${file}: binary file matches\n`);
            any = true;
          }
          continue;
        }
      }
      const ls = lines(text);
      let count = 0,
        lastPrinted = -1,
        afterLeft = 0;
      const emit = (i, sep) => {
        if (lastPrinted >= 0 && i > lastPrinted + 1 && (A || Bc)) o.o(color ? C_.s + "--" + C_.e + "\n" : "--\n");
        let line = ls[i];
        if (f.o || f["only-matching"]) {
          if (sep !== ":") return;
          for (const m of line.matchAll(reG)) {
            if (!m[0]) continue;
            o.o(
              (showName ? (color ? C_.f + name(file) + C_.e + C_.s + ":" + C_.e : name(file) + ":") : "") +
                (f.n ? (color ? C_.n + (i + 1) + C_.e + C_.s + ":" + C_.e : `${i + 1}:`) : "") +
                (color ? C_.m + m[0] + C_.e : m[0]) +
                "\n",
            );
          }
          lastPrinted = i;
          return;
        }
        if (color && sep === ":" && !invert) line = line.replace(reG, (m) => (m ? C_.m + m + C_.e : m));
        const pre =
          (showName ? (color ? C_.f + name(file) + C_.e + C_.s + sep + C_.e : name(file) + sep) : "") +
          (f.n || f["line-number"] ? (color ? C_.n + (i + 1) + C_.e + C_.s + sep + C_.e : `${i + 1}${sep}`) : "");
        o.o(pre + line + "\n");
        lastPrinted = i;
      };
      for (let i = 0; i < ls.length; i++) {
        const hit = re.test(ls[i]) !== !!invert;
        if (hit && count < max) {
          count++;
          any = true;
          if (
            f.c ||
            f.count ||
            f.l ||
            f["files-with-matches"] ||
            f.L ||
            f["files-without-match"] ||
            f.q ||
            f.quiet ||
            f.silent
          )
            continue;
          for (let b = Math.max(lastPrinted + 1, i - Bc); b < i; b++) emit(b, "-");
          emit(i, ":");
          afterLeft = A;
        } else if (afterLeft > 0 && !(f.c || f.l || f.q)) {
          emit(i, "-");
          afterLeft--;
        }
        if (count >= max && afterLeft <= 0) break;
      }
      total += count;
      if (f.c || f.count) o.o((showName ? name(file) + ":" : "") + count + "\n");
      if ((f.l || f["files-with-matches"]) && count) o.o((color ? C_.f + name(file) + C_.e : name(file)) + "\n");
      if ((f.L || f["files-without-match"]) && !count) o.o(name(file) + "\n");
    }
    if (f.q || f.quiet || f.silent) return { stdout: "", stderr: o.se, code: any ? 0 : o.code === 2 ? 2 : 1 };
    const r = o.r();
    if (r.code !== 2) r.code = any ? 0 : 1;
    return r;
  }
  C.grep = (a, ctx) => grep(a, ctx, null);
  C.egrep = (a, ctx) => grep(a, ctx, "E");
  C.fgrep = (a, ctx) => grep(a, ctx, "F");
  C.zgrep = (a, ctx) => grep(a, ctx, null);

  /* ================================================================ sed */
  function parseSed(script, ere) {
    const cmds = [];
    let i = 0;
    const s = script;
    const ws = () => {
      while (i < s.length && /[ \t]/.test(s[i])) i++;
    };
    function readRe(delim) {
      let r = "";
      while (i < s.length && s[i] !== delim) {
        if (s[i] === "\\" && s[i + 1] === delim) {
          r += delim;
          i += 2;
          continue;
        }
        if (s[i] === "\\" && s[i + 1] === "n") {
          r += "\\n";
          i += 2;
          continue;
        }
        if (s[i] === "\\") {
          r += s[i] + s[i + 1];
          i += 2;
          continue;
        }
        r += s[i++];
      }
      if (s[i] !== delim) throw new Error(`unterminated address regex`);
      i++;
      return r;
    }
    function addr() {
      ws();
      if (s[i] === "$") {
        i++;
        return { last: true };
      }
      if (/\d/.test(s[i])) {
        let n = "";
        while (/\d/.test(s[i])) n += s[i++];
        if (s[i] === "~") {
          i++;
          let st = "";
          while (/\d/.test(s[i])) st += s[i++];
          return { first: Number(n), step: Number(st) };
        }
        return { line: Number(n) };
      }
      if (s[i] === "/" || s[i] === "\\") {
        const d = s[i] === "\\" ? s[++i] : "/";
        i++;
        const src = readRe(d);
        let flags = "";
        if (s[i] === "I") {
          flags = "i";
          i++;
        }
        return { re: src === "" ? null : new RegExp(posix(src, ere), flags) };
      }
      return null;
    }
    function text() {
      // a/i/c text
      ws();
      if (s[i] === "\\") {
        i++;
        if (s[i] === "\n") i++;
      }
      let t = "";
      while (i < s.length && s[i] !== "\n") {
        if (s[i] === "\\" && s[i + 1] === "\n") {
          t += "\n";
          i += 2;
          continue;
        }
        if (s[i] === "\\" && s[i + 1] === "n") {
          t += "\n";
          i += 2;
          continue;
        }
        t += s[i++];
      }
      return t.replace(/^\\/, "");
    }
    function block(end) {
      const list = [];
      for (;;) {
        while (i < s.length && /[\s;]/.test(s[i])) i++;
        if (i >= s.length) {
          if (end) throw new Error("unmatched `{'");
          return list;
        }
        if (s[i] === "}") {
          if (!end) throw new Error("unexpected `}'");
          i++;
          return list;
        }
        const c = { a1: addr(), a2: null, neg: false };
        if (c.a1) {
          ws();
          if (s[i] === ",") {
            i++;
            ws();
            if (s[i] === "+") {
              i++;
              let n = "";
              while (/\d/.test(s[i])) n += s[i++];
              c.a2 = { plus: Number(n) };
            } else c.a2 = addr();
          }
        }
        ws();
        if (s[i] === "!") {
          c.neg = true;
          i++;
          ws();
        }
        c.cmd = s[i++];
        switch (c.cmd) {
          case "{":
            c.body = block(true);
            break;
          case "s": {
            const d = s[i++];
            const src = readRe(d);
            let rep = "";
            while (i < s.length && s[i] !== d) {
              if (s[i] === "\\" && s[i + 1] === d) {
                rep += d;
                i += 2;
                continue;
              }
              if (s[i] === "\\") {
                rep += s[i] + s[i + 1];
                i += 2;
                continue;
              }
              rep += s[i++];
            }
            if (s[i] !== d) throw new Error("unterminated `s' command");
            i++;
            let fl = "";
            while (i < s.length && /[gpiIme0-9w]/.test(s[i])) {
              if (s[i] === "w") {
                i++;
                ws();
                let fn = "";
                while (i < s.length && s[i] !== "\n" && s[i] !== ";") fn += s[i++];
                c.wfile = fn.trim();
                break;
              }
              fl += s[i++];
            }
            c.re = new RegExp(posix(src, ere), (/[iI]/.test(fl) ? "i" : "") + "g");
            c.rep = rep;
            c.global = fl.includes("g");
            c.print = fl.includes("p");
            c.nth = Number((fl.match(/\d+/) || [0])[0]);
            c.emptyRe = src === "";
            break;
          }
          case "y": {
            const d = s[i++];
            const a = readRe(d);
            const b = readRe(d);
            c.from = a;
            c.to = b;
            if ([...a].length !== [...b].length) throw new Error("strings for `y' command are different lengths");
            break;
          }
          case "a":
          case "i":
          case "c":
            c.text = text();
            break;
          case "q":
          case "Q": {
            ws();
            let n = "";
            while (/\d/.test(s[i])) n += s[i++];
            c.code = Number(n || 0);
            break;
          }
          case "r":
          case "w": {
            ws();
            let fn = "";
            while (i < s.length && s[i] !== "\n") fn += s[i++];
            c.file = fn.trim();
            break;
          }
          case "d":
          case "D":
          case "p":
          case "P":
          case "n":
          case "N":
          case "=":
          case "h":
          case "H":
          case "g":
          case "G":
          case "x":
          case "l":
          case "z":
            break;
          case "b":
          case "t":
          case "T":
          case ":": {
            ws();
            let lb = "";
            while (i < s.length && !/[;\n}]/.test(s[i])) lb += s[i++];
            c.label = lb.trim();
            break;
          }
          default:
            throw new Error(`unknown command: \`${c.cmd}'`);
        }
        list.push(c);
      }
    }
    return block(false);
  }
  function runSed(cmds, text, opt, ctx) {
    const input = lines(text);
    const trailingNl = text.endsWith("\n");
    let out = "";
    let hold = "";
    let quit = null;
    const ranges = new Map();
    let lastRe = null;
    const matchAddr = (a, n, ps) => {
      if (!a) return true;
      if (a.last) return n === input.length;
      if (a.line !== undefined) return n === a.line;
      if (a.first !== undefined) return a.step ? n >= a.first && (n - a.first) % a.step === 0 : n === a.first;
      if ("re" in a) {
        const r = a.re || lastRe;
        if (a.re) lastRe = a.re;
        return !!r && r.test(ps);
      }
      return false;
    };
    const selected = (c, n, ps) => {
      let hit;
      if (!c.a1) hit = true;
      else if (!c.a2) hit = matchAddr(c.a1, n, ps);
      else {
        const st = ranges.get(c);
        if (st) {
          const end =
            c.a2.plus !== undefined
              ? n >= st.start + c.a2.plus
              : c.a2.line !== undefined
                ? n >= c.a2.line
                : matchAddr(c.a2, n, ps);
          if (end || (c.a2.line !== undefined && n > c.a2.line)) ranges.delete(c);
          hit = true;
          if (c.a2.line !== undefined && c.a2.line < st.start) {
            hit = n === st.start;
          }
        } else if (matchAddr(c.a1, n, ps)) {
          hit = true;
          const immediate = c.a2.line !== undefined && c.a2.line <= n;
          if (!immediate && !(c.a2.plus === 0)) ranges.set(c, { start: n });
        } else hit = false;
      }
      return c.neg ? !hit : hit;
    };
    let idx = 0;
    const subRep = (rep, m) =>
      rep.replace(/\\(\d)|&|\\n|\\t|\\&|\\\\|\\([LUEul])/g, (x, d) =>
        x === "&"
          ? m[0]
          : x === "\\&"
            ? "&"
            : x === "\\n"
              ? "\n"
              : x === "\\t"
                ? "\t"
                : x === "\\\\"
                  ? "\\"
                  : d !== undefined
                    ? (m[Number(d)] ?? "")
                    : "",
      );
    while (idx < input.length && quit === null) {
      let ps = input[idx++];
      let n = idx;
      let append = "";
      let deleted = false,
        subst = false;
      const exec = (list) => {
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          if (!selected(c, n, ps)) continue;
          switch (c.cmd) {
            case "{":
              if (exec(c.body) === "stop") return "stop";
              break;
            case "s": {
              const re = c.emptyRe && lastRe ? new RegExp(lastRe.source, lastRe.flags + "g") : c.re;
              if (!c.emptyRe) lastRe = c.re;
              let count = 0,
                did = false;
              ps = ps.replace(re, (...m) => {
                count++;
                const groups = m.slice(0, -2);
                if (
                  (c.nth && count === c.nth) ||
                  (!c.nth && (c.global || count === 1)) ||
                  (c.nth && c.global && count >= c.nth)
                ) {
                  did = true;
                  return subRep(c.rep, groups);
                }
                return m[0];
              });
              if (did) {
                subst = true;
                if (c.print) out += ps + "\n";
                if (c.wfile) ctx.vfs.write(ctx.resolve(c.wfile), ps + "\n", { append: true });
              }
              break;
            }
            case "y":
              ps = [...ps]
                .map((ch) => {
                  const i2 = [...c.from].indexOf(ch);
                  return i2 >= 0 ? [...c.to][i2] : ch;
                })
                .join("");
              break;
            case "d":
              deleted = true;
              return "stop";
            case "D": {
              const nlp = ps.indexOf("\n");
              if (nlp < 0) {
                deleted = true;
                return "stop";
              }
              ps = ps.slice(nlp + 1);
              input.splice(idx, 0, ps);
              deleted = true;
              return "stop";
            }
            case "p":
              out += ps + "\n";
              break;
            case "P":
              out += ps.split("\n")[0] + "\n";
              break;
            case "n":
              if (!opt.n) out += ps + "\n";
              if (idx >= input.length) {
                deleted = true;
                return "stop";
              }
              ps = input[idx++];
              n = idx;
              break;
            case "N":
              if (idx >= input.length) {
                return "stop";
              }
              ps += "\n" + input[idx++];
              n = idx;
              break;
            case "=":
              out += n + "\n";
              break;
            case "a":
              append += c.text + "\n";
              break;
            case "i":
              out += c.text + "\n";
              break;
            case "c":
              if (!c.a2 || !ranges.has(c)) out += c.text + "\n";
              deleted = true;
              return "stop";
            case "h":
              hold = ps;
              break;
            case "H":
              hold += "\n" + ps;
              break;
            case "g":
              ps = hold;
              break;
            case "G":
              ps += "\n" + hold;
              break;
            case "x": {
              const t = ps;
              ps = hold;
              hold = t;
              break;
            }
            case "l":
              out += ps.replace(/\\/g, "\\\\").replace(/\t/g, "\\t") + "$\n";
              break;
            case "z":
              ps = "";
              break;
            case "q":
              quit = c.code;
              return "stop";
            case "Q":
              quit = c.code;
              deleted = true;
              return "stop";
            case "r": {
              const t = ctx.vfs.read(ctx.resolve(c.file));
              if (t !== undefined) append += t.endsWith("\n") ? t : t + "\n";
              break;
            }
            case "w":
              ctx.vfs.write(ctx.resolve(c.file), ps + "\n", { append: true, mkdirs: false });
              break;
            case "b":
            case "t":
            case "T":
              if (c.cmd === "b" || (c.cmd === "t" && subst) || (c.cmd === "T" && !subst)) {
                if (!c.label) return "stop";
                const j = list.findIndex((x) => x.cmd === ":" && x.label === c.label);
                if (j >= 0) {
                  k = j;
                  subst = false;
                }
              }
              break;
            case ":":
              break;
          }
        }
        return null;
      };
      exec(cmds);
      if (!deleted && !opt.n) out += ps + (idx < input.length || trailingNl || quit !== null ? "\n" : "");
      out += append;
    }
    if (quit !== null && idx < input.length) {
      /* stop early */
    }
    return { out, quit };
  }
  C.sed = (argv, ctx) => {
    const o = out();
    const scripts = [];
    const files = [];
    let inplace = null,
      n = false,
      ere = false,
      sep = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-e" || a === "--expression") {
        scripts.push(argv[++i]);
        continue;
      }
      if (/^--expression=/.test(a)) {
        scripts.push(a.slice(13));
        continue;
      }
      if (a === "-f" || a === "--file") {
        const t = ctx.vfs.read(ctx.resolve(argv[++i]));
        if (t === undefined) {
          o.e(`sed: couldn't open file ${argv[i]}: No such file or directory`);
          return o.r();
        }
        scripts.push(t);
        continue;
      }
      if (/^-i/.test(a) || /^--in-place/.test(a)) {
        inplace = a.replace(/^-i|^--in-place=?/, "");
        continue;
      }
      if (a === "-n" || a === "--quiet" || a === "--silent") {
        n = true;
        continue;
      }
      if (a === "-E" || a === "-r" || a === "--regexp-extended") {
        ere = true;
        continue;
      }
      if (a === "-s" || a === "--separate" || a === "-u" || a === "-z" || a === "--posix") {
        sep = true;
        continue;
      }
      if (/^-[nErsu]+$/.test(a)) {
        if (a.includes("n")) n = true;
        if (/[Er]/.test(a)) ere = true;
        continue;
      }
      if (/^-[a-zA-Z]/.test(a) && a !== "-") {
        o.e(
          `sed: invalid option -- '${a[1]}'\nUsage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...`,
        );
        return o.r();
      }
      files.push(a);
    }
    void sep;
    if (!scripts.length) {
      if (!files.length) {
        o.e("Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...");
        return o.r();
      }
      scripts.push(files.shift());
    }
    let cmds;
    try {
      cmds = parseSed(scripts.join("\n"), ere);
    } catch (e) {
      o.e(`sed: -e expression #1, char ${scripts[0].length}: ${e.message}`);
      return o.r();
    }
    if (inplace !== null) {
      if (!files.length) {
        o.e("sed: no input files");
        return o.r();
      }
      for (const f of files) {
        const p = ctx.resolve(f);
        const t = ctx.vfs.read(p);
        if (t === undefined) {
          o.e(`sed: can't read ${f}: ${ctx.vfs.isDir(p) ? "Is a directory" : "No such file or directory"}`, 2);
          continue;
        }
        if (!ctx.shell.canRead(p)) {
          o.e(`sed: couldn't open file ${f}: Permission denied`, 4);
          continue;
        }
        if (!ctx.shell.canWrite(p) || !ctx.shell.canWrite(VFS.parent(p) + "/.sedtmp")) {
          o.e(
            `sed: couldn't open temporary file ${VFS.parent(p) === ctx.cwd ? "." : VFS.parent(p)}/sed${IG.util.hex(f, 6)}: Permission denied`,
            4,
          );
          continue;
        }
        if (inplace) ctx.vfs.write(p + inplace, t);
        const r = runSed(cmds, t, { n }, ctx);
        const node = ctx.vfs.node(p);
        node.content = r.out;
        node.size = undefined;
        node.mtime = ctx.world.now();
      }
      ctx.world.reconcile();
      return o.r();
    }
    const r = inputs(ctx, files, "sed");
    r.errs.forEach((e) =>
      o.e(e.replace(/^sed: (.*): No such file or directory$/, "sed: can't read $1: No such file or directory"), 2),
    );
    const res = runSed(cmds, r.texts.map((t) => t.text).join(""), { n }, ctx);
    o.o(res.out);
    if (res.quit) o.code = res.quit;
    return o.r();
  };

  /* ================================================================ awk */
  const AWK_KW = new Set([
    "BEGIN",
    "END",
    "function",
    "func",
    "if",
    "else",
    "while",
    "for",
    "do",
    "break",
    "continue",
    "next",
    "nextfile",
    "exit",
    "return",
    "delete",
    "in",
    "getline",
    "print",
    "printf",
  ]);
  const AWK_FN = new Set([
    "length",
    "substr",
    "index",
    "split",
    "sub",
    "gsub",
    "match",
    "sprintf",
    "tolower",
    "toupper",
    "int",
    "sqrt",
    "exp",
    "log",
    "sin",
    "cos",
    "atan2",
    "rand",
    "srand",
    "system",
    "systime",
    "strftime",
    "gensub",
    "close",
    "fflush",
  ]);
  function awkLex(src) {
    const toks = [];
    let i = 0;
    const regexAllowed = () => {
      const t = toks[toks.length - 1];
      if (!t) return true;
      if (t.t === "num" || t.t === "str" || t.t === "name" || t.t === "func" || t.t === "builtin") return false;
      return !(t.t === "p" && [")", "]", "$", "++", "--"].includes(t.v));
    };
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r") {
        i++;
        continue;
      }
      if (c === "\\" && src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (c === "#") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "\n") {
        toks.push({ t: "nl" });
        i++;
        continue;
      }
      if (c === '"') {
        let s = "";
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\") {
            const n = src[i + 1];
            s +=
              {
                "n": "\n",
                "t": "\t",
                "r": "\r",
                "\\": "\\",
                '"': '"',
                "/": "/",
                "a": "\x07",
                "b": "\b",
                "f": "\f",
                "v": "\v",
              }[n] ?? "\\" + n;
            i += 2;
            continue;
          }
          s += src[i++];
        }
        i++;
        toks.push({ t: "str", v: s });
        continue;
      }
      if (c === "/" && regexAllowed()) {
        let s = "";
        i++;
        while (i < src.length && src[i] !== "/") {
          if (src[i] === "\\" && src[i + 1] === "/") {
            s += "/";
            i += 2;
            continue;
          }
          if (src[i] === "\\") {
            s += src[i] + src[i + 1];
            i += 2;
            continue;
          }
          s += src[i++];
        }
        i++;
        toks.push({ t: "re", v: s });
        continue;
      }
      let m = src.slice(i).match(/^(0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/);
      if (m) {
        toks.push({ t: "num", v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      m = src.slice(i).match(/^[A-Za-z_]\w*/);
      if (m) {
        const w = m[0];
        i += w.length;
        if (AWK_KW.has(w)) toks.push({ t: "kw", v: w });
        else if (AWK_FN.has(w)) toks.push({ t: "builtin", v: w });
        else if (src[i] === "(") toks.push({ t: "func", v: w });
        else toks.push({ t: "name", v: w });
        continue;
      }
      const ops = [
        "**=",
        "^=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "==",
        "<=",
        ">=",
        "!=",
        "++",
        "--",
        "&&",
        "||",
        ">>",
        "!~",
        "**",
        "{",
        "}",
        "(",
        ")",
        "[",
        "]",
        ";",
        ",",
        "+",
        "-",
        "*",
        "/",
        "%",
        "^",
        "!",
        ">",
        "<",
        "|",
        "?",
        ":",
        "~",
        "$",
        "=",
      ];
      const op = ops.find((o) => src.startsWith(o, i));
      if (!op) throw new Error(`syntax error at source line 1: unexpected character '${c}'`);
      toks.push({ t: "p", v: op });
      i += op.length;
    }
    return toks;
  }
  function awkParse(src) {
    const T = awkLex(src);
    let p = 0;
    const peek = (o = 0) => T[p + o];
    const is = (t, v) => {
      const k = T[p];
      return k && k.t === t && (v === undefined || k.v === v);
    };
    const isP = (v) => is("p", v);
    const eat = (t, v) => {
      if (!is(t, v)) throw new Error(`syntax error at source line 1 near '${T[p] ? T[p].v || T[p].t : "end"}'`);
      return T[p++];
    };
    const nls = () => {
      while (is("nl") || isP(";")) p++;
    };
    const optNl = () => {
      while (is("nl")) p++;
    };
    const prog = { begin: [], end: [], rules: [], funcs: {} };
    nls();
    while (p < T.length) {
      if (is("kw", "BEGIN")) {
        p++;
        optNl();
        prog.begin.push(block());
      } else if (is("kw", "END")) {
        p++;
        optNl();
        prog.end.push(block());
      } else if (is("kw", "function") || is("kw", "func")) {
        p++;
        const name = T[p++].v;
        eat("p", "(");
        const params = [];
        while (!isP(")")) {
          params.push(eat("name").v);
          if (isP(",")) p++;
          optNl();
        }
        p++;
        optNl();
        prog.funcs[name] = { params, body: block() };
      } else {
        let pat = null,
          pat2 = null;
        if (!isP("{")) {
          pat = expr();
          if (isP(",")) {
            p++;
            optNl();
            pat2 = expr();
          }
        }
        const action = isP("{") ? block() : null;
        prog.rules.push({ pat, pat2, action });
      }
      nls();
    }
    return prog;

    function block() {
      eat("p", "{");
      const body = [];
      nls();
      while (!isP("}")) {
        body.push(stmt());
        nls();
      }
      p++;
      return { type: "block", body };
    }
    function simpleOrBlock() {
      optNl();
      if (isP("{")) return block();
      const s = stmt();
      return s;
    }
    function stmt() {
      if (isP("{")) return block();
      if (is("kw", "if")) {
        p++;
        eat("p", "(");
        const c = expr();
        eat("p", ")");
        const th = simpleOrBlock();
        let el = null;
        const save = p;
        nls();
        if (is("kw", "else")) {
          p++;
          el = simpleOrBlock();
        } else p = save;
        return { type: "if", c, th, el };
      }
      if (is("kw", "while")) {
        p++;
        eat("p", "(");
        const c = expr();
        eat("p", ")");
        if (isP(";")) {
          p++;
          return { type: "while", c, body: { type: "block", body: [] } };
        }
        return { type: "while", c, body: simpleOrBlock() };
      }
      if (is("kw", "do")) {
        p++;
        const body = simpleOrBlock();
        nls();
        eat("kw", "while");
        eat("p", "(");
        const c = expr();
        eat("p", ")");
        return { type: "do", c, body };
      }
      if (is("kw", "for")) {
        p++;
        eat("p", "(");
        if (is("name") && peek(1) && peek(1).t === "kw" && peek(1).v === "in") {
          const v = T[p].v;
          p += 2;
          const arr = T[p++].v;
          eat("p", ")");
          return { type: "forin", v, arr, body: simpleOrBlock() };
        }
        const init = isP(";") ? null : simpleStmt();
        eat("p", ";");
        optNl();
        const c = isP(";") ? null : expr();
        eat("p", ";");
        optNl();
        const step = isP(")") ? null : simpleStmt();
        eat("p", ")");
        if (isP(";")) {
          p++;
          return { type: "for", init, c, step, body: { type: "block", body: [] } };
        }
        return { type: "for", init, c, step, body: simpleOrBlock() };
      }
      if (isP(";")) {
        p++;
        return { type: "block", body: [] };
      }
      const s = simpleStmt();
      if (isP(";")) p++;
      return s;
    }
    function simpleStmt() {
      if (is("kw", "print") || is("kw", "printf")) {
        const kind = T[p++].v;
        let args = [];
        const paren =
          isP("(") &&
          (() => {
            let d = 0,
              q = p;
            for (; q < T.length; q++) {
              if (T[q].t === "p" && T[q].v === "(") d++;
              if (T[q].t === "p" && T[q].v === ")") {
                d--;
                if (!d) break;
              }
            }
            const after = T[q + 1];
            return !after || after.t === "nl" || (after.t === "p" && [";", "}", ">", ">>", "|"].includes(after.v));
          })();
        if (paren) {
          p++;
          while (!isP(")")) {
            args.push(expr(true));
            if (isP(",")) {
              p++;
              optNl();
            }
          }
          p++;
        } else if (!is("nl") && !isP(";") && !isP("}") && !isP(">") && !isP(">>") && !isP("|")) {
          args.push(expr(true));
          while (isP(",")) {
            p++;
            optNl();
            args.push(expr(true));
          }
        }
        let redir = null;
        if (isP(">") || isP(">>") || isP("|")) {
          const op = T[p++].v;
          redir = { op, target: concat(true) };
        }
        return { type: kind, args, redir };
      }
      if (is("kw", "next")) {
        p++;
        return { type: "next" };
      }
      if (is("kw", "nextfile")) {
        p++;
        return { type: "next" };
      }
      if (is("kw", "exit")) {
        p++;
        const e = is("nl") || isP(";") || isP("}") ? null : expr();
        return { type: "exit", e };
      }
      if (is("kw", "return")) {
        p++;
        const e = is("nl") || isP(";") || isP("}") ? null : expr();
        return { type: "return", e };
      }
      if (is("kw", "break")) {
        p++;
        return { type: "break" };
      }
      if (is("kw", "continue")) {
        p++;
        return { type: "continue" };
      }
      if (is("kw", "delete")) {
        p++;
        const name = eat("name").v;
        let idx = null;
        if (isP("[")) {
          p++;
          idx = exprList();
          eat("p", "]");
        }
        return { type: "delete", name, idx };
      }
      return { type: "expr", e: expr() };
    }
    function exprList() {
      const l = [expr()];
      while (isP(",")) {
        p++;
        l.push(expr());
      }
      return l;
    }
    function expr(noGt) {
      return ternary(noGt);
    }
    function ternary(noGt) {
      const c = or(noGt);
      if (isP("?")) {
        p++;
        optNl();
        const a = ternary(noGt);
        optNl();
        eat("p", ":");
        optNl();
        const b = ternary(noGt);
        return { op: "?:", c, a, b };
      }
      if (["=", "+=", "-=", "*=", "/=", "%=", "^=", "**="].some((o) => isP(o)) && c.lv) {
        const op = T[p++].v;
        const r = ternary(noGt);
        return { op: "assign", aop: op, lv: c, r };
      }
      return c;
    }
    function or(noGt) {
      let l = and(noGt);
      while (isP("||")) {
        p++;
        optNl();
        l = { op: "||", l, r: and(noGt) };
      }
      return l;
    }
    function and(noGt) {
      let l = inExpr(noGt);
      while (isP("&&")) {
        p++;
        optNl();
        l = { op: "&&", l, r: inExpr(noGt) };
      }
      return l;
    }
    function inExpr(noGt) {
      let l = match(noGt);
      while (is("kw", "in")) {
        p++;
        l = { op: "in", key: l, arr: eat("name").v };
      }
      return l;
    }
    function match(noGt) {
      let l = cmp(noGt);
      while (isP("~") || isP("!~")) {
        const op = T[p++].v;
        l = { op, l, r: cmp(noGt) };
      }
      return l;
    }
    function cmp(noGt) {
      let l = concat(noGt);
      while (["<", "<=", "==", "!=", ">=", ">"].some((o) => isP(o)) && !(noGt && isP(">"))) {
        const op = T[p++].v;
        l = { op, l, r: concat(noGt) };
      }
      return l;
    }
    function concat(noGt) {
      let l = additive();
      while (p < T.length && startsOperand() && !(noGt && isP(">"))) l = { op: "cat", l, r: additive() };
      return l;
    }
    function startsOperand() {
      const t = T[p];
      if (!t) return false;
      if (t.t === "num" || t.t === "str" || t.t === "name" || t.t === "func" || t.t === "builtin" || t.t === "re")
        return true;
      if (t.t === "p") return ["$", "!", "(", "-", "+", "++", "--"].includes(t.v) && !(t.v === "-" || t.v === "+");
      return false;
    }
    function additive() {
      let l = mult();
      while (isP("+") || isP("-")) {
        const op = T[p++].v;
        l = { op, l, r: mult() };
      }
      return l;
    }
    function mult() {
      let l = unary();
      while (isP("*") || isP("/") || isP("%")) {
        const op = T[p++].v;
        l = { op, l, r: unary() };
      }
      return l;
    }
    function unary() {
      if (isP("!")) {
        p++;
        return { op: "!", e: unary() };
      }
      if (isP("-")) {
        p++;
        return { op: "neg", e: unary() };
      }
      if (isP("+")) {
        p++;
        return { op: "pos", e: unary() };
      }
      return power();
    }
    function power() {
      const l = postfix();
      if (isP("^") || isP("**")) {
        p++;
        return { op: "^", l, r: unary() };
      }
      return l;
    }
    function postfix() {
      if (isP("++") || isP("--")) {
        const op = T[p++].v;
        const lv = postfix();
        return { op: "pre" + op, lv };
      }
      const e = primary();
      if ((isP("++") || isP("--")) && e.lv) {
        const op = T[p++].v;
        return { op: "post" + op, lv: e };
      }
      return e;
    }
    function primary() {
      const t = T[p];
      if (!t) throw new Error("syntax error: unexpected end of program");
      if (t.t === "num") {
        p++;
        return { op: "num", v: t.v };
      }
      if (t.t === "str") {
        p++;
        return { op: "str", v: t.v };
      }
      if (t.t === "re") {
        p++;
        return { op: "re", v: t.v };
      }
      if (isP("$")) {
        p++;
        const e = primary();
        return { op: "field", e, lv: true };
      }
      if (isP("(")) {
        p++;
        const e = expr();
        if (isP(",")) {
          const list = [e];
          while (isP(",")) {
            p++;
            list.push(expr());
          }
          eat("p", ")");
          if (is("kw", "in")) {
            p++;
            return { op: "in", key: { op: "multi", list }, arr: eat("name").v };
          }
          return list[0];
        }
        eat("p", ")");
        return { op: "group", e };
      }
      if (t.t === "kw" && t.v === "getline") {
        p++;
        let lv = null;
        if (is("name") || isP("$")) lv = primary();
        let file = null;
        if (isP("<")) {
          p++;
          file = primary();
        }
        return { op: "getline", lv, file };
      }
      if (t.t === "builtin") {
        p++;
        let args = [];
        if (isP("(")) {
          p++;
          optNl();
          while (!isP(")")) {
            args.push(expr());
            if (isP(",")) {
              p++;
              optNl();
            }
          }
          p++;
        }
        return { op: "call", name: t.v, args, builtin: true };
      }
      if (t.t === "func") {
        p++;
        eat("p", "(");
        const args = [];
        optNl();
        while (!isP(")")) {
          args.push(expr());
          if (isP(",")) {
            p++;
            optNl();
          }
        }
        p++;
        return { op: "call", name: t.v, args };
      }
      if (t.t === "name") {
        p++;
        if (isP("[")) {
          p++;
          const idx = exprList();
          eat("p", "]");
          return { op: "idx", name: t.v, idx, lv: true };
        }
        return { op: "var", name: t.v, lv: true };
      }
      throw new Error(`syntax error at source line 1 near '${t.v || t.t}'`);
    }
  }
  const isNum = (v) =>
    typeof v === "number" || (typeof v === "string" && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v));
  const toNum = (v) => {
    if (typeof v === "number") return v;
    const m = String(v).match(/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  };
  const toStr = (v, fmt = "%.6g") => {
    if (typeof v !== "number") return v === undefined ? "" : String(v);
    if (Number.isInteger(v)) return String(v);
    return IG.printfFmt(fmt, [String(v)]).out;
  };
  class AwkExit {
    constructor(code) {
      this.code = code;
    }
  }
  class AwkNext {}
  class AwkBreak {}
  class AwkCont {}
  class AwkRet {
    constructor(v) {
      this.v = v;
    }
  }
  function runAwk(prog, inputsList, vars, ctx) {
    const V = Object.assign(
      {
        FS: " ",
        OFS: " ",
        ORS: "\n",
        RS: "\n",
        NR: 0,
        NF: 0,
        FNR: 0,
        SUBSEP: "\x1c",
        RSTART: 0,
        RLENGTH: -1,
        FILENAME: "",
        CONVFMT: "%.6g",
        OFMT: "%.6g",
      },
      vars,
    );
    const A = { ENVIRON: Object.assign({}, ctx.env) };
    let fields = [""];
    let out = "",
      err = "";
    const files = {};
    let steps = 0;
    const setRecord = (rec) => {
      fields[0] = rec;
      splitFields();
    };
    const splitFields = () => {
      const rec = fields[0];
      let parts;
      const fs = toStr(V.FS);
      if (fs === " ") parts = rec.trim() ? rec.trim().split(/[ \t\n]+/) : [];
      else if (fs.length === 1 && fs !== "\\") parts = rec === "" ? [] : rec.split(fs);
      else parts = rec === "" ? [] : rec.split(new RegExp(posix(fs, true)));
      fields = [rec, ...parts];
      V.NF = parts.length;
    };
    const rebuild = () => {
      fields[0] = fields
        .slice(1, V.NF + 1)
        .map((x) => toStr(x ?? ""))
        .join(toStr(V.OFS));
    };
    const getField = (i) => {
      i = Math.floor(toNum(i));
      if (i < 0) throw new Error(`trying to access out of range field ${i}`);
      return i <= V.NF || i === 0 ? (fields[i] ?? "") : "";
    };
    const setField = (i, v) => {
      i = Math.floor(toNum(i));
      if (i === 0) {
        setRecord(toStr(v));
        return;
      }
      while (fields.length <= i) fields.push("");
      fields[i] = v;
      if (i > V.NF) V.NF = i;
      rebuild();
    };
    const key = (list) => list.map((e) => toStr(ev(e))).join(toStr(V.SUBSEP));
    const arr = (n) => (A[n] = A[n] || {});
    let locals = [];
    const lookup = (n) => {
      for (let i = locals.length - 1; i >= 0; i--) if (n in locals[i]) return locals[i];
      return null;
    };
    const getVar = (n) => {
      const l = lookup(n);
      if (l) return l[n];
      if (n === "NF") return V.NF;
      return V[n] ?? "";
    };
    const setVar = (n, v) => {
      const l = lookup(n);
      if (l) {
        l[n] = v;
        return;
      }
      V[n] = v;
      if (n === "NF") {
        V.NF = Math.floor(toNum(v));
        fields.length = V.NF + 1;
        rebuild();
      }
      if (n === "FS") {
        /* applies to next record */
      }
    };
    const truthy = (v) => (typeof v === "number" ? v !== 0 : isNum(v) && v !== "" ? toNum(v) !== 0 : v !== "");
    const regex = (e) => (e.op === "re" ? new RegExp(posix(e.v, true)) : new RegExp(posix(toStr(ev(e)), true)));
    const assignLv = (lv, v) => {
      if (lv.op === "var") {
        const l = lookup(lv.name);
        if (l && typeof l[lv.name] === "object") throw new Error("can't assign to array");
        setVar(lv.name, v);
      } else if (lv.op === "idx") {
        const l = lookup(lv.name);
        const a = l && typeof l[lv.name] === "object" ? l[lv.name] : arr(lv.name);
        a[key(lv.idx)] = v;
      } else if (lv.op === "field") setField(ev(lv.e), v);
      return v;
    };
    const getLv = (lv) =>
      lv.op === "var"
        ? getVar(lv.name)
        : lv.op === "idx"
          ? (() => {
              const l = lookup(lv.name);
              const a = l && typeof l[lv.name] === "object" ? l[lv.name] : arr(lv.name);
              const k = key(lv.idx);
              if (!(k in a)) a[k] = "";
              return a[k];
            })()
          : getField(ev(lv.e));
    function cmp(a, b) {
      if (isNum(a) && isNum(b) && !(typeof a === "string" && typeof b === "string" && a.trim() === ""))
        return toNum(a) - toNum(b);
      const x = toStr(a),
        y = toStr(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    function ev(e) {
      if (++steps > 2e6) throw new Error("execution limit exceeded");
      switch (e.op) {
        case "num":
          return e.v;
        case "str":
          return e.v;
        case "re":
          return new RegExp(posix(e.v, true)).test(fields[0]) ? 1 : 0;
        case "group":
          return ev(e.e);
        case "var": {
          const v = getVar(e.name);
          return typeof v === "object" ? "" : v;
        }
        case "idx":
          return getLv(e);
        case "field":
          return getField(ev(e.e));
        case "assign": {
          if (e.aop === "=") return assignLv(e.lv, ev(e.r));
          const cur = toNum(getLv(e.lv)),
            r = toNum(ev(e.r));
          const v = {
            "+=": cur + r,
            "-=": cur - r,
            "*=": cur * r,
            "/=": cur / r,
            "%=": cur % r,
            "^=": cur ** r,
            "**=": cur ** r,
          }[e.aop];
          return assignLv(e.lv, v);
        }
        case "pre++":
          return assignLv(e.lv, toNum(getLv(e.lv)) + 1);
        case "pre--":
          return assignLv(e.lv, toNum(getLv(e.lv)) - 1);
        case "post++": {
          const v = toNum(getLv(e.lv));
          assignLv(e.lv, v + 1);
          return v;
        }
        case "post--": {
          const v = toNum(getLv(e.lv));
          assignLv(e.lv, v - 1);
          return v;
        }
        case "?:":
          return truthy(ev(e.c)) ? ev(e.a) : ev(e.b);
        case "||":
          return truthy(ev(e.l)) || truthy(ev(e.r)) ? 1 : 0;
        case "&&":
          return truthy(ev(e.l)) && truthy(ev(e.r)) ? 1 : 0;
        case "!":
          return truthy(ev(e.e)) ? 0 : 1;
        case "neg":
          return -toNum(ev(e.e));
        case "pos":
          return toNum(ev(e.e));
        case "in": {
          const k = e.key.op === "multi" ? key(e.key.list) : toStr(ev(e.key));
          const l = lookup(e.arr);
          const a = l && typeof l[e.arr] === "object" ? l[e.arr] : arr(e.arr);
          return k in a ? 1 : 0;
        }
        case "~":
          return regex(e.r).test(toStr(ev(e.l))) ? 1 : 0;
        case "!~":
          return regex(e.r).test(toStr(ev(e.l))) ? 0 : 1;
        case "<":
          return cmp(ev(e.l), ev(e.r)) < 0 ? 1 : 0;
        case "<=":
          return cmp(ev(e.l), ev(e.r)) <= 0 ? 1 : 0;
        case ">":
          return cmp(ev(e.l), ev(e.r)) > 0 ? 1 : 0;
        case ">=":
          return cmp(ev(e.l), ev(e.r)) >= 0 ? 1 : 0;
        case "==":
          return cmp(ev(e.l), ev(e.r)) === 0 ? 1 : 0;
        case "!=":
          return cmp(ev(e.l), ev(e.r)) !== 0 ? 1 : 0;
        case "cat":
          return toStr(ev(e.l), V.CONVFMT) + toStr(ev(e.r), V.CONVFMT);
        case "+":
          return toNum(ev(e.l)) + toNum(ev(e.r));
        case "-":
          return toNum(ev(e.l)) - toNum(ev(e.r));
        case "*":
          return toNum(ev(e.l)) * toNum(ev(e.r));
        case "/": {
          const d = toNum(ev(e.r));
          if (!d) throw new Error("division by zero");
          return toNum(ev(e.l)) / d;
        }
        case "%": {
          const d = toNum(ev(e.r));
          if (!d) throw new Error("division by zero in %");
          return toNum(ev(e.l)) % d;
        }
        case "^":
          return toNum(ev(e.l)) ** toNum(ev(e.r));
        case "getline":
          return 0;
        case "call":
          return call(e);
        case "multi":
          return key(e.list);
      }
      throw new Error("unknown expression " + e.op);
    }
    function call(e) {
      const a = e.args;
      if (!e.builtin) {
        const f = prog.funcs[e.name];
        if (!f) throw new Error(`calling undefined function ${e.name}`);
        const frame = {};
        f.params.forEach((pn, i) => {
          if (a[i] && a[i].op === "var" && (typeof getVar(a[i].name) === "object" || A[a[i].name]))
            frame[pn] = lookup(a[i].name) ? lookup(a[i].name)[a[i].name] : arr(a[i].name);
          else frame[pn] = a[i] ? ev(a[i]) : "";
        });
        locals.push(frame);
        try {
          exec(f.body);
          return "";
        } catch (x) {
          if (x instanceof AwkRet) return x.v;
          throw x;
        } finally {
          locals.pop();
        }
      }
      const s = (i) => toStr(ev(a[i]));
      switch (e.name) {
        case "length":
          if (!a.length) return [...fields[0]].length;
          if (a[0].op === "var" && (A[a[0].name] || typeof getVar(a[0].name) === "object"))
            return Object.keys(A[a[0].name] || getVar(a[0].name)).length;
          return [...s(0)].length;
        case "substr": {
          const str = [...s(0)];
          let m = Math.round(toNum(ev(a[1])));
          let n = a[2] ? Math.round(toNum(ev(a[2]))) : Infinity;
          if (m < 1) {
            n += m - 1;
            m = 1;
          }
          return str.slice(m - 1, n === Infinity ? undefined : m - 1 + Math.max(0, n)).join("");
        }
        case "index":
          return s(0).indexOf(s(1)) + 1;
        case "split": {
          const str = s(0);
          const sep = a[2] ? (a[2].op === "re" ? new RegExp(posix(a[2].v, true)) : toStr(ev(a[2]))) : toStr(V.FS);
          const parts =
            str === ""
              ? []
              : sep === " "
                ? str.trim().split(/\s+/)
                : str.split(typeof sep === "string" && sep.length > 1 ? new RegExp(posix(sep, true)) : sep);
          const t = arr(a[1].name);
          for (const k of Object.keys(t)) delete t[k];
          parts.forEach((x, i) => {
            t[i + 1] = x;
          });
          return parts.length;
        }
        case "sub":
        case "gsub": {
          const re =
            a[0].op === "re"
              ? new RegExp(posix(a[0].v, true), e.name === "gsub" ? "g" : "")
              : new RegExp(posix(toStr(ev(a[0])), true), e.name === "gsub" ? "g" : "");
          const target = a[2] || { op: "field", e: { op: "num", v: 0 }, lv: true };
          const rep = s(1);
          let n = 0;
          const res = toStr(getLv(target)).replace(re, (m) => {
            n++;
            return rep.replace(/\\\\&|\\&|&/g, (x) => (x === "&" ? m : x === "\\&" ? "&" : "\\&"));
          });
          if (n) assignLv(target, res);
          return n;
        }
        case "match": {
          const re = a[1].op === "re" ? new RegExp(posix(a[1].v, true)) : new RegExp(posix(s(1), true));
          const m = s(0).match(re);
          V.RSTART = m ? m.index + 1 : 0;
          V.RLENGTH = m ? m[0].length : -1;
          if (m && a[2]) {
            const t = arr(a[2].name);
            m.forEach((g, i) => {
              t[i] = g ?? "";
            });
          }
          return V.RSTART;
        }
        case "sprintf":
          return IG.printfFmt(
            s(0),
            a.slice(1).map((x) => toStr(ev(x))),
          ).out;
        case "tolower":
          return s(0).toLowerCase();
        case "toupper":
          return s(0).toUpperCase();
        case "int":
          return Math.trunc(toNum(ev(a[0])));
        case "sqrt":
          return Math.sqrt(toNum(ev(a[0])));
        case "exp":
          return Math.exp(toNum(ev(a[0])));
        case "log":
          return Math.log(toNum(ev(a[0])));
        case "sin":
          return Math.sin(toNum(ev(a[0])));
        case "cos":
          return Math.cos(toNum(ev(a[0])));
        case "atan2":
          return Math.atan2(toNum(ev(a[0])), toNum(ev(a[1])));
        case "rand":
          return Math.random();
        case "srand":
          return 0;
        case "systime":
          return Math.floor(ctx.world.now() / 1000);
        case "strftime":
          return IG.strftime(a.length ? s(0) : "%c", a[1] ? toNum(ev(a[1])) * 1000 : ctx.world.now());
        case "system": {
          const r = ctx.shell.exec(
            s(0),
            ctx.pod || ctx.container ? (ctx.pod ? { pod: ctx.pod } : { container: ctx.container }) : null,
          );
          out += r.out ? r.out + "\n" : "";
          return r.code;
        }
        case "close":
        case "fflush":
          return 0;
        case "gensub": {
          const re = a[0].op === "re" ? a[0].v : s(0);
          const how = s(2);
          const g = /^[gG]/.test(how);
          const target = a[3] ? s(3) : fields[0];
          let n = 0;
          const which = g ? 0 : toNum(how) || 1;
          return target.replace(new RegExp(posix(re, true), "g"), (...m) => {
            n++;
            if (!g && n !== which) return m[0];
            return s(1).replace(/\\(\d)|&/g, (x, d) => (x === "&" ? m[0] : (m[Number(d)] ?? "")));
          });
        }
      }
      return "";
    }
    function emit(text, redir) {
      if (!redir) {
        out += text;
        return;
      }
      const target = toStr(ev(redir.target));
      if (redir.op === "|") {
        const r = ctx.shell.exec(`printf '%s' '${text.replace(/'/g, "'\\''")}' | ${target}`);
        out += r.out ? r.out + "\n" : "";
        return;
      }
      if (target === "/dev/stderr") {
        err += text;
        return;
      }
      if (target === "/dev/stdout" || target === "-") {
        out += text;
        return;
      }
      const p = ctx.resolve(target);
      if (!files[p] && redir.op === ">") ctx.vfs.write(p, "", { mkdirs: false });
      files[p] = true;
      ctx.vfs.write(p, text, { append: true });
    }
    function exec(s) {
      switch (s.type) {
        case "block":
          for (const x of s.body) exec(x);
          return;
        case "expr":
          ev(s.e);
          return;
        case "print": {
          const vals = s.args.length ? s.args.map((a) => toStr(ev(a), V.OFMT)) : [fields[0]];
          emit(vals.join(toStr(V.OFS)) + toStr(V.ORS), s.redir);
          return;
        }
        case "printf": {
          if (!s.args.length) return;
          const vals = s.args.map((a) => toStr(ev(a)));
          emit(IG.printfFmt(vals[0], vals.slice(1)).out, s.redir);
          return;
        }
        case "if":
          if (truthy(ev(s.c))) exec(s.th);
          else if (s.el) exec(s.el);
          return;
        case "while":
          while (truthy(ev(s.c))) {
            try {
              exec(s.body);
            } catch (x) {
              if (x instanceof AwkBreak) break;
              if (x instanceof AwkCont) continue;
              throw x;
            }
          }
          return;
        case "do":
          do {
            try {
              exec(s.body);
            } catch (x) {
              if (x instanceof AwkBreak) break;
              if (x instanceof AwkCont) continue;
              throw x;
            }
          } while (truthy(ev(s.c)));
          return;
        case "for":
          if (s.init) exec(s.init);
          while (!s.c || truthy(ev(s.c))) {
            try {
              exec(s.body);
            } catch (x) {
              if (x instanceof AwkBreak) break;
              if (!(x instanceof AwkCont)) throw x;
            }
            if (s.step) exec(s.step);
          }
          return;
        case "forin": {
          const l = lookup(s.arr);
          const a = l && typeof l[s.arr] === "object" ? l[s.arr] : arr(s.arr);
          for (const k of Object.keys(a)) {
            setVar(s.v, isNum(k) ? k : k);
            try {
              exec(s.body);
            } catch (x) {
              if (x instanceof AwkBreak) break;
              if (!(x instanceof AwkCont)) throw x;
            }
          }
          return;
        }
        case "delete": {
          const a = arr(s.name);
          if (s.idx) delete a[key(s.idx)];
          else for (const k of Object.keys(a)) delete a[k];
          return;
        }
        case "next":
          throw new AwkNext();
        case "exit":
          throw new AwkExit(s.e ? toNum(ev(s.e)) : 0);
        case "return":
          throw new AwkRet(s.e ? ev(s.e) : "");
        case "break":
          throw new AwkBreak();
        case "continue":
          throw new AwkCont();
      }
    }
    let code = 0;
    const ranges = new Map();
    try {
      for (const b of prog.begin) exec(b);
      if (prog.rules.length || prog.end.length) {
        for (const inp of inputsList) {
          if (inp.assign) {
            setVar(inp.assign[0], inp.assign[1]);
            continue;
          }
          V.FILENAME = inp.name === "-" ? "" : inp.name;
          V.FNR = 0;
          const recs =
            toStr(V.RS) === ""
              ? inp.text.split(/\n{2,}/).filter(Boolean)
              : toStr(V.RS) === "\n"
                ? lines(inp.text)
                : inp.text.split(toStr(V.RS));
          for (const rec of recs) {
            V.NR++;
            V.FNR++;
            setRecord(rec);
            try {
              for (const r of prog.rules) {
                let hit;
                if (!r.pat) hit = true;
                else if (r.pat2) {
                  if (ranges.get(r)) {
                    hit = true;
                    if (truthy(ev(r.pat2))) ranges.set(r, false);
                  } else if (truthy(ev(r.pat))) {
                    hit = true;
                    if (!truthy(ev(r.pat2))) ranges.set(r, true);
                  } else hit = false;
                } else hit = truthy(ev(r.pat));
                if (!hit) continue;
                if (r.action) exec(r.action);
                else out += fields[0] + toStr(V.ORS);
              }
            } catch (x) {
              if (!(x instanceof AwkNext)) throw x;
            }
          }
        }
      }
      for (const b of prog.end) exec(b);
    } catch (x) {
      if (x instanceof AwkExit) {
        code = x.code;
        try {
          if (!x.inEnd) for (const b of prog.end) exec(b);
        } catch (y) {
          if (y instanceof AwkExit) code = y.code;
        }
      } else throw x;
    }
    return { out, err, code };
  }
  C.awk = (argv, ctx) => {
    const o = out();
    const vars = {};
    let progSrc = null;
    const files = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-F") {
        vars.FS = unesc(argv[++i]);
        continue;
      }
      if (/^-F./.test(a)) {
        vars.FS = unesc(a.slice(2));
        continue;
      }
      if (a === "-v") {
        const kv = argv[++i];
        const k = kv.indexOf("=");
        vars[kv.slice(0, k)] = unesc(kv.slice(k + 1));
        continue;
      }
      if (/^-v./.test(a)) {
        const kv = a.slice(2);
        const k = kv.indexOf("=");
        vars[kv.slice(0, k)] = unesc(kv.slice(k + 1));
        continue;
      }
      if (a === "-f") {
        progSrc = ctx.vfs.read(ctx.resolve(argv[++i])) ?? "";
        continue;
      }
      if (a === "--") continue;
      if (progSrc === null) {
        progSrc = a;
        continue;
      }
      files.push(a);
    }
    if (progSrc === null) {
      o.e("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]", 2);
      return o.r();
    }
    let prog;
    try {
      prog = awkParse(progSrc);
    } catch (e) {
      o.e(`awk: cmd. line:1: ${progSrc.split("\n")[0]}\nawk: cmd. line:1: ${e.message}`, 2);
      return o.r();
    }
    const list = [];
    const real = files.filter((f) => !/^[A-Za-z_]\w*=/.test(f));
    if (!real.length && (prog.rules.length || prog.end.length)) list.push({ name: "-", text: ctx.stdin });
    for (const f of files) {
      if (/^[A-Za-z_]\w*=/.test(f)) {
        const k = f.indexOf("=");
        list.push({ assign: [f.slice(0, k), unesc(f.slice(k + 1))] });
        continue;
      }
      const r = inputs(ctx, [f], "awk");
      if (r.errs.length) {
        o.e(
          r.errs[0].replace(
            /^awk: (.*): No such file or directory$/,
            "awk: fatal: cannot open file `$1' for reading: No such file or directory",
          ),
          2,
        );
        return o.r();
      }
      list.push(r.texts[0]);
    }
    try {
      const r = runAwk(prog, list, vars, ctx);
      o.o(r.out);
      if (r.err) o.e(r.err, r.code);
      o.code = r.code;
    } catch (e) {
      o.e(`awk: cmd. line:1: fatal: ${e.message}`, 2);
    }
    return o.r();
  };
  C.gawk = C.awk;
  C.mawk = C.awk;
  function unesc(s) {
    return String(s).replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }

  /* ================================================================ sort / uniq / cut / paste / tr ... */
  function humanVal(s) {
    const m = String(s)
      .trim()
      .match(/^([\d.]+)([KMGTP]?)/i);
    if (!m) return 0;
    return parseFloat(m[1]) * 1024 ** " KMGTP".indexOf((m[2] || " ").toUpperCase());
  }
  C.sort = (argv, ctx) => {
    const { f, pos } = opts(argv, "ktoS", ["key", "field-separator", "output", "buffer-size"]);
    const o = out();
    const r = inputs(ctx, pos, "sort");
    if (r.errs.length) {
      r.errs.forEach((e) =>
        o.e(
          e.replace(/^sort: (.*): No such file or directory$/, "sort: cannot read: $1: No such file or directory"),
          2,
        ),
      );
      return o.r();
    }
    let ls = lines(r.texts.map((t) => t.text).join(""));
    const sep = f.t || f["field-separator"];
    const keys = [].concat(
      argv.reduce(
        (acc, x, i) =>
          x === "-k" || x === "--key"
            ? acc.concat(argv[i + 1])
            : /^-k./.test(x)
              ? acc.concat(x.slice(2))
              : /^--key=/.test(x)
                ? acc.concat(x.slice(6))
                : acc,
        [],
      ),
    );
    const fieldsOf = (l) => (sep ? l.split(sep) : l.trim().split(/\s+/));
    const extract = (l, spec) => {
      const m = spec.match(/^(\d+)(?:\.(\d+))?([bdfghinMrV]*)(?:,(\d+)(?:\.(\d+))?([bdfghinMrV]*))?$/);
      if (!m) return { v: l, flags: "" };
      const fs = fieldsOf(l);
      const a = Number(m[1]) - 1,
        b = m[4] ? Number(m[4]) - 1 : fs.length - 1;
      let v = fs.slice(a, b + 1).join(sep || " ");
      if (m[2]) v = v.slice(Number(m[2]) - 1);
      return { v, flags: (m[3] || "") + (m[6] || "") };
    };
    const cmpVal = (a, b, fl) => {
      const fold = fl.includes("f") || f.f;
      if (fl.includes("n") || f.n || f["numeric-sort"]) return (parseFloat(a) || 0) - (parseFloat(b) || 0);
      if (fl.includes("g") || f.g) return (Number(a) || 0) - (Number(b) || 0);
      if (fl.includes("h") || f.h || f["human-numeric-sort"]) return humanVal(a) - humanVal(b);
      if (fl.includes("V") || f.V || f["version-sort"]) return a.localeCompare(b, undefined, { numeric: true });
      if (fl.includes("M") || f.M) {
        const M = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        return M.indexOf(a.trim().slice(0, 3).toUpperCase()) - M.indexOf(b.trim().slice(0, 3).toUpperCase());
      }
      const x = fold ? a.toUpperCase() : a,
        y = fold ? b.toUpperCase() : b;
      if (f.b || fl.includes("b")) return x.trim() < y.trim() ? -1 : x.trim() > y.trim() ? 1 : 0;
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const cmp = (a, b) => {
      if (keys.length) {
        for (const k of keys) {
          const ka = extract(a, k),
            kb = extract(b, k);
          let c = cmpVal(ka.v, kb.v, ka.flags);
          if (ka.flags.includes("r")) c = -c;
          if (c) return c;
        }
        return f.s || f.stable ? 0 : a < b ? -1 : a > b ? 1 : 0;
      }
      const c = cmpVal(a, b, "");
      return c || (f.s ? 0 : a < b ? -1 : a > b ? 1 : 0);
    };
    if (f.c || f.check) {
      for (let i = 1; i < ls.length; i++)
        if (cmp(ls[i - 1], ls[i]) > 0) {
          o.e(`sort: -:${i + 1}: disorder: ${ls[i]}`);
          return o.r();
        }
      return o.r();
    }
    ls.sort(cmp);
    if (f.r || f.reverse) ls.reverse();
    if (f.u || f.unique) ls = ls.filter((l, i) => i === 0 || cmp(ls[i - 1], l) !== 0);
    if (f.R || f["random-sort"]) ls.sort(() => Math.random() - 0.5);
    const text = join(ls);
    if (f.o || f.output) {
      ctx.vfs.write(ctx.resolve(f.o || f.output), text);
      return o.r();
    }
    o.o(text);
    return o.r();
  };
  C.uniq = (argv, ctx) => {
    const { f, pos } = opts(argv, "fsw", ["skip-fields", "skip-chars", "check-chars"]);
    const o = out();
    const r = inputs(ctx, pos.slice(0, 1), "uniq");
    r.errs.forEach((e) => o.e(e));
    const keyOf = (l) => {
      let k = l;
      const sf = Number(f.f || f["skip-fields"] || 0);
      if (sf) k = k.replace(new RegExp(`^(\\s*\\S+){${sf}}`), "");
      const sc = Number(f.s || f["skip-chars"] || 0);
      k = k.slice(sc);
      if (f.w) k = k.slice(0, Number(f.w));
      return f.i || f["ignore-case"] ? k.toLowerCase() : k;
    };
    const groups = [];
    for (const l of lines(r.texts.map((t) => t.text).join(""))) {
      const g = groups[groups.length - 1];
      if (g && keyOf(g.l) === keyOf(l)) g.n++;
      else groups.push({ l, n: 1 });
    }
    const sel = groups.filter((g) => (f.d || f.repeated ? g.n > 1 : true) && (f.u || f.unique ? g.n === 1 : true));
    const text = join(sel.map((g) => (f.c || f.count ? String(g.n).padStart(7) + " " : "") + g.l));
    if (pos[1]) ctx.vfs.write(ctx.resolve(pos[1]), text);
    else o.o(text);
    return o.r();
  };
  function rangeList(spec) {
    return String(spec)
      .split(",")
      .map((s) => {
        const m = s.match(/^(\d*)(-?)(\d*)$/);
        if (!m) return null;
        const a = m[1] ? Number(m[1]) : 1;
        const b = m[2] ? (m[3] ? Number(m[3]) : Infinity) : a;
        return [a, b];
      });
  }
  C.cut = (argv, ctx) => {
    const { f, pos } = opts(argv, "dfcb", ["delimiter", "fields", "characters", "bytes", "output-delimiter"]);
    const o = out();
    const spec = f.f || f.fields || f.c || f.characters || f.b || f.bytes;
    if (!spec) {
      o.e("cut: you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.");
      return o.r();
    }
    const ranges = rangeList(spec);
    if (ranges.some((x) => !x)) {
      o.e(`cut: invalid field value ‘${spec}’`);
      return o.r();
    }
    const inR = (i) => {
      const hit = ranges.some(([a, b]) => i >= a && i <= b);
      return f.complement ? !hit : hit;
    };
    const d = f.d !== undefined ? f.d : f.delimiter !== undefined ? f.delimiter : "\t";
    if (d.length > 1) {
      o.e("cut: the delimiter must be a single character");
      return o.r();
    }
    const od = f["output-delimiter"] ?? d;
    const r = inputs(ctx, pos, "cut");
    r.errs.forEach((e) => o.e(e));
    for (const l of lines(r.texts.map((t) => t.text).join(""))) {
      if (f.f || f.fields) {
        if (!l.includes(d)) {
          if (!f.s) o.o(l + "\n");
          continue;
        }
        o.o(
          l
            .split(d)
            .filter((_, i) => inR(i + 1))
            .join(od) + "\n",
        );
      } else o.o([...l].filter((_, i) => inR(i + 1)).join("") + "\n");
    }
    return o.r();
  };
  C.paste = (argv, ctx) => {
    const { f, pos } = opts(argv, "d", ["delimiters"]);
    const o = out();
    const d = (f.d ?? f.delimiters ?? "\t").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    const r = inputs(ctx, pos, "paste");
    r.errs.forEach((e) => o.e(e));
    const cols = r.texts.map((t) => lines(t.text));
    if (f.s || f.serial) {
      cols.forEach((c) => o.o(c.map((x, i) => (i ? d[(i - 1) % d.length] : "") + x).join("") + "\n"));
      return o.r();
    }
    const n = Math.max(0, ...cols.map((c) => c.length));
    for (let i = 0; i < n; i++)
      o.o(cols.map((c, k) => (k ? d[(k - 1) % d.length] : "") + (c[i] ?? "")).join("") + "\n");
    return o.r();
  };
  function trSet(s) {
    const out2 = [];
    s = s.replace(
      /\[:(\w+):\]/g,
      (m, k) =>
        ({
          alpha: "a-zA-Z",
          digit: "0-9",
          alnum: "a-zA-Z0-9",
          upper: "A-Z",
          lower: "a-z",
          space: " \t\n\r\f\v",
          blank: " \t",
          punct: "!-/:-@[-`{-~",
          xdigit: "0-9A-Fa-f",
        })[k] || "",
    );
    s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
    const ch = [...s];
    for (let i = 0; i < ch.length; i++) {
      if (ch[i + 1] === "-" && ch[i + 2] !== undefined) {
        for (let c = ch[i].charCodeAt(0); c <= ch[i + 2].charCodeAt(0); c++) out2.push(String.fromCharCode(c));
        i += 2;
      } else out2.push(ch[i]);
    }
    return out2;
  }
  C.tr = (argv, ctx) => {
    const flags = argv.filter((a) => /^-[cdsCt]+$/.test(a)).join("");
    const sets = argv.filter((a) => !/^-[cdsCt]+$/.test(a));
    const o = out();
    if (!sets.length) {
      o.e("tr: missing operand\nTry 'tr --help' for more information.");
      return o.r();
    }
    const text = ctx.stdin;
    let s1 = trSet(sets[0]);
    const s2 = sets[1] !== undefined ? trSet(sets[1]) : [];
    const comp = /[cC]/.test(flags);
    const inS1 = (c) => (comp ? !s1.includes(c) : s1.includes(c));
    let res = "";
    if (flags.includes("d")) {
      for (const c of text) if (!inS1(c)) res += c;
    } else if (s2.length) {
      for (const c of text) {
        if (inS1(c)) {
          const i = comp ? s2.length - 1 : s1.indexOf(c);
          res += s2[Math.min(i, s2.length - 1)];
        } else res += c;
      }
    } else res = text;
    if (flags.includes("s")) {
      const sq = s2.length && !flags.includes("d") ? s2 : flags.includes("d") ? s2 : s1;
      let prev = null,
        r2 = "";
      for (const c of res) {
        if (c === prev && sq.includes(c)) continue;
        r2 += c;
        prev = c;
      }
      res = r2;
    }
    o.o(res);
    return o.r();
  };
  C.rev = (argv, ctx) => {
    const r = inputs(ctx, argv, "rev");
    return join(lines(r.texts.map((t) => t.text).join("")).map((l) => [...l].reverse().join("")));
  };
  C.nl = (argv, ctx) => {
    const { f, pos } = opts(argv, "bwsv");
    const r = inputs(ctx, pos, "nl");
    let n = Number(f.v || 1) - 1;
    const all = f.b === "a";
    const w = Number(f.w || 6),
      sep = f.s ?? "\t";
    return join(
      lines(r.texts.map((t) => t.text).join("")).map((l) =>
        (l || all ? String(++n).padStart(w) + sep + l : " ".repeat(w + sep.length) + l).replace(/\s+$/, (m) =>
          l ? m : "",
        ),
      ),
    );
  };
  C.column = (argv, ctx) => {
    const { f, pos } = opts(argv, "soNc", ["separator", "output-separator", "table-columns"]);
    const r = inputs(ctx, pos, "column");
    const ls = lines(r.texts.map((t) => t.text).join(""));
    if (f.t || f.table) {
      const sep = f.s || f.separator;
      const rows = ls
        .filter((l) => l.trim())
        .map((l) => (sep ? l.split(new RegExp(`[${sep.replace(/[\]\\^-]/g, "\\$&")}]+`)) : l.trim().split(/\s+/)));
      if (f.N || f["table-columns"]) rows.unshift(String(f.N || f["table-columns"]).split(","));
      const w = [];
      rows.forEach((rw) =>
        rw.forEach((c, i) => {
          w[i] = Math.max(w[i] || 0, [...c].length);
        }),
      );
      const osep = f.o || f["output-separator"] || "  ";
      return join(
        rows.map((rw) =>
          rw
            .map((c, i) => (i === rw.length - 1 ? c : c + " ".repeat(w[i] - [...c].length)))
            .join(osep)
            .replace(/\s+$/, ""),
        ),
      );
    }
    return join(ls);
  };
  C.fold = (argv, ctx) => {
    const { f, pos } = opts(argv, "w", ["width"]);
    const w = Number(f.w || f.width || 80);
    const r = inputs(ctx, pos, "fold");
    const res = [];
    for (const l of lines(r.texts.map((t) => t.text).join(""))) {
      let rest = l;
      while ([...rest].length > w) {
        let cut = w;
        if (f.s) {
          const sp = rest.lastIndexOf(" ", w - 1);
          if (sp > 0) cut = sp + 1;
        }
        res.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      res.push(rest);
    }
    return join(res);
  };
  C.expand = (argv, ctx) => {
    const r = inputs(
      ctx,
      argv.filter((a) => !a.startsWith("-")),
      "expand",
    );
    return r.texts.map((t) => t.text.replace(/\t/g, "        ")).join("");
  };
  C.comm = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    if (pos.length < 2) {
      o.e("comm: missing operand\nTry 'comm --help' for more information.");
      return o.r();
    }
    const r = inputs(ctx, pos, "comm");
    if (r.errs.length) {
      r.errs.forEach((e) => o.e(e));
      return o.r();
    }
    const [a, b] = r.texts.map((t) => lines(t.text));
    let i = 0,
      j = 0;
    const col = (n, s) => {
      if (f[String(n)]) return;
      const pad = [1, 2].filter((k) => k < n && !f[String(k)]).length;
      o.o("\t".repeat(pad) + s + "\n");
    };
    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && a[i] < b[j])) col(1, a[i++]);
      else if (i >= a.length || b[j] < a[i]) col(2, b[j++]);
      else {
        col(3, a[i]);
        i++;
        j++;
      }
    }
    return o.r();
  };
  C.shuf = (argv, ctx) => {
    const { f, pos } = opts(argv, "niI", ["input-range", "head-count"]);
    let ls;
    if (f.i || f["input-range"]) {
      const [a, b] = String(f.i || f["input-range"])
        .split("-")
        .map(Number);
      ls = [];
      for (let k = a; k <= b; k++) ls.push(String(k));
    } else if (f.e) ls = pos;
    else
      ls = lines(
        inputs(ctx, pos, "shuf")
          .texts.map((t) => t.text)
          .join(""),
      );
    ls = ls.slice().sort(() => Math.random() - 0.5);
    const n = f.n || f["head-count"];
    return join(n ? ls.slice(0, Number(n)) : ls);
  };

  /* ================================================================ diff / cmp */
  function lcs(a, b) {
    const n = a.length,
      m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ t: "=", a: i, b: j });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) {
        ops.push({ t: "+", b: j });
        j++;
      } else {
        ops.push({ t: "-", a: i });
        i++;
      }
    }
    return ops;
  }
  C.diff = (argv, ctx) => {
    const { f, pos } = opts(argv, "U", ["unified"]);
    const o = out();
    if (pos.length !== 2) {
      o.e(`diff: missing operand after '${pos[0] || "diff"}'\ndiff: Try 'diff --help' for more information.`, 2);
      return o.r();
    }
    const fs = ctx.vfs;
    const r = inputs(
      ctx,
      pos.map((p) =>
        fs.isDir(ctx.resolve(p)) && !fs.isDir(ctx.resolve(pos[0] === p ? pos[1] : pos[0]))
          ? p.replace(/\/$/, "") + "/" + VFS.base(ctx.resolve(pos[0] === p ? pos[1] : pos[0]))
          : p,
      ),
      "diff",
    );
    if (r.errs.length) {
      r.errs.forEach((e) => o.e(e, 2));
      return o.r();
    }
    let [A, Bt] = r.texts.map((t) => t.text);
    const norm = (s) => {
      let x = s;
      if (f.w || f["ignore-all-space"]) x = x.replace(/\s+/g, "");
      else if (f.b) x = x.replace(/\s+/g, " ").trim();
      if (f.i) x = x.toLowerCase();
      return x;
    };
    const a = lines(A),
      b = lines(Bt);
    const ops = lcs(a.map(norm), b.map(norm));
    if (!ops.some((x) => x.t !== "=")) return o.r();
    o.code = 1;
    if (f.q || f.brief) {
      o.o(`Files ${pos[0]} and ${pos[1]} differ\n`);
      return o.r();
    }
    const ctxN = f.u || f.U || f.unified ? Number(f.U || f.unified || 3) || 3 : null;
    if (ctxN !== null) {
      const t = (n) => new Date(n.mtime).toISOString().replace("T", " ").replace("Z", "000000 +0000");
      const na = fs.node(ctx.resolve(pos[0])),
        nb = fs.node(ctx.resolve(pos[1]));
      o.o(`--- ${pos[0]}\t${na ? t(na) : ""}\n+++ ${pos[1]}\t${nb ? t(nb) : ""}\n`);
      const changes = ops.map((x, k) => (x.t !== "=" ? k : -1)).filter((k) => k >= 0);
      let k = 0;
      while (k < changes.length) {
        let start = Math.max(0, changes[k] - ctxN),
          end = Math.min(ops.length - 1, changes[k] + ctxN);
        while (k + 1 < changes.length && changes[k + 1] - ctxN <= end + 1) {
          k++;
          end = Math.min(ops.length - 1, changes[k] + ctxN);
        }
        const hunk = ops.slice(start, end + 1);
        const aStart = (hunk.find((x) => x.a !== undefined) || { a: 0 }).a,
          bStart = (hunk.find((x) => x.b !== undefined) || { b: 0 }).b;
        const aLen = hunk.filter((x) => x.t !== "+").length,
          bLen = hunk.filter((x) => x.t !== "-").length;
        o.o(
          `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n`
            .replace(/,1 /g, " ")
            .replace(/,1 @@/, " @@"),
        );
        for (const x of hunk)
          o.o(x.t === "=" ? " " + a[x.a] + "\n" : x.t === "-" ? "-" + a[x.a] + "\n" : "+" + b[x.b] + "\n");
        k++;
      }
      return o.r();
    }
    // normal format
    let k = 0;
    while (k < ops.length) {
      if (ops[k].t === "=") {
        k++;
        continue;
      }
      const dels = [],
        adds = [];
      while (k < ops.length && ops[k].t !== "=") {
        if (ops[k].t === "-") dels.push(ops[k].a);
        else adds.push(ops[k].b);
        k++;
      }
      const prevA = (
        ops
          .slice(0, k)
          .reverse()
          .find((x) => x.a !== undefined && x.t === "=") || { a: -1 }
      ).a;
      const prevB = (
        ops
          .slice(0, k)
          .reverse()
          .find((x) => x.b !== undefined && x.t === "=") || { b: -1 }
      ).b;
      const rng = (arr, prev) =>
        arr.length ? (arr.length > 1 ? `${arr[0] + 1},${arr[arr.length - 1] + 1}` : `${arr[0] + 1}`) : `${prev + 1}`;
      const cmd = dels.length && adds.length ? "c" : dels.length ? "d" : "a";
      o.o(`${rng(dels, prevA)}${cmd}${rng(adds, prevB)}\n`);
      dels.forEach((i) => o.o("< " + a[i] + "\n"));
      if (dels.length && adds.length) o.o("---\n");
      adds.forEach((i) => o.o("> " + b[i] + "\n"));
    }
    return o.r();
  };
  C.cmp = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const r = inputs(ctx, pos, "cmp");
    if (r.errs.length) return { stdout: "", stderr: r.errs.join("\n") + "\n", code: 2 };
    const [a, b] = r.texts.map((t) => t.text);
    if (a === b) return "";
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const line = a.slice(0, i).split("\n").length;
    if (f.s) return { stdout: "", stderr: "", code: 1 };
    if (i >= a.length || i >= b.length)
      return {
        stdout: "",
        stderr: `cmp: EOF on ${i >= a.length ? pos[0] : pos[1]} after byte ${i}, line ${line - 1}\n`,
        code: 1,
      };
    return { stdout: `${pos[0]} ${pos[1]} differ: byte ${i + 1}, line ${line}\n`, stderr: "", code: 1 };
  };

  /* ================================================================ expr / bc */
  C.expr = (argv) => {
    const a = argv.slice();
    let i = 0;
    const isInt = (v) => /^-?\d+$/.test(String(v));
    function prim() {
      const t = a[i++];
      if (t === "(") {
        const v = or();
        i++;
        return v;
      }
      if (t === "length") return String(prim()).length;
      if (t === "substr") {
        const s = String(prim()),
          p = Number(prim()),
          l = Number(prim());
        return s.substr(p - 1, l);
      }
      if (t === "index") {
        const s = String(prim()),
          c = String(prim());
        let best = 0;
        for (const ch of c) {
          const k = s.indexOf(ch) + 1;
          if (k && (!best || k < best)) best = k;
        }
        return best;
      }
      if (t === "match") {
        const s = String(prim()),
          re = String(prim());
        const m = s.match(new RegExp("^" + posix(re, false)));
        return m ? (m[1] !== undefined ? m[1] : m[0].length) : 0;
      }
      return t;
    }
    function mul() {
      let l = prim();
      while (["*", "/", "%"].includes(a[i])) {
        const op = a[i++];
        const r = prim();
        if (!isInt(l) || !isInt(r)) throw new Error("non-integer argument");
        if (op !== "*" && Number(r) === 0) throw new Error("division by zero");
        l = op === "*" ? l * r : op === "/" ? Math.trunc(l / r) : l % r;
      }
      return l;
    }
    function add() {
      let l = mul();
      while (["+", "-"].includes(a[i])) {
        const op = a[i++];
        const r = mul();
        if (!isInt(l) || !isInt(r)) throw new Error("non-integer argument");
        l = op === "+" ? Number(l) + Number(r) : Number(l) - Number(r);
      }
      return l;
    }
    function rel() {
      let l = add();
      while (["<", "<=", "=", "==", "!=", ">=", ">"].includes(a[i])) {
        const op = a[i++];
        const r = add();
        const bothInt = isInt(l) && isInt(r);
        const x = bothInt ? Number(l) : String(l),
          y = bothInt ? Number(r) : String(r);
        l = { "<": x < y, "<=": x <= y, "=": x === y, "==": x === y, "!=": x !== y, ">=": x >= y, ">": x > y }[op]
          ? 1
          : 0;
      }
      return l;
    }
    function match() {
      let l = rel();
      while (a[i] === ":") {
        i++;
        const re = String(rel());
        const m = String(l).match(new RegExp("^" + posix(re, false)));
        l = m ? (m[1] !== undefined ? m[1] : m[0].length) : 0;
      }
      return l;
    }
    function and() {
      let l = match();
      while (a[i] === "&") {
        i++;
        const r = match();
        l = l !== "" && l !== 0 && l !== "0" && r !== "" && r !== 0 && r !== "0" ? l : 0;
      }
      return l;
    }
    function or() {
      let l = and();
      while (a[i] === "|") {
        i++;
        const r = and();
        l = l !== "" && l !== 0 && l !== "0" ? l : r;
      }
      return l;
    }
    try {
      if (!a.length)
        return { stdout: "", stderr: "expr: missing operand\nTry 'expr --help' for more information.\n", code: 2 };
      const v = or();
      if (i < a.length) return { stdout: "", stderr: `expr: syntax error: unexpected argument ‘${a[i]}’\n`, code: 2 };
      return { stdout: v + "\n", stderr: "", code: v === 0 || v === "" || v === "0" ? 1 : 0 };
    } catch (e) {
      return { stdout: "", stderr: `expr: ${e.message}\n`, code: 2 };
    }
  };
  C.bc = (argv, ctx) => {
    const mathlib = argv.includes("-l");
    const src = argv.filter((a) => !a.startsWith("-")).length
      ? inputs(
          ctx,
          argv.filter((a) => !a.startsWith("-")),
          "bc",
        )
          .texts.map((t) => t.text)
          .join("\n")
      : ctx.stdin;
    let scale = mathlib ? 20 : 0;
    const vars = {};
    const res = [];
    for (let stmt of src.split(/[;\n]/)) {
      stmt = stmt.trim();
      if (!stmt || stmt === "quit") continue;
      let m;
      if ((m = stmt.match(/^scale\s*=\s*(\d+)$/))) {
        scale = Number(m[1]);
        continue;
      }
      if ((m = stmt.match(/^([a-z]\w*)\s*=\s*(.+)$/))) {
        vars[m[1]] = calc(m[2]);
        continue;
      }
      const v = calc(stmt);
      if (v === null)
        return {
          stdout: res.join("\n") + (res.length ? "\n" : ""),
          stderr: "(standard_in) 1: syntax error\n",
          code: 1,
        };
      res.push(v);
    }
    return join(res);
    function calc(e) {
      const ex = e
        .replace(/\bscale\b/g, String(scale))
        .replace(/\b([a-z]\w*)\b(?!\()/g, (x, k) =>
          k in vars ? vars[k] : ["s", "c", "a", "l", "e", "sqrt", "length"].includes(k) ? k : "0",
        )
        .replace(/\^/g, "**")
        .replace(/\bsqrt\(/g, "Math.sqrt(")
        .replace(/\bs\(/g, "Math.sin(")
        .replace(/\bc\(/g, "Math.cos(")
        .replace(/\ba\(/g, "Math.atan(")
        .replace(/\bl\(/g, "Math.log(")
        .replace(/\be\(/g, "Math.exp(");
      if (!/^[\d\s+\-*/%().,]*(Math\.\w+\([\d\s+\-*/%().,]*\)[\d\s+\-*/%().,]*)*$/.test(ex)) return null;
      let v;
      try {
        v = Function('"use strict";return (' + ex + ")")();
      } catch (er) {
        return null;
      }
      if (typeof v !== "number" || !isFinite(v)) return null;
      if (scale === 0) return String(Math.trunc(v));
      const s = v.toFixed(scale);
      return s.replace(/^0\./, ".").replace(/^-0\./, "-.");
    }
  };

  /* ================================================================ jq (practical subset) */
  function jqEval(filter, input) {
    // supports: . .a .a.b .[n] .[] .a[] | , select() map() keys length type to_entries from_entries
    // has() del() sort_by() group_by() unique min max add first last @csv @tsv tostring tonumber
    // ascii_downcase ascii_upcase join() split() test() contains() {a: .b} [ ... ] "\(.x)" == != and or not
    let s = filter.trim(),
      i = 0;
    const ws = () => {
      while (/\s/.test(s[i] || "")) i++;
    };
    function pipe() {
      let l = comma();
      ws();
      while (s[i] === "|" && s[i + 1] !== "|") {
        i++;
        const r = comma();
        const L = l;
        l = (v) => L(v).flatMap((x) => r(x));
        ws();
      }
      return l;
    }
    function comma() {
      const parts = [alt()];
      ws();
      while (s[i] === ",") {
        i++;
        parts.push(alt());
        ws();
      }
      return (v) => parts.flatMap((p) => p(v));
    }
    function alt() {
      let l = orE();
      ws();
      while (s.startsWith("//", i)) {
        i += 2;
        const r = orE();
        const L = l;
        l = (v) => {
          const a = L(v).filter((x) => x !== null && x !== false);
          return a.length ? a : r(v);
        };
        ws();
      }
      return l;
    }
    function orE() {
      let l = andE();
      ws();
      while (s.startsWith("or", i) && !/\w/.test(s[i + 2] || "")) {
        i += 2;
        const r = andE();
        const L = l;
        l = (v) => [truthy(L(v)[0]) || truthy(r(v)[0])];
        ws();
      }
      return l;
    }
    function andE() {
      let l = cmpE();
      ws();
      while (s.startsWith("and", i) && !/\w/.test(s[i + 3] || "")) {
        i += 3;
        const r = cmpE();
        const L = l;
        l = (v) => [truthy(L(v)[0]) && truthy(r(v)[0])];
        ws();
      }
      return l;
    }
    const truthy = (v) => v !== null && v !== false && v !== undefined;
    function cmpE() {
      const l = addE();
      ws();
      const m = s.slice(i).match(/^(==|!=|<=|>=|<|>)/);
      if (!m) return l;
      i += m[0].length;
      const r = addE();
      return (v) => {
        const a = l(v)[0],
          b = r(v)[0];
        const A = JSON.stringify(a),
          Bq = JSON.stringify(b);
        return [{ "==": A === Bq, "!=": A !== Bq, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b }[m[0]]];
      };
    }
    function addE() {
      let l = postfix();
      ws();
      while (/[+\-*/%]/.test(s[i] || "") && !(s[i] === "-" && /[a-z]/.test(s[i + 1] || ""))) {
        const op = s[i++];
        const r = postfix();
        const L = l;
        l = (v) => {
          const a = L(v)[0],
            b = r(v)[0];
          if (op === "+") {
            if (a === null) return [b];
            if (Array.isArray(a)) return [a.concat(b)];
            if (typeof a === "object") return [Object.assign({}, a, b)];
            return [a + b];
          }
          if (op === "-")
            return [
              Array.isArray(a) ? a.filter((x) => !b.some((y) => JSON.stringify(y) === JSON.stringify(x))) : a - b,
            ];
          return [op === "*" ? a * b : op === "/" ? (typeof a === "string" ? a.split(b) : a / b) : a % b];
        };
        ws();
      }
      return l;
    }
    function postfix() {
      let l = term();
      ws();
      for (;;) {
        ws();
        if (s[i] === "." && /[A-Za-z_"[]/.test(s[i + 1] || "")) {
          i++;
          const k = s[i] === '"' ? strLit() : s[i] === "[" ? null : ident();
          if (k === null) continue;
          const L = l;
          l = (v) => L(v).map((x) => (x == null ? null : (x[k] ?? null)));
          continue;
        }
        if (s[i] === "[") {
          i++;
          ws();
          if (s[i] === "]") {
            i++;
            const L = l;
            l = (v) => L(v).flatMap((x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []));
            continue;
          }
          const idx = pipe();
          ws();
          if (s[i] === ":") {
            i++;
            const end = pipe();
            ws();
            i++;
            const L = l;
            l = (v) => L(v).map((x) => x.slice(idx(v)[0] ?? 0, end(v)[0] ?? undefined));
            continue;
          }
          i++;
          const L = l;
          l = (v) =>
            L(v).map((x) => {
              const k = idx(v)[0];
              if (x == null) return null;
              if (typeof k === "number" && Array.isArray(x)) return x[k < 0 ? x.length + k : k] ?? null;
              return x[k] ?? null;
            });
          continue;
        }
        if (s[i] === "?") {
          i++;
          continue;
        }
        break;
      }
      return l;
    }
    function ident() {
      const m = s.slice(i).match(/^[A-Za-z_][\w]*/);
      i += m[0].length;
      return m[0];
    }
    function strLit() {
      i++;
      let parts = [],
        cur = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && s[i + 1] === "(") {
          i += 2;
          if (cur) parts.push(cur);
          cur = "";
          const e = pipe();
          ws();
          i++;
          parts.push(e);
          continue;
        }
        if (s[i] === "\\") {
          const n = s[i + 1];
          cur += { "n": "\n", "t": "\t", '"': '"', "\\": "\\" }[n] ?? n;
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      i++;
      if (cur) parts.push(cur);
      if (parts.every((p) => typeof p === "string")) return parts.join("");
      return { interp: parts };
    }
    function term() {
      ws();
      const c = s[i];
      if (s.startsWith("..", i)) {
        i += 2;
        return (v) => {
          const res = [];
          const walk = (x) => {
            res.push(x);
            if (x && typeof x === "object") Object.values(x).forEach(walk);
          };
          walk(v);
          return res;
        };
      }
      if (c === ".") {
        i++;
        if (/[A-Za-z_]/.test(s[i] || "")) {
          const k = ident();
          return (v) => [v == null ? null : (v[k] ?? null)];
        }
        if (s[i] === '"') {
          const k = strLit();
          return (v) => [v == null ? null : (v[k] ?? null)];
        }
        return (v) => [v];
      }
      if (c === "(") {
        i++;
        const e = pipe();
        ws();
        i++;
        return e;
      }
      if (c === '"') {
        const lit = strLit();
        if (typeof lit === "string") return () => [lit];
        return (v) => [
          lit.interp
            .map((p) => (typeof p === "string" ? p : ((x) => (typeof x === "string" ? x : JSON.stringify(x)))(p(v)[0])))
            .join(""),
        ];
      }
      if (/[\d-]/.test(c)) {
        const m = s.slice(i).match(/^-?\d+(\.\d+)?/);
        i += m[0].length;
        const n = Number(m[0]);
        return () => [n];
      }
      if (c === "[") {
        i++;
        ws();
        if (s[i] === "]") {
          i++;
          return () => [[]];
        }
        const e = pipe();
        ws();
        i++;
        return (v) => [e(v)];
      }
      if (c === "{") {
        i++;
        const pairs = [];
        for (;;) {
          ws();
          if (s[i] === "}") {
            i++;
            break;
          }
          let k;
          if (s[i] === '"') k = strLit();
          else if (s[i] === "(") {
            i++;
            const ke = pipe();
            ws();
            i++;
            k = ke;
          } else if (s[i] === "$") {
            i++;
            k = ident();
          } else k = ident();
          ws();
          let val;
          if (s[i] === ":") {
            i++;
            val = alt();
          } else {
            const kk = k;
            val = (v) => [v ? v[kk] : null];
          }
          pairs.push([k, val]);
          ws();
          if (s[i] === ",") i++;
        }
        return (v) => [Object.fromEntries(pairs.map(([k, f]) => [typeof k === "function" ? k(v)[0] : k, f(v)[0]]))];
      }
      if (c === "@") {
        i++;
        const name = s.slice(i).match(/^\w+/)[0];
        i += name.length;
        return (v) => [
          name === "csv"
            ? v.map((x) => (typeof x === "string" ? `"${x.replace(/"/g, '""')}"` : x)).join(",")
            : name === "tsv"
              ? v.join("\t")
              : name === "base64"
                ? IG.util.b64(String(v))
                : name === "base64d"
                  ? IG.util.unb64(String(v))
                  : name === "json"
                    ? JSON.stringify(v)
                    : String(v),
        ];
      }
      if (/[a-z_]/.test(c || "")) {
        const name = ident();
        ws();
        let args = [];
        if (s[i] === "(") {
          i++;
          for (;;) {
            args.push(pipe());
            ws();
            if (s[i] === ";") {
              i++;
              continue;
            }
            i++;
            break;
          }
        }
        const f0 = args[0];
        switch (name) {
          case "length":
            return (v) => [
              v == null
                ? 0
                : typeof v === "object"
                  ? Object.keys(v).length
                  : typeof v === "number"
                    ? Math.abs(v)
                    : String(v).length,
            ];
          case "keys":
          case "keys_unsorted":
            return (v) => [
              Array.isArray(v)
                ? v.map((_, k) => k)
                : name === "keys"
                  ? Object.keys(v || {}).sort()
                  : Object.keys(v || {}),
            ];
          case "values":
            return (v) => (v !== null ? [v] : []);
          case "type":
            return (v) => [v === null ? "null" : Array.isArray(v) ? "array" : typeof v];
          case "select":
            return (v) => (truthy(f0(v)[0]) ? [v] : []);
          case "map":
            return (v) => [(Array.isArray(v) ? v : Object.values(v || {})).flatMap((x) => f0(x))];
          case "map_values":
            return (v) => [Object.fromEntries(Object.entries(v || {}).map(([k, x]) => [k, f0(x)[0]]))];
          case "to_entries":
            return (v) => [Object.entries(v || {}).map(([key, value]) => ({ key, value }))];
          case "from_entries":
            return (v) => [Object.fromEntries((v || []).map((e) => [e.key ?? e.name ?? e.k, e.value ?? e.v]))];
          case "with_entries":
            return (v) => [
              Object.fromEntries(
                Object.entries(v || {})
                  .map(([key, value]) => f0({ key, value })[0])
                  .map((e) => [e.key, e.value]),
              ),
            ];
          case "has":
            return (v) => [v != null && Object.prototype.hasOwnProperty.call(v, f0(v)[0])];
          case "del":
            return (v) => {
              const c2 = JSON.parse(JSON.stringify(v));
              const src = s;
              void src;
              return [c2];
            };
          case "sort":
            return (v) => [v.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
          case "sort_by":
            return (v) => [
              v.slice().sort((a, b) => {
                const x = f0(a)[0],
                  y = f0(b)[0];
                return x < y ? -1 : x > y ? 1 : 0;
              }),
            ];
          case "group_by":
            return (v) => {
              const g = {};
              v.forEach((x) => {
                const k = JSON.stringify(f0(x)[0]);
                (g[k] = g[k] || []).push(x);
              });
              return [
                Object.keys(g)
                  .sort()
                  .map((k) => g[k]),
              ];
            };
          case "unique":
            return (v) => [[...new Set(v.map((x) => JSON.stringify(x)))].sort().map((x) => JSON.parse(x))];
          case "unique_by":
            return (v) => {
              const seen = new Map();
              v.forEach((x) => {
                const k = JSON.stringify(f0(x)[0]);
                if (!seen.has(k)) seen.set(k, x);
              });
              return [[...seen.values()]];
            };
          case "min":
            return (v) => [v.length ? v.reduce((a, b) => (b < a ? b : a)) : null];
          case "max":
            return (v) => [v.length ? v.reduce((a, b) => (b > a ? b : a)) : null];
          case "add":
            return (v) => [
              v.length
                ? v.reduce((a, b) =>
                    Array.isArray(a) ? a.concat(b) : typeof a === "object" && a ? Object.assign({}, a, b) : a + b,
                  )
                : null,
            ];
          case "first":
            return f0 ? (v) => f0(v).slice(0, 1) : (v) => [v[0] ?? null];
          case "last":
            return (v) => [v[v.length - 1] ?? null];
          case "reverse":
            return (v) => [Array.isArray(v) ? v.slice().reverse() : String(v).split("").reverse().join("")];
          case "tostring":
            return (v) => [typeof v === "string" ? v : JSON.stringify(v)];
          case "tonumber":
            return (v) => [Number(v)];
          case "ascii_downcase":
            return (v) => [String(v).toLowerCase()];
          case "ascii_upcase":
            return (v) => [String(v).toUpperCase()];
          case "join":
            return (v) => [v.map((x) => (x === null ? "" : x)).join(f0(v)[0])];
          case "split":
            return (v) => [String(v).split(f0(v)[0])];
          case "test":
            return (v) => [new RegExp(f0(v)[0]).test(String(v))];
          case "startswith":
            return (v) => [String(v).startsWith(f0(v)[0])];
          case "endswith":
            return (v) => [String(v).endsWith(f0(v)[0])];
          case "contains":
            return (v) => [
              typeof v === "string"
                ? v.includes(f0(v)[0])
                : JSON.stringify(v).includes(JSON.stringify(f0(v)[0]).replace(/^[[{]|[\]}]$/g, "")),
            ];
          case "not":
            return (v) => [!truthy(v)];
          case "empty":
            return () => [];
          case "null":
            return () => [null];
          case "true":
            return () => [true];
          case "false":
            return () => [false];
          case "env":
            return () => [{}];
          case "tojson":
            return (v) => [JSON.stringify(v)];
          case "fromjson":
            return (v) => [JSON.parse(v)];
          case "floor":
            return (v) => [Math.floor(v)];
          case "range":
            return (v) => {
              const n = f0(v)[0];
              return Array.from({ length: n }, (_, k) => k);
            };
          case "paths":
            return (v) => {
              const res = [];
              const walk = (x, p) => {
                if (p.length) res.push(p);
                if (x && typeof x === "object")
                  Object.entries(x).forEach(([k, y]) => walk(y, p.concat(Array.isArray(x) ? Number(k) : k)));
              };
              walk(v, []);
              return res;
            };
          case "if":
            throw new Error("if/then/else is not supported in this simulator");
        }
        throw new Error(`${name}/${args.length} is not defined`);
      }
      throw new Error(`syntax error, unexpected '${c}'`);
    }
    const f = pipe();
    ws();
    if (i < s.length) throw new Error(`syntax error, unexpected INVALID_CHARACTER at '${s.slice(i, i + 10)}'`);
    return f(input);
  }
  function jqFormat(v, indent, compact, sortKeys) {
    if (sortKeys && v && typeof v === "object") {
      const sk = (x) =>
        Array.isArray(x)
          ? x.map(sk)
          : x && typeof x === "object"
            ? Object.fromEntries(
                Object.keys(x)
                  .sort()
                  .map((k) => [k, sk(x[k])]),
              )
            : x;
      v = sk(v);
    }
    return compact ? JSON.stringify(v) : JSON.stringify(v, null, indent);
  }
  C.jq = (argv, ctx) => {
    const { f, pos } = opts(argv, "", ["arg", "argjson", "indent"]);
    const o = out();
    const filter = pos.shift() ?? ".";
    const r = inputs(ctx, pos, "jq");
    if (r.errs.length) {
      r.errs.forEach((e) =>
        o.e(
          e.replace(/^jq: (.*): No such file or directory$/, "jq: error: Could not open $1: No such file or directory"),
          2,
        ),
      );
      return o.r();
    }
    const docs = [];
    for (const t of r.texts) {
      const text = t.text.trim();
      if (!text) continue;
      try {
        docs.push(JSON.parse(text));
      } catch (e) {
        // multiple JSON values separated by whitespace
        const parts = text.split(/\n(?=[{[])/);
        try {
          parts.forEach((p) => docs.push(JSON.parse(p)));
        } catch (e2) {
          o.e(
            `jq: error (at <stdin>:${text.split("\n").length}): Cannot index string with string "${filter.replace(/^\./, "").split(/[.[|]/)[0]}"\nparse error: Invalid numeric literal at line 1, column ${Math.min(text.length, 10)}`,
            5,
          );
          return o.r();
        }
      }
    }
    if (f.n || f["null-input"]) docs.splice(0, docs.length, null);
    try {
      for (const d of docs)
        for (const v of jqEval(filter, d))
          o.o(
            ((f.r || f["raw-output"] || f.j) && typeof v === "string"
              ? v
              : jqFormat(v, 2, f.c || f["compact-output"], f.S || f["sort-keys"])) + (f.j ? "" : "\n"),
          );
    } catch (e) {
      o.e(`jq: error: ${e.message}`, 3);
    }
    if (f.e && /^(null|false)\n$/.test(o.so)) o.code = 1;
    return o.r();
  };

  /* ================================================================ xargs */
  C.xargs = (argv, ctx) => {
    const o = out();
    let i = 0,
      n = Infinity,
      rep = null,
      nul = false,
      noRun = false,
      verbose = false,
      delim = null,
      P = 1;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-n") n = Number(argv[++i]);
      else if (/^-n\d+$/.test(a)) n = Number(a.slice(2));
      else if (a === "-I") rep = argv[++i];
      else if (/^-I./.test(a)) rep = a.slice(2);
      else if (a === "-i") rep = "{}";
      else if (a === "-0" || a === "--null") nul = true;
      else if (a === "-r" || a === "--no-run-if-empty") noRun = true;
      else if (a === "-t" || a === "--verbose") verbose = true;
      else if (a === "-d") delim = argv[++i];
      else if (a === "-P") P = Number(argv[++i]);
      else if (a === "-L") n = Number(argv[++i]);
      else break;
    }
    void P;
    const cmd = argv.slice(i);
    if (!cmd.length) cmd.push("echo");
    const input = ctx.stdin;
    let items = nul
      ? input.split("\0")
      : delim
        ? input.split(delim.replace("\\n", "\n"))
        : rep
          ? lines(input)
          : (input.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^["']|["']$/g, ""));
    items = items.filter((x) => x !== "");
    if (!items.length && (noRun || rep)) return o.r();
    const batches = [];
    if (rep) items.forEach((it) => batches.push(cmd.map((c) => c.split(rep).join(it))));
    else if (!items.length) batches.push(cmd);
    else
      for (let k = 0; k < items.length; k += n === Infinity ? items.length : n)
        batches.push(cmd.concat(items.slice(k, n === Infinity ? undefined : k + n)));
    let code = 0;
    for (const b of batches) {
      if (verbose) o.e(b.join(" "), o.code);
      const res = ctx.shell.runArgv(
        b,
        ctx.pod ? { pod: ctx.pod } : ctx.container ? { container: ctx.container } : null,
      );
      if (res.out) {
        if (res.err) o.e(res.out, o.code);
        else o.o(res.out + "\n");
      }
      if (res.code) code = res.code === 127 ? 127 : 123;
    }
    o.code = code;
    return o.r();
  };

  /* ================================================================ find */
  C.find = (argv, ctx) => {
    const o = out();
    const fs = ctx.vfs;
    const starts = [];
    let i = 0;
    while (i < argv.length && !/^[-!(]/.test(argv[i])) starts.push(argv[i++]);
    if (!starts.length) starts.push(".");
    const expr = argv.slice(i);
    let maxdepth = Infinity,
      mindepth = 0;
    // parse expression into a predicate tree
    let p = 0;
    let hasAction = false;
    const now = ctx.world.now();
    function primary() {
      const t = expr[p++];
      if (t === "(") {
        const e = orE();
        p++;
        return e;
      }
      if (t === "!" || t === "-not") {
        const e = primary();
        return (x) => !e(x);
      }
      const arg = () => expr[p++];
      const numCmp = (spec, val) => {
        const m = String(spec).match(/^([+-]?)(\d+)$/);
        if (!m) return false;
        const n = Number(m[2]);
        return m[1] === "+" ? val > n : m[1] === "-" ? val < n : val === n;
      };
      switch (t) {
        case "-name": {
          const re = IG.bash.globRe(arg());
          return (x) => re.test(x.base);
        }
        case "-iname": {
          const g = IG.bash.globRe(arg());
          const re = new RegExp(g.source, "i");
          return (x) => re.test(x.base);
        }
        case "-path":
        case "-wholename": {
          const re = IG.bash.globRe(arg());
          return (x) => re.test(x.shown);
        }
        case "-regex": {
          const re = new RegExp("^" + posix(arg(), false) + "$");
          return (x) => re.test(x.shown);
        }
        case "-type": {
          const ty = arg();
          return (x) =>
            ty === "f"
              ? x.node.type === "f" && !x.node.dev
              : ty === "d"
                ? x.node.type === "d"
                : ty === "l"
                  ? x.node.type === "l"
                  : ty === "c"
                    ? !!x.node.dev
                    : false;
        }
        case "-size": {
          const spec = arg();
          const m = spec.match(/^([+-]?)(\d+)([ckMG]?)$/);
          return (x) => {
            if (!m || x.node.type === "d") return false;
            const unit = { "": 512, "c": 1, "k": 1024, "M": 1048576, "G": 1073741824 }[m[3]];
            const sz = Math.ceil(fs.fileSize(x.node) / unit);
            const n = Number(m[2]);
            return m[1] === "+" ? sz > n : m[1] === "-" ? sz < n : sz === n;
          };
        }
        case "-mtime": {
          const spec = arg();
          return (x) => numCmp(spec, Math.floor((now - x.node.mtime) / 86400e3));
        }
        case "-mmin": {
          const spec = arg();
          return (x) => numCmp(spec, Math.floor((now - x.node.mtime) / 60e3));
        }
        case "-newer": {
          const ref = fs.node(ctx.resolve(arg()));
          return (x) => !!ref && x.node.mtime > ref.mtime;
        }
        case "-user": {
          const u = arg();
          return (x) => x.node.owner === u;
        }
        case "-group": {
          const g = arg();
          return (x) => x.node.group === g;
        }
        case "-nouser":
          return (x) => !ctx.host.users[x.node.owner];
        case "-perm": {
          const spec = arg();
          const any = spec.startsWith("/"),
            all = spec.startsWith("-");
          const m = parseInt(spec.replace(/^[-/]/, ""), 8);
          return (x) => {
            const mode = x.node.mode & 0o7777;
            return any ? (mode & m) !== 0 : all ? (mode & m) === m : mode === m;
          };
        }
        case "-empty":
          return (x) => (x.node.type === "d" ? fs.children(x.path).length === 0 : fs.fileSize(x.node) === 0);
        case "-executable":
          return (x) => (x.node.mode & 0o111) !== 0;
        case "-readable":
          return (x) => ctx.shell.canRead(x.path);
        case "-writable":
          return (x) => ctx.shell.canWrite(x.path);
        case "-maxdepth":
          maxdepth = Number(arg());
          return () => true;
        case "-mindepth":
          mindepth = Number(arg());
          return () => true;
        case "-true":
          return () => true;
        case "-false":
          return () => false;
        case "-print":
          hasAction = true;
          return (x) => {
            o.o(x.shown + "\n");
            return true;
          };
        case "-print0":
          hasAction = true;
          return (x) => {
            o.o(x.shown + "\0");
            return true;
          };
        case "-ls":
          hasAction = true;
          return (x) => {
            const n = x.node;
            o.o(
              `${String(100000 + (IG.util.hash(x.path) % 900000)).padStart(8)}      4 ${IG.modeStr(n)}   1 ${n.owner.padEnd(8)} ${n.group.padEnd(8)} ${String(n.type === "d" ? 4096 : fs.fileSize(n)).padStart(8)} ${new Date(n.mtime).toUTCString().slice(8, 16)} ${x.shown}\n`,
            );
            return true;
          };
        case "-printf": {
          hasAction = true;
          const fmt = arg();
          return (x) => {
            o.o(
              fmt.replace(/%([pfsuMgmTt])|\\n|\\t/g, (m, k) =>
                m === "\\n"
                  ? "\n"
                  : m === "\\t"
                    ? "\t"
                    : {
                        p: x.shown,
                        f: x.base,
                        s: x.node.type === "d" ? 4096 : fs.fileSize(x.node),
                        u: x.node.owner,
                        g: x.node.group,
                        m: (x.node.mode & 0o7777).toString(8),
                        M: IG.modeStr(x.node),
                        T: IG.strftime("%F %T", x.node.mtime),
                        t: new Date(x.node.mtime).toUTCString(),
                      }[k],
              ),
            );
            return true;
          };
        }
        case "-delete":
          hasAction = true;
          return (x) => {
            if (!ctx.shell.canDelete(x.path)) {
              o.e(`find: cannot delete ‘${x.shown}’: Permission denied`);
              return false;
            }
            if (x.node.type === "d" && fs.children(x.path).length) {
              o.e(`find: cannot delete ‘${x.shown}’: Directory not empty`);
              return false;
            }
            x.deleted = true;
            fs.remove(x.path, false);
            return true;
          };
        case "-exec":
        case "-execdir":
        case "-ok": {
          hasAction = true;
          const cmd = [];
          while (p < expr.length && expr[p] !== ";" && expr[p] !== "+") cmd.push(expr[p++]);
          const term = expr[p++];
          if (term === undefined) throw new Error("missing argument to `-exec'");
          if (term === "+") {
            const batch = [];
            batchExecs.push({ cmd, batch });
            return (x) => {
              batch.push(x.shown);
              return true;
            };
          }
          return (x) => {
            const res = ctx.shell.runArgv(cmd.map((c) => c.split("{}").join(x.shown)));
            if (res.out) {
              if (res.err) o.e(res.out, o.code);
              else o.o(res.out + "\n");
            }
            return res.code === 0;
          };
        }
        case "-prune":
          return (x) => {
            x.prune = true;
            return true;
          };
        case "-quit":
          return () => {
            throw new Error("__quit");
          };
      }
      throw new Error(`unknown predicate \`${t}'`);
    }
    function andE() {
      let l = primary();
      while (p < expr.length && expr[p] !== ")" && expr[p] !== "-o" && expr[p] !== "-or" && expr[p] !== ",") {
        if (expr[p] === "-a" || expr[p] === "-and") p++;
        const r = primary();
        const L = l;
        l = (x) => L(x) && r(x);
      }
      return l;
    }
    function orE() {
      let l = andE();
      while (expr[p] === "-o" || expr[p] === "-or") {
        p++;
        const r = andE();
        const L = l;
        l = (x) => L(x) || r(x);
      }
      return l;
    }
    const batchExecs = [];
    let pred;
    try {
      pred = expr.length ? orE() : () => true;
    } catch (e) {
      o.e(`find: ${e.message}`);
      return o.r();
    }
    const userAction = hasAction;
    try {
      for (const s of starts) {
        const root = ctx.resolve(s);
        if (!fs.lexists(root)) {
          o.e(`find: ‘${s}’: No such file or directory`);
          continue;
        }
        const visit = (path, shown, depth) => {
          const node = fs.lnode(path);
          const x = {
            path,
            shown,
            base: depth === 0 ? s.replace(/\/$/, "").split("/").pop() || s : VFS.base(path),
            node,
          };
          if (depth >= mindepth && depth <= maxdepth) {
            if (pred(x) && !userAction) o.o(shown + "\n");
          }
          if (x.deleted || x.prune || node.type !== "d" || depth >= maxdepth) return;
          if (
            !ctx.pod &&
            !ctx.container &&
            (!ctx.host.allowed(ctx.user, node, "r") || !ctx.host.allowed(ctx.user, node, "x"))
          ) {
            o.e(`find: ‘${shown}’: Permission denied`);
            return;
          }
          for (const k of fs.children(path))
            visit(k.path, (shown === "/" ? "" : shown.replace(/\/$/, "")) + "/" + k.name, depth + 1);
        };
        visit(root, s, 0);
      }
    } catch (e) {
      if (e.message !== "__quit") throw e;
    }
    for (const b of batchExecs)
      if (b.batch.length) {
        const res = ctx.shell.runArgv(b.cmd.filter((c) => c !== "{}").concat(b.batch));
        if (res.out) {
          if (res.err) o.e(res.out, o.code);
          else o.o(res.out + "\n");
        }
      }
    ctx.world.reconcile();
    return o.r();
  };
})((globalThis.IG = globalThis.IG || {}));
