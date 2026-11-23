'use strict';
// Prueba de punta a punta con un Mercado Pago simulado: cobro, webhook firmado,
// re-simulación, reembolso parcial y pozo.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');

const mock = { refs: {}, refunds: [], last: null };
const mpServer = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = body ? JSON.parse(body) : {}; const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/checkout/preferences') { mock.last = j.external_reference; return send(201, { id: 'pref', init_point: 'https://mp.test/pay' }); }
    let m;
    if (req.method === 'GET' && (m = req.url.match(/^\/v1\/payments\/(\d+)$/))) return send(200, { id: +m[1], status: 'approved', transaction_amount: 500, currency_id: 'ARS', external_reference: mock.refs[m[1]] || mock.last });
    if (req.method === 'POST' && (m = req.url.match(/^\/v1\/payments\/(\d+)\/refunds$/))) { mock.refunds.push({ payment: m[1], amount: j.amount, key: req.headers['x-idempotency-key'], auth: req.headers.authorization }); return send(201, { id: 900 + mock.refunds.length }); }
    send(404, {});
  });
});

(async () => {
  await new Promise(r => mpServer.listen(0, r));
  Object.assign(process.env, { MP_BASE_URL: `http://127.0.0.1:${mpServer.address().port}`, MP_ACCESS_TOKEN: 'TEST-token', MP_WEBHOOK_SECRET: 'sek', MIN_PLAY_MS: '0', DB_PATH: path.join(os.tmpdir(), `cabina-${Date.now()}.db`), BASE_URL: 'http://localhost:3000' });
  const { app, CFG } = require('./server.js');
  const Sim = require('./public/sim.js');
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const api = (p, o = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: o.body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));

  // Bot de prueba que juega con la misma simulación y registra sus entradas.
  function bot(seed, total) {
    const S = Sim.newGame(seed, total), inputs = [], taps = []; let p = { x: 180, y: 260 }, tg = null, rc = 0, s = seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let f = 0; f < Sim.FRAMES; f++) {
      rc -= Sim.DT;
      if (rc <= 0) { rc = .25; let bd = 1e9; tg = null; for (const b of S.bills) if (b.on) { const d = Math.hypot(b.x - p.x, b.y - p.y); if (d < bd) { bd = d; tg = b; } } }
      let tap = false;
      if (tg && tg.on) {
        const dx = tg.x + tg.vx * Sim.P.close - p.x + (rnd() - .5) * 20, dy = tg.y + tg.vy * Sim.P.close - p.y + (rnd() - .5) * 20, d = Math.hypot(dx, dy) || 1, m = Math.min(d, 450 * Sim.DT);
        p.x += dx / d * m; p.y += dy / d * m;
        if (d < Sim.P.grab * .6 && S.cd <= 0 && !S.gr) tap = true;
      }
      const k = Sim.pack(p.x, p.y); inputs.push(k); if (tap) taps.push(f); Sim.tick(S, k, tap);
    }
    return { inputs, taps, got: S.got };
  }

  const newPaidGame = async (payId) => {
    const o = await api('/api/orders', { body: {} }); assert.equal(o.s, 200);
    mock.refs[payId] = o.j.gameId;
    return o.j.gameId;
  };
  const ok = (n) => console.log('ok  ', n);

  // 1. Flujo completo
  assert.equal((await api('/api/state')).j.pozo, 0);
  const id1 = await newPaidGame(111);
  assert.equal((await api(`/api/games/${id1}/start`, { body: {} })).s, 409); ok('no se puede iniciar sin pagar');
  assert.equal((await api(`/api/games/${id1}/confirm`, { body: { payment_id: '111' } })).j.status, 'paid'); ok('pago confirmado contra MP');
  const st = await api(`/api/games/${id1}/start`, { body: {} });
  assert.equal(st.s, 200); assert.equal(st.j.total, 500);
  assert.equal((await api(`/api/games/${id1}/start`, { body: {} })).j.error, 'already_started'); ok('semilla entregada una sola vez');
  const b1 = bot(st.j.seed, st.j.total);
  const f1 = await api(`/api/games/${id1}/finish`, { body: { ptr: b1.inputs, taps: b1.taps } });
  assert.equal(f1.s, 200);
  assert.equal(f1.j.got, b1.got, 'la re-simulación del servidor coincide con la del cliente');
  assert.equal(f1.j.refund + f1.j.toPozo + f1.j.casa, f1.j.total, 'el dinero se conserva');
  assert.equal(mock.refunds.length, 1); assert.equal(mock.refunds[0].amount, b1.got); assert.equal(mock.refunds[0].payment, '111');
  assert.ok(mock.refunds[0].key.startsWith('cabina-refund-')); assert.equal(f1.j.refundStatus, 'done');
  ok(`reembolso parcial de $${b1.got} sobre el pago original, pozo $${f1.j.pozo}, casa $${f1.j.casa}`);
  const again = await api(`/api/games/${id1}/finish`, { body: { ptr: b1.inputs, taps: b1.taps } });
  assert.equal(again.j.got, f1.j.got); assert.equal(mock.refunds.length, 1); ok('reenviar el resultado no reembolsa dos veces');

  // 2. El pozo pasa a la partida siguiente
  const pozo1 = (await api('/api/state')).j.pozo; assert.ok(pozo1 > 0);
  const id2 = await newPaidGame(222); await api(`/api/games/${id2}/confirm`, { body: { payment_id: '222' } });
  const st2 = await api(`/api/games/${id2}/start`, { body: {} }); assert.equal(st2.j.total, 500 + pozo1); ok(`la partida 2 arranca con $${st2.j.total} (500 + pozo)`);
  assert.equal((await api('/api/state')).j.pozo, 0, 'el pozo queda reservado mientras se juega');

  // 3. Trampas
  const b2 = bot(st2.j.seed, st2.j.total);
  const fake = await api(`/api/games/${id2}/finish`, { body: { ptr: b2.inputs, taps: [...b2.taps, ...Array.from({ length: 60 }, (_, i) => 1700 + i)].sort((a, b) => a - b).filter((v, i, a) => a.indexOf(v) === i) } });
  assert.ok(fake.s === 200 && fake.j.got <= st2.j.total); ok(`tap inventados no suman: el servidor calculó $${fake.j.got}`);
  const id3 = await newPaidGame(333); await api(`/api/games/${id3}/confirm`, { body: { payment_id: '333' } });
  const st3 = await api(`/api/games/${id3}/start`, { body: {} }); const b3 = bot(st3.j.seed, st3.j.total);
  const tp = b3.inputs.slice(); tp[500] = Sim.pack(10, 10); tp[501] = Sim.pack(350, 500);
  assert.equal((await api(`/api/games/${id3}/finish`, { body: { ptr: tp, taps: b3.taps } })).j.error, 'ptr_jump'); ok('teletransportar la mano se rechaza');
  CFG.minPlayMs = 1e9; assert.equal((await api(`/api/games/${id3}/finish`, { body: { ptr: b3.inputs, taps: b3.taps } })).s, 425); CFG.minPlayMs = 0; ok('enviar el resultado antes de 30 s se rechaza');
  assert.equal((await api(`/api/games/${id3}/finish`, { body: { ptr: b3.inputs.slice(0, 10), taps: [] } })).j.error, 'ptr_length'); ok('entradas incompletas se rechazan');

  // 4. Webhook firmado y pago reutilizado
  const id4 = await newPaidGame(444);
  const wh = (sig) => api('/api/mp-webhook?data.id=444&type=payment', { body: { type: 'payment', data: { id: '444' } }, headers: { 'x-request-id': 'req-1', 'x-signature': sig } });
  assert.equal((await wh('ts=1,v1=deadbeef')).s, 401); ok('webhook con firma inválida: 401');
  const sig = crypto.createHmac('sha256', 'sek').update('id:444;request-id:req-1;ts:1;').digest('hex');
  assert.equal((await wh(`ts=1,v1=${sig}`)).s, 200); assert.equal((await api(`/api/games/${id4}`)).j.status, 'paid'); ok('webhook con firma válida marca la partida como paga');
  const id5 = await newPaidGame(555); mock.refs['444'] = id5;
  assert.equal((await api(`/api/games/${id5}/confirm`, { body: { payment_id: '444' } })).j.reason, 'payment_reused'); ok('un mismo pago no sirve para dos partidas');

  console.log('\nTodo OK'); srv.close(); mpServer.close(); process.exit(0);
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
