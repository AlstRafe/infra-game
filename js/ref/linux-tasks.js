/* コマンド辞典: Linux の「やりたいこと」レシピと、ミッション画面の早見表。 */
(function (IG) {
  'use strict';
  IG.registerCommands({
    topic: 'basics',
    cheat: [['ls -l', '詳細付き一覧'], ['cat <file>', '中身を表示'], ['grep -n <pat> <file>', '一致行を行番号付きで'], ['tail -n 20 <file>', '末尾 20 行'], ['vi <file>', 'ファイルを編集（:wq で保存）'], ['df -h / du -sh *', 'ディスク使用量'], ['sudo <cmd>', '管理者権限で実行'], ['apropos <やりたいこと>', 'コマンドを探す（日本語可）']],
    tasks: [
      /* ---------------------------------------------------------------- files & disk usage */
      { q: 'ディスクの空き容量を確認する', k: '容量不足 いっぱい 残り', do: [['df -h', 'ファイルシステムごとの使用率と空き'], ['df -hT /var', '/var がどのファイルシステムか（種類も）'], ['df -i', 'inode の残り（空きがあるのに No space left のとき）']] },
      { q: '何が容量を使っているか探す', k: 'ディスク いっぱい 大きいディレクトリ 肥大', do: [['sudo du -h --max-depth=1 /var | sort -h', '1 階層下の内訳を小さい順'], ['sudo du -ah /var/log | sort -rh | head -20', '大きいもの上位 20'], ['sudo find / -xdev -type f -size +500M 2>/dev/null', '500MB を超えるファイル']], note: '/ を調べるときは -xdev（find）でほかのディスクに降りないようにする。' },
      { q: '削除したのにディスク容量が減らない', k: 'deleted 開いたまま 解放されない', do: [['sudo lsof +L1', '削除済みなのにプロセスが開いているファイル'], ['sudo systemctl restart app', '開いているプロセスを再起動すると解放される']], note: 'ログを消すときは rm ではなく truncate -s 0 で空にすると、書き込み中でも容量が戻る。' },
      { q: '大きくなったログファイルを空にする', k: '肥大 ログ 消す 容量', do: [['sudo truncate -s 0 /var/log/app.log', 'ファイルは残したまま中身だけ空に'], ['sudo logrotate -f /etc/logrotate.d/app', 'ローテーション設定で世代管理する']] },
      { q: 'ファイルを名前で探す', k: 'どこにある 場所 見つからない', do: [["find / -name 'nginx.conf' 2>/dev/null", '全体から名前で'], ["find . -iname '*.log'", '大文字小文字を無視'], ['which nginx', 'コマンドなら PATH から探す']] },
      { q: '最近更新されたファイルを探す', k: '変更された いつ 更新日時', do: [['find /etc -type f -mtime -1', '24 時間以内に更新'], ['ls -lt /var/log | head', '新しい順'], ['find . -newer deploy.stamp -type f', '目印ファイルより新しいもの']] },
      { q: 'ファイルやディレクトリを削除する', k: '消す 削除 rm 取り消し', do: [['rm old.log', 'ファイルを削除'], ['rm -i *.tmp', '1 つずつ確認しながら'], ['rmdir empty-dir', '空のディレクトリ'], ['rm -r build/', 'ディレクトリごと'], ['ls build/ && rm -rf build/', '中身を確かめてから強制削除']], note: 'ゴミ箱はなく元に戻せない。rm -rf の前に ls で対象を確認し、ワイルドカードや変数が空になっていないか見る。' },
      { q: 'ファイルをコピー・移動・名前変更する', k: 'コピー 移動 リネーム 複製', do: [['cp app.conf app.conf.bak', 'コピー'], ['cp -a /etc/nginx /tmp/nginx.bak', '権限・日時ごとディレクトリをコピー'], ['mv report.txt archive/', '移動'], ['mv old.txt new.txt', '名前変更']] },
      { q: 'ディレクトリを作る・移動する', k: 'フォルダ 作成 階層 カレント', do: [['mkdir -p /opt/app/logs', '途中の階層もまとめて作る'], ['cd /opt/app', '移動'], ['pwd', '今いる場所'], ['cd -', '直前のディレクトリへ戻る']] },
      { q: '古いファイルをまとめて削除する', k: '日数 何日前 掃除 一括削除', do: [['find /var/backups -name "*.tgz" -mtime +30', 'まず対象を表示して確認'], ['find /var/backups -name "*.tgz" -mtime +30 -delete', '確認したら削除']], note: '-delete の前に、同じ条件で表示だけして対象を確かめる。' },
      { q: 'ファイルの中から文字列を探す', k: 'grep どのファイルに書いてある 設定', do: [['grep -rn "timeout" /etc/nginx/', 'ディレクトリ配下を行番号付きで'], ['grep -ril "password" /opt/app/conf', '含むファイル名だけ'], ['grep -rn --include="*.yaml" "image:" .', '拡張子を限定']] },
      { q: '複数ファイルの文字列を一括で置換する', k: 'ホスト名 変更 書き換え まとめて', do: [['grep -rl "old-db" /opt/app/conf', 'まず対象ファイルを確認'], ['grep -rl "old-db" /opt/app/conf | xargs sed -i.bak "s/old-db/new-db/g"', 'バックアップを残して置換']] },
      { q: '設定ファイルを編集前にバックアップする', k: '変更前 退避 戻せるように', do: [['sudo cp -p /etc/nginx/nginx.conf /etc/nginx/nginx.conf.$(date +%Y%m%d)', '日付付きでコピー（権限・時刻も保持）'], ['diff -u /etc/nginx/nginx.conf.20261026 /etc/nginx/nginx.conf', '編集後に差分を確認']] },
      { q: '2 つのファイルの違いを見る', k: '差分 比較 どこが変わった', do: [['diff -u old.conf new.conf', '差分（+ 追加 / - 削除）'], ['vimdiff old.conf new.conf', '並べて色付きで'], ['diff -r dirA dirB', 'ディレクトリ同士']] },
      { q: 'ディレクトリを圧縮してまとめる', k: 'バックアップ tar 固める', do: [['tar czf etc-$(date +%F).tgz /etc', 'gzip 圧縮の tar'], ['tar tzf etc-2026-10-26.tgz | head', '中身を確認'], ['zip -r logs.zip logs/', 'Windows に渡すなら zip']] },
      { q: '圧縮ファイルを展開する', k: '解凍 tgz zip gz', do: [['tar xzf app.tgz -C /opt/app', '.tgz / .tar.gz'], ['unzip app.zip -d /opt/app', '.zip'], ['gzip -dk app.log.gz', '.gz（元を残す）']] },
      { q: '圧縮されたログを展開せずに検索する', k: 'gz ローテート 過去ログ', do: [['zgrep "ERROR" /var/log/syslog.2.gz', 'gz のまま grep'], ['zcat /var/log/syslog.2.gz | tail', '中身を表示']] },
      { q: 'シンボリックリンクを作る・リンク先を調べる', k: 'リンク 別名 current', do: [['ln -s /opt/app-2.1 /opt/app', 'リンクを作る'], ['ln -sfn /opt/app-2.2 /opt/app', 'リンク先を差し替え'], ['readlink -f /opt/app', '最終的なリンク先']] },
      { q: 'ファイルを安全にサーバー間でコピー・同期する', k: '転送 送る バックアップ 移行', do: [['scp app.tgz web01:/tmp/', '1 ファイル送る'], ['rsync -avz /var/www/ web02:/var/www/', '差分だけ同期'], ['rsync -av --delete --dry-run src/ web02:/srv/', '削除も同期する前に試し実行']] },

      /* ---------------------------------------------------------------- permissions & users */
      { q: 'Permission denied の原因を調べる', k: '権限エラー アクセスできない 拒否', do: [['ls -l /var/www/html/index.html', 'ファイルの権限と所有者'], ['ls -ld /var/www /var/www/html', '途中のディレクトリの x（通過）権限'], ['id', '自分がどのグループに入っているか'], ['getfacl /var/www/html', 'ACL の追加権限']], note: 'ディレクトリの奥にあるファイルは、途中のすべてのディレクトリに x 権限が必要。' },
      { q: 'ファイルの権限を変える', k: 'chmod パーミッション 実行権 755 644', do: [['chmod 640 app.conf', '所有者は読み書き・グループは読み・他人は不可'], ['chmod +x deploy.sh', '実行権を付ける'], ['chmod -R u=rwX,go=rX /var/www', 'ディレクトリだけ x 付きで一括']] },
      { q: 'ファイルの所有者を変える', k: 'chown オーナー', do: [['sudo chown -R www-data:www-data /var/www/html', '所有者とグループを再帰的に'], ['ls -l /var/www/html', '確認']] },
      { q: 'root でも消せない・変更できないファイル', k: 'operation not permitted immutable 属性', do: [['lsattr /etc/resolv.conf', 'i 属性が付いていないか'], ['sudo chattr -i /etc/resolv.conf', '外す']] },
      { q: '自分が誰で、何の権限を持っているか確認する', k: '自分は誰 whoami ユーザー 権限 アカウント 認証情報 ログイン中', do: [['whoami', 'Linux のユーザー名'], ['id', 'UID と所属グループ（sudo / wheel にいるか）'], ['sudo -l', 'sudo で何が実行できるか'], ['aws sts get-caller-identity', 'AWS ではどのアカウントの誰か'], ['kubectl auth can-i --list', 'Kubernetes で何ができるか'], ['oc whoami --show-server', 'OpenShift のユーザーと接続先']], note: '権限エラーに出会ったら、まず「今どのユーザー・どの認証情報で動いているか」を確かめる。' },
      { q: 'ユーザーを作成する', k: 'アカウント 追加 新規', do: [['sudo useradd -m -s /bin/bash alice', 'ホーム付きで作成'], ["echo 'alice:S3cure!pw' | sudo chpasswd", 'パスワード設定'], ['id alice', '確認']] },
      { q: 'ユーザーをグループに追加する', k: 'docker グループ sudo wheel 権限付与', do: [['sudo usermod -aG docker alice', '追加（-a を忘れない）'], ['id alice', '確認（本人は再ログインで反映）']], note: 'usermod -G だけだと、指定以外のグループから外れてしまう。' },
      { q: 'ユーザーに sudo 権限を与える', k: '管理者 root 権限 wheel', do: [['sudo usermod -aG sudo alice', 'Ubuntu は sudo グループ'], ['sudo usermod -aG wheel alice', 'RHEL は wheel グループ'], ['sudo -l -U alice', '許可内容を確認']] },
      { q: 'ユーザーをロック・無効にする', k: '退職 停止 ログイン禁止', do: [['sudo usermod -L alice', 'パスワードをロック'], ['sudo chage -E 0 alice', 'アカウントを期限切れに'], ['sudo passwd -S alice', '状態を確認']] },
      { q: 'パスワードの有効期限を確認・変更する', k: '期限切れ 90日', do: [['sudo chage -l alice', '確認'], ['sudo chage -M 90 alice', '90 日で期限']] },
      { q: '誰がログインしているか・ログイン履歴を見る', k: '接続中 いつ 誰が', do: [['w', 'ログイン中と実行中のコマンド'], ['last -n 20', '直近のログイン'], ['sudo lastb -n 20', '失敗したログイン']] },

      /* ---------------------------------------------------------------- processes */
      { q: 'CPU やメモリを食っているプロセスを探す', k: '重い 遅い 高負荷 原因', do: [['top -b -n 1 | head -20', 'ひと目で全体（対話なら top）'], ['ps aux --sort=-%cpu | head', 'CPU 使用率の高い順'], ['ps aux --sort=-%mem | head', 'メモリ使用量の多い順']] },
      { q: 'サーバーの負荷を確認する', k: 'ロードアベレージ load 重い', do: [['uptime', '1・5・15 分の負荷'], ['nproc', 'CPU 数（負荷が CPU 数を超えると詰まっている）'], ['vmstat 1 5', 'CPU 待ち（r）と I/O 待ち（wa）']] },
      { q: 'メモリの空きを確認する', k: '不足 oom available', do: [['free -h', 'available が実際に使える量'], ['ps aux --sort=-%mem | head', '使っているプロセス'], ["dmesg -T | grep -i 'out of memory'", 'OOM Killer の記録']] },
      { q: 'ディスク I/O が遅い原因を調べる', k: 'io 待ち 遅い wa', do: [['iostat -xz 1 3', 'デバイスごとの使用率（%util）と待ち時間'], ['pidstat -d 1 3', 'プロセスごとの I/O'], ['vmstat 1 5', 'wa（I/O 待ち）の割合']] },
      { q: 'プロセスを名前で探す', k: '動いているか pid', do: [['pgrep -a nginx', 'PID と引数'], ['ps -ef | grep [n]ginx', 'grep 自身を除く書き方'], ['pstree -p', '親子関係']] },
      { q: 'プロセスを止める', k: '終了 kill 応答しない ハング', do: [['kill 1234', 'まず通常の終了（TERM）'], ['kill -9 1234', '応答しない場合のみ強制終了'], ['pkill -f "python app.py"', '名前（引数）で指定']], note: 'サービスとして動いているものは systemctl stop で止める（kill すると自動で再起動されることがある）。' },
      { q: 'ポートを使っているプロセスを調べる', k: 'address already in use 待ち受け 使用中', do: [['sudo ss -tlnp', '待ち受け中の TCP ポートと PID'], ['sudo lsof -i :8080', '8080 番を開いているプロセス'], ['sudo fuser -v 8080/tcp', '同じく（短い）']], note: '他ユーザーのプロセス名を見るには sudo が必要。' },
      { q: 'ログアウトしても処理を続けたい', k: 'バックグラウンド 長時間 切断', do: [['nohup ./batch.sh > batch.log 2>&1 &', 'バックグラウンドで続行'], ['tmux new -s work', '切断しても戻れるセッション'], ['sudo systemd-run --unit=batch ./batch.sh', 'サービスとして実行し journalctl で追う']] },
      { q: 'コマンドに時間制限をつける', k: 'タイムアウト 終わらない 打ち切り', do: [['timeout 10 curl -s http://api/health', '10 秒で打ち切り'], ['timeout -s KILL 5m ./job.sh', '5 分で強制終了']] },
      { q: '一定間隔でコマンドを繰り返して様子を見る', k: '監視 定期 更新', do: [['watch -n 2 "ss -s"', '2 秒ごと'], ['while true; do date; curl -s -o /dev/null -w "%{http_code}\\n" localhost; sleep 5; done', 'ループで記録']] },

      /* ---------------------------------------------------------------- services & logs */
      { q: 'サービスの状態を確認する', k: '動いているか 起動しているか active', do: [['systemctl status nginx', '状態と直近のログ'], ['systemctl is-active nginx', 'スクリプト向け（active/inactive）'], ['systemctl list-units --type=service --state=running', '動いているサービス']] },
      { q: 'サービスを再起動・再読み込みする', k: 'restart reload 反映', do: [['sudo systemctl restart nginx', '再起動（接続が切れる）'], ['sudo systemctl reload nginx', '設定だけ再読み込み（対応していれば）']], note: '設定を変えたら、先に構文チェック（nginx -t など）をしてから反映する。' },
      { q: 'サーバー起動時にサービスを自動起動する', k: 'enable 自動起動 ブート', do: [['sudo systemctl enable --now nginx', '有効化して今すぐ起動'], ['systemctl is-enabled nginx', '確認']] },
      { q: '起動に失敗したサービスの原因を調べる', k: 'failed 起動しない エラー', do: [['systemctl --failed', '失敗しているユニット'], ['journalctl -xeu nginx', 'そのサービスのログ（説明付き・末尾）'], ['systemctl cat nginx', 'ユニットファイルの中身']] },
      { q: 'サービスのログを見る', k: 'journal 過去 時間指定', do: [['journalctl -u nginx --since "1 hour ago"', '直近 1 時間'], ['journalctl -u nginx -n 100 --no-pager', '最新 100 行'], ['journalctl -p err -b', '今回の起動以降のエラー']] },
      { q: 'ログをリアルタイムで見る', k: '追従 流れる tail -f 監視', do: [['tail -f /var/log/nginx/error.log', 'ファイルを追従'], ['journalctl -fu app', 'サービスのログを追従'], ['tail -f /var/log/syslog | grep --line-buffered ERROR', 'エラーだけ']] },
      { q: 'ログのエラー件数を数える・集計する', k: '何件 頻度 統計', do: [['grep -c ERROR app.log', 'エラー行の数'], ["grep ERROR app.log | awk '{print $5}' | sort | uniq -c | sort -rn | head", 'エラーの種類ごと'], ["awk '{print $9}' access.log | sort | uniq -c | sort -rn", 'HTTP ステータスごと']] },
      { q: '重複した行を取り除く・数える', k: 'ユニーク 一意 重複排除 sort uniq', do: [['sort list.txt | uniq', '並べてから連続する重複をまとめる'], ['sort -u list.txt', '同じ結果を 1 コマンドで'], ['sort list.txt | uniq -c | sort -rn', '出現回数の多い順'], ['sort list.txt | uniq -d', '重複している行だけ']], note: 'uniq は「隣り合う」重複しかまとめないので、先に sort するのが定石。' },
      { q: 'アクセスログから多い IP アドレスを集計する', k: 'アクセス元 攻撃 ランキング', do: [["awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head", '上位 10'], ['grep " 404 " /var/log/nginx/access.log | wc -l', '404 の件数']] },
      { q: 'ユニットファイルを編集したら反映する', k: 'daemon-reload service ファイル', do: [['sudo systemctl daemon-reload', 'systemd に読み直させる'], ['sudo systemctl restart app', 'サービスに反映']] },
      { q: '設定ファイルの文法をチェックする', k: '構文 検査 syntax test', do: [['sudo nginx -t', 'nginx'], ['sudo apachectl configtest', 'Apache'], ['sudo visudo -c', 'sudoers'], ['sudo findmnt --verify', '/etc/fstab']] },
      { q: 'サーバーの起動が遅い原因を調べる', k: 'ブート 時間', do: [['systemd-analyze', '起動時間の合計'], ['systemd-analyze blame | head', '時間のかかったサービス']] },
      { q: 'カーネルのエラーや OOM を確認する', k: 'ハードウェア ディスク エラー oom killer', do: [['dmesg -T | tail -30', '最近のカーネルメッセージ'], ["dmesg -T | grep -i -E 'oom|i/o error'", 'OOM・I/O エラー'], ['journalctl -k -p err', 'カーネルのエラーだけ']] },
      { q: 'クラッシュしたプロセスを調べる', k: 'coredump segfault 落ちた', do: [['coredumpctl list', 'コアダンプ一覧'], ['journalctl -p err --since today', '今日のエラー']] },

      /* ---------------------------------------------------------------- schedule */
      { q: 'コマンドを定期的に自動実行する', k: '毎日 毎時 cron 定期実行', do: [['crontab -e', '編集（例: 0 3 * * * /usr/local/bin/backup.sh）'], ['crontab -l', '設定の確認'], ['grep CRON /var/log/syslog | tail', '実行されたかの確認（Ubuntu）']], note: '書式は「分 時 日 月 曜日 コマンド」。cron は PATH が短いので、コマンドは絶対パスで書く。' },
      { q: '指定した時刻に 1 回だけ実行する', k: '予約 後で 夜間', do: [['echo "systemctl restart app" | sudo at 03:00', '3 時に 1 回'], ['atq', '予約一覧'], ['atrm 3', '予約 3 を取り消し']] },

      /* ---------------------------------------------------------------- network */
      { q: 'サーバーの IP アドレスを確認する', k: '自分のip アドレス', do: [['ip -br a', 'インターフェースごとに簡潔に'], ['hostname -I', 'IP だけ'], ['ip -4 addr show eth0', '特定の NIC']] },
      { q: 'デフォルトゲートウェイ・経路を確認する', k: 'ルーティング 外に出られない', do: [['ip r', '経路表（default via が出口）'], ['ip route get 8.8.8.8', 'その宛先にどの NIC・経路で出るか']] },
      { q: '相手のサーバーに通信できるか確認する', k: '疎通 つながらない 届かない ping', do: [['ping -c 3 10.0.1.20', 'IP レベルで届くか'], ['nc -zv 10.0.1.20 5432', 'そのポートまで届くか'], ['traceroute -n 10.0.1.20', 'どこで止まるか']], note: 'ping が通らなくても ICMP を遮断しているだけのことがある。最後はポート単位（nc / curl）で確かめる。' },
      { q: 'リモートのポートが開いているか確認する', k: 'ポート疎通 telnet 接続確認', do: [['nc -zv db01 5432', 'つながれば succeeded'], ['curl -v telnet://db01:5432', 'nc がない環境で'], ['nmap -p 22,80,443 web01', '複数ポートをまとめて（許可された範囲で）']] },
      { q: '名前解決できるか確認する', k: 'dns 引けない nxdomain hosts', do: [['dig +short api.example.com', 'DNS サーバーの答え'], ['getent hosts api.example.com', '/etc/hosts も含めた実際の答え'], ['resolvectl status', 'どの DNS サーバーを使っているか']], note: 'dig は /etc/hosts を見ない。アプリと同じ結果を見るなら getent。' },
      { q: 'Web サーバー・API の応答を確認する', k: 'http ステータス ヘルスチェック curl', do: [['curl -sI http://localhost/', 'ヘッダーだけ（ステータス行）'], ["curl -s -o /dev/null -w '%{http_code} %{time_total}s\\n' http://localhost/health", 'ステータスと応答時間'], ['curl -s http://localhost:8080/health | jq .', 'JSON を整形']] },
      { q: 'SSL 証明書の有効期限を確認する', k: 'tls https 期限切れ 更新', do: [['openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null | openssl x509 -noout -enddate', 'サーバーの証明書の期限'], ['openssl x509 -in /etc/ssl/certs/server.crt -noout -subject -enddate', 'ファイルの証明書']] },
      { q: 'パケットをキャプチャして通信を確認する', k: 'tcpdump 届いているか 通信内容', do: [['sudo tcpdump -nn -i eth0 port 443', '443 番の通信'], ['sudo tcpdump -nn -i any host 10.0.1.20 -c 20', '特定ホストとの通信を 20 個'], ['sudo tcpdump -i eth0 -w cap.pcap', '保存して Wireshark で見る']] },
      { q: 'ファイアウォールでポートを開ける', k: 'ポート開放 許可 穴あけ', do: [['sudo ufw allow 8080/tcp', 'Ubuntu（ufw）'], ['sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload', 'RHEL（firewalld）'], ['sudo ss -tlnp | grep 8080', 'アプリが待ち受けているかも確認']] },
      { q: 'ファイアウォールの設定を確認する', k: 'ルール 遮断 ブロック', do: [['sudo ufw status numbered', 'Ubuntu'], ['sudo firewall-cmd --list-all', 'RHEL'], ['sudo iptables -L -n -v', 'netfilter のルールそのもの']] },
      { q: 'IP アドレスを固定で設定する', k: '静的ip 変更 ネットワーク設定', do: [['sudo vi /etc/netplan/50-cloud-init.yaml', 'Ubuntu: netplan の YAML を編集'], ['sudo netplan try', '試しに適用（確認しないと元に戻る）'], ['sudo nmcli con mod eth0 ipv4.addresses 10.0.1.10/24 ipv4.gateway 10.0.1.1 ipv4.method manual && sudo nmcli con up eth0', 'RHEL: nmcli']] },
      { q: 'NIC のリンク状態やエラーを確認する', k: 'リンクダウン パケットロス 速度', do: [['ip -s link show eth0', '送受信とエラー・ドロップ数'], ['sudo ethtool eth0', 'リンク・速度・全二重']] },
      { q: 'ネットワークの帯域を測る', k: '速度 スループット 遅い', do: [['iperf3 -s', '片方でサーバー'], ['iperf3 -c 10.0.1.20 -t 10', 'もう片方から 10 秒測定']] },
      { q: 'hosts ファイルで名前解決を追加する', k: '/etc/hosts 名前 ip 対応', do: [['echo "10.0.1.30 db01" | sudo tee -a /etc/hosts', '追記'], ['getent hosts db01', '確認']] },

      /* ---------------------------------------------------------------- remote */
      { q: 'SSH を鍵認証でログインできるようにする', k: 'パスワードなし 公開鍵 authorized_keys', do: [['ssh-keygen -t ed25519 -C "alice@work"', '鍵ペアを作る'], ['ssh-copy-id -i ~/.ssh/id_ed25519.pub app@web01', 'サーバーに公開鍵を登録'], ['ssh app@web01', 'パスワードなしで入れるか確認']] },
      { q: 'リモートサーバーでコマンドを実行する', k: 'ssh 一括 複数台', do: [["ssh web01 'df -h /'", '1 台で実行'], ['for h in web01 web02; do echo "== $h"; ssh "$h" uptime; done', '複数台に順に']] },
      { q: '踏み台サーバー経由で接続する', k: 'bastion jump proxyjump', do: [['ssh -J bastion web01', '踏み台を経由'], ['scp -J bastion app.tgz web01:/tmp/', '経由してコピー']] },
      { q: 'サーバー再構築後の SSH 接続エラーを直す', k: 'host key verification failed known_hosts', do: [['ssh-keygen -R web01', '古いホスト鍵を削除'], ['ssh-keyscan -t ed25519 web01 >> ~/.ssh/known_hosts', '新しい鍵を登録']], note: '本当に再構築したサーバーか確認してから削除する（なりすましの警告のことがある）。' },

      /* ---------------------------------------------------------------- disks & storage */
      { q: 'ディスクとパーティションの構成を確認する', k: 'デバイス 一覧 sda sdb', do: [['lsblk -f', '構成・ファイルシステム・マウント先'], ['sudo fdisk -l', 'パーティションの詳細'], ['sudo blkid', 'UUID']] },
      { q: '新しいディスクをフォーマットしてマウントする', k: 'ディスク追加 増設 fstab', do: [['sudo parted -s /dev/sdb mklabel gpt mkpart data xfs 1MiB 100%', 'パーティション作成'], ['sudo mkfs.xfs /dev/sdb1', 'ファイルシステム作成'], ['sudo mkdir -p /data && sudo mount /dev/sdb1 /data', 'マウント'], ['sudo blkid /dev/sdb1', 'UUID を調べて /etc/fstab に書く']] },
      { q: '再起動後もマウントされるようにする', k: 'fstab 永続化 自動マウント', do: [['sudo blkid /dev/sdb1', 'UUID を確認'], ["echo 'UUID=xxxx /data xfs defaults,nofail 0 0' | sudo tee -a /etc/fstab", 'fstab に追記'], ['sudo mount -a && findmnt /data', '書いた内容でマウントできるか確認']], note: 'fstab の誤りは起動不能につながる。mount -a で確認してから再起動する。' },
      { q: 'マウントを外せない（target is busy）', k: 'umount できない 使用中', do: [['sudo fuser -vm /data', '使っているプロセス'], ['sudo lsof +f -- /data', '開いているファイル'], ['cd /', '自分がその中にいないか']] },
      { q: 'LVM の論理ボリュームを拡張する', k: '容量追加 増やす lvextend', do: [['sudo vgs', 'VG の空き（VFree）を確認'], ['sudo lvextend -r -L +10G /dev/vg0/data', '10G 増やしてファイルシステムも拡張'], ['df -h /data', '確認']] },
      { q: 'クラウドでディスクを拡張した後に OS 側を広げる', k: 'ebs 拡張 growpart resize', do: [['lsblk', 'ディスクだけ大きくなっていることを確認'], ['sudo growpart /dev/xvda 1', 'パーティションを拡張'], ['sudo xfs_growfs /', 'XFS の場合'], ['sudo resize2fs /dev/xvda1', 'ext4 の場合']] },
      { q: 'スワップを追加する', k: 'swapfile メモリ不足', do: [['sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile', 'ファイル確保'], ['sudo mkswap /swapfile && sudo swapon /swapfile', '有効化'], ['swapon --show', '確認（永続化は fstab）']] },
      { q: 'ファイルシステムを検査・修復する', k: '壊れた 読めない fsck', do: [['sudo umount /data', '先にアンマウント'], ['sudo e2fsck -f /dev/sdb1', 'ext4'], ['sudo xfs_repair /dev/sdb1', 'XFS']] },

      /* ---------------------------------------------------------------- system */
      { q: 'OS とカーネルのバージョンを確認する', k: 'ディストリビューション ubuntu rhel 版', do: [['cat /etc/os-release', 'OS の種類と版'], ['uname -r', 'カーネル'], ['hostnamectl', 'まとめて']] },
      { q: 'CPU とメモリの搭載量を確認する', k: 'スペック コア数', do: [['nproc', 'CPU 数'], ['lscpu', 'CPU の詳細'], ['free -h', 'メモリ']] },
      { q: 'カーネルパラメータを確認・変更する', k: 'sysctl ip_forward 永続化', do: [['sysctl net.ipv4.ip_forward', '確認'], ['echo "net.ipv4.ip_forward = 1" | sudo tee /etc/sysctl.d/99-forward.conf', '永続化の設定'], ['sudo sysctl --system', '反映']] },
      { q: 'カーネルモジュールを読み込む', k: 'ドライバ modprobe br_netfilter overlay', do: [['lsmod | grep br_netfilter', '読み込まれているか'], ['sudo modprobe br_netfilter', '読み込み'], ['echo br_netfilter | sudo tee /etc/modules-load.d/k8s.conf', '起動時にも読み込む']] },
      { q: 'サーバーを再起動・停止する', k: 'reboot shutdown 予約 メンテナンス', do: [["sudo shutdown -r +10 'メンテナンスのため再起動します'", '10 分後（ログイン中の人に告知）'], ['sudo shutdown -c', '予約の取り消し'], ['sudo reboot', '今すぐ再起動']] },
      { q: '時刻とタイムゾーンを確認・設定する', k: '時間がずれている ntp jst', do: [['timedatectl', '時刻・タイムゾーン・NTP 同期'], ['sudo timedatectl set-timezone Asia/Tokyo', '日本時間に'], ['chronyc tracking', 'NTP とのずれ']] },
      { q: 'ホスト名を変更する', k: 'hostname 名前', do: [['sudo hostnamectl set-hostname web01', '変更'], ['hostnamectl', '確認']] },
      { q: '日本語のロケールに設定する', k: '文字化け 言語 ja_jp', do: [['locale', '現在の設定'], ['sudo locale-gen ja_JP.UTF-8', '生成（Ubuntu）'], ['sudo localectl set-locale LANG=ja_JP.UTF-8', '既定に']] },

      /* ---------------------------------------------------------------- packages */
      { q: 'パッケージをインストールする', k: 'ソフト 入れる apt dnf', do: [['sudo apt update && sudo apt install -y nginx', 'Ubuntu/Debian'], ['sudo dnf install -y nginx', 'RHEL']] },
      { q: 'パッケージがインストール済みか・バージョンを確認する', k: '入っているか 版', do: [['dpkg -l | grep nginx', 'Ubuntu'], ['rpm -qa | grep nginx', 'RHEL'], ['nginx -v', 'コマンド自身に聞く']] },
      { q: 'このファイル・コマンドはどのパッケージか調べる', k: '入っていない コマンドがない 提供元', do: [['dpkg -S /usr/bin/dig', 'Ubuntu（インストール済み）'], ['dnf provides /usr/bin/dig', 'RHEL（未インストールでも）'], ['rpm -qf /etc/ssh/sshd_config', 'RHEL（インストール済み）']] },
      { q: 'パッケージをまとめて更新する', k: 'アップデート セキュリティ更新', do: [['sudo apt update && sudo apt upgrade -y', 'Ubuntu'], ['sudo dnf upgrade -y', 'RHEL']] },

      /* ---------------------------------------------------------------- shell & text */
      { q: 'コマンドがどこにあるか・何者か調べる', k: '場所 path 実体 エイリアス', do: [['type -a ls', '別名・関数・ファイルを全部'], ['which python3', '実体の場所'], ['command -v docker', 'スクリプトで存在確認']] },
      { q: 'コマンド名がわからないときに探す', k: 'キーワード 検索 調べる マニュアル', do: [['apropos ポート', 'やりたいことから探す（このシミュレータは日本語可）'], ['man -k partition', '英語のキーワードで'], ['whatis ss', '一行説明']] },
      { q: '環境変数を確認・設定する', k: 'path export 変数', do: [['env | sort', '一覧'], ['echo $PATH', '特定の変数'], ['export PATH="$PATH:/opt/app/bin"', 'このシェルで追加'], ["echo 'export EDITOR=vim' >> ~/.bashrc", '次回以降も（source ~/.bashrc で今すぐ）']] },
      { q: 'よく使うコマンドを短くする', k: 'alias 別名 短縮', do: [["alias k=kubectl", 'このシェルで'], ["echo \"alias ll='ls -alF'\" >> ~/.bashrc && source ~/.bashrc", '永続化']] },
      { q: '過去に実行したコマンドを探して再実行する', k: '履歴 history ctrl+r', do: [['history | grep ssh', '探す'], ['!!', '直前のコマンドを再実行'], ['sudo !!', '直前のコマンドを sudo 付きで']] },
      { q: 'コマンドの出力を画面に出しつつファイルにも保存する', k: 'ログ 記録 tee リダイレクト', do: [['./deploy.sh 2>&1 | tee deploy.log', '標準エラーも含めて'], ['./job.sh > job.log 2>&1', '画面に出さずにファイルだけ']] },
      { q: '直前のコマンドが成功したか確かめる', k: '終了コード exit status', do: [['echo $?', '0 なら成功'], ['make && echo OK || echo NG', '成否で分岐']] },
      { q: '作業内容をすべて記録する', k: '証跡 作業ログ 監査', do: [['script -a ~/work-$(date +%F).log', '端末の入出力を記録（exit で終了）']] },
      { q: 'JSON から必要な値を取り出す', k: 'jq パース api 結果', do: [['curl -s http://localhost:8080/health | jq .', '整形'], ["jq -r '.items[].name' data.json", '配列の各要素の name'], ["jq '.[] | select(.status==\"error\")' events.json", '条件で絞り込み']] },
      { q: 'CSV の特定の列を取り出す', k: '列 カンマ区切り 抽出', do: [['cut -d, -f1,3 data.csv', '1 列目と 3 列目'], ["awk -F, '$3 > 100 {print $1}' data.csv", '条件付き'], ['column -t -s, data.csv | head', '表形式で確認']] },
      { q: 'Windows で作ったファイルの文字化け・改行コードを直す', k: 'shift_jis crlf ^m 文字コード', do: [['file data.csv', '文字コードと改行の種類を確認'], ['iconv -f SHIFT_JIS -t UTF-8 data.csv > data-utf8.csv', '文字コードを UTF-8 に'], ["tr -d '\\r' < script.sh > script-unix.sh", 'CRLF を LF に']] },
      { q: '日付入りのファイル名を作る', k: 'タイムスタンプ バックアップ名', do: [['cp app.conf app.conf.$(date +%Y%m%d-%H%M)', '日時付きでコピー'], ['tar czf backup-$(date +%F).tgz /etc', '日付付きアーカイブ']] },
      { q: 'ファイルが壊れていないか（改ざん）確認する', k: 'ハッシュ チェックサム 一致', do: [['sha256sum app.tgz', 'ハッシュ値を計算'], ['sha256sum -c SHA256SUMS', '配布元の一覧と照合']] },
      { q: 'ランダムなパスワードを作る', k: '乱数 生成 文字列', do: [['openssl rand -base64 24', '英数記号の乱数'], ['openssl rand -hex 16', '16 進']] },
      { q: 'Base64 をエンコード・デコードする', k: 'secret 変換', do: [["echo -n 'p@ss' | base64", 'エンコード（-n で改行なし）'], ["echo 'cEBzcw==' | base64 -d", 'デコード']] },
      { q: 'スクリプトを安全に書く・デバッグする', k: 'エラーで止める set -e デバッグ', do: [['set -euo pipefail', 'エラー・未定義変数・パイプ途中の失敗で止める'], ['bash -n deploy.sh', '文法チェックだけ'], ['bash -x deploy.sh', '実行内容を表示']] },
      { q: 'ファイルを 1 行ずつ読んで処理する', k: 'ループ while read 一括', do: [['while read -r host; do ping -c1 -W1 "$host" >/dev/null && echo "$host OK"; done < hosts.txt', '1 行ずつ'], ['xargs -I{} ssh {} uptime < hosts.txt', 'xargs で']] },

      /* ---------------------------------------------------------------- middleware */
      { q: 'nginx の設定を変更して反映する', k: 'web サーバー reload 設定変更', do: [['sudo vi /etc/nginx/conf.d/app.conf', '編集'], ['sudo nginx -t', '構文チェック'], ['sudo systemctl reload nginx', '接続を切らずに反映']] },
      { q: 'Apache のモジュール・サイトを有効にする', k: 'a2enmod rewrite ssl バーチャルホスト', do: [['sudo a2enmod rewrite', 'モジュール'], ['sudo a2ensite app.conf', 'サイト'], ['sudo apachectl configtest && sudo systemctl reload apache2', '検査して反映']] },
      { q: 'データベースに接続できるか確認する', k: 'db mysql postgres 接続確認', do: [['nc -zv db01 5432', 'まずポートまで届くか'], ["psql -h db01 -U app -d appdb -c 'select 1'", 'PostgreSQL'], ["mysql -h db01 -u app -p -e 'select 1'", 'MySQL']] },
      { q: 'Redis の疎通とメモリ使用量を確認する', k: 'キャッシュ ping', do: [['redis-cli -h cache01 ping', 'PONG が返れば OK'], ['redis-cli -h cache01 info memory', 'メモリ']] },
      { q: '設定ファイルの変更履歴を管理する', k: 'git 差分 戻す バージョン管理', do: [['git status', '変更されたファイル'], ['git diff', '差分'], ['git log --oneline -5', '履歴'], ['git restore app.conf', '変更を取り消す']] },
      { q: 'その場で簡単な Web サーバーを立てる', k: 'テスト 動作確認 ファイル配布', do: [['python3 -m http.server 8000', 'カレントディレクトリを 8000 番で公開'], ['nc -l 9000', '9000 番で待ち受けるだけ（疎通確認用）', 1]] },
    ],
  });
})(globalThis.IG = globalThis.IG || {});
