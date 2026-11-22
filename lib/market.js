// lib/market.js
// Курсы без платных ключей. Цепочка источников с пометкой свежести:
//   RUB-пары: Мосбиржа (внутридневной) -> ЦБ РФ -> Coinbase -> кросс через доллар -> open.er-api -> CDN
//   остальные пары (гривна, тенге, иена, лира, лари, злотый, дирхам, сум, сом...):
//     Coinbase -> кросс через доллар -> open.er-api -> ЕЦБ -> CDN
//   крипта: CoinGecko (+24ч) -> Kraken -> Coinbase
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const cache = global.__tjrMarket || (global.__tjrMarket = new Map());

const numEnv = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const CALL_TIMEOUT = numEnv('MARKET_TIMEOUT_MS', 3500);
const TOTAL_BUDGET = numEnv('MARKET_BUDGET_MS', 8000);

const n = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') { const x = Number(v); if (Number.isFinite(x) && x > 0) return x; }
  return null;
};
const up = (s) => String(s || '').trim().toUpperCase();
const budgetOf = (opts) => (opts && opts.deadline ? opts.deadline : Date.now() + TOTAL_BUDGET);
const leftOf = (b) => b - Date.now();
const tmo = (b) => Math.max(800, Math.min(CALL_TIMEOUT, leftOf(b) - 300));

