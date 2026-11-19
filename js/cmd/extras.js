/* Commands that round out a stock Ubuntu 22.04 / RHEL 9 server: binary viewers (od xxd hexdump
 * strings), more checksums (sha512sum sha384sum cksum), text tools (join split fmt numfmt factor
 * unexpand), file helpers (install link unlink mkfifo shred sync chattr lsattr), system information
 * (getconf locale localectl locale-gen iconv ldd lspci lsusb dmidecode hwclock loginctl tty logname
 * hostid), scheduling (at atq atrm), accounts (chsh chfn lastb), monitoring (sar pidstat pmap ionice
 * taskset chrt), terminal (tput stty wall mesg), network (ssh-keyscan ssh-agent ssh-add ethtool mtr
 * arping whois nmcli netplan resolvectl networkctl openssl) and service clients (apache2ctl a2ensite
 * httpd chronyc redis-cli psql mysql), plus honest hints for what a browser simulator can't run. */
(function (IG) {
  "use strict";
  const U = IG.util;
  const VFS = IG.VFS;
  const C = (IG.commands = IG.commands || {});
  const opts = (...a) => IG.cliOpts(...a);
  const out = () => IG.cliOut();
  const lines = (t) => {
    const l = String(t).split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
  };
  const join = (l) => (l.length ? l.join("\n") + "\n" : "");
  const root = (ctx) => ctx.user === "root";
  const fail = (msg, code = 1, stdout = "") => ({ stdout, stderr: msg.endsWith("\n") ? msg : msg + "\n", code });
  const hint = (msg) => fail("ℹ " + msg);
  const now = (ctx) => ctx.world.now();
  const bytesOf = (s) => Array.from(new TextEncoder().encode(String(s)));
  const textOf = (b) => {
    try {
      return decodeURIComponent(b.map((x) => "%" + x.toString(16).padStart(2, "0")).join(""));
    } catch (e) {
      return String.fromCharCode(...b);
    }
  };
  function readIn(ctx, files, cmd) {
    const r = IG.readInputs(ctx, files, cmd);
    return { text: r.texts.map((t) => t.text).join(""), texts: r.texts, errs: r.errs };
  }

  /* ================================================================ binary viewers */
  const OD_W = { o1: 3, o2: 6, o4: 11, x1: 2, x2: 4, x4: 8, d1: 4, d2: 6, d4: 11, u1: 3, u2: 5, u4: 10 };
  const CESC = { 0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };
  C.od = (argv, ctx) => {
    let fmt = "o2",
      addr = "o",
      count = Infinity,
      skip = 0,
      verbose = false;
    const files = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const val = () => (a.length > 2 ? a.slice(2) : argv[++i]);
      if (a === "-c") fmt = "c";
      else if (a === "-x") fmt = "x2";
      else if (a === "-o") fmt = "o2";
      else if (a === "-d") fmt = "u2";
      else if (a === "-b") fmt = "o1";
      else if (a === "-v") verbose = true;
      else if (/^-A/.test(a)) addr = val()[0];
      else if (/^-t/.test(a)) fmt = val().replace(/z$/, "");
      else if (/^-N/.test(a)) count = Number(val());
      else if (/^-j/.test(a)) skip = Number(val());
      else files.push(a);
    }
    if (/^[xoud]$/.test(fmt)) fmt += "4";
    if (!(fmt === "c" || fmt === "a" || OD_W[fmt])) return fail(`od: invalid type string '${fmt}'`);
    const r = readIn(ctx, files, "od");
    if (r.errs.length && !r.texts.length) return fail(r.errs.join("\n"));
    const b = bytesOf(r.text).slice(skip, skip + count);
    const size = fmt === "c" || fmt === "a" ? 1 : Number(fmt[1]);
    const off = (n) =>
      addr === "n"
        ? ""
        : addr === "x"
          ? n.toString(16).padStart(6, "0")
          : addr === "d"
            ? String(n).padStart(7, "0")
            : n.toString(8).padStart(7, "0");
    const cell = (chunk, i) => {
      if (fmt === "c") {
        const c = chunk[i];
        return (CESC[c] || (c >= 32 && c < 127 ? String.fromCharCode(c) : c.toString(8).padStart(3, "0"))).padStart(4);
      }
      if (fmt === "a") {
        const c = chunk[i] & 0x7f;
        return (
          ["nul", "soh", "stx", "etx", "eot", "enq", "ack", "bel", "bs", "ht", "nl", "vt", "ff", "cr", "so", "si"][c] ||
          (c === 32 ? "sp" : c === 127 ? "del" : c < 32 ? "^" + String.fromCharCode(c + 64) : String.fromCharCode(c))
        ).padStart(4);
      }
      let v = 0;
      for (let k = size - 1; k >= 0; k--) v = v * 256 + (chunk[i + k] || 0);
      if (fmt[0] === "d" && v >= 2 ** (size * 8 - 1)) v -= 2 ** (size * 8);
      const base = { o: 8, x: 16, d: 10, u: 10 }[fmt[0]];
      const s = v.toString(base);
      return " " + (base === 10 ? s.padStart(OD_W[fmt]) : s.padStart(OD_W[fmt], "0"));
    };
    const res = [];
    let prev = null,
      starred = false;
    for (let p = 0; p < b.length; p += 16) {
      const chunk = b.slice(p, p + 16);
      const key = chunk.join(",");
      if (!verbose && key === prev && chunk.length === 16) {
        if (!starred) res.push("*");
        starred = true;
        continue;
      }
      prev = key;
      starred = false;
      let line = off(p + skip);
      for (let i = 0; i < chunk.length; i += size) line += cell(chunk, i);
      res.push(line);
    }
    if (addr !== "n") res.push(off(b.length + skip));
    return { stdout: join(res), stderr: r.errs.map((e) => e + "\n").join(""), code: r.errs.length ? 1 : 0 };
  };
  const printable = (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ".");
  C.xxd = (argv, ctx) => {
    const { f, pos } = opts(argv, "lscg", ["len", "seek", "cols", "groupsize"]);
    const r = readIn(ctx, pos.slice(0, 1), "xxd");
    if (r.errs.length)
      return fail(r.errs[0].replace(/^xxd: (.+): No such file or directory$/, "xxd: $1: No such file or directory"), 2);
    if (f.r || f.revert) {
      const hex =
        f.p || f.ps || f.plain
          ? r.text.replace(/\s+/g, "")
          : lines(r.text)
              .map((l) => (l.match(/^[0-9a-f]+:\s((?:[0-9a-f]{2,}\s?)+)/i) || [, ""])[1].replace(/\s+/g, ""))
              .join("");
      return textOf((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
    }
    let b = bytesOf(r.text);
    if (f.s || f.seek) b = b.slice(Number(f.s || f.seek));
    if (f.l || f.len) b = b.slice(0, Number(f.l || f.len));
    const hx = (n) => (f.u ? n.toString(16).toUpperCase() : n.toString(16)).padStart(2, "0");
    if (f.p || f.ps || f.plain)
      return join(
        b
          .map(hx)
          .join("")
          .match(/.{1,60}/g) || [],
      );
    if (f.i || f.include) {
      const name = (pos[0] || "stdin").replace(/[^\w]/g, "_");
      return `unsigned char ${name}[] = {\n${(
        b
          .map((x) => "0x" + hx(x))
          .join(", ")
          .match(/.{1,72}(, |$)/g) || []
      )
        .map((l) => "  " + l.trim())
        .join("\n")}\n};\nunsigned int ${name}_len = ${b.length};\n`;
    }
    const cols = Number(f.c || f.cols || 16),
      g = Number(f.g || f.groupsize || 2);
    if (!(cols >= 1 && cols <= 256)) return fail("xxd: invalid number of columns (max. 256).");
    const width = cols * 2 + Math.ceil(cols / g) - 1;
    const res = [];
    for (let p = 0; p < b.length; p += cols) {
      const chunk = b.slice(p, p + cols);
      let hexs = "";
      chunk.forEach((x, i) => {
        hexs += hx(x);
        if ((i + 1) % g === 0 && i + 1 < cols) hexs += " ";
      });
      res.push(`${p.toString(16).padStart(8, "0")}: ${hexs.trimEnd().padEnd(width)}  ${chunk.map(printable).join("")}`);
    }
    return join(res);
  };
  C.hexdump = (argv, ctx) => {
    const { f, pos } = opts(argv, "ns", ["length", "skip"]);
    const r = readIn(ctx, pos, "hexdump");
    if (r.errs.length && !r.texts.length)
      return fail(
        r.errs
          .map((e) => e.replace(/^hexdump: (.+): No such file or directory$/, "hexdump: $1: No such file or directory"))
          .join("\n"),
      );
    let b = bytesOf(r.text);
    const skip = Number(f.s || f.skip || 0);
    b = b.slice(skip);
    if (f.n || f.length) b = b.slice(0, Number(f.n || f.length));
    const res = [];
    let prev = null,
      starred = false;
    for (let p = 0; p < b.length; p += 16) {
      const chunk = b.slice(p, p + 16);
      const key = chunk.join(",");
      if (!f.v && key === prev && chunk.length === 16) {
        if (!starred) res.push("*");
        starred = true;
        continue;
      }
      prev = key;
      starred = false;
      if (f.C || f.canonical)
        res.push(
          `${(p + skip).toString(16).padStart(8, "0")}  ${chunk
            .map((x, i) => x.toString(16).padStart(2, "0") + " " + (i === 7 ? " " : ""))
            .join("")
            .padEnd(49)} |${chunk.map(printable).join("")}|`,
        );
      else {
        const words = [];
        for (let i = 0; i < chunk.length; i += 2)
          words.push(((chunk[i + 1] || 0) * 256 + chunk[i]).toString(16).padStart(4, "0"));
        res.push(`${(p + skip).toString(16).padStart(7, "0")} ${words.join(" ")}`);
      }
    }
    res.push((b.length + skip).toString(16).padStart(f.C || f.canonical ? 8 : 7, "0"));
    return join(res);
  };
  C.hd = (argv, ctx) => C.hexdump(["-C"].concat(argv), ctx);
  const ELF_STRINGS = (cmd) => [
    "/lib64/ld-linux-x86-64.so.2",
    "libc.so.6",
    "GLIBC_2.34",
    "GLIBC_2.3.4",
    "__libc_start_main",
    "__cxa_finalize",
    "strlen",
    "malloc",
    "getenv",
    "setlocale",
    "__stack_chk_fail",
    "GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0",
    `${cmd} (GNU coreutils) 8.32`,
    "Usage: %s [OPTION]...",
    ".shstrtab",
    ".interp",
    ".note.gnu.property",
    ".dynsym",
    ".text",
    ".rodata",
    ".data",
    ".bss",
  ];
  C.strings = (argv, ctx) => {
    const { f, pos } = opts(argv, "nt", ["bytes"]);
    const min = Number(f.n || f.bytes || 4);
    const o = out();
    const r = IG.readInputs(ctx, pos, "strings");
    for (const t of r.texts) {
      const s = t.text.startsWith("\x7fELF") ? ELF_STRINGS(VFS.base(t.name)).join("\n") + "\n" : t.text;
      const runs = s.match(new RegExp(`[\\x20-\\x7e\\t]{${min},}`, "g")) || [];
      o.o(join(runs));
    }
    r.errs.forEach((e) => o.e(e.replace(/^strings: (.+): No such file or directory$/, "strings: '$1': No such file")));
    return o.r();
  };

  /* ================================================================ checksums */
  // SHA-512 / SHA-384; the round constants are derived (cube / square roots of primes) rather than tabled
  const SHA2 = (() => {
    const M = (1n << 64n) - 1n;
    const iroot = (n, k) => {
      let x = 1n << BigInt(Math.ceil(n.toString(2).length / k));
      for (;;) {
        const y = ((BigInt(k) - 1n) * x + n / x ** BigInt(k - 1)) / BigInt(k);
        if (y >= x) return x;
        x = y;
      }
    };
    const primes = [];
    for (let n = 2; primes.length < 80; n++) if (primes.every((p) => n % p)) primes.push(n);
    const K = primes.map((p) => iroot(BigInt(p) << 192n, 3) & M);
    const IV = (ps) => ps.map((p) => iroot(BigInt(p) << 128n, 2) & M);
    const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M;
    function run(str, H0, words) {
      const b = bytesOf(str);
      const len = b.length;
      const total = Math.ceil((len + 17) / 128) * 128;
      const m = new Uint8Array(total);
      m.set(b);
      m[len] = 0x80;
      let bits = BigInt(len) * 8n;
      for (let i = total - 1; bits > 0n; i--) {
        m[i] = Number(bits & 255n);
        bits >>= 8n;
      }
      const H = H0.slice();
      const W = new Array(80);
      for (let o = 0; o < total; o += 128) {
        for (let i = 0; i < 16; i++) {
          let v = 0n;
          for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(m[o + i * 8 + k]);
          W[i] = v;
        }
        for (let i = 16; i < 80; i++) {
          const s0 = rotr(W[i - 15], 1) ^ rotr(W[i - 15], 8) ^ (W[i - 15] >> 7n);
          const s1 = rotr(W[i - 2], 19) ^ rotr(W[i - 2], 61) ^ (W[i - 2] >> 6n);
          W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M;
        }
        let [a, bb, c, d, e, f, g, h] = H;
        for (let i = 0; i < 80; i++) {
          const t1 = (h + (rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41)) + ((e & f) ^ (~e & M & g)) + K[i] + W[i]) & M;
          const t2 = ((rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39)) + ((a & bb) ^ (a & c) ^ (bb & c))) & M;
          h = g;
          g = f;
          f = e;
          e = (d + t1) & M;
          d = c;
          c = bb;
          bb = a;
          a = (t1 + t2) & M;
        }
        [a, bb, c, d, e, f, g, h].forEach((v, i) => {
          H[i] = (H[i] + v) & M;
        });
      }
      return H.slice(0, words)
        .map((x) => x.toString(16).padStart(16, "0"))
        .join("");
    }
    const H512 = IV(primes.slice(0, 8)),
      H384 = IV(primes.slice(8, 16));
    return { sha512: (s) => run(s, H512, 8), sha384: (s) => run(s, H384, 6) };
  })();
  IG.hash.sha512 = SHA2.sha512;
  IG.hash.sha384 = SHA2.sha384;
  C.sha512sum = IG.sumCmd("sha512");
  C.sha384sum = IG.sumCmd("sha384");
  const CRC = (() => {
    const t = [];
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      t.push(c >>> 0);
    }
    return t;
  })();
  function cksum(bytes) {
    let crc = 0;
    const step = (b) => {
      crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0;
    };
    bytes.forEach(step);
    for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
    return ~crc >>> 0;
  }
  C.cksum = (argv, ctx) => {
    const o = out();
    const r = IG.readInputs(
      ctx,
      argv.filter((a) => !a.startsWith("-")),
      "cksum",
    );
    for (const t of r.texts) {
      const b = bytesOf(t.text);
      o.o(`${cksum(b)} ${b.length}${t.name === "-" ? "" : " " + t.name}\n`);
    }
    r.errs.forEach((e) => o.e(e));
    return o.r();
  };

  /* ================================================================ text tools */
  C.join = (argv, ctx) => {
    const { f, pos } = opts(argv, "t12ae", []);
    if (pos.length < 2) return fail("join: missing operand\nTry 'join --help' for more information.");
    const [a, b] = pos.map((p) => readIn(ctx, [p], "join"));
    const err = a.errs.concat(b.errs);
    if (err.length) return fail(err.join("\n"));
    const t = f.t;
    const split = (l) => (t ? l.split(t) : l.trim().split(/\s+/));
    const k1 = Number(f["1"] || 1) - 1,
      k2 = Number(f["2"] || 1) - 1;
    const A = lines(a.text).map(split),
      B = lines(b.text).map(split);
    const sep = t || " ";
    const res = [],
      used = new Set();
    for (const ra of A) {
      const matches = B.filter((rb) => rb[k2] === ra[k1]);
      matches.forEach((rb) => used.add(rb));
      if (matches.length)
        for (const rb of matches)
          res.push([ra[k1], ...ra.filter((_, i) => i !== k1), ...rb.filter((_, i) => i !== k2)].join(sep));
      else if (String(f.a) === "1" || f.a === true) res.push(ra.join(sep));
    }
    if (String(f.a) === "2") for (const rb of B) if (!used.has(rb)) res.push(rb.join(sep));
    return join(res);
  };
  C.split = (argv, ctx) => {
    const { f, pos } = opts(argv, "lbna", ["lines", "bytes", "number", "suffix-length", "additional-suffix"]);
    const [file = "-", prefix = "x"] = pos;
    const r = readIn(ctx, [file], "split");
    if (r.errs.length)
      return fail(
        r.errs[0].replace(
          /^split: (.+): No such file or directory$/,
          "split: cannot open '$1' for reading: No such file or directory",
        ),
      );
    const sz = (s) => {
      const m = String(s).match(/^(\d+)([KMG]?)/i);
      return m ? Number(m[1]) * { "": 1, "K": 1024, "M": 1048576, "G": 1073741824 }[m[2].toUpperCase()] : NaN;
    };
    let parts;
    const text = r.text;
    // every size and count is a whole number of at least 1 (0 would split forever)
    const bad = (what, v) => fail(`split: invalid number of ${what}: ‘${v}’`);
    if (f.b || f.bytes) {
      const n = sz(f.b || f.bytes);
      if (!(n >= 1)) return bad("bytes", f.b || f.bytes);
      parts = text.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) || [];
    } else if (f.n || f.number) {
      const n = Number(f.n || f.number);
      if (!Number.isInteger(n) || n < 1) return bad("chunks", f.n || f.number);
      if (n > 10000) throw new IG.bash.Flow("abort", 0, 130); // more files than the simulator keeps
      const per = Math.ceil(text.length / n);
      parts = Array.from({ length: n }, (_, i) => text.slice(i * per, (i + 1) * per));
    } else {
      const n = Number(f.l || f.lines || 1000);
      if (!Number.isInteger(n) || n < 1) return bad("lines", f.l || f.lines);
      const ls = text.split(/(?<=\n)/);
      parts = [];
      for (let i = 0; i < ls.length; i += n) parts.push(ls.slice(i, i + n).join(""));
    }
    const width = Number(f.a || f["suffix-length"] || 2);
    const numeric = f.d || f["numeric-suffixes"];
    const sfx = (i) => {
      if (numeric) return String(i).padStart(width, "0");
      let s = "";
      for (let k = 0, n = i; k < width; k++, n = Math.floor(n / 26)) s = String.fromCharCode(97 + (n % 26)) + s;
      return s;
    };
    for (let i = 0; i < parts.length; i++) {
      const p = ctx.resolve(prefix + sfx(i) + (f["additional-suffix"] || ""));
      if (!ctx.shell.canWrite(p)) return fail(`split: cannot open '${prefix + sfx(i)}' for writing: Permission denied`);
      ctx.vfs.write(p, parts[i], { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user) });
    }
    return "";
  };
  C.fmt = (argv, ctx) => {
    const { f, pos } = opts(argv, "w", ["width"]);
    const w = Number(f.w || f.width || 75);
    const r = readIn(ctx, pos, "fmt");
    const res = [];
    for (const para of r.text.split(/\n\s*\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = "";
      for (const wd of words) {
        if (line && line.length + 1 + wd.length > w) {
          res.push(line);
          line = wd;
        } else line = line ? line + " " + wd : wd;
      }
      if (line) res.push(line);
      res.push("");
    }
    res.pop();
    return join(res);
  };
  C.unexpand = (argv, ctx) => {
    const all = argv.includes("-a") || argv.includes("--all");
    const r = readIn(
      ctx,
      argv.filter((a) => !a.startsWith("-")),
      "unexpand",
    );
    return join(
      lines(r.text).map((l) =>
        all ? l.replace(/ {8}/g, "\t") : l.replace(/^( {8})+/, (m) => "\t".repeat(m.length / 8)),
      ),
    );
  };
  const IEC = ["", "K", "M", "G", "T", "P", "E"];
  C.numfmt = (argv, ctx) => {
    const { f, pos } = opts(argv, "", ["to", "from", "suffix", "padding", "field", "format"]);
    const vals = pos.length ? pos : lines(ctx.stdin);
    const res = [];
    for (const v of vals) {
      const m = String(v)
        .trim()
        .match(/^(-?\d+(?:\.\d+)?)([KMGTPE]?)(i?)B?$/i);
      if (!m) return fail(`numfmt: invalid number: '${v}'`, 2, join(res));
      const unit = m[2].toUpperCase();
      if (unit && !f.from)
        return fail(`numfmt: rejecting suffix in input: '${v}' (consider using --from)`, 2, join(res));
      const base = f.from === "si" ? 1000 : 1024;
      const n = Number(m[1]) * base ** IEC.indexOf(unit);
      let s;
      if (f.to === "iec" || f.to === "iec-i" || f.to === "si") {
        const b = f.to === "si" ? 1000 : 1024;
        let i = 0,
          x = Math.abs(n);
        while (x >= b && i < 6) {
          x /= b;
          i++;
        }
        const r1 = i === 0 ? String(Math.ceil(x)) : x < 10 ? (Math.ceil(x * 10) / 10).toFixed(1) : String(Math.ceil(x));
        s = (n < 0 ? "-" : "") + r1 + (i ? IEC[i] + (f.to === "iec-i" ? "i" : "") : "");
      } else s = String(Math.round(n));
      res.push(s + (f.suffix || ""));
    }
    return join(res);
  };
  C.factor = (argv, ctx) => {
    const vals = argv.length
      ? argv
      : lines(ctx.stdin)
          .flatMap((l) => l.trim().split(/\s+/))
          .filter(Boolean);
    const o = out();
    for (const v of vals) {
      if (!/^\d+$/.test(v)) {
        o.e(`factor: ‘${v}’ is not a valid positive integer`);
        continue;
      }
      let n = BigInt(v);
      const fs = [];
      for (let d = 2n; d * d <= n; d += d === 2n ? 1n : 2n)
        while (n % d === 0n) {
          fs.push(d);
          n /= d;
        }
      if (n > 1n) fs.push(n);
      o.o(`${v}:${fs.map((x) => " " + x).join("")}\n`);
    }
    return o.r();
  };

  /* ================================================================ file helpers */
  C.sync = () => "";
  C.link = (argv, ctx) => {
    if (argv.length !== 2)
      return fail(
        `link: ${argv.length < 2 ? "missing operand" : `extra operand '${argv[2]}'`}\nTry 'link --help' for more information.`,
      );
    const [a, b] = argv.map((x) => ctx.resolve(x));
    if (!ctx.vfs.exists(a))
      return fail(`link: cannot create link '${argv[1]}' to '${argv[0]}': No such file or directory`);
    if (ctx.vfs.lexists(b)) return fail(`link: cannot create link '${argv[1]}' to '${argv[0]}': File exists`);
    if (ctx.vfs.isDir(a)) return fail(`link: cannot create link '${argv[1]}' to '${argv[0]}': Operation not permitted`);
    if (!ctx.shell.canWrite(b)) return fail(`link: cannot create link '${argv[1]}' to '${argv[0]}': Permission denied`);
    ctx.vfs.nodes.set(ctx.vfs.real(VFS.parent(b)) + "/" + VFS.base(b), ctx.vfs.node(a));
    return "";
  };
  C.unlink = (argv, ctx) => {
    if (argv.length !== 1)
      return fail(
        `unlink: ${argv.length ? `extra operand '${argv[1]}'` : "missing operand"}\nTry 'unlink --help' for more information.`,
      );
    const p = ctx.resolve(argv[0]);
    if (!ctx.vfs.lexists(p)) return fail(`unlink: cannot unlink '${argv[0]}': No such file or directory`);
    if (ctx.vfs.isDir(p) && ctx.vfs.lnode(p).type === "d")
      return fail(`unlink: cannot unlink '${argv[0]}': Is a directory`);
    if (!ctx.shell.canDelete(p))
      return fail(
        `unlink: cannot unlink '${argv[0]}': ${(ctx.vfs.lnode(p).attrs || "").match(/[ia]/) ? "Operation not permitted" : "Permission denied"}`,
      );
    ctx.vfs.remove(p);
    return "";
  };
  C.mkfifo = (argv, ctx) => {
    const { f, pos } = opts(argv, "m", ["mode"]);
    const o = out();
    for (const t of pos) {
      const p = ctx.resolve(t);
      if (ctx.vfs.lexists(p)) {
        o.e(`mkfifo: cannot create fifo '${t}': File exists`);
        continue;
      }
      if (!ctx.shell.canWrite(p)) {
        o.e(`mkfifo: cannot create fifo '${t}': Permission denied`);
        continue;
      }
      const n = ctx.vfs.write(p, "", {
        owner: ctx.user,
        group: ctx.host.primaryGroup(ctx.user),
        mode: f.m || f.mode ? parseInt(f.m || f.mode, 8) : 0o664 & ~(ctx.shell.umask ?? 0o002),
      });
      n.fifo = true;
    }
    return o.r();
  };
  C.shred = (argv, ctx) => {
    const { f, pos } = opts(argv, "ns", ["iterations", "size"]);
    const o = out();
    const passes = Number(f.n || f.iterations || 3);
    for (const t of pos) {
      const p = ctx.resolve(t);
      if (!ctx.vfs.exists(p)) {
        o.e(`shred: ${t}: failed to open for writing: No such file or directory`);
        continue;
      }
      if (!ctx.shell.canWrite(p)) {
        o.e(`shred: ${t}: failed to open for writing: Permission denied`);
        continue;
      }
      const n = ctx.vfs.node(p);
      const size = ctx.vfs.fileSize(n);
      if (f.v || f.verbose)
        for (let i = 1; i <= passes; i++) o.e(`shred: ${t}: pass ${i}/${passes + (f.z ? 1 : 0)} (random)...`, 0);
      n.content = f.z ? "\0".repeat(Math.min(size, 4096)) : U.hex(t + now(ctx), Math.min(size, 4096));
      n.size = size;
      if (f.u || f.remove) {
        if (f.v)
          o.e(
            `shred: ${t}: removing\nshred: ${t}: renamed to ${"0".repeat(VFS.base(t).length)}\nshred: ${t}: removed`,
            0,
          );
        ctx.vfs.remove(p);
      }
    }
    return o.r();
  };
  C.install = (argv, ctx) => {
    const { f, pos } = opts(argv, "mogt", ["mode", "owner", "group", "target-directory"]);
    const o = out();
    const mode = f.m || f.mode ? parseInt(f.m || f.mode, 8) : 0o755;
    const owner = f.o || f.owner,
      group = f.g || f.group;
    if (!pos.length) {
      o.e("install: missing file operand\nTry 'install --help' for more information.");
      return o.r();
    }
    if ((owner || group) && !root(ctx)) {
      o.e(`install: cannot change ownership of '${pos[pos.length - 1]}': Operation not permitted`);
      return o.r();
    }
    const meta = {
      owner: owner || ctx.user,
      group: group || (owner ? ctx.host.primaryGroup(owner) : ctx.host.primaryGroup(ctx.user)),
      mode,
    };
    if (f.d || f.directory) {
      for (const d of pos) {
        const p = ctx.resolve(d);
        if (!ctx.shell.canWrite(p)) {
          o.e(`install: cannot create directory '${d}': Permission denied`);
          continue;
        }
        ctx.vfs.mkdirp(p, meta);
        Object.assign(ctx.vfs.node(p), meta);
      }
      return o.r();
    }
    if (pos.length < 2) {
      o.e(
        `install: missing destination file operand after '${pos[0] || ""}'\nTry 'install --help' for more information.`,
      );
      return o.r();
    }
    const dest = ctx.resolve(pos[pos.length - 1]);
    for (const s of pos.slice(0, -1)) {
      const sp = ctx.resolve(s);
      if (!ctx.vfs.isFile(sp)) {
        o.e(`install: cannot stat '${s}': No such file or directory`);
        continue;
      }
      const tp = ctx.vfs.isDir(dest) ? dest + "/" + VFS.base(sp) : dest;
      if (f.D) ctx.vfs.mkdirp(VFS.parent(tp));
      if (!ctx.shell.canWrite(tp)) {
        o.e(`install: cannot create regular file '${tp}': Permission denied`);
        continue;
      }
      const n = ctx.vfs.node(sp);
      ctx.vfs.write(tp, n.content, Object.assign({ size: n.size }, meta));
      if (f.v || f.verbose) o.o(`'${s}' -> '${tp}'\n`);
    }
    return o.r();
  };
  // chattr +i (immutable) is enforced by Host.allowed / canDelete, +a blocks deletion
  const ATTRS = "suSDiadAcEjItTeCxFNPVm";
  C.chattr = (argv, ctx) => {
    const o = out();
    const rec = argv.includes("-R");
    const specs = argv.filter((a) => /^[+=-][a-zA-Z]+$/.test(a) && a !== "-R" && a !== "-V" && a !== "-f");
    const files = argv.filter((a) => !specs.includes(a) && !/^-[RVf]$/.test(a));
    if (!specs.length || !files.length) {
      o.e("Usage: chattr [-pRVf] [-+=aAcCdDeijPsStTuFx] [-v version] files...");
      return o.r();
    }
    for (const t of files) {
      const p = ctx.resolve(t);
      if (!ctx.vfs.exists(p)) {
        o.e(`chattr: No such file or directory while trying to stat ${t}`);
        continue;
      }
      for (const q of [p].concat(rec && ctx.vfs.isDir(p) ? ctx.vfs.walk(p) : [])) {
        const n = ctx.vfs.node(q);
        let a = n.attrs || "";
        for (const s of specs) {
          const fl = s.slice(1);
          if (/[ia]/.test(fl) && !root(ctx)) {
            o.e(`chattr: Operation not permitted while setting flags on ${q === p ? t : q}`);
            a = null;
            break;
          }
          if (ctx.user !== "root" && n.owner !== ctx.user) {
            o.e(`chattr: Operation not permitted while setting flags on ${q === p ? t : q}`);
            a = null;
            break;
          }
          if (s[0] === "+") a = [...new Set(a + fl)].join("");
          else if (s[0] === "-") a = [...a].filter((c) => !fl.includes(c)).join("");
          else a = fl;
        }
        if (a !== null) n.attrs = a;
      }
    }
    return o.r();
  };
  C.lsattr = (argv, ctx) => {
    const { f, pos } = opts(argv, "");
    const o = out();
    const xfs = (p) => ctx.host.os === "rhel" && !p.startsWith("/data");
    const fmt = (n, p) =>
      [...ATTRS]
        .map((c) => (((n.attrs || "") + (xfs(p) ? "" : "e")).includes(c) ? c : "-"))
        .join("")
        .replace(/^(.{22}).*$/, "$1");
    const targets = pos.length ? pos : ["."];
    for (const t of targets) {
      const p = ctx.resolve(t);
      if (!ctx.vfs.exists(p)) {
        o.e(`lsattr: No such file or directory while trying to stat ${t}`);
        continue;
      }
      if (ctx.vfs.isDir(p) && !f.d) {
        for (const c of ctx.vfs.children(p).filter((k) => f.a || !k.name.startsWith(".")))
          o.o(
            `${fmt(ctx.vfs.node(p + "/" + c.name) || {}, p)} ${t === "." && !pos.length ? "./" : t.replace(/\/$/, "") + "/"}${c.name}\n`,
          );
        continue;
      }
      o.o(`${fmt(ctx.vfs.node(p), p)} ${t}\n`);
    }
    return o.r();
  };

  /* ================================================================ system information */
  C.tty = (argv, ctx) => {
    const s = ctx.io && ctx.io.stdin;
    return !s || s.tty ? "/dev/pts/0\n" : { stdout: "not a tty\n", stderr: "", code: 1 };
  };
  C.logname = (argv, ctx) => {
    const fr = ctx.shell.stack.find((x) => x.host === ctx.host.name);
    return (fr ? fr.user : ctx.host.user) + "\n";
  };
  C.hostid = (argv, ctx) => U.hex(ctx.host.ip, 8) + "\n";
  const GETCONF = {
    PAGE_SIZE: "4096",
    PAGESIZE: "4096",
    LONG_BIT: "64",
    ARG_MAX: "2097152",
    CLK_TCK: "100",
    OPEN_MAX: "1024",
    CHILD_MAX: "31503",
    HOST_NAME_MAX: "64",
    LOGIN_NAME_MAX: "256",
    PATH_MAX: "4096",
    NAME_MAX: "255",
    LINE_MAX: "2048",
    GNU_LIBC_VERSION: "glibc 2.35",
    INT_MAX: "2147483647",
  };
  C.getconf = (argv, ctx) => {
    const g = Object.assign({}, GETCONF, {
      _NPROCESSORS_ONLN: String(ctx.host.cpus),
      _NPROCESSORS_CONF: String(ctx.host.cpus),
      _PHYS_PAGES: String(Math.round((ctx.host.memMiB * 1048576) / 4096)),
      GNU_LIBC_VERSION: ctx.host.os === "rhel" ? "glibc 2.34" : "glibc 2.35",
    });
    if (argv[0] === "-a") return join(Object.entries(g).map(([k, v]) => `${k.padEnd(34)} ${v}`));
    const k = argv.filter((a) => !a.startsWith("/"))[0];
    if (!k) return fail("Usage: getconf [-v SPEC] VAR\n  or:  getconf [-v SPEC] PATH_VAR PATH");
    return k in g ? g[k] + "\n" : fail(`getconf: Unrecognized variable \`${k}'`);
  };
  // locales: generated set per host (Ubuntu: locale-gen, RHEL: glibc-langpack-*)
  const locSet = (h) => (h.locales = h.locales || new Set(["C.utf8", "en_US.utf8"]));
  const normLoc = (l) => String(l).replace(/\.UTF-?8$/i, ".utf8");
  const sysLang = (h) => {
    const t = h.vfs.read(h.os === "rhel" ? "/etc/locale.conf" : "/etc/default/locale") || "";
    const m = t.match(/^LANG="?([^"\n]+)"?/m);
    return m ? m[1] : "C.UTF-8";
  };
  const hasLoc = (h, l) => {
    const n = normLoc(l);
    return (
      locSet(h).has(n) ||
      n === "C" ||
      n === "POSIX" ||
      (h.os === "rhel" && /^ja_JP/.test(n) && h.pkgs.has("glibc-langpack-ja"))
    );
  };
  C.locale = (argv, ctx) => {
    const h = ctx.host;
    if (argv.includes("-a"))
      return join(
        ["C", "C.utf8", "POSIX"]
          .concat(
            [...locSet(h)].filter((l) => l !== "C.utf8"),
            h.os === "rhel" && h.pkgs.has("glibc-langpack-ja") ? ["ja_JP.eucjp", "ja_JP.utf8"] : [],
          )
          .sort(),
      );
    const env = ctx.env || {};
    const lang = env.LANG ?? "C.UTF-8";
    const all = env.LC_ALL || "";
    const o = out();
    if (!hasLoc(h, lang))
      o.e(
        `locale: Cannot set LC_CTYPE to default locale: No such file or directory\nlocale: Cannot set LC_MESSAGES to default locale: No such file or directory\nlocale: Cannot set LC_ALL to default locale: No such file or directory`,
        0,
      );
    const cats = [
      "LC_CTYPE",
      "LC_NUMERIC",
      "LC_TIME",
      "LC_COLLATE",
      "LC_MONETARY",
      "LC_MESSAGES",
      "LC_PAPER",
      "LC_NAME",
      "LC_ADDRESS",
      "LC_TELEPHONE",
      "LC_MEASUREMENT",
      "LC_IDENTIFICATION",
    ];
    o.o(
      join(
        [`LANG=${lang}`, `LANGUAGE=${env.LANGUAGE || ""}`].concat(
          cats.map((c) => (env[c] ? `${c}=${env[c]}` : `${c}="${all || lang}"`)),
          [`LC_ALL=${all}`],
        ),
      ),
    );
    return o.r();
  };
  C["locale-gen"] = (argv, ctx) => {
    const h = ctx.host;
    if (!root(ctx)) return fail("/usr/sbin/locale-gen: line 41: /etc/locale.gen: Permission denied");
    const req = argv.filter((a) => !a.startsWith("-"));
    const o = out();
    o.o("Generating locales (this might take a while)...\n");
    for (const l of req.length ? req : [...locSet(h)].filter((x) => x !== "C.utf8")) {
      if (!/^[a-z]{2}_[A-Z]{2}(\.[\w-]+)?$/.test(l)) {
        o.e(`Error: '${l}' is not a supported language or locale`);
        continue;
      }
      locSet(h).add(normLoc(l.includes(".") ? l : l + ".UTF-8"));
      o.o(`  ${l.includes(".") ? l : l + ".UTF-8"}... done\n`);
    }
    o.o("Generation complete.\n");
    return o.r();
  };
  C["update-locale"] = (argv, ctx) => {
    if (!root(ctx)) return fail("/usr/sbin/update-locale: Permission denied");
    const kv = argv.filter((a) => a.includes("="));
    for (const a of kv)
      if (!hasLoc(ctx.host, a.split("=")[1])) return fail(`*** update-locale: Error: invalid locale settings:  ${a}`);
    const cur = ctx.vfs.read("/etc/default/locale") || "";
    let t = cur;
    for (const a of kv) {
      const [k] = a.split("=");
      t = new RegExp(`^${k}=`, "m").test(t) ? t.replace(new RegExp(`^${k}=.*$`, "m"), a) : t + a + "\n";
    }
    ctx.vfs.write("/etc/default/locale", t);
    return "";
  };
  C.localectl = (argv, ctx) => {
    const h = ctx.host;
    const [verb = "status", ...rest] = argv.filter((a) => !a.startsWith("--"));
    if (verb === "status")
      return `System Locale: LANG=${sysLang(h)}\n    VC Keymap: ${h.keymap || (h.os === "rhel" ? "us" : "n/a")}\n   X11 Layout: ${h.os === "rhel" ? "us" : "us"}\n${h.os === "rhel" ? "" : "    X11 Model: pc105\n"}`;
    if (verb === "list-locales")
      return join(
        ["C.UTF-8"]
          .concat(
            [...locSet(h)].filter((l) => l !== "C.utf8").map((l) => l.replace(".utf8", ".UTF-8")),
            h.os === "rhel" && h.pkgs.has("glibc-langpack-ja") ? ["ja_JP.UTF-8"] : [],
          )
          .sort(),
      );
    if (verb === "list-keymaps") return "jp106\nus\n";
    if (verb === "set-locale") {
      if (!root(ctx)) return fail("Failed to issue method call: Access denied");
      const kv = rest.map((a) => (a.includes("=") ? a : "LANG=" + a));
      for (const a of kv) {
        const l = a.split("=")[1];
        if (!hasLoc(h, l))
          return fail(
            `Failed to issue method call: Locale ${l} not installed, refusing.${h.os === "rhel" ? IG.t("\nℹ RHEL は sudo dnf install glibc-langpack-ja で日本語ロケールを追加します。") : IG.t("\nℹ Ubuntu は sudo locale-gen ja_JP.UTF-8 で生成してから設定します。")}`,
          );
      }
      ctx.vfs.write(h.os === "rhel" ? "/etc/locale.conf" : "/etc/default/locale", kv.join("\n") + "\n");
      return "";
    }
    if (verb === "set-keymap") {
      if (!root(ctx)) return fail("Failed to issue method call: Access denied");
      h.keymap = rest[0];
      return "";
    }
    return fail(`Unknown command verb ${verb}.`);
  };
  const ICONV = [
    "UTF-8",
    "UTF8",
    "ASCII",
    "US-ASCII",
    "SHIFT_JIS",
    "SJIS",
    "CP932",
    "EUC-JP",
    "ISO-2022-JP",
    "ISO-8859-1",
    "LATIN1",
    "UTF-16",
    "UTF-16LE",
    "UTF-16BE",
    "WINDOWS-1252",
  ];
  C.iconv = (argv, ctx) => {
    const { f, pos } = opts(argv, "ftco", ["from-code", "to-code", "output"]);
    if (f.l || f.list) return ICONV.map((x) => x + "//").join("\n") + "\n";
    const from = String(f.f || f["from-code"] || "UTF-8").toUpperCase(),
      to = String(f.t || f["to-code"] || "UTF-8").toUpperCase();
    for (const c of [from, to])
      if (!ICONV.includes(c.replace(/\/\/.*$/, "")))
        return fail(
          `iconv: ${c === from ? "conversion from" : "conversion to"} \`${c}' is not supported\nTry \`iconv --help' or \`iconv --usage' for more information.`,
        );
    const r = readIn(ctx, pos, "iconv");
    if (r.errs.length)
      return fail(
        r.errs[0].replace(
          /^iconv: (.+): No such file or directory$/,
          "iconv: cannot open input file `$1': No such file or directory",
        ),
      );
    let t = r.text;
    if (/^(US-)?ASCII/.test(to)) {
      const bad = [...t].findIndex((ch) => ch.charCodeAt(0) > 127);
      if (bad >= 0) {
        if (/TRANSLIT/.test(to)) t = t.replace(/[^\x00-\x7f]/g, "?");
        else if (/IGNORE/.test(to)) t = t.replace(/[^\x00-\x7f]/g, "");
        else
          return fail(
            `iconv: illegal input sequence at position ${bytesOf(t.slice(0, bad)).length}`,
            1,
            t.slice(0, bad),
          );
      }
    }
    if (f.o || f.output) {
      const dest = ctx.resolve(f.o || f.output);
      const why = IG.cannotWrite(ctx, dest);
      if (why) return { stdout: "", stderr: `iconv: cannot open output file: ${why}\n`, code: 1 };
      ctx.vfs.write(dest, t, { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user) });
      return "";
    }
    return t;
  };
  C.ldd = (argv, ctx) => {
    const o = out();
    const pos = argv.filter((a) => !a.startsWith("-"));
    if (!pos.length) return fail("ldd: missing file arguments\nTry `ldd --help' for more information.");
    const lib = ctx.host.os === "rhel" ? "/lib64" : "/lib/x86_64-linux-gnu";
    for (const t of pos) {
      const p = ctx.resolve(t);
      if (!ctx.vfs.exists(p)) {
        o.e(`ldd: ${t}: No such file or directory`);
        continue;
      }
      const c = ctx.vfs.read(p) || "";
      if (!c.startsWith("\x7fELF")) {
        if (pos.length > 1) o.o(`${t}:\n`);
        o.e("\tnot a dynamic executable", 1);
        continue;
      }
      const extra = /\/(ls|cp|mv|mkdir|id|stat)$/.test(p)
        ? ["libselinux.so.1", "libpcre2-8.so.0"]
        : /(curl|wget)$/.test(p)
          ? ["libcurl.so.4", "libssl.so.3", "libcrypto.so.3", "libz.so.1"]
          : /(ssh|scp)$/.test(p)
            ? ["libcrypto.so.3", "libz.so.1", "libgssapi_krb5.so.2"]
            : [];
      const addr = (k) => `0x00007f${U.hex(t + k, 10)}`;
      if (pos.length > 1) o.o(`${t}:\n`);
      o.o(
        join(
          [`\tlinux-vdso.so.1 (${addr("vdso")})`].concat(
            extra.map((l) => `\t${l} => ${lib}/${l} (${addr(l)})`),
            [`\tlibc.so.6 => ${lib}/libc.so.6 (${addr("libc")})`, `\t/lib64/ld-linux-x86-64.so.2 (${addr("ld")})`],
          ),
        ),
      );
    }
    return o.r();
  };
  C.lspci = (argv, ctx) => {
    const extra = (ctx.host.disks || []).map(
      (d, i) => `00:${(0x1c + i).toString(16)}.0 Non-Volatile memory controller: Amazon.com, Inc. NVMe EBS Controller`,
    );
    const rows = [
      "00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma]",
      "00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]",
      "00:01.3 Non-VGA unclassified device: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)",
      "00:03.0 VGA compatible controller: Amazon.com, Inc. Device 1111",
      "00:04.0 Non-Volatile memory controller: Amazon.com, Inc. NVMe EBS Controller",
      "00:05.0 Ethernet controller: Amazon.com, Inc. Elastic Network Adapter (ENA)",
    ].concat(extra);
    if (argv.includes("-k"))
      return join(
        rows.flatMap((r) =>
          [
            r,
            /Ethernet/.test(r)
              ? "\tKernel driver in use: ena\n\tKernel modules: ena"
              : /NVMe/.test(r)
                ? "\tKernel driver in use: nvme\n\tKernel modules: nvme"
                : null,
          ].filter(Boolean),
        ),
      );
    return join(rows);
  };
  C.lsusb = () => "";
  C.dmidecode = (argv, ctx) => {
    if (!root(ctx))
      return fail(
        "# dmidecode 3.3\n/sys/firmware/dmi/tables/smbios_entry_point: Permission denied\nScanning /dev/mem for entry point.\n/dev/mem: Permission denied",
      );
    const h = ctx.host;
    const S = {
      "system-manufacturer": "Amazon EC2",
      "system-product-name": h.cpus >= 4 ? "m5.xlarge" : "t3.large",
      "system-serial-number": "ec2" + U.hex(h.name, 6) + "-" + U.hex(h.name + 1, 4),
      "system-uuid":
        "ec2" +
        U.hex(h.name, 5) +
        "-" +
        U.hex(h.name + 2, 4) +
        "-" +
        U.hex(h.name + 3, 4) +
        "-" +
        U.hex(h.name + 4, 4) +
        "-" +
        U.hex(h.name + 5, 12),
      "bios-vendor": "Amazon EC2",
      "bios-version": "1.0",
      "processor-version": "Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz",
    };
    const s = argv[argv.indexOf("-s") + 1];
    if (argv.includes("-s"))
      return s in S
        ? S[s] + "\n"
        : fail(`Invalid string keyword: ${s}\nValid string keywords are:\n  ${Object.keys(S).join("\n  ")}`, 2);
    const t = argv[argv.indexOf("-t") + 1];
    const sys = `Handle 0x0001, DMI type 1, 27 bytes\nSystem Information\n\tManufacturer: ${S["system-manufacturer"]}\n\tProduct Name: ${S["system-product-name"]}\n\tVersion: Not Specified\n\tSerial Number: ${S["system-serial-number"]}\n\tUUID: ${S["system-uuid"]}\n\tWake-up Type: Power Switch\n\tSKU Number: Not Specified\n\tFamily: Not Specified\n`;
    const mem = `Handle 0x0008, DMI type 17, 40 bytes\nMemory Device\n\tTotal Width: 72 bits\n\tData Width: 64 bits\n\tSize: ${Math.round(h.memMiB / 1024)} GB\n\tForm Factor: DIMM\n\tType: DDR4\n\tSpeed: 2933 MT/s\n\tManufacturer: Not Specified\n`;
    const bios = `Handle 0x0000, DMI type 0, 24 bytes\nBIOS Information\n\tVendor: Amazon EC2\n\tVersion: 1.0\n\tRelease Date: 10/16/2017\n\tROM Size: 64 kB\n\tBIOS Revision: 1.0\n`;
    const head = "# dmidecode 3.3\nGetting SMBIOS data from sysfs.\nSMBIOS 2.7 present.\n\n";
    return (
      head +
      (argv.includes("-t")
        ? { system: sys, memory: mem, bios, 1: sys, 17: mem, 0: bios }[t] || sys
        : [bios, sys, mem].join("\n"))
    );
  };
  C.hwclock = (argv, ctx) =>
    root(ctx)
      ? IG.strftime("%F %T.", now(ctx)) + String(now(ctx) % 1000).padStart(3, "0") + "123+00:00\n"
      : fail(
          "hwclock: Cannot access the Hardware Clock via any known method.\nhwclock: Use the --verbose option to see the details of our search for an access method.",
        );
  C.loginctl = (argv, ctx) => {
    const h = ctx.host;
    const [verb = "list-sessions", arg] = argv.filter((a) => !a.startsWith("-"));
    const users = [...new Set(ctx.shell.stack.filter((f) => f.host === h.name).map((f) => f.user))];
    const uid = (u) => (h.users[u] || { uid: 0 }).uid;
    if (verb === "list-sessions")
      return `SESSION  UID USER     SEAT TTY\n${users.map((u, i) => `${String(i + 3).padStart(7)} ${String(uid(u)).padStart(4)} ${u.padEnd(8)}      pts/${i}`).join("\n")}\n\n${users.length} sessions listed.\n`;
    if (verb === "list-users")
      return ` UID USER\n${users.map((u) => `${String(uid(u)).padStart(4)} ${u}`).join("\n")}\n\n${users.length} users listed.\n`;
    if (verb === "enable-linger" || verb === "disable-linger") {
      const u = arg || ctx.user;
      if (!root(ctx) && u !== ctx.user) return fail("Could not enable linger: Access denied");
      const p = "/var/lib/systemd/linger/" + u;
      if (verb === "enable-linger") h.vfs.write(p, "", { mkdirs: true });
      else if (h.vfs.exists(p)) h.vfs.remove(p);
      return "";
    }
    if (verb === "show-user" || verb === "user-status")
      return `${arg || ctx.user} (${uid(arg || ctx.user)})\n           Since: ${IG.strftime("%a %F %T UTC", h.bootAt)}\n           State: active\n        Sessions: *3\n          Linger: ${h.vfs.exists("/var/lib/systemd/linger/" + (arg || ctx.user)) ? "yes" : "no"}\n            Unit: user-${uid(arg || ctx.user)}.slice\n`;
    return hint(
      IG.t(`loginctl {0} はこのシミュレータでは未対応です（list-sessions / list-users / enable-linger に対応）。`, {
        0: verb,
      }),
    );
  };

  /* ================================================================ at */
  function atTime(spec, base) {
    const s = spec.toLowerCase().trim();
    let m;
    if ((m = s.match(/^now(?:\s*\+\s*(\d+)\s*(min(?:ute)?s?|hours?|days?|weeks?))?$/)))
      return base + (m[1] ? Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2][0]] : 0);
    const d = new Date(base);
    const day = (hh, mm, plus) => {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
      return t <= base || plus ? t + 86400e3 * (plus || 1) * (t <= base || plus ? 1 : 0) : t;
    };
    if (s === "midnight") return day(0, 0);
    if (s === "noon") return day(12, 0);
    if (s === "teatime") return day(16, 0);
    if ((m = s.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?(?:\s+(tomorrow))?$/))) {
      let hh = Number(m[1]) % 24;
      if (m[3] === "pm" && hh < 12) hh += 12;
      if (m[3] === "am" && hh === 12) hh = 0;
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, Number(m[2] || 0));
      return m[4] ? t + 86400e3 : t <= base ? t + 86400e3 : t;
    }
    if (s === "tomorrow") return base + 86400e3;
    return null;
  }
  const atJobs = (h) => (h.atJobs = h.atJobs || { seq: 0, list: [] });
  C.at = (argv, ctx) => {
    const h = ctx.host;
    if (argv[0] === "-l") return C.atq(argv.slice(1), ctx);
    if (argv[0] === "-r" || argv[0] === "-d") return C.atrm(argv.slice(1), ctx);
    if (argv[0] === "-c") {
      const j = atJobs(h).list.find((x) => String(x.id) === argv[1]);
      return j
        ? `#!/bin/sh\n# atrun uid=${(h.users[j.user] || {}).uid} gid=${(h.users[j.user] || {}).gid}\n# mail ${j.user} 0\numask 22\ncd ${j.cwd} || {\n\t echo 'Execution directory inaccessible' >&2\n\t exit 1\n}\n${j.cmd}\n`
        : fail(`Cannot find jobid ${argv[1]}`);
    }
    let file = null;
    const words = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-f") file = argv[++i];
      else if (!/^-[mMqv]$/.test(argv[i])) words.push(argv[i]);
    }
    if (!words.length) return fail("Garbled time");
    const t = atTime(words.join(" "), now(ctx));
    if (t === null) return fail("syntax error. Last token seen: " + words[words.length - 1] + "\nGarbled time");
    const cmd = file ? ctx.vfs.read(ctx.resolve(file)) : ctx.hasStdin ? ctx.stdin : null;
    if (cmd === null || cmd === undefined)
      return hint(
        file
          ? `${file}: No such file or directory`
          : IG.t(
              "at の対話入力（at> プロンプト）は再現できません。echo 'コマンド' | at now + 5 minutes のようにパイプで渡してください。",
            ),
      );
    const j = { id: ++atJobs(h).seq, t, user: ctx.user, cmd: String(cmd).trim(), cwd: ctx.cwd, queue: "a" };
    atJobs(h).list.push(j);
    return {
      stdout: "",
      stderr: IG.t(
        `warning: commands will be executed using /bin/sh\njob {0} at {1}\nℹ シミュレータ内では時刻が来てもジョブは実行されません（atq / atrm で管理の練習ができます）。\n`,
        { 0: j.id, 1: IG.strftime("%a %b %e %T %Y", t) },
      ),
      code: 0,
    };
  };
  C.batch = (argv, ctx) => C.at(["now"].concat(argv), ctx);
  C.atq = (argv, ctx) =>
    join(
      atJobs(ctx.host)
        .list.filter((j) => root(ctx) || j.user === ctx.user)
        .map((j) => `${j.id}\t${IG.strftime("%a %b %e %T %Y", j.t)} ${j.queue} ${j.user}`),
    );
  C.atrm = (argv, ctx) => {
    const J = atJobs(ctx.host);
    const o = out();
    for (const id of argv) {
      const j = J.list.find((x) => String(x.id) === id);
      if (!j || (!root(ctx) && j.user !== ctx.user)) {
        o.e(`Cannot find jobid ${id}`);
        continue;
      }
      J.list = J.list.filter((x) => x !== j);
    }
    return o.r();
  };

  /* ================================================================ accounts */
  C.chsh = (argv, ctx) => {
    const h = ctx.host;
    if (argv.includes("-l") || argv.includes("--list-shells"))
      return (
        ctx.vfs
          .read("/etc/shells")
          .split("\n")
          .filter((l) => l.startsWith("/"))
          .join("\n") + "\n"
      );
    const { f, pos } = opts(argv, "s", ["shell"]);
    const user = pos[0] || ctx.user;
    if (!h.users[user]) return fail(`chsh: user '${user}' does not exist`);
    const sh = f.s || f.shell;
    if (!sh)
      return hint(IG.t("chsh の対話入力は再現できません。chsh -s /bin/bash のように -s でシェルを指定してください。"));
    if (!root(ctx))
      return user !== ctx.user
        ? fail(`chsh: you may not change the shell for '${user}'.`)
        : hint(
            IG.t(
              "一般ユーザーの chsh はパスワード入力が必要なため再現できません。sudo chsh -s <シェル> <ユーザー> を使ってください。",
            ),
          );
    const shells = (ctx.vfs.read("/etc/shells") || "").split("\n");
    if (!ctx.vfs.exists(sh)) return fail(`chsh: ${sh} does not exist`);
    if (!shells.includes(sh)) return fail(`chsh: ${sh} is an invalid shell`);
    h.users[user].shell = sh;
    h.syncAccounts();
    return "";
  };
  C.chfn = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, "frwh", ["full-name"]);
    const user = pos[0] || ctx.user;
    if (!h.users[user]) return fail(`chfn: user '${user}' does not exist`);
    if (!root(ctx))
      return hint(
        IG.t(
          '一般ユーザーの chfn はパスワード入力が必要なため再現できません。sudo chfn -f "氏名" <ユーザー> を使ってください。',
        ),
      );
    const name = f.f || f["full-name"];
    if (name === undefined) return hint(IG.t('chfn の対話入力は再現できません。-f "氏名" で指定してください。'));
    const g = (h.users[user].gecos || "").split(",");
    g[0] = name;
    h.users[user].gecos = g.join(",").replace(/,+$/, "") + (g.length > 1 ? "" : ",,,");
    h.syncAccounts();
    return "";
  };
  C.lastb = (argv, ctx) =>
    root(ctx)
      ? `${(ctx.host.failedLogins || []).map((l) => l + "\n").join("")}\nbtmp begins ${IG.strftime("%a %b %e %T %Y", ctx.host.bootAt)}\n`
      : fail("lastb: cannot open /var/log/btmp: Permission denied");

  /* ================================================================ monitoring */
  const sysHead = (ctx) =>
    `Linux ${ctx.host.kernel} (${ctx.host.hostname}) \t${IG.strftime("%m/%d/%Y", now(ctx))} \t_x86_64_\t(${ctx.host.cpus} CPU)\n`;
  const rnd = (seed, a, b) => a + ((U.hash(seed) % 1000) / 1000) * (b - a);
  C.sar = (argv, ctx) => {
    const h = ctx.host;
    const nums = argv.filter((a) => /^\d+$/.test(a)).map(Number);
    const mode = argv.includes("-r")
      ? "r"
      : argv.includes("-n")
        ? "n"
        : argv.includes("-b")
          ? "b"
          : argv.includes("-q")
            ? "q"
            : "u";
    let times;
    if (nums.length) times = Array.from({ length: nums[1] || 1 }, (_, i) => now(ctx) + (i + 1) * nums[0] * 1000);
    else {
      const collecting = h.os === "rhel" || /ENABLED="true"/.test(h.vfs.read("/etc/default/sysstat") || "");
      if (!collecting)
        return fail(
          `Cannot open /var/log/sysstat/sa${IG.strftime("%d", now(ctx))}: No such file or directory\nPlease check if data collecting is enabled`,
        );
      const mid = now(ctx) - (now(ctx) % 86400e3);
      times = [];
      for (let t = mid + 600e3; t < now(ctx); t += 600e3) times.push(t);
      times = times.slice(-12);
    }
    const T = (t) => IG.strftime("%T", t);
    const row = (t, i) => {
      const s = h.name + t + i;
      if (mode === "r") {
        const m = IG.memInfo(h);
        return `${T(t)}    ${String(m.free).padStart(9)} ${String(m.avail).padStart(9)} ${String(m.used).padStart(9)} ${((m.used / m.total) * 100).toFixed(2).padStart(9)} ${String(Math.round(m.buff * 0.1)).padStart(9)} ${String(Math.round(m.buff * 0.9)).padStart(9)} ${String(m.used * 2).padStart(9)} ${(((m.used * 2) / m.total) * 100).toFixed(2).padStart(9)} ${String(Math.round(m.used * 1.2)).padStart(9)} ${String(Math.round(m.buff * 0.6)).padStart(9)} ${String(Math.round(rnd(s, 0, 300))).padStart(9)}`;
      }
      if (mode === "q")
        return `${T(t)}    ${String(Math.round(rnd(s, 0, 2))).padStart(7)} ${String(140 + i).padStart(9)} ${rnd(
          s + 1,
          0,
          0.3,
        )
          .toFixed(2)
          .padStart(9)} ${rnd(s + 2, 0, 0.3)
          .toFixed(2)
          .padStart(9)} ${rnd(s + 3, 0, 0.3)
          .toFixed(2)
          .padStart(9)} ${"0".padStart(9)}`;
      if (mode === "b")
        return `${T(t)}    ${rnd(s, 0.5, 6).toFixed(2).padStart(9)} ${rnd(s + 1, 0, 1)
          .toFixed(2)
          .padStart(9)} ${rnd(s + 2, 0.5, 5)
          .toFixed(2)
          .padStart(9)} ${"0.00".padStart(9)} ${rnd(s + 3, 0, 40)
          .toFixed(2)
          .padStart(9)} ${rnd(s + 4, 10, 90)
          .toFixed(2)
          .padStart(9)} ${"0.00".padStart(9)}`;
      if (mode === "n")
        return [
          `${T(t)}           lo ${rnd(s, 0, 2).toFixed(2).padStart(9)} ${rnd(s, 0, 2).toFixed(2).padStart(9)} ${rnd(
            s + 1,
            0,
            0.2,
          )
            .toFixed(2)
            .padStart(9)} ${rnd(s + 1, 0, 0.2)
            .toFixed(2)
            .padStart(9)} ${"0.00".padStart(9)} ${"0.00".padStart(9)} ${"0.00".padStart(9)} ${"0.00".padStart(9)}`,
          `${T(t)}         eth0 ${rnd(s + 2, 1, 9)
            .toFixed(2)
            .padStart(9)} ${rnd(s + 3, 1, 9)
            .toFixed(2)
            .padStart(9)} ${rnd(s + 4, 0.1, 2)
            .toFixed(2)
            .padStart(9)} ${rnd(s + 5, 0.1, 2)
            .toFixed(2)
            .padStart(9)} ${"0.00".padStart(9)} ${"0.00".padStart(9)} ${"0.00".padStart(9)} ${"0.00".padStart(9)}`,
        ].join("\n");
      const us = rnd(s, 0.2, 3),
        sy = rnd(s + 1, 0.1, 1),
        wa = rnd(s + 2, 0, 0.3),
        st = rnd(s + 3, 0, 0.2);
      return `${T(t)}        all ${us.toFixed(2).padStart(9)} ${"0.00".padStart(9)} ${sy.toFixed(2).padStart(9)} ${wa.toFixed(2).padStart(9)} ${st.toFixed(2).padStart(9)} ${(100 - us - sy - wa - st).toFixed(2).padStart(9)}`;
    };
    const hdr = {
      u: "        CPU     %user     %nice   %system   %iowait    %steal     %idle",
      r: "kbmemfree   kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit   %commit  kbactive   kbinact   kbdirty",
      q: "  runq-sz  plist-sz   ldavg-1   ldavg-5  ldavg-15   blocked",
      b: "      tps      rtps      wtps      dtps   bread/s   bwrtn/s   bdscd/s",
      n: "        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil",
    }[mode];
    const rows = times.map(row);
    let avg = "";
    if (mode === "u") {
      const v = rows.map((r) => r.trim().split(/\s+/).slice(2).map(Number));
      avg =
        "\nAverage:        all " +
        v[0].map((_, k) => (v.reduce((a, r) => a + r[k], 0) / v.length).toFixed(2).padStart(9)).join(" ");
    }
    return `${sysHead(ctx)}\n${T(times[0] - (nums[0] || 600) * 1000)}${mode === "u" || mode === "n" ? "" : "    "}${hdr}\n${rows.join("\n")}${avg}\n`;
  };
  C.pidstat = (argv, ctx) => {
    const ps = IG.allProcs ? IG.allProcs(ctx) : [];
    const p = argv.includes("-p")
      ? ps.filter((x) => String(x.pid) === argv[argv.indexOf("-p") + 1])
      : ps.filter((x) => x.cpu > 0);
    const t = IG.strftime("%T", now(ctx));
    return `${sysHead(ctx)}\n${t}      UID       PID    %usr %system  %guest   %wait    %CPU   CPU  Command\n${p.map((x) => `${t} ${String((ctx.host.users[x.user] || { uid: 0 }).uid).padStart(8)} ${String(x.pid).padStart(9)} ${(x.cpu * 0.7).toFixed(2).padStart(7)} ${(x.cpu * 0.3).toFixed(2).padStart(7)} ${"0.00".padStart(7)} ${"0.00".padStart(7)} ${x.cpu.toFixed(2).padStart(7)} ${String(x.pid % ctx.host.cpus).padStart(5)}  ${String(x.cmd).split(/\s/)[0].split("/").pop().replace(/:$/, "")}`).join("\n")}\n`;
  };
  const procOf = (ctx, pid) => (IG.allProcs ? IG.allProcs(ctx) : []).find((x) => String(x.pid) === String(pid));
  C.pmap = (argv, ctx) => {
    const pid = argv.filter((a) => /^\d+$/.test(a))[0];
    const p = procOf(ctx, pid);
    if (!p) return { stdout: "", stderr: "", code: 1 };
    if (!root(ctx) && p.user !== ctx.user) return `${pid}:   ${p.cmd}\n total             0K\n`;
    const bin = String(p.cmd).split(/\s/)[0].split("/").pop();
    const base = 0x55d1c0a00000 + (U.hash(pid) % 4096) * 4096;
    const r = [
      [base, 152, "r----", bin],
      [base + 0x26000, 1024, "r-x--", bin],
      [base + 0x126000, 396, "r----", bin],
      [base + 0x1a0000, Math.max(132, p.rss || 400), "rw---", "  [ anon ]"],
      [0x7f3a1c000000, 2048, "r-x--", "libc.so.6"],
      [0x7f3a1c228000, 16, "rw---", "libc.so.6"],
      [0x7ffd52e40000, 132, "rw---", "  [ stack ]"],
    ];
    const total = r.reduce((a, x) => a + x[1], 0) + Math.round((p.vsz || 0) / 2);
    return `${pid}:   ${p.cmd}\n${r.map(([a, k, m, n]) => `${a.toString(16).padStart(16, "0")} ${String(k + "K").padStart(6)} ${m} ${n}`).join("\n")}\n total ${String(total + "K").padStart(16)}\n`;
  };
  // ionice [-c CLASS] [-n LEVEL] [-t] COMMAND… runs the command (I/O priority has no effect here);
  // ionice -p PID and a bare ionice show a class
  C.ionice = (argv, ctx) => {
    if (!argv.length) return "none: prio 0\n";
    let i = 0;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-p" || a === "--pid") {
        const p = procOf(ctx, argv[i + 1]);
        return p ? "none: prio 0\n" : fail(`ionice: ioprio_get failed: No such process`);
      }
      if (a === "-c" || a === "-n" || a === "--class" || a === "--classdata") i++;
      else if (!/^-[cn]\w+$|^--(class|classdata)=|^-t$|^--ignore$/.test(a)) break;
    }
    if (i >= argv.length) return "";
    return { stdout: "", stderr: "", code: ctx.shell.invoke(argv.slice(i), ctx.io) };
  };
  C.taskset = (argv, ctx) => {
    if (argv.includes("-p") || argv.includes("-cp")) {
      const pid = argv[argv.length - 1];
      const p = procOf(ctx, pid);
      if (!p) return fail(`taskset: failed to get pid ${pid}'s affinity: No such process`);
      return argv.includes("-cp")
        ? `pid ${pid}'s current affinity list: 0-${ctx.host.cpus - 1}\n`
        : `pid ${pid}'s current affinity mask: ${((1 << ctx.host.cpus) - 1).toString(16)}\n`;
    }
    return hint(
      IG.t(
        "taskset によるコマンドの起動は、このシミュレータでは CPU 割り当てを反映せずにそのまま実行した扱いになります。taskset -p <PID> で確認できます。",
      ),
    );
  };
  C.chrt = (argv, ctx) => {
    if (argv.includes("-p")) {
      const pid = argv[argv.length - 1];
      const p = procOf(ctx, pid);
      if (!p) return fail(`chrt: failed to get pid ${pid}'s policy: No such process`);
      return `pid ${pid}'s current scheduling policy: SCHED_OTHER\npid ${pid}'s current scheduling priority: 0\n`;
    }
    if (argv.includes("-m"))
      return "SCHED_OTHER min/max priority\t: 0/0\nSCHED_FIFO min/max priority\t: 1/99\nSCHED_RR min/max priority\t: 1/99\nSCHED_BATCH min/max priority\t: 0/0\nSCHED_IDLE min/max priority\t: 0/0\nSCHED_DEADLINE min/max priority\t: 0/0\n";
    return root(ctx)
      ? hint(IG.t("chrt によるリアルタイム優先度での起動は再現していません（chrt -p <PID> で確認できます）。"))
      : fail("chrt: failed to set pid 0's policy: Operation not permitted");
  };

  /* ================================================================ terminal */
  C.tput = (argv, ctx) => {
    const [cap, n] = argv;
    const caps = {
      cols: "120",
      lines: "40",
      colors: "256",
      sgr0: "\x1b(B\x1b[m",
      bold: "\x1b[1m",
      smul: "\x1b[4m",
      rmul: "\x1b[24m",
      rev: "\x1b[7m",
      clear: "\x1b[H\x1b[2J",
      setaf: `\x1b[3${n || 0}m`,
      setab: `\x1b[4${n || 0}m`,
      longname: "xterm with 256 colors",
    };
    if (!cap) return fail("usage: tput [-V] [-S] [-T term] capname", 2);
    return cap in caps
      ? cap === "cols" || cap === "lines" || cap === "colors" || cap === "longname"
        ? caps[cap] + "\n"
        : caps[cap]
      : fail(`tput: unknown terminfo capability '${cap}'`, 4);
  };
  C.stty = (argv, ctx) => {
    const s = ctx.io && ctx.io.stdin;
    if (s && !s.tty) return fail("stty: 'standard input': Inappropriate ioctl for device");
    if (argv[0] === "size") return "40 120\n";
    if (argv[0] === "-a")
      return "speed 38400 baud; rows 40; columns 120; line = 0;\nintr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>; eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R; werase = ^W; lnext = ^V; discard = ^O; min = 1; time = 0;\n-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts\n-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff -iuclc -ixany -imaxbel iutf8\nopost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff0\nisig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt echoctl echoke -flusho -extproc\n";
    if (!argv.length) return "speed 38400 baud; line = 0;\n-brkint -imaxbel iutf8\n";
    return "";
  };
  C.wall = (argv, ctx) => {
    const msg = argv.filter((a) => !a.startsWith("-")).join(" ") || (ctx.hasStdin ? ctx.stdin : "");
    return `\nBroadcast message from ${ctx.user}@${ctx.host.hostname} (pts/0) (${IG.strftime("%a %b %e %T %Y", now(ctx))}):\n\n${String(msg).replace(/\n$/, "")}\n\n`;
  };
  C.mesg = (argv) => (argv[0] === "n" || argv[0] === "y" ? "" : "is y\n");
  C.write = () =>
    hint(
      IG.t(
        "write は他のユーザーの端末にメッセージを送るコマンドです。ログインしている他の利用者がいないため再現していません（全員への通知は wall）。",
      ),
    );
  C.script = () =>
    hint(IG.t("script（端末操作の記録）はこのシミュレータでは未対応です。history コマンドで履歴を確認できます。"));

  /* ================================================================ ssh helpers */
  const KEYTYPE = {
    "ssh-ed25519": "AAAAC3NzaC1lZDI1NTE5AAAAI",
    "ecdsa-sha2-nistp256": "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBB",
    "ssh-rsa": "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
  };
  C["ssh-keyscan"] = (argv, ctx) => {
    const { f, pos } = opts(argv, "tpT");
    const o = out();
    const types = f.t
      ? String(f.t)
          .split(",")
          .map((t) =>
            t === "ed25519" ? "ssh-ed25519" : t === "rsa" ? "ssh-rsa" : t === "ecdsa" ? "ecdsa-sha2-nistp256" : t,
          )
      : ["ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"];
    for (const hostName of pos) {
      const r = IG.tcpConnect(ctx, hostName, Number(f.p || 22));
      if (r.unresolved) {
        o.e(`getaddrinfo ${hostName}: Name or service not known`, 0);
        continue;
      }
      if (!r.ok) {
        o.e(
          `${hostName}: ${r.timeout ? "Connection timed out" : r.unreachable ? "No route to host" : "Connection refused"}`,
          0,
        );
        continue;
      }
      for (const t of types) {
        o.e(`# ${hostName}:${f.p || 22} SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10`, 0);
        o.o(
          `${f.H ? "|1|" + U.hex(hostName, 27) + "=|" + U.hex(hostName + 1, 27) + "=" : hostName} ${t} ${KEYTYPE[t] + U.hex(hostName + t, 40)}\n`,
        );
      }
    }
    return o.r();
  };
  // agents live on the host (keyed by socket) because `eval $(ssh-agent)` runs ssh-agent in a subshell
  const agents = (h) => (h.sshAgents = h.sshAgents || {});
  C["ssh-agent"] = (argv, ctx) => {
    const env = ctx.env || {};
    if (argv.includes("-k")) {
      if (!env.SSH_AGENT_PID) return fail("SSH_AGENT_PID not set, cannot kill agent");
      delete agents(ctx.host)[env.SSH_AUTH_SOCK];
      return `unset SSH_AUTH_SOCK;\nunset SSH_AGENT_PID;\necho Agent pid ${env.SSH_AGENT_PID} killed;\n`;
    }
    const pid = 2000 + (U.hash(ctx.host.name + now(ctx) + Math.random()) % 5000);
    const sock = `/tmp/ssh-${U.hex(String(now(ctx)) + pid, 12)}/agent.${pid - 1}`;
    agents(ctx.host)[sock] = { pid, user: ctx.user, keys: [] };
    return `SSH_AUTH_SOCK=${sock}; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=${pid}; export SSH_AGENT_PID;\necho Agent pid ${pid};\n`;
  };
  C["ssh-add"] = (argv, ctx) => {
    const env = ctx.env || {};
    const ag = env.SSH_AUTH_SOCK && agents(ctx.host)[env.SSH_AUTH_SOCK];
    if (!ag) return fail("Could not open a connection to your authentication agent.", 2);
    const home = ctx.shell.home ? ctx.shell.home() : ctx.host.home;
    if (argv.includes("-l") || argv.includes("-L"))
      return ag.keys.length
        ? join(ag.keys.map((k) => `256 SHA256:${U.hex(k, 43)} ${ctx.user}@${ctx.host.hostname} (ED25519)`))
        : fail("The agent has no identities.");
    if (argv.includes("-D")) {
      ag.keys = [];
      return { stdout: "", stderr: "All identities removed.\n", code: 0 };
    }
    const sh = { sshAgent: ag };
    const files = argv.filter((a) => !a.startsWith("-"));
    const o = out();
    for (const k of files.length ? files : ["~/.ssh/id_ed25519"]) {
      const p = ctx.resolve(k.replace(/^~/, home));
      if (!ctx.vfs.exists(p)) {
        if (files.length) o.e(`${k}: No such file or directory`);
        continue;
      }
      const n = ctx.vfs.node(p);
      if (n.mode & 0o077) {
        o.e(
          `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nPermissions 0${(n.mode & 0o777).toString(8)} for '${p}' are too open.\nIt is required that your private key files are NOT accessible by others.\nThis private key will be ignored.`,
        );
        continue;
      }
      sh.sshAgent.keys.push(p);
      o.e(`Identity added: ${p} (${ctx.user}@${ctx.host.hostname})`, 0);
    }
    return o.r();
  };
  C.sftp = () =>
    hint(IG.t("sftp の対話モードは再現していません。ファイル転送には scp または rsync を使ってください。"));

  /* ================================================================ network tools */
  C.ethtool = (argv, ctx) => {
    const pos = argv.filter((a) => !a.startsWith("-"));
    const dev = pos[0];
    if (!dev) return fail("ethtool: bad command line argument(s)\nFor more information run ethtool -h", 1);
    if (dev !== "eth0" && dev !== "lo" && dev !== "ens5")
      return fail(`netlink error: no device matches name (offset 24)\nnetlink error: No such device`, 75);
    if (argv.includes("-i"))
      return `driver: ena\nversion: ${ctx.host.kernel}\nfirmware-version: \nexpansion-rom-version: \nbus-info: 0000:00:05.0\nsupports-statistics: yes\nsupports-test: no\nsupports-eeprom-access: no\nsupports-register-dump: no\nsupports-priv-flags: yes\n`;
    if (argv.includes("-S"))
      return `NIC statistics:\n     total_resets: 0\n     tx_timeout: 0\n     queue_0_tx_cnt: ${1000 + (U.hash(ctx.host.name) % 90000)}\n     queue_0_rx_cnt: ${2000 + (U.hash(ctx.host.name + 1) % 90000)}\n     bw_in_allowance_exceeded: 0\n     bw_out_allowance_exceeded: 0\n     pps_allowance_exceeded: 0\n     conntrack_allowance_exceeded: 0\n`;
    return `Settings for ${dev}:\n\tSupported ports: [  ]\n\tSupported link modes:   Not reported\n\tSupported pause frame use: No\n\tSupports auto-negotiation: No\n\tSupported FEC modes: Not reported\n\tAdvertised link modes:  Not reported\n\tAdvertised pause frame use: No\n\tAdvertised auto-negotiation: No\n\tAdvertised FEC modes: Not reported\n\tSpeed: Unknown!\n\tDuplex: Unknown! (255)\n\tAuto-negotiation: off\n\tPort: Other\n\tPHYAD: 0\n\tTransceiver: internal\n${root(ctx) ? "" : "netlink error: Operation not permitted\n"}\tLink detected: yes\n`;
  };
  C.mtr = (argv, ctx) => {
    const pos = argv.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
    const target = pos[0];
    if (!target)
      return fail(
        "mtr: No hostname specified\nusage: mtr [-BfhvrwctglxspQomniuT46] [--help] [--version] [--report] ...",
      );
    const r = IG.tcpConnect(ctx, target, 22);
    if (r.unresolved) return fail(`mtr: Failed to resolve host: ${target}: Name or service not known`);
    const ip = r.ip || target;
    const hops =
      ip === ctx.host.ip || /^127\./.test(ip)
        ? [[ip, 0.1]]
        : /^10\./.test(ip)
          ? [[ip, 0.4]]
          : [
              ["10.0.1.1", 0.3],
              ["???", null],
            ];
    const rep = `Start: ${IG.strftime("%FT%T+0000", now(ctx))}\nHOST: ${ctx.host.hostname.padEnd(26)}Loss%   Snt   Last   Avg  Best  Wrst StDev\n${hops.map(([h2, ms], i) => `  ${i + 1}.|-- ${h2.padEnd(25)}${ms === null ? "100.0" : "  0.0"}%    10 ${ms === null ? "   0.0   0.0   0.0   0.0   0.0" : `${ms.toFixed(1).padStart(6)}${(ms * 1.1).toFixed(1).padStart(6)}${(ms * 0.8).toFixed(1).padStart(6)}${(ms * 1.6).toFixed(1).padStart(6)}${(ms * 0.2).toFixed(1).padStart(6)}`}`).join("\n")}\n`;
    return argv.some((a) => /^(-r|--report|-rw|-c)$/.test(a))
      ? rep
      : { stdout: rep, stderr: IG.t("ℹ mtr の対話画面の代わりに --report 相当の結果を表示しました。\n"), code: 0 };
  };
  C.arping = (argv, ctx) => {
    if (!root(ctx)) return fail("arping: socket: Operation not permitted");
    const pos = argv.filter((a, i) => !a.startsWith("-") && !/^-[cIw]$/.test(argv[i - 1]));
    const target = pos[0];
    const c = argv.includes("-c") ? Number(argv[argv.indexOf("-c") + 1]) : 3;
    const r = IG.tcpConnect(ctx, target, 22);
    const ip = r.ip || target;
    const h2 = Object.values(ctx.world.hosts).find((x) => x.ip === ip);
    if (!h2)
      return fail(
        `ARPING ${ip} from ${ctx.host.ip} eth0\nSent ${c} probes (${c} broadcast(s))\nReceived 0 response(s)`,
        1,
        "",
      );
    return `ARPING ${ip} from ${ctx.host.ip} eth0\n${Array.from({ length: c }, () => `Unicast reply from ${ip} [${h2.mac.toUpperCase()}]  0.6${U.hash(ip) % 9}ms`).join("\n")}\nSent ${c} probes (1 broadcast(s))\nReceived ${c} response(s)\n`;
  };
  C.whois = (argv, ctx) =>
    fail(
      IG.t(
        `whois: getaddrinfo(whois.iana.org): Temporary failure in name resolution\nℹ 訓練環境はインターネットに出られないため whois は使えません。`,
      ),
      2,
    );

  /* nmcli (NetworkManager) — read-only views plus persistent-property edits that don't move the address */
  function nm(h) {
    if (h._nm) return h._nm;
    const t = h.vfs.read("/etc/NetworkManager/system-connections/cloud-init-eth0.nmconnection") || "";
    const uuid = (t.match(/^uuid=(.+)$/m) || [, U.hex(h.name, 8) + "-0000-0000-0000-" + U.hex(h.name, 12)])[1];
    return (h._nm = {
      name: "System eth0",
      uuid,
      props: {
        "connection.id": "System eth0",
        "connection.uuid": uuid,
        "connection.type": "802-3-ethernet",
        "connection.interface-name": "eth0",
        "connection.autoconnect": "yes",
        "ipv4.method": "auto",
        "ipv4.dns": "--",
        "ipv4.dns-search": "--",
        "ipv4.addresses": "--",
        "ipv4.gateway": "--",
        "ipv4.ignore-auto-dns": "no",
        "ipv6.method": "auto",
      },
    });
  }
  C.nmcli = (argv, ctx) => {
    const h = ctx.host;
    const a = argv.filter((x) => !/^-(t|p|f|g|terse|pretty)$/.test(x));
    const [obj = "", verb = "", ...rest] = a;
    const N = nm(h);
    const o1 = obj
      .replace(/^(g|ge|gen|gene|gener|genera)$/, "general")
      .replace(/^(d|de|dev|devi|devic)$/, "device")
      .replace(/^(c|co|con|conn|conne|connec|connect|connecti|connectio)$/, "connection")
      .replace(/^(n|ne|net|netw|netwo|networ)$/, "networking");
    const addr = `${h.ip}/24`;
    if (!obj)
      return `eth0: connected to ${N.name}\n        "Amazon.com Elastic Network Adapter (ENA)"\n        ethernet (ena), ${h.mac.toUpperCase()}, hw, mtu 9001\n        ip4 default\n        inet4 ${addr}\n        route4 default via 10.0.1.1 metric 100\n        route4 10.0.1.0/24 metric 100\n\nlo: connected (externally) to lo\n        "lo"\n        loopback (unknown), 00:00:00:00:00:00, sw, mtu 65536\n        inet4 127.0.0.1/8\n\nDNS configuration:\n        servers: 10.0.0.2\n        domains: lab.local\n        interface: eth0\n\nUse "nmcli device show" to get complete information about known devices and\n"nmcli connection show" to get an overview on active connection profiles.\n`;
    if (o1 === "general")
      return "STATE      CONNECTIVITY  WIFI-HW  WIFI     WWAN-HW  WWAN    \nconnected  full          missing  enabled  missing  enabled \n";
    if (o1 === "networking") return "enabled\n";
    if (o1 === "device") {
      if (!verb || verb === "status")
        return "DEVICE  TYPE      STATE                   CONNECTION  \neth0    ethernet  connected               System eth0 \nlo      loopback  connected (externally)  lo          \n";
      if (verb === "show")
        return `GENERAL.DEVICE:                         eth0\nGENERAL.TYPE:                           ethernet\nGENERAL.HWADDR:                         ${h.mac.toUpperCase()}\nGENERAL.MTU:                            9001\nGENERAL.STATE:                          100 (connected)\nGENERAL.CONNECTION:                     ${N.name}\nIP4.ADDRESS[1]:                         ${addr}\nIP4.GATEWAY:                            10.0.1.1\nIP4.ROUTE[1]:                           dst = 0.0.0.0/0, nh = 10.0.1.1, mt = 100\nIP4.DNS[1]:                             10.0.0.2\nIP4.DOMAIN[1]:                          lab.local\n`;
      return hint(IG.t(`nmcli device {0} はこのシミュレータでは未対応です。`, { 0: verb }));
    }
    if (o1 === "connection") {
      if (!verb || (verb === "show" && !rest.length))
        return `NAME         UUID                                  TYPE      DEVICE \n${N.name}  ${N.uuid}  ethernet  eth0   \nlo           ${U.hex("lo", 8)}-${U.hex("lo1", 4)}-${U.hex("lo2", 4)}-${U.hex("lo3", 4)}-${U.hex("lo4", 12)}  loopback  lo     \n`;
      const id = rest[0] === "id" ? rest[1] : rest[0];
      const known = id === N.name || id === N.uuid || id === "eth0";
      if (verb === "show")
        return known
          ? join(Object.entries(N.props).map(([k, v]) => `${(k + ":").padEnd(40)}${v}`)) +
              `GENERAL.STATE:                          activated\nIP4.ADDRESS[1]:                         ${addr}\nIP4.GATEWAY:                            10.0.1.1\n`
          : fail(`Error: ${id} - no such connection profile.`, 10);
      if (verb === "modify" || verb === "mod") {
        if (!root(ctx)) return fail(`Error: Failed to modify connection '${N.name}': Insufficient privileges`, 4);
        if (!known) return fail(`Error: unknown connection '${id}'.`, 10);
        const kv = rest.slice(rest[0] === "id" ? 2 : 1);
        for (let i = 0; i < kv.length; i += 2) {
          const k = kv[i].replace(/^\+/, "");
          let v = kv[i + 1];
          if (k === "ipv4.dns" && kv[i].startsWith("+") && N.props[k] !== "--") v = N.props[k] + "," + v;
          if (!(k in N.props) && !/^(ipv4|ipv6|connection)\./.test(k))
            return fail(`Error: invalid property '${k}': invalid property name.`, 2);
          if (k === "ipv4.method" && !/^(auto|manual|disabled|link-local|shared)$/.test(v))
            return fail(
              `Error: failed to modify ipv4.method: '${v}' not among [auto, disabled, link-local, manual, shared].`,
              2,
            );
          N.props[k] = v === undefined ? "--" : v.replace(/\s+/g, ",");
        }
        if (N.props["ipv4.method"] === "manual" && N.props["ipv4.addresses"] === "--")
          return fail(
            `Error: Failed to modify connection '${N.name}': ipv4.addresses: this property cannot be empty for 'method=manual'`,
            4,
          );
        return "";
      }
      if (verb === "up" || verb === "reload") {
        if (!root(ctx)) return fail("Error: Connection activation failed: Not authorized to control networking.", 4);
        const changed = N.props["ipv4.addresses"] !== "--" && !N.props["ipv4.addresses"].startsWith(h.ip + "/");
        return verb === "reload"
          ? ""
          : {
              stdout: `Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/2)\n`,
              stderr: changed
                ? IG.t(
                    "ℹ IP アドレスの変更は他のホストとの通信に影響するため、このシミュレータでは実際のアドレスは変えません（設定値は保存されます）。\n",
                  )
                : "",
              code: 0,
            };
      }
      if (verb === "down")
        return root(ctx)
          ? hint(IG.t("eth0 を停止すると SSH 接続が切れて操作できなくなるため、訓練環境では実行しません。"))
          : fail("Error: Not authorized to deactivate connections.", 4);
      return hint(
        IG.t(`nmcli connection {0} はこのシミュレータでは未対応です（show / modify / up に対応）。`, { 0: verb }),
      );
    }
    return fail(`Error: argument '${obj}' not understood. Try passing --help instead.`, 2);
  };
  /* netplan (Ubuntu) — validates the YAML like `netplan generate`; apply never moves the address */
  const NP_KEYS = new Set([
    "network",
    "version",
    "renderer",
    "ethernets",
    "bonds",
    "bridges",
    "vlans",
    "wifis",
    "dhcp4",
    "dhcp6",
    "addresses",
    "routes",
    "to",
    "via",
    "metric",
    "nameservers",
    "search",
    "match",
    "macaddress",
    "name",
    "set-name",
    "mtu",
    "gateway4",
    "gateway6",
    "optional",
    "interfaces",
    "parameters",
    "mode",
    "id",
    "link",
    "dhcp4-overrides",
    "use-dns",
    "use-routes",
    "route-metric",
    "link-local",
    "accept-ra",
    "critical",
    "wakeonlan",
    "table",
    "scope",
    "on-link",
    "type",
    "from",
    "routing-policy",
    "priority",
  ]);
  function netplanCheck(ctx) {
    const h = ctx.host;
    const files = h.vfs
      .walk("/etc/netplan")
      .filter((p) => /\.ya?ml$/.test(p))
      .sort();
    const warn = [],
      errs = [];
    for (const p of files) {
      const n = h.vfs.node(p);
      if (n.mode & 0o077)
        warn.push(
          `** (generate:${2000 + (U.hash(p) % 3000)}): WARNING **: ${IG.strftime("%T", now(ctx))}.123: Permissions for ${p} are too open. Netplan configuration should NOT be accessible by others.`,
        );
      const text = n.content;
      let doc;
      try {
        doc = IG.yaml.parse(text);
      } catch (e) {
        const m = String(e.message).match(/line (\d+)/);
        errs.push(`${p}:${m ? m[1] : 1}:1: Invalid YAML: ${String(e.message).replace(/^.*?:\s*/, "")}`);
        continue;
      }
      const ls = text.split("\n");
      for (let i = 0; i < ls.length; i++) {
        const t = ls[i].match(/^(\s*)([\w-]+):/);
        if (!t) continue;
        const inMatch = ls
          .slice(0, i)
          .reverse()
          .find((l) => l.match(/^\s*[\w-]+:\s*$/) && l.search(/\S/) < t[1].length);
        if (inMatch && /^\s*(ethernets|bonds|bridges|vlans|wifis):\s*$/.test(inMatch)) continue;
        if (!NP_KEYS.has(t[2])) {
          errs.push(
            `${p}:${i + 1}:${t[1].length + 1}: Error in network definition: unknown key '${t[2]}'\n${ls[i]}\n${" ".repeat(t[1].length)}^`,
          );
          break;
        }
      }
      const eths = (doc && doc.network && doc.network.ethernets) || {};
      for (const [ifc, c] of Object.entries(eths)) {
        for (const a of (c && c.addresses) || [])
          if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(String(a)) && !/:/.test(String(a))) {
            errs.push(`${p}: Error in network definition: invalid prefix length in address '${a}'`);
          }
        if (c && c.gateway4)
          warn.push(
            `\n** (generate:${2000 + (U.hash(p) % 3000)}): WARNING **: ${IG.strftime("%T", now(ctx))}.124: \`gateway4\` has been deprecated, use default routes instead.\nSee the 'Default routes' section of the documentation for more details.`,
          );
        void ifc;
      }
    }
    return { warn, errs, files };
  }
  C.netplan = (argv, ctx) => {
    const verb = argv.filter((a) => !a.startsWith("-"))[0] || "";
    if (!verb)
      return fail(
        'You need to specify a command\nusage: /usr/sbin/netplan  [-h] [--debug]  ...\n\nNetwork configuration in YAML\n\noptions:\n  -h, --help  show this help message and exit\n  --debug     Enable debug messages\n\nAvailable commands:\n  \n    help      Show this help message\n    apply     Apply current netplan config to running system\n    generate  Generate backend specific configuration files from /etc/netplan/*.yaml\n    get       Get a setting by specifying a nested key like "ethernets.eth0.addresses", or "all"\n    info      Show available features\n    ip        Retrieve IP information from the system\n    set       Add new setting by specifying a dot-separated path to a key and its value\n    try       Try to apply a new netplan config to running system, with automatic rollback\n    status    Query networking state of the running system',
        1,
      );
    if (verb === "get") {
      const files = ctx.host.vfs
        .walk("/etc/netplan")
        .filter((p) => /\.ya?ml$/.test(p))
        .sort();
      if (!root(ctx) && files.some((p) => !ctx.shell.canRead(p)))
        return fail(`PermissionError: [Errno 13] Permission denied: '${files.find((p) => !ctx.shell.canRead(p))}'`);
      return files.map((p) => ctx.host.vfs.read(p).replace(/^#.*\n/gm, "")).join("");
    }
    if (verb === "status")
      return `     Online state: online\n    DNS Addresses: 127.0.0.53 (stub)\n       DNS Search: lab.local\n\n●  2: eth0 ethernet UP (networkd: eth0)\n      MAC Address: ${ctx.host.mac} (Amazon.com, Inc.)\n        Addresses: ${ctx.host.ip}/24 (dhcp)\n    DNS Addresses: 10.0.0.2\n       DNS Search: lab.local\n           Routes: default via 10.0.1.1 from ${ctx.host.ip} metric 100 (dhcp)\n                   10.0.1.0/24 from ${ctx.host.ip} metric 100 (link)\n\n1 inactive interfaces hidden. Use "--all" to show all.\n`;
    if (!/^(apply|generate|try)$/.test(verb))
      return hint(
        IG.t(`netplan {0} はこのシミュレータでは未対応です（get / generate / try / apply / status に対応）。`, {
          0: verb,
        }),
      );
    if (!root(ctx))
      return fail(
        verb === "generate"
          ? `PermissionError: [Errno 13] Permission denied: '/run/systemd/network'`
          : "Permission denied (try with sudo)",
      );
    const r = netplanCheck(ctx);
    const o = out();
    if (r.warn.length) o.e(r.warn.join("\n"), 0);
    if (r.errs.length) {
      o.e(r.errs.join("\n"), 1);
      return o.r();
    }
    if (verb === "try") {
      o.o(
        "Do you want to keep these settings?\n\n\nPress ENTER before the timeout to accept the new configuration\n\n\nChanges will revert in 120 seconds\nConfiguration accepted.\n",
      );
      o.e(IG.t("ℹ 確認待ちのタイムアウトは再現せず、そのまま受け入れた扱いにしました。"), 0);
    }
    const addrs = r.files.flatMap((p) => {
      try {
        return Object.values(((IG.yaml.parse(ctx.host.vfs.read(p)) || {}).network || {}).ethernets || {}).flatMap(
          (c) => (c && c.addresses) || [],
        );
      } catch (e) {
        return [];
      }
    });
    if (verb !== "generate" && addrs.length && !addrs.some((a) => String(a).startsWith(ctx.host.ip + "/")))
      o.e(
        IG.t(
          "ℹ 静的 IP の変更は他のホストとの通信に影響するため、このシミュレータでは実際のアドレスは変えません（設定の検証のみ行いました）。",
        ),
        0,
      );
    return o.r();
  };
  C.resolvectl = (argv, ctx) => {
    const [verb = "status", name] = argv.filter((a) => !a.startsWith("-"));
    if (verb === "status")
      return `Global\n       Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported\nresolv.conf mode: stub\n\nLink 2 (eth0)\n    Current Scopes: DNS\n         Protocols: +DefaultRoute +LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported\nCurrent DNS Server: 10.0.0.2\n       DNS Servers: 10.0.0.2\n        DNS Domain: lab.local\n`;
    if (verb === "dns") return "Global:\nLink 2 (eth0): 10.0.0.2\n";
    if (verb === "domain") return "Global:\nLink 2 (eth0): lab.local\n";
    if (verb === "flush-caches") return root(ctx) ? "" : fail("Failed to flush caches: Access denied");
    if (verb === "statistics")
      return "DNSSEC supported by current servers: no\n\nTransactions\nCurrent Transactions: 0\n  Total Transactions: 214\n\nCache\n  Current Cache Size: 12\n          Cache Hits: 88\n        Cache Misses: 126\n";
    if (verb === "query") {
      const ip = ctx.world.resolveName ? ctx.world.resolveName(name, ctx.from) : null;
      if (!ip) return fail(`${name}: resolve call failed: '${name}' not found`);
      return `${name}: ${ip}                          -- link: eth0\n\n-- Information acquired via protocol DNS in 1.2ms.\n-- Data is authenticated: no; Data was acquired via local or encrypted transport: no\n-- Data from: network\n`;
    }
    return hint(IG.t(`resolvectl {0} はこのシミュレータでは未対応です。`, { 0: verb }));
  };
  C.networkctl = (argv, ctx) => {
    const verb = argv.filter((a) => !a.startsWith("-"))[0] || "list";
    if (verb === "list")
      return "IDX LINK TYPE     OPERATIONAL SETUP     \n  1 lo   loopback carrier     unmanaged\n  2 eth0 ether    routable    configured\n\n2 links listed.\n";
    if (verb === "status")
      return `●        State: routable\n  Online state: online\n       Address: ${ctx.host.ip} on eth0\n                fe80::${U.hex(ctx.host.name, 4)}:${U.hex(ctx.host.name + 1, 4)} on eth0\n       Gateway: 10.0.1.1 on eth0\n           DNS: 10.0.0.2\n Search Domains: lab.local\n`;
    return hint(IG.t(`networkctl {0} はこのシミュレータでは未対応です。`, { 0: verb }));
  };

  /* ================================================================ openssl */
  // generated certificates carry their metadata inside the base64 body, so x509 can read them back
  const pem = (type, body) =>
    `-----BEGIN ${type}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${type}-----\n`;
  const b64 = (s) => U.b64(s);
  function readCert(text) {
    const m = String(text || "").match(/-----BEGIN CERTIFICATE-----\n([\s\S]+?)\n-----END CERTIFICATE-----/);
    if (!m) return null;
    const raw = U.unb64(m[1].replace(/\s+/g, "")) || "";
    const j = raw.match(/^SIMCERT(\{.*\})/);
    if (j) {
      try {
        return JSON.parse(j[1]);
      } catch (e) {
        return null;
      }
    }
    return {
      subject: "CN = unknown",
      issuer: "CN = unknown",
      notBefore: 0,
      notAfter: 0,
      serial: U.hex(m[1], 40),
      opaque: true,
    };
  }
  const certDate = (t) => IG.strftime("%b %e %T %Y GMT", t);
  const subj = (s) =>
    String(s || "/CN=localhost")
      .split("/")
      .filter(Boolean)
      .map((kv) => kv.replace("=", " = "))
      .join(", ");
  C.openssl = (argv, ctx) => {
    const h = ctx.host;
    const [sub, ...a] = argv;
    const val = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
    const writeOut = (file, text, mode) => {
      const p = ctx.resolve(file);
      if (!ctx.shell.canWrite(p)) return false;
      ctx.vfs.write(p, text, { owner: ctx.user, group: h.primaryGroup(ctx.user), mode: mode ?? 0o644 });
      return true;
    };
    if (!sub || sub === "version")
      return (
        (h.os === "rhel"
          ? "OpenSSL 3.0.7 1 Nov 2022 (Library: OpenSSL 3.0.7 1 Nov 2022)"
          : "OpenSSL 3.0.2 15 Mar 2022 (Library: OpenSSL 3.0.2 15 Mar 2022)") + "\n"
      );
    if (sub === "rand") {
      const n = Number(a.filter((x) => /^\d+$/.test(x)).pop() || 16);
      // more than the terminal can hold: stopped like any runaway output, before building it
      if (n > 1e6) throw new IG.bash.Flow("abort", 0, 130);
      const bytes = Array.from({ length: n }, (_, i) => U.hash(now(ctx) + ":" + i + Math.random()) & 255);
      if (a.includes("-hex")) return bytes.map((b) => b.toString(16).padStart(2, "0")).join("") + "\n";
      if (a.includes("-base64")) return U.b64(String.fromCharCode(...bytes)) + "\n";
      return String.fromCharCode(...bytes);
    }
    if (sub === "passwd") {
      const alg = a.includes("-6")
        ? "6"
        : a.includes("-5")
          ? "5"
          : a.includes("-1")
            ? "1"
            : a.includes("-apr1")
              ? "apr1"
              : "6";
      const salt = val("-salt") || U.hex(String(now(ctx) + Math.random()), 16).slice(0, 16);
      const pw =
        a.filter((x) => !x.startsWith("-") && x !== salt).pop() || (a.includes("-stdin") ? ctx.stdin.trim() : null);
      if (pw === null)
        return hint(
          IG.t('パスワードの対話入力は再現できません。openssl passwd -6 "パスワード" のように引数で渡してください。'),
        );
      return `$${alg}$${salt}$${U.b64(IG.hash.sha512(salt + pw))
        .replace(/[+=]/g, ".")
        .slice(0, alg === "6" ? 86 : 43)}\n`;
    }
    if (sub === "genrsa" || sub === "genpkey") {
      const bits = Number(a.filter((x) => /^\d+$/.test(x)).pop() || 2048);
      // the key text grows with the size: capped at the largest size OpenSSL recommends, with its warning
      const warn =
        bits > 16384
          ? `Warning: It is not recommended to use more than 16384 bit for RSA keys.\n         Your key size is ${bits}! Larger key size may behave not as expected.\n`
          : "";
      const key = pem(
        "PRIVATE KEY",
        b64("SIMKEY" + U.hex(now(ctx) + String(Math.random()), Math.round(Math.min(bits, 16384) / 2.5))),
      );
      const file = val("-out");
      if (!file) return { stdout: key, stderr: warn, code: 0 };
      return writeOut(file, key, 0o600)
        ? { stdout: "", stderr: warn, code: 0 }
        : fail(`Can't open "${file}" for writing, Permission denied`);
    }
    if (sub === "req") {
      if (!a.includes("-x509")) {
        const file = val("-out");
        const csr = pem(
          "CERTIFICATE REQUEST",
          b64("SIMCSR" + JSON.stringify({ subject: subj(val("-subj")) }) + U.hex(String(now(ctx)), 200)),
        );
        if (!val("-subj"))
          return hint(
            IG.t('証明書情報の対話入力は再現できません。-subj "/C=JP/O=Example/CN=www.example.com" を付けてください。'),
          );
        if (a.includes("-newkey") && val("-keyout"))
          writeOut(val("-keyout"), pem("PRIVATE KEY", b64("SIMKEY" + U.hex(String(now(ctx) + 1), 800))), 0o600);
        return file ? (writeOut(file, csr) ? "" : fail(`Can't open "${file}" for writing, Permission denied`)) : csr;
      }
      if (!val("-subj"))
        return hint(IG.t('証明書情報の対話入力は再現できません。-subj "/CN=www.example.com" を付けてください。'));
      const days = Number(val("-days") || 30);
      const meta = {
        subject: subj(val("-subj")),
        issuer: subj(val("-subj")),
        notBefore: now(ctx),
        notAfter: now(ctx) + days * 86400e3,
        serial: U.hex(String(now(ctx)) + val("-subj"), 40),
        san: (a.find((x) => /^subjectAltName=/.test(x)) || "").replace(/^subjectAltName=/, "") || null,
      };
      const cert = pem("CERTIFICATE", b64("SIMCERT" + JSON.stringify(meta) + U.hex(meta.serial, 400)));
      const o = out();
      if (val("-keyout")) {
        if (!writeOut(val("-keyout"), pem("PRIVATE KEY", b64("SIMKEY" + U.hex(meta.serial + "k", 800))), 0o600)) {
          o.e(`Can't open "${val("-keyout")}" for writing, Permission denied`);
          return o.r();
        }
        o.e(".....+.....+++++++++++++++++++++++++++++++*......+.....+++++++++++++++++++++++++++++++*\n-----", 0);
      }
      if (val("-out")) {
        if (!writeOut(val("-out"), cert)) o.e(`Can't open "${val("-out")}" for writing, Permission denied`);
      } else o.o(cert);
      return o.r();
    }
    if (sub === "x509") {
      const file = val("-in");
      const text = file ? ctx.vfs.read(ctx.resolve(file)) : ctx.stdin;
      if (file && text === undefined)
        return fail(
          `Could not open file or uri for loading certificate from ${file}\n40F7B2C1A87F0000:error:16000069:STORE routines:ossl_store_get0_loader_int:unregistered scheme:../crypto/store/store_register.c:237:scheme=file\n40F7B2C1A87F0000:error:80000002:system library:file_open:No such file or directory:../providers/implementations/storemgmt/file_store.c:267:calling stat(${file})`,
        );
      const c = readCert(text);
      if (!c) return fail(`Could not read certificate from ${file || "<stdin>"}\nUnable to load certificate`);
      const o = out();
      if (c.opaque) o.e(IG.t("ℹ このシミュレータで作成していない証明書のため、内容の一部は表示できません。"), 0);
      if (a.includes("-subject")) o.o(`subject=${c.subject}\n`);
      if (a.includes("-issuer")) o.o(`issuer=${c.issuer}\n`);
      if (a.includes("-serial")) o.o(`serial=${c.serial.toUpperCase()}\n`);
      if (a.includes("-dates") || a.includes("-startdate")) o.o(`notBefore=${certDate(c.notBefore)}\n`);
      if (a.includes("-dates") || a.includes("-enddate")) o.o(`notAfter=${certDate(c.notAfter)}\n`);
      if (a.includes("-fingerprint"))
        o.o(
          `${a.includes("-sha256") ? "sha256" : "SHA1"} Fingerprint=${(IG.hash[a.includes("-sha256") ? "sha256" : "sha1"](c.serial).toUpperCase().match(/../g) || []).join(":")}\n`,
        );
      if (a.includes("-checkend")) {
        const s = Number(val("-checkend"));
        const ok = c.notAfter > now(ctx) + s * 1000;
        o.o(ok ? "Certificate will not expire\n" : "Certificate will expire\n");
        o.code = ok ? 0 : 1;
      }
      if (a.includes("-text"))
        o.o(
          `Certificate:\n    Data:\n        Version: 3 (0x2)\n        Serial Number:\n            ${(c.serial.match(/../g) || []).join(":")}\n        Signature Algorithm: sha256WithRSAEncryption\n        Issuer: ${c.issuer}\n        Validity\n            Not Before: ${certDate(c.notBefore)}\n            Not After : ${certDate(c.notAfter)}\n        Subject: ${c.subject}\n        Subject Public Key Info:\n            Public Key Algorithm: rsaEncryption\n                Public-Key: (2048 bit)\n        X509v3 extensions:\n            X509v3 Subject Key Identifier: \n                ${(
            U.hex(c.serial + "s", 40)
              .toUpperCase()
              .match(/../g) || []
          ).join(
            ":",
          )}\n${c.san ? `            X509v3 Subject Alternative Name: \n                ${c.san}\n` : ""}            X509v3 Basic Constraints: critical\n                CA:TRUE\n    Signature Algorithm: sha256WithRSAEncryption\n`,
        );
      if (!a.includes("-noout")) o.o(text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/)[0]);
      return o.r();
    }
    if (sub === "s_client") {
      const target = val("-connect") || "localhost:443";
      const [host2, port = "443"] = target.split(":");
      const r = IG.tcpConnect(ctx, host2, Number(port));
      if (r.unresolved) return fail(`${host2}: Name or service not known\nconnect:errno=2`);
      if (!r.ok)
        return fail(
          `4067B2C1A87F0000:error:8000006F:system library:BIO_connect:Connection refused:../crypto/bio/bio_sock2.c:125:calling connect()\n4067B2C1A87F0000:error:10000067:BIO routines:BIO_connect:connect error:../crypto/bio/bio_sock2.c:127:\nconnect:errno=111`,
        );
      const name = val("-servername") || host2;
      return `CONNECTED(00000003)\ndepth=0 CN = ${name}\nverify error:num=18:self-signed certificate\nverify return:1\n---\nCertificate chain\n 0 s:CN = ${name}\n   i:CN = ${name}\n   a:PKEY: rsaEncryption, 2048 (bit); sigalg: RSA-SHA256\n   v:NotBefore: ${certDate(ctx.host.bootAt)}; NotAfter: ${certDate(ctx.host.bootAt + 365 * 86400e3)}\n---\nServer certificate\nsubject=CN = ${name}\nissuer=CN = ${name}\n---\nNew, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384\nServer public key is 2048 bit\nVerify return code: 18 (self-signed certificate)\n---\nDONE\n`;
    }
    if (sub === "dgst") {
      const t = a.filter((x) => !x.startsWith("-")).pop();
      const c = t ? ctx.vfs.read(ctx.resolve(t)) : ctx.stdin;
      const alg = a.includes("-md5")
        ? "md5"
        : a.includes("-sha1")
          ? "sha1"
          : a.includes("-sha512")
            ? "sha512"
            : "sha256";
      return `${alg.toUpperCase().replace("SHA", "SHA2-").replace("SHA2-1", "SHA1").replace("MD5", "MD5")}(${t || "stdin"})= ${IG.hash[alg](c || "")}\n`;
    }
    if (sub === "base64" || (sub === "enc" && a.includes("-base64")))
      return C.base64(a.includes("-d") ? ["-d"] : [], ctx);
    return hint(
      IG.t(
        `openssl {0} はこのシミュレータでは未対応です（version / rand / passwd / genrsa / req / x509 / s_client / dgst に対応）。`,
        { 0: sub },
      ),
    );
  };

  /* ================================================================ service clients */
  const svcActive = (h, s) => h.services && h.services[s] === "active";
  C.apache2ctl = (argv, ctx) => {
    const h = ctx.host;
    const a = argv[0] || "";
    const sn =
      /ServerName\s+\S/.test(h.vfs.read("/etc/apache2/apache2.conf") || "") ||
      h.vfs.walk("/etc/apache2/conf-enabled").some((p) => /ServerName\s+\S/.test(h.vfs.read(p) || ""));
    const warn = sn
      ? ""
      : `AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using ${h.ip}. Set the 'ServerName' directive globally to suppress this message\n`;
    if (a === "configtest" || a === "-t") {
      const bad = h.vfs
        .walk("/etc/apache2/sites-enabled")
        .map((p) => [p, h.vfs.read(p) || ""])
        .find(([, t]) => (t.match(/<VirtualHost/g) || []).length !== (t.match(/<\/VirtualHost>/g) || []).length);
      return bad
        ? fail(
            `${warn}AH00526: Syntax error on line ${bad[1].split("\n").length} of ${bad[0]}:\n${bad[0]}:1: <VirtualHost> was not closed.`,
          )
        : { stdout: "", stderr: warn + "Syntax OK\n", code: 0 };
    }
    if (a === "-S")
      return {
        stdout: `VirtualHost configuration:\n*:80                   ${h.hostname} (/etc/apache2/sites-enabled/000-default.conf:1)\nServerRoot: "/etc/apache2"\nMain DocumentRoot: "/var/www/html"\nMain ErrorLog: "/var/log/apache2/error.log"\nMutex default: dir="/var/run/apache2/" mechanism=default \nPidFile: "/var/run/apache2/apache2.pid"\nDefine: DUMP_VHOSTS\nDefine: DUMP_RUN_CFG\nUser: name="www-data" id=33\nGroup: name="www-data" id=33\n`,
        stderr: warn,
        code: 0,
      };
    if (a === "-M")
      return {
        stdout:
          "Loaded Modules:\n core_module (static)\n so_module (static)\n watchdog_module (static)\n http_module (static)\n log_config_module (static)\n logio_module (static)\n version_module (static)\n unixd_module (static)\n access_compat_module (shared)\n alias_module (shared)\n auth_basic_module (shared)\n authz_core_module (shared)\n dir_module (shared)\n mime_module (shared)\n mpm_event_module (shared)\n reqtimeout_module (shared)\n setenvif_module (shared)\n status_module (shared)\n" +
          (h.vfs.exists("/etc/apache2/mods-enabled/rewrite.load") ? " rewrite_module (shared)\n" : "") +
          (h.vfs.exists("/etc/apache2/mods-enabled/ssl.load") ? " ssl_module (shared)\n" : ""),
        stderr: warn,
        code: 0,
      };
    if (a === "-v") return "Server version: Apache/2.4.52 (Ubuntu)\nServer built:   2024-07-17T18:57:26\n";
    if (/^(start|stop|restart|graceful|reload)$/.test(a))
      return C.systemctl([a === "graceful" ? "reload" : a, "apache2"], ctx);
    return fail(
      `Usage: /usr/sbin/apache2ctl start|stop|restart|graceful|graceful-stop|configtest|status|fullstatus|help`,
    );
  };
  C.apachectl = (argv, ctx) =>
    ctx.host.os === "rhel" ? C.httpd(argv[0] === "configtest" ? ["-t"] : argv, ctx) : C.apache2ctl(argv, ctx);
  function a2(kind, enable) {
    return (argv, ctx) => {
      const h = ctx.host;
      const dir = kind === "site" ? "sites" : kind === "mod" ? "mods" : "conf";
      const ext = kind === "site" || kind === "conf" ? ".conf" : ".load";
      const o = out();
      const names = argv.filter((a) => !a.startsWith("-"));
      if (!names.length) {
        o.e(
          IG.t(
            `Which {0} do you want to {1} (wildcards ok)?\nℹ 対話入力は再現できません。a2en{2} <名前> の形で指定してください。`,
            {
              0: kind === "mod" ? "module(s)" : kind === "site" ? "site(s)" : "conf(s)",
              1: enable ? "enable" : "disable",
              2: kind,
            },
          ),
        );
        return o.r();
      }
      if (!root(ctx)) {
        o.e(`ERROR: ${names[0]}: Permission denied`);
        return o.r();
      }
      for (const raw of names) {
        const n = raw.replace(new RegExp(ext.replace(".", "\\.") + "$"), "");
        const avail = `/etc/apache2/${dir}-available/${n}${ext}`,
          en = `/etc/apache2/${dir}-enabled/${n}${ext}`;
        if (!h.vfs.exists(avail)) {
          o.e(`ERROR: ${kind === "mod" ? "Module" : kind === "site" ? "Site" : "Conf"} ${n} does not exist!`);
          continue;
        }
        if (enable) {
          if (h.vfs.lexists(en)) {
            o.o(`${kind === "mod" ? "Module" : kind === "site" ? "Site" : "Conf"} ${n} already enabled\n`);
            continue;
          }
          h.vfs.mkdirp(VFS.parent(en));
          h.vfs.symlink(`../${dir}-available/${n}${ext}`, en);
          o.o(
            `Enabling ${kind === "mod" ? "module" : kind === "site" ? "site" : "conf"} ${n}.\nTo activate the new configuration, you need to run:\n  systemctl ${kind === "mod" ? "restart" : "reload"} apache2\n`,
          );
        } else {
          if (!h.vfs.lexists(en)) {
            o.o(`${kind === "mod" ? "Module" : kind === "site" ? "Site" : "Conf"} ${n} already disabled\n`);
            continue;
          }
          h.vfs.remove(en);
          o.o(
            `${kind === "mod" ? "Module" : kind === "site" ? "Site" : "Conf"} ${n} disabled.\nTo activate the new configuration, you need to run:\n  systemctl ${kind === "mod" ? "restart" : "reload"} apache2\n`,
          );
        }
      }
      return o.r();
    };
  }
  C.a2ensite = a2("site", true);
  C.a2dissite = a2("site", false);
  C.a2enmod = a2("mod", true);
  C.a2dismod = a2("mod", false);
  C.a2enconf = a2("conf", true);
  C.a2disconf = a2("conf", false);
  C.httpd = (argv, ctx) => {
    const h = ctx.host;
    if (argv.includes("-v"))
      return "Server version: Apache/2.4.57 (Red Hat Enterprise Linux)\nServer built:   Aug  5 2024 00:00:00\n";
    if (argv.includes("-t")) {
      const sn = /^\s*ServerName\s+\S/m.test(h.vfs.read("/etc/httpd/conf/httpd.conf") || "");
      return {
        stdout: "",
        stderr:
          (sn
            ? ""
            : `AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${h.hostname}. Set the 'ServerName' directive globally to suppress this message\n`) +
          "Syntax OK\n",
        code: 0,
      };
    }
    if (argv.includes("-M"))
      return "Loaded Modules:\n core_module (static)\n so_module (static)\n http_module (static)\n access_compat_module (shared)\n alias_module (shared)\n authz_core_module (shared)\n dir_module (shared)\n mime_module (shared)\n mpm_event_module (shared)\n systemd_module (shared)\n";
    return hint(IG.t("httpd を直接起動する代わりに sudo systemctl start httpd を使ってください。"));
  };
  C.chronyc = (argv, ctx) => {
    const verb = argv.filter((a) => !a.startsWith("-"))[0] || "";
    if (!svcActive(ctx.host, "chronyd") && !svcActive(ctx.host, "chrony")) return fail("506 Cannot talk to daemon");
    if (verb === "tracking")
      return `Reference ID    : A9FEA97B (169.254.169.123)\nStratum         : 4\nRef time (UTC)  : ${IG.strftime("%a %b %d %T %Y", now(ctx) - 64e3)}\nSystem time     : 0.000002315 seconds fast of NTP time\nLast offset     : +0.000001845 seconds\nRMS offset      : 0.000004118 seconds\nFrequency       : 12.418 ppm slow\nResidual freq   : +0.000 ppm\nSkew            : 0.011 ppm\nRoot delay      : 0.000316213 seconds\nRoot dispersion : 0.000387104 seconds\nUpdate interval : 64.2 seconds\nLeap status     : Normal\n`;
    if (verb === "sources")
      return `MS Name/IP address         Stratum Poll Reach LastRx Last sample               \n===============================================================================\n^* 169.254.169.123               3   6   377    38   +1105ns[+1302ns] +/-  171us\n${argv.includes("-v") ? "" : ""}`;
    if (verb === "sourcestats")
      return "Name/IP Address            NP  NR  Span  Frequency  Freq Skew  Offset  Std Dev\n==============================================================================\n169.254.169.123            21  11  1290     -0.001      0.006    -12ns  3612ns\n";
    if (verb === "makestep") return root(ctx) ? "200 OK\n" : fail("501 Not authorised");
    return hint(
      IG.t(`chronyc {0} はこのシミュレータでは未対応です（tracking / sources / sourcestats / makestep に対応）。`, {
        0: verb || IG.t("（対話モード）"),
      }),
    );
  };
  C["redis-cli"] = (argv, ctx) => {
    const h = ctx.host;
    const hostArg = argv.includes("-h") ? argv[argv.indexOf("-h") + 1] : "127.0.0.1";
    const port = argv.includes("-p") ? argv[argv.indexOf("-p") + 1] : "6379";
    const cmd = argv.filter((a, i) => !/^-[hpan]$/.test(a) && !/^-[hpan]$/.test(argv[i - 1]));
    const target =
      hostArg === "127.0.0.1" || hostArg === "localhost"
        ? h
        : Object.values(ctx.world.hosts).find((x) => x.name === hostArg || x.ip === hostArg);
    if (!target || !svcActive(target, "redis-server"))
      return fail(`Could not connect to Redis at ${hostArg}:${port}: Connection refused`);
    if (!cmd.length)
      return hint(
        IG.t(
          "redis-cli の対話モードは再現していません。redis-cli ping や redis-cli set key value のようにコマンドを続けて指定してください。",
        ),
      );
    const db = (target.redis = target.redis || {});
    const [c0, k, ...v] = cmd;
    switch (c0.toLowerCase()) {
      case "ping":
        return "PONG\n";
      case "set":
        db[k] = v.join(" ");
        return "OK\n";
      case "get":
        return k in db ? db[k] + "\n" : "(nil)\n";
      case "del": {
        const n = [k, ...v].filter((x) => x in db).length;
        [k, ...v].forEach((x) => delete db[x]);
        return `(integer) ${n}\n`;
      }
      case "keys":
        return Object.keys(db).length
          ? join(
              Object.keys(db)
                .filter((x) => IG.bash.globRe(k || "*").test(x))
                .map((x, i) => `${i + 1}) "${x}"`),
            )
          : "(empty array)\n";
      case "dbsize":
        return `(integer) ${Object.keys(db).length}\n`;
      case "info":
        return `# Server\r\nredis_version:7.0.15\r\nredis_mode:standalone\r\nos:Linux ${target.kernel} x86_64\r\ntcp_port:6379\r\nuptime_in_seconds:${Math.floor((now(ctx) - target.bootAt) / 1000)}\r\n\r\n# Memory\r\nused_memory_human:1.02M\r\nmaxmemory_policy:noeviction\r\n`;
      case "flushall":
        for (const x of Object.keys(db)) delete db[x];
        return "OK\n";
      default:
        return `(error) ERR unknown command '${c0}', with args beginning with: ${[k, ...v]
          .filter(Boolean)
          .map((x) => `'${x}' `)
          .join("")}\n`;
    }
  };
  C.psql = (argv, ctx) => {
    const h = ctx.host;
    const user = argv.includes("-U") ? argv[argv.indexOf("-U") + 1] : ctx.user;
    if (!svcActive(h, "postgresql"))
      return fail(
        'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n\tIs the server running locally and accepting connections on that socket?',
        2,
      );
    if (user !== "postgres")
      return fail(
        `psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${user}" does not exist${user === ctx.user ? IG.t("\nℹ 初期状態では sudo -u postgres psql で接続します。") : ""}`,
        2,
      );
    if (argv.includes("-l"))
      return "                                                   List of databases\n   Name    |  Owner   | Encoding | Collate |  Ctype  | ICU Locale | Locale Provider |   Access privileges   \n-----------+----------+----------+---------+---------+------------+-----------------+-----------------------\n postgres  | postgres | UTF8     | C.UTF-8 | C.UTF-8 |            | libc            | \n template0 | postgres | UTF8     | C.UTF-8 | C.UTF-8 |            | libc            | =c/postgres          +\n           |          |          |         |         |            |                 | postgres=CTc/postgres\n template1 | postgres | UTF8     | C.UTF-8 | C.UTF-8 |            | libc            | =c/postgres          +\n           |          |          |         |         |            |                 | postgres=CTc/postgres\n(3 rows)\n\n";
    const c = argv.includes("-c") ? argv[argv.indexOf("-c") + 1] : null;
    if (c && /select\s+version\(\)/i.test(c))
      return "                                                              version                                                              \n-----------------------------------------------------------------------------------------------------------------------------------\n PostgreSQL 16.4 (Ubuntu 16.4-0ubuntu0.24.04.2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0, 64-bit\n(1 row)\n\n";
    return hint(
      IG.t('psql の対話操作や任意の SQL は再現していません（psql -l と psql -c "SELECT version();" に対応）。'),
    );
  };
  C.mysql = (argv, ctx) =>
    svcActive(ctx.host, "mysql") || svcActive(ctx.host, "mariadb")
      ? hint(IG.t("MySQL クライアントの対話操作や SQL の実行は再現していません。"))
      : fail(
          "ERROR 2002 (HY000): Can't connect to local MySQL server through socket '/var/run/mysqld/mysqld.sock' (2)",
        );

  /* ================================================================ systemd odds and ends */
  C.coredumpctl = (argv, ctx) =>
    root(ctx) || ctx.host.inGroup(ctx.user, "adm") || ctx.host.inGroup(ctx.user, "wheel")
      ? fail("No coredumps found.")
      : fail("No coredumps found.\nHint: You are currently not seeing messages from other users and the system.");
  C.udevadm = (argv, ctx) => {
    const verb = argv[0];
    if (verb === "settle" || verb === "control") return "";
    if (verb === "trigger")
      return root(ctx)
        ? ""
        : fail("Failed to write 'change' to '/sys/devices/virtual/net/lo/uevent': Permission denied");
    if (verb === "info") {
      const dev =
        argv.find((a) => a.startsWith("/dev/")) || (argv.includes("-n") ? "/dev/" + argv[argv.indexOf("-n") + 1] : "");
      if (!dev) return fail("Bad Argument");
      return `P: /devices/pci0000:00/0000:00:1f.0/nvme/nvme1/${dev.replace("/dev/", "")}\nN: ${dev.replace("/dev/", "")}\nL: 0\nS: disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0${U.hex(dev, 15)}\nE: DEVNAME=${dev}\nE: DEVTYPE=disk\nE: SUBSYSTEM=block\nE: ID_MODEL=Amazon Elastic Block Store\n`;
    }
    return hint(
      IG.t(`udevadm {0} はこのシミュレータでは未対応です（info / settle / trigger に対応）。`, { 0: verb || "" }),
    );
  };
  C["systemd-run"] = (argv, ctx) => {
    if (!root(ctx) && !argv.includes("--user")) return fail("Failed to start transient service unit: Access denied");
    const id = "run-u" + (100 + (U.hash(String(now(ctx))) % 900));
    const timer = argv.some((a) => /^--on-(active|calendar|boot)/.test(a));
    return {
      stdout: "",
      stderr: timer
        ? IG.t(
            `Running timer as unit: {0}.timer\nWill run service as unit: {1}.service\nℹ シミュレータ内ではタイマーの時刻になってもコマンドは実行されません。\n`,
            { 0: id, 1: id },
          )
        : `Running as unit: ${id}.service\n`,
      code: 0,
    };
  };
  C["systemd-tmpfiles"] = (argv, ctx) => (root(ctx) ? "" : fail("Failed to open '/run/tmpfiles.d': Permission denied"));
  C["systemd-cgls"] = () =>
    hint(IG.t("cgroup ツリーの表示は再現していません。systemctl status <サービス> で CGroup 欄を確認できます。"));
  C.nsenter = () =>
    hint(
      IG.t(
        "Linux 名前空間（nsenter / unshare）はこのシミュレータでは再現していません。コンテナ内の操作は docker exec / kubectl exec を使ってください。",
      ),
    );
  C.unshare = C.nsenter;
  C.gcc = () => hint(IG.t("C/C++ のコンパイルはこのシミュレータでは未対応です。"));
  C.cc = C.gcc;
  C["g++"] = C.gcc;
  C.make = () => hint(IG.t("make によるビルドはこのシミュレータでは未対応です。"));
  C.cpio = () => hint(IG.t("cpio はこのシミュレータでは未対応です。アーカイブには tar を使ってください。"));
  C.iperf3 = () => hint(IG.t("iperf3 による帯域測定は、訓練環境に測定相手のサーバーがないため再現していません。"));
  C.socat = () =>
    hint(IG.t("socat はこのシミュレータでは未対応です。接続確認は nc -zv <ホスト> <ポート> を使ってください。"));
})((globalThis.IG = globalThis.IG || {}));
