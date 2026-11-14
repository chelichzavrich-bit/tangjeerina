// Рыночные данные: фиат и крипта. Без API-ключей, с запасными источниками и таймаутами.
// Никогда не бросает ошибки наружу: всегда возвращает строку (цифры или отговорку в характере).
// Экспортирует всё, что ждут разные версии webhook: getFiatData, getRubData, getPairData, getCryptoData, PAIRS, PAIR_ALIASES.

const TIMEOUT_MS = 8000;

async function jfetch(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'tangjeebot-rate-lookup/4.0' }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    } finally {
        clearTimeout(t);
    }
}

const PAIRS = {
    usd_rub: { from: 'USD', to: 'RUB', label: '💵 USD → RUB' },
    eur_rub: { from: 'EUR', to: 'RUB', label: '💶 EUR → RUB' },
    eur_usd: { from: 'EUR', to: 'USD', label: '💶 EUR → USD' },
    cny_usd: { from: 'CNY', to: 'USD', label: '💴 CNY → USD' }
};

const PAIR_ALIASES = {
    usd: 'usd_rub', доллар: 'usd_rub', бакс: 'usd_rub', рубль: 'usd_rub', rub: 'usd_rub',
    eur: 'eur_rub', евро: 'eur_rub', eur_usd: 'eur_usd',
    cny: 'cny_usd', юань: 'cny_usd', китай: 'cny_usd'
};

const CUR = {
    USD: ['доллар', '💵'], EUR: ['евро', '💶'], RUB: ['рубль', '💸'], CNY: ['юань', '💴']
};

const COINS = {
    bitcoin: ['BTC', '₿'], ethereum: ['ETH', 'Ξ'], solana: ['SOL', '◎'], 'the-open-network': ['TON', '💎']
};
const COIN_ALIASES = {
    btc: 'bitcoin', биткоин: 'bitcoin', eth: 'ethereum', эфириум: 'ethereum', эфир: 'ethereum',
    sol: 'solana', солана: 'solana', solana: 'solana', ton: 'the-open-network', тон: 'the-open-network', тонкоин: 'the-open-network'
};

function fmt(v) {
    if (!isFinite(v)) return 'н/д';
    if (v >= 1000) return Math.round(v).toLocaleString('en-US');
    if (v >= 1) return String(Math.round(v * 100) / 100);
    return String(Number(v.toPrecision(4)));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ───────────── источники фиата ─────────────
async function erRates(base) {
    const d = await jfetch(`https://open.er-api.com/v6/latest/${base}`);
    if (!d || d.result !== 'success' || !d.rates) throw new Error('er-api bad shape');
    return d.rates;
}

async function cbrRubPer(cur) {
    const d = await jfetch('https://www.cbr-xml-daily.ru/daily_json.js');
    const v = d && d.Valute && d.Valute[cur];
    if (!v || !v.Value) throw new Error('cbr missing ' + cur);
    return v.Value / v.Nominal; // рублей за 1 единицу валюты
}

async function rate(from, to) {
    if (from === to) return 1;
    try {
        const r = await erRates(from);
        if (r[to]) return r[to];
        throw new Error('no ' + to);
    } catch (e) { /* идём в запасной */ }
    const a = from === 'RUB' ? 1 : await cbrRubPer(from);
    const b = to === 'RUB' ? 1 : await cbrRubPer(to);
    return a / b;
}

// ───────────── публичные функции ─────────────
async function getPairData(from, to) {
    try {
        const v = await rate(from, to);
        const fn = (CUR[from] || [from, ''])[0];
        const fe = (CUR[from] || ['', ''])[1];
        const tn = (CUR[to] || [to, ''])[0];
        return `Курс ${fe} ${cap(fn)} → ${cap(tn)}: 1 ${fn} (${from}) = ${fmt(v)} ${tn} (${to}).`;
    } catch (e) {
        return `Курс ${from}/${to} сейчас не загрузить (${e.message}). Мой источники сегодня вредные, повтори позже 🤭`;
    }
}

async function getRubData() {
    try {
        const r = await erRates('USD');
        const usd = r.RUB;
        const eur = r.RUB / r.EUR;
        return `USD/RUB: ${fmt(usd)} | EUR/RUB: ${fmt(eur)}`;
    } catch (e) {
        try {
            const usd = await cbrRubPer('USD');
            const eur = await cbrRubPer('EUR');
            return `USD/RUB: ${fmt(usd)} | EUR/RUB: ${fmt(eur)}`;
        } catch (e2) {
            return 'Рубль сегодня не подвезли, повтори позже 🤭';
        }
    }
}

async function getFiatData() {
    try {
        const r = await erRates('USD');
        const usdRub = r.RUB;
        const eurRub = r.RUB / r.EUR;
        const eurUsd = r.EUR;
        const cnyUsd = r.CNY;
        return `USD/RUB: ${fmt(usdRub)} | EUR/RUB: ${fmt(eurRub)} | EUR/USD: ${fmt(eurUsd)} | CNY/USD: ${fmt(cnyUsd)}`;
    } catch (e) {
        try {
            const usd = await cbrRubPer('USD');
            const eur = await cbrRubPer('EUR');
            const cny = await cbrRubPer('CNY');
            return `USD/RUB: ${fmt(usd)} | EUR/RUB: ${fmt(eur)} | CNY/RUB: ${fmt(cny)} | (кроссы через рубль)`;
        } catch (e2) {
            return `Фиат не загрузить (${e2.message}), повтори позже 🤭`;
        }
    }
}

async function getCryptoData(coins) {
    let list = Array.isArray(coins) ? coins : String(coins || '').split(/[\s,]+/);
    const ids = [...new Set(list
        .map((c) => String(c || '').toLowerCase().trim())
        .map((c) => COIN_ALIASES[c] || (COINS[c] ? c : null))
        .filter(Boolean))];
    if (!ids.length) ids.push('bitcoin', 'ethereum');
    try {
        const d = await jfetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd,rub`);
        const lines = ids.map((id) => {
            const p = d && d[id];
            const c = COINS[id];
            if (!p || !c) return null;
            return `${c[1]} ${c[0]}: $${Math.round(p.usd).toLocaleString('en-US')} (≈ ${Math.round(p.rub).toLocaleString('en-US')} ₽)`;
        }).filter(Boolean);
        if (!lines.length) throw new Error('empty');
        return lines.join(' | ');
    } catch (e) {
        try {
            const sym = { bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT' };
            const out = [];
            for (const id of ids) {
                if (!sym[id]) continue;
                const d = await jfetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym[id]}`);
                if (d && d.price) out.push(`${COINS[id][1]} ${COINS[id][0]}: $${Math.round(Number(d.price)).toLocaleString('en-US')}`);
            }
            if (out.length) return out.join(' | ') + ' | (рубль сегодня не подвезли)';
        } catch (e2) { /* молча */ }
        return 'Крипта сейчас не загрузить, мой источники молчат как партизаны. Повтори позже 🤭';
    }
}

module.exports = { getFiatData, getRubData, getPairData, getCryptoData, PAIRS, PAIR_ALIASES };
