'use strict';
// 浏览器内数据引擎：直接请求 Lnfi 公开接口，历史缓存在 IndexedDB。
(function () {
const API = 'https://api.lnfi.network';
const HISTORY_DAYS = 62;            // 30d 及“较上一个 30d”需要 60 天
const KEEP_DAYS = 70;               // 缓存最多保留天数
const TRADE_POLL_MS = 60e3, BOOK_POLL_MS = 3 * 60e3, HOLDER_POLL_MS = 15 * 60e3, LIST_POLL_MS = 60e3, BTC_POLL_MS = 5 * 60e3;
const MIN_GAP_MS = 250;
const DAY = 864e5, HOUR = 36e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listeners = new Set();
let notifyT = null;
function notify() { if (notifyT) return; notifyT = setTimeout(() => { notifyT = null; listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }, 400); }

// ---------- IndexedDB ----------
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open('lnfi-tape', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }).catch(() => null);
  return dbP;
}
async function idbGet(k) { const d = await db(); if (!d) return null; return new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
async function idbSet(k, v) { const d = await db(); if (!d) return; return new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); }

// ---------- 请求（串行、限速、退避） ----------
let lastCall = 0, backoff = 0, chain = Promise.resolve();
const net = { ok: null, err: null, count: 0 };
function call(p, body) {
  const job = chain.then(async () => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS + backoff - Date.now()); if (wait) await sleep(wait);
    lastCall = Date.now();
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20e3);
      const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(to); net.count++;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); if (j.code !== 0) throw new Error('code ' + j.code);
      backoff = Math.max(0, backoff / 2 - 100); net.ok = Date.now(); return j.data;
    } catch (e) { backoff = Math.min(60e3, backoff ? backoff * 2 : 2000); net.err = { at: Date.now(), msg: String(e.message || e) }; throw e; }
  });
  chain = job.catch(() => {});
  return job;
}
async function callRetry(p, body, tries = 4) { for (let i = 0; ; i++) { try { return await call(p, body); } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); } } }
const hist = (token, status, page, eventId = '') => callRetry('/market/api/orderHistoryV1', { token, type: '', status, address: '', eventId, page, count: 100 });

// ---------- 状态 ----------
const S = { list: [], listAt: 0, btcUsd: null, m: {} };
const progress = { phase: 'list', market: null, page: 0, reached: null, done: 0, total: 0 };
const ms = s => Date.parse(s.endsWith('Z') ? s : s + 'Z');
const leg = o => [o.id, o.event_id, o.type === 'BUY' ? 1 : 0, o.owner, ms(o.create_time), ms(o.modify_time), +o.avg_price, +o.deal_volume, +o.deal_money, +o.price];
const sig4 = x => +x.toPrecision(4);
function px(l) { const r = l[7] ? l[8] / l[7] : l[6]; if (l[9] && Math.abs(l[9] / r - 1) < 0.01) return l[9]; return sig4(r); }
async function mkt(name) {
  if (S.m[name]) return S.m[name];
  const saved = await idbGet('m:' + name);
  const m = { name, legs: new Map(), makerCache: {}, backfilled: false, backfillPage: 1, sumCount: 0, book: null, bookAt: 0, holders: null, holdersAt: 0, tradesAt: 0, cache: null, ver: 0 };
  if (saved && saved.legs && saved.legs.length) {
    const newest = Math.max(...saved.legs.map(l => l[4]));
    if (Date.now() - newest < 50 * DAY) { // 太久没打开（>50 天）就丢掉重来
      saved.legs.forEach(l => m.legs.set(l[0], l)); m.makerCache = saved.makerCache || {}; m.backfilled = !!saved.backfilled; m.backfillPage = saved.backfillPage || 1;
    }
  }
  if (saved && saved.holders) { m.holders = saved.holders; m.holdersAt = saved.holdersAt || 0; }
  S.m[name] = m; return m;
}
async function save(m) {
  const cut = Date.now() - KEEP_DAYS * DAY;
  for (const [id, l] of m.legs) if (l[4] < cut && l[5] < cut) m.legs.delete(id);
  await idbSet('m:' + m.name, { legs: [...m.legs.values()], makerCache: m.makerCache, backfilled: m.backfilled, backfillPage: m.backfillPage, holders: m.holders, holdersAt: m.holdersAt });
}
function addLegs(m, arr) { let n = 0; for (const o of arr) { if (!m.legs.has(o.id)) n++; m.legs.set(o.id, leg(o)); } if (n) { m.ver++; m.cache = null; } return n; }

