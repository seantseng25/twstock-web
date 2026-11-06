'use strict';
// ============================================================ 平台介面
// Android：MainActivity 提供 window.Android（檔案、網路、提醒）。
// 網頁版（iPhone 加到主畫面）：檔案存在 IndexedDB，開機時整包載入記憶體，讀取維持同步呼叫。
// 電腦測試：window.DEV_SEED 提供內建資料，全部在記憶體。
const Native = window.Android || null;
const IS_WEB = !Native && !window.DEV_SEED;

function nativeStore() {
  return {
    ready: Promise.resolve(),
    read: n => Native.readFile(n),
    write: (n, s) => Native.writeFile(n, s),
    del: n => Native.deleteFile(n),
    list: prefix => JSON.parse(Native.listFiles(prefix)),
    asset: p => Native.readAsset(p),
    assets: dir => JSON.parse(Native.listAssets(dir)),
  };
}
function devStore() {
  const mem = window.DEV_FILES || {}, seed = window.DEV_SEED || {};
  return {
    ready: Promise.resolve(),
    read: n => (n in mem ? mem[n] : null),
    write: (n, s) => { mem[n] = s; },
    del: n => { delete mem[n]; },
    list: prefix => Object.keys(mem).filter(k => k.startsWith(prefix)),
    asset: p => (p in seed ? seed[p] : null),
    assets: dir => Object.keys(seed).filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1)),
  };
}
function webStore() {
  const mem = Object.create(null);
  let db = null;
  const ready = new Promise(resolve => {
    let req;
    try { req = indexedDB.open('twstock', 1); } catch (e) { resolve(); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onerror = () => resolve();
    req.onsuccess = () => {
      db = req.result;
      const cur = db.transaction('files').objectStore('files').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { mem[c.key] = c.value; c.continue(); } else resolve(); };
      cur.onerror = () => resolve();
    };
  });
  const put = fn => { if (db) try { fn(db.transaction('files', 'readwrite').objectStore('files')); } catch (e) { /* 存不進去就只留在記憶體 */ } };
  return {
    ready, persisted: () => !!db,
    read: n => (n in mem ? mem[n] : null),
    write: (n, s) => { mem[n] = s; put(st => st.put(s, n)); },
    del: n => { delete mem[n]; put(st => st.delete(n)); },
    list: prefix => Object.keys(mem).filter(k => k.startsWith(prefix)),
    asset: () => null,
    assets: () => [],
  };
}
const Store = Native ? nativeStore() : window.DEV_SEED ? devStore() : webStore();

let httpSeq = 0;
const httpPending = {};
window.__httpCb = (id, ok, text) => {
  const p = httpPending[id];
  delete httpPending[id];
  if (p) (ok ? p.resolve(text) : p.reject(new Error(text)));
};
function httpGet(url) {
  if (Native) {
    return new Promise((resolve, reject) => {
      const id = 'h' + (++httpSeq);
      httpPending[id] = { resolve, reject };
      Native.httpGet(id, url);
    });
  }
  return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ 小工具
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const isWeekend = s => { const w = parseYmd(s).getDay(); return w === 0 || w === 6; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = x => (x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('zh-TW'));
const px = x => (x == null || !isFinite(x) ? '—' : x >= 1000 ? x.toFixed(0) : x.toFixed(2));
const ud = x => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const signMoney = x => (x > 0 ? '+' : x < 0 ? '−' : '') + money(Math.abs(x));
const nm = c => App.names[c] || c;

// ============================================================ 狀態
const App = {
  tab: 'suggest', names: {}, days: [], dates: [], funds: [], sim: null, viewDate: null,
  divs: {}, divList: [], divNext: [],
  settings: null, my: null, busy: false, charts: {}, sheet: null, stmtMonth: 'all',
};
const SETTINGS_DEFAULT = { startDate: null, capital: 1000000, exitDays: 1, reminder: { on: true, h: 17, m: 30 } };
const MY_DEFAULT = { seq: 0, txns: [], plans: [], dismissed: [], fee: { discount: 1, minFee: 20, minFeeOdd: 1, dcaFee: 1 } };

function loadJson(name, def) {
  try { const s = Store.read(name); if (s) return Object.assign(JSON.parse(JSON.stringify(def)), JSON.parse(s)); } catch (e) { /* 壞檔就用預設值 */ }
  return JSON.parse(JSON.stringify(def));
}
const saveSettings = () => Store.write('settings.json', JSON.stringify(App.settings));
const saveMy = () => Store.write('my.json', JSON.stringify(App.my));

// ============================================================ 資料：內建（APK assets/seed）+ 手機下載
function listByPrefix(prefix) {
  const re = new RegExp('^' + prefix + '(\\d{4}-\\d{2}-\\d{2})\\.csv$'), s = new Set();
  for (const f of Store.assets('seed')) { const m = re.exec(f); if (m) s.add(m[1]); }
  for (const f of Store.list(prefix)) { const m = re.exec(f); if (m) s.add(m[1]); }
  return [...s].sort();
}
const readCsv = (prefix, d) => Store.read(prefix + d + '.csv') ?? Store.asset('seed/' + prefix + d + '.csv');

function loadData() {
  App.names = {};
  App.dates = listByPrefix('d_');
  App.days = App.dates.map(d => parseDayCsv(d, readCsv('d_', d), App.names));
  App.funds = listByPrefix('f_').map(d => Object.assign(parseFundCsv(readCsv('f_', d)), { date: d }));
  loadDivs();
  loadOtc();
  try { App.bt = JSON.parse(Store.read('backtest.json') ?? Store.asset('seed/backtest.json') ?? 'null'); } catch (e) { App.bt = null; }
}

// 除權息：div.csv（Date,Code,Prev,Ref,Cash,Stock）＝已發生的；div_next.json＝證交所預告
function loadDivs() {
  App.divs = {}; App.divList = [];
  const text = Store.read('div.csv') ?? Store.asset('seed/div.csv');
  if (text) {
    for (const ln of text.split(/\r?\n/).slice(1)) {
      const p = ln.split(',');
      if (p.length < 6) continue;
      const e = { date: p[0], code: p[1], prev: +p[2], ref: +p[3], cash: +p[4], stock: +p[5] < STOCK_DIV_MIN ? 0 : +p[5] };
      (App.divs[e.date] || (App.divs[e.date] = {}))[e.code] = e;
      App.divList.push(e);
    }
    App.divList.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  try { App.divNext = JSON.parse(Store.read('div_next.json') || '[]'); } catch (e) { App.divNext = []; }
}
const rocDate = s => { const m = /(\d+)年(\d+)月(\d+)日/.exec(String(s)); return m ? `${+m[1] + 1911}-${pad2(+m[2])}-${pad2(+m[3])}` : null; };

// 證交所除權除息計算結果表 → 每股現金股利與配股
function parseExRight(r) {
  const date = rocDate(r[0]), code = String(r[1]).trim(), P = num(r[3]), R = num(r[4]), V = num(r[5]), type = String(r[6]).trim(), X = num(r[10]);
  if (!date || !P || !R) return null;
  // 息：現金股利＝權值+息值；權息：現金股利＝前收盤−減除股利參考價；權：沒有現金股利。其餘差額換算成每股配股
  let cash = 0;
  if (type === '息') cash = V; else if (type === '權息' && X) cash = P - X;
  let stock = (P - cash) / R - 1;
  if (stock < STOCK_DIV_MIN) stock = 0;
  return { date, code, prev: P, ref: R, cash: +cash.toFixed(6), stock: +stock.toFixed(6) };
}

async function syncDividends() {
  const today = ymd(new Date()), first = App.dates[0];
  if (!first) return;
  const have = App.divList, spans = [];
  if (!have.length) spans.push([first, today]);
  else {
    if (first < have[0].date) spans.push([first, addDays(have[0].date, -1)]);
    spans.push([addDays(have[have.length - 1].date, -10), today]);
  }
  const map = {};
  for (const e of have) map[e.date + '|' + e.code] = e;
  for (const [from, to] of spans) {
    for (let s = from; s <= to; s = addDays(s, 365)) {
      const e = addDays(s, 364) < to ? addDays(s, 364) : to;
      setStatus(`下載除權息資料（${s.slice(0, 4)}）…`, 0.9);
      const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${s.replace(/-/g, '')}&endDate=${e.replace(/-/g, '')}&response=json`);
      if (j.stat === 'OK') for (const r of j.data) { const x = parseExRight(r); if (x) map[x.date + '|' + x.code] = x; }
      await sleep(2500);
    }
  }
  const rows = Object.values(map).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.code < b.code ? -1 : 1));
  Store.write('div.csv', ['Date,Code,Prev,Ref,Cash,Stock'].concat(rows.map(e => [e.date, e.code, e.prev, e.ref, e.cash, e.stock].join(','))).join('\n'));
  // 預告表：還沒發生的除權息，「待公告」的現金股利記成 null
  const k = await fetchJson('https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json');
  if (k.stat === 'OK') {
    Store.write('div_next.json', JSON.stringify(k.data.map(r => ({ date: rocDate(r[0]), code: String(r[1]).trim(), cash: num(r[7]), stock: num(r[4]) || 0 }))
      .filter(x => x.date)));
  }
  loadDivs();
}
function fundAt(date) {
  let r = App.funds[0];
  for (const f of App.funds) { if (f.date <= date) r = f; else break; }
  return r ? r.map : {};
}
// 最後一個 <= date 的交易日索引
function idxOnOrBefore(date) {
  let lo = 0, hi = App.dates.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (App.dates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function priceOn(code, date) {
  for (let i = idxOnOrBefore(date); i >= 0; i--) { const q = App.days[i].q[code]; if (q) return { price: q[3], date: App.dates[i] }; }
  return null;
}

function computeSim() {
  const n = App.days.length;
  if (n < 2) { App.sim = null; return; }
  let start = 60;
  if (App.settings.startDate) { const i = App.dates.findIndex(d => d >= App.settings.startDate); if (i >= 0) start = Math.max(60, i); }
  start = Math.min(start, n - 1);
  App.sim = runStrategy(App.days, fundAt, start, { capital: App.settings.capital, exitDays: App.settings.exitDays }, App.names, App.divs);
}

// ---------------------------------------------------------- 下載（臺灣證券交易所）
async function fetchJson(url) { return JSON.parse(await httpGet(url)); }

async function fetchTrust(d) {
  const trust = {};
  const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${d.replace(/-/g, '')}&selectType=ALLBUT0999&response=json`);
  if (j.stat === 'OK') {
    const tc = j.fields.indexOf('證券代號'), tv = j.fields.indexOf('投信買賣超股數');
    for (const row of j.data) { const v = num(row[tv]); if (v != null) trust[String(row[tc]).trim()] = v; }
  }
  return trust;
}

async function saveTwseDay(d, withTrust) {
  const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d.replace(/-/g, '')}&type=ALLBUT0999&response=json`);
  if (j.stat !== 'OK' || !j.tables) return false;
  let idx = null;
  for (const tb of j.tables) {
    if (tb.fields && tb.fields[0] === '指數') for (const row of tb.data) if (row[0] === '發行量加權股價指數') { idx = num(row[1]); break; }
    if (idx) break;
  }
  const qt = j.tables.find(tb => tb.fields && tb.fields.includes('證券代號'));
  if (!qt || !idx) return false;
  const f = qt.fields;
  const iC = f.indexOf('證券代號'), iN = f.indexOf('證券名稱'), iV = f.indexOf('成交股數'), iO = f.indexOf('開盤價'),
    iH = f.indexOf('最高價'), iL = f.indexOf('最低價'), iK = f.indexOf('收盤價'), iP = f.indexOf('本益比');
  let trust = {};
  if (withTrust) { await sleep(2500); trust = await fetchTrust(d); }
  const lines = ['#INDEX,' + idx, 'Code,Name,Open,High,Low,Close,Volume,PE,Trust'];
  for (const row of qt.data) {
    const o = num(row[iO]), c = num(row[iK]);
    if (o == null || c == null) continue;
    const code = String(row[iC]).trim(), name = String(row[iN]).trim().replace(/,/g, ' ');
    lines.push([code, name, o, num(row[iH]), num(row[iL]), c, num(row[iV]), num(row[iP]) ?? 0, trust[code] ?? ''].join(','));
  }
  Store.write('d_' + d + '.csv', lines.join('\n'));
  return true;
}

// 已存的日資料如果當時投信還沒公布（欄位空白），補抓一次
async function repairTrust(d) {
  const text = readCsv('d_', d), lines = text.split(/\r?\n/);
  if (lines.length < 3 || !lines[2].endsWith(',')) return;
  const trust = await fetchTrust(d);
  if (!Object.keys(trust).length) return;
  for (let i = 2; i < lines.length; i++) {
    const code = lines[i].split(',')[0];
    if (lines[i].endsWith(',') && code in trust) lines[i] += trust[code];
  }
  Store.write('d_' + d + '.csv', lines.join('\n'));
}

// 基本面快照：每天檢查一次，營收月份有更新才存新的一份（每月約一份）
async function syncFund(today) {
  if (Store.read('fund_checked.txt') === today) return;
  const rev = await fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap05_L');
  await sleep(1000);
  const val = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL');
  const vd = {};
  for (const v of val) vd[v.Code] = v;
  let vdate = null;
  if (val.length) { const r = String(val[0].Date); vdate = `${+r.slice(0, 3) + 1911}-${r.slice(3, 5)}-${r.slice(5, 7)}`; }
  const di = vdate ? idxOnOrBefore(vdate) : App.days.length - 1, day = App.days[di];
  const lines = ['#DATE,' + today, 'Code,Industry,RevYoY,CumYoY,RevMonth,BVPS,Div'], months = {};
  for (const x of rev) {
    const code = String(x['公司代號']).trim(), ym = String(x['資料年月']);
    const mon = ym.length >= 5 ? `${+ym.slice(0, ym.length - 2) + 1911}-${ym.slice(-2)}` : '';
    months[mon] = (months[mon] || 0) + 1;
    let bvps = '', div = '';
    const v = vd[code], q = day && day.q[code];
    if (v && q) {
      const pb = num(v.PBratio), dy = num(v.DividendYield);
      if (pb && pb > 0) bvps = q[3] / pb;
      if (dy != null) div = q[3] * dy / 100;
    }
    lines.push([code, String(x['產業別']).trim().replace(/,/g, ' '), num(x['營業收入-去年同月增減(%)']) ?? '',
      num(x['累計營業收入-前期比較增減(%)']) ?? '', mon, bvps, div].join(','));
  }
  const mainMonth = Object.entries(months).sort((a, b) => b[1] - a[1])[0]?.[0];
  const latest = App.funds[App.funds.length - 1];
  const latestMonth = latest ? Object.entries(Object.values(latest.map).reduce((a, f) => { a[f.revMonth] = (a[f.revMonth] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1])[0]?.[0] : null;
  if (mainMonth !== latestMonth) Store.write('f_' + today + '.csv', lines.join('\n'));
  Store.write('fund_checked.txt', today);
}

// 網頁版：電腦每天把收盤和基本面上傳到網站的 data/，這裡把手機上還沒有的檔案抓下來
async function mergeServerData() {
  if (!IS_WEB) return 0;
  let idx;
  try { idx = JSON.parse(await httpGet('data/index.json?t=' + Date.now())); } catch (e) { return 0; }
  const missing = (idx.files || []).filter(f => /^[dfo]_\d{4}-\d{2}-\d{2}\.csv$/.test(f) && Store.read(f) == null);
  if ((idx.files || []).includes('div.csv') && Store.read('div.csv') == null) missing.push('div.csv');
  const btVer = String(idx.backtest || '');
  if ((idx.files || []).includes('backtest.json') && Store.read('backtest_ver.txt') !== btVer) missing.push('backtest.json');
  for (let i = 0; i < missing.length; i += 6) {
    setStatus(`從網站同步資料（${i}/${missing.length}）…`, i / missing.length);
    await Promise.all(missing.slice(i, i + 6).map(async f => { Store.write(f, await httpGet('data/' + f)); }));
  }
  if (missing.includes('backtest.json')) Store.write('backtest_ver.txt', btVer);
  return missing.length;
}

// 上櫃收盤（櫃買中心）：只給成交量排行用，保留最近 OTC_DAYS 個交易日。
// Android 直接向櫃買中心下載；網頁版（櫃買中心不開放跨站讀取）靠電腦上傳到網站的 o_ 檔
const OTC_DAYS = 10;
async function syncOtc() {
  const keep = new Set(App.dates.slice(-OTC_DAYS));
  for (const d of keep) {
    if (Store.read('o_' + d + '.csv') != null) continue;
    try {
      const j = JSON.parse(await httpGet(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${d.replace(/-/g, '%2F')}&type=EW&response=json`));
      const t = (j.tables || [])[0], want = `${+d.slice(0, 4) - 1911}/${d.slice(5).replace('-', '/')}`;
      if (!t || t.date !== want || !(t.data || []).length) continue;
      const n = s => { const x = parseFloat(String(s).replace(/,/g, '')); return isFinite(x) ? x : null; };
      const lines = ['#OTC,' + d, 'Code,Name,Close,Prev,Volume,Value'];
      // 欄位：代號、名稱、收盤、漲跌、開盤、最高、最低、成交股數、成交金額…
      for (const r of t.data) {
        const c = n(r[2]), ch = n(r[3]), v = n(r[7]);
        if (!c || v == null) continue;
        lines.push([String(r[0]).trim(), String(r[1]).trim().replace(/,/g, ' '), c, ch != null ? +(c - ch).toFixed(2) : '', v, n(r[8]) ?? ''].join(','));
      }
      Store.write('o_' + d + '.csv', lines.join('\n'));
      await sleep(1500);
    } catch (e) { /* 這天抓不到就算了，下次更新再補 */ }
  }
  for (const f of Store.list('o_')) if (!keep.has(f.slice(2, 12))) Store.del(f);
  loadOtc();
}
function loadOtc() {
  App.otc = {};
  for (const d of App.dates.slice(-OTC_DAYS)) {
    const s = Store.read('o_' + d + '.csv');
    if (!s) continue;
    const m = {};
    for (const ln of s.split(/\r?\n/).slice(2)) {
      const p = ln.split(','); if (p.length < 6) continue;
      m[p[0]] = { name: p[1], close: +p[2], prev: p[3] === '' ? null : +p[3], vol: +p[4], value: p[5] === '' ? null : +p[5] };
    }
    App.otc[d] = m;
  }
}

