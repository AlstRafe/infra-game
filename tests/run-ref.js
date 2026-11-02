#!/usr/bin/env node
/* Checks the command dictionary (js/ref/): every command the simulator runs has an entry, links between
 * entries resolve, every example runs in the simulator as written, and searches find what people ask for.
 * Usage: node tests/run-ref.js [-v] */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script src="\.\/(js\/[^"]+)"/g)]
  .map((m) => m[1])
  .filter((s) => !s.startsWith("js/ui/"));
const ctx = vm.createContext({ console, Buffer, Date, Math, JSON, TextEncoder, setTimeout, clearTimeout });
ctx.globalThis = ctx;
for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(root, s), "utf8"), ctx, { filename: s });
const IG = ctx.IG;
const R = IG.cmdref;
const verbose = process.argv.includes("-v");
let failed = 0;
function check(name, problems, detail) {
  const ok = !problems.length;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${detail}`);
  if (!ok || verbose) for (const p of problems.slice(0, verbose ? 1e9 : 25)) console.log("      " + p);
  if (!ok && !verbose && problems.length > 25) console.log(`      … ${problems.length - 25} more (-v)`);
}

// 1. coverage: every command and builtin of the simulator has an entry
const sim = Object.keys(IG.commands)
  .concat(Object.keys(IG.Shell.BUILTINS))
  .filter((n) => !n.includes("_"));
check(
  "coverage",
  [...new Set(sim)].filter((n) => !R.byName[n]).map((n) => `no entry: ${n}`),
  `${R.entries.length} entries, ${R.tasks.length} recipes, ${new Set(sim).size} simulator commands`,
);

// 2. shape and links
const shape = [];
for (const e of R.entries) {
  if (e.same) {
    if (!R.byName[e.same] || R.byName[e.same].same) shape.push(`${e.name}: alias of unknown ${e.same}`);
    continue;
  }
  for (const f of ["cat", "en", "ja", "syn"]) if (!e[f]) shape.push(`${e.name}: no ${f}`);
  if (!(R.cats[e.topic] || {})[e.cat]) shape.push(`${e.name}: unknown category ${e.topic}/${e.cat}`);
  if (!/^https:\/\//.test(e.doc)) shape.push(`${e.name}: doc is not an https URL (${e.doc})`);
  if (!e.ex.length) shape.push(`${e.name}: no examples`);
  for (const r of e.rel) if (!R.byName[r]) shape.push(`${e.name}: related ${r} has no entry`);
}
const ids = new Set();
for (const t of R.tasks) {
  if (ids.has(t.id)) shape.push(`recipe id clash: ${t.q}`);
  ids.add(t.id);
  if (!t.do.length) shape.push(`${t.q}: no steps`);
  for (const n of t.see) if (!R.byName[n]) shape.push(`${t.q}: see ${n} has no entry`);
}
check("links", shape, "fields, categories, https docs, related entries, recipe ids");

// 3. every command line of the examples and recipes names known commands
const lines = [];
for (const e of R.entries) for (const [c, , real] of e.ex) lines.push([e.name, c, !e.nosim && !real]);
for (const t of R.tasks) for (const [c, , real] of t.do) lines.push([t.q.slice(0, 20), c, !real && R.runnable(c)]);
check(
  "resolve",
  lines.filter(([, c]) => !R.resolve(c).length && !/^(\.|~)?\//.test(c)).map(([w, c]) => `${w}: ${c}`),
  `${lines.length} command lines (a script path alone is fine)`,
);

// 4. runnable examples run as written (errors about files or permissions are fine; unknown commands and options are not)
const BAD =
  /command not found|invalid option|unrecognized option|unknown (?:option|flag|command|shorthand)|illegal option|未対応(?!のため JSON)|not supported|internal simulator error/i;
const sandbox = IG.missions.find((m) => m.sandbox);
const runs = [];
let ran = 0;
for (const [w, c, runnable] of lines) {
  if (
    !runnable ||
    /<[^>]+>/.test(c) ||
    /^\s*(sudo\s+)?(vi|vim|nano|less|more|top|htop|watch|ssh|sftp|telnet|tmux|screen|passwd|visudo|crontab -e|journalctl -f|tail -f|reboot|shutdown|poweroff|exit|logout|exec)\b/.test(
      c,
    ) ||
    /\s-f\s*$|-it\b|--follow|\bwatch\b|tail -f|logs -f|-w\b.*get|kubectl .* -w\b/.test(c)
  )
    continue;
  IG.clock.offset = 0;
  const s = new IG.Session(sandbox);
  const r = s.run(c);
  ran++;
  const out = String(r.res.out || "").replace(/\x1b\[[\d;]*m/g, "");
  if (BAD.test(out)) runs.push(`${w}: $ ${c}\n        ${out.split("\n").find((l) => BAD.test(l))}`);
}
check("examples", runs, `${ran} runnable examples executed in the free lab`);

// 5. search: what people type → what they need (the expected item in the top N)
const top = (q, n = 3, o) =>
  R.search(q, o)
    .slice(0, n)
    .map((h) => (h.kind === "task" ? "t:" + h.item.q : h.item.name));
const S = [
  ["ls", 1, "ls"],
  ["tar", 1, "tar"],
  ["kubectl logs", 1, "kubectl logs"],
  ["k get pods -A", 1, "kubectl get"],
  ["docker compose up -d", 1, "docker compose up"],
  ["aws s3 ls", 1, "aws s3 ls"],
  ["sudo ss -tlnp | grep :80", 1, "ss"],
  ["list open files", 1, "lsof"],
  ["ポートを使っているプロセス", 3, "lsof"],
  ["ディスクの空き", 2, "df"],
  ["ファイルを削除", 3, "rm"],
  ["重複", 2, "uniq"],
  ["名前を変える", 3, "mv"],
  ["ログをリアルタイムで見る", 3, "t:ログをリアルタイムで見る"],
  ["pod 再起動", 2, "kubectl rollout restart"],
  ["CrashLoopBackOff", 3, "t:CrashLoopBackOff の原因を調べる"],
  ["イメージの脆弱性", 3, "t:イメージの脆弱性を調べる"],
  ["脆弱性", 6, "harbor artifact vulnerabilities"],
  ["ユーザーをグループに追加", 3, "usermod"],
  ["dns 名前解決できない", 3, "dig"],
  ["コンテナに入りたい", 5, "docker exec"],
  ["消したい ファイル", 3, "rm"],
  ["圧縮", 5, "tar"],
  ["パッケージをインストール", 4, "apt"],
  ["ノード メンテナンス", 3, "kubectl drain"],
  ["自分は誰", 2, "t:自分が誰で"],
  ["whoami", 1, "whoami"],
  ["for ループ", 3, "for"],
  ["locate", 1, "locate"],
];
const miss = [];
for (const [q, n, want] of S) {
  const got = top(q, n);
  if (!got.some((g) => g === want || g.startsWith(want)))
    miss.push(`"${q}" → expected ${want} in top ${n}, got ${got.join(" | ")}`);
}
if (R.search("", {}).length) miss.push("empty query returns results");
if (R.search("docker", { topic: "basics" }).some((h) => h.item.topic !== "basics")) miss.push("topic filter leaks");
check("search", miss, `${S.length} queries`);

// 6. the terminal: man / --help / whatis / apropos for dictionary-only commands
const w = new IG.World();
const sh = new IG.Shell(w);
const run = (c) => {
  const r = sh.exec(c);
  return {
    out: r.chunks
      .map((x) => x.text)
      .join("")
      .replace(/\x1b\[[\d;]*m/g, ""),
    code: r.code,
  };
};
const T = [];
const expect = (c, re, code = 0) => {
  const r = run(c);
  if (!re.test(r.out) || r.code !== code) T.push(`$ ${c} → [${r.code}] ${r.out.split("\n").slice(0, 3).join(" / ")}`);
};
expect("man ls | head -1", /^LS\(1\)\s+User Commands\s+LS\(1\)\n$/);
expect(
  "man fuser",
  /NAME\n\s+fuser - identify processes using files or sockets[\s\S]*EXAMPLES[\s\S]*SEE ALSO[\s\S]*https:\/\/manpages\.debian\.org\/fuser\.1/,
);
expect("man docker-run", /^DOCKER-RUN\(1\)[\s\S]*docker run \[OPTIONS\]/);
expect("man 5 crontab | head -1", /^CRONTAB\(1\)/);
expect("man nosuchcmd", /No manual entry for nosuchcmd/, 16);
expect(
  "whatis ss nosuch",
  /^ss \(8\)\s+- another utility to investigate sockets\nnosuch: nothing appropriate\.\n$/,
  16,
);
expect("apropos socket", /^fuser \(1\)[\s\S]*^ss \(8\)/m);
expect(
  "apropos ポート 使用中",
  /^(fuser|lsof|ss) [\s\S]*やりたいこと別のレシピ[\s\S]*ポートを使っているプロセスを調べる/m,
);
expect("man -k 圧縮", /tar|gzip/);
expect("apropos qqqqzz", /nothing appropriate/, 16);
expect("fuser --help", /^Usage: fuser[\s\S]*Examples:[\s\S]*公式ドキュメント: https:/);
expect("grep --help | head -1", /^Usage: grep \[OPTION\.\.\.\] PATTERNS \[FILE\.\.\.\]\n$/);
expect("help cd", /^Usage: cd/);
expect("help ls", /no help topics match `ls'/, 1);
check("terminal", T, `${11 + 3} man / whatis / apropos / --help / help cases`);

console.log(failed ? `\n${failed} check(s) failed.` : "\nすべて OK");
process.exit(failed ? 1 : 0);
