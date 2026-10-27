/* Isometric "data center" renderer on a 2D canvas. Scenes are plain data, so the same
 * scene model can later drive a WebGL/three.js 3D view without touching game logic. */
(function (IG) {
  'use strict';

  const STATE = { ok: '#3ddc97', warn: '#f5b83d', bad: '#ff5d5d', off: '#3c4a5c', info: '#5aa9ff', ghost: 'rgba(120,140,160,.25)' };
  const TW = 34, TH = 17, RACK_H = 66, F = 0.78;

  function iso(gx, gy, z = 0) { return { x: (gx - gy) * TW, y: (gx + gy) * TH - z }; }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function mix(hex, other, t) {
    const p = s => { const n = parseInt(s.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const a = p(hex), b = p(other);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }

  class View {
    constructor(canvas, opt = {}) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.scene = { zones: [], links: [] };
      this.hit = [];
      this.hover = null;
      this.onHover = opt.onHover || null;
      this.onClick = opt.onClick || null;
      this.compact = !!opt.compact;
      this.padLeft = opt.padLeft || (() => 0);
      this.rackLabels = opt.rackLabels !== false;
      this.t0 = performance.now();
      this.alive = true;
      this.resize = this.resize.bind(this);
      this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(this.resize) : null;
      if (this.ro) this.ro.observe(canvas); else window.addEventListener('resize', this.resize);
      canvas.addEventListener('mousemove', e => this.move(e));
      canvas.addEventListener('mouseleave', () => { this.hover = null; this.onHover && this.onHover(null); });
      canvas.addEventListener('click', e => { this.move(e); if (this.hover && this.onClick) this.onClick(this.hover.rack, this.hover.zone); });
      this.resize();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }
    destroy() { this.alive = false; if (this.ro) this.ro.disconnect(); }
    setScene(scene) { this.scene = scene; }
    resize() {
      const r = this.c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
      this.dpr = dpr;
    }
    move(e) {
      const r = this.c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let found = null;
      for (let i = this.hit.length - 1; i >= 0; i--) { const h = this.hit[i]; if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) { found = h; break; } }
      if ((found && found.rack) !== (this.hover && this.hover.rack)) { this.hover = found; this.onHover && this.onHover(found ? Object.assign({ x: e.clientX, y: e.clientY }, found) : null); }
      else if (found && this.onHover) this.onHover(Object.assign({ x: e.clientX, y: e.clientY }, found));
      this.c.style.cursor = found && this.onClick ? 'pointer' : 'default';
    }
    loop(now) {
      if (!this.alive) return;
      if (!this.c.isConnected) { this.destroy(); return; }
      // a hidden view (the mission's while the map shows) has no size: drawing it would scale by a
      // negative number, and one throw used to end the loop, leaving the view blank when shown again
      if (!document.hidden && this.w > 40 && this.h > 40) {
        try { this.draw((now - this.t0) / 1000); } catch (e) { console.error(e); }
      }
      requestAnimationFrame(this.loop);
    }
    layout() {
      // bounds of everything in iso space
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
      for (const z of this.scene.zones) {
        add(iso(z.x, z.y)); add(iso(z.x + z.w, z.y)); add(iso(z.x, z.y + z.d)); add(iso(z.x + z.w, z.y + z.d, 0));
        add(iso(z.x, z.y, RACK_H + 24)); add(iso(z.x + z.w, z.y, RACK_H + 24));
        add({ x: iso(z.x, z.y + z.d).x, y: iso(z.x, z.y + z.d).y + 46 }); // the zone's name and sub under its corner
      }
      if (!isFinite(x0)) { x0 = -100; y0 = -50; x1 = 100; y1 = 50; }
      const pad = this.compact ? 14 : 24;
      const pl = this.padLeft(this.w);
      const aw = this.w - pl;
      const s = Math.min((aw - pad * 2) / (x1 - x0), (this.h - pad * 2) / (y1 - y0), this.compact ? 1.5 : 1.8);
      return { s, ox: pl + (aw - (x1 - x0) * s) / 2 - x0 * s, oy: (this.h - (y1 - y0) * s) / 2 - y0 * s };
    }
    draw(t) {
      const g = this.g;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      const L = this.layout();
      const P = (gx, gy, z = 0) => { const p = iso(gx, gy, z); return { x: L.ox + p.x * L.s, y: L.oy + p.y * L.s }; };
      this.hit = [];
      const zones = this.scene.zones.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
      for (const z of zones) this.floor(g, P, z, L.s);
      this.links(g, P, t, L.s);
      const racks = [];
      for (const z of zones) z.racks.forEach((r, i) => racks.push({ z, r, gx: z.x + 0.6 + (i % z.cols) * 1.25, gy: z.y + 0.6 + Math.floor(i / z.cols) * 1.5 }));
      racks.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
      this.labelBoxes = [];
      for (const it of racks) this.rack(g, P, it, t, L.s);
      // zone names last, on a dark halo: drawn with the floor, the racks in front covered them
      for (const z of zones) this.zoneLabel(g, P, z, L.s);
    }
    floor(g, P, z, s) {
      const ghost = z.ghost;
      const c = z.color;
      const pts = [P(z.x, z.y), P(z.x + z.w, z.y), P(z.x + z.w, z.y + z.d), P(z.x, z.y + z.d)];
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
      g.fillStyle = hexA(c, ghost ? 0.03 : 0.08); g.fill();
      g.strokeStyle = hexA(c, ghost ? 0.18 : 0.55); g.lineWidth = 1; g.setLineDash(ghost ? [4, 4] : []); g.stroke(); g.setLineDash([]);
      g.strokeStyle = hexA(c, ghost ? 0.04 : 0.1);
      for (let i = 1; i < z.w; i++) { const a = P(z.x + i, z.y), b = P(z.x + i, z.y + z.d); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
      for (let j = 1; j < z.d; j++) { const a = P(z.x, z.y + j), b = P(z.x + z.w, z.y + j); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    }
    zoneLabel(g, P, z, s) {
      const lp = P(z.x, z.y + z.d);
      const big = `600 ${Math.max(10, 10.5 * s)}px "Segoe UI","Hiragino Sans","Noto Sans JP",system-ui,sans-serif`;
      const small = `${Math.max(9, 9 * s)}px "Segoe UI","Hiragino Sans",system-ui,sans-serif`;
      const name = (z.icon ? z.icon + ' ' : '') + z.label, line = Math.max(11, 12 * s);
      g.font = big; let w = g.measureText(name).width;
      if (z.sub) { g.font = small; w = Math.max(w, g.measureText(z.sub).width); }
      // under the floor's left corner; where that covers a rack's name, lower, or else beside the floor
      const h = z.sub ? line * 2 : line, below = lp.y + 14 * s;
      const box = (bx, by) => ({ x0: bx, x1: bx + w, y0: by - line, y1: by + h - line + 3 });
      const free = ({ x0, x1, y0, y1 }) => x0 >= 2 && x1 <= this.w - 2 && y1 <= this.h - 2 &&
        !this.labelBoxes.some(b => b.x0 < x1 && b.x1 > x0 && b.y0 < y1 && b.y1 > y0);
      const rp = P(z.x + z.w, z.y);
      const spots = [[lp.x + 4 * s, below], [lp.x + 4 * s, below + line], [lp.x + 4 * s, below + 2 * line],
        [lp.x - 6 * s - w, lp.y + line / 2], [lp.x - 6 * s - w, lp.y - h + line], [rp.x + 6 * s, rp.y + line / 2]];
      const [x, y] = spots.find(([bx, by]) => free(box(bx, by))) || spots[0];
      this.labelBoxes.push(box(x, y));
      const text = (font, color, str, ty) => {
        g.font = font;
        g.lineJoin = 'round'; g.lineWidth = 3; g.strokeStyle = 'rgba(8, 13, 19, .85)';
        g.strokeText(str, x, ty);
        g.fillStyle = color; g.fillText(str, x, ty);
      };
      g.textAlign = 'left';
      text(big, hexA(z.color, z.ghost ? 0.5 : 0.95), name, y);
      if (z.sub) text(small, hexA('#9fb0c3', z.ghost ? 0.45 : 0.8), z.sub, y + line);
    }
    links(g, P, t, s) {
      const zmap = Object.fromEntries(this.scene.zones.map(z => [z.id, z]));
      for (const l of this.scene.links || []) {
        const a = zmap[l.from], b = zmap[l.to];
        if (!a || !b) continue;
        const pa = P(a.x + a.w / 2, a.y + a.d / 2), pb = P(b.x + b.w / 2, b.y + b.d / 2);
        g.strokeStyle = hexA(l.ghost ? '#556677' : '#7fd3ff', l.ghost ? 0.12 : 0.22);
        g.lineWidth = 1.2 * s; g.setLineDash([5 * s, 5 * s]); g.lineDashOffset = -t * 20;
        g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); g.stroke(); g.setLineDash([]);
        if (l.active) {
          const col = l.ok === false ? STATE.bad : STATE.ok;
          for (let k = 0; k < 3; k++) {
            const u = ((t * 0.9 + k / 3) % 1);
            const x = pa.x + (pb.x - pa.x) * u, y = pa.y + (pb.y - pa.y) * u;
            g.fillStyle = col; g.shadowColor = col; g.shadowBlur = 10;
            g.beginPath(); g.arc(x, y, 2.6 * s, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
          }
        }
      }
    }
    rack(g, P, it, t, s) {
      const { z, r, gx, gy } = it;
      const ghost = r.state === 'ghost' || z.ghost;
      const H = (r.kind === 'bucket' ? 34 : r.kind === 'small' ? 44 : RACK_H);
      const base = ghost ? '#1a222c' : mix('#1b2734', z.color, 0.12);
      const hov = this.hover && this.hover.rack === r;
      if (r.kind === 'bucket') return this.bucket(g, P, it, t, s, H, ghost, hov);
      const c = [P(gx, gy), P(gx + F, gy), P(gx + F, gy + F), P(gx, gy + F)];
      const top = [P(gx, gy, H), P(gx + F, gy, H), P(gx + F, gy + F, H), P(gx, gy + F, H)];
      const poly = (pts, fill, stroke) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); } };
      g.globalAlpha = ghost ? 0.35 : 1;
      // shadow
      poly([P(gx + 0.08, gy + 0.08), P(gx + F + 0.18, gy + 0.08), P(gx + F + 0.18, gy + F + 0.18), P(gx + 0.08, gy + F + 0.18)], 'rgba(0,0,0,.28)');
      const edge = hexA(hov ? '#ffffff' : z.color, ghost ? 0.25 : hov ? 0.9 : 0.45);
      poly([c[3], c[2], top[2], top[3]], mix(base, '#000000', 0.05), edge); // +y face (front-left)
      poly([c[1], c[2], top[2], top[1]], mix(base, '#000000', 0.35), edge); // +x face (front-right)
      poly(top, mix(base, '#ffffff', 0.12), edge);
      // unit slots on the front-left face
      const units = r.units || [];
      const n = Math.min(units.length, 8);
      const slotH = (H - 14) / 8;
      const face = (u, v) => P(gx + u * F, gy + F, v);
      for (let i = 0; i < 8; i++) {
        const v0 = 6 + i * slotH, v1 = v0 + slotH - 2;
        const u = units[i];
        poly([face(0.08, v0), face(0.92, v0), face(0.92, v1), face(0.08, v1)], u ? hexA('#0c131b', ghost ? 0.4 : 0.85) : hexA('#0c131b', 0.35));
        if (!u || i >= n) continue;
        const col = STATE[u.state] || STATE.off;
        const blink = u.state === 'bad' ? 0.45 + 0.55 * Math.abs(Math.sin(t * 4 + i)) : u.state === 'warn' ? 0.6 + 0.4 * Math.abs(Math.sin(t * 2 + i)) : 1;
        g.globalAlpha = (ghost ? 0.35 : 1) * blink;
        g.shadowColor = col; g.shadowBlur = ghost ? 0 : 8;
        poly([face(0.14, v0 + 1.5), face(0.3, v0 + 1.5), face(0.3, v1 - 1.5), face(0.14, v1 - 1.5)], col);
        g.shadowBlur = 0;
        g.globalAlpha = ghost ? 0.35 : 1;
        if (u.state !== 'off') { const a = face(0.38, (v0 + v1) / 2), b = face(0.38 + 0.5 * (u.load ?? 0.6), (v0 + v1) / 2); g.strokeStyle = hexA(col, 0.4); g.lineWidth = Math.max(1, 1.4 * s); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
      }
      if (units.length > 8) { const p = face(0.5, 4); g.fillStyle = '#9fb0c3'; g.font = `${Math.max(8, 8 * s)}px system-ui`; g.textAlign = 'center'; g.fillText(`+${units.length - 8}`, p.x, p.y + 2); }
      // vents on the right face
      g.strokeStyle = hexA('#000000', 0.35);
      for (let i = 0; i < 6; i++) { const v = 10 + i * ((H - 20) / 6); const a = P(gx + F, gy + 0.15, v), b = P(gx + F, gy + F - 0.15, v); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
      // beacon
      const bc = STATE[r.state] || STATE.off;
      const tc = P(gx + F / 2, gy + F / 2, H);
      const pulse = r.state === 'bad' ? 0.4 + 0.6 * Math.abs(Math.sin(t * 5)) : r.state === 'warn' ? 0.55 + 0.45 * Math.abs(Math.sin(t * 2.4)) : 1;
      g.globalAlpha = (ghost ? 0.3 : 1) * pulse;
      g.fillStyle = bc; g.shadowColor = bc; g.shadowBlur = ghost ? 0 : 14;
      g.beginPath(); g.ellipse(tc.x, tc.y - 3 * s, 4.2 * s, 2.4 * s, 0, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0; g.globalAlpha = 1;
      // label
      const lp = P(gx + F / 2, gy + F, 0);
      g.textAlign = 'center';
      g.font = `600 ${Math.max(8, 9 * s)}px "Segoe UI","Hiragino Sans",system-ui,sans-serif`;
      g.fillStyle = ghost ? 'rgba(160,175,190,.35)' : '#d7e2ee';
      const label = r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label;
      if (this.rackLabels || hov) {
        g.fillText(label, lp.x - 4 * s, lp.y + 13 * s);
        const half = g.measureText(label).width / 2, fs = Math.max(8, 9 * s);
        this.labelBoxes.push({ x0: lp.x - 4 * s - half, x1: lp.x - 4 * s + half, y0: lp.y + 13 * s - fs, y1: lp.y + 13 * s + 3 });
      }
      const xs = [c[0].x, c[1].x, c[2].x, c[3].x, top[0].x], ys = [top[0].y, top[1].y, c[2].y + 16 * s];
      this.hit.push({ x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4, y0: Math.min(...ys) - 8, y1: Math.max(...ys), rack: r, zone: z });
    }
    bucket(g, P, it, t, s, H, ghost, hov) {
      const { z, r, gx, gy } = it;
      const cx = P(gx + F / 2, gy + F / 2);
      const rx = 15 * s, ry = 7.5 * s, h = H * s;
      const col = STATE[r.state] || STATE.off;
      g.globalAlpha = ghost ? 0.35 : 1;
      g.fillStyle = mix('#1d2a37', z.color, 0.15);
      g.beginPath(); g.ellipse(cx.x, cx.y, rx, ry, 0, 0, Math.PI); g.lineTo(cx.x - rx, cx.y - h); g.ellipse(cx.x, cx.y - h, rx, ry, 0, Math.PI, 0, true); g.closePath(); g.fill();
      g.strokeStyle = hexA(hov ? '#ffffff' : z.color, 0.6); g.stroke();
      g.fillStyle = mix('#2a3a4c', z.color, 0.2);
      g.beginPath(); g.ellipse(cx.x, cx.y - h, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      const pulse = r.state === 'bad' ? 0.4 + 0.6 * Math.abs(Math.sin(t * 5)) : 1;
      g.globalAlpha = pulse; g.fillStyle = col; g.shadowColor = col; g.shadowBlur = 12;
      g.beginPath(); g.ellipse(cx.x, cx.y - h, rx * 0.45, ry * 0.45, 0, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0; g.globalAlpha = 1;
      g.textAlign = 'center'; g.font = `600 ${Math.max(8, 9 * s)}px "Segoe UI",system-ui,sans-serif`; g.fillStyle = '#d7e2ee';
      g.fillText(r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label, cx.x, cx.y + ry + 11 * s);
      this.hit.push({ x0: cx.x - rx - 4, x1: cx.x + rx + 4, y0: cx.y - h - ry - 4, y1: cx.y + ry + 14 * s, rack: r, zone: z });
    }
  }

  /* ------------------------------------------------------------ scene builders */
  function grid(zones) {
    // place zones left→right along the iso x axis in two rows
    let x = 0, y = 0, rowD = 0;
    zones.forEach((z, i) => {
      z.cols = z.cols || Math.max(1, Math.min(4, z.racks.length));
      const rows = Math.max(1, Math.ceil(z.racks.length / z.cols));
      z.w = z.w || Math.max(2, z.cols * 1.25 + 0.6);
      z.d = z.d || Math.max(2, rows * 1.5 + 0.5);
      if (i && i % 3 === 0) { x = 0; y += rowD + 1.4; rowD = 0; }
      z.x = x; z.y = y;
      x += z.w + 1.2;
      rowD = Math.max(rowD, z.d);
    });
    return zones;
  }

  function podState(st) {
    if (st.ready) return 'ok';
    if (['ContainerCreating', 'Pending', 'Completed'].includes(st.display)) return 'warn';
    if (st.display === 'Running') return 'warn';
    return 'bad';
  }
  function worst(states) { return states.includes('bad') ? 'bad' : states.includes('warn') ? 'warn' : states.length ? 'ok' : 'off'; }

  function sceneFromWorld(w) {
    const zones = [], links = [];
    const now = w.now();
    const recent = w.traffic.filter(x => now - x.at < 3500);
    const bast = { id: 'bastion', label: IG.t('踏み台'), sub: 'bastion', color: '#8fa3b8', icon: '❯_', racks: [] };
    for (const h of Object.values(w.hosts)) {
      const isNode = Object.values(w.clusters).some(c => c.nodes.some(n => n.host === h.name));
      if (isNode) continue;
      const svcs = Object.entries(h.services);
      const st = h.name === 'bastion' ? 'ok' : worst(svcs.map(([, s]) => (s === 'active' ? 'ok' : 'bad')));
      bast.racks.push({ label: h.name, kind: 'small', state: st, units: svcs.map(([n, s]) => ({ label: n, state: s === 'active' ? 'ok' : 'bad' })), info: [`IP ${h.ip}`, ...svcs.map(([n, s]) => `${n}: ${s}`), `disk ${h.diskPct()}%`] });
    }
    zones.push(bast);
    if (w.features.has('docker') && w.docker) {
      const cs = w.docker.containers;
      zones.push({ id: 'docker', label: IG.t('Docker ホスト'), sub: `${cs.filter(c => c.status === 'running').length}/${cs.length} running`, color: '#2496ed', icon: '🐳', racks: [{
        label: 'docker-engine', state: worst(cs.map(c => (c.status === 'running' ? 'ok' : c.meta.kind === 'tool' ? 'off' : 'bad'))) === 'off' ? 'ok' : worst(cs.map(c => (c.status === 'running' ? 'ok' : c.meta.kind === 'tool' ? 'ok' : 'bad'))),
        units: cs.map(c => ({ label: c.name, state: c.status === 'running' ? 'ok' : c.meta.kind === 'tool' ? 'off' : 'bad' })),
        info: cs.length ? cs.map(c => `${c.name} (${c.imageRef}) ${c.status}${c.ports.length && c.status === 'running' ? ' :' + c.ports.map(p => p.host).join(',') : ''}`) : [IG.t('コンテナなし')],
      }, { label: 'images', kind: 'small', state: 'ok', units: w.docker.images.slice(0, 8).map(i => ({ label: i.ref, state: 'info', load: 0.3 })), info: w.docker.images.map(i => i.ref).slice(0, 10).concat(w.docker.images.length ? [] : [IG.t('イメージなし')]) }] });
      links.push({ from: 'bastion', to: 'docker', active: recent.some(x => x.target && x.target.kind === 'container'), ok: !recent.some(x => x.target && x.target.kind === 'container' && !x.ok) });
    }
    for (const c of Object.values(w.clusters)) {
      const color = c.openshift ? '#e5484d' : c.flavor === 'eks' ? '#f5a524' : '#4f7cf0';
      const racks = c.nodes.map(n => {
        const ns = c.nodeState(n);
        const pods = c.pods.filter(p => p.node === n.name);
        const units = pods.map(p => { const st = c.podStatus(p); return { label: `${p.ns}/${p.name}`, state: podState(st), status: st.display }; });
        const state = !ns.ready ? 'bad' : ns.diskPressure ? 'bad' : n.cordoned ? 'warn' : n.role === 'control-plane' ? 'info' : worst(units.map(u => u.state)) === 'off' ? 'ok' : worst(units.map(u => u.state));
        return { label: n.name.split('.')[0], state, units: n.role === 'control-plane' ? [{ label: 'etcd', state: 'info' }, { label: 'kube-apiserver', state: 'info' }, { label: 'scheduler', state: 'info' }] : units,
          info: [`${n.role} · ${ns.ready ? 'Ready' : 'NotReady'}${n.cordoned ? ' · SchedulingDisabled' : ''}`, ns.diskPressure ? `⚠ DiskPressure (disk ${ns.diskPct}%)` : null, ...units.map(u => `${u.label.split('/')[1]}  ${u.status}`)].filter(Boolean) };
      });
      const pending = c.pods.filter(p => !p.node);
      if (pending.length) racks.push({ label: 'Pending', kind: 'small', state: 'warn', units: pending.map(p => ({ label: p.name, state: 'warn' })), info: [IG.t('スケジュール待ちの Pod'), ...pending.map(p => p.name)] });
      const ctx = w.context();
      zones.push({ id: 'cluster:' + c.name, label: c.name, sub: `${c.openshift ? 'OpenShift' : c.flavor === 'eks' ? 'Amazon EKS' : 'Kubernetes'}${ctx && ctx.cluster === c.name ? IG.t(' · 接続中') : IG.t(' · 未接続')}`, color, icon: c.openshift ? '⛭' : '☸', racks });
      links.push({ from: 'bastion', to: 'cluster:' + c.name, ghost: !(ctx && ctx.cluster === c.name), active: recent.some(x => x.target && x.target.cluster === c.name), ok: !recent.some(x => x.target && x.target.cluster === c.name && !x.ok) });
    }
    if (w.harbor && w.features.has('harbor')) {
      const ps = Object.values(w.harbor.projects).filter(p => p.name !== 'library' || Object.keys(p.repos).length);
      zones.push({ id: 'harbor', label: 'Harbor', sub: w.harbor.host, color: '#4cae4c', icon: '⚓', racks: ps.length ? ps.map(p => {
        const arts = Object.entries(p.repos).flatMap(([r, tags]) => Object.values(tags).map(tg => ({ label: `${r}:${tg.tag}`, state: !tg.scan ? 'off' : tg.scan.critical ? 'bad' : tg.scan.high ? 'warn' : 'ok', scan: tg.scan })));
        return { label: p.name, state: worst(arts.map(a => a.state)) === 'off' ? 'ok' : worst(arts.map(a => a.state)), units: arts, info: [`${p.public ? 'public' : 'private'}${p.preventVul ? IG.t(` · 脆弱性ブロック >= {0}`, { 0: p.preventVul }) : ''}`, ...arts.map(a => `${a.label}  ${a.scan ? `C${a.scan.critical}/H${a.scan.high}` : IG.t('未スキャン')}`)] };
      }) : [{ label: IG.t('(プロジェクトなし)'), state: 'off', units: [], info: ['harbor project create <name>'] }] });
      links.push({ from: 'bastion', to: 'harbor', active: recent.some(x => x.target && x.target.kind === 'harbor') });
    }
    if (w.aws && w.features.has('aws')) {
      const A = w.aws;
      const racks = A.instances.map(i => {
        const sgs = i.sgIds.map(id => A.sgs[id]).filter(Boolean);
        const world22 = sgs.some(s => s.ingress.some(r => r.from <= 22 && r.to >= 22 && r.cidrs.includes('0.0.0.0/0')));
        const units = i.listen.map(p => { const open = sgs.some(s => s.ingress.some(r => r.from <= p && r.to >= p)); return { label: `tcp/${p}`, state: p === 22 && world22 ? 'bad' : open ? 'ok' : 'off' }; });
        return { label: i.name, state: i.state !== 'running' ? 'off' : world22 ? 'warn' : 'ok', units, info: [`${i.id} · ${i.type} · ${i.state}`, i.publicIp ? `public ${i.publicIp}` : IG.t('public IP なし'), ...sgs.flatMap(s => s.ingress.map(r => `${s.name}: ${r.proto}/${r.from}${r.to !== r.from ? '-' + r.to : ''} ← ${r.cidrs.join(', ')}`))] };
      });
      for (const b of Object.values(A.buckets)) racks.push({ label: b.name.replace(/^corelab-/, ''), kind: 'bucket', state: A.bucketPublic(b) ? 'bad' : 'ok', info: [`s3://${b.name}`, A.bucketPublic(b) ? IG.t('⚠ 公開状態（誰でも読める）') : IG.t('Block Public Access / 非公開'), `${Object.keys(b.objects).length} objects`] });
      if (Object.keys(A.eks).length && !Object.values(w.clusters).some(c => c.flavor === 'eks')) racks.push({ label: 'EKS', kind: 'small', state: 'info', units: [] });
      zones.push({ id: 'aws', label: 'AWS ap-northeast-1', sub: `account ${A.account}`, color: '#f5a524', icon: '☁', racks: racks.length ? racks : [{ label: IG.t('(リソースなし)'), state: 'off', units: [] }] });
      links.push({ from: 'bastion', to: 'aws', active: recent.some(x => x.target && (x.target.kind === 'ec2' || x.target.kind === 's3')), ok: !recent.some(x => x.target && (x.target.kind === 'ec2' || x.target.kind === 's3') && !x.ok) });
    }
    return { zones: grid(zones), links };
  }

  // Home screen: one zone per track; one rack per mission, lit when cleared.
  function sceneFromProgress(progress, unlockAll) {
    const zones = [{ id: 'core', label: 'CoreLab', sub: 'NOC', color: '#38d6c4', icon: '◈', racks: [{ label: IG.t('あなた'), kind: 'small', state: 'ok', units: [{ label: 'operator', state: 'ok' }], info: [progress.rank().cur.name, `XP ${progress.data.xp}`] }] }];
    const links = [];
    for (const t of IG.tracks) {
      const ms = IG.missionsOf(t.id);
      const done = ms.filter(m => progress.cleared(m.id)).length;
      zones.push({ id: t.id, label: t.name, sub: IG.t(`{0}/{1} 稼働`, { 0: done, 1: ms.length }), color: t.color, icon: t.icon, ghost: done === 0 && !progress.unlocked(ms[0], unlockAll), cols: Math.min(3, ms.length), racks: ms.map(m => {
        const st = progress.stars(m.id);
        return { label: `#${m.order} ${m.title.length > 7 ? m.title.slice(0, 6) + '…' : m.title}`, title: m.title, mission: m.id, state: st ? 'ok' : progress.unlocked(m, unlockAll) ? 'warn' : 'ghost', units: st ? Array.from({ length: 2 + st * 2 }, (_, i) => ({ label: '', state: i < st * 2 ? 'ok' : 'info', load: 0.3 + ((i * 37) % 60) / 100 })) : [], info: [m.summary, st ? IG.t(`{0}{1} クリア済み`, { 0: '★'.repeat(st), 1: '☆'.repeat(3 - st) }) : progress.unlocked(m, unlockAll) ? IG.t('▶ 挑戦できます') : IG.t('🔒 前のミッションをクリアすると解放')] };
      }) });
      links.push({ from: 'core', to: t.id, ghost: done === 0, active: done > 0, ok: true });
    }
    return { zones: grid(zones), links };
  }

  IG.DC = { View, sceneFromWorld, sceneFromProgress, STATE };
})(globalThis.IG = globalThis.IG || {});
