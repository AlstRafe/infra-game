/* Line breaks that read naturally on any device and in any browser (2026-11-20: 「端末によって改行位置が不自然」).
 *
 * Browsers break Japanese and Chinese between any two characters, so a line can end inside a word (「練 / 習」).
 * `word-break: auto-phrase` fixes that in Chrome only. Instead, as in the Home Page site list (homepage/phrases),
 * the text is cut into phrases (文節) with BudouX's trained model for the page's language (js/phrases/, loaded by
 * js/core/i18n.js) and a <wbr> is put between them; css/app.css sets `word-break: keep-all` (break only there, at
 * spaces and at punctuation) and `overflow-wrap: anywhere` (a phrase too long for the line still breaks).
 *  - Chinese: only the model's surer places count, and a lone character joins a neighbour (「每|小|時」).
 *  - Japanese: never between two kanji (「架|空」).
 *  - A short Latin name stays on one line (「Riot ID」), and so does a Latin word or a number with the word after it
 *    (「nginx を」「約 1 分」), and a closing bracket with the particle after it (「（Pod）を」, Korean too).
 *  - A sentence's last phrase of one or two characters goes with the one before it (no 「…ファイ / ル。」 line).
 * Run on the whole page once its text is translated (app.js), then on whatever the game renders later. Code,
 * commands, the terminal and fields are never touched (their text is copied and typed). */
