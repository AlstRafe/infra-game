/* Track: Linux basics */
(function (IG) {
  'use strict';
  const HOME = '/home/operator';

  const appLog = [];
  const svc = ['api-gateway', 'payment', 'auth', 'search', 'payment', 'api-gateway', 'search'];
  for (let i = 0; i < 42; i++) {
    const s = svc[i % svc.length];
    const t = `2026-10-24T00:${String(10 + Math.floor(i / 2)).padStart(2, '0')}:${String((i * 17) % 60).padStart(2, '0')}Z`;
    let level = 'INFO ', msg = `GET /v1/${s === 'search' ? 'items?q=router' : s === 'auth' ? 'token' : s === 'payment' ? 'charge' : 'health'} 200 ${10 + (i % 7) * 3}ms`;
    if (s === 'payment' && i % 3 !== 0) { level = 'ERROR'; msg = 'POST /v1/charge 502 upstream timed out (card-network:443)'; }
    if (s === 'auth' && i % 13 === 2) { level = 'ERROR'; msg = 'POST /v1/token 500 redis connection reset'; }
    if (s === 'search' && i % 11 === 3) { level = 'WARN '; msg = 'slow query 1840ms'; }
    appLog.push(`${t} ${level} [${s}] ${msg}`);
  }

  IG.registerMission({
    id: 'basics-01', track: 'basics', order: 1, difficulty: 1, par: 240, xp: 100,
    title: '初日の当番', summary: 'ターミナルの基本操作でログを調べ、障害の発生源を報告する',
    story: [
      'CoreLab へようこそ。あなたは今日からインフラ運用チームの一員です。',
      'さっそく当番の引き継ぎメモが届きました。「決済まわりでエラーが増えている気がする。ログを見て、どのサービスが原因か報告してほしい」',
      '下のターミナルにコマンドを入力して進めます。まずは ls で手元のファイルを眺めてみましょう。',
    ],
    cwd: HOME,
    setup(w, B) {
      B.files(w, {
        [HOME + '/README-FIRST.txt']: 'CoreLab 訓練環境へようこそ！\n\n- ここはブラウザ内のシミュレーションです。何を壊しても大丈夫。\n- ls でファイル一覧、cat <ファイル> で中身を表示、cd <ディレクトリ> で移動します。\n- Tab キーで入力補完、↑ キーで前のコマンドを呼び出せます。\n- 困ったら help コマンド、またはミッション欄の「ヒント」を押してください。\n',
        [HOME + '/runbook/oncall.md']: '# 当番手順書（抜粋）\n\n1. アプリのログは /var/log/app/app.log にある\n2. grep で ERROR の行だけを抜き出し、どのサービス（[ ] の中）が多いか調べる\n3. 原因と思われるサービス名を ~/report.txt に1行で書いて報告する\n   例: echo サービス名 > ~/report.txt\n',
        [HOME + '/.bash_history']: '',
        '/var/log/app/app.log': appLog.join('\n') + '\n',
        '/var/log/app/app.log.1': '2026-10-23T23:59:59Z INFO  [api-gateway] rotated\n',
      });
    },
    objectives: [
      { title: '手順書を読む', detail: 'runbook ディレクトリにある oncall.md を表示する',
        hints: ['ls で一覧を見ると runbook/ というディレクトリがあります。cd runbook で中に入れます。', '`cat runbook/oncall.md` で手順書を表示できます。'],
        check: (w, c) => c.ran(/^(cat|less|more|head|tail|vi|vim|view)\b.*oncall\.md/) },
      { title: 'ERROR の行を抜き出す', detail: '/var/log/app/app.log から ERROR を含む行を grep で抽出する',
        hints: ['grep は「パターンを含む行だけ」を表示するコマンドです。書式: grep <パターン> <ファイル>', '`grep ERROR /var/log/app/app.log` を実行しましょう。件数だけなら `grep -c ERROR …`、サービス別に数えるなら `grep ERROR /var/log/app/app.log | awk \'{print $3}\' | sort | uniq -c`'],
        check: (w, c) => c.ran(/grep\b.*ERROR.*app\.log|grep\b.*ERROR\s*$|cat .*app\.log.*\|\s*grep.*ERROR/i) },
      { title: '原因サービスを報告する', detail: 'ERROR が最も多いサービス名を ~/report.txt に書く',
        hints: ['ERROR の行の [ ] に注目。いちばん多く出ているサービスはどれでしょう？', '`echo payment > ~/report.txt` のように > でファイルに書き込めます。書けたら `cat ~/report.txt` で確認を。'],
        check: (w, c) => /\bpayment\b/i.test(c.file(HOME + '/report.txt') || '') && !/auth|search|gateway/i.test(c.file(HOME + '/report.txt') || '') },
    ],
    solution: ['ls', 'cat runbook/oncall.md', "grep ERROR /var/log/app/app.log | awk '{print $3}' | sort | uniq -c", 'echo payment > ~/report.txt'],
    debrief: {
      points: [
        'grep でパターンに一致する行だけを抽出できる。-c で件数、-i で大文字小文字無視、-v で反転。',
        '| （パイプ）でコマンドをつなぐと「抽出 → 集計 → 並べ替え」を一行で書ける。',
        '> はファイルを上書き、>> は追記。報告や記録を残すときの基本。',
      ],
      commands: [['ls -l', '詳細付きで一覧'], ['cat / less', 'ファイルを表示'], ['grep -c ERROR file', '一致した行数'], ["awk '{print $3}'", '3列目だけ取り出す'], ['sort | uniq -c', '重複を数える']],
    },
  });

  IG.registerMission({
    id: 'basics-02', track: 'basics', order: 2, difficulty: 2, par: 360, xp: 150,
    title: 'Web サーバーが起動しない', summary: 'SSH でサーバーに入り、ログから設定ミスを見つけて nginx を復旧する',
    story: [
      '社内ポータル（web-01）が昨夜の設定変更から表示されなくなりました。',
      '担当者は「nginx を再起動したら落ちたまま」とだけ書き残して帰宅しています。',
      'web-01 に SSH でログインし、なぜ nginx が起動しないのかを突き止めて復旧してください。',
    ],
    cwd: HOME,
    setup(w, B) {
      const conf = 'server {\n    listn 80;\n    server_name portal.lab.local web-01;\n    root /var/www/portal;\n    index index.html;\n\n    location / {\n        try_files $uri $uri/ =404;\n    }\n}\n';
      w.addHost('web-01', {
        user: 'ubuntu', ip: '10.0.1.31', services: { nginx: 'failed', 'ssh': 'active' },
        motd: 'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-1016-aws x86_64)\n\n  System load:  0.08   Memory usage: 21%   Processes: 112\n\n*** System restart required ***',
        files: {
          '/etc/nginx/nginx.conf': 'user www-data;\nworker_processes auto;\n\nevents { worker_connections 768; }\n\nhttp {\n    include /etc/nginx/mime.types;\n    access_log /var/log/nginx/access.log;\n    error_log /var/log/nginx/error.log;\n    include /etc/nginx/conf.d/*.conf;\n}\n',
          '/etc/nginx/conf.d/portal.conf': conf,
          '/etc/nginx/mime.types': 'types { text/html html; }\n',
          '/var/www/portal/index.html': '<!doctype html><title>CoreLab Portal</title><h1>CoreLab 社内ポータル</h1><p>今日も安全運用で。</p>',
          '/var/log/nginx/error.log': '2026/10/23 22:47:10 [emerg] 2412#2412: unknown directive "listn" in /etc/nginx/conf.d/portal.conf:2\n',
          '/home/ubuntu/CHANGELOG.txt': '2026-10-23 夜: portal.conf の listen を整理（担当: 佐藤）\n',
        },
        journal: { nginx: [
          'Oct 23 22:47:09 web-01 systemd[1]: Stopping nginx.service - A high performance web server...',
          'Oct 23 22:47:10 web-01 nginx[2412]: nginx: [emerg] unknown directive "listn" in /etc/nginx/conf.d/portal.conf:2',
          'Oct 23 22:47:10 web-01 systemd[1]: nginx.service: Control process exited, code=exited, status=1/FAILURE',
          'Oct 23 22:47:10 web-01 systemd[1]: Failed to start nginx.service - A high performance web server.',
        ] },
        checks: {
          nginx: h => {
            const lines = (h.vfs.read('/etc/nginx/conf.d/portal.conf') || '').split('\n');
            const allowed = /^(server|listen|server_name|root|index|location|try_files|return|proxy_pass|access_log|error_log|add_header|\}|\{|#)/;
            for (let i = 0; i < lines.length; i++) {
              const t = lines[i].trim();
              if (!t) continue;
              const word = t.split(/\s+/)[0];
              if (!allowed.test(word)) return [`nginx: [emerg] unknown directive "${word.replace(/;$/, '')}" in /etc/nginx/conf.d/portal.conf:${i + 1}`];
              if (!/[;{}]$/.test(t) && !t.startsWith('#')) return [`nginx: [emerg] directive "${word}" is not terminated by ";" in /etc/nginx/conf.d/portal.conf:${i + 2}`];
            }
            if (!/listen\s+80;/.test(lines.join('\n'))) return ['nginx: [warn] no "listen 80" found; portal would not be served on port 80'];
            return null;
          },
        },
        web: { port: 80, service: 'nginx', server: 'nginx/1.26.2', body: '<!doctype html><title>CoreLab Portal</title><h1>CoreLab 社内ポータル</h1><p>今日も安全運用で。</p>' },
      });
      B.files(w, { [HOME + '/tickets/INC-2041.txt']: '件名: 社内ポータル (http://web-01/) が表示されない\n対象: web-01 (10.0.1.31) / ユーザー ubuntu（sudo 可）\n接続: ssh web-01\n' });
    },
    objectives: [
      { title: '落ちた理由をログで確認する', detail: 'web-01 に SSH し、nginx のステータスかログを確認する',
        hints: ['`ssh web-01` でサーバーに入れます。戻るときは `exit`。', '`systemctl status nginx` で状態、`sudo journalctl -u nginx` で詳しいログが見られます。'],
        check: (w, c) => c.ran(/journalctl.*nginx|systemctl\s+status\s+nginx|nginx\s+-t|error\.log/) },
      { title: '設定を直して nginx を起動する', detail: '/etc/nginx/conf.d/portal.conf の誤りを直し、nginx を再起動する',
        hints: ['ログに「unknown directive "listn"」とあります。綴りミスです。', '`sudo vi /etc/nginx/conf.d/portal.conf` で編集（または `sudo sed -i \'s/listn/listen/\' /etc/nginx/conf.d/portal.conf`）。`sudo nginx -t` で確認してから `sudo systemctl restart nginx`。'],
        check: w => w.hosts['web-01'].services.nginx === 'active' },
      { title: 'ポータルの表示を確認する', detail: 'curl http://web-01/ で 200 が返ることを確認する',
        hints: ['踏み台に戻らなくても web-01 上から curl できます。', '`curl -s http://web-01/`'],
        check: (w, c) => c.http(h => h.ok && (h.host === 'web-01' || h.host === '10.0.1.31')) },
    ],
    solution: ['ssh web-01', 'systemctl status nginx', 'sudo journalctl -u nginx', "sudo sed -i 's/listn/listen/' /etc/nginx/conf.d/portal.conf", 'sudo nginx -t', 'sudo systemctl restart nginx', 'exit', 'curl -s http://web-01/'],
    debrief: {
      points: [
        'サービスが起動しないときは systemctl status → journalctl -u <unit> の順で原因を探すのが定石。',
        '設定を変えたら再起動の前に構文チェック（nginx -t、apachectl configtest など）を挟むと事故が減る。',
        'システムファイルの編集やサービス操作には sudo が必要。必要な時だけ使う。',
      ],
      commands: [['ssh <host>', 'リモートにログイン'], ['systemctl status <svc>', 'サービス状態'], ['journalctl -u <svc>', 'サービスのログ'], ['sudo nginx -t', '設定ファイルの検査'], ['sudo systemctl restart <svc>', '再起動']],
    },
  });
})(globalThis.IG = globalThis.IG || {});