function lastExpectedTradingDay() {
  const now = new Date();
  let d = ymd(now);
  if (now.getHours() * 60 + now.getMinutes() < 14 * 60 + 30) d = addDays(d, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

async function syncData(opts = {}) {
  if (App.busy) return;
  App.busy = true;
  try {
    const today = ymd(new Date());
    if (IS_WEB && !opts.from) { if (await mergeServerData()) loadData(); }
    const noTrade = new Set(JSON.parse(Store.read('no_trade.json') || '[]'));
    const todo = [];
    let from = opts.from || (App.dates.length ? addDays(App.dates[App.dates.length - 1], 1) : addDays(today, -100));
    const to = opts.to || today;
    for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d) && !noTrade.has(d) && !App.dates.includes(d)) todo.push(d);
    const repair = opts.from ? [] : App.dates.filter(d => d >= addDays(today, -7));
    const total = todo.length + repair.length + 1;
    let k = 0;
    for (const d of repair) { setStatus(`檢查 ${d} 投信資料…`, k++ / total); await repairTrust(d); await sleep(1500); }
    for (const d of todo) {
      setStatus(`下載 ${d} 收盤資料（${k + 1 - repair.length}/${todo.length}）…`, k++ / total);
      const ok = await saveTwseDay(d, d >= addDays(today, -7));
      if (!ok && d < today) noTrade.add(d);
      await sleep(2500);
    }
    Store.write('no_trade.json', JSON.stringify([...noTrade]));
    loadData();
    if (Native) { setStatus('更新上櫃收盤（成交量排行用）…', k / total); await syncOtc(); }
    // 網頁版沒辦法直接讀證交所 openapi（跨網站限制），基本面只靠電腦上傳
    if (Native) {
      setStatus('更新基本面資料…', k / total);
      try { await syncFund(today); loadData(); } catch (e) { toast('基本面更新失敗，沿用舊資料'); }
    }
    try { await syncDividends(); } catch (e) { toast('除權息資料更新失敗，沿用舊資料'); }
    computeSim();
    const ran = runDCA();
    toast(todo.length ? `更新完成，最新資料 ${App.dates[App.dates.length - 1]}` + (ran ? `，定期定額成交 ${ran} 筆` : '') : '已是最新資料');
  } catch (e) {
    toast('更新失敗：' + e.message);
  } finally {
    App.busy = false;
    setStatus(null);
    render();
  }
}

// ============================================================ 我的帳戶
const TXN_LABEL = { DEPOSIT: '入金', WITHDRAW: '出金', BUY: '買進', SELL: '賣出', DCA: '定期定額', DCA_FAIL: '定期定額失敗', DIV: '股利' };

function myFee(amount, shares, dca) {
  const f = App.my.fee;
  const raw = a => Math.floor(a * 0.001425 * f.discount);
  if (dca) return Math.max(f.dcaFee, raw(amount));
  const whole = Math.floor(shares / 1000) * 1000, odd = shares - whole, unit = amount / shares;
  let fee = 0;
  if (whole) fee += Math.max(f.minFee, raw(whole * unit));
  if (odd) fee += Math.max(f.minFeeOdd, raw(odd * unit));
  return fee;
}
const myTax = (amount, code) => Math.floor(amount * (code.startsWith('00') ? 0.001 : 0.003));

const sortTxns = txns => txns.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

// 依序重播所有交易，算出現金、持股（平均成本法）、已實現損益；錯誤（現金或持股變負）丟例外
function replay(txns) {
  const st = { cash: 0, net: 0, hold: {}, realized: 0, fees: 0, taxes: 0, divIncome: 0, lastPx: {}, rows: [] };
  for (const t of sortTxns(txns)) {
    const h = t.code ? (st.hold[t.code] || (st.hold[t.code] = { shares: 0, cost: 0 })) : null;
    let pnl = null;
    if (t.type === 'DEPOSIT') { st.cash += t.amount; st.net += t.amount; }
    else if (t.type === 'WITHDRAW') { st.cash -= t.amount; st.net -= t.amount; }
    else if (t.type === 'DIV') {
      // 現金股利扣掉二代健保和匯費入帳；配股增加股數、總成本不變（平均成本下降）
      st.cash += t.amount - t.fee; st.divIncome += t.amount - t.fee; h.shares += t.shares || 0;
    }
    else if (t.type === 'BUY' || t.type === 'DCA') {
      st.cash -= t.amount + t.fee; h.shares += t.shares; h.cost += t.amount + t.fee; st.fees += t.fee; st.lastPx[t.code] = t.price;
    } else if (t.type === 'SELL') {
      if (t.shares > h.shares) throw new Error(`${t.date} 賣出 ${nm(t.code)} ${t.shares} 股，但當時只持有 ${h.shares} 股`);
      const avg = h.cost / h.shares, proceeds = t.amount - t.fee - t.tax;
      pnl = proceeds - avg * t.shares;
      st.realized += pnl; st.cash += proceeds; h.cost -= avg * t.shares; h.shares -= t.shares;
      st.fees += t.fee; st.taxes += t.tax; st.lastPx[t.code] = t.price;
    }
    if (st.cash < -0.5) throw new Error(`${t.date} 現金會變成負的（${money(st.cash)}），請先入金`);
    if (h && h.shares === 0) delete st.hold[t.code];
    st.rows.push({ t, cash: st.cash, pnl });
  }
  return st;
}

function myState() {
  let st;
  try { st = replay(App.my.txns); } catch (e) { st = { cash: 0, net: 0, hold: {}, realized: 0, fees: 0, taxes: 0, divIncome: 0, lastPx: {}, rows: [], error: e.message }; }
  const lastDate = App.dates[App.dates.length - 1];
  let mv = 0, mvPrev = 0, cost = 0;
  const list = [];
  for (const code in st.hold) {
    const h = st.hold[code];
    const p = lastDate && priceOn(code, lastDate);
    const price = p ? p.price : st.lastPx[code];
    const i = App.dates.length - 2, prevQ = i >= 0 ? App.days[i].q[code] : null;
    const value = h.shares * price;
    mv += value; cost += h.cost; mvPrev += h.shares * (prevQ ? prevQ[3] : price);
    list.push({ code, shares: h.shares, avg: h.cost / h.shares, cost: h.cost, price, value, pnl: value - h.cost });
  }
  list.sort((a, b) => b.value - a.value);
  const total = st.cash + mv;
  return Object.assign(st, { mv, total, list, unrealized: mv - cost, pnl: total - st.net, dayChg: mv - mvPrev });
}

function addTxn(t) {
  t.id = ++App.my.seq;
  const next = App.my.txns.concat([t]);
  replay(next);   // 驗證，失敗會丟出錯誤訊息
  App.my.txns = next;
  saveMy();
}

