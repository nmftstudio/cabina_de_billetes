// Simulación determinista de la cabina. La usan el navegador y el servidor.
// Solo usa + - * / sqrt floor abs min max (exactos en IEEE 754): nada de Math.sin/cos/exp/hypot/pow,
// que pueden diferir entre motores y romper la re-simulación.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 360, H = 520, DT = 1 / 60, SECONDS = 30, FRAMES = SECONDS * 60, BANK = 500;
  const P = { turb: 4, fan: 2, grab: 16, repel: 2, resp: 8, rr: 100, close: .2, cool: .45, sd: 40, sf: 1500 };
  const TAU = 6.283185307179586, PI_2 = 1.5707963267948966;

  function cos(x) {
    x = x - TAU * Math.floor(x / TAU + .5);
    const x2 = x * x;
    return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 / 20922789888000)))))));
  }
  function expNeg(u) { // e^-u para u >= 0
    const t = -u / 8;
    let e = 1 + t * (1 + t * (1 / 2 + t * (1 / 6 + t * (1 / 24 + t / 120))));
    e *= e; e *= e; e *= e;
    return e;
  }
  const dist = (dx, dy) => Math.sqrt(dx * dx + dy * dy);

  function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function newGame(seed, total) {
    const r = rng(seed), terms = [];
    for (let i = 0; i < 5; i++) {
      const s = 1 + i * .9, a = TAU * r();
      const kx = cos(a) * .012 * s * (1 + r()), ky = cos(a - PI_2) * .012 * s * (1 + r());
      terms.push({ kx, ky, w: (.5 + r() * 1.5) * (1 + i * .3) * (r() < .5 ? -1 : 1), p: TAU * r(), A: 9000 / s });
    }
    const n = Math.min(150, Math.round(total / 10)), bills = [];
    for (let i = 0; i < n; i++) bills.push({ x: 30 + r() * (W - 60), y: 60 + r() * (H - 120), vx: 0, vy: 0, r: r() * 6.28, w: 0, f: r() * 6.28, on: true });
    return { seed, terms, bills, n, t: 0, f: 0, got: 0, cd: 0, gr: null, g1: r() * 6, g2: r() * 6, pops: null };
  }
  const gust = S => Math.max(.12, .55 + .45 * cos(S.t * .9 + S.g1 - PI_2) * cos(S.t * .37 + S.g2 - PI_2));

  function sep(a, dt) {
    for (let i = 0; i < a.length; i++) {
      const p = a[i]; if (!p.on) continue;
      for (let j = i + 1; j < a.length; j++) {
        const q = a[j]; if (!q.on) continue;
        const dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
        if (d2 < P.sd * P.sd) { const d = Math.sqrt(d2) || 1, k = P.sf * (1 - d / P.sd) * dt / d; p.vx += dx * k; p.vy += dy * k; q.vx -= dx * k; q.vy -= dy * k; }
      }
    }
  }

  function step(S, dt, ptr) {
    S.t += dt; S.cd = Math.max(0, S.cd - dt); const G = gust(S); sep(S.bills, dt);
    if (S.gr) {
      S.gr.t += dt;
      if (S.gr.t >= P.close) {
        let bb = null, bd = P.grab;
        for (const b of S.bills) if (b.on) { const d = dist(b.x - S.gr.x, b.y - S.gr.y); if (d < bd) { bd = d; bb = b; } }
        if (bb) { bb.on = false; S.got += 10; if (S.pops) S.pops.push({ x: bb.x, y: bb.y, t: 0 }); }
        S.gr = null;
      }
    }
    for (const b of S.bills) {
      if (!b.on) continue;
      let u = 0, v = 0;
      for (const m of S.terms) { const c = cos(m.kx * b.x + m.ky * b.y + m.w * S.t + m.p) * m.A; u += c * m.ky; v -= c * m.kx; }
      const q = (b.x - W / 2) / 120;
      const jet = P.fan * G * 300 * expNeg(q * q) * (.35 + .65 * b.y / H);
      const tx = u * P.turb, ty = v * P.turb + 70 - jet;
      b.vx += (tx - b.vx) * P.resp * dt; b.vy += (ty - b.vy) * P.resp * dt;
      if (ptr) {
        const dx = b.x - ptr.x, dy = b.y - ptr.y, d = dist(dx, dy) || 1;
        if (d < P.rr) { const k = P.repel * (1 - d / P.rr) * 900 * dt / d; b.vx += dx * k; b.vy += dy * k; }
      }
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < 12) { b.x = 12; b.vx = Math.abs(b.vx) * .6; } else if (b.x > W - 12) { b.x = W - 12; b.vx = -Math.abs(b.vx) * .6; }
      if (b.y < 12) { b.y = 12; b.vy = Math.abs(b.vy) * .6; } else if (b.y > H - 26) { b.y = H - 26; b.vy = -Math.abs(b.vy) * .4; }
      b.w += ((u - v) * .012 - b.w) * 3 * dt; b.r += b.w * dt; b.f += (1.5 + dist(b.vx, b.vy) * .02) * dt;
    }
  }

  // Entrada por frame: un entero empaquetado (x*10)*8192 + (y*10), o -1 si no hay puntero.
  const pack = (x, y) => Math.round(Math.min(W, Math.max(0, x)) * 10) * 8192 + Math.round(Math.min(H, Math.max(0, y)) * 10);
  const unpack = v => { if (v < 0) return null; const xi = Math.floor(v / 8192); return { x: xi / 10, y: (v - xi * 8192) / 10 }; };

  // Un frame de juego: aplica el tap (si se puede) y avanza la física.
  function tick(S, packed, tap) {
    const ptr = unpack(packed);
    if (tap && ptr && !S.gr && S.cd <= 0) { S.gr = { x: ptr.x, y: ptr.y, t: 0 }; S.cd = P.cool; }
    step(S, DT, ptr);
    S.f++;
  }

  // Re-simula una partida completa. inputs: array de FRAMES enteros; taps: frames con intento de agarre.
  function replay(seed, total, inputs, taps) {
    const S = newGame(seed, total), tapSet = new Set(taps);
    for (let f = 0; f < FRAMES; f++) tick(S, inputs[f], tapSet.has(f));
    return S.got;
  }

  return { W, H, DT, SECONDS, FRAMES, BANK, P, newGame, tick, replay, pack, unpack, gust };
});
