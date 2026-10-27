/* Command reference (コマンド辞典): one dictionary for every command the simulator runs (Linux, Docker,
 * Harbor, kubectl, oc, aws) and for "what do I type to …" recipes. It feeds man / --help / whatis /
 * apropos in the terminal, the cheat sheet beside it, the コマンド辞典 screen and the quick search on
 * every screen. DOM-free.
 *
 *   IG.registerCommands({
 *     topic: 'basics',                                  // a track id
 *     cats: { file: 'ファイル・ディレクトリ', … },       // categories, in display order
 *     doc: (e, path) => url,                            // official manual of an entry (path: the entry's own `doc`)
 *     cmds: [{ n: 'ls', cat: 'file', s: 1, en: 'list directory contents', ja: '…', syn: 'ls [OPTION]... [FILE]...',
 *              ex: [['ls -lah', '…'], ['ls --hyperlink', '…', 1]],   // 1: works on a real server only (not in the game)
 *              rel: 'tree, stat', k: 'search words', doc?, nosim?, same? }],
 *     tasks: [{ q: 'ポートを使っているプロセスを調べる', k: '…', do: [['ss -tlnp', '…']], note?: '…', see?: 'other, commands' }],
 *     cheat: [['ls -l', '詳細付き一覧'], …],               // the mission screen's 早見表
 *   });
 *
 * `nosim` marks a command the game's terminal does not run (kept because it is needed at work);
 * `same` points an alias (egrep, k …) at the entry that documents it. */
