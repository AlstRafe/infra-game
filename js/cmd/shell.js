/* Bash-like shell: tokenizer (quotes, $VAR, globs), pipes, redirection, && || ;,
 * Linux builtins, ssh between simulated hosts, curl, and Tab completion. */
(function (IG) {
  'use strict';
  const U = IG.util;
  const VFS = IG.VFS;
  IG.commands = IG.commands || {};
  const C = IG.commands;
  const ok = (out = '') => ({ out, code: 0 });
  const fail = (out, code = 1) => ({ out, code, err: true });

  /* ------------------------------------------------------------ tokenizer */
  function tokenize(line, env) {
    const toks = [];
    let cur = null, glob = false, quoted = false, i = 0;
    const push = () => { if (cur !== null) toks.push({ t: 'w', v: cur, glob, quoted }); cur = null; glob = false; quoted = false; };
    const add = s => { cur = (cur || '') + s; };
    const readVar = () => {
      if (line[i + 1] === '{') { const j = line.indexOf('}', i); const name = line.slice(i + 2, j); i = j; return env[name] ?? ''; }
      if (line[i + 1] === '?') { i++; return String(env['?'] ?? 0); }
      const m = line.slice(i + 1).match(/^[A-Za-z_]\w*/);
      if (!m) return '$';
      i += m[0].length;
      return env[m[0]] ?? '';
    };
    while (i < line.length) {
      const c = line[i];
      if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) throw new Error('unexpected EOF while looking for matching `\''); add(line.slice(i + 1, j)); quoted = true; i = j + 1; continue; }
      if (c === '"') {
        i++; quoted = true; cur = cur || '';
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && /["\\$`]/.test(line[i + 1])) { add(line[i + 1]); i += 2; continue; }
          if (line[i] === '$') { add(readVar()); i++; continue; }
          add(line[i]); i++;
        }
        if (i >= line.length) throw new Error('unexpected EOF while looking for matching `"\'');
        i++; continue;
      }
      if (c === '\\') { add(line[i + 1] || ''); i += 2; continue; }
      if (c === '$') { add(readVar()); i++; continue; }
      if (/\s/.test(c)) { push(); i++; continue; }
      if (c === '#' && cur === null) break;
      if (c === '|' || c === '&' || c === ';' || c === '>' || c === '<') {
        if (c === '>' && cur === '2' && !quoted) { cur = null; if (line.slice(i, i + 3) === '>&1') { toks.push({ t: 'op', v: '2>&1' }); i += 3; } else { toks.push({ t: 'op', v: '2>' }); i++; } continue; }
        push();
        const two = line.slice(i, i + 2);
        if (two === '||' || two === '&&' || two === '>>') { toks.push({ t: 'op', v: two }); i += 2; continue; }
        if (c === '&') { toks.push({ t: 'op', v: '&' }); i++; continue; }
        toks.push({ t: 'op', v: c }); i++; continue;
      }
      if ((c === '*' || c === '?') ) glob = true;
      add(c); i++;
    }
    push();
    return toks;
  }
  IG.shellWords = line => tokenize(line, {}).filter(t => t.t === 'w').map(t => t.v);

  function globToRe(p) { return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }

  /* ------------------------------------------------------------ shell */
  class Shell {
    constructor(world, opt = {}) {
      this.world = world;
      this.stack = [{ host: 'bastion', cwd: world.hosts.bastion.home, prev: world.hosts.bastion.home }];
      this.env = { USER: 'operator', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color' };
      this.aliases = { ll: 'ls -l', la: 'ls -a', k: 'kubectl' };
      this.history = [];
      this.root = false;
      this.lastCode = 0;
      Object.assign(this.env, opt.env || {});
    }
    get frame() { return this.stack[this.stack.length - 1]; }
    get host() { return this.world.hosts[this.frame.host]; }
    get cwd() { return this.frame.cwd; }
    prompt() {
      const h = this.host;
      const home = h.home;
      const p = this.cwd === home ? '~' : this.cwd.startsWith(home + '/') ? '~' + this.cwd.slice(home.length) : this.cwd;
      return `${h.user}@${h.name}:${p}${h.user === 'root' ? '#' : '$'}`;
    }
    baseEnv() {
      const h = this.host;
      return Object.assign({}, this.env, { HOME: h.home, USER: h.user, HOSTNAME: h.name, PWD: this.cwd, '?': this.lastCode });
    }

    // Run a full command line. `over` = { pod } | { container } for kubectl/docker exec.
    exec(line, over = null) {
      const raw = String(line).trim();
      if (!raw) return ok('');
      if (!over) this.history.push(raw);
      let toks;
      try { toks = tokenize(this.expandAlias(raw), over && over.pod ? Object.assign({}, over.pod.env) : over && over.container ? Object.assign({}, over.container.env) : this.baseEnv()); }
      catch (e) { return fail(`bash: ${e.message}`, 2); }
      // split into sequences
      const seqs = [];
      let curSeq = [], op = null;
      for (const t of toks) {
        if (t.t === 'op' && (t.v === '&&' || t.v === '||' || t.v === ';')) { seqs.push({ toks: curSeq, op }); curSeq = []; op = t.v; continue; }
        curSeq.push(t);
      }
      seqs.push({ toks: curSeq, op });
      const outs = [];
      let code = 0, extra = {};
      for (const s of seqs) {
        if (!s.toks.length) { if (s.op && s.op !== ';') return fail(`bash: syntax error near unexpected token \`${s.op}'`, 2); continue; }
        if (s.op === '&&' && code !== 0) continue;
        if (s.op === '||' && code === 0) continue;
        const r = this.pipeline(s.toks, over);
        if (r.out) outs.push({ text: r.out, err: r.err });
        code = r.code || 0;
        if (r.clear) extra.clear = true;
        if (r.editor) extra.editor = r.editor;
      }
      this.lastCode = code;
      const text = outs.map(o => o.text).join('\n');
      return Object.assign({ out: text, code, err: code !== 0 && outs.length > 0 && outs.every(o => o.err) }, extra);
    }
    expandAlias(line) {
      const m = line.match(/^(\S+)(.*)$/);
      if (m && this.aliases[m[1]] && !line.startsWith('alias ')) return this.aliases[m[1]] + m[2];
      return line;
    }
    pipeline(toks, over) {
      const cmds = [[]];
      for (const t of toks) { if (t.t === 'op' && t.v === '|') cmds.push([]); else cmds[cmds.length - 1].push(t); }
      if (cmds.some(c => !c.length)) return fail("bash: syntax error near unexpected token `|'", 2);
      let stdin = null, last = null;
      const errs = [];
      for (let idx = 0; idx < cmds.length; idx++) {
        const r = this.simple(cmds[idx], stdin, over);
        if (r.err && idx < cmds.length - 1) { errs.push(r.out); stdin = ''; continue; }
        stdin = r.out || '';
        last = r;
      }
      if (!last) return fail(errs.join('\n'));
      if (errs.length) return Object.assign({}, last, { out: [...errs, last.out].filter(Boolean).join('\n') });
      return last;
    }
    simple(toks, stdin, over) {
      const words = [];
      const redir = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.t === 'op') {
          if (['>', '>>', '<', '2>'].includes(t.v)) {
            const target = toks[i + 1];
            if (!target || target.t !== 'w') return fail(`bash: syntax error near unexpected token \`newline'`, 2);
            redir.push({ op: t.v, target: target.v }); i++; continue;
          }
          if (t.v === '2>&1') { redir.push({ op: '2>&1' }); continue; }
          if (t.v === '&') continue;
        }
        if (t.glob && !t.quoted) words.push(...this.glob(t.v, over)); else words.push(t.quoted ? t.v : t.v.replace(/^~(?=\/|$)/, this.host.home));
      }
      for (const r of redir) {
        if (r.op === '<') {
          const p = this.resolve(r.target);
          const c = this.vfs(over).read(p);
          if (c === undefined) return fail(`bash: ${r.target}: No such file or directory`);
          stdin = c;
        }
      }
      let res;
      if (!words.length) res = ok('');
      else {
        // VAR=value assignment
        if (/^[A-Za-z_]\w*=/.test(words[0]) && words.length === 1) { const i = words[0].indexOf('='); this.env[words[0].slice(0, i)] = words[0].slice(i + 1); return ok(''); }
        res = this.runArgv(words, over, stdin);
      }
      const silenceErr = redir.some(r => r.op === '2>' && r.target === '/dev/null');
      const toFile = redir.find(r => r.op === '>' || r.op === '>>');
      if (toFile) {
        const merge = redir.some(r => r.op === '2>&1');
        const body = res.err && !merge ? '' : res.out || '';
        if (toFile.target !== '/dev/null') {
          const p = this.resolve(toFile.target);
          const fs = this.vfs(over);
          if (fs.isDir(p)) return fail(`bash: ${toFile.target}: Is a directory`);
          if (!fs.isDir(VFS.parent(p))) return fail(`bash: ${toFile.target}: No such file or directory`);
          if (!this.writable(p, over)) return fail(`bash: ${toFile.target}: Permission denied`);
          const prev = toFile.op === '>>' ? fs.read(p) || '' : '';
          fs.write(p, prev + (body ? body + (body.endsWith('\n') ? '' : '\n') : ''));
        }
        res = Object.assign({}, res, { out: res.err && !merge && !silenceErr ? res.out : '' });
      }
      if (silenceErr && res.err) res = Object.assign({}, res, { out: '' });
      return res;
    }
    glob(pattern, over) {
      const fs = this.vfs(over);
      const abs = this.resolve(pattern);
      const dir = VFS.parent(abs), base = VFS.base(abs);
      if (/[*?]/.test(dir)) return [pattern];
      const re = globToRe(base);
      const hits = fs.children(dir).filter(c => re.test(c.name) && (!c.name.startsWith('.') || base.startsWith('.')));
      if (!hits.length) return [pattern];
      const prefix = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/') + 1) : '';
      return hits.map(h => prefix + h.name);
    }
    resolve(p) { return VFS.norm(p, this.cwd, this.host.home); }
    vfs(over) { return over && (over.pod || over.container) ? this.podFs(over) : this.host.vfs; }
    podFs(over) {
      const x = over.pod || over.container;
      const name = over.pod ? over.pod.pod : over.container.name;
      const ns = over.pod ? over.pod.ns : null;
      return new VFS({ files: {
        '/etc/hostname': name + '\n',
        '/etc/resolv.conf': ns ? `search ${ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n` : 'nameserver 127.0.0.11\noptions ndots:0\n',
        '/etc/hosts': `127.0.0.1\tlocalhost\n${(x && x.ip) || '172.18.0.3'}\t${name}\n`,
        '/etc/os-release': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
      }, dirs: ['/app', '/tmp', '/var', '/usr/bin'] });
    }
    writable(path, over) {
      if (over && (over.pod || over.container)) return path.startsWith('/tmp');
      if (this.root || this.host.user === 'root') return true;
      return path === this.host.home || path.startsWith(this.host.home + '/') || path.startsWith('/tmp');
    }
    from(over) {
      if (over && over.pod) return { kind: 'pod', cluster: over.pod.cluster, ns: over.pod.ns, pod: over.pod.pod };
      if (over && over.container) return { kind: 'container', container: over.container.name };
      return { kind: 'host', host: this.host.name };
    }

    runArgv(argv, over = null, stdin = null) {
      let [name, ...args] = argv;
      if (name === 'sudo') {
        if (over) return fail('sh: sudo: not found', 127);
        if (!args.length) return fail('usage: sudo command');
        const was = this.root; this.root = true;
        try { return this.runArgv(args, over, stdin); } finally { this.root = was; }
      }
      const ctx = {
        world: this.world, shell: this, host: this.host, vfs: this.vfs(over), cwd: over ? '/' : this.cwd, stdin,
        env: over && over.pod ? over.pod.env : over && over.container ? over.container.env : this.baseEnv(),
        resolve: p => (over ? VFS.norm(p, '/') : this.resolve(p)), pod: over && over.pod, container: over && over.container, root: this.root || this.host.user === 'root',
        from: this.from(over),
      };
      if (over) {
        const allowed = ['curl', 'wget', 'env', 'printenv', 'hostname', 'cat', 'ls', 'echo', 'nslookup', 'dig', 'whoami', 'id', 'ping', 'head', 'tail', 'grep', 'wc', 'sleep', 'date', 'pwd', 'true', 'false', 'exit', 'ps', 'uname'];
        if (!allowed.includes(name)) return fail(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${name}": executable file not found in $PATH: unknown\ncommand terminated with exit code 126`, 126);
      }
      const fn = Builtins[name] || C[name];
      if (!fn) {
        const near = Object.keys(Object.assign({}, Builtins, C)).find(c => c.length > 2 && (c.startsWith(name.slice(0, 3)) || name.startsWith(c)));
        return fail(`bash: ${name}: command not found${near ? `\nℹ もしかして: ${near}` : ''}`, 127);
      }
      try {
        const r = fn(args, ctx);
        return typeof r === 'string' ? ok(r) : r || ok('');
      } catch (e) {
        if (typeof console !== 'undefined') console.error(e);
        return fail(`${name}: internal simulator error: ${e.message}`);
      }
    }

    /* ------------------------------------------------------------ completion */
    complete(line) {
      const endsSpace = /\s$/.test(line);
      const parts = line.trim() ? line.trim().split(/\s+/) : [];
      const cur = endsSpace ? '' : parts.pop() || '';
      const prev = parts;
      let cands = [];
      const w = this.world;
      const cl = w.currentCluster();
      const ctxNs = () => { const i = prev.findIndex(p => p === '-n' || p === '--namespace'); return i >= 0 ? prev[i + 1] : (w.context() || {}).namespace || 'default'; };
      const resourceNames = (type, ns) => {
        if (!cl) return [];
        const T = { po: 'pods', pod: 'pods', pods: 'pods', deploy: 'deployments', deployment: 'deployments', deployments: 'deployments', svc: 'services', service: 'services', services: 'services', cm: 'configmaps', configmap: 'configmaps', configmaps: 'configmaps', secret: 'secrets', secrets: 'secrets', ns: 'namespaces', namespace: 'namespaces', namespaces: 'namespaces', no: 'nodes', node: 'nodes', nodes: 'nodes', route: 'routes', routes: 'routes', ep: 'services', endpoints: 'services' }[type];
        if (T === 'pods') return cl.pods.filter(p => p.ns === ns).map(p => p.name);
        if (T === 'nodes') return cl.nodes.map(n => n.name);
        const K = { deployments: 'Deployment', services: 'Service', configmaps: 'ConfigMap', secrets: 'Secret', namespaces: 'Namespace', routes: 'Route' }[T];
        return K ? cl.list(K, K === 'Namespace' ? null : ns).map(o => o.metadata.name) : [];
      };
      if (!prev.length) {
        cands = Object.keys(Object.assign({}, Builtins, C, this.aliases)).filter(c => !c.includes('-') || c === 'docker-compose');
      } else {
        const cmd = prev[0];
        if ((cmd === 'kubectl' || cmd === 'k' || cmd === 'oc') && !cur.startsWith('-')) {
          const verbs = cmd === 'oc' ? IG.ocVerbs : IG.kubectlVerbs;
          const pos = prev.slice(1).filter((p, i, arr) => !p.startsWith('-') && !['-n', '--namespace', '-o', '-f', '-l', '-c'].includes(arr[i - 1]));
          if (prev[prev.length - 1] === '-n' || prev[prev.length - 1] === '--namespace') cands = cl ? cl.list('Namespace').map(n => n.metadata.name) : [];
          else if (prev[prev.length - 1] === '-f') cands = null;
          else if (!pos.length) cands = verbs;
          else if (['rollout'].includes(pos[0]) && pos.length === 1) cands = ['status', 'history', 'undo', 'restart'];
          else if (['config'].includes(pos[0]) && pos.length === 1) cands = ['current-context', 'get-contexts', 'use-context', 'set-context', 'view'];
          else if (['create'].includes(pos[0]) && pos.length === 1) cands = ['deployment', 'configmap', 'secret', 'namespace', 'service'];
          else if (['set'].includes(pos[0]) && pos.length === 1) cands = ['image', 'env'];
          else if (['logs', 'exec'].includes(pos[0]) && pos.length === 1) cands = resourceNames('pods', ctxNs()).concat(resourceNames('deploy', ctxNs()).map(n => 'deploy/' + n));
          else if (['cordon', 'uncordon', 'drain'].includes(pos[0])) cands = resourceNames('nodes');
          else if (['get', 'describe', 'delete', 'edit', 'scale', 'label', 'patch', 'expose', 'rollout', 'top'].includes(pos[0]) || (pos[0] === 'rollout' && pos.length >= 2)) {
            const rest = pos[0] === 'rollout' ? pos.slice(2) : pos.slice(1);
            if (cur.includes('/')) { const [t] = cur.split('/'); cands = resourceNames(t, ctxNs()).map(n => t + '/' + n); }
            else if (!rest.length) cands = pos[0] === 'top' ? ['nodes', 'pods'] : pos[0] === 'scale' || pos[0] === 'rollout' ? ['deployment', 'deploy/'] : ['pods', 'deployments', 'services', 'endpoints', 'configmaps', 'secrets', 'nodes', 'namespaces', 'events', 'replicasets', 'all'].concat(cl && cl.openshift ? ['routes'] : []);
            else cands = resourceNames(rest[0], ctxNs());
          }
        } else if (cmd === 'docker' && !cur.startsWith('-')) {
          const pos = prev.slice(1).filter(p => !p.startsWith('-'));
          if (!pos.length) cands = IG.dockerVerbs;
          else if (pos[0] === 'compose' && pos.length === 1) cands = ['up', 'down', 'ps', 'logs', 'restart', 'config'];
          else if (['logs', 'start', 'stop', 'restart', 'rm', 'exec', 'inspect'].includes(pos[0])) cands = w.docker ? w.docker.containers.map(c => c.name) : [];
          else if (['push', 'tag', 'rmi', 'run'].includes(pos[0])) cands = w.docker ? w.docker.images.map(i => i.ref) : [];
          else cands = null;
        } else if (cmd === 'aws' && !cur.startsWith('-')) {
          const pos = prev.slice(1).filter(p => !p.startsWith('-'));
          const ops = { ec2: ['describe-instances', 'describe-security-groups', 'authorize-security-group-ingress', 'revoke-security-group-ingress', 'start-instances', 'stop-instances'], s3: ['ls', 'cp', 'mb'], s3api: ['get-public-access-block', 'put-public-access-block', 'get-bucket-policy', 'get-bucket-policy-status', 'delete-bucket-policy', 'list-buckets'], eks: ['list-clusters', 'describe-cluster', 'update-kubeconfig'], sts: ['get-caller-identity'], configure: ['list', 'get', 'set'] };
          cands = !pos.length ? Object.keys(ops) : pos.length === 1 ? ops[pos[0]] || [] : null;
        } else if (cmd === 'harbor') {
          const pos = prev.slice(1).filter(p => !p.startsWith('-'));
          const sub = { project: ['list', 'create', 'view'], repo: ['list'], artifact: ['list', 'scan', 'vulnerabilities'], robot: ['create', 'list'] };
          cands = !pos.length ? ['login', 'project', 'repo', 'artifact', 'robot'] : pos.length === 1 ? sub[pos[0]] || [] : null;
        } else if (cmd === 'systemctl' || (cmd === 'sudo' && prev[1] === 'systemctl')) {
          const pos = prev.slice(cmd === 'sudo' ? 2 : 1);
          cands = !pos.length ? ['status', 'restart', 'start', 'stop', 'is-active'] : Object.keys(this.host.services);
        } else if (cmd === 'ssh') cands = Object.values(w.hosts).filter(h => h.sshable && h.name !== this.host.name).map(h => h.name);
        else cands = null;
      }
      if (cands === null || (cands && cands.length === 0 && prev.length)) cands = this.pathCands(cur);
      const opts = [...new Set(cands)].filter(c => c.startsWith(cur)).sort();
      if (!opts.length) return { line, options: [] };
      const prefix = opts.reduce((p, c) => { while (!c.startsWith(p)) p = p.slice(0, -1); return p; }, opts[0]);
      const base = line.slice(0, line.length - cur.length);
      if (opts.length === 1) return { line: base + opts[0] + (opts[0].endsWith('/') ? '' : ' '), options: [] };
      return { line: base + prefix, options: opts };
    }
    pathCands(cur) {
      const fs = this.host.vfs;
      const dirPart = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/') + 1) : '';
      const dir = this.resolve(dirPart || '.');
      if (!fs.isDir(dir)) return [];
      return fs.children(dir).filter(c => !c.name.startsWith('.') || VFS.base('/' + cur).startsWith('.')).map(c => dirPart + c.name + (c.dir ? '/' : ''));
    }
  }

  /* ------------------------------------------------------------ builtins */
  const MONTH = 'Oct 24 09:41';
  function lsLong(fs, e, h, user) {
    const sys = !e.path.startsWith('/home/') && !e.path.startsWith('/tmp');
    const owner = sys ? 'root' : user;
    const size = e.dir ? 4096 : fs.size(e.path);
    return `${e.dir ? 'drwxr-xr-x' : e.path.endsWith('.sh') ? '-rwxr-xr-x' : '-rw-r--r--'} ${e.dir ? 2 : 1} ${owner.padEnd(8)} ${owner.padEnd(8)} ${(h ? U.human(size) : String(size)).padStart(h ? 5 : 9)} ${MONTH} ${e.name}${e.dir ? '/' : ''}`;
  }
  function readInputs(args, ctx, cmd) {
    if (!args.length) return { texts: [ctx.stdin || ''] };
    const texts = [];
    for (const f of args) {
      const p = ctx.resolve(f);
      if (ctx.vfs.isDir(p)) return { error: `${cmd}: ${f}: Is a directory` };
      const c = ctx.vfs.read(p);
      if (c === undefined) return { error: `${cmd}: ${f}: No such file or directory` };
      texts.push(c);
    }
    return { texts };
  }
  function lines(t) { const l = String(t).split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }
  function sedRe(pat, ere, flags) {
    let src = pat;
    if (!ere) src = src.replace(/\\([(){}+?|])|([(){}+?|])/g, (m, esc, bare) => (esc ? esc : '\\' + bare));
    return new RegExp(src, flags);
  }
  function statusLine(code) { return ({ 200: 'OK', 201: 'Created', 301: 'Moved Permanently', 302: 'Found', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 412: 'Precondition Failed', 500: 'Internal Server Error', 503: 'Service Unavailable' })[code] || ''; }

  function jq(filter, data) {
    const stages = filter.split('|').map(s => s.trim());
    let vals = [data];
    for (const st of stages) {
      const next = [];
      for (const v of vals) {
        if (st === '.' || st === '') { next.push(v); continue; }
        if (st === 'keys') { next.push(Object.keys(v || {}).sort()); continue; }
        if (st === 'length') { next.push(Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : String(v ?? '').length); continue; }
        let cur = [v];
        const parts = st.match(/\.[\w-]+|\.?\[\d*\]|\."[^"]+"/g) || [];
        for (const p of parts) {
          const nx = [];
          for (const c of cur) {
            if (p === '[]' || p === '.[]') { if (Array.isArray(c)) nx.push(...c); else if (c && typeof c === 'object') nx.push(...Object.values(c)); }
            else if (/\[\d+\]/.test(p)) nx.push(Array.isArray(c) ? c[Number(p.replace(/\D/g, ''))] : null);
            else nx.push(c == null ? null : c[p.replace(/^\.|"/g, '')] ?? null);
          }
          cur = nx;
        }
        next.push(...cur);
      }
      vals = next;
    }
    return vals;
  }

  const Builtins = {
    pwd: (a, c) => ok(c.cwd),
    cd(a, c) {
      const sh = c.shell;
      if (c.pod || c.container) return fail('sh: cd: not supported in exec');
      let target = a[0];
      if (!target || target === '~') target = c.host.home;
      if (target === '-') target = sh.frame.prev;
      const p = sh.resolve(target);
      if (!c.vfs.exists(p)) return fail(`bash: cd: ${a[0]}: No such file or directory`);
      if (!c.vfs.isDir(p)) return fail(`bash: cd: ${a[0]}: Not a directory`);
      sh.frame.prev = sh.frame.cwd; sh.frame.cwd = p;
      return ok(a[0] === '-' ? p : '');
    },
    ls(a, c) {
      const { pos, flags } = U.args(a);
      const long = flags.l, all = flags.a || flags.A, human = flags.h, rec = flags.R;
      const targets = pos.length ? pos : ['.'];
      const out = [];
      const listDir = (p, label) => {
        let kids = c.vfs.children(p).filter(e => all || !e.name.startsWith('.'));
        if (flags.t) kids = kids.reverse();
        if (label) out.push(label + ':');
        if (long) { out.push(`total ${kids.length * 4}`); kids.forEach(e => out.push(lsLong(c.vfs, e, human, c.host.user))); }
        else if (kids.length) out.push((flags['1'] ? kids.map(e => e.name + (e.dir ? '/' : '')).join('\n') : kids.map(e => e.name + (e.dir ? '/' : '')).join('  ')));
        if (rec) for (const k of kids.filter(e => e.dir)) { out.push(''); listDir(k.path, k.path); }
      };
      for (const t of targets) {
        const p = c.resolve(t);
        if (!c.vfs.exists(p)) return fail(`ls: cannot access '${t}': No such file or directory`, 2);
        if (c.vfs.isFile(p)) out.push(long ? lsLong(c.vfs, { name: t, path: p, dir: false }, human, c.host.user) : t);
        else listDir(p, targets.length > 1 || rec ? (rec && t === '.' ? '.' : t) : '');
        if (targets.length > 1) out.push('');
      }
      return ok(out.join('\n').trimEnd());
    },
    tree(a, c) {
      const root = c.resolve(a.find(x => !x.startsWith('-')) || '.');
      if (!c.vfs.isDir(root)) return fail(`${a[0]} [error opening dir]`);
      const out = [a.find(x => !x.startsWith('-')) || '.'];
      let nd = 0, nf = 0;
      const walk = (p, pre) => {
        const kids = c.vfs.children(p).filter(e => !e.name.startsWith('.'));
        kids.forEach((k, i) => { const last = i === kids.length - 1; out.push(pre + (last ? '└── ' : '├── ') + k.name); if (k.dir) { nd++; walk(k.path, pre + (last ? '    ' : '│   ')); } else nf++; });
      };
      walk(root, '');
      out.push('', `${nd} directories, ${nf} files`);
      return ok(out.join('\n'));
    },
    cat(a, c) {
      const files = a.filter(x => x !== '-n');
      const r = readInputs(files, c, 'cat');
      if (r.error) return fail(r.error);
      let t = r.texts.join('');
      if (a.includes('-n')) t = lines(t).map((l, i) => String(i + 1).padStart(6) + '\t' + l).join('\n');
      return ok(t.replace(/\n$/, ''));
    },
    head(a, c) { return headTail(a, c, 'head'); },
    tail(a, c) { return headTail(a, c, 'tail'); },
    grep(a, c) {
      const { pos, flags } = U.args(a, ['e', 'm', 'A', 'B', 'C']);
      let pat = U.first(flags.e) ?? pos.shift();
      if (pat === undefined) return fail("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.", 2);
      let re;
      try {
        const src = flags.E || flags.P ? pat : pat.replace(/\\\|/g, '|').replace(/\\([(){}+?])/g, '$1');
        re = new RegExp(flags.F ? pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : flags.w ? `\\b(?:${src})\\b` : src, flags.i ? 'i' : '');
      } catch (e) { return fail(`grep: Invalid regular expression`, 2); }
      let files = pos;
      if (flags.r || flags.R) {
        const roots = files.length ? files : ['.'];
        files = [];
        for (const r of roots) { const p = c.resolve(r); if (c.vfs.isFile(p)) files.push(r); else for (const f of c.vfs.walk(p)) if (c.vfs.isFile(f)) files.push(f); }
      }
      const multi = files.length > 1 || flags.r || flags.R;
      const out = [];
      let total = 0;
      const sources = files.length ? files : [null];
      for (const f of sources) {
        let text;
        if (f === null) text = c.stdin || '';
        else { const p = c.resolve(f); if (c.vfs.isDir(p)) { out.push(`grep: ${f}: Is a directory`); continue; } text = c.vfs.read(p); if (text === undefined) { out.push(`grep: ${f}: No such file or directory`); continue; } }
        const ls = lines(text);
        let n = 0;
        ls.forEach((l, i) => {
          const hit = re.test(l) !== !!flags.v;
          if (!hit) return;
          n++;
          if (flags.c || flags.l || flags.q) return;
          const shown = flags.o ? (l.match(new RegExp(re.source, re.flags + 'g')) || []).join('\n') : l;
          out.push((multi && f ? f.replace(c.host.home, '~') + ':' : '') + (flags.n ? i + 1 + ':' : '') + shown);
        });
        total += n;
        if (flags.c) out.push((multi && f ? f + ':' : '') + n);
        if (flags.l && n) out.push(f);
      }
      if (flags.q) return { out: '', code: total ? 0 : 1 };
      return { out: out.join('\n'), code: total || flags.c ? 0 : 1 };
    },
    wc(a, c) {
      const { pos, flags } = U.args(a);
      const r = readInputs(pos, c, 'wc');
      if (r.error) return fail(r.error);
      const t = r.texts.join('');
      const l = (t.match(/\n/g) || []).length + (t && !t.endsWith('\n') ? 1 : 0), w = (t.match(/\S+/g) || []).length, ch = t.length;
      const name = pos.length === 1 ? ' ' + pos[0] : '';
      if (flags.l) return ok(l + name);
      if (flags.w) return ok(w + name);
      if (flags.c || flags.m) return ok(ch + name);
      return ok(`${String(l).padStart(7)} ${String(w).padStart(7)} ${String(ch).padStart(7)}${name}`);
    },
    sort(a, c) {
      const { pos, flags } = U.args(a, ['k', 't']);
      const r = readInputs(pos, c, 'sort');
      if (r.error) return fail(r.error);
      let ls = lines(r.texts.join(''));
      const k = flags.k ? Number(String(U.first(flags.k)).split(',')[0]) : 0;
      const key = l => (k ? (l.trim().split(flags.t ? U.first(flags.t) : /\s+/)[k - 1] || '') : l);
      ls.sort((x, y) => (flags.n ? parseFloat(key(x)) - parseFloat(key(y)) : key(x).localeCompare(key(y))));
      if (flags.r) ls.reverse();
      if (flags.u) ls = ls.filter((l, i) => i === 0 || l !== ls[i - 1]);
      return ok(ls.join('\n'));
    },
    uniq(a, c) {
      const { pos, flags } = U.args(a);
      const r = readInputs(pos, c, 'uniq');
      if (r.error) return fail(r.error);
      const out = [];
      for (const l of lines(r.texts.join(''))) { const last = out[out.length - 1]; if (last && last.l === l) last.n++; else out.push({ l, n: 1 }); }
      return ok(out.map(x => (flags.c ? String(x.n).padStart(7) + ' ' : '') + x.l).join('\n'));
    },
    cut(a, c) {
      const { pos, flags } = U.args(a, ['d', 'f', 'c']);
      const r = readInputs(pos, c, 'cut');
      if (r.error) return fail(r.error);
      const d = U.first(flags.d) ?? '\t';
      const pick = spec => { const out = new Set(); String(spec).split(',').forEach(s => { const [x, y] = s.split('-'); const from = Number(x || 1), to = s.includes('-') ? Number(y || 999) : from; for (let i = from; i <= to; i++) out.add(i); }); return [...out].sort((x, y) => x - y); };
      return ok(lines(r.texts.join('')).map(l => flags.c ? pick(U.first(flags.c)).map(i => l[i - 1] || '').join('') : (() => { const f = l.split(d); return pick(U.first(flags.f)).map(i => f[i - 1]).filter(x => x !== undefined).join(d); })()).join('\n'));
    },
    awk(a, c) {
      const { pos, flags } = U.args(a, ['F']);
      const prog = pos.shift();
      if (!prog) return fail("usage: awk [-F fs] 'program' [file ...]", 2);
      const r = readInputs(pos, c, 'awk');
      if (r.error) return fail(r.error);
      const m = prog.match(/^\s*(?:(\/.*?\/)|(NR\s*[<>=!]=?\s*\d+)|(\$\d+\s*[=!~]=?\s*"[^"]*"))?\s*(?:\{\s*print\s*(.*?)\s*;?\s*\})?\s*$/);
      if (!m) return fail('ℹ このシミュレータの awk は \'/regex/ {print $1, $3}\' や \'NR>1 {print $2}\' 程度の簡単な形式のみ対応しています。');
      const fs = flags.F ? new RegExp(U.first(flags.F).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : /\s+/;
      const out = [];
      lines(r.texts.join('')).forEach((l, i) => {
        const fields = flags.F ? l.split(fs) : l.trim().split(fs);
        const get = n => (n === 0 ? l : fields[n - 1] ?? '');
        if (m[1] && !new RegExp(m[1].slice(1, -1)).test(l)) return;
        if (m[2]) { const mm = m[2].match(/NR\s*([<>=!]=?)\s*(\d+)/); const nr = i + 1, v = Number(mm[2]); if (!({ '>': nr > v, '<': nr < v, '>=': nr >= v, '<=': nr <= v, '==': nr === v, '!=': nr !== v })[mm[1]]) return; }
        if (m[3]) { const mm = m[3].match(/\$(\d+)\s*([=!~]=?)\s*"([^"]*)"/); const v = get(Number(mm[1])); const pass = mm[2] === '==' ? v === mm[3] : mm[2] === '!=' ? v !== mm[3] : new RegExp(mm[3]).test(v); if (!pass) return; }
        if (!m[4]) { out.push(l); return; }
        out.push(m[4].split(/\s*,\s*/).map(x => (/^\$\d+$/.test(x) ? get(Number(x.slice(1))) : x === 'NR' ? String(i + 1) : x === 'NF' ? String(fields.length) : x.replace(/^"|"$/g, ''))).join(' '));
      });
      return ok(out.join('\n'));
    },
    sed(a, c) {
      const { pos, flags } = U.args(a, ['e']);
      const scripts = U.list(flags.e).concat(flags.e ? [] : [pos.shift()]).filter(Boolean);
      if (!scripts.length) return fail('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...', 1);
      const ops = [];
      for (const s of scripts) {
        let m = s.match(/^s(.)(.*?)\1(.*?)\1([gip0-9]*)$/);
        if (m) {
          let re;
          try { re = sedRe(m[2], flags.E || flags.r, (m[4].includes('g') ? 'g' : '') + (m[4].includes('i') ? 'i' : '')); } catch (e) { return fail(`sed: -e expression #1, char ${s.length}: Invalid regular expression`); }
          ops.push(l => l.replace(re, m[3].replace(/\\n/g, '\n').replace(/\\(\d)/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\&/g, '&')));
          continue;
        }
        m = s.match(/^(\d+)(?:,(\d+|\$))?([pd])$/);
        if (m) { ops.push({ range: [Number(m[1]), m[2] === '$' ? Infinity : Number(m[2] || m[1])], cmd: m[3] }); continue; }
        m = s.match(/^\/(.*)\/([pd])$/);
        if (m) { ops.push({ re: new RegExp(m[1]), cmd: m[2] }); continue; }
        return fail(`sed: -e expression #1, char ${s.length}: unknown command: \`${s[0]}'`);
      }
      const apply = text => {
        const out = [];
        lines(text).forEach((l, i) => {
          let line = l, del = false, printed = false;
          for (const op of ops) {
            if (typeof op === 'function') { line = op(line); continue; }
            const hit = op.range ? i + 1 >= op.range[0] && i + 1 <= op.range[1] : op.re.test(line);
            if (!hit) continue;
            if (op.cmd === 'd') del = true;
            if (op.cmd === 'p') { out.push(line); printed = true; }
          }
          if (!del && !flags.n) out.push(line);
          void printed;
        });
        return out.join('\n');
      };
      if (flags.i) {
        if (!pos.length) return fail('sed: no input files');
        for (const f of pos) {
          const p = c.resolve(f);
          const t = c.vfs.read(p);
          if (t === undefined) return fail(`sed: can't read ${f}: No such file or directory`, 2);
          if (!c.shell.writable(p, c.pod || c.container ? {} : null)) return fail(`sed: couldn't open temporary file ${VFS.parent(p)}/sed${U.hex(f, 6)}: Permission denied`, 4);
          c.vfs.write(p, apply(t) + (t.endsWith('\n') ? '\n' : ''));
        }
        return ok('');
      }
      const r = readInputs(pos, c, 'sed');
      if (r.error) return fail(r.error.replace('sed: ', "sed: can't read ").replace(': No such', ': No such'), 2);
      return ok(apply(r.texts.join('')));
    },
    tee(a, c) {
      const { pos, flags } = U.args(a);
      for (const f of pos) { const p = c.resolve(f); if (!c.shell.writable(p)) return fail(`tee: ${f}: Permission denied`); c.vfs.write(p, (flags.a ? c.vfs.read(p) || '' : '') + (c.stdin || '') + '\n'); }
      return ok(c.stdin || '');
    },
    find(a, c) {
      const start = a[0] && !a[0].startsWith('-') ? a[0] : '.';
      const rest = a[0] && !a[0].startsWith('-') ? a.slice(1) : a;
      const opt = {};
      for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('-')) opt[rest[i].slice(1)] = rest[i + 1];
      const root = c.resolve(start);
      if (!c.vfs.exists(root)) return fail(`find: '${start}': No such file or directory`);
      const all = [root, ...c.vfs.walk(root)];
      const re = opt.name ? globToRe(opt.name) : opt.iname ? new RegExp(globToRe(opt.iname).source, 'i') : null;
      let sizeTest = null;
      if (opt.size) { const m = opt.size.match(/^([+-]?)(\d+)([kMG]?)$/); if (m) { const mult = { '': 512, k: 1024, M: 1048576, G: 1073741824 }[m[3]]; const v = Number(m[2]) * mult; sizeTest = s => (m[1] === '+' ? s > v : m[1] === '-' ? s < v : s === v); } }
      const hits = all.filter(p => {
        if (opt.type === 'f' && !c.vfs.isFile(p)) return false;
        if (opt.type === 'd' && !c.vfs.isDir(p)) return false;
        if (re && !re.test(VFS.base(p))) return false;
        if (sizeTest && !(c.vfs.isFile(p) && sizeTest(c.vfs.size(p)))) return false;
        return true;
      });
      const shown = p => (start.startsWith('/') ? p : start === '.' ? '.' + p.slice(root.length) : start.replace(/\/$/, '') + p.slice(root.length)) || '.';
      return ok(hits.map(shown).join('\n'));
    },
    mkdir(a, c) {
      const { pos, flags } = U.args(a);
      if (!pos.length) return fail('mkdir: missing operand');
      for (const d of pos) {
        const p = c.resolve(d);
        if (!c.shell.writable(p)) return fail(`mkdir: cannot create directory '${d}': Permission denied`);
        if (c.vfs.exists(p) && !flags.p) return fail(`mkdir: cannot create directory '${d}': File exists`);
        if (!flags.p && !c.vfs.isDir(VFS.parent(p))) return fail(`mkdir: cannot create directory '${d}': No such file or directory`);
        c.vfs.mkdirp(p);
      }
      return ok('');
    },
    touch(a, c) {
      for (const f of a) {
        const p = c.resolve(f);
        if (!c.vfs.isDir(VFS.parent(p))) return fail(`touch: cannot touch '${f}': No such file or directory`);
        if (!c.shell.writable(p)) return fail(`touch: cannot touch '${f}': Permission denied`);
        if (!c.vfs.exists(p)) c.vfs.write(p, '');
      }
      return ok('');
    },
    cp(a, c) {
      const { pos, flags } = U.args(a);
      if (pos.length < 2) return fail(`cp: missing destination file operand after '${pos[0] || ''}'`);
      const dst = c.resolve(pos.pop());
      for (const s of pos) {
        const sp = c.resolve(s);
        if (!c.vfs.exists(sp)) return fail(`cp: cannot stat '${s}': No such file or directory`);
        const target = c.vfs.isDir(dst) ? dst + '/' + VFS.base(sp) : dst;
        if (!c.shell.writable(target)) return fail(`cp: cannot create regular file '${target}': Permission denied`);
        if (c.vfs.isDir(sp)) {
          if (!flags.r && !flags.R && !flags.a) return fail(`cp: -r not specified; omitting directory '${s}'`);
          c.vfs.mkdirp(target);
          for (const f of c.vfs.walk(sp)) { const t = target + f.slice(sp.length); if (c.vfs.isDir(f)) c.vfs.mkdirp(t); else c.vfs.write(t, c.vfs.read(f), { mkdirs: true }); }
        } else c.vfs.write(target, c.vfs.read(sp), { size: c.vfs.files.get(sp).size });
      }
      return ok('');
    },
    mv(a, c) {
      const { pos } = U.args(a);
      if (pos.length < 2) return fail(`mv: missing destination file operand after '${pos[0] || ''}'`);
      const dst = c.resolve(pos.pop());
      for (const s of pos) {
        const sp = c.resolve(s);
        if (!c.vfs.exists(sp)) return fail(`mv: cannot stat '${s}': No such file or directory`);
        if (!c.shell.writable(sp) || !c.shell.writable(dst)) return fail(`mv: cannot move '${s}': Permission denied`);
        const target = c.vfs.isDir(dst) ? dst + '/' + VFS.base(sp) : dst;
        if (c.vfs.isDir(sp)) { c.vfs.mkdirp(target); for (const f of c.vfs.walk(sp)) { const t = target + f.slice(sp.length); if (c.vfs.isDir(f)) c.vfs.mkdirp(t); else c.vfs.write(t, c.vfs.read(f), { mkdirs: true }); } c.vfs.remove(sp, true); }
        else { const e = c.vfs.files.get(sp); c.vfs.write(target, e.content, { size: e.size }); c.vfs.remove(sp); }
      }
      return ok('');
    },
    rm(a, c) {
      const { pos, flags } = U.args(a);
      if (!pos.length) return fail('rm: missing operand');
      for (const f of pos) {
        const p = c.resolve(f);
        if (!c.vfs.exists(p)) { if (flags.f) continue; return fail(`rm: cannot remove '${f}': No such file or directory`); }
        if (p === '/' || p === c.host.home) return fail(`rm: refusing to remove '${f}'（訓練環境の保護）`);
        if (!c.shell.writable(p)) return fail(`rm: cannot remove '${f}': Permission denied\nℹ システム領域のファイルは sudo が必要です。`);
        if (c.vfs.isDir(p) && !flags.r && !flags.R) return fail(`rm: cannot remove '${f}': Is a directory`);
        c.vfs.remove(p, true);
      }
      c.world.reconcile();
      return ok('');
    },
    rmdir(a, c) { for (const d of a) { const p = c.resolve(d); try { c.vfs.remove(p, false); } catch (e) { return fail(`rmdir: failed to remove '${d}': ${e.message === 'ENOTEMPTY' ? 'Directory not empty' : 'No such file or directory'}`); } } return ok(''); },
    truncate(a, c) {
      const { pos, flags } = U.args(a, ['s']);
      if (U.first(flags.s) !== '0') return fail('ℹ このシミュレータの truncate は -s 0 のみ対応しています。');
      for (const f of pos) {
        const p = c.resolve(f);
        if (!c.vfs.isFile(p)) return fail(`truncate: cannot open '${f}' for writing: No such file or directory`);
        if (!c.shell.writable(p)) return fail(`truncate: cannot open '${f}' for writing: Permission denied`);
        c.vfs.write(p, '');
      }
      c.world.reconcile();
      return ok('');
    },
    echo(a) {
      let n = false, e = false;
      while (a[0] === '-n' || a[0] === '-e' || a[0] === '-ne' || a[0] === '-en') { if (a[0].includes('n')) n = true; if (a[0].includes('e')) e = true; a = a.slice(1); }
      let t = a.join(' ');
      if (e) t = t.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      return ok(t + (n ? '' : ''));
    },
    printf(a) { const fmt = (a[0] || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t'); let i = 1; return ok(fmt.replace(/%[sd]/g, () => a[i++] ?? '').replace(/\n$/, '')); },
    history: (a, c) => ok(c.shell.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n')),
    clear: () => ({ out: '', code: 0, clear: true }),
    whoami: (a, c) => (c.pod ? (c.pod.openshift ? fail('whoami: cannot find name for user ID 1000680000') : ok('root')) : c.container ? ok('root') : ok(c.root ? 'root' : c.host.user)),
    id: (a, c) => ok(c.pod && c.pod.openshift ? 'uid=1000680000(1000680000) gid=0(root) groups=0(root),1000680000' : c.pod || c.container || c.root ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=1000(${c.host.user}) gid=1000(${c.host.user}) groups=1000(${c.host.user}),27(sudo),999(docker)`),
    hostname: (a, c) => ok(c.pod ? c.pod.pod : c.container ? c.container.name.slice(0, 12) : c.host.name),
    date: (a, c) => ok(new Date(c.world.now()).toUTCString().replace('GMT', 'UTC')),
    uptime: () => ok(' 09:41:07 up 12 days,  3:22,  1 user,  load average: 0.18, 0.21, 0.19'),
    uname: (a, c) => ok(a.includes('-a') ? `Linux ${c.host.name} 5.15.0-1066-aws #72-Ubuntu SMP x86_64 x86_64 x86_64 GNU/Linux` : a.includes('-r') ? '5.15.0-1066-aws' : 'Linux'),
    env: (a, c) => ok(Object.entries(c.env).filter(([k]) => k !== '?').map(([k, v]) => `${k}=${v}`).join('\n')),
    printenv: (a, c) => (a[0] ? (c.env[a[0]] !== undefined ? ok(c.env[a[0]]) : { out: '', code: 1 }) : ok(Object.entries(c.env).filter(([k]) => k !== '?').map(([k, v]) => `${k}=${v}`).join('\n'))),
    export(a, c) { for (const kv of a) { const i = kv.indexOf('='); if (i > 0) c.shell.env[kv.slice(0, i)] = kv.slice(i + 1); } return ok(''); },
    unset(a, c) { for (const k of a) delete c.shell.env[k]; return ok(''); },
    alias(a, c) {
      if (!a.length) return ok(Object.entries(c.shell.aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\n'));
      for (const d of a) { const i = d.indexOf('='); if (i > 0) c.shell.aliases[d.slice(0, i)] = d.slice(i + 1); else if (c.shell.aliases[d]) return ok(`alias ${d}='${c.shell.aliases[d]}'`); }
      return ok('');
    },
    which(a, c) { const hits = a.filter(x => Builtins[x] || C[x]).map(x => `/usr/bin/${x}`); return { out: hits.join('\n'), code: hits.length === a.length ? 0 : 1 }; },
    type(a, c) { return ok(a.map(x => (c.shell.aliases[x] ? `${x} is aliased to \`${c.shell.aliases[x]}'` : Builtins[x] || C[x] ? `${x} is /usr/bin/${x}` : `bash: type: ${x}: not found`)).join('\n')); },
    man: a => fail(`ℹ man ページは収録していません。${a[0] ? `${a[0]} --help` : '<command> --help'} や help コマンド、kubectl explain を使ってください。`, 16),
    true: () => ok(''),
    false: () => ({ out: '', code: 1 }),
    sleep: () => ok(''),
    chmod: () => ok(''),
    chown: (a, c) => (c.root ? ok('') : fail(`chown: changing ownership of '${a[a.length - 1]}': Operation not permitted`)),
    base64(a, c) {
      const { pos, flags } = U.args(a);
      const r = readInputs(pos, c, 'base64');
      if (r.error) return fail(r.error);
      const t = r.texts.join('');
      if (flags.d || flags.decode) { const d = U.unb64(t.replace(/\s+/g, '')); return d === null ? fail('base64: invalid input') : ok(d); }
      return ok(U.b64(t));
    },
    jq(a, c) {
      const { pos, flags } = U.args(a);
      const filter = pos.shift() || '.';
      const r = readInputs(pos, c, 'jq');
      if (r.error) return fail(r.error);
      let data;
      try { data = JSON.parse(r.texts.join('')); } catch (e) { return fail('jq: error (at <stdin>:0): Cannot parse input as JSON', 2); }
      const vals = jq(filter, data);
      return ok(vals.map(v => (flags.r && typeof v === 'string' ? v : JSON.stringify(v, null, 2))).join('\n'));
    },
    df(a, c) {
      const h = c.host;
      const cap = h.diskGiB * 1024 ** 3, used = h.diskUsedBytes();
      const fmt = n => (a.includes('-h') ? U.human(n) : String(Math.round(n / 1024)));
      return ok(U.table(['Filesystem', a.includes('-h') ? 'Size' : '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted on'], [
        ['/dev/nvme0n1p1', fmt(cap), fmt(used), fmt(Math.max(0, cap - used)), Math.min(100, Math.round((used / cap) * 100)) + '%', '/'],
        ['tmpfs', fmt(3.9 * 1024 ** 3), '0', fmt(3.9 * 1024 ** 3), '0%', '/dev/shm'],
        ['/dev/nvme0n1p15', fmt(105 * 1024 ** 2), fmt(6.1 * 1024 ** 2), fmt(99 * 1024 ** 2), '6%', '/boot/efi'],
      ]));
    },
    du(a, c) {
      const { pos, flags } = U.args(a, ['d']);
      const targets = pos.length ? pos : ['.'];
      const fmt = n => (flags.h ? U.human(n) : String(Math.ceil(n / 1024)));
      const out = [];
      for (const t of targets) {
        const p = c.resolve(t);
        if (!c.vfs.exists(p)) { out.push(`du: cannot access '${t}': No such file or directory`); continue; }
        if (!flags.s && c.vfs.isDir(p)) for (const d of c.vfs.walk(p).filter(x => c.vfs.isDir(x)).reverse()) out.push(`${fmt(c.vfs.size(d) + 4096)}\t${t.replace(/\/$/, '')}${d.slice(p.length)}`);
        out.push(`${fmt(c.vfs.size(p) + (c.vfs.isDir(p) ? 4096 : 0))}\t${t}`);
      }
      return ok(out.join('\n'));
    },
    free: (a) => ok(a.includes('-h') ? U.table(['', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'], [['Mem:', '7.7Gi', '2.1Gi', '3.4Gi', '2.0Mi', '2.2Gi', '5.3Gi'], ['Swap:', '0B', '0B', '0B']]) : U.table(['', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'], [['Mem:', '8039472', '2201548', '3565120', '2048', '2272804', '5557616'], ['Swap:', '0', '0', '0']])),
    ps(a, c) {
      const svc = Object.entries(c.host.services || {}).filter(([, s]) => s === 'active').map(([n], i) => ['root', String(800 + i * 37), '1.2', '2.1', `/usr/bin/${n}`]);
      return ok(U.table(['USER', 'PID', '%CPU', '%MEM', 'COMMAND'], [['root', '1', '0.0', '0.1', '/sbin/init'], ['root', '412', '0.0', '0.2', '/lib/systemd/systemd-journald'], ...svc, [c.host.user, '2201', '0.0', '0.1', '-bash'], [c.host.user, '2240', '0.0', '0.0', 'ps aux']]));
    },
    ip(a, c) {
      const sub = a[0] === 'a' ? 'addr' : a[0] || 'addr';
      if (sub === 'route' || sub === 'r') return ok('default via 10.0.1.1 dev eth0 proto dhcp src ' + c.host.ip + ' metric 100\n10.0.1.0/24 dev eth0 proto kernel scope link src ' + c.host.ip + '\n172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown');
      return ok(`1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc mq state UP\n    inet ${c.host.ip}/24 brd 10.0.1.255 scope global dynamic eth0\n3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN\n    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0`);
    },
    ping(a, c) {
      const { pos, flags } = U.args(a, ['c', 'W', 'i']);
      const host = pos[0];
      if (!host) return fail('ping: usage error: Destination address required', 2);
      const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : c.world.resolveName(host, c.from);
      if (!ip) return fail(`ping: ${host}: Name or service not known`, 2);
      const n = Number(U.first(flags.c) || 3);
      const blocked = c.world.aws && c.world.aws.instances.some(i => i.publicIp === ip);
      if (blocked) return { out: `PING ${host} (${ip}) 56(84) bytes of data.\n\n--- ${host} ping statistics ---\n${n} packets transmitted, 0 received, 100% packet loss, time ${n * 1000 - 1}ms\nℹ ICMP がセキュリティグループで許可されていない可能性があります（ping が通らなくても HTTP は通ることがあります）。`, code: 1 };
      const rows = Array.from({ length: n }, (_, i) => `64 bytes from ${ip}: icmp_seq=${i + 1} ttl=63 time=${(0.3 + (U.hash(ip + i) % 90) / 100).toFixed(2)} ms`);
      return ok(`PING ${host} (${ip}) 56(84) bytes of data.\n${rows.join('\n')}\n\n--- ${host} ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss, time ${n * 1000 - 998}ms`);
    },
    nslookup(a, c) {
      const host = a.find(x => !x.startsWith('-'));
      if (!host) return fail('usage: nslookup <host>');
      const ip = c.world.resolveName(host, c.from);
      const server = c.pod ? '10.96.0.10' : '10.0.0.2';
      if (!ip) return { out: `Server:\t\t${server}\nAddress:\t${server}#53\n\n** server can't find ${host}: NXDOMAIN`, code: 1 };
      let fq = host;
      if (c.pod && !host.includes('.')) fq = `${host}.${c.pod.ns}.svc.cluster.local`;
      else if (c.pod && host.split('.').length === 2) fq = `${host}.svc.cluster.local`;
      return ok(`Server:\t\t${server}\nAddress:\t${server}#53\n\nName:\t${fq}\nAddress: ${ip}`);
    },
    dig(a, c) {
      const host = a.find(x => !x.startsWith('-') && !x.startsWith('+'));
      const ip = host && c.world.resolveName(host, c.from);
      if (a.includes('+short')) return ok(ip || '');
      return ok(`; <<>> DiG 9.18.28 <<>> ${host}\n;; ->>HEADER<<- opcode: QUERY, status: ${ip ? 'NOERROR' : 'NXDOMAIN'}\n\n;; ANSWER SECTION:\n${ip ? `${host}.\t\t30\tIN\tA\t${ip}` : ''}`);
    },
    curl(a, c) {
      const { pos, flags } = U.args(a, ['o', 'X', 'H', 'd', 'data', 'w', 'u', 'm', 'connect-timeout', 'max-time', 'request', 'header', 'output', 'write-out', 'user']);
      const url = pos[0];
      if (!url) return fail("curl: try 'curl --help' or 'curl --manual' for more information", 2);
      const head = flags.I || flags.head;
      const method = U.first(flags.X || flags.request) || (head ? 'HEAD' : flags.d || flags.data ? 'POST' : 'GET');
      const r = c.world.http(url, c.from, { method });
      const silent = flags.s || flags.silent;
      if (r.error) {
        const code = Number((r.error.match(/curl: \((\d+)\)/) || [])[1] || 1);
        if (silent && !(flags.S || flags['show-error'])) return { out: `ℹ curl が失敗しました（exit ${code}）。-s を外すとエラー内容が表示されます。`, code, err: true };
        return { out: r.error, code, err: true };
      }
      const headers = `HTTP/1.1 ${r.status} ${statusLine(r.status)}\n${r.server ? `Server: ${r.server}\n` : ''}Date: ${new Date(c.world.now()).toUTCString()}\nContent-Type: ${/^[{[]/.test(r.body) ? 'application/json' : /^<\?xml/.test(r.body) ? 'application/xml' : 'text/html'}\nContent-Length: ${r.body.length}\nConnection: keep-alive\n`;
      let body = head ? '' : r.body;
      const out = [];
      if (flags.v || flags.verbose) out.push(`*   Trying ${c.world.resolveName(url.replace(/^\w+:\/\//, '').split(/[:/]/)[0], c.from) || '0.0.0.0'}...`, `* Connected (port ${(url.match(/:(\d+)/) || [])[1] || (url.startsWith('https') ? 443 : 80)})`, `> ${method} ${(url.replace(/^\w+:\/\/[^/]+/, '') || '/')} HTTP/1.1`, '> User-Agent: curl/8.5.0', '> Accept: */*', '>', ...headers.trim().split('\n').map(l => '< ' + l), '<');
      if (flags.i || flags.include || head) out.push(headers);
      const o = U.first(flags.o || flags.output);
      if (o) { if (o !== '/dev/null') { const p = c.resolve(o); if (!c.shell.writable(p, c.pod || c.container ? {} : null)) return fail(`curl: (23) Failure writing output to destination`, 23); c.vfs.write(p, body); } body = ''; }
      if (body) out.push(body);
      const wo = U.first(flags.w || flags['write-out']);
      if (wo) out.push(String(wo).replace(/%\{http_code\}/g, r.status).replace(/\\n/g, '\n'));
      const code = (flags.f || flags.fail) && r.status >= 400 ? 22 : 0;
      if (code) return { out: `curl: (22) The requested URL returned error: ${r.status}`, code, err: true };
      return { out: out.join('\n').replace(/\n+$/, ''), code: 0 };
    },
    wget(a, c) {
      const { pos, flags } = U.args(a, ['O']);
      const url = pos[0];
      if (!url) return fail('wget: missing URL');
      const r = c.world.http(url, c.from);
      if (r.error) return fail(`wget: ${r.error.replace(/^curl: \(\d+\) /, '')}`, 4);
      if (r.status >= 400) return fail(`wget: server returned error: HTTP/1.1 ${r.status} ${statusLine(r.status)}`, 8);
      if (U.first(flags.O) === '-' || flags.q && U.first(flags.O) === '-') return ok(r.body);
      return ok(`Connecting to ${url}\nsaving to 'index.html'\nindex.html           100% |********************************|   ${r.body.length}  0:00:00 ETA\n'index.html' saved`);
    },
    ssh(a, c) {
      const { pos } = U.args(a, ['i', 'p', 'l', 'o']);
      if (!pos[0]) return fail('usage: ssh [-i identity_file] [user@]hostname');
      const target = pos[0].includes('@') ? pos[0].split('@')[1] : pos[0];
      const w = c.world;
      const h = Object.values(w.hosts).find(x => x.name === target || x.ip === target || x.publicIp === target);
      if (!h) {
        const ec2 = w.aws && w.aws.instances.find(i => i.publicIp === target || i.publicDns === target || i.privateIp === target);
        if (ec2) return fail(`ssh: connect to host ${target} port 22: Connection timed out\nℹ この訓練では EC2 へのログインは扱いません。AWS CLI で調査してください。`, 255);
        return fail(`ssh: Could not resolve hostname ${target}: Name or service not known`, 255);
      }
      if (!h.sshable || h === c.host) return fail(`ssh: connect to host ${target} port 22: Connection refused`, 255);
      if (c.pod || c.container) return fail('sh: ssh: not found', 127);
      c.shell.stack.push({ host: h.name, cwd: h.home, prev: h.home });
      return ok(`${h.motd || `Welcome to ${h.name}`}\nLast login: ${new Date(w.now() - 86400e3 * 2).toUTCString()} from 10.0.1.20`);
    },
    exit(a, c) {
      if (c.pod || c.container) return ok('');
      if (c.shell.stack.length > 1) { const h = c.shell.stack.pop(); return ok(`logout\nConnection to ${h.host} closed.`); }
      return ok('ℹ 踏み台（bastion）からはログアウトできません。');
    },
    logout(a, c) { return Builtins.exit(a, c); },
    systemctl(a, c) {
      const { pos } = U.args(a);
      const [act, unit] = pos;
      const name = (unit || '').replace(/\.service$/, '');
      const svcs = c.host.services;
      if (!act) return ok(Object.entries(svcs).map(([n, s]) => `${(n + '.service').padEnd(28)} loaded ${s === 'active' ? 'active   running' : 'inactive dead   '} ${n}`).join('\n'));
      if (!(name in svcs)) return fail(`Unit ${name}.service could not be found.`, 4);
      if (act === 'status') {
        const s = svcs[name];
        const desc = { kubelet: 'kubelet: The Kubernetes Node Agent', containerd: 'containerd container runtime', docker: 'Docker Application Container Engine', nginx: 'A high performance web server', crio: 'Container Runtime Interface for OCI (CRI-O)' }[name] || name;
        const extra = (c.host.journal[name] || []).slice(-3);
        return { out: `${s === 'active' ? '●' : s === 'failed' ? '×' : '○'} ${name}.service - ${desc}\n     Loaded: loaded (/lib/systemd/system/${name}.service; enabled; vendor preset: enabled)\n     Active: ${s === 'active' ? 'active (running) since Mon 2026-10-12 00:11:42 UTC; 1 week 5 days ago' : s === 'failed' ? 'failed (Result: exit-code) since Sat 2026-10-24 01:20:11 UTC; 4min ago' : 'inactive (dead) since Fri 2026-10-23 22:47:10 UTC; 3h ago'}\n   Main PID: ${s === 'active' ? 1000 + (U.hash(name) % 3000) + ' (' + name + ')' : '— (code=exited, status=0/SUCCESS)'}\n${extra.length ? '\n' + extra.join('\n') : ''}`, code: s === 'active' ? 0 : 3 };
      }
      if (act === 'is-active') return { out: svcs[name], code: svcs[name] === 'active' ? 0 : 3 };
      if (['restart', 'start', 'stop', 'reload', 'enable'].includes(act)) {
        if (!c.root) return fail(`Failed to ${act} ${name}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${name}.service' for details.\nℹ サービス操作には sudo が必要です。`);
        const err = act !== 'stop' && act !== 'enable' && c.host.checks[name] ? c.host.checks[name](c.host) : null;
        if (err) {
          svcs[name] = 'failed';
          c.host.journal[name] = (c.host.journal[name] || []).concat(err.map(l => `Oct 24 01:20:11 ${c.host.name} ${name}[2412]: ${l}`), [`Oct 24 01:20:11 ${c.host.name} systemd[1]: ${name}.service: Control process exited, code=exited, status=1/FAILURE`, `Oct 24 01:20:11 ${c.host.name} systemd[1]: Failed to start ${name}.service.`]);
          c.world.emit(`${c.host.name}: ${name} failed to ${act}`, 'WARN');
          return fail(`Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`);
        }
        svcs[name] = act === 'stop' ? 'inactive' : 'active';
        c.world.emit(`${c.host.name}: systemctl ${act} ${name}`);
        c.world.reconcile();
        return ok('');
      }
      return fail(`Unknown command verb ${act}.`);
    },
    journalctl(a, c) {
      const { flags } = U.args(a, ['u', 'n', 'since']);
      const unit = String(U.first(flags.u) || '').replace(/\.service$/, '');
      let l = unit ? (c.host.journal[unit] || []) : Object.values(c.host.journal).flat();
      if (unit && !(unit in c.host.services)) return ok('-- No entries --');
      if (unit === 'kubelet' && c.host.diskPct && c.host.diskPct() >= 85) l = l.concat([`Oct 24 01:10:02 ${c.host.name} kubelet[1290]: I1024 01:10:02.512 eviction_manager.go:366] "Eviction manager: attempting to reclaim" resourceName="ephemeral-storage"`, `Oct 24 01:10:02 ${c.host.name} kubelet[1290]: I1024 01:10:02.513 eviction_manager.go:377] "Eviction manager: must evict pod(s) to reclaim" resourceName="ephemeral-storage" usage="${c.host.diskPct()}%" threshold="85%"`]);
      const n = Number(U.first(flags.n) || 0);
      if (n) l = l.slice(-n);
      return ok(l.length ? l.join('\n') : '-- No entries --');
    },
    nginx(a, c) {
      if (!('nginx' in c.host.services)) return fail('bash: nginx: command not found', 127);
      if (a.includes('-v') || a.includes('-V')) return ok('nginx version: nginx/1.26.2');
      if (!a.includes('-t')) return fail('ℹ nginx は systemctl で操作します。設定テストは sudo nginx -t です。');
      if (!c.root) return fail('nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\nℹ sudo nginx -t で実行してください。');
      const err = c.host.checks.nginx && c.host.checks.nginx(c.host);
      if (err) return fail(err.join('\n') + '\nnginx: configuration file /etc/nginx/nginx.conf test failed');
      return ok('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful');
    },
    vi: editorCmd, vim: editorCmd, nano: editorCmd, view: editorCmd,
    less: (a, c) => Builtins.cat(a.filter(x => !x.startsWith('-')), c),
    more: (a, c) => Builtins.cat(a, c),
    help(a, c) {
      const f = c.world.features;
      const sec = [
        '使えるコマンド（シミュレータ）',
        '',
        'ファイル操作 : pwd ls cd cat less head tail tree find grep wc sort uniq cut awk sed mkdir touch cp mv rm truncate echo vi',
        'システム     : whoami hostname df du free ps ip ping nslookup curl ssh exit sudo systemctl journalctl env export history clear',
      ];
      if (f.has('k8s') || f.has('ocp') || f.has('aws')) sec.push('Kubernetes   : kubectl (k)  例) kubectl get pods -A / kubectl describe pod <name> / kubectl logs <pod>');
      if (f.has('ocp')) sec.push('OpenShift    : oc  例) oc login / oc new-project / oc new-app / oc expose svc/<name> / oc get routes');
      if (f.has('docker')) sec.push('Docker       : docker  例) docker ps -a / docker run -d --name web -p 8080:80 nginx:1.27 / docker compose up -d');
      if (f.has('harbor')) sec.push('Harbor       : harbor  例) harbor project list / harbor artifact list <project>/<repo>');
      if (f.has('aws')) sec.push('AWS          : aws  例) aws sts get-caller-identity / aws ec2 describe-instances');
      sec.push('', 'Tab: 補完 · ↑/↓: 履歴 · Ctrl+L: 画面クリア · <cmd> --help でヘルプ', '迷ったら左のミッション欄の「ヒント」を押してください。');
      return ok(sec.join('\n'));
    },
  };
  function headTail(a, c, cmd) {
    let n = 10;
    const files = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-n') { n = Number(a[++i]); continue; }
      if (/^-n\d+$/.test(a[i])) { n = Number(a[i].slice(2)); continue; }
      if (/^-\d+$/.test(a[i])) { n = Number(a[i].slice(1)); continue; }
      if (a[i] === '-f') continue;
      files.push(a[i]);
    }
    const r = readInputs(files, c, cmd);
    if (r.error) return fail(r.error.replace(`${cmd}: `, `${cmd}: cannot open '`).replace(': No such', "' for reading: No such"));
    const l = lines(r.texts.join(''));
    return ok((cmd === 'head' ? l.slice(0, n) : l.slice(Math.max(0, l.length - n))).join('\n'));
  }
  function editorCmd(a, c) {
    const f = a.find(x => !x.startsWith('-') && !x.startsWith('+'));
    if (c.pod || c.container) return fail('sh: vi: not found', 127);
    if (!f) return fail('ℹ 編集するファイル名を指定してください（例: vi deployment.yaml）');
    const p = c.resolve(f);
    if (c.vfs.isDir(p)) return fail(`"${f}" is a directory`);
    if (!c.vfs.isDir(VFS.parent(p))) return fail(`"${f}" [New DIRECTORY] — 親ディレクトリが存在しません`);
    return { out: '', code: 0, editor: { path: p, host: c.host.name, readonly: !c.shell.writable(p) } };
  }

  IG.Shell = Shell;
  IG.builtins = Builtins;
})(globalThis.IG = globalThis.IG || {});
