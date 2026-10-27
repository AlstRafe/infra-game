/* Track: Docker */
(function (IG) {
  'use strict';
  const HOME = '/home/operator';
  const APP_PY = 'import os\nfrom flask import Flask, jsonify\n\napp = Flask(__name__)\nPORT = int(os.environ.get("PORT", "8000"))\n\n@app.get("/health")\ndef health():\n    return jsonify(status="ok")\n\nif __name__ == "__main__":\n    app.run(host="0.0.0.0", port=PORT)\n';

  IG.registerMission({
    id: 'docker-01', track: 'docker', order: 1, difficulty: 1, par: 240, xp: 100,
    title: 'はじめてのコンテナ', summary: 'nginx コンテナを起動してポートを公開し、アクセスログまで確認する',
    story: [
      '開発チームから依頼が来ました。「検証用の Web ページを、踏み台の 8080 番ポートで見られるようにしてほしい」',
      'nginx をサーバーに直接インストールする代わりに、Docker コンテナで動かします。',
      'コンテナは「イメージ（設計図）から起動した実行中のプロセス」です。ポート公開（-p）でホストとつなぎます。',
    ],
    cwd: HOME,
    setup(w, B) {
      w.features.add('docker');
      B.files(w, { [HOME + '/tickets/REQ-101.txt']: IG.t('依頼: 検証用 Web ページの公開\n- イメージ: nginx:1.27\n- コンテナ名: web\n- 公開ポート: ホストの 8080 → コンテナの 80\n- 完了確認: curl http://localhost:8080 で "Welcome to nginx!" が見えること\n') });
    },
    objectives: [
      { title: 'web コンテナを起動する', detail: 'nginx:1.27 を名前 web、ホスト 8080 → コンテナ 80 で起動',
        hints: ['依頼票は `cat tickets/REQ-101.txt`。コンテナの起動は docker run です。', '`docker run -d --name web -p 8080:80 nginx:1.27`（-d はバックグラウンド、-p はホスト:コンテナ）。起動後は `docker ps` で確認。'],
        check: w => { const c = w.docker.byName('web'); return c && c.status === 'running' && /^nginx:(1\.27|latest)$/.test(c.imageRef) && c.ports.some(p => p.host === 8080 && p.container === 80); } },
      { title: 'ページの表示を確認する', detail: 'curl で http://localhost:8080 にアクセスする',
        hints: ['ブラウザの代わりに curl で HTTP リクエストを送れます。', '`curl http://localhost:8080`'],
        check: (w, c) => c.http(h => h.ok && /^(localhost|127\.0\.0\.1)$/.test(h.host) && h.port === 8080) },
      { title: 'アクセスログを確認する', detail: 'さっきのリクエストがコンテナのログに出ていることを確かめる',
        hints: ['コンテナの標準出力は docker logs で読めます。', '`docker logs web`'],
        check: (w, c) => c.ran(/docker\s+(container\s+)?logs\b.*\bweb\b/) },
    ],
    solution: ['cat tickets/REQ-101.txt', 'docker run -d --name web -p 8080:80 nginx:1.27', 'docker ps', 'curl http://localhost:8080', 'docker logs web'],
    debrief: {
      points: [
        'docker run = pull（必要なら）+ create + start。-d でバックグラウンド、--name で名前を付ける。',
        '-p 8080:80 は「ホストの 8080 をコンテナの 80 に転送」。左がホスト、右がコンテナ。',
        'コンテナのログは標準出力へ。docker logs で確認でき、ログファイルを探し回る必要がない。',
      ],
      commands: [['docker run -d --name N -p H:C IMAGE', 'コンテナ起動'], ['docker ps [-a]', 'コンテナ一覧（-a は停止中も）'], ['docker logs N', 'ログ表示'], ['docker stop / rm N', '停止 / 削除']],
    },
  });

  IG.registerMission({
    id: 'docker-02', track: 'docker', order: 2, difficulty: 2, par: 420, xp: 150,
    title: 'Compose が立ち上がらない', summary: 'docker compose のログから設定漏れを見つけ、API を復旧する',
    story: [
      'EC サイトの検証環境は docker compose で web / api / db の 3 つのコンテナを動かしています。',
      '朝の定期再起動のあと「API が 502 を返す」と問い合わせがありました。',
      '~/shop の compose.yaml を調べて、api コンテナが落ちている原因を直してください。',
    ],
    cwd: HOME,
    setup(w, B) {
      w.features.add('docker');
      w.docker.addLocal('shop-api:0.9', { kind: 'app', app: 'shop-api', port: 5000, requiresEnv: ['DB_HOST'], hostEnv: ['DB_HOST'], version: '0.9.0', cmd: ['python', 'app.py'], entry: 'app.py', size: '131MB', vulns: { critical: 0, high: 0, medium: 3, low: 21 } }, w.now() - 6 * 86400e3);
      B.files(w, {
        [HOME + '/shop/compose.yaml']: 'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: example-only\n\n  api:\n    image: shop-api:0.9\n    ports:\n      - "5000:5000"\n    environment:\n      DB_NAME: shop\n    depends_on:\n      - db\n\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n    depends_on:\n      - api\n',
        [HOME + '/shop/README.md']: IG.t('# shop 検証環境\n\n起動: docker compose up -d\n状態: docker compose ps -a\nログ: docker compose logs <service>\n\n## api の環境変数\n- DB_HOST : 接続先 DB のホスト名（必須）。Compose ではサービス名で名前解決できる\n- DB_NAME : DB 名（既定: shop）\n'),
      });
      B.sh(w, 'docker compose up -d', HOME + '/shop');
    },
    objectives: [
      { title: '落ちたコンテナと原因を突き止める', detail: '停止しているコンテナを見つけ、そのログを読む',
        hints: ['`cd ~/shop` してから `docker compose ps -a`（-a で停止中も表示）。', '`docker compose logs api` でエラーを確認しましょう。'],
        check: (w, c) => c.ran(/docker\s+(compose\s+logs\b.*api|logs\s+shop-api-1|compose\s+logs\s*$)/) },
      { title: 'compose.yaml を直して api を起動する', detail: '足りない環境変数を追加し、docker compose up -d で反映する',
        hints: ['ログの KeyError は「環境変数 DB_HOST が無い」という意味です。README によると DB のホスト名はサービス名で解決できます。', 'compose.yaml の api の environment に `DB_HOST: db` を追加（`vi compose.yaml`）し、`docker compose up -d` で再作成します。'],
        check: w => { const c = w.docker.byName('shop-api-1'); return c && c.status === 'running'; } },
      { title: 'API のヘルスチェック', detail: 'http://localhost:5000/health が 200 を返すことを確認',
        hints: ['ホストの 5000 番が api コンテナにつながっています。', '`curl -s localhost:5000/health`'],
        check: (w, c) => c.http(h => h.ok && h.port === 5000 && /health/.test(h.path)) },
    ],
    solution: ['cd ~/shop', 'docker compose ps -a', 'docker compose logs api', "sed -i 's/      DB_NAME: shop/      DB_NAME: shop\\n      DB_HOST: db/' compose.yaml", 'docker compose up -d', 'curl -s localhost:5000/health'],
    debrief: {
      points: [
        'docker compose ps は既定で起動中だけを表示。落ちたコンテナを探すときは -a を付ける。',
        'Compose のネットワーク内ではサービス名（db など）がそのままホスト名として使える。localhost はコンテナ自身を指すので DB には届かない。',
        'compose.yaml を変えたら docker compose up -d で差分のあるコンテナだけ再作成される。',
      ],
      commands: [['docker compose ps -a', '全サービスの状態'], ['docker compose logs <svc>', 'サービスのログ'], ['docker compose up -d', '作成・更新して起動'], ['docker compose down', '停止して削除']],
    },
  });

  IG.registerMission({
    id: 'docker-03', track: 'docker', order: 3, difficulty: 2, par: 420, xp: 180,
    title: 'イメージをビルドせよ', summary: 'Dockerfile のミスを直してアプリをビルドし、コンテナで動かす',
    story: [
      '新しい在庫 API（shop-api）のソースが ~/shop-api に届きました。',
      '開発者のメモ:「Dockerfile も書いたのでビルドして 1.0 タグで動かしてみてください。ポートは 8000 です」',
      'ところが、ビルドがうまく通らないようです……。',
    ],
    cwd: HOME,
    setup(w, B) {
      w.features.add('docker');
      B.files(w, {
        [HOME + '/shop-api/Dockerfile']: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirement.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app.py .\nENV PORT=8000\nEXPOSE 8000\nCMD ["python", "app.py"]\n',
        [HOME + '/shop-api/requirements.txt']: 'flask==3.0.3\n',
        [HOME + '/shop-api/app.py']: APP_PY,
        [HOME + '/shop-api/.dockerignore']: '__pycache__/\n*.pyc\n',
      });
    },
    objectives: [
      { title: 'shop-api:1.0 をビルドする', detail: 'docker build でイメージを作る（エラーが出たら Dockerfile を修正）',
        hints: ['`cd ~/shop-api` → `docker build -t shop-api:1.0 .`（最後の . はビルドコンテキスト＝カレントディレクトリ）。', 'エラーの "requirement.txt": not found に注目。実際のファイル名は ls で確認できます。Dockerfile の綴りを直しましょう（`vi Dockerfile`）。'],
        check: w => { const i = w.docker.findImage('shop-api:1.0'); return i && i.meta.kind === 'app'; } },
      { title: 'コンテナとして起動する', detail: 'shop-api:1.0 をポート公開付きで起動する',
        hints: ['アプリは 8000 番で待ち受けます。', '`docker run -d --name shop-api -p 8000:8000 shop-api:1.0`'],
        check: w => w.docker.containers.some(c => c.imageRef === 'shop-api:1.0' && c.status === 'running' && c.ports.length) },
      { title: '/health を確認する', detail: 'curl でヘルスチェックが 200 になることを確認',
        hints: ['公開したホスト側のポートにアクセスします。', '`curl -s localhost:8000/health`'],
        check: (w, c) => c.http(h => h.ok && /health/.test(h.path) && h.target && h.target.kind === 'container' && (w.docker.byName(h.target.name) || {}).imageRef === 'shop-api:1.0') },
    ],
    solution: ['cd ~/shop-api', 'ls', 'docker build -t shop-api:1.0 .', "sed -i 's/requirement.txt/requirements.txt/' Dockerfile", 'docker build -t shop-api:1.0 .', 'docker run -d --name shop-api -p 8000:8000 shop-api:1.0', 'curl -s localhost:8000/health'],
    debrief: {
      points: [
        'Dockerfile は上から順に 1 命令 = 1 レイヤ。COPY のパスはビルドコンテキストからの相対パス。',
        'ビルドエラーは「どのステップ（[3/5] など）で」「何が not found か」を読むのが近道。',
        'requirements.txt を先に COPY して pip install するのはレイヤキャッシュを効かせるための定番パターン。',
      ],
      commands: [['docker build -t name:tag .', 'ビルド'], ['docker images', 'イメージ一覧'], ['docker run -d -p H:C name:tag', '起動'], ['docker inspect <name>', '設定の詳細']],
    },
  });
})(globalThis.IG = globalThis.IG || {});