// 每個扣款日找第一個 >= 該日的交易日，用當天收盤價成交
function runDCA() {
  const last = App.dates[App.dates.length - 1];
  if (!last) return 0;
  let count = 0;
  for (const p of App.my.plans) {
    if (!p.active) continue;
    const exec = new Set();
    let y = +p.start.slice(0, 4), m = +p.start.slice(5, 7);
    const ly = +last.slice(0, 4), lm = +last.slice(5, 7);
    while (y < ly || (y === ly && m <= lm)) {
      for (const dom of p.days) {
        const target = `${y}-${pad2(m)}-${pad2(Math.min(dom, 28))}`;
        let i = idxOnOrBefore(addDays(target, -1)) + 1;
        if (i < App.dates.length) {
          const ex = App.dates[i];
          if (ex >= p.start && ex <= last && ex <= addDays(target, 10)) exec.add(ex);
        }
      }
      if (++m > 12) { m = 1; y++; }
    }
    for (const ex of [...exec].sort()) {
      if (p.lastRun && ex <= p.lastRun) continue;
      const q = App.days[App.dates.indexOf(ex)].q[p.code];
      let t;
      if (!q) t = { date: ex, type: 'DCA_FAIL', code: p.code, shares: 0, price: 0, amount: 0, fee: 0, tax: 0, note: '當天沒有收盤價（上櫃股票或停牌）' };
      else {
        const shares = Math.floor(p.amount / q[3]);
        if (shares < 1) t = { date: ex, type: 'DCA_FAIL', code: p.code, shares: 0, price: q[3], amount: 0, fee: 0, tax: 0, note: '金額不夠買 1 股' };
        else { const amount = shares * q[3]; t = { date: ex, type: 'DCA', code: p.code, shares, price: q[3], amount, fee: myFee(amount, shares, true), tax: 0, note: `定期定額 ${money(p.amount)}` }; }
      }
      try { addTxn(t); } catch (e) {
        addTxn({ date: ex, type: 'DCA_FAIL', code: p.code, shares: 0, price: q ? q[3] : 0, amount: 0, fee: 0, tax: 0, note: '現金不足，扣款失敗' });
      }
      p.lastRun = ex; count++;
    }
  }
  if (count) saveMy();
  return count;
}

// 每個交易日的總資產與累計入金（畫圖用）
function myHistory() {
  const txns = sortTxns(App.my.txns);
  if (!txns.length || !App.dates.length) return null;
  const first = txns[0].date, labels = [], assets = [], nets = [];
  let k = 0;
  const st = { cash: 0, net: 0, hold: {} };
  for (let i = 0; i < App.dates.length; i++) {
    const d = App.dates[i];
    if (d < first) continue;
    while (k < txns.length && txns[k].date <= d) {
      const t = txns[k++], h = t.code ? (st.hold[t.code] || (st.hold[t.code] = { shares: 0, cost: 0, px: 0 })) : null;
      if (t.type === 'DEPOSIT') { st.cash += t.amount; st.net += t.amount; }
      else if (t.type === 'WITHDRAW') { st.cash -= t.amount; st.net -= t.amount; }
      else if (t.type === 'BUY' || t.type === 'DCA') { st.cash -= t.amount + t.fee; h.shares += t.shares; h.px = t.price; }
      else if (t.type === 'SELL') { st.cash += t.amount - t.fee - t.tax; h.shares -= t.shares; h.px = t.price; }
      else if (t.type === 'DIV') { st.cash += t.amount - t.fee; h.shares += t.shares || 0; }
    }
    let mv = 0;
    for (const c in st.hold) { const h = st.hold[c]; if (!h.shares) continue; const q = App.days[i].q[c]; if (q) h.px = q[3]; mv += h.shares * h.px; }
    labels.push(d); assets.push(st.cash + mv); nets.push(st.net);
  }
  return labels.length ? { labels, assets, nets } : null;
}

// ============================================================ 畫面
const $ = sel => document.querySelector(sel);
const TITLES = { suggest: '每日建議', rank: '成交量排行', sim: '百萬模擬', mine: '我的帳戶', settings: '設定' };

function setStatus(msg, frac) {
  const el = $('#status');
  if (!msg) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.querySelector('.status-text').textContent = msg;
  el.querySelector('.bar i').style.width = Math.round((frac || 0) * 100) + '%';
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === App.tab));
  $('#title').textContent = TITLES[App.tab];
  const last = App.dates[App.dates.length - 1];
  $('#dataInfo').textContent = last ? `資料 ${last}` : '尚無資料';
  App.charts = {};
  const html = { suggest: renderSuggest, rank: renderRank, sim: renderSim, mine: renderMine, settings: renderSettings }[App.tab]();
  $('#main').innerHTML = html;
  drawCharts();
  rankAuto();
  renderIdx();
}

const regimeClass = n => ({ '偏多': 'bull', '偏空': 'bear', '方向不明': 'flat' }[n] || 'na');
const tag = g => `<span class="tag tag-${g.toLowerCase()}">${GROUP_LABEL[g]}</span>`;
const empty = msg => `<div class="empty">${msg}</div>`;

function stockLine(code, extra) {
  return `<div class="stk"><span class="code">${esc(code)}</span><b>${esc(nm(code))}</b>${extra || ''}</div>`;
}

// ---------------------------------------------------------- 每日建議
function renderSuggest() {
  const sim = App.sim;
  if (!sim) return empty('還沒有收盤資料，請按右上角或設定裡的「立即更新」。');
  const L = sim.last, view = App.viewDate && App.viewDate !== L.date ? sim.log.find(x => x.date === App.viewDate) : null;
  const entry = view || L;
  const t = App.dates.indexOf(entry.date);
  const ixChg = t > 0 ? App.days[t].index / App.days[t - 1].index - 1 : null;
  const regName = view ? view.regime : L.reg.name;
  const opts = sim.log.slice().reverse().map(x => `<option value="${x.date}" ${x.date === entry.date ? 'selected' : ''}>${x.date}${x.date === L.date ? '（最新）' : ''}</option>`).join('');

  let h = `<section class="card">
    <div class="row between">
      <select class="date-pick" data-change="pickDay">${opts}</select>
      <button class="btn" data-act="sync" ${App.busy ? 'disabled' : ''}>更新資料</button>
    </div>
    <div class="regime ${regimeClass(regName)}">
      <div><div class="muted">大盤</div><div class="regime-name">${regName}</div></div>
      <div class="right"><div class="big">${App.days[t].index.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
      <div class="${ud(ixChg)}">${fmtPct(ixChg)}</div></div>
    </div>`;
  if (!view) {
    const r = L.reg;
    if (r.ma60) h += `<div class="muted small">20 日線 ${money(r.ma20)}・60 日線 ${money(r.ma60)}</div>`;
    h += `<p class="summary">${regimeText(r.name, L)}</p>`;
    if (r.name === '偏空' && L.acct.stock > 0) {
      h += `<p class="muted small">避險提示：百萬模擬帳戶股票 ${money(L.acct.stock)} 元，約可放空小台 ${(L.acct.stock / (r.index * 50)).toFixed(1)} 口；大盤站回 60 日線後解除。</p>`;
    }
  }
  h += `<p class="muted small">訊號用 ${entry.date} 收盤算出，下一個交易日開盤執行。這是策略模擬，不是投資建議。</p></section>`;

  h += `<h3 class="sec">買進建議 <span class="count">${entry.buys.length}</span></h3>`;
  h += entry.buys.length ? `<div class="list">${entry.buys.map(b => `
    <div class="item">
      <div class="row between">${stockLine(b.code, tag(b.g))}<button class="btn-sm" data-act="quickBuy" data-code="${b.code}">記錄買進</button></div>
      <div class="small">收盤 <b>${px(b.close)}</b>・停損參考 <b>${px(b.stop)}</b></div>
      <div class="muted small">${esc(b.why)}</div>
    </div>`).join('')}</div>` : empty(regName === '偏空' ? '大盤偏空，核心組照規則不買；其他組也沒有新名單。' : '今天沒有買進訊號。');

  h += `<h3 class="sec">賣出建議 <span class="count">${entry.sells.length}</span></h3>`;
  const mine = myState().hold;
  h += entry.sells.length ? `<div class="list">${entry.sells.map(s => `
    <div class="item">
      <div class="row between">${stockLine(s.code, tag(s.g))}${mine[s.code] ? `<button class="btn-sm" data-act="quickSell" data-code="${s.code}">記錄賣出</button>` : ''}</div>
      <div class="small">進場 ${px(s.entryPrice)} → 收盤 ${px(s.close)}　<b class="${ud(s.ret)}">${fmtPct(s.ret)}</b></div>
      <div class="muted small">${esc(s.why)}</div>
    </div>`).join('')}</div>` : empty('今天沒有要賣的，手上的續抱，跌到停損價再賣。');

  if (view) return h + `<p class="muted small center">歷史日期只顯示當天的買賣訊號。</p>`;

  if (L.shorts.length) {
    h += `<details class="card"><summary>放空參考（大盤偏空才列，只供參考）</summary><div class="list">${L.shorts.map(s => `
      <div class="item">${stockLine(s.code)}<div class="small">收盤 ${px(s.close)}・近 20 日 <b class="down">${fmtPct(s.r20)}</b></div><div class="muted small">${esc(s.why)}</div></div>`).join('')}</div></details>`;
  }
  h += `<details class="card"><summary>類股強弱 RS 前 10 名</summary><div class="rs">${L.rs.slice(0, 10).map((x, i) => {
    const max = Math.max(...L.rs.slice(0, 10).map(y => Math.abs(y.rs))) || 1;
    return `<div class="rs-row"><span class="rs-rank">${i + 1}</span><span class="rs-name">${esc(x.ind)}</span>
      <span class="rs-bar"><i class="${x.rs >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(x.rs) / max * 100}%"></i></span><span class="rs-val">${x.rs.toFixed(3)}</span></div>`;
  }).join('')}</div></details>`;
  for (const g of GROUPS) h += groupHoldings(g);
  return h;
}

function regimeText(n, L) {
  const core = L.buys.filter(b => b.g === 'Core').length;
  if (n === '偏多') return `大盤偏多：各組照常買進，價值組和 PEAD 組持股上限 30 檔。核心組今天選出 ${core} 檔。`;
  if (n === '方向不明') return `大盤方向不明：核心組照常買（今天 ${core} 檔）；價值組和 PEAD 組減碼，上限 15 檔。`;
  if (n === '偏空') return '大盤偏空：核心組不買進；價值組和 PEAD 組減碼，上限 4 檔，其餘放現金。';
  return '歷史資料不足 60 天，無法判斷大盤多空，照規則各組都不買。';
}

function groupHoldings(g) {
  const G = App.sim.G[g], t = App.days.length - 1, today = parseYmd(App.dates[t]);
  const rows = G.pos.slice().sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1)).map(p => {
    const cur = App.days[t].q[p.code]?.[3] ?? p.last, r = App.sim.posRet(p, cur);
    const days = Math.round((today - parseYmd(p.entryDate)) / 86400000);
    return `<tr><td>${stockLine(p.code)}<div class="muted small">${p.entryDate}・${days} 天</div></td>
      <td class="num">${px(p.entryPrice)}<div class="muted small">停損 ${px(p.stop)}</div></td>
      <td class="num">${px(cur)}<div class="${ud(r)}">${fmtPct(r)}</div></td></tr>`;
  }).join('');
  const avg = G.closedN ? G.closedSum / G.closedN : null;
  return `<details class="card"><summary>${GROUP_LABEL[g]}紙上持股（${G.pos.length} 檔）</summary>
    ${rows ? `<table class="tbl"><thead><tr><th>股票</th><th class="num">進場/停損</th><th class="num">現價/損益</th></tr></thead><tbody>${rows}</tbody></table>` : empty('目前沒有持股')}
    ${G.closedN ? `<p class="muted small">已賣出 ${G.closedN} 筆，平均 <b class="${ud(avg)}">${fmtPct(avg)}</b>（和持股一起看才不會偏樂觀）</p>` : ''}</details>`;
}

