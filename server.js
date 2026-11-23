'use strict';
// Cabina de Billetes: backend. Node >= 22.5 (usa node:sqlite).
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const Sim = require('./public/sim.js');

const E = process.env;
const CFG = {
  port: +E.PORT || 3000,
  base: (E.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  mpBase: E.MP_BASE_URL || 'https://api.mercadopago.com',
  token: E.MP_ACCESS_TOKEN || '',
  whSecret: E.MP_WEBHOOK_SECRET || '',
  mode: E.MODE === 'live' ? 'live' : 'test',
  bank: Sim.BANK,
  casaPct: +(E.CASA_PCT ?? 10),        // % de lo no capturado que se queda la casa
  pozoMax: +(E.POZO_MAX ?? 1000),      // tope del pozo; el excedente va a la casa
  maxRefund: +(E.MAX_REFUND ?? 0),     // tope de reembolso por partida (0 = sin tope)
  minPlayMs: +(E.MIN_PLAY_MS ?? 28000),// una partida real dura 30 s
  expireMs: +(E.EXPIRE_MS ?? 600000),  // partida iniciada y no terminada = se pierde
  maxJump: 150,                        // px por frame: evita "teletransportar" la mano
  dbPath: E.DB_PATH || 'cabina.db',
};
if (CFG.mode === 'live' && (!CFG.whSecret || !CFG.token)) { console.error('MODE=live requiere MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET'); process.exit(1); }

// ---------- DB ----------
const db = new DatabaseSync(CFG.dbPath);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS games(
  id TEXT PRIMARY KEY, status TEXT NOT NULL, seed INTEGER NOT NULL, payment_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  pot_in INTEGER, total INTEGER, got INTEGER, refund INTEGER, refund_status TEXT, refund_id TEXT,
  refund_tries INTEGER NOT NULL DEFAULT 0, casa INTEGER, to_pozo INTEGER);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO kv VALUES('pozo',0);`);
const q = s => db.prepare(s);
const getGame = id => q('SELECT * FROM games WHERE id=?').get(String(id));
const getPozo = () => q("SELECT v FROM kv WHERE k='pozo'").get().v;
const setPozo = v => q("UPDATE kv SET v=? WHERE k='pozo'").run(v);
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

// ---------- Mercado Pago ----------
async function mp(pathname, { method = 'GET', body, key } = {}) {
  const r = await fetch(CFG.mpBase + pathname, {
    method,
    headers: { Authorization: `Bearer ${CFG.token}`, 'Content-Type': 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`MP ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}

// Consulta el pago a MP (nunca confía en lo que diga el cliente o el body del webhook).
async function applyPayment(paymentId) {
  const p = await mp(`/v1/payments/${encodeURIComponent(paymentId)}`);
  const g = getGame(p.external_reference || '');
  if (!g) return { ok: false, reason: 'game_not_found' };
  if (p.status !== 'approved' || Number(p.transaction_amount) !== CFG.bank || p.currency_id !== 'ARS') return { ok: false, reason: 'payment_' + p.status };
  if (g.status === 'pending') {
    try { q("UPDATE games SET status='paid', payment_id=? WHERE id=? AND status='pending'").run(String(p.id), g.id); }
    catch { return { ok: false, reason: 'payment_reused' }; }
  } else if (g.payment_id !== String(p.id)) return { ok: false, reason: 'payment_mismatch' };
  return { ok: true, gameId: g.id };
}

// Reembolso parcial. La clave de idempotencia evita doble reembolso si se reintenta.
async function doRefund(g) {
  q('UPDATE games SET refund_tries=refund_tries+1 WHERE id=?').run(g.id);
  try {
    const j = await mp(`/v1/payments/${g.payment_id}/refunds`, { method: 'POST', body: { amount: g.refund }, key: `cabina-refund-${g.id}` });
    q("UPDATE games SET refund_status='done', refund_id=? WHERE id=?").run(String(j.id ?? ''), g.id);
    return 'done';
  } catch (e) {
    console.error('refund falló', g.id, e.status, JSON.stringify(e.body || e.message));
    q("UPDATE games SET refund_status='failed' WHERE id=?").run(g.id);
    return 'failed';
  }
}

