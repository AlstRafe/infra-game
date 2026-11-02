# Linux シミュレータ対応表

CoreLab の Linux はブラウザ内のシミュレーションです。インフラ運用でよく使う範囲について、実機（Ubuntu 22.04 / 24.04、RHEL 9）と同じ書式・出力・エラーメッセージ・終了コードになるよう作り込んでいます。網羅性のチェックには LPIC-1（101/102）と LFCS（Operations / Networking / Storage / Essential Commands / Users & Groups）の出題範囲を使いました。

- 実装コマンド数: 約 365（シェル組み込みを除く）
- 回帰テスト: `node tests/run-linux.js`（約 400 件、実機の出力と照合）
- 練習場所: フリーラボの `ssh lab-ubuntu`（Ubuntu 24.04・未使用の 20GB ディスク付き）と `ssh lab-rhel`（RHEL 9・LVM 構成・10GB ディスク付き）

凡例: ✅ 対応 / △ 一部対応（制限あり） / ❌ 非対応（理由つき）

## シェル（bash 5.1 相当）

| 機能                                                                    | 状態 | 備考                                                               |
| ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------ |
| 変数・`export`・`unset`・`readonly`・`local`・`declare`                 | ✅   | `export` しない変数は子プロセス（`bash -c`、スクリプト）に渡らない |
| `${var:-x}` `${#v}` `${v%.*}` `${v//a/b}` `${v:0:3}` `${v^^}` など      | ✅   |                                                                    |
| `$(...)`・バッククォート・`$((...))`・`((...))`・`let`                  | ✅   |                                                                    |
| ブレース展開・`~`・グロブ・単語分割・クォート                           | ✅   | 一致しないグロブはそのまま残る（bash と同じ）                      |
| `if`・`for`（リスト/C 形式）・`while`・`until`・`case`・関数・`return`  | ✅   |                                                                    |
| `[ ]`・`test`・`[[ ]]`（パターン・`=~` と `BASH_REMATCH`）              | ✅   |                                                                    |
| パイプ・`&&`・`\|\|`・`;`・`!`・`\|&`・サブシェル `( )`・グループ `{ }` | ✅   |                                                                    |
| リダイレクト（`>` `>>` `<` `2>` `2>&1` `&>`）・ヒアドキュメント・`<<<`  | ✅   | `sudo echo x > /etc/f` が失敗するのも実機どおり                    |
| `read`（パイプ・ヒアドキュメント・`while read`）                        | ✅   | キーボードからの対話入力は ❌                                      |
| 履歴（`history`・`!!`・`!n`・`!$`・Ctrl+R）・`alias`・`source`・`type`  | ✅   |                                                                    |
| `set -e / -x / -u / -o pipefail`・複数行入力・Tab 補完                  | ✅   |                                                                    |
| スクリプト実行（shebang・`chmod +x`・`bash -x`）                        | ✅   | Python・Perl・Node は ❌（案内を表示）                             |
| バックグラウンド `&`・`jobs`・`kill %1`                                 | △    | 即座に完了扱い。`fg` での再開は表示のみ                            |

## ファイル・権限

