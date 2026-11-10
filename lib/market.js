// lib/market.js
// Легковесный сборщик рыночных данных без API-ключей (Vercel Free Tier friendly)

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

// Получает курсы крипты
async function getCryptoData(coins = ['bitcoin', 'ethereum']) {
    try {
        const ids = coins.map(c => CRYPTO_IDS[c.toLowerCase()] || c.toLowerCase()).join(',');
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { cache: 'no-store' });
        const data = await res.json();
        
        const lines = [];
        for (const coin of coins) {
            const id = CRYPTO_IDS[coin.toLowerCase()] || coin.toLowerCase();
            const price = data[id]?.usd;
            if (price) lines.push(`${coin.toUpperCase()}: $${price}`);
        }
        return lines.length > 0 ? lines.join(' | ') : 'Крипта не найдена';
    } catch (e) {
        return 'Данные крипты не загрузились (рынок упал, как и твои надежды)';
    }
}

// Fallback на ЦБ РФ для рубля (Frankfurter не отдает RUB)
async function getRubData(fromCurr) {
    try {
        const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { cache: 'no-store' });
        const data = await res.json();
        const f = fromCurr.toUpperCase();
        
        if (f === 'USD') {
            const rate = data.Valute.USD.Value; 
            return `1 USD = ${rate.toFixed(2)} RUB`;
        } else if (f === 'EUR') {
            const rate = data.Valute.EUR.Value;
            return `1 EUR = ${rate.toFixed(2)} RUB`;
        } else if (f === 'RUB') {
            // Инвертируем, так как ЦБ дает курс иностранной валюты к RUB
            const usdRate = data.Valute.USD.Value;
            const rubToUsd = (1 / usdRate).toFixed(4);
            return `1 RUB = ${rubToUsd} USD`;
        }
        return 'Курс не найден';
    } catch (e) {
        return 'ЦБ РФ молчит, как и твои финансы';
    }
}

// Основная функция для фиата
async function getPairData(from, to) {
    try {
        const f = from.toUpperCase();
        const t = to.toUpperCase();
        
        // Если задействован рубль, используем ЦБ РФ
        if (f === 'RUB' || t === 'RUB') {
            return await getRubData(f === 'RUB' ? 'RUB' : f);
        }

        // Иначе используем Frankfurter
        const res = await fetch(`https://api.frankfurter.app/latest?from=${f}&to=${t}`, { cache: 'no-store' });
        const data = await res.json();
        const rate = data.rates?.[t];
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

module.exports = { getCryptoData, getPairData, PAIRS };