// ---------- 抓取 ----------
async function refreshList() {
  try {
    const d = await callRetry('/market/api/getTokenList', {});
    S.list = d.filter(t => t.isBase === 1 && t.name !== 'SATS').map(t => ({
      name: t.name, token: t.token, proto: String(t.token).startsWith('rgb:') ? 'RGB' : 'Taproot',
      quote: t.dealPrice != null ? +t.dealPrice : null, vol24api: t.tfTotalPrice != null ? +t.tfTotalPrice : 0,
      supply: t.totalSupply / (t.decimals || 1), decimals: t.decimals || 1,
    }));
    S.listAt = Date.now(); idbSet('list', S.list); notify();
  } catch (e) { console.warn('列表失败', e); }
}
async function refreshBtc() { try { const j = await (await fetch('https://mempool.space/api/v1/prices')).json(); if (j.USD) { S.btcUsd = j.USD; notify(); } } catch {} }
async function backfill(m) {
  const horizon = Date.now() - HISTORY_DAYS * DAY;
  let page = m.backfillPage || 1;
  progress.market = m.name;
  while (!m.backfilled) {
    let d; try { d = await hist(m.name, 'SUCCESS', page); } catch (e) { return false; }
    m.sumCount = d.sumCount; const arr = d.orderPOS || [];
    if (!arr.length && page * 100 < d.sumCount) { await sleep(10e3); continue; }
    addLegs(m, arr);
    const oldest = arr.length ? ms(arr[arr.length - 1].create_time) : 0;
    progress.page = page; progress.reached = oldest || null;
    if (!arr.length || arr.length < 100 || oldest < horizon || page * 100 >= d.sumCount) m.backfilled = true;
    page++; m.backfillPage = page;
    if (page % 10 === 0) save(m);
    notify();
  }
  await save(m); return true;
}
async function pollTrades(m) {
  for (let page = 1; page <= 200; page++) {
    const d = await hist(m.name, 'SUCCESS', page); m.sumCount = d.sumCount;
    const arr = d.orderPOS || []; const known = arr.filter(o => m.legs.has(o.id)).length; const fresh = m.legs.size === 0;
    addLegs(m, arr);
    if (!arr.length || known > 0 || arr.length < 100 || fresh) break;
  }
  m.tradesAt = Date.now(); notify();
  if (m.backfilled) { await resolveMakers(m, 10); await save(m); }
}
// 只看到吃单腿（挂单早于 60 天）的 30 天内成交：用 eventId 查回挂单者，永久缓存
async function resolveMakers(m, limit) {
  const cut = Date.now() - 30 * DAY; let n = 0;
  for (const [ev, g] of groupEvents(m)) {
    if (n >= limit) break;
    if (m.makerCache[ev] !== undefined || new Set(g.map(l => l[2])).size > 1 || g[0][4] < cut) continue;
    n++;
    try { const d = await hist(m.name, 'SUCCESS', 1, ev); const t = g[0][2]; const mk = (d.orderPOS || []).find(o => (o.type === 'BUY' ? 1 : 0) !== t); m.makerCache[ev] = mk ? [mk.owner] : 0; m.cache = null; } catch { break; }
  }
  if (n) notify();
}
async function pollBook(m) {
  const all = [];
  for (let page = 1; page <= 30; page++) { const d = await hist(m.name, 'INIT', page); const arr = d.orderPOS || []; all.push(...arr); if (arr.length < 100 || page * 100 >= d.sumCount) break; }
  const rows = all.map(o => ({ side: o.type, price: +o.price, vol: (+o.volume) - (+o.deal_volume) })).filter(r => r.vol > 0);
  const agg = side => { const mp = new Map(); for (const r of rows.filter(r => r.side === side)) { const a = mp.get(r.price) || { price: r.price, vol: 0, n: 0 }; a.vol += r.vol; a.n++; mp.set(r.price, a); } return [...mp.values()].sort((a, b) => side === 'SELL' ? a.price - b.price : b.price - a.price); };
  m.book = { asks: agg('SELL'), bids: agg('BUY'), orders: rows.length }; m.bookAt = Date.now(); m.cache = null; notify();
}
async function pollHolderCount(m, info) {
  const s = (await callRetry('/assets/api/getHolderSummary', { assetId: info.token })).data || {};
  m.holders = { ...(m.holders || {}), count: s.holderCount, total: +s.totalSupply || info.supply * info.decimals }; m.cache = null; notify();
}
async function pollHolders(m, info) {
  await pollHolderCount(m, info);
  const top = await callRetry('/assets/api/getHolders', { assetId: info.token, page: 1, count: 20 });
  m.holders.top = (top.data || []).map(h => { const b = +h.balance + (+h.lockBalance || 0); return { owner: h.owner, bal: b / info.decimals, share: b / m.holders.total }; });
  m.holdersAt = Date.now(); m.cache = null; save(m); notify();
}

