/* World: one mission's simulated infrastructure (hosts, clusters, Docker, Harbor, AWS) plus
 * the network resolver used by curl. Missions build a World in their setup() function. */
(function (IG) {
  'use strict';
  const U = IG.util;

  class Host {
    constructor(name, spec = {}) {
      this.name = name;
      this.user = spec.user || 'operator';
      this.home = spec.home || (this.user === 'root' ? '/root' : '/home/' + this.user);
      this.ip = spec.ip || '10.0.1.20';
      this.publicIp = spec.publicIp || null;
      this.vfs = new IG.VFS({ dirs: ['/tmp', '/etc', '/var/log', this.home].concat(spec.dirs || []), files: spec.files || {} });
      this.services = Object.assign({}, spec.services || {});
      this.diskGiB = spec.diskGiB || 50;
      this.baseUsedGiB = spec.baseUsedGiB || 12;
      this.motd = spec.motd || '';
      this.journal = spec.journal || {};
      this.sshable = spec.sshable !== false;
      this.checks = spec.checks || {}; // service -> (host) => error lines | null (validated on start/restart)
      this.web = spec.web || null;     // { port, service, server, body } simple HTTP server on this host
    }
    diskUsedBytes() { return this.baseUsedGiB * 1024 ** 3 + this.vfs.size('/'); }
    diskPct() { return Math.round((this.diskUsedBytes() / (this.diskGiB * 1024 ** 3)) * 100); }
  }

  class World {
    constructor() {
      this.catalog = IG.images.baseCatalog();
      this.features = new Set();
      this.hosts = {};
      this.clusters = {};
      this.kube = { current: null, contexts: {} };
      this.events = [];
      this.httpLog = [];
      this.traffic = [];
      this.bootstrap = false;
      this.bootAge = 3 * 86400e3;
      this.flags = {};
      this.listeners = [];
      this.docker = IG.Docker ? new IG.Docker(this) : null;
      this.harbor = null;
      this.aws = null;
      this.addHost('bastion', { publicIp: '198.51.100.20' });
    }
    now() { return IG.clock.now(); }
    stamp() { return this.bootstrap ? this.now() - this.bootAge : this.now(); }
    addHost(name, spec) { this.hosts[name] = new Host(name, spec); return this.hosts[name]; }
    get bastion() { return this.hosts.bastion; }

    emit(msg, level = 'INFO') {
      if (this.bootstrap) return;
      const e = { at: this.now(), level, msg };
      this.events.push(e);
      if (this.events.length > 200) this.events.shift();
      this.listeners.forEach(fn => fn(e));
    }

    addImage(ref, meta) {
      const p = IG.images.parse(ref);
      const key = p.host ? p.full : p.short;
      this.catalog[key] = Object.assign({ ref: key, vulns: { critical: 0, high: 0, medium: 0, low: 0 }, size: '84MB' }, meta);
      return this.catalog[key];
    }
    lookupImage(ref) {
      const p = IG.images.parse(ref);
      const key = p.host ? p.full : p.short;
      const meta = this.catalog[key] || this.catalog[IG.images.aliases[key]];
      return meta ? { meta, key: this.catalog[key] ? key : IG.images.aliases[key], parsed: p } : { meta: null, key, parsed: p };
    }
    // Resolve an image for a pull. auths: { host: {username, password} }
    pullImage(ref, auths = {}) {
      const p = IG.images.parse(ref);
      if (this.harbor && p.host === this.harbor.host) return this.harbor.pull(p, auths[p.host]);
      const { meta } = this.lookupImage(ref);
      if (!meta) {
        const repo = (p.host ? p.host + '/' : 'docker.io/library/') + p.name;
        if (p.host && !/\.lab\.local$|amazonaws\.com$|quay\.io$|docker\.io$/.test(p.host)) {
          return { ok: false, reason: 'notfound', error: `failed to resolve reference "${p.full}": failed to do request: Head "https://${p.host}/v2/${p.name}/manifests/${p.tag}": dial tcp: lookup ${p.host}: no such host` };
        }
        return { ok: false, reason: 'notfound', error: `rpc error: code = NotFound desc = failed to pull and unpack image "${p.host ? p.full : 'docker.io/library/' + p.short}": failed to resolve reference "${repo}:${p.tag}": ${repo}:${p.tag}: not found` };
      }
      return { ok: true, meta };
    }

    addCluster(cluster) { this.clusters[cluster.name] = cluster; return cluster; }
    context() { return this.kube.current ? this.kube.contexts[this.kube.current] : null; }
    currentCluster() { const c = this.context(); return c ? this.clusters[c.cluster] : null; }
    addContext(name, cluster, namespace = 'default', user = 'admin', makeCurrent = true) {
      this.kube.contexts[name] = { cluster, namespace, user };
      if (makeCurrent) this.kube.current = name;
    }

    reconcile() {
      for (const c of Object.values(this.clusters)) c.reconcile();
    }

    /* ------------------------------------------------------------- network */
    // from: {kind:'host', host} | {kind:'pod', cluster, ns, pod} | {kind:'container', container}
    http(url, from = { kind: 'host', host: 'bastion' }, opt = {}) {
      const m = String(url).match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([/?][^#]*)?$/i);
      if (!m) return { error: `curl: (3) URL rejected: Malformed input to a URL function` };
      const scheme = (m[1] || 'http').toLowerCase();
      const host = m[2].toLowerCase();
      const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
      const path = m[4] || '/';
      const req = { scheme, host, port, path, method: opt.method || 'GET' };
      let res = this.route(req, from);
      if (!res) res = { error: `curl: (6) Could not resolve host: ${host}` };
      const rec = { url: `${scheme}://${host}${m[3] ? ':' + port : ''}${path}`, host, port, path, status: res.status || 0, ok: !!res.status && res.status < 400,
        from: from.kind, ns: from.ns, cluster: from.cluster, at: this.now(), target: res.target || null };
      this.httpLog.push(rec);
      this.traffic.push({ at: this.now(), ok: rec.ok, target: res.target || null, from: from.kind });
      if (this.traffic.length > 40) this.traffic.shift();
      this.emit(`${rec.ok ? 'HTTP' : 'NET'} ${req.method} ${rec.url} → ${res.status || 'error'}`, rec.ok ? 'INFO' : 'WARN');
      return res;
    }
    route(req, from) {
      const { host } = req;
      if (from.kind === 'pod') {
        const c = this.clusters[from.cluster];
        if (host === 'localhost' || host === '127.0.0.1') return c.podSelfHttp(from.pod, req);
        const r = c.inClusterHttp(req, from.ns);
        if (r) return r;
      }
      if (from.kind === 'container' && this.docker) {
        const r = this.docker.containerNetHttp(req, from.container);
        if (r) return r;
      }
      for (const c of Object.values(this.clusters)) {
        const r = c.externalHttp(req);
        if (r) return r;
      }
      if (from.kind === 'host' && from.host === 'bastion' && this.docker && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) return this.docker.hostHttp(req);
      if (this.aws) { const r = this.aws.http(req, from); if (r) return r; }
      if (this.harbor) { const r = this.harbor.http(req); if (r) return r; }
      const h = Object.values(this.hosts).find(x => x.web && (x.name === host || x.ip === host));
      if (h) {
        if (h.services[h.web.service] === 'active' && req.port === h.web.port) return Object.assign({ target: { kind: 'host', name: h.name } }, IG.runtime.respond({ kind: 'web', server: h.web.server, body: h.web.body }, req.path));
        return { error: `curl: (7) Failed to connect to ${host} port ${req.port} after 1 ms: Couldn't connect to server`, target: { kind: 'host', name: h.name } };
      }
      return null;
    }
    resolveName(name, from) {
      if (from && from.kind === 'pod') {
        const svc = this.clusters[from.cluster].dnsLookup(name, from.ns);
        if (svc) return svc.spec.clusterIP;
      }
      for (const c of Object.values(this.clusters)) { const ip = c.externalDns(name); if (ip) return ip; }
      if (this.harbor && name === this.harbor.host) return '10.0.2.30';
      if (this.aws) { const ip = this.aws.dns(name); if (ip) return ip; }
      if (name === 'localhost') return '127.0.0.1';
      const h = Object.values(this.hosts).find(x => x.name === name);
      if (h) return h.ip;
      return null;
    }
  }

  IG.Host = Host;
  IG.World = World;
})(globalThis.IG = globalThis.IG || {});
