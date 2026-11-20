// lib/market.js
// Курсы фиата (ЦБ РФ + frankfurter) и крипты (CoinGecko). Без ключей, с кэшем и таймаутами.
const TIMEOUT_MS = 6000;
const cache = global.__tjrMarket || (global.__tjrMarket = new Map());

async function jfetch(url, ttl = 60000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const CRYPTO_IDS = {
  btc: 'bitcoin', bitcoin: 'bitcoin', биткоин: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum', эфир: 'ethereum', эфириум: 'ethereum',
  sol: 'solana', solana: 'solana',
  ton: 'the-open-network', toncoin: 'the-open-network', тон: 'the-open-network',
  bnb: 'binancecoin', doge: 'dogecoin', xrp: 'ripple', ada: 'cardano', trx: 'tron', ltc: 'litecoin'
};

async function getCryptoData(coins = ['bitcoin', 'ethereum']) {
  try {
    const ids = [...new Set((coins || []).map((c) => CRYPTO_IDS[String(c).toLowerCase()] || String(c).toLowerCase()).filter(Boolean))];
    if (!ids.length) return 'Монеты не распознала';
    const data = await jfetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids.join(',') + '&vs_currencies=usd&include_24hr_change=true');
    const lines = [];
    for (const id of ids) {
      const row = data[id];
      if (!row || typeof row.usd !== 'number') continue;
      const ch = typeof row.usd_24h_change === 'number'
        ? ' (' + (row.usd_24h_change >= 0 ? '+' : '') + row.usd_24h_change.toFixed(1) + '% за сутки)'
        : '';
      lines.push(id + ': $' + row.usd + ch);
    }
    return lines.length ? lines.join(' | ') : 'Такие монеты не нашлись';
  } catch (e) {
    return 'Крипта не загрузилась: ' + e.message;
  }
}

async function getPairData(from, to) {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  try {
    if (t === 'RUB' || f === 'RUB') {
      const data = await jfetch('https://www.cbr-xml-daily.ru/daily_json.js', 600000);
      const val = (code) => {
        const v = data.Valute && data.Valute[code];
        return v ? v.Value / (v.Nominal || 1) : null;
      };
      if (f === 'RUB') {
        const r = val(t);
        return r ? '1 RUB = ' + (1 / r).toFixed(4) + ' ' + t : 'Курс ' + t + ' не найден';
      }
      const r = val(f);
      return r ? '1 ' + f + ' = ' + r.toFixed(2) + ' RUB' : 'Курс ' + f + ' не найден';
    }
    const data = await jfetch('https://api.frankfurter.app/latest?from=' + f + '&to=' + t);
    const rate = data.rates && data.rates[t];
    return rate ? '1 ' + f + ' = ' + rate + ' ' + t : 'Курс ' + f + '/' + t + ' не найден';
  } catch (e) {
    return 'Курсы не загрузились: ' + e.message;
  }
}

const PAIRS = {
  usd_rub: { from: 'USD', to: 'RUB', label: '💵 Доллар → Рубль' },
  eur_rub: { from: 'EUR', to: 'RUB', label: '💶 Евро → Рубль' },
  eur_usd: { from: 'EUR', to: 'USD', label: '💶 Евро → Доллар' },
  cny_usd: { from: 'CNY', to: 'USD', label: '💴 Юань → Доллар' }
};
const PAIR_ALIASES = {
  usd: 'usd_rub', dollar: 'usd_rub', доллар: 'usd_rub', бакс: 'usd_rub', баксы: 'usd_rub',
  eur: 'eur_rub', euro: 'eur_rub', евро: 'eur_rub',
  cny: 'cny_usd', yuan: 'cny_usd', юань: 'cny_usd', китай: 'cny_usd',
  rub: 'usd_rub', рубль: 'usd_rub', рубли: 'usd_rub'
};

function resolvePairKey(arg) {
  const a = String(arg || '').toLowerCase().trim();
  if (!a) return 'usd_rub';
  if (PAIRS[a]) return a;
  if (PAIR_ALIASES[a]) return PAIR_ALIASES[a];
  const m = /([a-zа-я]{3})[\s/_-]+([a-zа-я]{3})/.exec(a);
  if (m) {
    const key = (PAIR_ALIASES[m[1]] || m[1]).split('_')[0] + '_' + (PAIR_ALIASES[m[2]] || m[2]).split('_')[0];
    if (PAIRS[key]) return key;
  }
  for (const k of Object.keys(PAIR_ALIASES)) if (a.includes(k)) return PAIR_ALIASES[k];
  return null;
}

function kursKeyboard() {
  const keys = Object.keys(PAIRS);
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

module.exports = { getCryptoData, getPairData, PAIRS, PAIR_ALIASES, CRYPTO_IDS, resolvePairKey, kursKeyboard, cryptoKeyboard };
