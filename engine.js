'use strict';
// 策略引擎：從桌面版 TwStockSim.ps1 移植，規則一致。
// 資料格式：每天 { date, index, q: {code: [open, high, low, close, volume, pe]}, trust: {code: 投信買賣超} | null }

const GROUPS = ['Core', 'Value', 'Pead'];
const GROUP_LABEL = { Core: '核心組', Value: '價值組', Pead: 'PEAD 組' };

const DEFAULT_CFG = {
  coreCap: 20, coreMaxBuy: 5, coreTopPct: 0.08, topIndustries: 10,
  rotCap: { '偏多': 30, '方向不明': 15, '偏空': 4 },
  atrMult: 2, minPrice: 10, minVol20: 500000, peadMinYoY: 20,
  fee: 0.001425, tax: 0.003, slip: 0.0005, minFee: 20, acctSlots: 30,
  capital: 1000000, exitDays: 1,
};

function num(s) {
  if (s === undefined || s === null) return null;
  s = String(s).replace(/,/g, '').trim();
  if (s === '' || s === '--') return null;
  const v = Number(s);
  return isFinite(v) ? v : null;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y), n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function pctRank(obj) {
  const e = Object.entries(obj).sort((a, b) => a[1] - b[1]), n = e.length, r = {};
  e.forEach(([k], i) => { r[k] = n > 1 ? i / (n - 1) : 1; });
  return r;
}

// 與桌面版相同的 CSV 格式：第一行 #INDEX,指數；第二行標題；之後 Code,Name,Open,High,Low,Close,Volume,PE,Trust
function parseDayCsv(date, text, names) {
  const lines = text.split(/\r?\n/);
  const index = parseFloat(lines[0].split(',')[1]);
  const q = Object.create(null);
  let trust = null;
  for (let i = 2; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const p = ln.split(',');
    if (p.length < 9) continue;
    names[p[0]] = p[1];
    q[p[0]] = [+p[2], +p[3], +p[4], +p[5], +p[6], +p[7]];
    if (p[8] !== '') { if (!trust) trust = Object.create(null); trust[p[0]] = +p[8]; }
  }
  return { date, index, q, trust };
}

function parseFundCsv(text) {
  const lines = text.split(/\r?\n/);
  const date = lines[0].split(',')[1];
  const map = Object.create(null);
  for (let i = 2; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 7) continue;
    map[p[0]] = { industry: p[1], revYoY: num(p[2]), cumYoY: num(p[3]), revMonth: p[4], bvps: num(p[5]), div: num(p[6]) };
  }
  return { date, map };
}

// 每股配股小於這個值視為沒有配股（參考價四捨五入到 0.01 造成的誤差；真的配股至少每千股 1 股）
const STOCK_DIV_MIN = 0.0005;

// 二代健保補充保費：單次股利 2 萬元以上扣 2.11%；匯費每次 10 元
function dividendNet(gross) {
  if (gross <= 0) return { gross: 0, nhi: 0, remit: 0, net: 0 };
  const nhi = gross >= 20000 ? Math.round(gross * 0.0211) : 0, remit = 10;
  return { gross, nhi, remit, net: Math.max(0, gross - nhi - remit) };
}

