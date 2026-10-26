/* System administration commands: sudo su users/groups, processes (ps top kill ...),
 * systemd (systemctl journalctl hostnamectl timedatectl), packages (apt dpkg dnf rpm),
 * storage (df lsblk mount mkfs blkid fdisk swapon), kernel (sysctl dmesg lsmod), logging
 * (logger logrotate), cron, archives (tar gzip zip), and misc (time watch nohup ...). */
(function (IG) {
  'use strict';
  const U = IG.util;
  const VFS = IG.VFS;
  const L = IG.linux;
  const C = (IG.commands = IG.commands || {});
  const opts = (...a) => IG.cliOpts(...a);
  const out = () => IG.cliOut();
  const lines = t => { const l = String(t).split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  const join = l => (l.length ? l.join('\n') + '\n' : '');
  const human = (n, si) => IG.humanSize(n, si);
  const root = ctx => ctx.user === 'root';
  const need = (ctx, msg) => (root(ctx) ? null : { stdout: '', stderr: msg + '\n', code: 1 });
  const stamp = (t) => { const d = new Date(t); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} ${d.toISOString().slice(11, 19)}`; };

  /* ================================================================ sudo / su */
  C.sudo = (argv, ctx) => {
    const sh = ctx.shell, h = ctx.host;
    if (ctx.pod || ctx.container) return { stdout: '', stderr: 'sh: sudo: not found\n', code: 127 };
    let i = 0, target = 'root', login = false, shellMode = false, list = false, preserve = false;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-u') target = argv[++i];
      else if (/^-u./.test(a)) target = a.slice(2);
      else if (a === '-i' || a === '--login') login = true;
      else if (a === '-s' || a === '--shell') shellMode = true;
      else if (a === '-l' || a === '--list') list = true;
      else if (a === '-E' || a === '--preserve-env') preserve = true;
      else if (a === '-k' || a === '-K' || a === '-n' || a === '-H' || a === '-S') continue;
      else if (a === '--') { i++; break; }
      else if (/^-i./.test(a) || /^-iu/.test(a)) { login = true; if (a.includes('u')) target = argv[++i]; }
      else break;
    }
    void preserve;
    const me = ctx.user;
    if (me !== 'root' && !h.isSudoer(me)) {
      h.authLog(`sudo: ${me} : user NOT in sudoers ; TTY=pts/0 ; PWD=${ctx.cwd} ; USER=root ; COMMAND=${argv.slice(i).join(' ')}`);
      return { stdout: '', stderr: `[sudo] password for ${me}: \n${me} is not in the sudoers file.  This incident will be reported.\nℹ このユーザーは sudo グループ（RHEL では wheel）に入っていません。\n`, code: 1 };
    }
    if (list) return `Matching Defaults entries for ${me} on ${h.hostname}:\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty\n\nUser ${me} may run the following commands on ${h.hostname}:\n    (ALL : ALL) ALL\n    (ALL) NOPASSWD: ALL`;
    if (!h.users[target]) return { stdout: '', stderr: `sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit\n`, code: 1 };
    const rest = argv.slice(i);
    if (login || shellMode) {
      if (rest.length) return runAs(ctx, target, rest);
      const home = h.users[target].home;
      sh.stack.push({ host: h.name, user: target, cwd: login ? home : ctx.cwd, prev: ctx.cwd, via: 'sudo' });
      h.authLog(`sudo: ${me} : TTY=pts/0 ; PWD=${ctx.cwd} ; USER=${target} ; COMMAND=/bin/bash`);
      return '';
    }
    if (!rest.length) return { stdout: '', stderr: 'usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]\nusage: sudo [-ABbEHknPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i|-s] [<command>]\n', code: 1 };
    const builtin = IG.shellBuiltins[rest[0]] && !['echo', 'printf', 'test', '[', 'pwd', 'true', 'false', 'kill'].includes(rest[0]);
    if (builtin) return { stdout: '', stderr: `sudo: ${rest[0]}: command not found\nℹ ${rest[0]} はシェルの組み込みコマンドなので sudo では実行できません（sudo -i で root シェルに入るか、sudo bash -c '...' を使います）。\n`, code: 1 };
    h.authLog(`sudo: ${me} : TTY=pts/0 ; PWD=${ctx.cwd} ; USER=${target} ; COMMAND=${(sh.which(rest[0]) || { path: rest[0] }).path} ${rest.slice(1).join(' ')}`.trimEnd());
    return runAs(ctx, target, rest);
  };
  function runAs(ctx, user, argv) {
    const sh = ctx.shell;
    const prev = sh.euid;
    sh.euid = user;
    try { return { stdout: '', stderr: '', code: sh.invoke(argv, ctx.io) }; }
    finally { sh.euid = prev; }
  }
  C.su = (argv, ctx) => {
    const h = ctx.host, sh = ctx.shell;
    let login = false, cmd = null, target = 'root';
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-' || a === '-l' || a === '--login') login = true;
      else if (a === '-c' || a === '--command') cmd = argv[++i];
      else if (a === '-s') i++;
      else pos.push(a);
    }
    if (pos[0]) target = pos[0];
    if (!h.users[target]) return { stdout: '', stderr: `su: user ${target} does not exist or the user entry does not contain all the required fields\n`, code: 1 };
    if (ctx.user !== 'root') return { stdout: '', stderr: `Password: \nsu: Authentication failure\nℹ パスワード入力は再現できません。sudo su - ${target === 'root' ? '' : target} または sudo -iu ${target} を使ってください。\n`, code: 1 };
    const u = h.users[target];
    if (/nologin|false/.test(u.shell)) return { stdout: '', stderr: 'This account is currently not available.\n', code: 1 };
    if (cmd) return runAs(ctx, target, ['bash', '-c', cmd]);
    sh.stack.push({ host: h.name, user: target, cwd: login ? u.home : ctx.cwd, prev: ctx.cwd, via: 'su' });
    return '';
  };
  C.sudoedit = (argv, ctx) => runAs(ctx, 'root', ['vi', ...argv]);
  C.visudo = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: 'visudo: /etc/sudoers: Permission denied\n', code: 1 };
    const file = argv[argv.indexOf('-f') + 1] && argv.includes('-f') ? argv[argv.indexOf('-f') + 1] : '/etc/sudoers';
    if (argv.includes('-c')) return `${file}: parsed OK\n/etc/sudoers.d/90-cloud-init-users: parsed OK`;
    ctx.editor({ path: ctx.resolve(file), host: ctx.host.name, readonly: false, onSave: text => { const bad = text.split('\n').findIndex(l => l.trim() && !l.trim().startsWith('#') && !/^(Defaults|@include|%|\w|Cmnd_Alias|User_Alias|Host_Alias|Runas_Alias)/.test(l.trim())); return bad >= 0 ? { out: `>>> ${file}: syntax error near line ${bad + 1} <<<\nℹ 実際の visudo は保存前に構文を検査し、誤りがあると反映しません。`, err: true } : { out: '' }; } });
    return '';
  };

  /* ================================================================ users & groups */
  const NO_ROOT = cmd => `${cmd}: Permission denied.\n${cmd}: cannot lock /etc/passwd; try again later.`;
  C.useradd = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: NO_ROOT('useradd') + '\n', code: 1 };
    const { f, pos } = opts(argv, 'sdGgucep', ['shell', 'home-dir', 'groups', 'gid', 'uid', 'comment']);
    const h = ctx.host;
    const name = pos[0];
    if (!name) return { stdout: '', stderr: 'Usage: useradd [options] LOGIN\n', code: 2 };
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(name)) return { stdout: '', stderr: `useradd: invalid user name '${name}': use --badname to ignore\n`, code: 3 };
    if (h.users[name]) return { stdout: '', stderr: `useradd: user '${name}' already exists\n`, code: 9 };
    const groups = String(f.G || f.groups || '').split(',').filter(Boolean);
    const bad = groups.find(g => !h.groups[g]);
    if (bad) return { stdout: '', stderr: `useradd: group '${bad}' does not exist\n`, code: 6 };
    const createHome = h.os === 'rhel' ? !f.M : !!(f.m || f['create-home']);
    h.addUser(name, { shell: f.s || f.shell || (h.os === 'rhel' ? '/bin/bash' : '/bin/sh'), home: f.d || f['home-dir'], groups, uid: f.u || f.uid ? Number(f.u || f.uid) : undefined, gecos: f.c || f.comment || '', createHome });
    if (f.g || f.gid) { const g = h.groups[f.g || f.gid]; if (g) h.users[name].gid = g.gid; }
    h.syncAccounts();
    h.authLog(`useradd[${4000 + U.hash(name) % 900}]: new user: name=${name}, UID=${h.users[name].uid}, GID=${h.users[name].gid}, home=${h.users[name].home}, shell=${h.users[name].shell}, from=/dev/pts/0`);
    return '';
  };
  C.adduser = (argv, ctx) => {
    if (ctx.host.os === 'rhel') return C.useradd(['-m'].concat(argv), ctx);
    if (!root(ctx)) return { stdout: '', stderr: 'fatal: Only root may add a user or group to the system.\n', code: 1 };
    const name = argv.filter(a => !a.startsWith('-'))[0];
    if (argv.filter(a => !a.startsWith('-')).length === 2) return C.usermod(['-aG', argv.filter(a => !a.startsWith('-'))[1], name], ctx).code ? { stdout: '', stderr: 'adduser: failed\n', code: 1 } : `Adding user \`${name}' to group \`${argv.filter(a => !a.startsWith('-'))[1]}' ...\nDone.`;
    const r = C.useradd(['-m', '-s', '/bin/bash', name], ctx);
    if (r && r.code) return r;
    const u = ctx.host.users[name];
    return `Adding user \`${name}' ...\nAdding new group \`${name}' (${u.gid}) ...\nAdding new user \`${name}' (${u.uid}) with group \`${name}' ...\nCreating home directory \`${u.home}' ...\nCopying files from \`/etc/skel' ...\nℹ パスワード入力は再現できないため未設定のままです（echo '${name}:password' | sudo chpasswd で設定できます）。`;
  };
  C.usermod = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: NO_ROOT('usermod') + '\n', code: 1 };
    const { f, pos } = opts(argv, 'sdGglcu', ['shell', 'home', 'groups', 'gid', 'login', 'comment']);
    const h = ctx.host;
    const name = pos[0];
    if (!h.users[name]) return { stdout: '', stderr: `usermod: user '${name}' does not exist\n`, code: 6 };
    const u = h.users[name];
    if (f.G || f.groups) {
      const gs = String(f.G || f.groups).split(',');
      const bad = gs.find(g => !h.groups[g]);
      if (bad) return { stdout: '', stderr: `usermod: group '${bad}' does not exist\n`, code: 6 };
      if (!(f.a || f.append)) for (const g of Object.values(h.groups)) g.members.delete(name);
      gs.forEach(g => h.groups[g].members.add(name));
    }
    if (f.s || f.shell) u.shell = f.s || f.shell;
    if (f.c || f.comment) u.gecos = f.c || f.comment;
    if (f.d || f.home) { u.home = f.d || f.home; if (f.m) h.makeHome(name); }
    if (f.L || f.lock) u.locked = true;
    if (f.U || f.unlock) u.locked = false;
    if (f.l || f.login) { const nn = f.l || f.login; h.users[nn] = u; delete h.users[name]; }
    h.syncAccounts();
    return '';
  };
  C.userdel = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: NO_ROOT('userdel') + '\n', code: 1 };
    const { f, pos } = opts(argv);
    const h = ctx.host;
    const name = pos[0];
    if (!h.users[name]) return { stdout: '', stderr: `userdel: user '${name}' does not exist\n`, code: 6 };
    if (ctx.shell.stack.some(s => s.host === h.name && s.user === name)) return { stdout: '', stderr: `userdel: user ${name} is currently used by process ${4200 + U.hash(name) % 99}\n`, code: 8 };
    const home = h.users[name].home;
    delete h.users[name];
    for (const g of Object.values(h.groups)) g.members.delete(name);
    if (h.groups[name] && !Object.values(h.users).some(u => u.gid === h.groups[name].gid)) delete h.groups[name];
    if ((f.r || f.remove) && ctx.vfs.exists(home)) ctx.vfs.remove(home, true);
    h.syncAccounts();
    return (f.r || f.remove) && h.os === 'ubuntu' ? { stdout: '', stderr: `userdel: ${name} mail spool (/var/mail/${name}) not found\n`, code: 0 } : '';
  };
  C.groupadd = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: NO_ROOT('groupadd').replace('passwd', 'group') + '\n', code: 10 };
    const { f, pos } = opts(argv, 'g', ['gid']);
    const h = ctx.host;
    if (h.groups[pos[0]]) return { stdout: '', stderr: `groupadd: group '${pos[0]}' already exists\n`, code: 9 };
    const gid = f.g || f.gid ? Number(f.g || f.gid) : Math.max(999, ...Object.values(h.groups).filter(g => g.gid < 60000).map(g => g.gid)) + 1;
    h.groups[pos[0]] = { gid, members: new Set() };
    h.syncAccounts();
    return '';
  };
  C.groupdel = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: NO_ROOT('groupdel').replace('passwd', 'group') + '\n', code: 10 };
    const h = ctx.host;
    if (!h.groups[argv[0]]) return { stdout: '', stderr: `groupdel: group '${argv[0]}' does not exist\n`, code: 6 };
    if (Object.values(h.users).some(u => u.gid === h.groups[argv[0]].gid)) return { stdout: '', stderr: `groupdel: cannot remove the primary group of user '${Object.keys(h.users).find(u => h.users[u].gid === h.groups[argv[0]].gid)}'\n`, code: 8 };
    delete h.groups[argv[0]];
    h.syncAccounts();
    return '';
  };
  C.gpasswd = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: 'gpasswd: Permission denied.\n', code: 1 };
    const h = ctx.host;
    const [flag, user, group] = argv;
    if (!h.groups[group]) return { stdout: '', stderr: `gpasswd: group '${group}' does not exist in /etc/group\n`, code: 3 };
    if (flag === '-a') { h.groups[group].members.add(user); h.syncAccounts(); return `Adding user ${user} to group ${group}`; }
    if (flag === '-d') { h.groups[group].members.delete(user); h.syncAccounts(); return `Removing user ${user} from group ${group}`; }
    return { stdout: '', stderr: 'Usage: gpasswd [option] GROUP\n', code: 2 };
  };
  C.passwd = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv);
    const target = pos[0] || ctx.user;
    if (pos[0] && pos[0] !== ctx.user && !root(ctx)) return { stdout: '', stderr: `passwd: You may not view or modify password information for ${pos[0]}.\n`, code: 1 };
    if (!h.users[target]) return { stdout: '', stderr: `passwd: user '${target}' does not exist\n`, code: 1 };
    const u = h.users[target];
    if (f.S || f.status) return `${target} ${u.locked ? 'L' : u.password && !u.password.startsWith('!') && u.password !== '*' ? 'P' : 'NP'} 10/24/2026 0 99999 7 -1`;
    if (f.l || f.lock) { if (!root(ctx)) return { stdout: '', stderr: 'passwd: Permission denied.\n', code: 1 }; u.locked = true; h.syncAccounts(); return `passwd: password changed.`; }
    if (f.u || f.unlock) { if (!root(ctx)) return { stdout: '', stderr: 'passwd: Permission denied.\n', code: 1 }; u.locked = false; h.syncAccounts(); return `passwd: password changed.`; }
    if (f.e || f.expire) { if (!root(ctx)) return { stdout: '', stderr: 'passwd: Permission denied.\n', code: 1 }; u.expired = true; return 'passwd: password expiry information changed.'; }
    if (ctx.hasStdin && f.stdin) { u.password = '$6$' + U.hex(ctx.stdin, 16) + '$'; h.syncAccounts(); return 'passwd: password updated successfully'; }
    return { stdout: '', stderr: `New password: \nℹ 対話的なパスワード入力は再現できません。echo '${target}:新しいパスワード' | sudo chpasswd を使ってください。\npasswd: Authentication token manipulation error\npasswd: password unchanged\n`, code: 10 };
  };
  C.chpasswd = (argv, ctx) => {
    if (!root(ctx)) return { stdout: '', stderr: 'chpasswd: (user operator) pam_chauthtok() failed, error:\nAuthentication token manipulation error\nchpasswd: (line 1, user operator) password not changed\n', code: 1 };
    const h = ctx.host;
    const o = out();
    lines(ctx.stdin).forEach((l, i) => { const [u, p] = l.split(':'); if (!h.users[u]) { o.e(`chpasswd: (line ${i + 1}, user ${u}) password not changed`); return; } h.users[u].password = '$6$' + U.hex(u + p, 16) + '$' + U.hex(p + u, 43); });
    h.syncAccounts();
    return o.r();
  };
  C.chage = (argv, ctx) => {
    const { f, pos } = opts(argv, 'MmWEId');
    const u = pos[0];
    if (!ctx.host.users[u]) return { stdout: '', stderr: `chage: user '${u}' does not exist in /etc/passwd\n`, code: 1 };
    if (f.l) return `Last password change\t\t\t\t\t: Oct 12, 2026\nPassword expires\t\t\t\t\t: ${f.M ? 'Jan 10, 2027' : 'never'}\nPassword inactive\t\t\t\t\t: never\nAccount expires\t\t\t\t\t\t: never\nMinimum number of days between password change\t\t: 0\nMaximum number of days between password change\t\t: 99999\nNumber of days of warning before password expires\t: 7`;
    if (!root(ctx)) return { stdout: '', stderr: 'chage: Permission denied.\n', code: 1 };
    return '';
  };
  C.getent = (argv, ctx) => {
    const [db, key] = argv;
    const h = ctx.host;
    const v = ctx.vfs;
    if (db === 'passwd' || db === 'group') { const l = lines(v.read('/etc/' + db) || ''); const sel = key ? l.filter(x => x.split(':')[0] === key || x.split(':')[2] === key) : l; return { stdout: join(sel), stderr: '', code: sel.length ? 0 : 2 }; }
    if (db === 'shadow') return root(ctx) ? join(lines(v.read('/etc/shadow')).filter(x => !key || x.startsWith(key + ':'))) : { stdout: '', stderr: '', code: 2 };
    if (db === 'hosts' || db === 'ahosts') {
      if (!key) return v.read('/etc/hosts').split('\n').filter(l => l.trim() && !l.startsWith('#')).join('\n');
      const ip = ctx.world.resolveName(key, ctx.from);
      return ip ? `${ip.padEnd(15)} ${key}` : { stdout: '', stderr: '', code: 2 };
    }
    if (db === 'services') { const S = { ssh: '22/tcp', http: '80/tcp', https: '443/tcp', domain: '53/tcp', mysql: '3306/tcp', postgresql: '5432/tcp' }; return key ? (S[key] ? `${key.padEnd(21)} ${S[key]}` : { stdout: '', stderr: '', code: 2 }) : join(Object.entries(S).map(([k, x]) => `${k.padEnd(21)} ${x}`)); }
    return { stdout: '', stderr: `Unknown database: ${db}\nTry \`getent --help' or \`getent --usage' for more information.\n`, code: 1 };
  };
  C.who = (argv, ctx) => {
    const h = ctx.host;
    const sess = ctx.shell.stack.filter(s => s.host === h.name && !s.via);
    if (argv.includes('-b')) return `         system boot  ${IG.strftime('%F %R', h.bootAt)}`;
    if (argv.includes('-r')) return `         run-level 5  ${IG.strftime('%F %R', h.bootAt)}`;
    return join(sess.map((s, i) => `${s.user.padEnd(8)} pts/${i}        ${IG.strftime('%F %R', ctx.world.now() - 600e3)} (198.51.100.20)`));
  };
  C.w = (argv, ctx) => {
    const up = C.uptime([], ctx);
    const sess = ctx.shell.stack.filter(s => s.host === ctx.host.name && !s.via);
    return `${up}\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n${sess.map((s, i) => `${s.user.padEnd(8)} pts/${i}    198.51.100.20    ${IG.strftime('%R', ctx.world.now() - 600e3)}    0.00s  0.03s  0.00s w`).join('\n')}`;
  };
  C.users = (argv, ctx) => ctx.shell.stack.filter(s => s.host === ctx.host.name && !s.via).map(s => s.user).join(' ');
  C.last = (argv, ctx) => {
    const h = ctx.host;
    const u = h.user;
    const rows = [`${u.padEnd(8)} pts/0        198.51.100.20    ${IG.strftime('%a %b %e %R', ctx.world.now() - 600e3)}   still logged in`, `${u.padEnd(8)} pts/0        198.51.100.20    ${IG.strftime('%a %b %e %R', ctx.world.now() - 86400e3)} - ${IG.strftime('%R', ctx.world.now() - 80000e3)}  (01:46)`, `reboot   system boot  ${h.kernel.padEnd(16)} ${IG.strftime('%a %b %e %R', h.bootAt)}   still running`];
    return rows.join('\n') + `\n\nwtmp begins ${IG.strftime('%a %b %e %T %Y', h.bootAt - 30 * 86400e3)}`;
  };
  C.lastlog = (argv, ctx) => 'Username         Port     From             Latest\n' + Object.keys(ctx.host.users).map(u => (u === ctx.host.user ? `${u.padEnd(16)} pts/0    198.51.100.20    ${IG.strftime('%a %b %e %T +0000 %Y', ctx.world.now() - 600e3)}` : `${u.padEnd(16)}                            **Never logged in**`)).join('\n');

  /* ================================================================ processes */
  function sessionProcs(ctx) {
    const h = ctx.host;
    const res = [];
    const now = ctx.world.now();
    ctx.shell.stack.forEach((s, i) => {
      if (s.host !== h.name) return;
      const base = 4200 + i * 11;
      if (!s.via) res.push({ pid: base, ppid: h.pids.ssh || h.pids.sshd || 812, user: 'root', cmd: `sshd: ${s.user} [priv]`, tty: '?', stat: 'Ss', start: IG.strftime('%R', now - 600e3) });
      if (!s.via) res.push({ pid: base + 1, ppid: base, user: s.user, cmd: `sshd: ${s.user}@pts/${i}`, tty: '?', stat: 'S', start: IG.strftime('%R', now - 600e3) });
      if (s.via) res.push({ pid: base, ppid: base - 9, user: 'root', cmd: s.via === 'sudo' ? `sudo -i` : 'su -', tty: `pts/${i}`, stat: 'S', start: IG.strftime('%R', now - 60e3) });
      res.push({ pid: base + 2, ppid: s.via ? base : base + 1, user: s.user, cmd: '-bash', tty: `pts/${i}`, stat: 'Ss', start: IG.strftime('%R', now - 600e3) });
    });
    for (const j of ctx.shell.jobs.filter(x => !x.done)) res.push({ pid: j.pid, ppid: 4202, user: ctx.user, cmd: j.cmd, tty: 'pts/0', stat: 'S', start: IG.strftime('%R', now) });
    return res;
  }
  function allProcs(ctx, self = 'ps') {
    if (ctx.pod || ctx.container) {
      const img = (ctx.pod ? ctx.pod.image : ctx.container && ctx.container.name) || '';
      return [{ pid: 1, ppid: 0, user: ctx.pod && ctx.pod.openshift ? '1000680000' : 'root', cmd: /nginx/.test(img) ? 'nginx: master process nginx -g daemon off;' : 'python app.py', tty: '?', stat: 'Ss', start: '09:41', cpu: 0.1, mem: 0.4, vsz: 11000, rss: 7000, time: '0:00' }, { pid: 31, ppid: 0, user: 'root', cmd: self, tty: 'pts/0', stat: 'Rs+', start: '09:58', cpu: 0, mem: 0, vsz: 2500, rss: 1300, time: '0:00' }];
    }
    const sp = sessionProcs(ctx).map(p => Object.assign({ cpu: 0, mem: 0.1, vsz: 8900, rss: 5400, time: '0:00' }, p));
    const me = Math.max(...sp.map(p => p.pid)) + 40;
    return ctx.host.processes(sp.concat([{ pid: me, ppid: sp[sp.length - 1] ? sp[sp.length - 1].pid : 1, user: ctx.user, cmd: self, tty: 'pts/' + (ctx.shell.stack.length - 1), stat: 'R+', start: IG.strftime('%R', ctx.world.now()), cpu: 0, mem: 0, vsz: 10100, rss: 3500, time: '0:00' }]));
  }
  IG.allProcs = allProcs;
  const COLS = {
    pid: ['PID', p => String(p.pid), 7], ppid: ['PPID', p => String(p.ppid), 7], user: ['USER', p => p.user, -8], uid: ['UID', p => p.user, -8], '%cpu': ['%CPU', p => p.cpu.toFixed(1), 4], pcpu: ['%CPU', p => p.cpu.toFixed(1), 4],
    '%mem': ['%MEM', p => p.mem.toFixed(1), 4], pmem: ['%MEM', p => p.mem.toFixed(1), 4], vsz: ['VSZ', p => String(p.vsz), 6], rss: ['RSS', p => String(p.rss), 5], tty: ['TTY', p => p.tty, -8], stat: ['STAT', p => p.stat, -4],
    start: ['START', p => p.start, -5], time: ['TIME', p => p.time.padStart(5, '0').replace(/^0(\d):/, '$1:'), 8], cmd: ['CMD', p => p.cmd, 0], command: ['COMMAND', p => p.cmd, 0], args: ['COMMAND', p => p.cmd, 0],
    comm: ['COMMAND', p => p.cmd.replace(/^-/, '').split(/[\s:]/)[0].split('/').pop(), -15], etime: ['ELAPSED', () => '12-03:22:10', 11], nice: ['NI', () => '0', 3], ni: ['NI', () => '0', 3], pri: ['PRI', () => '19', 3],
  };
  C.ps = (argv, ctx) => {
    const a = argv.join(' ');
    const bsd = argv.length && !argv[0].startsWith('-');
    const f = new Set((bsd ? argv[0] : argv.filter(x => /^-[a-zA-Z]+$/.test(x)).join('').replace(/-/g, '')).split(''));
    let procs = allProcs(ctx);
    const valOf = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : (argv.find(x => x.startsWith(flag + '=')) || '').split('=')[1]; };
    const all = f.has('e') || f.has('A') || (bsd && (f.has('a') || f.has('x')));
    const userSel = valOf('-u') || valOf('-U') || valOf('--user');
    const pidSel = valOf('-p') || valOf('--pid');
    const cmdSel = valOf('-C');
    if (pidSel) procs = procs.filter(p => pidSel.split(',').includes(String(p.pid)));
    else if (cmdSel) procs = procs.filter(p => p.cmd.replace(/^-/, '').split(/[\s:]/)[0].split('/').pop() === cmdSel);
    else if (userSel) procs = procs.filter(p => userSel.split(',').includes(p.user));
    else if (!all) procs = procs.filter(p => p.tty === 'pts/' + (ctx.shell.stack.length - 1) && p.user === ctx.user || p.cmd === 'ps' && p.user === ctx.user);
    let sort = valOf('--sort');
    if (sort) { const desc = sort.startsWith('-'); const key = sort.replace(/^[-+]/, ''); const fn = { '%mem': p => p.mem, pmem: p => p.mem, '%cpu': p => p.cpu, pcpu: p => p.cpu, pid: p => p.pid, rss: p => p.rss, vsz: p => p.vsz }[key]; if (fn) procs.sort((x, y) => (desc ? fn(y) - fn(x) : fn(x) - fn(y))); }
    const custom = valOf('-o') || valOf('--format') || (argv.find(x => /^-\w*o$/.test(x)) ? argv[argv.indexOf(argv.find(x => /^-\w*o$/.test(x))) + 1] : null);
    let cols;
    if (custom) cols = custom.split(/[,\s]+/).map(c => { const [k, h] = c.split('='); return COLS[k] ? [h ?? COLS[k][0], COLS[k][1], COLS[k][2]] : null; }).filter(Boolean);
    else if (bsd && f.has('u')) cols = ['user', 'pid', '%cpu', '%mem', 'vsz', 'rss', 'tty', 'stat', 'start', 'time', 'command'].map(k => COLS[k]);
    else if (f.has('f')) cols = [['UID', p => p.user, -8], ['PID', p => String(p.pid), 7], ['PPID', p => String(p.ppid), 7], ['C', () => '0', 1], ['STIME', p => p.start, -5], ['TTY', p => p.tty, -8], ['TIME', p => '00:00:' + String(p.time.split(':')[1] || '00').padStart(2, '0'), 8], ['CMD', p => p.cmd, 0]];
    else if (bsd) cols = [['PID', p => String(p.pid), 7], ['TTY', p => p.tty, -8], ['STAT', p => p.stat, -4], ['TIME', p => p.time, 6], ['COMMAND', p => p.cmd, 0]];
    else cols = [['PID', p => String(p.pid), 7], ['TTY', p => p.tty, -8], ['TIME', p => '00:00:00', 8], ['CMD', p => p.cmd.replace(/^-/, '').split(' ')[0].split('/').pop(), 0]];
    if (/--no-headers?/.test(a)) return join(procs.map(p => cols.map(([, fn, w]) => (w > 0 ? fn(p).padStart(w) : w < 0 ? fn(p).padEnd(-w) : fn(p))).join(' ')));
    const rows = [cols.map(([h, , w]) => (w > 0 ? h.padStart(w) : w < 0 ? h.padEnd(-w) : h)).join(' ')].concat(procs.map(p => cols.map(([, fn, w]) => (w > 0 ? fn(p).padStart(w) : w < 0 ? fn(p).padEnd(-w) : fn(p))).join(' ')));
    return join(rows.map(r => r.replace(/\s+$/, '')));
  };
  function memInfo(h) {
    const total = h.memMiB * 1024;
    const procs = h.processes();
    const used = Math.min(total * 0.9, 380000 + procs.reduce((s, p) => s + (p.rss || 0), 0) + (h.extraProcs.reduce((s, p) => s + (p.mem || 0) * total / 100, 0)));
    const buff = Math.round(total * 0.28);
    return { total, used: Math.round(used), free: Math.round(total - used - buff), shared: 2048, buff, avail: Math.round(total - used) };
  }
  IG.memInfo = memInfo;
  function loadavg(h) { const cpu = h.processes().reduce((s, p) => s + (p.cpu || 0), 0) / 100; return [0.08 + cpu, 0.11 + cpu * 0.9, 0.09 + cpu * 0.8]; }
  C.top = (argv, ctx) => {
    const h = ctx.host;
    const procs = allProcs(ctx, 'top').sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
    const m = memInfo(h);
    const load = loadavg(h);
    const cpuSum = Math.min(100, procs.reduce((s, p) => s + p.cpu, 0) / h.cpus);
    const n = argv.includes('-n') ? Number(argv[argv.indexOf('-n') + 1]) : 1;
    void n;
    const up = ctx.world.now() - h.bootAt;
    const head = `top - ${IG.strftime('%T', ctx.world.now())} up ${Math.floor(up / 86400e3)} days, ${String(Math.floor((up % 86400e3) / 3600e3)).padStart(2)}:${String(Math.floor((up % 3600e3) / 60e3)).padStart(2, '0')},  1 user,  load average: ${load.map(x => x.toFixed(2)).join(', ')}\nTasks: ${procs.length + 96} total,   1 running, ${procs.length + 95} sleeping,   0 stopped,   0 zombie\n%Cpu(s):  ${cpuSum.toFixed(1)} us,  0.3 sy,  0.0 ni, ${(99.5 - cpuSum).toFixed(1)} id,  0.1 wa,  0.0 hi,  0.0 si,  0.1 st\nMiB Mem :   ${(m.total / 1024).toFixed(1)} total,   ${(m.free / 1024).toFixed(1)} free,   ${(m.used / 1024).toFixed(1)} used,   ${(m.buff / 1024).toFixed(1)} buff/cache\nMiB Swap: ${((IG.swapKiB ? IG.swapKiB(h) : 0) / 1024).toFixed(1).padStart(8)} total, ${((IG.swapKiB ? IG.swapKiB(h) : 0) / 1024).toFixed(1).padStart(8)} free,      0.0 used.   ${(m.avail / 1024).toFixed(1)} avail Mem\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n`;
    const rows = procs.slice(0, argv.includes('-b') ? procs.length : 20).map(p => `${String(p.pid).padStart(7)} ${p.user.slice(0, 8).padEnd(8)}  20   0 ${String(p.vsz).padStart(7)} ${String(p.rss).padStart(6)} ${String(Math.round(p.rss / 3)).padStart(6)} ${p.stat[0]} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(5)} ${('  ' + p.time + '.12').slice(-9)} ${p.cmd.replace(/^-/, '').split(/\s/)[0].split('/').pop().replace(/:$/, '')}`);
    const note = argv.includes('-b') ? '' : 'ℹ top は対話型のため、1 回分のスナップショットを表示しました（q で終了する操作は不要です）。\n';
    return { stdout: head + rows.join('\n') + '\n', stderr: note, code: 0 };
  };
  C.htop = (argv, ctx) => { const r = C.top(['-b'], ctx); r.stderr = 'ℹ htop は対話型のため、top -b 相当のスナップショットを表示しました。\n'; return r; };
  const SIGS = ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'POLL', 'PWR', 'SYS'];
  function signal(ctx, pid, sig) {
    const h = ctx.host;
    const p = allProcs(ctx).find(x => x.pid === pid);
    if (!p) return `(${pid}) - No such process`;
    if (ctx.user !== 'root' && p.user !== ctx.user) return `(${pid}) - Operation not permitted`;
    if (pid === 1) return null;
    if (sig === 0 || sig === 'CONT' || sig === 'STOP' || sig === 'WINCH' || sig === 'USR1' || sig === 'USR2') return null;
    const svc = p.svc;
    if (svc) {
      const def = L.SVC[svc] || {};
      const master = h.pids[svc] === pid;
      if (sig === 'HUP' && def.reload) { h.log(svc, `${svc}[${pid}]: signal 1 (SIGHUP) received, reconfiguring`); return null; }
      if (!master) { h.log(svc, `${svc}[${h.pids[svc]}]: worker process ${pid} exited on signal ${sig === 'KILL' ? 9 : 15}`); return null; }
      if (def.restart) {
        h.log(svc, `systemd[1]: ${svc}.service: Main process exited, code=killed, status=${sig === 'KILL' ? '9/KILL' : '15/TERM'}`);
        h.log(svc, `systemd[1]: ${svc}.service: Scheduled restart job, restart counter is at 1.`);
        h.setSvc(svc, 'active');
        h.log(svc, `systemd[1]: Started ${svc}.service - ${def.desc}.`);
      } else {
        h.setSvc(svc, sig === 'KILL' ? 'failed' : 'inactive');
        h.log(svc, `systemd[1]: ${svc}.service: ${sig === 'KILL' ? 'Main process exited, code=killed, status=9/KILL' : 'Deactivated successfully.'}`);
      }
      ctx.world.reconcile();
      return null;
    }
    const idx = h.extraProcs.findIndex(x => x.pid === pid);
    if (idx >= 0) { if (h.extraProcs[idx].ignoreTerm && sig === 'TERM') return null; h.extraProcs.splice(idx, 1); return null; }
    const job = ctx.shell.jobs.find(j => j.pid === pid);
    if (job) { job.done = true; return null; }
    if (/bash|sshd: /.test(p.cmd)) return null;
    return null;
  }
  function parseSig(a) {
    if (!a) return 'TERM';
    const s = a.replace(/^-/, '').replace(/^s\s*/, '').replace(/^SIG/i, '').toUpperCase();
    if (/^\d+$/.test(s)) return Number(s) === 0 ? 0 : SIGS[Number(s) - 1] || null;
    return SIGS.includes(s) ? s : null;
  }
  C.kill = (argv, ctx) => {
    const o = out();
    if (argv[0] === '-l' || argv[0] === '-L') return join(SIGS.map((s, i) => `${String(i + 1).padStart(2)}) SIG${s}`).reduce((acc, x, i) => (i % 5 ? (acc[acc.length - 1] += '\t' + x, acc) : acc.concat(x)), []));
    let sig = 'TERM';
    const pids = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-s' || a === '-n') { sig = parseSig(argv[++i]); continue; }
      if (/^-/.test(a) && !/^-\d+$/.test(a) || /^-\d+$/.test(a) && i === 0 && argv.length > 1) { sig = parseSig(a); if (sig === null) { o.e(`bash: kill: ${a.slice(1)}: invalid signal specification`); return o.r(); } continue; }
      pids.push(a);
    }
    if (!pids.length) { o.e('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', 2); return o.r(); }
    for (const p of pids) {
      if (p.startsWith('%')) { const j = ctx.shell.jobs.find(x => x.n === Number(p.slice(1)) || p === '%%' || p === '%+'); if (!j) { o.e(`bash: kill: ${p}: no such job`); continue; } j.done = true; o.o(`[${j.n}]+  Terminated              ${j.cmd}\n`); ctx.shell.jobs = ctx.shell.jobs.filter(x => x !== j); continue; }
      if (!/^-?\d+$/.test(p)) { o.e(`bash: kill: ${p}: arguments must be process or job IDs`); continue; }
      const err = signal(ctx, Number(p), sig);
      if (err) o.e(`bash: kill: ${err}`);
    }
    return o.r();
  };
  function matchProcs(ctx, pattern, full, user, exact) {
    const re = exact ? new RegExp('^' + pattern + '$') : new RegExp(pattern);
    return allProcs(ctx, '__self__').filter(p => p.cmd !== '__self__' && (!user || p.user === user) && re.test(full ? p.cmd : p.cmd.replace(/^-/, '').split(/[\s:]/)[0].split('/').pop()));
  }
  C.pgrep = (argv, ctx) => {
    const { f, pos } = opts(argv, 'u', ['signal']);
    if (!pos[0]) return { stdout: '', stderr: "pgrep: no matching criteria specified\nTry `pgrep --help' for more information.\n", code: 2 };
    const ps = matchProcs(ctx, pos[0], f.f, f.u, f.x);
    return { stdout: join(ps.map(p => (f.a ? `${p.pid} ${p.cmd}` : f.l ? `${p.pid} ${p.cmd.replace(/^-/, '').split(/[\s:]/)[0].split('/').pop()}` : String(p.pid)))), stderr: '', code: ps.length ? 0 : 1 };
  };
  C.pidof = (argv, ctx) => { const ps = matchProcs(ctx, argv.filter(a => !a.startsWith('-'))[0] || '', false, null, true); return { stdout: ps.length ? ps.map(p => p.pid).reverse().join(' ') + '\n' : '', stderr: '', code: ps.length ? 0 : 1 }; };
  C.pkill = (argv, ctx) => {
    const sigArg = argv.find(a => /^-(\d+|[A-Z]+)$/.test(a) || /^--signal=/.test(a));
    const sig = parseSig(sigArg ? sigArg.replace('--signal=', '') : null);
    const { f, pos } = opts(argv.filter(a => a !== sigArg), 'u');
    const ps = matchProcs(ctx, pos[0] || '', f.f, f.u, f.x);
    const o = out();
    for (const p of ps) { const e = signal(ctx, p.pid, sig); if (e) o.e(`pkill: killing pid ${p.pid} failed: Operation not permitted`); }
    if (!ps.length) o.code = 1;
    return o.r();
  };
  C.killall = (argv, ctx) => {
    const sigArg = argv.find(a => /^-(\d+|[A-Z]+)$/.test(a));
    const sig = parseSig(sigArg || null);
    const names = argv.filter(a => !a.startsWith('-'));
    const o = out();
    for (const n of names) {
      const ps = matchProcs(ctx, n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), false, null, true);
      if (!ps.length) { o.e(`${n}: no process found`); continue; }
      for (const p of ps) { const e = signal(ctx, p.pid, sig); if (e) o.e(`${n}(${p.pid}): Operation not permitted`); }
    }
    return o.r();
  };
  C.pstree = (argv, ctx) => {
    const ps = allProcs(ctx, 'pstree');
    const name = p => p.cmd.replace(/^-/, '').split(/[\s:]/)[0].split('/').pop() + (argv.includes('-p') ? `(${p.pid})` : '');
    const kids = pid => ps.filter(p => p.ppid === pid && p.pid !== pid);
    const outl = [];
    const walk = (p, pre, last, top) => {
      const label = name(p);
      outl.push(top ? label : pre + (last ? '└─' : '├─') + label);
      const k = kids(p.pid);
      k.forEach((c, i) => walk(c, top ? '' : pre + (last ? '  ' : '│ '), i === k.length - 1, false));
    };
    const rootp = ps.find(p => p.pid === 1);
    walk(rootp, '', true, true);
    return join(outl);
  };
  C.nice = (argv, ctx) => {
    let n = 10, i = 0;
    if (argv[0] === '-n') { n = Number(argv[1]); i = 2; } else if (/^-\d+$/.test(argv[0] || '')) { n = Number(argv[0].slice(1)); i = 1; } else if (/^--adjustment=/.test(argv[0] || '')) { n = Number(argv[0].split('=')[1]); i = 1; }
    if (!argv[i]) return '0';
    if (n < 0 && !root(ctx)) return Object.assign({ stderr: 'nice: cannot set niceness: Permission denied\n' }, { stdout: '', code: ctx.shell.invoke(argv.slice(i), ctx.io) });
    return { stdout: '', stderr: '', code: ctx.shell.invoke(argv.slice(i), ctx.io) };
  };
  C.renice = (argv, ctx) => {
    const { f, pos } = opts(argv, 'npgu');
    const n = Number(f.n ?? pos.shift());
    const pids = [f.p].concat(pos).filter(Boolean);
    const o = out();
    for (const p of pids) {
      const pr = allProcs(ctx).find(x => x.pid === Number(p));
      if (!pr) { o.e(`renice: failed to get priority for ${p} (process ID): No such process`); continue; }
      if ((n < 0 || pr.user !== ctx.user) && !root(ctx)) { o.e(`renice: failed to set priority for ${p} (process ID): Permission denied`); continue; }
      o.o(`${p} (process ID) old priority 0, new priority ${n}\n`);
    }
    return o.r();
  };
  C.nohup = (argv, ctx) => {
    if (!argv.length) return { stdout: '', stderr: "nohup: missing operand\nTry 'nohup --help' for more information.\n", code: 125 };
    const r = ctx.shell.runArgv(argv, null);
    const p = ctx.resolve('nohup.out');
    if (ctx.io.fd[1] && ctx.io.fd[1].term) { ctx.vfs.write(p, (ctx.vfs.read(p) || '') + (r.out ? r.out + '\n' : ''), ctx.vfs.exists(p) ? {} : { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user), mode: 0o600 }); return { stdout: '', stderr: "nohup: ignoring input and appending output to 'nohup.out'\n", code: r.code }; }
    return { stdout: r.out ? r.out + '\n' : '', stderr: '', code: r.code };
  };
  C.timeout = (argv, ctx) => {
    const args = argv.filter(a => !/^-(s|k|-signal|-kill-after)/.test(a));
    const dur = args.shift();
    if (!dur || !args.length) return { stdout: '', stderr: "timeout: missing operand\nTry 'timeout --help' for more information.\n", code: 125 };
    return { stdout: '', stderr: '', code: ctx.shell.invoke(args, ctx.io) };
  };
  C.watch = (argv, ctx) => {
    let i = 0, n = '2.0';
    while (argv[i] && argv[i].startsWith('-')) { if (argv[i] === '-n') n = Number(argv[++i]).toFixed(1); i++; }
    const cmd = argv.slice(i).join(' ');
    if (!cmd) return { stdout: '', stderr: 'Usage:\n watch [options] command\n', code: 1 };
    const r = ctx.shell.exec(cmd, ctx.pod ? { pod: ctx.pod } : null);
    return { stdout: `Every ${n}s: ${cmd}${' '.repeat(Math.max(1, 60 - cmd.length))}${ctx.host.hostname}: ${IG.strftime('%a %b %e %T %Y', ctx.world.now())}\n\n${r.out}\n`, stderr: 'ℹ watch は画面を更新し続けるコマンドです。シミュレータでは 1 回分を表示しました（もう一度実行すると最新状態になります）。\n', code: 0 };
  };
  C.time = (argv, ctx) => {
    const code = argv.length ? ctx.shell.invoke(argv, ctx.io) : 0;
    const r = (Math.random() * 0.05 + 0.002).toFixed(3);
    return { stdout: '', stderr: `\nreal\t0m${r}s\nuser\t0m0.00${Math.floor(Math.random() * 9)}s\nsys\t0m0.00${Math.floor(Math.random() * 9)}s\n`, code };
  };
  C.lsof = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'iuptc', []);
    let socks = h.sockets();
    const header = 'COMMAND    PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME';
    if (f.i !== undefined || argv.some(a => a.startsWith('-i'))) {
      const spec = argv.find(a => a.startsWith('-i')).slice(2) || (typeof f.i === 'string' ? f.i : '');
      const port = (spec.match(/:(\d+)/) || [])[1];
      if (port) socks = socks.filter(s => String(s.port) === port);
      if (!root(ctx)) socks = socks.filter(() => false);
      const rows = socks.map(s => `${s.proc.slice(0, 9).padEnd(9)} ${String(s.pid).padStart(5)} ${'root'.padStart(8)}    6u  IPv${s.proto === 'tcp6' ? 6 : 4} ${String(20000 + s.port).padStart(6)}      0t0  ${s.proto.startsWith('udp') ? 'UDP' : 'TCP'} ${s.addr === '0.0.0.0' ? '*' : s.addr}:${s.port}${s.proto.startsWith('udp') ? '' : ' (LISTEN)'}`);
      return { stdout: rows.length ? join([header].concat(rows)) : '', stderr: '', code: rows.length ? 0 : 1 };
    }
    if (pos[0]) {
      const p = ctx.resolve(pos[0]);
      const n = ctx.vfs.node(p);
      if (!n) return { stdout: '', stderr: `lsof: status error on ${pos[0]}: No such file or directory\n`, code: 1 };
      const holders = /\/var\/log\/(syslog|auth\.log|messages|kern\.log)/.test(p) ? [['rsyslogd', h.pids.rsyslog || 701, 'syslog']] : /nginx\/(access|error)\.log/.test(p) ? [['nginx', h.pids.nginx || 813, 'root']] : /\/var\/log\/app\//.test(p) ? [['app', 2210, 'root']] : [];
      if (!holders.length) return { stdout: '', stderr: '', code: 1 };
      return join([header].concat(holders.map(([c, pid, u]) => `${c.padEnd(9)} ${String(pid).padStart(5)} ${u.padStart(8)}    7w   REG  259,1 ${String(ctx.vfs.fileSize(n)).padStart(8)} ${100000 + (U.hash(p) % 900000)} ${p}`)));
    }
    return join([header].concat(allProcs(ctx, 'lsof').slice(0, 30).map(p => `${p.cmd.replace(/^-/, '').split(/[\s:]/)[0].split('/').pop().slice(0, 9).padEnd(9)} ${String(p.pid).padStart(5)} ${p.user.padStart(8)}  cwd    DIR  259,1     4096    2 /`)));
  };
  C.fuser = (argv, ctx) => {
    const t = argv.filter(a => !a.startsWith('-'))[0] || '';
    const m = t.match(/^(\d+)\/(tcp|udp)$/);
    if (m) { const s = ctx.host.sockets().find(x => String(x.port) === m[1]); return s ? { stdout: ` ${s.pid}\n`, stderr: `${t}:`, code: 0 } : { stdout: '', stderr: '', code: 1 }; }
    return { stdout: '', stderr: '', code: 1 };
  };

  /* ================================================================ memory / cpu / kernel */
  C.free = (argv, ctx) => {
    const m = memInfo(ctx.host);
    const sw = IG.swapKiB ? IG.swapKiB(ctx.host) : 0;
    const k = argv.join(' ');
    const fmt = v => (/-h|--human/.test(k) ? human(v * 1024).replace(/([KMGT])$/, '$1i').replace(/^(\d+)$/, '$1B') : /-g/.test(k) ? String(Math.floor(v / 1048576)) : /-m|--mega/.test(k) ? String(Math.floor(v / 1024)) : /-b/.test(k) ? String(v * 1024) : String(v));
    const rows = [['', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'], ['Mem:', fmt(m.total), fmt(m.used), fmt(m.free), fmt(m.shared), fmt(m.buff), fmt(m.avail)], ['Swap:', fmt(sw), fmt(0), fmt(sw)]];
    if (/-t/.test(k)) rows.push(['Total:', fmt(m.total), fmt(m.used), fmt(m.free)]);
    const w = [6, 12, 12, 12, 12, 12, 12];
    return join(rows.map(r => r.map((c, i) => (i === 0 ? c.padEnd(w[0]) : c.padStart(w[i]))).join('').replace(/\s+$/, '')));
  };
  C.vmstat = (argv, ctx) => {
    const m = memInfo(ctx.host);
    const n = Math.min(10, Number(argv.filter(a => /^\d+$/.test(a))[1] || 1));
    const row = () => ` 0  0      0 ${String(m.free).padStart(6)} ${String(Math.round(m.buff * 0.1)).padStart(6)} ${String(Math.round(m.buff * 0.9)).padStart(6)}    0    0     2     9   52  101  1  0 99  0  0`;
    return `procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n${Array.from({ length: n }, row).join('\n')}`;
  };
  C.iostat = (argv, ctx) => `Linux ${ctx.host.kernel} (${ctx.host.hostname}) \t${IG.strftime('%m/%d/%Y', ctx.world.now())} \t_x86_64_\t(${ctx.host.cpus} CPU)\n\navg-cpu:  %user   %nice %system %iowait  %steal   %idle\n           0.94    0.00    0.31    0.05    0.02   98.68\n\nDevice             tps    kB_read/s    kB_wrtn/s    kB_dscd/s    kB_read    kB_wrtn    kB_dscd\nnvme0n1           3.12        21.40        48.77         0.00    2310421    5263022          0`;
  C.mpstat = (argv, ctx) => `Linux ${ctx.host.kernel} (${ctx.host.hostname}) \t${IG.strftime('%m/%d/%Y', ctx.world.now())} \t_x86_64_\t(${ctx.host.cpus} CPU)\n\n${IG.strftime('%T', ctx.world.now())}     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle\n${IG.strftime('%T', ctx.world.now())}     all    0.94    0.00    0.31    0.05    0.00    0.02    0.02    0.00    0.00   98.66`;
  C.lscpu = (argv, ctx) => `Architecture:            x86_64\n  CPU op-mode(s):        32-bit, 64-bit\n  Address sizes:         46 bits physical, 48 bits virtual\n  Byte Order:            Little Endian\nCPU(s):                  ${ctx.host.cpus}\n  On-line CPU(s) list:   0-${ctx.host.cpus - 1}\nVendor ID:               GenuineIntel\n  Model name:            Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz\n    CPU family:          6\n    Model:               85\n    Thread(s) per core:  2\n    Core(s) per socket:  ${ctx.host.cpus / 2 || 1}\n    Socket(s):           1\nVirtualization features: \n  Hypervisor vendor:     KVM\n  Virtualization type:   full\nCaches (sum of all):     \n  L1d:                   32 KiB (1 instance)\n  L2:                    1 MiB (1 instance)\n  L3:                    35.8 MiB (1 instance)`;
  C.sysctl = (argv, ctx) => {
    const h = ctx.host;
    const o = out();
    const sync = (k, v) => { h.sysctl[k] = v; const p = '/proc/sys/' + k.replace(/\./g, '/'); if (ctx.vfs.exists(p)) ctx.vfs.write(p, v + '\n'); };
    if (argv.includes('-a') || argv.includes('--all') || !argv.length) return join(Object.entries(h.sysctl).sort().map(([k, v]) => `${k} = ${v}`));
    if (argv.includes('-p') || argv.includes('--load') || argv.includes('--system')) {
      if (!root(ctx)) return { stdout: '', stderr: `sysctl: permission denied on key "${Object.keys(h.sysctl)[0]}"\n`, code: 255 };
      const files = argv.includes('--system') ? ['/etc/sysctl.conf', ...ctx.vfs.walk('/etc/sysctl.d').filter(x => x.endsWith('.conf'))] : [argv[argv.indexOf('-p') + 1] && !argv[argv.indexOf('-p') + 1].startsWith('-') ? argv[argv.indexOf('-p') + 1] : '/etc/sysctl.conf'];
      for (const fp of files) for (const l of lines(ctx.vfs.read(ctx.resolve(fp)) || '')) { const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)$/); if (m) { sync(m[1], m[2].trim()); o.o(`${m[1]} = ${m[2].trim()}\n`); } }
      return o.r();
    }
    for (const a of argv.filter(x => x !== '-w' && x !== '-n' && x !== '-q')) {
      const m = a.match(/^([\w.]+)=(.*)$/);
      if (m) { if (!root(ctx)) { o.e(`sysctl: permission denied on key "${m[1]}"`, 255); continue; } if (!(m[1] in h.sysctl)) { o.e(`sysctl: cannot stat /proc/sys/${m[1].replace(/\./g, '/')}: No such file or directory`, 255); continue; } sync(m[1], m[2]); if (!argv.includes('-q')) o.o(`${m[1]} = ${m[2]}\n`); continue; }
      if (!(a in h.sysctl)) { o.e(`sysctl: cannot stat /proc/sys/${a.replace(/\./g, '/')}: No such file or directory`, 255); continue; }
      o.o(argv.includes('-n') ? h.sysctl[a] + '\n' : `${a} = ${h.sysctl[a]}\n`);
    }
    return o.r();
  };
  C.dmesg = (argv, ctx) => {
    const h = ctx.host;
    if (!root(ctx) && h.os === 'ubuntu') return { stdout: '', stderr: 'dmesg: read kernel buffer failed: Operation not permitted\n', code: 1 };
    const base = [[0.0, `Linux version ${h.kernel} (buildd@lcy02-amd64-001) (x86_64-linux-gnu-gcc-12 (Ubuntu 12.3.0-1ubuntu1~22.04) 12.3.0) #72-Ubuntu SMP`], [0.0, `Command line: BOOT_IMAGE=/boot/vmlinuz-${h.kernel} root=PARTUUID=8d6b5a4e-01 ro console=tty1 console=ttyS0 nvme_core.io_timeout=4294967295 panic=-1`], [0.12, `Memory: ${h.memMiB * 1024 - 210000}K/${h.memMiB * 1024}K available`], [1.84, 'nvme nvme0: 2/0/0 default/read/poll queues'], [1.9, ' nvme0n1: p1 p14 p15'], [3.2, 'EXT4-fs (nvme0n1p1): mounted filesystem with ordered data mode. Quota mode: none.'], [6.4, 'ena 0000:00:05.0 eth0: renamed from ens5']].concat(h.kmsg || []);
    const f = argv.join(' ');
    return join(base.filter(([, m]) => !/-l\s*err/.test(f) || /error|fail|oom|killed/i.test(m)).map(([t, m]) => (/-T/.test(f) ? `[${IG.strftime('%a %b %e %T %Y', h.bootAt + t * 1000)}] ${m}` : `[${t.toFixed(6).padStart(12)}] ${m}`)));
  };
  C.lsmod = () => 'Module                  Size  Used by\ntls                   151552  0\nnf_conntrack          196608  2 nf_nat,xt_conntrack\nbr_netfilter           32768  0\noverlay               192512  0\nena                   147456  0\nnvme                   61440  2\nnvme_core             208896  3 nvme';
  C.modprobe = (argv, ctx) => need(ctx, 'modprobe: ERROR: could not insert \'' + (argv.filter(a => !a.startsWith('-'))[0] || '') + "': Operation not permitted") || '';

  /* storage (df lsblk mount mkfs lvm swap ...) lives in storage.js */

  /* ================================================================ systemd */
  function unitPath(h, s) {
    for (const d of ['/etc/systemd/system/', h.os === 'ubuntu' ? '/lib/systemd/system/' : '/usr/lib/systemd/system/']) if (h.vfs.exists(d + s + '.service')) return d + s + '.service';
    return null;
  }
  function unitInfo(h, s) {
    const p = unitPath(h, s);
    const txt = p ? h.vfs.read(p) : '';
    const get = k => ((txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').trim();
    return { path: p, desc: get('Description') || (L.SVC[s] || {}).desc || s, exec: get('ExecStart'), type: get('Type'), user: get('User'), restart: get('Restart'), text: txt, mtime: p ? h.vfs.node(p).mtime : 0 };
  }
  function changedOnDisk(h, s) { const i = unitInfo(h, s); h.unitLoaded = h.unitLoaded || {}; return h.unitLoaded[s] !== undefined && i.mtime > h.unitLoaded[s]; }
  function startService(ctx, h, s, verb) {
    const info = unitInfo(h, s);
    h.unitLoaded = h.unitLoaded || {};
    if (h.unitLoaded[s] === undefined) h.unitLoaded[s] = info.mtime;
    // custom unit: check ExecStart target
    if (!(s in L.SVC) && info.exec) {
      const bin = info.exec.replace(/^[-@+!]+/, '').split(/\s+/)[0];
      if (!h.vfs.exists(bin)) { h.setSvc(s, 'failed'); h.log(s, `systemd[1]: ${s}.service: Failed to locate executable ${bin}: No such file or directory`); h.log(s, `systemd[1]: ${s}.service: Failed at step EXEC spawning ${bin}: No such file or directory`); h.log(s, `systemd[1]: ${s}.service: Main process exited, code=exited, status=203/EXEC`); h.log(s, `systemd[1]: ${s}.service: Failed with result 'exit-code'.`); return `Job for ${s}.service failed because the control process exited with error code.`; }
      if (!(h.vfs.node(bin).mode & 0o111)) { h.setSvc(s, 'failed'); h.log(s, `systemd[1]: ${s}.service: Failed to execute ${bin}: Permission denied`); h.log(s, `systemd[1]: ${s}.service: Main process exited, code=exited, status=203/EXEC`); return `Job for ${s}.service failed because the control process exited with error code.`; }
      h.extraProcs = h.extraProcs.filter(p => p.svcCustom !== s);
      const pid = 3000 + (U.hash(s + ctx.world.now()) % 900);
      h.pids[s] = pid;
      h.extraProcs.push({ pid, ppid: 1, user: info.user || 'root', cmd: info.exec.replace(/^[-@+!]+/, ''), cpu: 0, mem: 0.2, stat: 'Ss', svc: s, svcCustom: s });
    }
    const err = h.checks[s] ? h.checks[s](h) : s === 'nginx' && !h.web ? nginxCheck(h) : null;
    if (err) {
      h.setSvc(s, 'failed');
      for (const l of err) h.log(s, `${s}[${2400 + (U.hash(l) % 99)}]: ${l}`);
      h.log(s, `systemd[1]: ${s}.service: Control process exited, code=exited, status=1/FAILURE`);
      h.log(s, `systemd[1]: ${s}.service: Failed with result 'exit-code'.`);
      h.log(s, `systemd[1]: Failed to start ${s}.service - ${info.desc}.`);
      ctx.world.emit(`${h.hostname}: ${s} failed to ${verb}`, 'WARN');
      return `Job for ${s}.service failed because the control process exited with error code.`;
    }
    h.log(s, `systemd[1]: Starting ${s}.service - ${info.desc}...`);
    h.setSvc(s, 'active');
    h.log(s, `systemd[1]: Started ${s}.service - ${info.desc}.`);
    ctx.world.emit(`${h.hostname}: systemctl ${verb} ${s}`);
    return null;
  }
  function nginxCheck(h) {
    const files = ['/etc/nginx/nginx.conf', ...h.vfs.walk('/etc/nginx/sites-enabled'), ...h.vfs.walk('/etc/nginx/conf.d')].filter(p => h.vfs.isFile(p));
    for (const p of files) {
      // statement tokenizer: words up to ';' '{' or '}', tracking line numbers and block nesting
      const txt = h.vfs.read(p).replace(/#[^\n]*/g, '');
      const stack = [];
      let buf = '', line = 1, startLine = 1;
      for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (c === '\n') line++;
        if (c !== ';' && c !== '{' && c !== '}') { if (!buf.trim()) startLine = line; buf += c; continue; }
        const words = buf.trim().split(/\s+/).filter(Boolean);
        buf = '';
        if (c === '}') {
          if (words.length) return [`nginx: [emerg] directive "${words[0]}" is not terminated by ";" in ${p}:${line}`];
          if (!stack.length) return [`nginx: [emerg] unexpected "}" in ${p}:${line}`];
          stack.pop();
          continue;
        }
        if (!words.length) { if (c === '{') return [`nginx: [emerg] unexpected "{" in ${p}:${line}`]; continue; }
        const inTypes = stack[stack.length - 1] === 'types';
        if (!inTypes && !NGINX_DIRECTIVES.has(words[0])) return [`nginx: [emerg] unknown directive "${words[0]}" in ${p}:${startLine}`];
        if (!inTypes && words[0] === 'listen' && !/^(\[?[\d.:\]*]*:)?\d+$/.test(words[1] || '')) return [`nginx: [emerg] invalid port in "${words[1] || ''}" of the "listen" directive in ${p}:${startLine}`];
        if (c === '{') stack.push(words[0]);
      }
      if (buf.trim()) return [`nginx: [emerg] unexpected end of file, expecting ";" or "}" in ${p}:${line}`];
      if (stack.length) return [`nginx: [emerg] unexpected end of file, expecting "}" in ${p}:${line}`];
    }
    const ports = new Set();
    for (const p of files) for (const m of (h.vfs.read(p) || '').matchAll(/^\s*listen\s+(\d+)/gm)) { if (Number(m[1]) < 1024 || true) ports.add(Number(m[1])); }
    for (const port of ports) { const other = h.sockets().find(s => s.port === port && s.svc !== 'nginx'); if (other) return [`nginx: [emerg] bind() to 0.0.0.0:${port} failed (98: Address already in use)`]; }
    return null;
  }
  const NGINX_DIRECTIVES = new Set('user worker_processes pid include events worker_connections http sendfile tcp_nopush types_hash_max_size default_type access_log error_log gzip server listen server_name root index location try_files return proxy_pass proxy_set_header add_header types upstream keepalive_timeout client_max_body_size ssl_certificate ssl_certificate_key ssl_protocols rewrite alias autoindex deny allow expires charset log_format server_tokens limit_req proxy_read_timeout fastcgi_pass error_page if set ssl_ciphers proxy_http_version'.split(' '));
  function svcStatus(ctx, h, s) {
    const st = h.svcState(s);
    const info = unitInfo(h, s);
    const def = L.SVC[s] || {};
    const enabled = h.enabled[s] !== false;
    const lines2 = [];
    const dot = st === 'active' ? '●' : st === 'failed' ? '×' : '○';
    lines2.push(`${dot} ${s}.service - ${info.desc}`);
    lines2.push(`     Loaded: ${h.masked.has(s) ? 'masked (Reason: Unit ' + s + '.service is masked.)' : `loaded (${info.path || '/lib/systemd/system/' + s + '.service'}; ${enabled ? 'enabled' : 'disabled'}; vendor preset: enabled)`}`);
    const since = IG.strftime('%a %F %T UTC', st === 'active' ? h.bootAt + 2000 : ctx.world.now() - 240e3);
    lines2.push(`     Active: ${st === 'active' ? `active (running) since ${since}; ${Math.floor((ctx.world.now() - h.bootAt) / 86400e3)} days ago` : st === 'failed' ? `failed (Result: exit-code) since ${since}; 4min ago` : `inactive (dead)${h.journal[s] ? ' since ' + since + '; 4min ago' : ''}`}`);
    if (st === 'active' && !def.oneshot) {
      const procs = h.processes().filter(p => p.svc === s);
      const main = procs.find(p => p.pid === h.pids[s]) || procs[0];
      if (main) {
        lines2.push(`   Main PID: ${main.pid} (${main.cmd.split(/[\s:]/)[0].split('/').pop()})`, `      Tasks: ${procs.length + (/kubelet|dockerd|containerd/.test(main.cmd) ? 14 : 0)} (limit: 9387)`, `     Memory: ${(main.rss / 1024).toFixed(1)}M`, `        CPU: ${main.time.replace(':', 'min ')}s`, `     CGroup: /system.slice/${s}.service`);
        procs.forEach((p, i) => lines2.push(`             ${i === procs.length - 1 ? '└─' : '├─'}${p.pid} "${p.cmd}"`));
      }
    }
    const j = (h.journal[s] || []).slice(-10);
    if (j.length) lines2.push('', ...j);
    if (changedOnDisk(h, s)) lines2.splice(1, 0, `Warning: The unit file, source configuration file or drop-ins of ${s}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
    return { text: lines2.join('\n') + '\n', code: st === 'active' ? 0 : 3 };
  }
  C.systemctl = (argv, ctx) => {
    if (ctx.pod || ctx.container) return { stdout: '', stderr: 'System has not been booted with systemd as init system (PID 1). Can\'t operate.\nFailed to connect to bus: Host is down\n', code: 1 };
    const h = ctx.host;
    const o = out();
    const flags = argv.filter(a => a.startsWith('-'));
    const pos = argv.filter(a => !a.startsWith('-'));
    let [verb, ...units] = pos;
    if (!verb || verb === 'list-units') {
      const failedOnly = flags.includes('--failed') || flags.some(f => /--state=failed/.test(f));
      const all = Object.keys(h.services).concat(h.name === 'bastion' ? ['docker', 'containerd'] : []).filter((x, i, a) => a.indexOf(x) === i).sort();
      const rows = all.map(s => ({ s, st: h.svcState(s) })).filter(r => (failedOnly ? r.st === 'failed' : flags.includes('--all') || r.st !== 'inactive') && !(flags.some(f => /--state=running/.test(f)) && r.st !== 'active'));
      o.o(`  UNIT${' '.repeat(36)}LOAD   ACTIVE   SUB     DESCRIPTION\n` + rows.map(r => `${r.st === 'failed' ? '●' : ' '} ${(r.s + '.service').padEnd(39)} loaded ${({ active: 'active  ', failed: 'failed  ', inactive: 'inactive' })[r.st]} ${({ active: 'running', failed: 'failed ', inactive: 'dead   ' })[r.st]} ${unitInfo(h, r.s).desc}`).join('\n') + `\n\nLOAD   = Reflects whether the unit definition was properly loaded.\nACTIVE = The high-level unit activation state, i.e. generalization of SUB.\nSUB    = The low-level unit activation state, values depend on unit type.\n${rows.length} loaded units listed.\n`);
      return o.r();
    }
    if (verb === 'list-unit-files') return join(['UNIT FILE                              STATE           VENDOR PRESET'].concat(Object.keys(h.services).sort().map(s => `${(s + '.service').padEnd(38)} ${h.masked.has(s) ? 'masked ' : h.enabled[s] === false ? 'disabled' : 'enabled '}         enabled`), ['', `${Object.keys(h.services).length} unit files listed.`]));
    if (verb === 'daemon-reload') { if (!root(ctx)) { o.e('Failed to reload daemon: Access denied'); return o.r(); } h.systemdFstab = ctx.world.now(); h.unitLoaded = h.unitLoaded || {}; for (const s of Object.keys(h.services)) h.unitLoaded[s] = unitInfo(h, s).mtime; for (const p of ctx.vfs.walk('/etc/systemd/system').filter(x => x.endsWith('.service'))) { const s = VFS.base(p).replace(/\.service$/, ''); h.unitLoaded[s] = ctx.vfs.node(p).mtime; if (!(s in h.services)) { h.services[s] = 'inactive'; h.enabled[s] = false; } } return o.r(); }
    if (verb === 'list-timers') return 'NEXT                        LEFT          LAST                        PASSED       UNIT                         ACTIVATES\nSun 2026-10-25 00:00:00 UTC 13h left      Sat 2026-10-24 00:00:00 UTC 10h ago      logrotate.timer              logrotate.service\nSun 2026-10-25 06:41:12 UTC 20h left      Sat 2026-10-24 06:41:12 UTC 3h 18min ago apt-daily-upgrade.timer      apt-daily-upgrade.service\n\n2 timers listed.\nPass --all to see loaded but inactive timers, too.';
    if (['reboot', 'poweroff', 'halt'].includes(verb)) return C.reboot([], ctx);
    if (['get-default'].includes(verb)) return 'multi-user.target';
    if (!units.length) { o.e(`Too few arguments.`); return o.r(); }
    for (let u of units) {
      const s = h.svcName(u);
      const known = h.knownService(s) || !!unitPath(h, s);
      if (!known) {
        if (verb === 'status') o.e(`Unit ${s}.service could not be found.`, 4);
        else if (verb === 'is-active') { o.o('inactive\n'); o.code = 3; }
        else if (verb === 'is-enabled') { o.e(`Failed to get unit file state for ${s}.service: No such file or directory`, 1); }
        else o.e(`Failed to ${verb} ${s}.service: Unit ${s}.service not found.`, 5);
        continue;
      }
      if (!(s in h.services) && s !== 'docker' && s !== 'containerd') { h.services[s] = 'inactive'; h.enabled[s] = false; }
      const authFail = () => o.e(`Failed to ${verb} ${s}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${s}.service' for details.\nℹ サービスの操作には sudo が必要です。`);
      switch (verb) {
        case 'status': { const r = svcStatus(ctx, h, s); o.o(r.text); o.code = Math.max(o.code, r.code); break; }
        case 'is-active': o.o((h.svcState(s) === 'active' ? 'active' : h.svcState(s) === 'failed' ? 'failed' : 'inactive') + '\n'); if (h.svcState(s) !== 'active') o.code = 3; break;
        case 'is-enabled': o.o((h.masked.has(s) ? 'masked' : h.enabled[s] === false ? 'disabled' : 'enabled') + '\n'); if (h.enabled[s] === false || h.masked.has(s)) o.code = 1; break;
        case 'is-failed': o.o((h.svcState(s) === 'failed' ? 'failed' : h.svcState(s)) + '\n'); if (h.svcState(s) !== 'failed') o.code = 1; break;
        case 'cat': { const i = unitInfo(h, s); o.o(`# ${i.path}\n${i.text}`); break; }
        case 'show': { const i = unitInfo(h, s); const props = { Id: s + '.service', Description: i.desc, LoadState: 'loaded', ActiveState: h.svcState(s), SubState: h.svcState(s) === 'active' ? 'running' : 'dead', MainPID: h.svcState(s) === 'active' ? h.pids[s] || 0 : 0, UnitFileState: h.enabled[s] === false ? 'disabled' : 'enabled', ExecStart: `{ path=${i.exec.split(' ')[0]} ; argv[]=${i.exec} }`, Restart: i.restart || 'no', User: i.user || '' }; const want = flags.find(f => f.startsWith('-p') || f.startsWith('--property')); const keys = want ? (want.split('=')[1] || pos[pos.indexOf(u) - 1] || '').split(',') : Object.keys(props); o.o(join(keys.filter(k => k in props).map(k => (flags.includes('--value') ? String(props[k]) : `${k}=${props[k]}`)))); break; }
        case 'start': case 'restart': case 'try-restart': case 'reload-or-restart': {
          if (!root(ctx)) { authFail(); break; }
          if (h.masked.has(s)) { o.e(`Failed to ${verb} ${s}.service: Unit ${s}.service is masked.`); break; }
          if (verb === 'try-restart' && h.svcState(s) !== 'active') break;
          if (changedOnDisk(h, s)) o.e(`Warning: The unit file, source configuration file or drop-ins of ${s}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`, 0);
          if (verb === 'start' && h.svcState(s) === 'active') break;
          if (verb !== 'start' && h.svcState(s) === 'active') h.log(s, `systemd[1]: Stopping ${s}.service - ${unitInfo(h, s).desc}...`);
          const err = startService(ctx, h, s, verb);
          if (err) o.e(`${err}\nSee "systemctl status ${s}.service" and "journalctl -xeu ${s}.service" for details.`);
          ctx.world.reconcile();
          break;
        }
        case 'stop': if (!root(ctx)) { authFail(); break; } if (h.svcState(s) === 'active') { h.log(s, `systemd[1]: Stopping ${s}.service - ${unitInfo(h, s).desc}...`); h.setSvc(s, 'inactive'); h.log(s, `systemd[1]: ${s}.service: Deactivated successfully.`); h.log(s, `systemd[1]: Stopped ${s}.service - ${unitInfo(h, s).desc}.`); ctx.world.emit(`${h.hostname}: systemctl stop ${s}`, 'WARN'); } ctx.world.reconcile(); break;
        case 'reload': {
          if (!root(ctx)) { authFail(); break; }
          if (h.svcState(s) !== 'active') { o.e(`${s}.service is not active, cannot reload.`); break; }
          if (!(L.SVC[s] || {}).reload && !/ExecReload/.test(unitInfo(h, s).text)) { o.e(`Failed to reload ${s}.service: Job type reload is not applicable for unit ${s}.service.`); break; }
          const err = h.checks[s] ? h.checks[s](h) : s === 'nginx' && !h.web ? nginxCheck(h) : null;
          if (err) { for (const l of err) h.log(s, `${s}[${h.pids[s]}]: ${l}`); h.log(s, `systemd[1]: ${s}.service: Control process exited, code=exited, status=1/FAILURE`); h.log(s, `systemd[1]: Reload failed for ${s}.service - ${unitInfo(h, s).desc}.`); o.e(`Job for ${s}.service failed because the control process exited with error code.\nSee "systemctl status ${s}.service" and "journalctl -xeu ${s}.service" for details.`); break; }
          h.log(s, `systemd[1]: Reloading ${s}.service - ${unitInfo(h, s).desc}...`); h.log(s, `systemd[1]: Reloaded ${s}.service - ${unitInfo(h, s).desc}.`);
          break;
        }
        case 'enable': case 'disable': {
          if (!root(ctx)) { o.e(`Failed to ${verb} unit: Interactive authentication required.`); break; }
          const was = h.enabled[s] !== false;
          h.enabled[s] = verb === 'enable';
          if (verb === 'enable' && !was) o.e(`Created symlink /etc/systemd/system/multi-user.target.wants/${s}.service → ${unitInfo(h, s).path || '/lib/systemd/system/' + s + '.service'}.`, 0);
          if (verb === 'disable' && was) o.e(`Removed "/etc/systemd/system/multi-user.target.wants/${s}.service".`, 0);
          if (flags.includes('--now')) { if (verb === 'enable') { const err = startService(ctx, h, s, 'start'); if (err) o.e(err); } else { h.setSvc(s, 'inactive'); } ctx.world.reconcile(); }
          break;
        }
        case 'mask': if (!root(ctx)) { authFail(); break; } h.masked.add(s); o.e(`Created symlink /etc/systemd/system/${s}.service → /dev/null.`, 0); break;
        case 'unmask': if (!root(ctx)) { authFail(); break; } h.masked.delete(s); o.e(`Removed "/etc/systemd/system/${s}.service".`, 0); break;
        case 'edit': o.e('ℹ systemctl edit の代わりに sudo vi /etc/systemd/system/<name>.service.d/override.conf を作成し、sudo systemctl daemon-reload を実行してください。'); break;
        default: o.e(`Unknown command verb '${verb}'.`);
      }
    }
    return o.r();
  };
  C.service = (argv, ctx) => {
    if (argv[0] === '--status-all') return join(Object.keys(ctx.host.services).sort().map(s => ` [ ${ctx.host.svcState(s) === 'active' ? '+' : '-'} ]  ${s}`));
    const [name, action] = argv;
    if (!name || !action) return { stdout: '', stderr: 'Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n', code: 1 };
    return C.systemctl([action, name], ctx);
  };
  C.journalctl = (argv, ctx) => {
    const h = ctx.host;
    const { f } = opts(argv, 'unpSUt', ['unit', 'lines', 'priority', 'since', 'until', 'identifier', 'output']);
    if (!root(ctx) && !h.inGroup(ctx.user, 'systemd-journal') && !h.inGroup(ctx.user, 'adm') && !h.inGroup(ctx.user, 'wheel')) {
      return { stdout: '-- No entries --\n', stderr: 'Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\' can see all messages.\n      Pass -q to turn off this notice.\n', code: 0 };
    }
    const units = [].concat(f.u || f.unit || []).map(u => String(u).replace(/\.service$/, ''));
    let entries;
    if (units.length) entries = units.flatMap(u => (h.journal[u === 'sshd' && h.journal.ssh ? 'ssh' : u] || []).map(l => ({ l, u })));
    else if (f.k || f.dmesg) entries = lines(C.dmesg([], { host: h, user: 'root', world: ctx.world }).toString()).map(l => ({ l: `${stamp(h.bootAt)} ${h.hostname} kernel: ${l.replace(/^\[[\d.\s]+\]\s*/, '')}`, u: 'kernel' }));
    else entries = lines(ctx.vfs.read(h.os === 'ubuntu' ? '/var/log/syslog' : '/var/log/messages') || '').map(l => ({ l, u: '' })).concat(Object.entries(h.journal).flatMap(([u, ls]) => ls.map(l => ({ l, u }))).filter(e => !/^\w{3} \d\d \d\d:\d\d:\d\d/.test(e.l) || true));
    // dynamic kubelet eviction messages
    if (units.includes('kubelet') && h.diskPct() >= 85) entries.push({ l: `${stamp(ctx.world.now() - 30e3)} ${h.hostname} kubelet[1290]: I1024 01:10:02.512 eviction_manager.go:366] "Eviction manager: attempting to reclaim" resourceName="ephemeral-storage"` }, { l: `${stamp(ctx.world.now() - 29e3)} ${h.hostname} kubelet[1290]: I1024 01:10:02.513 eviction_manager.go:377] "Eviction manager: must evict pod(s) to reclaim" resourceName="ephemeral-storage" usage="${h.diskPct()}%" threshold="85%"` });
    if (units.length && h.svcState(units[0]) === undefined && !h.knownService(units[0])) return '-- No entries --';
    const prio = f.p || f.priority;
    if (prio) entries = entries.filter(e => /error|fail|emerg|crit|denied|refused|exited|cannot|unable/i.test(e.l) || (/warn/i.test(e.l) && /warning|4/.test(prio)));
    const grep = argv[argv.indexOf('-g') + 1];
    if (argv.includes('-g') && grep) entries = entries.filter(e => new RegExp(grep, 'i').test(e.l));
    if (f.since || f.S) { const t = IG.parseDate(String(f.since || f.S).replace(/^-/, ''), ctx.world.now()); if (!isNaN(t)) entries = entries.filter(e => { const m = e.l.match(/^(\w{3}) +(\d+) (\d\d:\d\d:\d\d)/); if (!m) return true; const d = Date.parse(`${m[1]} ${m[2]} 2026 ${m[3]} UTC`); return isNaN(d) || d >= t; }); }
    let ls = entries.map(e => e.l);
    if (f.r || f.reverse) ls.reverse();
    const n = f.n || f.lines;
    if (n !== undefined) ls = ls.slice(-Number(n === true ? 10 : n));
    if (f.e && n === undefined) ls = ls.slice(-1000);
    if (f.x) ls = ls.concat(ls.some(l => /Failed|failed/.test(l)) ? [`░░ Subject: A start job for unit ${units[0] || 'unit'}.service has failed`, '░░ Defined-By: systemd', '░░ Support: http://www.ubuntu.com/support', '░░', `░░ A start job for unit ${units[0] || 'unit'}.service has finished with a failure.`, '░░', "░░ The job identifier is 1924 and the job result is failed."] : []);
    const text = ls.length ? join(ls) : '-- No entries --\n';
    return { stdout: text, stderr: f.f || f.follow ? 'ℹ -f（追従）は継続表示できないため、現在までのログを表示しました。\n' : '', code: 0 };
  };
  C.logger = (argv, ctx) => {
    const { f, pos } = opts(argv, 'tp', ['tag', 'priority']);
    const msg = pos.join(' ') || ctx.stdin.trim();
    const tag = f.t || f.tag || ctx.user;
    ctx.host.log(tag, `${tag}: ${msg}`);
    return '';
  };
  C.hostnamectl = (argv, ctx) => {
    const h = ctx.host;
    if (argv[0] === 'set-hostname' || argv[0] === 'hostname' && argv[1]) {
      if (!root(ctx)) return { stdout: '', stderr: 'Could not set static hostname: Access denied\n', code: 1 };
      h.displayName = argv[1];
      ctx.vfs.write('/etc/hostname', argv[1] + '\n');
      return '';
    }
    return ` Static hostname: ${h.hostname}\n       Icon name: computer-vm\n         Chassis: vm 🖴\n      Machine ID: ${U.hex('mid' + h.name, 32)}\n         Boot ID: ${U.hex('boot' + h.name, 32)}\n  Virtualization: amazon\nOperating System: ${h.osPretty}\n          Kernel: Linux ${h.kernel}\n    Architecture: x86-64\n Hardware Vendor: Amazon EC2\n  Hardware Model: t3.large\nFirmware Version: 1.0`;
  };
  const TZ = { UTC: [0, 'UTC'], 'Etc/UTC': [0, 'UTC'], 'Asia/Tokyo': [540, 'JST'], 'Asia/Seoul': [540, 'KST'], 'Asia/Shanghai': [480, 'CST'], 'Asia/Singapore': [480, '+08'], 'Europe/London': [60, 'BST'], 'America/New_York': [-240, 'EDT'], 'America/Los_Angeles': [-420, 'PDT'] };
  C.timedatectl = (argv, ctx) => {
    const h = ctx.host;
    const zone = h.tz || 'Etc/UTC';
    if (argv[0] === 'list-timezones') return join(Object.keys(TZ).filter(z => z.includes('/')).sort());
    if (argv[0] === 'set-timezone') {
      if (!root(ctx)) return { stdout: '', stderr: 'Failed to set time zone: Access denied\n', code: 1 };
      if (!TZ[argv[1]]) return { stdout: '', stderr: `Failed to set time zone: Invalid or not installed time zone '${argv[1]}'\n`, code: 1 };
      h.tz = argv[1];
      ctx.vfs.write('/etc/timezone', argv[1] + '\n');
      if (ctx.vfs.lexists('/etc/localtime')) ctx.vfs.remove('/etc/localtime');
      ctx.vfs.symlink('/usr/share/zoneinfo/' + argv[1], '/etc/localtime');
      return '';
    }
    if (argv[0] === 'set-ntp') return need(ctx, 'Failed to set ntp: Access denied') || '';
    const [off, abbr] = TZ[zone] || [0, 'UTC'];
    const local = ctx.world.now() + off * 60e3;
    return `               Local time: ${IG.strftime('%a %F %T', local)} ${abbr}\n           Universal time: ${IG.strftime('%a %F %T', ctx.world.now())} UTC\n                 RTC time: ${IG.strftime('%a %F %T', ctx.world.now())}\n                Time zone: ${zone} (${abbr}, ${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}${String(Math.abs(off) % 60).padStart(2, '0')})\nSystem clock synchronized: yes\n              NTP service: active\n          RTC in local TZ: no`;
  };
  IG.TZ = TZ;
  C['systemd-analyze'] = (argv, ctx) => (argv[0] === 'blame' ? '6.214s cloud-init.service\n2.882s snapd.service\n1.204s systemd-networkd-wait-online.service\n 411ms ssh.service' : `Startup finished in 3.904s (kernel) + 14.212s (userspace) = 18.116s\ngraphical.target reached after 13.841s in userspace`);
  C.reboot = (argv, ctx) => {
    const h = ctx.host;
    if (!root(ctx)) return { stdout: '', stderr: 'Failed to set wall message, ignoring: Interactive authentication required.\nCall to Reboot failed: Interactive authentication required.\n', code: 1 };
    if (h.name === 'bastion') return { stdout: '', stderr: 'ℹ 踏み台（作業端末）の再起動は訓練環境では行いません。\n', code: 1 };
    h.bootAt = ctx.world.now();
    for (const s of Object.keys(h.services)) h.setSvc(s, h.enabled[s] === false || h.masked.has(s) ? 'inactive' : 'active');
    for (const s of Object.keys(h.services)) if (h.services[s] === 'active') { const err = h.checks[s] ? h.checks[s](h) : s === 'nginx' && !h.web ? nginxCheck(h) : null; if (err) h.setSvc(s, 'failed'); }
    h.extraProcs = h.extraProcs.filter(p => p.persistent);
    const bad = IG.storageBoot ? IG.storageBoot(h) : [];
    const sh = ctx.shell;
    while (sh.stack.length > 1 && sh.frame.host === h.name) sh.stack.pop();
    ctx.world.reconcile();
    ctx.world.emit(`${h.hostname} rebooted`, 'WARN');
    const warn = bad.length ? `ℹ /etc/fstab の次の行をマウントできませんでした: ${bad.join(', ')}\n  実機では nofail の無い行が失敗すると emergency mode で起動が止まり、SSH できなくなります（EC2 ならボリュームを別インスタンスに付け替えて修復）。\n  sudo findmnt --verify で事前に確認し、追加ディスクには nofail を付けましょう。\n` : '';
    return { stdout: `Connection to ${h.name} closed by remote host.\nConnection to ${h.name} closed.\n`, stderr: warn, code: 0 };
  };
  C.shutdown = (argv, ctx) => (argv.includes('-r') ? C.reboot(argv, ctx) : { stdout: '', stderr: root(ctx) ? 'ℹ 停止（shutdown -h / poweroff）は訓練環境では実行しません。再起動は shutdown -r now / reboot です。\n' : 'Failed to set wall message, ignoring: Interactive authentication required.\nFailed to call ScheduleShutdown in logind, proceeding with immediate shutdown: Interactive authentication required.\n', code: 1 });
  C.poweroff = C.shutdown; C.halt = C.shutdown;

  /* ================================================================ cron */
  function cronValidate(text) {
    const ls = lines(text);
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i].trim();
      if (!l || l.startsWith('#') || /^\w+=/.test(l)) continue;
      if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S/.test(l)) continue;
      const parts = l.split(/\s+/);
      if (parts.length < 6) return `"-":${i + 1}: bad command`;
      const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
      const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
      for (let k = 0; k < 5; k++) {
        if (!/^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/i.test(parts[k]) && !(k === 3 && /^[a-z]{3}$/i.test(parts[k])) && !(k === 4 && /^[a-z]{3}(-[a-z]{3})?$/i.test(parts[k]))) return `"-":${i + 1}: bad ${names[k]}`;
        for (const n of parts[k].match(/\d+/g) || []) if (!parts[k].includes('/') && (Number(n) < ranges[k][0] || Number(n) > ranges[k][1])) return `"-":${i + 1}: bad ${names[k]}`;
      }
    }
    return null;
  }
  C.crontab = (argv, ctx) => {
    const h = ctx.host;
    const uIdx = argv.indexOf('-u');
    const user = uIdx >= 0 ? argv[uIdx + 1] : ctx.user;
    if (uIdx >= 0 && !root(ctx) && user !== ctx.user) return { stdout: '', stderr: 'must be privileged to use -u\n', code: 1 };
    const path = (h.os === 'ubuntu' ? '/var/spool/cron/crontabs/' : '/var/spool/cron/') + user;
    const fs = ctx.vfs;
    const flags = argv.filter((a, i) => a.startsWith('-') && a !== '-' && (uIdx < 0 || i !== uIdx + 1));
    const file = argv.filter((a, i) => (a === '-' || !a.startsWith('-')) && (uIdx < 0 || i !== uIdx + 1))[0];
    const install = text => { const err = cronValidate(text); if (err) return { stdout: '', stderr: `${err}\nerrors in crontab file, can't install.\n`, code: 1 }; fs.write(path, text, { owner: user, group: h.os === 'ubuntu' ? 'crontab' : user, mode: 0o600, mkdirs: true }); return { stdout: '', stderr: '', code: 0 }; };
    if (flags.includes('-l')) { const t = fs.read(path); return t ? t : { stdout: '', stderr: `no crontab for ${user}\n`, code: 1 }; }
    if (flags.includes('-r')) { if (!fs.exists(path)) return { stdout: '', stderr: `no crontab for ${user}\n`, code: 1 }; fs.remove(path); return ''; }
    if (flags.includes('-e')) {
      const tmp = `/tmp/crontab.${U.hex(String(ctx.world.now()), 6)}/crontab`;
      fs.write(tmp, fs.read(path) || '# Edit this file to introduce tasks to be run by cron.\n#\n# m h  dom mon dow   command\n', { mkdirs: true, owner: ctx.user, mode: 0o600 });
      ctx.editor({ path: tmp, host: h.name, readonly: false, onSave: text => { const r = install(text); return r.code ? { out: r.stderr.trim() + '\nℹ 誤りのため反映されていません。crontab -e で修正してください。', err: true } : { out: 'crontab: installing new crontab' }; } });
      return { stdout: '', stderr: h.os === 'ubuntu' && !fs.exists(path) ? 'no crontab for ' + user + ' - using an empty one\n' : '', code: 0 };
    }
    if (file) { const t = file === '-' ? ctx.stdin : fs.read(ctx.resolve(file)); if (t === undefined) return { stdout: '', stderr: `${file}: No such file or directory\n`, code: 1 }; return install(t); }
    return { stdout: '', stderr: "crontab: usage error: file name or - (for stdin) must be specified\n", code: 1 };
  };

  /* ================================================================ packages */
  const DEPS = { nginx: ['nginx-common', 'libnginx-mod-http-geoip2'], apache2: ['apache2-bin', 'apache2-data', 'apache2-utils'], postgresql: ['postgresql-16', 'postgresql-client-16', 'postgresql-common'], 'redis-server': ['redis-tools', 'libjemalloc2'], htop: ['libnl-3-200'], sysstat: [], nmap: ['nmap-common', 'liblinear4'] };
  function aptInstall(ctx, names, yes, rhel) {
    const h = ctx.host;
    const o = out();
    const PKG = L.PKG;
    const unknown = names.find(n => !(n in PKG) && !L.SERVICE_OF_PKG[n]);
    if (unknown) { if (rhel) o.e(`Last metadata expiration check: 0:12:44 ago on ${IG.strftime('%a %d %b %Y %T %p UTC', ctx.world.now())}.\nNo match for argument: ${unknown}\nError: Unable to find a match: ${unknown}`); else o.e(`Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nE: Unable to locate package ${unknown}`, 100); return o.r(); }
    const fresh = names.filter(n => !h.pkgs.has(n));
    const already = names.filter(n => h.pkgs.has(n));
    if (rhel) {
      if (!fresh.length) { o.o(`Last metadata expiration check: 0:12:44 ago.\n${already.map(n => `Package ${n}-${L.PKG_VER[n] || '1.0-1.el9'}.x86_64 is already installed.`).join('\n')}\nDependencies resolved.\nNothing to do.\nComplete!\n`); return o.r(); }
      const deps = fresh.flatMap(n => DEPS[n] || []);
      o.o(`Last metadata expiration check: 0:12:44 ago on ${IG.strftime('%a %d %b %Y %T %p UTC', ctx.world.now())}.\nDependencies resolved.\n${'='.repeat(80)}\n Package          Architecture   Version              Repository                Size\n${'='.repeat(80)}\nInstalling:\n${fresh.map(n => ` ${n.padEnd(16)} x86_64         ${(L.PKG_VER[n] || '1.0-1.el9').slice(0, 20).padEnd(20)} rhel-9-for-x86_64-appstream-rpms  412 k`).join('\n')}\n${deps.length ? 'Installing dependencies:\n' + deps.map(n => ` ${n.padEnd(16)} x86_64         1.0-1.el9            rhel-9-for-x86_64-appstream-rpms   88 k`).join('\n') + '\n' : ''}\nTransaction Summary\n${'='.repeat(80)}\nInstall  ${fresh.length + deps.length} Package${fresh.length + deps.length > 1 ? 's' : ''}\n\nTotal download size: 1.2 M\nInstalled size: 3.4 M\n`);
      if (!yes) { o.o('Is this ok [y/N]: '); if (!/^y/i.test(ctx.stdin.trim())) { o.o('Operation aborted.\n'); o.code = 1; return o.r(); } }
      o.o(`Downloading Packages:\nRunning transaction check\nTransaction check succeeded.\nRunning transaction test\nTransaction test succeeded.\nRunning transaction\n${fresh.map((n, i) => `  Installing       : ${n}  ${i + 1}/${fresh.length}`).join('\n')}\n\nInstalled:\n  ${fresh.join(' ')}\n\nComplete!\n`);
    } else {
      if (!fresh.length) { o.o(`Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n${already.map(n => `${n} is already the newest version (${L.PKG_VER[n] || '1.0-1ubuntu1'}).`).join('\n')}\n0 upgraded, 0 newly installed, 0 to remove and 14 not upgraded.\n`); return o.r(); }
      const deps = fresh.flatMap(n => DEPS[n] || []);
      const all = deps.concat(fresh);
      o.o(`Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n${deps.length ? `The following additional packages will be installed:\n  ${deps.join(' ')}\n` : ''}The following NEW packages will be installed:\n  ${all.join(' ')}\n0 upgraded, ${all.length} newly installed, 0 to remove and 14 not upgraded.\nNeed to get ${(all.reduce((t, n) => t + 100 + (U.hash(n) % 900), 0) / 1000).toFixed(1)} MB of archives.\nAfter this operation, ${(all.length * 1.2).toFixed(1)} MB of additional disk space will be used.\n`);
      if (deps.length && !yes) { o.o('Do you want to continue? [Y/n] '); const ans = ctx.stdin.trim(); if (ans && !/^y/i.test(ans) || !ans && !ctx.hasStdin) { o.o('Abort.\n'); o.code = 1; if (!ctx.hasStdin) o.e('ℹ 確認プロンプトに応答できないため中断しました。apt install -y で自動承認できます。', 1); return o.r(); } }
      o.o(all.map((n, i) => `Get:${i + 1} http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu jammy-updates/main amd64 ${n} amd64 ${L.PKG_VER[n] || '1.0-1ubuntu1'} [${100 + (U.hash(n) % 900)} kB]`).join('\n') + `\nFetched ${(all.reduce((t, n) => t + 100 + (U.hash(n) % 900), 0) / 1000).toFixed(1)} MB in 1s (2,418 kB/s)\n` + all.map(n => `Selecting previously unselected package ${n}.\nPreparing to unpack .../${n}_${L.PKG_VER[n] || '1.0-1ubuntu1'}_amd64.deb ...\nUnpacking ${n} (${L.PKG_VER[n] || '1.0-1ubuntu1'}) ...`).join('\n') + '\n' + all.map(n => `Setting up ${n} (${L.PKG_VER[n] || '1.0-1ubuntu1'}) ...`).join('\n') + '\nProcessing triggers for man-db (2.10.2-1) ...\n');
    }
    for (const n of fresh) {
      h.pkgs.add(n);
      const svc = L.SERVICE_OF_PKG[n];
      if (svc) {
        const name = rhel && svc === 'ssh' ? 'sshd' : svc;
        h.services[name] = rhel ? 'inactive' : 'active';
        h.enabled[name] = !rhel;
        h.pids[name] = 3500 + (U.hash(name) % 400);
        h.writeUnit(name);
        if (name === 'nginx') h.installNginxFiles();
        if (name === 'apache2' || name === 'httpd') { ctx.vfs.write(name === 'httpd' ? '/var/www/html/index.html' : '/var/www/html/index.html', name === 'httpd' ? '' : '<!DOCTYPE html>\n<html><head><title>Apache2 Ubuntu Default Page: It works</title></head><body><h1>It works!</h1></body></html>\n', { mkdirs: true }); ctx.vfs.mkdirp(name === 'httpd' ? '/var/log/httpd' : '/var/log/apache2'); ctx.vfs.write((name === 'httpd' ? '/var/log/httpd/access_log' : '/var/log/apache2/access.log'), '', {}); }
        if (!rhel) { h.log(name, `systemd[1]: Starting ${name}.service - ${(L.SVC[name] || {}).desc || name}...`); h.log(name, `systemd[1]: Started ${name}.service - ${(L.SVC[name] || {}).desc || name}.`); }
      }
      ctx.vfs.write('/var/log/dpkg.log', `${IG.strftime('%F %T', ctx.world.now())} install ${n}:amd64 <none> ${L.PKG_VER[n] || '1.0-1ubuntu1'}\n`, { append: true });
    }
    h.syncBins();
    ctx.world.emit(`${h.hostname}: installed ${fresh.join(', ')}`);
    ctx.world.reconcile();
    return o.r();
  }
  function aptRemove(ctx, names, purge, rhel) {
    const h = ctx.host;
    const o = out();
    const essential = ['bash', 'coreutils', 'systemd', 'apt', 'dpkg', 'sudo', 'dnf', 'rpm', 'passwd', 'login', 'util-linux', 'grep', 'sed', 'findutils', 'tar', 'gzip'];
    const bad = names.find(n => essential.includes(n));
    if (bad) { o.e(rhel ? `Error: \n Problem: The operation would result in removing the following protected packages: ${bad}` : `E: Removing essential system-critical packages is not permitted. This might break the system.`, 100); return o.r(); }
    const present = names.filter(n => h.pkgs.has(n));
    if (!present.length) { o.o(rhel ? `No match for argument: ${names[0]}\nNo packages marked for removal.\nDependencies resolved.\nNothing to do.\nComplete!\n` : `Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nPackage '${names[0]}' is not installed, so not removed\n0 upgraded, 0 newly installed, 0 to remove and 14 not upgraded.\n`); return o.r(); }
    o.o(rhel ? `Dependencies resolved.\nRemoving:\n ${present.join('\n ')}\n\nRemoved:\n  ${present.join(' ')}\n\nComplete!\n` : `Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nThe following packages will be REMOVED:\n  ${present.map(n => n + (purge ? '*' : '')).join(' ')}\n0 upgraded, 0 newly installed, ${present.length} to remove and 14 not upgraded.\n${present.map(n => `Removing ${n} (${L.PKG_VER[n] || '1.0-1ubuntu1'}) ...`).join('\n')}\n${purge ? present.map(n => `Purging configuration files for ${n} (${L.PKG_VER[n] || '1.0-1ubuntu1'}) ...`).join('\n') + '\n' : ''}`);
    for (const n of present) {
      h.pkgs.delete(n);
      for (const c of (L.PKG[n] || '').split(' ')) for (const d of ['/usr/bin/', '/usr/sbin/']) if (ctx.vfs.lexists(d + c)) ctx.vfs.remove(d + c);
      const svc = L.SERVICE_OF_PKG[n];
      if (svc && h.services[svc]) { delete h.services[svc]; const up = unitPath(h, svc); if (up) ctx.vfs.remove(up); }
      if (purge && n === 'nginx' && ctx.vfs.exists('/etc/nginx')) ctx.vfs.remove('/etc/nginx', true);
    }
    ctx.world.reconcile();
    return o.r();
  }
  C.apt = (argv, ctx) => {
    const h = ctx.host;
    if (h.os === 'rhel') return { stdout: '', stderr: 'bash: apt: command not found\nℹ RHEL 系では dnf（または yum）を使います。\n', code: 127 };
    const { f, pos } = opts(argv, 'o', []);
    const [verb, ...pkgs] = pos;
    const lockErr = { stdout: '', stderr: `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n`, code: 100 };
    const yes = f.y || f.yes || f['assume-yes'];
    const warn = ctx.name === 'apt' && !(ctx.io.fd[1] && ctx.io.fd[1].term) ? '\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n' : '';
    switch (verb) {
      case 'update':
        if (!root(ctx)) return { stdout: '', stderr: 'Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/\n', code: 100 };
        h.aptUpdated = true;
        return `Hit:1 http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu jammy InRelease\nGet:2 http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu jammy-updates InRelease [128 kB]\nHit:3 http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu jammy-backports InRelease\nGet:4 http://security.ubuntu.com/ubuntu jammy-security InRelease [129 kB]\nFetched 257 kB in 1s (285 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n14 packages can be upgraded. Run 'apt list --upgradable' to see them.`;
      case 'upgrade': case 'full-upgrade': case 'dist-upgrade':
        if (!root(ctx)) return lockErr;
        return `Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nCalculating upgrade... Done\nThe following packages will be upgraded:\n  curl libcurl4 openssl libssl3 ...\n14 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${yes ? 'ℹ シミュレータではパッケージの実バージョンは変化しません。' : 'Do you want to continue? [Y/n] Abort.'}`;
      case 'install': case 'reinstall':
        if (!pkgs.length) return '0 upgraded, 0 newly installed, 0 to remove and 14 not upgraded.';
        if (!root(ctx)) return lockErr;
        return aptInstall(ctx, pkgs.map(p => p.replace(/=.*$/, '')), yes, false);
      case 'remove': case 'purge': case 'autoremove':
        if (!root(ctx)) return lockErr;
        if (verb === 'autoremove') return 'Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n0 upgraded, 0 newly installed, 0 to remove and 14 not upgraded.';
        return aptRemove(ctx, pkgs, verb === 'purge' || f.purge, false);
      case 'list': {
        if (f.upgradable) return warn + 'Listing... Done\ncurl/jammy-updates 7.81.0-1ubuntu1.18 amd64 [upgradable from: 7.81.0-1ubuntu1.17]\nopenssl/jammy-updates 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.17]';
        const names = f.installed ? [...h.pkgs].sort() : Object.keys(L.PKG).sort();
        const pat = pkgs[0] ? IG.bash.globRe(pkgs[0]) : null;
        return warn + 'Listing... Done\n' + join(names.filter(n => !pat || pat.test(n)).map(n => `${n}/jammy-updates,now ${L.PKG_VER[n] || '1.0-1ubuntu1'} amd64${h.pkgs.has(n) ? ' [installed]' : ''}`));
      }
      case 'search': { const re = new RegExp(pkgs[0] || '.', 'i'); return warn + 'Sorting... Done\nFull Text Search... Done\n' + Object.keys(L.PKG).filter(n => re.test(n) || re.test(L.PKG[n])).map(n => `${n}/jammy ${L.PKG_VER[n] || '1.0-1ubuntu1'} amd64\n  provides: ${L.PKG[n]}\n`).join('\n'); }
      case 'show': case 'policy': {
        const n = pkgs[0];
        if (!(n in L.PKG)) return { stdout: '', stderr: `N: Unable to locate package ${n}\nE: No packages found\n`, code: 100 };
        if (verb === 'policy') return `${n}:\n  Installed: ${h.pkgs.has(n) ? L.PKG_VER[n] || '1.0-1ubuntu1' : '(none)'}\n  Candidate: ${L.PKG_VER[n] || '1.0-1ubuntu1'}\n  Version table:\n     ${L.PKG_VER[n] || '1.0-1ubuntu1'} 500\n        500 http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu jammy-updates/main amd64 Packages`;
        return `Package: ${n}\nVersion: ${L.PKG_VER[n] || '1.0-1ubuntu1'}\nPriority: optional\nSection: utils\nOrigin: Ubuntu\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nInstalled-Size: ${200 + (U.hash(n) % 3000)} kB\nDescription: provides ${L.PKG[n]}`;
      }
      default:
        return { stdout: '', stderr: `E: Invalid operation ${verb || ''}\n`, code: 100 };
    }
  };
  C['apt-get'] = (argv, ctx) => C.apt(argv, Object.assign({}, ctx, { name: 'apt-get' }));
  C['apt-cache'] = (argv, ctx) => C.apt(argv[0] === 'search' || argv[0] === 'show' || argv[0] === 'policy' ? argv : ['show'].concat(argv), ctx);
  C.dpkg = (argv, ctx) => {
    const h = ctx.host;
    const a = argv[0];
    if (a === '-l' || a === '--list') {
      const pat = argv[1] ? IG.bash.globRe(argv[1]) : null;
      const rows = [...h.pkgs].sort().filter(n => !pat || pat.test(n));
      if (!rows.length) return { stdout: '', stderr: `dpkg-query: no packages found matching ${argv[1]}\n`, code: 1 };
      return 'Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n||/ Name                 Version                  Architecture Description\n+++-====================-========================-============-=================================\n' + join(rows.map(n => `ii  ${n.padEnd(20)} ${(L.PKG_VER[n] || '1.0-1ubuntu1').padEnd(24)} amd64        provides ${(L.PKG[n] || n).split(' ').slice(0, 3).join(' ')}`));
    }
    if (a === '-L') { const n = argv[1]; if (!h.pkgs.has(n)) return { stdout: '', stderr: `dpkg-query: package '${n}' is not installed\n`, code: 1 }; return join(['/.', '/usr', '/usr/bin'].concat((L.PKG[n] || '').split(' ').map(c => '/usr/bin/' + c), [`/usr/share/doc/${n}`, `/usr/share/doc/${n}/copyright`])); }
    if (a === '-S') { const c = VFS.base(argv[1] || ''); const p = L.CMD_PKG[c]; return p && h.pkgs.has(p) ? `${p}: /usr/bin/${c}` : { stdout: '', stderr: `dpkg-query: no path found matching pattern ${argv[1]}\n`, code: 1 }; }
    if (a === '-s' || a === '--status') { const n = argv[1]; return h.pkgs.has(n) ? `Package: ${n}\nStatus: install ok installed\nVersion: ${L.PKG_VER[n] || '1.0-1ubuntu1'}` : { stdout: '', stderr: `dpkg-query: package '${n}' is not installed and no information is available\n`, code: 1 }; }
    if (a === '-i') return need(ctx, 'dpkg: error: requested operation requires superuser privilege') || { stdout: '', stderr: 'ℹ .deb ファイルの直接インストールは未対応です。apt install <パッケージ名> を使ってください。\n', code: 1 };
    return { stdout: '', stderr: 'dpkg: need an action option\n\nType dpkg --help for help about installing and deinstalling packages [*];\nUse \'apt\' or \'aptitude\' for user-friendly package management;\n', code: 2 };
  };
  C.dnf = (argv, ctx) => {
    const h = ctx.host;
    if (h.os !== 'rhel') return { stdout: '', stderr: `Command 'dnf' not found, but can be installed with:\nsudo apt install dnf\nℹ Ubuntu では apt を使います。\n`, code: 127 };
    const { f, pos } = opts(argv);
    const [verb, ...pkgs] = pos;
    const nonroot = { stdout: '', stderr: 'Error: This command has to be run with superuser privileges (under the root user on most systems).\n', code: 1 };
    switch (verb) {
      case 'install': case 'reinstall': if (!root(ctx)) return nonroot; return aptInstall(ctx, pkgs, f.y || f.assumeyes, true);
      case 'remove': case 'erase': if (!root(ctx)) return nonroot; return aptRemove(ctx, pkgs, false, true);
      case 'update': case 'upgrade': if (!root(ctx)) return nonroot; return 'Last metadata expiration check: 0:12:44 ago.\nDependencies resolved.\nNothing to do.\nComplete!';
      case 'check-update': return '\nopenssl.x86_64              1:3.0.7-28.el9_4              rhel-9-for-x86_64-baseos-rpms';
      case 'repolist': return 'repo id                                              repo name\nrhel-9-for-x86_64-appstream-rpms                     Red Hat Enterprise Linux 9 for x86_64 - AppStream (RPMs)\nrhel-9-for-x86_64-baseos-rpms                        Red Hat Enterprise Linux 9 for x86_64 - BaseOS (RPMs)';
      case 'list': return 'Installed Packages\n' + join([...h.pkgs].sort().filter(n => !pkgs[0] || IG.bash.globRe(pkgs[0]).test(n)).map(n => `${(n + '.x86_64').padEnd(40)} ${(L.PKG_VER[n] || '1.0-1.el9').padEnd(28)} @rhel-9-for-x86_64-baseos-rpms`));
      case 'search': return '========================= Name Matched: ' + (pkgs[0] || '') + ' =========================\n' + Object.keys(L.PKG).filter(n => n.includes(pkgs[0] || '')).map(n => `${n}.x86_64 : provides ${L.PKG[n]}`).join('\n');
      case 'info': return (pkgs[0] in L.PKG) ? `Name         : ${pkgs[0]}\nVersion      : ${L.PKG_VER[pkgs[0]] || '1.0'}\nRelease      : 1.el9\nArchitecture : x86_64\nRepository   : ${h.pkgs.has(pkgs[0]) ? '@System' : 'rhel-9-for-x86_64-appstream-rpms'}\nSummary      : provides ${L.PKG[pkgs[0]]}` : { stdout: '', stderr: 'Error: No matching Packages to list\n', code: 1 };
      case 'provides': case 'whatprovides': { const c = VFS.base(pkgs[0] || ''); const p = L.CMD_PKG[c]; return p ? `${p}-1.0-1.el9.x86_64 : provides ${L.PKG[p]}\nRepo        : rhel-9-for-x86_64-baseos-rpms\nMatched from:\nFilename    : /usr/bin/${c}` : { stdout: '', stderr: `Error: No matches found.\n`, code: 1 }; }
      default: return { stdout: '', stderr: `No such command: ${verb}. Please use /usr/bin/dnf --help\n`, code: 1 };
    }
  };
  C.yum = C.dnf;
  C.rpm = (argv, ctx) => {
    const h = ctx.host;
    const a = argv[0];
    if (a === '-qa') return join([...h.pkgs].sort().map(n => `${n}-${L.PKG_VER[n] || '1.0'}-1.el9.x86_64`));
    if (a === '-q') return h.pkgs.has(argv[1]) ? `${argv[1]}-${L.PKG_VER[argv[1]] || '1.0'}-1.el9.x86_64` : { stdout: `package ${argv[1]} is not installed\n`, stderr: '', code: 1 };
    if (a === '-qf') { const p = L.CMD_PKG[VFS.base(argv[1] || '')]; return p && h.pkgs.has(p) ? `${p}-1.0-1.el9.x86_64` : { stdout: `file ${argv[1]} is not owned by any package\n`, stderr: '', code: 1 }; }
    if (a === '-ql') return h.pkgs.has(argv[1]) ? join((L.PKG[argv[1]] || '').split(' ').map(c => '/usr/bin/' + c)) : { stdout: `package ${argv[1]} is not installed\n`, stderr: '', code: 1 };
    if (a === '-qi') return h.pkgs.has(argv[1]) ? `Name        : ${argv[1]}\nVersion     : ${L.PKG_VER[argv[1]] || '1.0'}\nRelease     : 1.el9\nArchitecture: x86_64\nInstall Date: ${IG.strftime('%a %d %b %Y %T %p UTC', h.bootAt)}\nSummary     : provides ${L.PKG[argv[1]]}` : { stdout: `package ${argv[1]} is not installed\n`, stderr: '', code: 1 };
    return { stdout: '', stderr: 'RPM version 4.16.1.3\nℹ rpm -qa / -q / -qf / -ql / -qi に対応しています。\n', code: 1 };
  };

  /* ================================================================ archives */
  const TAR = 'SIMTAR\n', GZ = '\x1f\x8bSIMGZ\n', ZIP = 'PK\x03\x04SIM\n', XZ = '\xfd7zXZSIM\n', BZ = 'BZhSIM\n', ZS = '\x28\xb5\x2f\xfdSIM\n';
  // compressors share one implementation; the marker tells the formats apart (file, tar auto-detect)
  const ZK = { gzip: { ext: '.gz', mark: GZ, ratio: 0.28 }, xz: { ext: '.xz', mark: XZ, ratio: 0.22 }, bzip2: { ext: '.bz2', mark: BZ, ratio: 0.25 }, zstd: { ext: '.zst', mark: ZS, ratio: 0.24 } };
  IG.compressMarks = { gzip: GZ, xz: XZ, bzip2: BZ };
  function pack(ctx, paths, opt = {}) {
    const fs = ctx.vfs;
    const entries = [];
    const errs = [];
    for (const p of paths) {
      const abs = ctx.resolve(p);
      if (!fs.lexists(abs)) { errs.push(p); continue; }
      const rel = p.replace(/^\/+/, '').replace(/\/$/, '');
      const add = (a, r) => {
        if (opt.exclude && opt.exclude.some(re => re.test(VFS.base(a)) || re.test(r))) return;
        const n = fs.lnode(a);
        if (n.type === 'f' && !ctx.shell.canRead(a)) { errs.push(`${r}: Cannot open: Permission denied`); return; }
        entries.push({ path: r + (n.type === 'd' ? '/' : ''), type: n.type, content: n.type === 'f' ? n.content : undefined, size: n.type === 'f' ? n.size : undefined, target: n.target, mode: n.mode, owner: n.owner, group: n.group, mtime: n.mtime });
        if (n.type === 'd') for (const k of fs.children(a)) add(k.path, r + '/' + k.name);
      };
      add(abs, rel);
    }
    return { entries, errs, leading: paths.some(p => p.startsWith('/')) };
  }
  function unpack(ctx, entries, dest, opt = {}) {
    const fs = ctx.vfs;
    for (const e of entries) {
      const p = VFS.norm(e.path, dest);
      if (e.type === 'd') { fs.mkdirp(p, { owner: opt.keepOwner ? e.owner : ctx.user, group: opt.keepOwner ? e.group : ctx.host.primaryGroup(ctx.user), mode: e.mode }); continue; }
      if (!fs.isDir(VFS.parent(p))) fs.mkdirp(VFS.parent(p), { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user) });
      if (e.type === 'l') { if (fs.lexists(p)) fs.remove(p); fs.symlink(e.target, p, { owner: ctx.user }); continue; }
      fs.write(p, e.content || '', { owner: opt.keepOwner ? e.owner : ctx.user, group: opt.keepOwner ? e.group : ctx.host.primaryGroup(ctx.user), mode: e.mode, size: e.size, mtime: e.mtime });
    }
  }
  function sizeOfEntries(es) { return es.reduce((s, e) => s + (e.size ?? (e.content || '').length), 0); }
  C.tar = (argv, ctx) => {
    const o = out();
    let a = argv.slice();
    if (a[0] && !a[0].startsWith('-') && /^[cxtrufzjJvpCO]+$/.test(a[0])) a[0] = '-' + a[0];
    let mode = null, file = null, gz = false, verbose = false, dir = null;
    const files = [], excl = [];
    let keepOwner = false, strip = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (/^--exclude=/.test(x)) { excl.push(IG.bash.globRe(x.slice(10))); continue; }
      if (x === '--exclude') { excl.push(IG.bash.globRe(a[++i])); continue; }
      if (/^--strip-components=/.test(x)) { strip = Number(x.split('=')[1]); continue; }
      if (x === '--same-owner' || x === '-p') { keepOwner = true; continue; }
      if (x === '-C' || x === '--directory') { dir = a[++i]; continue; }
      if (/^--directory=/.test(x)) { dir = x.split('=')[1]; continue; }
      if (x === '--gzip' || x === '-z') { gz = true; continue; }
      if (x === '--xz') { gz = XZ; continue; }
      if (x === '--bzip2') { gz = BZ; continue; }
      if (x === '--zstd') { gz = ZS; continue; }
      if (/^-[a-zA-Z]+$/.test(x)) {
        for (let k = 1; k < x.length; k++) {
          const ch = x[k];
          if ('cxtru'.includes(ch)) mode = ch;
          else if (ch === 'z') gz = true;
          else if (ch === 'j') gz = BZ;
          else if (ch === 'J') gz = XZ;
          else if (ch === 'v') verbose = true;
          else if (ch === 'p') keepOwner = true;
          else if (ch === 'f') { file = x.slice(k + 1) || a[++i]; break; }
          else if (ch === 'C') { dir = a[++i]; break; }
        }
        continue;
      }
      files.push(x);
    }
    if (!mode) { o.e("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.", 2); return o.r(); }
    const fs = ctx.vfs;
    const base = dir ? ctx.resolve(dir) : ctx.cwd;
    if (mode === 'c') {
      if (!files.length) { o.e('tar: Cowardly refusing to create an empty archive\nTry \'tar --help\' or \'tar --usage\' for more information.', 2); return o.r(); }
      const sub = Object.assign({}, ctx, { resolve: p => VFS.norm(p, base, ctx.shell.home()) });
      const r = pack(sub, files, { exclude: excl });
      if (r.leading) o.e("tar: Removing leading `/' from member names", 0);
      for (const e of r.errs) o.e(e.includes(':') ? `tar: ${e}` : `tar: ${e}: Cannot stat: No such file or directory`, 2);
      if (verbose) for (const e of r.entries) o.o(e.path + '\n');
      let data = TAR + JSON.stringify(r.entries);
      if (gz) data = (gz === true ? GZ : gz) + data;
      const size = Math.round(sizeOfEntries(r.entries) * (gz ? 0.3 : 1.02)) + 10240;
      if (!file || file === '-') { o.o(data); }
      else {
        const p = ctx.resolve(file);
        if (!ctx.shell.canWrite(p)) { o.e(`tar: ${file}: Cannot open: Permission denied\ntar: Error is not recoverable: exiting now`, 2); return o.r(); }
        fs.write(p, data, { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user), size });
      }
      if (r.errs.length) o.e('tar: Exiting with failure status due to previous errors', 2);
      return o.r();
    }
    let raw;
    if (!file || file === '-') raw = ctx.stdin;
    else {
      const p = ctx.resolve(file);
      if (!fs.exists(p)) { o.e(`tar: ${file}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now`, 2); return o.r(); }
      if (!ctx.shell.canRead(p)) { o.e(`tar: ${file}: Cannot open: Permission denied\ntar: Error is not recoverable: exiting now`, 2); return o.r(); }
      raw = fs.read(p);
    }
    const zm = [GZ, XZ, BZ, ZS].find(m => raw.startsWith(m));
    if (zm) raw = raw.slice(zm.length);
    else if (gz) { o.e('gzip: stdin: not in gzip format\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now', 2); return o.r(); }
    if (!raw.startsWith(TAR)) { o.e('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors', 2); return o.r(); }
    let entries = JSON.parse(raw.slice(TAR.length));
    if (files.length) entries = entries.filter(e => files.some(f => e.path === f || e.path.startsWith(f.replace(/\/$/, '') + '/') || e.path === f + '/'));
    if (strip) entries = entries.map(e => Object.assign({}, e, { path: e.path.split('/').slice(strip).join('/') })).filter(e => e.path && e.path !== '/');
    if (mode === 't') {
      for (const e of entries) o.o(verbose ? `${IG.modeStr({ type: e.type, mode: e.mode })} ${e.owner}/${e.group} ${String(e.size ?? (e.content || '').length).padStart(8)} ${IG.strftime('%F %R', e.mtime)} ${e.path}${e.type === 'l' ? ' -> ' + e.target : ''}\n` : e.path + '\n');
      return o.r();
    }
    if (mode === 'x') {
      if (!ctx.shell.canWrite(base + '/.probe')) { o.e(`tar: ${entries[0] ? entries[0].path : '.'}: Cannot mkdir: Permission denied\ntar: Exiting with failure status due to previous errors`, 2); return o.r(); }
      unpack(ctx, entries, base, { keepOwner: keepOwner && root(ctx) || root(ctx) });
      if (verbose) for (const e of entries) o.o(e.path + '\n');
      ctx.world.reconcile();
    }
    return o.r();
  };
  function gzipCmd(decompress, tool = 'gzip') {
    const K = ZK[tool], GZm = K.mark;
    return (argv, ctx) => {
      const { f, pos } = opts(argv);
      const o = out();
      const dec = decompress || f.d || f.decompress;
      const fs = ctx.vfs;
      if (!pos.length) { const t = ctx.stdin; if (dec) { if (!t.startsWith(GZm)) { o.e(`${tool}: stdin: ${tool === 'gzip' ? 'not in gzip format' : 'File format not recognized'}`, 1); return o.r(); } o.o(t.slice(GZm.length)); } else o.o(GZm + t); return o.r(); }
      for (const name of pos) {
        const p = ctx.resolve(name);
        if (!fs.exists(p)) { o.e(`${tool}: ${name}: No such file or directory`); continue; }
        if (fs.isDir(p)) { o.e(`${tool}: ${name} is a directory -- ignored`, 2); continue; }
        const n = fs.node(p);
        if (f.l) { const orig = n.content.startsWith(GZm) ? n.content.length - GZm.length : 0; o.o(`         compressed        uncompressed  ratio uncompressed_name\n${String(fs.fileSize(n)).padStart(19)} ${String(orig).padStart(19)}  70.0% ${name.replace(/\.gz$/, '')}\n`); continue; }
        if (dec) {
          if (!name.endsWith(K.ext) && !(tool === 'gzip' && name.endsWith('.tgz'))) { o.e(`${tool}: ${name}: unknown suffix -- ignored`, 2); continue; }
          if (!n.content.startsWith(GZm)) { o.e(`${tool}: ${name}: ${tool === 'gzip' ? 'not in gzip format' : 'File format not recognized'}`); continue; }
          const target = name.endsWith('.tgz') ? p.replace(/\.tgz$/, '.tar') : p.slice(0, -K.ext.length);
          if (f.c || f.stdout) { o.o(n.content.slice(GZm.length)); continue; }
          if (!ctx.shell.canWrite(target)) { o.e(`${tool}: ${target}: Permission denied`); continue; }
          fs.write(target, n.content.slice(GZm.length), { owner: n.owner, group: n.group, mode: n.mode, size: n.origSize });
          if (!f.k && !f.keep) fs.remove(p);
        } else {
          if (name.endsWith(K.ext)) { o.e(`${tool}: ${name} already has ${K.ext} suffix -- unchanged`, 2); continue; }
          if (f.c || f.stdout) { o.o(GZm + n.content); continue; }
          if (!ctx.shell.canWrite(p + K.ext)) { o.e(`${tool}: ${name}${K.ext}: Permission denied`); continue; }
          const node = fs.write(p + K.ext, GZm + n.content, { owner: n.owner, group: n.group, mode: n.mode, size: Math.max(32, Math.round(fs.fileSize(n) * K.ratio)) });
          node.origSize = n.size;
          if (!f.k && !f.keep) fs.remove(p);
        }
      }
      ctx.world.reconcile();
      return o.r();
    };
  }
  C.gzip = gzipCmd(false);
  C.gunzip = gzipCmd(true);
  C.zcat = (argv, ctx) => gzipCmd(true)(['-c', '-k'].concat(argv), ctx);
  C.xz = gzipCmd(false, 'xz');
  C.unxz = gzipCmd(true, 'xz');
  C.xzcat = (argv, ctx) => gzipCmd(true, 'xz')(['-c', '-k'].concat(argv), ctx);
  C.bzip2 = gzipCmd(false, 'bzip2');
  C.bunzip2 = gzipCmd(true, 'bzip2');
  C.bzcat = (argv, ctx) => gzipCmd(true, 'bzip2')(['-c', '-k'].concat(argv), ctx);
  C.zstd = (argv, ctx) => gzipCmd(argv.includes('-d'), 'zstd')(['-k'].concat(argv.filter(a => a !== '-d')), ctx); // zstd keeps the source by default
  C.unzstd = (argv, ctx) => gzipCmd(true, 'zstd')(['-k'].concat(argv), ctx);
  C.zstdcat = (argv, ctx) => gzipCmd(true, 'zstd')(['-c', '-k'].concat(argv), ctx);
  C.zip = (argv, ctx) => {
    const { pos } = opts(argv);
    const [zipName, ...files] = pos;
    if (!zipName) return { stdout: '', stderr: 'zip error: Nothing to do! (try: zip -r archive.zip dir)\n', code: 12 };
    const r = pack(ctx, files);
    const p = ctx.resolve(zipName.endsWith('.zip') ? zipName : zipName + '.zip');
    ctx.vfs.write(p, ZIP + JSON.stringify(r.entries), { owner: ctx.user, group: ctx.host.primaryGroup(ctx.user), size: Math.round(sizeOfEntries(r.entries) * 0.35) + 200 });
    return join(r.entries.map(e => `  adding: ${e.path} (${e.type === 'd' ? 'stored 0%' : 'deflated 64%'})`)) + r.errs.map(e => `\tzip warning: name not matched: ${e}\n`).join('');
  };
  C.unzip = (argv, ctx) => {
    const { f, pos } = opts(argv, 'd');
    const p = ctx.resolve(pos[0] || '');
    const t = ctx.vfs.read(p);
    if (t === undefined) return { stdout: '', stderr: `unzip:  cannot find or open ${pos[0]}, ${pos[0]}.zip or ${pos[0]}.ZIP.\n`, code: 9 };
    if (!t.startsWith(ZIP)) return { stdout: '', stderr: `  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.\n`, code: 9 };
    const entries = JSON.parse(t.slice(ZIP.length));
    if (f.l) return `Archive:  ${pos[0]}\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n${entries.map(e => `${String(e.size ?? (e.content || '').length).padStart(9)}  ${IG.strftime('%m-%d-%Y %R', e.mtime)}   ${e.path}`).join('\n')}\n---------                     -------\n${String(sizeOfEntries(entries)).padStart(9)}                     ${entries.length} files`;
    const dest = f.d ? ctx.resolve(f.d) : ctx.cwd;
    if (f.d) ctx.vfs.mkdirp(dest, { owner: ctx.user });
    unpack(ctx, entries, dest);
    return `Archive:  ${pos[0]}\n` + join(entries.map(e => (e.type === 'd' ? `   creating: ${e.path}` : `  inflating: ${e.path}`)));
  };

  /* ================================================================ misc tools / honest stubs */
  C.python3 = (argv, ctx) => {
    if (argv[0] === '--version' || argv[0] === '-V') return ctx.host.os === 'rhel' ? 'Python 3.9.18' : 'Python 3.10.12';
    if (argv[0] === '-m' && argv[1] === 'http.server') return { stdout: '', stderr: 'ℹ python3 -m http.server はシミュレーションしていません。Web サーバーは nginx / apache2 をインストールして試せます。\n', code: 1 };
    return { stdout: '', stderr: 'ℹ Python の実行はこのシミュレータでは未対応です（bash スクリプトは実行できます）。\n', code: 1 };
  };
  C.python = (argv, ctx) => ({ stdout: '', stderr: ctx.host.os === 'ubuntu' ? "Command 'python' not found, did you mean:\n  command 'python3' from deb python3\n  command 'python' from deb python-is-python3\n" : 'bash: python: command not found\n', code: 127 });
  C.perl = argv => (argv[0] === '-v' || argv[0] === '--version' ? '\nThis is perl 5, version 34, subversion 0 (v5.34.0) built for x86_64-linux-gnu-thread-multi\n' : { stdout: '', stderr: 'ℹ Perl の実行はこのシミュレータでは未対応です（bash スクリプトや sed / awk は実行できます）。\n', code: 1 });
  C.node = argv => (argv[0] === '-v' || argv[0] === '--version' ? 'v18.19.1\n' : { stdout: '', stderr: 'ℹ Node.js の実行はこのシミュレータでは未対応です。\n', code: 1 });
  C.nodejs = C.node;
  C.git = argv => (argv[0] === '--version' ? 'git version 2.34.1' : { stdout: '', stderr: 'ℹ git の操作はこのシミュレータでは未対応です。\n', code: 1 });
  C.tmux = () => ({ stdout: '', stderr: 'ℹ tmux / screen のような端末多重化はブラウザのシミュレータでは再現できません。\n', code: 1 });
  C.screen = C.tmux;
  C.strace = () => ({ stdout: '', stderr: 'ℹ strace（システムコールのトレース）は未対応です。\n', code: 1 });
  C.crictl = (argv, ctx) => {
    const h = ctx.host;
    const cl = Object.values(ctx.world.clusters).find(c => c.nodes.some(n => n.host === h.name));
    if (!cl) return { stdout: '', stderr: 'FATA[0000] validate service connection: validate CRI v1 runtime API for endpoint "unix:///run/containerd/containerd.sock": rpc error: code = Unavailable desc = connection error\n', code: 1 };
    if (!root(ctx)) return { stdout: '', stderr: 'FATA[0000] validate service connection: validate CRI v1 runtime API for endpoint "unix:///run/containerd/containerd.sock": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied"\n', code: 1 };
    const node = cl.nodes.find(n => n.host === h.name);
    const pods = cl.pods.filter(p => p.node === node.name);
    if (argv[0] === 'pods') return join(['POD ID              CREATED        STATE   NAME                                   NAMESPACE   ATTEMPT   RUNTIME'].concat(pods.map(p => `${U.hex(p.name, 13)}       2 days ago     Ready   ${p.name.padEnd(38)} ${p.ns.padEnd(11)} 0         (default)`)));
    if (argv[0] === 'images') return join(['IMAGE                                       TAG                 IMAGE ID            SIZE'].concat([...new Set(pods.map(p => p.spec.containers[0].image))].map(i => { const x = IG.images.parse(i); return `${(x.host ? x.host + '/' : 'docker.io/library/') + x.name}`.padEnd(43) + ' ' + x.tag.padEnd(19) + ' ' + U.hex(i, 13) + '       84.1MB'; })));
    return join(['CONTAINER           IMAGE               CREATED        STATE     NAME           ATTEMPT   POD ID          POD'].concat(pods.map(p => { const st = cl.podStatus(p); return `${U.hex(p.name + 'c', 13)}       ${U.hex(p.spec.containers[0].image, 13)}       2 days ago     ${st.display === 'Running' ? 'Running' : 'Exited '}   ${p.spec.containers[0].name.padEnd(14)} ${st.restarts}         ${U.hex(p.name, 13)}   ${p.name}`; })));
  };
  C.nginx = (argv, ctx) => {
    const h = ctx.host;
    if (argv.includes('-v')) return { stdout: '', stderr: 'nginx version: nginx/1.24.0 (Ubuntu)\n', code: 0 };
    if (argv.includes('-V')) return { stdout: '', stderr: 'nginx version: nginx/1.24.0 (Ubuntu)\nbuilt with OpenSSL 3.0.13 30 Jan 2024\nTLS SNI support enabled\nconfigure arguments: --with-cc-opt=\'-g -O2\' --prefix=/usr/share/nginx --conf-path=/etc/nginx/nginx.conf --http-log-path=/var/log/nginx/access.log --error-log-path=stderr --lock-path=/var/lock/nginx.lock --pid-path=/run/nginx.pid\n', code: 0 };
    const err = h.checks.nginx ? h.checks.nginx(h) : nginxCheck(h);
    if (argv.includes('-t') || argv.includes('-T')) {
      if (!root(ctx)) return { stdout: '', stderr: '2026/10/24 01:20:11 [warn] 2412#2412: the "user" directive makes sense only if the master process runs with super-user privileges, ignored in /etc/nginx/nginx.conf:1\nnginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\n2026/10/24 01:20:11 [emerg] 2412#2412: open() "/run/nginx.pid" failed (13: Permission denied)\nnginx: configuration file /etc/nginx/nginx.conf test failed\nℹ sudo nginx -t で実行してください。\n', code: 1 };
      if (err) return { stdout: '', stderr: err.join('\n') + '\nnginx: configuration file /etc/nginx/nginx.conf test failed\n', code: 1 };
      const dump = argv.includes('-T') ? ['/etc/nginx/nginx.conf', ...ctx.vfs.walk('/etc/nginx/sites-enabled'), ...ctx.vfs.walk('/etc/nginx/conf.d')].filter(p => ctx.vfs.isFile(p)).map(p => `# configuration file ${p}:\n${ctx.vfs.read(p)}`).join('\n') : '';
      return { stdout: dump, stderr: 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n', code: 0 };
    }
    if (argv.includes('-s')) { const sig = argv[argv.indexOf('-s') + 1]; if (!root(ctx)) return { stdout: '', stderr: 'nginx: [alert] kill(813, 1) failed (1: Operation not permitted)\n', code: 1 }; if (h.svcState('nginx') !== 'active') return { stdout: '', stderr: 'nginx: [error] invalid PID number "" in "/run/nginx.pid"\n', code: 1 }; if (sig === 'reload' && err) return { stdout: '', stderr: err.join('\n') + '\n', code: 1 }; if (sig === 'stop' || sig === 'quit') h.setSvc('nginx', 'inactive'); return ''; }
    return { stdout: '', stderr: 'ℹ nginx は systemctl で操作します（sudo systemctl restart nginx）。設定テストは sudo nginx -t です。\n', code: 1 };
  };
  C.logrotate = (argv, ctx) => {
    const conf = argv.filter(a => !a.startsWith('-'))[0] || '/etc/logrotate.conf';
    const debug = argv.includes('-d') || argv.includes('--debug');
    const force = argv.includes('-f') || argv.includes('--force');
    if (!root(ctx) && !debug) return { stdout: '', stderr: `error: error setting owner of /var/lib/logrotate/status.tmp to uid 0 and gid 0: Operation not permitted\n`, code: 1 };
    const fs = ctx.vfs;
    const files = [];
    const read = p => { const t = fs.read(ctx.resolve(p)); if (!t) return; for (const m of t.matchAll(/^([^\s{}#][^{]*?)\s*\{([\s\S]*?)\}/gm)) for (const f of m[1].trim().split(/\s+/)) files.push({ f, body: m[2] }); for (const m of t.matchAll(/^include\s+(\S+)/gm)) for (const k of fs.walk(m[1]).filter(x => fs.isFile(x))) read(k); };
    read(conf);
    const o = out();
    for (const { f, body } of files) {
      for (const p of IG.bash.globRe ? [f] : [f]) {
        const abs = ctx.resolve(p);
        if (!fs.exists(abs)) { if (debug) o.e(`considering log ${p}\n  log ${p} does not exist -- skipping`, 0); continue; }
        if (debug) { o.e(`rotating pattern: ${p}  ${/weekly/.test(body) ? 'weekly' : 'daily'} (${(body.match(/rotate (\d+)/) || [0, 4])[1]} rotations)\nconsidering log ${p}\n  log needs rotating: ${force ? 'yes (forced)' : 'no'}`, 0); continue; }
        if (!force) continue;
        const n = fs.node(abs);
        const comp = /\bcompress\b/.test(body) && !/delaycompress/.test(body);
        if (/copytruncate/.test(body)) { fs.write(abs + '.1' + (comp ? '.gz' : ''), (comp ? GZ : '') + n.content, { owner: n.owner, group: n.group, mode: n.mode, size: comp ? Math.round(fs.fileSize(n) * 0.25) : n.size }); n.content = ''; n.size = undefined; }
        else { fs.rename(abs, abs + '.1'); fs.write(abs, '', { owner: n.owner, group: n.group, mode: n.mode }); if (comp) { const r = fs.node(abs + '.1'); fs.write(abs + '.1.gz', GZ + r.content, { owner: n.owner, group: n.group, mode: n.mode, size: Math.round(fs.fileSize(r) * 0.25) }); fs.remove(abs + '.1'); } }
      }
    }
    ctx.world.reconcile();
    return o.r();
  };
  C.man = (argv, ctx) => {
    if (argv[0] === '-k') return C.apropos(argv.slice(1), ctx);
    if (argv[0] === '-f') return C.whatis(argv.slice(1), ctx);
    const name = argv.filter(a => !a.startsWith('-') && !/^\d[a-z]?$/.test(a))[0];   // `man 5 crontab`
    if (!name) return { stdout: '', stderr: 'What manual page do you want?\nFor example, try \'man man\'.\n', code: 1 };
    const page = IG.manpages && IG.manpages.man(name);
    if (!page) return { stdout: '', stderr: `No manual entry for ${name}\nℹ 名前が分からないときは apropos <やりたいこと> で探せます（例: apropos ディスク 空き）。\n`, code: 16 };
    return page;
  };
  C.info = C.man;
  C.whatis = (argv) => {
    const names = argv.filter(a => !a.startsWith('-'));
    if (!names.length) return { stdout: '', stderr: 'whatis what?\n', code: 1 };
    const found = names.filter(n => IG.manpages.has(n));
    return { stdout: join(found.map(n => IG.manpages.line(n))), stderr: join(names.filter(n => !found.includes(n)).map(n => `${n}: nothing appropriate.`)), code: found.length === names.length ? 0 : 16 };
  };
  // Real apropos searches names and NAME lines; this one also takes Japanese 「やりたいこと」 and adds the matching recipes.
  C.apropos = (argv) => {
    const words = argv.filter(a => !a.startsWith('-'));
    if (!words.length) return { stdout: '', stderr: 'apropos what?\nℹ 例: apropos socket / apropos ポート 使用中\n', code: 1 };
    const r = IG.cmdref.apropos(words);
    if (!r.cmds.length && !r.tasks.length) return { stdout: '', stderr: `${words.join(' ')}: nothing appropriate.\n`, code: 16 };
    const out = r.cmds.map(e => IG.manpages.line(e.name, r.ja ? IG.cmdref.lead(e.ja) : e.en));
    if (r.tasks.length) {
      out.push('', 'ℹ やりたいこと別のレシピ（コマンド辞典より）:');
      for (const t of r.tasks) out.push(`  ■ ${t.q}`, ...t.do.slice(0, 3).map(([c, n]) => `      $ ${c}    # ${n}`));
    }
    return join(out);
  };
  C.whereis = (argv, ctx) => join(argv.map(n => { const w = ctx.shell.which(n); return `${n}:${w ? ' ' + w.path : ''}${IG.manpages && IG.manpages.desc(n) ? ` /usr/share/man/man1/${n}.1.gz` : ''}`; }));
  C.which = (argv, ctx) => {
    const all = argv.includes('-a');
    const names = argv.filter(a => !a.startsWith('-'));
    const res = names.map(n => { const w = ctx.shell.which(n); return w && (!w.registered || ctx.host.hasCommand(n)) ? (all && w.path.startsWith('/usr/bin/') ? `${w.path}\n/bin/${n}` : w.path) : null; });
    return { stdout: join(res.filter(Boolean)), stderr: '', code: res.every(Boolean) ? 0 : 1 };
  };
  C.bash = (argv, ctx) => {
    const sh = ctx.shell;
    let i = 0, xtrace = false, noexec = false;
    while (argv[i] && /^-[xnveil]+$/.test(argv[i])) { if (argv[i].includes('x')) xtrace = true; if (argv[i].includes('n')) noexec = true; i++; }
    if (argv[i] === '-c') {
      const src = argv[i + 1] || '';
      return { stdout: '', stderr: '', code: sh.runScript(src, [argv[i + 2] || ctx.name, ...argv.slice(i + 3)], ctx.io, { xtrace, noexec }) };
    }
    if (argv[i] === '--version') return 'GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)\nCopyright (C) 2020 Free Software Foundation, Inc.';
    if (argv[i]) {
      const p = ctx.resolve(argv[i]);
      const n = ctx.vfs.node(p);
      if (!n) return { stdout: '', stderr: `${ctx.name}: ${argv[i]}: No such file or directory\n`, code: 127 };
      if (!ctx.shell.canRead(p)) return { stdout: '', stderr: `${ctx.name}: ${argv[i]}: Permission denied\n`, code: 126 };
      return { stdout: '', stderr: '', code: sh.runScript(n.content, [argv[i], ...argv.slice(i + 1)], ctx.io, { xtrace, noexec }) };
    }
    if (ctx.hasStdin) return { stdout: '', stderr: '', code: sh.runScript(ctx.stdin, [ctx.name], ctx.io, { xtrace }) };
    return { stdout: '', stderr: 'ℹ 入れ子の対話シェルは開けません。bash -c "コマンド" か bash スクリプト.sh の形で使ってください。\n', code: 1 };
  };
  C.sh = C.bash;
})(globalThis.IG = globalThis.IG || {});
