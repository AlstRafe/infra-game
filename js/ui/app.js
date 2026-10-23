/* CoreLab UI controller: routing, home map, mission screen, terminal, editor, modals. */
(function (IG) {
  'use strict';
  const U = IG.util;
  const $ = id => document.getElementById(id);
  const esc = U.escapeHtml;

  let storage = null;
  try { storage = window.localStorage; storage.getItem('probe'); } catch (e) { storage = null; }
  const progress = new IG.Progress(storage);
  const unlockAll = /[?&]unlock=all\b/.test(location.search);
  let homeView = null, missionView = null, session = null, tick = null, toastTimer = null;
  const term = { history: [], idx: 0, lastTab: '' };
  const editor = { path: null, host: null, original: '', onSave: null, readonly: false };

  /* ------------------------------------------------------------ helpers */
  function toast(msg, good) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('good', !!good);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }
  const trackOf = id => IG.tracks.find(t => t.id === id);
  const fmtTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const starText = (n, total = 3) => '<span>★</span>'.repeat(n) + '<span class="empty">★</span>'.repeat(total - n);
  function inlineCode(text) { return esc(text).replace(/`([^`]+)`/g, (_, c) => `<code data-cmd="${c.replace(/"/g, '&quot;')}" title="クリックでターミナルに入力">${c}</code>`); }
  function nextMission() {
    for (const t of IG.tracks) for (const m of IG.missionsOf(t.id)) if (!progress.cleared(m.id) && progress.unlocked(m, unlockAll)) return m;
    return null;
  }
  function setNav(which) { document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === which)); }

  /* ------------------------------------------------------------ profile */
  function renderProfile() {
    const r = progress.rank();
    $('rankBadge').innerHTML = `<span>Lv${r.idx + 1}</span>`;
    $('rankBadge').style.setProperty('--pct', r.pct + '%');
    $('rankName').textContent = r.cur.name;
    $('xpFill').style.width = r.pct + '%';
    $('xpText').textContent = r.next ? `${progress.data.xp} / ${r.next.xp} XP` : `${progress.data.xp} XP · MAX`;
    $('profileChip').title = r.next ? `次のランク「${r.next.name}」まで ${r.next.xp - progress.data.xp} XP` : '最高ランク到達';
  }

  /* ------------------------------------------------------------ home */
  function showHome() {
    stopMission();
    $('viewMission').hidden = true;
    $('viewHome').hidden = false;
    document.title = 'CoreLab — インフラ運用トレーニング';
    setNav('home');
    renderProfile();
    renderTracks();
    renderSide();
    const all = IG.missions.filter(m => !m.sandbox);
    $('statClear').textContent = `${all.filter(m => progress.cleared(m.id)).length}/${all.length}`;
    $('statStars').textContent = all.reduce((n, m) => n + progress.stars(m.id), 0);
    $('statBadges').textContent = `${progress.data.badges.length}/${Object.keys(IG.badges).length}`;
    const nx = nextMission();
    const btn = $('continueBtn');
    const anyClear = all.some(m => progress.cleared(m.id));
    btn.textContent = nx ? `▶ ${anyClear ? '続きから' : 'はじめる'}: ${nx.title}` : '▶ フリーラボへ';
    btn.onclick = () => { location.hash = nx ? `#/play/${nx.id}` : '#/play/sandbox'; };
    $('firstRun').hidden = !!progress.data.seenIntro || anyClear;
    if (!homeView) {
      homeView = new IG.DC.View($('dcHome'), {
        padLeft: w => (w > 900 ? Math.min(470, w * 0.46) : 0),
        rackLabels: false,
        onHover: h => homeTip(h),
        onClick: r => { if (r.mission) { const m = IG.mission(r.mission); if (progress.unlocked(m, unlockAll)) location.hash = `#/play/${m.id}`; else toast('🔒 前のミッションをクリアすると解放されます'); } },
      });
    }
    homeView.setScene(IG.DC.sceneFromProgress(progress, unlockAll));
    requestAnimationFrame(() => homeView.resize());
  }
  function homeTip(h) {
    const tip = $('homeTip');
    if (!h) { tip.hidden = true; return; }
    const box = $('viewHome').querySelector('.hero').getBoundingClientRect();
    tip.innerHTML = `<strong>${esc(h.rack.title || h.rack.label)}</strong>${h.rack.info ? `<ul>${h.rack.info.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
    tip.hidden = false;
    tip.style.left = Math.min(h.x - box.left + 14, box.width - 310) + 'px';
    tip.style.top = Math.min(h.y - box.top + 14, box.height - 90) + 'px';
  }
  function renderTracks() {
    const nx = nextMission();
    $('trackList').innerHTML = IG.tracks.map(t => {
      const ms = IG.missionsOf(t.id);
      const done = ms.filter(m => progress.cleared(m.id)).length;
      return `<article class="track" style="--tc:${t.color}">
        <header class="track-head"><span class="track-icon" aria-hidden="true">${t.icon}</span><div><h2>${esc(t.name)}</h2><p>${esc(t.blurb)}</p></div><span class="track-count">${done}/${ms.length}</span></header>
        <ol class="mission-list">${ms.map((m, i) => {
          const st = progress.stars(m.id), open = progress.unlocked(m, unlockAll);
          const cls = [st ? 'cleared' : '', nx && nx.id === m.id ? 'next' : ''].join(' ');
          return `<li><button class="mission-row ${cls}" data-play="${m.id}" ${open ? '' : 'disabled'} aria-label="${esc(m.title)}${open ? '' : '（ロック中）'}">
            <span class="num">${open ? i + 1 : '🔒'}</span>
            <span><strong>${esc(m.title)}</strong><small>${esc(m.summary)}</small></span>
            <span class="meta"><span class="stars" aria-label="★${st}">${starText(st)}</span><span class="diff">難易度 ${'●'.repeat(m.difficulty)}${'○'.repeat(3 - m.difficulty)}</span></span>
          </button></li>`;
        }).join('')}</ol></article>`;
    }).join('');
  }
  function renderSide() {
    const r = progress.rank();
    $('rankLadder').innerHTML = IG.ranks.map((k, i) => `<li class="${i < r.idx ? 'reached' : ''} ${i === r.idx ? 'current' : ''}"><span>${esc(k.name)}</span><span>${k.xp} XP</span></li>`).join('');
    $('badgeList').innerHTML = Object.entries(IG.badges).map(([id, b]) => `<span class="badge ${progress.data.badges.includes(id) ? 'got' : ''}" title="${esc(b.name)}: ${esc(b.desc)}" aria-label="${esc(b.name)}">${b.icon}</span>`).join('');
  }

  /* ------------------------------------------------------------ mission */
  function stopMission() {
    clearInterval(tick); tick = null;
    $('missionTip').hidden = true;
    if ($('terminal').classList.contains('max')) toggleMax(false);
  }
  function openMission(id) {
    const m = IG.mission(id);
    if (!m) { location.hash = '#/'; return; }
    if (!m.sandbox && !progress.unlocked(m, unlockAll)) { toast('🔒 このミッションはまだロックされています'); location.hash = '#/'; return; }
    stopMission();
    closeAllModals();
    if (!progress.data.seenIntro) { progress.data.seenIntro = true; progress.save(); }
    IG.clock.offset = 0;
    session = new IG.Session(m);
    $('viewHome').hidden = true;
    $('viewMission').hidden = false;
    setNav(m.sandbox ? 'sandbox' : 'home');
    document.title = `${m.title} — CoreLab`;
    renderProfile();
    const t = trackOf(m.track) || { name: 'FREE LAB', color: '#38d6c4' };
    const chip = $('mTrack');
    chip.textContent = t.name;
    chip.style.setProperty('--tc', t.color);
    $('mTitle').textContent = m.title;
    $('mStory').innerHTML = m.story.map(p => `<p>${inlineCode(p)}</p>`).join('');
    $('storyBox').open = true;
    $('sandboxNote').hidden = !m.sandbox;
    $('mStars').hidden = !!m.sandbox;
    $('showSolution').hidden = !!m.sandbox;
    renderObjectives();
    renderCheat();
    $('eventList').innerHTML = '';
    session.world.listeners.push(e => addEvent(e.msg, e.level));
    addEvent(m.sandbox ? 'フリーラボを起動しました' : `ミッション開始: ${m.title}`, 'INFO');
    $('termOut').innerHTML = '';
    printLine('sys', 'CoreLab 訓練シェルに接続しました（すべてブラウザ内のシミュレーションです）');
    printLine('sys', m.sandbox ? 'help でコマンド一覧。README.md に例があります。' : 'help でコマンド一覧 · Tab で補完 · 左の「目標」を達成するとクリアです');
    term.history = []; term.idx = 0;
    updatePrompt();
    if (!missionView) missionView = new IG.DC.View($('dcMission'), { compact: true, onHover: h => missionTip(h) });
    missionView.setScene(IG.DC.sceneFromWorld(session.world));
    requestAnimationFrame(() => missionView.resize());
    tick = setInterval(onTick, 500);
    onTick();
    $('termInput').value = '';
    if (document.activeElement && window.innerWidth <= 820) document.activeElement.blur();
    window.scrollTo(0, 0);
    requestAnimationFrame(() => window.scrollTo(0, 0));
    if (window.innerWidth > 820) setTimeout(() => $('termInput').focus({ preventScroll: true }), 50);
  }
  function onTick() {
    if (!session) return;
    const el = session.elapsed();
    $('mTimer').textContent = fmtTime(el);
    $('mHints').textContent = session.hintsUsed;
    if (!session.m.sandbox) {
      const r = session.result;
      let stars = r ? r.stars : 3 - (session.hintsUsed > 0 ? 1 : 0) - (session.hintsUsed > 2 || el > session.m.par ? 1 : 0);
      if (session.gaveUp) stars = 0;
      $('mStars').innerHTML = starText(Math.max(session.gaveUp ? 0 : 1, stars));
      $('mStars').title = `目標時間 ${fmtTime(session.m.par)} · ヒントを使うと★が減ります`;
    }
    missionView && missionView.setScene(IG.DC.sceneFromWorld(session.world));
  }
  function renderObjectives() {
    const m = session.m;
    $('mProgress').textContent = `${session.done.filter(Boolean).length}/${m.objectives.length}`;
    $('mObjectives').innerHTML = m.objectives.map((o, i) => {
      const shown = o.hints.slice(0, session.hintsShown[i]);
      const left = o.hints.length - session.hintsShown[i];
      return `<li class="obj ${session.done[i] ? 'done' : ''}" id="obj${i}">
        <div class="obj-head"><span class="obj-check">${session.done[i] ? '✓' : i + 1}</span><div><strong>${esc(o.title)}</strong><small>${esc(o.detail)}</small></div></div>
        <div class="obj-hints">${shown.map(h => `<div class="hint">💡 ${inlineCode(h)}</div>`).join('')}
        ${left > 0 && !session.done[i] ? `<button class="hint-btn" data-hint="${i}" title="ヒントを見ると評価の★が減ります">ヒントを見る（残り ${left}）</button>` : ''}</div></li>`;
    }).join('');
  }
  function renderCheat() {
    const f = session.world.features;
    const groups = [['Linux', [['ls -l', '詳細付き一覧'], ['cat <file>', '中身を表示'], ['grep -n <pat> <file>', '一致行を行番号付きで'], ['tail -n 20 <file>', '末尾 20 行'], ['vi <file>', 'ファイルを編集（:wq で保存）'], ['df -h / du -sh *', 'ディスク使用量'], ['sudo <cmd>', '管理者権限で実行']]]];
    if (f.has('docker')) groups.push(['Docker', [['docker ps -a', '全コンテナ'], ['docker logs <name>', 'ログ'], ['docker run -d --name n -p 8080:80 <img>', '起動'], ['docker build -t name:tag .', 'ビルド'], ['docker compose ps -a', 'Compose の状態'], ['docker compose up -d', 'Compose 起動・更新']]]);
    if (f.has('harbor')) groups.push(['Harbor', [['docker login harbor.lab.local -u <user> -p <pw>', 'レジストリ認証'], ['harbor project list', 'プロジェクト一覧'], ['harbor artifact list <p>/<r>', 'タグとスキャン結果'], ['harbor artifact vulnerabilities <p>/<r>:<t>', '脆弱性一覧'], ['harbor robot create <n> --project <p>', 'robot 作成']]]);
    if (f.has('k8s') || f.has('ocp') || f.has('aws')) groups.push(['Kubernetes', [['kubectl get pods -o wide', 'Pod とノード'], ['kubectl describe pod <pod>', '詳細と Events'], ['kubectl logs <pod>', 'ログ'], ['kubectl get events', '最近の出来事'], ['kubectl apply -f <file>', 'マニフェスト反映'], ['kubectl rollout status deploy/<n>', 'ロールアウト確認'], ['kubectl exec deploy/<n> -- curl -s <url>', 'Pod 内から通信確認']]]);
    if (f.has('ocp')) groups.push(['OpenShift', [['oc login <api> -u <user> -p <pw>', 'ログイン'], ['oc new-project <name>', 'プロジェクト作成'], ['oc new-app <image> --name=<n>', 'アプリ作成'], ['oc expose service/<n>', 'Route 作成'], ['oc get route', '公開 URL']]]);
    if (f.has('aws')) groups.push(['AWS', [['aws sts get-caller-identity', '自分は誰？'], ['aws ec2 describe-instances', 'EC2 一覧'], ['aws ec2 describe-security-groups', 'SG ルール'], ['aws s3 ls', 'バケット一覧'], ['aws eks update-kubeconfig --name <n>', 'EKS 接続']]]);
    $('tabCheat').innerHTML = `<div class="cheat">${groups.map(([h, rows]) => `<h3>${h}</h3><dl>${rows.map(([c, d]) => `<dt data-cmd="${esc(c)}" title="クリックで入力">${esc(c)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>`).join('')}</div>`;
  }
  function addEvent(msg, level) {
    const li = document.createElement('li');
    li.className = level;
    const t = document.createElement('time');
    t.textContent = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    const s = document.createElement('span');
    s.textContent = msg;
    li.append(t, s);
    const list = $('eventList');
    list.prepend(li);
    while (list.children.length > 80) list.lastChild.remove();
  }
  function missionTip(h) {
    const tip = $('missionTip');
    if (!h) { tip.hidden = true; return; }
    tip.innerHTML = `<strong>${esc(h.rack.label)}</strong>${h.zone ? `<small style="color:var(--dim)">${esc(h.zone.label)}</small>` : ''}${h.rack.info && h.rack.info.length ? `<ul>${h.rack.info.slice(0, 12).map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
    tip.hidden = false;
    tip.style.left = Math.min(h.x + 14, window.innerWidth - 320) + 'px';
    tip.style.top = Math.min(h.y + 14, window.innerHeight - 160) + 'px';
  }

  /* ------------------------------------------------------------ terminal */
  const HL = /(\b(?:CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|NotReady|FailedScheduling|Unauthorized|Forbidden|NXDOMAIN|AccessDenied)\b|\bExited \(\d+\)|\b(?:Error|ERROR|Failed|failed|FAILURE)\b)|(\b(?:Pending|ContainerCreating|Terminating|SchedulingDisabled|Warning|WARN|WARNING!?|DiskPressure)\b)|(\b(?:Running|Completed|Succeeded|Login Succeeded|Login successful|successfully rolled out|ACTIVE|healthy)\b|\bUp \d+ \w+)/g;
  function highlight(text) {
    return text.split('\n').map(line => {
      const e = esc(line);
      if (/^ℹ/.test(line)) return `<span class="s-info">${e}</span>`;
      if (/^\s*#/.test(line)) return `<span class="s-dim">${e}</span>`;
      return e.replace(HL, (m, bad, warn, good) => `<span class="${bad ? 's-bad' : warn ? 's-warn' : 's-ok'}">${m}</span>`);
    }).join('\n');
  }
  function printLine(cls, text, raw) {
    const out = $('termOut');
    const div = document.createElement('div');
    div.className = cls;
    if (raw) div.innerHTML = raw; else if (cls === 'out' || cls === 'err') div.innerHTML = highlight(text); else div.textContent = text;
    out.appendChild(div);
    while (out.children.length > 600) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  }
  function updatePrompt() {
    const p = session.shell.prompt();
    $('termPrompt').textContent = p;
    $('termTitle').textContent = p.replace(/[$#]$/, '').replace(/:.*$/, '');
  }
  function submit(line) {
    if (!session) return;
    const p = session.shell.prompt();
    printLine('cmd', '', `<span class="p">${esc(p)}</span> ${esc(line)}`);
    if (line.trim()) { term.history.push(line); }
    term.idx = term.history.length;
    const before = session.completed;
    const r = session.run(line);
    if (r.res.clear) $('termOut').innerHTML = '';
    if (r.res.out) printLine(r.res.err ? 'err' : 'out', r.res.out);
    updatePrompt();
    handleProgress(r.newly, before);
    if (r.res.editor) openEditor(r.res.editor);
    onTick();
  }
  function handleProgress(newly, wasComplete) {
    let done = false;
    for (const i of newly) {
      if (i === 'complete') { done = true; continue; }
      const o = session.m.objectives[i];
      printLine('win', `✔ 目標達成: ${o.title}`);
      addEvent(`目標達成: ${o.title}`, 'GOAL');
      toast(`✔ 目標達成: ${o.title}`, true);
    }
    if (newly.length) {
      renderObjectives();
      newly.filter(i => i !== 'complete').forEach(i => { const el = $('obj' + i); if (el) el.classList.add('flash'); });
    }
    if (done && !wasComplete) setTimeout(showResult, 900);
  }
  function toggleMax(force) {
    const t = $('terminal');
    const on = force === undefined ? !t.classList.contains('max') : force;
    t.classList.toggle('max', on);
    $('termMax').textContent = on ? '⤡' : '⛶';
    $('termMax').title = on ? '元に戻す (Esc)' : 'ターミナルを最大化';
    $('termOut').scrollTop = $('termOut').scrollHeight;
    $('termInput').focus();
  }
  function insertCommand(cmd) {
    if ($('viewMission').hidden) return;
    const input = $('termInput');
    input.value = cmd;
    input.focus();
    input.setSelectionRange(cmd.length, cmd.length);
  }

  /* ------------------------------------------------------------ editor */
  function openEditor(req) {
    const host = session.world.hosts[req.host || session.shell.host.name];
    editor.path = req.path; editor.host = host; editor.onSave = req.onSave || null; editor.readonly = !!req.readonly;
    editor.original = (host.vfs.read(req.path) ?? '');
    const ta = $('editorText');
    ta.value = editor.original;
    const home = host.home;
    $('editorTitle').textContent = (req.path.startsWith(home) ? '~' + req.path.slice(home.length) : req.path) + (host.vfs.exists(req.path) ? '' : ' [新規]') + (editor.readonly ? ' [読み取り専用]' : '');
    setMode('INSERT');
    $('vimForm').hidden = true;
    $('editorModal').hidden = false;
    gutter();
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }
  function setMode(m) { $('editorMode').textContent = m; }
  function gutter() {
    const n = $('editorText').value.split('\n').length;
    $('editorGutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    $('editorGutter').scrollTop = $('editorText').scrollTop;
    const dirty = $('editorText').value !== editor.original;
    $('editorStatus').textContent = dirty ? '● 未保存の変更があります — Esc → :wq で保存して終了 / :q! で破棄' : 'Esc → :wq で保存して終了 / :q! で破棄 / Ctrl+S で保存';
  }
  function saveEditor(close) {
    const text = $('editorText').value;
    if (editor.readonly) { toast('E45: 読み取り専用です。システムファイルは sudo vi <file> で開いてください'); return false; }
    try { editor.host.vfs.write(editor.path, text); } catch (e) { toast('E212: 書き込みできません（ディレクトリが存在しない）'); return false; }
    editor.original = text;
    gutter();
    if (editor.onSave) {
      const r = editor.onSave(text);
      if (r && r.out) printLine(r.err ? 'err' : 'out', r.out);
      if (r && r.err) { toast('適用に失敗しました（ターミナルを確認）'); }
    } else toast(`"${IG.VFS.base(editor.path)}" ${text.split('\n').length}L written`);
    session.world.reconcile();
    const before = session.completed;
    handleProgress(session.evaluate(), before);
    if (close) closeEditor(true);
    return true;
  }
  function closeEditor(force) {
    if (!force && $('editorText').value !== editor.original) { toast('E37: 変更が保存されていません（:wq で保存 / :q! で破棄）'); return; }
    $('editorModal').hidden = true;
    if (editor.onSave && force !== 'saved' && $('editorText').value === editor.original && !editor.savedOnce) { /* kubectl edit cancelled */ }
    editor.onSave = null;
    $('termInput').focus();
  }
  function runVim(cmd) {
    const c = cmd.trim().replace(/^:/, '');
    if (c === 'w') return saveEditor(false);
    if (c === 'wq' || c === 'x' || c === 'wq!') return saveEditor(true);
    if (c === 'q') return closeEditor(false);
    if (c === 'q!') { $('editorText').value = editor.original; if (editor.onSave) printLine('out', 'Edit cancelled, no changes made.'); return closeEditor(true); }
    if (/^\d+$/.test(c)) { const ta = $('editorText'); const lines = ta.value.split('\n'); const pos = lines.slice(0, Number(c) - 1).join('\n').length + (Number(c) > 1 ? 1 : 0); ta.focus(); ta.setSelectionRange(pos, pos); return; }
    toast(`E492: エディタのコマンドではありません: ${c}`);
  }

  /* ------------------------------------------------------------ result / solution */
  function showResult() {
    const m = session.m, r = session.result;
    if (!r) return;
    const rec = session.gaveUp ? { gain: 0, newBadges: [], rankUp: null } : progress.record(m, r);
    $('resultTitle').textContent = session.gaveUp ? '復旧完了（解答参照）' : ['', '復旧完了！', 'ナイス対応！', '完璧な障害対応！'][r.stars];
    $('resultStars').innerHTML = Array.from({ length: 3 }, (_, i) => `<span class="${i < r.stars ? '' : 'empty'}" style="animation-delay:${0.15 + i * 0.18}s">★</span>`).join('');
    $('rTime').textContent = `${fmtTime(r.time)} / 目標 ${fmtTime(m.par)}`;
    $('rHints').textContent = `${r.hints} 回`;
    $('rXp').textContent = session.gaveUp ? '0' : `+${rec.gain}`;
    const extra = [];
    if (session.gaveUp) extra.push('解答を見たため XP は獲得できません。もう一度挑戦してみましょう！');
    else if (!rec.gain && progress.stars(m.id) >= r.stars) extra.push('ベスト記録以下のため追加 XP はありません');
    if (rec.rankUp) extra.push(`🎉 ランクアップ！「${esc(rec.rankUp.name)}」になりました`);
    for (const b of rec.newBadges) extra.push(`<span class="badge-earned">${IG.badges[b].icon} バッジ獲得: ${esc(IG.badges[b].name)}</span>`);
    $('rExtra').innerHTML = extra.join('<br>');
    $('rPoints').innerHTML = m.debrief.points.map(p => `<li>${inlineCode(p)}</li>`).join('');
    $('rCommands').innerHTML = m.debrief.commands.map(([c, d]) => `<tr><td>${esc(c)}</td><td>${esc(d)}</td></tr>`).join('');
    const list = IG.missionsOf(m.track);
    const nx = list[list.indexOf(m) + 1] || nextMission();
    $('rNext').textContent = nx ? `次へ: ${nx.title} →` : 'マップへ →';
    $('rNext').onclick = () => { $('resultModal').hidden = true; location.hash = nx ? `#/play/${nx.id}` : '#/'; if (nx && location.hash === `#/play/${nx.id}`) openMission(nx.id); };
    $('rRetry').onclick = () => { $('resultModal').hidden = true; openMission(m.id); };
    $('rStay').onclick = () => { $('resultModal').hidden = true; $('termInput').focus(); };
    renderProfile();
    $('resultModal').hidden = false;
    $('rNext').focus();
  }
  function showSolution() {
    if (!session || session.m.sandbox) return;
    if (!session.completed) { session.giveUp(); onTick(); }
    $('solList').innerHTML = session.solution().map(c => `<li><div><code>${esc(c)}</code><button class="btn ghost small" data-insert="${esc(c)}">入力</button></div></li>`).join('');
    $('solutionModal').hidden = false;
  }
  function closeAllModals() { document.querySelectorAll('.modal-backdrop').forEach(m => { if (m.id !== 'editorModal') m.hidden = true; }); }

  /* ------------------------------------------------------------ events */
  function route() {
    const m = location.hash.match(/^#\/play\/([\w-]+)/);
    if (m) openMission(m[1]); else showHome();
  }
  window.addEventListener('hashchange', route);

  document.addEventListener('click', e => {
    const play = e.target.closest('[data-play]');
    if (play && !play.disabled) { const id = play.dataset.play; if (location.hash === `#/play/${id}`) openMission(id); else location.hash = `#/play/${id}`; return; }
    const hint = e.target.closest('[data-hint]');
    if (hint && session) { const i = Number(hint.dataset.hint); const h = session.hint(i); if (h) { addEvent(`ヒント使用: ${session.m.objectives[i].title}`, 'WARN'); renderObjectives(); onTick(); } return; }
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) { insertCommand(cmd.dataset.cmd); return; }
    const ins = e.target.closest('[data-insert]');
    if (ins) { $('solutionModal').hidden = true; insertCommand(ins.dataset.insert); return; }
    const close = e.target.closest('[data-close]');
    if (close) { close.closest('.modal-backdrop').hidden = true; return; }
    if (e.target.classList.contains('modal-backdrop') && e.target.id !== 'editorModal' && e.target.id !== 'resultModal') e.target.hidden = true;
  });
  $('howtoBtn').onclick = () => { $('howtoModal').hidden = false; };
  $('dismissFirstRun').onclick = () => { progress.data.seenIntro = true; progress.save(); $('firstRun').hidden = true; };
  $('resetProgress').onclick = () => { if (confirm('すべての進捗（XP・★・バッジ）をリセットします。よろしいですか？')) { progress.reset(); showHome(); toast('進捗をリセットしました'); } };
  $('resetMission').onclick = () => { if (session) { openMission(session.m.id); toast('環境を初期状態に戻しました'); } };
  $('showSolution').onclick = showSolution;
  $('termClear').onclick = () => { $('termOut').innerHTML = ''; $('termInput').focus(); };
  $('termMax').onclick = () => toggleMax();
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $('tabEvents').hidden = b.dataset.tab !== 'events';
    $('tabCheat').hidden = b.dataset.tab !== 'cheat';
  }));
  $('termOut').addEventListener('mouseup', () => { if (!String(window.getSelection())) $('termInput').focus(); });
  $('termForm').addEventListener('submit', e => { e.preventDefault(); const v = $('termInput').value; $('termInput').value = ''; submit(v); });
  $('termInput').addEventListener('keydown', e => {
    const input = e.target;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!session) return;
      const before = input.value;
      const r = session.shell.complete(before);
      input.value = r.line;
      if (r.options.length > 1 && (r.line === before || term.lastTab === before)) {
        printLine('cmd', '', `<span class="p">${esc(session.shell.prompt())}</span> ${esc(before)}`);
        printLine('opts', r.options.join('    '));
      }
      term.lastTab = r.line;
      return;
    }
    term.lastTab = '';
    if (e.key === 'ArrowUp') { e.preventDefault(); if (term.idx > 0) { term.idx--; input.value = term.history[term.idx]; } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (term.idx < term.history.length - 1) { term.idx++; input.value = term.history[term.idx]; } else { term.idx = term.history.length; input.value = ''; } return; }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); $('termOut').innerHTML = ''; return; }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && input.selectionStart === input.selectionEnd) { e.preventDefault(); printLine('cmd', '', `<span class="p">${esc(session.shell.prompt())}</span> ${esc(input.value)}^C`); input.value = ''; return; }
    if (e.key === 'Escape') { if ($('terminal').classList.contains('max')) toggleMax(false); else input.value = ''; }
  });

  const ta = $('editorText');
  ta.addEventListener('input', () => { setMode('INSERT'); gutter(); });
  ta.addEventListener('scroll', () => { $('editorGutter').scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); gutter(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveEditor(false); return; }
    if (e.key === 'Escape') { e.preventDefault(); setMode('NORMAL'); $('vimForm').hidden = false; $('vimInput').value = ''; $('vimInput').focus(); }
  });
  $('vimForm').addEventListener('submit', e => { e.preventDefault(); const c = $('vimInput').value; $('vimForm').hidden = true; setMode('INSERT'); runVim(c); if (!$('editorModal').hidden) ta.focus(); });
  $('vimInput').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); $('vimForm').hidden = true; setMode('INSERT'); ta.focus(); } });
  $('editorSave').onclick = () => saveEditor(true);
  $('editorCancel').onclick = () => runVim('q!');
  $('editorClose').onclick = () => closeEditor(false);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal-backdrop')].find(m => !m.hidden && m.id !== 'editorModal');
    if (open) { open.hidden = true; if (!$('viewMission').hidden) $('termInput').focus(); }
  });
  window.addEventListener('beforeunload', e => { if (session && !session.completed && session.lines.length > 3 && !$('viewMission').hidden) { e.preventDefault(); e.returnValue = ''; } });

  route();
})(globalThis.IG = globalThis.IG || {});
