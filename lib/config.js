// Все настройки берутся из переменных окружения Vercel. Значения по умолчанию подобраны под бесплатные тарифы.
const num = (name, def) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const v = Number(raw);
    return Number.isFinite(v) ? v : def;
};

function cfg() {
    const pulseMin = Math.max(1, num('PULSE_MIN_MINUTES', 30));
    return {
        historyMax: Math.max(2, Math.floor(num('HISTORY_MAX_MESSAGES', 40))), // сообщений (user+bot), 40 = 20 пар
        historyMsgChars: 1500,                                                // макс. длина одного сообщения в памяти
        memoryTtlSec: Math.max(60, Math.round(num('MEMORY_TTL_HOURS', 72) * 3600)),
        maxOutputTokens: num('MAX_OUTPUT_TOKENS', 1200),
        maxMediaBytes: Math.round(num('MAX_FILE_MB', 10) * 1024 * 1024),
        maxDocChars: num('MAX_DOC_CHARS', 30000),
        pulseMin,
        pulseMax: Math.max(pulseMin, num('PULSE_MAX_MINUTES', 240)),
        pulseActiveDays: num('PULSE_ACTIVE_DAYS', 14),
        pulseMaxUnanswered: num('PULSE_MAX_UNANSWERED', 2),
        pulseMaxChats: Math.max(1, Math.floor(num('PULSE_MAX_CHATS_PER_RUN', 3))),
        pulseTz: process.env.PULSE_TZ || 'UTC',
        pulseQuiet: process.env.PULSE_QUIET_HOURS === undefined ? '1-8' : process.env.PULSE_QUIET_HOURS,
        botUsername: (process.env.BOT_USERNAME || '').replace(/^@/, '').trim(),
        // ── чтение ссылок (lib/links.js) ──
        linksEnabled: (process.env.LINK_PARSING || 'on').trim().toLowerCase() !== 'off',
        maxLinks: Math.max(1, Math.floor(num('MAX_LINKS_PER_MESSAGE', 2))),   // сколько ссылок читать из одного сообщения
        linkTimeoutMs: Math.max(1000, num('LINK_TIMEOUT_MS', 5000)),          // общий таймаут на одну ссылку
        linkTextChars: Math.max(100, num('LINK_TEXT_CHARS', 500)),            // сколько символов текста статьи брать
        linkMaxImageBytes: Math.round(num('LINK_MAX_IMAGE_MB', 5) * 1024 * 1024),
        youtubeApiKey: (process.env.YOUTUBE_API_KEY || '').trim()             // необязательно: без ключа - oEmbed + разбор страницы
    };
}

module.exports = { cfg };
