/* Short manual pages / --help texts for the simulated commands (option lists are excerpts). */
(function (IG) {
  "use strict";
  const P = {};
  const def = (name, sec, desc, syn, opts, ja) => {
    P[name] = { sec, desc, syn, opts, ja };
  };
  // [name, section, description, synopsis, [[option, text]...], japanese note]
  def(
    "ls",
    1,
    "list directory contents",
    "ls [OPTION]... [FILE]...",
    [
      ["-a, --all", "do not ignore entries starting with ."],
      ["-A", "do not list implied . and .."],
      ["-l", "use a long listing format"],
      ["-h", "with -l, print sizes like 1K 234M 2G"],
      ["-t", "sort by time, newest first"],
      ["-S", "sort by file size, largest first"],
      ["-r", "reverse order while sorting"],
      ["-R", "list subdirectories recursively"],
      ["-d", "list directories themselves, not their contents"],
      ["-i", "print the index number of each file"],
      ["-F", "append indicator (one of */=>@|) to entries"],
      ["-1", "list one file per line"],
    ],
    IG.t("ファイル一覧。-l で権限・所有者・サイズ・更新日時を表示"),
  );
  def(
    "cd",
    1,
    "change the shell working directory (bash builtin)",
    "cd [-L|-P] [dir]",
    [
      ["-", "change to the previous directory ($OLDPWD)"],
      ["~", "change to your home directory"],
    ],
    IG.t("ディレクトリ移動（シェル組み込み）"),
  );
  def(
    "cp",
    1,
    "copy files and directories",
    "cp [OPTION]... SOURCE... DIRECTORY",
    [
      ["-r, -R", "copy directories recursively"],
      ["-a", "archive mode; same as -dR --preserve=all"],
      ["-p", "preserve mode, ownership, timestamps"],
      ["-v", "explain what is being done"],
      ["-n", "do not overwrite an existing file"],
    ],
    IG.t("コピー。ディレクトリは -r"),
  );
  def(
    "mv",
    1,
    "move (rename) files",
    "mv [OPTION]... SOURCE... DIRECTORY",
    [
      ["-v", "explain what is being done"],
      ["-n", "do not overwrite an existing file"],
      ["-f", "do not prompt before overwriting"],
    ],
    IG.t("移動・名前変更"),
  );
  def(
    "rm",
    1,
    "remove files or directories",
    "rm [OPTION]... [FILE]...",
    [
      ["-r, -R", "remove directories and their contents recursively"],
      ["-f", "ignore nonexistent files, never prompt"],
      ["-v", "explain what is being done"],
      ["-d", "remove empty directories"],
    ],
    IG.t("削除。元に戻せないので注意"),
  );
  def(
    "mkdir",
    1,
    "make directories",
    "mkdir [OPTION]... DIRECTORY...",
    [
      ["-p", "no error if existing, make parent directories as needed"],
      ["-m MODE", "set file mode (as in chmod)"],
      ["-v", "print a message for each created directory"],
    ],
    IG.t("ディレクトリ作成"),
  );
  def(
    "chmod",
    1,
    "change file mode bits",
    "chmod [OPTION]... MODE[,MODE]... FILE...",
    [
      ["-R", "change files and directories recursively"],
      ["-v", "output a diagnostic for every file processed"],
      ["MODE", "octal (e.g. 755, 640) or symbolic (u+x, go-w, a=r)"],
    ],
    IG.t("権限変更（rwx=421）"),
  );
  def(
    "chown",
    1,
    "change file owner and group",
    "chown [OPTION]... [OWNER][:[GROUP]] FILE...",
    [["-R", "operate on files and directories recursively"]],
    IG.t("所有者変更（通常 root 権限が必要）"),
  );
  def(
    "ln",
    1,
    "make links between files",
    "ln [OPTION]... TARGET LINK_NAME",
    [
      ["-s", "make symbolic links instead of hard links"],
      ["-f", "remove existing destination files"],
      ["-n", "treat LINK_NAME as a normal file if it is a symlink to a directory"],
    ],
    IG.t("リンク作成。シンボリックリンクは -s"),
  );
  def(
    "cat",
    1,
    "concatenate files and print on the standard output",
    "cat [OPTION]... [FILE]...",
    [
      ["-n", "number all output lines"],
      ["-A", "show all (tabs as ^I, line ends as $)"],
      ["-s", "suppress repeated empty output lines"],
    ],
    IG.t("ファイル内容を表示"),
  );
  def(
    "less",
    1,
    "opposite of more (pager)",
    "less [options] file...",
    [
      ["/pattern", "search forward (interactive)"],
      ["q", "quit"],
    ],
    IG.t("ページャ（シミュレータでは全文表示）"),
  );
  def(
    "head",
    1,
    "output the first part of files",
    "head [OPTION]... [FILE]...",
    [
      ["-n NUM", "print the first NUM lines (default 10)"],
      ["-c NUM", "print the first NUM bytes"],
    ],
    IG.t("先頭行"),
  );
  def(
    "tail",
    1,
    "output the last part of files",
    "tail [OPTION]... [FILE]...",
    [
      ["-n NUM", "output the last NUM lines; -n +NUM starts at line NUM"],
      ["-f", "output appended data as the file grows"],
      ["-c NUM", "output the last NUM bytes"],
    ],
    IG.t("末尾行。-f で追従"),
  );
  def(
    "grep",
    1,
    "print lines that match patterns",
    "grep [OPTION...] PATTERNS [FILE...]",
    [
      ["-i", "ignore case distinctions"],
      ["-v", "select non-matching lines"],
      ["-n", "print line number with output lines"],
      ["-c", "print only a count of matching lines"],
      ["-l", "print only names of FILEs with selected lines"],
      ["-r, -R", "read all files under each directory, recursively"],
      ["-E", "PATTERNS are extended regular expressions"],
      ["-F", "PATTERNS are strings"],
      ["-w", "match only whole words"],
      ["-x", "match only whole lines"],
      ["-o", "show only nonempty parts of lines that match"],
      ["-A/-B/-C NUM", "print NUM lines of trailing/leading/both context"],
      ["-q", "quiet; exit status only"],
      ["-e PATTERN", "use PATTERN for matching (repeatable)"],
    ],
    IG.t("文字列検索"),
  );
  def(
    "sed",
    1,
    "stream editor for filtering and transforming text",
    "sed [OPTION]... {script} [input-file]...",
    [
      ["-n", "suppress automatic printing of pattern space"],
      ["-i[SUFFIX]", "edit files in place (makes backup if SUFFIX supplied)"],
      ["-E, -r", "use extended regular expressions"],
      ["-e script", "add the script to the commands to be executed"],
      ["'s/old/new/g'", "substitute (g = all occurrences)"],
      ["'5d', '/re/d'", "delete line 5 / matching lines"],
      ["'2,4p'", "print lines 2-4 (with -n)"],
      ["'/re/a text'", "append text after matching line"],
    ],
    IG.t("置換・行の削除などのストリーム編集"),
  );
  def(
    "awk",
    1,
    "pattern scanning and processing language",
    "awk [-F fs] [-v var=value] 'program' [file ...]",
    [
      ["-F fs", "use fs for the input field separator"],
      ["-v var=val", "assign a variable before execution"],
      ["'{print $1}'", "print the first field"],
      ["'$3 > 100'", "print lines whose 3rd field is greater than 100"],
      ["'{s+=$2} END {print s}'", "sum a column"],
      ["'{c[$1]++} END {for (k in c) print k, c[k]}'", "count by key"],
      ["NR, NF, FS, OFS", "record number, number of fields, separators"],
    ],
    IG.t("列単位の集計・加工"),
  );
  def(
    "sort",
    1,
    "sort lines of text files",
    "sort [OPTION]... [FILE]...",
    [
      ["-n", "compare according to string numerical value"],
      ["-h", "compare human readable numbers (e.g., 2K 1G)"],
      ["-r", "reverse the result of comparisons"],
      ["-k POS1[,POS2]", "sort via a key"],
      ["-t SEP", "use SEP instead of non-blank to blank transition"],
      ["-u", "output only the first of an equal run"],
      ["-V", "natural sort of (version) numbers"],
    ],
    IG.t("並べ替え"),
  );
  def(
    "uniq",
    1,
    "report or omit repeated lines",
    "uniq [OPTION]... [INPUT [OUTPUT]]",
    [
      ["-c", "prefix lines by the number of occurrences"],
      ["-d", "only print duplicate lines"],
      ["-u", "only print unique lines"],
    ],
    IG.t("重複行の集約（事前に sort）"),
  );
  def(
    "cut",
    1,
    "remove sections from each line of files",
    "cut OPTION... [FILE]...",
    [
      ["-d DELIM", "use DELIM instead of TAB for field delimiter"],
      ["-f LIST", "select only these fields"],
      ["-c LIST", "select only these characters"],
    ],
    IG.t("列の切り出し"),
  );
  def(
    "tr",
    1,
    "translate or delete characters",
    "tr [OPTION]... SET1 [SET2]",
    [
      ["-d", "delete characters in SET1"],
      ["-s", "squeeze repeated characters"],
      ["-c", "use the complement of SET1"],
    ],
    IG.t("文字の置換・削除"),
  );
  def(
    "wc",
    1,
    "print newline, word, and byte counts",
    "wc [OPTION]... [FILE]...",
    [
      ["-l", "print the newline counts"],
      ["-w", "print the word counts"],
      ["-c", "print the byte counts"],
    ],
    IG.t("行数・単語数・バイト数"),
  );
  def(
    "find",
    1,
    "search for files in a directory hierarchy",
    "find [path...] [expression]",
    [
      ["-name PATTERN", "base of file name matches shell pattern"],
      ["-type f|d|l", "file is of type"],
      ["-size [+-]N[kMG]", "file uses more/less than N units of space"],
      ["-mtime [+-]N", "modified N*24 hours ago"],
      ["-user NAME", "file is owned by user"],
      ["-perm MODE", "permission bits"],
      ["-maxdepth N", "descend at most N levels"],
      ["-exec CMD {} \\;", "execute command on each file"],
      ["-delete", "delete files"],
      ["-print0", "print with NUL separators"],
    ],
    IG.t("ファイル検索"),
  );
  def(
    "xargs",
    1,
    "build and execute command lines from standard input",
    "xargs [OPTION]... [COMMAND [INITIAL-ARGS]...]",
    [
      ["-n MAX", "use at most MAX arguments per command line"],
      ["-I R", "replace R in INITIAL-ARGS with names read from input"],
      ["-0", "items are terminated by a null character"],
      ["-r", "do not run command if input is empty"],
    ],
    IG.t("標準入力を引数に変換"),
  );
  def(
    "tar",
    1,
    "an archiving utility",
    "tar [OPTION...] [FILE]...",
    [
      ["-c", "create a new archive"],
      ["-x", "extract files from an archive"],
      ["-t", "list the contents of an archive"],
      ["-z", "filter the archive through gzip"],
      ["-v", "verbosely list files processed"],
      ["-f ARCHIVE", "use archive file ARCHIVE"],
      ["-C DIR", "change to directory DIR"],
      ["--exclude=PATTERN", "exclude files matching PATTERN"],
    ],
    IG.t("アーカイブ（例: tar czf a.tgz dir / tar xzf a.tgz）"),
  );
  def(
    "gzip",
    1,
    "compress or expand files",
    "gzip [OPTION]... [FILE]...",
    [
      ["-d", "decompress"],
      ["-k", "keep (don't delete) input files"],
      ["-c", "write on standard output"],
      ["-l", "list compressed file contents"],
    ],
    IG.t("圧縮"),
  );
  def(
    "df",
    1,
    "report file system space usage",
    "df [OPTION]... [FILE]...",
    [
      ["-h", "print sizes in powers of 1024 (e.g., 1023M)"],
      ["-T", "print file system type"],
      ["-i", "list inode information instead of block usage"],
    ],
    IG.t("ディスク使用量（ファイルシステム単位）"),
  );
  def(
    "du",
    1,
    "estimate file space usage",
    "du [OPTION]... [FILE]...",
    [
      ["-s", "display only a total for each argument"],
      ["-h", "print sizes in human readable format"],
      ["-a", "write counts for all files"],
      ["-d N, --max-depth=N", "print totals only N levels deep"],
      ["-c", "produce a grand total"],
    ],
    IG.t("ディスク使用量（ディレクトリ単位）"),
  );
  def(
    "free",
    1,
    "Display amount of free and used memory in the system",
    "free [options]",
    [
      ["-h", "show human-readable output"],
      ["-m", "show output in mebibytes"],
    ],
    IG.t("メモリ使用量"),
  );
  def(
    "ps",
    1,
    "report a snapshot of the current processes",
    "ps [options]",
    [
      ["aux", "all processes in BSD format with user and %CPU/%MEM"],
      ["-ef", "all processes in full format"],
      ["-u USER", "select by effective user"],
      ["-p PID", "select by process ID"],
      ["-o FORMAT", "user-defined format, e.g. -o pid,ppid,cmd,%mem"],
      ["--sort=-%mem", "sort by memory usage, descending"],
    ],
    IG.t("プロセス一覧"),
  );
  def(
    "top",
    1,
    "display Linux processes",
    "top [options]",
    [
      ["-b", "batch mode"],
      ["-n N", "number of iterations"],
    ],
    IG.t("リソース監視（対話型。シミュレータは 1 回表示）"),
  );
  def(
    "kill",
    1,
    "send a signal to a process",
    "kill [-s signal|-signal] pid...",
    [
      ["-l", "list signal names"],
      ["-9, -KILL", "force kill"],
      ["-15, -TERM", "graceful termination (default)"],
      ["-1, -HUP", "hang up (often: reload configuration)"],
    ],
    IG.t("シグナル送信"),
  );
  def(
    "pkill",
    1,
    "look up or signal processes based on name",
    "pkill [options] pattern",
    [
      ["-f", "match against full argument lists"],
      ["-u USER", "match only processes of the user"],
      ["-9", "send SIGKILL"],
    ],
    IG.t("名前でプロセスにシグナル"),
  );
  def(
    "systemctl",
    1,
    "Control the systemd system and service manager",
    "systemctl [OPTIONS...] COMMAND [UNIT...]",
    [
      ["status UNIT", "show runtime status"],
      ["start|stop|restart|reload UNIT", "control a service"],
      ["enable|disable [--now] UNIT", "start at boot (and now)"],
      ["is-active|is-enabled UNIT", "check state (for scripts)"],
      ["list-units [--failed]", "list loaded units"],
      ["daemon-reload", "reload unit files after editing"],
      ["cat UNIT", "show the unit file"],
      ["mask|unmask UNIT", "prevent/allow starting"],
    ],
    IG.t("サービス管理（操作は sudo）"),
  );
  def(
    "journalctl",
    1,
    "Print log entries from the systemd journal",
    "journalctl [OPTIONS...] [MATCHES...]",
    [
      ["-u UNIT", "show logs from the specified unit"],
      ["-n N", "number of journal entries to show"],
      ["-f", "follow the journal"],
      ["-e", "jump to the end"],
      ["-x", "add explanatory help texts"],
      ["--since TIME", 'show entries not older than the date ("1 hour ago")'],
      ["-p PRIORITY", "filter by priority (err, warning, ...)"],
      ["-k", "show kernel messages"],
      ["-r", "reverse output"],
    ],
    IG.t("ログ閲覧"),
  );
  def(
    "ssh",
    1,
    "OpenSSH remote login client",
    "ssh [options] [user@]hostname [command]",
    [
      ["-i FILE", "identity (private key) file"],
      ["-p PORT", "port to connect to"],
      ["-l USER", "login name"],
    ],
    IG.t("リモートログイン。コマンドを付けるとリモート実行"),
  );
  def(
    "scp",
    1,
    "OpenSSH secure file copy",
    "scp [options] source ... target",
    [
      ["-r", "recursively copy entire directories"],
      ["-p", "preserves modification times and modes"],
      ["host:path", "remote file specification"],
    ],
    IG.t("リモートとのファイルコピー"),
  );
  def(
    "ssh-keygen",
    1,
    "OpenSSH authentication key utility",
    "ssh-keygen [-t ed25519|rsa] [-f file] [-N passphrase] [-C comment]",
    [
      ["-t TYPE", "key type (ed25519 recommended)"],
      ["-f FILE", "output key file"],
      ["-N PHRASE", "new passphrase ('' for none)"],
      ["-l -f FILE", "show fingerprint"],
    ],
    IG.t("鍵ペア生成"),
  );
  def(
    "curl",
    1,
    "transfer a URL",
    "curl [options] <url>",
    [
      ["-s", "silent mode"],
      ["-S", "show error even when -s is used"],
      ["-i", "include protocol response headers"],
      ["-I", "show document info only (HEAD)"],
      ["-v", "verbose"],
      ["-o FILE", "write to file"],
      ["-O", "write output to a file named as the remote file"],
      ["-L", "follow redirects"],
      ["-k", "allow insecure server connections"],
      ["-X METHOD", "specify request method"],
      ["-H HEADER", "pass custom header"],
      ["-d DATA", "HTTP POST data"],
      ["-w FORMAT", 'output format after completion, e.g. "%{http_code}"'],
      ["-f", "fail silently on HTTP errors"],
    ],
    IG.t("HTTP リクエスト"),
  );
  def(
    "wget",
    1,
    "The non-interactive network downloader",
    "wget [option]... [URL]...",
    [
      ["-O FILE", "write documents to FILE (- for stdout)"],
      ["-q", "quiet"],
      ["--spider", "don't download anything"],
    ],
    IG.t("ダウンロード"),
  );
  def(
    "ip",
    8,
    "show / manipulate routing, network devices, interfaces",
    "ip [ OPTIONS ] OBJECT { COMMAND | help }",
    [
      ["ip a", "show addresses"],
      ["ip -br a", "brief address list"],
      ["ip r", "show routes"],
      ["ip link", "show interfaces"],
      ["ip neigh", "show ARP/neighbour table"],
    ],
    IG.t("ネットワーク設定の確認"),
  );
  def(
    "ss",
    8,
    "another utility to investigate sockets",
    "ss [options] [ FILTER ]",
    [
      ["-t", "TCP sockets"],
      ["-u", "UDP sockets"],
      ["-l", "listening sockets"],
      ["-n", "numeric (don't resolve service names)"],
      ["-p", "show process using socket (root for others')"],
      ["-a", "all sockets"],
      ["-s", "summary"],
      ["'sport = :80'", "filter by source port"],
    ],
    IG.t("ソケット確認（ss -tlnp が定番）"),
  );
  def(
    "ping",
    8,
    "send ICMP ECHO_REQUEST to network hosts",
    "ping [options] destination",
    [
      ["-c COUNT", "stop after COUNT replies"],
      ["-W TIMEOUT", "time to wait for a response"],
    ],
    IG.t("疎通確認"),
  );
  def(
    "dig",
    1,
    "DNS lookup utility",
    "dig [@server] [name] [type] [+short]",
    [
      ["+short", "print only the answer"],
      ["@server", "query the given DNS server"],
    ],
    IG.t("DNS 問い合わせ（/etc/hosts は見ない）"),
  );
  def(
    "nc",
    1,
    "arbitrary TCP and UDP connections and listens",
    "nc [options] host port",
    [
      ["-z", "scan without sending data"],
      ["-v", "verbose"],
      ["-w SEC", "timeout"],
    ],
    IG.t("ポート疎通確認（nc -zv host port）"),
  );
  def(
    "ufw",
    8,
    "program for managing a netfilter firewall",
    "ufw [--force] COMMAND",
    [
      ["status [verbose|numbered]", "show status"],
      ["enable|disable", "turn the firewall on/off"],
      ["allow|deny PORT[/PROTO]", "add a rule (e.g. allow 22/tcp)"],
      ["allow from CIDR to any port N", "restrict by source"],
      ["delete N", "delete rule number N"],
      ["app list", "list application profiles"],
    ],
    IG.t("Ubuntu のファイアウォール"),
  );
  def(
    "firewall-cmd",
    1,
    "firewalld command line client",
    "firewall-cmd [OPTIONS...]",
    [
      ["--state", "is firewalld running"],
      ["--list-all", "list everything in the zone"],
      ["--add-service=http", "allow a service"],
      ["--add-port=8080/tcp", "allow a port"],
      ["--permanent", "change the permanent configuration"],
      ["--reload", "apply permanent configuration"],
    ],
    IG.t("RHEL のファイアウォール"),
  );
  def(
    "apt",
    8,
    "command-line interface (package manager)",
    "apt [options] command",
    [
      ["update", "download package information"],
      ["upgrade", "upgrade installed packages"],
      ["install PKG", "install packages (-y: assume yes)"],
      ["remove|purge PKG", "remove packages (purge also config)"],
      ["list --installed", "list installed packages"],
      ["search WORD", "search package descriptions"],
      ["show PKG", "show package details"],
    ],
    IG.t("Ubuntu/Debian のパッケージ管理"),
  );
  def(
    "dnf",
    8,
    "DNF, the package manager for RHEL",
    "dnf [options] COMMAND",
    [
      ["install PKG", "install packages"],
      ["remove PKG", "remove packages"],
      ["list installed", "list installed packages"],
      ["provides FILE", "find which package provides a file"],
    ],
    IG.t("RHEL のパッケージ管理"),
  );
  def(
    "sudo",
    8,
    "execute a command as another user",
    "sudo [-u user] [-i|-s] [command]",
    [
      ["-i", "run login shell as the target user"],
      ["-u USER", "run command as USER"],
      ["-l", "list user's privileges"],
    ],
    IG.t("管理者権限で実行"),
  );
  def(
    "su",
    1,
    "run a command with substitute user and group ID",
    "su [options] [-] [user]",
    [
      ["-", "start a login shell"],
      ["-c CMD", "run command"],
    ],
    IG.t("ユーザー切り替え"),
  );
  def(
    "useradd",
    8,
    "create a new user",
    "useradd [options] LOGIN",
    [
      ["-m", "create the user's home directory"],
      ["-s SHELL", "login shell"],
      ["-G GROUPS", "supplementary groups"],
      ["-u UID", "user ID"],
    ],
    IG.t("ユーザー作成"),
  );
  def(
    "usermod",
    8,
    "modify a user account",
    "usermod [options] LOGIN",
    [
      ["-aG GROUP", "append to supplementary group (keep -a!)"],
      ["-s SHELL", "change login shell"],
      ["-L / -U", "lock / unlock the password"],
    ],
    IG.t("ユーザー変更"),
  );
  def(
    "passwd",
    1,
    "change user password",
    "passwd [options] [LOGIN]",
    [
      ["-l", "lock"],
      ["-u", "unlock"],
      ["-S", "status"],
    ],
    IG.t("パスワード（対話入力は再現不可。chpasswd を使用）"),
  );
  def(
    "crontab",
    1,
    "maintain crontab files for individual users",
    "crontab [-u user] {-l | -r | -e | file}",
    [
      ["-l", "list"],
      ["-e", "edit"],
      ["-r", "remove"],
      ["m h dom mon dow command", 'line format, e.g. "*/5 * * * * /usr/local/bin/backup.sh"'],
    ],
    IG.t("定期実行"),
  );
  def(
    "chpasswd",
    8,
    "update passwords in batch mode",
    "echo 'user:password' | chpasswd",
    [],
    IG.t("パスワード一括設定"),
  );
  def(
    "mount",
    8,
    "mount a filesystem",
    "mount [-a] [device] [dir]",
    [
      ["-a", "mount all filesystems in /etc/fstab"],
      ["(no args)", "list mounted filesystems"],
    ],
    IG.t("マウント"),
  );
  def(
    "lsblk",
    8,
    "list block devices",
    "lsblk [options]",
    [["-f", "output info about filesystems"]],
    IG.t("ディスク構成"),
  );
  def("mkfs", 8, "build a Linux filesystem", "mkfs.ext4 DEVICE / mkfs.xfs DEVICE", [], IG.t("フォーマット"));
  def(
    "sysctl",
    8,
    "configure kernel parameters at runtime",
    "sysctl [options] [variable[=value]]",
    [
      ["-a", "display all values"],
      ["-w var=val", "set a value"],
      ["-p [FILE]", "load settings from file (default /etc/sysctl.conf)"],
    ],
    IG.t("カーネルパラメータ"),
  );
  def(
    "dmesg",
    1,
    "print or control the kernel ring buffer",
    "dmesg [options]",
    [
      ["-T", "human readable timestamps"],
      ["-l err", "restrict output to the given levels"],
    ],
    IG.t("カーネルメッセージ（Ubuntu は root 権限が必要）"),
  );
  def(
    "hostnamectl",
    1,
    "Control the system hostname",
    "hostnamectl [status | set-hostname NAME]",
    [],
    IG.t("ホスト名"),
  );
  def(
    "timedatectl",
    1,
    "Control the system time and date",
    "timedatectl [status | set-timezone ZONE | list-timezones]",
    [],
    IG.t("時刻・タイムゾーン"),
  );
  def(
    "stat",
    1,
    "display file or file system status",
    "stat [OPTION]... FILE...",
    [["-c FORMAT", "use the specified FORMAT, e.g. '%a %U %n'"]],
    IG.t("ファイルの詳細情報"),
  );
  def(
    "diff",
    1,
    "compare files line by line",
    "diff [OPTION]... FILES",
    [
      ["-u", "output unified diff"],
      ["-q", "report only when files differ"],
      ["-i", "ignore case"],
      ["-w", "ignore all white space"],
    ],
    IG.t("差分"),
  );
  def(
    "jq",
    1,
    "Command-line JSON processor",
    "jq [options] 'filter' [file...]",
    [
      ["-r", "output raw strings"],
      ["-c", "compact output"],
      ["'.items[].metadata.name'", "iterate arrays"],
      ["'select(.state==\"running\")'", "filter"],
      ["'map(.name)'", "transform"],
    ],
    IG.t("JSON 加工"),
  );
  def(
    "tee",
    1,
    "read from standard input and write to standard output and files",
    "tee [OPTION]... [FILE]...",
    [
      ["-a", "append to the given FILEs"],
      ["sudo tee FILE", "write to a root-owned file from a pipe"],
    ],
    IG.t("分岐出力（sudo でファイルに書く定番）"),
  );
  def("nohup", 1, "run a command immune to hangups", "nohup COMMAND [ARG]... &", [], IG.t("ログアウト後も実行"));
  def(
    "lsof",
    8,
    "list open files",
    "lsof [-i :PORT] [FILE]",
    [
      ["-i :PORT", "which process listens on PORT (root)"],
      ["FILE", "which process holds FILE"],
    ],
    IG.t("使用中のファイル・ポート"),
  );
  def(
    "bash",
    1,
    "GNU Bourne-Again SHell",
    "bash [options] [file]",
    [
      ["-c STRING", "read commands from STRING"],
      ["-x", "print commands as they are executed (debug)"],
      ["-n", "check syntax only"],
    ],
    IG.t("シェル。スクリプト実行"),
  );
  def(
    "vi",
    1,
    "Vi IMproved, a programmer's text editor",
    "vi [file]",
    [
      ["Esc → :wq", "save and quit"],
      ["Esc → :q!", "quit without saving"],
      ["Esc → :w", "save"],
      ["Esc → :NUMBER", "go to line"],
    ],
    IG.t("エディタ（シミュレータでは画面上で編集）"),
  );
  def(
    "date",
    1,
    "print or set the system date and time",
    "date [OPTION]... [+FORMAT]",
    [
      ["+%F", "full date; like %Y-%m-%d"],
      ["+%T", "time; same as %H:%M:%S"],
      ["-d STRING", "display time described by STRING, e.g. 'yesterday', '2 hours ago'"],
      ["-u", "print Coordinated Universal Time (UTC)"],
    ],
    IG.t("日時表示"),
  );
  def(
    "history",
    1,
    "display the command history (bash builtin)",
    "history [n] | history -c",
    [
      ["!!", "repeat the last command"],
      ["!n", "repeat command number n"],
      ["!str", "repeat the last command starting with str"],
      ["!$", "last argument of the previous command"],
    ],
    IG.t("コマンド履歴"),
  );

  // Every other command (and the examples, SEE ALSO and official link of these) comes from the command dictionary (js/ref/).
  const SEC_NAME = { 1: "User Commands", 5: "File Formats", 7: "Miscellaneous", 8: "System Administration" };
  const ref = (n) => (IG.cmdref ? IG.cmdref.get(n) : null);
  // `man docker-run`, `man kubectl-get` → the "docker run" / "kubectl get" entry
  const lookup = (n) => ref(n) || (/^[a-z][\w.]*-/.test(n) && !P[n] ? ref(n.replace(/-/g, " ")) : null);
  const page = (n) => n.replace(/ /g, "-");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?)]$/.test(s) ? "" : ".");
  const seeAlso = (e) =>
    e.rel
      .map((r) => {
        const x = ref(r);
        return x && x.topic === "basics" ? `${r}(${x.s})` : r;
      })
      .join(", ");
  IG.manpages = {
    has: (n) => !!(P[n] || lookup(n)),
    desc: (n) => (P[n] ? P[n].desc : (lookup(n) || {}).en || null),
    sec: (n) => (P[n] ? P[n].sec : (lookup(n) || {}).s || 1),
    opts: (n) => (P[n] ? P[n].opts : null),
    // one whatis/apropos line: "ls (1)               - list directory contents"
    line: (n, text) => `${`${page(n)} (${IG.manpages.sec(n)})`.padEnd(20)} - ${text || IG.manpages.desc(n)}`,
    help(n) {
      const p = P[n],
        e = lookup(n);
      if (!p && !e) return null;
      const out = p
        ? [`Usage: ${p.syn}`, cap(p.desc), "", p.opts.map(([o, t]) => `  ${o.padEnd(28)} ${t}`).join("\n")]
        : [`Usage: ${e.syn}`, cap(e.en)];
      if (e && e.ex.length) out.push("", "Examples:", e.ex.map(([c, t]) => `  ${c}\n      ${t}`).join("\n"));
      out.push("", `ℹ ${e ? e.ja : p.ja}${p ? IG.t("（オプションは抜粋）") : ""}`);
      if (e && e.doc) out.push(IG.t(`  公式ドキュメント: {0}`, { 0: e.doc }));
      return out.join("\n");
    },
    man(n) {
      const p = P[n],
        e = lookup(n);
      if (!p && !e) return null;
      const name = page(e ? e.name : n),
        sec = p ? p.sec : e.s;
      const T = `${name.toUpperCase()}(${sec})`;
      const mid = SEC_NAME[sec] || "Manual";
      const pad = Math.max(1, 78 - T.length * 2 - mid.length);
      const out = [
        `${T}${" ".repeat(Math.floor(pad / 2))}${mid}${" ".repeat(Math.ceil(pad / 2))}${T}`,
        "",
        "NAME",
        `       ${name} - ${p ? p.desc : e.en}`,
        "",
        "SYNOPSIS",
        `       ${p ? p.syn : e.syn}`,
        "",
        "DESCRIPTION",
        `       ${e ? e.ja : p.ja}`,
      ];
      if (e && e.alias) out.push(IG.t(`       {0} と同じコマンドです。`, { 0: e.alias }));
      if (e && e.nosim) out.push("", IG.t("       ※ このシミュレータでは実行できません（実務で使う知識として収録）。"));
      if (p && p.opts.length)
        out.push("", "OPTIONS (excerpt)", p.opts.map(([o, t]) => `       ${o}\n              ${t}`).join("\n\n"));
      if (e && e.ex.length)
        out.push("", "EXAMPLES", e.ex.map(([c, t]) => `       $ ${c}\n              ${t}`).join("\n\n"));
      const see = e ? seeAlso(e) : "";
      out.push("", "SEE ALSO", `       ${see ? see + ", " : ""}${page(n)} --help`);
      if (e && e.doc) out.push("", "ONLINE DOCUMENTATION", `       ${e.doc}`);
      out.push("", IG.t("ℹ CoreLab 収録の要約版です。やりたいことから探すには apropos <キーワード>（日本語可）。"));
      return out.join("\n") + "\n";
    },
    overview(features) {
      const f = features || new Set();
      const sec = [
        IG.t("GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)  —  CoreLab シミュレータ"),
        "",
        IG.t(
          "【ファイル】 ls cd pwd cat less head tail cp mv rm mkdir rmdir touch ln find tree stat file chmod chown chgrp du df tar gzip zip/unzip md5sum sha256sum",
        ),
        IG.t("【テキスト】 grep sed awk sort uniq cut paste tr wc diff comm column nl rev jq xargs tee printf echo"),
        IG.t(
          "【ユーザー】 whoami id groups sudo su useradd usermod userdel groupadd passwd chpasswd who w last getent",
        ),
        IG.t("【プロセス】 ps top htop kill pkill pgrep killall nice renice nohup jobs bg fg timeout watch lsof"),
        IG.t("【サービス】 systemctl journalctl service hostnamectl timedatectl crontab logger logrotate reboot"),
        IG.t("【パッケージ】 apt apt-get dpkg（RHEL: dnf yum rpm）"),
        IG.t(
          "【ネットワーク】 ip ss netstat ping traceroute tracepath dig nslookup host curl wget nc telnet ssh scp rsync ssh-keygen ufw iptables firewall-cmd tcpdump",
        ),
        IG.t(
          "【ディスク・カーネル】 lsblk blkid fdisk mount umount findmnt mkfs free vmstat uptime uname lscpu sysctl dmesg",
        ),
        IG.t(
          "【シェル】 if/for/while/case・関数・$(...)・$((...))・ヒアドキュメント・リダイレクト・パイプ・&&/||・alias・export・source・history（!!）",
        ),
      ];
      const on = (t) => (IG.cmdref ? IG.cmdref.topicOn(t, f) : f.has(t));
      if (on("k8s"))
        sec.push(
          IG.t(
            "【Kubernetes】 kubectl (k)  例) kubectl get pods -A / kubectl describe pod <name> / kubectl logs <pod>",
          ),
        );
      if (on("ocp"))
        sec.push(IG.t("【OpenShift】 oc  例) oc login / oc new-project / oc new-app / oc expose svc/<name>"));
      if (on("docker"))
        sec.push(IG.t("【Docker】 docker / docker compose  例) docker ps -a / docker run -d -p 8080:80 nginx:1.27"));
      if (on("harbor"))
        sec.push(IG.t("【Harbor】 harbor  例) harbor project list / harbor artifact list <project>/<repo>"));
      if (on("aws")) sec.push(IG.t("【AWS】 aws  例) aws sts get-caller-identity / aws ec2 describe-instances"));
      sec.push(
        "",
        IG.t(
          "man <コマンド> / <コマンド> --help で使い方 · apropos <やりたいこと> でコマンド検索（例: apropos ポート 使用中）",
        ),
        IG.t("Tab: 補完 · ↑/↓: 履歴 · Ctrl+R: 履歴検索"),
        IG.t("迷ったら目標の「ヒント」、コマンドが分からなければ Ctrl+K（コマンド辞典）。"),
      );
      return sec.join("\n") + "\n";
    },
  };
})((globalThis.IG = globalThis.IG || {}));
