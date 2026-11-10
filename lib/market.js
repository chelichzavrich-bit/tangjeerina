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

// Получает курсы фиата (USD, EUR, GBP и т.д.) к RUB
async function getFiatData(currency = 'usd') {
    try {
        const curr = currency.toLowerCase().trim();
        const res = await fetch(`https://api.frankfurter.app/latest?from=${curr}&to=RUB`, { cache: 'no-store' });
        const data = await res.json();
        const rate = data.rates?.RUB;
        if (!rate) return `Курс ${curr.toUpperCase()} не найден`;
        return `1 ${curr.toUpperCase()} = ${rate} RUB`;
    } catch (e) {
        console.error('Fiat API error:', e.message);
        return 'Данные фиата не загрузились (интернет сломался, как и твои финансы)';
    }
}

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

module.exports = { getFiatData, getCryptoData };