async function jget(url, { ttl = 60000, timeout = CALL_TIMEOUT } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? m[3] + '.' + m[2] : '';
}
function thousands(v) {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function fmtValue(v) {
  if (v >= 1000) return thousands(v);
  if (v >= 100) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}
function fmtPair(f, t, r) {
  const tag = r.src + (r.fresh ? ', ' + r.fresh : '');
  return '1 ' + f + ' = ' + fmtValue(r.value) + ' ' + t + ' [' + tag + ']';
}
function fmtUsd(v) {
  if (v >= 1000) return thousands(v);
  return v >= 1 ? v.toFixed(2) : v.toFixed(6);
}

// ───────────── Мосбиржа ─────────────
const MOEX_URL = 'https://iss.moex.com/iss/engines/currency/markets/selt/boards/CETS/securities.json' +
  '?iss.meta=off&iss.only=marketdata,securities' +
  '&marketdata.columns=SECID,LAST,LCURRENTPRICE,UPDATETIME' +
  '&securities.columns=SECID,PREVPRICE,PREVDATE';

const MOEX_SEC = {
  USD: ['USD000UTSTOM', 'USD000000TOD'],
  EUR: ['EUR_RUB__TOM', 'EUR_RUB__TOD'],
  CNY: ['CNYRUB_TOM', 'CNYRUB_TOD']
};

function moexTable(block) {
  if (!block || !Array.isArray(block.columns) || !Array.isArray(block.data)) return [];
  return block.data.map((row) => {
    const o = {};
    block.columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

async function moexRates(timeout) {
  const d = await jget(MOEX_URL, { ttl: 60000, timeout });
  const md = moexTable(d && d.marketdata);
  const sec = moexTable(d && d.securities);
  const out = {};
  for (const cur of Object.keys(MOEX_SEC)) {
    for (const id of MOEX_SEC[cur]) {
      const m = md.find((x) => x.SECID === id);
      const live = m ? (n(m.LAST) || n(m.LCURRENTPRICE)) : null;
      if (live) {
        out[cur] = { value: live, src: 'Мосбиржа', fresh: 'живой, ' + String(m.UPDATETIME || '').slice(11, 16) + ' МСК', live: true };
        break;
      }
      const s = sec.find((x) => x.SECID === id);
      const prev = s ? n(s.PREVPRICE) : null;
      if (prev && !out[cur]) {
        out[cur] = { value: prev, src: 'Мосбиржа', fresh: 'закрытие ' + dayLabel(s.PREVDATE) + ', биржа сейчас закрыта', live: false };
      }
    }
  }
  if (!Object.keys(out).length) throw new Error('пустая выдача MOEX');
  return out;
}

async function cbrRates(timeout) {
  const d = await jget('https://www.cbr-xml-daily.ru/daily_json.js', { ttl: 6 * 3600000, timeout });
  const out = {};
  const day = dayLabel(d && d.Date);
  for (const cur of ['USD', 'EUR', 'CNY']) {
    const v = d && d.Valute && d.Valute[cur];
    const val = v ? n(v.Value) : null;
    if (val) out[cur] = { value: val / (v.Nominal || 1), src: 'ЦБ РФ', fresh: 'официальный на ' + day, live: false };
  }
  if (!Object.keys(out).length) throw new Error('пустой ЦБ');
  return out;
}

async function coinbaseRates(base, timeout) {
  const d = await jget('https://api.coinbase.com/v2/exchange-rates?currency=' + up(base), { ttl: 300000, timeout });
  const rates = d && d.data && d.data.rates;
  if (!rates || typeof rates !== 'object') throw new Error('нет rates');
  return rates;
}

async function erApi(from, to, timeout) {
  const d = await jget('https://open.er-api.com/v6/latest/' + up(from), { ttl: 6 * 3600000, timeout });
  const v = d && d.rates ? n(d.rates[up(to)]) : null;
  if (!v) throw new Error('нет пары');
  const day = d.time_last_update_unix ? dayLabel(new Date(d.time_last_update_unix * 1000).toISOString()) : '';
  return { value: v, src: 'open.er-api', fresh: 'суточный, обновлён ' + day, live: false };
}

async function frankfurter(from, to, timeout) {
  const d = await jget('https://api.frankfurter.app/latest?from=' + up(from) + '&to=' + up(to), { ttl: 6 * 3600000, timeout });
  const v = d && d.rates ? n(d.rates[up(to)]) : null;
  if (!v) throw new Error('нет пары');
  return { value: v, src: 'ЕЦБ', fresh: 'суточный на ' + dayLabel(d.date), live: false };
}

async function cdnRates(from, to, timeout) {
  const f = String(from).toLowerCase();
  const t = String(to).toLowerCase();
  const urls = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/' + f + '.json',
    'https://latest.currency-api.pages.dev/v1/currencies/' + f + '.json'
  ];
  let lastErr = 'нет данных';
  for (const u of urls) {
    try {
      const d = await jget(u, { ttl: 6 * 3600000, timeout });
      const v = d && d[f] ? n(d[f][t]) : null;
      if (v) return { value: v, src: 'currency-api', fresh: 'суточный на ' + dayLabel(d.date), live: false };
      lastErr = 'нет пары ' + f + '/' + t;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

// Таблица «сколько единиц валюты за 1 доллар». Основа для любых кроссов.
async function usdTable(b) {
  const hit = cache.get('__usdTable');
  if (hit && Date.now() - hit.at < 120000) return hit.data;
  const table = { USD: 1 };
  try {
    const r = await coinbaseRates('USD', tmo(b));
    for (const k of Object.keys(r)) { const v = n(r[k]); if (v) table[up(k)] = v; }
  } catch (_) { /* пойдём дальше */ }
  if (!table.RUB && leftOf(b) > 1200) {
    try { const m = await moexRates(tmo(b)); if (m.USD) table.RUB = m.USD.value; } catch (_) {}
  }
  if (!table.RUB && leftOf(b) > 1200) {
    try { const c = await cbrRates(tmo(b)); if (c.USD) table.RUB = c.USD.value; } catch (_) {}
  }
  if (Object.keys(table).length < 20 && leftOf(b) > 1200) {
    try {
      const d = await jget('https://open.er-api.com/v6/latest/USD', { ttl: 6 * 3600000, timeout: tmo(b) });
      for (const k of Object.keys((d && d.rates) || {})) {
        const v = n(d.rates[k]);
        if (v && !table[up(k)]) table[up(k)] = v;
      }
    } catch (_) {}
  }
  if (Object.keys(table).length < 3) throw new Error('таблица валют пуста');
  cache.set('__usdTable', { at: Date.now(), data: table });
  return table;
}

async function getPairData(from, to, opts = {}) {
  const f = up(from);
  const t = up(to);
  if (!f || !t) return 'Пара не указана';
  if (f === t) return '1 ' + f + ' = 1 ' + t + ' [это одна и та же бумажка]';
  const b = budgetOf(opts);
  const errors = [];
  const step = async (fn) => {
    if (leftOf(b) < 1200) throw new Error('бюджет времени вышел');
    return fn(tmo(b));
  };

  if (t === 'RUB' && MOEX_SEC[f]) {
    try { const m = await step(moexRates); if (m[f]) return fmtPair(f, t, m[f]); } catch (e) { errors.push('MOEX: ' + e.message); }
    try { const c = await step(cbrRates); if (c[f]) return fmtPair(f, t, c[f]); } catch (e) { errors.push('ЦБ: ' + e.message); }
  }
  if (f === 'RUB' && MOEX_SEC[t]) {
    try {
      const m = await step(moexRates);
      if (m[t]) return fmtPair(f, t, { ...m[t], value: 1 / m[t].value });
    } catch (e) { errors.push('MOEX: ' + e.message); }
    try {
      const c = await step(cbrRates);
      if (c[t]) return fmtPair(f, t, { ...c[t], value: 1 / c[t].value });
    } catch (e) { errors.push('ЦБ: ' + e.message); }
  }
  if (MOEX_SEC[f] && MOEX_SEC[t]) {
    try {
      const m = await step(moexRates);
      if (m[f] && m[t]) {
        const live = !!(m[f].live && m[t].live);
        return fmtPair(f, t, {
          value: m[f].value / m[t].value,
          src: 'кросс через Мосбиржу',
          fresh: live ? 'живой' : 'по последним ценам биржи',
          live
        });
      }
    } catch (e) { errors.push('MOEX-кросс: ' + e.message); }
  }

  try {
    const r = await step((tm) => coinbaseRates(f, tm));
    const v = n(r[t]);
    if (v) return fmtPair(f, t, { value: v, src: 'Coinbase', fresh: 'свежий', live: true });
  } catch (e) { errors.push('Coinbase: ' + e.message); }

  try {
    const tbl = await usdTable(b);
    const vf = tbl[f];
    const vt = tbl[t];
    if (vf && vt) {
      return fmtPair(f, t, { value: vt / vf, src: 'кросс через доллар', fresh: 'свежий', live: true });
    }
    errors.push('кросс: нет ' + (vf ? t : f));
  } catch (e) { errors.push('кросс: ' + e.message); }

  try { return fmtPair(f, t, await step((tm) => erApi(f, t, tm))); } catch (e) { errors.push('er-api: ' + e.message); }
  if (f !== 'RUB' && t !== 'RUB') {
    try { return fmtPair(f, t, await step((tm) => frankfurter(f, t, tm))); } catch (e) { errors.push('ЕЦБ: ' + e.message); }
  }
  try { return fmtPair(f, t, await step((tm) => cdnRates(f, t, tm))); } catch (e) { errors.push('CDN: ' + e.message); }

  return 'Курс ' + f + '/' + t + ' не загрузился (' + errors.slice(0, 3).join('; ') + ')';
}

async function getRubData(fromCurr, opts = {}) {
  const f = up(fromCurr);
  return f === 'RUB' ? getPairData('RUB', 'USD', opts) : getPairData(f, 'RUB', opts);
}

// ───────────── крипта ─────────────
const CRYPTO_IDS = {
  btc: 'bitcoin', bitcoin: 'bitcoin', биткоин: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum', эфир: 'ethereum', эфириум: 'ethereum',
  sol: 'solana', solana: 'solana',
  ton: 'the-open-network', toncoin: 'the-open-network', тон: 'the-open-network',
  bnb: 'binancecoin', binancecoin: 'binancecoin',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  xrp: 'ripple', ripple: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  trx: 'tron', tron: 'tron',
  ltc: 'litecoin', litecoin: 'litecoin'
};
const KRAKEN_TOKEN = { bitcoin: 'XBT', ethereum: 'ETH', solana: 'SOL', 'the-open-network': 'TON', ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', litecoin: 'LTC', tron: 'TRX' };
const CB_SYM = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', 'the-open-network': 'TON', binancecoin: 'BNB', dogecoin: 'DOGE', ripple: 'XRP', cardano: 'ADA', tron: 'TRX', litecoin: 'LTC' };
const normCoin = (c) => CRYPTO_IDS[String(c || '').toLowerCase().trim()] || String(c || '').toLowerCase().trim();

async function krakenPrices(ids, timeout) {
  const wanted = ids.map((id) => KRAKEN_TOKEN[id]).filter(Boolean);
  if (!wanted.length) return {};
  const pairs = wanted.map((t) => (t === 'XBT' ? 'XBTUSD' : t + 'USD')).join(',');
  const d = await jget('https://api.kraken.com/0/public/Ticker?pair=' + pairs, { ttl: 60000, timeout });
  const res = (d && d.result) || {};
  const out = {};
  for (const id of ids) {
    const tok = KRAKEN_TOKEN[id];
    if (!tok) continue;
    const key = Object.keys(res).find((k) => k.includes(tok));
    const price = key && res[key] && Array.isArray(res[key].c) ? n(res[key].c[0]) : null;
    if (price) out[id] = price;
  }
  return out;
}

async function coinbaseSpot(id, timeout) {
  const sym = CB_SYM[id];
  if (!sym) return null;
  const d = await jget('https://api.coinbase.com/v2/prices/' + sym + '-USD/spot', { ttl: 60000, timeout });
  return d && d.data ? n(d.data.amount) : null;
}

async function getCryptoData(coins = ['bitcoin', 'ethereum'], opts = {}) {
  const ids = [...new Set((coins || []).map(normCoin).filter(Boolean))];
  if (!ids.length) return 'Монеты не распознала';
  const b = budgetOf(opts);
  const got = {};
  const changes = {};
  const srcs = new Set();
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids.join(',') + '&vs_currencies=usd&include_24hr_change=true';
    const d = await jget(url, { ttl: 60000, timeout: tmo(b) });
    for (const id of ids) {
      const row = d && d[id];
      const v = row ? n(row.usd) : null;
      if (v) {
        got[id] = v;
        srcs.add('CoinGecko');
        if (typeof row.usd_24h_change === 'number') changes[id] = row.usd_24h_change;
      }
    }
  } catch (e) { console.error('market coingecko:', e.message); }

  let missing = ids.filter((id) => !got[id]);
  if (missing.length && leftOf(b) > 1500) {
    try {
      const k = await krakenPrices(missing, tmo(b));
      for (const id of Object.keys(k)) { got[id] = k[id]; srcs.add('Kraken'); }
    } catch (e) { console.error('market kraken:', e.message); }
  }
  missing = ids.filter((id) => !got[id]);
  if (missing.length && leftOf(b) > 1500) {
    const jobs = missing.slice(0, 4).map(async (id) => {
      try {
        const v = await coinbaseSpot(id, tmo(b));
        if (v) { got[id] = v; srcs.add('Coinbase'); }
      } catch (_) { /* монеты может не быть */ }
    });
    await Promise.all(jobs);
  }

  const lines = [];
  for (const id of ids) {
    if (!got[id]) continue;
    const ch = typeof changes[id] === 'number'
      ? ' (' + (changes[id] >= 0 ? '+' : '') + changes[id].toFixed(1) + '% за сутки)'
      : '';
    lines.push(id + ': $' + fmtUsd(got[id]) + ch);
  }
  if (!lines.length) return 'Крипта не загрузилась ни с одного источника (CoinGecko, Kraken, Coinbase молчат)';
  return lines.join(' | ') + ' [' + [...srcs].join('/') + ', живой]';
}

// ───────────── меню и алиасы ─────────────
const CUR_NAME = {
  USD: 'Доллар', EUR: 'Евро', RUB: 'Рубль', CNY: 'Юань', UAH: 'Гривна', KZT: 'Тенге',
  GBP: 'Фунт', JPY: 'Иена', TRY: 'Лира', GEL: 'Лари', PLN: 'Злотый', AED: 'Дирхам',
  UZS: 'Сум', KGS: 'Сом', CHF: 'Франк', CAD: 'Доллар Канады', AUD: 'Доллар Австралии',
  BYN: 'Бел. рубль', AMD: 'Драм', AZN: 'Манат', MDL: 'Лей', INR: 'Рупия', KRW: 'Вона',
  BRL: 'Реал', MXN: 'Песо', ZAR: 'Рэнд', EGP: 'Фунт Египта', SAR: 'Риял', THB: 'Бат',
  VND: 'Донг', IDR: 'Рупия', MYR: 'Ринггит', PHP: 'Песо', SGD: 'Доллар Сингапура',
  HKD: 'Доллар Гонконга', TWD: 'Доллар Тайваня', NZD: 'Доллар НЗ', SEK: 'Крона Швеции',
  NOK: 'Крона Норвегии', DKK: 'Крона Дании', CZK: 'Крона Чехии', HUF: 'Форинт',
  RON: 'Лей Румынии', BGN: 'Лев', RSD: 'Динар', ISK: 'Крона Исландии', TJS: 'Сомони', TMT: 'Манат'
};
const CUR_FLAG = {
  USD: '💵', EUR: '💶', RUB: '🇷🇺', CNY: '💴', UAH: '🇺🇦', KZT: '🇰🇿', GBP: '🇬🇧',
  JPY: '🇯🇵', TRY: '🇹🇷', GEL: '🇬🇪', PLN: '🇵🇱', AED: '🇦🇪', UZS: '🇺🇿', KGS: '🇰🇬',
  CHF: '🇨🇭', CAD: '🇨🇦', AUD: '🇦🇺', BYN: '🇧🇾', AMD: '🇦🇲', AZN: '🇦🇿', MDL: '🇲🇩',
  INR: '🇮🇳', KRW: '🇰🇷', BRL: '🇧🇷', MXN: '🇲🇽', ZAR: '🇿🇦', EGP: '🇪🇬', SAR: '🇸🇦',
  THB: '🇹🇭', VND: '🇻🇳', IDR: '🇮🇩', MYR: '🇲🇾', PHP: '🇵🇭', SGD: '🇸🇬', HKD: '🇭🇰',
  TWD: '🇹🇼', NZD: '🇳🇿', SEK: '🇸🇪', NOK: '🇳🇴', DKK: '🇩🇰', CZK: '🇨🇿', HUF: '🇭🇺',
  RON: '🇷🇴', BGN: '🇧🇬', RSD: '🇷🇸', ISK: '🇮🇸', TJS: '🇹🇯', TMT: '🇹🇲'
};

const PAIRS = {
  usd_rub: { from: 'USD', to: 'RUB', label: '💵 Доллар → Рубль' },
  eur_rub: { from: 'EUR', to: 'RUB', label: '💶 Евро → Рубль' },
  cny_rub: { from: 'CNY', to: 'RUB', label: '💴 Юань → Рубль' },
  uah_rub: { from: 'UAH', to: 'RUB', label: '🇺🇦 Гривна → Рубль' },
  kzt_rub: { from: 'KZT', to: 'RUB', label: '🇰🇿 Тенге → Рубль' },
  usd_uah: { from: 'USD', to: 'UAH', label: '💵 Доллар → Гривна' },
  usd_kzt: { from: 'USD', to: 'KZT', label: '💵 Доллар → Тенге' },
  eur_usd: { from: 'EUR', to: 'USD', label: '💶 Евро → Доллар' },
  gbp_usd: { from: 'GBP', to: 'USD', label: '🇬🇧 Фунт → Доллар' },
  usd_jpy: { from: 'USD', to: 'JPY', label: '🇯🇵 Доллар → Иена' },
  usd_try: { from: 'USD', to: 'TRY', label: '🇹🇷 Доллар → Лира' },
  usd_gel: { from: 'USD', to: 'GEL', label: '🇬🇪 Доллар → Лари' },
  usd_pln: { from: 'USD', to: 'PLN', label: '🇵🇱 Доллар → Злотый' },
  usd_aed: { from: 'USD', to: 'AED', label: '🇦🇪 Доллар → Дирхам' },
  usd_uzs: { from: 'USD', to: 'UZS', label: '🇺🇿 Доллар → Сум' },
  usd_kgs: { from: 'USD', to: 'KGS', label: '🇰🇬 Доллар → Сом' }
};

const PAIR_ALIASES = {
  usd: 'usd_rub', dollar: 'usd_rub', доллар: 'usd_rub', доллары: 'usd_rub', бакс: 'usd_rub', баксы: 'usd_rub',
  eur: 'eur_rub', euro: 'eur_rub', евро: 'eur_rub',
  cny: 'cny_rub', yuan: 'cny_rub', юань: 'cny_rub', юани: 'cny_rub', китай: 'cny_rub', rmb: 'cny_rub',
  uah: 'uah_rub', гривна: 'uah_rub', гривны: 'uah_rub', гривен: 'uah_rub', грн: 'uah_rub', hryvnia: 'uah_rub', украина: 'uah_rub',
  kzt: 'kzt_rub', тенге: 'kzt_rub', тг: 'kzt_rub', казахстан: 'kzt_rub',
  jpy: 'usd_jpy', иена: 'usd_jpy', йена: 'usd_jpy', япония: 'usd_jpy',
  gbp: 'gbp_usd', фунт: 'gbp_usd', стерлинг: 'gbp_usd',
  try: 'usd_try', лира: 'usd_try', турция: 'usd_try',
  gel: 'usd_gel', лари: 'usd_gel', грузия: 'usd_gel',
  pln: 'usd_pln', злотый: 'usd_pln', польша: 'usd_pln',
  aed: 'usd_aed', дирхам: 'usd_aed', оаэ: 'usd_aed', дубай: 'usd_aed',
  uzs: 'usd_uzs', сум: 'usd_uzs', узбекистан: 'usd_uzs',
  kgs: 'usd_kgs', сом: 'usd_kgs', киргизия: 'usd_kgs', кыргызстан: 'usd_kgs',
  rub: 'usd_rub', рубль: 'usd_rub', рубли: 'usd_rub', рублей: 'usd_rub'
};

const CUR_ALIASES = {
  usd: 'USD', доллар: 'USD', доллары: 'USD', бакс: 'USD', баксы: 'USD', dollar: 'USD', dollars: 'USD', '$': 'USD',
  eur: 'EUR', евро: 'EUR', euro: 'EUR', '€': 'EUR',
  rub: 'RUB', рубль: 'RUB', рубли: 'RUB', рублей: 'RUB', руб: 'RUB', ruble: 'RUB', rubles: 'RUB', '₽': 'RUB',
  cny: 'CNY', юань: 'CNY', юани: 'CNY', yuan: 'CNY', rmb: 'CNY',
  uah: 'UAH', гривна: 'UAH', гривны: 'UAH', гривен: 'UAH', грн: 'UAH', hryvnia: 'UAH', '₴': 'UAH',
  kzt: 'KZT', тенге: 'KZT', тг: 'KZT', tenge: 'KZT', '₸': 'KZT',
  gbp: 'GBP', фунт: 'GBP', фунты: 'GBP', sterling: 'GBP', '£': 'GBP',
  jpy: 'JPY', иена: 'JPY', йена: 'JPY', yen: 'JPY', '¥': 'JPY',
  try: 'TRY', лира: 'TRY', лиры: 'TRY', lira: 'TRY', tl: 'TRY',
  gel: 'GEL', лари: 'GEL', lari: 'GEL',
  pln: 'PLN', злотый: 'PLN', злотые: 'PLN', zloty: 'PLN',
  aed: 'AED', дирхам: 'AED', дирхамы: 'AED', dirham: 'AED',
  uzs: 'UZS', сум: 'UZS', сумы: 'UZS', soum: 'UZS',
  kgs: 'KGS', сом: 'KGS', сомы: 'KGS', som: 'KGS',
  chf: 'CHF', франк: 'CHF', frank: 'CHF',
  cad: 'CAD', aud: 'AUD', nzd: 'NZD', sgd: 'SGD', hkd: 'HKD', twd: 'TWD',
  byn: 'BYN', amd: 'AMD', драм: 'AMD', azn: 'AZN', манат: 'AZN', mdl: 'MDL', лей: 'MDL',
  inr: 'INR', рупия: 'INR', krw: 'KRW', вона: 'KRW', brl: 'BRL', реал: 'BRL',
  mxn: 'MXN', песо: 'MXN', zar: 'ZAR', рэнд: 'ZAR', egp: 'EGP', sar: 'SAR', риял: 'SAR',
  thb: 'THB', бат: 'THB', vnd: 'VND', донг: 'VND', idr: 'IDR', myr: 'MYR', ринггит: 'MYR',
  php: 'PHP', sek: 'SEK', nok: 'NOK', dkk: 'DKK', czk: 'CZK', huf: 'HUF', форинт: 'HUF',
  ron: 'RON', bgn: 'BGN', лев: 'BGN', rsd: 'RSD', динар: 'RSD', isk: 'ISK',
  tjs: 'TJS', сомони: 'TJS', tmt: 'TMT'
};

// Пара, которой нет в кнопках, создаётся на лету - /kurs доллар вона тоже сработает.
function ensurePair(f, t) {
  const from = up(f);
  const to = up(t);
  if (!from || !to || from === to) return null;
  if (!CUR_NAME[from] || !CUR_NAME[to]) return null;
  const key = (from + '_' + to).toLowerCase();
  if (!PAIRS[key]) {
    PAIRS[key] = {
      from, to,
      label: (CUR_FLAG[from] || '') + ' ' + CUR_NAME[from] + ' → ' + CUR_NAME[to]
    };
  }
  return key;
}

function resolvePairKey(arg) {
  const a = String(arg || '').toLowerCase().trim();
  if (!a) return 'usd_rub';
  if (PAIRS[a]) return a;
  if (PAIR_ALIASES[a]) return PAIR_ALIASES[a];

  const tokens = a.split(/[^a-zа-яё$€₽₴₸£¥]+/i).filter(Boolean);
  const curs = tokens.map((t) => CUR_ALIASES[t]).filter(Boolean);

  if (curs.length >= 2) {
    const direct = (curs[0] + '_' + curs[1]).toLowerCase();
    if (PAIRS[direct]) return direct;
    const reverse = (curs[1] + '_' + curs[0]).toLowerCase();
    if (PAIRS[reverse]) return reverse;
    const made = ensurePair(curs[0], curs[1]);
    if (made) return made;
  }
  if (curs.length === 1) {
    const cur = curs[0];
    const pref = cur.toLowerCase() + '_';
    const found = Object.keys(PAIRS).find((k) => k.startsWith(pref));
    if (found) return found;
    const toRub = ensurePair(cur, 'RUB');
    if (toRub) return toRub;
    const fromUsd = ensurePair('USD', cur);
    if (fromUsd) return fromUsd;
  }
  for (const k of Object.keys(PAIR_ALIASES)) if (a.includes(k)) return PAIR_ALIASES[k];
  return null;
}

function kursKeyboard() {
  const keys = Object.keys(PAIRS).slice(0, 20);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((k) => ({ text: PAIRS[k].label, callback_data: 'kurs:' + k })));
  }
  return rows;
}

function cryptoKeyboard() {
  return [
    [{ text: '₿ BTC', callback_data: 'crypto:btc' }, { text: 'Ξ ETH', callback_data: 'crypto:eth' }],
    [{ text: '◎ SOL', callback_data: 'crypto:sol' }, { text: '💎 TON', callback_data: 'crypto:ton' }],
    [{ text: '🔥 ВСЁ СРАЗУ', callback_data: 'crypto:btc+eth+sol+ton' }]
  ];
}

module.exports = {
  getCryptoData, getPairData, getRubData,
  PAIRS, PAIR_ALIASES, CUR_ALIASES, CUR_NAME, CRYPTO_IDS,
  resolvePairKey, ensurePair, kursKeyboard, cryptoKeyboard
};