function verifySignature(req) {
  if (!CFG.whSecret) return CFG.mode !== 'live';
  const sig = req.get('x-signature') || '', rid = req.get('x-request-id') || '';
  let ts, v1;
  for (const part of sig.split(',')) { const [k, v] = part.trim().split('='); if (k === 'ts') ts = v; else if (k === 'v1') v1 = v; }
  if (!ts || !v1) return false;
  const dataId = String(req.query['data.id'] || '').toLowerCase();
  const manifest = `${dataId ? `id:${dataId};` : ''}${rid ? `request-id:${rid};` : ''}ts:${ts};`;
  const h = crypto.createHmac('sha256', CFG.whSecret).update(manifest).digest('hex');
  return v1.length === h.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(h));
}

// ---------- Lógica del pozo ----------
// Cierra la partida: reparte total = reembolso + lo que entra al pozo + casa. Atómico.
function finishTx(id, got) {
  return tx(() => {
    const g = getGame(id);
    if (!g || g.status !== 'started') return null;
    const refund = CFG.maxRefund > 0 ? Math.min(got, CFG.maxRefund) : got;
    const rest = g.total - refund;
    const toPozoWanted = rest - Math.floor(rest * CFG.casaPct / 100 / 10) * 10;
    const cur = getPozo(), pozo = Math.min(CFG.pozoMax, cur + toPozoWanted);
    const toPozo = pozo - cur, casa = rest - toPozo;
    setPozo(pozo);
    q("UPDATE games SET status='finished', finished_at=?, got=?, refund=?, refund_status=?, to_pozo=?, casa=? WHERE id=?")
      .run(Date.now(), got, refund, refund > 0 ? 'pending' : 'none', toPozo, casa, id);
    return { refund, toPozo, casa, pozo };
  });
}
const expireStale = () => {
  for (const g of q("SELECT id FROM games WHERE status='started' AND started_at<?").all(Date.now() - CFG.expireMs)) finishTx(g.id, 0);
};

function validInputs(ptr, taps) {
  if (!Array.isArray(ptr) || ptr.length !== Sim.FRAMES) return 'ptr_length';
  let prev = null;
  for (const v of ptr) {
    if (!Number.isInteger(v) || v < -1) return 'ptr_value';
    if (v === -1) { prev = null; continue; }
    const xi = Math.floor(v / 8192), yi = v - xi * 8192;
    if (xi > Sim.W * 10 || yi > Sim.H * 10) return 'ptr_range';
    if (prev && Math.hypot(xi - prev[0], yi - prev[1]) / 10 > CFG.maxJump) return 'ptr_jump';
    prev = [xi, yi];
  }
  if (!Array.isArray(taps) || taps.length > 200) return 'taps_length';
  let last = -1;
  for (const f of taps) { if (!Number.isInteger(f) || f <= last || f >= Sim.FRAMES || ptr[f] < 0) return 'taps_value'; last = f; }
  return null;
}

// ---------- HTTP ----------
const app = express();
if (E.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '300kb' }));

const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const now = Date.now(), arr = (hits.get(req.ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: 'rate_limited' });
  arr.push(now); hits.set(req.ip, arr); next();
};

app.get('/api/state', (req, res) => res.json({ pozo: getPozo(), bank: CFG.bank, mode: CFG.mode }));

app.post('/api/orders', limit(10, 3600e3), async (req, res) => {
  const id = crypto.randomUUID(), seed = crypto.randomInt(1, 2 ** 31 - 1);
  q("INSERT INTO games(id,status,seed,created_at) VALUES(?,?,?,?)").run(id, 'pending', seed, Date.now());
  const back = `${CFG.base}/?game=${id}`;
  try {
    const pref = await mp('/checkout/preferences', {
      method: 'POST',
      body: {
        items: [{ id: 'partida', title: 'Cabina de Billetes: 1 partida', quantity: 1, unit_price: CFG.bank, currency_id: 'ARS' }],
        external_reference: id,
        back_urls: { success: back, pending: back, failure: back },
        ...(CFG.base.startsWith('https') ? { auto_return: 'approved', notification_url: `${CFG.base}/api/mp-webhook` } : {}),
        statement_descriptor: 'CABINA',
      },
    });
    res.json({ gameId: id, url: pref.init_point });
  } catch (e) { console.error('preferencia', e.status, JSON.stringify(e.body || e.message)); res.status(502).json({ error: 'mp_unavailable' }); }
});

