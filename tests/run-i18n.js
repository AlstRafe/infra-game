#!/usr/bin/env node
/* Checks the translations (js/i18n/<lang>/*.js, see js/core/i18n.js) for each language:
 * (1) every Japanese text the game shows has one: the page (index.html), the texts in code
 *     (IG.t('…') / T('…')) and the data (missions, drills, the command reference),
 * (2) a translation keeps the {placeholders} of its Japanese and has no kana left in it,
 * (3) every mission's reference solution still completes (nothing depends on the wording),
 * (4) portal.json (the Home Page card) has the text in the language, starting with the mission's title.
 * Usage: node tests/run-i18n.js [lang] [-v]  */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const all = [...html.matchAll(/<script src="\.\/(js\/[^"]+)"/g)].map((m) => m[1]);
const scripts = all.filter((s) => !s.startsWith("js/ui/"));
const JP = /[぀-ヿ㐀-鿿！-～]/;
const KANA = /[ぁ-ゖァ-ヺ]/;

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const only = args.find((a) => !a.startsWith("-"));
let failed = 0;
function check(name, problems, detail) {
  const ok = !problems.length;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${detail}`);
  if (!ok || verbose) for (const p of problems.slice(0, verbose ? 1e9 : 15)) console.log("      " + p);
  if (!ok && !verbose && problems.length > 15) console.log(`      … ${problems.length - 15} more (-v)`);
}
const short = (s) => JSON.stringify(s.length > 70 ? s.slice(0, 70) + "…" : s);

// The game in one language: its packs loaded right after i18n.js, as the browser does
function load(lang) {
  const ctx = vm.createContext({ console, Buffer, Date, Math, JSON, TextEncoder, setTimeout, clearTimeout });
  ctx.globalThis = ctx;
  for (const s of scripts) {
    vm.runInContext(fs.readFileSync(path.join(root, s), "utf8"), ctx, { filename: s });
    if (s !== "js/core/i18n.js") continue;
    ctx.IG.i18n.use(lang);
    ctx.IG.i18n.missing = new Set();
    for (const p of ctx.IG.i18n.PACKS) {
      const file = `js/i18n/${lang}/${p}.js`;
      vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
    }
  }
  return ctx.IG;
}
// What a pack file adds: {ja: translation}
function pack(lang, p) {
  const map = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, `js/i18n/${lang}/${p}.js`), "utf8"), {
    IG: { i18n: { add: (m) => Object.assign(map, m) } },
  });
  return map;
}

// The texts written in Japanese outside the data: index.html as IG.i18n.page() reads it, and the
// string literals given to IG.t / T in the scripts (a literal with ${…} in it is not a text)
const entity = (s) =>
  s.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (m, n) => ({ "amp": "&", "lt": "<", "gt": ">", "quot": '"', "#39": "'", "nbsp": " " })[n],
  );
const pageTexts = (() => {
  const out = new Set();
  let body = html.slice(html.indexOf("<body"));
  body = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "");
  body = body.replace(/<(\w+)\b[^>]*\sdata-i18n\b[^>]*>([\s\S]*?)<\/\1>/g, (m, tag, inner) => {
    out.add(inner.trim());
    return "";
  });
  for (const [, , v] of body.matchAll(/\s(title|aria-label|placeholder)="([^"]*)"/g))
    if (JP.test(v)) out.add(entity(v));
  for (const t of body.replace(/<[^>]*>/g, "\n").split("\n")) if (JP.test(t)) out.add(entity(t.trim()));
  return [...out];
})();
const codeTexts = (() => {
  const out = new Set();
  const call = /(?:\bIG\.t|(?<![\w.$])T)\(\s*('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)/g;
  for (const s of all.filter((f) => !f.startsWith("js/i18n/"))) {
    for (const [, lit] of fs.readFileSync(path.join(root, s), "utf8").matchAll(call)) {
      if (lit.startsWith("`") && lit.includes("${")) continue;
      const text = vm.runInNewContext(lit);
      if (JP.test(text)) out.add(text);
    }
  }
  return [...out];
})();
const card = JSON.parse(fs.readFileSync(path.join(root, "portal.json"), "utf8"));

const langs = only ? [only] : ["ko", "en-GB", "zh-TW"];
for (const lang of langs) {
  console.log(`\n${lang}`);
  const IG = load(lang);
  const T = IG.i18n;
  const dataMissing = [...T.missing];

  // 1. coverage
  check(
    "page",
    pageTexts.filter((t) => !T.has(t)).map((t) => `no translation: ${short(t)}`),
    `${pageTexts.length} texts in index.html`,
  );
  check(
    "code",
    codeTexts.filter((t) => !T.has(t)).map((t) => `no translation: ${short(t)}`),
    `${codeTexts.length} texts in the scripts`,
  );
  check(
    "data",
    dataMissing.map((t) => `no translation: ${short(t)}`),
    `missions, drills and the command reference as loaded`,
  );

  // 2. the translations themselves
  const problems = [];
  let count = 0;
  for (const p of T.PACKS) {
    for (const [ja, tr] of Object.entries(pack(lang, p))) {
      count++;
      const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(" ");
      if (holes(ja) !== holes(tr))
        problems.push(`${p}: placeholders ${holes(ja) || "-"} became ${holes(tr) || "-"} in ${short(tr)}`);
      if (KANA.test(tr)) problems.push(`${p}: kana left in ${short(tr)}`);
      if (!tr.trim()) problems.push(`${p}: empty translation of ${short(ja)}`);
    }
  }
  check("translations", problems, `${count} texts in ${T.PACKS.length} packs`);

  // 3. the missions as played in this language (the texts may change in play: count those too)
  T.missing = new Set();
  const unsolved = [];
  for (const m of IG.missions) {
    IG.clock.offset = 0;
    const s = new IG.Session(m);
    s.evaluate();
    const early = s.done.some(Boolean);
    for (const step of m.solution || []) {
      IG.clock.offset += 15000;
      s.run(typeof step === "function" ? step(s.world) : step);
    }
    if (!m.sandbox && (!s.completed || early))
      unsolved.push(
        `${m.id} ${m.title}${early ? " (done at start)" : ""}${s.completed ? "" : ` (incomplete: ${s.done.map((d, i) => (d ? "" : i + 1)).filter(Boolean)})`}`,
      );
  }
  check("missions", unsolved, `${IG.missions.length} reference solutions`);
  check(
    "play",
    [...T.missing].map((t) => `no translation: ${short(t)}`),
    "texts shown while playing them",
  );

  // 4. the Home Page card
  const say = (v) => (typeof v === "string" ? v : v && v[lang]);
  const cardProblems = [];
  if (!say(card.title)) cardProblems.push("no title");
  for (const [text, href] of card.items) {
    const m = IG.mission((href.match(/^\/#\/play\/([\w-]+)$/) || [])[1]);
    if (!say(text)) cardProblems.push(`no text for ${href}`);
    else if (!m || !say(text).startsWith(m.title))
      cardProblems.push(`${short(say(text))} does not start with the title ${m ? short(m.title) : "(no mission)"}`);
  }
  check("portal.json", cardProblems, `${card.items.length} missions on the Home Page card`);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll languages complete.");
process.exit(failed ? 1 : 0);
