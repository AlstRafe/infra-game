#!/usr/bin/env node
/* Plays every mission's reference solution against the simulator and checks that
 * (1) no objective is complete before playing, and (2) every objective completes.
 * Usage: node tests/run-solutions.js [missionId] [-v]  */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="\.\/(js\/[^"]+)"/g)].map(m => m[1]).filter(s => !s.startsWith('js/ui/'));

const ctx = vm.createContext({ console, Buffer, Date, Math, JSON, setTimeout, clearTimeout });
ctx.globalThis = ctx;
for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(root, s), 'utf8'), ctx, { filename: s });
const IG = ctx.IG;

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const only = args.find(a => !a.startsWith('-'));
let failed = 0;

for (const m of IG.missions) {
  if (only && m.id !== only) continue;
  IG.clock.offset = 0;
  const s = new IG.Session(m);
  s.evaluate();
  const early = s.done.map((d, i) => (d ? i + 1 : 0)).filter(Boolean);
  const log = [];
  for (const step of m.solution || []) {
    IG.clock.offset += 15000; // let transient states (ContainerCreating, ErrImagePull) settle
    const cmd = typeof step === 'function' ? step(s.world) : step;
    const r = s.run(cmd);
    log.push(`$ ${cmd}\n${r.res.out}${r.res.code ? `\n[exit ${r.res.code}]` : ''}`);
  }
  const ok = m.sandbox ? true : s.completed && !early.length;
  if (!ok) failed++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${m.id.padEnd(10)} ${m.title}${early.length ? `  (already done at start: ${early})` : ''}${!m.sandbox && !s.completed ? `  (incomplete: ${s.done.map((d, i) => (d ? '' : i + 1)).filter(Boolean)})` : ''}`);
  if (!ok || verbose) console.log(log.map(l => '    ' + l.replace(/\n/g, '\n    ')).join('\n'));
}
// portal.json: the missions the site list (Home Page) offers on CoreLab's card. They must exist,
// be open from the start (first of their track) and keep the title the card shows.
if (!only) {
  const card = JSON.parse(fs.readFileSync(path.join(root, 'portal.json'), 'utf8'));
  for (const [said, href] of card.items) {
    const text = typeof said === 'string' ? said : said.ja; // the other languages: tests/run-i18n.js
    const m = IG.mission((href.match(/^\/#\/play\/([\w-]+)$/) || [])[1]);
    const ok = !!m && m.order === 1 && text.startsWith(m.title);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  portal.json ${text} -> ${href}`);
  }
}
console.log(failed ? `\n${failed} mission(s) failed` : '\nAll missions solvable.');
process.exit(failed ? 1 : 0);
