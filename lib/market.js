// lib/market.js
// Легковесный сборщик рыночных данных без API-ключей (Vercel Free Tier friendly)

// Маппинг популярных тикеров к ID CoinGecko
const CRYPTO_IDS = {
    'btc': 'bitcoin',
    'bitcoin': 'bitcoin',
    'eth': 'ethereum',
    'ethereum': 'ethereum',
    'sol': 'solana',
    'solana': 'solana',
    'ada': 'cardano',
    'cardano': 'cardano',
    'xrp': 'ripple',
    'ripple': 'ripple',
    'doge': 'dogecoin',
    'dogecoin': 'dogecoin',
    'ton': 'the-open-network',
    'toncoin': 'the-open-network',
    'bnb': 'binancecoin',
    'bnb-chain': 'binancecoin'
};

// Названия валют для красивого вывода
const CURRENCY_NAMES = {
    'usd': 'доллар',
    'eur': 'евро',
    'rub': 'рубль',
    'cny': 'юань (жэньминьби)',
    'gbp': 'фунт',
    'jpy': 'иена'
};

// Получает курсы крипты по списку монет
async function getCryptoData(coins = ['bitcoin', 'ethereum']) {
    try {
        const ids = coins.map(c => CRYPTO_IDS[c.toLowerCase()] || c.toLowerCase()).join(',');
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { cache: 'no-store' });
        const data = await res.json();
        
        const lines = [];
        for (const coin of coins) {
            const id = CRYPTO_IDS[coin.toLowerCase()] || coin.toLowerCase();
            const price = data[id]?.usd;
            if (price) {
                lines.push(`${coin.toUpperCase()}: $${price}`);
            }
        }
        
        return lines.length > 0 ? lines.join(' | ') : 'Крипта не найдена (ты точно правильно написал?)';
    } catch (e) {
        console.error('Crypto API error:', e.message);
        return 'Данные крипты не загрузились (рынок упал, как и твои надежды)';
    }
}

// Получает курс конкретной пары валют через Frankfurter API
// Примеры: getPairData('USD', 'RUB'), getPairData('EUR', 'USD'), getPairData('CNY', 'USD')
async function getPairData(from, to) {
    try {
        const f = from.toUpperCase();
        const t = to.toUpperCase();
        const res = await fetch(`https://api.frankfurter.app/latest?from=${f}&to=${t}`, { cache: 'no-store' });
        const data = await res.json();
        const rate = data.rates?.[t];
        if (!rate) return `Курс ${f}/${t} не найден`;
        
        const fromName = CURRENCY_NAMES[f.toLowerCase()] || f;
        const toName = CURRENCY_NAMES[t.toLowerCase()] || t;
        
        return `1 ${fromName} (${f}) = ${rate} ${toName} (${t})`;
    } catch (e) {
        console.error('Pair API error:', e.message);
        return 'Данные фиата не загрузились (интернет сломался, как и твои финансы)';
    }
}

// Предустановленные пары для inline-кнопок команды /kurs
const PAIRS = {
    'usd_rub': { from: 'USD', to: 'RUB', label: '💵 Доллары → Рубли' },
    'eur_rub': { from: 'EUR', to: 'RUB', label: '💶 Евро → Рубли' },
    'eur_usd': { from: 'EUR', to: 'USD', label: '💶 Евро → Доллары' },
    'cny_usd': { from: 'CNY', to: 'USD', label: '💴 Юани → Доллары' }
};

module.exports = { getCryptoData, getPairData, PAIRS };
