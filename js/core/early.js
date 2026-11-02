/* CoreLab: runs in <head>, before the first paint. A returning visitor (closed the welcome box or has
 * cleared a mission: renderHome in js/ui/app.js) gets html.returning, so the "はじめての方へ" box is not
 * drawn first and then removed when the deferred scripts have run, which would move the page under
 * the reader's eyes. */
(() => {
  if (typeof document === "undefined") return;
  try {
    const data = JSON.parse(localStorage.getItem("corelab.progress.v2") || "{}");
    if (data.seenIntro || Object.values(data.missions || {}).some((m) => m && m.stars > 0))
      document.documentElement.classList.add("returning");
  } catch {
    /* no storage: a first visit */
  }
})();
