// Все настройки берутся из переменных окружения Vercel. Значения по умолчанию подобраны под бесплатные тарифы.
const num = (name, def) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const v = Number(raw);
    return Number.isFinite(v) ? v : def;
};

function cfg() {
    return {
        // ── память ──
        historyMax: Math.max(2, Math.floor(num('HISTORY_MAX_MESSAGES', 60))),   // сколько последних реплик чата помнить (все участники + Танг)
        historyMsgChars: 1200,                                                  // макс. длина одного сообщения в памяти
        memoryTtlSec: Math.max(60, Math.round(num('MEMORY_TTL_HOURS', 336) * 3600)), // 336 ч = 14 дней: чат «забывается», если молчит дольше

        // ── ответы ──
        maxOutputTokens: num('MAX_OUTPUT_TOKENS', 1200),
        maxMediaBytes: Math.round(num('MAX_FILE_MB', 10) * 1024 * 1024),
        maxDocChars: num('MAX_DOC_CHARS', 30000),
        botUsername: (process.env.BOT_USERNAME || '').replace(/^@/, '').trim(),

        // ── «участница чата, но не спамит» ──
        cooldownSec: Math.max(0, num('COOLDOWN_SECONDS', 240)),        // после любого её сообщения 4 мин не вклинивается сама
        spontPerHour: Math.max(0, Math.floor(num('SPONTANEOUS_PER_HOUR', 6))), // не больше N самопроизвольных реплик в час на чат
        reactStrong: num('REACT_STRONG', 0.75),   // шанс ответить на «громкое» лор-слово (Жак, ЛНР, харза...) без пинга
        reactWeak: num('SPONTANEOUS_CHANCE', 0.4), // шанс для «слабых» слов (деньги, звезда, лампа...)
        reactTopic: num('REACT_TOPIC', 0.2),      // шанс для тем (крипта, коммунизм, любовь...)
        reactLink: num('REACT_LINK', 0.3),        // шанс прокомментировать ссылку
        reactPhoto: num('REACT_PHOTO', 0.3),      // шанс прокомментировать фото/стикер
        reactJoin: num('REACT_JOIN', 0.8),        // шанс поприветствовать новичка
        reactRandom: num('REACT_RANDOM', 0.04),   // шанс вклиниться в любое сообщение просто так

        // ── «пульс»: писать самой, когда в чате тишина ──
        silenceHours: Math.max(1, num('SILENCE_HOURS', 12)),           // тишина дольше N часов = повод написать
        pulseMaxUnanswered: Math.max(1, num('PULSE_MAX_UNANSWERED', 2)), // сколько раз подряд писать в мёртвый чат
        pulseActiveDays: num('PULSE_ACTIVE_DAYS', 14),
        pulseMaxChats: Math.max(1, Math.floor(num('PULSE_MAX_CHATS_PER_RUN', 3))),
        pulseTz: process.env.PULSE_TZ || 'Europe/Berlin',
        pulseQuiet: process.env.PULSE_QUIET_HOURS === undefined ? '1-8' : process.env.PULSE_QUIET_HOURS,

        // ── голосовой пинг ──
        voiceEveryHours: Math.max(1, num('VOICE_EVERY_HOURS', 48)),    // примерно раз в 2 дня (+ случайный разброс до 8 ч)

        // ── чтение ссылок (lib/links.js) ──
        linksEnabled: (process.env.LINK_PARSING || 'on').trim().toLowerCase() !== 'off',
        maxLinks: Math.max(1, Math.floor(num('MAX_LINKS_PER_MESSAGE', 2))),
        linkTimeoutMs: Math.max(1000, num('LINK_TIMEOUT_MS', 5000)),
        linkTextChars: Math.max(100, num('LINK_TEXT_CHARS', 500)),
        linkMaxImageBytes: Math.round(num('LINK_MAX_IMAGE_MB', 5) * 1024 * 1024),
        youtubeApiKey: (process.env.YOUTUBE_API_KEY || '').trim(),
        youtubeVideoSeconds: Math.max(0, Math.floor(num('YOUTUBE_VIDEO_SECONDS', 120))) // сколько секунд ролика Gemini реально «смотрит». 0 = только название/описание
    };
}

module.exports = { cfg };