// ---------- 计算（与服务器版口径一致） ----------
function groupEvents(m) { const g = new Map(); for (const l of m.legs.values()) { let a = g.get(l[1]); if (!a) g.set(l[1], a = []); a.push(l); } return g; }
function trades(m) {
  const out = [];
  for (const [ev, g] of groupEvents(m)) {
    g.sort((a, b) => a[0] - b[0]);
    let makerOwner = null, takers;
    if (new Set(g.map(l => l[2])).size > 1) { const mk = g[0]; makerOwner = mk[3]; takers = g.filter(l => l[2] !== mk[2]); }
    else { takers = g.filter(l => l[5] - l[4] < 120e3); const c = m.makerCache[ev]; if (c) makerOwner = c[0]; }
    for (const l of takers) if (l[7] > 0) out.push({ id: l[0], t: l[5] || l[4], p: px(l), v: l[7], s: l[8], side: l[2] ? 'buy' : 'sell', taker: l[3], maker: makerOwner });
  }
  return out.sort((a, b) => a.t - b.t);
}
function lastBefore(tr, t) { let p = null; for (const x of tr) { if (x.t <= t) p = x.p; else break; } return p; }
function windowStats(tr, from, to) { let vol = 0, n = 0, buy = 0; const w = new Set(); for (const x of tr) if (x.t > from && x.t <= to) { vol += x.s; n++; if (x.side === 'buy') buy += x.s; w.add(x.taker); if (x.maker) w.add(x.maker); } return { vol, n, buy, wallets: w.size }; }
function series(tr, step, from, to) {
  const out = []; let i = 0; let last = lastBefore(tr, from);
  while (i < tr.length && tr[i].t <= from) i++;
  for (let t = Math.floor(from / step) * step; t < to; t += step) {
    let o = null, h = -Infinity, l = Infinity, c = last, v = 0, n = 0;
    while (i < tr.length && tr[i].t < t + step) { const x = tr[i++]; if (o === null) o = x.p; h = Math.max(h, x.p); l = Math.min(l, x.p); c = x.p; v += x.s; n++; }
    if (o === null) { o = h = l = c; }
    out.push([t, o, h, l, c, v, n]); last = c;
  }
  return out;
}
function summary(m, info) {
  const now = Date.now();
  if (m.cache && now - m.cache.at < 15e3) return m.cache;
  const tr = trades(m); const last = tr.length ? tr[tr.length - 1] : null;
  const pc = d => { const p0 = lastBefore(tr, now - d); return last && p0 ? last.p / p0 - 1 : null; };
  // 回填未覆盖整个“上一窗口”时，较上期不显示
  const covered = d => m.backfilled || (progress.reached && progress.market === m.name && progress.reached < now - 2 * d);
  const w = d => { const a = windowStats(tr, now - d, now), b = windowStats(tr, now - 2 * d, now - d); const ok = covered(d); return { vol: a.vol, prev: ok ? b.vol : null, chg: ok && b.vol ? a.vol / b.vol - 1 : null, n: a.n, buy: a.buy, wallets: a.wallets }; };
  const bestAsk = m.book && m.book.asks[0] ? m.book.asks[0].price : null, bestBid = m.book && m.book.bids[0] ? m.book.bids[0].price : null;
  const s = {
    name: info.name, token: info.token, proto: info.proto, supply: info.supply, quote: info.quote, vol24api: info.vol24api,
    last: last ? last.p : null, lastAt: last ? last.t : null, ch24: pc(DAY), ch7: pc(7 * DAY), ch30: covered(15 * DAY) ? pc(30 * DAY) : null,
    v24: w(DAY), v7: w(7 * DAY), v30: w(30 * DAY), fdv: last ? last.p * info.supply : null, holders: m.holders ? m.holders.count : null,
    bestAsk, bestBid, spark: series(tr, 4 * HOUR, now - 7 * DAY, now).map(r => r[4]), backfilled: m.backfilled, loaded: m.legs.size > 0,
  };
  m.cache = { at: now, s, tr }; return m.cache;
}