app.post('/api/mp-webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  const type = req.query.type || req.body?.type, id = req.query['data.id'] || req.body?.data?.id;
  if (type === 'payment' && id) {
    try { await applyPayment(id); } catch (e) { console.error('webhook', e.status, e.message); return res.sendStatus(500); }
  }
  res.sendStatus(200);
});

app.get('/api/games/:id', (req, res) => {
  const g = getGame(req.params.id);
  g ? res.json({ status: g.status }) : res.sendStatus(404);
});

// El cliente vuelve de MP con ?payment_id=...: confirmamos contra la API de MP.
app.post('/api/games/:id/confirm', limit(60, 3600e3), async (req, res) => {
  const g = getGame(req.params.id);
  if (!g) return res.sendStatus(404);
  if (g.status !== 'pending') return res.json({ status: g.status });
  const pid = String(req.body?.payment_id || '');
  if (!/^\d+$/.test(pid)) return res.status(400).json({ error: 'payment_id' });
  try {
    const r = await applyPayment(pid);
    const fresh = getGame(g.id);
    res.json({ status: fresh.status, ...(r.ok ? {} : { reason: r.reason }) });
  } catch (e) { res.status(502).json({ error: 'mp_unavailable' }); }
});

// Entrega la semilla UNA sola vez: recargar no permite "ensayar" la misma partida.
app.post('/api/games/:id/start', (req, res) => {
  expireStale();
  const out = tx(() => {
    const g = getGame(req.params.id);
    if (!g) return [404, {}];
    if (g.status !== 'paid') return [409, { error: g.status === 'started' ? 'already_started' : 'status_' + g.status }];
    const pozo = getPozo(), take = Math.min(pozo, 1000), total = CFG.bank + take;
    setPozo(pozo - take);
    q("UPDATE games SET status='started', started_at=?, pot_in=?, total=? WHERE id=?").run(Date.now(), take, total, g.id);
    return [200, { seed: g.seed, total }];
  });
  res.status(out[0]).json(out[1]);
});

app.post('/api/games/:id/finish', async (req, res) => {
  const g = getGame(req.params.id);
  if (!g) return res.sendStatus(404);
  if (g.status === 'finished') return res.json(resultOf(g));
  if (g.status !== 'started') return res.status(409).json({ error: 'status_' + g.status });
  if (Date.now() - g.started_at < CFG.minPlayMs) return res.status(425).json({ error: 'too_fast' });
  const { ptr, taps } = req.body || {};
  const err = validInputs(ptr, taps);
  if (err) return res.status(400).json({ error: err });
  const got = Sim.replay(g.seed, g.total, ptr, taps);
  const r = finishTx(g.id, got);
  if (!r) return res.status(409).json({ error: 'already_finished' });
  if (r.refund > 0) await doRefund({ id: g.id, payment_id: g.payment_id, refund: r.refund });
  res.json(resultOf(getGame(g.id)));
});

function resultOf(g) {
  return { got: g.got, total: g.total, refund: g.refund, toPozo: g.to_pozo, casa: g.casa, refundStatus: g.refund_status, pozo: getPozo(), seed: g.seed };
}

app.use(express.static(path.join(__dirname, 'public')));

// Tareas de fondo: expira partidas abandonadas y reintenta reembolsos fallidos.
setInterval(() => {
  try {
    expireStale();
    for (const g of q("SELECT * FROM games WHERE status='finished' AND refund>0 AND refund_status IN ('pending','failed') AND refund_tries<10 AND finished_at<?").all(Date.now() - 20000)) doRefund(g);
  } catch (e) { console.error('job', e.message); }
}, 60000).unref();

if (require.main === module) app.listen(CFG.port, () => console.log(`Cabina en ${CFG.base} (modo ${CFG.mode})`));
module.exports = { app, CFG, db };
