/* Light or dark. The device's setting (prefers-color-scheme) until the player picks one with the
 * button in the top bar: automatic → light → dark → automatic, the order and the words of News
 * Site's button. The choice is localStorage "theme", the key every site of the Home Page server
 * uses (they share one origin), so a choice made on one of them holds on all. Loaded in <head>
 * so the first paint is already in the chosen theme. DOM-free except for apply() and button(). */
(function (IG) {
  "use strict";
  const doc = typeof document !== "undefined" ? document : null;
  const ORDER = ["auto", "light", "dark"];
  const PAINT = { light: "#fbfbfa", dark: "#0f0f10" }; // --bg of each palette (css/app.css), for phone toolbars

  function get() {
    try {
      const t = localStorage.getItem("theme");
      return ORDER.includes(t) ? t : "auto";
    } catch (e) {
      /* storage blocked */
    }
    return (doc && doc.documentElement.dataset.theme) || "auto";
  }
  function apply(theme) {
    if (!doc) return;
    const root = doc.documentElement;
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
    doc.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.content = PAINT[theme === "auto" ? (m.media.includes("dark") ? "dark" : "light") : theme];
    });
  }
  /** The top bar's button: its icon follows <html data-theme> (css), its name says the state. */
  function button(el) {
    const name = (theme) => {
      const state = { auto: IG.t("自動"), light: IG.t("オフ"), dark: IG.t("オン") }[theme];
      const text =
        theme === "auto"
          ? IG.t("ダークモード 自動（端末の設定に合わせる）、押すと切り替え")
          : IG.t("ダークモード {state}、押すと切り替え", { state });
      el.setAttribute("aria-label", text);
      el.title = text;
    };
    name(get());
    el.addEventListener("click", () => {
      const next = ORDER[(ORDER.indexOf(get()) + 1) % ORDER.length];
      try {
        if (next === "auto") localStorage.removeItem("theme");
        else localStorage.setItem("theme", next);
      } catch (e) {
        /* this page only */
      }
      apply(next);
      name(next);
    });
    // Changed on another site in another tab: follow it here too
    addEventListener("storage", (e) => {
      if (e.key === "theme" || e.key === null) {
        apply(get());
        name(get());
      }
    });
  }

  IG.theme = { get, apply, button };
  apply(get());
})((globalThis.IG = globalThis.IG || {}));