| 機能                                                                                       | 状態 | 備考                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ls`・`cp`・`mv`・`rm`・`mkdir -p`・`ln -s`・`link`/`unlink`・`install`・`mkfifo`・`shred` | ✅   | `rm -rf /` は実機同様に拒否                                                                                                                            |
| パーミッション（rwx・所有者・グループ・umask・sticky bit）での拒否                         | ✅   | `/etc/shadow`・`/root` は一般ユーザーから読めない                                                                                                      |
| `chmod`（数値・記号）・`chown`・`chgrp`（-R）                                              | ✅   |                                                                                                                                                        |
| ACL（`setfacl -m/-x/-b/-d/-R`・`getfacl`）                                                 | ✅   | 名前付きユーザー/グループ・マスク・既定 ACL の継承まで権限判定に反映。`ls -l` の `+` 表示あり。Ubuntu では `sudo apt install acl` が必要（実機どおり） |
| `chattr +i / +a`・`lsattr`                                                                 | ✅   | `+i` は root でも書き込み・削除不可（Operation not permitted）。`+a` はリダイレクトの追記のみ許可し、削除を拒否                                        |
| `stat`・`file`・`du`・`find`（-name -type -size -mtime -user -perm -exec -delete …）       | ✅   |                                                                                                                                                        |
| `md5sum`・`sha1sum`・`sha256sum`・`sha384sum`・`sha512sum`・`cksum`（実際の値・`-c` 検証） | ✅   |                                                                                                                                                        |
| `tar`（c/x/t・z/j/J・-C・--exclude）・`gzip`・`xz`・`bzip2`・`zstd`・`zip`/`unzip`         | ✅   | 中身はシミュレータ独自形式（`file` での判別は実機どおり）                                                                                              |
| `od`・`xxd`（-p -r -i）・`hexdump -C`                                                      | ✅   |                                                                                                                                                        |
| `vi`/`vim`/`nano`                                                                          | △    | 画面上のエディタで編集（`:wq` `:q!`）。vim のノーマルモード操作は ❌                                                                                   |
| `less`/`more`                                                                              | △    | 全文表示（ページ送り・検索なし）                                                                                                                       |

## テキスト処理

| 機能                                                                                                                     | 状態 | 備考                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------ |
| `grep`（-i -v -n -c -l -r -E -F -P -w -o -A/-B/-C -q）・カラー表示                                                       | ✅   |                                                  |
| `sed`（s///・アドレス・範囲・d p a i c y q・-n -i -E・ホールドスペース）                                                 | ✅   |                                                  |
| `awk`（BEGIN/END・連想配列・制御構文・printf・split/sub/gsub/match・-F -v）                                              | ✅   | `getline` は ❌                                  |
| `sort`・`uniq`・`cut`・`paste`・`tr`・`wc`・`head`・`tail`・`join`・`split`・`comm`・`column`・`fmt`・`nl`・`tac`・`rev` | ✅   | `tail -f` は現時点の内容のみ                     |
| `diff`（-u -q）・`cmp`・`xargs`・`tee`・`printf`・`seq`・`expr`・`bc`・`numfmt`・`factor`                                | ✅   |                                                  |
| `jq`                                                                                                                     | △    | 実務でよく使う範囲（`if/then/else` 等は ❌）     |
| `iconv`（-f -t -l・ASCII 変換時の illegal input 検出）                                                                   | △    | 変換表は持たず、文字コードの判定とエラーのみ再現 |
| `date`（+書式・-d）・`base64`・`strings`（binutils 導入後）                                                              | ✅   |                                                  |

## ユーザー・権限昇格

| 機能                                                                                                                        | 状態 | 備考                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `whoami`・`id`・`groups`・`who`・`w`・`last`・`lastb`・`getent`・`logname`・`tty`                                           | ✅   |                                                                                    |
| `sudo`（-i -u -l）・sudo 権限なしの拒否と auth.log 記録                                                                     | ✅   | NOPASSWD 設定（クラウド既定）。パスワード入力は ❌                                 |
| `useradd`・`usermod -aG`・`userdel -r`・`groupadd`・`gpasswd`・`chpasswd`・`passwd -l/-u/-S`・`chage`・`chsh -s`・`chfn -f` | ✅   | `/etc/passwd` `/etc/group` `/etc/shadow` に反映。`chsh` は `/etc/shells` を検証    |
| `su - user`（root から）                                                                                                    | ✅   | 一般ユーザーからはパスワードが必要なため ❌（`sudo su -` を案内）                  |
| `passwd`（対話）・`visudo`                                                                                                  | △    | 対話入力は再現できないため `chpasswd` を案内。visudo は編集と簡易構文チェック      |
| グループ追加の反映タイミング                                                                                                | ❌   | 実機では再ログインまで新しいグループが効かないが、シミュレータでは即時に反映される |

## プロセス・サービス・ログ・ジョブ

| 機能                                                                                                                         | 状態 | 備考                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ps`・`pgrep`・`pidof`・`pstree`・`kill`・`pkill`・`killall`・`nice`・`renice`・`pmap`・`ionice -p`・`taskset -p`・`chrt -p` | ✅   |                                                                                                                                        |
| `top`・`htop`・`watch`                                                                                                       | △    | 1 回分のスナップショットを表示                                                                                                         |
| `systemctl`（status/start/stop/restart/reload/enable/disable/--now/mask/cat/show/daemon-reload/--failed）                    | ✅   | 自作ユニットも起動可。ExecStart 不備は 203/EXEC で失敗                                                                                 |
| `journalctl`（-u -n -f -e -x -p -k -r --since）・`logger`・syslog/auth.log・`logrotate`                                      | ✅   | `-f` は現時点まで表示                                                                                                                  |
| `crontab`（-l -e -r・書式検証）・`at`/`atq`/`atrm`（at 導入後）                                                              | △    | 登録・一覧・削除は可能。時刻になってもジョブは実行されない                                                                             |
| `reboot`・`shutdown -r`                                                                                                      | ✅   | enable 済みのサービスだけ起動し、マウントは fstab から復元。nofail のない壊れた fstab 行は警告（実機は emergency mode で起動が止まる） |
| `loginctl`（list-sessions / enable-linger）・`systemd-run`・`coredumpctl`・`udevadm`                                         | △    | 表示と基本操作のみ                                                                                                                     |
| `sar`（-u -r -q -b -n・間隔指定）・`pidstat`・`iostat`・`vmstat`・`mpstat`（sysstat 導入後）                                 | ✅   | Ubuntu は収集無効が既定のため `sar` 単体はエラー（実機どおり）                                                                         |

