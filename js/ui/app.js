/* CoreLab UI controller: routing, home map, learning (drills & mock exams), mission screen,
 * terminal, editor, modals. */
(function (IG) {
  "use strict";
  const U = IG.util;
  const $ = (id) => document.getElementById(id);
  const esc = U.escapeHtml;
  const T = IG.t;

  let storage;
  try {
    storage = window.localStorage;
    storage.getItem("probe");
  } catch (e) {
    storage = null;
  }
  const progress = new IG.Progress(storage);
  const unlockAll = /[?&]unlock=all\b/.test(location.search);
  let homeView = null,
    missionView = null,
    session = null,
    tick = null,
    toastTimer = null;
  let run = null; // the drill / mock exam being played
  let stash = null; // a mission left for a drill, so it can resume where it was
  const term = { history: [], idx: 0, lastTab: "", pending: null, search: null };
  const editor = { path: null, host: null, original: "", onSave: null, readonly: false };

  /* ------------------------------------------------------------ helpers */
  function toast(msg, good) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("good", !!good);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
  }
  const trackOf = (id) => IG.tracks.find((t) => t.id === id);
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const starText = (n, total = 3) => "<span>★</span>".repeat(n) + '<span class="empty">★</span>'.repeat(total - n);
  // `cmd` in a text → clickable code: in a mission it types into the terminal, elsewhere (ref) it opens the command dictionary
  function inlineCode(text, ref) {
    return esc(text).replace(/`([^`]+)`/g, (_, c) =>
      ref
        ? `<code data-ref-cmd="${c.replace(/"/g, "&quot;")}" title="${T("クリックでコマンド辞典を開く")}">${c}</code>`
        : `<code data-cmd="${c.replace(/"/g, "&quot;")}" title="${T("クリックでターミナルに入力")}">${c}</code>`,
    );
  }
  const VIEWS = ["viewHome", "viewLearn", "viewDrill", "viewMission", "viewRef"];
  function showView(id) {
    for (const v of VIEWS) $(v).hidden = v !== id;
  }
  function nextMission() {
    for (const t of IG.tracks)
      for (const m of IG.missionsOf(t.id)) if (!progress.cleared(m.id) && progress.unlocked(m, unlockAll)) return m;
    return null;
  }
  function setNav(which) {
    document.querySelectorAll("[data-nav]").forEach((a) => {
      a.classList.toggle("active", a.dataset.nav === which);
      if (a.dataset.nav === which) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  /* ------------------------------------------------------------ profile */
  function renderProfile() {
    const r = progress.rank();
    $("rankBadge").innerHTML = `<span>Lv${r.idx + 1}</span>`;
    $("rankBadge").style.setProperty("--pct", r.pct + "%");
    $("rankName").textContent = r.cur.name;
    $("xpFill").style.width = r.pct + "%";
    $("xpText").textContent = r.next ? `${progress.data.xp} / ${r.next.xp} XP` : `${progress.data.xp} XP · MAX`;
    $("profileChip").title = r.next
      ? T("次のランク「{rank}」まで {xp} XP", { rank: r.next.name, xp: r.next.xp - progress.data.xp })
      : T("最高ランク到達");
  }

  /* ------------------------------------------------------------ home: a product page (index.html, css "home") */
  const LOCK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9.5" rx="1"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>';
  const fact = (big, words) => `<li><b>${esc(String(big))}</b><span>${esc(words)}</span></li>`;
  function showHome() {
    stopMission();
    run = null;
    showView("viewHome");
    document.title = `CoreLab | ${T("インフラ運用トレーニングゲーム")}`;
    setNav("home");
    renderProfile();
    renderTracks();
    renderSide();
    renderHomeLearn();
    renderHomeRef();
    const all = IG.missions.filter((m) => !m.sandbox);
    $("statClear").textContent = `${all.filter((m) => progress.cleared(m.id)).length}/${all.length}`;
    $("statStars").textContent = `${all.reduce((n, m) => n + progress.stars(m.id), 0)}/${all.length * 3}`;
    $("statBadges").textContent = `${progress.data.badges.length}/${Object.keys(IG.badges).length}`;
    const nx = nextMission();
    const btn = $("continueBtn");
    const anyClear = all.some((m) => progress.cleared(m.id));
    btn.textContent = nx ? `▶ ${anyClear ? T("続きから") : T("はじめる")}: ${nx.title}` : `▶ ${T("フリーラボへ")}`;
    btn.onclick = () => {
      location.hash = nx ? `#/play/${nx.id}` : "#/play/sandbox";
    };
    $("firstRun").hidden = !!progress.data.seenIntro || anyClear;
    document.documentElement.classList.remove("returning"); // from js/core/early.js; from here on, hidden decides
    if (!homeView) {
      homeView = new IG.DC.View($("dcHome"), {
        rackLabels: false,
        onHover: (h) => homeTip(h),
        onClick: (r) => {
          if (r.mission) {
            const m = IG.mission(r.mission);
            if (progress.unlocked(m, unlockAll)) location.hash = `#/play/${m.id}`;
            else toast(T("前のミッションをクリアすると解放されます"));
          }
        },
      });
    }
    homeView.setScene(IG.DC.sceneFromProgress(progress, unlockAll));
    requestAnimationFrame(() => homeView.resize());
  }
  function homeTip(h) {
    const tip = $("homeTip");
    if (!h) {
      tip.hidden = true;
      return;
    }
    const box = tip.parentElement.getBoundingClientRect();
    tip.innerHTML = `<strong>${esc(h.rack.title || h.rack.label)}</strong>${h.rack.info ? `<ul>${h.rack.info.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}`;
    tip.hidden = false;
    tip.style.left = Math.max(0, Math.min(h.x - box.left + 14, box.width - 310)) + "px";
    tip.style.top = Math.max(0, Math.min(h.y - box.top + 14, box.height - 90)) + "px";
  }
  function renderTracks() {
    const nx = nextMission();
    $("trackList").innerHTML = IG.tracks
      .map((t) => {
        const ms = IG.missionsOf(t.id);
        const done = ms.filter((m) => progress.cleared(m.id)).length;
        return `<article class="track">
        <header class="track-head"><span class="track-icon" data-t="${t.id}" aria-hidden="true"></span><div><h2>${esc(t.name)}</h2><p>${esc(t.blurb)}</p></div><span class="track-count">${done}/${ms.length}</span></header>
        <ol class="mission-list">${ms
          .map((m, i) => {
            const st = progress.stars(m.id),
              open = progress.unlocked(m, unlockAll);
            const cls = [st ? "cleared" : "", nx && nx.id === m.id ? "next" : ""].join(" ");
            const num = !open ? LOCK : st ? "✓" : String(i + 1).padStart(2, "0");
            // the button is named by what it shows (title, summary, stars, difficulty), so a voice user can say what they see
            return `<li><button class="mission-row ${cls}" data-play="${m.id}" ${open ? "" : "disabled"}>
            <span class="num" aria-hidden="true">${num}</span>
            <span><strong>${esc(m.title)}</strong>${open ? "" : `<span class="sr-only">${T("（ロック中）")}</span>`}<small>${esc(m.summary)}</small></span>
            <span class="meta"><span class="stars" role="img" aria-label="★${st}/3">${starText(st)}</span><span class="diff">${T("難易度")} <span role="img" aria-label="${m.difficulty}/3">${"●".repeat(m.difficulty)}${"○".repeat(3 - m.difficulty)}</span></span></span>
          </button></li>`;
          })
          .join("")}</ol></article>`;
      })
      .join("");
  }
  function renderSide() {
    const r = progress.rank();
    $("rankNow").textContent = r.cur.name;
    $("rankNext").textContent = r.next
      ? T("次のランク「{rank}」まで {xp} XP", { rank: r.next.name, xp: r.next.xp - progress.data.xp })
      : T("最高ランク到達");
    $("rankLadder").innerHTML = IG.ranks
      .map(
        (k, i) =>
          `<li class="${i < r.idx ? "reached" : ""} ${i === r.idx ? "current" : ""}"${i === r.idx ? ' aria-current="step"' : ""}><span>${esc(k.name)}</span><span>${k.xp} XP</span></li>`,
      )
      .join("");
    $("badgeList").innerHTML = Object.entries(IG.badges)
      .map(([id, b]) => {
        const got = progress.data.badges.includes(id);
        const label = got ? b.name : T("{name}（未獲得）", { name: b.name });
        return `<li class="badge ${got ? "got" : ""}" title="${esc(label)}: ${esc(b.desc)}"><i aria-hidden="true">${b.icon}</i><span aria-hidden="true">${esc(b.name)}</span><span class="sr-only">${esc(label)}: ${esc(b.desc)}</span></li>`;
      })
      .join("");
  }
  // The learning, as a preview: each topic, the level to take next and the five levels; then the facts
  function renderHomeLearn() {
    const topics = IG.drillTopics();
    $("homeLearn").innerHTML = topics
      .map((t) => {
        const d = IG.drills[t],
          tr = trackOf(t),
          nx = progress.nextDrill(t);
        const bars = d.levels
          .map((l) => {
            const c = unitStat(t, l).cls;
            return `<i class="${c === "passed" ? "on" : c}"></i>`;
          })
          .join("");
        const passed = progress.drillPassedCount(t);
        return `<li><a href="#/learn/${t}"><span class="track-icon" data-t="${t}" aria-hidden="true"></span><span><b>${esc(tr.name)}</b><small>Lv${nx.n} ${esc(nx.title)}</small></span><span class="lv5" role="img" aria-label="${T("段階 {done}/{all} 合格", { done: passed, all: d.levels.length })}">${bars}</span></a></li>`;
      })
      .join("");
    const units = topics.reduce((n, t) => n + IG.drillUnits(t).length, 0);
    const qs = topics.reduce((n, t) => n + IG.drillUnits(t).reduce((m, u) => m + u.qs.length, 0), 0);
    $("learnFacts").innerHTML =
      fact(qs, T("収録問題")) + fact(units, T("問題集（入門〜資格対策）")) + fact(IG.certs.length, T("模擬試験"));
  }
  // The command dictionary, as a preview: a few things a visitor may want to do and the command for each
  const HOME_TASKS = { basics: [0, 2], docker: [1], k8s: [1, 3], aws: [3] };
  function renderHomeRef() {
    const R = IG.cmdref;
    if ($("homeRefTasks").childElementCount) return;
    const picks = [];
    for (const [topic, idx] of Object.entries(HOME_TASKS)) {
      const list = R.tasks.filter((t) => t.topic === topic);
      for (const i of idx) if (list[i]) picks.push(list[i]);
    }
    $("homeRefTasks").innerHTML = picks
      .map(
        (t) =>
          `<li><a href="#/ref/t/${encodeURIComponent(t.id)}"><b>${esc(t.q)}</b><code>${esc(t.do[0][0])}</code></a></li>`,
      )
      .join("");
    $("refFacts").innerHTML =
      fact(R.entries.filter((e) => !e.same).length, T("コマンド")) +
      fact(R.tasks.length, T("やりたいことのレシピ")) +
      fact(R.topics.length, T("分野"));
  }

  /* ------------------------------------------------------------ learning: drills & certifications */
  // A unit is "<topic>:<n>" or "<topic>:#<id>"; in a URL the pack id is written "e.<id>".
  const refToUrl = (ref) => String(ref).replace(/^#/, "e.");
  const urlToRef = (s) => (String(s).startsWith("e.") ? "#" + String(s).slice(2) : String(s));
  const pct = (x) => Math.round(x * 100) + "%";
  function refLinks(topic, keys) {
    const list = (keys || []).map((k) => IG.drillRef(topic, k)).filter(Boolean);
    if (!list.length) return "";
    return `<ul class="src-list">${list.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></li>`).join("")}</ul>`;
  }
  function unitStat(topic, unit) {
    const d = progress.drill(topic, unit.n ? unit.n : "#" + unit.id);
    if (!d) return { label: T("未挑戦"), cls: "" };
    if (d.passed) return { label: T("合格 {pct}", { pct: pct(d.best) }), cls: "passed" };
    return { label: T("最高 {pct}", { pct: pct(d.best) }), cls: "tried" };
  }

  function showLearn(topic) {
    stashMission();
    stopMission();
    run = null;
    showView("viewLearn");
    setNav("learn");
    renderProfile();
    window.scrollTo(0, 0);
    if (topic && IG.drills[topic]) renderLearnTopic(topic);
    else renderLearnIndex();
  }
  function renderLearnIndex() {
    document.title = `${T("ラーニング")} | CoreLab`;
    $("learnTitle").textContent = T("分野ごとの学習問題");
    $("learnLead").textContent = T(
      "ミッションに必要な知識を、入門からエキスパートまで 5 段階で。問題はすべて公式ドキュメントが出典で、各分野の認定資格の試験範囲に対応しています。",
    );
    $("learnCrumb").hidden = true;
    const topics = IG.drillTopics();
    const allUnits = topics.reduce((n, t) => n + IG.drillUnits(t).length, 0);
    const passedUnits = topics.reduce(
      (n, t) => n + IG.drillUnits(t).filter((u) => progress.unitPassed(t, u)).length,
      0,
    );
    const exams = IG.certs.filter((c) => progress.examPassed(c.id)).length;
    $("learnBody").innerHTML = `
      <dl class="hero-stats learn-stats">
        <div><dt>${T("合格した問題集")}</dt><dd>${passedUnits}/${allUnits}</dd></div>
        <div><dt>${T("模擬試験 合格")}</dt><dd>${exams}/${IG.certs.length}</dd></div>
        <div><dt>${T("収録問題")}</dt><dd>${topics.reduce((n, t) => n + IG.drillUnits(t).reduce((m, u) => m + u.qs.length, 0), 0)}</dd></div>
      </dl>
      <div class="learn-grid">${topics
        .map((t) => {
          const d = IG.drills[t],
            tr = trackOf(t);
          const done = progress.drillPassedCount(t),
            nx = progress.nextDrill(t);
          const certs = IG.certsOf(t);
          return `<article class="learn-card" style="--tc:${tr.color}">
          <header><span class="track-icon" data-t="${t}" aria-hidden="true"></span><div><h2>${esc(tr.name)}</h2><p>${esc(d.blurb)}</p></div></header>
          <ol class="level-dots" aria-label="${T("レベルの進捗")}">${d.levels
            .map((l) => {
              const s = unitStat(t, l);
              return `<li class="${s.cls}" title="Lv${l.n} ${esc(l.title)} — ${s.label}"><b>${l.n}</b><span>${esc(IG.levels[l.n - 1].name)}</span></li>`;
            })
            .join("")}</ol>
          <p class="learn-meta">${T("段階 {done}/{all} 合格", { done, all: d.levels.length })}${(d.extras || []).length ? ` · ${T("資格対策 {n} 本", { n: (d.extras || []).length })}` : ""}${certs.length ? ` · ${T("対応資格 {n}", { n: certs.length })}` : ""}</p>
          <footer><a class="btn primary small" href="#/drill/${t}/${nx.n}">${done ? T("続ける") : T("はじめる")}: Lv${nx.n} ${esc(nx.title)}</a><a class="btn ghost small" href="#/learn/${t}">${T("分野の詳細")} →</a></footer>
        </article>`;
        })
        .join("")}</div>
      <p class="small-print">${T("出典リンクは各認定機関・ベンダーの公式ドキュメントです（新しいタブで開きます）。内容は 2026-10 時点の公開情報にもとづきます。")}</p>`;
  }
  function renderLearnTopic(topic) {
    const d = IG.drills[topic],
      tr = trackOf(topic);
    document.title = `${T("{track} のラーニング", { track: tr.name })} | CoreLab`;
    $("learnTitle").textContent = T("{track} — 学習問題", { track: tr.name });
    $("learnLead").textContent = d.blurb;
    const crumb = $("learnCrumb");
    crumb.hidden = false;
    crumb.innerHTML = `<a href="#/learn">← ${T("分野一覧")}</a>${d.certs ? `<span class="cert-hint">${T("対応資格")}: ${esc(d.certs)}</span>` : ""}`;
    const unitCard = (unit, extra) => {
      const ref = unit.n ? unit.n : "#" + unit.id;
      const s = unitStat(topic, unit);
      const certs = IG.certsForUnit(`${topic}:${ref}`);
      return `<article class="unit ${s.cls}">
        <header>
          <span class="unit-badge">${unit.n ? "Lv" + unit.n : T("資格")}</span>
          <div><h3>${esc(unit.title)}</h3><small>${esc(unit.goal)}</small></div>
          <span class="unit-stat">${esc(s.label)}</span>
        </header>
        <ul class="points">${unit.points.map((p) => `<li>${inlineCode(p, true)}</li>`).join("")}</ul>
        ${cmdChips(`${topic}:${ref}`)}
        ${refLinks(topic, unit.refs)}
        ${
          certs.length
            ? `<p class="unit-certs">${T("試験範囲")}: ${certs
                .slice(0, 6)
                .map((c) => `<a href="#/learn/${topic}#cert-${c.id}">${esc(c.code)}</a>`)
                .join(T("、"))}${certs.length > 6 ? ` ${T("ほか {n}", { n: certs.length - 6 })}` : ""}</p>`
            : ""
        }
        <footer><a class="btn ${extra ? "ghost" : "primary"} small" href="#/drill/${topic}/${refToUrl(ref)}">${s.cls ? T("もう一度解く") : T("問題を解く")}${T("（{n} 問）", { n: unit.qs.length })}</a>
        ${
          (unit.missions || []).length
            ? (unit.missions || [])
                .map((id) => {
                  const m = IG.mission(id);
                  return m
                    ? `<a class="btn ghost small" href="#/play/${id}">${T("関連ミッション")}: ${esc(m.title)}</a>`
                    : "";
                })
                .join("")
            : ""
        }</footer>
      </article>`;
    };
    const certs = IG.certsOf(topic);
    $("learnBody").innerHTML = `
      <h2 class="section-label big">${T("段階別（入門 → エキスパート）")}</h2>
      <div class="units">${d.levels.map((l) => unitCard(l, false)).join("")}</div>
      ${
        (d.extras || []).length
          ? `<h2 class="section-label big">${T("資格対策の補講")}</h2>
        <p class="muted flat">${T("段階別の 5 本に加えて、資格の試験範囲を埋めるための問題集です。")}</p>
        <div class="units">${d.extras.map((e) => unitCard(e, true)).join("")}</div>`
          : ""
      }
      ${
        certs.length
          ? `<h2 class="section-label big">${T("対応資格と試験範囲")}</h2>
        <p class="muted flat">${T("公式の出題範囲（ドメインと配点）に、このゲームのどの問題集が対応しているかを示します。模擬試験は配点に応じて出題します。")}${IG.certNotes[topic] ? esc(T(IG.certNotes[topic])) : ""}</p>
        <div class="certs">${certs.map((c) => certCard(c, topic)).join("")}</div>`
          : ""
      }`;
    if (location.hash.includes("#cert-")) {
      const el = document.getElementById(
        location.hash.split("#cert-")[1] ? "cert-" + location.hash.split("#cert-")[1] : "",
      );
      if (el) {
        el.open = true;
        el.scrollIntoView({ block: "center" });
      }
    }
  }
  function certCard(c, topic) {
    const cov = IG.certCoverage(c);
    const ex = progress.exam(c.id);
    const size = Math.min(IG.EXAM_SIZE, cov.qs);
    return `<details class="cert" id="cert-${c.id}">
      <summary>
        <span class="cert-code">${esc(c.code)}</span>
        <span class="cert-name">${esc(c.name)}<small>${esc(c.org)} · ${esc(IG.certLevels[c.level] || "")}${ex ? (ex.passed ? ` · ${T("模擬試験 合格")}` : ` · ${T("模擬試験 最高 {pct}", { pct: pct(ex.best) })}`) : ""}</small></span>
        <span class="cov" title="${T("公式の配点のうち、このゲームの問題集が対応している割合")}"><i style="width:${cov.pct}%"></i><b>${cov.pct}%</b></span>
      </summary>
      <div class="cert-body">
        ${c.note ? `<p class="muted flat">${esc(c.note)}</p>` : ""}
        <p class="flat"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${T("公式の試験範囲を見る")}</a>${cov.out ? ` · ${T("このゲームの範囲外: 配点 {pct}%", { pct: cov.out })}` : ""}${cov.missing ? ` · ${T("未対応: 配点 {pct}%", { pct: cov.missing })}` : ""}</p>
        <table class="dom-table">
          <thead><tr><th>${T("出題範囲（公式）")}</th><th>${T("配点")}</th><th>${T("対応する問題集")}</th></tr></thead>
          <tbody>${c.domains
            .map((dm) => {
              const units = IG.domainUnits(dm);
              const cell = dm.out
                ? `<span class="out">${T("このゲームの範囲外")}</span>`
                : units.length
                  ? units
                      .map(
                        (u) =>
                          `<a href="#/drill/${u.topic}/${refToUrl(IG.unitRef(u.topic, u.unit).split(":")[1])}">${esc((u.topic === topic ? "" : (trackOf(u.topic) || {}).short + " ") + IG.unitName(u.unit))}</a>`,
                      )
                      .join("、")
                  : `<span class="out">${T("未対応")}</span>`;
              return `<tr class="${dm.out ? "is-out" : units.length ? "" : "is-missing"}"><td>${esc(dm.name)}</td><td>${dm.weight}%</td><td>${cell}</td></tr>`;
            })
            .join("")}</tbody>
        </table>
        ${size >= 5 ? `<a class="btn primary small" href="#/exam/${c.id}">${T("模擬試験に挑戦（{n} 問 · 合格 {pass}%）", { n: size, pass: Math.round(IG.EXAM_PASS * 100) })}</a>` : `<p class="muted flat">${T("この試験の対応問題がまだ少ないため、模擬試験は用意できていません。")}</p>`}
      </div>
    </details>`;
  }

  /* ---------------------------------------- a drill / exam run */
  function startDrill(topic, ref) {
    const u = IG.drillUnit(`${topic}:${ref}`);
    if (!u.unit) {
      location.hash = "#/learn";
      return;
    }
    try {
      run = IG.drillRun(topic, ref);
    } catch (e) {
      location.hash = "#/learn";
      return;
    }
    openRunView(trackOf(topic), `#/learn/${topic}`);
    $("drillNotes").innerHTML =
      `<h2>${T("要点")}</h2><ul class="points">${u.unit.points.map((p) => `<li>${inlineCode(p, true)}</li>`).join("")}</ul>
      <h2>${T("出典（公式ドキュメント）")}</h2>${refLinks(topic, u.unit.refs)}
      <p class="muted flat">${esc(u.unit.goal)}</p>`;
    renderQuestion();
  }
  function startExam(certId) {
    const c = IG.cert(certId);
    if (!c) {
      location.hash = "#/learn";
      return;
    }
    const cov = IG.certCoverage(c);
    try {
      run = IG.examRun(certId, Math.min(IG.EXAM_SIZE, cov.qs));
    } catch (e) {
      location.hash = "#/learn";
      return;
    }
    openRunView(trackOf(c.topic), `#/learn/${c.topic}`);
    $("drillNotes").innerHTML = `<h2>${esc(c.code)}</h2>
      <p class="flat">${esc(c.name)}<br><small class="muted">${esc(c.org)} · ${esc(IG.certLevels[c.level] || "")}</small></p>
      <p class="flat"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${T("公式の試験範囲")}</a></p>
      <p class="muted flat">${T("公式の配点に応じて、対応する問題集から {n} 問を出題します。合格ラインは {pass}% です。本番の形式・難易度を再現するものではありません。", { n: run.items.length, pass: Math.round(IG.EXAM_PASS * 100) })}</p>
      <p class="muted flat">${T("このゲームの対応範囲: 配点の {pct}%", { pct: cov.pct })}${cov.out ? T("（範囲外 {pct}%）", { pct: cov.out }) : ""}${cov.missing ? T("（未対応 {pct}%）", { pct: cov.missing }) : ""}</p>`;
    renderQuestion();
  }
  // Leaving a mission for a drill: keep the session (and the screen) so it can be resumed.
  function stashMission() {
    if (!session || $("viewMission").hidden) return;
    stash = {
      id: session.m.id,
      session,
      out: $("termOut").innerHTML,
      events: $("eventList").innerHTML,
      history: term.history.slice(),
      leftAt: IG.clock.now(),
    };
  }
  function openRunView(tr, backHref) {
    stashMission();
    stopMission();
    showView("viewDrill");
    setNav("learn");
    renderProfile();
    const chip = $("drillChip");
    chip.textContent = (tr || {}).name || "LEARNING";
    chip.style.setProperty("--tc", (tr || {}).color || "#d9783f");
    $("drillTitle").textContent = run.meta.title;
    document.title = `${run.meta.title} | CoreLab`;
    $("drillBack").href = backHref;
    window.scrollTo(0, 0);
  }
  function renderQuestion() {
    if (!run) return;
    const total = run.items.length;
    $("drillCount").textContent = `${Math.min(run.pos + 1, total)} / ${total}`;
    $("drillFill").style.width = `${(run.answers.length / total) * 100}%`;
    const it = run.current;
    const q = it.q;
    const answered = run.answers[run.pos];
    const choices = q.c
      ? `<ol class="choices">${it.order
          .map((orig, i) => {
            const cls = answered ? (orig === 0 ? "right" : answered.given === i ? "wrong" : "") : "";
            return `<li><button class="choice ${cls}" data-choice="${i}" ${answered ? "disabled" : ""}><span class="pick">${String.fromCharCode(65 + i)}</span><span>${esc(q.c[orig])}</span></button></li>`;
          })
          .join("")}</ol>`
      : `<form class="typed" id="typedForm"><label for="typedInput">${T("コマンドを入力")}</label>
         <input id="typedInput" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${T("例")}: kubectl get pods" ${answered ? "disabled" : ""} value="${answered ? esc(String(answered.given)) : ""}">
         <button class="btn primary small" type="submit" ${answered ? "disabled" : ""}>${T("回答する")}</button></form>`;
    $("drillMain").innerHTML = `
      <article class="qcard">
        <p class="qnum">${T("第 {n} 問", { n: run.pos + 1 })}${it.domain ? ` <span class="qdomain">${esc(it.domain)}</span>` : ""}${q.c ? "" : ` <span class="qdomain">${T("記述")}</span>`}</p>
        <h2 class="qtext">${inlineCode(q.q, true)}</h2>
        ${q.code ? `<pre class="qcode">${esc(q.code)}</pre>` : ""}
        ${choices}
        <div class="feedback" id="feedback"></div>
      </article>`;
    if (answered) showFeedback(answered);
    else if (!q.c) {
      const i = $("typedInput");
      if (window.innerWidth > 820) i.focus();
    }
  }
  function showFeedback(a) {
    const last = run.answers.length >= run.items.length;
    $("feedback").innerHTML = `
      <p class="verdict ${a.correct ? "ok" : "ng"}">${a.correct ? `✔ ${T("正解")}` : `✘ ${T("不正解")}`}${a.correct ? "" : `　${T("正解")}: <code>${esc(a.expected)}</code>`}</p>
      <p class="why">${inlineCode(a.item.q.x, true)}</p>
      ${a.ref ? `<p class="src">${T("出典")}: <a href="${esc(a.ref.url)}" target="_blank" rel="noopener noreferrer">${esc(a.ref.title)}</a></p>` : ""}
      <button class="btn primary small" id="nextQ">${last ? T("結果を見る") : `${T("次の問題")} →`}</button>`;
    $("nextQ").focus({ preventScroll: true });
  }
  function answerCurrent(v) {
    if (!run || run.answers[run.pos]) return;
    const a = run.answer(v);
    if (!a) return;
    renderQuestion();
  }
  function advance() {
    if (!run) return;
    if (run.next()) {
      renderQuestion();
      return;
    }
    showRunResult();
  }
  function showRunResult() {
    const res = run.result();
    const rec = progress.recordRun(run, res); // a review of missed questions records nothing
    renderProfile();
    const review = !!run.meta.review;
    const meta = review ? run.meta.from : run.meta;
    const exam = meta.kind === "exam";
    const cert = exam ? meta.cert : null;
    const topic = exam ? cert.topic : meta.topic;
    const d = IG.drills[topic];
    const nextLevel = !exam && meta.unit.n ? d.levels.find((l) => l.n === Number(meta.unit.n) + 1) : null;
    $("drillFill").style.width = "100%";
    $("drillMain").innerHTML = `
      <article class="qcard result-card">
        <p class="kicker">${review ? "REVIEW" : exam ? "MOCK EXAM RESULT" : "DRILL RESULT"}</p>
        <h2>${review ? (res.passed ? T("全問正解！") : T("あと少し")) : res.passed ? T("合格！") : T("もう一歩")} <span class="score">${res.score} / ${res.total}（${pct(res.pct)}）</span></h2>
        <p class="muted flat">${review ? T("間違えた問題の解き直し（記録には残りません） · 所要 {time}", { time: fmtTime(res.time) }) : T("合格ライン {pass}% · 所要 {time}", { pass: Math.round(run.meta.pass * 100), time: fmtTime(res.time) })}${rec.gain ? ` · ${T("獲得 +{xp} XP", { xp: rec.gain })}` : ""}</p>
        ${rec.rankUp ? `<p class="levelup">🎉 ${T("ランクアップ！「{rank}」になりました", { rank: esc(rec.rankUp.name) })}</p>` : ""}
        ${rec.newBadges.map((b) => `<p class="levelup">${IG.badges[b].icon} ${T("バッジ獲得")}: ${esc(IG.badges[b].name)}</p>`).join("")}
        ${
          res.missed.length
            ? `<h3>${T("間違えた問題（{n}）", { n: res.missed.length })}</h3>
          <ol class="missed">${res.missed.map((m) => `<li><b>${inlineCode(m.item.q.q, true)}</b><span class="ans">${T("正解")}: <code>${esc(m.expected)}</code></span><span class="why">${inlineCode(m.item.q.x)}</span>${m.ref ? `<a href="${esc(m.ref.url)}" target="_blank" rel="noopener noreferrer">${esc(m.ref.title)}</a>` : ""}</li>`).join("")}</ol>`
            : `<p class="flat">${T("全問正解です。")}</p>`
        }
        <footer class="result-actions">
          ${res.missed.length ? `<button class="btn primary small" id="reviewRun">${T("間違えた {n} 問だけ解き直す", { n: res.missed.length })}</button>` : ""}
          <button class="btn ${res.missed.length ? "ghost" : "primary"} small" id="retryRun">${review ? T("全問をもう一度") : T("もう一度")}</button>
          ${nextLevel ? `<a class="btn ghost small" href="#/drill/${topic}/${nextLevel.n}">${T("次のレベル")}: Lv${nextLevel.n} ${esc(nextLevel.title)}</a>` : ""}
          ${exam ? "" : `<a class="btn ghost small" href="#/learn/${topic}">${T("{track}の一覧へ", { track: esc((trackOf(topic) || {}).name || "") })}</a>`}
          ${exam ? `<a class="btn ghost small" href="#/learn/${topic}#cert-${cert.id}">${T("試験範囲に戻る")}</a>` : ""}
          ${stash ? `<a class="btn ghost small" href="#/play/${stash.id}">${T("ミッションに戻る")}: ${esc((IG.mission(stash.id) || {}).title || "")}</a>` : ""}
        </footer>
      </article>`;
    if ($("reviewRun"))
      $("reviewRun").onclick = () => {
        run = IG.reviewRun(run);
        $("drillTitle").textContent = run.meta.title;
        window.scrollTo(0, 0);
        renderQuestion();
      };
    $("retryRun").onclick = () => {
      const h = location.hash;
      location.hash = "#/learn";
      setTimeout(() => {
        location.hash = h;
      }, 0);
    };
  }

  /* ------------------------------------------------------------ mission */
  function stopMission() {
    clearInterval(tick);
    tick = null;
    $("missionTip").hidden = true;
    if ($("terminal").classList.contains("max")) toggleMax(false);
  }
  function openMission(id, restart) {
    const m = IG.mission(id);
    if (!m) {
      location.hash = "#/";
      return;
    }
    if (!m.sandbox && !progress.unlocked(m, unlockAll)) {
      toast(T("このミッションはまだロックされています"));
      location.hash = "#/";
      return;
    }
    // Back from a drill: pick the mission up where it was left, and do not count the time away.
    const resume = !restart && stash && stash.id === id ? stash : null;
    stopMission();
    closeAllModals();
    if (!progress.data.seenIntro) {
      progress.data.seenIntro = true;
      progress.save();
    }
    run = null;
    if (resume) {
      session = resume.session;
      session.startedAt += IG.clock.now() - resume.leftAt;
    } else {
      stash = null;
      IG.clock.offset = 0;
      session = new IG.Session(m);
    }
    showView("viewMission");
    setNav(m.sandbox ? "sandbox" : "home");
    document.title = `${m.title} | CoreLab`;
    renderProfile();
    const t = trackOf(m.track) || { name: "FREE LAB", color: "#d9783f" };
    const chip = $("mTrack");
    chip.textContent = t.name;
    chip.style.setProperty("--tc", t.color);
    $("mTitle").textContent = m.title;
    $("mStory").innerHTML = m.story.map((p) => `<p>${inlineCode(p)}</p>`).join("");
    $("storyBox").open = true;
    $("sandboxNote").hidden = !m.sandbox;
    $("mStars").hidden = !!m.sandbox;
    $("showSolution").hidden = !!m.sandbox;
    renderObjectives();
    renderNeedKnow(m);
    renderCheat();
    if (resume) {
      $("eventList").innerHTML = resume.events;
      $("termOut").innerHTML = resume.out;
      term.history = resume.history;
      term.idx = resume.history.length;
      term.pending = null;
      term.search = null;
      addEvent(T("学習問題から戻りました（環境はそのままです）"), "INFO");
    } else {
      $("eventList").innerHTML = "";
      session.world.listeners.push((e) => addEvent(e.msg, e.level));
      addEvent(m.sandbox ? T("フリーラボを起動しました") : `${T("ミッション開始")}: ${m.title}`, "INFO");
      $("termOut").innerHTML = "";
      printLine("sys", T("CoreLab 訓練シェルに接続しました（すべてブラウザ内のシミュレーションです）"));
      printLine(
        "sys",
        m.sandbox
          ? T("help でコマンド一覧 · Ctrl+K でコマンド辞典。README.md に例があります。")
          : T("help でコマンド一覧 · Tab で補完 · Ctrl+K でコマンド辞典 · 左の「目標」を達成するとクリア"),
      );
      term.history = [];
      term.idx = 0;
      term.pending = null;
      term.search = null;
    }
    updatePrompt();
    if (!missionView) missionView = new IG.DC.View($("dcMission"), { compact: true, onHover: (h) => missionTip(h) });
    missionView.setScene(IG.DC.sceneFromWorld(session.world));
    requestAnimationFrame(() => missionView.resize());
    tick = setInterval(onTick, 500);
    onTick();
    $("termInput").value = "";
    if (document.activeElement && window.innerWidth <= 820) document.activeElement.blur();
    window.scrollTo(0, 0);
    requestAnimationFrame(() => window.scrollTo(0, 0));
    if (window.innerWidth > 820) setTimeout(() => $("termInput").focus({ preventScroll: true }), 50);
  }
  function onTick() {
    if (!session) return;
    const el = session.elapsed();
    $("mTimer").textContent = fmtTime(el);
    $("mHints").textContent = session.hintsUsed;
    if (!session.m.sandbox) {
      const r = session.result;
      let stars = r
        ? r.stars
        : 3 - (session.hintsUsed > 0 ? 1 : 0) - (session.hintsUsed > 2 || el > session.m.par ? 1 : 0);
      if (session.gaveUp) stars = 0;
      $("mStars").innerHTML = starText(Math.max(session.gaveUp ? 0 : 1, stars));
      $("mStars").title = T("目標時間 {time} · ヒントを使うと★が減ります", { time: fmtTime(session.m.par) });
    }
    missionView && missionView.setScene(IG.DC.sceneFromWorld(session.world));
  }
  function renderObjectives() {
    const m = session.m;
    $("mProgress").textContent = `${session.done.filter(Boolean).length}/${m.objectives.length}`;
    $("mObjectives").innerHTML = m.objectives
      .map((o, i) => {
        const shown = o.hints.slice(0, session.hintsShown[i]);
        const left = o.hints.length - session.hintsShown[i];
        return `<li class="obj ${session.done[i] ? "done" : ""}" id="obj${i}">
        <div class="obj-head"><span class="obj-check">${session.done[i] ? "✓" : i + 1}</span><div><strong>${esc(o.title)}</strong><small>${esc(o.detail)}</small></div></div>
        <div class="obj-hints">${shown.map((h) => `<div class="hint">💡 ${inlineCode(h)}</div>`).join("")}
        ${left > 0 && !session.done[i] ? `<button class="hint-btn" data-hint="${i}" title="${T("ヒントを見ると評価の★が減ります")}">${T("ヒントを見る（残り {n}）", { n: left })}</button>` : ""}</div></li>`;
      })
      .join("");
  }
  // Drills whose level lists this mission, shown under the objectives.
  function renderNeedKnow(m) {
    const links = IG.drillsForMission(m.id);
    $("needKnow").hidden = !links.length;
    if (!links.length) return;
    $("needLinks").innerHTML =
      links
        .map(({ topic, level }) => {
          const tr = trackOf(topic) || {};
          const s = unitStat(topic, level);
          return `<a class="need-link ${s.cls}" href="#/drill/${topic}/${level.n}" style="--tc:${tr.color || "#d9783f"}">
        <span class="need-lv">Lv${level.n}</span>
        <span><strong>${esc(level.title)}</strong><small>${esc(tr.short || topic)} · ${T("{n} 問", { n: level.qs.length })} · ${esc(s.label)}</small></span></a>`;
        })
        .join("") +
      `<a class="need-link more" href="#/learn/${m.track || links[0].topic}"><span class="need-lv">＋</span><span><strong>${T("この分野の学習問題すべて")}</strong><small>${T("資格の試験範囲・模擬試験もここから")}</small></span></a>`;
  }
  // 早見表: each toolset present in this mission's world, from the command dictionary
  function renderCheat() {
    const R = IG.cmdref,
      f = session.world.features;
    const groups = R.topics.filter((t) => R.cheats[t] && R.topicOn(t, f));
    $("tabCheat").innerHTML =
      `<button type="button" class="btn ghost small cheat-search" data-open-ref>⌕ ${T("コマンド辞典で探す")} <kbd>Ctrl K</kbd></button>
      <div class="cheat">${groups.map((t) => `<h3>${esc(trackOf(t).label)}</h3><dl>${R.cheats[t].map(([c, d]) => `<dt data-cmd="${esc(c)}" title="${T("クリックで入力")}">${esc(c)}</dt><dd>${esc(d)}</dd>`).join("")}</dl>`).join("")}</div>`;
  }
  function addEvent(msg, level) {
    const li = document.createElement("li");
    li.className = level;
    const t = document.createElement("time");
    t.textContent = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    const s = document.createElement("span");
    s.textContent = msg;
    li.append(t, s);
    const list = $("eventList");
    list.prepend(li);
    while (list.children.length > 80) list.lastChild.remove();
  }
  function missionTip(h) {
    const tip = $("missionTip");
    if (!h) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<strong>${esc(h.rack.label)}</strong>${h.zone ? `<small style="color:var(--dim)">${esc(h.zone.label)}</small>` : ""}${
      h.rack.info && h.rack.info.length
        ? `<ul>${h.rack.info
            .slice(0, 12)
            .map((i) => `<li>${esc(i)}</li>`)
            .join("")}</ul>`
        : ""
    }`;
    tip.hidden = false;
    tip.style.left = Math.min(h.x + 14, window.innerWidth - 320) + "px";
    tip.style.top = Math.min(h.y + 14, window.innerHeight - 160) + "px";
  }

  /* ------------------------------------------------------------ terminal */
  const HL =
    /(\b(?:CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|NotReady|FailedScheduling|Unauthorized|Forbidden|NXDOMAIN|AccessDenied)\b|\bExited \(\d+\)|\b(?:Error|ERROR|Failed|failed|FAILURE)\b)|(\b(?:Pending|ContainerCreating|Terminating|SchedulingDisabled|Warning|WARN|WARNING!?|DiskPressure)\b)|(\b(?:Running|Completed|Succeeded|Login Succeeded|Login successful|successfully rolled out|ACTIVE|healthy)\b|\bUp \d+ \w+)/g;
  function highlight(text) {
    return text
      .split("\n")
      .map((line) => {
        const e = esc(line);
        if (/^ℹ/.test(line)) return `<span class="s-info">${e}</span>`;
        if (/^\s*#/.test(line)) return `<span class="s-dim">${e}</span>`;
        return e.replace(
          HL,
          (m, bad, warn, good) => `<span class="${bad ? "s-bad" : warn ? "s-warn" : "s-ok"}">${m}</span>`,
        );
      })
      .join("\n");
  }
  // ANSI SGR (colour) sequences emitted by ls/grep/tree --color → spans
  const ANSI_FG = {
    30: "k",
    31: "r",
    32: "g",
    33: "y",
    34: "b",
    35: "m",
    36: "c",
    37: "w",
    90: "k",
    91: "r",
    92: "g",
    93: "y",
    94: "b",
    95: "m",
    96: "c",
    97: "w",
  };
  function ansi(text) {
    let html = "",
      open = false;
    const parts = String(text).split(/\x1b\[([\d;]*)m(?:\x1b\[K)?/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        html += esc(parts[i]);
        continue;
      }
      if (open) {
        html += "</span>";
        open = false;
      }
      const codes = parts[i].split(";").filter(Boolean).map(Number);
      if (!codes.length || codes.every((c) => c === 0)) continue;
      const cls = codes
        .map((c) => (c === 1 ? "a-bold" : ANSI_FG[c] ? "a-" + ANSI_FG[c] : c >= 40 && c <= 47 ? "a-bg" : ""))
        .filter(Boolean)
        .join(" ");
      html += `<span class="${cls}">`;
      open = true;
    }
    return html + (open ? "</span>" : "");
  }
  function printLine(cls, text, raw) {
    const out = $("termOut");
    const div = document.createElement("div");
    div.className = cls;
    if (raw) div.innerHTML = raw;
    else if (cls === "out" || cls === "err") div.innerHTML = /\x1b\[/.test(text) ? ansi(text) : highlight(text);
    else div.textContent = text;
    out.appendChild(div);
    while (out.children.length > 800) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  }
  function printChunks(chunks) {
    // merge consecutive chunks of the same stream; drop the final newline of each block
    const blocks = [];
    for (const c of chunks) {
      const last = blocks[blocks.length - 1];
      if (last && last.stream === c.stream) last.text += c.text;
      else blocks.push({ stream: c.stream, text: c.text });
    }
    for (const b of blocks) {
      const t = b.text.replace(/\n$/, "");
      if (t || b.text) printLine(b.stream === "err" ? "err" : "out", t);
    }
  }
  function updatePrompt() {
    const p = term.pending !== null ? ">" : session.shell.prompt();
    $("termPrompt").textContent = term.search
      ? `(reverse-i-search)\`${term.search.q}': ${term.search.match || (term.search.q ? T("（一致なし）") : "")}`
      : p;
    if (term.pending === null)
      $("termTitle").textContent = p
        .replace(/^\[/, "")
        .replace(/[$#]$/, "")
        .replace(/[:\s].*$/, "");
  }
  function submit(line) {
    if (!session) return;
    const shownPrompt = term.pending !== null ? ">" : session.shell.prompt();
    printLine("cmd", "", `<span class="p">${esc(shownPrompt)}</span> ${esc(line)}`);
    const full = term.pending !== null ? term.pending + "\n" + line : line;
    const before = session.completed;
    const r = session.run(full);
    if (r.res.incomplete) {
      term.pending = full;
      updatePrompt();
      return;
    }
    term.pending = null;
    if (full.trim()) term.history.push(full);
    term.idx = term.history.length;
    if (r.res.clear) $("termOut").innerHTML = "";
    if (r.res.chunks) printChunks(r.res.chunks);
    else if (r.res.out) printLine(r.res.err ? "err" : "out", r.res.out);
    updatePrompt();
    handleProgress(r.newly, before);
    if (r.res.editor) openEditor(r.res.editor);
    onTick();
  }
  // Ctrl+R reverse history search
  function searchUpdate() {
    const s = term.search;
    const hist = session ? session.shell.history : [];
    s.match = "";
    for (let i = hist.length - 1; i >= 0; i--)
      if (s.q && hist[i].includes(s.q)) {
        s.match = hist[i];
        break;
      }
    $("termInput").placeholder = T("検索語を入力（Enter で実行 / Esc で編集）");
    updatePrompt();
  }
  function searchEnd(execute) {
    const s = term.search;
    term.search = null;
    $("termInput").placeholder = T("コマンドを入力（help で一覧）");
    updatePrompt();
    if (execute && s && s.match) {
      $("termInput").value = "";
      submit(s.match);
    } else if (s) $("termInput").value = s.match || "";
  }
  function handleProgress(newly, wasComplete) {
    let done = false;
    for (const i of newly) {
      if (i === "complete") {
        done = true;
        continue;
      }
      const o = session.m.objectives[i];
      printLine("win", `✔ ${T("目標達成")}: ${o.title}`);
      addEvent(`${T("目標達成")}: ${o.title}`, "GOAL");
      toast(`✔ ${T("目標達成")}: ${o.title}`, true);
    }
    if (newly.length) {
      renderObjectives();
      newly
        .filter((i) => i !== "complete")
        .forEach((i) => {
          const el = $("obj" + i);
          if (el) el.classList.add("flash");
        });
    }
    if (done && !wasComplete) setTimeout(showResult, 900);
  }
  function toggleMax(force) {
    const t = $("terminal");
    const on = force === undefined ? !t.classList.contains("max") : force;
    t.classList.toggle("max", on);
    $("termMax").textContent = on ? "⤡" : "⛶";
    $("termMax").title = on ? T("元に戻す (Esc)") : T("ターミナルを最大化");
    $("termOut").scrollTop = $("termOut").scrollHeight;
    $("termInput").focus();
  }
  function insertCommand(cmd) {
    if ($("viewMission").hidden || !session) {
      openRefFor(cmd);
      return;
    }
    const input = $("termInput");
    input.value = cmd;
    input.focus();
    input.setSelectionRange(cmd.length, cmd.length);
  }

  /* ------------------------------------------------------------ editor */
  function openEditor(req) {
    const host = session.world.hosts[req.host || session.shell.host.name];
    editor.path = req.path;
    editor.host = host;
    editor.onSave = req.onSave || null;
    editor.readonly = !!req.readonly;
    editor.owner = req.owner;
    editor.group = req.group;
    editor.umask = req.umask;
    editor.original = host.vfs.read(req.path) ?? "";
    const ta = $("editorText");
    ta.value = editor.original;
    const home = host.home;
    $("editorTitle").textContent =
      (req.path.startsWith(home) ? "~" + req.path.slice(home.length) : req.path) +
      (host.vfs.exists(req.path) ? "" : ` [${T("新規")}]`) +
      (editor.readonly ? ` [${T("読み取り専用")}]` : "");
    setMode("INSERT");
    $("vimForm").hidden = true;
    $("editorModal").hidden = false;
    gutter();
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }
  function setMode(m) {
    $("editorMode").textContent = m;
  }
  function gutter() {
    const n = $("editorText").value.split("\n").length;
    $("editorGutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
    $("editorGutter").scrollTop = $("editorText").scrollTop;
    const dirty = $("editorText").value !== editor.original;
    $("editorStatus").textContent = dirty
      ? T("● 未保存の変更があります — Esc → :wq で保存して終了 / :q! で破棄")
      : T("Esc → :wq で保存して終了 / :q! で破棄 / Ctrl+S で保存");
  }
  function saveEditor(close) {
    const text = $("editorText").value;
    if (editor.readonly) {
      toast(T("E45: 読み取り専用です。システムファイルは sudo vi <file> で開いてください"));
      return false;
    }
    try {
      const exists = editor.host.vfs.exists(editor.path);
      editor.host.vfs.write(
        editor.path,
        text,
        exists || !editor.owner
          ? {}
          : { owner: editor.owner, group: editor.group, mode: 0o666 & ~(editor.umask ?? 0o002) },
      );
    } catch (e) {
      toast(T("E212: 書き込みできません（ディレクトリが存在しない）"));
      return false;
    }
    editor.original = text;
    gutter();
    if (editor.onSave) {
      const r = editor.onSave(text);
      if (r && r.out) printLine(r.err ? "err" : "out", r.out);
      if (r && r.err) {
        toast(T("適用に失敗しました（ターミナルを確認）"));
      }
    } else toast(`"${IG.VFS.base(editor.path)}" ${text.split("\n").length}L written`);
    session.world.reconcile();
    const before = session.completed;
    handleProgress(session.evaluate(), before);
    if (close) closeEditor(true);
    return true;
  }
  function closeEditor(force) {
    if (!force && $("editorText").value !== editor.original) {
      toast(T("E37: 変更が保存されていません（:wq で保存 / :q! で破棄）"));
      return;
    }
    $("editorModal").hidden = true;
    if (editor.onSave && force !== "saved" && $("editorText").value === editor.original && !editor.savedOnce) {
      /* kubectl edit cancelled */
    }
    editor.onSave = null;
    $("termInput").focus();
  }
  function runVim(cmd) {
    const c = cmd.trim().replace(/^:/, "");
    if (c === "w") return saveEditor(false);
    if (c === "wq" || c === "x" || c === "wq!") return saveEditor(true);
    if (c === "q") return closeEditor(false);
    if (c === "q!") {
      $("editorText").value = editor.original;
      if (editor.onSave) printLine("out", "Edit cancelled, no changes made.");
      return closeEditor(true);
    }
    if (/^\d+$/.test(c)) {
      const ta = $("editorText");
      const lines = ta.value.split("\n");
      const pos = lines.slice(0, Number(c) - 1).join("\n").length + (Number(c) > 1 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      return;
    }
    toast(`${T("E492: エディタのコマンドではありません")}: ${c}`);
  }

  /* ------------------------------------------------------------ result / solution */
  /* ------------------------------------------------------------ command dictionary: page and quick search */
  let refPage = null,
    refQuick = null;
  const refHash = (s) =>
    s.sel
      ? `#/ref/${s.sel.kind}/${encodeURIComponent(s.sel.id)}`
      : s.q.trim()
        ? `#/ref?q=${encodeURIComponent(s.q.trim())}`
        : "#/ref";
  function refOpts(modal) {
    return {
      modal,
      toast,
      progress,
      unlockAll,
      canInsert: () => !!session && !$("viewMission").hidden,
      insert: (cmd) => {
        if (modal) $("refModal").hidden = true;
        insertCommand(cmd);
      },
      onState: modal
        ? null
        : (st, push) => {
            const h = refHash(st);
            if (location.hash !== h)
              history[push ? "pushState" : "replaceState"](
                { ref: push || (history.state && history.state.ref) },
                "",
                h,
              );
            refTitle(st);
          },
    };
  }
  function refTitle(st) {
    const it = st.sel && (st.sel.kind === "t" ? IG.cmdref.task(st.sel.id) : IG.cmdref.get(st.sel.id));
    document.title = `${it ? (it.q || it.name) + " | " : ""}${T("コマンド辞典")} | CoreLab`;
  }
  function showRef(sel, q) {
    const entering = $("viewRef").hidden;
    stashMission();
    stopMission();
    run = null;
    showView("viewRef");
    setNav("ref");
    renderProfile();
    if (!refPage) refPage = new IG.RefView($("refPage"), refOpts(false));
    const st = { sel };
    if (q !== undefined) Object.assign(st, { q, cat: "" });
    refPage.set(st);
    refTitle(refPage.s);
    if (entering) {
      window.scrollTo(0, 0);
      if (!sel && window.innerWidth > 820) refPage.focus();
    }
  }
  // Ctrl+K, /, ⌕: the page's own box on the dictionary page, the quick search everywhere else
  function openSearch() {
    if (!$("viewRef").hidden && refPage) {
      refPage.focus();
      return;
    }
    openRefQuick();
  }
  function openRefQuick(st) {
    if (!refQuick) refQuick = new IG.RefView($("refModalBody"), refOpts(true));
    $("refModal").hidden = false;
    refQuick.stack = [];
    if (st) refQuick.set(Object.assign({ q: "", cat: "", sel: null }, st));
    else refQuick.render();
    if (refQuick.s.sel) refQuick.detail.focus({ preventScroll: true });
    else refQuick.focus();
  }
  // a command line → its dictionary entry (or a search for it)
  function openRefFor(line) {
    const name = IG.cmdref.resolve(line)[0];
    if (name) openRefQuick({ sel: { kind: "c", id: name } });
    else openRefQuick({ q: line });
  }
  function cmdChips(ref) {
    const names = IG.cmdref.cmdsForDrill(ref).slice(0, 14);
    return names.length
      ? `<p class="unit-cmds"><span>${T("出てくるコマンド")}</span>${names.map((n) => `<code data-ref-cmd="${esc(n)}" title="${T("コマンド辞典で見る")}">${esc(n)}</code>`).join("")}</p>`
      : "";
  }

  function showResult() {
    const m = session.m,
      r = session.result;
    if (!r) return;
    const rec = session.gaveUp ? { gain: 0, newBadges: [], rankUp: null } : progress.record(m, r);
    $("resultTitle").textContent = T(
      session.gaveUp ? "復旧完了（解答参照）" : ["", "復旧完了！", "ナイス対応！", "完璧な障害対応！"][r.stars],
    );
    $("resultStars").innerHTML = Array.from(
      { length: 3 },
      (_, i) => `<span class="${i < r.stars ? "" : "empty"}" style="animation-delay:${0.15 + i * 0.18}s">★</span>`,
    ).join("");
    $("rTime").textContent = `${fmtTime(r.time)} / ${T("目標")} ${fmtTime(m.par)}`;
    $("rHints").textContent = T("{n} 回", { n: r.hints });
    $("rXp").textContent = session.gaveUp ? "0" : `+${rec.gain}`;
    const extra = [];
    if (session.gaveUp) extra.push(T("解答を見たため XP は獲得できません。もう一度挑戦してみましょう！"));
    else if (!rec.gain && progress.stars(m.id) >= r.stars) extra.push(T("ベスト記録以下のため追加 XP はありません"));
    if (rec.rankUp) extra.push(`🎉 ${T("ランクアップ！「{rank}」になりました", { rank: esc(rec.rankUp.name) })}`);
    for (const b of rec.newBadges)
      extra.push(
        `<span class="badge-earned">${IG.badges[b].icon} ${T("バッジ獲得")}: ${esc(IG.badges[b].name)}</span>`,
      );
    $("rExtra").innerHTML = extra.join("<br>");
    $("rPoints").innerHTML = m.debrief.points.map((p) => `<li>${inlineCode(p, true)}</li>`).join("");
    $("rCommands").innerHTML = m.debrief.commands
      .map(
        ([c, d]) =>
          `<tr><td><code data-ref-cmd="${esc(c)}" title="${T("コマンド辞典で詳しく見る")}">${esc(c)}</code></td><td>${esc(d)}</td></tr>`,
      )
      .join("");
    const list = IG.missionsOf(m.track);
    const nx = list[list.indexOf(m) + 1] || nextMission();
    $("rNext").textContent = nx ? `${T("次へ")}: ${nx.title} →` : `${T("ミッション一覧へ")} →`;
    $("rNext").onclick = () => {
      $("resultModal").hidden = true;
      location.hash = nx ? `#/play/${nx.id}` : "#/";
      if (nx && location.hash === `#/play/${nx.id}`) openMission(nx.id);
    };
    $("rRetry").onclick = () => {
      $("resultModal").hidden = true;
      stash = null;
      openMission(m.id, true);
    };
    $("rStay").onclick = () => {
      $("resultModal").hidden = true;
      $("termInput").focus();
    };
    renderProfile();
    $("resultModal").hidden = false;
    $("rNext").focus();
  }
  function showSolution() {
    if (!session || session.m.sandbox) return;
    if (!session.completed) {
      session.giveUp();
      onTick();
    }
    $("solList").innerHTML = session
      .solution()
      .map(
        (c) =>
          `<li><div><code>${esc(c)}</code><button class="btn ghost small" data-insert="${esc(c)}">${T("入力")}</button></div></li>`,
      )
      .join("");
    $("solutionModal").hidden = false;
  }
  function closeAllModals() {
    document.querySelectorAll(".modal-backdrop").forEach((m) => {
      if (m.id !== "editorModal") m.hidden = true;
    });
  }

  /* ------------------------------------------------------------ events */
  function route() {
    const h = location.hash;
    let m;
    // A dialog belongs to the screen it was opened on (the browser's Back after a mission left its result on top)
    closeAllModals();
    if ((m = h.match(/^#\/ref(?:\/([ct])\/([^?]*))?(?:\?q=(.*))?$/)))
      return showRef(
        m[1] ? { kind: m[1], id: decodeURIComponent(m[2]) } : null,
        m[3] !== undefined ? decodeURIComponent(m[3]) : m[1] ? undefined : "",
      );
    if ((m = h.match(/^#\/play\/([\w-]+)/))) return openMission(m[1]);
    if ((m = h.match(/^#\/drill\/([\w-]+)\/([\w.-]+)/))) return startDrill(m[1], urlToRef(m[2]));
    if ((m = h.match(/^#\/exam\/([\w.-]+)/))) return startExam(m[1]);
    if ((m = h.match(/^#\/learn(?:\/([\w-]+))?/))) return showLearn(m[1]);
    showHome();
  }
  window.addEventListener("hashchange", route);

  document.addEventListener("click", (e) => {
    const play = e.target.closest("[data-play]");
    if (play && !play.disabled) {
      const id = play.dataset.play;
      if (location.hash === `#/play/${id}`) openMission(id, true);
      else location.hash = `#/play/${id}`;
      return;
    }
    const hint = e.target.closest("[data-hint]");
    if (hint && session) {
      const i = Number(hint.dataset.hint);
      const h = session.hint(i);
      if (h) {
        addEvent(`${T("ヒント使用")}: ${session.m.objectives[i].title}`, "WARN");
        renderObjectives();
        onTick();
      }
      return;
    }
    const cmd = e.target.closest("[data-cmd]");
    if (cmd) {
      insertCommand(cmd.dataset.cmd);
      return;
    }
    const rc = e.target.closest("[data-ref-cmd]");
    if (rc) {
      openRefFor(rc.dataset.refCmd);
      return;
    }
    if (e.target.closest("[data-open-ref]")) {
      openRefQuick();
      return;
    }
    const ins = e.target.closest("[data-insert]");
    if (ins) {
      $("solutionModal").hidden = true;
      insertCommand(ins.dataset.insert);
      return;
    }
    const close = e.target.closest("[data-close]");
    if (close) {
      close.closest(".modal-backdrop").hidden = true;
      return;
    }
    if (e.target.classList.contains("modal-backdrop") && e.target.id !== "editorModal" && e.target.id !== "resultModal")
      e.target.hidden = true;
  });
  // drill / mock exam: choices, typed answers, next question
  $("drillMain").addEventListener("click", (e) => {
    const c = e.target.closest("[data-choice]");
    if (c && !c.disabled) {
      answerCurrent(Number(c.dataset.choice));
      return;
    }
    if (e.target.closest("#nextQ")) advance();
  });
  $("drillMain").addEventListener("submit", (e) => {
    if (!e.target.closest("#typedForm")) return;
    e.preventDefault();
    const input = $("typedInput");
    if (!input || input.disabled) return;
    if (!input.value.trim()) {
      toast(T("コマンドを入力してください"));
      input.focus();
      return;
    }
    answerCurrent(input.value);
  });
  document.addEventListener("keydown", (e) => {
    if ($("viewDrill").hidden || !run) return;
    if (e.target.id === "typedInput") return;
    const it = run.current;
    if (run.answers[run.pos]) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        advance();
      }
      return;
    }
    if (it && it.q.c && /^[1-9a-dA-D]$/.test(e.key)) {
      const i = /[1-9]/.test(e.key) ? Number(e.key) - 1 : e.key.toLowerCase().charCodeAt(0) - 97;
      if (i >= 0 && i < it.order.length) {
        e.preventDefault();
        answerCurrent(i);
      }
    }
  });
  $("howtoBtn").onclick = $("howtoTop").onclick = () => {
    $("howtoModal").hidden = false;
  };
  $("searchBtn").onclick = openSearch;
  $("mRef").onclick = () => openRefQuick();
  document.addEventListener("keydown", (e) => {
    if (!$("editorModal").hidden) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      openSearch();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (
      e.key === "/" &&
      !typing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      ![...document.querySelectorAll(".modal-backdrop")].some((x) => !x.hidden)
    ) {
      e.preventDefault();
      openSearch();
    }
  });
  // The language: the text written in index.html, and the menu (a choice reloads the page with ?lang=, keeping the screen)
  IG.i18n.page(document.body);
  IG.wrap.start(); // natural line breaks in Japanese and Chinese, from here on (js/ui/wrap.js)
  $("langMenu").innerHTML = IG.i18n.menu();
  $("langMenu").addEventListener("click", (e) => {
    const a = e.target.closest("a[hreflang]");
    if (a) a.href = `?lang=${a.hreflang}${location.hash}`;
  });
  // Closed by a click elsewhere or Escape (back on its button), as on every site of the list
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#langMenu")) $("langMenu").open = false;
  });
  $("langMenu").addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !$("langMenu").open) return;
    $("langMenu").open = false;
    $("langMenu").querySelector("summary").focus();
  });
  IG.theme.button($("themeBtn"));
  // Served under a sub-path of a site list (e.g. /infra/ on this PC's front page)? Then offer the way back to it.
  if (/^https?:$/.test(location.protocol) && !/^\/(index\.html)?$/.test(location.pathname))
    $("portalLink").hidden = $("portalTab").hidden = false;
  $("dismissFirstRun").onclick = () => {
    progress.data.seenIntro = true;
    progress.save();
    $("firstRun").hidden = true;
  };
  $("firstRunHowto").onclick = () => {
    $("howtoModal").hidden = false;
  };
  // The home's dictionary preview: a search there opens the dictionary with it
  $("homeRefForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("homeRefQ").value.trim();
    location.hash = q ? `#/ref?q=${encodeURIComponent(q)}` : "#/ref";
  });
  // On-screen keys for touch screens: they act as the key would in the input (Tab completes, ↑ recalls…),
  // and keep the keyboard open (mousedown would move the focus off the input).
  $("termKeys").addEventListener("mousedown", (e) => e.preventDefault());
  $("termKeys").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const input = $("termInput");
    input.focus({ preventScroll: true });
    if (b.dataset.text) {
      input.setRangeText(b.dataset.text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: b.dataset.key,
          ctrlKey: "ctrl" in b.dataset,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
  // Backup of the progress: a JSON file to keep or to read on another device (merged, nothing lost)
  $("exportProgress").onclick = () => {
    const blob = new Blob([progress.export()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `corelab-progress-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(T("進捗を書き出しました（{file}）", { file: a.download }), true);
  };
  $("importProgress").onclick = () => $("importFile").click();
  $("importFile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const r = file.size > 2e6 ? { error: "format" } : progress.import(await file.text());
    if (r.error) {
      toast(T("読み込めませんでした。CoreLab で書き出した進捗ファイルを選んでください。"));
      return;
    }
    showHome();
    toast(T("進捗を読み込みました（クリア {n} 本 · {xp} XP）", { n: r.cleared, xp: r.xp }), true);
  };
  $("resetProgress").onclick = () => {
    if (confirm(T("すべての進捗（XP・★・バッジ）をリセットします。よろしいですか？"))) {
      progress.reset();
      showHome();
      toast(T("進捗をリセットしました"));
    }
  };
  $("resetMission").onclick = () => {
    if (session) {
      openMission(session.m.id, true);
      toast(T("環境を初期状態に戻しました"));
    }
  };
  $("showSolution").onclick = showSolution;
  $("termClear").onclick = () => {
    $("termOut").innerHTML = "";
    $("termInput").focus();
  };
  $("termMax").onclick = () => toggleMax();
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("tabEvents").hidden = b.dataset.tab !== "events";
      $("tabCheat").hidden = b.dataset.tab !== "cheat";
    }),
  );
  $("termOut").addEventListener("mouseup", () => {
    if (!String(window.getSelection())) $("termInput").focus();
  });
  $("termForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("termInput").value;
    $("termInput").value = "";
    submit(v);
  });
  $("termInput").addEventListener("input", (e) => {
    if (term.search) {
      term.search.q = e.target.value;
      searchUpdate();
    }
  });
  $("termInput").addEventListener("keydown", (e) => {
    const input = e.target;
    if (term.search) {
      const s = term.search;
      if (e.key === "Enter") {
        e.preventDefault();
        searchEnd(true);
        return;
      }
      if (
        e.key === "Escape" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "Tab" ||
        (e.ctrlKey && /^[cg]$/i.test(e.key))
      ) {
        e.preventDefault();
        searchEnd(false);
        return;
      }
      if (e.ctrlKey && /^r$/i.test(e.key)) {
        e.preventDefault();
        const hist = session.shell.history;
        const from = s.match ? hist.lastIndexOf(s.match) - 1 : hist.length - 1;
        for (let i = from; i >= 0; i--)
          if (hist[i].includes(s.q) && hist[i] !== s.match) {
            s.match = hist[i];
            break;
          }
        updatePrompt();
        return;
      }
      return;
    }
    if (e.ctrlKey && /^r$/i.test(e.key)) {
      e.preventDefault();
      if (session) {
        term.search = { q: "", match: "" };
        input.value = "";
        searchUpdate();
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (!session) return;
      const before = input.value;
      const r = session.shell.complete(before);
      input.value = r.line;
      if (r.options.length > 1 && (r.line === before || term.lastTab === before)) {
        printLine("cmd", "", `<span class="p">${esc(session.shell.prompt())}</span> ${esc(before)}`);
        printLine("opts", r.options.join("    "));
      }
      term.lastTab = r.line;
      return;
    }
    term.lastTab = "";
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (term.idx > 0) {
        term.idx--;
        input.value = term.history[term.idx];
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (term.idx < term.history.length - 1) {
        term.idx++;
        input.value = term.history[term.idx];
      } else {
        term.idx = term.history.length;
        input.value = "";
      }
      return;
    }
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      $("termOut").innerHTML = "";
      return;
    }
    if (e.ctrlKey && (e.key === "c" || e.key === "C") && input.selectionStart === input.selectionEnd) {
      e.preventDefault();
      printLine(
        "cmd",
        "",
        `<span class="p">${esc(term.pending !== null ? ">" : session.shell.prompt())}</span> ${esc(input.value)}^C`,
      );
      input.value = "";
      term.pending = null;
      updatePrompt();
      return;
    }
    if (e.key === "Escape") {
      if ($("terminal").classList.contains("max")) toggleMax(false);
      else input.value = "";
    }
  });

  const ta = $("editorText");
  ta.addEventListener("input", () => {
    setMode("INSERT");
    gutter();
  });
  ta.addEventListener("scroll", () => {
    $("editorGutter").scrollTop = ta.scrollTop;
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText("  ", s, ta.selectionEnd, "end");
      gutter();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveEditor(false);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setMode("NORMAL");
      $("vimForm").hidden = false;
      $("vimInput").value = "";
      $("vimInput").focus();
    }
  });
  $("vimForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const c = $("vimInput").value;
    $("vimForm").hidden = true;
    setMode("INSERT");
    runVim(c);
    if (!$("editorModal").hidden) ta.focus();
  });
  $("vimInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      $("vimForm").hidden = true;
      setMode("INSERT");
      ta.focus();
    }
  });
  $("editorSave").onclick = () => saveEditor(true);
  $("editorCancel").onclick = () => runVim("q!");
  $("editorClose").onclick = () => closeEditor(false);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".modal-backdrop")]
      .reverse()
      .find((m) => !m.hidden && m.id !== "editorModal");
    if (open) {
      open.hidden = true;
      if (!$("viewMission").hidden) $("termInput").focus();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (session && !session.completed && session.lines.length > 3 && !$("viewMission").hidden) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  route();
})((globalThis.IG = globalThis.IG || {}));