// ---------------------------------------------------------- 百萬模擬
// 長期回測：電腦用完整歷史（2004 年起）跑同一套策略，手機只顯示結果
function renderLongBacktest() {
  const bt = App.bt;
  if (!bt || !bt.runs || !bt.runs.length) return '';
  const k = Math.min(App.btRun || 0, bt.runs.length - 1), R = bt.runs[k], S = R.series, i0 = S.index[0];
  const E5 = R.etf && S.etf ? R.etf : null;   // 舊版 backtest.json 沒有 0050 比較
  App.charts.long = { labels: S.dates, pct: true, series: [
    { name: '模擬帳戶', color: 'var(--accent)', data: S.acct.map(v => v / R.capital - 1) },
    ...(E5 ? [{ name: '0050（含息）', color: 'var(--c3)', data: S.etf.map(v => v - 1) }] : []),
    { name: '加權指數（不含息）', color: 'var(--muted)', data: S.index.map(v => v / i0 - 1), dash: true },
  ] };
  const pick = bt.runs.length > 1 ? `<select data-change="btRun">${bt.runs.map((r, i) => `<option value="${i}" ${i === k ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>` : `<p class="small">${esc(R.label)}</p>`;
  const etfTd = x => (E5 ? `<td class="num ${ud(x)}">${fmtPct(x, 1)}</td>` : '');
  const yrows = R.yearly.slice().reverse().map(y => `<tr><td>${y.year}</td><td class="num ${ud(y.acct)}">${fmtPct(y.acct, 1)}</td>${etfTd(y.etf)}<td class="num ${ud(y.index)}">${fmtPct(y.index, 1)}</td>
    <td class="num ${ud(y.Core)}">${fmtPct(y.Core, 1)}</td><td class="num ${ud(y.Value)}">${fmtPct(y.Value, 1)}</td><td class="num ${ud(y.Pead)}">${fmtPct(y.Pead, 1)}</td></tr>`).join('');
  const crows = R.crises.map(c => `<tr><td>${esc(c.name)}<div class="muted small">${c.from} ~ ${c.to}</div></td>
    <td class="num ${ud(c.acct)}">${fmtPct(c.acct, 1)}</td>${etfTd(c.etf)}<td class="num ${ud(c.index)}">${fmtPct(c.index, 1)}</td></tr>`).join('');
  const beat = E5 ? R.yearly.filter(y => y.acct > y.etf).length : 0;
  const vs = E5 ? `<div class="calc"><div class="row between"><span>同期 100 萬買 0050 放著（股息再投入）</span><b class="${ud(E5.ret)}">${money(E5.final)}</b></div>
    <div class="small muted">年化 ${fmtPct(E5.cagr)}・最大回落 ${(E5.mdd * 100).toFixed(1)}%</div>
    <div class="small">策略比 0050 <b class="${ud(R.final - E5.final)}">${R.final >= E5.final ? '多' : '少'} ${money(Math.abs(R.final - E5.final))} 元</b>；${R.yearly.length} 年中有 ${beat} 年贏 0050</div></div>` : '';
  return `<section class="card"><h3 class="sec0">長期回測（${R.start.slice(0, 4)} ~ ${R.end.slice(0, 4)}）</h3>${pick}
    <div class="muted small" style="margin-top:8px">100 萬照策略自動買賣 ${R.days.toLocaleString()} 個交易日</div>
    <div class="hero ${ud(R.acctRet)}">${money(R.final)}</div>
    <div class="${ud(R.acctRet)}">總報酬 ${fmtPct(R.acctRet, 1)}・年化 ${fmtPct(R.cagr)}<span class="muted">　大盤年化 ${fmtPct(R.idxCagr)}</span></div>
    <div class="grid3">
      <div><div class="muted small">最大回落</div><b>${(R.acctMdd * 100).toFixed(1)}%</b></div>
      <div><div class="muted small">股利收入</div><b>${money(R.divs)}</b></div>
      <div><div class="muted small">手續費+稅</div><b>${money(R.fees)}</b></div>
      <div><div class="muted small">賣出筆數</div><b>${R.trades.toLocaleString()}</b></div>
      <div><div class="muted small">勝率</div><b>${R.winRate != null ? (R.winRate * 100).toFixed(1) + '%' : '—'}</b></div>
      <div><div class="muted small">三組合計</div><b class="${ud(R.combRet)}">${fmtPct(R.combRet, 0)}</b></div>
    </div>${vs}</section>
  <section class="card">${chartBlock('long')}</section>
  ${crows ? `<section class="card"><h3 class="sec0">股災和大多頭時的表現</h3><table class="tbl"><thead><tr><th>期間</th><th class="num">帳戶</th>${E5 ? '<th class="num">0050</th>' : ''}<th class="num">大盤</th></tr></thead><tbody>${crows}</tbody></table></section>` : ''}
  <details class="card"><summary>逐年報酬</summary><table class="tbl"><thead><tr><th>年</th><th class="num">帳戶</th>${E5 ? '<th class="num">0050</th>' : ''}<th class="num">大盤</th><th class="num">核心</th><th class="num">價值</th><th class="num">PEAD</th></tr></thead><tbody>${yrows}</tbody></table>
    <p class="muted small">核心組、PEAD 組要有月營收資料（2010 年起）才會選股。</p></details>
  <p class="muted small">長期回測由電腦用證交所 ${bt.dataFrom} 起的完整歷史計算，選股只用當時已公布的營收和淨值比；大盤用不含息的加權指數，0050 是從第一天買進放著、股息再投入的含息報酬（沒扣手續費）。過去績效不代表未來。</p>
  <h3 class="sec">近期模擬（手機計算）</h3>`;
}

function renderSim() {
  const sim = App.sim;
  const long = renderLongBacktest();
  if (!sim || !sim.perf.length) return long + empty('還沒有足夠的資料。');
  const s = perfSummary(sim.perf), cap = sim.cfg.capital, a = sim.last.acct, pnl = a.total - cap;
  App.charts.sim = {
    labels: sim.perf.map(x => x.date), pct: true,
    series: [
      { name: '模擬帳戶', color: 'var(--accent)', data: sim.perf.map(x => x.acct / cap - 1) },
      { name: '三組紙上合計', color: 'var(--c3)', data: sim.perf.map(x => x.comb - 1) },
      { name: '大盤', color: 'var(--muted)', data: sim.perf.map(x => x.index / sim.perf[0].index - 1), dash: true },
    ],
  };
  let h = long + `<section class="card">
    <div class="muted">帳戶總值（本金 ${money(cap)}）</div>
    <div class="hero ${ud(pnl)}">${money(a.total)}</div>
    <div class="${ud(pnl)}">${signMoney(pnl)}（${fmtPct(pnl / cap)}）<span class="muted">　同期大盤 ${fmtPct(s.idx)}</span></div>
    <div class="grid3">
      <div><div class="muted small">現金</div><b>${money(a.cash)}</b></div>
      <div><div class="muted small">股票</div><b>${money(a.stock)}</b></div>
      <div><div class="muted small">手續費+稅</div><b>${money(sim.acct.fees)}</b></div>
      <div><div class="muted small">最大回落</div><b>${(s.acctMdd * 100).toFixed(2)}%</b></div>
      <div><div class="muted small">股利收入</div><b class="${ud(sim.acct.divs)}">${money(sim.acct.divs)}</b></div>
      <div><div class="muted small">起始日</div><b>${s.start}</b></div>
    </div>
    <p class="muted small">共 ${s.n} 個交易日。每天收盤後照核心、價值、PEAD 三組訊號自動買賣，隔天成交：整張用開盤價、零股用收盤價＋0.1%，手續費和證交稅照扣，錢不夠就買不起。
      除權息日自動領股利（扣二代健保和匯費）。起始日可在「設定」修改。</p>
  </section>
  <section class="card">${chartBlock('sim')}</section>
  <section class="card"><h3 class="sec0">各組紙上成績</h3>
    <table class="tbl"><thead><tr><th>組別</th><th class="num">扣成本後</th><th class="num">扣成本前</th><th class="num">持股</th></tr></thead><tbody>
    ${GROUPS.map(g => `<tr><td>${GROUP_LABEL[g]}</td><td class="num ${ud(s[g])}">${fmtPct(s[g])}</td><td class="num ${ud(s[g + 'G'])}">${fmtPct(s[g + 'G'])}</td><td class="num">${sim.G[g].pos.length}</td></tr>`).join('')}
    <tr class="total"><td>三組合計</td><td class="num ${ud(s.comb)}">${fmtPct(s.comb)}</td><td></td><td class="num">最大回落 ${(s.mdd * 100).toFixed(1)}%</td></tr>
    </tbody></table></section>`;

  const t = App.days.length - 1;
  const holds = sim.acct.hold.map(x => {
    const value = x.shares * x.last, r = value / x.cost - 1;
    return `<tr><td>${stockLine(x.code)}<div class="muted small">${GROUP_LABEL[x.group]}・${x.date}</div></td>
      <td class="num">${x.shares.toLocaleString()}<div class="muted small">成本 ${money(x.cost)}</div></td>
      <td class="num">${money(value)}<div class="${ud(r)}">${fmtPct(r)}</div></td></tr>`;
  }).join('');
  h += `<section class="card"><h3 class="sec0">目前持股（${sim.acct.hold.length}）</h3>
    ${holds ? `<table class="tbl"><thead><tr><th>股票</th><th class="num">股數</th><th class="num">市值/損益</th></tr></thead><tbody>${holds}</tbody></table>` : empty('目前空手')}</section>`;

  const trades = sim.acct.trades.slice(-100).reverse().map(x => {
    const isDiv = x.side === '股利', buy = x.side === '買進';
    const amt = buy ? -(x.amount + x.fee) : x.amount - x.fee - x.tax;
    return `
    <div class="txn"><div class="row between"><div>${stockLine(x.code, `<span class="side ${buy ? 'buy' : isDiv ? 'div' : 'sell'}">${x.side}</span>`)}</div>
      <div class="num ${isDiv ? 'up' : ''}">${amt < 0 ? '−' : '+'}${money(Math.abs(amt))}</div></div>
      <div class="row between small muted"><span>${x.date}・${GROUP_LABEL[x.group]}・${isDiv ? (x.shares ? `配股 ${x.shares.toLocaleString()} 股` : '現金股利') : `${x.shares.toLocaleString()} 股 @ ${px(x.price)}`}</span>
      ${x.pnl != null ? `<b class="${ud(x.pnl)}">${signMoney(x.pnl)}</b>` : ''}</div>
      <div class="muted small">${esc(x.why)}</div></div>`;
  }).join('');
  h += `<section class="card"><h3 class="sec0">交易紀錄（最近 100 筆）</h3>${trades || empty('還沒有交易')}</section>`;
  return h;
}

// ---------------------------------------------------------- 我的帳戶
function renderMine() {
  const st = myState();
  const hist = myHistory();
  if (hist) {
    App.charts.mine = { labels: hist.labels, series: [
      { name: '總資產', color: 'var(--accent)', data: hist.assets },
      { name: '累計投入', color: 'var(--muted)', data: hist.nets, dash: true },
    ] };
  }
  const pnlPct = st.net > 0 ? st.pnl / st.net : null;
  let h = '';
  if (st.error) h += `<div class="card warn">${esc(st.error)}</div>`;
  h += `<section class="card">
    <div class="muted">總資產</div>
    <div class="hero">${money(st.total)}</div>
    <div class="${ud(st.pnl)}">總損益 ${signMoney(st.pnl)}${pnlPct != null ? `（${fmtPct(pnlPct)}）` : ''}<span class="muted">　今日 </span><span class="${ud(st.dayChg)}">${signMoney(st.dayChg)}</span></div>
    <div class="grid3">
      <div><div class="muted small">現金</div><b>${money(st.cash)}</b></div>
      <div><div class="muted small">股票市值</div><b>${money(st.mv)}</b></div>
      <div><div class="muted small">累計投入</div><b>${money(st.net)}</b></div>
      <div><div class="muted small">未實現</div><b class="${ud(st.unrealized)}">${signMoney(st.unrealized)}</b></div>
      <div><div class="muted small">已實現</div><b class="${ud(st.realized)}">${signMoney(st.realized)}</b></div>
      <div><div class="muted small">股利收入</div><b class="${ud(st.divIncome)}">${signMoney(st.divIncome)}</b></div>
    </div>
    <p class="muted small">手續費和證交稅累計 ${money(st.fees + st.taxes)} 元。總損益已包含股利。</p>
    <div class="actions">
      <button class="act" data-act="deposit"><i>＋</i>入金</button>
      <button class="act" data-act="withdraw"><i>－</i>出金</button>
      <button class="act buy" data-act="buy"><i>買</i>買進</button>
      <button class="act sell" data-act="sell"><i>賣</i>賣出</button>
      <button class="act" data-act="dca"><i>⟳</i>定期定額</button>
      <button class="act div" data-act="dividend"><i>息</i>股利</button>
    </div>
  </section>`;

  const pend = pendingDividends(), next = upcomingDividends(st.hold);
  if (pend.length) {
    h += `<section class="card"><h3 class="sec0">待確認股利（${pend.length}）</h3>${pend.map(p => `
      <div class="txn"><div class="row between">${stockLine(p.code)}<b class="up">${p.net ? '+' + money(p.net) : ''}${p.stockShares ? `${p.net ? '・' : ''}配 ${p.stockShares} 股` : ''}</b></div>
        <div class="small muted">除權息日 ${p.date}・當時持有 ${p.shares.toLocaleString()} 股・每股現金 ${p.cash.toFixed(2)}${p.stock ? `、配股 ${p.stock.toFixed(4)}` : ''}${p.nhi ? `・預扣二代健保 ${money(p.nhi)}` : ''}</div>
        <div class="row between"><span class="muted small">股利通常在除息後約一個月入帳</span>
        <span><button class="btn-sm" data-act="divConfirm" data-key="${p.divKey}">確認入帳</button> <button class="btn-sm ghost" data-act="divDismiss" data-key="${p.divKey}">忽略</button></span></div></div>`).join('')}
      <p class="muted small">依證交所除權息資料和你在除權息前一天的持股自動算出；金額以實際入帳為準，確認時可以修改。</p></section>`;
  }
  if (next.length) {
    h += `<section class="card"><h3 class="sec0">即將除權息</h3>${next.map(x => `
      <div class="txn"><div class="row between">${stockLine(x.code)}<span class="small">${x.date}</span></div>
        <div class="small muted">每股現金 ${x.cash != null ? x.cash.toFixed(4) : '待公告'}${x.stock ? `、配股 ${x.stock.toFixed(4)}` : ''}・持有 ${x.shares.toLocaleString()} 股${x.net ? `・預估入帳 ${money(x.net)}` : ''}</div></div>`).join('')}
      <p class="muted small">除權息日前一天收盤還持有才領得到。</p></section>`;
  }
  if (hist) h += `<section class="card">${chartBlock('mine')}</section>`;

  h += `<section class="card"><h3 class="sec0">持股（${st.list.length}）</h3>${st.list.length ? `<table class="tbl"><thead><tr><th>股票</th><th class="num">股數/均價</th><th class="num">市值/損益</th></tr></thead><tbody>${
    st.list.map(x => `<tr data-act="quickSell" data-code="${x.code}"><td>${stockLine(x.code)}<div class="muted small">現價 ${px(x.price)}</div></td>
      <td class="num">${x.shares.toLocaleString()}<div class="muted small">${px(x.avg)}</div></td>
      <td class="num">${money(x.value)}<div class="${ud(x.pnl)}">${signMoney(x.pnl)}（${fmtPct(x.pnl / x.cost)}）</div></td></tr>`).join('')
  }</tbody></table><p class="muted small">點持股可以直接記錄賣出。均價含買進手續費。</p>` : empty('還沒有持股。先「入金」，再「買進」或設定「定期定額」。')}</section>`;

  h += `<section class="card"><h3 class="sec0">定期定額（${App.my.plans.length}）</h3>${App.my.plans.length ? App.my.plans.map(p => `
    <div class="txn"><div class="row between">${stockLine(p.code)}<b>${money(p.amount)} / 次</b></div>
      <div class="row between small muted"><span>每月 ${p.days.join('、')} 日・${p.start} 起・${p.lastRun ? '上次 ' + p.lastRun : '尚未扣款'}</span>
      <span><button class="btn-sm" data-act="togglePlan" data-id="${p.id}">${p.active ? '暫停' : '恢復'}</button>
      <button class="btn-sm ghost" data-act="delPlan" data-id="${p.id}">刪除</button></span></div>
      ${p.active ? '' : '<div class="small warn-text">已暫停</div>'}</div>`).join('') : empty('沒有定期定額計畫。')}
    <p class="muted small">扣款日遇到休市就順延到下一個交易日，用當天收盤價成交；每次更新資料時自動執行。</p></section>`;

  const months = [...new Set(st.rows.map(r => r.t.date.slice(0, 7)))].sort().reverse();
  const rows = st.rows.slice().reverse().filter(r => App.stmtMonth === 'all' || r.t.date.startsWith(App.stmtMonth));
  h += `<section class="card"><div class="row between"><h3 class="sec0">對帳單</h3>
    <span><select data-change="stmtMonth"><option value="all">全部</option>${months.map(m => `<option value="${m}" ${m === App.stmtMonth ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <button class="btn-sm" data-act="export">匯出</button></span></div>
    ${rows.length ? rows.map(r => stmtRow(r)).join('') : empty('沒有紀錄')}</section>`;
  return h;
}

function cashDelta(t) {
  if (t.type === 'DEPOSIT') return t.amount;
  if (t.type === 'WITHDRAW') return -t.amount;
  if (t.type === 'BUY' || t.type === 'DCA') return -(t.amount + t.fee);
  if (t.type === 'SELL') return t.amount - t.fee - t.tax;
  if (t.type === 'DIV') return t.amount - t.fee;
  return 0;
}

// ---------------------------------------------------------- 股利：待確認（已除權息、當時有持股、還沒記錄）與即將除權息
function sharesBefore(txns, code, date) {
  let s = 0;
  for (const t of txns) {
    if (t.code !== code || t.date >= date) continue;
    if (t.type === 'BUY' || t.type === 'DCA') s += t.shares;
    else if (t.type === 'SELL') s -= t.shares;
    else if (t.type === 'DIV') s += t.shares || 0;
  }
  return s;
}
function divEstimate(shares, cash, stock) {
  const d = dividendNet(Math.floor(shares * (cash || 0)));
  return Object.assign(d, { stockShares: Math.floor(shares * (stock || 0)) });
}
function pendingDividends() {
  const txns = App.my.txns, codes = new Set(txns.filter(t => t.code).map(t => t.code));
  if (!codes.size) return [];
  const first = sortTxns(txns)[0].date;
  // divKey＝「除權息日|代號」，把股利紀錄對應回除權息事件（事件本身的 ref 是參考價，不能拿來當鍵）
  const done = new Set(txns.filter(t => t.type === 'DIV' && t.divKey).map(t => t.divKey)), skip = new Set(App.my.dismissed || []);
  const out = [];
  for (const e of App.divList) {
    if (e.date <= first || !codes.has(e.code)) continue;
    const divKey = e.date + '|' + e.code;
    if (done.has(divKey) || skip.has(divKey)) continue;
    const shares = sharesBefore(txns, e.code, e.date);
    if (shares > 0) out.push(Object.assign({}, e, divEstimate(shares, e.cash, e.stock), { divKey, shares }));
  }
  return out.reverse();
}
function upcomingDividends(hold) {
  const today = ymd(new Date());
  return App.divNext.filter(x => x.date >= today && hold[x.code]).map(x => Object.assign({ shares: hold[x.code].shares }, x,
    x.cash != null ? divEstimate(hold[x.code].shares, x.cash, x.stock) : {}));
}
function stmtRow(r) {
  const t = r.t, d = cashDelta(t), stock = t.code;
  const cls = { BUY: 'buy', DCA: 'buy', SELL: 'sell', DIV: 'div' }[t.type] || '';
  const detail = t.type === 'DIV'
    ? `・現金 ${money(t.amount)}${t.shares ? `・配股 ${t.shares.toLocaleString()} 股` : ''}${t.fee ? `・健保+匯費 ${money(t.fee)}` : ''}`
    : `${t.shares ? `・${t.shares.toLocaleString()} 股 @ ${px(t.price)}` : ''}${t.fee ? `・費 ${money(t.fee)}` : ''}${t.tax ? `・稅 ${money(t.tax)}` : ''}`;
  return `<div class="txn"><div class="row between">
      <div><span class="side ${cls}">${TXN_LABEL[t.type]}</span> ${stock ? `<span class="code">${esc(t.code)}</span> <b>${esc(nm(t.code))}</b>` : ''}</div>
      <div class="num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d ? signMoney(d) : '—'}</div></div>
    <div class="row between small muted"><span>${t.date}${detail}</span>
      <span>餘額 ${money(r.cash)}</span></div>
    ${r.pnl != null ? `<div class="small">已實現 <b class="${ud(r.pnl)}">${signMoney(r.pnl)}</b></div>` : ''}
    <div class="row between small muted"><span>${esc(t.note || '')}</span><button class="link" data-act="delTxn" data-id="${t.id}">刪除</button></div></div>`;
}

// ---------------------------------------------------------- 成交量排行
// 即時：證交所即時報價（mis.twse.com.tw）沒有排行榜 API，所以把所有上市股票分批查一次再自己排序；
//       這個網址不開放網頁跨站讀取，只有 Android App（原生連線）能直接查；
//       網頁版改讀電腦盤中每 2 分鐘上傳的排行（live_rank.ps1）。
// 收盤／本週：用已下載的每日收盤資料計算，網頁版也能用。
const Rank = { mode: 'live', by: 'vol', etf: true, mkt: 'all', live: null, loading: false, done: 0, total: 0, err: '', timer: null };
const RANK_TOP = 30;
const isEtf = c => c.startsWith('00');
const posNum = s => { const x = parseFloat(s); return isFinite(x) && x > 0 ? x : null; };
// 手機時間當台灣時間：週一到週五 08:55–13:35 視為盤中（自動每分鐘更新）
const inSession = () => { const d = new Date(), w = d.getDay(), m = d.getHours() * 60 + d.getMinutes(); return w > 0 && w < 6 && m >= 535 && m <= 815; };

// 網頁版：電腦盤中每 2 分鐘把排行上傳到 GitHub 的 live 分支（live_rank.ps1），從 raw.githubusercontent.com 讀
function liveRankUrl() {
  const m = /^([\w-]+)\.github\.io$/.exec(location.hostname), repo = location.pathname.split('/')[1];
  return IS_WEB && m && repo ? `https://raw.githubusercontent.com/${m[1]}/${repo}/live/rank.json` : null;
}
const HAS_LIVE = !!(Native || liveRankUrl());
async function fetchWebLiveRank() {
  Object.assign(Rank, { loading: true, done: 0, total: 1, err: '', tried: Date.now() });
  if (App.tab === 'rank') render();
  try {
    const j = JSON.parse(await httpGet(liveRankUrl() + '?t=' + Date.now()));
    idxFromPc(j); renderIdx();
    Rank.live = { rows: j.rows.map(r => ({ code: r[0], name: r[1], otc: r[2] === 1, price: r[3], chg: r[4], lots: r[5], value: r[6] })),
      date: j.date, time: j.time, at: Date.now(), uploaded: j.at, fromPc: true };
  } catch (e) { Rank.err = '讀不到電腦上傳的即時排行（電腦可能沒開，或今天還沒上傳）。'; }
  Rank.loading = false;
  if (App.tab === 'rank') render();
}

async function fetchLiveRank() {
  if (!Native && liveRankUrl() && !Rank.loading) return fetchWebLiveRank();
  if (!Native || Rank.loading || !App.days.length) return;
  const batches = []; let cur = [];
  const otcLast = App.otc[Object.keys(App.otc).sort().pop()] || {};   // 上櫃代號取最近一天的上櫃收盤檔
  const keys = [...Object.keys(App.days[App.days.length - 1].q).map(c => `tse_${c}.tw`), ...Object.keys(otcLast).map(c => `otc_${c}.tw`)];
  for (const k of keys) {
    cur.push(k);
    if (cur.join('|').length > 1200) { batches.push(cur); cur = []; }   // 網址太長證交所會回「參數不足」
  }
  if (cur.length) batches.push(cur);
  Object.assign(Rank, { loading: true, done: 0, total: batches.length, err: '', tried: Date.now() });
  if (App.tab === 'rank') render();
  const rows = []; let fail = 0, date = '', time = '';
  async function one(b) {
    try {
      const j = JSON.parse(await httpGet('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=' + encodeURIComponent(b.join('|'))));
      for (const m of j.msgArray || []) {
        const lots = parseFloat(m.v), y = posNum(m.y);
        if (!isFinite(lots)) continue;
        // z 是最新成交價；剛好沒有新成交時是 "-"，改用最後一筆成交或最佳買價
        const p = posNum(m.z) ?? posNum(m.trade && m.trade.z) ?? posNum(String(m.b || '').split('_')[0]);
        rows.push({ code: m.c, name: m.n, otc: m.ex === 'otc', price: p, chg: p && y ? p / y - 1 : null, lots, value: p ? lots * 1000 * p : 0 });
        if ((m.d || '') + (m.t || '') > date + time) { date = m.d || ''; time = m.t || ''; }
      }
    } catch (e) { fail++; }
    Rank.done++;
    if (App.tab === 'rank' && Rank.done % 3 === 0) render();
  }
  let i = 0;   // 原生連線最多同時 3 條
  await Promise.all([0, 1, 2].map(async () => { while (i < batches.length) await one(batches[i++]); }));
  Rank.loading = false;
  if (rows.length) Rank.live = { rows, date: date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '', time, at: Date.now(), partial: fail > 0 };
  if (!rows.length) Rank.err = '證交所即時報價沒有回應，請稍後再按「重新整理」。';
  else if (fail) Rank.err = `有 ${fail} 批資料沒抓到，排行可能不完整。`;
  if (App.tab === 'rank') render();
}

// 收盤排行：一天（end 那天）或一段期間（from..end）的成交量加總；漲跌和期間前一天比
function closeRank(from, end) {
  const i0 = App.dates.indexOf(from), i1 = App.dates.indexOf(end);
  const prev = i0 > 0 ? App.days[i0 - 1].q : null, acc = {};
  for (let i = i0; i <= i1; i++) {
    for (const [c, q] of Object.entries(App.days[i].q)) {
      const a = acc[c] || (acc[c] = { code: c, name: nm(c), lots: 0, value: 0, price: null });
      a.lots += q[4] / 1000; a.value += q[4] * q[3]; if (q[3] > 0) a.price = q[3];
    }
  }
  const out = Object.values(acc).map(a => Object.assign(a, { chg: prev && prev[a.code] && prev[a.code][3] > 0 && a.price ? a.price / prev[a.code][3] - 1 : null }));
  // 上櫃：成交金額是櫃買中心的實際數字；漲跌用期間第一天的前一日收盤
  const oacc = {}; let miss = 0;
  for (let i = i0; i <= i1; i++) {
    const m = App.otc[App.dates[i]];
    if (!m) { miss++; continue; }
    for (const [c, x] of Object.entries(m)) {
      const a = oacc[c] || (oacc[c] = { code: c, name: x.name, otc: true, lots: 0, value: 0, price: null, base: x.prev });
      a.lots += x.vol / 1000; a.value += x.value ?? x.vol * x.close; if (x.close > 0) a.price = x.close;
    }
  }
  for (const a of Object.values(oacc)) out.push(Object.assign(a, { chg: a.base > 0 && a.price ? a.price / a.base - 1 : null }));
  out.otcMissing = Object.keys(oacc).length ? miss : i1 - i0 + 1;
  return out;
}
// 最新收盤日所在那一週（週一起算）的第一個交易日
function weekStart(d) {
  const w = parseYmd(d).getDay(), mon = addDays(d, -((w + 6) % 7));
  return App.dates.find(x => x >= mon && x <= d);
}

function renderRank() {
  if (!App.days.length) return empty('還沒有收盤資料，請先到「每日建議」按「更新資料」。');
  const last = App.dates[App.dates.length - 1], ws = weekStart(last);
  const chip = (act, v, on, label) => `<button class="${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`;
  if (!HAS_LIVE && Rank.mode === 'live') Rank.mode = 'day';
  let h = `<section class="card"><div class="chips">
      ${HAS_LIVE ? chip('rankMode', 'live', Rank.mode === 'live', '即時') : ''}
      ${chip('rankMode', 'day', Rank.mode === 'day', `收盤 ${last.slice(5)}`)}
      ${chip('rankMode', 'week', Rank.mode === 'week', `本週 ${ws.slice(5)}～${last.slice(5)}`)}
    </div><div class="chips">
      ${chip('rankBy', 'vol', Rank.by === 'vol', '成交量')}${chip('rankBy', 'val', Rank.by === 'val', '成交值')}
      ${chip('rankEtf', 1, Rank.etf, '含 ETF')}${chip('rankEtf', 0, !Rank.etf, '只看個股')}
    </div><div class="chips">
      ${chip('rankMkt', 'all', Rank.mkt === 'all', '上市＋上櫃')}${chip('rankMkt', 'tse', Rank.mkt === 'tse', '上市')}${chip('rankMkt', 'otc', Rank.mkt === 'otc', '上櫃')}
    </div>`;
  let rows = null, note = '';
  if (Rank.mode === 'live') {
    const L = Rank.live;
    if (Rank.loading && !L) h += `<div class="small muted">讀取即時報價 ${Rank.done}/${Rank.total}…</div><div class="status"><div class="bar"><i style="width:${Math.round(Rank.done / (Rank.total || 1) * 100)}%"></i></div></div>`;
    if (L) {
      rows = L.rows;
      const today = ymd(new Date());
      note = L.date && L.date !== today ? `最新報價是 ${L.date} ${L.time}（今天還沒開盤或休市）` :
        `報價時間 ${L.time}${inSession() ? '・盤中每分鐘自動更新' : '・已收盤'}`;
      if (L.fromPc) {
        note += '・電腦每 2 分鐘上傳，約晚 2～5 分鐘';
        const age = (Date.now() - new Date(L.uploaded).getTime()) / 60000;
        if (L.date === today && inSession() && age > 8) h += `<div class="err">電腦上次上傳是 ${L.uploaded.slice(11, 16)}，可能沒開機或沒連網，排行不是最新的。</div>`;
      }
    }
    if (L && !L.rows.some(r => r.otc)) note += '・還沒有上櫃代號清單，先只排上市';
    h += `<div class="row between"><span class="muted small">${note || (Native ? '證交所報價約有 5 秒延遲' : '')}</span>
      <button class="btn-sm" data-act="rankRefresh" ${Rank.loading ? 'disabled' : ''}>重新整理</button></div>`;
    if (Rank.err) h += `<div class="err">${esc(Rank.err)}</div>`;
  } else {
    rows = Rank.mode === 'day' ? closeRank(last, last) : closeRank(ws, last);
    note = Rank.mode === 'day' ? `${last} 收盤` : `${ws} 到 ${last} 累計・漲跌是本週以來`;
    h += `<div class="muted small">${note}</div>`;
    if (rows.otcMissing) h += `<div class="muted small warn-text">上櫃資料缺 ${rows.otcMissing} 天${Native ? '（按「每日建議」的更新資料補抓）' : '（等電腦下次上傳）'}，上櫃排行可能不完整。</div>`;
  }
  h += '</section>';
  if (!rows) return h + (Rank.loading ? '' : empty('按「重新整理」讀取即時排行。'));
  const key = Rank.by === 'vol' ? 'lots' : 'value';
  const top = rows.filter(r => r[key] > 0 && (Rank.etf || !isEtf(r.code)) && (Rank.mkt === 'all' || (Rank.mkt === 'otc') === !!r.otc))
    .sort((a, b) => b[key] - a[key]).slice(0, RANK_TOP);
  const hold = myState().hold;
  h += `<section class="card"><table class="tbl"><tr><th></th><th>股票</th><th class="num">價格</th><th class="num">${Rank.by === 'vol' ? '張數' : '金額（億）'}</th></tr>
    ${top.map((r, i) => `<tr><td class="muted">${i + 1}</td>
      <td><b>${esc(r.name || nm(r.code))}</b>${hold[r.code] ? ' <span class="tag">持有</span>' : ''}<div class="code">${esc(r.code)}${r.otc ? '・上櫃' : ''}</div></td>
      <td class="num">${px(r.price)}<div class="small ${ud(r.chg)}">${fmtPct(r.chg)}</div></td>
      <td class="num">${Rank.by === 'vol' ? money(r.lots) : (r.value / 1e8).toFixed(1)}</td></tr>`).join('')}</table>
    ${Rank.by === 'val' ? `<p class="muted small">${Rank.mode === 'live' ? '成交值用成交量 × 現價估算。' : '上市成交值用成交量 × 收盤價估算，上櫃是櫃買中心公布的成交金額。'}</p>` : ''}</section>`;
  return h;
}

// 排行分頁開著、在盤中，就每分鐘重抓一次即時報價
function rankAuto() {
  const want = HAS_LIVE && App.tab === 'rank' && Rank.mode === 'live';
  if (want && !Rank.timer) Rank.timer = setInterval(() => { if (inSession() && !document.hidden) fetchLiveRank(); }, 60000);
  if (!want && Rank.timer) { clearInterval(Rank.timer); Rank.timer = null; }
  // 失敗後不馬上重試（至少隔 1 分鐘），免得一直打證交所
  if (want && !Rank.loading && Date.now() - (Rank.tried || 0) > 60000 && (!Rank.live || inSession())) fetchLiveRank();
}

// ---------------------------------------------------------- 即時指數（畫面上方，每個分頁都看得到）
// Android 直接查證交所即時報價（盤中每 20 秒）；網頁版讀電腦每 2 分鐘上傳的 rank.json 裡的指數
const Idx = { data: null, at: 0, busy: false };
const d8 = s => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');
function idxFromPc(j) {
  if (!j || !j.idx) return;
  const one = a => (a ? { p: a[0], y: a[1], h: a[2], l: a[3], t: a[4] } : null);
  Idx.data = { tse: one(j.idx.tse), otc: one(j.idx.otc), date: j.date, uploaded: j.at, fromPc: true };
  Idx.at = Date.now();
}
async function fetchIndex() {
  if (Idx.busy) return;
  Idx.busy = true;
  try {
    if (Native) {
      const j = JSON.parse(await httpGet('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=' + encodeURIComponent('tse_t00.tw|otc_o00.tw')));
      const d = { fromPc: false };
      for (const m of j.msgArray || []) {
        d[m.ex] = { p: posNum(m.z), y: posNum(m.y), h: posNum(m.h), l: posNum(m.l), t: m.t || '' };
        d.date = d8(m.d);
      }
      if (d.tse || d.otc) { Idx.data = d; Idx.at = Date.now(); }
    } else if (liveRankUrl()) idxFromPc(JSON.parse(await httpGet(liveRankUrl() + '?t=' + Date.now())));
  } catch (e) { /* 抓不到就顯示上次的數字或最近收盤 */ }
  Idx.busy = false;
  renderIdx();
}
function renderIdx() {
  const el = $('#idxbar');
  if (!el) return;
  let D = Idx.data;
  if (!D || !(D.tse || D.otc)) {   // 沒有即時資料：用最近一天的收盤
    const n = App.days.length;
    if (n < 2) { el.classList.add('hidden'); return; }
    D = { tse: { p: App.days[n - 1].index, y: App.days[n - 2].index }, date: App.dates[n - 1], closeOnly: true };
  }
  const cell = (name, x) => {
    if (!x || !x.p) return `<div><div class="nm">${name}</div><div class="v">—</div></div>`;
    const ch = x.y ? x.p - x.y : null;
    return `<div><div class="nm">${name}</div><div class="v ${ud(ch)}">${x.p.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      <div class="c ${ud(ch)}">${ch == null ? '' : `${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${Math.abs(ch).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}（${fmtPct(ch / x.y)}）`}</div></div>`;
  };
  const today = ymd(new Date()), t = (D.tse && D.tse.t) || (D.otc && D.otc.t) || '';
  let note;
  if (D.closeOnly) note = `${D.date} 收盤`;
  else if (D.date !== today) note = `${D.date} 收盤（今天還沒開盤或休市）`;
  else if (D.fromPc) note = `${t}・電腦每 2 分鐘上傳，約晚 2～5 分鐘`;
  else note = `${t}${inSession() ? '・盤中每 20 秒更新' : '・今日收盤'}`;
  el.innerHTML = cell('加權指數', D.tse) + cell('櫃買指數', D.otc) + `<div class="t">${esc(note)}</div>`;
  el.classList.remove('hidden');
}
function startIndexTimer() {
  fetchIndex();
  setInterval(() => { if (!document.hidden && (inSession() || !Idx.data)) fetchIndex(); }, Native ? 20000 : 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - Idx.at > 15000) fetchIndex(); });
}

// ---------------------------------------------------------- 設定
function renderSettings() {
  const s = App.settings, f = App.my.fee, d = App.dates;
  const starts = d.slice(Math.min(60, Math.max(0, d.length - 1)));
  const cur = App.sim && App.sim.perf.length ? App.sim.perf[0].date : '';
  return `<section class="card"><h3 class="sec0">百萬模擬</h3>
    <label class="field"><span>起始日</span><select id="setStart">${starts.map(x => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="field"><span>本金</span><input id="setCap" type="number" inputmode="numeric" value="${s.capital}"></label>
    <label class="field"><span>核心組出場</span><select id="setExit">
      ${[[1, '穩健：跌破 20 日線就賣'], [2, '中庸：連 2 天才賣'], [3, '積極：連 3 天才賣']].map(([v, l]) => `<option value="${v}" ${s.exitDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="muted small">起始日前要有 60 個交易日的歷史才能判斷大盤；要更早的起始日，請先補抓歷史資料。</p>
    <button class="btn wide" data-act="saveSim">套用並重新模擬</button></section>

  <section class="card"><h3 class="sec0">我的帳戶手續費</h3>
    <label class="field"><span>手續費折扣</span><input id="feeDisc" type="number" step="0.01" inputmode="decimal" value="${f.discount}"></label>
    <label class="field"><span>整股最低手續費</span><input id="feeMin" type="number" inputmode="numeric" value="${f.minFee}"></label>
    <label class="field"><span>零股最低手續費</span><input id="feeOdd" type="number" inputmode="numeric" value="${f.minFeeOdd}"></label>
    <label class="field"><span>定期定額最低手續費</span><input id="feeDca" type="number" inputmode="numeric" value="${f.dcaFee}"></label>
    <p class="muted small">折扣：6 折填 0.6、2.8 折填 0.28。證交稅：股票 0.3%、ETF 0.1%。</p>
    <button class="btn wide" data-act="saveFee">儲存</button></section>

  ${Native ? `<section class="card"><h3 class="sec0">每日提醒</h3>
    <label class="field"><span>週一到週五提醒</span><input id="remOn" type="checkbox" ${s.reminder.on ? 'checked' : ''}></label>
    <label class="field"><span>時間</span><input id="remTime" type="time" value="${pad2(s.reminder.h)}:${pad2(s.reminder.m)}"></label>
    <button class="btn wide" data-act="saveRem">儲存</button></section>` : ''}
  ${(() => {
    const v = otaInfo();
    if (!v) return '';
    return `<section class="card"><h3 class="sec0">App 版本與更新</h3>
      <p class="small">主程式 ${esc(v.nativeVersion)}<br>畫面與功能 ${esc(v.webVersion)}（${v.webSource === 'ota' ? '已透過 OTA 更新' : 'APK 內建'}）</p>
      <button class="btn wide" data-act="otaCheck">檢查更新</button>
      <p class="muted small">${v.configured ? '每次打開 App 會自動檢查。畫面和功能的更新不用重新安裝；主程式更新需要在系統的安裝畫面按確認。' : '這個 APK 建置時還沒有設定網站，沒有 OTA 更新功能。'}</p></section>`;
  })()}
  ${IS_WEB ? `<section class="card"><h3 class="sec0">Android App</h3>
    <p class="small">Android 手機可以安裝 App 版：即時排行直接向證交所抓（幾秒延遲），還有每日提醒，之後也會自動更新。</p>
    <a class="btn wide filebtn" href="android.html">下載 Android App</a></section>` : ''}
  ${IS_WEB && !isStandalone() && !IS_ANDROID_BROWSER ? `<section class="card warn"><b>建議加到主畫面</b><p class="small">在 Safari 按下方「分享」→「加入主畫面」，之後從主畫面圖示打開。
    直接在 Safari 裡使用的話，太久沒開時 Safari 可能會清掉這個網站的資料（包括我的帳戶），加到主畫面就不會。</p></section>` : ''}

  <section class="card"><h3 class="sec0">資料</h3>
    <p class="small">收盤資料 ${d.length} 天（${d[0] || '—'} ～ ${d[d.length - 1] || '—'}）<br>基本面快照 ${App.funds.length} 份（最新 ${App.funds[App.funds.length - 1]?.date || '—'}）</p>
    <button class="btn wide" data-act="sync" ${App.busy ? 'disabled' : ''}>立即更新</button>
    <button class="btn wide ghost" data-act="older" ${App.busy ? 'disabled' : ''}>補抓更早 3 個月的歷史</button>
    <p class="muted small">資料來源：臺灣證券交易所公開資料（只有上市股票）。證交所有流量限制，每天約 3 秒抓一次，補抓 3 個月大約 3 分鐘。${IS_WEB
      ? '網頁版的營收、淨值比、殖利率由電腦每天收盤後上傳（證交所不允許網頁直接讀取這些資料），收盤價則手機也會自己下載。' : ''}</p></section>

  <section class="card"><h3 class="sec0">備份</h3>
    <button class="btn wide" data-act="exportBackup">匯出備份（我的帳戶＋設定）</button>
    <button class="btn wide ghost" data-act="importBackup">匯入備份</button>
    <p class="muted small">換手機、清除資料前先匯出備份。備份可以在 Android 版和 iPhone 網頁版之間互相匯入。</p></section>

  <section class="card"><h3 class="sec0">其他</h3>
    <button class="btn wide danger" data-act="resetMy">清空我的帳戶</button>
    <p class="muted small">本 App 產生的是策略模擬的紙上交易紀錄，不是投資建議。回放過去日期時，營收和淨值比可能用到較晚的快照，會有偷看未來的偏差。</p></section>`;
}

// ============================================================ 圖表（canvas）
function chartBlock(key) {
  const c = App.charts[key];
  return `<div class="legend">${c.series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div><canvas class="chart" data-chart="${key}"></canvas>`;
}
function cssColor(v) {
  if (!v.startsWith('var(')) return v;
  return getComputedStyle(document.body).getPropertyValue(v.slice(4, -1)).trim();
}
function drawCharts() {
  document.querySelectorAll('canvas[data-chart]').forEach(cv => {
    const spec = App.charts[cv.dataset.chart];
    if (!spec) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const P = { l: 6, r: 58, t: 8, b: 20 };
    let min = Infinity, max = -Infinity;
    for (const s of spec.series) for (const v of s.data) if (v != null && isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
    if (spec.pct) { min = Math.min(min, 0); max = Math.max(max, 0); }
    if (min === max) { min -= 1; max += 1; }
    const span = max - min; min -= span * 0.06; max += span * 0.06;
    const n = spec.labels.length;
    const X = i => P.l + (w - P.l - P.r) * (n <= 1 ? 0.5 : i / (n - 1));
    const Y = v => P.t + (h - P.t - P.b) * (1 - (v - min) / (max - min));
    const fmt = v => (spec.pct ? (v * 100).toFixed(1) + '%' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(1) + '萬' : Math.round(v));
    ctx.font = '11px sans-serif'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = cssColor('var(--line)'); ctx.fillStyle = cssColor('var(--muted)'); ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = min + (max - min) * k / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(w - P.r, y); ctx.stroke();
      ctx.fillText(fmt(v), w - P.r + 6, y);
    }
    ctx.textBaseline = 'alphabetic';
    if (n) {
      ctx.textAlign = 'left'; ctx.fillText(spec.labels[0].slice(5), P.l, h - 4);
      ctx.textAlign = 'right'; ctx.fillText(spec.labels[n - 1].slice(5), w - P.r, h - 4);
      ctx.textAlign = 'left';
    }
    for (const s of spec.series) {
      ctx.strokeStyle = cssColor(s.color); ctx.lineWidth = 2; ctx.setLineDash(s.dash ? [4, 4] : []);
      ctx.beginPath();
      let started = false;
      s.data.forEach((v, i) => { if (v == null) return; if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v)); });
      if (n === 1 && started) { ctx.arc(X(0), Y(s.data[0]), 2, 0, 7); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
}

// ============================================================ 表單（底部彈出視窗）
function openSheet(title, body, onSubmit, onInput) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = `<form id="sheetForm">${body}<div class="err" id="sheetErr"></div><button class="btn wide" type="submit">確定</button></form>`;
  $('#sheet').classList.remove('hidden');
  App.sheet = { onSubmit, onInput };
  if (onInput) onInput();
}
function closeSheet() { $('#sheet').classList.add('hidden'); App.sheet = null; }
window.onAndroidBack = () => { if (App.sheet) { closeSheet(); return true; } return false; };
const fv = id => document.getElementById(id).value.trim();

function stockDatalist() {
  const last = App.days[App.days.length - 1];
  const codes = last ? Object.keys(last.q) : [];
  return `<datalist id="stockList">${codes.map(c => `<option value="${c}">${esc(nm(c))}</option>`).join('')}</datalist>`;
}
const defaultDate = () => App.dates[App.dates.length - 1] || ymd(new Date());

function openCash(type) {
  openSheet(type === 'DEPOSIT' ? '入金' : '出金', `
    <label class="field"><span>金額</span><input id="fAmt" type="number" inputmode="numeric" placeholder="例如 100000" required></label>
    <label class="field"><span>日期</span><input id="fDate" type="date" value="${defaultDate()}" required></label>
    <label class="field"><span>備註</span><input id="fNote" placeholder="選填"></label>`, () => {
    const amount = num(fv('fAmt'));
    if (!amount || amount <= 0) throw new Error('請輸入金額');
    addTxn({ date: fv('fDate'), type, amount, shares: 0, price: 0, fee: 0, tax: 0, note: fv('fNote') });
    return `${TXN_LABEL[type]} ${money(amount)} 元`;
  });
}

function openTrade(side, code, price) {
  const st = myState();
  const holdOpts = Object.keys(st.hold).map(c => `<option value="${c}" ${c === code ? 'selected' : ''}>${c} ${esc(nm(c))}（${st.hold[c].shares.toLocaleString()} 股）</option>`).join('');
  const codeField = side === 'BUY'
    ? `<label class="field"><span>股票代號</span><input id="fCode" list="stockList" inputmode="numeric" value="${code || ''}" required></label>${stockDatalist()}`
    : `<label class="field"><span>股票</span><select id="fCode">${holdOpts}</select></label>`;
  if (side === 'SELL' && !holdOpts) { toast('目前沒有持股可以賣'); return; }
  let lastKey = '', first = true;
  openSheet(side === 'BUY' ? '買進' : '賣出', `${codeField}
    <div class="muted small" id="fName"></div>
    <label class="field"><span>日期</span><input id="fDate" type="date" value="${defaultDate()}" required></label>
    <label class="field"><span>成交價</span><input id="fPx" type="number" step="0.01" inputmode="decimal" value="${price || ''}" required></label>
    <label class="field"><span>股數</span><input id="fSh" type="number" inputmode="numeric" placeholder="1 張 = 1000 股" required></label>
    <div class="chips"><button type="button" data-sh="1000">1 張</button><button type="button" data-sh="100">+100 股</button><button type="button" data-sh="all">${side === 'SELL' ? '全部' : '清除'}</button></div>
    <div class="calc" id="fCalc"></div>`, () => {
    const c = fv('fCode'), p = num(fv('fPx')), sh = Math.floor(num(fv('fSh')) || 0);
    if (!c) throw new Error('請輸入股票代號');
    if (!p || p <= 0 || sh <= 0) throw new Error('請輸入成交價和股數');
    const amount = p * sh, fee = myFee(amount, sh), tax = side === 'SELL' ? myTax(amount, c) : 0;
    addTxn({ date: fv('fDate'), type: side, code: c, shares: sh, price: p, amount, fee, tax, note: '' });
    return `${TXN_LABEL[side]} ${nm(c)} ${sh.toLocaleString()} 股`;
  }, () => {
    const c = fv('fCode'), date = fv('fDate');
    $('#fName').textContent = c ? (App.names[c] ? nm(c) : '（不在上市資料裡，請自己輸入成交價）') : '';
    const key = c + '|' + date;
    if (key !== lastKey && c && date) {   // 換了股票或日期才自動帶入當天收盤價（第一次開啟時保留傳進來的價格）
      lastKey = key;
      const p = priceOn(c, date);
      if (p && !(first && price)) $('#fPx').value = p.price;
      if (side === 'SELL' && st.hold[c]) $('#fSh').value = st.hold[c].shares;
      first = false;
    }
    const p = num(fv('fPx')), sh = Math.floor(num(fv('fSh')) || 0);
    if (!p || !sh) { $('#fCalc').innerHTML = `<span class="muted">可用現金 ${money(st.cash)}</span>`; return; }
    const amount = p * sh, fee = myFee(amount, sh);
    if (side === 'BUY') {
      $('#fCalc').innerHTML = `成交金額 ${money(amount)}・手續費 ${money(fee)}<br><b>應付 ${money(amount + fee)}</b>　<span class="muted">可用現金 ${money(st.cash)}</span>`;
    } else {
      const tax = myTax(amount, c), h = st.hold[c], pnl = h ? amount - fee - tax - h.cost / h.shares * sh : null;
      $('#fCalc').innerHTML = `成交金額 ${money(amount)}・手續費 ${money(fee)}・證交稅 ${money(tax)}<br><b>實收 ${money(amount - fee - tax)}</b>${pnl != null ? `　預估損益 <b class="${ud(pnl)}">${signMoney(pnl)}</b>` : ''}`;
    }
  });
  document.querySelectorAll('.chips button').forEach(b => b.addEventListener('click', () => {
    const el = $('#fSh'), cur = Math.floor(num(el.value) || 0);
    if (b.dataset.sh === 'all') el.value = side === 'SELL' ? (st.hold[fv('fCode')]?.shares || '') : '';
    else el.value = b.dataset.sh === '1000' ? cur + 1000 : cur + 100;
    App.sheet.onInput();
  }));
}

// 記錄股利：從「待確認股利」帶入（pre）或手動輸入
function openDividend(pre) {
  pre = pre || {};
  const exDate = pre.date || defaultDate();
  openSheet('記錄股利', `
    <label class="field"><span>股票代號</span><input id="fCode" list="stockList" inputmode="numeric" value="${pre.code || ''}" required></label>${stockDatalist()}
    <div class="muted small" id="fName"></div>
    <label class="field"><span>除權息日</span><input id="fEx" type="date" value="${exDate}" required></label>
    <label class="field"><span>入帳日期</span><input id="fDate" type="date" value="${pre.date || defaultDate()}" required></label>
    <label class="field"><span>當時持股</span><input id="fSh" type="number" inputmode="numeric" value="${pre.shares || ''}"></label>
    <label class="field"><span>每股現金股利</span><input id="fCash" type="number" step="0.0001" inputmode="decimal" value="${pre.cash ?? ''}"></label>
    <label class="field"><span>每股配股（股）</span><input id="fStock" type="number" step="0.0001" inputmode="decimal" value="${pre.stock || 0}"></label>
    <label class="field"><span>二代健保</span><input id="fNhi" type="number" inputmode="numeric" placeholder="自動"></label>
    <label class="field"><span>匯費</span><input id="fRemit" type="number" inputmode="numeric" value="10"></label>
    <div class="calc" id="fCalc"></div>
    <p class="muted small">二代健保：單次股利 2 萬元以上扣 2.11%（留空自動算）。配股不足 1 股的部分不計。</p>`, () => {
    const c = fv('fCode'), sh = Math.floor(num(fv('fSh')) || 0), x = calc();
    if (!c) throw new Error('請輸入股票代號');
    if (!x.gross && !x.add) throw new Error('請輸入持股和每股股利');
    addTxn({ date: fv('fDate'), type: 'DIV', code: c, shares: x.add, price: num(fv('fCash')) || 0, amount: x.gross, fee: x.nhi + x.remit, tax: 0,
      divKey: pre.divKey || null, note: `除權息日 ${fv('fEx')}・持股 ${sh.toLocaleString()} 股` });
    return `已記錄 ${nm(c)} 股利 ${money(x.gross - x.nhi - x.remit)} 元` + (x.add ? `、配股 ${x.add} 股` : '');
  }, () => {
    const c = fv('fCode');
    $('#fName').textContent = c ? nm(c) : '';
    if (!pre.shares && c && fv('fEx') && !fv('fSh')) {   // 手動輸入時自動帶入除權息前一天的持股
      const s = sharesBefore(App.my.txns, c, fv('fEx'));
      if (s > 0) $('#fSh').value = s;
    }
    const x = calc();
    $('#fCalc').innerHTML = `現金股利 ${money(x.gross)}・二代健保 ${money(x.nhi)}・匯費 ${money(x.remit)}<br><b>實收 ${money(x.gross - x.nhi - x.remit)}</b>${x.add ? `　配股 <b>${x.add.toLocaleString()}</b> 股` : ''}`;
  });
  function calc() {
    const sh = Math.floor(num(fv('fSh')) || 0), gross = Math.floor(sh * (num(fv('fCash')) || 0));
    const nhiIn = num(fv('fNhi')), remit = gross > 0 ? Math.max(0, num(fv('fRemit')) ?? 10) : 0;
    const nhi = nhiIn != null ? Math.max(0, nhiIn) : dividendNet(gross).nhi;
    return { gross, nhi, remit, add: Math.floor(sh * (num(fv('fStock')) || 0)) };
  }
}

function openDCA() {
  openSheet('新增定期定額', `
    <label class="field"><span>股票代號</span><input id="fCode" list="stockList" inputmode="numeric" placeholder="例如 0050" required></label>${stockDatalist()}
    <div class="muted small" id="fName"></div>
    <label class="field"><span>每次金額</span><input id="fAmt" type="number" inputmode="numeric" value="3000" required></label>
    <label class="field"><span>每月扣款日</span><input id="fDays" value="6" placeholder="例如 6,16,26"></label>
    <label class="field"><span>開始日期</span><input id="fStart" type="date" value="${ymd(new Date())}" required></label>
    <p class="muted small">扣款日可以填多個，用逗號分開（1～28）。開始日期可以設在過去，會自動補上已經發生的扣款。</p>`, () => {
    const code = fv('fCode'), amount = num(fv('fAmt'));
    const days = [...new Set(fv('fDays').split(/[,，、\s]+/).map(Number).filter(x => x >= 1 && x <= 28))].sort((a, b) => a - b);
    if (!code) throw new Error('請輸入股票代號');
    if (!amount || amount < 100) throw new Error('每次金額至少 100 元');
    if (!days.length) throw new Error('請輸入扣款日（1～28）');
    App.my.plans.push({ id: ++App.my.seq, code, amount, days, start: fv('fStart'), active: true, lastRun: null });
    saveMy();
    const n = runDCA();
    return `已新增 ${nm(code)} 定期定額` + (n ? `，補上 ${n} 次扣款` : '');
  }, () => { const c = fv('fCode'); $('#fName').textContent = c ? nm(c) : ''; });
}

// ============================================================ 事件
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { App.tab = tab.dataset.tab; App.viewDate = null; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, code = el.dataset.code, id = +el.dataset.id;
  switch (act) {
    case 'sync': syncData(); break;
    case 'rankMode': Rank.mode = el.dataset.v; render(); break;
    case 'rankBy': Rank.by = el.dataset.v; render(); break;
    case 'rankEtf': Rank.etf = el.dataset.v === '1'; render(); break;
    case 'rankMkt': Rank.mkt = el.dataset.v; render(); break;
    case 'rankRefresh': fetchLiveRank(); break;
    case 'older': if (App.dates.length) syncData({ from: addDays(App.dates[0], -92), to: addDays(App.dates[0], -1) }); break;
    case 'closeSheet': closeSheet(); break;
    case 'deposit': openCash('DEPOSIT'); break;
    case 'withdraw': openCash('WITHDRAW'); break;
    case 'buy': openTrade('BUY'); break;
    case 'sell': openTrade('SELL'); break;
    case 'dca': openDCA(); break;
    case 'dividend': openDividend(); break;
    case 'divConfirm': { const p = pendingDividends().find(x => x.divKey === el.dataset.key); if (p) openDividend(p); break; }
    case 'divDismiss': (App.my.dismissed || (App.my.dismissed = [])).push(el.dataset.key); saveMy(); render(); toast('已忽略，之後不再提醒'); break;
    case 'quickBuy': { const p = priceOn(code, defaultDate()); openTrade('BUY', code, p && p.price); break; }
    case 'quickSell': openTrade('SELL', code); break;
    case 'togglePlan': { const p = App.my.plans.find(x => x.id === id); p.active = !p.active; saveMy(); if (p.active) runDCA(); render(); break; }
    case 'delPlan': if (confirm('刪除這個定期定額計畫？（已成交的紀錄會保留）')) { App.my.plans = App.my.plans.filter(x => x.id !== id); saveMy(); render(); } break;
    case 'delTxn': {
      if (!confirm('刪除這筆紀錄？')) break;
      const next = App.my.txns.filter(x => x.id !== id);
      try { replay(next); App.my.txns = next; saveMy(); render(); } catch (err) { toast('不能刪除：' + err.message); }
      break;
    }
    case 'export': exportStatement(); break;
    case 'otaCheck': if (Native && Native.checkUpdate) { Native.checkUpdate(); toast('檢查更新中…'); } break;
    case 'otaApply': if (Native && Native.applyWebUpdate) Native.applyWebUpdate(); break;
    case 'otaInstall': if (Native && Native.installApk) Native.installApk(); break;
    case 'getApk': location.href = 'android.html'; break;
    case 'exportBackup': exportBackup(); break;
    case 'importBackup': openImport(); break;
    case 'saveSim': {
      App.settings.startDate = fv('setStart');
      App.settings.capital = Math.max(10000, num(fv('setCap')) || 1000000);
      App.settings.exitDays = +fv('setExit');
      saveSettings(); computeSim(); toast('已重新模擬'); App.tab = 'sim'; render(); break;
    }
    case 'saveFee': {
      const f = App.my.fee;
      f.discount = Math.min(1, Math.max(0.01, num(fv('feeDisc')) || 1));
      f.minFee = Math.max(0, num(fv('feeMin')) ?? 20); f.minFeeOdd = Math.max(0, num(fv('feeOdd')) ?? 1); f.dcaFee = Math.max(0, num(fv('feeDca')) ?? 1);
      saveMy(); toast('已儲存，之後的交易會用新的手續費'); break;
    }
    case 'saveRem': {
      const [hh, mm] = (fv('remTime') || '17:30').split(':').map(Number);
      App.settings.reminder = { on: document.getElementById('remOn').checked, h: hh, m: mm };
      saveSettings();
      if (Native && Native.setReminder) Native.setReminder(hh, mm, App.settings.reminder.on);
      toast(App.settings.reminder.on ? `每個交易日 ${pad2(hh)}:${pad2(mm)} 提醒` : '已關閉提醒'); break;
    }
    case 'resetMy':
      if (confirm('確定清空我的帳戶？所有入金、交易、定期定額紀錄都會刪除，不能復原。')) { App.my = loadJson('__none__', MY_DEFAULT); saveMy(); render(); toast('已清空'); }
      break;
  }
});
document.addEventListener('change', e => {
  const k = e.target.dataset.change;
  if (k === 'pickDay') { App.viewDate = e.target.value; render(); }
  if (k === 'stmtMonth') { App.stmtMonth = e.target.value; render(); }
  if (k === 'btRun') { App.btRun = +e.target.value; render(); }
});
document.addEventListener('input', e => { if (App.sheet && App.sheet.onInput && e.target.closest('#sheetForm')) App.sheet.onInput(); });
document.addEventListener('submit', e => {
  if (e.target.id !== 'sheetForm') return;
  e.preventDefault();
  try { const msg = App.sheet.onSubmit(); closeSheet(); render(); toast(msg); }
  catch (err) { $('#sheetErr').textContent = err.message; }
});

function exportStatement() {
  const st = replaySafe();
  const lines = ['日期,類別,代號,名稱,股數,價格,成交金額,手續費,證交稅,現金變動,現金餘額,已實現損益,備註'];
  for (const r of st.rows) {
    const t = r.t;
    lines.push([t.date, TXN_LABEL[t.type], t.code || '', t.code ? nm(t.code) : '', t.shares || '', t.price || '', Math.round(t.amount || 0),
      t.fee || 0, t.tax || 0, Math.round(cashDelta(t)), Math.round(r.cash), r.pnl != null ? Math.round(r.pnl) : '', (t.note || '').replace(/,/g, ' ')].join(','));
  }
  saveText(`對帳單_${ymd(new Date())}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}
function replaySafe() { try { return replay(App.my.txns); } catch (e) { return { rows: [] }; } }

// 存成檔案：Android 用系統分享；iPhone 用分享面板（可存到「檔案」）；不支援就直接下載
async function saveText(name, text, type) {
  if (Native && Native.shareText) { Native.shareText(name, text); return; }
  try {
    const file = new File([text], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  toast('已下載 ' + name);
}

function exportBackup() {
  const text = JSON.stringify({ app: 'twstock', version: 1, exportedAt: new Date().toISOString(), my: App.my, settings: App.settings });
  saveText(`台股策略備份_${ymd(new Date())}.json`, text, 'application/json');
}
function importBackup(text) {
  let b;
  try { b = JSON.parse(text); } catch (e) { throw new Error('內容不是正確的備份檔'); }
  if (!b || b.app !== 'twstock' || !b.my) throw new Error('不是這個 App 的備份檔');
  replay(b.my.txns || []);
  App.my = Object.assign(JSON.parse(JSON.stringify(MY_DEFAULT)), b.my);
  if (b.settings) App.settings = Object.assign(JSON.parse(JSON.stringify(SETTINGS_DEFAULT)), b.settings);
  saveMy(); saveSettings(); computeSim(); runDCA();
}
function openImport() {
  openSheet('匯入備份', `<p class="small">匯入會<b>取代</b>目前「我的帳戶」的所有紀錄和設定。</p>
    <label class="btn wide ghost filebtn">選擇備份檔<input type="file" id="fFile" accept=".json,application/json,text/plain" hidden></label>
    <p class="muted small center">或把備份檔的內容貼在下面</p>
    <textarea id="fText" rows="5" placeholder='{"app":"twstock", …}'></textarea>`, () => {
    importBackup(fv('fText'));
    return `已匯入備份：${App.my.txns.length} 筆紀錄、${App.my.plans.length} 個定期定額`;
  });
  $('#fFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) f.text().then(t => { $('#fText').value = t; });
  });
}
// ============================================================ Android OTA 更新
// 原生端啟動時自動檢查；網頁更新下載完就顯示「立即套用」，APK 更新則提示下載安裝（系統會再問一次）
const otaInfo = () => { try { return Native && Native.getVersionInfo ? JSON.parse(Native.getVersionInfo()) : null; } catch (e) { return null; } };
function otaBanner(text, act, label) {
  const el = $('#ota');
  el.innerHTML = `<span>${esc(text)}</span>${act ? `<button data-act="${act}">${label}</button>` : ''}`;
  el.classList.remove('hidden');
}
window.__otaEvent = ev => {
  if (ev.type === 'web-ready') otaBanner('新版本已下載完成', 'otaApply', '立即套用');
  else if (ev.type === 'apk-available') otaBanner(`App 主程式有新版 ${ev.versionName}${ev.notes ? '：' + ev.notes : ''}`, 'otaInstall', '下載安裝');
  else if (ev.type === 'apk-downloading') otaBanner('正在下載新版 App，完成後會出現安裝畫面…');
  else if (ev.type === 'need-permission') toast('請在設定裡允許「安裝不明應用程式」，回來後再按一次下載安裝');
  else if (ev.type === 'none' && ev.manual) toast('已經是最新版本');
  else if (ev.type === 'error' && ev.manual) toast(ev.msg);
  if (App.tab === 'settings' && ev.manual) render();
};

const IS_ANDROID_BROWSER = IS_WEB && /Android/i.test(navigator.userAgent);
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

// ============================================================ 啟動
async function boot() {
  await Store.ready;
  App.settings = loadJson('settings.json', SETTINGS_DEFAULT);
  App.my = loadJson('my.json', MY_DEFAULT);
  loadData();
  if (IS_WEB) {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (!App.dates.length) { $('#main').innerHTML = empty('第一次使用，正在下載歷史資料…'); setStatus('從網站同步資料…', 0); }
    if (await mergeServerData()) loadData();
    setStatus(null);
  }
  computeSim();
  runDCA();
  render();
  if (Native && Native.bootOk) Native.bootOk();   // 告訴 OTA 這個版本能正常開機
  startIndexTimer();
  if (IS_ANDROID_BROWSER) otaBanner('這支 Android 手機可以安裝 App 版（即時排行更快）', 'getApk', '下載');
  if (Native && Native.setReminder) Native.setReminder(App.settings.reminder.h, App.settings.reminder.m, App.settings.reminder.on);
  const last = App.dates[App.dates.length - 1];
  if ((Native || IS_WEB) && (!last || last < lastExpectedTradingDay())) syncData();
  else {
    if ((Native || IS_WEB) && !App.divList.length && last) {
      syncDividends().then(() => { computeSim(); render(); }).catch(() => {}).finally(() => setStatus(null));
    }
    if (Native && last && !App.otc[last]) syncOtc().then(() => { if (App.tab === 'rank') render(); });
  }
  if (IS_WEB && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
window.addEventListener('resize', drawCharts);
boot();
