/* Languages: Japanese (the text as written), Korean, British English, Traditional Chinese (Taiwan).
 *
 * The choice is shared with the other sites of the Home Page server: the `lang` cookie for the whole
 * host (the server answers `?lang=ko` on any address with it), else the browser's languages. Run on
 * its own (file://, another server) CoreLab reads `?lang=` itself and keeps the choice in
 * localStorage too.
 *
 * Every text is written in Japanese and translated by looking that Japanese up in the language's
 * pack (js/i18n/<lang>/*.js, loaded before the game's scripts): IG.t('…', {n: 3}) in code,
 * IG.i18n.deep(object) for data (missions, drills, the command reference), and text in index.html
 * by IG.i18n.page(). A text missing from the pack shows in Japanese; tests/run-i18n.js lists them.
 * DOM-free except for page() and the pack loader. */
(function (IG) {
  "use strict";
  const LANGS = ["ja", "ko", "en-GB", "zh-TW"];
  const NAMES = { "ja": "日本語", "ko": "한국어", "en-GB": "English (UK)", "zh-TW": "中文（台灣）" };
  const PACKS = ["ui", "sim", "missions", "learn", "ref"];
  const JP = /[぀-ヿ㐀-鿿！-～]/;
  // Data keys that are never shown as prose (ids, commands, answers typed into the terminal)
  const KEEP = new Set([
    "id",
    "track",
    "topic",
    "solution",
    "cwd",
    "a",
    "ok",
    "cmd",
    "url",
    "code",
    "icon",
    "color",
    "image",
  ]);
  const STORE = "corelab.lang";
  const doc = typeof document !== "undefined" ? document : null;

  function fromBrowser(list) {
    for (const raw of list || []) {
      const tag = String(raw).toLowerCase();
      for (const [prefix, lang] of [
        ["ja", "ja"],
        ["ko", "ko"],
        ["zh", "zh-TW"],
        ["en", "en-GB"],
      ])
        if (tag === prefix || tag.startsWith(prefix + "-")) return lang;
    }
    return list && list.length ? "en-GB" : "ja";
  }
  function chosen() {
    if (!doc) return "ja";
    let asked = null;
    try {
      asked = new URLSearchParams(location.search).get("lang");
    } catch (e) {
      /* no URL */
    }
    if (LANGS.includes(asked)) {
      remember(asked);
      dropParam();
      return asked;
    }
    const cookie = (doc.cookie.match(/(?:^|;\s*)lang=([^;]+)/) || [])[1];
    if (LANGS.includes(cookie)) return cookie;
    try {
      const kept = localStorage.getItem(STORE);
      if (LANGS.includes(kept)) return kept;
    } catch (e) {
      /* storage blocked */
    }
    return fromBrowser(navigator.languages || [navigator.language]);
  }
  function remember(lang) {
    try {
      doc.cookie = `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;
    } catch (e) {
      /* file:// */
    }
    try {
      localStorage.setItem(STORE, lang);
    } catch (e) {
      /* storage blocked */
    }
  }
  function dropParam() {
    try {
      const u = new URL(location.href);
      u.searchParams.delete("lang");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) {
      /* not on http(s) */
    }
  }

  const dict = Object.create(null);
  const done = new Set(); // translations (a text already in the language is not missing)
  const I = {
    LANGS,
    NAMES,
    PACKS,
    lang: chosen(),
    /** Recording for tests: a Set gets every Japanese text that had no translation. */
    missing: null,
    add(map) {
      Object.assign(dict, map);
      for (const k in map) done.add(map[k]);
    },
    use(lang) {
      I.lang = lang;
    },
    has(ja) {
      return ja in dict;
    },
    /** `ja` in the current language, with {name} filled in from `vars`. */
    t(ja, vars) {
      let s = ja;
      if (I.lang !== "ja" && typeof ja === "string" && JP.test(ja)) {
        if (ja in dict) s = dict[ja];
        else if (I.missing && !done.has(ja)) I.missing.add(ja);
      }
      return vars
        ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m))
        : s;
    },
    /** Translates the prose of a data object in place (strings in objects and arrays; ids,
     * commands and answers kept) and returns it. */
    deep(value, key) {
      if (I.lang === "ja" || value == null) return value;
      if (typeof value === "string") return KEEP.has(key) ? value : I.t(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = I.deep(value[i], key);
        return value;
      }
      if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        for (const k of Object.keys(value)) if (!KEEP.has(k)) value[k] = I.deep(value[k], k);
      }
      return value;
    },
    /** The written-in-HTML text of a page: elements marked data-i18n are translated whole
     * (their markup is part of the sentence), other text nodes and title / aria-label / placeholder one by one. */
    page(root) {
      doc.documentElement.lang = I.lang;
      if (I.lang === "ja") return;
      root.querySelectorAll("[data-i18n]").forEach((el) => {
        el.innerHTML = I.t(el.innerHTML.trim());
      });
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue.trim();
        if (text && JP.test(text) && !n.parentElement.closest("script,style,[data-i18n]"))
          n.nodeValue = n.nodeValue.replace(text, I.t(text));
      }
      root.querySelectorAll("[title],[aria-label],[placeholder]").forEach((el) => {
        for (const a of ["title", "aria-label", "placeholder"])
          if (el.hasAttribute(a) && JP.test(el.getAttribute(a))) el.setAttribute(a, I.t(el.getAttribute(a)));
      });
    },
    /** The language menu (the same on every site of the Home Page server). */
    menu() {
      const items = LANGS.map(
        (l) =>
          `<li><a href="?lang=${l}" lang="${l}" hreflang="${l}"${l === I.lang ? ' aria-current="true"' : ""}>${NAMES[l]}</a></li>`,
      ).join("");
      return `<summary title="${I.t("言語")}" aria-label="${I.t("言語")}: ${NAMES[I.lang]}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg><span>${NAMES[I.lang]}</span></summary><ul>${items}</ul>`;
    },
    fromBrowser,
  };
  IG.i18n = I;
  IG.t = I.t;

  // The language's packs, before the game's scripts (they are parser-blocking like the rest)
  if (doc && I.lang !== "ja" && doc.readyState === "loading" && doc.currentScript) {
    const base = doc.currentScript.src.replace(/js\/core\/i18n\.js(\?.*)?$/, "");
    for (const p of PACKS) doc.write(`<script src="${base}js/i18n/${I.lang}/${p}.js"></script>`);
  }
})((globalThis.IG = globalThis.IG || {}));
