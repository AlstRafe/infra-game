/* コマンド辞典の画面部品。#/ref のページと、どの画面からでも開ける検索（Ctrl+K）が同じものを使う。
 *
 *   const view = new IG.RefView(element, {
 *     modal: true,                 // the quick search: own back stack, a close button, no URL
 *     canInsert: () => bool,       // is there a terminal to type an example into?
 *     insert: cmd => …,            // type it there
 *     onState: (state, push) => …, // page only: mirror the state in the URL
 *     toast: msg => …, progress, unlockAll,
 *   });
 *   view.set({ q, topic, sel: { kind: 'c' | 't', id } });   view.focus(); */
(function (IG) {
  "use strict";
  const R = IG.cmdref;
  const esc = IG.util.escapeHtml;
  const T = IG.t;
  const trackOf = (id) => IG.tracks.find((t) => t.id === id) || { id, label: id, color: "#38d6c4" };
  const refToUrl = (ref) => String(ref).replace(/^#/, "e.");
  const EXAMPLES = [
    "ポートを使っているプロセス",
    "ディスクの空き",
    "ログをリアルタイムで見る",
    "tar",
    "kubectl logs",
    "Pod 再起動",
    "イメージ 脆弱性",
    "S3 バケット 公開",
  ].map((x) => T(x));

  class RefView {
    constructor(root, opts) {
      this.root = root;
      this.o = opts;
      this.s = { q: "", topic: "", cat: "", sel: null };
      this.stack = [];
      this.hits = [];
      root.classList.add("ref", opts.modal ? "ref-modal" : "ref-page");
      root.innerHTML = `
        <form class="ref-search" role="search">
          <span class="ref-glass" aria-hidden="true">⌕</span>
          <input type="search" class="ref-q" placeholder="${T("コマンド名 / やりたいこと（例: ポートを使っているプロセス）")}" aria-label="${T("コマンドを検索")}" autocomplete="off" spellcheck="false" enterkeyhint="search">
          ${opts.modal ? `<button type="button" class="icon-btn" data-close aria-label="${T("閉じる")}">×</button>` : ""}
        </form>
        <div class="ref-topics" role="group" aria-label="${T("分野で絞り込む")}"></div>
        <div class="ref-body"><div class="ref-list"></div><article class="ref-detail" tabindex="-1" aria-live="polite"></article></div>`;
      this.input = root.querySelector(".ref-q");
      this.list = root.querySelector(".ref-list");
      this.detail = root.querySelector(".ref-detail");
      let timer = null;
      this.input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.s.q = this.input.value;
          this.s.cat = "";
          this.s.sel = null;
          this.stack = [];
          this.render();
          this.sync(false);
        }, 90);
      });
      root.querySelector(".ref-search").addEventListener("submit", (e) => {
        e.preventDefault();
        clearTimeout(timer);
        this.s.q = this.input.value;
        this.s.sel = null;
        this.render();
        const first = this.list.querySelector("[data-open]");
        if (first) first.click();
      });
      root.addEventListener("keydown", (e) => this.keys(e));
      root.addEventListener("click", (e) => this.click(e));
    }
    get wide() {
      return !this.o.modal && typeof matchMedia === "function" && matchMedia("(min-width: 1000px)").matches;
    }
    set(st) {
      Object.assign(this.s, st);
      if (this.input.value !== this.s.q) this.input.value = this.s.q;
      this.render();
    }
    focus() {
      this.input.focus();
      this.input.select();
    }
    sync(push) {
      if (this.o.onState) this.o.onState(this.s, push);
    }
    open(kind, id) {
      if (this.o.modal) this.stack.push(this.s.sel);
      this.s.sel = { kind, id };
      this.render();
      this.sync(true);
      this.detail.scrollTop = 0;
      if (!this.o.modal) {
        const top = this.detail.getBoundingClientRect().top;
        if (top < 70) window.scrollTo(0, window.scrollY + top - 70);
      }
      this.detail.focus({ preventScroll: true });
    }
    back() {
      // the page: step back through the browser history when we put the entry there, otherwise to the results
      if (!this.o.modal && history.state && history.state.ref) {
        history.back();
        return;
      }
      this.s.sel = this.stack.pop() || null;
      this.render();
      this.sync(false);
      const cur = this.s.sel ? this.detail : this.list.querySelector(".active") || this.input;
      cur.focus({ preventScroll: true });
    }
    click(e) {
      const t = e.target;
      const op = t.closest("[data-open]");
      if (op) {
        const [kind, ...id] = op.dataset.open.split(":");
        this.open(kind, id.join(":"));
        return;
      }
      const tp = t.closest("[data-topic]");
      if (tp) {
        this.s.topic = this.s.topic === tp.dataset.topic ? "" : tp.dataset.topic;
        this.s.cat = "";
        this.render();
        return;
      }
      const cat = t.closest("[data-cat]");
      if (cat) {
        this.s.cat = cat.dataset.cat;
        this.s.sel = null;
        this.render();
        this.list.scrollTop = 0;
        return;
      }
      const q = t.closest("[data-q]");
      if (q) {
        this.set({ q: q.dataset.q, cat: "", sel: null });
        this.sync(false);
        return;
      }
      if (t.closest(".ref-back")) {
        this.back();
        return;
      }
      const ins = t.closest("[data-ref-insert]");
      if (ins) {
        this.o.insert(ins.dataset.refInsert);
        return;
      }
      const cp = t.closest("[data-ref-copy]");
      if (cp)
        copy(cp.dataset.refCopy).then(
          () => this.o.toast(T("コピーしました")),
          () => this.o.toast(T("コピーできませんでした")),
        );
    }
    // ↓ from the search box into the results, ↑↓ between them, Backspace / ← back from an entry
    keys(e) {
      const items = [...this.list.querySelectorAll("[data-open]")];
      if (e.target === this.input && e.key === "ArrowDown" && items.length) {
        e.preventDefault();
        items[0].focus();
        return;
      }
      const i = items.indexOf(e.target);
      if (i >= 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const n = i + (e.key === "ArrowDown" ? 1 : -1);
        (n < 0 ? this.input : items[Math.min(n, items.length - 1)]).focus();
        return;
      }
      if (this.s.sel && e.target === this.detail && (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft"))) {
        e.preventDefault();
        this.back();
      }
    }

    /* ---------------------------------------------------------- rendering */
    render() {
      this.root.querySelector(".ref-topics").innerHTML =
        `<button type="button" data-topic="" aria-pressed="${!this.s.topic}">${T("すべて")}</button>` +
        R.topics
          .map((id) => {
            const t = trackOf(id);
            return `<button type="button" data-topic="${id}" aria-pressed="${this.s.topic === id}" style="--tc:${t.color}">${esc(t.label)}</button>`;
          })
          .join("");
      this.renderList();
      const sel =
        this.s.sel ||
        (this.wide && this.hits[0]
          ? {
              kind: this.hits[0].kind === "task" ? "t" : "c",
              id: this.hits[0].kind === "task" ? this.hits[0].item.id : this.hits[0].item.name,
            }
          : null);
      this.root.classList.toggle("has-sel", !!this.s.sel);
      this.detail.innerHTML = !sel
        ? this.guide()
        : sel.kind === "t"
          ? this.taskHtml(R.task(sel.id))
          : this.cmdHtml(R.get(sel.id));
      const key = sel ? `${sel.kind}:${sel.id}` : "";
      for (const b of this.list.querySelectorAll("[data-open]")) b.classList.toggle("active", b.dataset.open === key);
    }
    renderList() {
      const q = this.s.q.trim();
      this.hits = [];
      if (!q) {
        this.list.innerHTML = this.s.cat ? this.catList() : this.browse();
        return;
      }
      this.hits = R.search(q, { topic: this.s.topic || undefined, limit: 40 });
      if (!this.hits.length) {
        const elsewhere = this.s.topic ? R.search(q, { limit: 40 }).length : 0;
        this.list.innerHTML = `<div class="ref-empty"><p>${T("「{q}」に当てはまるものが見つかりませんでした。", { q: esc(q) })}</p>
          ${elsewhere ? `<p><button type="button" class="btn ghost small" data-topic="${this.s.topic}">${T("すべての分野で探す（{n} 件）", { n: elsewhere })}</button></p>` : ""}
          <p class="muted">${T("言い換えると見つかることがあります（例:「消したい」→「削除」、「重い」→「CPU」「負荷」）。コマンド名の一部でも探せます。")}</p></div>`;
        return;
      }
      const n = { task: 0, cmd: 0 };
      for (const h of this.hits) n[h.kind]++;
      this.list.innerHTML = `<p class="ref-count">${n.task ? T("レシピ {n}", { n: n.task }) : ""}${n.task && n.cmd ? " · " : ""}${n.cmd ? T("コマンド {n}", { n: n.cmd }) : ""}</p>
        <ul class="ref-items">${this.hits.map((h) => this.item(h.kind, h.item)).join("")}</ul>`;
    }
    item(kind, it) {
      if (kind === "task") {
        return `<li><button type="button" class="ref-item task" data-open="t:${it.id}"><span class="ref-kind">${T("レシピ")}</span>
          <strong>${esc(it.q)}</strong><small><code>${esc(it.do[0][0])}</code>${it.do.length > 1 ? T(" ほか {n} 手順", { n: it.do.length - 1 }) : ""}</small></button></li>`;
      }
      const e = R.get(it.name),
        t = trackOf(e.topic);
      return `<li><button type="button" class="ref-item" data-open="c:${esc(e.name)}" style="--tc:${t.color}"><span class="ref-kind">${esc(t.label)}</span>
        <strong><code>${esc(e.name)}</code>${e.nosim ? `<em class="ref-tag">${T("実機のみ")}</em>` : ""}</strong><small>${esc(R.lead(e.ja))}</small></button></li>`;
    }
    browse() {
      const topics = this.s.topic ? [this.s.topic] : R.topics;
      const picks = topics.flatMap((id) => R.tasks.filter((t) => t.topic === id).slice(0, this.s.topic ? 8 : 2));
      return `<h3 class="ref-h">${T("よく使うレシピ")}</h3><ul class="ref-items">${picks.map((t) => this.item("task", t)).join("")}</ul>
        <h3 class="ref-h">${T("分類から探す")}</h3>
        ${topics
          .map((id) => {
            const t = trackOf(id);
            return `<div class="ref-cats" style="--tc:${t.color}"><span class="ref-cats-name">${esc(t.label)}</span>${Object.entries(
              R.cats[id] || {},
            )
              .map(([c, name]) => {
                const n = R.inCat(id, c).length;
                return n ? `<button type="button" data-cat="${id}:${c}">${esc(name)} <b>${n}</b></button>` : "";
              })
              .join("")}</div>`;
          })
          .join("")}`;
    }
    catList() {
      const [topic, cat] = this.s.cat.split(":");
      const list = R.inCat(topic, cat).sort((a, b) => a.name.localeCompare(b.name));
      return `<p class="ref-count"><button type="button" class="link-btn" data-q="">← ${T("分類一覧")}</button> ${esc(trackOf(topic).label)} › ${esc(R.catName(topic, cat))}（${list.length}）</p>
        <ul class="ref-items">${list.map((e) => this.item("cmd", e)).join("")}</ul>`;
    }
    guide() {
      return `<div class="ref-guide">
        <h2>${T("コマンド辞典")}</h2>
        <p>${T("{cmds} のコマンドと {tasks} の「やりたいこと別レシピ」を収録。コマンド名でも、日本語の「やりたいこと」でも探せます。", { cmds: R.entries.filter((e) => !e.same).length, tasks: R.tasks.length })}</p>
        <h3>${T("例えば")}</h3>
        <div class="ref-chips">${EXAMPLES.map((q) => `<button type="button" class="ref-chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <h3>${T("ターミナルからも")}</h3>
        <dl class="ref-opts"><dt><code>${T("apropos ポート 使用中")}</code></dt><dd>${T("やりたいことからコマンドを探す（<code>man -k</code> も同じ）")}</dd>
          <dt><code>man ss</code> / <code>ss --help</code></dt><dd>${T("使い方・使用例・関連コマンド・公式ドキュメント")}</dd>
          <dt><code>whatis lsof</code></dt><dd>${T("一行説明")}</dd></dl>
        <p class="muted">${T(this.o.modal ? "<kbd>↑</kbd><kbd>↓</kbd> で選んで <kbd>Enter</kbd>、<kbd>Esc</kbd> で閉じる。" : "どの画面でも <kbd>Ctrl</kbd>+<kbd>K</kbd>（または <kbd>/</kbd>）でこの検索を開けます。ミッション中でも環境はそのままです。")}</p>
      </div>`;
    }
    backBtn() {
      return this.s.sel ? `<button type="button" class="ref-back link-btn">← ${T("戻る")}</button>` : "";
    }
    cmdline(c, runnable, real) {
      return `<div class="ref-cmdline"><code>${esc(c)}</code><span class="ref-acts">${real ? `<em class="ref-tag" title="${T("この書き方はゲームのターミナルでは動きません")}">${T("実機のみ")}</em>` : ""}${runnable && this.o.canInsert() ? `<button type="button" class="btn small" data-ref-insert="${esc(c)}" title="${T("ターミナルに入力（Enter で実行）")}">${T("入力")}</button>` : ""}<button type="button" class="btn ghost small" data-ref-copy="${esc(c)}">${T("コピー")}</button></span></div>`;
    }
    chips(names) {
      return `<div class="ref-chips">${names
        .map((n) => {
          const x = R.get(n);
          return x
            ? `<button type="button" class="ref-chip${x.nosim ? " nosim" : ""}" data-open="c:${esc(n)}" title="${esc(R.lead(x.ja))}"><code>${esc(n)}</code></button>`
            : "";
        })
        .join("")}</div>`;
    }
    links(title, rows) {
      return rows.length ? `<section><h3>${title}</h3><ul class="ref-links">${rows.join("")}</ul></section>` : "";
    }
    cmdHtml(e) {
      if (!e) return `<div class="ref-guide">${this.backBtn()}<p>${T("この項目は見つかりませんでした。")}</p></div>`;
      const base = e.alias ? R.byName[e.alias] : e;
      const t = trackOf(e.topic),
        rel = R.related(base);
      const opts = IG.manpages && IG.manpages.opts(e.name);
      const unit = (ref) => {
        const u = IG.drillUnit(ref);
        if (!u.unit) return "";
        const tr = trackOf(u.topic);
        return `<li><a href="#/drill/${u.topic}/${refToUrl(ref.split(":")[1])}"><span class="ref-kind" style="--tc:${tr.color}">${esc(tr.label)}</span>${esc(IG.unitName(u.unit))}</a></li>`;
      };
      const mission = (id) => {
        const m = IG.mission(id);
        if (!m) return "";
        const open = !this.o.progress || this.o.progress.unlocked(m, this.o.unlockAll);
        return open
          ? `<li><a href="#/play/${m.id}"><span class="ref-kind" style="--tc:${trackOf(m.track).color}">${esc(trackOf(m.track).label)}</span>${esc(m.title)}</a></li>`
          : `<li class="locked"><span>🔒 ${esc(m.title)}</span></li>`;
      };
      const term =
        e.topic === "basics"
          ? `<code>man ${esc(e.name)}</code> / <code>${esc(e.name)} --help</code>`
          : `<code>${esc(e.name)} --help</code>`;
      return `<header class="ref-dh" style="--tc:${t.color}">${this.backBtn()}
          <p class="ref-meta"><span class="track-chip" style="--tc:${t.color}">${esc(t.label)}</span><span>${esc(R.catName(e.topic, base.cat))}</span></p>
          <h2><code>${esc(e.name)}</code>${e.topic === "basics" ? `<small>(${base.s})</small>` : ""}</h2>
          <p class="ref-ja">${esc(e.ja)}</p>
          <p class="ref-en" lang="en">${esc(e.en)}</p>
          <p class="ref-badges">${e.nosim ? `<span class="ref-tag warn">${T("ゲームのターミナルでは未対応（実務の知識として収録）")}</span>` : `<span class="ref-tag ok">${T("ゲームのターミナルで試せます")}</span>`}${base.builtin ? `<span class="ref-tag">${T("シェル組み込み")}</span>` : ""}${e.alias ? `<span class="ref-tag"><button type="button" class="link-btn" data-open="c:${esc(e.alias)}">${T("{name} の別名", { name: `${esc(e.alias)}</button>` })}</span>` : ""}</p>
        </header>
        <section><h3>${T("書式")}</h3><pre class="ref-syn">${esc(base.syn)}</pre></section>
        ${base.ex.length ? `<section><h3>${T("使用例")}</h3><ul class="ref-ex">${base.ex.map(([c, n, real]) => `<li>${this.cmdline(c, !e.nosim && !real && R.runnable(c), real)}<span>${esc(n)}</span></li>`).join("")}</ul></section>` : ""}
        ${opts && opts.length ? `<section><h3>${T("主なオプション")}</h3><dl class="ref-opts">${opts.map(([o, d]) => `<dt><code>${esc(o)}</code></dt><dd lang="en">${esc(d)}</dd>`).join("")}</dl></section>` : ""}
        ${rel.own.length ? `<section><h3>${T("関連コマンド")}</h3>${this.chips(rel.own)}</section>` : ""}
        ${rel.co.length ? `<section><h3>${T("一緒に使われる")}</h3>${this.chips(rel.co)}</section>` : ""}
        ${this.links(
          T("このコマンドを使うレシピ"),
          R.tasksFor(base).map(
            (x) => `<li><button type="button" class="link-row" data-open="t:${x.id}">${esc(x.q)}</button></li>`,
          ),
        )}
        ${this.links(T("学習問題で練習"), R.drillsFor(base).slice(0, 6).map(unit))}
        ${this.links(T("このコマンドが活躍するミッション"), R.missionsFor(base).slice(0, 6).map(mission))}
        ${rel.same.length ? `<section><h3>${T("同じ分類（{cat}）", { cat: esc(R.catName(e.topic, base.cat)) })}</h3>${this.chips(rel.same)}</section>` : ""}
        <footer class="ref-foot">${base.doc ? `<a class="btn ghost small" href="${esc(base.doc)}" target="_blank" rel="noopener noreferrer">${T("公式ドキュメント")} ↗</a>` : ""}${e.nosim ? "" : `<span>${T("ターミナルで {cmd}", { cmd: term })}</span>`}</footer>`;
    }
    taskHtml(t) {
      if (!t) return `<div class="ref-guide">${this.backBtn()}<p>${T("このレシピは見つかりませんでした。")}</p></div>`;
      const tr = trackOf(t.topic);
      const similar = R.similarTasks(t);
      return `<header class="ref-dh" style="--tc:${tr.color}">${this.backBtn()}
          <p class="ref-meta"><span class="track-chip" style="--tc:${tr.color}">${esc(tr.label)}</span><span>${T("やりたいこと別レシピ")}</span></p>
          <h2>${esc(t.q)}</h2>
        </header>
        <section><h3>${T("手順")}</h3><ol class="ref-ex ref-steps">${t.do.map(([c, n, real]) => `<li>${this.cmdline(c, !real && R.runnable(c), real)}<span>${esc(n)}</span></li>`).join("")}</ol></section>
        ${t.note ? `<p class="ref-note">${esc(t.note)}</p>` : ""}
        <section><h3>${T("使うコマンド")}</h3>${this.chips(R.taskCmds(t))}</section>
        ${this.links(
          T("関連するレシピ"),
          similar.map(
            (x) => `<li><button type="button" class="link-row" data-open="t:${x.id}">${esc(x.q)}</button></li>`,
          ),
        )}
        ${t.do.some(([c]) => /<[^>]+>/.test(c)) ? `<p class="muted small-print">${T("&lt;pod&gt; のような部分は自分の環境の名前に置き換えて使います。")}</p>` : ""}`;
    }
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((ok, ng) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      try {
        document.execCommand("copy") ? ok() : ng();
      } catch (err) {
        ng(err);
      } finally {
        ta.remove();
      }
    });
  }
  IG.RefView = RefView;
})((globalThis.IG = globalThis.IG || {}));