// ---------- 对外接口（与服务器版 JSON 结构相同） ----------
function markets() {
  return { ready: S.list.length > 0, now: Date.now(), btcUsd: S.btcUsd, apiOk: net.ok, apiErr: net.err, progress: { ...progress },
    markets: S.list.filter(i => S.m[i.name]).map(info => { const m = S.m[info.name]; return { ...summary(m, info).s, tradesAt: m.tradesAt, bookAt: m.bookAt, holdersAt: m.holdersAt }; }) };
}
function market(name) {
  const info = S.list.find(t => t.name.toLowerCase() === String(name).toLowerCase()); if (!info || !S.m[info.name]) return null;
  const m = S.m[info.name]; const { s, tr } = summary(m, info); const now = Date.now(); const first = tr.length ? tr[0].t : now - DAY;
  const traders = new Set(); for (const l of m.legs.values()) traders.add(l[3]);
  const holders = m.holders && m.holders.top ? { count: m.holders.count, top: m.holders.top.map(h => ({ ...h, traded: traders.has(h.owner) })) } : null;
  return { now, btcUsd: S.btcUsd, summary: s, tradesAt: m.tradesAt, bookAt: m.bookAt, holdersAt: m.holdersAt,
    charts: { m15: series(tr, 15 * 60e3, now - 3 * DAY, now), h1: series(tr, HOUR, Math.max(first - HOUR, now - 30 * DAY), now), d1: series(tr, DAY, first - DAY, now) },
    trades: tr.slice(-150).reverse(), book: m.book, holders };
}

// ---------- 调度 ----------
let focus = null; // 当前打开的详情页市场，优先刷新
const visible = () => !document.hidden;
async function waitVisible() { while (!visible()) await sleep(1000); }
async function start() {
  const cachedList = await idbGet('list'); if (cachedList) { S.list = cachedList; for (const i of S.list) await mkt(i.name); notify(); }
  refreshBtc();
  await refreshList();
  if (!S.list.length) { await sleep(5000); return start(); }
  for (const i of S.list) await mkt(i.name);
  notify();
  // 先 PPRGB，其余按 Lnfi 24h 成交额
  const order = [...S.list].sort((a, b) => (b.name === 'PPRGB') - (a.name === 'PPRGB') || b.vol24api - a.vol24api);
  progress.total = order.length; progress.phase = 'history';
  // 持有人数量（每个 1 次请求）先拿，表格就完整了
  for (const i of order) { try { await pollHolderCount(S.m[i.name], i); } catch {} }
  for (const i of order) {
    const m = S.m[i.name];
    await waitVisible();
    if (m.backfilled) { try { await pollTrades(m); } catch {} }
    else await backfill(m);
    progress.done++;
    if (i.name === 'PPRGB' || i.name === focus) { try { await pollBook(m); } catch {} }
    notify();
  }
  progress.phase = 'done'; progress.market = null; notify();
  for (const i of order) { const m = S.m[i.name]; await resolveMakers(m, 40); await save(m); }
  // 定时任务（仅在页面可见时）
  const timers = { trades: Date.now(), book: 0, holders: 0, list: Date.now(), btc: Date.now() };
  for (;;) {
    await sleep(2000); await waitVisible();
    const now = Date.now();
    try {
      if (now - timers.list > LIST_POLL_MS) { timers.list = now; await refreshList(); for (const i of S.list) await mkt(i.name); }
      if (now - timers.btc > BTC_POLL_MS) { timers.btc = now; refreshBtc(); }
      if (now - timers.trades > TRADE_POLL_MS) { timers.trades = now; for (const i of S.list) { await waitVisible(); try { await pollTrades(S.m[i.name]); } catch {} } }
      if (now - timers.book > BOOK_POLL_MS) { timers.book = now; for (const i of S.list) { await waitVisible(); try { await pollBook(S.m[i.name]); } catch {} } }
      if (now - timers.holders > HOLDER_POLL_MS) { timers.holders = now; for (const i of S.list) { await waitVisible(); try { await pollHolders(S.m[i.name], i); } catch {} } }
    } catch (e) { console.warn(e); }
  }
}
// 打开详情页时：如果挂单/持有人还没有，插队拿一次
async function ensureDetail(name) {
  focus = name; const info = S.list.find(t => t.name === name); const m = S.m[name]; if (!info || !m) return;
  try { if (!m.book || Date.now() - m.bookAt > BOOK_POLL_MS) await pollBook(m); } catch {}
  try { if (!m.holders || !m.holders.top || Date.now() - m.holdersAt > HOLDER_POLL_MS) await pollHolders(m, info); } catch {}
}
window.LNFI = { start, markets, market, ensureDetail, onUpdate: f => listeners.add(f), net, progress, HISTORY_DAYS };
})();
