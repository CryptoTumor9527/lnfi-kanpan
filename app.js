'use strict';
// ===== 持仓配置：改这里即可（名字、数量；token 为市场名） =====
const HOLDINGS = {
  token: 'PPRGB',
  list: [
    { name: '毒瘤', qty: 50000 },
    { name: '洪总', qty: 10674 },
  ],
};
// ===== 工具 =====
const $ = s => document.querySelector(s);
const TZ = 'Asia/Shanghai';
const fDT = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fT = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fD = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let unit = localStorage.getItem('unit') || 'sats';
let btcUsd = null;

function num(n, d) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (d == null) d = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
function compact(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '万';
  return num(n);
}
function usdP(p) { // 单价 USDT，约 4 位有效数字
  if (p == null || !isFinite(p) || !btcUsd) return '—';
  const u = p * btcUsd / 1e8; if (u === 0) return '$0';
  const d = Math.max(0, Math.min(12, 3 - Math.floor(Math.log10(Math.abs(u)))));
  return '$' + Number(u.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
function price(p) { // sats/枚：上 sats（粗），下 USDT（小灰）
  if (p == null) return '—';
  return `<span class="dp"><b>${num(p)} <small>sats</small></b><em>${usdP(p)}</em></span>`;
}
function sats(v) { // 金额（sats）
  if (v == null) return '—';
  if (unit === 'usd' && btcUsd) { const u = v * btcUsd / 1e8; return '$' + compact(u); }
  if (v >= 1e8) return num(v / 1e8, 3) + ' <small class="mut">BTC</small>';
  return compact(v);
}
function usdt(v) { // sats 市值 → USDT（按 BTC/USD 价，USD 视同 USDT），不受 sats/USD 切换影响
  if (v == null || !isFinite(v) || !btcUsd) return '—';
  const u = v * btcUsd / 1e8;
  if (Math.abs(u) >= 1e6) return (u / 1e6).toFixed(2) + 'M <small class="mut">USDT</small>';
  return u.toLocaleString('en-US', { maximumFractionDigits: u >= 100 ? 0 : 2 }) + ' <small class="mut">USDT</small>';
}
function fdvTxt(v) { if (v == null) return '—'; const btc = v / 1e8; return unit === 'usd' && btcUsd ? '$' + compact(btc * btcUsd) : num(btc, btc >= 10 ? 1 : 3) + ' <small class="mut">BTC</small>'; }
function pct(x, cls = true) {
  if (x == null || !isFinite(x)) return '<span class="mut">—</span>';
  const s = (x > 0 ? '+' : '') + (x * 100).toFixed(Math.abs(x) >= 10 ? 0 : 1) + '%';
  return cls ? `<span class="${x > 0 ? 'up' : x < 0 ? 'dn' : 'mut'}">${s}</span>` : s;
}
function ago(t) {
  if (!t) return '—'; const s = (Date.now() - t) / 1e3;
  if (s < 60) return Math.max(0, s | 0) + ' 秒前'; if (s < 3600) return (s / 60 | 0) + ' 分钟前';
  if (s < 86400) return (s / 3600 | 0) + ' 小时前'; return (s / 86400 | 0) + ' 天前';
}
// hex 公钥 -> npub（bech32）
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; } return c; }
function npub(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) return hex || '';
  const bytes = hex.match(/../g).map(h => parseInt(h, 16)); const d = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
  if (bits) d.push((acc << (5 - bits)) & 31);
  const hrp = 'npub', ex = [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];
  const pm = polymod([...ex, ...d, 0, 0, 0, 0, 0, 0]) ^ 1; const ck = []; for (let i = 0; i < 6; i++) ck.push((pm >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...d, ...ck].map(x => CH[x]).join('');
}
const shortKey = h => { const n = npub(h); return n.length > 20 ? n.slice(0, 10) + '…' + n.slice(-5) : n; };

// ===== 迷你走势图 =====
function spark(cv, arr) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth || 110, h = cv.clientHeight || 30;
  cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const v = (arr || []).filter(x => x != null); if (v.length < 2) return;
  const lo = Math.min(...v), hi = Math.max(...v), rg = hi - lo || hi || 1;
  const col = v[v.length - 1] >= v[0] ? '#22d3a6' : '#ff5d73';
  g.beginPath(); v.forEach((y, i) => { const X = i / (v.length - 1) * w, Y = h - 2 - (y - lo) / rg * (h - 4); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
  g.strokeStyle = col; g.lineWidth = 1.4; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath(); const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, col + '33'); gr.addColorStop(1, col + '00'); g.fillStyle = gr; g.fill();
}