## パッケージ

| 機能                                                                                           | 状態 | 備考                                                                               |
| ---------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `apt`/`apt-get`（update・install・remove・purge・list・search・show・policy）・`dpkg -l/-L/-S` | ✅   | 導入するとコマンドが使えるようになり、nginx・apache2・redis 等はサービスとして起動 |
| `dnf`/`yum`・`rpm -qa/-q/-qf/-ql/-qi`                                                          | ✅   |                                                                                    |
| 未導入コマンドの案内（Ubuntu の command-not-found）                                            | ✅   | 例: `strings` → `sudo apt install binutils`、`nmcli` → `network-manager`           |
| 実際のパッケージの中身・依存解決                                                               | ❌   | 収録カタログ内のパッケージのみ                                                     |

## ネットワーク

| 機能                                                                                                                              | 状態 | 備考                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ip a/link/route/neigh`・`hostname -I`・`ifconfig`・`ethtool`（-i -S）                                                            | ✅   |                                                                                                                                               |
| `ss`・`netstat`・`lsof -i`・`fuser`                                                                                               | ✅   |                                                                                                                                               |
| `ping`・`traceroute`・`tracepath`・`mtr --report`・`arping`・`dig`・`host`・`nslookup`・`resolvectl`                              | ✅   | `/etc/hosts` は ping/curl/getent に効き、dig/host には効かない（実機どおり）                                                                  |
| `curl`・`wget`・`nc -zv`・`telnet`・`openssl s_client`                                                                            | ✅   | 外部インターネットには出られない（`whois` もエラー）                                                                                          |
| `ssh`（config・known_hosts・リモートコマンド）・`scp`・`rsync`・`ssh-keygen`・`ssh-copy-id`・`ssh-keyscan`・`ssh-agent`/`ssh-add` | ✅   | 鍵認証のみ。秘密鍵のパーミッションが緩いと ssh-add が拒否                                                                                     |
| `ufw`・`iptables`・`firewall-cmd`（--permanent と --reload の違いを含む）                                                         | ✅   | 他ホストからの到達性に実際に反映                                                                                                              |
| `nmcli`（general/device/connection show・modify・up）・`netplan`（get/generate/try/apply/status）・`networkctl`                   | △    | 表示、設定値の保存、netplan の YAML 検証（未知のキー・パーミッション警告）まで。IP アドレス自体は変わらない（他ホストとの通信を壊さないため） |
| `ip addr add` など一時的なアドレス変更                                                                                            | ❌   | 案内を表示                                                                                                                                    |
| `tcpdump`・`nmap`                                                                                                                 | △    | 代表的な出力のみ                                                                                                                              |
| `openssl`（version・rand・passwd・genrsa・req -x509・x509 -text/-dates/-checkend・dgst）                                          | ✅   | シミュレータで作った証明書は内容を読み戻せる                                                                                                  |
| Web/DB サーバー（nginx・apache2 の `apache2ctl configtest`/`a2ensite`・`httpd -t`・`redis-cli`・`psql -l`）                       | △    | 起動・設定ファイル・ポートは反映。任意の SQL や redis の高度なコマンドは ❌                                                                   |

## ストレージ

| 機能                                                                                                                                                                     | 状態 | 備考                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `df`（-h -T -i）・`lsblk`（-f -o -p -d）・`blkid`（-s -o value）・`findmnt`（--verify）・`mount`・`umount`（使用中は busy）                                              | ✅   |                                                                                                                  |
| パーティション作成: `parted -s`（mklabel・mkpart・rm・resizepart・set）・`fdisk` へのパイプ入力（g/o/n/d/t/p/w）・`growpart`                                             | ✅   | `parted -l`・`fdisk -l` にも反映。fdisk の対話画面は ❌（パイプで入力）                                          |
| ファイルシステム: `mkfs.ext4`/`mkfs.xfs`（既存署名の確認・-F/-f）・`wipefs`・`e2label`・`e2fsck`・`xfs_repair`                                                           | ✅   | ルートディスクの変更は訓練環境では禁止                                                                           |
| LVM: `pvcreate`・`vgcreate`・`vgextend`・`vgreduce`・`lvcreate`（-L / -l 100%FREE）・`lvextend`（-r）・`lvreduce`・`lvremove`・`lvrename`・`pvs`/`vgs`/`lvs`・`*display` | ✅   | エクステント（4MiB）単位の計算、空き不足・使用中・確認プロンプト（-y）を再現。スナップショット・thin・RAID は ❌ |
| オンライン拡張: `resize2fs`・`xfs_growfs`                                                                                                                                | ✅   | LV を広げただけでは `df` は増えない。ext4 のオフライン縮小は e2fsck 必須、XFS は縮小不可（実機どおり）           |
| スワップ: `mkswap`（デバイス/ファイル）・`swapon`（--show -a）・`swapoff`・`free` への反映                                                                               | ✅   | スワップファイルのパーミッション警告あり                                                                         |
| `/etc/fstab`（UUID= / LABEL= / デバイス名・nofail・noauto）・`mount -a`・daemon-reload の警告                                                                            | ✅   |                                                                                                                  |

## システム情報・ロケール・時刻

| 機能                                                                                            | 状態 | 備考                                                                                      |
| ----------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `free`・`vmstat`・`uptime`・`uname`・`lscpu`・`lspci`・`dmidecode`・`getconf`・`ldd`・`hwclock` | ✅   |                                                                                           |
| `sysctl`（-a -w -p）と `/proc/sys`・`dmesg`・`lsmod`・`hostnamectl`・`timedatectl`・`chronyc`   | ✅   |                                                                                           |
| `locale`・`locale -a`・`locale-gen`・`localectl`（status / set-locale / list-locales）          | ✅   | 日本語ロケールは Ubuntu は `locale-gen`、RHEL は `glibc-langpack-ja` が必要（実機どおり） |

## 再現できないもの（シミュレーションの限界）

- 対話型の画面操作（vim の全機能、top/htop のキー操作、less のページ送り、tmux/screen、fdisk・parted の対話モード）
- キーボードからのパスワードや確認の入力（passwd、su、ssh のパスワード認証、`[y/n]` プロンプト）。代わりに `-y`・`-F`・`echo y |` などを案内します
- Python・Perl・Node など bash 以外の言語、git、コンパイル（gcc/make）
- 本物のネットワークとカーネル機能（インターネット・SELinux・cgroups・名前空間）
- 時間経過で動く処理（cron/at ジョブの実行、ログの継続出力）
- IP アドレスの実際の変更、グループ追加が再ログインまで効かない挙動
- ファイルの実データ（アーカイブ・圧縮ファイルの中身はシミュレータ独自形式）

上記を使おうとした場合は、可能な限り「ℹ 〜は未対応です。代わりに〜」という案内を表示します。
