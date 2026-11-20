// lib/config.js
// Все настройки берутся из переменных окружения Vercel. Значения по умолчанию рабочие.
const num = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
};
const flag = (name, def) => {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim().toLowerCase();
  if (!raw) return def;
  return !['0', 'off', 'false', 'no'].includes(raw);
};
const str = (name, def) => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : String(raw).trim();
};

function cfg() {
  return {
    // память
    historyMax: Math.max(4, Math.floor(num('HISTORY_MAX_MESSAGES', 60))),
    historyMsgChars: Math.max(200, Math.floor(num('HISTORY_MSG_CHARS', 1200))),
    historyTokenBudget: Math.max(1000, Math.floor(num('HISTORY_CHAR_BUDGET', 9000))),
    memoryTtlSec: Math.max(300, Math.round(num('MEMORY_TTL_HOURS', 336) * 3600)),
    archiveMax: Math.max(20, Math.floor(num('DOX_ARCHIVE_MESSAGES', 200))),
    // ответы
    maxOutputTokens: Math.max(128, Math.floor(num('MAX_OUTPUT_TOKENS', 1400))),
    maxMediaBytes: Math.round(num('MAX_FILE_MB', 8) * 1024 * 1024),
    maxInlineTotalBytes: Math.round(num('MAX_INLINE_MB', 14) * 1024 * 1024),
    maxDocChars: Math.max(500, Math.floor(num('MAX_DOC_CHARS', 30000))),
    botUsername: str('BOT_USERNAME', '').replace(/^@/, '').toLowerCase(),
    workBudgetMs: Math.max(10000, Math.floor(num('WORK_BUDGET_MS', 45000))),
    replyInGroup: flag('REPLY_IN_GROUP', true),
    thinkingLevel: str('GEMINI_THINKING_LEVEL', ''),
    // участница чата, но не спамит
    cooldownSec: Math.max(0, num('COOLDOWN_SECONDS', 240)),
    spontPerHour: Math.max(0, Math.floor(num('SPONTANEOUS_PER_HOUR', 6))),
    reactStrong: num('REACT_STRONG', 0.75),
    reactWeak: num('SPONTANEOUS_CHANCE', 0.4),
    reactTopic: num('REACT_TOPIC', 0.2),
    reactLink: num('REACT_LINK', 0.3),
    reactPhoto: num('REACT_PHOTO', 0.3),
    reactJoin: num('REACT_JOIN', 0.8),
    reactRandom: num('REACT_RANDOM', 0.04),
    reactChannel: num('REACT_CHANNEL', 1),
    // пульс
    silenceHours: Math.max(1, num('SILENCE_HOURS', 12)),
    pulseMaxUnanswered: Math.max(1, num('PULSE_MAX_UNANSWERED', 2)),
    pulseActiveDays: Math.max(1, num('PULSE_ACTIVE_DAYS', 14)),
    pulseMaxChats: Math.max(1, Math.floor(num('PULSE_MAX_CHATS_PER_RUN', 3))),
    pulseTz: str('PULSE_TZ', 'Etc/GMT+5'), // Etc/GMT+5 = UTC-5, знак в названии зоны обратный
    pulseQuiet: str('PULSE_QUIET_HOURS', '1-8'),
    voiceEveryHours: Math.max(1, num('VOICE_EVERY_HOURS', 48)),
    // ссылки
    linksEnabled: flag('LINK_PARSING', true),
    maxLinks: Math.max(1, Math.floor(num('MAX_LINKS_PER_MESSAGE', 2))),
    linkTimeoutMs: Math.max(1500, num('LINK_TIMEOUT_MS', 6000)),
    linkTextChars: Math.max(100, Math.floor(num('LINK_TEXT_CHARS', 600))),
    linkMaxImageBytes: Math.round(num('LINK_MAX_IMAGE_MB', 5) * 1024 * 1024),
    youtubeApiKey: str('YOUTUBE_API_KEY', ''),
    // фичи
    reactionsEnabled: flag('REACTIONS', true),
    stickersEnabled: flag('STICKERS', true),
    stickerTtlSec: Math.max(3600, Math.round(num('STICKER_TTL_HOURS', 168) * 3600)),
    searchEnabled: flag('SEARCH', true),
    marketEnabled: flag('MARKET', true),
    doxEnabled: flag('DOX', true),
    codesEnabled: flag('CODES', true),
    avMock: flag('VOICE_MOCK', true)
  };
}

module.exports = { cfg, num, flag, str };