// ===== 首页 =====
let M = null, sortK = localStorage.getItem('sortK') || 'v24', sortAsc = false, proto = 'all';
const getters = {
  name: m => m.name, last: m => m.last, ch24: m => m.ch24, ch7: m => m.ch7, ch30: m => m.ch30,
  v24: m => m.v24.vol, v7: m => m.v7.vol, v30: m => m.v30.vol, w30: m => m.v30.wallets, holders: m => m.holders, fdv: m => m.fdv,
};
function renderHome() {
  if (!M) return;
  btcUsd = M.btcUsd;
  let rows = M.markets.filter(m => proto === 'all' || m.proto === proto);
  const g = getters[sortK] || getters.v24;
  rows.sort((a, b) => { const x = g(a), y = g(b); if (x == null) return 1; if (y == null) return -1; const r = typeof x === 'string' ? x.localeCompare(y) : x - y; return sortAsc ? r : -r; });
  document.querySelectorAll('#mt th').forEach(th => { th.classList.toggle('sort', th.dataset.k === sortK); th.classList.toggle('asc', th.dataset.k === sortK && sortAsc); });
  const vc = w => `${sats(w.vol)}<span class="vchg">${w.prev || w.vol ? pct(w.chg) : ''}</span>`;
  $('#mt tbody').innerHTML = rows.map(m => `<tr data-n="${esc(m.name)}">
    <td class="l"><span class="nm">${esc(m.name)}</span><span class="tag ${m.proto}">${m.proto}</span><span class="sub2">${!m.loaded && !m.backfilled ? '排队加载…' : m.lastAt ? '最后成交 ' + ago(m.lastAt) : '60 天内无成交'}${m.backfilled || !m.loaded ? '' : ' · 历史加载中'}</span></td>
    <td>${price(m.last)}</td><td>${pct(m.ch24)}</td><td>${pct(m.ch7)}</td><td>${pct(m.ch30)}</td>
    <td>${vc(m.v24)}</td><td>${vc(m.v7)}</td><td>${vc(m.v30)}</td>
    <td>${m.v30.wallets || '—'}</td><td>${m.holders != null ? num(m.holders) : '—'}</td><td>${fdvTxt(m.fdv)}</td>
    <td><canvas></canvas></td></tr>`).join('');
  $('#mt tbody').querySelectorAll('tr').forEach((tr, i) => spark(tr.querySelector('canvas'), rows[i].spark));
  // 顶部卡片：按 24h 成交额前 6
  const top = [...M.markets].sort((a, b) => (b.v24.vol - a.v24.vol) || ((b.v7.vol) - (a.v7.vol))).slice(0, 6);
  $('#cards').innerHTML = top.map(m => `<div class="card" data-n="${esc(m.name)}"><div class="r1"><span><span class="nm">${esc(m.name)}</span><span class="tag ${m.proto}">${m.proto}</span></span>${pct(m.ch24)}</div>
    <div class="px">${price(m.last)}</div><div class="sm">24h 量 ${sats(m.v24.vol)} · ${m.v24.n} 笔</div><canvas></canvas></div>`).join('');
  $('#cards').querySelectorAll('.card').forEach((c, i) => spark(c.querySelector('canvas'), top[i].spark));
  $('#btc').innerHTML = btcUsd ? `BTC $${num(btcUsd, 0)}` : '';
}
function setStatus(ok, txt) {
  $('#status').innerHTML = `<i class="dot ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}"></i><span>${txt}</span>`;
}
let lastOk = 0;
async function loadHome() {
  try {
    M = LNFI.markets();
    const pg = M.progress;
    const lnfiStale = M.apiErr && (!M.apiOk || M.apiErr.at > M.apiOk) && Date.now() - (M.apiOk || 0) > 2 * 60e3;
    let txt;
    if (!M.ready) txt = '正在读取市场列表…';
    else if (pg.phase !== 'done') txt = `加载中 ${pg.done}/${pg.total}${pg.market ? ` · ${pg.market} 第 ${pg.page} 页${pg.reached ? '（已到 ' + fD.format(new Date(pg.reached)).slice(5) + '）' : ''}` : ''}`;
    else txt = `更新于 ${M.apiOk ? fT.format(new Date(M.apiOk)) : '—'}`;
    if (lnfiStale) txt += ' · Lnfi 暂无响应，稍后重试';
    setStatus(lnfiStale ? false : pg.phase === 'done' ? true : null, txt);
    if (!route.name) renderHome();
  } catch (e) { console.error(e); setStatus(false, '出错：' + e.message); }
}

