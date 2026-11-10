// lib/market.js
// Легковесный сборщик рыночных данных без API-ключей (Vercel Free Tier friendly)

async function getMarketData() {
    try {
        // 1. Крипта (CoinGecko free API)
        const cryptoRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd', { cache: 'no-store' });
        const cryptoData = await cryptoRes.json();
        const btc = cryptoData.bitcoin?.usd || '???';
        const eth = cryptoData.ethereum?.usd || '???';

        // 2. Фиат (Frankfurter free API, USD к RUB)
        const fiatRes = await fetch('https://api.frankfurter.app/latest?from=USD&to=RUB', { cache: 'no-store' });
        const fiatData = await fiatRes.json();
        const usdRub = fiatData.rates?.RUB || '???';

        return `BTC: $${btc} | ETH: $${eth} | USD/RUB: ${usdRub}`;
    } catch (e) {
        // Если API временно недоступен, даем характерную заглушку
        return 'РЫНОК: данные не загрузились (интернет сломался, как и твои финансы)';
    }
}

module.exports = { getMarketData };
