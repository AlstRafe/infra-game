/* kubectl and oc command-line simulation on top of IG.k8s.Cluster. */
(function (IG) {
  'use strict';
  const U = IG.util;
  const Y = IG.yaml;
  const { KINDS } = IG.k8s;
  IG.commands = IG.commands || {};

  const ok = out => ({ out, code: 0 });
  const fail = (out, code = 1) => ({ out, code, err: true });

  const VF = ['n', 'namespace', 'o', 'output', 'l', 'selector', 'f', 'filename', 'c', 'container', 'context', 'replicas', 'image', 'port',
    'target-port', 'type', 'name', 'from-literal', 'from-file', 'from-env-file', 'docker-server', 'docker-username', 'docker-password', 'docker-email',
    'to-revision', 'revision', 'tail', 'p', 'patch', 'hostname', 'protocol', 'dry-run', 'env', 'field-selector', 's', 'server', 'u', 'username',
    'password', 'token', 'sort-by', 'timeout', 'restart', 'service', 'path', 'insecure-policy', 'for', 'tcp', 'labels', 'grace-period', 'z',
    'serviceaccount', 'display-name', 'description', 'cert', 'key', 'ca-cert', 'cluster', 'user', 'overrides', 'subresource', 'as'];

  const TYPE_ALIASES = {
    pods: ['po', 'pod', 'pods'], deployments: ['deploy', 'deployment', 'deployments', 'deployment.apps', 'deployments.apps'],
    replicasets: ['rs', 'replicaset', 'replicasets'], services: ['svc', 'service', 'services'], endpoints: ['ep', 'endpoint', 'endpoints'],
    configmaps: ['cm', 'configmap', 'configmaps'], secrets: ['secret', 'secrets'], namespaces: ['ns', 'namespace', 'namespaces'],
    projects: ['project', 'projects'], nodes: ['no', 'node', 'nodes'], events: ['ev', 'event', 'events'],
    routes: ['route', 'routes', 'route.route.openshift.io'], ingresses: ['ing', 'ingress', 'ingresses'],
    persistentvolumeclaims: ['pvc', 'persistentvolumeclaim', 'persistentvolumeclaims'], serviceaccounts: ['sa', 'serviceaccount', 'serviceaccounts'],
    all: ['all'],
  };
  const TYPE_OF = {};
  for (const [t, al] of Object.entries(TYPE_ALIASES)) for (const a of al) TYPE_OF[a] = t;
  const KIND_OF = { pods: 'Pod', deployments: 'Deployment', services: 'Service', configmaps: 'ConfigMap', secrets: 'Secret', namespaces: 'Namespace', projects: 'Namespace', routes: 'Route' };
  const SINGULAR = { pods: 'pod', deployments: 'deployment.apps', services: 'service', configmaps: 'configmap', secrets: 'secret', namespaces: 'namespace', projects: 'project.project.openshift.io', routes: 'route.route.openshift.io', nodes: 'node', replicasets: 'replicaset.apps', endpoints: 'endpoints', events: 'event' };

  /* ------------------------------------------------------------ helpers */
  function ageOf(ts, w) { return U.age(w.now() - (typeof ts === 'number' ? ts : Date.parse(ts))); }
  function parseTargets(words) {
    const out = [];
    if (!words.length) return out;
    if (words[0].includes('/')) {
      for (const w of words) { const [t, n] = w.split('/'); const type = TYPE_OF[t.toLowerCase()]; out.push({ raw: t, type, names: n ? [n] : [] }); }
      return out;
    }
    const types = words[0].split(',');
    for (const t of types) out.push({ raw: t, type: TYPE_OF[t.toLowerCase()], names: words.slice(1) });
    return out;
  }
  function selectorMatch(sel, labels) {
    if (!sel) return true;
    return String(sel).split(',').every(term => {
      const m = term.match(/^([^!=]+)(!=|==|=)(.*)$/);
      if (!m) return labels && term in labels;
      const v = labels && labels[m[1].trim()];
      return m[2] === '!=' ? v !== m[3].trim() : v === m[3].trim();
    });
  }
  function jsonpath(obj, expr) {
    const inner = String(expr).replace(/^'|'$/g, '').replace(/^\{|\}$/g, '');
    const parts = inner.replace(/^\./, '').match(/[^.[\]]+|\[[^\]]*\]/g) || [];
    let cur = [obj];
    for (const p of parts) {
      const next = [];
      for (const c of cur) {
        if (c == null) continue;
        if (p === '[*]') { if (Array.isArray(c)) next.push(...c); }
        else if (/^\[\d+\]$/.test(p)) next.push(c[Number(p.slice(1, -1))]);
        else if (/^\['.*'\]$/.test(p)) next.push(c[p.slice(2, -2)]);
        else next.push(c[p.replace(/\\\./g, '.')]);
      }
      cur = next;
    }
    return cur.filter(v => v !== undefined).map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' ');
  }
  function readManifests(ctx, file) {
    const res = [];
    if (file === '-') return [{ file: '-', text: ctx.stdin || '' }];
    const path = ctx.resolve(file);
    if (ctx.vfs.isDir(path)) {
      for (const c of ctx.vfs.children(path)) if (!c.dir && /\.(ya?ml|json)$/.test(c.name)) res.push({ file: c.path.replace(ctx.host.home, '~'), text: ctx.vfs.read(c.path) });
      if (!res.length) throw new Error(`error: no objects passed to apply`);
      return res;
    }
    if (!ctx.vfs.isFile(path)) throw new Error(`error: the path "${file}" does not exist`);
    return [{ file, text: ctx.vfs.read(path) }];
  }
  function parseDocs(text, file) {
    if (/^\s*[{[]/.test(text)) { try { const j = JSON.parse(text); return j.kind === 'List' ? j.items : [j]; } catch (e) { throw new Error(`error: error parsing ${file}: ${e.message}`); } }
    try {
      const docs = Y.parseAll(text).filter(d => d !== null);
      return docs.flatMap(d => (d && d.kind === 'List' ? d.items || [] : [d]));
    } catch (e) {
      throw new Error(`error: error parsing ${file}: error converting YAML to JSON: ${e.message}`);
    }
  }

  /* ------------------------------------------------------------ authorization (OpenShift developer) */
  function canAccess(cl, user, resource, ns) {
    const u = cl.users[user] || {};
    if (u.admin || !cl.openshift) return null;
    if (resource === 'nodes') return `Error from server (Forbidden): nodes is forbidden: User "${user}" cannot list resource "nodes" in API group "" at the cluster scope`;
    if (ns && !(cl.projectsOf[user] && cl.projectsOf[user].has(ns))) return `Error from server (Forbidden): ${resource} is forbidden: User "${user}" cannot list resource "${resource}" in API group "${resource === 'deployments' ? 'apps' : resource === 'routes' ? 'route.openshift.io' : ''}" in the namespace "${ns}"`;
    return null;
  }

  /* ------------------------------------------------------------ manifests for -o yaml */
  function podManifest(cl, p) {
    const st = cl.podStatus(p);
    const v = st.verdict;
    return {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: p.name, namespace: p.ns, labels: p.labels, creationTimestamp: new Date(p.createdAt).toISOString(),
        ownerReferences: p.owner ? [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: `${p.owner}-${p.hash}`, controller: true }] : undefined },
      spec: Object.assign({}, p.spec, { nodeName: p.node || undefined }),
      status: {
        phase: st.phase, podIP: p.ip || undefined, hostIP: p.node ? (cl.nodes.find(n => n.name === p.node) || {}).ip : undefined,
        conditions: p.node ? undefined : [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: p.schedMsg }],
        containerStatuses: v ? v.containers.map(c => ({
          name: c.name, image: c.image, ready: !!c.ready, restartCount: c.state === 'crash' ? st.restarts : 0,
          state: c.state === 'running' ? { running: { startedAt: new Date(p.createdAt + 2000).toISOString() } } : { waiting: { reason: st.display, message: c.message } },
        })) : undefined,
      },
    };
  }
  function deployStatus(cl, d) {
    const pods = cl.deployPods(d.metadata.namespace, d.metadata.name);
    const hash = cl.templateHash(d.spec.template);
    const ready = pods.filter(p => cl.podStatus(p).ready).length;
    const updated = pods.filter(p => p.hash === hash).length;
    return { replicas: pods.length, updatedReplicas: updated, readyReplicas: ready, availableReplicas: ready, observedGeneration: d.metadata.generation, desired: d.spec.replicas ?? 1 };
  }
  function objManifest(cl, kind, o) {
    if (kind === 'Pod') return podManifest(cl, o);
    const out = U.clone(o);
    if (kind === 'Deployment') { const s = deployStatus(cl, o); delete s.desired; out.status = s; }
    if (kind === 'Service') out.status = { loadBalancer: {} };
    return out;
  }

  /* ------------------------------------------------------------ get */
  function listFor(cl, type, ns, allNs, w) {
    const nsOk = o => allNs || (o.metadata ? o.metadata.namespace === ns : o.ns === ns);
    switch (type) {
      case 'pods': {
        const pods = cl.pods.filter(p => allNs || p.ns === ns).map(p => ({ kind: 'pod', name: p.name, ns: p.ns, labels: p.labels, p }));
        const sys = cl.systemPods.filter(p => allNs || ns === 'kube-system').map(p => ({ kind: 'pod', name: p.name, ns: p.ns, labels: {}, sys: p }));
        return pods.concat(sys).sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
      }
      case 'replicasets': {
        const out = [];
        for (const d of cl.list('Deployment')) {
          if (!nsOk(d)) continue;
          const hist = cl.deployHistory(d.metadata.namespace, d.metadata.name).slice(-3);
          const curHash = cl.templateHash(d.spec.template);
          for (const h of hist) {
            const pods = cl.deployPods(d.metadata.namespace, d.metadata.name).filter(p => p.hash === h.hash);
            out.push({ kind: 'rs', name: `${d.metadata.name}-${h.hash}`, ns: d.metadata.namespace, labels: d.spec.template.metadata.labels, desired: h.hash === curHash ? pods.length : pods.length, pods, d });
          }
        }
        return out;
      }
      case 'endpoints':
        return cl.list('Service').filter(nsOk).map(s => ({ kind: 'ep', name: s.metadata.name, ns: s.metadata.namespace, labels: s.metadata.labels, o: s }));
      case 'nodes': return cl.nodes.map(n => ({ kind: 'node', name: n.name, labels: Object.assign({ 'kubernetes.io/hostname': n.name }, n.labels), n }));
      case 'events': return eventsFor(cl, allNs ? null : ns, w).map(e => ({ kind: 'event', name: e.object, ns: e.ns, e }));
      case 'serviceaccounts': return (allNs ? cl.list('Namespace').map(n => n.metadata.name) : [ns]).map(n => ({ kind: 'sa', name: 'default', ns: n, labels: {}, o: { metadata: { name: 'default', namespace: n, creationTimestamp: new Date(cl.created).toISOString() } } }));
      case 'ingresses': case 'persistentvolumeclaims': return [];
      default: {
        const kind = KIND_OF[type];
        if (!kind) return null;
        let items = cl.list(kind, KINDS[kind].ns && !allNs ? ns : null);
        const extra = type === 'configmaps' ? cl.list('Namespace').filter(n => allNs || n.metadata.name === ns).map(n => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: n.metadata.name, creationTimestamp: n.metadata.creationTimestamp }, data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\n(training)\n-----END CERTIFICATE-----\n' }, synthetic: true })) : [];
        items = items.concat(extra).sort((a, b) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));
        return items.map(o => ({ kind, name: o.metadata.name, ns: o.metadata.namespace, labels: o.metadata.labels || {}, o }));
      }
    }
  }
  function eventsFor(cl, ns, w) {
    const out = [];
    const t = ts => U.age(w.now() - ts);
    for (const p of cl.pods) {
      if (ns && p.ns !== ns) continue;
      const st = cl.podStatus(p);
      const obj = 'pod/' + p.name;
      const at = Math.max(p.createdAt, w.now() - 3600e3);
      if (!p.node) { out.push({ ns: p.ns, at, type: 'Warning', reason: 'FailedScheduling', object: obj, message: p.schedMsg }); continue; }
      out.push({ ns: p.ns, at, type: 'Normal', reason: 'Scheduled', object: obj, message: `Successfully assigned ${p.ns}/${p.name} to ${p.node}` });
      const c = st.verdict && st.verdict.failing;
      const img = p.spec.containers[0].image;
      if (st.display === 'ContainerCreating') continue;
      if (c && c.state === 'pull') {
        out.push({ ns: p.ns, at: at + 1000, type: 'Normal', reason: 'Pulling', object: obj, message: `Pulling image "${c.image}"` });
        out.push({ ns: p.ns, at: at + 2000, type: 'Warning', reason: 'Failed', object: obj, message: `Failed to pull image "${c.image}": ${c.message}` });
        out.push({ ns: p.ns, at: at + 2000, type: 'Warning', reason: 'Failed', object: obj, message: 'Error: ErrImagePull' });
        out.push({ ns: p.ns, at: at + 4000, type: 'Normal', reason: 'BackOff', object: obj, message: `Back-off pulling image "${c.image}"` });
      } else if (c && c.state === 'config') {
        out.push({ ns: p.ns, at: at + 1000, type: 'Warning', reason: 'Failed', object: obj, message: `Error: ${c.message}` });
      } else {
        out.push({ ns: p.ns, at: at + 1000, type: 'Normal', reason: 'Pulled', object: obj, message: `Container image "${img}" already present on machine` });
        out.push({ ns: p.ns, at: at + 1500, type: 'Normal', reason: 'Created', object: obj, message: `Created container ${p.spec.containers[0].name}` });
        out.push({ ns: p.ns, at: at + 1600, type: 'Normal', reason: 'Started', object: obj, message: `Started container ${p.spec.containers[0].name}` });
        if (c && c.state === 'crash') out.push({ ns: p.ns, at: w.now() - 5000, type: 'Warning', reason: 'BackOff', object: obj, message: `Back-off restarting failed container ${c.name} in pod ${p.name}_${p.ns}(${p.uid})` });
        else if (!st.ready && st.message) out.push({ ns: p.ns, at: w.now() - 8000, type: 'Warning', reason: 'Unhealthy', object: obj, message: st.message });
      }
    }
    for (const n of cl.nodes) {
      const s = cl.nodeState(n);
      if (s.diskPressure && (!ns || ns === 'default')) out.push({ ns: 'default', at: w.now() - 20000, type: 'Warning', reason: 'EvictionThresholdMet', object: 'node/' + n.name, message: 'Attempting to reclaim ephemeral-storage' });
      if (!s.ready && (!ns || ns === 'default')) out.push({ ns: 'default', at: w.now() - 30000, type: 'Normal', reason: 'NodeNotReady', object: 'node/' + n.name, message: `Node ${n.name} status is now: NodeNotReady` });
    }
    for (const e of cl.events) if (!ns || e.ns === ns) out.push(e);
    return out.sort((a, b) => a.at - b.at).map(e => Object.assign({ last: t(e.at) }, e));
  }

  function tableFor(cl, type, items, wide, allNs, w, showLabels, prefix = '') {
    const nsCol = allNs && !['nodes', 'namespaces', 'projects'].includes(type);
    let headers, rows;
    const lbl = o => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>';
    switch (type) {
      case 'pods':
        headers = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'];
        if (wide) headers.push('IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES');
        rows = items.map(it => {
          if (it.sys) { const r = [it.name, '1/1', 'Running', '0', U.age(w.now() - cl.created)]; if (wide) r.push('10.244.0.' + (U.hash(it.name) % 200 + 2), it.sys.node, '<none>', '<none>'); return r; }
          const p = it.p, st = cl.podStatus(p);
          const r = [p.name, `${st.readyN}/${st.total}`, st.display, st.restarts ? `${st.restarts} (${U.age(Math.min(12000, w.now() - p.createdAt))} ago)` : '0', U.age(w.now() - p.createdAt)];
          if (wide) r.push(p.ip || '<none>', p.node || '<none>', '<none>', '<none>');
          return r;
        });
        break;
      case 'deployments':
        headers = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'];
        if (wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
        rows = items.map(({ o }) => {
          const s = deployStatus(cl, o);
          const r = [o.metadata.name, `${s.readyReplicas}/${s.desired}`, String(Math.min(s.updatedReplicas, s.desired)), String(s.availableReplicas), ageOf(o.metadata.creationTimestamp, w)];
          if (wide) r.push(o.spec.template.spec.containers.map(c => c.name).join(','), o.spec.template.spec.containers.map(c => c.image).join(','), lbl(o.spec.selector.matchLabels));
          return r;
        });
        break;
      case 'replicasets':
        headers = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'];
        rows = items.map(it => [it.name, String(it.desired), String(it.pods.length), String(it.pods.filter(p => cl.podStatus(p).ready).length), ageOf(it.d.metadata.creationTimestamp, w)]);
        break;
      case 'services':
        headers = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'];
        if (wide) headers.push('SELECTOR');
        rows = items.map(({ o }) => {
          const s = o.spec;
          const ext = s.type === 'LoadBalancer' ? (cl.flavor === 'eks' ? `a${U.hex(o.metadata.name, 10)}-${U.hash(o.metadata.name) % 9999}.ap-northeast-1.elb.amazonaws.com` : '<pending>') : '<none>';
          const r = [o.metadata.name, s.type, s.clusterIP, ext, s.ports.map(p => (p.nodePort ? `${p.port}:${p.nodePort}` : p.port) + '/' + (p.protocol || 'TCP')).join(','), ageOf(o.metadata.creationTimestamp, w)];
          if (wide) r.push(lbl(s.selector));
          return r;
        });
        break;
      case 'endpoints':
        headers = ['NAME', 'ENDPOINTS', 'AGE'];
        rows = items.map(({ o }) => {
          const eps = cl.endpoints(o).flatMap(e => o.spec.ports.map(sp => `${e.pod.ip}:${cl.targetFor(e.pod, sp.targetPort)}`));
          return [o.metadata.name, eps.length ? eps.slice(0, 3).join(',') + (eps.length > 3 ? ` + ${eps.length - 3} more...` : '') : '<none>', ageOf(o.metadata.creationTimestamp, w)];
        });
        break;
      case 'configmaps':
        headers = ['NAME', 'DATA', 'AGE'];
        rows = items.map(({ o }) => [o.metadata.name, String(Object.keys(o.data || {}).length), ageOf(o.metadata.creationTimestamp, w)]);
        break;
      case 'secrets':
        headers = ['NAME', 'TYPE', 'DATA', 'AGE'];
        rows = items.map(({ o }) => [o.metadata.name, o.type, String(Object.keys(o.data || {}).length), ageOf(o.metadata.creationTimestamp, w)]);
        break;
      case 'namespaces':
        headers = ['NAME', 'STATUS', 'AGE'];
        rows = items.map(({ o }) => [o.metadata.name, 'Active', ageOf(o.metadata.creationTimestamp, w)]);
        break;
      case 'projects':
        headers = ['NAME', 'DISPLAY NAME', 'STATUS'];
        rows = items.map(({ o }) => [o.metadata.name, '', 'Active']);
        break;
      case 'nodes':
        headers = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'];
        if (wide) headers.push('INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME');
        rows = items.map(({ n }) => {
          const s = cl.nodeState(n);
          const r = [n.name, (s.ready ? 'Ready' : 'NotReady') + (n.cordoned ? ',SchedulingDisabled' : ''), n.role === 'worker' ? (cl.flavor === 'eks' ? '<none>' : 'worker') : n.role, U.age(w.now() - n.created), cl.flavor === 'eks' ? 'v1.30.4-eks-a737599' : cl.version];
          if (wide) r.push(n.ip, '<none>', cl.openshift ? 'Red Hat Enterprise Linux CoreOS 416.94' : cl.flavor === 'eks' ? 'Amazon Linux 2023.5.20241001' : 'Ubuntu 22.04.4 LTS', '5.14.0-427.el9.x86_64', cl.openshift ? 'cri-o://1.29.8' : 'containerd://1.7.22');
          return r;
        });
        break;
      case 'events':
        headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
        rows = items.map(({ e }) => [e.last, e.type, e.reason, e.object, e.message]);
        break;
      case 'routes':
        headers = ['NAME', 'HOST/PORT', 'PATH', 'SERVICES', 'PORT', 'TERMINATION', 'WILDCARD'];
        rows = items.map(({ o }) => [o.metadata.name, o.spec.host, o.spec.path || '', o.spec.to.name, (o.spec.port && o.spec.port.targetPort) || '<all>', o.spec.tls ? o.spec.tls.termination + (o.spec.tls.insecureEdgeTerminationPolicy ? '/' + o.spec.tls.insecureEdgeTerminationPolicy : '') : '', 'None']);
        break;
      case 'serviceaccounts':
        headers = ['NAME', 'SECRETS', 'AGE'];
        rows = items.map(({ o }) => [o.metadata.name, '0', ageOf(o.metadata.creationTimestamp, w)]);
        break;
      default: return '';
    }
    if (prefix) rows.forEach(r => { r[0] = prefix + r[0]; });
    if (nsCol) { headers.unshift('NAMESPACE'); rows.forEach((r, i) => r.unshift(items[i].ns || '')); }
    if (showLabels) { headers.push('LABELS'); rows.forEach((r, i) => r.push(lbl(items[i].labels))); }
    return U.table(headers, rows);
  }

  function cmdGet(cl, a, ns, allNs, w, user) {
    const targets = parseTargets(a.pos.slice(1));
    if (!targets.length) return fail('error: you must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.');
    const out = [], errs = [], objs = [];
    const fmt = U.first(a.flags.o || a.flags.output);
    const selector = U.first(a.flags.l || a.flags.selector);
    let expanded = [];
    for (const t of targets) {
      if (!t.type) return fail(`error: the server doesn't have a resource type "${t.raw}"`);
      if (t.type === 'routes' && !cl.openshift) return fail(`error: the server doesn't have a resource type "${t.raw}"`);
      if (t.type === 'all') expanded.push({ type: 'pods', names: [] }, { type: 'services', names: [] }, { type: 'deployments', names: [] }, { type: 'replicasets', names: [] }, ...(cl.openshift ? [{ type: 'routes', names: [] }] : []));
      else expanded.push(t);
    }
    const multi = expanded.length > 1;
    for (const t of expanded) {
      const denied = canAccess(cl, user, t.type, ['nodes', 'namespaces', 'projects'].includes(t.type) ? null : allNs ? 'kube-system' : ns);
      if (denied && !(t.type === 'namespaces' || t.type === 'projects')) { errs.push(denied); continue; }
      let items = listFor(cl, t.type, ns, allNs, w);
      if ((t.type === 'namespaces' || t.type === 'projects') && cl.openshift && !(cl.users[user] || {}).admin) items = items.filter(i => cl.projectsOf[user] && cl.projectsOf[user].has(i.name));
      if (selector) items = items.filter(i => selectorMatch(selector, i.labels));
      if (t.names.length) {
        const found = [];
        for (const n of t.names) {
          const hit = items.find(i => i.name === n);
          if (hit) found.push(hit); else errs.push(`Error from server (NotFound): ${t.type === 'deployments' ? 'deployments.apps' : t.type === 'routes' ? 'routes.route.openshift.io' : t.type} "${n}" not found`);
        }
        items = found;
      }
      if (!items.length) continue;
      if (fmt === 'yaml' || fmt === 'json' || (fmt && fmt.startsWith('jsonpath'))) {
        for (const i of items) {
          if (i.p) objs.push(podManifest(cl, i.p));
          else if (i.o) objs.push(objManifest(cl, i.kind, i.o));
          else if (i.n) objs.push({ apiVersion: 'v1', kind: 'Node', metadata: { name: i.n.name, labels: i.labels }, spec: { unschedulable: i.n.cordoned || undefined, taints: cl.nodeState(i.n).taints.length ? cl.nodeState(i.n).taints : undefined }, status: { addresses: [{ type: 'InternalIP', address: i.n.ip }], allocatable: { cpu: i.n.cpu + 'm', memory: i.n.mem + 'Mi' } } });
        }
        continue;
      }
      if (fmt === 'name') { out.push(items.map(i => `${SINGULAR[t.type] || t.type}/${i.name}`).join('\n')); continue; }
      const prefix = multi || targets.some(x => x.type === 'all') ? (SINGULAR[t.type] || t.type).replace(/\..*/, '') + '/' : '';
      out.push(tableFor(cl, t.type, items, fmt === 'wide', allNs, w, a.flags['show-labels'], prefix));
    }
    if (objs.length) {
      const doc = objs.length === 1 && !(targets.length === 1 && !targets[0].names.length) ? objs[0] : { apiVersion: 'v1', kind: 'List', items: objs, metadata: { resourceVersion: '' } };
      if (fmt === 'json') out.push(JSON.stringify(doc, null, 2));
      else if (fmt === 'yaml') out.push(Y.stringify(doc).trimEnd());
      else out.push(jsonpath(doc, fmt.slice(fmt.indexOf('=') + 1)));
    }
    if (!out.length && !errs.length) {
      const nsTxt = allNs ? '' : ` in ${ns} namespace`;
      return ok(`No resources found${expanded.every(t => ['nodes', 'namespaces', 'projects'].includes(t.type)) ? '' : nsTxt}.`);
    }
    let text = out.join('\n\n');
    if (a.flags.w || a.flags.watch) text += IG.t('\n\nℹ ウォッチ（-w）は未対応です。状態の変化はもう一度 get して確認してください。');
    if (errs.length) return { out: [text, ...errs].filter(Boolean).join('\n'), code: 1, err: !text };
    return ok(text);
  }

  /* ------------------------------------------------------------ describe */
  function eventsBlock(evs) {
    if (!evs.length) return 'Events:              <none>';
    return 'Events:\n' + U.table(['  Type', 'Reason', 'Age', 'From', 'Message'], [['  ----', '------', '----', '----', '-------']].concat(evs.slice(-8).map(e => ['  ' + e.type, e.reason, e.last, e.reason === 'Scheduled' || e.reason === 'FailedScheduling' ? 'default-scheduler' : e.object.startsWith('deployment') ? 'deployment-controller' : 'kubelet', e.message])));
  }
  function describePod(cl, p, w) {
    const st = cl.podStatus(p);
    const v = st.verdict;
    const node = cl.nodes.find(n => n.name === p.node);
    const lines = [
      `Name:             ${p.name}`, `Namespace:        ${p.ns}`, `Priority:         0`, `Service Account:  ${p.spec.serviceAccountName || 'default'}`,
      `Node:             ${p.node ? `${p.node}/${node.ip}` : '<none>'}`, `Start Time:       ${p.node ? new Date(p.createdAt).toUTCString() : '<none>'}`,
      `Labels:           ${Object.entries(p.labels).map(([k, val]) => `${k}=${val}`).join('\n                  ') || '<none>'}`,
      `Status:           ${st.phase}`, `IP:               ${p.ip || ''}`,
      p.owner ? `Controlled By:    ReplicaSet/${p.owner}-${p.hash}` : null, 'Containers:',
    ].filter(x => x !== null);
    p.spec.containers.forEach((c, i) => {
      const cv = v && v.containers[i];
      lines.push(`  ${c.name}:`, `    Image:          ${c.image}`, `    Port:           ${(c.ports || []).map(x => x.containerPort + '/TCP').join(', ') || '<none>'}`);
      if (!p.node || st.display === 'ContainerCreating') lines.push('    State:          Waiting', `      Reason:       ${st.display === 'Pending' ? 'Pending' : 'ContainerCreating'}`);
      else if (cv && cv.state === 'running') lines.push('    State:          Running', `      Started:      ${new Date(p.createdAt + 2000).toUTCString()}`);
      else if (cv && cv.state === 'crash') lines.push('    State:          Waiting', '      Reason:       CrashLoopBackOff', '    Last State:     Terminated', '      Reason:       Error', `      Exit Code:    ${cv.exitCode}`);
      else if (cv) lines.push('    State:          Waiting', `      Reason:       ${st.display}`);
      lines.push(`    Ready:          ${cv && cv.ready ? 'True' : 'False'}`, `    Restart Count:  ${cv && cv.state === 'crash' ? st.restarts : 0}`);
      const req = (c.resources && c.resources.requests) || null;
      if (req) lines.push('    Requests:', ...Object.entries(req).map(([k, val]) => `      ${k}:     ${val}`));
      if (c.readinessProbe) { const h = c.readinessProbe.httpGet || c.readinessProbe.tcpSocket || {}; lines.push(`    Readiness:      ${c.readinessProbe.httpGet ? `http-get http://:${h.port}${h.path || '/'}` : `tcp-socket :${h.port}`} delay=${c.readinessProbe.initialDelaySeconds || 0}s timeout=1s period=10s #success=1 #failure=3`); }
      const env = (c.env || []).map(e => `      ${e.name}:  ${e.value !== undefined ? e.value : e.valueFrom && e.valueFrom.configMapKeyRef ? `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>` : e.valueFrom && e.valueFrom.secretKeyRef ? `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>` : '<unknown>'}  Optional: false`);
      const envFrom = (c.envFrom || []).map(ef => `      ${ef.configMapRef ? ef.configMapRef.name + '  ConfigMap' : ef.secretRef.name + '  Secret'}  Optional: false`);
      if (envFrom.length) lines.push('    Environment Variables from:', ...envFrom);
      lines.push(`    Environment:    ${env.length ? '' : '<none>'}`.trimEnd(), ...env);
    });
    lines.push('Conditions:', '  Type              Status', `  PodScheduled      ${p.node ? 'True' : 'False'}`, `  Ready             ${st.ready ? 'True' : 'False'}`);
    if (p.spec.imagePullSecrets) lines.push(`Image Pull Secrets: ${p.spec.imagePullSecrets.map(s => s.name).join(', ')}`);
    if (p.spec.nodeSelector) lines.push(`Node-Selectors:   ${Object.entries(p.spec.nodeSelector).map(([k, val]) => k + '=' + val).join(',')}`);
    lines.push(eventsBlock(eventsFor(cl, p.ns, w).filter(e => e.object === 'pod/' + p.name)));
    return lines.join('\n');
  }
  function describeDeployment(cl, d, w) {
    const s = deployStatus(cl, d);
    const t = d.spec.template;
    const c = t.spec.containers;
    const hist = cl.deployHistory(d.metadata.namespace, d.metadata.name);
    const cur = hist[hist.length - 1];
    const lines = [
      `Name:                   ${d.metadata.name}`, `Namespace:              ${d.metadata.namespace}`, `CreationTimestamp:      ${new Date(d.metadata.creationTimestamp).toUTCString()}`,
      `Labels:                 ${Object.entries(d.metadata.labels || {}).map(([k, v]) => k + '=' + v).join(',') || '<none>'}`,
      `Annotations:            deployment.kubernetes.io/revision: ${cur ? cur.rev : 1}`,
      `Selector:               ${Object.entries(d.spec.selector.matchLabels || {}).map(([k, v]) => k + '=' + v).join(',')}`,
      `Replicas:               ${s.desired} desired | ${s.updatedReplicas} updated | ${s.replicas} total | ${s.availableReplicas} available | ${Math.max(0, s.replicas - s.availableReplicas)} unavailable`,
      'StrategyType:           RollingUpdate', 'RollingUpdateStrategy:  25% max unavailable, 25% max surge', 'Pod Template:',
      `  Labels:  ${Object.entries(t.metadata.labels || {}).map(([k, v]) => k + '=' + v).join('\n           ')}`, '  Containers:',
    ];
    for (const x of c) {
      lines.push(`   ${x.name}:`, `    Image:      ${x.image}`, `    Port:       ${(x.ports || []).map(p => p.containerPort + '/TCP').join(', ') || '<none>'}`);
      const r = x.resources && x.resources.requests;
      if (r) lines.push('    Requests:', ...Object.entries(r).map(([k, v]) => `      ${k}:     ${v}`));
      if (x.env) lines.push('    Environment:', ...x.env.map(e => `      ${e.name}:  ${e.value !== undefined ? e.value : '<set from ref>'}`));
      if (x.envFrom) lines.push('    Environment Variables from:', ...x.envFrom.map(ef => `      ${ef.configMapRef ? ef.configMapRef.name + '  ConfigMap' : ef.secretRef.name + '  Secret'}  Optional: false`));
    }
    if (t.spec.imagePullSecrets) lines.push(`  Image Pull Secrets:  ${t.spec.imagePullSecrets.map(x => x.name).join(', ')}`);
    const avail = s.availableReplicas >= s.desired;
    lines.push('Conditions:', '  Type           Status  Reason', '  ----           ------  ------', `  Available      ${avail ? 'True    MinimumReplicasAvailable' : 'False   MinimumReplicasUnavailable'}`,
      `  Progressing    ${s.updatedReplicas >= s.desired && avail ? 'True    NewReplicaSetAvailable' : 'True    ReplicaSetUpdated'}`,
      `NewReplicaSet:   ${d.metadata.name}-${cl.templateHash(t)} (${s.updatedReplicas}/${s.desired} replicas created)`);
    lines.push(eventsBlock(eventsFor(cl, d.metadata.namespace, w).filter(e => e.object === 'deployment/' + d.metadata.name)));
    return lines.join('\n');
  }
  function describeService(cl, o) {
    const s = o.spec;
    const eps = cl.endpoints(o);
    return [
      `Name:              ${o.metadata.name}`, `Namespace:         ${o.metadata.namespace}`, `Labels:            ${Object.entries(o.metadata.labels || {}).map(([k, v]) => k + '=' + v).join(',') || '<none>'}`,
      `Selector:          ${Object.entries(s.selector || {}).map(([k, v]) => k + '=' + v).join(',') || '<none>'}`, `Type:              ${s.type}`, `IP:                ${s.clusterIP}`,
      ...s.ports.flatMap(p => [`Port:              ${p.name || '<unset>'}  ${p.port}/${p.protocol}`, `TargetPort:        ${p.targetPort}/${p.protocol}`, p.nodePort ? `NodePort:          ${p.name || '<unset>'}  ${p.nodePort}/TCP` : null,
        `Endpoints:         ${eps.length ? eps.map(e => `${e.pod.ip}:${cl.targetFor(e.pod, p.targetPort)}`).join(',') : '<none>'}`]).filter(Boolean),
      'Session Affinity:  None', 'Events:            <none>',
    ].join('\n');
  }
  function describeNode(cl, n, w) {
    const s = cl.nodeState(n);
    const used = cl.nodeAllocated(n);
    const pods = cl.pods.filter(p => p.node === n.name);
    const hb = new Date(w.now() - 12000).toUTCString();
    return [
      `Name:               ${n.name}`, `Roles:              ${n.role}`, `Labels:             kubernetes.io/hostname=${n.name}${Object.entries(n.labels).map(([k, v]) => `\n                    ${k}=${v}`).join('')}`,
      `CreationTimestamp:  ${new Date(n.created).toUTCString()}`, `Taints:             ${s.taints.map(t => `${t.key}:${t.effect}`).join('\n                    ') || '<none>'}`,
      `Unschedulable:      ${n.cordoned}`, 'Conditions:',
      U.table(['  Type', 'Status', 'LastHeartbeatTime', 'Reason', 'Message'], [
        ['  ----', '------', '-----------------', '------', '-------'],
        ['  MemoryPressure', 'False', hb, 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'],
        ['  DiskPressure', s.diskPressure ? 'True' : 'False', hb, s.diskPressure ? 'KubeletHasDiskPressure' : 'KubeletHasNoDiskPressure', s.diskPressure ? `kubelet has disk pressure (nodefs ${s.diskPct}% used)` : 'kubelet has no disk pressure'],
        ['  PIDPressure', 'False', hb, 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'],
        ['  Ready', s.ready ? 'True' : 'Unknown', hb, s.ready ? 'KubeletReady' : 'NodeStatusUnknown', s.ready ? 'kubelet is posting ready status' : 'Kubelet stopped posting node status.'],
      ]),
      'Addresses:', `  InternalIP:  ${n.ip}`, `  Hostname:    ${n.name}`, 'Allocatable:', `  cpu:     ${n.cpu}m`, `  memory:  ${n.mem}Mi`,
      `Non-terminated Pods:  (${pods.length} in total)`,
      ...pods.map(p => `  ${p.ns.padEnd(12)} ${p.name.padEnd(40)} ${(p.spec.containers[0].resources && p.spec.containers[0].resources.requests && p.spec.containers[0].resources.requests.cpu) || '0'}`),
      'Allocated resources:', `  cpu      ${used.cpu}m (${Math.round((used.cpu / n.cpu) * 100)}%)`, `  memory   ${Math.round(used.mem)}Mi (${Math.round((used.mem / n.mem) * 100)}%)`,
      eventsBlock(eventsFor(cl, null, w).filter(e => e.object === 'node/' + n.name)),
    ].join('\n');
  }
  function cmdDescribe(cl, a, ns, w, user) {
    const targets = parseTargets(a.pos.slice(1));
    if (!targets.length) return fail('error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
    const out = [], errs = [];
    for (const t of targets) {
      if (!t.type || (t.type === 'routes' && !cl.openshift)) return fail(`error: the server doesn't have a resource type "${t.raw}"`);
      const denied = canAccess(cl, user, t.type, t.type === 'nodes' ? null : ns);
      if (denied) { errs.push(denied); continue; }
      let items = listFor(cl, t.type, ns, false, w) || [];
      if (t.names.length) {
        const sel = [];
        for (const n of t.names) {
          const exact = items.filter(i => i.name === n);
          const pref = exact.length ? exact : items.filter(i => i.name.startsWith(n));
          if (pref.length) sel.push(...pref); else errs.push(`Error from server (NotFound): ${t.type === 'deployments' ? 'deployments.apps' : t.type} "${n}" not found`);
        }
        items = sel;
      }
      for (const i of items) {
        if (t.type === 'pods' && i.p) out.push(describePod(cl, i.p, w));
        else if (t.type === 'deployments') out.push(describeDeployment(cl, i.o, w));
        else if (t.type === 'services') out.push(describeService(cl, i.o));
        else if (t.type === 'nodes') out.push(describeNode(cl, i.n, w));
        else if (t.type === 'configmaps') out.push([`Name:         ${i.name}`, `Namespace:    ${i.ns}`, '', 'Data', '====', ...Object.entries(i.o.data || {}).flatMap(([k, v]) => [`${k}:`, '----', String(v), ''])].join('\n'));
        else if (t.type === 'secrets') out.push([`Name:         ${i.name}`, `Namespace:    ${i.ns}`, '', `Type:  ${i.o.type}`, '', 'Data', '====', ...Object.entries(i.o.data || {}).map(([k, v]) => `${k}:  ${(U.unb64(v) || '').length} bytes`)].join('\n'));
        else if (t.type === 'routes') out.push([`Name:             ${i.name}`, `Namespace:        ${i.ns}`, `Requested Host:   ${i.o.spec.host}`, `Path:             <none>`, `TLS Termination:  ${i.o.spec.tls ? i.o.spec.tls.termination : '<none>'}`, `Service:          ${i.o.spec.to.name}`, `Endpoints:        ${(() => { const s = cl.get('Service', i.ns, i.o.spec.to.name); return s ? cl.endpoints(s).map(e => e.pod.ip).join(', ') || '<none>' : '<error: endpoints "' + i.o.spec.to.name + '" not found>'; })()}`].join('\n'));
        else if (i.o) out.push(Y.stringify(objManifest(cl, i.kind, i.o)).trimEnd());
      }
    }
    if (!out.length && !errs.length) return ok(`No resources found in ${ns} namespace.`);
    return { out: out.concat(errs).join('\n\n\n'), code: errs.length ? 1 : 0, err: !out.length };
  }

  /* ------------------------------------------------------------ pods by target */
  function findPod(cl, ns, target) {
    if (!target) return { error: 'error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.' };
    const [t, n] = target.includes('/') ? target.split('/') : ['pod', target];
    const type = TYPE_OF[t];
    if (type === 'pods') {
      const p = cl.pods.find(x => x.ns === ns && x.name === n);
      return p ? { pod: p } : { error: `Error from server (NotFound): pods "${n}" not found` };
    }
    if (type === 'deployments') {
      const d = cl.get('Deployment', ns, n);
      if (!d) return { error: `Error from server (NotFound): deployments.apps "${n}" not found` };
      const pods = cl.deployPods(ns, n).sort((a, b) => Number(cl.podStatus(b).ready) - Number(cl.podStatus(a).ready));
      return pods.length ? { pod: pods[0], note: pods.length > 1 ? `Found ${pods.length} pods, using pod/${pods[0].name}` : null } : { error: `error: timed out waiting for the condition` };
    }
    return { error: `error: cannot attach to ${t}: selector for ${t} not implemented` };
  }

  /* ------------------------------------------------------------ mutating commands */
  function deploymentFrom(cl, a, ns) {
    const [first, second] = a.pos.slice(1);
    if (!first) return { error: 'error: required resource not specified' };
    let type, name;
    if (first.includes('/')) [type, name] = first.split('/'); else { type = first; name = second; }
    if (TYPE_OF[type] !== 'deployments') return { error: IG.t(`error: {0} "{1}" is not a deployment (このシミュレータでは Deployment のみ対応)`, { 0: type, 1: name }) };
    const d = cl.get('Deployment', ns, name);
    if (!d) return { error: `Error from server (NotFound): deployments.apps "${name}" not found` };
    return { d: U.clone(d), name };
  }
  function save(cl, d, user) { return cl.apply(d, d.metadata.namespace, { user }); }

  function cmdCreate(cl, a, ns, ctx, user) {
    const sub = a.pos[1];
    const dry = a.flags['dry-run'];
    const fmt = U.first(a.flags.o || a.flags.output);
    const emit = (m) => {
      if (dry) return ok(fmt === 'json' ? JSON.stringify(m, null, 2) : fmt === 'yaml' ? Y.stringify(m).trimEnd() : `${KINDS[m.kind].display}/${m.metadata.name} created (dry run)`);
      try { const r = cl.apply(m, ns, { create: true, user }); return ok(r); } catch (e) { return fail(e.message); }
    };
    if (a.flags.f || a.flags.filename) return applyFiles(cl, a, ns, ctx, user, true);
    const name = a.pos[2];
    switch (TYPE_OF[sub] || sub) {
      case 'deployments': {
        const image = U.first(a.flags.image);
        if (!name || !image) return fail('error: required flag(s) "image" not set');
        const c = { name: IG.images.parse(image).name.split('/').pop(), image };
        if (a.flags.port) c.ports = [{ containerPort: Number(U.first(a.flags.port)) }];
        return emit({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels: { app: name } }, spec: { replicas: Number(U.first(a.flags.replicas) || 1), selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [c] } } } });
      }
      case 'namespaces':
        if (!name) return fail('error: exactly one NAME is required, got 0');
        return emit({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });
      case 'configmaps': {
        if (!name) return fail('error: exactly one NAME is required, got 0');
        const data = {};
        for (const lit of U.list(a.flags['from-literal'])) { const i = lit.indexOf('='); if (i < 1) return fail(`error: invalid literal source ${lit}, expected key=value`); data[lit.slice(0, i)] = lit.slice(i + 1); }
        for (const f of U.list(a.flags['from-file'])) {
          const [k, p] = f.includes('=') ? f.split('=') : [IG.VFS.base(ctx.resolve(f)), f];
          const content = ctx.vfs.read(ctx.resolve(p));
          if (content === undefined) return fail(`error: error reading ${p}: no such file or directory`);
          data[k] = content;
        }
        for (const f of U.list(a.flags['from-env-file'])) {
          const content = ctx.vfs.read(ctx.resolve(f));
          if (content === undefined) return fail(`error: error reading ${f}: no such file or directory`);
          for (const line of content.split('\n')) { const m = line.match(/^\s*([A-Za-z_][\w.-]*)\s*=\s*(.*)$/); if (m) data[m[1]] = m[2]; }
        }
        return emit({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: ns }, data });
      }
      case 'secrets': {
        const kind = a.pos[2], sname = a.pos[3];
        if (kind === 'generic') {
          if (!sname) return fail('error: exactly one NAME is required, got 0');
          const data = {};
          for (const lit of U.list(a.flags['from-literal'])) { const i = lit.indexOf('='); if (i < 1) return fail(`error: invalid literal source ${lit}, expected key=value`); data[lit.slice(0, i)] = U.b64(lit.slice(i + 1)); }
          for (const f of U.list(a.flags['from-file'])) {
            const [k, p] = f.includes('=') ? f.split('=') : [IG.VFS.base(ctx.resolve(f)), f];
            const content = ctx.vfs.read(ctx.resolve(p));
            if (content === undefined) return fail(`error: error reading ${p}: no such file or directory`);
            data[k] = U.b64(content);
          }
          return emit({ apiVersion: 'v1', kind: 'Secret', metadata: { name: sname, namespace: ns }, type: 'Opaque', data });
        }
        if (kind === 'docker-registry') {
          if (!sname) return fail('error: exactly one NAME is required, got 0');
          const server = U.first(a.flags['docker-server']) || 'https://index.docker.io/v1/';
          const username = U.first(a.flags['docker-username']), password = U.first(a.flags['docker-password']);
          if (!username || !password) return fail('error: required flag(s) "docker-password", "docker-username" not set');
          const cfg = { auths: { [server]: { username, password, auth: U.b64(username + ':' + password) } } };
          return emit({ apiVersion: 'v1', kind: 'Secret', metadata: { name: sname, namespace: ns }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': U.b64(JSON.stringify(cfg)) } });
        }
        if (kind === 'tls') return fail(IG.t('ℹ TLS Secret の作成はこのシミュレータでは未対応です。'));
        return fail('error: Please specify the secret type: generic, docker-registry or tls');
      }
      case 'services': {
        const stype = a.pos[2], sname = a.pos[3];
        const tcp = U.first(a.flags.tcp);
        if (!sname || !tcp) return fail('error: at least one tcp port specifier must be provided (--tcp=port:targetPort)');
        const [port, target] = tcp.split(':').map(Number);
        const typ = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' }[stype];
        if (!typ) return fail(`error: unknown service type "${stype}"`);
        return emit({ apiVersion: 'v1', kind: 'Service', metadata: { name: sname, namespace: ns, labels: { app: sname } }, spec: { type: typ, selector: { app: sname }, ports: [{ name: `${port}-${target || port}`, port, targetPort: target || port }] } });
      }
      case 'routes': {
        if (!cl.openshift) return fail('error: unknown command "route" for "kubectl create"');
        const term = a.pos[2], rname = a.pos[3];
        const svc = U.first(a.flags.service) || rname;
        if (!['edge', 'passthrough', 'reencrypt'].includes(term)) return fail('error: Please specify the route type: edge, passthrough, reencrypt');
        if (!cl.get('Service', ns, svc)) return fail(`Error from server (NotFound): services "${svc}" not found`);
        const r = { apiVersion: 'route.openshift.io/v1', kind: 'Route', metadata: { name: rname || svc, namespace: ns, labels: { app: svc } }, spec: { to: { kind: 'Service', name: svc }, tls: { termination: term, insecureEdgeTerminationPolicy: U.first(a.flags['insecure-policy']) || undefined } } };
        if (a.flags.hostname) r.spec.host = U.first(a.flags.hostname);
        return emit(r);
      }
      default:
        return fail(`error: unknown command "${sub || ''}" for "kubectl create"\n\nAvailable: configmap, deployment, namespace, secret (generic|docker-registry), service (clusterip|nodeport)`);
    }
  }

  function applyFiles(cl, a, ns, ctx, user, create) {
    const files = U.list(a.flags.f || a.flags.filename);
    if (!files.length) return fail('error: must specify one of -f and -k');
    const out = [];
    let code = 0;
    for (const f of files) {
      let sources;
      try { sources = readManifests(ctx, f); } catch (e) { return fail(e.message); }
      for (const src of sources) {
        let docs;
        try { docs = parseDocs(src.text, src.file); } catch (e) { out.push(e.message); code = 1; continue; }
        if (!docs.length) { out.push(`error: no objects passed to ${create ? 'create' : 'apply'}`); code = 1; }
        for (const d of docs) {
          if (cl.openshift && d && d.kind === 'Namespace' && !(cl.users[user] || {}).admin) { out.push(IG.t(`Error from server (Forbidden): namespaces is forbidden: User "{0}" cannot create resource "namespaces" (oc new-project を使ってください)`, { 0: user })); code = 1; continue; }
          const targetNs = (d && d.metadata && d.metadata.namespace) || ns;
          const denied = d && d.kind !== 'Namespace' ? canAccess(cl, user, KINDS[d.kind] ? KINDS[d.kind].plural : 'resources', targetNs) : null;
          if (denied) { out.push(denied); code = 1; continue; }
          try { out.push(cl.apply(d, ns, { file: src.file, create, user })); } catch (e) { out.push(e.message); code = 1; }
        }
      }
    }
    return { out: out.join('\n'), code, err: code !== 0 && out.every(l => /^(error|Error|The )/.test(l)) };
  }

  function cmdDelete(cl, a, ns, ctx, user) {
    if (a.flags.f || a.flags.filename) {
      const out = [];
      for (const f of U.list(a.flags.f || a.flags.filename)) {
        let sources;
        try { sources = readManifests(ctx, f); } catch (e) { return fail(e.message); }
        for (const s of sources) for (const d of parseDocs(s.text, s.file)) {
          const k = KINDS[d.kind];
          if (!k) continue;
          const dns = (d.metadata && d.metadata.namespace) || ns;
          out.push(cl.remove(d.kind, dns, d.metadata.name) ? `${k.display} "${d.metadata.name}" deleted` : `Error from server (NotFound): error when deleting "${s.file}": ${k.plural} "${d.metadata.name}" not found`);
        }
      }
      cl.reconcile();
      return ok(out.join('\n'));
    }
    const targets = parseTargets(a.pos.slice(1));
    if (!targets.length) return fail('error: You must provide one or more resources by argument or filename.');
    const out = [];
    let code = 0;
    for (const t of targets) {
      if (!t.type) return fail(`error: the server doesn't have a resource type "${t.raw}"`);
      const denied = canAccess(cl, user, t.type, t.type === 'namespaces' || t.type === 'projects' ? null : ns);
      if (denied) { out.push(denied.replace('list', 'delete')); code = 1; continue; }
      let names = t.names;
      if (a.flags.all) names = (listFor(cl, t.type, ns, false, ctx.world) || []).filter(i => !i.sys && !(i.o && i.o.synthetic)).map(i => i.name);
      if (!names.length) return fail('error: resource(s) were provided, but no name was specified');
      for (const n of names) {
        if (t.type === 'pods') {
          const p = cl.pods.find(x => x.ns === ns && x.name === n);
          if (!p) { out.push(`Error from server (NotFound): pods "${n}" not found`); code = 1; continue; }
          cl.pods = cl.pods.filter(x => x !== p);
          if (!p.owner) cl.remove('Pod', ns, n);
          out.push(`pod "${n}" deleted`);
          continue;
        }
        if (t.type === 'nodes') { out.push(IG.t('ℹ ノードの削除はこのシミュレータでは無効化されています。')); continue; }
        const kind = KIND_OF[t.type];
        if (!kind) { out.push(`error: deleting ${t.type} is not supported in this simulator`); code = 1; continue; }
        if (cl.remove(kind, ns, n)) { out.push(`${t.type === 'projects' ? 'project.project.openshift.io' : KINDS[kind].display} "${n}" deleted`); ctx.world.emit(`${KINDS[kind].display}/${n} deleted (${cl.name})`, 'WARN'); }
        else { out.push(`Error from server (NotFound): ${t.type === 'deployments' ? 'deployments.apps' : t.type} "${n}" not found`); code = 1; }
      }
    }
    cl.reconcile();
    return { out: out.join('\n'), code, err: code && out.length === 1 };
  }

  function cmdRollout(cl, a, ns, w, user) {
    const sub = a.pos[1];
    const b = { pos: a.pos.slice(1), flags: a.flags };
    const r = deploymentFrom(cl, b, ns);
    if (r.error) return fail(r.error);
    const { d, name } = r;
    const hist = cl.deployHistory(ns, name);
    if (sub === 'status') {
      const s = deployStatus(cl, d);
      const settled = cl.healthy(ns, name);
      const lines = [];
      if (s.updatedReplicas < s.desired) lines.push(`Waiting for deployment "${name}" rollout to finish: ${s.updatedReplicas} out of ${s.desired} new replicas have been updated...`);
      if (s.replicas > s.updatedReplicas) lines.push(`Waiting for deployment "${name}" rollout to finish: ${s.replicas - s.updatedReplicas} old replicas are pending termination...`);
      if (s.availableReplicas < s.desired) lines.push(`Waiting for deployment "${name}" rollout to finish: ${s.availableReplicas} of ${s.desired} updated replicas are available...`);
      if (settled) { lines.push(`deployment "${name}" successfully rolled out`); return ok(lines.join('\n')); }
      lines.push(`error: deployment "${name}" exceeded its progress deadline`);
      return { out: lines.join('\n'), code: 1 };
    }
    if (sub === 'history') {
      const rev = U.first(a.flags.revision);
      if (rev) {
        const h = hist.find(x => String(x.rev) === String(rev));
        if (!h) return fail(`error: unable to find the specified revision`);
        return ok(`deployment.apps/${name} with revision #${rev}\nPod Template:\n${Y.stringify(h.template).trimEnd().split('\n').map(l => '  ' + l).join('\n')}`);
      }
      return ok(`deployment.apps/${name} \n` + U.table(['REVISION', 'CHANGE-CAUSE'], hist.map(h => [String(h.rev), h.cause || '<none>'])));
    }
    if (sub === 'undo') {
      const to = U.first(a.flags['to-revision']);
      let target;
      if (to && to !== '0') target = hist.find(h => String(h.rev) === String(to));
      else target = hist[hist.length - 2];
      if (!target) return fail(to ? `error: unable to find specified revision ${to} in history` : `error: no rollout history found for deployment "${name}"`);
      d.spec.template = U.clone(target.template);
      try { save(cl, d, user); } catch (e) { return fail(e.message); }
      w.emit(`deployment/${name} rolled back to revision ${target.rev}`, 'WARN');
      return ok(`deployment.apps/${name} rolled back`);
    }
    if (sub === 'restart') {
      d.spec.template.metadata.annotations = Object.assign({}, d.spec.template.metadata.annotations, { 'kubectl.kubernetes.io/restartedAt': new Date(w.now()).toISOString() });
      save(cl, d, user);
      return ok(`deployment.apps/${name} restarted`);
    }
    return fail(`error: unknown command "${sub || ''}" for "kubectl rollout"\nAvailable: history, restart, status, undo`);
  }

  /* ------------------------------------------------------------ main dispatcher */
  function kubectl(argv, ctx, flavor = 'kubectl') {
    const w = ctx.world;
    const a = U.args(argv, VF);
    const verb = a.pos[0];
    if (!verb || verb === 'help' || a.flags.help || a.flags.h) return ok(helpText(flavor));
    if (verb === 'version') {
      const cl0 = w.currentCluster();
      const client = flavor === 'oc' ? 'Client Version: 4.16.12\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3' : 'Client Version: v1.30.4\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3';
      if (!cl0) return { out: client + '\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?', code: 1 };
      return ok(`${client}\nServer Version: ${cl0.version}`);
    }
    if (verb === 'config') return cmdConfig(a, w);
    if (verb === 'api-resources') return ok(U.table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], [
      ['configmaps', 'cm', 'v1', 'true', 'ConfigMap'], ['endpoints', 'ep', 'v1', 'true', 'Endpoints'], ['events', 'ev', 'v1', 'true', 'Event'], ['namespaces', 'ns', 'v1', 'false', 'Namespace'],
      ['nodes', 'no', 'v1', 'false', 'Node'], ['pods', 'po', 'v1', 'true', 'Pod'], ['secrets', '', 'v1', 'true', 'Secret'], ['serviceaccounts', 'sa', 'v1', 'true', 'ServiceAccount'],
      ['services', 'svc', 'v1', 'true', 'Service'], ['deployments', 'deploy', 'apps/v1', 'true', 'Deployment'], ['replicasets', 'rs', 'apps/v1', 'true', 'ReplicaSet'],
      ...(w.currentCluster() && w.currentCluster().openshift ? [['routes', '', 'route.openshift.io/v1', 'true', 'Route']] : []),
    ]));
    if (verb === 'explain') return ok(explain(a.pos[1]));
    const cl = w.currentCluster();
    if (!cl) return fail(flavor === 'oc' ? 'error: Missing or incomplete configuration info.  Please login or point to an existing, complete config file:\n\n  1. Via the command-line flag --kubeconfig\n  2. Via the KUBECONFIG environment variable\n  3. In your home directory as ~/.kube/config\n\nTo view or setup config directly use the \'config\' command.' : 'E1024 01:02:03.123456   4242 memcache.go:265] couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?');
    const context = w.context();
    const user = context.user;
    const ns = U.first(a.flags.n || a.flags.namespace) || context.namespace || 'default';
    const allNs = !!(a.flags.A || a.flags['all-namespaces']);
    switch (verb) {
      case 'get': return cmdGet(cl, a, ns, allNs, w, user);
      case 'describe': return cmdDescribe(cl, a, ns, w, user);
      case 'apply': {
        const r = applyFiles(cl, a, ns, ctx, user, false);
        return r;
      }
      case 'create': return cmdCreate(cl, a, ns, ctx, user);
      case 'delete': return cmdDelete(cl, a, ns, ctx, user);
      case 'logs': {
        const denied = canAccess(cl, user, 'pods', ns);
        if (denied) return fail(denied);
        let target = a.pos[1];
        if (!target && typeof a.flags.p === 'string' && a.flags.p) target = a.flags.p;
        const sel = U.first(a.flags.l || a.flags.selector);
        if (!target && sel) { const p = cl.pods.find(x => x.ns === ns && selectorMatch(sel, x.labels)); if (!p) return ok('No resources found in ' + ns + ' namespace.'); target = p.name; }
        const r = findPod(cl, ns, target);
        if (r.error) return fail(r.error);
        const logs = cl.podLogs(r.pod, U.first(a.flags.c || a.flags.container));
        if (logs.error) return fail(logs.error);
        let text = logs.text;
        const tail = U.first(a.flags.tail);
        if (tail && Number(tail) >= 0) text = text.split('\n').slice(-Number(tail)).join('\n');
        return ok((r.note ? r.note + '\n' : '') + text + (a.flags.f || a.flags.follow ? IG.t('\nℹ -f（フォロー）は未対応のため現在までのログを表示しました。') : ''));
      }
      case 'exec': {
        const target = a.pos[1];
        const r = findPod(cl, ns, target);
        if (r.error) return fail(r.error.replace("'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'", "'exec (POD | TYPE/NAME) [-c CONTAINER] -- COMMAND [args...]'"));
        if (!a.rest.length) return fail('error: you must specify at least one command for the container');
        return podExec(ctx, cl, r.pod, a.rest, !!(a.flags.i || a.flags.t));
      }
      case 'run': {
        const name = a.pos[1];
        const image = U.first(a.flags.image);
        if (!name || !image) return fail('error: required flag(s) "image" not set');
        if (a.flags.rm) {
          const tmp = { name, ns, spec: { containers: [{ name, image }] }, labels: { run: name }, node: 'tmp', createdAt: -Infinity };
          const v = cl.containerVerdict(tmp).containers[0];
          if (v.state === 'pull') return { out: `pod "${name}" deleted\nerror: timed out waiting for the condition (ImagePullBackOff: ${v.message})`, code: 1 };
          const res = a.rest.length ? ctx.shell.runArgv(a.rest, { pod: { cluster: cl.name, ns, pod: name, env: v.env || {}, image } }) : { out: '' };
          return { out: [res.out, `pod "${name}" deleted`].filter(Boolean).join('\n'), code: res.code || 0 };
        }
        const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, labels: { run: name } }, spec: { containers: [{ name, image }] } };
        if (a.rest.length) pod.spec.containers[0].command = a.rest;
        if (a.flags.port) pod.spec.containers[0].ports = [{ containerPort: Number(U.first(a.flags.port)) }];
        try { cl.apply(pod, ns, { create: true, user }); } catch (e) { return fail(e.message); }
        return ok(`pod/${name} created`);
      }
      case 'edit': {
        const targets = parseTargets(a.pos.slice(1));
        const t = targets[0];
        if (!t || !t.type || !t.names[0]) return fail('error: resource(s) were provided, but no name was specified');
        const kind = KIND_OF[t.type];
        const obj = kind && cl.get(kind, KINDS[kind].ns ? ns : null, t.names[0]);
        if (!obj) return fail(`Error from server (NotFound): ${t.type} "${t.names[0]}" not found`);
        const editable = U.clone(obj);
        const header = '# Please edit the object below. Lines beginning with a \'#\' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n';
        const original = Y.stringify(editable);
        const path = `/tmp/kubectl-edit-${U.hex(t.names[0] + w.now(), 6)}.yaml`;
        ctx.vfs.write(path, header + original, { mkdirs: true });
        return {
          out: '', code: 0,
          editor: {
            path,
            onSave(text) {
              const body = text.split('\n').filter(l => !l.startsWith('#')).join('\n');
              if (!body.trim()) return { out: 'Edit cancelled, no changes made.' };
              let doc;
              try { doc = Y.parse(body); } catch (e) { return { out: `error: ${e.message}`, err: true }; }
              if (IG.k8s.stable(doc) === IG.k8s.stable(Y.parse(original))) return { out: 'Edit cancelled, no changes made.' };
              try { cl.apply(doc, ns, { user }); } catch (e) { return { out: `error: ${t.type} "${t.names[0]}" is invalid\n${e.message}`, err: true }; }
              return { out: `${KINDS[kind].display}/${t.names[0]} edited` };
            },
          },
        };
      }
      case 'scale': {
        const r = deploymentFrom(cl, a, ns);
        if (r.error) return fail(r.error);
        const n = U.first(a.flags.replicas);
        if (n === undefined || n === true) return fail('error: required flag(s) "replicas" not set');
        if (!/^\d+$/.test(String(n))) return fail(`error: invalid argument "${n}" for "--replicas" flag: strconv.ParseInt: parsing "${n}": invalid syntax`);
        r.d.spec.replicas = Number(n);
        save(cl, r.d, user);
        w.emit(`deployment/${r.name} scaled to ${n}`);
        return ok(`deployment.apps/${r.name} scaled`);
      }
      case 'set': {
        const what = a.pos[1];
        const b = { pos: a.pos.slice(1), flags: a.flags };
        const r = deploymentFrom(cl, b, ns);
        if (r.error) return fail(r.error);
        const pairs = a.pos.slice(r.d && a.pos[2] && a.pos[2].includes('/') ? 3 : 4);
        if (what === 'image') {
          if (!pairs.length) return fail('error: at least one image update is required');
          for (const pr of pairs) {
            const [cn, img] = pr.split('=');
            const cs = r.d.spec.template.spec.containers.filter(c => cn === '*' || c.name === cn);
            if (!cs.length) return fail(`error: unable to find container named "${cn}"`);
            cs.forEach(c => { c.image = img; });
          }
          if (a.flags.record) r.d.metadata.annotations = Object.assign({}, r.d.metadata.annotations, { 'kubernetes.io/change-cause': 'kubectl set image ' + a.pos.slice(2).join(' ') });
          save(cl, r.d, user);
          w.emit(`deployment/${r.name} image updated`);
          return ok(`deployment.apps/${r.name} image updated`);
        }
        if (what === 'env') {
          if (!pairs.length) return fail('error: at least one environment variable must be provided');
          for (const c of r.d.spec.template.spec.containers) {
            c.env = c.env || [];
            for (const pr of pairs) {
              if (pr.endsWith('-')) { c.env = c.env.filter(e => e.name !== pr.slice(0, -1)); continue; }
              const i = pr.indexOf('=');
              const k = pr.slice(0, i), v = pr.slice(i + 1);
              const ex = c.env.find(e => e.name === k);
              if (ex) { ex.value = v; delete ex.valueFrom; } else c.env.push({ name: k, value: v });
            }
            if (!c.env.length) delete c.env;
          }
          save(cl, r.d, user);
          return ok(`deployment.apps/${r.name} env updated`);
        }
        return fail(`error: unknown command "${what}" for "kubectl set" (image, env)`);
      }
      case 'rollout': return cmdRollout(cl, a, ns, w, user);
      case 'expose': {
        const targets = parseTargets(a.pos.slice(1));
        const t = targets[0];
        if (!t || !t.type || !t.names[0]) return fail('error: You must provide one or more resources by argument or filename.');
        if (t.type === 'services' && flavor === 'oc') return ocExposeRoute(cl, a, ns, t.names[0], user);
        let selector, port = U.first(a.flags.port);
        if (t.type === 'deployments') {
          const d = cl.get('Deployment', ns, t.names[0]);
          if (!d) return fail(`Error from server (NotFound): deployments.apps "${t.names[0]}" not found`);
          selector = d.spec.selector.matchLabels;
          port = port || (d.spec.template.spec.containers[0].ports || [])[0]?.containerPort;
        } else if (t.type === 'services') {
          const s = cl.get('Service', ns, t.names[0]);
          if (!s) return fail(`Error from server (NotFound): services "${t.names[0]}" not found`);
          selector = s.spec.selector; port = port || s.spec.ports[0].port;
        } else if (t.type === 'pods') {
          const p = cl.pods.find(x => x.ns === ns && x.name === t.names[0]);
          if (!p) return fail(`Error from server (NotFound): pods "${t.names[0]}" not found`);
          selector = p.labels; port = port || (p.spec.containers[0].ports || [])[0]?.containerPort;
        } else return fail(`error: cannot expose a ${t.raw}`);
        if (!port) return fail(`error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples`);
        const name = U.first(a.flags.name) || t.names[0];
        const tp = U.first(a.flags['target-port']);
        const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels: Object.assign({}, selector) }, spec: { type: U.first(a.flags.type) || 'ClusterIP', selector: Object.assign({}, selector), ports: [{ port: Number(port), targetPort: tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : Number(port), protocol: 'TCP' }] } };
        try { cl.apply(svc, ns, { create: true, user }); } catch (e) { return fail(e.message); }
        return ok(`service/${name} exposed`);
      }
      case 'patch': {
        const targets = parseTargets(a.pos.slice(1));
        const t = targets[0];
        const kind = t && KIND_OF[t.type];
        if (!kind) return fail('error: resource(s) were provided, but no name was specified');
        const obj = cl.get(kind, KINDS[kind].ns ? ns : null, t.names[0]);
        if (!obj) return fail(`Error from server (NotFound): ${t.type} "${t.names[0]}" not found`);
        const raw = U.first(a.flags.p || a.flags.patch);
        if (!raw || raw === true) return fail('error: must specify --patch or --patch-file containing the contents of the patch');
        let patch;
        try { patch = /^\s*\{/.test(raw) ? JSON.parse(raw) : Y.parse(raw); } catch (e) { return fail(`error: unable to parse "${raw}": ${e.message}`); }
        const merged = U.merge(obj, patch);
        try { const r = cl.apply(merged, ns, { user }); return ok(r.endsWith('unchanged') ? `${KINDS[kind].display}/${t.names[0]} patched (no change)` : `${KINDS[kind].display}/${t.names[0]} patched`); } catch (e) { return fail(e.message); }
      }
      case 'label': {
        const targets = parseTargets([a.pos[1], a.pos[1] && a.pos[1].includes('/') ? null : a.pos[2]].filter(Boolean));
        const t = targets[0];
        if (!t || !t.type) return fail('error: resource(s) were provided, but no name was specified');
        const kvs = a.pos.slice(a.pos[1].includes('/') ? 2 : 3);
        let labels, apply;
        if (t.type === 'pods') { const p = cl.pods.find(x => x.ns === ns && x.name === t.names[0]); if (!p) return fail(`Error from server (NotFound): pods "${t.names[0]}" not found`); labels = p.labels; apply = () => {}; }
        else if (t.type === 'nodes') { const n = cl.nodes.find(x => x.name === t.names[0]); if (!n) return fail(`Error from server (NotFound): nodes "${t.names[0]}" not found`); labels = n.labels; apply = () => cl.reconcile(); }
        else {
          const kind = KIND_OF[t.type];
          const obj = kind && cl.get(kind, KINDS[kind].ns ? ns : null, t.names[0]);
          if (!obj) return fail(`Error from server (NotFound): ${t.type} "${t.names[0]}" not found`);
          const c = U.clone(obj); c.metadata.labels = c.metadata.labels || {}; labels = c.metadata.labels; apply = () => cl.apply(c, ns, { user });
        }
        for (const kv of kvs) {
          if (kv.endsWith('-')) { delete labels[kv.slice(0, -1)]; continue; }
          const [k, v] = kv.split('=');
          if (k in labels && labels[k] !== v && !a.flags.overwrite) return fail(`error: '${k}' already has a value (${labels[k]}), and --overwrite is false`);
          labels[k] = v;
        }
        apply();
        return ok(`${SINGULAR[t.type] || t.type}/${t.names[0]} labeled`);
      }
      case 'cordon': case 'uncordon': case 'drain': {
        if (!(cl.users[user] || {}).admin) return fail(`Error from server (Forbidden): nodes "${a.pos[1]}" is forbidden: User "${user}" cannot patch resource "nodes" in API group "" at the cluster scope`);
        const n = cl.nodes.find(x => x.name === a.pos[1]);
        if (!n) return fail(`Error from server (NotFound): nodes "${a.pos[1]}" not found`);
        if (verb === 'uncordon') { const was = n.cordoned; n.cordoned = false; cl.reconcile(); return ok(`node/${n.name} ${was ? 'uncordoned' : 'already uncordoned'}`); }
        const was = n.cordoned; n.cordoned = true;
        if (verb === 'cordon') { cl.reconcile(); return ok(`node/${n.name} ${was ? 'already cordoned' : 'cordoned'}`); }
        const sys = cl.systemPods.filter(p => p.node === n.name && p.name.startsWith('kube-proxy') || p.node === n.name && p.name.startsWith('aws-node'));
        if (sys.length && !a.flags['ignore-daemonsets']) return { out: `node/${n.name} cordoned\nerror: unable to drain node "${n.name}" due to error: cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): kube-system/${sys[0].name}, continuing command...\nThere are pending nodes to be drained:\n ${n.name}`, code: 1 };
        const victims = cl.pods.filter(p => p.node === n.name);
        cl.pods = cl.pods.filter(p => p.node !== n.name);
        cl.reconcile();
        return ok([`node/${n.name} cordoned`, sys.length ? `Warning: ignoring DaemonSet-managed Pods: ${sys.map(p => 'kube-system/' + p.name).join(', ')}` : null, ...victims.map(p => `evicting pod ${p.ns}/${p.name}`), ...victims.map(p => `pod/${p.name} evicted`), `node/${n.name} drained`].filter(Boolean).join('\n'));
      }
      case 'top': {
        const what = TYPE_OF[a.pos[1]];
        if (what === 'nodes') {
          return ok(U.table(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], cl.nodes.map(n => {
            const u = cl.nodeAllocated(n); const s = cl.nodeState(n);
            if (!s.ready) return [n.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>'];
            const np = cl.pods.filter(p => p.node === n.name).length + cl.systemPods.filter(p => p.node === n.name).length;
            const cpu = Math.round(u.cpu * 0.6 + 90 + np * 28 + (U.hash(n.name) % 40)), mem = Math.round(u.mem * 0.7 + 700 + np * 96 + (U.hash(n.name) % 300));
            return [n.name, cpu + 'm', Math.round((cpu / n.cpu) * 100) + '%', mem + 'Mi', Math.round((mem / n.mem) * 100) + '%'];
          })));
        }
        if (what === 'pods') {
          const pods = cl.pods.filter(p => allNs || p.ns === ns).filter(p => cl.podStatus(p).display === 'Running');
          if (!pods.length) return ok(`No resources found in ${ns} namespace.`);
          return ok(U.table(['NAME', 'CPU(cores)', 'MEMORY(bytes)'], pods.map(p => { const r = cl.podRequests(p.spec); return [p.name, Math.round((r.cpu || 50) * 0.4 + (U.hash(p.name) % 9)) + 'm', Math.round((r.mem || 64) * 0.55 + (U.hash(p.name) % 13)) + 'Mi']; })));
        }
        return fail('error: unknown command "' + (a.pos[1] || '') + '" for "kubectl top" (nodes, pods)');
      }
      case 'wait': {
        const cond = U.first(a.flags.for) || '';
        const t = parseTargets(a.pos.slice(1))[0];
        if (!t || !t.names[0]) return fail('error: resource name may not be empty');
        if (t.type === 'deployments') {
          if (!cl.get('Deployment', ns, t.names[0])) return fail(`Error from server (NotFound): deployments.apps "${t.names[0]}" not found`);
          return cl.healthy(ns, t.names[0]) ? ok(`deployment.apps/${t.names[0]} condition met`) : fail(`error: timed out waiting for the condition on deployments/${t.names[0]}`);
        }
        if (t.type === 'pods') {
          const p = cl.pods.find(x => x.ns === ns && x.name === t.names[0]);
          if (!p) return fail(`Error from server (NotFound): pods "${t.names[0]}" not found`);
          return cl.podStatus(p, true).ready ? ok(`pod/${p.name} condition met`) : fail(`error: timed out waiting for the condition on pods/${p.name}`);
        }
        return fail(`error: wait for ${cond} on ${t.raw} is not supported in this simulator`);
      }
      case 'cluster-info':
        return ok(`Kubernetes control plane is running at ${cl.server}\nCoreDNS is running at ${cl.server}/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.`);
      case 'auth': {
        if (a.pos[1] !== 'can-i') return fail('error: unknown command "' + (a.pos[1] || '') + '" for "kubectl auth"');
        const res = TYPE_OF[a.pos[3]] || a.pos[3];
        const denied = canAccess(cl, user, res, res === 'nodes' ? null : ns);
        return denied ? { out: 'no', code: 1 } : ok('yes');
      }
      case 'port-forward':
        return fail(IG.t('ℹ port-forward はこのシミュレータでは未対応です。クラスタ内からの確認は `kubectl exec <pod> -- curl http://<service>:<port>` を使ってください。'));
      default:
        return fail(`error: unknown command "${verb}" for "${flavor}"\n\nDid you mean this?\n\t${['get', 'describe', 'logs', 'apply', 'delete', 'scale', 'rollout', 'exec', 'edit', 'create'].find(x => x[0] === verb[0]) || 'get'}`);
    }
  }

  function podExec(ctx, cl, pod, cmd, interactive) {
    const st = cl.podStatus(pod);
    if (st.display !== 'Running') return fail(`error: unable to upgrade connection: container not found ("${pod.spec.containers[0].name}")`);
    if (/^(\/bin\/)?(ba)?sh$/.test(cmd[0]) && cmd.length === 1) return fail(IG.t(`ℹ 対話シェル{0}はこのシミュレータでは未対応です。\n  例: kubectl exec {1} -- curl -s http://<service>:<port>/health`, { 0: interactive ? '（-it）' : '', 1: pod.owner ? 'deploy/' + pod.owner : pod.name }));
    let argv = cmd;
    if (/^(\/bin\/)?(ba)?sh$/.test(cmd[0]) && cmd[1] === '-c') return ctx.shell.exec(cmd.slice(2).join(' '), { pod: podCtx(cl, pod, st) });
    return ctx.shell.runArgv(argv, { pod: podCtx(cl, pod, st) });
  }
  function podCtx(cl, pod, st) {
    const c = st.verdict.containers[0];
    return { cluster: cl.name, ns: pod.ns, pod: pod.name, env: Object.assign({ HOSTNAME: pod.name, KUBERNETES_SERVICE_HOST: '10.96.0.1' }, c.env || {}), image: c.image, openshift: cl.openshift, ip: pod.ip };
  }

  function cmdConfig(a, w) {
    const sub = a.pos[1];
    const k = w.kube;
    switch (sub) {
      case 'current-context': return k.current ? ok(k.current) : fail('error: current-context is not set');
      case 'get-contexts': return ok(U.table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], Object.entries(k.contexts).map(([n, c]) => [n === k.current ? '*' : '', n, c.cluster, c.user, c.namespace || ''])));
      case 'use-context': {
        const n = a.pos[2];
        if (!k.contexts[n]) return fail(`error: no context exists with the name: "${n}"`);
        k.current = n; return ok(`Switched to context "${n}".`);
      }
      case 'set-context': {
        const n = a.flags.current ? k.current : a.pos[2];
        if (!n || !k.contexts[n]) return fail('error: current-context is not set');
        const ns = U.first(a.flags.namespace || a.flags.n);
        if (ns) k.contexts[n].namespace = ns;
        return ok(`Context "${n}" modified.`);
      }
      case 'view':
        return ok(Y.stringify({ apiVersion: 'v1', kind: 'Config', clusters: Object.values(k.contexts).map(c => ({ cluster: { server: w.clusters[c.cluster] ? w.clusters[c.cluster].server : '', 'certificate-authority-data': 'DATA+OMITTED' }, name: c.cluster })), contexts: Object.entries(k.contexts).map(([n, c]) => ({ context: { cluster: c.cluster, namespace: c.namespace, user: c.user }, name: n })), 'current-context': k.current || '', users: [...new Set(Object.values(k.contexts).map(c => c.user))].map(u => ({ name: u, user: { token: 'REDACTED' } })) }).trimEnd());
      default: return fail('error: unknown command "' + (sub || '') + '" for "kubectl config"\nAvailable: current-context, get-contexts, use-context, set-context, view');
    }
  }

  const EXPLAIN = {
    deployment: 'KIND:     Deployment\nVERSION:  apps/v1\n\nDESCRIPTION:\n     Deployment enables declarative updates for Pods and ReplicaSets.\n\nFIELDS:\n   apiVersion\t<string>\n   kind\t<string>\n   metadata\t<Object>\n   spec\t<Object>\n     Specification of the desired behavior of the Deployment.',
    'deployment.spec': 'FIELDS:\n   replicas\t<integer>\n     Number of desired pods. Defaults to 1.\n   selector\t<Object> -required-\n     Label selector for pods. Must match the pod template\'s labels.\n   template\t<Object> -required-\n     Template describes the pods that will be created.\n   strategy\t<Object>\n     The deployment strategy to use to replace existing pods with new ones.',
    'deployment.spec.replicas': 'FIELD:    replicas <integer>\n\nDESCRIPTION:\n     Number of desired pods. This is a pointer to distinguish between explicit\n     zero and not specified. Defaults to 1.',
    service: 'KIND:     Service\nVERSION:  v1\n\nFIELDS:\n   spec\t<Object>\n     selector\t<map[string]string>  Route service traffic to pods with label keys and values matching this selector.\n     ports\t<[]Object>  The list of ports that are exposed by this service.\n     type\t<string>  ClusterIP (default), NodePort, LoadBalancer, ExternalName.',
    'service.spec.ports.targetport': 'FIELD:    targetPort <IntOrString>\n\nDESCRIPTION:\n     Number or name of the port to access on the pods targeted by the service.\n     If this is a string, it will be looked up as a named port in the target\n     Pod\'s container ports. If not specified, the value of the \'port\' field is used.',
    pod: 'KIND:     Pod\nVERSION:  v1\n\nDESCRIPTION:\n     Pod is a collection of containers that can run on a host.',
    'pod.spec.imagepullsecrets': 'FIELD:    imagePullSecrets <[]LocalObjectReference>\n\nDESCRIPTION:\n     ImagePullSecrets is an optional list of references to secrets in the same\n     namespace to use for pulling any of the images used by this PodSpec.',
  };
  function explain(p) {
    if (!p) return IG.t('You must specify the type of resource to explain. 例: kubectl explain deployment.spec.replicas');
    const key = p.toLowerCase().replace(/^deployments?/, 'deployment').replace(/^svc|^services?/, 'service').replace(/^pods?/, 'pod').replace(/\.template\.spec/, '');
    return EXPLAIN[key] || EXPLAIN[key.split('.').slice(0, 2).join('.')] || IG.t(`ℹ このシミュレータに "{0}" の説明は収録されていません。実環境では kubectl explain {1} で API スキーマを確認できます。`, { 0: p, 1: p });
  }

  function helpText(flavor) {
    const n = flavor;
    return `${n} controls the ${flavor === 'oc' ? 'OpenShift' : 'Kubernetes'} cluster manager (simulated subset).

Basic Commands:
  get           Display one or many resources
  describe      Show details of a specific resource
  create        Create a resource (deployment, configmap, secret, namespace, service)
  apply         Apply a configuration to a resource by file name (-f)
  delete        Delete resources by file names or resources and names
  edit          Edit a resource in the editor
  expose        Expose a deployment as a service${flavor === 'oc' ? ' / a service as a route' : ''}
  run           Run a pod (use --rm -it ... -- <cmd> for one-off checks)

Deploy Commands:
  rollout       status | history | undo | restart
  scale         Set a new size for a deployment
  set           image | env

Troubleshooting:
  logs          Print the logs for a container in a pod
  exec          Execute a command in a container (exec POD -- CMD)
  top           Display resource usage (nodes | pods)
  explain       Get documentation for a resource

Cluster Management:
  cordon / uncordon / drain    Node maintenance
  config        current-context | get-contexts | use-context | set-context --current --namespace=NS
${flavor === 'oc' ? `
OpenShift:
  login / logout / whoami / project / projects / new-project / new-app / status
  adm policy add-scc-to-user <scc> -z <serviceaccount>
` : ''}
Global flags: -n NAMESPACE, -A, -o wide|yaml|json|name|jsonpath=..., -l key=value`;
  }

  /* ------------------------------------------------------------ oc */
  function ocExposeRoute(cl, a, ns, svcName, user) {
    const svc = cl.get('Service', ns, svcName);
    if (!svc) return fail(`Error from server (NotFound): services "${svcName}" not found`);
    const name = U.first(a.flags.name) || svcName;
    const r = { apiVersion: 'route.openshift.io/v1', kind: 'Route', metadata: { name, namespace: ns, labels: Object.assign({}, svc.metadata.labels) }, spec: { to: { kind: 'Service', name: svcName } } };
    if (a.flags.hostname) r.spec.host = U.first(a.flags.hostname);
    if (a.flags.port) r.spec.port = { targetPort: /^\d+$/.test(U.first(a.flags.port)) ? Number(U.first(a.flags.port)) : U.first(a.flags.port) };
    try { cl.apply(r, ns, { create: true, user }); } catch (e) { return fail(e.message); }
    return ok(`route.route.openshift.io/${name} exposed`);
  }

  function oc(argv, ctx) {
    const w = ctx.world;
    const a = U.args(argv, VF);
    const verb = a.pos[0];
    const ocp = Object.values(w.clusters).find(c => c.openshift);
    const context = w.context();
    const cl = w.currentCluster();
    switch (verb) {
      case 'login': {
        const server = a.pos[1] || U.first(a.flags.server || a.flags.s);
        let target = ocp;
        if (server) target = Object.values(w.clusters).find(c => c.server.replace(/\/$/, '') === server.replace(/\/$/, '') || c.apiHost() === server.replace(/^https?:\/\//, '').replace(/:\d+$/, ''));
        if (!target) return fail(`error: dial tcp: lookup ${String(server).replace(/^https?:\/\//, '').replace(/:\d+$/, '')}: no such host - verify you have provided the correct host and port and that the server is currently running.`);
        if (!target.openshift) return fail('error: the server is not an OpenShift cluster (use kubectl / aws eks update-kubeconfig)');
        const u = U.first(a.flags.u || a.flags.username);
        const p = U.first(a.flags.p || a.flags.password);
        const token = U.first(a.flags.token);
        let user = null;
        if (token) user = Object.entries(target.users).find(([, x]) => x.token === token)?.[0];
        else if (u) user = target.users[u] && target.users[u].password === p ? u : null;
        else return fail(IG.t('ℹ ユーザー名とパスワードを指定してください: oc login ') + target.server + ' -u <user> -p <password>');
        if (!user) return fail('Login failed (401 Unauthorized)\nVerify you have provided the correct credentials.');
        const projects = [...(target.projectsOf[user] || [])].sort();
        const isAdmin = target.users[user].admin;
        const ns = projects[0] || 'default';
        w.addContext(`${ns}/${target.apiHost().replace(/\./g, '-')}:6443/${user}`, target.name, ns, user);
        w.emit(`oc login: ${user}@${target.name}`);
        const lines = ['Login successful.', ''];
        if (isAdmin) lines.push('You have access to ' + (target.list('Namespace').length + 61) + ' projects, the list has been suppressed. You can list all projects with \'oc projects\'', '', `Using project "${ns}".`);
        else if (!projects.length) lines.push("You don't have any projects. You can try to create a new project, by running", '', '    oc new-project <projectname>');
        else lines.push(projects.length > 1 ? 'You have access to the following projects and can switch between them with \'oc project <projectname>\':\n\n' + projects.map(x => (x === ns ? '  * ' : '    ') + x).join('\n') + '\n' : `You have one project on this server: "${ns}"`, '', `Using project "${ns}".`);
        return ok(lines.join('\n'));
      }
      case 'logout': {
        if (!context) return fail('error: You must have a token in order to logout.');
        const name = w.kube.current;
        const u = context.user;
        delete w.kube.contexts[name]; w.kube.current = null;
        return ok(`Logged "${u}" out on "${cl ? cl.server : ''}"`);
      }
      case 'whoami':
        if (!cl || !cl.openshift) return fail('error: You must be logged in to the server (Unauthorized)');
        if (a.flags['show-server']) return ok(cl.server);
        if (a.flags['show-console']) return ok(`https://console-openshift-console.${cl.appsDomain}`);
        return ok(context.user);
      case 'project': {
        if (!cl) return fail('error: You must be logged in to the server (Unauthorized)');
        const target = a.pos[1];
        if (!target) return ok(`Using project "${context.namespace}" on server "${cl.server}".`);
        const has = (cl.users[context.user] || {}).admin ? !!cl.get('Namespace', null, target) : cl.projectsOf[context.user] && cl.projectsOf[context.user].has(target);
        if (!has) return fail(`error: A project named "${target}" does not exist on "${cl.server}".\nYour projects are:\n${[...(cl.projectsOf[context.user] || [])].map(p => '* ' + p).join('\n') || '(none)'}`);
        context.namespace = target;
        return ok(`Now using project "${target}" on server "${cl.server}".`);
      }
      case 'projects': {
        if (!cl) return fail('error: You must be logged in to the server (Unauthorized)');
        const ps = (cl.users[context.user] || {}).admin ? cl.list('Namespace').map(n => n.metadata.name) : [...(cl.projectsOf[context.user] || [])].sort();
        if (!ps.length) return ok("You are not a member of any projects. You can request a project to be created with the 'new-project' command.");
        return ok('You have access to the following projects and can switch between them with \' project <projectname>\':\n\n' + ps.map(p => (p === context.namespace ? '  * ' : '    ') + p).join('\n') + `\n\nUsing project "${context.namespace}" on server "${cl.server}".`);
      }
      case 'new-project': {
        if (!cl || !cl.openshift) return fail('error: You must be logged in to the server (Unauthorized)');
        const name = a.pos[1];
        if (!name) return fail('error: must have exactly one argument');
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) return fail(`The ProjectRequest "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-'`);
        if (cl.get('Namespace', null, name)) return fail(`Error from server (AlreadyExists): project.project.openshift.io "${name}" already exists`);
        cl.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, annotations: { 'openshift.io/requester': context.user } } }, null, { user: context.user });
        context.namespace = name;
        return ok(`Now using project "${name}" on server "${cl.server}".\n\nYou can add applications to this project with the 'new-app' command. For example, try:\n\n    oc new-app rails-postgresql-example\n\nto build a new example application in Ruby. Or use kubectl to deploy a simple Kubernetes application:\n\n    kubectl create deployment hello-node --image=registry.k8s.io/e2e-test-images/agnhost:2.43 -- /agnhost serve-hostname`);
      }
      case 'new-app': {
        if (!cl || !cl.openshift) return fail('error: You must be logged in to the server (Unauthorized)');
        const ns = U.first(a.flags.n || a.flags.namespace) || context.namespace;
        const image = a.pos[1] || U.first(a.flags.image);
        if (!image) return fail('error: You must specify one or more images, image streams, templates, or source code locations to create an application.');
        const pull = w.pullImage(image, {});
        if (!pull.ok) return fail(`error: unable to locate any images in image streams, local docker images with name "${image}"\n\nThe 'oc new-app' command will match arguments to the following types:\n\n  1. Images tagged into image streams in the current project or the 'openshift' project\n  2. Images in the Docker Hub, on remote registries, or on the local Docker engine`);
        const parsed = IG.images.parse(image);
        const name = U.first(a.flags.name) || parsed.name.split('/').pop();
        const labels = { app: name, 'app.kubernetes.io/component': name, 'app.kubernetes.io/instance': name };
        const port = pull.meta.port;
        const env = U.list(a.flags.e || a.flags.env).map(kv => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1) }; });
        const dep = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels: Object.assign({}, labels) }, spec: { replicas: 1, selector: { matchLabels: { deployment: name } }, template: { metadata: { labels: { deployment: name } }, spec: { containers: [Object.assign({ name, image }, port ? { ports: [{ containerPort: port, protocol: 'TCP' }] } : {}, env.length ? { env } : {})] } } } };
        try {
          cl.apply(dep, ns, { create: true, user: context.user });
          if (port) cl.apply({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels: Object.assign({}, labels) }, spec: { selector: { deployment: name }, ports: [{ name: `${port}-tcp`, port, targetPort: port, protocol: 'TCP' }] } }, ns, { create: true, user: context.user });
        } catch (e) { return fail(e.message); }
        return ok(`--> Found container image ${IG.images.id(image).slice(0, 7)} (12 days old) from ${parsed.host || 'Docker Hub'} for "${image}"\n\n    * An image stream tag will be created as "${name}:${parsed.tag}" that will track this image\n\n--> Creating resources ...\n    deployment.apps "${name}" created\n${port ? `    service "${name}" created\n` : ''}--> Success\n    Application is not exposed. You can expose services to the outside world by executing one or more of the commands below:\n     'oc expose service/${name}' \n    Run 'oc status' to view your app.`);
      }
      case 'expose': {
        if (!cl) break;
        const t = parseTargets(a.pos.slice(1))[0];
        const ns = U.first(a.flags.n || a.flags.namespace) || context.namespace;
        if (t && t.type === 'services' && t.names[0]) return ocExposeRoute(cl, a, ns, t.names[0], context.user);
        break;
      }
      case 'status': {
        if (!cl || !cl.openshift) return fail('error: You must be logged in to the server (Unauthorized)');
        const ns = context.namespace;
        const lines = [`In project ${ns} on server ${cl.server}`, ''];
        for (const s of cl.list('Service', ns)) {
          const route = cl.list('Route', ns).find(r => r.spec.to.name === s.metadata.name);
          lines.push(`${route ? `${route.spec.tls ? 'https' : 'http'}://${route.spec.host} to pod port ${s.spec.ports[0].targetPort}` : `svc/${s.metadata.name}`} (svc/${s.metadata.name})`);
          for (const d of cl.list('Deployment', ns).filter(d => IG.k8s.matches(s.spec.selector, d.spec.template.metadata.labels))) {
            const st = deployStatus(cl, d);
            lines.push(`  deployment/${d.metadata.name} deploys ${d.spec.template.spec.containers[0].image}`, `    deployment #${cl.deployHistory(ns, d.metadata.name).slice(-1)[0]?.rev || 1} running for ${ageOf(d.metadata.creationTimestamp, w)} - ${st.readyReplicas} pod${st.readyReplicas === 1 ? '' : 's'}`);
          }
          lines.push('');
        }
        const crash = cl.pods.filter(p => p.ns === ns && cl.podStatus(p).reason === 'CrashLoopBackOff');
        if (crash.length) lines.push(`Errors:\n  pod/${crash[0].name} is crash-looping\n\n    The container is starting and exiting repeatedly. This usually means the container is unable\n    to start, misconfigured, or limited by security restrictions. Check the container logs with\n\n      oc logs ${crash[0].name}`);
        lines.push("View details with 'oc describe <resource>/<name>' or list resources with 'oc get all'.");
        return ok(lines.join('\n'));
      }
      case 'adm': {
        if (!cl || !cl.openshift) return fail('error: You must be logged in to the server (Unauthorized)');
        if (a.pos[1] === 'policy' && a.pos[2] === 'add-scc-to-user') {
          const scc = a.pos[3];
          const sa = U.first(a.flags.z || a.flags.serviceaccount);
          const ns = U.first(a.flags.n || a.flags.namespace) || context.namespace;
          if (!(cl.users[context.user] || {}).admin) return fail(`Error from server (Forbidden): clusterroles.rbac.authorization.k8s.io "system:openshift:scc:${scc}" is forbidden: User "${context.user}" cannot get resource "clusterroles" in API group "rbac.authorization.k8s.io" at the cluster scope`);
          if (!sa) return fail('error: you must specify at least one user or service account');
          if (scc === 'anyuid' || scc === 'privileged') cl.anyuid.add(ns + '/' + sa);
          return ok(`clusterrole.rbac.authorization.k8s.io/system:openshift:scc:${scc} added: "${sa}"`);
        }
        return fail(IG.t('ℹ このシミュレータの oc adm は "policy add-scc-to-user" のみ対応しています。'));
      }
      case 'rsh': case 'debug':
        return fail(IG.t(`ℹ oc {0} の対話シェルは未対応です。oc exec <pod> -- <command> を使ってください。`, { 0: verb }));
      case 'get':
        if (['projects', 'project'].includes(a.pos[1]) && cl) {
          const ps = (cl.users[context.user] || {}).admin ? cl.list('Namespace').map(n => n.metadata.name) : [...(cl.projectsOf[context.user] || [])].sort();
          return ok(ps.length ? U.table(['NAME', 'DISPLAY NAME', 'STATUS'], ps.map(p => [p, '', 'Active'])) : 'No resources found.');
        }
        break;
    }
    if (!cl && !['version', 'config', 'help', 'explain', 'api-resources', undefined].includes(verb) && !a.flags.help) return fail(IG.t('error: You must be logged in to the server (Unauthorized)\n\nℹ まず oc login <server> -u <user> -p <password> でログインしてください。'));
    return kubectl(argv, ctx, 'oc');
  }

  IG.commands.kubectl = (argv, ctx) => kubectl(argv, ctx, 'kubectl');
  IG.commands.k = IG.commands.kubectl;
  IG.commands.oc = oc;
  IG.kubectlTypes = Object.keys(TYPE_OF);
  IG.kubectlVerbs = ['get', 'describe', 'logs', 'apply', 'create', 'delete', 'edit', 'exec', 'expose', 'scale', 'set', 'rollout', 'run', 'patch', 'label', 'top', 'cordon', 'uncordon', 'drain', 'config', 'cluster-info', 'version', 'explain', 'api-resources', 'wait', 'auth'];
  IG.ocVerbs = IG.kubectlVerbs.concat(['login', 'logout', 'whoami', 'project', 'projects', 'new-project', 'new-app', 'status', 'adm']);
})(globalThis.IG = globalThis.IG || {});
