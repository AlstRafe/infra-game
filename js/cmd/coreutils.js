/* GNU coreutils-style file commands: ls cp mv rm mkdir rmdir touch ln readlink realpath stat
 * file chmod chown chgrp du df cat tac head tail wc tee basename dirname mktemp truncate dd
 * fallocate tree find md5sum/sha*sum base64 seq yes sleep date env/printenv whoami id groups
 * uname hostname uptime nproc and the editor launchers (vi/vim/nano/less). */
(function (IG) {
  "use strict";
  const U = IG.util;
  const VFS = IG.VFS;
  const C = (IG.commands = IG.commands || {});

  /* ---------------- helpers */
  function out() {
    const o = { so: "", se: "", code: 0 };
    o.o = (t) => {
      o.so += t;
    };
    o.e = (t, code = 1) => {
      o.se += t.endsWith("\n") ? t : t + "\n";
      o.code = code;
    };
    o.r = () => ({ stdout: o.so, stderr: o.se, code: o.code });
    return o;
  }
  const lines = (t) => {
    const l = String(t).split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
  };
  const join = (l) => (l.length ? l.join("\n") + "\n" : "");
  // parse flags: returns {f:{}, pos:[]} supporting -abc, --long, --long=val, and value flags
  function opts(argv, valueFlags = "", longValue = []) {
    const f = {},
      pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--") {
        pos.push(...argv.slice(i + 1));
        break;
      }
      if (/^--[\w-]+/.test(a)) {
        const eq = a.indexOf("=");
        const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (eq > 0) f[k] = a.slice(eq + 1);
        else if (longValue.includes(k)) f[k] = argv[++i];
        else f[k] = true;
        continue;
      }
      if (/^-\d$/.test(a) && !valueFlags.includes("#")) {
        f[a[1]] = true;
        continue;
      } // e.g. ls -1
      if (/^-[^-\d]/.test(a) || (/^-\d/.test(a) && valueFlags.includes("#"))) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (valueFlags.includes(ch)) {
            f[ch] = a.slice(j + 1) || argv[++i];
            break;
          }
          if (/\d/.test(ch) && valueFlags.includes("#")) {
            f["#"] = a.slice(j);
            break;
          }
          f[ch] = (f[ch] === true ? 1 : f[ch] || 0) + 1 > 1 ? (f[ch] || 0) + 1 : true;
        }
        continue;
      }
      pos.push(a);
    }
    return { f, pos };
  }
  IG.cliOpts = opts;
  const umask = (ctx) => (ctx.shell.umask !== undefined ? ctx.shell.umask : ctx.user === "root" ? 0o022 : 0o002);
  const owner = (ctx, dir) => ({
    owner: ctx.user,
    group: ctx.pod || ctx.container ? "root" : ctx.host.primaryGroup(ctx.user),
    mode: (dir ? 0o777 : 0o666) & ~umask(ctx),
  });
  const tty = (ctx) => !!(ctx.io && ctx.io.fd && ctx.io.fd[1] && ctx.io.fd[1].term);
  const color = (ctx, f) => f.color === "always" || ((f.color === "auto" || f.color === true) && tty(ctx));
  function modeStr(n) {
    const t = n.type === "d" ? "d" : n.type === "l" ? "l" : n.dev ? "c" : n.fifo ? "p" : "-";
    const m = n.mode;
    const r = (b, ch) => (m & b ? ch : "-");
    let s =
      t +
      r(0o400, "r") +
      r(0o200, "w") +
      r(0o100, "x") +
      r(0o40, "r") +
      r(0o20, "w") +
      r(0o10, "x") +
      r(0o4, "r") +
      r(0o2, "w") +
      r(0o1, "x");
    if (m & 0o4000) s = s.slice(0, 3) + (m & 0o100 ? "s" : "S") + s.slice(4);
    if (m & 0o2000) s = s.slice(0, 6) + (m & 0o10 ? "s" : "S") + s.slice(7);
    if (m & 0o1000) s = s.slice(0, 9) + (m & 0o1 ? "t" : "T");
    return s;
  }
  IG.modeStr = modeStr;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function lsTime(t, now) {
    const d = new Date(t);
    const recent = now - t < 182 * 86400e3 && t <= now + 3600e3;
    return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${recent ? d.toISOString().slice(11, 16) : " " + d.getUTCFullYear()}`;
  }
  function human(n, si) {
    const u = ["", "K", "M", "G", "T"];
    let i = 0;
    let v = n;
    const base = si ? 1000 : 1024;
    while (v >= base && i < u.length - 1) {
      v /= base;
      i++;
    }
    if (i === 0) return String(Math.round(v));
    return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + u[i];
  }
  IG.humanSize = human;
  function inode(path) {
    return 100000 + (U.hash(path) % 900000);
  }
  // read files (or stdin) for text filters. returns {texts:[{name,text}], errs}
  function inputs(ctx, files, cmd) {
    const res = { texts: [], errs: [] };
    if (!files.length) {
      res.texts.push({ name: "-", text: ctx.stdin });
      return res;
    }
    for (const f of files) {
      if (f === "-") {
        res.texts.push({ name: "-", text: ctx.stdin });
        continue;
      }
      const p = ctx.resolve(f);
      const fs = ctx.vfs;
      if (!fs.exists(p)) {
        res.errs.push(`${cmd}: ${f}: No such file or directory`);
        continue;
      }
      if (fs.isDir(p)) {
        res.errs.push(`${cmd}: ${f}: Is a directory`);
        continue;
      }
      if (!ctx.shell.canRead(p)) {
        res.errs.push(`${cmd}: ${f}: Permission denied`);
        continue;
      }
      const n = fs.node(p);
      if (n.dev) {
        res.texts.push({ name: f, text: "" });
        continue;
      }
      res.texts.push({ name: f, text: decode(n) });
    }
    return res;
  }
  // archives / binaries store a marker; show something plausible when catted
  function decode(n) {
    return n.content;
  }
  IG.readInputs = inputs;
  IG.cliOut = out;
  // Why a command may not write the file p (null when it may): the checks of a > redirection.
  function cannotWrite(ctx, p) {
    if (ctx.vfs.isDir(p)) return "Is a directory";
    if (!ctx.vfs.isDir(VFS.parent(p))) return "No such file or directory";
    if (!ctx.shell.canWrite(p)) return "Permission denied";
    return null;
  }
  IG.cannotWrite = cannotWrite;

  /* ================================================================ ls */
  const LS_COLORS = { d: "01;34", l: "01;36", x: "01;32", arc: "01;31", stk: "30;42", dev: "40;33;01" };
  function lsName(ctx, e, f, useColor) {
    const n = e.node;
    let name = e.name;
    if (/[\s'"$]/.test(name) && tty(ctx)) name = `'${name}'`;
    let cls = "";
    if (n.type === "d") cls = n.mode & 0o1002 ? LS_COLORS.stk : LS_COLORS.d;
    else if (n.type === "l") cls = LS_COLORS.l;
    else if (n.dev) cls = LS_COLORS.dev;
    else if (n.mode & 0o111) cls = LS_COLORS.x;
    else if (/\.(tar|tgz|gz|zip|xz|bz2|deb|rpm)$/.test(e.name)) cls = LS_COLORS.arc;
    let s = useColor && cls ? `\x1b[${cls}m${name}\x1b[0m` : name;
    if (f.F || f.classify) s += n.type === "d" ? "/" : n.type === "l" ? "@" : n.mode & 0o111 ? "*" : "";
    else if (f.p && n.type === "d") s += "/";
    return s;
  }
  function columns(names, width = 100) {
    if (!names.length) return "";
    const plain = names.map((n) => n.replace(/\x1b\[[\d;]*m/g, ""));
    const w = Math.max(...plain.map((n) => [...n].length)) + 2;
    const cols = Math.max(1, Math.floor(width / w));
    const rows = Math.ceil(names.length / cols);
    const out = [];
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const i = c * rows + r;
        if (i >= names.length) break;
        const last = c === cols - 1 || (c + 1) * rows + r >= names.length;
        line += last ? names[i] : names[i] + " ".repeat(w - [...plain[i]].length);
      }
      out.push(line);
    }
    return join(out);
  }
  C.ls = (argv, ctx) => {
    const { f, pos } = opts(argv, "w", ["color", "sort", "time-style", "width"]);
    const o = out();
    const fs = ctx.vfs;
    const useColor = color(ctx, f);
    const all = f.a || f.all,
      almost = f.A || f["almost-all"];
    const long = f.l || f.n || f.g || f.o;
    const now = ctx.world.now();
    const targets = pos.length ? pos : ["."];
    const files = [],
      dirs = [];
    for (const t of targets) {
      const p = ctx.resolve(t);
      if (!fs.lexists(p)) {
        o.e(`ls: cannot access '${t}': No such file or directory`, 2);
        continue;
      }
      const ln = fs.lnode(p);
      const isDir = fs.isDir(p) && !(ln.type === "l" && (long || f.d) && !t.endsWith("/"));
      if (f.d || f.directory || !isDir)
        files.push({ name: t, path: p, node: f.L ? fs.node(p) || ln : ln, dir: ln.type === "d" });
      else dirs.push({ name: t, path: p });
    }
    const sortEntries = (arr) => {
      const s = arr.slice();
      if (f.S || f.sort === "size")
        s.sort((a, b) => fs.fileSize(b.node) - fs.fileSize(a.node) || a.name.localeCompare(b.name));
      else if (f.t || f.sort === "time") s.sort((a, b) => b.node.mtime - a.node.mtime || a.name.localeCompare(b.name));
      else if (f.U || f.sort === "none") {
        /* directory order */
      } else if (f.v || f.sort === "version")
        s.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      else
        s.sort((a, b) => {
          const x = a.name.replace(/^\./, "").toLowerCase(),
            y = b.name.replace(/^\./, "").toLowerCase();
          return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : 1;
        });
      if (f.r || f.reverse) s.reverse();
      return s;
    };
    const longLine = (e, cols) => {
      const n = e.node;
      const user = f.n ? String((ctx.host.users[n.owner] || { uid: n.owner }).uid) : n.owner;
      const grp = f.n ? String((ctx.host.groups[n.group] || { gid: n.group }).gid) : n.group;
      const size = n.type === "d" ? 4096 : fs.fileSize(n);
      const sz = f.h || f["human-readable"] ? human(size) : String(size);
      const links = n.type === "d" ? 2 + fs.children(e.path).filter((c) => c.dir).length : 1;
      let name = lsName(ctx, e, f, useColor);
      if (n.type === "l") name += " -> " + n.target;
      const parts = [];
      if (f.i) parts.push(String(inode(e.path)).padStart(cols.ino));
      if (f.s) parts.push(String(Math.ceil(size / 4096) * 4).padStart(cols.blk));
      parts.push(modeStr(n) + (n.acl || n.dacl ? "+" : cols.acl ? " " : ""), String(links).padStart(cols.links));
      if (!f.g) parts.push(user.padEnd(cols.user));
      if (!f.o) parts.push(grp.padEnd(cols.group));
      parts.push(sz.padStart(cols.size), lsTime(n.mtime, now), name);
      return parts.join(" ");
    };
    const colsFor = (list) => ({
      acl: list.some((e) => e.node.acl || e.node.dacl),
      links: Math.max(
        1,
        ...list.map(
          (e) => String(e.node.type === "d" ? 2 + fs.children(e.path).filter((c) => c.dir).length : 1).length,
        ),
      ),
      user: Math.max(
        ...list.map((e) => (f.n ? String((ctx.host.users[e.node.owner] || { uid: 0 }).uid) : e.node.owner).length),
      ),
      group: Math.max(
        ...list.map((e) => (f.n ? String((ctx.host.groups[e.node.group] || { gid: 0 }).gid) : e.node.group).length),
      ),
      size: Math.max(
        ...list.map((e) => {
          const s = e.node.type === "d" ? 4096 : fs.fileSize(e.node);
          return (f.h ? human(s) : String(s)).length;
        }),
      ),
      ino: 6,
      blk: 4,
    });
    const render = (list) => {
      if (!list.length) return "";
      if (long) {
        const cols = colsFor(list);
        return join(list.map((e) => longLine(e, cols)));
      }
      const names = list.map((e) => (f.i ? inode(e.path) + " " : "") + lsName(ctx, e, f, useColor));
      if (f["1"] || !tty(ctx)) return join(names);
      if (f.m) return names.join(", ") + "\n";
      return columns(names);
    };
    o.o(render(sortEntries(files)));
    const showHeader = targets.length > 1 || f.R;
    const doDir = (d, label, first) => {
      const node = fs.node(d.path);
      if (
        !ctx.pod &&
        !ctx.container &&
        (!ctx.host.allowed(ctx.user, node, "r") || !ctx.host.traversable(ctx.user, d.path + "/x"))
      ) {
        o.e(`ls: cannot open directory '${label}': Permission denied`, 2);
        return;
      }
      let kids = fs.children(d.path).filter((c) => all || almost || !c.name.startsWith("."));
      if (all)
        kids = [
          { name: ".", path: d.path, node, dir: true },
          { name: "..", path: VFS.parent(d.path), node: fs.node(VFS.parent(d.path)), dir: true },
        ].concat(kids);
      kids = sortEntries(kids);
      if (showHeader) o.o((first && !files.length ? "" : "\n") + label + ":\n");
      if (long) {
        const total = kids.reduce(
          (n, k) => n + Math.ceil((k.node.type === "d" ? 4096 : fs.fileSize(k.node)) / 4096) * 4,
          0,
        );
        o.o(`total ${f.h ? human(total * 1024) : total}\n`);
      }
      o.o(render(kids));
      if (f.R)
        for (const k of kids)
          if (k.dir && k.name !== "." && k.name !== "..")
            doDir({ path: k.path }, (label === "." ? "." : label.replace(/\/$/, "")) + "/" + k.name, false);
    };
    sortEntries(dirs.map((d) => Object.assign(d, { node: fs.node(d.path) }))).forEach((d, i) =>
      doDir(d, d.name, i === 0),
    );
    return o.r();
  };
  C.dir = C.ls;

  /* ================================================================ file ops */
  C.mkdir = (argv, ctx) => {
    const { f, pos } = opts(argv, "m", ["mode"]);
    const o = out();
    if (!pos.length) {
      o.e("mkdir: missing operand\nTry 'mkdir --help' for more information.");
      return o.r();
    }
    const mode = f.m || f.mode ? parseInt(f.m || f.mode, 8) : null;
    for (const d of pos) {
      const p = ctx.resolve(d);
      const fs = ctx.vfs;
      if (fs.lexists(p)) {
        if (!f.p && !f.parents) o.e(`mkdir: cannot create directory ‘${d}’: File exists`);
        continue;
      }
      const parent = VFS.parent(p);
      if (!fs.isDir(parent) && !(f.p || f.parents)) {
        o.e(`mkdir: cannot create directory ‘${d}’: No such file or directory`);
        continue;
      }
      // find first missing ancestor to check permission
      let anc = parent;
      while (!fs.exists(anc)) anc = VFS.parent(anc);
      if (!ctx.shell.canWrite(anc + "/.probe")) {
        o.e(`mkdir: cannot create directory ‘${d}’: Permission denied`);
        continue;
      }
      const own = Object.assign(owner(ctx, true), { ownParents: true });
      own.parentMode = own.mode;
      if (mode !== null) own.mode = mode;
      fs.mkdirp(p, own);
      if (f.v || f.verbose) o.o(`mkdir: created directory '${d}'\n`);
    }
    return o.r();
  };
  C.rmdir = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    for (const d of pos) {
      const p = ctx.resolve(d);
      const fs = ctx.vfs;
      if (!fs.exists(p)) {
        o.e(`rmdir: failed to remove '${d}': No such file or directory`);
        continue;
      }
      if (!fs.isDir(p)) {
        o.e(`rmdir: failed to remove '${d}': Not a directory`);
        continue;
      }
      if (fs.children(p).length) {
        o.e(`rmdir: failed to remove '${d}': Directory not empty`);
        continue;
      }
      if (!ctx.shell.canDelete(p)) {
        o.e(`rmdir: failed to remove '${d}': Permission denied`);
        continue;
      }
      fs.remove(p);
      if (f.p) {
        let q = VFS.parent(p);
        while (q !== "/" && q !== ctx.cwd && !fs.children(q).length) {
          fs.remove(q);
          q = VFS.parent(q);
        }
      }
    }
    return o.r();
  };
  C.touch = (argv, ctx) => {
    const { f, pos } = opts(argv, "dtr", ["date", "reference"]);
    const o = out();
    if (!pos.length) {
      o.e("touch: missing file operand\nTry 'touch --help' for more information.");
      return o.r();
    }
    const when = f.d || f.date ? parseDate(f.d || f.date, ctx.world.now()) : ctx.world.now();
    for (const t of pos) {
      const p = ctx.resolve(t);
      const fs = ctx.vfs;
      if (fs.exists(p)) {
        if (
          !ctx.pod &&
          ctx.user !== "root" &&
          fs.node(p).owner !== ctx.user &&
          !ctx.host.allowed(ctx.user, fs.node(p), "w")
        ) {
          o.e(`touch: cannot touch '${t}': Permission denied`);
          continue;
        }
        fs.touch(p, when);
        continue;
      }
      if (f.c || f["no-create"]) continue;
      if (!fs.isDir(VFS.parent(p))) {
        o.e(`touch: cannot touch '${t}': No such file or directory`);
        continue;
      }
      if (!ctx.shell.canWrite(p)) {
        o.e(`touch: cannot touch '${t}': Permission denied`);
        continue;
      }
      fs.write(p, "", Object.assign(owner(ctx), { mtime: when }));
    }
    return o.r();
  };
  function copyNode(ctx, fs, src, dst, preserve) {
    const n = fs.node(src);
    const opt = preserve
      ? { owner: n.owner, group: n.group, mode: n.mode, mtime: n.mtime }
      : Object.assign(owner(ctx), { mode: n.mode & ~umask(ctx) });
    if (n.type === "d") {
      fs.mkdirp(dst, opt);
      for (const c of fs.children(src)) copyNode(ctx, fs, c.path, dst + "/" + c.name, preserve);
      return;
    }
    if (fs.exists(dst)) {
      const d = fs.node(dst);
      d.content = n.content;
      d.size = n.size;
      d.mtime = preserve ? n.mtime : ctx.world.now();
      return;
    }
    fs.write(dst, n.content, Object.assign(opt, { size: n.size }));
  }
  C.cp = (argv, ctx) => {
    const { f, pos } = opts(argv, "t", ["target-directory"]);
    const o = out();
    const fs = ctx.vfs;
    const recursive = f.r || f.R || f.a || f.recursive || f.archive;
    const preserve = f.a || f.p || f.archive || f.preserve;
    const targetDir = f.t || f["target-directory"];
    if (pos.length < (targetDir ? 1 : 2)) {
      o.e(
        pos.length
          ? `cp: missing destination file operand after '${pos[0]}'\nTry 'cp --help' for more information.`
          : "cp: missing file operand\nTry 'cp --help' for more information.",
      );
      return o.r();
    }
    const dstArg = targetDir || pos.pop();
    const dst = ctx.resolve(dstArg);
    if (pos.length > 1 && !fs.isDir(dst)) {
      o.e(`cp: target '${dstArg}' is not a directory`);
      return o.r();
    }
    for (const s of pos) {
      const sp = ctx.resolve(s);
      if (!fs.exists(sp)) {
        o.e(`cp: cannot stat '${s}': No such file or directory`);
        continue;
      }
      if (fs.isDir(sp) && !recursive) {
        o.e(`cp: -r not specified; omitting directory '${s}'`);
        continue;
      }
      if (!ctx.shell.canRead(sp)) {
        o.e(`cp: cannot open '${s}' for reading: Permission denied`);
        continue;
      }
      const target = fs.isDir(dst) ? dst + "/" + VFS.base(sp) : dst;
      if (target === sp || target.startsWith(sp + "/")) {
        o.e(`cp: cannot copy a directory, '${s}', into itself, '${dstArg}'`);
        continue;
      }
      if (fs.exists(target) && (f.n || f["no-clobber"])) continue;
      if (!ctx.shell.canWrite(target)) {
        o.e(
          `cp: cannot create ${fs.isDir(sp) ? "directory" : "regular file"} '${fs.isDir(dst) ? dstArg.replace(/\/$/, "") + "/" + VFS.base(sp) : dstArg}': ${fs.isDir(VFS.parent(target)) ? "Permission denied" : "No such file or directory"}`,
        );
        continue;
      }
      if (!fs.isDir(VFS.parent(target))) {
        o.e(`cp: cannot create regular file '${dstArg}': No such file or directory`);
        continue;
      }
      copyNode(ctx, fs, sp, target, preserve);
      if (f.v || f.verbose)
        o.o(`'${s}' -> '${fs.isDir(dst) ? dstArg.replace(/\/$/, "") + "/" + VFS.base(sp) : dstArg}'\n`);
    }
    return o.r();
  };
  C.mv = (argv, ctx) => {
    const { f, pos } = opts(argv, "t", ["target-directory"]);
    const o = out();
    const fs = ctx.vfs;
    if (pos.length < 2) {
      o.e(
        pos.length
          ? `mv: missing destination file operand after '${pos[0]}'\nTry 'mv --help' for more information.`
          : "mv: missing file operand\nTry 'mv --help' for more information.",
      );
      return o.r();
    }
    const dstArg = pos.pop();
    const dst = ctx.resolve(dstArg);
    if (pos.length > 1 && !fs.isDir(dst)) {
      o.e(`mv: target '${dstArg}' is not a directory`);
      return o.r();
    }
    for (const s of pos) {
      const sp = ctx.resolve(s);
      if (!fs.lexists(sp)) {
        o.e(`mv: cannot stat '${s}': No such file or directory`);
        continue;
      }
      const target = fs.isDir(dst) ? dst + "/" + VFS.base(sp) : dst;
      if (target === sp) {
        o.e(`mv: '${s}' and '${dstArg}' are the same file`);
        continue;
      }
      if (target.startsWith(sp + "/")) {
        o.e(`mv: cannot move '${s}' to a subdirectory of itself, '${dstArg}/${VFS.base(sp)}'`);
        continue;
      }
      if (!ctx.shell.canDelete(sp) || !ctx.shell.canWrite(target)) {
        o.e(`mv: cannot move '${s}' to '${dstArg}': Permission denied`);
        continue;
      }
      if (!fs.isDir(VFS.parent(target))) {
        o.e(`mv: cannot move '${s}' to '${dstArg}': No such file or directory`);
        continue;
      }
      if (fs.exists(target) && (f.n || f["no-clobber"])) continue;
      if (fs.lexists(target)) {
        if (fs.isDir(target) && !fs.isDir(sp)) {
          o.e(`mv: cannot overwrite directory '${dstArg}' with non-directory`);
          continue;
        }
        fs.remove(target, true);
      }
      fs.rename(sp, target);
      if (f.v || f.verbose)
        o.o(
          `renamed '${s}' -> '${fs.isDir(dst) && target !== dst ? dstArg.replace(/\/$/, "") + "/" + VFS.base(sp) : dstArg}'\n`,
        );
    }
    ctx.world.reconcile();
    return o.r();
  };
  C.rm = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    const fs = ctx.vfs;
    const rec = f.r || f.R || f.recursive;
    if (!pos.length) {
      if (!f.f) o.e("rm: missing operand\nTry 'rm --help' for more information.");
      return o.r();
    }
    for (const t of pos) {
      const p = ctx.resolve(t);
      if (p === "/" && !f["no-preserve-root"]) {
        o.e(`rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe`);
        continue;
      }
      if (t === "." || t === ".." || /\/\.\.?$/.test(t)) {
        o.e(`rm: refusing to remove '.' or '..' directory: skipping '${t}'`);
        continue;
      }
      if (!fs.lexists(p)) {
        if (!f.f && !f.force) o.e(`rm: cannot remove '${t}': No such file or directory`);
        continue;
      }
      const isDir = fs.lnode(p).type === "d";
      if (isDir && !rec && !f.d) {
        o.e(`rm: cannot remove '${t}': Is a directory`);
        continue;
      }
      if (isDir && !rec && fs.children(p).length) {
        o.e(`rm: cannot remove '${t}': Directory not empty`);
        continue;
      }
      if (!ctx.shell.canDelete(p)) {
        o.e(`rm: cannot remove '${t}': Permission denied`);
        continue;
      }
      if (isDir && !ctx.pod && ctx.user !== "root") {
        const blocked = fs
          .walk(p)
          .find((k) => fs.lnode(k).type === "d" && !ctx.host.allowed(ctx.user, fs.lnode(k), "w"));
        if (blocked) {
          o.e(`rm: cannot remove '${blocked.replace(ctx.cwd + "/", "")}': Permission denied`);
          continue;
        }
      }
      if (f.v || f.verbose) {
        for (const k of fs.walk(p).reverse()) o.o(`removed '${k}'\n`);
        o.o(isDir ? `removed directory '${t}'\n` : `removed '${t}'\n`);
      }
      fs.remove(p, true);
    }
    ctx.world.reconcile();
    return o.r();
  };
  C.ln = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    const fs = ctx.vfs;
    if (!pos.length) {
      o.e("ln: missing file operand\nTry 'ln --help' for more information.");
      return o.r();
    }
    const target = pos[0];
    const link = pos[1] || VFS.base(target);
    let lp = ctx.resolve(link);
    if (fs.isDir(lp) && !(f.n || f.T)) lp = lp + "/" + VFS.base(target);
    if (fs.lexists(lp)) {
      if (f.f || f.force) fs.remove(lp);
      else {
        o.e(`ln: failed to create ${f.s ? "symbolic " : "hard "}link '${link}': File exists`);
        return o.r();
      }
    }
    if (!ctx.shell.canWrite(lp)) {
      o.e(`ln: failed to create ${f.s ? "symbolic " : "hard "}link '${link}': Permission denied`);
      return o.r();
    }
    if (f.s || f.symbolic) {
      fs.symlink(target, lp, { owner: ctx.user, group: ctx.pod ? "root" : ctx.host.primaryGroup(ctx.user) });
    } else {
      const tp = ctx.resolve(target);
      if (!fs.exists(tp)) {
        o.e(`ln: failed to access '${target}': No such file or directory`);
        return o.r();
      }
      if (fs.isDir(tp)) {
        o.e(`ln: ${target}: hard link not allowed for directory`);
        return o.r();
      }
      fs.nodes.set(lp, fs.node(tp)); // shared node = hard link
    }
    if (f.v) o.o(`'${link}' -> '${target}'\n`);
    return o.r();
  };
  C.readlink = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    for (const t of pos) {
      const p = ctx.resolve(t);
      if (f.f || f.e || f.m || f.canonicalize) {
        const r = ctx.vfs.real(p);
        if (!r || (f.e && !ctx.vfs.exists(p))) {
          o.code = 1;
          continue;
        }
        o.o(r + "\n");
        continue;
      }
      const n = ctx.vfs.lnode(p);
      if (!n || n.type !== "l") {
        o.code = 1;
        continue;
      }
      o.o(n.target + "\n");
    }
    return o.r();
  };
  C.realpath = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    for (const t of pos) {
      const p = ctx.resolve(t);
      const r = ctx.vfs.real(p);
      if (!ctx.vfs.exists(p) && !f.m) {
        o.e(`realpath: ${t}: No such file or directory`);
        continue;
      }
      o.o(r + "\n");
    }
    return o.r();
  };
  C.basename = (argv) => {
    const { f, pos } = opts(argv, "s", ["suffix"]);
    const names = f.a || f.s ? pos : [pos[0]];
    const suf = f.s || f.suffix || (!f.a && pos[1]) || "";
    if (!pos.length)
      return {
        stdout: "",
        stderr: "basename: missing operand\nTry 'basename --help' for more information.\n",
        code: 1,
      };
    return join(
      names.map((n) => {
        let b = n.replace(/\/+$/, "").split("/").pop() || "/";
        if (suf && b.endsWith(suf) && b !== suf) b = b.slice(0, -suf.length);
        return b;
      }),
    );
  };
  C.dirname = (argv) =>
    join(
      argv
        .filter((a) => !a.startsWith("-"))
        .map((n) => {
          const s = n.replace(/\/+$/, "");
          const i = s.lastIndexOf("/");
          return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i);
        }),
    );
  C.mktemp = (argv, ctx) => {
    const { f, pos } = opts(argv, "p", ["tmpdir"]);
    const tmpl = pos[0] || "tmp.XXXXXXXXXX";
    if (!/X{3,}$/.test(tmpl)) return { stdout: "", stderr: `mktemp: too few X's in template '${tmpl}'\n`, code: 1 };
    const name = tmpl.replace(/X{3,}$/, (m) =>
      U.hex(String(ctx.world.now() + Math.random()), m.length).replace(/[0-9]/g, (d) => "aBcDeFgHiJ"[d]),
    );
    const p = tmpl.includes("/") ? ctx.resolve(name) : (f.p || f.tmpdir || "/tmp").replace(/\/$/, "") + "/" + name;
    const why = cannotWrite(ctx, p);
    if (why)
      return {
        stdout: "",
        stderr: `mktemp: failed to create ${f.d ? "directory" : "file"} via template '${tmpl}': ${why}\n`,
        code: 1,
      };
    if (f.d) ctx.vfs.mkdirp(p, Object.assign(owner(ctx, true), { mode: 0o700 }));
    else ctx.vfs.write(p, "", Object.assign(owner(ctx), { mode: 0o600 }));
    return p + "\n";
  };
  function chmodApply(mode, spec, isDir) {
    if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
    for (const clause of spec.split(",")) {
      const m = clause.match(/^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/);
      if (!m) return null;
      const who = m[1] || "a";
      let bits = 0;
      for (const p of m[3]) {
        const b = { r: 0o444, w: 0o222, x: 0o111, X: isDir || mode & 0o111 ? 0o111 : 0, s: 0o6000, t: 0o1000 }[p] || 0;
        bits |= b;
      }
      let mask = 0;
      if (who.includes("u") || who.includes("a")) mask |= 0o4700;
      if (who.includes("g") || who.includes("a")) mask |= 0o2070;
      if (who.includes("o") || who.includes("a")) mask |= 0o1007;
      if (!m[1]) mask &= ~0o022 | 0o7000; // plain "+w" honours umask in GNU; approximate
      bits &= mask;
      if (m[2] === "+") mode |= bits;
      else if (m[2] === "-") mode &= ~bits;
      else mode = (mode & ~mask) | bits;
    }
    return mode;
  }
  C.chmod = (argv, ctx) => {
    const args = argv.slice();
    const rec = args.includes("-R") || args.includes("--recursive");
    const verbose = args.includes("-v") || args.includes("-c");
    const rest = args.filter((a) => !["-R", "--recursive", "-v", "-c", "-f"].includes(a));
    const o = out();
    if (rest.length < 2) {
      o.e(
        rest.length
          ? `chmod: missing operand after '${rest[0]}'\nTry 'chmod --help' for more information.`
          : "chmod: missing operand\nTry 'chmod --help' for more information.",
      );
      return o.r();
    }
    const spec = rest[0];
    const fs = ctx.vfs;
    for (const t of rest.slice(1)) {
      const p = ctx.resolve(t);
      if (!fs.exists(p)) {
        o.e(`chmod: cannot access '${t}': No such file or directory`);
        continue;
      }
      const targets = [p].concat(rec && fs.isDir(p) ? fs.walk(p) : []);
      for (const q of targets) {
        const n = fs.lnode(q);
        if (n.type === "l") continue;
        if (ctx.user !== "root" && n.owner !== ctx.user && !ctx.pod) {
          o.e(`chmod: changing permissions of '${q === p ? t : q}': Operation not permitted`);
          continue;
        }
        const m = chmodApply(n.mode & 0o7777, spec, n.type === "d");
        if (m === null) {
          o.e(`chmod: invalid mode: ‘${spec}’\nTry 'chmod --help' for more information.`);
          return o.r();
        }
        const old = n.mode & 0o7777;
        n.mode = m;
        if (verbose && (args.includes("-v") || old !== m))
          o.o(
            `mode of '${q === p ? t : q}' changed from ${old.toString(8).padStart(4, "0")} (${modeStr(Object.assign({}, n, { mode: old })).slice(1)}) to ${m.toString(8).padStart(4, "0")} (${modeStr(n).slice(1)})\n`,
          );
      }
    }
    return o.r();
  };
  function chownCmd(argv, ctx, grpOnly) {
    const rec = argv.includes("-R");
    const rest = argv.filter((a) => !/^-[Rvhcf]+$/.test(a) && a !== "--recursive");
    const o = out();
    const cmd = grpOnly ? "chgrp" : "chown";
    if (rest.length < 2) {
      o.e(`${cmd}: missing operand\nTry '${cmd} --help' for more information.`);
      return o.r();
    }
    let [usr, grp] = grpOnly ? [null, rest[0]] : rest[0].split(/[:.]/);
    const h = ctx.host;
    if (usr && !h.users[usr] && !/^\d+$/.test(usr)) {
      o.e(`${cmd}: invalid user: ‘${rest[0]}’`);
      return o.r();
    }
    if (grp && !h.groups[grp] && !/^\d+$/.test(grp)) {
      o.e(`${cmd}: invalid group: ‘${rest[0]}’`);
      return o.r();
    }
    if (usr && !grp && rest[0].includes(":")) grp = h.primaryGroup(usr);
    const fs = ctx.vfs;
    for (const t of rest.slice(1)) {
      const p = ctx.resolve(t);
      if (!fs.exists(p)) {
        o.e(`${cmd}: cannot access '${t}': No such file or directory`);
        continue;
      }
      for (const q of [p].concat(rec && fs.isDir(p) ? fs.walk(p) : [])) {
        const n = fs.lnode(q);
        const allowed = ctx.user === "root" || (!usr && n.owner === ctx.user && h.inGroup(ctx.user, grp));
        if (!allowed) {
          o.e(`${cmd}: changing ${usr ? "ownership" : "group"} of '${q === p ? t : q}': Operation not permitted`);
          continue;
        }
        if (usr) n.owner = usr;
        if (grp) n.group = grp;
      }
    }
    return o.r();
  }
  C.chown = (a, ctx) => chownCmd(a, ctx, false);
  C.chgrp = (a, ctx) => chownCmd(a, ctx, true);
  C.stat = (argv, ctx) => {
    const { f, pos } = opts(argv, "c", ["format", "printf"]);
    const o = out();
    const fs = ctx.vfs;
    const fmt = f.c || f.format || f.printf;
    for (const t of pos) {
      const p = ctx.resolve(t);
      const n = f.L ? fs.node(p) : fs.lnode(p);
      if (!n) {
        o.e(`stat: cannot statx '${t}': No such file or directory`);
        continue;
      }
      const size = n.type === "d" ? 4096 : fs.fileSize(n);
      const uid = (ctx.host.users[n.owner] || { uid: 0 }).uid,
        gid = (ctx.host.groups[n.group] || { gid: 0 }).gid;
      const ts = new Date(n.mtime).toISOString().replace("T", " ").replace("Z", "000000 +0000");
      const kind =
        n.type === "d"
          ? "directory"
          : n.type === "l"
            ? "symbolic link"
            : n.dev
              ? "character special file"
              : size
                ? "regular file"
                : "regular empty file";
      if (fmt) {
        o.o(
          fmt
            .replace(
              /%([aAUGugsnFyYiNhb%])/g,
              (m, k) =>
                ({
                  "a": (n.mode & 0o7777).toString(8),
                  "A": modeStr(n),
                  "U": n.owner,
                  "G": n.group,
                  "u": uid,
                  "g": gid,
                  "s": size,
                  "n": t,
                  "F": kind,
                  "y": ts,
                  "Y": Math.floor(n.mtime / 1000),
                  "i": inode(p),
                  "N": n.type === "l" ? `'${t}' -> '${n.target}'` : `'${t}'`,
                  "h": 1,
                  "b": Math.ceil(size / 512),
                  "%": "%",
                })[k],
            )
            .replace(/\\n/g, "\n") + (f.printf ? "" : "\n"),
        );
        continue;
      }
      o.o(
        `  File: ${t}${n.type === "l" ? " -> " + n.target : ""}\n  Size: ${String(size).padEnd(10)}\tBlocks: ${String(Math.ceil(size / 4096) * 8).padEnd(10)} IO Block: 4096   ${kind}\nDevice: 10301h/66305d\tInode: ${String(inode(p)).padEnd(11)} Links: ${n.type === "d" ? 2 : 1}\nAccess: (${(n.mode & 0o7777).toString(8).padStart(4, "0")}/${modeStr(n)})  Uid: (${String(uid).padStart(5)}/${n.owner.padStart(8)})   Gid: (${String(gid).padStart(5)}/${n.group.padStart(8)})\nAccess: ${ts}\nModify: ${ts}\nChange: ${new Date(n.ctime || n.mtime).toISOString().replace("T", " ").replace("Z", "000000 +0000")}\n Birth: -\n`,
      );
    }
    return o.r();
  };
  C.file = (argv, ctx) => {
    const { pos } = opts(argv);
    const o = out();
    for (const t of pos) {
      const p = ctx.resolve(t);
      const fs = ctx.vfs;
      const ln = fs.lnode(p);
      if (!ln) {
        o.o(`${t}: cannot open \`${t}' (No such file or directory)\n`);
        continue;
      }
      if (ln.type === "l") {
        o.o(`${t}: symbolic link to ${ln.target}\n`);
        continue;
      }
      if (ln.type === "d") {
        o.o(`${t}: directory\n`);
        continue;
      }
      if (ln.dev) {
        o.o(`${t}: character special (1/3)\n`);
        continue;
      }
      const c = ln.content;
      let kind;
      if (c === "\x7fELF")
        kind =
          "ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, stripped";
      else if (c.startsWith("\xfd7zXZSIM")) kind = "XZ compressed data, checksum CRC64";
      else if (c.startsWith("BZhSIM")) kind = "bzip2 compressed data, block size = 900k";
      else if (c.startsWith("\x28\xb5\x2f\xfdSIM")) kind = "Zstandard compressed data (v0.8+), Dictionary ID: None";
      else if (c.startsWith("\x1f\x8bSIMGZ"))
        kind = "gzip compressed data, from Unix, original size modulo 2^32 " + c.length * 3;
      else if (c.startsWith("SIMTAR\n")) kind = "POSIX tar archive (GNU)";
      else if (c.startsWith("PK\x03\x04SIM"))
        kind = "Zip archive data, at least v2.0 to extract, compression method=deflate";
      else if (!c.length && !ln.size) kind = "empty";
      else if (/^#!.*\b(ba)?sh\b/.test(c))
        kind =
          (/bash/.test(c.split("\n")[0]) ? "Bourne-Again shell script" : "POSIX shell script") +
          ", ASCII text executable";
      else if (/^#!.*python/.test(c)) kind = "Python script, ASCII text executable";
      else if (
        /^\s*[{[]/.test(c) &&
        (() => {
          try {
            JSON.parse(c);
            return true;
          } catch (e) {
            return false;
          }
        })()
      )
        kind = "JSON text data";
      else if (/^-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/.test(c)) kind = "OpenSSH private key";
      else if (/^ssh-(ed25519|rsa) /.test(c)) kind = "OpenSSH ED25519 public key";
      else if (/^<!doctype html|^<html/i.test(c)) kind = "HTML document, ASCII text";
      else if (/[^\x00-\x7f]/.test(c)) kind = "Unicode text, UTF-8 text";
      else kind = "ASCII text" + (c.split("\n").some((l) => l.length > 300) ? ", with very long lines" : "");
      o.o(`${t}: ${kind}\n`);
    }
    return o.r();
  };
  C.truncate = (argv, ctx) => {
    const { f, pos } = opts(argv, "s", ["size"]);
    const o = out();
    const spec = String(f.s || f.size || "");
    if (!spec) {
      o.e("truncate: you must specify either '--size' or '--reference'\nTry 'truncate --help' for more information.");
      return o.r();
    }
    for (const t of pos) {
      const p = ctx.resolve(t);
      const fs = ctx.vfs;
      if (!fs.exists(p)) {
        if (f.c) continue;
        if (!ctx.shell.canWrite(p)) {
          o.e(`truncate: cannot open '${t}' for writing: Permission denied`);
          continue;
        }
        fs.write(p, "", owner(ctx));
      }
      if (!ctx.shell.canWrite(p)) {
        o.e(`truncate: cannot open '${t}' for writing: Permission denied`);
        continue;
      }
      const n = fs.node(p);
      const cur = fs.fileSize(n);
      const m = spec.match(/^([+-]?)(\d+)([KMGT]?)(i?B?)$/i);
      if (!m) {
        o.e(`truncate: Invalid number: ‘${spec}’`);
        return o.r();
      }
      const v = Number(m[2]) * { "": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4 }[m[3].toUpperCase()];
      const size = m[1] === "+" ? cur + v : m[1] === "-" ? Math.max(0, cur - v) : v;
      if (size === 0) {
        n.content = "";
        n.size = undefined;
      } else if (size < n.content.length) {
        n.content = n.content.slice(0, size);
        n.size = undefined;
      } else n.size = size;
      n.mtime = ctx.world.now();
    }
    ctx.world.reconcile();
    return o.r();
  };
  C.fallocate = (argv, ctx) => {
    const { f, pos } = opts(argv, "l", ["length"]);
    const o = out();
    const spec = String(f.l || f.length || "");
    const m = spec.match(/^(\d+)([KMGT]?)/i);
    if (!m || !pos[0]) {
      o.e("fallocate: no length argument specified\nTry 'fallocate --help' for more information.");
      return o.r();
    }
    const p = ctx.resolve(pos[0]);
    if (!ctx.shell.canWrite(p)) {
      o.e(`fallocate: cannot open ${pos[0]}: Permission denied`);
      return o.r();
    }
    const size =
      Number(m[1]) * { "": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4 }[m[2].toUpperCase()];
    if (ctx.host && size > ctx.host.diskGiB * 1024 ** 3 - ctx.host.diskUsedBytes()) {
      o.e(`fallocate: fallocate failed: No space left on device`);
      return o.r();
    }
    ctx.vfs.write(p, "", Object.assign(owner(ctx), { size }));
    ctx.world.reconcile();
    return o.r();
  };
  C.dd = (argv, ctx) => {
    const kv = Object.fromEntries(argv.map((a) => a.split("=")).filter((x) => x.length === 2));
    const o = out();
    const unit = (s) => {
      const m = String(s || "512").match(/^(\d+)([kKMG]?)/);
      return Number(m[1]) * { "": 1, "k": 1024, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3 }[m[2]];
    };
    const bs = unit(kv.bs),
      count = kv.count !== undefined ? Number(kv.count) : 1;
    const bytes = bs * count;
    if (kv.of) {
      const p = ctx.resolve(kv.of);
      if (kv.of !== "/dev/null") {
        if (!ctx.shell.canWrite(p)) {
          o.e(`dd: failed to open '${kv.of}': Permission denied`);
          return o.r();
        }
        if (ctx.host && bytes > ctx.host.diskGiB * 1024 ** 3 - ctx.host.diskUsedBytes()) {
          o.e(`dd: error writing '${kv.of}': No space left on device`);
          return o.r();
        }
        const src = kv.if && !/^\/dev\/(zero|urandom|random)$/.test(kv.if) ? ctx.vfs.read(ctx.resolve(kv.if)) : null;
        ctx.vfs.write(
          p,
          src !== null && src !== undefined ? src.slice(0, bytes) : "",
          Object.assign(owner(ctx), src ? {} : { size: bytes }),
        );
      }
    }
    const secs = Math.max(0.01, bytes / 1.2e9);
    o.e(
      `${count}+0 records in\n${count}+0 records out\n${bytes} bytes (${human(bytes, true)}B, ${human(bytes)}iB) copied, ${secs.toFixed(4)} s, ${human(bytes / secs, true)}B/s`,
      0,
    );
    ctx.world.reconcile();
    return o.r();
  };
  C.tree = (argv, ctx) => {
    const { f, pos } = opts(argv, "LIP");
    const o = out();
    const roots = pos.length ? pos : ["."];
    const fs = ctx.vfs;
    const max = f.L ? Number(f.L) : Infinity;
    let nd = 0,
      nf = 0;
    for (const r of roots) {
      const p = ctx.resolve(r);
      if (!fs.isDir(p)) {
        o.o(`${r}  [error opening dir]\n`);
        continue;
      }
      o.o((tty(ctx) ? `\x1b[01;34m${r}\x1b[0m` : r) + "\n");
      const walk = (dir, pre, depth) => {
        if (depth > max) return;
        let kids = fs.children(dir).filter((k) => f.a || !k.name.startsWith("."));
        if (f.d) kids = kids.filter((k) => k.dir);
        if (f.I) {
          const re = IG.bash.globRe(f.I);
          kids = kids.filter((k) => !re.test(k.name));
        }
        kids.forEach((k, i) => {
          const last = i === kids.length - 1;
          const nm = lsName(ctx, k, {}, tty(ctx)) + (k.link ? " -> " + k.node.target : "");
          o.o(pre + (last ? "└── " : "├── ") + (f.h ? `[${human(k.size).padStart(4)}]  ` : "") + nm + "\n");
          if (k.dir) {
            nd++;
            walk(k.path, pre + (last ? "    " : "│   "), depth + 1);
          } else nf++;
        });
      };
      walk(p, "", 1);
    }
    o.o(`\n${nd} director${nd === 1 ? "y" : "ies"}${f.d ? "" : `, ${nf} file${nf === 1 ? "" : "s"}`}\n`);
    return o.r();
  };
  C.du = (argv, ctx) => {
    const { f, pos } = opts(argv, "d", ["max-depth", "exclude"]);
    const o = out();
    const fs = ctx.vfs;
    const targets = pos.length ? pos : ["."];
    const depthMax =
      f.s || f.summarize
        ? 0
        : f.d !== undefined
          ? Number(f.d)
          : f["max-depth"] !== undefined
            ? Number(f["max-depth"])
            : Infinity;
    const fmt = (n) =>
      f.h || f["human-readable"] ? human(n) : f.m ? String(Math.ceil(n / 1048576)) : String(Math.ceil(n / 1024));
    const blocks = (n) => Math.ceil(n / 4096) * 4096;
    let grand = 0;
    for (const t of targets) {
      const p = ctx.resolve(t);
      if (!fs.exists(p)) {
        o.e(`du: cannot access '${t}': No such file or directory`);
        continue;
      }
      const sizeOf = (q) => {
        const n = fs.lnode(q);
        if (n.type !== "d") return blocks(fs.fileSize(n));
        return 4096 + fs.children(q).reduce((s, k) => s + sizeOf(k.path), 0);
      };
      const denied = [];
      const visit = (q, label, depth) => {
        const n = fs.lnode(q);
        if (n.type === "d" && !ctx.pod && !ctx.container && !ctx.host.allowed(ctx.user, n, "r")) {
          denied.push(label);
          return 4096;
        }
        if (n.type !== "d") {
          const s = blocks(fs.fileSize(n));
          if (f.a && depth <= depthMax) o.o(`${fmt(s)}\t${label}\n`);
          return s;
        }
        let total = 4096;
        for (const k of fs.children(q)) total += visit(k.path, label.replace(/\/$/, "") + "/" + k.name, depth + 1);
        if (depth <= depthMax) o.o(`${fmt(total)}\t${label}\n`);
        return total;
      };
      const total = visit(p, t, 0);
      void sizeOf;
      for (const d of denied) o.e(`du: cannot read directory '${d}': Permission denied`);
      grand += total;
    }
    if (f.c || f.total) o.o(`${fmt(grand)}\ttotal\n`);
    return o.r();
  };

  /* ================================================================ viewing */
  C.cat = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    const r = inputs(ctx, pos, "cat");
    let n = 0;
    for (const t of r.texts) {
      let text = t.text;
      if (f.s || f["squeeze-blank"]) text = text.replace(/\n{3,}/g, "\n\n");
      if (f.n || f.b || f.number)
        text =
          lines(text)
            .map((l) => (f.b && !l ? l : String(++n).padStart(6) + "\t" + l))
            .join("\n") + (text.endsWith("\n") ? "\n" : "");
      if (f.A || f.E || f["show-ends"]) text = text.replace(/\t/g, f.A ? "^I" : "\t").replace(/\n/g, "$\n");
      o.o(text);
    }
    r.errs.forEach((e) => o.e(e));
    return o.r();
  };
  C.tac = (argv, ctx) => {
    const r = inputs(
      ctx,
      argv.filter((a) => !a.startsWith("-")),
      "tac",
    );
    const o = out();
    for (const t of r.texts) o.o(join(lines(t.text).reverse()));
    r.errs.forEach((e) => o.e(e));
    return o.r();
  };
  function headTail(argv, ctx, cmd) {
    const o = out();
    let n = 10,
      c = null,
      plus = false,
      quiet = false,
      verbose = false;
    const files = [];
    const fail = (msg) => {
      o.e(`${cmd}: ${msg}`);
      return o.r();
    };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      let m;
      if (a === "--") {
        files.push(...argv.slice(i + 1));
        break;
      }
      if (a === "-n" || a === "--lines" || a === "-c" || a === "--bytes") {
        const bytes = a === "-c" || a === "--bytes";
        const v = argv[++i];
        if (v === undefined)
          return fail(
            `option requires an argument -- '${bytes ? "c" : "n"}'\nTry '${cmd} --help' for more information.`,
          );
        if (!/^[+-]?\d+$/.test(v)) return fail(`invalid number of ${bytes ? "bytes" : "lines"}: '${v}'`);
        plus = v.startsWith("+");
        if (bytes) c = Number(v);
        else n = parseInt(v.replace("+", ""), 10);
        continue;
      }
      if ((m = a.match(/^(?:-n|--lines=)([+-]?\d+)$/))) {
        plus = m[1].startsWith("+");
        n = parseInt(m[1].replace("+", ""), 10);
        continue;
      }
      if ((m = a.match(/^-c(\d+)$/))) {
        c = Number(m[1]);
        continue;
      }
      if ((m = a.match(/^-(\d+)$/))) {
        n = Number(m[1]);
        continue;
      }
      if (a === "-f" || a === "-F" || a === "--follow") {
        o.followed = true;
        continue;
      }
      if (a === "-q") {
        quiet = true;
        continue;
      }
      if (a === "-v") {
        verbose = true;
        continue;
      }
      files.push(a);
    }
    const r = inputs(ctx, files, cmd);
    r.texts.forEach((t, k) => {
      if ((r.texts.length > 1 && !quiet) || verbose)
        o.o(`${k ? "\n" : ""}==> ${t.name === "-" ? "standard input" : t.name} <==\n`);
      if (c !== null) {
        if (cmd === "head") o.o(t.text.slice(0, c));
        else o.o(plus ? t.text.slice(Math.max(0, c - 1)) : c ? t.text.slice(-Math.abs(c)) : "");
        return;
      }
      const l = lines(t.text);
      let sel;
      if (cmd === "head") sel = n < 0 ? l.slice(0, Math.max(0, l.length + n)) : l.slice(0, n);
      else sel = plus ? l.slice(Math.max(0, n - 1)) : l.slice(Math.max(0, l.length - Math.abs(n)));
      o.o(join(sel));
    });
    r.errs.forEach((e) =>
      o.e(
        cmd === "head"
          ? e.replace(
              /^head: (.*): (No such file or directory|Permission denied|Is a directory)$/,
              "head: cannot open '$1' for reading: $2",
            )
          : e.replace(
              /^tail: (.*): (No such file or directory|Permission denied)$/,
              "tail: cannot open '$1' for reading: $2",
            ),
      ),
    );
    if (o.followed && cmd === "tail")
      o.e(
        IG.t(
          "ℹ -f（追従）はシミュレーションでは実行し続けられないため、現在の内容を表示しました。新しいログはもう一度 tail で確認してください。",
        ),
        o.code,
      );
    return o.r();
  }
  C.head = (a, ctx) => headTail(a, ctx, "head");
  C.tail = (a, ctx) => headTail(a, ctx, "tail");
  C.less = (argv, ctx) => {
    const files = argv.filter((a) => !a.startsWith("-") && !a.startsWith("+"));
    const r = C.cat(files, ctx);
    if (tty(ctx) && !r.code)
      r.stderr = (r.stderr || "") + IG.t("(END) ℹ ページャ操作は再現していないため全文を表示しました\n");
    return r;
  };
  C.more = C.less;
  C.view = (a, ctx) => editor(a, ctx, true);
  C.wc = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    const r = inputs(ctx, pos, "wc");
    const sel = ["l", "w", "m", "c", "L"].filter(
      (k) => f[k] || f[{ l: "lines", w: "words", m: "chars", c: "bytes", L: "max-line-length" }[k]],
    );
    const show = sel.length ? sel : ["l", "w", "c"];
    const rows = r.texts.map((t) => {
      const s = t.text;
      const v = {
        l: (s.match(/\n/g) || []).length,
        w: (s.match(/\S+/g) || []).length,
        m: [...s].length,
        c: typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : Buffer.byteLength(s),
        L: Math.max(0, ...lines(s).map((x) => x.length)),
      };
      return { v, name: t.name === "-" ? "" : t.name };
    });
    if (rows.length > 1) {
      const sum = (k) => rows.reduce((s, x) => s + x.v[k], 0);
      rows.push({
        v: { l: sum("l"), w: sum("w"), m: sum("m"), c: sum("c"), L: Math.max(...rows.map((x) => x.v.L)) },
        name: "total",
      });
    }
    const width =
      rows.length > 1 || show.length > 1 ? Math.max(...rows.flatMap((x) => show.map((k) => String(x.v[k]).length))) : 0;
    for (const row of rows)
      o.o(show.map((k) => String(row.v[k]).padStart(width)).join(" ") + (row.name ? " " + row.name : "") + "\n");
    r.errs.forEach((e) => o.e(e));
    return o.r();
  };
  C.tee = (argv, ctx) => {
    const { f, pos } = opts(argv);
    const o = out();
    const data = ctx.stdin;
    for (const t of pos) {
      if (t === "/dev/null") continue;
      const p = ctx.resolve(t);
      const why = cannotWrite(ctx, p);
      if (why) {
        o.e(`tee: ${t}: ${why}`);
        continue;
      }
      ctx.vfs.write(p, data, Object.assign(ctx.vfs.exists(p) ? {} : owner(ctx), { append: !!(f.a || f.append) }));
    }
    o.o(data);
    ctx.world.reconcile();
    return o.r();
  };

  /* ================================================================ checksums / encoding */
  function sumCmd(algo) {
    return (argv, ctx) => {
      const { f, pos } = opts(argv);
      const o = out();
      const H = IG.hash[algo];
      if (f.c || f.check) {
        const r = inputs(ctx, pos, algo + "sum");
        let bad = 0;
        for (const t of r.texts)
          for (const l of lines(t.text)) {
            const m = l.match(/^([0-9a-f]+)\s+\*?(.+)$/);
            if (!m) continue;
            const p = ctx.resolve(m[2]);
            const c = ctx.vfs.read(p);
            if (c === undefined) {
              o.o(`${m[2]}: FAILED open or read\n`);
              bad++;
              continue;
            }
            const okk = H(c) === m[1];
            if (!okk) bad++;
            if (!f.quiet || !okk) o.o(`${m[2]}: ${okk ? "OK" : "FAILED"}\n`);
          }
        if (bad) o.e(`${algo}sum: WARNING: ${bad} computed checksum did NOT match`);
        return o.r();
      }
      const r = inputs(ctx, pos, algo + "sum");
      for (const t of r.texts) o.o(`${H(t.text)}  ${t.name}\n`);
      r.errs.forEach((e) => o.e(e));
      return o.r();
    };
  }
  IG.sumCmd = sumCmd;
  C.md5sum = sumCmd("md5");
  C.sha1sum = sumCmd("sha1");
  C.sha256sum = sumCmd("sha256");
  C.base64 = (argv, ctx) => {
    const { f, pos } = opts(argv, "w", ["wrap"]);
    const o = out();
    const r = inputs(ctx, pos, "base64");
    const t = r.texts.map((x) => x.text).join("");
    if (f.d || f.decode) {
      const d = U.unb64(t.replace(/\s+/g, ""));
      if (d === null) {
        o.e("base64: invalid input");
        return o.r();
      }
      o.o(d);
      return o.r();
    }
    const enc = U.b64(t);
    const w = f.w !== undefined ? Number(f.w) : f.wrap !== undefined ? Number(f.wrap) : 76;
    o.o((w ? enc.match(new RegExp(`.{1,${w}}`, "g")) || [] : [enc]).join("\n") + "\n");
    r.errs.forEach((e) => o.e(e));
    return o.r();
  };

  /* ================================================================ misc text producers */
  C.seq = (argv) => {
    // A negative number is an operand, not an option: seq 5 -1 1
    const f = {},
      pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (/^-(?!\d|\.\d)/.test(a) && a !== "-") {
        const long = a.match(/^--(separator|format)(?:=(.*))?$/);
        if (long) f[long[1][0]] = long[2] ?? argv[++i];
        else if (/^-[sf]/.test(a)) f[a[1]] = a.slice(2) || argv[++i];
        else if (a === "-w" || a === "--equal-width") f.w = true;
        else pos.push(a);
      } else pos.push(a);
    }
    const nums = pos.map(Number);
    if (!pos.length)
      return { stdout: "", stderr: "seq: missing operand\nTry 'seq --help' for more information.\n", code: 1 };
    if (nums.some(isNaN))
      return {
        stdout: "",
        stderr: `seq: invalid floating point argument: ‘${pos.find((x) => isNaN(Number(x)))}’\nTry 'seq --help' for more information.\n`,
        code: 1,
      };
    const [a, step, b] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
    if (!step)
      return {
        stdout: "",
        stderr: `seq: invalid Zero increment value: ‘${pos[1]}’\nTry 'seq --help' for more information.\n`,
        code: 1,
      };
    const out2 = [];
    const dec = Math.max(...pos.map((x) => (x.split(".")[1] || "").length));
    for (let v = a; step > 0 ? v <= b + 1e-9 : v >= b - 1e-9; v += step) {
      out2.push(v.toFixed(dec));
      if (out2.length > 100000) break;
    }
    const w = f.w ? Math.max(...out2.map((x) => x.length)) : 0;
    return out2.length ? out2.map((x) => x.padStart(w, "0")).join(f.s ?? "\n") + "\n" : "";
  };
  C.yes = (argv) => ({
    stdout:
      Array(1000)
        .fill(argv.length ? argv.join(" ") : "y")
        .join("\n") + "\n",
    stderr: "",
    code: 0,
  });
  C.sleep = (argv, ctx) => {
    const n = argv.reduce(
      (s, a) => s + (parseFloat(a) || 0) * ({ s: 1, m: 60, h: 3600, d: 86400 }[a.slice(-1)] || 1),
      0,
    );
    if (!argv.length)
      return { stdout: "", stderr: "sleep: missing operand\nTry 'sleep --help' for more information.\n", code: 1 };
    IG.clock.offset += Math.min(n, 3600) * 1000;
    ctx.world.reconcile();
    return "";
  };
  C.true = () => "";
  C.false = () => ({ stdout: "", stderr: "", code: 1 });

  /* ================================================================ identity & system info */
  function parseDate(s, now) {
    if (!s) return now;
    const t = String(s).trim();
    if (/^@\d+$/.test(t)) return Number(t.slice(1)) * 1000;
    let m;
    if (t === "now") return now;
    if (t === "yesterday") return now - 86400e3;
    if (t === "tomorrow") return now + 86400e3;
    if ((m = t.match(/^([+-]?\d+)\s*(second|minute|hour|day|week|month|year)s?(\s+ago)?$/))) {
      const mult = {
        second: 1e3,
        minute: 60e3,
        hour: 3600e3,
        day: 86400e3,
        week: 7 * 86400e3,
        month: 30 * 86400e3,
        year: 365 * 86400e3,
      }[m[2]];
      return now + Number(m[1]) * mult * (m[3] ? -1 : 1);
    }
    if ((m = t.match(/^(\d+)\s*(second|minute|hour|day|week)s?\s+ago$/)))
      return now - Number(m[1]) * { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3 }[m[2]];
    const d = Date.parse(
      t.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(t) || /^\d{4}-\d\d-\d\d$/.test(t) ? "" : "Z"),
    );
    return isNaN(d) ? NaN : d;
  }
  IG.parseDate = parseDate;
  function strftime(fmt, t, utc = true) {
    const d = new Date(t);
    const g = utc
      ? {
          Y: d.getUTCFullYear(),
          m: d.getUTCMonth(),
          d: d.getUTCDate(),
          H: d.getUTCHours(),
          M: d.getUTCMinutes(),
          S: d.getUTCSeconds(),
          w: d.getUTCDay(),
        }
      : null;
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const jan1 = Date.UTC(g.Y, 0, 1);
    return fmt.replace(/%([%a-zA-Z:]|:z)/g, (m, k) => {
      switch (k) {
        case "Y":
          return g.Y;
        case "y":
          return p(g.Y % 100);
        case "m":
          return p(g.m + 1);
        case "d":
          return p(g.d);
        case "e":
          return String(g.d).padStart(2);
        case "H":
          return p(g.H);
        case "I":
          return p(((g.H + 11) % 12) + 1);
        case "M":
          return p(g.M);
        case "S":
          return p(g.S);
        case "p":
          return g.H < 12 ? "AM" : "PM";
        case "F":
          return `${g.Y}-${p(g.m + 1)}-${p(g.d)}`;
        case "T":
          return `${p(g.H)}:${p(g.M)}:${p(g.S)}`;
        case "R":
          return `${p(g.H)}:${p(g.M)}`;
        case "D":
          return `${p(g.m + 1)}/${p(g.d)}/${p(g.Y % 100)}`;
        case "a":
          return DAYS[g.w].slice(0, 3);
        case "A":
          return DAYS[g.w];
        case "b":
        case "h":
          return MONTHS[g.m].slice(0, 3);
        case "B":
          return MONTHS[g.m];
        case "s":
          return Math.floor(t / 1000);
        case "N":
          return p(Math.floor(t % 1000) * 1e6, 9);
        case "j":
          return p(Math.floor((t - jan1) / 86400e3) + 1, 3);
        case "u":
          return g.w || 7;
        case "w":
          return g.w;
        case "Z":
          return "UTC";
        case "z":
          return "+0000";
        case ":z":
          return "+00:00";
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "%":
          return "%";
        case "c":
          return `${DAYS[g.w].slice(0, 3)} ${MONTHS[g.m].slice(0, 3)} ${String(g.d).padStart(2)} ${p(g.H)}:${p(g.M)}:${p(g.S)} ${g.Y}`;
        case "x":
          return `${p(g.m + 1)}/${p(g.d)}/${p(g.Y % 100)}`;
        case "X":
          return `${p(g.H)}:${p(g.M)}:${p(g.S)}`;
        case "V": {
          const dt = new Date(Date.UTC(g.Y, g.m, g.d));
          const day = dt.getUTCDay() || 7;
          dt.setUTCDate(dt.getUTCDate() + 4 - day);
          const y1 = Date.UTC(dt.getUTCFullYear(), 0, 1);
          return p(Math.ceil(((dt - y1) / 86400e3 + 1) / 7));
        }
      }
      return m;
    });
  }
  IG.strftime = strftime;
  C.date = (argv, ctx) => {
    const { f, pos } = opts(argv, "ds", ["date", "set", "iso-8601", "rfc-3339"]);
    const o = out();
    let t = ctx.world.now();
    if (f.s || f.set) {
      if (ctx.user !== "root") {
        o.e(`date: cannot set date: Operation not permitted`);
      } else o.e(IG.t("ℹ 訓練環境では時刻の変更は反映されません（timedatectl / chrony が管理）。"), 0);
    }
    if (f.d || f.date) {
      t = parseDate(f.d || f.date, t);
      if (isNaN(t)) {
        o.e(`date: invalid date ‘${f.d || f.date}’`);
        return o.r();
      }
    }
    if (f.r) {
      const n = ctx.vfs.node(ctx.resolve(f.r));
      if (n) t = n.mtime;
    }
    const fmt = pos.find((x) => x.startsWith("+"));
    if (fmt) o.o(strftime(fmt.slice(1), t) + "\n");
    else if (f["iso-8601"] !== undefined || f.I)
      o.o(strftime(f["iso-8601"] === "seconds" ? "%Y-%m-%dT%H:%M:%S+00:00" : "%Y-%m-%d", t) + "\n");
    else if (f.R || f["rfc-email"]) o.o(strftime("%a, %d %b %Y %H:%M:%S +0000", t) + "\n");
    else o.o(strftime("%a %b %e %H:%M:%S %Z %Y", t).replace(/ {2}(\d) /, "  $1 ") + "\n");
    return o.r();
  };
  C.whoami = (argv, ctx) =>
    ctx.pod && ctx.pod.openshift
      ? { stdout: "", stderr: "whoami: cannot find name for user ID 1000680000\n", code: 1 }
      : ctx.pod || ctx.container
        ? "root"
        : ctx.user;
  C.id = (argv, ctx) => {
    const { f, pos } = opts(argv);
    if (ctx.pod && ctx.pod.openshift) return "uid=1000680000(1000680000) gid=0(root) groups=0(root),1000680000";
    if (ctx.pod || ctx.container) return "uid=0(root) gid=0(root) groups=0(root)";
    const h = ctx.host;
    const u = pos[0] || ctx.user;
    const x = h.users[u];
    if (!x) return { stdout: "", stderr: `id: ‘${u}’: no such user\n`, code: 1 };
    const pg = h.primaryGroup(u);
    const gs = h.groupsOf(u);
    if (f.u) return f.n ? u : String(x.uid);
    if (f.g) return f.n ? pg : String(x.gid);
    const ordered = [pg].concat(gs.filter((g) => g !== pg));
    if (f.G) return f.n ? ordered.join(" ") : ordered.map((g) => h.groups[g].gid).join(" ");
    return `uid=${x.uid}(${u}) gid=${x.gid}(${pg}) groups=${[pg]
      .concat(gs.filter((g) => g !== pg))
      .map((g) => `${h.groups[g].gid}(${g})`)
      .join(",")}`;
  };
  C.groups = (argv, ctx) => {
    const h = ctx.host;
    const us = argv.length ? argv : [ctx.user];
    return us
      .map((u) =>
        h.users[u]
          ? (argv.length ? `${u} : ` : "") +
            [h.primaryGroup(u)].concat(h.groupsOf(u).filter((g) => g !== h.primaryGroup(u))).join(" ")
          : `groups: ‘${u}’: no such user`,
      )
      .join("\n");
  };
  C.hostname = (argv, ctx) => {
    if (ctx.pod) return ctx.pod.pod;
    if (ctx.container) return ctx.container.name.slice(0, 12);
    const h = ctx.host;
    if (argv.includes("-I") || argv.includes("--all-ip-addresses"))
      return h.ip + " " + (h.name === "bastion" && ctx.world.features.has("docker") ? "172.17.0.1 " : "");
    if (argv.includes("-i")) return h.ip;
    if (argv.includes("-f") || argv.includes("--fqdn")) return h.name + ".lab.local";
    if (argv.includes("-s")) return h.name;
    const pos = argv.filter((a) => !a.startsWith("-"));
    if (pos.length)
      return ctx.user === "root"
        ? {
            stdout: "",
            stderr: IG.t(
              "ℹ ホスト名の変更は hostnamectl set-hostname を使ってください（一時変更は再起動で消えます）。\n",
            ),
            code: 0,
          }
        : { stdout: "", stderr: "hostname: you must be root to change the host name\n", code: 1 };
    return h.name;
  };
  C.uname = (argv, ctx) => {
    const h = ctx.host;
    const kernel = ctx.pod || ctx.container ? "5.15.0-1066-aws" : h.kernel;
    const f = new Set(argv.join("").replace(/-/g, "").split(""));
    if (argv.includes("--all")) f.add("a");
    const name = ctx.pod ? ctx.pod.pod : ctx.container ? ctx.container.name.slice(0, 12) : h.name;
    const ver =
      h.os === "rhel"
        ? "#1 SMP PREEMPT_DYNAMIC Thu Apr 11 11:46:32 EDT 2024"
        : "#72-Ubuntu SMP Fri Aug 30 13:43:12 UTC 2024";
    if (f.has("a")) return `Linux ${name} ${kernel} ${ver} x86_64 x86_64 x86_64 GNU/Linux`;
    const parts = [];
    if (f.has("s") || f.size === 0) parts.push("Linux");
    if (f.has("n")) parts.push(name);
    if (f.has("r")) parts.push(kernel);
    if (f.has("v")) parts.push(ver);
    if (f.has("m") || f.has("p") || f.has("i")) parts.push("x86_64");
    if (f.has("o")) parts.push("GNU/Linux");
    return parts.join(" ");
  };
  C.nproc = (argv, ctx) => String(ctx.host.cpus);
  C.arch = () => "x86_64";
  C.uptime = (argv, ctx) => {
    const h = ctx.host;
    const up = ctx.world.now() - h.bootAt;
    const days = Math.floor(up / 86400e3),
      hrs = Math.floor((up % 86400e3) / 3600e3),
      mins = Math.floor((up % 3600e3) / 60e3);
    if (argv.includes("-p") || argv.includes("--pretty"))
      return `up ${days ? `${days} day${days > 1 ? "s" : ""}, ` : ""}${hrs} hour${hrs === 1 ? "" : "s"}, ${mins} minute${mins === 1 ? "" : "s"}`;
    if (argv.includes("-s") || argv.includes("--since")) return strftime("%F %T", h.bootAt);
    const load = h.loadavg();
    return ` ${strftime("%T", ctx.world.now())} up ${days ? `${days} days, ` : ""}${String(hrs).padStart(2)}:${String(mins).padStart(2, "0")},  ${ctx.shell.stack.filter((s) => s.host === h.name).length} user,  load average: ${load.map((x) => x.toFixed(2)).join(", ")}`;
  };
  C.env = (argv, ctx) => {
    const e = Object.assign({}, ctx.env);
    let i = 0;
    if (argv[0] === "-i" || argv[0] === "-") {
      for (const k of Object.keys(e)) delete e[k];
      i++;
    }
    while (argv[i] && argv[i].startsWith("-u")) {
      delete e[argv[i] === "-u" ? argv[++i] : argv[i].slice(2)];
      i++;
    }
    while (argv[i] && /^[A-Za-z_]\w*=/.test(argv[i])) {
      const k = argv[i].slice(0, argv[i].indexOf("="));
      e[k] = argv[i].slice(k.length + 1);
      i++;
    }
    if (argv[i]) {
      const sh = ctx.shell;
      const saved = Object.assign({}, sh.vars),
        savedExp = new Set(sh.exported);
      for (const [k, v] of Object.entries(e)) {
        sh.vars[k] = v;
        sh.exported.add(k);
      }
      try {
        return { stdout: "", stderr: "", code: sh.invoke(argv.slice(i), ctx.io) };
      } finally {
        sh.vars = saved;
        sh.exported = savedExp;
      }
    }
    return join(Object.entries(e).map(([k, v]) => `${k}=${v}`));
  };
  C.printenv = (argv, ctx) => {
    if (argv.length) {
      const vals = argv.map((k) => ctx.env[k]);
      return {
        stdout: join(vals.filter((v) => v !== undefined)),
        stderr: "",
        code: vals.every((v) => v !== undefined) ? 0 : 1,
      };
    }
    return join(Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`));
  };

  /* ================================================================ editors */
  function editor(argv, ctx, readonly) {
    const fname = argv.find((x) => !x.startsWith("-") && !x.startsWith("+"));
    if (ctx.pod || ctx.container) return { stdout: "", stderr: `sh: ${ctx.name}: not found\n`, code: 127 };
    if (!fname)
      return {
        stdout: "",
        stderr: IG.t("ℹ 編集するファイル名を指定してください（例: vi deployment.yaml）\n"),
        code: 1,
      };
    const p = ctx.resolve(fname);
    const fs = ctx.vfs;
    if (fs.isDir(p)) return { stdout: "", stderr: `"${fname}" is a directory\n`, code: 1 };
    if (!fs.isDir(VFS.parent(fs.real(p) || p)))
      return {
        stdout: "",
        stderr: IG.t(`"{0}" E212: Can't open file for writing (親ディレクトリが存在しません)\n`, { 0: fname }),
        code: 1,
      };
    if (fs.exists(p) && !ctx.shell.canRead(p))
      return {
        stdout: "",
        stderr: IG.t(`"{0}" [Permission Denied]\nℹ 読み取り権限がありません。sudo vi {1} を試してください。\n`, {
          0: fname,
          1: fname,
        }),
        code: 1,
      };
    const ro = readonly || argv.includes("-R") || !ctx.shell.canWrite(fs.real(p) || p);
    ctx.editor({
      path: fs.real(p) || p,
      host: ctx.host.name,
      readonly: ro,
      owner: ctx.user,
      group: ctx.host.primaryGroup(ctx.user),
      umask: umask(ctx),
      kind: ctx.name === "nano" ? "nano" : "vi",
    });
    return "";
  }
  C.vi = (a, ctx) => editor(a, ctx, false);
  C.vim = C.vi;
  C.nano = C.vi;
  C.vimdiff = C.vi;
  C.clear = (a, ctx) => {
    ctx.clear();
    return "";
  };
  C.reset = C.clear;
  /* ================================================================ POSIX ACL (setfacl / getfacl) */
  // node.acl = { u: {user: bits}, g: {group: bits}, g0: owning-group bits }; the mask lives in the
  // mode's group bits (as on Linux). node.dacl = full default ACL of a directory (inherited by the VFS).
  const permBits = (s) =>
    /^[0-7]$/.test(s)
      ? Number(s)
      : /^[rwxX-]*$/.test(s)
        ? (s.includes("r") ? 4 : 0) | (s.includes("w") ? 2 : 0) | (/[xX]/.test(s) ? 1 : 0)
        : null;
  const permStr = (b) => (b & 4 ? "r" : "-") + (b & 2 ? "w" : "-") + (b & 1 ? "x" : "-");
  const aclView = (n) => ({
    u0: (n.mode >> 6) & 7,
    u: Object.assign({}, n.acl ? n.acl.u : {}),
    g0: n.acl ? n.acl.g0 : (n.mode >> 3) & 7,
    g: Object.assign({}, n.acl ? n.acl.g : {}),
    mask: n.acl ? (n.mode >> 3) & 7 : null,
    o: n.mode & 7,
  });
  const unionMask = (a) => [a.g0, ...Object.values(a.u), ...Object.values(a.g)].reduce((x, y) => x | y, 0);
  function aclParse(spec, ctx, withPerms) {
    const res = [];
    let pos = 0;
    for (const raw of String(spec || "").split(",")) {
      const e = { def: false };
      let parts = raw.split(":");
      if (/^d(efault)?$/.test(parts[0])) {
        e.def = true;
        parts = parts.slice(1);
      }
      const t = { user: "u", group: "g", mask: "m", other: "o" }[parts[0]] || parts[0];
      if (!/^[ugmo]$/.test(t || "")) return { err: pos + 1 };
      e.type = t;
      if ((t === "m" || t === "o") && parts.length === 2) parts = [t, "", parts[1]];
      e.q = parts[1] || "";
      if (
        e.q &&
        ((t === "u" && !ctx.host.users[e.q]) || (t === "g" && !ctx.host.groups[e.q]) || t === "m" || t === "o")
      )
        return { err: pos + raw.indexOf(e.q) + 1 };
      if (withPerms) {
        e.permRaw = parts[2] === undefined ? "" : parts[2];
        e.perms = permBits(e.permRaw);
        if (e.perms === null || parts.length < 3) return { err: pos + raw.length + 1 };
      }
      res.push(e);
      pos += raw.length + 1;
    }
    return { list: res };
  }
  C.setfacl = (argv, ctx) => {
    const fs = ctx.vfs;
    const o = out();
    const ops = [],
      files = [];
    let rec = false,
      noMask = false,
      defOnly = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-m" || a === "--modify" || a === "-x" || a === "--remove") {
        ops.push({ op: a === "-m" || a === "--modify" ? "m" : "x", spec: argv[++i], flag: a });
        continue;
      }
      if (/^--(modify|remove)=/.test(a)) {
        ops.push({
          op: a.startsWith("--modify") ? "m" : "x",
          spec: a.slice(a.indexOf("=") + 1),
          flag: a.split("=")[0],
        });
        continue;
      }
      if (a === "--remove-all") {
        ops.push({ op: "b" });
        continue;
      }
      if (a === "--remove-default") {
        ops.push({ op: "k" });
        continue;
      }
      if (a === "--recursive") {
        rec = true;
        continue;
      }
      if (a === "--no-mask") {
        noMask = true;
        continue;
      }
      if (a === "--default") {
        defOnly = true;
        continue;
      }
      if (/^-[bkRnd]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (c === "b") ops.push({ op: "b" });
          if (c === "k") ops.push({ op: "k" });
          if (c === "R") rec = true;
          if (c === "n") noMask = true;
          if (c === "d") defOnly = true;
        }
        continue;
      }
      files.push(a);
    }
    if (!ops.length || !files.length) {
      o.e("Usage: setfacl [-bkndRLP] { -m|-M|-x|-X ... } file ...\nTry `setfacl --help' for more information.", 2);
      return o.r();
    }
    const parsed = [];
    for (const op of ops) {
      if (op.op === "b" || op.op === "k") {
        parsed.push(op);
        continue;
      }
      const r = aclParse(op.spec, ctx, op.op === "m");
      if (r.err) {
        o.e(`setfacl: Option ${op.flag}: Invalid argument near character ${r.err}`, 2);
        return o.r();
      }
      parsed.push({ op: op.op, list: r.list.map((e) => Object.assign(e, { def: e.def || defOnly })) });
    }
    for (const t of files) {
      const p = ctx.resolve(t);
      if (!fs.exists(p)) {
        o.e(`setfacl: ${t}: No such file or directory`);
        continue;
      }
      for (const q of [p].concat(rec && fs.isDir(p) ? fs.walk(p) : [])) {
        const n = fs.node(q);
        const shown = q === p ? t : q;
        if (ctx.user !== "root" && n.owner !== ctx.user) {
          o.e(`setfacl: ${shown}: Operation not permitted`);
          continue;
        }
        const a = aclView(n);
        let d = n.dacl ? JSON.parse(JSON.stringify(n.dacl)) : null;
        let explicit = null,
          dExplicit = null,
          bad = false;
        for (const op of parsed) {
          if (op.op === "b") {
            a.u = {};
            a.g = {};
            a.mask = null;
            d = null;
            continue;
          }
          if (op.op === "k") {
            d = null;
            continue;
          }
          for (const e of op.list) {
            if (e.def && n.type !== "d") {
              if (q === p) o.e(`setfacl: ${shown}: Only directories can have default ACLs`);
              bad = true;
              break;
            }
            const tgt = e.def ? (d = d || { u0: a.u0, u: {}, g0: a.g0, g: {}, mask: null, o: a.o }) : a;
            const bits =
              e.permRaw && e.permRaw.includes("X") && !(n.type === "d" || n.mode & 0o111) ? e.perms & 6 : e.perms;
            if (op.op === "m") {
              if (e.type === "u") {
                if (e.q) tgt.u[e.q] = bits;
                else tgt.u0 = bits;
              } else if (e.type === "g") {
                if (e.q) tgt.g[e.q] = bits;
                else tgt.g0 = bits;
              } else if (e.type === "o") tgt.o = bits;
              else if (e.def) dExplicit = bits;
              else explicit = bits;
            } else if (e.q) delete (e.type === "u" ? tgt.u : tgt.g)[e.q];
          }
          if (bad) break;
        }
        if (bad) continue;
        const ext = Object.keys(a.u).length || Object.keys(a.g).length || explicit !== null;
        const mask = explicit !== null ? explicit : noMask && a.mask !== null ? a.mask : unionMask(a);
        if (ext) {
          n.acl = { u: a.u, g: a.g, g0: a.g0 };
          n.mode = (n.mode & ~0o777) | (a.u0 << 6) | (mask << 3) | a.o;
        } else {
          delete n.acl;
          n.mode = (n.mode & ~0o777) | (a.u0 << 6) | (a.g0 << 3) | a.o;
        }
        if (d) {
          d.mask = dExplicit !== null ? dExplicit : unionMask(d);
          n.dacl = d;
        } else delete n.dacl;
      }
    }
    return o.r();
  };
  C.getfacl = (argv, ctx) => {
    const fs = ctx.vfs;
    const { f, pos } = opts(argv, "");
    const o = out();
    if (!pos.length) {
      o.e("Usage: getfacl [-aceEsRLPtpndvh] file ...\nTry `getfacl --help' for more information.", 1);
      return o.r();
    }
    let warned = false;
    const tabs = (s) => s + "\t".repeat(Math.max(1, Math.ceil((32 - s.length) / 8)));
    const entries = (a, pre) => {
      const r = [];
      const eff = (s, b) => (a.mask !== null && (b & a.mask) !== b ? tabs(s) + "#effective:" + permStr(b & a.mask) : s);
      r.push(`${pre}user::${permStr(a.u0)}`);
      for (const [u, b] of Object.entries(a.u))
        r.push(eff(`${pre}user:${f.n ? (ctx.host.users[u] || { uid: u }).uid : u}:${permStr(b)}`, b));
      r.push(eff(`${pre}group::${permStr(a.g0)}`, a.g0));
      for (const [g, b] of Object.entries(a.g))
        r.push(eff(`${pre}group:${f.n ? (ctx.host.groups[g] || { gid: g }).gid : g}:${permStr(b)}`, b));
      if (a.mask !== null) r.push(`${pre}mask::${permStr(a.mask)}`);
      r.push(`${pre}other::${permStr(a.o)}`);
      return r;
    };
    for (const t of pos) {
      const p = ctx.resolve(t);
      if (!fs.exists(p)) {
        o.e(`getfacl: ${t}: No such file or directory`);
        continue;
      }
      for (const q of [p].concat(f.R && fs.isDir(p) ? fs.walk(p) : [])) {
        const n = fs.node(q);
        let name = q === p ? t : q;
        if (name.startsWith("/") && !f.p && !f["absolute-names"]) {
          if (!warned) o.e("getfacl: Removing leading '/' from absolute path names", 0);
          warned = true;
          name = name.replace(/^\/+/, "") || "/";
        }
        const res = [];
        if (!(f.c || f["omit-header"])) {
          res.push(`# file: ${name}`, `# owner: ${n.owner}`, `# group: ${n.group}`);
          const fl = (n.mode & 0o4000 ? "s" : "-") + (n.mode & 0o2000 ? "s" : "-") + (n.mode & 0o1000 ? "t" : "-");
          if (fl !== "---") res.push(`# flags: ${fl}`);
        }
        if (!f.d) res.push(...entries(aclView(n), ""));
        if (n.dacl && !f.a) res.push(...entries(n.dacl, f.d ? "" : "default:"));
        o.o(res.join("\n") + "\n\n");
      }
    }
    return o.r();
  };
})((globalThis.IG = globalThis.IG || {}));
