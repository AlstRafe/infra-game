/* Harbor registry simulation: projects, artifacts, vulnerability scanning, robot accounts,
 * pull policy, plus a simplified `harbor` CLI. CVE ids are fictional (CVE-SIM-*). */
(function (IG) {
  'use strict';
  const U = IG.util;
  IG.commands = IG.commands || {};
  const ok = out => ({ out, code: 0 });
  const fail = (out, code = 1) => ({ out, code, err: true });
  const SEV = ['critical', 'high', 'medium', 'low'];
  const PKGS = {
    critical: ['openssl 1.1.1n', 'libexpat1 2.2.10', 'zlib1g 1.2.11', 'python3.8 3.8.13', 'libdb5.3 5.3.28'],
    high: ['libssl1.1 1.1.1n', 'curl 7.74.0', 'libxml2 2.9.10', 'perl-base 5.32.1', 'libsqlite3-0 3.34.1', 'git 2.30.2', 'setuptools 56.0.0'],
    medium: ['libc6 2.31', 'tar 1.34', 'ncurses-base 6.2', 'pip 23.0.1', 'libgnutls30 3.7.1'],
    low: ['coreutils 8.32', 'login 4.8.1', 'libtasn1-6 4.16.0', 'apt 2.2.4', 'bsdutils 2.36.1'],
  };

  class Harbor {
    constructor(world, o = {}) {
      this.world = world;
      this.host = o.host || 'harbor.lab.local';
      this.users = o.users || { admin: { password: 'Harbor12345', admin: true } };
      this.robots = {};
      this.projects = {};
      this.session = null;
      this.createProject('library', { public: true });
    }
    get enabled() { return this.world.features.has('harbor'); }
    auth(u, p) {
      if (this.users[u] && this.users[u].password === p) return { name: u, admin: !!this.users[u].admin, user: true };
      const r = this.robots[u];
      if (r && r.secret === p) return { name: u, robot: true, project: r.project, perms: r.perms };
      return null;
    }
    can(identity, project, action) {
      if (!identity) return false;
      if (identity.user) return identity.admin || (this.projects[project] && (this.projects[project].members || []).includes(identity.name)) || action === 'pull' && this.projects[project] && this.projects[project].public;
      if (identity.robot) return identity.project === project && identity.perms.includes(action);
      return false;
    }
    createProject(name, o = {}) {
      this.projects[name] = { name, public: !!o.public, preventVul: o.preventVul || null, autoScan: o.autoScan !== false, repos: {}, members: o.members || [], created: this.world.stamp() };
      return this.projects[name];
    }
    addArtifact(project, repo, tag, meta, o = {}) {
      const p = this.projects[project] || this.createProject(project);
      const r = (p.repos[repo] = p.repos[repo] || {});
      const ref = `${this.host}/${project}/${repo}:${tag}`;
      r[tag] = { tag, digest: IG.images.digest(ref + (meta.buildSeed || '')), meta: U.clone(meta), pushed: o.pushed || this.world.stamp(), scan: o.scan === false ? null : this.scanOf(meta), size: meta.size || '84MB', pulls: o.pulls || 0 };
      return r[tag];
    }
    scanOf(meta) { return Object.assign({ critical: 0, high: 0, medium: 0, low: 0 }, meta.vulns || {}); }
    split(parsed) {
      const i = parsed.name.indexOf('/');
      return i < 0 ? { project: 'library', repo: parsed.name } : { project: parsed.name.slice(0, i), repo: parsed.name.slice(i + 1) };
    }
    push(parsed, creds, meta) {
      const { project, repo } = this.split(parsed);
      const id = creds ? this.auth(creds.username, creds.password) : null;
      if (!id) return { ok: false, error: IG.t(`unauthorized: unauthorized to access repository: {0}/{1}, action: push: unauthorized to access repository: {2}/{3}, action: push\n\nℹ 先に docker login {4} を実行してください。`, { 0: project, 1: repo, 2: project, 3: repo, 4: this.host }) };
      if (!this.projects[project]) return { ok: false, error: IG.t(`unknown: project {0} not found: project {1} not found\n\nℹ Harbor ではプロジェクトを先に作成する必要があります（harbor project create {2}）。`, { 0: project, 1: project, 2: project }) };
      if (!this.can(id, project, 'push')) return { ok: false, error: `unauthorized: unauthorized to access repository: ${project}/${repo}, action: push` };
      const a = this.addArtifact(project, repo, parsed.tag, meta, { pushed: this.world.now(), scan: this.projects[project].autoScan ? undefined : false });
      return { ok: true, digest: a.digest, mounted: !!meta.base };
    }
    pull(parsed, creds) {
      const { project, repo } = this.split(parsed);
      const ref = `${this.host}/${parsed.name}:${parsed.tag}`;
      const base = `rpc error: code = Unknown desc = failed to pull and unpack image "${ref}": failed to resolve reference "${ref}": `;
      const p = this.projects[project];
      const id = creds ? this.auth(creds.username, creds.password) : null;
      if (!p) return { ok: false, reason: 'notfound', error: base + `${ref}: not found` };
      if (!p.public && !this.can(id, project, 'pull')) return { ok: false, reason: 'unauthorized', error: base + `pulling from host ${this.host} failed with status code [manifests ${parsed.tag}]: 401 Unauthorized` };
      const art = p.repos[repo] && p.repos[repo][parsed.tag];
      if (!art) return { ok: false, reason: 'notfound', error: base + `${ref}: not found` };
      if (p.preventVul && art.scan) {
        const idx = SEV.indexOf(p.preventVul);
        const blocked = SEV.slice(0, idx + 1).reduce((n, s) => n + (art.scan[s] || 0), 0);
        if (blocked > 0) {
          return { ok: false, reason: 'policy', error: base + `unexpected status from HEAD request to https://${this.host}/v2/${parsed.name}/manifests/${parsed.tag}: 412 Precondition Failed: current image with "${blocked} vulnerabilities" cannot be pulled due to configured policy in 'Prevent images with vulnerability severity of "${cap(p.preventVul)}" or higher from running.' To continue with pull, please contact your project administrator to exempt matched vulnerabilities through configuring the CVE allowlist.` };
        }
      }
      art.pulls++;
      return { ok: true, meta: art.meta };
    }
    vulnRows(art) {
      const rows = [];
      for (const s of SEV) {
        const n = art.scan[s] || 0;
        for (let i = 0; i < Math.min(n, s === 'critical' || s === 'high' ? n : 3); i++) {
          const pk = PKGS[s][(U.hash(art.digest + s + i) >>> 0) % PKGS[s].length];
          const [pkg, ver] = pk.split(' ');
          rows.push([`CVE-SIM-${2021 + (i % 4)}-${String(1000 + (U.hash(art.digest + s + i) % 8999)).padStart(4, '0')}`, cap(s), pkg, ver, s === 'low' ? '' : bump(ver)]);
        }
        if (n > 3 && (s === 'medium' || s === 'low')) rows.push(['…', cap(s), IG.t(`(他 {0} 件)`, { 0: n - 3 }), '', '']);
      }
      return rows;
    }
    http(req) {
      if (req.host !== this.host) return null;
      if (req.path.startsWith('/api/v2.0/health')) return { status: 200, body: JSON.stringify({ status: 'healthy', components: [{ name: 'core', status: 'healthy' }, { name: 'registry', status: 'healthy' }, { name: 'trivy', status: 'healthy' }] }, null, 2), target: { kind: 'harbor' } };
      if (req.path.startsWith('/api/v2.0/projects')) return { status: 200, body: JSON.stringify(Object.values(this.projects).filter(p => p.public).map(p => ({ name: p.name, metadata: { public: String(p.public) }, repo_count: Object.keys(p.repos).length })), null, 2), target: { kind: 'harbor' } };
      if (req.path === '/' || req.path.startsWith('/harbor')) return { status: 200, body: '<!doctype html>\n<html>\n<head><title>Harbor</title></head>\n<body><harbor-app></harbor-app></body>\n</html>', target: { kind: 'harbor' } };
      return { status: 404, body: '{"errors":[{"code":"NOT_FOUND","message":"not found"}]}', target: { kind: 'harbor' } };
    }
  }
  function cap(s) { return s[0].toUpperCase() + s.slice(1); }
  function bump(v) { const p = v.split('.'); p[p.length - 1] = String((parseInt(p[p.length - 1], 10) || 0) + 2); return p.join('.'); }

  /* ------------------------------------------------------------ CLI */
  const VF = ['u', 'username', 'p', 'password', 'project', 'permissions', 'prevent-vul', 'severity', 'duration', 'description'];
  function harbor(argv, ctx) {
    const w = ctx.world, H = w.harbor;
    if (!H || !H.enabled) return fail('bash: harbor: command not found');
    if (ctx.pod) return fail('OCI runtime exec failed: exec: "harbor": executable file not found in $PATH: unknown', 126);
    const a = U.args(argv, VF);
    const [group, action, target] = a.pos;
    const identity = () => {
      if (H.session) return H.auth(H.session.username, H.session.password);
      const d = w.docker && w.docker.logins[H.host];
      return d ? H.auth(d.username, d.password) : null;
    };
    const needLogin = () => fail(IG.t(`Error: unauthorized: authentication required\n\nℹ harbor login {0} -u <user> -p <password> でログインしてください（docker login 済みならその認証情報も使われます）。`, { 0: H.host }));
    if (!group || group === 'help' || a.flags.help) {
      return ok(`harbor - Harbor registry CLI (simulated subset)\n\nUsage:\n  harbor login <host> -u <user> -p <password>\n  harbor project list | create <name> [--public] [--prevent-vul critical|high] | view <name>\n  harbor repo list <project>\n  harbor artifact list <project>/<repo>\n  harbor artifact scan <project>/<repo>:<tag>\n  harbor artifact vulnerabilities <project>/<repo>:<tag>\n  harbor robot create <name> --project <project> [--permissions pull,push] | list`);
    }
    if (group === 'login') {
      const host = action;
      const u = U.first(a.flags.u || a.flags.username), p = U.first(a.flags.p || a.flags.password);
      if (host && host.replace(/^https?:\/\//, '') !== H.host) return fail(`Error: Get "https://${host}/api/v2.0/users/current": dial tcp: lookup ${host}: no such host`);
      if (!u || !p) return fail(IG.t('ℹ harbor login <host> -u <user> -p <password> の形式で指定してください。'));
      if (!H.auth(u, p)) return fail('Error: login failed: 401 Unauthorized (invalid username or password)');
      H.session = { username: u, password: p };
      return ok(`Login successful for ${u} at https://${H.host}`);
    }
    if (group === 'logout') { H.session = null; return ok('Logged out.'); }
    const id = identity();
    if (!id) return needLogin();
    const parseRef = s => {
      const m = String(s || '').replace(new RegExp('^' + H.host.replace(/\./g, '\\.') + '/'), '').match(/^([^/]+)\/([^:@]+)(?::(.+))?$/);
      return m ? { project: m[1], repo: m[2], tag: m[3] } : null;
    };
    switch (group) {
      case 'project': case 'projects':
        if (!action || action === 'list' || action === 'ls') {
          const ps = Object.values(H.projects).filter(p => p.public || id.admin || (p.members || []).includes(id.name) || id.project === p.name);
          return ok(U.table(['NAME', 'ACCESS', 'REPOSITORIES', 'PREVENT VULNERABLE', 'AUTO SCAN', 'CREATED'], ps.map(p => [p.name, p.public ? 'public' : 'private', String(Object.keys(p.repos).length), p.preventVul ? `>= ${p.preventVul}` : 'off', p.autoScan ? 'on' : 'off', new Date(p.created).toISOString().slice(0, 10)])));
        }
        if (action === 'create') {
          if (!target) return fail('Error: project name is required');
          if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(target)) return fail(`Error: invalid project name "${target}" (lowercase letters, digits, . _ - only)`);
          if (!id.user) return fail('Error: forbidden: robot accounts cannot create projects');
          if (H.projects[target]) return fail(`Error: conflict: the project named ${target} already exists`);
          const pv = U.first(a.flags['prevent-vul'] || a.flags.severity);
          H.createProject(target, { public: !!a.flags.public, preventVul: pv && pv !== true ? String(pv).toLowerCase() : null, members: [id.name] });
          w.emit(`Harbor project "${target}" created (${a.flags.public ? 'public' : 'private'})`);
          return ok(`Project ${target} created successfully (access: ${a.flags.public ? 'public' : 'private'}, auto scan: on)`);
        }
        if (action === 'view' || action === 'get') {
          const p = H.projects[target];
          if (!p) return fail(`Error: project ${target} not found`);
          return ok([`Name:                 ${p.name}`, `Access level:         ${p.public ? 'public' : 'private'}`, `Repositories:         ${Object.keys(p.repos).length}`, `Auto scan on push:    ${p.autoScan ? 'enabled' : 'disabled'}`, `Prevent vulnerable:   ${p.preventVul ? `enabled (severity >= ${p.preventVul})` : 'disabled'}`, `Robot accounts:       ${Object.values(H.robots).filter(r => r.project === p.name).map(r => r.name).join(', ') || '<none>'}`].join('\n'));
        }
        return fail(`Error: unknown command "${action}" for "harbor project"`);
      case 'repo': case 'repository': {
        const pname = target || action === 'list' && a.pos[2];
        if (!pname) return fail('Error: project name is required: harbor repo list <project>');
        const p = H.projects[pname];
        if (!p || (!p.public && !H.can(id, pname, 'pull'))) return fail(`Error: project ${pname} not found`);
        const rows = Object.entries(p.repos).map(([r, tags]) => [`${pname}/${r}`, String(Object.keys(tags).length), String(Object.values(tags).reduce((n, t) => n + t.pulls, 0)), new Date(Math.max(...Object.values(tags).map(t => t.pushed))).toISOString().replace('T', ' ').slice(0, 16)]);
        return ok(rows.length ? U.table(['NAME', 'ARTIFACTS', 'PULLS', 'LAST MODIFIED'], rows) : `No repositories in project ${pname}.`);
      }
      case 'artifact': case 'artifacts': {
        const ref = parseRef(target);
        if (!ref) return fail(`Error: invalid reference "${target || ''}". expected <project>/<repo>[:<tag>]`);
        const p = H.projects[ref.project];
        if (!p || (!p.public && !H.can(id, ref.project, 'pull'))) return fail(`Error: project ${ref.project} not found`);
        const tags = p.repos[ref.repo];
        if (!tags) return fail(`Error: repository ${ref.project}/${ref.repo} not found`);
        const sevText = s => (s ? (s.critical ? `Critical ${s.critical}` : s.high ? `High ${s.high}` : s.medium ? `Medium ${s.medium}` : 'No vulnerability') + ` (C:${s.critical} H:${s.high} M:${s.medium} L:${s.low})` : 'Not scanned');
        if (action === 'list' || action === 'ls') {
          return ok(U.table(['TAG', 'DIGEST', 'SIZE', 'VULNERABILITIES', 'PUSHED'], Object.values(tags).sort((x, y) => y.pushed - x.pushed).map(t => [t.tag, t.digest.slice(0, 19) + '…', t.size, sevText(t.scan), new Date(t.pushed).toISOString().replace('T', ' ').slice(0, 16)])));
        }
        const art = ref.tag && tags[ref.tag];
        if (!art) return fail(`Error: artifact ${ref.project}/${ref.repo}:${ref.tag || '<tag>'} not found`);
        if (action === 'scan') {
          art.scan = H.scanOf(art.meta);
          w.emit(`Harbor scan ${ref.project}/${ref.repo}:${ref.tag} → C${art.scan.critical}/H${art.scan.high}`, art.scan.critical ? 'WARN' : 'INFO');
          return ok(`Scan requested for ${ref.project}/${ref.repo}:${ref.tag}\nScanner: Trivy (simulated)\nResult:  ${sevText(art.scan)}`);
        }
        if (action === 'vulnerabilities' || action === 'vuln' || action === 'vulns') {
          if (!art.scan) return ok('Not scanned yet. Run: harbor artifact scan ' + target);
          const rows = H.vulnRows(art);
          if (!rows.length) return ok(`${ref.project}/${ref.repo}:${ref.tag}: No vulnerability found 🎉`);
          return ok(`${ref.project}/${ref.repo}:${ref.tag}  base: ${art.meta.base || 'unknown'}\n` + U.table(['VULNERABILITY', 'SEVERITY', 'PACKAGE', 'CURRENT VERSION', 'FIXED IN'], rows) + `\n\nSummary: Critical ${art.scan.critical}, High ${art.scan.high}, Medium ${art.scan.medium}, Low ${art.scan.low}`);
        }
        if (action === 'delete') { delete tags[ref.tag]; return ok(`Artifact ${ref.project}/${ref.repo}:${ref.tag} deleted`); }
        return fail(`Error: unknown command "${action}" for "harbor artifact" (list, scan, vulnerabilities, delete)`);
      }
      case 'robot': {
        if (action === 'list' || action === 'ls') return ok(U.table(['NAME', 'PROJECT', 'PERMISSIONS', 'EXPIRES'], Object.values(H.robots).map(r => [r.name, r.project, r.perms.join(','), 'never'])));
        if (action === 'create') {
          const project = U.first(a.flags.project);
          if (!target || !project) return fail('Error: usage: harbor robot create <name> --project <project> [--permissions pull,push]');
          if (!H.projects[project]) return fail(`Error: project ${project} not found`);
          if (!id.user || !(id.admin || (H.projects[project].members || []).includes(id.name))) return fail(`Error: forbidden: ${id.name} is not a project admin of ${project}`);
          const perms = String(U.first(a.flags.permissions) || 'pull').split(',').map(s => s.trim());
          const name = `robot$${project}+${target}`;
          const secret = H.robotSecret(project, target);
          H.robots[name] = { name, project, perms, secret };
          w.emit(`Harbor robot ${name} created (${perms.join(',')})`);
          return ok(IG.t(`Robot account created.\n  Name:    {0}\n  Secret:  {1}\n  Scope:   project/{2} ({3})\n\n⚠ Secret はこの一度しか表示されません。必要ならコピーして安全に保管してください。`, { 0: name, 1: secret, 2: project, 3: perms.join(', ') }));
        }
        return fail(`Error: unknown command "${action}" for "harbor robot" (create, list)`);
      }
      default:
        return fail(`Error: unknown command "${group}" for "harbor"\nRun 'harbor help' for usage.`);
    }
  }
  Harbor.prototype.robotSecret = function (project, name) { return 'h' + U.hex('robot-secret:' + project + ':' + name, 31); };

  IG.Harbor = Harbor;
  IG.commands.harbor = harbor;
})(globalThis.IG = globalThis.IG || {});