(function (IG) {
  'use strict';
  const R = IG.cmdref = { entries: [], byName: Object.create(null), tasks: [], byTask: Object.create(null), cats: {}, cheats: {}, topics: [] };
  let index = null, links = null;
  const list = s => (Array.isArray(s) ? s : String(s || '').split(',')).map(x => x.trim()).filter(Boolean);
  // short, stable ids for recipes (they appear in URLs): a hash of the question
  const hashId = s => { let h = 5381; for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36); };

  IG.registerCommands = d => {
    const ids = (d.tasks || []).map(t => hashId(t.q));   // from the Japanese: the same address in every language
    IG.i18n.deep(d);
    for (const k in d.cats || {}) d.cats[k] = IG.t(d.cats[k]);   // a category key may be one deep() keeps (image)
    const topic = d.topic;
    if (!R.topics.includes(topic)) R.topics.push(topic);
    R.cats[topic] = Object.assign(R.cats[topic] || {}, d.cats || {});
    if (d.cheat) R.cheats[topic] = (R.cheats[topic] || []).concat(d.cheat);
    for (const c of d.cmds || []) {
      const e = Object.assign({ topic, s: 1, ex: [], k: '', syn: c.n }, c, { name: c.n, rel: list(c.rel) });
      e.doc = /^https?:/.test(c.doc || '') ? c.doc : d.doc ? d.doc(e, c.doc) : '';
      if (R.byName[e.name]) throw new Error(`cmdref: ${e.name} registered twice`);
      R.entries.push(e);
      R.byName[e.name] = e;
    }
    for (const [i, t] of (d.tasks || []).entries()) {
      const task = Object.assign({ topic, k: '', see: [] }, t, { id: ids[i], see: list(t.see) });
      R.tasks.push(task);
      R.byTask[task.id] = task;
    }
    index = null; links = null;
  };

  R.get = name => {
    const e = R.byName[String(name || '').trim()];
    return e && e.same && R.byName[e.same] ? Object.assign({}, R.byName[e.same], { name: e.name, alias: e.same, en: e.en || R.byName[e.same].en, ja: e.ja || R.byName[e.same].ja }) : e || null;
  };
  R.task = id => R.byTask[id] || null;
  // The first sentence of a description (a 「。」 or ". " inside brackets does not end it).
  R.lead = text => { let d = 0; const t = String(text || ''); for (let i = 0; i < t.length; i++) { const ch = t[i]; if ('（(「'.includes(ch)) d++; else if ('）)」'.includes(ch)) d--; else if (d <= 0 && (ch === '。' || (ch === '.' && (i + 1 === t.length || /\s/.test(t[i + 1])) && /[a-z\uac00-\ud7a3)]/i.test(t[i - 1] || '')))) return t.slice(0, i); } return t; };
  R.catName = (topic, cat) => (R.cats[topic] || {})[cat] || cat;
  R.inCat = (topic, cat) => R.entries.filter(e => e.topic === topic && e.cat === cat && !e.same);
  // Is a topic's toolset present in a mission world? (Linux always; kubectl also with OpenShift and EKS.)
  R.topicOn = (topic, f) => topic === 'basics' || (f && (topic === 'k8s' ? f.has('k8s') || f.has('ocp') || f.has('aws') : f.has(topic)));

  /* ------------------------------------------------------------ which commands does a line use? */
  const WRAP = { sudo: 0, time: 0, nohup: 0, exec: 0, command: 0, builtin: 0, env: 0, nice: 0, ionice: 0, watch: 0, timeout: 1, xargs: 0, strace: 0 };
  const VALUED = { sudo: ['-u', '-g', '-U'], nice: ['-n'], ionice: ['-c', '-n'], watch: ['-n'], xargs: ['-n', '-I', '-P', '-d'], timeout: ['-s', '-k'], strace: ['-e', '-o', '-p'] };
  // shell keywords: the next word is a command (if, while …), the rest is not (for, case), or nothing to find (done, fi)
  const KW_CMD = { if: 'if', elif: 'if', while: 'while', until: 'until', do: null, then: null, else: null, '!': null, '{': null };
  const KW_END = { for: 'for', select: null, case: 'case', done: null, fi: null, esac: null, '}': null, in: null };
  const words = s => s.match(/'[^']*'|"[^"]*"|[^\s'"]+/g) || [];
  // The dictionary entries a command line uses, in order: `sudo ss -tlnp | grep :80` → ['ss', 'grep'].
  R.resolve = line => {
    const found = [];
    const add = n => { if (R.byName[n] && !found.includes(n)) found.push(n); };
    const segs = String(line).replace(/<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b/g, '').split(/\|\||&&|[|;&\n]|\$\(|`|\)/);
    for (const seg of segs) {
      const ws = words(seg.trim());
      let i = 0, wrap = null, end = false;
      while (i < ws.length) {
        const w = ws[i];
        if (w in KW_CMD) { if (KW_CMD[w]) add(KW_CMD[w]); i++; continue; }
        if (w in KW_END) { if (KW_END[w]) add(KW_END[w]); end = true; break; }
        if (/^![!$\w-]/.test(w)) { add('history'); end = true; break; }   // !!, !42, !ssh
        if (/^\w+=/.test(w) || /^[<>0-9]/.test(w)) { i++; continue; }
        if (w in WRAP) {
          wrap = w;
          if (w !== 'sudo') add(w);
          i++;
          while (i < ws.length && /^-/.test(ws[i])) { i += (VALUED[w] || []).includes(ws[i]) ? 2 : 1; }
          i += WRAP[w];
          continue;
        }
        break;
      }
      if (end) continue;
      if (ws[i] === '[' || ws[i] === '[[') { add('test'); continue; }
      if (ws[i] === '.' || ws[i] === ':') { add(ws[i]); continue; }
      const head = [];
      for (let j = i; j < ws.length && head.length < 4 && /^[a-z0-9][\w.:/-]*$/i.test(ws[j]); j++) head.push(j === i && ws[j] === 'k' ? 'kubectl' : ws[j]);
      let hit = false;
      for (let n = head.length; n > 0 && !hit; n--) {
        const name = head.slice(0, n).join(' ');
        if (R.byName[name]) { add(name); hit = true; }
      }
      if (!hit && wrap) add(wrap);   // `sudo -i`, `sudo ./run.sh`
    }
    return found;
  };

  /* ------------------------------------------------------------ search */
  const kata = s => s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const norm = s => kata(String(s || '').normalize('NFKC').toLowerCase());
  // Words people use for the same thing. A match on any of them adds the first word, so 「消したい」 finds 「削除」.
  const SYN = [
    ['削除', '消す', '消し', '消去', 'けす', '取り除', '除去', 'delete', 'remove', '捨て'],
    ['容量', 'サイズ', '大きさ', '使用量', '食って', '占有', 'size', 'usage', 'いっぱい', '満杯', '逼迫'],
    ['空き', '残り', '空いて', 'free', 'available'],
    ['一覧', 'リスト', 'list', '全部', 'すべて', '全て'],
    ['再起動', 'リスタート', 'restart', '再始動', '再読み込み', 'reload', 'リロード'],
    ['停止', '止め', '止ま', 'とめ', 'ストップ', 'stop', '落とし'],
    ['起動', '開始', '立ち上げ', 'スタート', 'start', '動かす', '動かし', '実行'],
    ['確認', '見る', '見た', '表示', '調べ', 'チェック', '知り', '見せ', '見え', '把握', 'show', 'check'],
    ['検索', '探す', '探し', 'さがす', '見つけ', 'find', 'search', 'サーチ', '絞り込', 'フィルタ', 'filter', '抽出'],
    ['置換', '置き換え', '書き換え', '一括変更', 'replace'],
    ['編集', 'エディタ', '修正', 'edit', '書き込'],
    ['変更', '変える', '変え', '切り替え', '切替', 'change', 'switch', '設定'],
    ['作成', '作る', '作り', '新規', 'つくる', 'create', '生成', 'make'],
    ['追加', '加える', '足す', 'add', '増設'],
    ['プロセス', 'process', 'pid'],
    ['権限', 'パーミッション', 'permission', 'アクセス権', '所有者', 'owner', 'denied', '拒否'],
    ['ディレクトリ', 'フォルダ', 'folder', 'directory'],
    ['ログ', 'log', 'logs', '記録'],
    ['リアルタイム', '追従', '流れ', 'follow', 'tail', 'ずっと'],
    ['数える', 'カウント', 'count', '件数', '数を', '何件', '集計', '統計'],
    ['並べ替え', 'ソート', 'sort', '順番', '並び替え', '順に', 'ランキング', '多い順', '大きい順'],
    ['重複', 'ダブり', 'uniq', 'ユニーク'],
    ['差分', '比較', 'diff', '違い', '変更点'],
    ['名前変更', 'リネーム', 'rename', '名前を変'],
    ['コピー', '複製', 'copy', 'バックアップ', 'backup'],
    ['移動', 'move'],
    ['通信', '接続', 'つなが', '繋が', '疎通', '到達', 'connect', 'つながらない', '届かない', 'connection'],
    ['ポート', 'port'],
    ['待ち受け', 'listen', 'リッスン', '開いている', '使っている', '使用中', 'ポートを使'],
    ['名前解決', 'dns', 'ドメイン', '引けない', 'resolve', 'nxdomain'],
    ['ユーザー', 'ユーザ', 'user', 'アカウント', 'account'],
    ['グループ', 'group'],
    ['パスワード', 'password', 'passwd'],
    ['メモリ', 'memory', 'ram', 'oom'],
    ['cpu', '負荷', '重い', '遅い', 'load', '高負荷'],
    ['ディスク', 'disk', 'ストレージ', 'storage', 'hdd', 'ssd', 'ボリューム', 'volume'],
    ['定期', '毎日', '毎時', '毎週', 'cron', 'スケジュール', '定時', '自動で'],
    ['自動起動', 'ブート時', '起動時', 'boot', 'enable', '有効化'],
    ['ネットワーク', 'network', 'nic', 'インターフェース', 'interface'],
    ['ipアドレス', 'アドレス', 'ip', 'address'],
    ['ファイアウォール', 'firewall', 'fw', '穴あけ', 'ポート開放', '開放', '許可', 'allow'],
    ['イメージ', 'image', 'images'],
    ['コンテナ', 'container', 'containers'],
    ['pod', 'ポッド', 'pods'],
    ['デプロイ', 'deploy', 'deployment', 'deployments', 'リリース', '反映', 'ロールアウト', 'rollout'],
    ['ノード', 'node', 'nodes', 'ワーカー'],
    ['secret', 'シークレット', '秘密', '認証情報'],
    ['サービス', 'service', 'svc', 'デーモン', 'daemon'],
    ['namespace', 'ネームスペース', '名前空間', 'ns', 'プロジェクト'],
    ['ロールバック', 'rollback', '戻す', '元に戻', '切り戻', 'undo'],
    ['スケール', 'scale', '台数', 'レプリカ', 'replica', '増やす', '減らす'],
    ['イベント', 'event', 'events'],
    ['バケット', 'bucket', 's3'],
    ['インスタンス', 'instance', 'ec2', '仮想マシン', 'vm'],
    ['セキュリティグループ', 'security group', 'sg', 'インバウンド', 'inbound'],
    ['ポリシー', 'policy'],
    ['証明書', 'certificate', 'cert', 'tls', 'ssl', 'https'],
    ['時刻', '日時', '時計', 'clock', 'ntp', 'タイムゾーン', 'timezone', '日付'],
    ['文字列', 'テキスト', 'text', '文字'],
    ['行', '行数', '何行', 'line'],
    ['ダウンロード', 'download', '取得', 'fetch'],
    ['転送', 'アップロード', 'upload', '送る', '送信', '同期', 'sync'],
    ['リモート', '遠隔', '別サーバ', '他のサーバ', 'ssh', 'ログイン'],
    ['マウント', 'mount'],
    ['パーティション', 'partition', '区画'],
    ['フォーマット', 'format', 'ファイルシステム作成'],
    ['環境変数', 'env', 'export', 'path'],
    ['エイリアス', 'alias', '別名', '短縮'],
    ['履歴', 'history', 'ヒストリ', '過去のコマンド', '前に打った'],
    ['カーネル', 'kernel'],
    ['モジュール', 'module', 'ドライバ', 'driver'],
    ['パッケージ', 'package', 'pkg', 'ソフトウェア'],
    ['インストール', 'install', '入れる', '導入'],
    ['強制終了', 'kill', '殺す', '終了させ', '止まらない', '応答しない', 'ハング', '固まっ', 'フリーズ'],
    ['エラー', 'error', '失敗', '落ちる', '落ちた', 'fail', 'failed', '異常', '障害', 'トラブル'],
    ['ハッシュ', 'チェックサム', 'checksum', 'md5', 'sha', '改ざん'],
    ['暗号', '暗号化', 'encrypt', '復号'],
    ['鍵', 'key', '公開鍵', '秘密鍵'],
    ['経路', 'ルーティング', 'routing', 'ゲートウェイ', 'gateway'],
    ['圧縮', 'zip', 'アーカイブ', 'archive', '固める'],
    ['展開', '解凍', 'unzip', 'extract', '伸張'],
    ['脆弱性', 'cve', 'vulnerability', 'スキャン', 'scan'],
    ['レジストリ', 'registry', 'harbor', 'リポジトリ', 'repository'],
    ['タグ', 'tag'],
    ['ビルド', 'build', 'dockerfile'],
    ['公開', '外部から', 'expose', 'route', 'ルート', 'url'],
    ['シェル', 'shell', '中に入', '入って', '入りたい', 'コンテナに入', 'ログインして', 'exec'],
    ['マニフェスト', 'manifest', 'yaml', 'json'],
    ['コンテキスト', 'context', 'kubeconfig', 'クラスタ切替'],
    ['ラベル', 'label', 'セレクタ', 'selector'],
    ['リソース', 'resource', '使用率'],
    ['スクリプト', 'script', 'ループ', 'loop', '繰り返し', '一括'],
    ['日本語', '文字化け', '文字コード', 'shift_jis', 'sjis', 'utf-8', 'utf8'],
    ['バージョン', 'version', '版'],
  ].map(g => g.map(norm));
  const SYN_RE = new RegExp(SYN.flat().filter(w => !/^[a-z0-9 ._-]+$/.test(w)).sort((a, b) => b.length - a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const SYN_OF = new Map();
  SYN.forEach(g => g.forEach(w => { if (!SYN_OF.has(w)) SYN_OF.set(w, g[0]); }));
  const FILLER = new RegExp(norm('(したい|やりたい|知りたい|調べたい|見たい|方法|やり方|どうやって|どうすれば|どうする|コマンド|教えて|ください|とは|って何|には|ための|なるべく)'), 'g');
  // Text → { jp: bigrams of the Japanese parts (with the canonical synonyms added), w: ASCII words }
  // A particle between two words splits them: 「ディスクの空き」 → 「ディスク 空き」, so 「くの」「の空」 are not searched for.
  const PARTICLE = /([\u4e00-\u9fff\u30a1-\u30fc0-9a-zA-Z])[をがのにでとへやもは](?=[\u4e00-\u9fff\u30a1-\u30fc0-9a-zA-Z])/g;
  function analyse(text, query) {
    const nf = String(text || '').normalize('NFKC');
    const raw = nf.replace(PARTICLE, '$1 ');
    let t = norm(raw);
    const canon = new Set();
    for (const m of norm(nf).match(SYN_RE) || []) canon.add(SYN_OF.get(m));   // before the particle split: 「名前を変」
    if (query) t = t.replace(FILLER, ' ');
    const w = new Set(t.match(/-{0,2}[a-z0-9][a-z0-9._:/+=*-]*/g) || []);
    for (const x of w) { if (SYN_OF.has(x)) canon.add(SYN_OF.get(x)); const bare = x.replace(/^-+/, ''); if (SYN_OF.has(bare)) canon.add(SYN_OF.get(bare)); }
    const jp = new Set();
    const runs = (t.replace(/[a-z0-9._:/+=*-]+/g, ' ') + ' ' + [...canon].join(' ')).split(/[\s、。,.!?！？「」『』（）()・:：/／~〜→\-]+/).filter(Boolean);
    for (const r of runs) {
      if (/^[a-z0-9]+$/.test(r)) { w.add(r); continue; }
      if (r.length === 1) { if (/[一-鿿]/.test(r)) jp.add(r); continue; }
      for (let i = 0; i < r.length - 1; i++) jp.add(r.slice(i, i + 2));
    }
    for (const c of canon) if (/^[a-z0-9]+$/.test(c)) w.add(c);
    for (const k of raw.match(/[\u30a1-\u30fa\u30fc]{2,}/g) || []) w.add(kata(k));   // katakana words: ログ ≠ ログイン
    return { jp, w, text: t };
  }
  function docOf(kind, item) {
    const isCmd = kind === 'cmd';
    const name = isCmd ? item.name : '';
    const head = isCmd ? [item.ja, item.k].join(' ') : [item.q, item.k].join(' ');
    const body = isCmd ? [item.en, item.syn, R.catName(item.topic, item.cat), ...item.ex.flat()].join(' ') : [item.note, ...item.do.flat()].join(' ');
    // the lead: what it is for, in one phrase (a recipe's question, the first sentence of a command's description)
    const lead = analyse(isCmd ? R.lead(item.ja) : item.q);
    return { kind, item, topic: item.topic, name: analyse(name), nameWords: name.split(' '), head: analyse(head), body: analyse(body), lead: lead.jp, title: isCmd ? null : lead.w };
  }
  function build() {
    const docs = R.entries.filter(e => !e.same).map(e => docOf('cmd', e)).concat(R.tasks.map(t => docOf('task', t)));
    const df = new Map();
    const count = k => df.set(k, (df.get(k) || 0) + 1);
    for (const d of docs) {
      new Set([...d.head.jp, ...d.body.jp]).forEach(b => count('j' + b));
      new Set([...d.head.w, ...d.body.w, ...d.name.w]).forEach(x => count('w' + x));
    }
    const N = docs.length;
    const idf = k => Math.log(1 + N / (1 + (df.get(k) || 0)));
    for (const d of docs) { d.headSum = 0; for (const b of d.head.jp) d.headSum += idf('j' + b); }
    return { docs, idf };
  }
  const prefixHit = (set, t) => { if (t.length < 3) return false; for (const x of set) if (x.startsWith(t)) return true; return false; };
  // Ranked commands and recipes for a query: words (ls, -tlnp, kubectl logs) or what you want to do, in Japanese or English.
  const popCache = Object.create(null);
  const pop = n => popCache[n] ?? (popCache[n] = Math.min(5, 1.2 * Math.log2(1 + ['tasks', 'drills', 'missions'].reduce((a, k) => a + (L()[k][n] || []).length, 0))));
  R.search = (query, opts = {}) => {
    if (!index) index = build();
    const q = String(query || '').trim();
    if (!q) return [];
    const qa = analyse(q, true);
    const qn = norm(q).replace(/\s+/g, ' ');
    let jpTotal = 0;
    for (const b of qa.jp) jpTotal += index.idf('j' + b);
    const typed = /^[\x20-\x7e]+$/.test(q) ? R.resolve(q) : [];   // a command line: `k get pods -A` → kubectl get
    const nameW = jpTotal ? 4 : 8;
    const phrase = qn.length >= 6 && /\s/.test(qn) ? qn : null;
    const hits = [];
    for (const d of index.docs) {
      if (opts.topic && d.topic !== opts.topic) continue;
      if (opts.kind && d.kind !== opts.kind) continue;
      let s = 0;
      if (d.kind === 'cmd') {
        if (d.item.name === qn) s += 60;
        else if (typed[0] === d.item.name) s += 50;
        else if (typed.includes(d.item.name)) s += 25;
        else if (d.item.name.startsWith(qn + ' ')) s += 18;
        else if (qn.length >= 2 && d.item.name.startsWith(qn)) s += 14;
        if (phrase && (d.head.text.includes(phrase) || d.body.text.includes(phrase))) s += 30;
      } else if (phrase && d.head.text.includes(phrase)) s += 30;
      for (const t of qa.w) {
        const w = index.idf('w' + t);
        if (!/^[-a-z0-9]/.test(t)) {   // a katakana word: only a little on top of its bigrams
          if (d.head.w.has(t)) s += 1.5 * w; else if (d.body.w.has(t)) s += 0.5 * w;
          continue;
        }
        if (d.kind === 'task' && d.title.has(t)) s += 3 * w;
        if (d.nameWords.includes(t)) s += nameW * w;
        else if (d.kind === 'cmd' && t.length >= 2 && d.nameWords.some(x => x.startsWith(t))) s += 3 * w;
        if (d.head.w.has(t)) s += 3 * w; else if (prefixHit(d.head.w, t)) s += 1.2 * w;
        if (d.body.w.has(t)) s += 1.2 * w; else if (prefixHit(d.body.w, t)) s += 0.5 * w;
      }
      let jp = 0, inHead = 0, inLead = 0;
      for (const b of qa.jp) {
        const w = index.idf('j' + b);
        if (d.head.jp.has(b)) { jp += 3 * w; inHead += w; } else if (d.body.jp.has(b)) jp += 1 * w;
        if (d.lead.has(b)) inLead += w;
      }
      // how much of the query it covers (above all in its lead), and how much of its own description is about the query
      const cov = jpTotal ? jp / (3 * jpTotal) : 1;
      if (jpTotal) s += 24 * cov + 12 * inLead / jpTotal + (d.headSum ? 8 * inHead / d.headSum : 0);
      if (d.kind === 'task') s *= 1 + 0.2 * cov;   // a recipe that covers the query answers 「〜したい」 directly
      else if (s > 0) s += pop(d.item.name);      // between equals, the command the game's lessons use more (rm before shred)
      if (s > 0) hits.push({ kind: d.kind, item: d.item, score: Math.round(s * 10) / 10 });
    }
    hits.sort((a, b) => b.score - a.score || (a.item.name || a.item.q).localeCompare(b.item.name || b.item.q));
    const best = hits.length ? hits[0].score : 0;
    const floor = Math.max(opts.min ?? 4, best * (opts.cut ?? 0.28));
    return hits.filter(h => h.score >= floor).slice(0, opts.limit || 40);
  };

  /* ------------------------------------------------------------ links between entries, recipes, drills, missions */
  function buildLinks() {
    const L = { rev: {}, tasks: {}, co: {}, drills: {}, unitCmds: {}, missions: {} };
    const push = (map, k, v) => { (map[k] = map[k] || []).includes(v) || map[k].push(v); };
    for (const e of R.entries) for (const r of e.rel) push(L.rev, r, e.name);
    for (const t of R.tasks) {
      const names = [];
      for (const [line] of t.do) for (const n of R.resolve(line)) if (!names.includes(n)) names.push(n);
      for (const n of t.see) if (!names.includes(n)) names.push(n);
      t.cmds = names;
      for (const n of names) { push(L.tasks, n, t.id); for (const m of names) if (m !== n) push(L.co, n, m); }
    }
    // drills: the commands in model answers, code blocks, `code` spans and command-like choices
    for (const topic of IG.drillTopics ? IG.drillTopics() : []) {
      for (const unit of IG.drillUnits(topic)) {
        const ref = `${topic}:${unit.n || '#' + unit.id}`;
        const snippets = [];
        const ticks = s => (String(s || '').match(/`[^`]+`/g) || []).map(x => x.slice(1, -1));
        for (const p of unit.points || []) snippets.push(...ticks(p));
        for (const q of unit.qs) {
          if (q.a) snippets.push(q.a);
          if (q.code) snippets.push(...q.code.split('\n').filter(l => /^\s*(\$|#)\s/.test(l)).map(l => l.replace(/^\s*[$#]\s/, '')));
          snippets.push(...ticks(q.q), ...ticks(q.x));
          if (q.c && /^[a-z][\w.-]*( |$)/.test(q.c[0])) snippets.push(q.c[0]);
        }
        for (const s of snippets) for (const n of R.resolve(s)) { push(L.drills, n, ref); push(L.unitCmds, ref, n); }
      }
    }
    for (const m of IG.missions || []) {
      if (m.sandbox) continue;
      const lines = (Array.isArray(m.solution) ? m.solution : []).concat(((m.debrief || {}).commands || []).map(c => c[0]));
      for (const l of lines) for (const n of R.resolve(String(l).replace(/<[^>]+>/g, 'x'))) push(L.missions, n, m.id);
    }
    return L;
  }
  const L = () => (links = links || buildLinks());
  // Related commands, by how they are related: listed by the entry, used in the same recipes, same category.
  R.related = e => {
    const own = e.rel.concat(L().rev[e.name] || []).filter((n, i, a) => a.indexOf(n) === i && n !== e.name && R.byName[n]);
    const co = (L().co[e.name] || []).filter(n => !own.includes(n) && n !== e.name && R.byName[n]).slice(0, 8);
    const seen = new Set([e.name, ...own, ...co]);
    const same = R.inCat(e.topic, e.cat).map(x => x.name).filter(n => !seen.has(n)).slice(0, 12);
    return { own, co, same };
  };
  R.tasksFor = e => (L().tasks[e.name] || []).map(R.task);
  R.drillsFor = e => L().drills[e.name] || [];
  R.missionsFor = e => L().missions[e.name] || [];
  R.taskCmds = t => { L(); return t.cmds || []; };
  R.cmdsForDrill = ref => L().unitCmds[ref] || [];
  // Recipes that share the most commands with this one.
  R.similarTasks = (t, n = 5) => {
    const score = new Map();
    for (const c of R.taskCmds(t)) for (const id of L().tasks[c] || []) if (id !== t.id) score.set(id, (score.get(id) || 0) + 1);
    return [...score].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => R.task(id));
  };
  // Can every command of this line be run in the game's terminal?
  R.runnable = line => { const ns = R.resolve(line); return ns.length > 0 && ns.every(n => R.byName[n] && !R.byName[n].nosim); };
  R.inGame = e => !e.nosim;

  /* ------------------------------------------------------------ terminal: apropos / man -k */
  // Real apropos matches names and NAME lines; this one also understands what you want to do, in
  // Japanese, Korean, Chinese, or several English words on the English screens (apropos port in use),
  // and lists recipes.
  R.apropos = words => {
    const q = words.join(' ').trim();
    const plain = !/^[\x20-\x7e]+$/.test(q) || (IG.i18n && IG.i18n.lang === 'en-GB' && words.length > 1);
    let cmds;
    if (!plain) {
      const res = words.map(w => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      cmds = R.entries.filter(e => !e.nosim && res.some(re => re.test(e.name) || re.test(e.en)));
      cmds.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      cmds = R.search(q, { kind: 'cmd', limit: 12 }).map(h => h.item).filter(e => !e.nosim);
    }
    const tasks = plain ? R.search(q, { kind: 'task', limit: 3 }).map(h => h.item) : [];
    return { cmds, tasks, plain };
  };
})(globalThis.IG = globalThis.IG || {});
