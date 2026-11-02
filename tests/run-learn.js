#!/usr/bin/env node
/* Checks the learning data and engine: every question has choices or a model answer that passes its
 * own check, an explanation and a resolvable source; every certification's domains add up to 100%
 * and point at drills that exist; drills and mock exams can be played to a scored result.
 * Usage: node tests/run-learn.js [-v]  */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script src="\.\/(js\/[^"]+)"/g)]
  .map((m) => m[1])
  .filter((s) => !s.startsWith("js/ui/"));

const ctx = vm.createContext({ console, Buffer, Date, Math, JSON, setTimeout, clearTimeout });
ctx.globalThis = ctx;
for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(root, s), "utf8"), ctx, { filename: s });
const IG = ctx.IG;

const verbose = process.argv.includes("-v");
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log("FAIL  " + msg);
};

/* ---------------------------------------------------------------- drills */
let units = 0,
  questions = 0;
for (const topic of IG.drillTopics()) {
  const d = IG.drills[topic];
  if (d.levels.length !== IG.levels.length) fail(`${topic}: ${d.levels.length} levels (expected ${IG.levels.length})`);
  d.levels.forEach((l, i) => {
    if (l.n !== i + 1) fail(`${topic}: level ${i + 1} has n=${l.n}`);
  });
  for (const unit of IG.drillUnits(topic)) {
    units++;
    const where = `${topic}:${unit.n || "#" + unit.id} ${unit.title}`;
    if (!unit.title || !unit.goal) fail(`${where}: title/goal missing`);
    if (!(unit.points || []).length) fail(`${where}: no points`);
    if (!(unit.refs || []).length) fail(`${where}: no sources`);
    for (const k of unit.refs || []) if (!IG.drillRef(topic, k)) fail(`${where}: unknown source key "${k}"`);
    if (unit.qs.length < 3) fail(`${where}: only ${unit.qs.length} questions`);
    for (const q of unit.qs) {
      questions++;
      const qw = `${where} / "${String(q.q).slice(0, 28)}…"`;
      if (!q.x) fail(`${qw}: no explanation`);
      const ref = IG.drillRef(topic, q.r);
      if (!ref) fail(`${qw}: unknown source key "${q.r}"`);
      else if (!/^https:\/\//.test(ref.url)) fail(`${qw}: source is not https`);
      if (q.c) {
        if (q.c.length < 3) fail(`${qw}: ${q.c.length} choices`);
        if (new Set(q.c).size !== q.c.length) fail(`${qw}: duplicate choices`);
      } else if (q.a) {
        if (!(q.ok || []).length) fail(`${qw}: typed question without accepted patterns`);
        if (!IG.checkTyped(q, q.a)) fail(`${qw}: the model answer "${q.a}" fails its own check`);
        if (IG.checkTyped(q, "definitely not the answer")) fail(`${qw}: accepts arbitrary text`);
      } else fail(`${qw}: neither choices nor a model answer`);
    }
  }
  // the missions a level cites must exist
  for (const l of d.levels)
    for (const id of l.missions || []) if (!IG.mission(id)) fail(`${topic}:${l.n} cites unknown mission "${id}"`);
}
console.log(`PASS  drills      ${IG.drillTopics().length} topics · ${units} question sets · ${questions} questions`);

/* ---------------------------------------------------------------- certifications */
for (const c of IG.certs) {
  const w = c.domains.reduce((n, d) => n + d.weight, 0);
  if (Math.abs(w - 100) > 0.5) fail(`${c.code}: domain weights add up to ${w}%`);
  if (!/^https:\/\//.test(c.url)) fail(`${c.code}: exam guide URL is not https`);
  if (!c.code || !c.name || !c.org || !IG.certLevels[c.level]) fail(`${c.code || c.id}: incomplete metadata`);
  for (const d of c.domains) {
    if (d.out && (d.units || []).length) fail(`${c.code} / ${d.name}: marked out of scope but maps to drills`);
    for (const ref of d.units || []) if (!IG.drillUnit(ref).unit) fail(`${c.code} / ${d.name}: unknown drill "${ref}"`);
  }
  const cov = IG.certCoverage(c);
  if (verbose)
    console.log(
      `      ${c.code.padEnd(20)} ${String(cov.pct + "%").padStart(5)} covered · ${String(cov.out + "%").padStart(4)} out of scope · pool ${cov.qs}`,
    );
}
const dup = IG.certs.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dup.length) fail(`duplicate certification ids: ${dup}`);
console.log(
  `PASS  certs       ${IG.certs.length} exams · ${IG.drillTopics().filter((t) => IG.certsOf(t).length).length} topics mapped`,
);

/* ---------------------------------------------------------------- playing a drill */
function play(run, right) {
  while (!run.done) {
    const it = run.current;
    run.answer(
      it.q.c ? (right ? it.order.indexOf(0) : (it.order.indexOf(0) + 1) % it.order.length) : right ? it.q.a : "nope",
    );
    run.next();
  }
  return run.result();
}
for (const topic of IG.drillTopics()) {
  for (const unit of IG.drillUnits(topic)) {
    const ref = unit.n ? unit.n : "#" + unit.id;
    const res = play(IG.drillRun(topic, ref), true);
    if (res.score !== res.total || !res.passed) fail(`${topic}:${ref}: a perfect run scored ${res.score}/${res.total}`);
    const bad = play(IG.drillRun(topic, ref), false);
    if (bad.score !== 0 || bad.passed) fail(`${topic}:${ref}: a wrong run scored ${bad.score}/${bad.total}`);
  }
}
console.log("PASS  drill runs  perfect runs pass, wrong runs fail, in every question set");

/* ---------------------------------------------------------------- mock exams */
let small = 0;
for (const c of IG.certs) {
  const cov = IG.certCoverage(c);
  const size = Math.min(IG.EXAM_SIZE, cov.qs);
  const run = IG.examRun(c.id, size);
  if (!run.items.length) {
    fail(`${c.code}: mock exam has no questions`);
    continue;
  }
  if (run.items.length < size) fail(`${c.code}: asked for ${size} questions, got ${run.items.length}`);
  if (new Set(run.items.map((i) => i.q)).size !== run.items.length) fail(`${c.code}: the same question appears twice`);
  if (run.items.length < 5) small++;
  const res = play(run, true);
  if (res.score !== res.total || !res.passed) fail(`${c.code}: a perfect mock exam scored ${res.score}/${res.total}`);
}
console.log(
  `PASS  mock exams  ${IG.certs.length} exams playable${small ? ` (${small} with fewer than 5 questions)` : ""}`,
);

/* ---------------------------------------------------------------- progress */
const store = (() => {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = String(v);
    },
  };
})();
const p = new IG.Progress(store);
const r1 = IG.drillRun("basics", 1);
const rec = p.recordRun(r1, play(r1, true));
if (!p.drillPassed("basics", 1)) fail("progress: a passed drill is not recorded");
if (rec.gain !== IG.drillXp(1)) fail(`progress: XP for Lv1 was ${rec.gain}`);
if (!p.data.badges.includes("study")) fail("progress: the 予習派 badge was not given");
const again = IG.drillRun("basics", 1);
if (p.recordRun(again, play(again, true)).gain !== 0) fail("progress: XP given twice for the same drill");
const ex = IG.examRun("cka");
const erec = p.recordRun(ex, play(ex, true));
if (!p.examPassed("cka") || erec.gain !== IG.examXp) fail("progress: a passed mock exam is not recorded");
if (!p.data.badges.includes("exam")) fail("progress: the 試験合格 badge was not given");
const restored = new IG.Progress(store);
if (!restored.drillPassed("basics", 1) || !restored.examPassed("cka")) fail("progress: not restored from storage");
console.log("PASS  progress    drill/exam results, XP once per unit, badges, persistence");

/* ---------------------------------------------------------------- missions ↔ drills */
const linked = IG.missions.filter((m) => !m.sandbox && IG.drillsForMission(m.id).length);
if (linked.length < IG.missions.filter((m) => !m.sandbox).length / 2)
  fail(`only ${linked.length} missions link to a drill`);
console.log(
  `PASS  links       ${linked.length}/${IG.missions.filter((m) => !m.sandbox).length} missions link to a drill`,
);

console.log(failed ? `\n${failed} problem(s)` : "\nすべて OK");
process.exit(failed ? 1 : 0);
