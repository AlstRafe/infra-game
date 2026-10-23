/* Kubernetes / OpenShift cluster model. Desired state lives in `objects` (plain manifests);
 * pods are derived by reconcile() and their status is computed from the world on demand. */
(function (IG) {
  'use strict';
  const U = IG.util;

  const KINDS = {
    Namespace: { plural: 'namespaces', api: 'v1', ns: false, display: 'namespace' },
    Deployment: { plural: 'deployments', api: 'apps/v1', ns: true, display: 'deployment.apps' },
    Service: { plural: 'services', api: 'v1', ns: true, display: 'service' },
    ConfigMap: { plural: 'configmaps', api: 'v1', ns: true, display: 'configmap' },
    Secret: { plural: 'secrets', api: 'v1', ns: true, display: 'secret' },
    Pod: { plural: 'pods', api: 'v1', ns: true, display: 'pod' },
    Route: { plural: 'routes', api: 'route.openshift.io/v1', ns: true, display: 'route.route.openshift.io', openshift: true },
  };
  const KNOWN_FIELDS = {
    'Deployment.spec': ['replicas', 'selector', 'template', 'strategy', 'minReadySeconds', 'revisionHistoryLimit', 'paused', 'progressDeadlineSeconds'],
    'Service.spec': ['selector', 'ports', 'type', 'clusterIP', 'clusterIPs', 'sessionAffinity', 'externalTrafficPolicy', 'ipFamilies', 'ipFamilyPolicy', 'internalTrafficPolicy', 'loadBalancerSourceRanges'],
    container: ['name', 'image', 'ports', 'env', 'envFrom', 'resources', 'command', 'args', 'readinessProbe', 'livenessProbe', 'startupProbe', 'imagePullPolicy', 'volumeMounts', 'securityContext', 'workingDir', 'lifecycle', 'stdin', 'tty'],
    metadata: ['name', 'namespace', 'labels', 'annotations', 'creationTimestamp', 'uid', 'resourceVersion', 'generation', 'generateName', 'ownerReferences', 'finalizers', 'managedFields'],
  };

  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (U.isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  const matches = (selector, labels) => !!selector && Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels && labels[k] === v);

  class ApiError extends Error {}

  class Cluster {
    constructor(world, o) {
      this.world = world;
      this.name = o.name;
      this.server = o.server || `https://${o.name}.lab.local:6443`;
      this.openshift = !!o.openshift;
      this.flavor = o.flavor || (o.openshift ? 'openshift' : 'kubernetes');
      this.version = o.version || (o.openshift ? 'v1.29.8+f10c92d' : 'v1.30.4');
      this.appsDomain = o.appsDomain || 'apps.' + o.name + '.lab.local';
      this.users = o.users || { admin: { admin: true } };
      this.created = world.now() - 40 * 86400e3;
      this.objects = new Map();
      this.pods = [];
      this.history = new Map();
      this.events = [];
      this.anyuid = new Set();
      this.projectsOf = {}; // openshift: user -> Set(ns)
      this.seq = 1;
      this.rr = 0;
      this.nodes = (o.nodes || [{ name: 'worker-1' }, { name: 'worker-2' }]).map((n, i) => Object.assign({
        role: 'worker', cpu: 4000, mem: 8192, ready: true, cordoned: false, labels: {}, taints: [],
        ip: `10.0.${o.subnet || 1}.${11 + i}`, index: i + 1, created: this.created,
      }, n));
      for (const ns of ['default', 'kube-system', 'kube-public'].concat(o.namespaces || [])) this.ensureNamespace(ns, true);
      this.systemPods = this.makeSystemPods();
    }

    /* ------------------------------------------------------------ objects */
    key(kind, ns, name) { return `${kind}/${KINDS[kind] && KINDS[kind].ns ? ns : ''}/${name}`; }
    get(kind, ns, name) { return this.objects.get(this.key(kind, ns, name)) || null; }
    list(kind, ns) {
      const out = [];
      for (const o of this.objects.values()) if (o.kind === kind && (ns == null || !KINDS[kind].ns || o.metadata.namespace === ns)) out.push(o);
      return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    }
    ensureNamespace(name, system) {
      if (this.get('Namespace', null, name)) return;
      this.store({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { 'kubernetes.io/metadata.name': name } } }, system ? this.created : null);
    }
    store(obj, created) {
      const md = obj.metadata;
      const prev = this.get(obj.kind, md.namespace, md.name);
      md.creationTimestamp = prev ? prev.metadata.creationTimestamp : new Date(created || this.world.stamp()).toISOString();
      md.uid = prev ? prev.metadata.uid : U.hex('uid:' + this.name + obj.kind + md.namespace + md.name, 8) + '-' + U.hex(md.name, 4) + '-4' + U.hex(md.name + 1, 3) + '-a' + U.hex(md.name + 2, 3) + '-' + U.hex(md.name + 3, 12);
      md.resourceVersion = String(1000 + this.seq++ * 7);
      if (obj.kind === 'Deployment') md.generation = prev ? (prev.metadata.generation || 1) + (stable(prev.spec) !== stable(obj.spec) ? 1 : 0) : 1;
      this.objects.set(this.key(obj.kind, md.namespace, md.name), obj);
      return obj;
    }
    remove(kind, ns, name) {
      const k = this.key(kind, ns, name);
      if (!this.objects.has(k)) return false;
      this.objects.delete(k);
      if (kind === 'Deployment') { this.pods = this.pods.filter(p => !(p.ns === ns && p.owner === name)); this.history.delete(ns + '/' + name); }
      if (kind === 'Pod') this.pods = this.pods.filter(p => !(p.ns === ns && p.name === name));
      if (kind === 'Namespace') {
        for (const [key, o] of [...this.objects]) if (o.metadata.namespace === name) this.objects.delete(key);
        this.pods = this.pods.filter(p => p.ns !== name);
      }
      return true;
    }
    stripForCompare(o) { const c = U.clone(o); delete c.status; if (c.metadata) { for (const k of ['creationTimestamp', 'uid', 'resourceVersion', 'generation', 'managedFields']) delete c.metadata[k]; if (c.metadata.annotations) delete c.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']; } return c; }

    // Validate + store a manifest. Returns "<display>/<name> created|configured|unchanged".
    apply(manifest, defaultNs, opt = {}) {
      if (!U.isObj(manifest)) throw new ApiError('error: unable to decode: Object \'Kind\' is missing');
      const kind = manifest.kind;
      const spec = KINDS[kind];
      if (!kind) throw new ApiError(`error: unable to decode "${opt.file || '-'}": Object 'Kind' is missing in '${JSON.stringify(manifest).slice(0, 80)}'`);
      if (!spec || (spec.openshift && !this.openshift) || manifest.apiVersion !== spec.api) {
        throw new ApiError(`error: resource mapping not found for name: "${manifest.metadata && manifest.metadata.name}" namespace: "${(manifest.metadata && manifest.metadata.namespace) || ''}" from "${opt.file || '-'}": no matches for kind "${kind}" in version "${manifest.apiVersion}"\nensure CRDs are installed first`);
      }
      const md = manifest.metadata = manifest.metadata || {};
      if (!md.name) throw new ApiError(`error: error when retrieving current configuration of:\nResource: "${spec.plural}", GroupVersionKind: "${kind}"\nName: "", Namespace: "${defaultNs}"\nfrom server for: "${opt.file || '-'}": resource name may not be empty`);
      if (spec.ns) {
        md.namespace = md.namespace || defaultNs;
        if (!this.get('Namespace', null, md.namespace)) throw new ApiError(`Error from server (NotFound): error when creating "${opt.file || '-'}": namespaces "${md.namespace}" not found`);
      } else delete md.namespace;
      this.validate(manifest, opt);
      const prev = this.get(kind, md.namespace, md.name);
      if (opt.create && prev) throw new ApiError(`Error from server (AlreadyExists): error when creating "${opt.file || '-'}": ${spec.plural.replace(/s$/, '')}s "${md.name}" already exists`);
      const label = `${spec.display}/${md.name}`;
      if (prev && stable(this.stripForCompare(prev)) === stable(this.stripForCompare(manifest))) return `${label} unchanged`;
      if (prev && kind === 'Deployment' && stable(prev.spec.selector) !== stable(manifest.spec.selector)) {
        throw new ApiError(`The Deployment "${md.name}" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries(manifest.spec.selector.matchLabels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}}: field is immutable`);
      }
      const obj = U.clone(manifest);
      delete obj.status;
      if (kind === 'Service') this.prepareService(obj, prev);
      if (kind === 'Route') this.prepareRoute(obj);
      if (kind === 'Secret' && obj.stringData) { obj.data = Object.assign({}, obj.data || {}); for (const [k, v] of Object.entries(obj.stringData)) obj.data[k] = U.b64(String(v)); delete obj.stringData; }
      if (kind === 'Secret' && !obj.type) obj.type = 'Opaque';
      if (kind === 'Namespace' && this.openshift && opt.user) (this.projectsOf[opt.user] = this.projectsOf[opt.user] || new Set()).add(md.name);
      this.store(obj);
      if (kind === 'Pod') this.createBarePod(obj);
      this.reconcile();
      if (!this.world.bootstrap) this.world.emit(`${label} ${prev ? 'configured' : 'created'} (${this.name})`);
      return `${label} ${prev ? 'configured' : 'created'}`;
    }
    validate(m, opt) {
      const where = `error validating "${opt.file || '-'}": error validating data`;
      const unknown = (path, obj, allowed) => {
        if (!U.isObj(obj)) return;
        for (const k of Object.keys(obj)) if (!allowed.includes(k)) {
          throw new ApiError(`Error from server (BadRequest): error when creating "${opt.file || '-'}": ${m.kind} in version "${m.apiVersion.split('/').pop()}" cannot be handled as a ${m.kind}: strict decoding error: unknown field "${path}.${k}"`);
        }
      };
      unknown('metadata', m.metadata, KNOWN_FIELDS.metadata);
      if (m.kind === 'Deployment') {
        const s = m.spec;
        if (!U.isObj(s)) throw new ApiError(`error: ${where}: ValidationError(Deployment): missing required field "spec" in io.k8s.api.apps.v1.Deployment`);
        unknown('spec', s, KNOWN_FIELDS['Deployment.spec']);
        if (s.replicas !== undefined && !Number.isInteger(s.replicas)) throw new ApiError(`error: ${where}: ValidationError(Deployment.spec.replicas): invalid type for io.k8s.api.apps.v1.DeploymentSpec.replicas: got "${typeof s.replicas}", expected "integer"`);
        if (!s.selector) throw new ApiError(`error: ${where}: ValidationError(Deployment.spec): missing required field "selector" in io.k8s.api.apps.v1.DeploymentSpec`);
        if (!s.template || !U.isObj(s.template.spec)) throw new ApiError(`error: ${where}: ValidationError(Deployment.spec): missing required field "template" in io.k8s.api.apps.v1.DeploymentSpec`);
        const tl = (s.template.metadata && s.template.metadata.labels) || {};
        if (!matches(s.selector.matchLabels, tl)) {
          throw new ApiError(`The Deployment "${m.metadata.name}" is invalid: spec.template.metadata.labels: Invalid value: map[string]string{${Object.entries(tl).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``);
        }
        this.validatePodSpec(s.template.spec, 'spec.template.spec', m, where);
      }
      if (m.kind === 'Pod') this.validatePodSpec(m.spec || {}, 'spec', m, where);
      if (m.kind === 'Service') {
        const s = m.spec || {};
        unknown('spec', s, KNOWN_FIELDS['Service.spec']);
        if (!Array.isArray(s.ports) || !s.ports.length) throw new ApiError(`The Service "${m.metadata.name}" is invalid: spec.ports: Required value`);
        s.ports.forEach((p, i) => {
          if (!Number.isInteger(p.port)) throw new ApiError(`The Service "${m.metadata.name}" is invalid: spec.ports[${i}].port: Invalid value: ${JSON.stringify(p.port)}: must be between 1 and 65535, inclusive`);
        });
      }
      if (m.kind === 'Route' && !(m.spec && m.spec.to && m.spec.to.name)) throw new ApiError(`The Route "${m.metadata.name}" is invalid: spec.to.name: Required value`);
    }
    validatePodSpec(ps, path, m, where) {
      if (!Array.isArray(ps.containers) || !ps.containers.length) throw new ApiError(`The ${m.kind} "${m.metadata.name}" is invalid: ${path}.containers: Required value`);
      ps.containers.forEach((c, i) => {
        if (!U.isObj(c)) throw new ApiError(`error: ${where}: ValidationError(${m.kind}.${path}.containers[${i}]): invalid type, expected "object"`);
        for (const k of Object.keys(c)) if (!KNOWN_FIELDS.container.includes(k)) {
          throw new ApiError(`Error from server (BadRequest): error when creating "-": ${m.kind} in version "${m.apiVersion.split('/').pop()}" cannot be handled as a ${m.kind}: strict decoding error: unknown field "${path}.containers[${i}].${k}"`);
        }
        if (!c.name) throw new ApiError(`The ${m.kind} "${m.metadata.name}" is invalid: ${path}.containers[${i}].name: Required value`);
        if (!c.image) throw new ApiError(`The ${m.kind} "${m.metadata.name}" is invalid: ${path}.containers[${i}].image: Required value`);
        (c.ports || []).forEach((p, j) => { if (!Number.isInteger(p.containerPort)) throw new ApiError(`The ${m.kind} "${m.metadata.name}" is invalid: ${path}.containers[${i}].ports[${j}].containerPort: Required value`); });
      });
    }
    prepareService(obj, prev) {
      const s = obj.spec;
      s.type = s.type || 'ClusterIP';
      s.clusterIP = (prev && prev.spec.clusterIP) || s.clusterIP || `10.96.${(U.hash(obj.metadata.namespace + obj.metadata.name) % 200) + 10}.${(U.hash(obj.metadata.name) % 240) + 10}`;
      s.ports = s.ports.map(p => Object.assign({ protocol: 'TCP' }, p, { targetPort: p.targetPort ?? p.port }));
      if (s.type === 'NodePort' || s.type === 'LoadBalancer') s.ports.forEach((p, i) => { if (!p.nodePort) p.nodePort = 30000 + (U.hash(obj.metadata.name + i) % 2700); });
    }
    prepareRoute(obj) {
      const md = obj.metadata;
      obj.spec.host = obj.spec.host || `${md.name}-${md.namespace}.${this.appsDomain}`;
      obj.spec.to = Object.assign({ kind: 'Service', weight: 100 }, obj.spec.to);
      obj.spec.wildcardPolicy = obj.spec.wildcardPolicy || 'None';
    }

    /* ------------------------------------------------------------ nodes */
    nodeState(n) {
      const host = n.host ? this.world.hosts[n.host] : null;
      const kubelet = host ? host.services.kubelet !== 'inactive' : true;
      const diskPressure = host ? host.diskPct() >= 85 : !!n.diskPressure;
      const ready = n.ready && kubelet;
      const taints = n.taints.slice();
      if (n.role === 'control-plane') taints.push({ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' });
      if (diskPressure) taints.push({ key: 'node.kubernetes.io/disk-pressure', effect: 'NoSchedule' });
      if (!ready) taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' });
      if (n.cordoned) taints.push({ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' });
      return { ready, diskPressure, taints, kubelet, diskPct: host ? host.diskPct() : 40 };
    }
    podRequests(spec) {
      let cpu = 0, mem = 0;
      for (const c of spec.containers || []) { const r = (c.resources && c.resources.requests) || {}; cpu += U.cpu(r.cpu); mem += U.mem(r.memory); }
      return { cpu, mem };
    }
    nodeAllocated(n) {
      let cpu = 0, mem = 0;
      for (const p of this.pods) if (p.node === n.name) { const r = this.podRequests(p.spec); cpu += r.cpu; mem += r.mem; }
      return { cpu, mem };
    }
    schedule(pod) {
      const req = this.podRequests(pod.spec);
      const reasons = {};
      const add = r => { reasons[r] = (reasons[r] || 0) + 1; };
      const fits = [];
      for (const n of this.nodes) {
        const st = this.nodeState(n);
        const blocking = st.taints.find(t => t.effect === 'NoSchedule' && !(pod.spec.tolerations || []).some(tl => tl.key === t.key || tl.operator === 'Exists' && !tl.key));
        if (blocking) { add(blocking.key === 'node.kubernetes.io/unschedulable' ? 'node(s) were unschedulable' : `node(s) had untolerated taint {${blocking.key}: }`); continue; }
        const sel = pod.spec.nodeSelector;
        if (sel && !Object.entries(sel).every(([k, v]) => (n.labels[k] ?? (k === 'kubernetes.io/hostname' ? n.name : undefined)) === v)) { add("node(s) didn't match Pod's node affinity/selector"); continue; }
        const used = this.nodeAllocated(n);
        const cpuOk = used.cpu + req.cpu <= n.cpu, memOk = used.mem + req.mem <= n.mem;
        if (!cpuOk) add('Insufficient cpu');
        if (!memOk) add('Insufficient memory');
        if (cpuOk && memOk) fits.push({ n, free: n.cpu - used.cpu - req.cpu, count: this.pods.filter(p => p.node === n.name).length });
      }
      if (!fits.length) {
        const parts = Object.entries(reasons).map(([r, c]) => `${c} ${r}`);
        pod.node = null;
        pod.schedMsg = `0/${this.nodes.length} nodes are available: ${parts.join(', ')}. preemption: 0/${this.nodes.length} nodes are available: ${this.nodes.length} No preemption victims found for incoming pod.`;
        return false;
      }
      fits.sort((a, b) => a.count - b.count || b.free - a.free);
      const n = fits[0].n;
      pod.node = n.name;
      pod.ip = `10.244.${n.index}.${(this.seq++ % 250) + 3}`;
      pod.scheduledAt = this.world.bootstrap ? pod.createdAt : this.world.now();
      pod.schedMsg = null;
      return true;
    }

    /* ------------------------------------------------------------ reconcile */
    templateHash(tpl) { return U.suffix(stable(tpl), 10); }
    deployHistory(ns, name) { const k = ns + '/' + name; if (!this.history.has(k)) this.history.set(k, []); return this.history.get(k); }
    newPod(ns, owner, hash, tpl) {
      const name = owner ? `${owner}-${hash}-${U.suffix(owner + hash + this.seq++ + this.name, 5)}` : tpl.metadata.name;
      const pod = {
        name, ns, owner, hash, labels: Object.assign({}, (tpl.metadata && tpl.metadata.labels) || {}, owner ? { 'pod-template-hash': hash } : {}),
        spec: U.clone(tpl.spec), createdAt: this.world.stamp() + (this.world.bootstrap ? (this.seq % 50) * 1000 : 0),
        node: null, ip: null, access: [], uid: U.hex(name, 8),
      };
      this.pods.push(pod);
      this.schedule(pod);
      return pod;
    }
    createBarePod(obj) {
      this.pods = this.pods.filter(p => !(p.ns === obj.metadata.namespace && p.name === obj.metadata.name));
      this.newPod(obj.metadata.namespace, null, null, { metadata: obj.metadata, spec: obj.spec });
    }
    reconcile() {
      for (const p of this.pods) if (!p.node) this.schedule(p);
      for (const d of this.list('Deployment')) this.reconcileDeployment(d);
      const deps = new Set(this.list('Deployment').map(d => d.metadata.namespace + '/' + d.metadata.name));
      this.pods = this.pods.filter(p => !p.owner || deps.has(p.ns + '/' + p.owner));
    }
    reconcileDeployment(d) {
      const ns = d.metadata.namespace, name = d.metadata.name;
      const tpl = d.spec.template;
      const hash = this.templateHash(tpl);
      const hist = this.deployHistory(ns, name);
      const last = hist[hist.length - 1];
      if (!last || last.hash !== hash) {
        const old = hist.findIndex(h => h.hash === hash);
        const cause = d.metadata.annotations && d.metadata.annotations['kubernetes.io/change-cause'];
        if (old >= 0) hist.splice(old, 1);
        hist.push({ rev: (last ? last.rev : 0) + 1, hash, template: U.clone(tpl), cause: cause || null });
      }
      const replicas = d.spec.replicas ?? 1;
      const mine = this.pods.filter(p => p.ns === ns && p.owner === name);
      const cur = mine.filter(p => p.hash === hash);
      const old = mine.filter(p => p.hash !== hash);
      let newTarget = replicas, oldKeep = 0;
      if (old.length) {
        const probe = { ns, spec: tpl.spec, labels: {}, node: 'probe', createdAt: -Infinity };
        const healthy = this.containerVerdict(probe).ready;
        const oldReady = old.filter(p => this.podStatus(p, true).ready);
        if (!healthy && oldReady.length) {
          const surge = Math.ceil(replicas * 0.25), unavail = Math.floor(replicas * 0.25);
          oldKeep = Math.min(oldReady.length, Math.max(0, replicas - unavail));
          newTarget = Math.max(0, Math.min(replicas, replicas + surge - oldKeep));
        }
      }
      const removeIds = new Set();
      const oldSorted = old.slice().sort((a, b) => Number(this.podStatus(b, true).ready) - Number(this.podStatus(a, true).ready));
      oldSorted.slice(oldKeep).forEach(p => removeIds.add(p));
      if (cur.length > newTarget) cur.slice().sort((a, b) => (a.node ? 1 : 0) - (b.node ? 1 : 0) || b.createdAt - a.createdAt).slice(0, cur.length - newTarget).forEach(p => removeIds.add(p));
      const before = cur.length;
      if (removeIds.size) this.pods = this.pods.filter(p => !removeIds.has(p));
      for (let i = cur.length; i < newTarget; i++) this.newPod(ns, name, hash, tpl);
      const after = Math.min(newTarget, Math.max(before, newTarget));
      if (newTarget !== before && !this.world.bootstrap) this.pushEvent(ns, 'Normal', 'ScalingReplicaSet', `deployment/${name}`, `Scaled ${newTarget > before ? 'up' : 'down'} replica set ${name}-${hash} to ${after}`);
    }
    pushEvent(ns, type, reason, object, message) {
      this.events.push({ ns, type, reason, object, message, at: this.world.now() });
      if (this.events.length > 100) this.events.shift();
    }

    /* ------------------------------------------------------------ pod status */
    pullAuths(ns, spec) {
      const auths = {};
      for (const ref of spec.imagePullSecrets || []) {
        const s = this.get('Secret', ns, ref.name);
        if (!s || s.type !== 'kubernetes.io/dockerconfigjson' || !s.data || !s.data['.dockerconfigjson']) continue;
        try {
          const cfg = JSON.parse(U.unb64(s.data['.dockerconfigjson']));
          for (const [host, a] of Object.entries(cfg.auths || {})) {
            let { username, password } = a;
            if ((!username || !password) && a.auth) { const dec = U.unb64(a.auth) || ''; const i = dec.indexOf(':'); username = dec.slice(0, i); password = dec.slice(i + 1); }
            auths[host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')] = { username, password };
          }
        } catch (e) { /* malformed secret: ignored like kubelet does */ }
      }
      return auths;
    }
    resolveEnv(c, ns) {
      const env = {};
      for (const ef of c.envFrom || []) {
        if (ef.configMapRef) {
          const cm = this.get('ConfigMap', ns, ef.configMapRef.name);
          if (!cm) { if (ef.configMapRef.optional) continue; return { error: `configmap "${ef.configMapRef.name}" not found` }; }
          Object.assign(env, cm.data || {});
        }
        if (ef.secretRef) {
          const s = this.get('Secret', ns, ef.secretRef.name);
          if (!s) { if (ef.secretRef.optional) continue; return { error: `secret "${ef.secretRef.name}" not found` }; }
          for (const [k, v] of Object.entries(s.data || {})) env[k] = U.unb64(v);
        }
      }
      for (const e of c.env || []) {
        if (!e || !e.name) continue;
        if (e.value !== undefined) { env[e.name] = String(e.value); continue; }
        const vf = e.valueFrom || {};
        if (vf.configMapKeyRef) {
          const r = vf.configMapKeyRef, cm = this.get('ConfigMap', ns, r.name);
          if (!cm) { if (r.optional) continue; return { error: `configmap "${r.name}" not found` }; }
          if (!cm.data || !(r.key in cm.data)) { if (r.optional) continue; return { error: `couldn't find key ${r.key} in ConfigMap ${ns}/${r.name}` }; }
          env[e.name] = cm.data[r.key];
        } else if (vf.secretKeyRef) {
          const r = vf.secretKeyRef, s = this.get('Secret', ns, r.name);
          if (!s) { if (r.optional) continue; return { error: `secret "${r.name}" not found` }; }
          if (!s.data || !(r.key in s.data)) { if (r.optional) continue; return { error: `couldn't find key ${r.key} in Secret ${ns}/${r.name}` }; }
          env[e.name] = U.unb64(s.data[r.key]);
        } else if (vf.fieldRef) env[e.name] = vf.fieldRef.fieldPath;
      }
      return { env };
    }
    // Final ("settled") verdict for a pod's containers, independent of time.
    containerVerdict(pod) {
      const out = { containers: [], ready: false, failing: null };
      const auths = this.pullAuths(pod.ns, pod.spec);
      for (const c of pod.spec.containers || []) {
        const v = { name: c.name, image: c.image };
        const pull = this.world.pullImage(c.image, auths);
        if (!pull.ok) { Object.assign(v, { state: 'pull', reason: 'ImagePullBackOff', message: pull.error }); out.containers.push(v); continue; }
        v.meta = pull.meta;
        const env = this.resolveEnv(c, pod.ns);
        if (env.error) { Object.assign(v, { state: 'config', reason: 'CreateContainerConfigError', message: env.error }); out.containers.push(v); continue; }
        v.env = env.env;
        const sa = pod.spec.serviceAccountName || 'default';
        const rt = IG.runtime.evaluate(pull.meta, {
          env: env.env, openshift: this.openshift, anyuid: this.anyuid.has(pod.ns + '/' + sa) || !!(c.securityContext && c.securityContext.runAsUser === 0 && this.anyuid.has(pod.ns + '/' + sa)),
          resolveHost: h => !!this.dnsLookup(h, pod.ns), command: c.command || c.args,
        });
        v.rt = rt;
        if (!rt.ok) {
          Object.assign(v, rt.completed ? { state: 'done', reason: 'Completed', message: '' } : { state: 'crash', reason: 'CrashLoopBackOff', message: `back-off restarting failed container ${c.name}`, exitCode: rt.exitCode });
          out.containers.push(v); continue;
        }
        v.state = 'running';
        v.ready = this.probeOk(c, rt, pull.meta);
        if (!v.ready) v.message = this.probeMessage(c, rt, pod);
        out.containers.push(v);
      }
      out.ready = out.containers.length > 0 && out.containers.every(c => c.state === 'running' && c.ready);
      out.failing = out.containers.find(c => c.state !== 'running') || null;
      return out;
    }
    probePort(c, port) {
      if (typeof port === 'string') { const p = (c.ports || []).find(x => x.name === port); return p ? p.containerPort : NaN; }
      return Number(port);
    }
    probeOk(c, rt, meta) {
      const pr = c.readinessProbe;
      if (!pr) return true;
      const h = pr.httpGet || pr.tcpSocket;
      if (!h) return true;
      if (this.probePort(c, h.port) !== rt.port) return false;
      if (pr.httpGet) { const r = IG.runtime.respond(meta, h.path || '/'); return !!r && r.status < 400; }
      return true;
    }
    probeMessage(c, rt, pod) {
      const h = c.readinessProbe.httpGet || c.readinessProbe.tcpSocket;
      const port = this.probePort(c, h.port);
      if (port !== rt.port) return `Readiness probe failed: Get "http://${pod.ip || '10.244.0.0'}:${port}${h.path || ''}": dial tcp ${pod.ip || '10.244.0.0'}:${port}: connect: connection refused`;
      return `Readiness probe failed: HTTP probe failed with statuscode: 404`;
    }
    podStatus(pod, settled = false) {
      const total = (pod.spec.containers || []).length;
      const base = { total, readyN: 0, ready: false, restarts: 0, verdict: null };
      if (!pod.node) return Object.assign(base, { phase: 'Pending', display: 'Pending', reason: 'Unschedulable', message: pod.schedMsg });
      const v = this.containerVerdict(pod);
      base.verdict = v;
      const age = settled ? Infinity : this.world.now() - pod.createdAt;
      if (age < 1500) return Object.assign(base, { phase: 'Pending', display: 'ContainerCreating', reason: 'ContainerCreating' });
      const f = v.failing;
      if (f) {
        if (f.state === 'pull') return Object.assign(base, { phase: 'Pending', display: age < 6000 ? 'ErrImagePull' : 'ImagePullBackOff', reason: 'ImagePullBackOff', message: f.message });
        if (f.state === 'config') return Object.assign(base, { phase: 'Pending', display: 'CreateContainerConfigError', reason: 'CreateContainerConfigError', message: f.message });
        const restarts = settled ? 5 : Math.min(48, 1 + Math.floor((age - 1500) / 12000));
        if (f.state === 'done' && !pod.owner) return Object.assign(base, { phase: 'Succeeded', display: 'Completed', reason: 'Completed' });
        return Object.assign(base, { phase: 'Running', display: age < 7000 ? (f.state === 'done' ? 'Completed' : 'Error') : 'CrashLoopBackOff', reason: 'CrashLoopBackOff', restarts, message: f.message });
      }
      const readyN = v.containers.filter(c => c.ready).length;
      return Object.assign(base, { phase: 'Running', display: 'Running', reason: 'Running', readyN, ready: readyN === total, message: v.containers.find(c => !c.ready)?.message });
    }
    podLogs(pod, container) {
      const st = this.podStatus(pod);
      const v = st.verdict;
      const c = v && (v.containers.find(x => x.name === container) || v.containers[0]);
      if (!pod.node || !c) return { error: `Error from server (BadRequest): container "${(pod.spec.containers[0] || {}).name}" in pod "${pod.name}" is waiting to start: ContainerCreating` };
      if (c.state === 'pull' || c.state === 'config') return { error: `Error from server (BadRequest): container "${c.name}" in pod "${pod.name}" is waiting to start: ${c.state === 'pull' ? 'trying and failing to pull image' : 'CreateContainerConfigError'}` };
      return { text: [...(c.rt.logs || []), ...pod.access].join('\n') };
    }

    /* ------------------------------------------------------------ networking */
    dnsLookup(host, ns) {
      const h = host.toLowerCase().replace(/\.$/, '');
      const parts = h.split('.');
      let name, sns;
      if (parts.length === 1) { name = parts[0]; sns = ns; }
      else if (parts.length === 2) { [name, sns] = parts; }
      else if (parts.length === 3 && parts[2] === 'svc') { [name, sns] = parts; }
      else if (h.endsWith('.svc.cluster.local') && parts.length === 5) { [name, sns] = parts; }
      else return null;
      return this.get('Service', sns, name);
    }
    endpoints(svc) {
      const sel = svc.spec.selector;
      return this.pods.filter(p => p.ns === svc.metadata.namespace && matches(sel, p.labels)).map(p => ({ pod: p, st: this.podStatus(p) })).filter(x => x.st.ready);
    }
    targetFor(pod, targetPort) {
      if (typeof targetPort === 'string') {
        for (const c of pod.spec.containers) { const p = (c.ports || []).find(x => x.name === targetPort); if (p) return p.containerPort; }
        return NaN;
      }
      return Number(targetPort);
    }
    serviceHttp(svc, port, req, viaName) {
      const sp = svc.spec.ports.find(p => p.port === port);
      const ns = svc.metadata.namespace;
      const fail = { error: `curl: (7) Failed to connect to ${viaName} port ${port} after 2 ms: Couldn't connect to server`, target: { kind: 'svc', cluster: this.name, ns, name: svc.metadata.name } };
      if (!sp) return fail;
      const eps = this.endpoints(svc);
      if (!eps.length) return fail;
      const ep = eps[this.rr++ % eps.length];
      return this.podHttp(ep.pod, this.targetFor(ep.pod, sp.targetPort), req) || fail;
    }
    podHttp(pod, port, req) {
      const v = this.containerVerdict(pod);
      const c = v.containers.find(x => x.state === 'running' && x.rt.port === port);
      if (!c) return null;
      const r = IG.runtime.respond(c.meta, req.path, { instance: pod.name });
      if (!r) return { error: 'curl: (52) Empty reply from server', target: { kind: 'pod', cluster: this.name, ns: pod.ns, name: pod.name } };
      pod.access.push(`10.244.0.1 - - [${new Date(this.world.now()).toUTCString()}] "${req.method} ${req.path} HTTP/1.1" ${r.status} ${r.body.length} "-" "curl/8.10.1"`);
      if (pod.access.length > 30) pod.access.shift();
      return Object.assign({ target: { kind: 'pod', cluster: this.name, ns: pod.ns, name: pod.name, owner: pod.owner } }, r);
    }
    podSelfHttp(podName, req) {
      const pod = this.pods.find(p => p.name === podName);
      return (pod && this.podHttp(pod, req.port, req)) || { error: `curl: (7) Failed to connect to localhost port ${req.port} after 0 ms: Couldn't connect to server` };
    }
    inClusterHttp(req, ns) {
      const svc = this.dnsLookup(req.host, ns);
      if (svc) return this.serviceHttp(svc, req.port, req, req.host);
      const bySvcIp = this.list('Service').find(s => s.spec.clusterIP === req.host);
      if (bySvcIp) return this.serviceHttp(bySvcIp, req.port, req, req.host);
      const pod = this.pods.find(p => p.ip === req.host);
      if (pod) return this.podHttp(pod, req.port, req) || { error: `curl: (7) Failed to connect to ${req.host} port ${req.port} after 1 ms: Couldn't connect to server` };
      if (/\.svc(\.cluster\.local)?$/.test(req.host) || !req.host.includes('.')) return { error: `curl: (6) Could not resolve host: ${req.host}` };
      return null;
    }
    externalDns(host) {
      if (this.openshift && host.endsWith('.' + this.appsDomain)) return '10.0.3.50';
      if (host === this.apiHost()) return '10.0.3.10';
      return null;
    }
    apiHost() { return this.server.replace(/^https?:\/\//, '').replace(/:\d+$/, ''); }
    externalHttp(req) {
      if (this.openshift && req.host.endsWith('.' + this.appsDomain)) {
        const route = this.list('Route').find(r => r.spec.host === req.host);
        const unavailable = { status: 503, body: '<html><body><h1>Application is not available</h1><p>The application is currently not serving requests at this endpoint. It may not have been started or is still starting.</p></body></html>', target: { kind: 'route', cluster: this.name } };
        if (!route) return unavailable;
        const svc = this.get('Service', route.metadata.namespace, route.spec.to.name);
        if (!svc) return Object.assign(unavailable, { target: { kind: 'route', cluster: this.name, ns: route.metadata.namespace, name: route.metadata.name } });
        if (req.scheme === 'https' && !route.spec.tls) return { error: `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to ${req.host}:443` };
        const tp = route.spec.port && route.spec.port.targetPort;
        const sp = (tp !== undefined && svc.spec.ports.find(p => p.name === tp || p.targetPort === tp || p.port === tp)) || svc.spec.ports[0];
        const r = this.serviceHttp(svc, sp.port, req, req.host);
        if (r.error) return Object.assign(unavailable, { target: r.target });
        return r;
      }
      if (req.host === this.apiHost() && req.port === 6443) return { status: 401, body: JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message: 'Unauthorized', reason: 'Unauthorized', code: 401 }, null, 2) };
      const node = this.nodes.find(n => n.ip === req.host);
      if (node) {
        const svc = this.list('Service').find(s => s.spec.ports.some(p => p.nodePort === req.port));
        if (svc) return this.serviceHttp(svc, svc.spec.ports.find(p => p.nodePort === req.port).port, req, req.host);
        return { error: `curl: (7) Failed to connect to ${req.host} port ${req.port} after 1 ms: Couldn't connect to server` };
      }
      return null;
    }

    /* ------------------------------------------------------------ helpers for missions & UI */
    deployPods(ns, name) { return this.pods.filter(p => p.ns === ns && p.owner === name); }
    readyCount(ns, name) {
      const d = this.get('Deployment', ns, name);
      if (!d) return 0;
      const hash = this.templateHash(d.spec.template);
      return this.deployPods(ns, name).filter(p => p.hash === hash && this.podStatus(p, true).ready).length;
    }
    healthy(ns, name, n) {
      const d = this.get('Deployment', ns, name);
      if (!d) return false;
      const want = n ?? (d.spec.replicas ?? 1);
      return this.readyCount(ns, name) >= want && this.deployPods(ns, name).every(p => this.podStatus(p, true).ready);
    }
    makeSystemPods() {
      const out = [];
      const sys = (name, node) => out.push({ name, ns: 'kube-system', node, system: true });
      sys('coredns-5d78c9869d-' + U.suffix(this.name + 'a'), this.nodes[0].name);
      sys('coredns-5d78c9869d-' + U.suffix(this.name + 'b'), this.nodes[this.nodes.length - 1].name);
      for (const n of this.nodes) sys((this.flavor === 'eks' ? 'aws-node-' : 'kube-proxy-') + U.suffix(n.name + this.name), n.name);
      return out;
    }
  }

  IG.k8s = { Cluster, ApiError, KINDS, matches, stable };
})(globalThis.IG = globalThis.IG || {});
