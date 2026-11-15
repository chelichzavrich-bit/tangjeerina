// lib/market.js
// Легковесный сборщик рыночных данных без API-ключей. У каждого запроса таймаут 6с.

const TIMEOUT_MS = 6000;

async function jfetch(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    } finally {
        clearTimeout(t);
    }
}

const CRYPTO_IDS = {
    'btc': 'bitcoin', 'bitcoin': 'bitcoin',
    'eth': 'ethereum', 'ethereum': 'ethereum',
    'sol': 'solana', 'solana': 'solana',
    'ton': 'the-open-network', 'toncoin': 'the-open-network',
    'bnb': 'binancecoin', 'bnb-chain': 'binancecoin'
};

const CURRENCY_NAMES = {
    'usd': 'доллар', 'eur': 'евро', 'rub': 'рубль', 'cny': 'юань'
};

async function getCryptoData(coins = ['bitcoin', 'ethereum']) {
    try {
        const ids = coins.map(c => CRYPTO_IDS[c.toLowerCase()] || c.toLowerCase()).join(',');
        const data = await jfetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
        const lines = [];
        for (const coin of coins) {
            const id = CRYPTO_IDS[coin.toLowerCase()] || coin.toLowerCase();
            const price = data[id] && data[id].usd;
            if (price) lines.push(`${coin.toUpperCase()}: $${price}`);
        }
        return lines.length > 0 ? lines.join(' | ') : 'Крипта не найдена';
    } catch (e) {
        return 'Данные крипты не загрузились (рынок упал, как и твои надежды)';
    }
}

async function getRubData(fromCurr) {
    try {
        const data = await jfetch('https://www.cbr-xml-daily.ru/daily_json.js');
        const f = fromCurr.toUpperCase();

        if (f === 'USD') {
            const rate = data.Valute.USD.Value;
            return `1 USD = ${rate.toFixed(2)} RUB`;
        } else if (f === 'EUR') {
            const rate = data.Valute.EUR.Value;
            return `1 EUR = ${rate.toFixed(2)} RUB`;
        } else if (f === 'RUB') {
            const usdRate = data.Valute.USD.Value;
            const rubToUsd = (1 / usdRate).toFixed(4);
            return `1 RUB = ${rubToUsd} USD`;
        }
        return 'Курс не найден';
    } catch (e) {
        return 'ЦБ РФ молчит, как и твои финансы';
    }
}

async function getPairData(from, to) {
    try {
        const f = from.toUpperCase();
        const t = to.toUpperCase();

        if (f === 'RUB' || t === 'RUB') {
            return await getRubData(f === 'RUB' ? 'RUB' : f);
        }

        const data = await jfetch(`https://api.frankfurter.app/latest?from=${f}&to=${t}`);
        const rate = data.rates && data.rates[t];
        if (!rate) return `Курс ${f}/${t} не найден`;

        const fromName = CURRENCY_NAMES[f.toLowerCase()] || f;
        const toName = CURRENCY_NAMES[t.toLowerCase()] || t;
        return `1 ${fromName} (${f}) = ${rate} ${toName} (${t})`;
    } catch (e) {
        return 'Данные фиата не загрузились';
    }
}

const PAIRS = {
    'usd_rub': { from: 'USD', to: 'RUB', label: '💵 Доллары → Рубли' },
    'eur_rub': { from: 'EUR', to: 'RUB', label: '💶 Евро → Рубли' },
    'eur_usd': { from: 'EUR', to: 'USD', label: '💶 Евро → Доллары' },
    'cny_usd': { from: 'CNY', to: 'USD', label: '💴 Юани → Доллары' }
};

const PAIR_ALIASES = {
    usd: 'usd_rub', dollar: 'usd_rub', доллар: 'usd_rub', бакс: 'usd_rub',
    eur: 'eur_rub', euro: 'eur_rub', евро: 'eur_rub',
    eur_usd: 'eur_usd', cny: 'cny_usd', yuan: 'cny_usd', юань: 'cny_usd', китай: 'cny_usd'
};

module.exports = { getCryptoData, getPairData, getRubData, PAIRS, PAIR_ALIASES };