// ===== 持仓面板（固定在顶部） =====
function renderHoldings() {
  const el = $('#hold'); if (!el) return;
  let mk = null, bu = null;
  try { const all = LNFI.markets(); bu = all.btcUsd; mk = all.markets.find(m => m.name === HOLDINGS.token); } catch {}
  const px = mk && mk.last != null ? mk.last : null;
  const fmtBtc = v => v == null ? '—' : num(v / 1e8, 4) + ' BTC';
  const fmtUsd = v => v == null || !bu ? '—' : '$' + (v * bu / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtSats = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const cell = (name, qty, cls = '') => { const v = px == null ? null : qty * px; return `<div class="hc ${cls}">
    <div class="hn"><b>${esc(name)}</b><span>${num(qty, 0)} ${esc(HOLDINGS.token)}</span></div>
    <div class="hv">${fmtSats(v)} <small>sats</small></div>
    <div class="hs">${fmtBtc(v)} · ${fmtUsd(v)}</div></div>`; };
  const tot = HOLDINGS.list.reduce((a, h) => a + h.qty, 0);
  el.innerHTML = `<div class="hc hp"><div class="hn"><b>${esc(HOLDINGS.token)} 现价</b><span>${mk && mk.backfilled && mk.ch24 != null ? '24h ' + pct(mk.ch24) : ''}</span></div>
    <div class="hv">${px == null ? '<span class="mut">读取中…</span>' : price(px)}</div>
    <div class="hs">${mk && mk.lastAt ? '成交于 ' + fDT.format(new Date(mk.lastAt)) : ''}${bu ? ' · BTC $' + num(bu, 0) : ''}</div></div>`
    + HOLDINGS.list.map(h => cell(h.name, h.qty)).join('') + (HOLDINGS.list.length > 1 ? cell('合计', tot, 'ht') : '');
}

// ===== 详情页 =====
let D = null, tf = 'h1', ctype = 'line', route = {};
function stat(k, v, s = '') { return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderDetail() {
  if (!D) return; btcUsd = D.btcUsd; $('#btc').innerHTML = btcUsd ? `BTC $${num(btcUsd, 0)}` : '';
  const s = D.summary;
  $('#dName').textContent = s.name; $('#dProto').textContent = s.proto; $('#dProto').className = 'tag ' + s.proto;
  $('#dLast').innerHTML = price(s.last); $('#dCh').innerHTML = '24h ' + pct(s.ch24);
  document.title = `${s.name} ${s.last != null ? num(s.last) + ' sats' : ''} · Lnfi 看盘`;
  const w = x => `${pct(x.chg)} 较上期 · ${x.n} 笔`;
  $('#dStats').innerHTML = [
    stat('24h 成交额', sats(s.v24.vol), w(s.v24)), stat('7d 成交额', sats(s.v7.vol), w(s.v7)), stat('30d 成交额', sats(s.v30.vol), w(s.v30)),
    stat('7d / 30d 涨跌', `${pct(s.ch7)} / ${pct(s.ch30)}`, '按实际成交价'),
    stat('24h 买入占比', s.v24.vol ? (s.v24.buy / s.v24.vol * 100).toFixed(0) + '%' : '—', '吃单买入 / 总额'),
    stat('钱包（24h / 30d）', `${s.v24.wallets} / ${s.v30.wallets}`, '参与成交的 Nostr 公钥'),
    stat('持有人', s.holders != null ? num(s.holders) : '—', D.holdersAt ? '更新 ' + ago(D.holdersAt) : ''),
    stat('隐含 FDV', fdvTxt(s.fdv), `供应 ${compact(s.supply)} × 最新价`),
    stat('买一 / 卖一', `${s.bestBid != null ? num(s.bestBid) : '—'} / ${s.bestAsk != null ? num(s.bestAsk) : '—'}`, (s.bestBid != null || s.bestAsk != null ? `${usdP(s.bestBid)} / ${usdP(s.bestAsk)} · ` : '') + (s.bestBid && s.bestAsk ? '价差 ' + ((s.bestAsk / s.bestBid - 1) * 100).toFixed(1) + '%' : '')),
    stat('Lnfi 报价', s.quote != null ? num(s.quote) + ' sats' : '—', (s.quote != null ? usdP(s.quote) + ' · ' : '') + 'Lnfi 列表价（参考）'),
    stat('最后成交', s.lastAt ? ago(s.lastAt) : '—', s.lastAt ? fDT.format(new Date(s.lastAt)) : ''),
  ].join('');
  // 成交
  $('#trHint').textContent = D.tradesAt ? '刷新 ' + fT.format(new Date(D.tradesAt)) : '';
  $('#trades').innerHTML = `<div class="row h"><span>时间</span><span>方向</span><span>价格</span><span>数量</span><span>金额 sats</span></div>` +
    (D.trades.length ? D.trades.map(t => `<div class="row" title="吃单 ${esc(npub(t.taker))}${t.maker ? '\n挂单 ' + esc(npub(t.maker)) : ''}"><span>${fDT.format(new Date(t.t))}</span><span class="${t.side === 'buy' ? 'up' : 'dn'}">${t.side === 'buy' ? '买入' : '卖出'}</span><span>${price(t.p)}</span><span>${compact(t.v)}</span><span>${compact(t.s)}</span></div>`).join('') : '<div class="loading">暂无成交</div>');
  // 挂单簿
  const b = D.book;
  $('#bookHint').textContent = b ? `${b.orders} 张挂单 · ${D.bookAt ? fT.format(new Date(D.bookAt)) : ''}` : '加载中';
  if (b) {
    const asks = b.asks.slice(0, 40), bids = b.bids.slice(0, 40);
    const mx = Math.max(1, ...asks.map(a => a.vol * a.price), ...bids.map(a => a.vol * a.price));
    const r = (x, c) => `<div class="brow ${c}"><i style="width:${(x.vol * x.price / mx * 100).toFixed(1)}%"></i><span class="${c === 'ask' ? 'dn' : 'up'}">${price(x.price)}</span><span>${compact(x.vol)}</span><span class="mut">${x.n}</span></div>`;
    const hd = `<div class="brow h"><span>价格</span><span>数量</span><span>单数</span></div>`;
    const sp = b.asks[0] && b.bids[0] ? `买一 ${num(b.bids[0].price)} · 卖一 ${num(b.asks[0].price)} · 价差 ${((b.asks[0].price / b.bids[0].price - 1) * 100).toFixed(2)}%` : '';
    $('#book').innerHTML = `<div class="spread">${sp || '单边挂单'}</div><div class="side"><div class="mut" style="font-size:12px;margin-bottom:2px">买单（出价）</div>${hd}${bids.map(x => r(x, 'bid')).join('') || '<div class="loading">无</div>'}</div><div class="side"><div class="mut" style="font-size:12px;margin-bottom:2px">卖单（要价）</div>${hd}${asks.map(x => r(x, 'ask')).join('') || '<div class="loading">无</div>'}</div>`;
  } else $('#book').innerHTML = '<div class="loading">加载中…</div>';
  // 持有人
  const h = D.holders;
  $('#hoHint').textContent = h ? `共 ${num(h.count)} 个地址 · ${D.holdersAt ? fT.format(new Date(D.holdersAt)) : ''}` : '';
  $('#holders').innerHTML = h ? `<div class="row h hrow"><span>#</span><span>地址</span><span>余额</span><span>占比</span><span>市值 (USDT)</span></div>` + h.top.map((x, i) => `<div class="row hrow"><span class="mut">${i + 1}</span><span title="${esc(npub(x.owner))}">${esc(shortKey(x.owner))}${x.traded ? '' : ' <small class="mut">未在市场成交过</small>'}</span><span>${compact(x.bal)}</span><span>${(x.share * 100).toFixed(2)}%</span><span>${usdt(x.bal * s.last)}</span></div>`).join('') : '<div class="loading">加载中…</div>';
  drawChart();
}
async function loadDetail() {
  if (!route.name) return;
  try { D = LNFI.market(route.name); if (D) renderDetail(); }
  catch (e) { console.error(e); }
}

// ===== 主图（自绘 canvas） =====
let hover = null;
function drawChart() {
  const cv = $('#chart'); if (!D || !cv.clientWidth) return;
  const data = D.charts[tf] || [];
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const padL = 8, padR = 64, padT = 10, volH = H * 0.18, padB = 22, ph = H - padT - padB - volH - 6;
  const pts = data.filter(r => r[4] != null);
  if (pts.length < 2) { g.fillStyle = '#7d8a9b'; g.font = '13px sans-serif'; g.fillText('该周期内暂无足够成交', 20, 40); return; }
  // 价格范围：按收盘价分位数，避免极端成交把图压扁
  const cl = pts.map(r => r[4]).sort((a, b) => a - b);
  const q = p => cl[Math.min(cl.length - 1, Math.floor(p * (cl.length - 1)))];
  let lo = ctype === 'candle' ? Math.min(...pts.map(r => r[3])) : q(0), hi = ctype === 'candle' ? Math.max(...pts.map(r => r[2])) : q(1);
  const lo2 = q(0.02), hi2 = q(0.98); if (hi > hi2 * 3) hi = hi2 * 1.5; if (lo < lo2 / 3) lo = lo2 / 1.5;
  const m = (hi - lo) * 0.08 || hi * 0.05 || 1; lo -= m; hi += m; lo = Math.max(0, lo);
  const n = data.length, cw = (W - padL - padR) / n;
  const X = i => padL + (i + 0.5) * cw, Y = p => padT + (1 - (Math.min(hi, Math.max(lo, p)) - lo) / (hi - lo)) * ph;
  // 网格 + 价格刻度
  g.strokeStyle = '#1b2430'; g.fillStyle = '#7d8a9b'; g.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono'); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const p = lo + (hi - lo) * i / 4, y = Y(p); g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillText(num(p), W - padR + 6, y + 4); }
  // 时间刻度
  const step = Math.ceil(n / Math.max(2, Math.floor((W - padR) / 90)));
  for (let i = 0; i < n; i += step) { const t = new Date(data[i][0]); g.fillText(tf === 'd1' ? fD.format(t).slice(5) : fDT.format(t), X(i) - 26, H - 6); }
  // 成交量柱
  const vmax = Math.max(1, ...data.map(r => r[5]));
  const vb = H - padB;
  data.forEach((r, i) => { if (!r[5]) return; const h = r[5] / vmax * volH; g.fillStyle = r[4] >= r[1] ? 'rgba(34,211,166,.35)' : 'rgba(255,93,115,.35)'; g.fillRect(X(i) - Math.max(1, cw * 0.35), vb - h, Math.max(2, cw * 0.7), h); });
  if (ctype === 'candle') {
    data.forEach((r, i) => { if (r[4] == null) return; const up = r[4] >= r[1]; const c = r[6] ? (up ? '#22d3a6' : '#ff5d73') : '#3a4656'; g.strokeStyle = c; g.fillStyle = c;
      g.beginPath(); g.moveTo(X(i), Y(r[2])); g.lineTo(X(i), Y(r[3])); g.stroke();
      const y1 = Y(Math.max(r[1], r[4])), y2 = Y(Math.min(r[1], r[4])); g.fillRect(X(i) - Math.max(1, cw * 0.32), y1, Math.max(2, cw * 0.64), Math.max(1, y2 - y1)); });
  } else {
    const col = pts[pts.length - 1][4] >= pts[0][4] ? '#22d3a6' : '#ff5d73';
    g.beginPath(); let st = false; data.forEach((r, i) => { if (r[4] == null) return; const x = X(i), y = Y(r[4]); st ? g.lineTo(x, y) : (g.moveTo(x, y), st = true); });
    g.strokeStyle = col; g.lineWidth = 1.6; g.stroke();
    g.lineTo(X(n - 1), padT + ph); g.lineTo(X(data.findIndex(r => r[4] != null)), padT + ph); g.closePath();
    const gr = g.createLinearGradient(0, padT, 0, padT + ph); gr.addColorStop(0, col + '30'); gr.addColorStop(1, col + '00'); g.fillStyle = gr; g.fill();
    // 超出刻度的极端成交，在边缘标一下
    data.forEach((r, i) => { if (!r[6]) return; if (r[2] > hi) { g.fillStyle = '#f7b23b'; g.fillRect(X(i) - 1.5, padT, 3, 3); } if (r[3] < lo) { g.fillStyle = '#f7b23b'; g.fillRect(X(i) - 1.5, padT + ph - 3, 3, 3); } });
  }
  // 最新价标签
  const lp = pts[pts.length - 1][4]; const ly = Y(lp);
  g.setLineDash([3, 3]); g.strokeStyle = '#f7b23b88'; g.beginPath(); g.moveTo(padL, ly); g.lineTo(W - padR, ly); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#f7b23b'; g.fillRect(W - padR + 2, ly - 9, padR - 4, 18); g.fillStyle = '#0b0f14'; g.fillText(num(lp), W - padR + 6, ly + 4);
  // 十字光标
  if (hover != null && data[hover]) {
    const r = data[hover], x = X(hover);
    g.strokeStyle = '#ffffff33'; g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - padB); g.stroke();
    const tip = $('#tip'); tip.hidden = false;
    tip.innerHTML = `${tf === 'd1' ? fD.format(new Date(r[0])) : fDT.format(new Date(r[0]))}<br>开 ${num(r[1])} 高 ${num(r[2])}<br>低 ${num(r[3])} 收 <b>${num(r[4])} sats</b><br><span class="mut">USDT 收 ${usdP(r[4])} · 高 ${usdP(r[2])} · 低 ${usdP(r[3])}</span><br>成交 ${compact(r[5])} sats · ${r[6]} 笔`;
    tip.style.left = Math.min(W - tip.offsetWidth - 4, x + 12) + 'px'; tip.style.top = '8px';
  } else $('#tip').hidden = true;
  cv._map = { padL, cw, n };
}
function chartHover(e) {
  const cv = $('#chart'), mp = cv._map; if (!mp) return;
  const rect = cv.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const i = Math.floor((x - mp.padL) / mp.cw); hover = i >= 0 && i < mp.n ? i : null; drawChart();
}

// ===== 路由 / 事件 =====
function go() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  route = { name: h || null };
  $('#home').hidden = !!route.name; $('#detail').hidden = !route.name;
  if (route.name) { D = null; LNFI.ensureDetail(route.name); $('#trades').innerHTML = $('#book').innerHTML = $('#holders').innerHTML = '<div class="loading">加载中…</div>'; $('#dStats').innerHTML = ''; $('#dName').textContent = route.name; loadDetail(); window.scrollTo(0, 0); }
  else { document.title = 'Lnfi 看盘 · RGB / Taproot'; renderHome(); }
}
function seg(id, cb) { const el = $(id); el.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.v); }); }
seg('#protoFilter', v => { proto = v; renderHome(); });
seg('#unitSel', v => { unit = v; localStorage.setItem('unit', v); route.name ? renderDetail() : renderHome(); });
document.querySelectorAll('#unitSel button').forEach(b => b.classList.toggle('on', b.dataset.v === unit));
seg('#tfSel', v => { tf = v; hover = null; drawChart(); });
seg('#ctSel', v => { ctype = v; drawChart(); });
$('#mt thead').addEventListener('click', e => { const th = e.target.closest('th'); if (!th || !th.dataset.k) return; if (sortK === th.dataset.k) sortAsc = !sortAsc; else { sortK = th.dataset.k; sortAsc = th.dataset.k === 'name'; } localStorage.setItem('sortK', sortK); renderHome(); });
document.addEventListener('click', e => { const r = e.target.closest('[data-n]'); if (r && !route.name) location.hash = '#/' + encodeURIComponent(r.dataset.n); });
$('#back').onclick = () => { location.hash = ''; };
$('#chart').addEventListener('mousemove', chartHover); $('#chart').addEventListener('touchmove', chartHover, { passive: true });
$('#chart').addEventListener('mouseleave', () => { hover = null; drawChart(); });
addEventListener('resize', () => route.name ? drawChart() : renderHome());
addEventListener('hashchange', go);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadHome(); loadDetail(); } });

// 数据有变化就重画（引擎内部已节流）；另每 15 秒刷新“几分钟前”
let rT = 0;
LNFI.onUpdate(() => { renderHoldings(); const now = Date.now(); if (now - rT < 1000) return; rT = now; loadHome(); loadDetail(); });
setInterval(() => { if (document.hidden) return; renderHoldings(); loadHome(); loadDetail(); }, 15e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadHome(); loadDetail(); } });
renderHoldings(); go(); loadHome(); LNFI.start();