(function (IG) {
  "use strict";
  const WJ = "⁠";
  const NBSP = " ";
  const SKIP =
    "script,style,code,pre,kbd,samp,textarea,input,select,option,svg,.term-out,.term-demo,.sr-only,[data-cmd]";
  //: How sure the model must be of a place between phrases (BudouX: above 0). The Chinese model's places below about
  //: 1500 are often inside a word (瀏覽|82器, 隨|88時, 更|403新, 練|1333習題), its sure ones well above it.
  const THRESHOLD = { "ja": 0, "zh-TW": 1500 };
  // Text no longer than this is never split (a word or a short label)
  const SHORT = 4;
  const CJK = "ぁ-ヿ㐀-䶿一-鿿";
  const ASIAN = new RegExp(`[${CJK}가-힣]`);
  const KANA = /[ぁ-ヿㇰ-ㇿｦ-ﾟ]/;
  const KANJI = /[㐀-䶿一-鿿々〆]/;
  // Latin words one after another with a space between them; two of them no longer than NAME are a name
  const LATIN_WORDS = /[A-Za-z0-9][\w.+#-]*(?: [A-Za-z0-9][\w.+#-]*)+/g;
  const NAME = 12;
  // Spaces that are no place to break: after a Latin word or a number before Japanese or Chinese ("nginx を",
  // "60 試験"), and between such text and a number after it ("約 1 分")
  const HELD_SPACE = new RegExp(`(?<=[A-Za-z0-9.)\\]]) (?=[${CJK}])|(?<=[${CJK}]) (?=[0-9])`, "g");
  // A closing bracket with a particle after it (hiragana, Hangul): a word joiner keeps them together
  const AFTER_BRACKET = /(?<=[)\]）」』】])(?=[ぁ-ゟ가-힣])/g;
  // Punctuation at the end of a chunk, not counted as its characters
  const CLAUSE_ENDS = "，。、；：！？）」』";
  const TRAILING = /[，。、；：！？）」』\s⁠]+$/;
  // Chinese characters that go with the words after them when the model leaves one alone (each, every, this, and...)
  const LEADS = new Set("各每這那第與和及並把被從在對很再又不沒只也就都");

  let model = null;
  /** The phrase model for text: the page's (Japanese or Chinese), when the text is in kana or kanji. */
  function modelFor(text) {
    const lang = document.documentElement.lang;
    if (!IG.phraseModel || !(lang in THRESHOLD)) return null;
    if (!KANA.test(text) && !KANJI.test(text)) return null;
    if (!model) {
      model = IG.phraseModel;
      let sum = 0;
      for (const group of Object.values(model)) for (const v of Object.values(group)) sum += v;
      model._base = -sum * 0.5;
      model._lang = lang;
    }
    return model;
  }

  /** BudouX's Parser.parse: the places before which a line may break, with how sure the model is (ordered). */
  function cuts(s, m, threshold) {
    const get = (group, key) => (m[group] && m[group][key]) || 0;
    const out = new Map();
    for (let i = 1; i < s.length; i++) {
      let score = m._base;
      if (i > 2) score += get("UW1", s[i - 3]);
      if (i > 1) score += get("UW2", s[i - 2]);
      score += get("UW3", s[i - 1]);
      score += get("UW4", s[i]);
      if (i + 1 < s.length) score += get("UW5", s[i + 1]);
      if (i + 2 < s.length) score += get("UW6", s[i + 2]);
      if (i > 1) score += get("BW1", s.slice(i - 2, i));
      score += get("BW2", s.slice(i - 1, i + 1));
      if (i + 1 < s.length) score += get("BW3", s.slice(i, i + 2));
      if (i > 2) score += get("TW1", s.slice(i - 3, i));
      if (i > 1) score += get("TW2", s.slice(i - 2, i + 1));
      if (i + 1 < s.length) score += get("TW3", s.slice(i - 1, i + 2));
      if (i + 2 < s.length) score += get("TW4", s.slice(i, i + 3));
      if (score > threshold) out.set(i, score);
    }
    return out;
  }

  /** Chinese: no chunk of one character. It joins the one before it, or the one after it at the start, after
   *  punctuation, when it leads the words after it (LEADS) or is the same character again (「看看」). */
  function joinSingles(s, cut) {
    for (;;) {
      const edges = [0, ...cut.keys(), s.length];
      let changed = false;
      for (let k = edges.length - 2; k >= 0; k--) {
        const a = edges[k];
        const b = edges[k + 1];
        const chunk = s
          .slice(a, b)
          .trim()
          .replace(/[，。、；：！？）」』]+$/, "");
        if (chunk.length > 1 || (!cut.has(a) && !cut.has(b))) continue;
        const forward =
          !cut.has(a) || LEADS.has(chunk) || CLAUSE_ENDS.includes(s[a - 1]) || /\s/.test(s[a - 1]) || s[a] === s[b];
        cut.delete(forward && cut.has(b) ? b : a);
        changed = true;
        break;
      }
      if (!changed) return;
    }
  }

  const latin = (c) => /[A-Za-z0-9#\-_./:']/.test(c);
  const held = (c) => /\s/.test(c) || c === WJ;

  /** The phrases of s (one when it cannot or need not be cut). */
  function phrases(s) {
    const m = s.length > SHORT && modelFor(s);
    if (!m) return [s];
    const cut = cuts(s, m, THRESHOLD[m._lang]);
    if (m._lang === "zh-TW") joinSingles(s, cut);
    const edges = [0, ...cut.keys(), s.length];
    let chunks = [];
    for (let k = 0; k + 1 < edges.length; k++) chunks.push(s.slice(edges[k], edges[k + 1]));
    if (m._lang === "ja") {
      const joined = chunks.slice(0, 1);
      for (const c of chunks.slice(1)) {
        const last = joined[joined.length - 1];
        if (KANJI.test(last[last.length - 1]) && KANJI.test(c[0])) joined[joined.length - 1] += c;
        else joined.push(c);
      }
      chunks = joined;
    }
    // a sentence does not end on a line of one or two characters
    if (chunks.length > 1 && s.length >= 12 && [...chunks[chunks.length - 1].replace(TRAILING, "")].length <= 2)
      chunks.splice(-2, 2, chunks[chunks.length - 2] + chunks[chunks.length - 1]);
    // no break inside a Latin word, nor next to a space (a break is there already, or none may be) or a joiner
    const out = chunks.slice(0, 1);
    for (const c of chunks.slice(1)) {
      const before = out[out.length - 1];
      const b = before[before.length - 1];
      if ((latin(b) && latin(c[0])) || held(b) || held(c[0])) out[out.length - 1] += c;
      else out.push(c);
    }
    return out;
  }

  function oneLine(name) {
    return name.split(" ").length === 2 && name.length <= NAME ? name.replace(" ", NBSP) : name;
  }

  const done = new WeakSet();
  function skip(node) {
    const el = node.parentElement;
    return !el || !!el.closest(SKIP);
  }
  /** One text node: spaces and brackets held, then cut into phrases with a <wbr> between them. */
  function fixText(node) {
    if (done.has(node)) return;
    done.add(node);
    let s = node.nodeValue;
    if (!ASIAN.test(s)) return;
    if (s.length > SHORT) s = s.replace(LATIN_WORDS, oneLine).replace(HELD_SPACE, NBSP).replace(AFTER_BRACKET, WJ);
    const parts = phrases(s);
    if (parts.length < 2) {
      if (s !== node.nodeValue) node.nodeValue = s;
      return;
    }
    node.nodeValue = parts[0];
    const frag = document.createDocumentFragment();
    for (const p of parts.slice(1)) {
      const t = document.createTextNode(p);
      done.add(t);
      frag.append(document.createElement("wbr"), t);
    }
    node.after(frag);
  }

  /** Fixes the text under root (an element or a text node). */
  function fix(root) {
    if (root.nodeType === 3) {
      if (!skip(root)) fixText(root);
      return;
    }
    if (root.nodeType !== 1 || root.closest(SKIP)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!skip(n)) nodes.push(n);
    for (const n of nodes) fixText(n);
  }

  /** Fixes the whole page now, then whatever is added to it later. */
  function start() {
    fix(document.body);
    const observer = new MutationObserver((records) => {
      for (const r of records)
        if (r.type === "characterData") {
          done.delete(r.target);
          if (r.target.isConnected) fix(r.target);
        } else for (const n of r.addedNodes) if (n.isConnected) fix(n);
      // what fix() itself changed is not looked at again
      observer.takeRecords();
    });
    // before the frame is painted (an observer runs as a microtask), so a line never jumps after it shows
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }
  IG.wrap = { fix, start, phrases };
})((globalThis.IG = globalThis.IG || {}));
