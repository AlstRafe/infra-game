/* Storage: block devices, partitions, LVM, filesystems, swap and mounts.
 * The root disk layout is fixed per OS (Ubuntu: plain ext4 partition, RHEL: LVM rhel-root/rhel-swap).
 * Extra disks from the host spec (`disks: [{ name, sizeGiB }]`) can be partitioned (parted -s, fdisk
 * with a piped script, growpart), used as LVM PVs (pvcreate/vgcreate/lvcreate/lvextend ...), formatted
 * (mkfs.*, mkswap), mounted (mount / fstab / mount -a / reboot) and grown (lvextend -r, resize2fs,
 * xfs_growfs). A filesystem keeps its own size (fsMiB) so `df` only grows after the fs is resized. */
(function (IG) {
  'use strict';
  const U = IG.util;
  const C = (IG.commands = IG.commands || {});
  const opts = (...a) => IG.cliOpts(...a);
  const out = () => IG.cliOut();
  const lines = t => { const l = String(t).split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  const join = l => (l.length ? l.join('\n') + '\n' : '');
  const root = ctx => ctx.user === 'root';
  const fail = (msg, code = 1, stdout = '') => ({ stdout, stderr: msg.endsWith('\n') ? msg : msg + '\n', code });
  const MiB = 1048576, PE = 4; // LVM extent size (MiB)

  /* ---------------------------------------------------------------- state */
  const uuid = seed => `${U.hex(seed, 8)}-${U.hex(seed + 1, 4)}-4${U.hex(seed + 2, 3)}-a${U.hex(seed + 3, 3)}-${U.hex(seed + 4, 12)}`;
  const lvmId = seed => { const s = U.hex(seed, 32); let i = 0; return [6, 4, 4, 4, 4, 4, 6].map(n => s.slice(i, (i += n))).join('-'); };
  const pname = (d, n) => d.name + (/\d$/.test(d.name) ? 'p' : '') + n;
  const mapName = (vg, lv) => `${vg.replace(/-/g, '--')}-${lv.replace(/-/g, '--')}`;
  function st(h) {
    if (h._storage) return h._storage;
    h.disks = h.disks || [];
    for (const d of h.disks) Object.assign(d, { mib: d.sizeGiB * 1024, parts: d.parts || [], pt: d.pt || null });
    const s = (h._storage = { minor: 4 + h.disks.length, dm: 0, seq: 0, prio: -2, vgs: {}, pvs: {}, swapFiles: {}, tmpfs: [] });
    if (h.os === 'rhel') {
      const pvMiB = h.diskGiB * 1024 - 1626;
      const ext = Math.floor((pvMiB - 1) / PE);
      s.pvs['/dev/nvme0n1p3'] = { vg: 'rhel', mib: pvMiB, uuid: lvmId(h.name + 'pv'), sys: true };
      s.vgs.rhel = { uuid: lvmId(h.name + 'vg'), sys: true, lvs: [{ name: 'root', mib: (ext - 512) * PE, fs: 'xfs', mount: '/', sys: true, dm: s.dm++, uuid: '7b1a3a2e-6d2e-4a8f-9a1e-2b6c1e0f4a11' }, { name: 'swap', mib: 2048, fs: 'swap', swapOn: true, prio: s.prio--, sys: true, dm: s.dm++, uuid: uuid(h.name + 'swap') }] };
    }
    return s;
  }
  const newId = (h, tag) => uuid(h.name + tag + st(h).seq++ + ':' + (h.world ? h.world.now() : 0));
  // every block device that can carry a signature: extra disks, their partitions, logical volumes
  function vols(h) {
    const s = st(h), v = [];
    h.disks.forEach((d, i) => {
      v.push({ dev: '/dev/' + d.name, kname: d.name, name: d.name, o: d, kind: 'disk', mib: d.mib, mm: `259:${4 + i}` });
      for (const p of d.parts) v.push({ dev: '/dev/' + p.name, kname: p.name, name: p.name, o: p, kind: 'part', mib: p.end - p.start, mm: `259:${p.minor}`, disk: d });
    });
    for (const [vg, g] of Object.entries(s.vgs)) for (const lv of g.lvs) v.push({ dev: `/dev/${vg}/${lv.name}`, mapper: '/dev/mapper/' + mapName(vg, lv.name), kname: 'dm-' + lv.dm, name: mapName(vg, lv.name), o: lv, kind: 'lvm', mib: lv.mib, mm: `253:${lv.dm}`, vg, sys: lv.sys });
    return v;
  }
  function findVol(h, dev) {
    if (!dev) return null;
    const u = String(dev).match(/^(?:UUID=|\/dev\/disk\/by-uuid\/)"?([^"]+)"?$/), l = String(dev).match(/^(?:LABEL=|\/dev\/disk\/by-label\/)"?([^"]+)"?$/);
    return vols(h).find(v => v.dev === dev || v.mapper === dev || '/dev/' + v.kname === dev || (u && v.o.uuid && v.o.uuid.toLowerCase() === u[1].toLowerCase()) || (l && v.o.label === l[1])) || null;
  }
  const protectedDev = d => /^\/dev\/(nvme0n1|xvda|sda)/.test(d) || /^\/dev\/(mapper\/rhel-|rhel\/|dm-[01]$)/.test(d) || /^(UUID=7b1a3a2e|LABEL=(cloudimg-rootfs|UEFI))/i.test(d);
  const PROTECTED = d => IG.t(`ℹ ルートディスク（{0}）の変更は訓練環境では禁止しています。練習には追加ディスク（lsblk で確認）を使ってください。`, { 0: d });
  const pvOf = (h, v) => st(h).pvs[v.dev];
  // why a device can't be formatted / wiped right now
  function inUse(h, v) {
    if (v.o.mount) return 'mounted';
    if (v.o.swapOn) return 'swap';
    const pv = pvOf(h, v);
    if (pv && pv.vg) return 'lvm';
    if (v.kind === 'disk') for (const p of v.o.parts) { const pv2 = vols(h).find(x => x.o === p); if (inUse(h, pv2)) return 'parts'; }
    return null;
  }
  // signature found on the device (filesystem, LVM label or partition table)
  const sigOf = (h, v) => v.o.fs || (pvOf(h, v) ? 'LVM2_member' : v.kind === 'disk' && v.o.pt ? v.o.pt : null);

  /* ---------------------------------------------------------------- sizes */
  const hum1 = b => { const u = ['B', 'K', 'M', 'G', 'T']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } const s = i === 0 ? String(Math.round(b)) : b.toFixed(1).replace(/\.0$/, ''); return s + u[i]; };
  const humIEC = b => { const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (Number.isInteger(Math.round(b * 10) / 10) ? String(Math.round(b * 10) / 10) : b.toFixed(1)) + ' ' + u[i]; };
  const lsz = (mib, long) => { if (!mib) return long ? '0   ' : '0 '; const [u, f] = mib >= 1048576 ? ['t', 1048576] : mib >= 1024 ? ['g', 1024] : ['m', 1]; const v = mib / f; const s = v.toFixed(2); return (Number(s) > v + 1e-9 ? '<' : '') + s + (long ? ' ' + u.toUpperCase() + 'iB' : u); };
  const compact = b => { for (const [u, f] of [['TB', 1e12], ['GB', 1e9], ['MB', 1e6], ['kB', 1e3]]) if (b >= 10 * f) { const v = b / f; return v.toFixed(Math.max(0, 2 - Math.floor(Math.log10(v)))) + u; } return Math.round(b) + 'B'; };
  // LVM / resize2fs style size: 10G 500M 1.5g 2T 100s (default unit MiB)
  function lsize(spec, def = 'm') {
    const m = String(spec).match(/^([+-])?(\d+(?:\.\d+)?)([bskmgtpe])?(?:i?b)?$/i);
    if (!m) return null;
    const mul = { b: 1 / MiB, s: 512 / MiB, k: 1 / 1024, m: 1, g: 1024, t: 1048576, p: 1073741824, e: 1099511627776 }[(m[3] || def).toLowerCase()];
    return { sign: m[1] || '', mib: Number(m[2]) * mul };
  }

  /* ---------------------------------------------------------------- mounts */
  function usedBytes(h, mount, fs, size) {
    let n = fs === 'xfs' ? Math.round(size * 0.007) : 24 * 1024;
    for (const [p, node] of h.vfs.nodes) if (node.type === 'f' && p.startsWith(mount + '/')) n += h.vfs.fileSize(node);
    return n;
  }
  function mounts(h) {
    const rhel = h.os === 'rhel';
    const m = [{ src: rhel ? '/dev/mapper/rhel-root' : '/dev/root', target: '/', type: rhel ? 'xfs' : 'ext4', size: rhel ? st(h).vgs.rhel.lvs[0].mib * MiB * 0.998 : h.diskGiB * 1024 ** 3, used: h.diskUsedBytes(), opts: rhel ? 'rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota' : 'rw,relatime,discard,errors=remount-ro' }, { src: 'tmpfs', target: '/dev/shm', type: 'tmpfs', size: 3.9 * 1024 ** 3, used: 0, opts: 'rw,nosuid,nodev' }, { src: 'tmpfs', target: '/run', type: 'tmpfs', size: 1.6 * 1024 ** 3, used: 900 * 1024, opts: 'rw,nosuid,nodev,size=1603620k,mode=755' }];
    if (rhel) m.push({ src: '/dev/nvme0n1p2', target: '/boot', type: 'xfs', size: 960 * MiB, used: 283 * MiB, opts: 'rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota' });
    m.push({ src: rhel ? '/dev/nvme0n1p1' : '/dev/nvme0n1p15', target: '/boot/efi', type: 'vfat', size: (rhel ? 599 : 105) * MiB, used: (rhel ? 7.1 : 6.1) * MiB, opts: 'rw,relatime,fmask=0077,dmask=0077' });
    for (const v of vols(h)) if (v.o.mount && !v.sys) { const size = (v.o.fsMiB || v.mib) * MiB * (v.o.fs === 'xfs' ? 0.995 : 0.978); const used = usedBytes(h, v.o.mount, v.o.fs, size); m.push({ src: v.mapper || v.dev, target: v.o.mount, type: v.o.fs, size, used, avail: Math.max(0, size * (v.o.fs === 'xfs' ? 1 : 0.95) - used), opts: v.o.opts || (v.o.fs === 'xfs' ? 'rw,relatime,attr2,inode64,logbufs=8,logbsize=32k,noquota' : 'rw,relatime'), vol: v }); }
    for (const t of st(h).tmpfs) m.push({ src: 'tmpfs', target: t.target, type: 'tmpfs', size: t.size, used: usedBytes(h, t.target, 'tmpfs', 0) - 24 * 1024, opts: 'rw,relatime' + (t.opts ? ',' + t.opts : '') });
    return m;
  }
  IG.mounts = mounts;
  C.df = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'tx', ['type', 'output', 'exclude-type']);
    const hum = f.h || f['human-readable'], si = f.H;
    let ms = mounts(h);
    if (pos.length) {
      const o = out();
      const pick = [];
      for (const p of pos) {
        const v = p.startsWith('/dev/') ? findVol(h, p) : null;
        const m = v ? ms.find(x => x.vol && x.vol.dev === v.dev) : ms.filter(x => { const abs = ctx.resolve(p); return abs === x.target || abs.startsWith(x.target === '/' ? '/' : x.target + '/'); }).sort((a, b) => b.target.length - a.target.length)[0];
        if (!v && p.startsWith('/dev/') && !ms.some(x => x.src === p)) { o.e(`df: ${p}: No such file or directory`); continue; }
        if (!p.startsWith('/dev/') && !ctx.vfs.exists(ctx.resolve(p))) { o.e(`df: ${p}: No such file or directory`); continue; }
        if (m) pick.push(m); else if (v) pick.push({ src: p, target: '/dev', type: 'devtmpfs', size: 4 * 1024 ** 3, used: 0 });
      }
      if (!pick.length) return o.r();
      ms = pick;
      if (o.se) { const r = C.df(argv.filter(a => !pos.includes(a)).concat(pick.map(m => m.target)), ctx); return { stdout: r.stdout, stderr: o.se, code: 1 }; }
    }
    if (f.t || f.type) ms = ms.filter(m => String(f.t || f.type).split(',').includes(m.type));
    if (f.x || f['exclude-type']) ms = ms.filter(m => !String(f.x || f['exclude-type']).split(',').includes(m.type));
    const fmt = n => (hum || si ? (n === 0 ? '0' : IG.humanSize(n, si)) : f.m ? String(Math.ceil(n / MiB)) : String(Math.ceil(n / 1024)));
    // GNU df: human-readable size columns are at least 5 wide, Use% at least 4
    const tab = (all, left) => { const n = all[0].length; const w = all[0].map((_, k) => Math.max(...all.map(r => r[k].length), (hum || si) && !left.includes(k) && k < n - 1 ? (k === n - 2 ? 4 : 5) : 0)); return join(all.map(r => r.map((c, k) => (left.includes(k) ? c.padEnd(w[k]) : k === r.length - 1 ? c : c.padStart(w[k]))).join(' '))); };
    const avail = m => (m.avail !== undefined ? m.avail : Math.max(0, m.size - m.used));
    const pct = m => (m.used ? Math.min(100, Math.ceil((m.used / (m.used + avail(m))) * 100)) : 0) + '%';
    if (f.i || f.inodes) return tab([['Filesystem', 'Inodes', 'IUsed', 'IFree', 'IUse%', 'Mounted on']].concat(ms.map(m => { const total = Math.round(m.size / 16384); const used = m.target === '/' ? 112000 + h.vfs.nodes.size : m.type === 'tmpfs' ? 1 : 11; return [m.src, String(total), String(used), String(total - used), Math.ceil((used / total) * 100) + '%', m.target]; })), [0]);
    const hdr = ['Filesystem'].concat(f.T ? ['Type'] : [], [hum || si ? 'Size' : f.m ? '1M-blocks' : '1K-blocks', 'Used', hum || si ? 'Avail' : 'Available', 'Use%', 'Mounted on']);
    const rows = ms.map(m => [m.src].concat(f.T ? [m.type] : [], [fmt(m.size), fmt(m.used), fmt(avail(m)), pct(m), m.target]));
    if (f.total) { const t = ms.reduce((a, m) => [a[0] + m.size, a[1] + m.used, a[2] + avail(m)], [0, 0, 0]); rows.push(['total'].concat(f.T ? ['-'] : [], [fmt(t[0]), fmt(t[1]), fmt(t[2]), Math.ceil((t[1] / (t[1] + t[2])) * 100) + '%', '-'])); }
    return tab([hdr].concat(rows), f.T ? [0, 1] : [0]);
  };
  const fstab =h => lines(h.vfs.read('/etc/fstab') || '').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { const [src, target, type, o = 'defaults'] = l.split(/\s+/); return { src, target, type, opts: o }; });
  const fstabStale = h => { const n = h.vfs.node('/etc/fstab'); return !!n && n.mtime > (h.systemdFstab || 0); };
  const FSTAB_HINT = "mount: (hint) your fstab has been modified, but systemd still uses the old version;\n       use 'systemctl daemon-reload' to reload.";

  /* ---------------------------------------------------------------- swap */
  function swaps(h) {
    const r = [];
    for (const v of vols(h)) if (v.o.swapOn) r.push({ name: v.kind === 'lvm' ? '/dev/' + v.kname : v.dev, type: 'partition', kib: v.mib * 1024 - 4, prio: v.o.prio });
    for (const [p, f] of Object.entries(st(h).swapFiles)) if (f.on) r.push({ name: p, type: 'file', kib: f.kib, prio: f.prio });
    return r;
  }
  IG.swapKiB = h => swaps(h).reduce((a, s) => a + s.kib, 0);

  /* ---------------------------------------------------------------- lsblk */
  function rootTree(h) {
    const g = h.diskGiB;
    const n = (name, mm, bytes, type, mnt = '', fstype = '', extra = {}) => Object.assign({ name, mm, bytes, type, mnt, fstype, ro: '0', kids: [] }, extra);
    if (h.os === 'rhel') {
      const s = st(h), [rl, sl] = s.vgs.rhel.lvs;
      const p3 = n('nvme0n1p3', '259:3', s.pvs['/dev/nvme0n1p3'].mib * MiB, 'part', '', 'LVM2_member', { fsver: 'LVM2 001', uuid: s.pvs['/dev/nvme0n1p3'].uuid });
      p3.kids = [n('rhel-root', '253:0', rl.mib * MiB, 'lvm', '/', 'xfs', { uuid: rl.uuid, path: '/dev/mapper/rhel-root' }), n('rhel-swap', '253:1', sl.mib * MiB, 'lvm', '[SWAP]', 'swap', { fsver: '1', uuid: sl.uuid, path: '/dev/mapper/rhel-swap' })];
      return [Object.assign(n('nvme0n1', '259:0', g * 1024 ** 3, 'disk'), { kids: [n('nvme0n1p1', '259:1', 600 * MiB, 'part', '/boot/efi', 'vfat', { fsver: 'FAT32', uuid: '5C1D-9A2F' }), n('nvme0n1p2', '259:2', 1024 * MiB, 'part', '/boot', 'xfs', { uuid: uuid(h.name + 'boot') }), p3] })];
    }
    return [n('loop0', '7:0', 25.2 * MiB, 'loop', '/snap/amazon-ssm-agent/7993', 'squashfs', { ro: '1', fsver: '4.0' }), n('loop1', '7:1', 55.7 * MiB, 'loop', '/snap/core18/2846', 'squashfs', { ro: '1', fsver: '4.0' }),
      Object.assign(n('nvme0n1', '259:0', g * 1024 ** 3, 'disk'), { kids: [n('nvme0n1p1', '259:1', (g - 0.1) * 1024 ** 3, 'part', '/', 'ext4', { fsver: '1.0', label: 'cloudimg-rootfs', uuid: uuid('root') }), n('nvme0n1p14', '259:2', 4 * MiB, 'part'), n('nvme0n1p15', '259:3', 106 * MiB, 'part', '/boot/efi', 'vfat', { fsver: 'FAT32', label: 'UEFI', uuid: '5C1D-9A2F' })] })];
  }
  function volNode(h, v, ms) {
    const pv = pvOf(h, v), mt = ms.find(x => x.vol && x.vol.dev === v.dev);
    const fstype = v.o.fs || (pv ? 'LVM2_member' : '');
    return { name: v.name, path: v.mapper || v.dev, mm: v.mm, bytes: v.mib * MiB, type: v.kind, ro: '0', mnt: v.o.swapOn ? '[SWAP]' : v.o.mount || '', fstype, fsver: { ext4: '1.0', swap: '1', LVM2_member: 'LVM2 001' }[fstype] || '', label: v.o.label || '', uuid: v.o.uuid || (pv ? pv.uuid : ''), avail: mt ? mt.size - mt.used : null, fssize: mt ? mt.size : null, fsused: mt ? mt.used : null, pct: mt ? Math.ceil((mt.used / mt.size) * 100) + '%' : '', kids: [] };
  }
  function lvsOnPv(h, dev) {
    const pv = st(h).pvs[dev];
    return pv && pv.vg ? vgInfo(h, pv.vg).onPv(dev) : [];
  }
  function devTree(h) {
    const ms = mounts(h), all = vols(h);
    const lvKids = dev => lvsOnPv(h, dev).map(lv => volNode(h, all.find(x => x.o === lv), ms));
    const t = rootTree(h);
    for (const v of all.filter(x => x.kind === 'disk')) {
      const n = volNode(h, v, ms);
      n.kids = v.o.parts.length ? v.o.parts.map(p => { const pvv = all.find(x => x.o === p); const pn = volNode(h, pvv, ms); pn.kids = lvKids(pvv.dev); return pn; }) : lvKids(v.dev);
      t.push(n);
    }
    return t;
  }
  const LSBLK_COLS = {
    NAME: [r => r.pre + r.name], KNAME: [r => r.name], PATH: [r => r.path || '/dev/' + r.name], 'MAJ:MIN': [r => { const [a, b] = r.mm.split(':'); return a.padStart(3) + ':' + b; }], RM: [() => '0', 1], SIZE: [r => (r.bytesMode ? String(Math.round(r.bytes)) : hum1(r.bytes)), 1], RO: [r => r.ro, 1], TYPE: [r => r.type],
    MOUNTPOINT: [r => r.mnt], MOUNTPOINTS: [r => r.mnt], FSTYPE: [r => r.fstype || ''], FSVER: [r => r.fsver || ''], LABEL: [r => r.label || ''], UUID: [r => r.uuid || ''], FSAVAIL: [r => (r.avail == null ? '' : hum1(r.avail)), 1], 'FSUSE%': [r => r.pct || '', 1],
    FSSIZE: [r => (r.fssize == null ? '' : hum1(r.fssize)), 1], FSUSED: [r => (r.fsused == null ? '' : hum1(r.fsused)), 1], MODEL: [r => (r.type === 'disk' ? 'Amazon Elastic Block Store' : '')], SERIAL: [r => (r.type === 'disk' ? 'vol0' + U.hex(r.name, 15) : '')],
  };
  C.lsblk = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'o', ['output']);
    let cols = f.f || f.fs ? ['NAME', 'FSTYPE', 'FSVER', 'LABEL', 'UUID', 'FSAVAIL', 'FSUSE%', 'MOUNTPOINTS'] : ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINTS'];
    const oc = f.o || f.output;
    if (oc) { cols = (String(oc).startsWith('+') ? cols.concat(String(oc).slice(1).split(',')) : String(oc).split(',')).map(c => c.toUpperCase()); const bad = cols.find(c => !LSBLK_COLS[c]); if (bad) return fail(`lsblk: unknown column: ${bad}`); }
    let t = devTree(h);
    if (pos.length) {
      const flat = []; const walk = ns => ns.forEach(n => { flat.push(n); walk(n.kids); });
      walk(t);
      t = pos.map(p => flat.find(n => '/dev/' + n.name === p || n.path === p || (findVol(h, p) && findVol(h, p).name === n.name)));
      const miss = pos.find((p, i) => !t[i]);
      if (miss) return fail(`lsblk: ${miss}: not a block device`, 32);
    }
    const rows = [];
    const walk = (ns, pre) => ns.forEach((n, i) => { const last = i === ns.length - 1; rows.push(Object.assign({}, n, { pre: f.l || f.list ? '' : pre === null ? '' : pre + (last ? '└─' : '├─'), name: f.p || f.paths ? n.path || '/dev/' + n.name : n.name, bytesMode: f.b || f.bytes })); if (!(f.d || f.nodeps)) walk(n.kids, pre === null ? '' : pre + (last ? '  ' : '│ ')); });
    t.forEach(n => { rows.push(Object.assign({}, n, { pre: '', name: f.p || f.paths ? n.path || '/dev/' + n.name : n.name, bytesMode: f.b || f.bytes })); if (!(f.d || f.nodeps)) walk(n.kids, ''); });
    const cells = rows.map(r => cols.map(c => LSBLK_COLS[c][0](r)));
    const all = (f.n || f.noheadings ? [] : [cols]).concat(cells);
    const w = cols.map((c, k) => Math.max(...all.map(r => [...r[k]].length)));
    return join(all.map(r => r.map((c, k) => (LSBLK_COLS[cols[k]][1] ? c.padStart(w[k]) : k === cols.length - 1 ? c : c + ' '.repeat(w[k] - [...c].length))).join(' ').trimEnd()));
  };

  /* ---------------------------------------------------------------- blkid */
  function blkRows(h) {
    const s = st(h), rows = [];
    if (h.os === 'rhel') rows.push(['/dev/nvme0n1p1', { UUID: '5C1D-9A2F', BLOCK_SIZE: '512', TYPE: 'vfat', PARTLABEL: 'EFI System Partition', PARTUUID: '1d5e3c1a-01' }], ['/dev/nvme0n1p2', { UUID: uuid(h.name + 'boot'), BLOCK_SIZE: '512', TYPE: 'xfs', PARTUUID: '1d5e3c1a-02' }], ['/dev/nvme0n1p3', { UUID: s.pvs['/dev/nvme0n1p3'].uuid, TYPE: 'LVM2_member', PARTUUID: '1d5e3c1a-03' }], ['/dev/mapper/rhel-root', { UUID: s.vgs.rhel.lvs[0].uuid, BLOCK_SIZE: '512', TYPE: 'xfs' }], ['/dev/mapper/rhel-swap', { UUID: s.vgs.rhel.lvs[1].uuid, TYPE: 'swap' }]);
    else rows.push(['/dev/nvme0n1p1', { LABEL: 'cloudimg-rootfs', UUID: uuid('root'), BLOCK_SIZE: '4096', TYPE: 'ext4', PARTUUID: '8d6b5a4e-01' }], ['/dev/nvme0n1p15', { LABEL_FATBOOT: 'UEFI', LABEL: 'UEFI', UUID: '5C1D-9A2F', BLOCK_SIZE: '512', TYPE: 'vfat', PARTUUID: '8d6b5a4e-0f' }], ['/dev/nvme0n1p14', { PARTUUID: '8d6b5a4e-0e' }]);
    for (const v of vols(h)) {
      if (v.sys) continue;
      const a = {};
      const pv = pvOf(h, v);
      if (v.o.label && v.o.fs) a.LABEL = v.o.label;
      if (v.o.fs) { a.UUID = v.o.uuid; if (v.o.fs !== 'swap') a.BLOCK_SIZE = v.o.fs === 'xfs' ? '512' : '4096'; a.TYPE = v.o.fs; }
      else if (pv) { a.UUID = pv.uuid; a.TYPE = 'LVM2_member'; }
      else if (v.kind === 'disk' && v.o.pt) { a.PTUUID = v.o.ptuuid; a.PTTYPE = v.o.pt; }
      if (v.kind === 'part') { if (v.disk.pt === 'gpt' && v.o.pname) a.PARTLABEL = v.o.pname; a.PARTUUID = v.o.partuuid; }
      if (Object.keys(a).length) rows.push([v.mapper || v.dev, a]);
    }
    return rows;
  }
  C.blkid = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'soUL', ['match-tag', 'output']);
    if (!root(ctx)) return { stdout: '', stderr: '', code: 2 };
    let rows = blkRows(h);
    if (f.U || f.L) { const r = rows.find(([, a]) => (f.U ? (a.UUID || '').toLowerCase() === String(f.U).toLowerCase() : a.LABEL === f.L)); return r ? r[0] + '\n' : { stdout: '', stderr: '', code: 2 }; }
    if (pos.length) rows = pos.map(p => { const v = findVol(h, p); return rows.find(([d]) => d === p || (v && (d === v.dev || d === v.mapper))); }).filter(Boolean);
    const tags = [].concat(f.s || f['match-tag'] || []).flatMap(x => String(x).split(','));
    const fmt = f.o || f.output || 'full';
    const pick = a => Object.entries(a).filter(([k]) => !tags.length || tags.includes(k));
    if (!rows.length) return { stdout: '', stderr: '', code: 2 };
    if (fmt === 'value') return join(rows.flatMap(([, a]) => pick(a).map(([, v]) => v)));
    if (fmt === 'export') return rows.map(([d, a]) => `DEVNAME=${d}\n` + pick(a).map(([k, v]) => `${k}=${v}\n`).join('')).join('\n');
    return join(rows.map(([d, a]) => `${d}: ` + pick(a).map(([k, v]) => `${k}="${v}"`).join(' ')).filter(l => !/: $/.test(l)));
  };

  /* ---------------------------------------------------------------- partitions */
  const ptype = (d, p) => (d.pt === 'gpt' ? (p.flags.includes('lvm') ? 'Linux LVM' : p.flags.includes('swap') ? 'Linux swap' : 'Linux filesystem') : p.flags.includes('lvm') ? '8e Linux LVM' : p.flags.includes('swap') ? '82 Linux swap / Solaris' : '83 Linux');
  const lastUsable = d => (d.pt === 'gpt' ? d.mib - 34 / 2048 : d.mib);
  function mklabel(h, d, label) {
    const busy = d.parts.find(p => inUse(h, vols(h).find(x => x.o === p)));
    if (busy || d.mount || d.swapOn || (st(h).pvs['/dev/' + d.name] || {}).vg) return `Error: Partition(s) on /dev/${d.name} are being used.`;
    for (const p of d.parts) delete st(h).pvs['/dev/' + p.name];
    delete st(h).pvs['/dev/' + d.name];
    Object.assign(d, { pt: label, parts: [], fs: null, uuid: null, ptuuid: label === 'gpt' ? newId(h, 'pt').toUpperCase() : '0x' + U.hex(h.name + d.name + st(h).seq++, 8) });
    return null;
  }
  function addPart(h, d, start, end, x = {}) {
    if (!d.pt) return `Error: /dev/${d.name}: unrecognised disk label`;
    const max = d.pt === 'gpt' ? 128 : 4;
    let num = x.num;
    if (!num) { num = 1; while (d.parts.some(p => p.num === num)) num++; }
    if (num > max || d.parts.length >= max) return d.pt === 'gpt' ? 'Error: Too many partitions.' : 'Error: Too many primary partitions.';
    start = Math.max(1, start);
    end = Math.min(end, lastUsable(d));
    if (end <= start) return 'Error: Invalid partition boundaries (the end is before the start).';
    if (d.parts.some(p => start < p.end && end > p.start)) return "Error: Can't have overlapping partitions.";
    const p = { num, name: pname(d, num), start, end, minor: st(h).minor++, pname: x.pname || '', ptype: x.ptype || 'primary', flags: x.flags || [], fs: null, uuid: null, mount: null, partuuid: d.pt === 'gpt' ? newId(h, 'pu') : d.ptuuid.slice(2) + '-0' + num };
    d.parts.push(p);
    d.parts.sort((a, b) => a.num - b.num);
    return p;
  }
  function delPart(h, d, num) {
    const p = d.parts.find(x => x.num === num);
    if (!p) return `Error: Partition doesn't exist.`;
    if (inUse(h, vols(h).find(x => x.o === p))) return `Error: Partition /dev/${p.name} is being used. You must unmount it before you modify it with Parted.`;
    delete st(h).pvs['/dev/' + p.name];
    d.parts = d.parts.filter(x => x !== p);
    return null;
  }
  // parted position: 0% 100% 1MiB 10GiB 512MB 2048s -1s (bare number = MB)
  function ppos(tok, d) {
    const m = String(tok).match(/^(-)?(\d+(?:\.\d+)?)(%|s|b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i);
    if (!m) return null;
    const n = Number(m[2]), u = (m[3] || 'MB').toLowerCase();
    const mib = u === '%' ? (d.mib * n) / 100 : (n * { s: 512, b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: MiB, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 }[u]) / MiB;
    return m[1] ? d.mib - mib : mib;
  }
  function partedPrint(h, d, unit) {
    const f = !unit || unit === 'compact' ? compact : b => { const k = { s: 512, b: 1, kib: 1024, mib: MiB, gib: 1024 ** 3, kb: 1e3, mb: 1e6, gb: 1e9, '%': d.mib * MiB / 100 }[unit] || 1; const v = b / k; return (Number.isInteger(Math.round(v * 100) / 100) ? String(Math.round(v)) : v.toFixed(2)) + (unit === 's' ? 's' : unit === '%' ? '%' : { b: 'B', kib: 'KiB', mib: 'MiB', gib: 'GiB', kb: 'kB', mb: 'MB', gb: 'GB' }[unit]); };
    let s = `Model: Amazon Elastic Block Store (nvme)\nDisk /dev/${d.name}: ${f(d.mib * MiB)}\nSector size (logical/physical): 512B/512B\nPartition Table: ${d.pt || 'unknown'}\nDisk Flags: \n`;
    if (!d.pt) return s;
    const gpt = d.pt === 'gpt';
    const hdr = gpt ? ['Number', 'Start', 'End', 'Size', 'File system', 'Name', 'Flags'] : ['Number', 'Start', 'End', 'Size', 'Type', 'File system', 'Flags'];
    const rows = d.parts.map(p => { const fs = p.fs === 'swap' ? 'linux-swap(v1)' : p.fs || ''; const c = [' ' + p.num, f(p.start * MiB), f(p.end * MiB), f((p.end - p.start) * MiB)]; return gpt ? c.concat(fs, p.pname, p.flags.join(', ')) : c.concat(p.ptype, fs, p.flags.join(', ')); });
    const all = [hdr].concat(rows);
    const w = hdr.map((_, k) => Math.max(...all.map(r => r[k].length)) + 2);
    return s + '\n' + all.map(r => r.map((c, k) => c.padEnd(w[k])).join('').trimEnd()).join('\n') + '\n\n';
  }
  const PCMDS = new Set(['mklabel', 'mktable', 'mkpart', 'print', 'rm', 'resizepart', 'name', 'set', 'toggle', 'unit', 'quit', 'align-check']);
  C.parted = (argv, ctx) => {
    const h = ctx.host;
    const o = out();
    const script = argv.some(a => a === '-s' || a === '--script');
    const args = [];
    for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '-a' || a === '--align') { i++; continue; } if (/^-(s|-script|m|-machine|f|-fix)$/.test(a)) continue; args.push(a); }
    const list = argv.includes('-l') || argv.includes('--list');
    if (!root(ctx)) return fail(`Error: Error opening ${args.find(a => a.startsWith('/dev/')) || '/dev/nvme0n1'}: Permission denied`);
    const s = st(h);
    if (list) {
      const rootDisk = h.os === 'rhel' ? `Model: Amazon Elastic Block Store (nvme)\nDisk /dev/nvme0n1: ${compact(h.diskGiB * 1024 ** 3)}\nSector size (logical/physical): 512B/512B\nPartition Table: gpt\nDisk Flags: \n\nNumber  Start   End     Size    File system     Name                  Flags\n 1      1049kB  630MB   629MB   fat16           EFI System Partition  boot, esp\n 2      630MB   1704MB  1074MB  xfs\n 3      1704MB  ${compact(h.diskGiB * 1024 ** 3)}  ${compact(h.diskGiB * 1024 ** 3 - 1704e6)}                                 lvm\n\n` : `Model: Amazon Elastic Block Store (nvme)\nDisk /dev/nvme0n1: ${compact(h.diskGiB * 1024 ** 3)}\nSector size (logical/physical): 512B/512B\nPartition Table: gpt\nDisk Flags: \n\nNumber  Start   End     Size    File system  Name  Flags\n14      1049kB  5243kB  4194kB                     bios_grub\n15      5243kB  116MB   111MB   fat32              boot, esp\n 1      116MB   ${compact(h.diskGiB * 1024 ** 3)}  ${compact(h.diskGiB * 1024 ** 3 - 116e6)}  ext4\n\n`;
      o.o(rootDisk);
      for (const d of h.disks) { if (!d.pt) o.e(`Error: /dev/${d.name}: unrecognised disk label`, 0); o.o(partedPrint(h, d) + (d.pt ? '' : '\n')); }
      return o.r();
    }
    const devTok = args.find(a => a.startsWith('/dev/'));
    if (!devTok) return fail(argv.length ? `Error: Could not stat device ${args[0]} - No such file or directory.` : IG.t('ℹ parted の対話モードは再現していません。parted -s /dev/nvme1n1 mklabel gpt mkpart primary ext4 0% 100% のように 1 行で指定してください（一覧は parted -l）。'));
    if (protectedDev(devTok)) { const cmds0 = args.slice(args.indexOf(devTok) + 1); if (!cmds0.length || cmds0.every(c => c === 'print' || c === 'unit' || /^(s|b|kb|mb|gb|kib|mib|gib|compact|%)$/i.test(c))) return C.parted(['-l'], ctx); return fail(PROTECTED(devTok)); }
    const d = h.disks.find(x => '/dev/' + x.name === devTok);
    if (!d) { const v = findVol(h, devTok); return fail(v ? `Error: ${devTok}: unrecognised disk label` : `Error: Could not stat device ${devTok} - No such file or directory.`); }
    const cmds = args.slice(args.indexOf(devTok) + 1);
    if (!cmds.length) return fail(script ? '' : IG.t(`GNU Parted 3.4\nUsing /dev/{0}\nℹ parted の対話モードは再現していません。parted -s /dev/{1} mklabel gpt mkpart primary ext4 0% 100% のようにコマンドを続けて指定してください。`, { 0: d.name, 1: d.name }));
    let unit = null;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i].toLowerCase();
      const next = () => cmds[++i];
      if (c === 'print') { if (!d.pt) { o.e(`Error: /dev/${d.name}: unrecognised disk label`); o.o(partedPrint(h, d, unit)); return o.r(); } o.o(partedPrint(h, d, unit)); continue; }
      if (c === 'unit') { unit = String(next() || 'compact').toLowerCase(); continue; }
      if (c === 'quit') break;
      if (c === 'mklabel' || c === 'mktable') { const l = String(next() || '').toLowerCase(); if (!['gpt', 'msdos'].includes(l)) { o.e(l ? `parted: invalid token: ${l}` : 'Error: Expecting a disk label type.'); return o.r(); } const e = mklabel(h, d, l); if (e) { o.e(e); return o.r(); } continue; }
      if (c === 'mkpart') {
        const toks = [];
        while (i + 1 < cmds.length && !PCMDS.has(cmds[i + 1].toLowerCase()) && toks.filter(t => ppos(t, d) !== null).length < 2) toks.push(cmds[++i]);
        const posn = toks.filter(t => ppos(t, d) !== null), words = toks.filter(t => ppos(t, d) === null);
        if (posn.length < 2) { o.e(posn.length ? 'Error: Expecting a end position.' : 'Error: Expecting a start position.'); return o.r(); }
        if (!d.pt) { o.e(`Error: /dev/${d.name}: unrecognised disk label`); return o.r(); }
        const x = { flags: [] };
        if (d.pt === 'msdos') { if (!/^(primary|extended|logical)$/.test(words[0] || '')) { o.e('Error: Expecting a partition type.'); return o.r(); } x.ptype = words[0]; if (/swap/.test(words[1] || '')) x.flags.push('swap'); }
        else { x.pname = words[0] || ''; if (/swap/.test(words[1] || words[0] || '')) x.flags.push('swap'); }
        const r = addPart(h, d, ppos(posn[0], d), ppos(posn[1], d), x);
        if (typeof r === 'string') { o.e(r); return o.r(); }
        continue;
      }
      if (c === 'rm') { const e = delPart(h, d, Number(next())); if (e) { o.e(e); return o.r(); } continue; }
      if (c === 'resizepart') { const p = d.parts.find(x => x.num === Number(cmds[i + 1])); i++; const end = ppos(next(), d); if (!p) { o.e("Error: Partition doesn't exist."); return o.r(); } if (end === null || end <= p.start) { o.e('Error: Invalid partition boundaries.'); return o.r(); } const nx = d.parts.filter(x => x.start >= p.end).sort((a, b) => a.start - b.start)[0]; if (nx && end > nx.start) { o.e("Error: Can't have overlapping partitions."); return o.r(); } if (end < p.end && inUse(h, vols(h).find(x => x.o === p))) { o.e(`Error: Partition /dev/${p.name} is being used. You must unmount it before you modify it with Parted.`); return o.r(); } p.end = Math.min(end, lastUsable(d)); continue; }
      if (c === 'name') { const p = d.parts.find(x => x.num === Number(next())); const nm = next(); if (!p) { o.e("Error: Partition doesn't exist."); return o.r(); } p.pname = nm || ''; continue; }
      if (c === 'set' || c === 'toggle') { const p = d.parts.find(x => x.num === Number(next())); const fl = String(next() || ''); const on = c === 'toggle' ? !(p && p.flags.includes(fl)) : String(next() || 'on') === 'on'; if (!p) { o.e("Error: Partition doesn't exist."); return o.r(); } p.flags = p.flags.filter(x => x !== fl).concat(on ? [fl] : []); continue; }
      if (c === 'align-check') { next(); next(); o.o(`${cmds[i]} aligned\n`); continue; }
      o.e(`parted: invalid token: ${cmds[i]}`);
      return o.r();
    }
    return o.r();
  };
  C.partprobe = (argv, ctx) => (root(ctx) ? '' : fail(`Error: Error opening ${argv.find(a => a.startsWith('/dev/')) || '/dev/nvme0n1'}: Permission denied`));
  C.partx = (argv, ctx) => (root(ctx) ? '' : fail('partx: cannot open /dev/nvme1n1: Permission denied'));
  C.growpart = (argv, ctx) => {
    const h = ctx.host;
    st(h);
    const [dev, n] = argv.filter(a => !a.startsWith('-'));
    if (!dev || !n) return fail('growpart disk partition\n   rewrite partition table so that partition takes up all the space it can\n   options:\n    -h | --help       print Usage and exit\n    -N | --dry-run    only report what would be done, show new \'sfdisk -d\'\n\n   Example:\n    - growpart /dev/sda 1\n      Resize partition 1 on /dev/sda', 2);
    if (!root(ctx)) return fail(`sfdisk: cannot open ${dev}: Permission denied\nFAILED: failed to dump sfdisk info for ${dev}`);
    if (/^\/dev\/(nvme0n1|xvda|sda)$/.test(dev)) { const sz = Math.round(h.diskGiB * 2097152 - (h.os === 'rhel' ? 3328000 : 227362)); return { stdout: `NOCHANGE: partition ${n} is size ${sz}. it cannot be grown\n`, stderr: '', code: 1 }; }
    const d = h.disks.find(x => '/dev/' + x.name === dev);
    if (!d) return fail(`FAILED: ${dev}: does not exist`);
    const p = d.parts.find(x => x.num === Number(n));
    if (!p) return fail(`WARN: unknown label\nFAILED: failed to get start and size for ${pname(d, n)}`);
    const nx = d.parts.filter(x => x.start >= p.end).sort((a, b) => a.start - b.start)[0];
    const max = nx ? nx.start : lastUsable(d);
    const sec = m => Math.round(m * 2048);
    if (max - p.end < 1) return { stdout: `NOCHANGE: partition ${n} is size ${sec(p.end - p.start)}. it cannot be grown\n`, stderr: '', code: 1 };
    const old = [sec(p.end - p.start), sec(p.end) - 1];
    if (!argv.includes('-N') && !argv.includes('--dry-run')) p.end = max;
    return `CHANGED: partition=${n} start=${sec(p.start)} old: size=${old[0]} end=${old[1]} new: size=${sec(max - p.start)} end=${sec(max) - 1}\n`;
  };

  /* ---------------------------------------------------------------- fdisk */
  function fdiskDisk(name, mib, model, d) {
    const sectors = Math.round(mib * 2048);
    let s = `Disk ${name}: ${humIEC(mib * MiB)}, ${Math.round(mib * MiB)} bytes, ${sectors} sectors\n${model ? 'Disk model: Amazon Elastic Block Store              \n' : ''}Units: sectors of 1 * 512 = 512 bytes\nSector size (logical/physical): 512 bytes / 512 bytes\nI/O size (minimum/optimal): 4096 bytes / 4096 bytes`;
    if (d && d.pt) {
      s += `\nDisklabel type: ${d.pt === 'gpt' ? 'gpt' : 'dos'}\nDisk identifier: ${d.ptuuid}`;
      if (d.parts.length) {
        const gpt = d.pt === 'gpt';
        const hdr = gpt ? ['Device', 'Start', 'End', 'Sectors', 'Size', 'Type'] : ['Device', 'Boot', 'Start', 'End', 'Sectors', 'Size', 'Id', 'Type'];
        const rows = d.parts.map(p => { const a = Math.round(p.start * 2048), b = Math.round(p.end * 2048) - 1; const t = ptype(d, p); return gpt ? ['/dev/' + p.name, String(a), String(b), String(b - a + 1), hum1((p.end - p.start) * MiB), t] : ['/dev/' + p.name, '', String(a), String(b), String(b - a + 1), hum1((p.end - p.start) * MiB), t.slice(0, 2), t.slice(3)]; });
        const all = [hdr].concat(rows);
        const w = hdr.map((_, k) => Math.max(...all.map(r => r[k].length)));
        const left = gpt ? [0, 5] : [0, 1, 7];
        s += '\n\n' + all.map(r => r.map((c, k) => (left.includes(k) ? c.padEnd(w[k]) : c.padStart(w[k]))).join(' ').trimEnd()).join('\n');
      }
    }
    return s;
  }
  function fdiskScript(h, ctx, d, text) {
    const inp = lines(text).map(l => l.trim());
    let i = 0;
    const ask = () => (i < inp.length ? inp[i++] : null);
    const o = out();
    o.o(`\nWelcome to fdisk (util-linux 2.37.2).\nChanges will remain in memory only, until you decide to write them.\nBe careful before using the write command.\n\n`);
    const snap = JSON.stringify({ pt: d.pt, parts: d.parts, ptuuid: d.ptuuid });
    if (!d.pt) { o.o(`Device does not contain a recognized partition table.\n`); mklabel(h, d, 'msdos'); o.o(`Created a new DOS disklabel with disk identifier ${d.ptuuid}.\n`); }
    const total = Math.round(d.mib * 2048);
    const parseLast = (v, first) => { if (!v) return Math.round(lastUsable(d) * 2048) - 1; const m = v.match(/^\+(\d+(?:\.\d+)?)([KMGTP])?$/i); if (m) return first + Math.round((Number(m[1]) * { K: 2, M: 2048, G: 2097152, T: 2147483648, P: 2199023255552 }[(m[2] || 'K').toUpperCase()] || Number(m[1]))) - 1; return Number(v); };
    for (;;) {
      o.o('\nCommand (m for help): ');
      const c = ask();
      if (c === null) { o.o('\n'); restore(); o.e(IG.t('ℹ w（書き込み）が無いまま入力が終わったため、変更は破棄されました。'), 0); return o.r(); }
      if (c === 'w') { o.o('The partition table has been altered.\nCalling ioctl() to re-read partition table.\nSyncing disks.\n'); return o.r(); }
      if (c === 'q') { restore(); o.o('\n'); return o.r(); }
      if (c === 'p') { o.o(fdiskDisk('/dev/' + d.name, d.mib, true, d) + '\n'); continue; }
      if (c === 'g' || c === 'o') { const e = mklabel(h, d, c === 'g' ? 'gpt' : 'msdos'); if (e) { o.o(e + '\n'); continue; } o.o(c === 'g' ? `Created a new GPT disklabel (GUID: ${d.ptuuid}).\n` : `Created a new DOS disklabel with disk identifier ${d.ptuuid}.\n`); continue; }
      if (c === 'n') {
        const gpt = d.pt === 'gpt';
        const free = (gpt ? 128 : 4) - d.parts.length;
        if (!gpt) { o.o(`Partition type\n   p   primary (${d.parts.length} primary, 0 extended, ${free} free)\n   e   extended (container for logical partitions)\nSelect (default p): `); const t = ask(); if (t && t !== 'p') { o.o(IG.t('\nℹ 拡張パーティション（e）は未対応です。\n')); continue; } }
        let def = 1; while (d.parts.some(p => p.num === def)) def++;
        o.o(`Partition number (${def}-${gpt ? 128 : 4}, default ${def}): `); const num = Number(ask() || def) || def;
        const lastEnd = d.parts.length ? Math.max(...d.parts.map(p => Math.round(p.end * 2048))) : 2048;
        const f0 = Math.max(2048, lastEnd);
        const lastSec = Math.round(lastUsable(d) * 2048) - 1;
        o.o(`First sector (${f0}-${lastSec}, default ${f0}): `); const first = Number(ask() || f0) || f0;
        o.o(`Last sector, +/-sectors or +/-size{K,M,G,T,P} (${first}-${lastSec}, default ${lastSec}): `); const last = Math.min(parseLast(ask(), first), lastSec);
        if (!Number.isFinite(first) || !Number.isFinite(last)) { o.o('Value out of range.\n'); continue; }
        const r = addPart(h, d, first / 2048, (last + 1) / 2048, { num, pname: '' });
        if (typeof r === 'string') { o.o(`\nValue out of range.\n`); continue; }
        o.o(`\nCreated a new partition ${num} of type '${gpt ? 'Linux filesystem' : 'Linux'}' and of size ${humIEC((r.end - r.start) * MiB)}.\n`);
        continue;
      }
      if (c === 'd') { let num = d.parts.length === 1 ? d.parts[0].num : null; if (num === null) { o.o(`Partition number (${d.parts.map(p => p.num).join(',')}, default ${d.parts[d.parts.length - 1].num}): `); num = Number(ask() || d.parts[d.parts.length - 1].num); } else o.o(`Selected partition ${num}\n`); const e = delPart(h, d, num); o.o(e ? e.replace(/^Error: /, '') + '\n' : `Partition ${num} has been deleted.\n`); continue; }
      if (c === 't') { let num = d.parts.length === 1 ? d.parts[0].num : null; if (num === null) { o.o('Partition number: '); num = Number(ask()); } else o.o(`Selected partition ${num}\n`); const p = d.parts.find(x => x.num === num); o.o(`Hex code or alias (type L to list all): `); const t = String(ask() || '').toLowerCase(); if (!p) continue; p.flags = p.flags.filter(x => x !== 'lvm' && x !== 'swap'); if (/^(8e|lvm|31|e6d6d379-f507-44c2-a23c-238f2a3df928)$/.test(t)) p.flags.push('lvm'); if (/^(82|swap|19|0657fd6d-a4ab-43c4-84e5-0933c84b4f4f)$/.test(t)) p.flags.push('swap'); o.o(`Changed type of partition '${d.pt === 'gpt' ? 'Linux filesystem' : 'Linux'}' to '${ptype(d, p).replace(/^\w\w /, '')}'.\n`); continue; }
      if (c === 'm') { o.o('Help:\n  d   delete a partition\n  n   add a new partition\n  p   print the partition table\n  t   change a partition type\n  g   create a new empty GPT partition table\n  o   create a new empty DOS partition table\n  w   write table to disk and exit\n  q   quit without saving changes\n'); continue; }
      if (c === '') continue;
      o.o(`${c}: unknown command\n`);
    }
    function restore() { const s0 = JSON.parse(snap); Object.assign(d, s0); }
  }
  C.fdisk = (argv, ctx) => {
    const h = ctx.host;
    st(h);
    const dev = argv.find(a => a.startsWith('/dev/'));
    if (!root(ctx)) return fail(`fdisk: cannot open ${dev || '/dev/nvme0n1'}: Permission denied`);
    const rootBlock = () => {
      const g = h.diskGiB, sec = g * 2097152;
      const parts = h.os === 'rhel' ? `Device           Start       End   Sectors  Size Type\n/dev/nvme0n1p1    2048   1230847   1228800  600M EFI System\n/dev/nvme0n1p2 1230848   3327999   2097152    1G Linux filesystem\n/dev/nvme0n1p3 3328000 ${sec - 34} ${sec - 34 - 3328000 + 1} ${hum1((sec - 3328000) * 512)} Linux LVM` : `Device           Start       End   Sectors  Size Type\n/dev/nvme0n1p1  227328 ${sec - 34} ${sec - 227362} ${(g - 0.1).toFixed(1)}G Linux filesystem\n/dev/nvme0n1p14   2048     10239      8192    4M BIOS boot\n/dev/nvme0n1p15  10240    227327    217088  106M EFI System`;
      return fdiskDisk('/dev/nvme0n1', g * 1024, true) + `\nDisklabel type: gpt\nDisk identifier: 8D6B5A4E-1C2B-4E87-9C0E-6E2F7B3A1D44\n\n${parts}`;
    };
    if (argv.includes('-l') || argv.includes('--list')) {
      if (dev) { if (/^\/dev\/nvme0n1$/.test(dev)) return rootBlock() + '\n'; const v = findVol(h, dev); if (!v) return fail(`fdisk: cannot open ${dev}: No such file or directory`); return fdiskDisk(v.mapper || v.dev, v.mib, v.kind === 'disk', v.kind === 'disk' ? v.o : null) + '\n'; }
      const blocks = [rootBlock()].concat(h.disks.map(d => fdiskDisk('/dev/' + d.name, d.mib, true, d)));
      for (const v of vols(h).filter(x => x.kind === 'lvm')) blocks.push(fdiskDisk(v.mapper, v.mib, false));
      return blocks.join('\n\n\n') + '\n';
    }
    if (!dev) return fail(IG.t("Usage:\n fdisk [options] <disk>         change partition table\n fdisk [options] -l [<disk>...] list partition table(s)\n\nℹ 一覧は sudo fdisk -l です。"), 1);
    if (protectedDev(dev)) return fail(PROTECTED(dev));
    const d = h.disks.find(x => '/dev/' + x.name === dev);
    if (!d) return fail(findVol(h, dev) ? `fdisk: cannot open ${dev}: Inappropriate ioctl for device` : `fdisk: cannot open ${dev}: No such file or directory`);
    const text = ctx.hasStdin ? String(ctx.stdin) : '';
    if (text.trim()) return fdiskScript(h, ctx, d, text);
    return fail(IG.t(`ℹ fdisk の対話操作は再現していません。次のどちらかで指定してください:\n  sudo parted -s {0} mklabel gpt mkpart primary ext4 0% 100%\n  printf 'g\\nn\\n\\n\\n\\nw\\n' | sudo fdisk {1}`, { 0: dev, 1: dev }));
  };

  /* ---------------------------------------------------------------- mkfs / mkswap / labels */
  function ext4Out(dev, mib, id) { const blocks = Math.round(mib * 256), inodes = Math.max(1024, Math.round(mib * 64)); return `Creating filesystem with ${blocks} 4k blocks and ${inodes} inodes\nFilesystem UUID: ${id}\nSuperblock backups stored on blocks: \n\t32768, 98304, 163840, 229376, 294912, 819200, 884736, 1605632, 2654208, 4096000\n\nAllocating group tables: done                            \nWriting inode tables: done                            \nCreating journal (${blocks >= 1048576 ? 32768 : 16384} blocks): done\nWriting superblocks and filesystem accounting information: done   \n\n`; }
  function xfsMeta(dev, mib) { const blocks = Math.round(mib * 256); return `meta-data=${dev.padEnd(22)} isize=512    agcount=4, agsize=${Math.ceil(blocks / 4)} blks\n         =                       sectsz=512   attr=2, projid32bit=1\n         =                       crc=1        finobt=1, sparse=1, rmapbt=0\n         =                       reflink=1    bigtime=1 inobtcount=1 nrext64=0\ndata     =                       bsize=4096   blocks=${blocks}, imaxpct=25\n         =                       sunit=0      swidth=0 blks\nnaming   =version 2              bsize=4096   ascii-ci=0, ftype=1\nlog      =internal log           bsize=4096   blocks=16384, version=2\n         =                       sectsz=512   sunit=0 blks, lazy-count=1\nrealtime =none                   extsz=4096   blocks=0, rtextents=0\n`; }
  function mkfs(type) {
    return (argv, ctx) => {
      const h = ctx.host;
      const { f, pos } = opts(argv, 'LmbTNIOEt', ['label']);
      const dev = pos[0];
      const xfs = type === 'xfs';
      const head = xfs ? '' : `mke2fs 1.46.5 (30-Dec-2021)\n`;
      if (!dev) return fail(xfs ? 'No device name given in argument list\nUsage: mkfs.xfs [options] device' : `Usage: mkfs.${type} [-c|-l filename] [-b block-size] [-C cluster-size]\n\t[-i bytes-per-inode] [-I inode-size] [-J journal-options]\n\t[-L volume-label] [-m reserved-blocks-percentage] [-F] [-q] device [blocks-count]`);
      if (!root(ctx)) return fail(xfs ? `mkfs.xfs: cannot open ${dev}: Permission denied` : `${head}mkfs.${type}: Permission denied while trying to determine filesystem size`);
      if (protectedDev(dev)) return fail(PROTECTED(dev));
      const v = findVol(h, dev);
      if (!v) return fail(xfs ? `mkfs.xfs: cannot open ${dev}: No such file or directory` : `${head}The file ${dev} does not exist and no size was specified.`);
      const busy = inUse(h, v);
      if (busy === 'mounted') return fail(xfs ? `mkfs.xfs: ${dev} contains a mounted filesystem` : `${head}${dev} contains a ${v.o.fs} file system\n\tmounted on ${v.o.mount}\nmkfs.${type}: ${dev} is apparently in use by the system; will not make a filesystem here!`);
      if (busy) return fail(xfs ? `mkfs.xfs: cannot open ${dev}: Device or resource busy` : `${head}mkfs.${type}: ${dev} is apparently in use by the system; will not make a filesystem here!`);
      const sig = sigOf(h, v);
      const force = xfs ? f.f : f.F;
      if (sig && !force) {
        const yes = !xfs && ctx.hasStdin && /^y/i.test(String(ctx.stdin).trim());
        if (!yes) {
          if (xfs) return fail(sig === 'gpt' || sig === 'msdos' ? `mkfs.xfs: ${dev} appears to contain a partition table (${sig === 'msdos' ? 'dos' : sig}).\nmkfs.xfs: Use the -f option to force overwrite.` : `mkfs.xfs: ${dev} appears to contain an existing filesystem (${sig}).\nmkfs.xfs: Use the -f option to force overwrite.`);
          const what = sig === 'gpt' || sig === 'msdos' ? `Found a ${sig === 'msdos' ? 'dos' : sig} partition table in ${dev}` : `${dev} contains a ${sig} file system${v.o.label ? ` labelled '${v.o.label}'` : ''}${v.o.created ? `\n\tcreated on ${new Date(v.o.created).toUTCString().replace(/ GMT$/, '').replace(/^(\w+), (\d+) (\w+) (\d+) (.+)$/, '$1 $3 $2 $5 $4')}` : ''}`;
          return { stdout: `${head}${what}\nProceed anyway? (y,N) \n`, stderr: IG.t(`ℹ 確認プロンプトへの入力は再現できません。上書きする場合は -F を付けるか、echo y | sudo mkfs.{0} {1} としてください。\n`, { 0: type, 1: dev }), code: 1 };
        }
      }
      if (v.kind === 'disk') { v.o.parts = []; v.o.pt = null; }
      delete st(h).pvs[v.dev];
      const id = newId(h, 'fs');
      Object.assign(v.o, { fs: type, uuid: id, label: f.L || f.label || null, fsMiB: v.mib, created: ctx.world.now(), fsckOk: true, broken: false });
      if (f.q) return '';
      return xfs ? xfsMeta(dev, v.mib) + 'Discarding blocks...Done.\n' : `${head}${sig && force ? '' : ''}Discarding device blocks: done                            \n${ext4Out(dev, v.mib, id)}`;
    };
  }
  C['mkfs.ext4'] = mkfs('ext4');
  C['mkfs.xfs'] = mkfs('xfs');
  C['mkfs.ext3'] = mkfs('ext3');
  C['mkfs.ext2'] = mkfs('ext2');
  C.mke2fs = (argv, ctx) => { const t = argv.indexOf('-t'); return mkfs(t >= 0 ? argv[t + 1] : 'ext2')(t >= 0 ? argv.filter((_, i) => i !== t && i !== t + 1) : argv, ctx); };
  C.mkfs = (argv, ctx) => {
    const t = argv.indexOf('-t');
    const type = t >= 0 ? argv[t + 1] : 'ext2';
    const fn = C['mkfs.' + type];
    if (!fn || !ctx.host.hasCommand('mkfs.' + type)) return fail(`mkfs: failed to execute mkfs.${type}: No such file or directory`);
    return fn(t >= 0 ? argv.filter((_, i) => i !== t && i !== t + 1) : argv, ctx);
  };
  C.mkswap = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'LUp', ['label']);
    const t = pos[0];
    if (!t) return fail('mkswap: error: Nowhere to set up swap on?\nTry \'mkswap --help\' for more information.');
    if (protectedDev(t)) return fail(PROTECTED(t));
    const s = st(h);
    const id = newId(h, 'sw');
    const label = f.L || f.label;
    const o = out();
    if (!t.startsWith('/dev/')) {
      const p = ctx.resolve(t);
      if (!ctx.vfs.isFile(p)) return fail(`mkswap: cannot open ${t}: No such file or directory`);
      if (!ctx.shell.canWrite(p)) return fail(`mkswap: cannot open ${t}: Permission denied`);
      const n = ctx.vfs.node(p);
      const bytes = ctx.vfs.fileSize(n);
      if (bytes < 40960) return fail(`mkswap: error: swap area needs to be at least 40 KiB`);
      if (s.swapFiles[p] && s.swapFiles[p].on) return fail(`mkswap: error: ${t} is mounted; will not make swapspace`);
      if (n.mode & 0o077) o.e(`mkswap: ${t}: insecure permissions ${(n.mode & 0o777).toString(8).padStart(4, '0')}, fix with: chmod 0600 ${t}`, 0);
      s.swapFiles[p] = { uuid: id, label, kib: Math.floor(bytes / 1024) - 4, on: false };
      o.o(`Setting up swapspace version 1, size = ${humIEC(bytes - 4096)} (${bytes - 4096} bytes)\n${label ? 'LABEL=' + label : 'no label'}, UUID=${id}\n`);
      return o.r();
    }
    if (!root(ctx)) return fail(`mkswap: cannot open ${t}: Permission denied`);
    const v = findVol(h, t);
    if (!v) return fail(`mkswap: cannot open ${t}: No such file or directory`);
    if (inUse(h, v)) return fail(`mkswap: error: ${t} is mounted; will not make swapspace`);
    const sig = sigOf(h, v);
    if (sig && sig !== 'swap') o.e(`mkswap: ${t}: warning: wiping old ${sig === 'msdos' ? 'dos' : sig} signature.`, 0);
    if (v.kind === 'disk') { v.o.parts = []; v.o.pt = null; }
    delete s.pvs[v.dev];
    Object.assign(v.o, { fs: 'swap', uuid: id, label: label || null, fsMiB: v.mib, created: ctx.world.now() });
    o.o(`Setting up swapspace version 1, size = ${humIEC(v.mib * MiB - 4096)} (${Math.round(v.mib * MiB) - 4096} bytes)\n${label ? 'LABEL=' + label : 'no label'}, UUID=${id}\n`);
    return o.r();
  };
  C.e2label = (argv, ctx) => {
    const h = ctx.host;
    const [dev, label] = argv;
    if (!dev) return fail('Usage: e2label device [newlabel]');
    if (!root(ctx)) return fail(`e2label: Permission denied while trying to open ${dev}\nCouldn't find valid filesystem superblock.`);
    const v = findVol(h, dev);
    if (!v || !/^ext/.test(v.o.fs || '')) return fail(`e2label: ${v ? 'Bad magic number in super-block' : 'No such file or directory'} while trying to open ${dev}\nCouldn't find valid filesystem superblock.`);
    if (label === undefined) return (v.o.label || '') + '\n';
    v.o.label = label.slice(0, 16);
    return '';
  };
  C.wipefs = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'to', ['types', 'output']);
    const dev = pos[0];
    if (!dev) return fail('wipefs: no device specified\nTry \'wipefs --help\' for more information.');
    if (!root(ctx)) return fail(`wipefs: error: ${dev}: probing initialization failed: Permission denied`);
    if (protectedDev(dev)) return fail(PROTECTED(dev));
    const v = findVol(h, dev);
    if (!v) return fail(`wipefs: error: ${dev}: probing initialization failed: No such file or directory`);
    const pv = pvOf(h, v);
    const sigs = [];
    if (v.o.fs) sigs.push({ type: v.o.fs, off: { ext4: 0x438, ext3: 0x438, ext2: 0x438, xfs: 0, swap: 0xff6 }[v.o.fs], bytes: { xfs: '58 46 53 42', swap: '53 57 41 50 53 50 41 43 45 32' }[v.o.fs] || '53 ef', uuid: v.o.uuid, label: v.o.label || '' });
    if (pv) sigs.push({ type: 'LVM2_member', off: 0x218, bytes: '4c 56 4d 32 20 30 30 31', uuid: pv.uuid, label: '' });
    if (v.kind === 'disk' && v.o.pt === 'gpt') sigs.push({ type: 'gpt', off: 0x200, bytes: '45 46 49 20 50 41 52 54', uuid: '', label: '' }, { type: 'gpt', off: Math.round(v.mib * MiB) - 512, bytes: '45 46 49 20 50 41 52 54', uuid: '', label: '' }, { type: 'PMBR', off: 0x1fe, bytes: '55 aa', uuid: '', label: '' });
    if (v.kind === 'disk' && v.o.pt === 'msdos') sigs.push({ type: 'dos', off: 0x1fe, bytes: '55 aa', uuid: '', label: '' });
    if (!(f.a || f.all)) {
      if (!sigs.length) return '';
      const rows = [['DEVICE', 'OFFSET', 'TYPE', 'UUID', 'LABEL']].concat(sigs.map(s => [v.name, '0x' + s.off.toString(16), s.type, s.uuid, s.label]));
      const w = [0, 1, 2, 3].map(k => Math.max(...rows.map(r => r[k].length)));
      return join(rows.map(r => r.map((c, k) => (k < 4 ? c.padEnd(w[k]) : c)).join(' ').trimEnd()));
    }
    if (inUse(h, v)) return fail(`wipefs: error: ${dev}: probing initialization failed: Device or resource busy`);
    const o = out();
    for (const s of sigs) o.o(`${dev}: ${s.bytes.split(' ').length} bytes were erased at offset 0x${s.off.toString(16).padStart(8, '0')} (${s.type}): ${s.bytes}\n`);
    if (v.kind === 'disk' && v.o.pt) o.o(`${dev}: calling ioctl to re-read partition table: Success\n`);
    if (v.kind === 'disk') { v.o.parts = []; v.o.pt = null; }
    delete st(h).pvs[v.dev];
    Object.assign(v.o, { fs: null, uuid: null, label: null, fsMiB: null });
    return o.r();
  };

  /* ---------------------------------------------------------------- fsck / resize */
  const blocks4k = mib => Math.round(mib * 256);
  function e2fsck(argv, ctx) {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'bBjlLC');
    const dev = pos[0];
    const head = 'e2fsck 1.46.5 (30-Dec-2021)\n';
    if (!dev) return fail('Usage: e2fsck [-panyrcdfktvDFV] [-b superblock] [-B blocksize]\n\t\t[-l|-L bad_blocks_file] [-C fd] [-j external_journal]\n\t\t[-E extended-options] [-z undo_file] device', 16);
    if (!root(ctx)) return fail(`${head}e2fsck: Permission denied while trying to open ${dev}\nYou must have r/w access to the filesystem or be root`, 8);
    const v = protectedDev(dev) ? null : findVol(h, dev);
    if (protectedDev(dev)) return fail(`${head}${dev} is mounted.\ne2fsck: Cannot continue, aborting.\n`, 8);
    if (!v) return fail(`${head}e2fsck: No such file or directory while trying to open ${dev}\nPossibly non-existent device?`, 8);
    if (!/^ext/.test(v.o.fs || '')) return fail(`${head}ext2fs_open2: Bad magic number in super-block\ne2fsck: Superblock invalid, trying backup blocks....\ne2fsck: Bad magic number in super-block while trying to open ${dev}\n\nThe superblock could not be read or does not describe a valid ext2/ext3/ext4\nfilesystem.${v.o.fs === 'xfs' ? IG.t('\nℹ XFS の検査は xfs_repair を使います。') : ''}`, 8);
    if (v.o.mount) return fail(`${head}${dev} is mounted.\ne2fsck: Cannot continue, aborting.\n`, 8);
    const used = Math.round(blocks4k(v.o.fsMiB) * 0.025), files = 11 + [...h.vfs.nodes.keys()].length % 7;
    if (v.o.broken) return { stdout: head, stderr: `The filesystem size (according to the superblock) is ${blocks4k(v.o.fsMiB)} blocks\nThe physical size of the device is ${blocks4k(v.mib)} blocks\nEither the superblock or the partition table is likely to be corrupt!\nAbort? yes\n\n`, code: 8 };
    if (!(f.f || f.force)) return `${head}${dev}: clean, ${files}/${Math.round(v.o.fsMiB * 64)} files, ${used}/${blocks4k(v.o.fsMiB)} blocks\n`;
    v.o.fsckOk = true;
    return `${head}Pass 1: Checking inodes, blocks, and sizes\nPass 2: Checking directory structure\nPass 3: Checking directory connectivity\nPass 4: Checking reference counts\nPass 5: Checking group summary information\n${dev}: ${files}/${Math.round(v.o.fsMiB * 64)} files (0.0% non-contiguous), ${used}/${blocks4k(v.o.fsMiB)} blocks\n`;
  }
  C.e2fsck = e2fsck;
  C['fsck.ext4'] = e2fsck;
  C['fsck.xfs'] = (argv, ctx) => (argv.includes('-f') ? 'If you wish to check the consistency of an XFS filesystem or\nrepair a damaged filesystem, see xfs_repair(8).\n' : '');
  C.fsck = (argv, ctx) => {
    const dev = argv.filter(a => !a.startsWith('-'))[0];
    const v = dev && findVol(ctx.host, dev);
    const r = v && v.o.fs === 'xfs' ? C['fsck.xfs'](argv, ctx) : e2fsck(argv, ctx);
    const res = typeof r === 'string' ? { stdout: r, stderr: '', code: 0 } : r;
    return Object.assign({}, res, { stdout: 'fsck from util-linux 2.37.2\n' + res.stdout });
  };
  C.xfs_repair = (argv, ctx) => {
    const h = ctx.host;
    const dev = argv.filter(a => !a.startsWith('-'))[0];
    if (!root(ctx)) return fail(`xfs_repair: cannot open ${dev}: Permission denied`);
    const v = findVol(h, dev);
    if (!v) return fail(`xfs_repair: cannot open ${dev}: No such file or directory`);
    if (v.o.mount) return fail(`xfs_repair: ${dev} contains a mounted filesystem\nxfs_repair: ${dev} contains a mounted and writable filesystem\n\nfatal error -- couldn't initialize XFS library`);
    if (v.o.fs !== 'xfs') return fail(`Phase 1 - find and verify superblock...\nbad primary superblock - bad magic number !!!\n\nattempting to find secondary superblock...\n...Sorry, could not find valid secondary superblock\nExiting now.`);
    return 'Phase 1 - find and verify superblock...\nPhase 2 - using internal log\n        - zero log...\n        - scan filesystem freespace and inode maps...\n        - found root inode chunk\nPhase 3 - for each AG...\nPhase 4 - check for duplicate blocks...\nPhase 5 - rebuild AG headers and trees...\nPhase 6 - check inode connectivity...\nPhase 7 - verify and correct link counts...\ndone\n';
  };
  // grow / shrink an ext4 filesystem; returns { text, err }
  function ext4Resize(h, v, shown, mib) {
    const nb = blocks4k(mib);
    if (Math.abs(mib - v.o.fsMiB) < 0.01) return { text: `The filesystem is already ${nb} (4k) blocks long.  Nothing to do!\n\n` };
    if (mib > v.mib + 0.01) return { err: `The containing partition (or device) is only ${blocks4k(v.mib)} (4k) blocks.\nYou requested a new size of ${nb} blocks.\n\n` };
    if (v.o.mount) {
      if (mib < v.o.fsMiB) return { err: `Filesystem at ${shown} is mounted on ${v.o.mount}; on-line resizing required\nresize2fs: On-line shrinking not supported\n` };
      v.o.fsMiB = mib;
      return { text: `Filesystem at ${shown} is mounted on ${v.o.mount}; on-line resizing required\nold_desc_blocks = ${Math.ceil(v.mib / 32768)}, new_desc_blocks = ${Math.ceil(mib / 32768)}\nThe filesystem on ${shown} is now ${nb} (4k) blocks long.\n\n` };
    }
    if (!v.o.fsckOk) return { err: `Please run 'e2fsck -f ${shown}' first.\n\n` };
    v.o.fsMiB = mib;
    return { text: `Resizing the filesystem on ${shown} to ${nb} (4k) blocks.\nThe filesystem on ${shown} is now ${nb} (4k) blocks long.\n\n` };
  }
  C.resize2fs = (argv, ctx) => {
    const h = ctx.host;
    const { pos } = opts(argv, 'Sbz');
    const dev = pos[0];
    const head = 'resize2fs 1.46.5 (30-Dec-2021)\n';
    if (!dev) return fail(`Usage: resize2fs [-d debug_flags] [-f] [-F] [-M] [-P] [-p] device [-b|-s|new_size] [-S RAID-stride] [-z undo_file]\n`);
    if (!root(ctx)) return fail(`${head}open: Permission denied while opening ${dev}`);
    if (protectedDev(dev)) return `${head}The filesystem is already ${blocks4k(h.diskGiB * 1024 - 111)} (4k) blocks long.  Nothing to do!\n\n`;
    const v = findVol(h, dev);
    if (!v) return fail(`${head}open: No such file or directory while opening ${dev}`);
    if (!/^ext/.test(v.o.fs || '')) return fail(`${head}resize2fs: Bad magic number in super-block while trying to open ${dev}\nCouldn't find valid filesystem superblock.${v.o.fs === 'xfs' ? IG.t('\nℹ XFS の拡張は xfs_growfs <マウントポイント> を使います。') : ''}`);
    let mib = v.mib;
    if (pos[1]) { const z = lsize(pos[1], 'k'); if (!z || !/[kmgts]$/i.test(pos[1])) { if (/^\d+$/.test(pos[1])) mib = Number(pos[1]) / 256; else return fail(`${head}resize2fs: Invalid new size: ${pos[1]}\n`); } else mib = z.mib; }
    const r = ext4Resize(h, v, dev, mib);
    return r.err ? { stdout: head, stderr: r.err, code: 1 } : { stdout: head + r.text, stderr: '', code: 0 };
  };
  function xfsTarget(h, ctx, t) {
    const abs = t && t.startsWith('/') ? t : t && ctx.resolve(t);
    return vols(h).find(v => v.o.fs === 'xfs' && v.o.mount && (v.o.mount === abs || v.dev === t || v.mapper === t));
  }
  C.xfs_growfs = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'DLmR');
    const t = pos[0];
    if (!t) return fail('Usage: xfs_growfs [options] mountpoint\n\nOptions:\n\t-d          grow data/metadata section\n\t-D size     grow data/metadata section to size blks');
    if (t === '/' && h.os === 'rhel') return root(ctx) ? xfsMeta('/dev/mapper/rhel-root', st(h).vgs.rhel.lvs[0].mib) : fail('xfs_growfs: XFS_IOC_FSGROWFSDATA xfsctl failed: Operation not permitted');
    const v = xfsTarget(h, ctx, t);
    if (!v) return fail(`xfs_growfs: ${t} is not a mounted XFS filesystem`);
    const meta = xfsMeta(v.mapper || v.dev, v.o.fsMiB);
    if (!root(ctx)) return fail('xfs_growfs: XFS_IOC_FSGROWFSDATA xfsctl failed: Operation not permitted', 1, meta);
    const target = f.D ? Number(f.D) / 256 : v.mib;
    if (target < v.o.fsMiB) return fail(IG.t('xfs_growfs: XFS_IOC_FSGROWFSDATA xfsctl failed: Invalid argument\nℹ XFS は縮小できません（拡張のみ）。'), 1, meta);
    if (target === v.o.fsMiB) return meta;
    const from = blocks4k(v.o.fsMiB);
    v.o.fsMiB = target;
    return meta + `data blocks changed from ${from} to ${blocks4k(target)}\n`;
  };
  C.xfs_info = (argv, ctx) => {
    const h = ctx.host;
    const t = argv.filter(a => !a.startsWith('-'))[0];
    if (!t) return fail('Usage: xfs_info [-V] [-t mtab] [mountpoint|device|file]');
    if ((t === '/' || t === '/dev/mapper/rhel-root') && h.os === 'rhel') return xfsMeta('/dev/mapper/rhel-root', st(h).vgs.rhel.lvs[0].mib);
    const v = xfsTarget(h, ctx, t) || (findVol(h, t) && findVol(h, t).o.fs === 'xfs' ? findVol(h, t) : null);
    if (!v) return fail(`xfs_info: ${t} is not a mounted XFS filesystem`);
    return xfsMeta(v.mapper || v.dev, v.o.fsMiB);
  };

  /* ---------------------------------------------------------------- mount / umount */
  function doMount(ctx, src, target, type, mopts, o) {
    const h = ctx.host;
    const t = ctx.resolve(target);
    if (type === 'tmpfs' || src === 'tmpfs') {
      if (!ctx.vfs.isDir(t)) return o.e(`mount: ${target}: mount point does not exist.`, 32);
      const m = String(mopts || '').match(/size=(\d+)([kmg%]?)/i);
      st(h).tmpfs.push({ target: t, size: m ? Number(m[1]) * ({ k: 1024, m: MiB, g: 1024 ** 3 }[m[2].toLowerCase()] || 1) : h.memMiB * MiB / 2, opts: mopts || '' });
      return;
    }
    if (protectedDev(src)) return o.e(`mount: ${target}: ${src} already mounted or mount point busy.`, 32);
    const v = findVol(h, src);
    if (!v) return o.e(/^(UUID|LABEL)=/.test(src) ? `mount: ${target}: can't find ${src}.` : `mount: ${target}: special device ${src} does not exist.`, 32);
    const sig = v.o.fs || (pvOf(h, v) ? 'LVM2_member' : null);
    if (sig === 'swap' || sig === 'LVM2_member') return o.e(`mount: ${target}: unknown filesystem type '${sig}'.`, 32);
    if (v.o.broken) return o.e(`mount: ${target}: can't read superblock on ${v.mapper || v.dev}.\n       dmesg(1) may have more information after failed mount system call.`, 32);
    if (!sig || (type && type !== 'auto' && type !== sig)) return o.e(`mount: ${target}: wrong fs type, bad option, bad superblock on ${v.mapper || v.dev}, missing codepage or helper program, or other error.\n       dmesg(1) may have more information after failed mount system call.`, 32);
    if (sig === 'xfs' && !h.hasCommand('mkfs.xfs') && h.os === 'ubuntu') { /* the kernel module exists even without xfsprogs */ }
    if (!ctx.vfs.isDir(t)) return o.e(`mount: ${target}: mount point does not exist.`, 32);
    if (v.o.mount) return o.e(`mount: ${target}: ${v.mapper || v.dev} already mounted on ${v.o.mount}.`, 32);
    v.o.mount = t;
    v.o.fsckOk = false;
    v.o.opts = mopts && mopts !== 'defaults' ? 'rw,relatime,' + mopts.split(',').filter(x => !/^(defaults|nofail|noauto|_netdev|x-systemd\..*)$/.test(x)).join(',') : null;
    if (v.o.opts) v.o.opts = v.o.opts.replace(/,$/, '').replace(/^rw,relatime,ro/, 'ro,relatime');
  }
  C.mount = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'toL', ['types', 'options', 'source', 'target']);
    const type = f.t || f.types;
    const mo = f.o || f.options;
    if (!pos.length && !f.a && !f.all) {
      const rows = mounts(h).filter(m => !type || m.type === type).map(m => `${m.src} on ${m.target} type ${m.type} (${m.opts})`);
      return join(rows.concat(type ? [] : ['proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)', 'sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)']));
    }
    if (!root(ctx)) return fail('mount: only root can do that');
    const o = out();
    if (f.bind || f.B || f.rbind) { o.e(IG.t('ℹ bind マウントはこのシミュレータでは未対応です。')); return o.r(); }
    if (f.a || f.all) {
      for (const e of fstab(h)) {
        if (e.type === 'swap' || ['/', '/boot', '/boot/efi', 'none'].includes(e.target) || /\bnoauto\b/.test(e.opts)) continue;
        const v = findVol(h, e.src);
        if (v && v.o.mount === e.target) continue;
        if (e.type === 'tmpfs' && st(h).tmpfs.some(x => x.target === e.target)) continue;
        const before = o.code;
        doMount(ctx, e.src, e.target, e.type, e.opts, o);
        if (/\bnofail\b/.test(e.opts) && o.code) o.code = before;
      }
      if (fstabStale(h)) o.e(FSTAB_HINT, o.code);
      return o.r();
    }
    if (mo && /\bremount\b/.test(mo)) {
      const v = vols(h).find(x => x.o.mount === ctx.resolve(pos[0]));
      if (!v) { o.e(`mount: ${pos[0]}: mount point not mounted or bad option.`, 32); return o.r(); }
      v.o.opts = (/\bro\b/.test(mo) ? 'ro' : 'rw') + ',relatime';
      return o.r();
    }
    if (pos.length === 1) {
      const e = fstab(h).find(x => x.target === ctx.resolve(pos[0]) || x.src === pos[0]);
      if (!e) { o.e(`mount: ${pos[0]}: can't find in /etc/fstab.`, 1); return o.r(); }
      doMount(ctx, e.src, e.target, type || e.type, mo || e.opts, o);
    } else doMount(ctx, pos[0], pos[1], type, mo, o);
    if (fstabStale(h)) o.e(FSTAB_HINT, o.code);
    return o.r();
  };
  C.umount = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 't');
    if (!pos.length && !f.a) return fail('Usage:\n umount [-hV]\n umount -a [options]\n umount [options] <source> | <directory>', 1);
    if (!root(ctx)) return fail('umount: only root can do that');
    const o = out();
    const targets = f.a ? vols(h).filter(v => v.o.mount && !v.sys).map(v => v.o.mount) : pos;
    for (const t of targets) {
      const abs = t.startsWith('/dev/') ? t : ctx.resolve(t);
      if (abs === '/' || abs === '/boot' || abs === '/boot/efi' || abs === '/run' || abs === '/dev/shm') { o.e(`umount: ${abs}: target is busy.`, 32); continue; }
      const tm = st(h).tmpfs.findIndex(x => x.target === abs);
      if (tm >= 0) { st(h).tmpfs.splice(tm, 1); continue; }
      const v = vols(h).find(x => x.o.mount && (x.o.mount === abs || x.dev === t || x.mapper === t));
      if (!v) { o.e(`umount: ${t}: ${findVol(h, t) || !t.startsWith('/dev/') ? 'not mounted' : 'no mount point specified'}.`, 32); continue; }
      const m = v.o.mount;
      if (!(f.l || f.lazy) && ctx.shell.stack.some(s => s.host === h.name && (s.cwd === m || s.cwd.startsWith(m + '/')))) { o.e(`umount: ${m}: target is busy.`, 32); continue; }
      v.o.mount = null;
      v.o.opts = null;
    }
    return o.r();
  };
  C.findmnt = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'tSTo', ['types', 'source', 'target', 'output']);
    if (f.verify || f.x) {
      const o = out();
      let errs = 0, warns = 0;
      for (const e of fstab(h)) {
        const msgs = [];
        if (['/', '/boot', '/boot/efi'].includes(e.target)) continue;
        if (e.target !== 'none' && e.type !== 'swap' && !h.vfs.exists(e.target)) { if (/\bnoauto\b/.test(e.opts)) { msgs.push('   [W] unreachable target: No such file or directory'); warns++; } else { msgs.push('   [E] unreachable on boot required target: No such file or directory'); errs++; } }
        const v = protectedDev(e.src) ? 'sys' : e.type === 'swap' && !e.src.startsWith('/dev/') && !/=/.test(e.src) ? (st(h).swapFiles[e.src] ? 'file' : null) : findVol(h, e.src);
        if (!v && /^(UUID|LABEL|PARTUUID|PARTLABEL)=/.test(e.src)) { msgs.push(`   [E] unreachable source: ${e.src}`); errs++; }
        else if (!v && !/^(tmpfs|proc|sysfs)$/.test(e.src)) { msgs.push(`   [W] ${e.src}: No such file or directory`); warns++; }
        else if (v && typeof v === 'object') { const disk = v.o.fs || (pvOf(h, v) ? 'LVM2_member' : ''); if (e.type && e.type !== 'auto' && disk !== e.type) { msgs.push(disk ? `   [E] ${e.type} does not match with on-disk ${disk}` : `   [W] cannot detect on-disk filesystem type`); disk ? errs++ : warns++; } }
        if (msgs.length) o.o(`${e.target}\n${msgs.join('\n')}\n`);
      }
      if (fstabStale(h)) { o.o(`   [W] your fstab has been modified, but systemd still uses the old version;\n       use 'systemctl daemon-reload' to reload\n`); warns++; }
      o.o(errs || warns ? `\n0 parse errors, ${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}\n` : 'Success, no errors or warnings detected\n');
      o.code = errs ? 1 : 0;
      return o.r();
    }
    let ms = mounts(h);
    const tgt = f.T || f.target || (pos[0] && !pos[0].startsWith('/dev/') ? ctx.resolve(pos[0]) : null);
    const src = f.S || f.source || (pos[0] && pos[0].startsWith('/dev/') ? pos[0] : null);
    if (tgt) ms = ms.filter(m => m.target === tgt);
    if (src) { const v = findVol(h, src); ms = ms.filter(m => m.src === src || (v && m.vol && m.vol.dev === v.dev)); }
    if (f.t || f.types) ms = ms.filter(m => String(f.t || f.types).split(',').includes(m.type));
    if ((tgt || src || f.t) && !ms.length) return { stdout: '', stderr: '', code: 1 };
    const rows = [['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS']].concat(ms.map(m => [m.target, m.src, m.type, m.opts]));
    const w = [0, 1, 2].map(k => Math.max(...rows.map(r => r[k].length)));
    return join((f.n || f.noheadings ? rows.slice(1) : rows).map(r => r.map((c, k) => (k < 3 ? c.padEnd(w[k]) : c)).join(' ')));
  };

  /* ---------------------------------------------------------------- swapon / swapoff */
  function swapCheckFile(ctx, p, shown, o) {
    const n = ctx.vfs.node(p);
    if (n.mode & 0o077) o.e(`swapon: ${shown}: insecure permissions ${(n.mode & 0o777).toString(8).padStart(4, '0')}, 0600 suggested.`, o.code);
    if (n.owner !== 'root') o.e(`swapon: ${shown}: insecure file owner ${(ctx.host.users[n.owner] || {}).uid ?? 1000}, 0 (root) suggested.`, o.code);
  }
  function swapOn(ctx, t, o, prio) {
    const h = ctx.host, s = st(h);
    if (protectedDev(t) || t === '/dev/dm-1') { o.e(`swapon: ${t}: swapon failed: Device or resource busy`, 255); return; }
    if (!t.startsWith('/dev/') && !/^(UUID|LABEL)=/.test(t)) {
      const p = ctx.resolve(t);
      if (!ctx.vfs.exists(p)) { o.e(`swapon: cannot open ${t}: No such file or directory`, 255); return; }
      const sf = s.swapFiles[p];
      if (!sf) { o.e(`swapon: ${t}: read swap header failed`, 255); return; }
      if (sf.on) { o.e(`swapon: ${t}: swapon failed: Device or resource busy`, 255); return; }
      swapCheckFile(ctx, p, t, o);
      Object.assign(sf, { on: true, prio: prio ?? s.prio-- });
      return;
    }
    const v = findVol(h, t);
    if (!v) { o.e(`swapon: cannot open ${t}: No such file or directory`, 255); return; }
    if (v.o.fs !== 'swap') { o.e(`swapon: ${t}: read swap header failed`, 255); return; }
    if (v.o.swapOn) { o.e(`swapon: ${t}: swapon failed: Device or resource busy`, 255); return; }
    Object.assign(v.o, { swapOn: true, prio: prio ?? s.prio-- });
  }
  C.swapon = (argv, ctx) => {
    const h = ctx.host;
    const { f, pos } = opts(argv, 'p', ['priority']);
    const show = () => {
      const sw = swaps(h);
      if (f.s || f.summary) return join(['Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority'].concat(sw.map(x => `${x.name.padEnd(40)}${x.type}\t${x.type === 'file' ? '\t' : ''}${x.kib}\t\t0\t\t${x.prio}`)));
      if (!sw.length) return '';
      const rows = (f.noheadings ? [] : [['NAME', 'TYPE', 'SIZE', 'USED', 'PRIO']]).concat(sw.map(x => [x.name, x.type, f.bytes ? String(x.kib * 1024) : hum1(x.kib * 1024 + 4096), f.bytes ? '0' : '0B', String(x.prio)]));
      const w = [0, 1, 2, 3].map(k => Math.max(...rows.map(r => r[k].length)));
      return join(rows.map(r => r.map((c, k) => (k === 0 || k === 1 ? c.padEnd(w[k]) : k < 4 ? c.padStart(w[k]) : c.padStart(4))).join(' ')));
    };
    if (f.show || f.s || f.summary || (!pos.length && !f.a && !f.all)) return show();
    if (!root(ctx)) return fail(`swapon: ${pos[0] || '/swapfile'}: swapon failed: Operation not permitted`, 255);
    const o = out();
    const prio = f.p !== undefined ? Number(f.p) : f.priority !== undefined ? Number(f.priority) : undefined;
    if (f.a || f.all) { for (const e of fstab(h).filter(x => x.type === 'swap')) { if (protectedDev(e.src)) continue; const v = findVol(h, e.src); const sf = st(h).swapFiles[e.src]; if ((v && v.o.swapOn) || (sf && sf.on)) continue; swapOn(ctx, e.src, o); } return o.r(); }
    for (const t of pos) swapOn(ctx, t, o, prio);
    return o.r();
  };
  C.swapoff = (argv, ctx) => {
    const h = ctx.host;
    if (!root(ctx)) return fail('swapoff: Not superuser.');
    const { f, pos } = opts(argv, '');
    const o = out();
    if (f.a || f.all) { for (const v of vols(h)) if (v.o.swapOn && !v.sys) v.o.swapOn = false; for (const sf of Object.values(st(h).swapFiles)) sf.on = false; return o.r(); }
    for (const t of pos) {
      if (protectedDev(t) || t === '/dev/dm-1') { o.e(IG.t('ℹ システムのスワップ（rhel-swap）は訓練環境では無効化しません。'), 1); continue; }
      const p = t.startsWith('/dev/') ? null : ctx.resolve(t);
      const sf = p && st(h).swapFiles[p];
      const v = !p && findVol(h, t);
      if (sf && sf.on) { sf.on = false; continue; }
      if (v && v.o.swapOn) { v.o.swapOn = false; continue; }
      o.e(`swapoff: ${t}: swapoff failed: Invalid argument`, 255);
    }
    return o.r();
  };

  /* ---------------------------------------------------------------- LVM */
  const LVM_DENY = { stdout: '', stderr: '  WARNING: Running as a non-root user. Functionality may be unavailable.\n  /run/lock/lvm/P_global:aux: open failed: Permission denied\n', code: 5 };
  function vgInfo(h, name) {
    const s = st(h), g = s.vgs[name];
    const pvs = Object.keys(s.pvs).filter(d => s.pvs[d].vg === name);
    const pe = d => Math.floor((s.pvs[d].mib - 1) / PE);
    const total = pvs.reduce((a, d) => a + pe(d), 0);
    const used = g.lvs.reduce((a, l) => a + l.mib / PE, 0);
    const ranges = []; let c = 0;
    for (const d of pvs) { ranges.push({ d, a: c, b: c + pe(d) }); c += pe(d); }
    const lvr = []; c = 0;
    for (const l of g.lvs) { lvr.push({ l, a: c, b: c + l.mib / PE }); c += l.mib / PE; }
    const rng = d => ranges.find(x => x.d === d);
    return { g, pvs, pe, total, used, free: total - used, onPv: d => lvr.filter(x => x.a < rng(d).b && x.b > rng(d).a).map(x => x.l), allocPv: d => Math.max(0, Math.min(rng(d).b, used) - rng(d).a), lvPvs: l => { const r = lvr.find(x => x.l === l); return ranges.filter(x => x.a < r.b && x.b > r.a).map(x => x.d); } };
  }
  function findLv(h, t) {
    const s = st(h);
    let m = String(t || '').match(/^(?:\/dev\/)?([^/]+)\/([^/]+)$/);
    if (m && m[1] !== 'mapper' && s.vgs[m[1]]) { const lv = s.vgs[m[1]].lvs.find(l => l.name === m[2]); return lv ? { vg: m[1], lv } : { vg: m[1], missing: m[2] }; }
    m = String(t || '').match(/^\/dev\/mapper\/(.+)$/);
    if (m) for (const [vg, g] of Object.entries(s.vgs)) for (const lv of g.lvs) if (mapName(vg, lv.name) === m[1]) return { vg, lv };
    m = String(t || '').match(/^(?:\/dev\/)?([^/]+)\/([^/]+)$/);
    return m ? { vgMissing: m[1] } : null;
  }
  const lvmTable = (hdr, rows, right) => { const all = [hdr].concat(rows); const w = hdr.map((_, k) => Math.max(...all.map(r => r[k].length))); return join(all.map((r, i) => '  ' + r.map((c, k) => (i > 0 && right.includes(k) ? c.padStart(w[k]) : c.padEnd(w[k]))).join(' ').trimEnd())); };
  const nameFilter = (pos, key) => x => !pos.length || pos.some(p => p === x[key] || p.replace(/^\/dev\//, '') === x[key]);
  C.pvs = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { pos } = opts(argv, 'oO', ['options', 'units']);
    const rows = Object.entries(s.pvs).filter(([d]) => !pos.length || pos.includes(d)).map(([d, p]) => { if (!p.vg) return [d, '', 'lvm2', '---', lsz(p.mib), lsz(p.mib)]; const vi = vgInfo(h, p.vg); return [d, p.vg, 'lvm2', 'a--', lsz(vi.pe(d) * PE), lsz((vi.pe(d) - vi.allocPv(d)) * PE)]; });
    if (pos.length && !rows.length) return fail(`  Failed to find physical volume "${pos[0]}".`, 5);
    return rows.length ? lvmTable(['PV', 'VG', 'Fmt', 'Attr', 'PSize', 'PFree'], rows, [4, 5]) : '';
  };
  C.vgs = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { pos } = opts(argv, 'oO', ['options', 'units']);
    const names = Object.keys(s.vgs).filter(n => !pos.length || pos.includes(n));
    if (pos.length && !names.length) return fail(`  Volume group "${pos[0]}" not found\n  Cannot process volume group ${pos[0]}`, 5);
    return names.length ? lvmTable(['VG', '#PV', '#LV', '#SN', 'Attr', 'VSize', 'VFree'], names.map(n => { const vi = vgInfo(h, n); return [n, String(vi.pvs.length), String(vi.g.lvs.length), '0', 'wz--n-', lsz(vi.total * PE), lsz(vi.free * PE)]; }), [1, 2, 3, 5, 6]) : '';
  };
  const lvAttr = lv => `-wi-a${lv.mount || lv.swapOn ? 'o' : '-'}----`;
  C.lvs = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { pos } = opts(argv, 'oO', ['options', 'units']);
    const rows = [];
    for (const [vg, g] of Object.entries(s.vgs)) for (const lv of g.lvs) if (!pos.length || pos.some(p => p === vg || findLv(h, p)?.lv === lv)) rows.push([lv.name, vg, lvAttr(lv), lsz(lv.mib), '', '', '', '', '', '', '', '']);
    return rows.length ? lvmTable(['LV', 'VG', 'Attr', 'LSize', 'Pool', 'Origin', 'Data%', 'Meta%', 'Move', 'Log', 'Cpy%Sync', 'Convert'], rows, [3]) : pos.length ? fail(`  Failed to find logical volume "${pos[0]}"`, 5) : '';
  };
  const kv = (k, v) => `  ${k.padEnd(21)} ${v}`;
  C.pvdisplay = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const pos = argv.filter(a => !a.startsWith('-'));
    const list = Object.entries(s.pvs).filter(([d]) => !pos.length || pos.includes(d));
    if (pos.length && !list.length) return fail(`  Failed to find physical volume "${pos[0]}".`, 5);
    return list.map(([d, p]) => {
      if (!p.vg) return `  "${d}" is a new physical volume of "${lsz(p.mib, true)}"\n  --- NEW Physical volume ---\n${kv('PV Name', d)}\n${kv('VG Name', '')}\n${kv('PV Size', lsz(p.mib, true))}\n${kv('Allocatable', 'NO')}\n${kv('PE Size', '0   ')}\n${kv('Total PE', '0')}\n${kv('Free PE', '0')}\n${kv('Allocated PE', '0')}\n${kv('PV UUID', p.uuid)}\n   \n`;
      const vi = vgInfo(h, p.vg), tot = vi.pe(d), al = vi.allocPv(d);
      return `  --- Physical volume ---\n${kv('PV Name', d)}\n${kv('VG Name', p.vg)}\n${kv('PV Size', `${lsz(p.mib, true)} / not usable ${lsz(p.mib - tot * PE, true)}`)}\n${kv('Allocatable', `yes ${tot === al ? '(but full)' : ''}`)}\n${kv('PE Size', '4.00 MiB')}\n${kv('Total PE', String(tot))}\n${kv('Free PE', String(tot - al))}\n${kv('Allocated PE', String(al))}\n${kv('PV UUID', p.uuid)}\n   \n`;
    }).join('');
  };
  C.vgdisplay = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const pos = argv.filter(a => !a.startsWith('-'));
    const names = Object.keys(s.vgs).filter(n => !pos.length || pos.includes(n));
    if (pos.length && !names.length) return fail(`  Volume group "${pos[0]}" not found\n  Cannot process volume group ${pos[0]}`, 5);
    return names.map(n => { const vi = vgInfo(h, n); const open = vi.g.lvs.filter(l => l.mount || l.swapOn).length; return `  --- Volume group ---\n${kv('VG Name', n)}\n${kv('System ID', '')}\n${kv('Format', 'lvm2')}\n${kv('Metadata Areas', String(vi.pvs.length))}\n${kv('Metadata Sequence No', String(1 + vi.g.lvs.length + (vi.g.seq || 0)))}\n${kv('VG Access', 'read/write')}\n${kv('VG Status', 'resizable')}\n${kv('MAX LV', '0')}\n${kv('Cur LV', String(vi.g.lvs.length))}\n${kv('Open LV', String(open))}\n${kv('Max PV', '0')}\n${kv('Cur PV', String(vi.pvs.length))}\n${kv('Act PV', String(vi.pvs.length))}\n${kv('VG Size', lsz(vi.total * PE, true))}\n${kv('PE Size', '4.00 MiB')}\n${kv('Total PE', String(vi.total))}\n${kv('Alloc PE / Size', `${vi.used} / ${lsz(vi.used * PE, true)}`)}\n${kv('Free  PE / Size', `${vi.free} / ${lsz(vi.free * PE, true)}`)}\n${kv('VG UUID', vi.g.uuid)}\n   \n`; }).join('');
  };
  C.lvdisplay = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const pos = argv.filter(a => !a.startsWith('-'));
    const items = [];
    for (const [vg, g] of Object.entries(s.vgs)) for (const lv of g.lvs) if (!pos.length || pos.some(p => p === vg || findLv(h, p)?.lv === lv)) items.push([vg, lv]);
    if (pos.length && !items.length) return fail(`  Failed to find logical volume "${pos[0]}"`, 5);
    return items.map(([vg, lv]) => `  --- Logical volume ---\n${kv('LV Path', `/dev/${vg}/${lv.name}`)}\n${kv('LV Name', lv.name)}\n${kv('VG Name', vg)}\n${kv('LV UUID', lv.lvid || (lv.lvid = lvmId(h.name + vg + lv.name)))}\n${kv('LV Write Access', 'read/write')}\n${'  LV Creation host, time'} ${h.hostname}, ${IG.strftime('%F %T +0000', lv.created || h.bootAt)}\n${kv('LV Status', 'available')}\n${kv('# open', lv.mount || lv.swapOn ? '1' : '0')}\n${kv('LV Size', lsz(lv.mib, true))}\n${kv('Current LE', String(lv.mib / PE))}\n${kv('Segments', String(vgInfo(h, vg).lvPvs(lv).length))}\n${kv('Allocation', 'inherit')}\n${kv('Read ahead sectors', 'auto')}\n${kv('- currently set to', '256')}\n${kv('Block device', `253:${lv.dm}`)}\n   \n`).join('');
  };
  // shared PV initialisation (pvcreate, and vgcreate/vgextend on a plain device)
  function pvInit(ctx, dev, f, o) {
    const h = ctx.host, s = st(h);
    if (protectedDev(dev)) { o.e(PROTECTED(dev), 5); return false; }
    const v = findVol(h, dev);
    if (!v || v.kind === 'lvm') { o.e(`  No device found for ${dev}.`, 5); return false; }
    if (s.pvs[dev] && s.pvs[dev].vg) { o.e(`  Can't initialize physical volume "${dev}" of volume group "${s.pvs[dev].vg}" without -ff\n  ${dev}: physical volume not initialized.`, 5); return false; }
    if (v.kind === 'disk' && v.o.parts.length) { o.e(`  Cannot use ${dev}: device is partitioned`, 5); return false; }
    if (v.o.mount || v.o.swapOn) { o.e(`  Can't open ${dev} exclusively.  Mounted filesystem?\n  Can't open ${dev} exclusively.  Mounted filesystem?`, 5); return false; }
    const sig = v.o.fs || (v.kind === 'disk' && v.o.pt) || null;
    if (sig) {
      const off = { ext4: 1080, xfs: 0, swap: 4086, gpt: 512, msdos: 510 }[sig] ?? 0;
      const yes = f.y || f.yes || (f.f && f.f !== true) || f.ff || (ctx.hasStdin && /^y/i.test(String(ctx.stdin).trim()));
      if (!yes) { o.o(`WARNING: ${sig === 'msdos' ? 'dos' : sig} signature detected on ${dev} at offset ${off}. Wipe it? [y/n]: [n]\n`); o.e(IG.t(`  Aborted wiping of {0}.\n  1 existing signature left on the device.\nℹ 既存の署名を消して続けるには -y を付けてください（例: sudo pvcreate -y {1}）。`, { 0: sig === 'msdos' ? 'dos' : sig, 1: dev }), 5); return false; }
      o.o(`  Wiping ${sig === 'msdos' ? 'dos' : sig} signature on ${dev}.\n`);
      Object.assign(v.o, { fs: null, uuid: null, label: null, pt: null });
    }
    s.pvs[dev] = { vg: null, mib: v.mib, uuid: lvmId(h.name + dev + s.seq++) };
    o.o(`  Physical volume "${dev}" successfully created.\n`);
    return true;
  }
  C.pvcreate = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const { f, pos } = opts(argv, '');
    if (!pos.length) return fail('  Please enter a physical volume path.\n  Run `pvcreate --help\' for more information.', 3);
    const o = out();
    for (const d of pos) pvInit(ctx, d, f, o);
    return o.r();
  };
  C.pvremove = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const o = out();
    for (const d of argv.filter(a => !a.startsWith('-'))) {
      const p = s.pvs[d];
      if (!p) { o.e(`  No PV found on device ${d}.`, 5); continue; }
      if (p.vg) { o.e(`  PV ${d} is used by VG ${p.vg} so please use vgreduce first.\n  (If you are certain you need pvremove, then confirm by using --force twice.)\n  ${d}: physical volume label not removed.`, 5); continue; }
      delete s.pvs[d];
      o.o(`  Labels on physical volume "${d}" successfully wiped.\n`);
    }
    return o.r();
  };
  C.vgcreate = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { f, pos } = opts(argv, 's', ['physicalextentsize']);
    const [name, ...devs] = pos;
    if (!name) return fail('  No command with matching syntax recognised.  Run \'vgcreate --help\' for more information.\n  Correct command syntax is:\n  vgcreate VG_new PV ...', 3);
    if (!devs.length) return fail('  Please enter physical volume name(s)\n  Run `vgcreate --help\' for more information.', 3);
    if (s.vgs[name]) return fail(`  A volume group called ${name} already exists.`, 5);
    if (!/^[A-Za-z0-9+_.][A-Za-z0-9+_.-]*$/.test(name)) return fail(`  Name contains invalid character, valid set includes: [a-zA-Z0-9.-_+].\n  New volume group name "${name}" is invalid.`, 3);
    const o = out();
    for (const d of devs) { if (s.pvs[d] && s.pvs[d].vg) { o.e(`  Physical volume '${d}' is already in volume group '${s.pvs[d].vg}'\n  Unable to add physical volume '${d}' to volume group '${name}'\n  ${d}: physical volume not initialized.`, 5); return o.r(); } }
    for (const d of devs) if (!s.pvs[d] && !pvInit(ctx, d, f, o)) return o.r();
    s.vgs[name] = { uuid: lvmId(h.name + 'vg' + name + s.seq++), lvs: [] };
    for (const d of devs) s.pvs[d].vg = name;
    o.o(`  Volume group "${name}" successfully created\n`);
    return o.r();
  };
  C.vgextend = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { f, pos } = opts(argv, '');
    const [name, ...devs] = pos;
    if (!s.vgs[name]) return fail(`  Volume group "${name}" not found\n  Cannot process volume group ${name}`, 5);
    if (!devs.length) return fail('  Please enter physical volume(s)\n  Run `vgextend --help\' for more information.', 3);
    const o = out();
    for (const d of devs) { if (s.pvs[d] && s.pvs[d].vg) { o.e(`  Physical volume '${d}' is already in volume group '${s.pvs[d].vg}'\n  Unable to add physical volume '${d}' to volume group '${name}'\n  ${d}: physical volume not initialized.`, 5); return o.r(); } if (!s.pvs[d] && !pvInit(ctx, d, f, o)) return o.r(); s.pvs[d].vg = name; }
    s.vgs[name].seq = (s.vgs[name].seq || 0) + 1;
    o.o(`  Volume group "${name}" successfully extended\n`);
    return o.r();
  };
  C.vgreduce = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const [name, ...devs] = argv.filter(a => !a.startsWith('-'));
    if (!s.vgs[name]) return fail(`  Volume group "${name}" not found\n  Cannot process volume group ${name}`, 5);
    if (s.vgs[name].sys) return fail(PROTECTED('/dev/' + name), 5);
    const o = out();
    for (const d of devs) {
      if (!s.pvs[d] || s.pvs[d].vg !== name) { o.e(`  Physical Volume "${d}" not found in Volume Group "${name}".`, 5); continue; }
      const vi = vgInfo(h, name);
      if (vi.allocPv(d)) { o.e(`  Physical volume "${d}" still in use`, 5); continue; }
      if (vi.pvs.length === 1) { o.e(`  Can't remove final physical volume "${d}" from volume group "${name}"`, 5); continue; }
      s.pvs[d].vg = null;
      o.o(`  Removed "${d}" from volume group "${name}"\n`);
    }
    return o.r();
  };
  C.vgremove = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { f, pos } = opts(argv, '');
    const o = out();
    for (const name of pos) {
      const g = s.vgs[name];
      if (!g) { o.e(`  Volume group "${name}" not found\n  Cannot process volume group ${name}`, 5); continue; }
      if (g.sys) { o.e(PROTECTED('/dev/' + name), 5); continue; }
      const busy = g.lvs.find(l => l.mount || l.swapOn);
      if (busy) { o.e(`  Logical volume ${name}/${busy.name} contains a filesystem in use.`, 5); continue; }
      if (g.lvs.length && !(f.f || f.force || f.y || f.yes)) { o.o(`Do you really want to remove volume group "${name}" containing ${g.lvs.length} logical volumes? [y/n]: `); if (!(ctx.hasStdin && /^y/i.test(String(ctx.stdin).trim()))) { o.o('\n'); o.e(IG.t(`  Volume group "{0}" not removed\nℹ 確認プロンプトへの入力は再現できません。-y（または -f）を付けてください。`, { 0: name }), 5); continue; } o.o('\n'); }
      for (const l of g.lvs) o.o(`  Logical volume "${l.name}" successfully removed.\n`);
      for (const d of Object.keys(s.pvs)) if (s.pvs[d].vg === name) s.pvs[d].vg = null;
      delete s.vgs[name];
      o.o(`  Volume group "${name}" successfully removed\n`);
    }
    return o.r();
  };
  // -l 100%FREE / 50%VG / 1280 / +100%FREE  → extents (relative when signed)
  function extSpec(spec, vi, cur) {
    const m = String(spec).match(/^([+-])?(\d+)(?:%(FREE|VG|PVS|ORIGIN))?$/i);
    if (!m) return null;
    const n = Number(m[2]);
    const base = m[3] ? Math.floor((n * ({ FREE: vi.free, VG: vi.total, PVS: vi.total, ORIGIN: cur }[m[3].toUpperCase()])) / 100) : n;
    return { sign: m[1] || '', ext: base };
  }
  C.lvcreate = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { f, pos } = opts(argv, 'LlnTsi', ['size', 'extents', 'name', 'type', 'snapshot']);
    if (f.T || f.thin || f.s || f.snapshot || f.type) return fail(IG.t('ℹ スナップショット・シンプロビジョニング・RAID の LV はこのシミュレータでは未対応です（通常の linear LV のみ）。'), 3);
    const vgn = String(pos[0] || '').replace(/^\/dev\//, '').split('/')[0];
    if (!vgn) return fail('  Please specify a volume group name.\n  Run `lvcreate --help\' for more information.', 3);
    if (!s.vgs[vgn]) return fail(`  Volume group "${vgn}" not found\n  Cannot process volume group ${vgn}`, 5);
    const vi = vgInfo(h, vgn);
    const L = f.L || f.size, l = f.l || f.extents;
    if (L && l) return fail('  Please specify either size or extents (not both).', 3);
    if (!L && !l) return fail('  Please specify either size or extents.', 3);
    const o = out();
    let ext;
    if (L) { const z = lsize(L); if (!z || z.sign) return fail(`  Invalid argument for --size: ${L}\n  Error during parsing of command line.`, 3); ext = Math.ceil(z.mib / PE - 1e-9); if (Math.abs(ext * PE - z.mib) > 1e-6) o.o(`  Rounding up size to full physical extent ${lsz(ext * PE, true)}.\n`); }
    else { const e = extSpec(l, vi, 0); if (!e || e.sign) return fail(`  Invalid argument for --extents: ${l}\n  Error during parsing of command line.`, 3); ext = e.ext; }
    if (ext <= 0) return fail('  Invalid size or extents: Size must be positive (or use lvremove).', 3);
    if (ext > vi.free) return fail(`  Volume group "${vgn}" has insufficient free space (${vi.free} extents): ${ext} required.`, 5, o.so);
    const name = f.n || f.name || (() => { let k = 0; while (s.vgs[vgn].lvs.some(x => x.name === 'lvol' + k)) k++; return 'lvol' + k; })();
    if (s.vgs[vgn].lvs.some(x => x.name === name)) return fail(`  Logical Volume "${name}" already exists in volume group "${vgn}"`, 5, o.so);
    s.vgs[vgn].lvs.push({ name, mib: ext * PE, dm: s.dm++, created: ctx.world.now(), fs: null, mount: null });
    o.o(`  Logical volume "${name}" created.\n`);
    return o.r();
  };
  function lvResize(mode) {
    return (argv, ctx) => {
      if (!root(ctx)) return LVM_DENY;
      const h = ctx.host, s = st(h);
      const { f, pos } = opts(argv, 'Ll', ['size', 'extents']);
      const cmd = 'lv' + mode;
      const L = f.L || f.size, l = f.l || f.extents;
      if (!pos.length) return fail(`  Please specify a logical volume path.\n  Run \`${cmd} --help' for more information.`, 3);
      const r = findLv(h, pos[0]);
      if (!r || r.vgMissing) return fail(`  Volume group "${r ? r.vgMissing : pos[0]}" not found\n  Cannot process volume group ${r ? r.vgMissing : pos[0]}`, 5);
      if (r.missing) return fail(`  Logical volume ${r.vg}/${r.missing} not found.`, 5);
      const { vg, lv } = r;
      if (!L && !l) return fail(`  Please specify either size or extents.`, 3);
      const vi = vgInfo(h, vg);
      const cur = lv.mib / PE;
      let want;
      const o = out();
      if (L) { const z = lsize(L); if (!z) return fail(`  Invalid argument for --size: ${L}`, 3); const e = Math.ceil(z.mib / PE - 1e-9); if (Math.abs(e * PE - z.mib) > 1e-6) o.o(`  Rounding size to boundary between physical extents: ${lsz(e * PE, true)}.\n`); want = z.sign === '+' ? cur + e : z.sign === '-' ? cur - e : e; }
      else { const e = extSpec(l, vi, cur); if (!e) return fail(`  Invalid argument for --extents: ${l}`, 3); want = e.sign === '+' ? cur + e.ext : e.sign === '-' ? cur - e.ext : e.ext; }
      if (want === cur) return fail(`  New size (${cur} extents) matches existing size (${cur} extents).`, 5, o.so);
      if (mode === 'extend' && want < cur) return fail(`  New size given (${want} extents) not larger than existing size (${cur} extents)`, 3, o.so);
      if (mode === 'reduce' && want > cur) return fail(`  New size given (${want} extents) not less than existing size (${cur} extents)`, 3, o.so);
      if (want <= 0) return fail('  Size must be positive (or use lvremove).', 3, o.so);
      const shown = '/dev/mapper/' + mapName(vg, lv.name);
      const v = vols(h).find(x => x.o === lv);
      let fsOut = '';
      if (want > cur) {
        if (want - cur > vi.free) return fail(`  Insufficient free space: ${want - cur} extents needed, but only ${vi.free} available`, 5, o.so);
      } else {
        if (lv.sys) return fail(PROTECTED(`/dev/${vg}/${lv.name}`), 5);
        if (lv.fs && lv.fs !== 'swap' && (f.r || f.resizefs)) {
          if (lv.fs === 'xfs') return fail(IG.t(`  File system xfs found on {0}/{1}.\n  File system size ({2}) is larger than the requested size ({3}).\n  File system reduce is required and not supported (xfs).\nℹ XFS は縮小できません。データを退避して作り直す必要があります。`, { 0: vg, 1: lv.name, 2: lsz(lv.fsMiB, true), 3: lsz(want * PE, true) }), 5, o.so);
          if (lv.mount) return fail(IG.t(`  File system ext4 found on {0}/{1} mounted at {2}.\n  File system size ({3}) is larger than the requested size ({4}).\n  File system reduce is required and not supported while mounted.\nℹ ext4 の縮小はアンマウントしてから行います（sudo umount {5}）。`, { 0: vg, 1: lv.name, 2: lv.mount, 3: lsz(lv.fsMiB, true), 4: lsz(want * PE, true), 5: lv.mount }), 5, o.so);
          lv.fsckOk = true;
          const rr = ext4Resize(h, v, shown, want * PE);
          if (rr.err) return fail(rr.err, 5, o.so);
          fsOut = `fsck from util-linux 2.37.2\n${shown}: clean\nresize2fs 1.46.5 (30-Dec-2021)\n${rr.text}`;
        } else if (lv.fs && lv.fsMiB > want * PE + 1e-6) {
          o.o(`  WARNING: Reducing active${lv.mount ? ' and open' : ''} logical volume to ${lsz(want * PE, true)}.\n  THIS MAY DESTROY YOUR DATA (filesystem etc.)\n`);
          if (!(f.f || f.force || f.y || f.yes || (ctx.hasStdin && /^y/i.test(String(ctx.stdin).trim())))) { o.o(`Do you really want to reduce ${vg}/${lv.name}? [y/n]: \n`); o.e(IG.t(`  Logical volume {0}/{1} NOT reduced.\nℹ ファイルシステムごと縮小するには -r（--resizefs）を付けます。-f で強行するとファイルシステムが壊れます。`, { 0: vg, 1: lv.name }), 5); return o.r(); }
          lv.broken = true;
        }
      }
      // a shrinking filesystem is resized before the LV, a growing one after it
      o.o(fsOut + `  Size of logical volume ${vg}/${lv.name} changed from ${lsz(cur * PE, true)} (${cur} extents) to ${lsz(want * PE, true)} (${want} extents).\n  Logical volume ${vg}/${lv.name} successfully resized.\n`);
      lv.mib = want * PE;
      if (want > cur && (f.r || f.resizefs) && lv.fs) {
        const nv = vols(h).find(x => x.o === lv);
        if (/^ext/.test(lv.fs)) { if (!lv.mount) { lv.fsckOk = true; o.o(`fsck from util-linux 2.37.2\n${shown}: clean, 11/${Math.round(lv.fsMiB * 64)} files, ${Math.round(blocks4k(lv.fsMiB) * 0.025)}/${blocks4k(lv.fsMiB)} blocks\n`); } const rr = ext4Resize(h, nv, shown, nv.mib); o.o('resize2fs 1.46.5 (30-Dec-2021)\n' + (rr.text || rr.err)); }
        else if (lv.fs === 'xfs') { const from = blocks4k(lv.fsMiB); o.o(xfsMeta(shown, lv.fsMiB) + `data blocks changed from ${from} to ${blocks4k(nv.mib)}\n`); lv.fsMiB = nv.mib; }
      }
      if (lv.broken && lv.fsMiB <= lv.mib) lv.broken = false;
      return o.r();
    };
  }
  C.lvextend = lvResize('extend');
  C.lvreduce = lvResize('reduce');
  C.lvresize = lvResize('resize');
  C.lvremove = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const { f, pos } = opts(argv, '');
    if (!pos.length) return fail('  No command with matching syntax recognised.  Run \'lvremove --help\' for more information.', 3);
    const o = out();
    const yes = f.f || f.force || f.y || f.yes || (ctx.hasStdin && /^y/i.test(String(ctx.stdin).trim()));
    for (const t of pos) {
      const targets = s.vgs[t.replace(/^\/dev\//, '')] ? s.vgs[t.replace(/^\/dev\//, '')].lvs.map(lv => ({ vg: t.replace(/^\/dev\//, ''), lv })) : [findLv(h, t)];
      for (const r of targets) {
        if (!r || r.vgMissing) { o.e(`  Volume group "${r ? r.vgMissing : t}" not found\n  Cannot process volume group ${r ? r.vgMissing : t}`, 5); continue; }
        if (r.missing) { o.e(`  Failed to find logical volume "${r.vg}/${r.missing}"`, 5); continue; }
        if (r.lv.sys) { o.e(PROTECTED(`/dev/${r.vg}/${r.lv.name}`), 5); continue; }
        if (r.lv.mount || r.lv.swapOn) { o.e(`  Logical volume ${r.vg}/${r.lv.name} contains a filesystem in use.`, 5); continue; }
        if (!yes) { o.o(`Do you really want to remove active logical volume ${r.vg}/${r.lv.name}? [y/n]: \n`); o.e(IG.t(`  Logical volume "{0}" not removed.\nℹ 確認プロンプトへの入力は再現できません。-y を付けるか echo y | sudo lvremove ... としてください。`, { 0: r.lv.name }), 5); continue; }
        s.vgs[r.vg].lvs = s.vgs[r.vg].lvs.filter(x => x !== r.lv);
        o.o(`  Logical volume "${r.lv.name}" successfully removed.\n`);
      }
    }
    return o.r();
  };
  C.lvrename = (argv, ctx) => {
    if (!root(ctx)) return LVM_DENY;
    const h = ctx.host, s = st(h);
    const p = argv.filter(a => !a.startsWith('-'));
    const [vg, from, to] = p.length === 3 ? p : [findLv(h, p[0])?.vg, findLv(h, p[0])?.lv?.name, String(p[1] || '').split('/').pop()];
    const g = s.vgs[vg];
    const lv = g && g.lvs.find(x => x.name === from);
    if (!lv) return fail(`  Existing logical volume "${from}" not found in volume group "${vg}"`, 5);
    if (lv.sys) return fail(PROTECTED(`/dev/${vg}/${from}`), 5);
    if (g.lvs.some(x => x.name === to)) return fail(`  Logical Volume "${to}" already exists in volume group "${vg}"`, 5);
    lv.name = to;
    return `  Renamed "${from}" to "${to}" in volume group "${vg}"\n`;
  };

  /* ---------------------------------------------------------------- boot */
  // called by reboot: mounts come only from /etc/fstab; broken entries without nofail are reported
  IG.storageBoot = h => {
    const s = st(h);
    for (const v of vols(h)) if (!v.sys) { v.o.mount = null; v.o.swapOn = false; v.o.opts = null; }
    for (const sf of Object.values(s.swapFiles)) sf.on = false;
    s.tmpfs = [];
    const problems = [];
    const ctx = { host: h, vfs: h.vfs, world: h.world, resolve: p => p, user: 'root' };
    for (const e of fstab(h)) {
      if (['/', '/boot', '/boot/efi'].includes(e.target) || protectedDev(e.src) || /\bnoauto\b/.test(e.opts)) continue;
      const o = out();
      if (e.type === 'swap') {
        if (e.src.startsWith('/dev/') || /^(UUID|LABEL)=/.test(e.src)) { const v = findVol(h, e.src); if (v && v.o.fs === 'swap') v.o.swapOn = true; else o.e('x'); }
        else if (s.swapFiles[e.src]) s.swapFiles[e.src].on = true; else o.e('x');
      } else doMount(ctx, e.src, e.target, e.type, e.opts, o);
      if (o.code && !/\bnofail\b/.test(e.opts)) problems.push(e);
      if (o.code) { h.log('systemd', `systemd[1]: ${e.type === 'swap' ? 'dev-' + VFSbase(e.src) + '.swap' : unitName(e.target)}: Job ${e.type === 'swap' ? e.src : e.target} failed with result 'dependency'.`); h.log('systemd', `systemd[1]: Dependency failed for ${e.target === 'none' ? e.src : e.target}.`); }
    }
    for (const v of vols(h)) if (v.o.mount) v.o.fsckOk = false;
    h.systemdFstab = h.world ? h.world.now() : Date.now();
    return problems.map(e => `${e.src} ${e.target}`);
  };
  const VFSbase = p => String(p).replace(/^\//, '').replace(/\//g, '-');
  const unitName = t => (t === '/' ? '-' : t.replace(/^\//, '').replace(/\//g, '-')) + '.mount';
})(globalThis.IG = globalThis.IG || {});
