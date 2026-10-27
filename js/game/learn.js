/* Learning layer: per-topic drills in graded levels (intro → expert) plus exam-specific extra packs,
 * every question citing official documentation; certification catalogue with official exam domains
 * and weights, coverage calculation, drill/mock-exam runs and their progress. DOM-free. */
(function (IG) {
  'use strict';

  IG.levels = [
    { n: 1, name: IG.t('入門'), en: 'Intro', desc: IG.t('はじめて触る。用語と全体像をつかむ') },
    { n: 2, name: IG.t('基礎'), en: 'Basics', desc: IG.t('日常の操作を自分でできる') },
    { n: 3, name: IG.t('実務'), en: 'Practitioner', desc: IG.t('障害を調べて直せる') },
    { n: 4, name: IG.t('応用'), en: 'Advanced', desc: IG.t('設計・セキュリティ・運用改善') },
    { n: 5, name: IG.t('エキスパート'), en: 'Expert', desc: IG.t('内部動作と上位資格レベル') },
  ];
  IG.DRILL_PASS = 0.8;
  IG.EXAM_PASS = 0.72;      // close to the pass mark of most vendor exams
  IG.EXAM_SIZE = 20;
  IG.drillXp = n => (Number(n) ? Number(n) * 20 : 60);
  IG.examXp = 150;

  Object.assign(IG.badges, {
    study: { name: IG.t('予習派'), icon: '📘', desc: IG.t('ラーニングのドリルに初めて合格') },
    expert: { name: IG.t('その道のプロ'), icon: '🎓', desc: IG.t('いずれかの分野でエキスパート（Lv5）に合格') },
    exam: { name: IG.t('試験合格'), icon: '📝', desc: IG.t('資格の模擬試験に合格') },
    sage: { name: IG.t('全分野制覇'), icon: '📚', desc: IG.t('すべての分野・レベルのドリルに合格') },
  });

  /* ------------------------------------------------------------ drill data
   * js/game/drills/*.js:
   *   { topic: <track id>, blurb, certs, refs: { key: [title, url] },
   *     levels: [{ n, title, goal, points: [...], refs: [key...], missions: [missionId...], qs: [...] }],
   *     extras: [{ id, title, goal, points, refs, qs }] }   exam-oriented supplementary packs
   * A question is either a choice question (c[0] is the answer) or a typed command:
   *   { q, code?, c: ['正解', '誤り', …], x: '解説', r: <refs key> }
   *   { q, code?, a: '模範解答', ok: [RegExp…], x, r }
   * A unit is addressed as "<topic>:<n>" (level) or "<topic>:#<id>" (extra pack). */
  IG.drills = {};
  IG.registerDrills = d => { IG.drills[d.topic] = IG.i18n.deep(d); };
  // Extra packs live in their own files (js/game/drills/extra-*.js) and add to a topic registered above.
  IG.addExtras = d => {
    const t = IG.drills[d.topic];
    if (!t) throw new Error(`no drills for ${d.topic}`);
    IG.i18n.deep(d);
    Object.assign(t.refs, d.refs || {});
    t.extras = (t.extras || []).concat(d.extras || []);
  };
  IG.drillLevel = (topic, n) => { const d = IG.drills[topic]; return d && d.levels.find(l => l.n === Number(n)); };
  IG.drillExtra = (topic, id) => { const d = IG.drills[topic]; return d && (d.extras || []).find(e => e.id === id); };
  IG.drillTopics = () => IG.tracks.filter(t => IG.drills[t.id]).map(t => t.id);
  IG.drillUnits = topic => { const d = IG.drills[topic]; return d ? d.levels.concat(d.extras || []) : []; };
  IG.unitRef = (topic, unit) => `${topic}:${unit.n ? unit.n : '#' + unit.id}`;
  IG.unitName = unit => (unit.n ? `Lv${unit.n} ${unit.title}` : unit.title);
  // "basics:3" / "basics:#shell" → { topic, unit } (unit is undefined when the pack does not exist)
  IG.drillUnit = ref => {
    const [topic, rest] = String(ref).split(':');
    return { topic, unit: rest && rest[0] === '#' ? IG.drillExtra(topic, rest.slice(1)) : IG.drillLevel(topic, rest) };
  };
  IG.drillsForMission = id => {
    const out = [];
    for (const topic of IG.drillTopics()) for (const l of IG.drills[topic].levels) if ((l.missions || []).includes(id)) out.push({ topic, level: l });
    return out;
  };
  IG.drillRef = (topic, key) => { const r = IG.drills[topic] && IG.drills[topic].refs[key]; return r ? { key, title: r[0], url: r[1] } : null; };

  /* ------------------------------------------------------------ certification catalogue
   * js/game/certs/*.js: IG.registerCerts({ topic, note?, certs: [{
   *     id, name, code, org, url, level: 'foundational'|'associate'|'professional'|'specialty',
   *     ja?: '日本語名', note?: '補足',
   *     domains: [{ name, weight, units: ['<topic>:<ref>'…], out?: true }] }] })
   * `out: true` marks a domain outside this game's scope (AI/ML, 言語フレームワークなど): it is shown
   * as such instead of being silently counted as covered. */
  IG.certs = [];
  IG.certNotes = {};
  IG.registerCerts = d => {
    IG.i18n.deep(d);
    if (d.note) IG.certNotes[d.topic] = d.note;
    for (const c of d.certs) IG.certs.push(Object.assign({ topic: d.topic }, c));
  };
  IG.certsOf = topic => IG.certs.filter(c => c.topic === topic);
  IG.cert = id => IG.certs.find(c => c.id === id);
  IG.certLevels = { foundational: IG.t('入門'), associate: IG.t('標準'), professional: IG.t('上級'), specialty: IG.t('専門') };

  // Units of a domain that actually exist and have questions.
  function domainUnits(domain) {
    return (domain.units || []).map(IG.drillUnit).filter(u => u.unit && u.unit.qs && u.unit.qs.length);
  }
  IG.domainUnits = domainUnits;
  // covered / partial(out-of-scope) / missing share of the exam's weight, and the question pool size.
  IG.certCoverage = cert => {
    let covered = 0, out = 0, missing = 0, qs = 0;
    const seen = new Set();
    for (const d of cert.domains) {
      const units = domainUnits(d);
      if (d.out) out += d.weight;
      else if (units.length) covered += d.weight;
      else missing += d.weight;
      for (const u of units) { const ref = IG.unitRef(u.topic, u.unit); if (!seen.has(ref)) { seen.add(ref); qs += u.unit.qs.length; } }
    }
    const total = covered + out + missing || 1;
    return { covered, out, missing, pct: Math.round((covered / total) * 100), qs, units: [...seen] };
  };
  IG.certsForUnit = ref => IG.certs.filter(c => c.domains.some(d => (d.units || []).includes(ref)));

  /* ------------------------------------------------------------ runs */
  // Typed answers: ignore surrounding blanks, repeated spaces and a pasted "$ " prompt.
  const norm = s => String(s || '').trim().replace(/^\$\s*/, '').replace(/\s+/g, ' ');
  IG.checkTyped = (q, text) => { const t = norm(text); return !!t && (t === norm(q.a) || (q.ok || []).some(re => re.test(t))); };

  function shuffle(list, rnd) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const mkItem = (q, topic, rnd, domain) => ({ q, topic, domain, order: q.c ? shuffle(q.c.map((_, i) => i), rnd) : null });

  class Run {
    // items: [{ q, topic, domain?, order }]; meta: { kind: 'drill'|'exam', key, title, pass, … }
    constructor(items, meta) {
      this.items = items;
      this.meta = meta;
      this.pos = 0;
      this.answers = [];
      this.startedAt = Date.now();
    }
    get current() { return this.items[this.pos]; }
    get done() { return this.pos >= this.items.length; }
    get correct() { return this.answers.filter(a => a.correct).length; }
    // choice questions: the shown position the player picked; typed questions: the text
    answer(v) {
      const it = this.current;
      if (!it || this.answers.length > this.pos) return null;
      const q = it.q;
      const correct = q.c ? it.order[Number(v)] === 0 : IG.checkTyped(q, v);
      const a = { item: it, given: v, correct, expected: q.c ? q.c[0] : q.a, rightPos: q.c ? it.order.indexOf(0) : -1, ref: IG.drillRef(it.topic, q.r) };
      this.answers.push(a);
      return a;
    }
    next() { if (this.answers.length > this.pos) this.pos++; return !this.done; }
    result() {
      const total = this.items.length, score = this.correct;
      const pct = total ? score / total : 0;
      return { score, total, pct, passed: pct >= this.meta.pass, missed: this.answers.filter(a => !a.correct), time: Math.round((Date.now() - this.startedAt) / 1000) };
    }
  }
  IG.Run = Run;

  IG.drillRun = (topic, ref, rnd = Math.random) => {
    const unit = String(ref)[0] === '#' ? IG.drillExtra(topic, String(ref).slice(1)) : IG.drillLevel(topic, ref);
    if (!unit) throw new Error(`no drill ${topic}:${ref}`);
    return new Run(shuffle(unit.qs.map(q => mkItem(q, topic, rnd)), rnd), { kind: 'drill', key: IG.unitRef(topic, unit), topic, unit, title: IG.unitName(unit), pass: IG.DRILL_PASS });
  };

  /* Mock exam: questions are drawn from the units mapped to each in-scope domain, as many per domain
   * as its official weight suggests (at least one), then trimmed/padded to `size`. */
  IG.examRun = (certId, size = IG.EXAM_SIZE, rnd = Math.random) => {
    const cert = IG.cert(certId);
    if (!cert) throw new Error(`no cert ${certId}`);
    const pools = cert.domains.map(d => {
      const qs = [];
      const seen = new Set();
      for (const u of domainUnits(d)) {
        const ref = IG.unitRef(u.topic, u.unit);
        if (seen.has(ref)) continue;
        seen.add(ref);
        for (const q of u.unit.qs) qs.push({ q, topic: u.topic });
      }
      return { d, qs: shuffle(qs, rnd) };
    }).filter(p => p.qs.length);
    const weight = pools.reduce((n, p) => n + p.d.weight, 0) || 1;
    const picked = [];
    const used = new Set();
    const take = (p, n) => {
      for (const c of p.qs) {
        if (picked.length >= size || n <= 0) break;
        if (used.has(c.q)) continue;
        used.add(c.q);
        picked.push(mkItem(c.q, c.topic, rnd, p.d.name));
        n--;
      }
    };
    for (const p of pools) take(p, Math.max(1, Math.round((p.d.weight / weight) * size)));
    for (const p of pools) if (picked.length < size) take(p, size - picked.length);   // pad from whatever is left
    return new Run(shuffle(picked, rnd).slice(0, size), { kind: 'exam', key: 'exam:' + cert.id, cert, title: IG.t(`{0} 模擬試験`, { 0: cert.name }), pass: IG.EXAM_PASS });
  };

  /* ------------------------------------------------------------ progress */
  const P = IG.Progress.prototype;
  P.drills = function () { return (this.data.drills = this.data.drills || {}); };
  P.drill = function (topic, ref) { return this.drills()[`${topic}:${ref}`] || null; };
  P.drillPassed = function (topic, ref) { const d = this.drill(topic, ref); return !!(d && d.passed); };
  P.unitPassed = function (topic, unit) { return this.drillPassed(topic, unit.n ? unit.n : '#' + unit.id); };
  P.drillPassedCount = function (topic) { return IG.drills[topic] ? IG.drills[topic].levels.filter(l => this.drillPassed(topic, l.n)).length : 0; };
  // first level not yet passed (or the last one when all are passed)
  P.nextDrill = function (topic) { const ls = IG.drills[topic].levels; return ls.find(l => !this.drillPassed(topic, l.n)) || ls[ls.length - 1]; };
  P.exam = function (certId) { return (this.data.exams = this.data.exams || {})[certId] || null; };
  P.examPassed = function (certId) { const e = this.exam(certId); return !!(e && e.passed); };
  // One path for both kinds: run.meta.key is "<topic>:<ref>" or "exam:<certId>".
  P.recordRun = function (run, result) {
    const exam = run.meta.kind === 'exam';
    const store = exam ? (this.data.exams = this.data.exams || {}) : this.drills();
    const key = exam ? run.meta.cert.id : run.meta.key;
    const prev = store[key] || { best: 0, passed: false, plays: 0 };
    const before = this.rank();
    const gain = result.passed && !prev.passed ? (exam ? IG.examXp : IG.drillXp(run.meta.unit.n)) : 0;
    store[key] = { best: Math.max(prev.best || 0, result.pct), passed: prev.passed || result.passed, plays: (prev.plays || 0) + 1, last: Date.now() };
    this.data.xp += gain;
    const newBadges = [];
    const give = id => { if (!this.data.badges.includes(id)) { this.data.badges.push(id); newBadges.push(id); } };
    if (result.passed) give(exam ? 'exam' : 'study');
    if (!exam && result.passed && Number(run.meta.unit.n) === IG.levels.length) give('expert');
    if (IG.drillTopics().every(t => IG.drills[t].levels.every(l => this.drillPassed(t, l.n)))) give('sage');
    this.save();
    const after = this.rank();
    return { gain, newBadges, rankUp: after.idx > before.idx ? after.cur : null };
  };
  // Kept for older callers / tests.
  P.recordDrill = function (topic, n, result) { return this.recordRun({ meta: { kind: 'drill', key: `${topic}:${n}`, unit: { n } } }, result); };
})(globalThis.IG = globalThis.IG || {});