// 從 startIdx 開始逐日跑紙上交易與 100 萬模擬帳戶。fundAt(date) 回傳當天可用的基本面快照。
// divs：{ 除權息日: { code: { prev, ref, cash, stock } } }，prev/ref 是除權息前收盤與參考價，cash 每股現金股利，stock 每股配股。
function runStrategy(days, fundAt, startIdx, cfgIn, names, divs) {
  const cfg = Object.assign({}, DEFAULT_CFG, cfgIn || {});
  const G = {};
  for (const k of GROUPS) {
    G[k] = { key: k, w: k === 'Core' ? 1 / cfg.coreCap : 1 / 30, navG: 1, navN: 1, pos: [], pendBuy: [], pendSell: [], closed: [], closedN: 0, closedSum: 0 };
  }
  const acct = { cash: cfg.capital, fees: 0, divs: 0, hold: [], trades: [] };
  const perf = [], log = [];
  let fund = {}, cache = new Map();
  const nm = c => (names && names[c]) || c;

  // 除權息事件：還原係數 f = 參考價 / 除權息前收盤（< 1）。事件日之前的價格乘上 f 就是「還原權息」價格，
  // 指標都用還原價計算，避免除息缺口被誤判成跌破均線或停損
  const ev = Object.create(null), evDay = [];
  days.forEach((d, i) => {
    const m = divs && divs[d.date];
    evDay[i] = m || null;
    if (m) for (const c in m) if (m[c].prev > 0 && m[c].ref > 0) (ev[c] || (ev[c] = [])).push({ i, f: m[c].ref / m[c].prev });
  });
  const adjF = (c, i, t) => {
    const E = ev[c];
    if (!E) return 1;
    let f = 1;
    for (const e of E) if (e.i > i && e.i <= t) f *= e.f;
    return f;
  };
  const evOn = (t, c) => { const m = evDay[t]; return m && m[c] && m[c].prev > 0 && m[c].ref > 0 ? m[c] : null; };

  const Q = (t, c) => (t < 0 ? null : days[t].q[c] || null);
  const cl = (t, c) => { const q = Q(t, c); return q ? q[3] : null; };
  function ma(t, c, n) {
    const key = t + '|' + c + '|' + n;
    if (cache.has(key)) return cache.get(key);
    let res = null;
    if (t - n + 1 >= 0) {
      let s = 0, k = 0;
      for (let i = t - n + 1; i <= t; i++) { const q = days[i].q[c]; if (q) { s += q[3] * adjF(c, i, t); k++; } }
      if (k >= Math.ceil(n * 0.8)) res = s / k;
    }
    cache.set(key, res);
    return res;
  }
  function avgVol(t, c, n) {
    let s = 0, k = 0;
    for (let i = Math.max(0, t - n + 1); i <= t; i++) { const q = days[i].q[c]; if (q) { s += q[4]; k++; } }
    return k < Math.ceil(n * 0.8) ? null : s / k;
  }
  function atr(t, c) {
    let s = 0, k = 0;
    for (let i = Math.max(1, t - 13); i <= t; i++) {
      const q = days[i].q[c], p = days[i - 1].q[c];
      if (q && p) {
        const fq = adjF(c, i, t), pc = p[3] * adjF(c, i - 1, t);
        s += Math.max((q[1] - q[2]) * fq, Math.abs(q[1] * fq - pc), Math.abs(q[2] * fq - pc)); k++;
      }
    }
    return k ? s / k : null;
  }
  const ret = (t, c, n) => { const a = cl(t, c), b = cl(t - n, c); return a && b ? a / (b * adjF(c, t - n, t)) - 1 : null; };
  function idxMA(t, n) {
    if (t - n + 1 < 0) return null;
    let s = 0;
    for (let i = t - n + 1; i <= t; i++) s += days[i].index;
    return s / n;
  }
  function ind(c) {
    const f = fund[c];
    if (f && f.industry) return f.industry;
    return c.startsWith('00') ? 'ETF' : null;
  }
  function regime(t) {
    const ix = days[t].index, m20 = idxMA(t, 20), m60 = idxMA(t, 60);
    if (m60 == null || !ix) return { name: '資料不足', index: ix, ma20: m20, ma60: m60 };
    let n = '方向不明';
    if (ix > m20 && ix > m60) n = '偏多'; else if (ix < m20 && ix < m60) n = '偏空';
    return { name: n, index: ix, ma20: m20, ma60: m60 };
  }
  // 類股 RS：產業成分股近 60 日報酬中位數 - 大盤近 60 日報酬
  function industryRS(t) {
    const n = Math.min(60, t);
    if (n < 5) return [];
    const ixr = days[t].index / days[t - n].index - 1, acc = {};
    for (const c in days[t].q) {
      const i = ind(c); if (!i) continue;
      const r = ret(t, c, n); if (r == null) continue;
      (acc[i] || (acc[i] = [])).push(r);
    }
    const out = [];
    for (const k in acc) if (acc[k].length >= 3) out.push({ ind: k, rs: median(acc[k]) - ixr });
    return out.sort((a, b) => b.rs - a.rs);
  }
  function universe(t) {
    const out = [], q = days[t].q;
    for (const c in q) {
      if (c.startsWith('00')) continue;
      const f = fund[c]; if (!f || !f.industry) continue;
      if (q[c][3] < cfg.minPrice) continue;
      const v = avgVol(t, c, 20); if (v == null || v < cfg.minVol20) continue;
      out.push(c);
    }
    return out;
  }

  // 核心組：累計營收年增 75% + 單月營收年增 25% 評分前 8%、強勢產業、股價 > 20MA > 60MA
  function coreList(t, uni, topInd) {
    const g = {}, m = {};
    for (const c of uni) { const f = fund[c]; if (f.cumYoY != null && f.revYoY != null) { g[c] = f.cumYoY; m[c] = f.revYoY; } }
    if (Object.keys(g).length < 5) return [];
    const pg = pctRank(g), pm = pctRank(m), score = {};
    for (const c in g) score[c] = 0.75 * pg[c] + 0.25 * pm[c];
    const rank = pctRank(score), res = [];
    for (const c in score) {
      if (rank[c] < 1 - cfg.coreTopPct) continue;
      if (!topInd.includes(ind(c))) continue;
      const p = cl(t, c), m20 = ma(t, c, 20), m60 = ma(t, c, 60);
      if (m20 == null || m60 == null || !(p > m20 && m20 > m60)) continue;
      const top = Math.max(1, Math.round((1 - rank[c]) * 100));
      res.push({ code: c, score: score[c], why: `評分前 ${top}%，${ind(c)}，站上 20/60 日線` });
    }
    return res.sort((a, b) => b.score - a.score);
  }
  // 價值組：同產業內本益比低、股價淨值比低、殖利率高
  function valueList(t, uni) {
    const byInd = {};
    for (const c of uni) {
      const f = fund[c], q = Q(t, c), pe = q[5];
      if (pe <= 0 || pe > 40 || !f.bvps || f.bvps <= 0) continue;
      const dy = f.div ? f.div / q[3] : 0;
      (byInd[f.industry] || (byInd[f.industry] = {}))[c] = { pe, pb: q[3] / f.bvps, dy };
    }
    const res = [];
    for (const i in byInd) {
      const h = byInd[i], codes = Object.keys(h);
      if (codes.length < 3) continue;
      const pe = {}, pb = {}, dy = {};
      for (const c of codes) { pe[c] = h[c].pe; pb[c] = h[c].pb; dy[c] = h[c].dy; }
      const rpe = pctRank(pe), rpb = pctRank(pb), rdy = pctRank(dy);
      for (const c of codes) {
        res.push({ code: c, score: ((1 - rpe[c]) + (1 - rpb[c]) + rdy[c]) / 3,
          why: `本益比 ${h[c].pe.toFixed(1)}、淨值比 ${h[c].pb.toFixed(2)}、殖利率 ${(h[c].dy * 100).toFixed(1)}%` });
      }
    }
    return res.sort((a, b) => b.score - a.score);
  }
  // PEAD 組：月營收年增 >= 20%，且公布後股價還在漲
  function peadList(t, uni) {
    const res = [];
    for (const c of uni) {
      const f = fund[c];
      if (f.revYoY == null || f.revYoY < cfg.peadMinYoY || f.cumYoY == null || f.cumYoY <= 0) continue;
      const m20 = ma(t, c, 20), r10 = ret(t, c, 10);
      if (m20 == null || r10 == null || cl(t, c) <= m20 || r10 <= 0) continue;
      res.push({ code: c, score: f.revYoY, why: `月營收年增 ${f.revYoY.toFixed(1)}%，公布後 10 日 ${fmtPct(r10)}` });
    }
    return res.sort((a, b) => b.score - a.score);
  }
  function shortRefs(t, uni, rs) {
    const weak = rs.slice(-3).map(x => x.ind), res = [];
    for (const c of uni) {
      if (!weak.includes(ind(c))) continue;
      const p = cl(t, c), m20 = ma(t, c, 20), m60 = ma(t, c, 60), r20 = ret(t, c, 20);
      if (m20 == null || m60 == null || r20 == null || !(p < m20 && m20 < m60)) continue;
      res.push({ code: c, r20, close: p, why: `${ind(c)}（弱勢產業），跌破 20/60 日線` });
    }
    return res.sort((a, b) => a.r20 - b.r20).slice(0, 5);
  }

  // 紙上持股的含息報酬：mult 是除權息後「股利再投入」的累積倍數
  const posRet = (p, price) => (price ? price * p.mult / p.entryPrice - 1 : null);
  function addSell(g, p, why, price) {
    if (g.pendSell.some(s => s.code === p.code)) return;
    g.pendSell.push({ code: p.code, why, ret: posRet(p, price), entryPrice: p.entryPrice, close: price });
  }
  function addBuy(g, t, code, why) {
    g.pendBuy.push({ code, atr: atr(t, code), why, close: cl(t, code) });
  }
  const tradeFee = (amt, odd) => (amt <= 0 ? 0 : Math.max(odd ? 1 : cfg.minFee, Math.floor(amt * cfg.fee)));

  // 模擬帳戶：昨天的決定今天成交；整張用開盤價、零股用收盤價 ±0.1%
  function execAccount(t) {
    const date = days[t].date;
    // 除權息日：前一天收盤還持有的股票領股利（實際發放約一個月後，這裡簡化成除息日入帳）
    for (const h of acct.hold) {
      const e = evOn(t, h.code);
      if (!e) continue;
      const d = dividendNet(Math.floor(h.shares * e.cash)), add = Math.floor(h.shares * e.stock);
      if (!d.net && !add) continue;
      acct.cash += d.net; acct.divs += d.net; h.shares += add;
      acct.trades.push({ date, group: h.group, code: h.code, name: nm(h.code), side: '股利', shares: add, price: e.cash,
        amount: d.gross, fee: d.nhi + d.remit, tax: 0, pnl: null,
        why: `現金股利每股 ${e.cash.toFixed(2)} 元` + (add ? `、配股 ${add} 股` : '') + (d.nhi ? `（已扣二代健保 ${d.nhi}）` : '') });
    }
    for (const gk of GROUPS) {
      for (const s of G[gk].pendSell) {
        const key = gk + '|' + s.code, h = acct.hold.find(x => x.key === key), q = Q(t, s.code);
        if (!h || !q || q[0] <= 0) continue;
        const whole = Math.floor(h.shares / 1000) * 1000, odd = h.shares - whole;
        const a1 = whole * q[0], a2 = odd * q[3] * 0.999;
        const fee = tradeFee(a1, false) + tradeFee(a2, true), tax = Math.floor(a1 * cfg.tax) + Math.floor(a2 * cfg.tax);
        acct.cash += a1 + a2 - fee - tax; acct.fees += fee + tax;
        acct.hold.splice(acct.hold.indexOf(h), 1);
        acct.trades.push({ date, group: gk, code: s.code, name: nm(s.code), side: '賣出', shares: h.shares, price: (a1 + a2) / h.shares,
          amount: a1 + a2, fee, tax, pnl: a1 + a2 - fee - tax - h.cost, why: s.why });
      }
    }
    const budget = cfg.capital / cfg.acctSlots;
    for (const gk of GROUPS) {
      for (const b of G[gk].pendBuy) {
        const q = Q(t, b.code);
        if (!q || q[0] <= 0) continue;
        const lots = Math.floor(budget / (q[0] * 1000)), a1 = lots * 1000 * q[0];
        const oddPx = q[3] * 1.001, odd = Math.floor((budget - a1) / oddPx), a2 = odd * oddPx;
        const shares = lots * 1000 + odd;
        if (shares <= 0) continue;
        const fee = tradeFee(a1, false) + tradeFee(a2, true);
        if (a1 + a2 + fee > acct.cash) continue;   // 錢不夠就買不起
        acct.cash -= a1 + a2 + fee; acct.fees += fee;
        acct.hold.push({ key: gk + '|' + b.code, group: gk, code: b.code, shares, cost: a1 + a2 + fee, last: q[3], date });
        acct.trades.push({ date, group: gk, code: b.code, name: nm(b.code), side: '買進', shares, price: (a1 + a2) / shares,
          amount: a1 + a2, fee, tax: 0, pnl: null, why: b.why });
      }
    }
  }
  function acctValue(t) {
    let stock = 0;
    for (const h of acct.hold) { const c = cl(t, h.code); if (c) h.last = c; stock += h.shares * h.last; }
    return { cash: acct.cash, stock, total: acct.cash + stock };
  }

  // 紙上組合：每檔固定權重，開盤價成交；淨值分扣成本前/後
  function execGroup(g, t) {
    const date = days[t].date, w = g.w;
    let r = 0, cost = 0;
    const carry = [];
    // 除權息日：前一天收盤持有的部位（含今天開盤要賣的）領股利；報酬用還原價計算，停損價跟著還原
    for (const p of g.pos) {
      const e = evOn(t, p.code);
      if (e) { p.exF = e.ref / e.prev; p.mult /= p.exF; p.stop = Math.round(p.stop * p.exF * 100) / 100; } else p.exF = 1;
    }
    for (const s of g.pendSell) {
      const p = g.pos.find(x => x.code === s.code);
      if (!p) continue;
      const q = Q(t, s.code);
      if (!q || q[0] <= 0) { carry.push(s); continue; }   // 沒成交就明天再賣
      const pc = cl(t - 1, s.code);
      if (pc) r += w * (q[0] / (pc * p.exF) - 1);
      cost += w * (cfg.fee + cfg.tax + cfg.slip);
      const rr = posRet(p, q[0]);
      g.closed.push({ code: p.code, entryDate: p.entryDate, entryPrice: p.entryPrice, exitDate: date, exitPrice: q[0], ret: rr, why: s.why });
      if (g.closed.length > 200) g.closed.shift();
      g.closedN++; g.closedSum += rr;
      g.pos.splice(g.pos.indexOf(p), 1);
    }
    for (const p of g.pos) {
      const c1 = cl(t, p.code), c0 = cl(t - 1, p.code);
      if (c1 && c0) r += w * (c1 / (c0 * p.exF) - 1);
      if (c1) p.last = c1;
    }
    for (const b of g.pendBuy) {
      const q = Q(t, b.code);
      if (!q || q[0] <= 0) continue;
      const a = b.atr || q[0] * 0.05;
      g.pos.push({ code: b.code, entryDate: date, entryPrice: q[0], stop: Math.round((q[0] - cfg.atrMult * a) * 100) / 100, last: q[3], below: 0, mult: 1, exF: 1 });
      r += w * (q[3] / q[0] - 1); cost += w * (cfg.fee + cfg.slip);
    }
    g.pendSell = carry; g.pendBuy = [];
    g.navG *= 1 + r; g.navN *= 1 + r - cost;
  }

  function rotation(g, t, list, cap) {
    for (const p of g.pos) { const c = cl(t, p.code); if (c != null && c <= p.stop) addSell(g, p, '跌到停損價', c); }
    if (cap == null) return;
    const inList = {};
    list.forEach((x, i) => { inList[x.code] = i; });
    // 排名掉到上限 2 倍以外才算跌出名單（緩衝帶，避免在名單邊緣來回買賣）
    const keep = [];
    for (const p of g.pos) {
      const c = cl(t, p.code) ?? p.last;
      if (!(p.code in inList) || inList[p.code] >= 2 * cap) addSell(g, p, '跌出名單', c);
      else if (!g.pendSell.some(s => s.code === p.code)) keep.push(p);
    }
    // 持股超過上限（例如大盤轉弱、上限縮小）就賣掉排名最差的
    const extra = keep.length - cap;
    if (extra > 0) {
      keep.sort((a, b) => inList[b.code] - inList[a.code]).slice(0, extra)
        .forEach(p => addSell(g, p, '減碼（名額縮減）', cl(t, p.code) ?? p.last));
    }
    let remain = g.pos.length - g.pendSell.length;
    const held = new Set(g.pos.map(p => p.code));
    for (const x of list.slice(0, cap)) {
      if (remain >= cap) break;
      if (held.has(x.code)) continue;
      addBuy(g, t, x.code, x.why); remain++;
    }
  }

  // 處理一個交易日：先成交昨天的單 → 算指標 → 產生明天的單
  function runDay(t) {
    cache = new Map();
    fund = fundAt(days[t].date) || {};
    const D = days[t];
    execAccount(t);
    for (const k of GROUPS) execGroup(G[k], t);

    const reg = regime(t), rs = industryRS(t);
    const top = rs.slice(0, cfg.topIndustries).map(x => x.ind);
    const uni = universe(t);

    const core = G.Core, prev = days[t - 1];
    for (const p of core.pos) {
      const c = cl(t, p.code);
      if (c == null) continue;
      const m20 = ma(t, p.code, 20);
      p.below = m20 != null && c < m20 ? p.below + 1 : 0;
      if (c <= p.stop) addSell(core, p, '跌到停損價', c);
      else if (p.below >= cfg.exitDays) addSell(core, p, '跌破 20 日線', c);
      else if (D.trust && prev && prev.trust && D.trust[p.code] < 0 && prev.trust[p.code] < 0) addSell(core, p, '投信連賣 2 天', c);
    }
    let coreMax = 0;
    if (reg.name === '偏多' || reg.name === '方向不明') {
      coreMax = Math.min(cfg.coreMaxBuy, Math.max(0, cfg.coreCap - (core.pos.length - core.pendSell.length)));
      const held = new Set(core.pos.map(p => p.code));
      for (const x of coreList(t, uni, top)) {
        if (core.pendBuy.length >= coreMax) break;
        if (held.has(x.code)) continue;
        addBuy(core, t, x.code, x.why);
      }
    }
    const cap = reg.name === '資料不足' ? null : cfg.rotCap[reg.name];
    rotation(G.Value, t, valueList(t, uni), cap);
    rotation(G.Pead, t, peadList(t, uni), cap);
    const shorts = reg.name === '偏空' ? shortRefs(t, uni, rs) : [];

    const av = acctValue(t);
    const comb = GROUPS.reduce((s, k) => s + G[k].navN, 0) / GROUPS.length;
    perf.push({ date: D.date, index: D.index, regime: reg.name, comb, acct: av.total,
      Core: G.Core.navN, CoreG: G.Core.navG, Value: G.Value.navN, ValueG: G.Value.navG, Pead: G.Pead.navN, PeadG: G.Pead.navG });
    const buys = [], sells = [];
    for (const k of GROUPS) {
      for (const b of G[k].pendBuy) buys.push({ g: k, code: b.code, why: b.why, close: b.close, stop: b.atr ? b.close - cfg.atrMult * b.atr : null });
      for (const s of G[k].pendSell) sells.push({ g: k, code: s.code, why: s.why, ret: s.ret, entryPrice: s.entryPrice, close: s.close });
    }
    log.push({ date: D.date, regime: reg.name, index: D.index, buys, sells });
    return { t, date: D.date, reg, rs, shorts, cap, coreMax, acct: av, buys, sells };
  }

  let last = null;
  for (let t = startIdx; t < days.length; t++) last = runDay(t);
  return { cfg, G, acct, perf, log, last, posRet };
}

function perfSummary(perf) {
  if (!perf.length) return null;
  const first = perf[0], last = perf[perf.length - 1];
  let peak = 0, mdd = 0, apeak = 0, amdd = 0;
  for (const x of perf) {
    peak = Math.max(peak, x.comb); mdd = Math.max(mdd, 1 - x.comb / peak);
    apeak = Math.max(apeak, x.acct); amdd = Math.max(amdd, 1 - x.acct / apeak);
  }
  return { start: first.date, end: last.date, n: perf.length, comb: last.comb - 1, idx: last.index / first.index - 1, mdd, acctMdd: amdd,
    Core: last.Core - 1, CoreG: last.CoreG - 1, Value: last.Value - 1, ValueG: last.ValueG - 1, Pead: last.Pead - 1, PeadG: last.PeadG - 1 };
}

function fmtPct(x, d = 2) {
  if (x == null || !isFinite(x)) return '—';
  const v = x * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
}
