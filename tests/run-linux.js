#!/usr/bin/env node
/* Regression tests for the Linux/bash simulator. Each case runs in a fresh world with a
 * bastion (Ubuntu 22.04) and an extra Ubuntu host "srv1" plus a RHEL host "rhel1".
 * Usage: node tests/run-linux.js [filter] [-v] */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="\.\/(js\/[^"]+)"/g)].map(m => m[1]).filter(s => !s.startsWith('js/ui/') && !s.startsWith('js/game/missions/'));
const ctx = vm.createContext({ console, Buffer, Date, Math, JSON, TextEncoder, setTimeout, clearTimeout });
ctx.globalThis = ctx;
for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(root, s), 'utf8'), ctx, { filename: s });
const IG = ctx.IG;

function fresh() {
  IG.clock.offset = 0;
  const w = new IG.World();
  w.addHost('srv1', { user: 'ubuntu', ip: '10.0.1.40', services: { nginx: 'active' } });
  w.addHost('rhel1', { os: 'rhel', user: 'ec2-user', ip: '10.0.1.50' });
  const sh = new IG.Shell(w);
  return { w, sh };
}
const strip = s => s.replace(/\x1b\[[\d;]*m(\x1b\[K)?/g, '');

// [description, commands (string or array; only the last is checked), expectation]
// expectation: RegExp (matches full output), string (exact), or {out, err, code}
const T = [
  // ---------------- shell syntax & expansion
  ['echo basic', 'echo hello world', 'hello world'],
  ['variables', ['NAME=CoreLab', 'echo "Hi $NAME"'], 'Hi CoreLab'],
  ['single quotes', `echo '$HOME'`, '$HOME'],
  ['HOME', 'echo $HOME', '/home/operator'],
  ['tilde', 'echo ~', '/home/operator'],
  ['default value', 'echo ${UNSET:-fallback}', 'fallback'],
  ['string length', ['X=abcdef', 'echo ${#X}'], '6'],
  ['suffix strip', ['F=archive.tar.gz', 'echo ${F%.gz} ${F%%.*} ${F#*.}'], 'archive.tar archive tar.gz'],
  ['substitution', ['S=a-b-c', 'echo ${S//-/_}'], 'a_b_c'],
  ['substring', ['S=kubernetes', 'echo ${S:0:4}'], 'kube'],
  ['upper', ['S=abc', 'echo ${S^^}'], 'ABC'],
  ['arithmetic', 'echo $((3 * (4 + 5) % 7))', '6'],
  ['arith vars', ['a=5', 'b=3', 'echo $((a*b+1))'], '16'],
  ['let/inc', ['i=1', '((i++))', 'echo $i'], '2'],
  ['command substitution', 'echo "today: $(echo ok)"', 'today: ok'],
  ['backticks', 'echo `echo nested`', 'nested'],
  ['brace expansion', 'echo file{1..3}.txt', 'file1.txt file2.txt file3.txt'],
  ['brace list', 'echo {a,b}{x,y}', 'ax ay bx by'],
  ['exit status', ['false', 'echo $?'], '1'],
  ['&& ||', 'true && echo yes || echo no', 'yes'],
  ['|| on failure', 'false && echo yes || echo no', 'no'],
  ['semicolon', 'echo a; echo b', 'a\nb'],
  ['negation', '! false && echo negated', 'negated'],
  ['if/else', 'if [ 3 -gt 2 ]; then echo bigger; else echo smaller; fi', 'bigger'],
  ['elif', ['x=5', 'if [ $x -lt 3 ]; then echo a; elif [ $x -lt 10 ]; then echo b; else echo c; fi'], 'b'],
  ['for list', 'for i in 1 2 3; do echo n$i; done', 'n1\nn2\nn3'],
  ['for C-style', 'for ((i=0; i<3; i++)); do printf "%d," $i; done', '0,1,2,'],
  ['while', ['n=0', 'while [ $n -lt 3 ]; do n=$((n+1)); done; echo $n'], '3'],
  ['until', ['n=0', 'until [ $n -ge 2 ]; do n=$((n+1)); done; echo $n'], '2'],
  ['break/continue', 'for i in 1 2 3 4 5; do [ $i -eq 2 ] && continue; [ $i -eq 4 ] && break; echo $i; done', '1\n3'],
  ['case', ['f=report.csv', 'case $f in *.txt) echo text;; *.csv|*.tsv) echo table;; *) echo other;; esac'], 'table'],
  ['function', ['greet() { echo "hi $1 ($#)"; }', 'greet bob x'], 'hi bob (2)'],
  ['function return', ['ok() { return 3; }', 'ok; echo $?'], '3'],
  ['local', ['v=global', 'f() { local v=inner; echo $v; }', 'f; echo $v'], 'inner\nglobal'],
  ['[[ pattern ]]', '[[ nginx.service == *.service ]] && echo match', 'match'],
  ['[[ regex ]]', '[[ "v1.30.4" =~ ^v([0-9]+)\\.([0-9]+) ]] && echo ${BASH_REMATCH[2]}', '30'],
  ['test -f/-d', 'test -d /etc && [ -f /etc/passwd ] && echo both', 'both'],
  ['string compare', '[ "abc" = "abc" ] && [ -n "x" ] && [ -z "" ] && echo yes', 'yes'],
  ['integer error', '[ abc -eq 1 ]', { err: /integer expression expected/, code: 2 }],
  ['subshell isolation', ['x=1', '(x=2; echo in $x)', 'echo out $x'], 'out 1'],
  ['group', '{ echo a; echo b; } | wc -l', '2'],
  ['array', ['arr=(alpha beta gamma)', 'echo ${arr[1]} ${#arr[@]} ${arr[@]}'], 'beta 3 alpha beta gamma'],
  ['heredoc', ['cat <<EOF > /tmp/h.txt', 'line1 $HOME', 'EOF'].join('\n') + '\ncat /tmp/h.txt', 'line1 /home/operator'],
  ['heredoc quoted', "cat <<'EOF'\n$HOME\nEOF", '$HOME'],
  ['herestring', 'read a b <<< "one two three"; echo "$b"', 'two three'],
  ['while read', ['printf "a\\nb\\nc\\n" > /tmp/l.txt', 'while read line; do echo "<$line>"; done < /tmp/l.txt'], '<a>\n<b>\n<c>'],
  ['pipe into while', 'printf "x 1\\ny 2\\n" | while read k v; do echo $v$k; done', '1x\n2y'],
  ['glob', ['mkdir -p /tmp/g && touch /tmp/g/a.log /tmp/g/b.log /tmp/g/c.txt', 'echo /tmp/g/*.log'], '/tmp/g/a.log /tmp/g/b.log'],
  ['glob no match stays', 'echo /tmp/nomatch*', '/tmp/nomatch*'],
  ['quoted glob', 'echo "*.log"', '*.log'],
  ['word splitting', ['L="a  b   c"', 'for x in $L; do echo "[$x]"; done'], '[a]\n[b]\n[c]'],
  ['quoted no split', ['L="a  b"', 'for x in "$L"; do echo "[$x]"; done'], '[a  b]'],
  ['history !!', ['echo first', '!!'], 'echo first\nfirst'],
  ['alias', ['alias hi="echo hello"', 'hi there'], 'hello there'],
  ['ll alias', 'type ll', "ll is aliased to `ls -alF'"],
  ['export to child', ['export FOO=bar', 'bash -c \'echo $FOO\''], 'bar'],
  ['not exported', ['BAR=baz', 'bash -c \'echo "[$BAR]"\''], '[]'],
  ['env prefix', 'GREETING=hey env | grep GREETING', 'GREETING=hey'],
  ['set -e in script', ['printf "set -e\\necho one\\nfalse\\necho two\\n" > /tmp/s.sh', 'bash /tmp/s.sh'], 'one'],
  ['script args', ['printf \'#!/bin/bash\\necho "$0 got $# args: $1"\\n\' > ~/a.sh', 'chmod +x ~/a.sh', './a.sh x y'], './a.sh got 2 args: x'],
  ['script no exec bit', ['echo "echo hi" > ~/b.sh', './b.sh'], { err: /Permission denied/, code: 126 }],
  ['command not found', 'nosuchcmd', { err: /nosuchcmd: command not found/, code: 127 }],
  ['ubuntu suggests package', 'netstat -tlnp', { err: /sudo apt install net-tools/, code: 127 }],
  ['syntax error', 'if true; then', { incomplete: true }],
  ['unexpected token', 'echo hi ;; echo', { err: /syntax error near unexpected token/ }],
  ['printf formats', 'printf "%-5s|%05.1f|%x|%3d\\n" ab 3.14159 255 7', 'ab   |003.1|ff|  7'],
  ['printf repeat', 'printf "%s=%s\\n" a 1 b 2', 'a=1\nb=2'],
  ['echo -e', 'echo -e "a\\tb"', 'a\tb'],
  ['seq | paste', 'seq 3 | paste -sd+ | bc', '6'],
  ['xargs', 'echo a b c | xargs -n1 echo item', 'item a\nitem b\nitem c'],
  ['xargs -I', 'printf "x\\ny\\n" | xargs -I{} echo "<{}>"', '<x>\n<y>'],
  ['stderr redirect', 'ls /nope 2>/dev/null; echo code=$?', 'code=2'],
  ['2>&1 into pipe', 'ls /nope 2>&1 | grep -c "No such"', '1'],
  ['&> file', ['ls /nope /etc/hostname &> /tmp/both.txt', 'wc -l < /tmp/both.txt'], '2'],
  ['append', ['echo a > /tmp/ap', 'echo b >> /tmp/ap', 'cat /tmp/ap'], 'a\nb'],
  ['noclobber-free overwrite', ['echo a > /tmp/ov', 'echo b > /tmp/ov', 'cat /tmp/ov'], 'b'],
  ['pipefail', ['set -o pipefail', 'false | true; echo $?'], '1'],
  ['background job', ['sleep 1 &', 'jobs'], /\[1\]\+\s+Done\s+sleep 1|\[1\]\+\s+(Running|Done)/],
  // ---------------- files & permissions
  ['pwd', 'pwd', '/home/operator'],
  ['cd -', ['cd /etc', 'cd /tmp', 'cd -'], '/etc'],
  ['ls -l format', ['echo hi > f.txt', 'ls -l f.txt'], /^-rw-rw-r-- 1 operator operator 3 \w{3} [ \d]\d \d\d:\d\d f\.txt$/],
  ['ls -la dotfiles', 'ls -a ~', /\.bashrc/],
  ['mkdir -p & tree', ['mkdir -p proj/{src,docs}', 'touch proj/src/main.c', 'tree proj'], /proj\n├── docs\n└── src\n    └── main\.c\n\n2 directories, 1 file/],
  ['mkdir existing', ['mkdir d1', 'mkdir d1'], { err: /mkdir: cannot create directory ‘d1’: File exists/ }],
  ['rm dir needs -r', ['mkdir d2', 'rm d2'], { err: /rm: cannot remove 'd2': Is a directory/ }],
  ['cp -r & diff', ['mkdir -p a/b && echo x > a/b/f', 'cp -r a c', 'diff -r a/b/f c/b/f && echo same'], 'same'],
  ['mv rename', ['touch old', 'mv old new', 'ls new'], 'new'],
  ['ln -s & readlink', ['ln -s /etc/hostname hn', 'readlink hn', 'cat hn'], 'bastion'],
  ['ls -l symlink', ['ln -s /etc/hosts h', 'ls -l h'], /h -> \/etc\/hosts$/],
  ['chmod numeric', ['touch p', 'chmod 640 p', 'stat -c "%a %A" p'], '640 -rw-r-----'],
  ['chmod symbolic', ['touch q', 'chmod u+x,o-r q', 'stat -c %A q'], '-rwxrw----'],
  ['cannot read shadow', 'cat /etc/shadow', { err: /cat: \/etc\/shadow: Permission denied/, code: 1 }],
  ['sudo read shadow', 'sudo head -1 /etc/shadow', /^root:/],
  ['cannot write /etc', 'echo x > /etc/test', { err: /bash: \/etc\/test: Permission denied/ }],
  ['sudo echo redirect still fails', 'sudo echo x > /etc/test2', { err: /Permission denied/ }],
  ['sudo tee works', ['echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-fwd.conf > /dev/null', 'cat /etc/sysctl.d/99-fwd.conf'], 'net.ipv4.ip_forward=1'],
  ['root dir unreadable', 'ls /root', { err: /ls: cannot open directory '\/root': Permission denied/ }],
  ['chown needs root', ['touch o', 'chown root o'], { err: /Operation not permitted/ }],
  ['sudo chown', ['touch o2', 'sudo chown root:root o2', 'stat -c "%U:%G" o2'], 'root:root'],
  ['/tmp sticky', 'stat -c %A /tmp', 'drwxrwxrwt'],
  ['find -name', ['mkdir -p fx/y && touch fx/a.log fx/y/b.log fx/c.txt', 'find fx -name "*.log" | sort'], 'fx/a.log\nfx/y/b.log'],
  ['find -type d', ['mkdir -p fy/z', 'find fy -type d'], 'fy\nfy/z'],
  ['find -exec', ['mkdir fz && echo hi > fz/1', 'find fz -type f -exec cat {} \\;'], 'hi'],
  ['find -size', ['fallocate -l 5M big.bin', 'find . -maxdepth 1 -size +1M'], './big.bin'],
  ['du -sh', ['mkdir dd && fallocate -l 2M dd/x', 'du -sh dd'], /^2\.1M\tdd$|^2\.0M\tdd$/],
  ['df -h root', 'df -h /', /\/dev\/root\s+50G\s+\S+\s+\S+\s+\d+% \//],
  ['file types', ['echo "#!/bin/bash" > s.sh', 'file s.sh /etc /bin'], /s\.sh: Bourne-Again shell script.*\n\/etc: directory\n\/bin: symbolic link to usr\/bin/],
  ['stat', 'stat /etc/passwd', /Access: \(0644\/-rw-r--r--\)  Uid: \(    0\/    root\)/],
  ['sha256sum', ['printf hello > hw', 'sha256sum hw'], '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  hw'],
  ['md5sum -c', ['echo data > m', 'md5sum m > m.md5', 'md5sum -c m.md5'], 'm: OK'],
  ['tar czf/tzf/xzf', ['mkdir -p t/sub && echo 1 > t/sub/f', 'tar czf t.tgz t', 'rm -r t', 'tar tzf t.tgz', ], 't/\nt/sub/\nt/sub/f'],
  ['tar extract', ['mkdir -p t2 && echo 7 > t2/v', 'tar cf t2.tar t2', 'rm -r t2', 'tar xf t2.tar && cat t2/v'], '7'],
  ['gzip/gunzip', ['echo zz > gz.txt', 'gzip gz.txt', 'ls gz.txt*', 'gunzip gz.txt.gz && cat gz.txt'], 'zz'],
  ['zcat', ['echo inside > z1', 'gzip z1', 'zcat z1.gz'], 'inside'],
  // ---------------- text processing
  ['grep -n', ['printf "a\\nerror x\\nb\\nERROR y\\n" > log', 'grep -n error log'], '2:error x'],
  ['grep -i -c', ['printf "a\\nerror x\\nERROR y\\n" > log', 'grep -ic error log'], '2'],
  ['grep -v', ['printf "a\\nb\\n" > l2', 'grep -v a l2'], 'b'],
  ['grep -E alt', ['printf "cat\\ndog\\nbird\\n" > an', 'grep -E "cat|dog" an'], 'cat\ndog'],
  ['grep BRE \\|', ['printf "cat\\ndog\\nbird\\n" > an', 'grep "cat\\|bird" an'], 'cat\nbird'],
  ['grep -o', 'echo "ip=10.0.1.5 ip=10.0.1.6" | grep -oE "[0-9]+(\\.[0-9]+){3}"', '10.0.1.5\n10.0.1.6'],
  ['grep -r', ['mkdir -p gr/x && echo needle > gr/x/f && echo hay > gr/g', 'grep -r needle gr'], 'gr/x/f:needle'],
  ['grep -A1', ['printf "1\\nhit\\n2\\n3\\n" > ga', 'grep -A1 hit ga'], 'hit\n2'],
  ['grep no match code', 'echo a | grep b; echo $?', '1'],
  ['grep -w', 'printf "port\\nports\\n" | grep -w port', 'port'],
  ['sed s///g', 'echo "a-b-c" | sed "s/-/+/g"', 'a+b+c'],
  ['sed -n p range', 'seq 10 | sed -n "3,5p"', '3\n4\n5'],
  ['sed d regex', 'printf "keep\\n#drop\\nkeep2\\n" | sed "/^#/d"', 'keep\nkeep2'],
  ['sed -i backref', ['echo "name: foo" > y.yml', 'sed -i -E "s/name: (.*)/name: \\1-bar/" y.yml', 'cat y.yml'], 'name: foo-bar'],
  ['sed append', 'printf "a\\nb\\n" | sed "/a/a inserted"', 'a\ninserted\nb'],
  ['sed &', 'echo port | sed "s/port/[&]/"', '[port]'],
  ['sed $ last', "seq 3 | sed -n '$p'", '3'],
  ['sed "$p" expands var (empty)', 'seq 3 | sed -n "$p"', ''],
  ['awk fields', 'echo "a b c" | awk \'{print $2, $NF}\'', 'b c'],
  ['awk -F', 'echo "root:x:0:0" | awk -F: \'{print $1 "-" $3}\'', 'root-0'],
  ['awk sum', 'printf "a 3\\nb 4\\n" | awk \'{s+=$2} END {print s}\'', '7'],
  ['awk count', 'printf "x\\ny\\nx\\n" | awk \'{c[$1]++} END {for (k in c) print k, c[k]}\' | sort', 'x 2\ny 1'],
  ['awk condition', 'printf "a 10\\nb 200\\n" | awk \'$2 > 100 {print $1}\'', 'b'],
  ['awk NR', 'seq 5 | awk \'NR>3\'', '4\n5'],
  ['awk printf', 'echo 3.14159 | awk \'{printf "%.2f\\n", $1}\'', '3.14'],
  ['awk gsub/length', 'echo "a.b.c" | awk \'{n=gsub(/\\./,"-"); print $0, n, length($0)}\'', 'a-b-c 2 5'],
  ['awk -v', 'echo x | awk -v who=ops \'{print who}\'', 'ops'],
  ['awk BEGIN only', 'awk \'BEGIN {print 2^10}\'', '1024'],
  ['sort -n', 'printf "10\\n9\\n100\\n" | sort -n', '9\n10\n100'],
  ['sort -k -r', 'printf "a 2\\nb 10\\nc 1\\n" | sort -k2 -nr', 'b 10\na 2\nc 1'],
  ['sort -h', 'printf "1G\\n20M\\n3K\\n" | sort -h', '3K\n20M\n1G'],
  ['sort | uniq -c', 'printf "b\\na\\nb\\n" | sort | uniq -c', '      1 a\n      2 b'],
  ['cut -d -f', 'echo "a,b,c" | cut -d, -f2,3', 'b,c'],
  ['cut -c', 'echo abcdef | cut -c2-4', 'bcd'],
  ['tr upper', 'echo hello | tr a-z A-Z', 'HELLO'],
  ['tr -d', 'echo "a1b2" | tr -d 0-9', 'ab'],
  ['tr -s', 'echo "a   b" | tr -s " "', 'a b'],
  ['wc -l', 'printf "1\\n2\\n3\\n" | wc -l', '3'],
  ['head -n', 'seq 100 | head -3', '1\n2\n3'],
  ['tail -n +', 'seq 5 | tail -n +4', '4\n5'],
  ['tac', 'seq 3 | tac', '3\n2\n1'],
  ['column -t', 'printf "a bb\\nccc d\\n" | column -t', 'a    bb\nccc  d'],
  ['diff -u', ['printf "a\\nb\\n" > d1', 'printf "a\\nc\\n" > d2', 'diff -u d1 d2 | tail -3'], ' a\n-b\n+c'],
  ['diff normal', ['printf "a\\nb\\n" > e1', 'printf "a\\nc\\n" > e2', 'diff e1 e2'], { out: '2c2\n< b\n---\n> c', code: 1 }],
  ['jq', `echo '{"items":[{"name":"a","v":1},{"name":"b","v":2}]}' | jq -r '.items[] | select(.v > 1) | .name'`, 'b'],
  ['jq length', `echo '[1,2,3]' | jq length`, '3'],
  ['base64 roundtrip', 'echo -n secret | base64 | base64 -d', 'secret'],
  ['expr', 'expr 7 \\* 6', '42'],
  ['bc', 'echo "scale=2; 10/3" | bc', '3.33'],
  ['rev', 'echo abc | rev', 'cba'],
  ['nl', 'printf "a\\nb\\n" | nl', '     1\ta\n     2\tb'],
  ['date format', 'date -d @0 +%F', '1970-01-01'],
  ['basename/dirname', 'basename /var/log/syslog .log; dirname /var/log/syslog', 'syslog\n/var/log'],
  // ---------------- users, sudo
  ['whoami', 'whoami', 'operator'],
  ['id', 'id', 'uid=1000(operator) gid=1000(operator) groups=1000(operator),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),110(lxd),999(docker)'],
  ['sudo whoami', 'sudo whoami', 'root'],
  ['sudo -i & exit', ['sudo -i', 'whoami', 'pwd'], '/root'],
  ['useradd needs root', 'useradd bob', { err: /useradd: Permission denied/ }],
  ['useradd & id', ['sudo useradd -m -s /bin/bash -G docker alice', 'id alice'], /uid=1001\(alice\) gid=1001\(alice\) groups=1001\(alice\),999\(docker\)/],
  ['home created', ['sudo useradd -m carol', 'sudo ls -ld /home/carol'], /^drwxr-x--- \d+ carol carol/],
  ['usermod -aG', ['sudo useradd -m dave', 'sudo usermod -aG adm dave', 'groups dave'], 'dave : dave adm'],
  ['passwd file updated', ['sudo useradd -m erin', 'grep erin /etc/passwd'], /^erin:x:1001:1001::\/home\/erin:\/bin\/sh$/],
  ['chpasswd', ['sudo useradd -m fay', "echo 'fay:Secret123' | sudo chpasswd", 'sudo grep fay /etc/shadow | cut -c1-7'], 'fay:$6$'],
  ['userdel -r', ['sudo useradd -m gus', 'sudo userdel -r gus', 'id gus'], { err: /id: ‘gus’: no such user/ }],
  ['su needs password', 'su - ', { err: /su: Authentication failure/ }],
  ['sudo su - user', ['sudo useradd -m hank', 'sudo su - hank', 'whoami; pwd'], 'hank\n/home/hank'],
  ['non-sudoer', ['sudo useradd -m ivy', 'sudo su - ivy', 'sudo ls'], { err: /ivy is not in the sudoers file/ }],
  ['getent', 'getent passwd root', 'root:x:0:0:root:/root:/bin/bash'],
  ['sudo builtin', 'sudo cd /root', { err: /sudo: cd: command not found/ }],
  ['auth.log records sudo', ['sudo true', 'sudo grep "COMMAND=/usr/bin/true" /var/log/auth.log'], /sudo: operator : TTY=pts\/0 ; PWD=\/home\/operator ; USER=root ; COMMAND=\/usr\/bin\/true/],
  // ---------------- processes & services
  ['ps aux shows sshd', 'ps aux | grep -c "[s]shd"', /^[1-9]\d*$/],
  ['ps -ef header', 'ps -ef | head -1', /^UID\s+PID\s+PPID\s+C\s+STIME\s+TTY\s+TIME\s+CMD$/],
  ['pgrep', 'pgrep -l cron', /^\d+ cron$/],
  ['kill others denied', 'kill $(pgrep cron)', { err: /Operation not permitted/ }],
  ['systemctl status', 'systemctl status cron', /● cron\.service - Regular background program processing daemon\n\s+Loaded: loaded .*\n\s+Active: active \(running\)/],
  ['systemctl stop needs sudo', 'systemctl stop cron', { err: /Interactive authentication required/ }],
  ['systemctl stop/is-active', ['sudo systemctl stop cron', 'systemctl is-active cron'], { out: 'inactive', code: 3 }],
  ['systemctl unknown', 'systemctl status nosuch', { err: /Unit nosuch\.service could not be found\./, code: 4 }],
  ['disable/is-enabled', ['sudo systemctl disable cron', 'systemctl is-enabled cron'], { out: 'disabled', code: 1 }],
  ['custom unit', ['printf \'#!/bin/bash\\nwhile true; do sleep 60; done\\n\' | sudo tee /usr/local/bin/myapp >/dev/null', 'sudo chmod +x /usr/local/bin/myapp', 'printf "[Unit]\\nDescription=My App\\n[Service]\\nExecStart=/usr/local/bin/myapp\\n[Install]\\nWantedBy=multi-user.target\\n" | sudo tee /etc/systemd/system/myapp.service >/dev/null', 'sudo systemctl daemon-reload', 'sudo systemctl enable --now myapp', 'systemctl is-active myapp'], 'active'],
  ['custom unit missing exec', ['printf "[Service]\\nExecStart=/opt/none\\n" | sudo tee /etc/systemd/system/broken.service >/dev/null', 'sudo systemctl daemon-reload', 'sudo systemctl start broken'], { err: /Job for broken\.service failed/ }],
  ['journalctl -u', ['sudo systemctl restart cron', 'journalctl -u cron -n 1'], /Started cron\.service/],
  ['journalctl group gate', ['sudo useradd -m jo', 'sudo -u jo journalctl -n 1'], /Users in groups 'adm', 'systemd-journal' can see all messages/],
  ['free -h', 'free -h | head -1', /^\s+total\s+used\s+free\s+shared\s+buff\/cache\s+available$/],
  ['uptime', 'uptime', /up 12 days/],
  ['crontab install & list', ['echo "*/5 * * * * /usr/local/bin/backup.sh" | crontab -', 'crontab -l'], '*/5 * * * * /usr/local/bin/backup.sh'],
  ['crontab invalid', 'echo "61 * * * * x" | crontab -', { err: /bad minute/ }],
  ['crontab empty', 'crontab -l', { err: /no crontab for operator/, code: 1 }],
  ['sysctl read', 'sysctl net.ipv4.ip_forward', 'net.ipv4.ip_forward = 0'],
  ['sysctl -w', ['sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null', 'cat /proc/sys/net/ipv4/ip_forward'], '1'],
  ['dmesg restricted', 'dmesg', { err: /Operation not permitted/ }],
  ['timedatectl tz', ['sudo timedatectl set-timezone Asia/Tokyo', 'timedatectl | grep "Time zone"'], /Asia\/Tokyo \(JST, \+0900\)/],
  ['hostnamectl', 'hostnamectl | grep "Operating System"', 'Operating System: Ubuntu 22.04.4 LTS'],
  // ---------------- packages
  ['apt needs root', 'apt install tree', { err: /are you root\?/, code: 100 }],
  ['apt install net-tools', ['sudo apt install -y net-tools > /dev/null', 'which netstat'], '/usr/bin/netstat'],
  ['apt unknown pkg', 'sudo apt install -y nosuchpkg', { err: /E: Unable to locate package nosuchpkg/ }],
  ['apt install nginx serves', ['sudo apt install -y nginx > /dev/null', 'curl -s localhost | grep -o "<h1>.*</h1>"'], '<h1>Welcome to nginx!</h1>'],
  ['dpkg -l', 'dpkg -l bash | tail -1', /^ii  bash/],
  ['dnf on ubuntu', 'dnf install x', { err: /Command 'dnf' not found, but can be installed with:\nsudo apt install dnf/, code: 127 }],
  // ---------------- networking
  ['ip -br a', 'ip -br a', /^lo\s+UNKNOWN\s+127\.0\.0\.1\/8 .*\neth0\s+UP\s+10\.0\.1\.20\/24/],
  ['ip route', 'ip r | head -1', 'default via 10.0.1.1 dev eth0 proto dhcp src 10.0.1.20 metric 100'],
  ['ss -tln', 'ss -tln | grep -c ":22 "', /^[12]$/],
  ['ss -tlnp needs root for proc', 'sudo ss -tlnp | grep 22', /users:\(\("sshd",pid=\d+,fd=6\)\)/],
  ['ping internal', 'ping -c 1 srv1', /1 packets transmitted, 1 received, 0% packet loss/],
  ['ping unknown', 'ping -c 1 nope.example', { err: /Name or service not known/, code: 2 }],
  ['curl srv1 nginx', 'curl -s http://srv1/ | grep -o "<h1>.*</h1>"', '<h1>Welcome to nginx!</h1>'],
  ['curl refused', 'curl http://srv1:8080/', { err: /Failed to connect to srv1 port 8080/, code: 7 }],
  ['curl -w code', 'curl -s -o /dev/null -w "%{http_code}" http://srv1/nope', '404'],
  ['nc -zv open', 'nc -zv srv1 80', { err: /Connection to srv1 \(10\.0\.1\.40\) 80 port \[tcp\/http\] succeeded!/, code: 0 }],
  ['nc -zv closed', 'nc -zv srv1 81', { err: /Connection refused/, code: 1 }],
  ['dig +short', 'dig +short srv1', '10.0.1.40'],
  ['/etc/hosts used by ping not dig', ['echo "10.0.1.40 portal.corp" | sudo tee -a /etc/hosts >/dev/null', 'getent hosts portal.corp', 'dig +short portal.corp'], ''],
  ['getent hosts via /etc/hosts', ['echo "10.0.1.40 portal.corp" | sudo tee -a /etc/hosts >/dev/null', 'getent hosts portal.corp'], /^10\.0\.1\.40\s+portal\.corp$/],
  ['ssh via config', ['ssh srv1', 'whoami; hostname'], 'ubuntu\nsrv1'],
  ['ssh remote cmd', 'ssh srv1 "systemctl is-active nginx"', { out: 'active', err: /Permanently added 'srv1'/ }],
  ['ssh root denied', 'ssh root@srv1', { err: /Permission denied \(publickey\)/, code: 255 }],
  ['ssh unknown host', 'ssh nohost', { err: /Could not resolve hostname nohost/, code: 255 }],
  ['scp to remote', ['echo payload > pl.txt', 'scp pl.txt srv1:/tmp/', 'ssh srv1 cat /tmp/pl.txt'], { out: 'payload' }],
  ['ssh-keygen', ['ssh-keygen -t ed25519 -N "" -f ~/.ssh/test_key > /dev/null', 'ls -1 ~/.ssh/test_key*'], '/home/operator/.ssh/test_key\n/home/operator/.ssh/test_key.pub'],
  ['ufw enable blocks', ['ssh srv1 "sudo ufw allow 22/tcp && sudo ufw --force enable" > /dev/null', 'curl -s -m 2 http://srv1/; echo code=$?'], /code=28/],
  ['ufw allow http', ['ssh srv1 "sudo ufw allow 22/tcp; sudo ufw allow 80/tcp; sudo ufw --force enable" > /dev/null', 'curl -s -o /dev/null -w "%{http_code}" http://srv1/'], '200'],
  ['ufw status', ['ssh srv1 "sudo ufw allow OpenSSH; sudo ufw --force enable" > /dev/null', 'ssh srv1 sudo ufw status | head -1'], 'Status: active'],
  ['rhel firewalld', ['ssh rhel1', 'sudo firewall-cmd --add-service=http --permanent', 'sudo firewall-cmd --reload', 'sudo firewall-cmd --list-services'], 'ssh dhcpv6-client cockpit http'],
  ['rhel prompt & dnf', ['ssh rhel1', 'sudo dnf install -y httpd > /dev/null', 'rpm -q httpd'], /^httpd-/],
  ['rhel no apt', ['ssh rhel1', 'apt install x'], { err: 'bash: apt: command not found', code: 127 }],
  ['ssh exit', ['ssh srv1', 'exit'], 'logout\nConnection to srv1 closed.'],
  // ---------------- misc
  ['man', 'man ls | head -1', /^LS\(1\)\s+User Commands\s+LS\(1\)$/],
  ['--help generic', 'grep --help | head -1', 'Usage: grep [OPTION...] PATTERNS [FILE...]'],
  ['type builtin', 'type cd', 'cd is a shell builtin'],
  ['which', 'which ls', '/usr/bin/ls'],
  ['command -v', 'command -v find', '/usr/bin/find'],
  ['command -v alias', 'command -v grep', "alias grep='grep --color=auto'"],
  ['history', ['echo one', 'history | tail -2 | head -1'], /^\s+1\s+echo one$/],
  ['source bashrc alias', ['echo "alias gs=\'echo src\'" >> ~/.bashrc', 'source ~/.bashrc', 'gs'], 'src'],
  ['umask', 'umask', '0002'],
];

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const filter = args.find(a => !a.startsWith('-'));
let pass = 0, fail = 0;
for (const [name, cmds, expect] of T) {
  if (filter && !name.includes(filter)) continue;
  const { sh } = fresh();
  const list = Array.isArray(cmds) ? cmds : [cmds];
  let r;
  let crash = null;
  try { for (const c of list) { IG.clock.offset += 5000; r = sh.exec(c); } } catch (e) { crash = e; }
  const outText = r ? strip(r.chunks ? r.chunks.filter(c => c.stream === 'out').map(c => c.text).join('') : r.out).replace(/\n$/, '') : '';
  const errText = r ? strip(r.chunks ? r.chunks.filter(c => c.stream === 'err').map(c => c.text).join('') : '') : '';
  const all = r ? strip(r.out) : '';
  let ok;
  if (crash) ok = false;
  else if (expect instanceof RegExp) ok = expect.test(all);
  else if (typeof expect === 'string') ok = all === expect;
  else {
    ok = true;
    if (expect.incomplete) ok = !!r.incomplete;
    if (expect.out !== undefined) ok = ok && (expect.out instanceof RegExp ? expect.out.test(outText) : outText === expect.out);
    if (expect.err !== undefined) ok = ok && (expect.err instanceof RegExp ? expect.err.test(errText) : errText.trim() === expect.err);
    if (expect.code !== undefined) ok = ok && r.code === expect.code;
  }
  if (ok) pass++; else fail++;
  if (!ok || verbose) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) {
      if (crash) console.log('      CRASH: ' + (crash.stack || crash).toString().split('\n').slice(0, 4).join('\n      '));
      else console.log(`      expected: ${expect instanceof RegExp ? expect : JSON.stringify(expect, (k, v) => (v instanceof RegExp ? v.toString() : v))}\n      got(out): ${JSON.stringify(outText)}\n      got(err): ${JSON.stringify(errText)}\n      code: ${r && r.code}${r && r.incomplete ? ' (incomplete)' : ''}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
