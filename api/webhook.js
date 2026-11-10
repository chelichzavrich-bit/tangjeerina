// Telegram webhook: Танг Джи Рина (Vercel + Google Gemini).
// Логика разложена по модулям в папке lib/. Текст персонажа лежит в lib/persona.js.
const { cfg } = require('../lib/config');
const memory = require('../lib/memory');
const { telegram, sendMessage } = require('../lib/telegram');
const { readIncoming } = require('../lib/files');
const { extractUrls, parseLinks, describeLinks } = require('../lib/links');
const { generateReply, buildContents } = require('../lib/ai');
const { randomFallback } = require('../lib/fallbacks');
const { handlePulseRequest } = require('../lib/pulse');

// ═══════════════════════════════════════════════════════════════
// ЖЁСТКИЙ WATCHLIST (без импорта из persona.js — там нет экспорта TRIGGER_KEYWORDS,
// из-за чего оригинальный checkTriggers падал с ошибкой, и бот молчал в группах).
// Содержит: её собственный тег, её имя, ключевых персонажей, триггерные темы.
// Все слова в нижнем регистре. Проверка через includes.
// ═══════════════════════════════════════════════════════════════
const WATCHLIST = [
    '@tangjeebot', 'танг', 'танджи', 'танг джи рина',
    'жак', 'жрак', 'жак кэрротлин',
    'лаорен', 'дао рен', 'лао рен', 'лао рен нян',
    'манго', 'ман го', 'мандарин',
    'звезда', 'лампа', 'бывший',
    'харза', 'деньги', 'золото',
    'лнр', 'лунная народная республика',
    'чингчонг', 'крольчиха',
    'пингвин', 'пингвинья империя',
    'ли чуцао', 'танг ченг', 'ли мун',
    'марозол', 'мияконе', 'снорк', 'мороженщица',
    'дядя санта', 'товарищ мороз', 'снегурочка',
    'император форстер'
];

function parseBody(req) {
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return null; }
    }
    return req.body || null;
}

const displayName = (from) => (from && (from.first_name || from.username)) || 'Аноним';

// ═══════════════════════════════════════════════════════════════
// Извлекает все URL-строки из сообщения (текст + подписи + скрытые text_link)
// БЕЗ парсинга содержимого. Нужно, чтобы проверить триггеры в самих ссылках
// (например, t.me/tangjeebot) ДО чтения ссылок.
// ═══════════════════════════════════════════════════════════════
function extractRawUrls(msg) {
    const found = [];
    const add = (raw) => {
        let s = String(raw || '').trim();
        if (!s) return;
        if (!found.includes(s.toLowerCase())) found.push(s.toLowerCase());
    };
    const text = msg.text || msg.caption || '';
    const ents = msg.entities || msg.caption_entities || [];
    for (const e of ents) {
        if (e.type === 'text_link' && e.url) add(e.url);
        else if (e.type === 'url') add(text.slice(e.offset, e.offset + e.length));
    }
    const re = /\b(?:https?:\/\/|(?:www\.)?(?:t\.me|telegram\.me|youtu\.be|youtube\.com|m\.youtube\.com)[^\s<>"«»]+)/gi;
    for (const m of text.matchAll(re)) {
        let s = m[0].replace(/[.,!?;:\]}»"'…]+$/, '');
        if (s.endsWith(')') && !s.includes('(')) s = s.slice(0, -1);
        add(s);
    }
    return found;
}

// ═══════════════════════════════════════════════════════════════
// Проверка триггеров: текст сообщения + текст цитаты + URL ссылок в сообщении.
// Это гарантирует, что бот отреагирует, даже если триггерное слово только в ссылке
// (например, t.me/zhak_carrotlin или t.me/tangjeebot).
// ═══════════════════════════════════════════════════════════════
function checkTriggers(msg) {
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const urls = extractRawUrls(msg).join(' ');
    const fullText = text + ' ' + replyText + ' ' + urls;
    return WATCHLIST.some(kw => fullText.includes(kw));
}

// ═══════════════════════════════════════════════════════════════
// В группах отвечаем, если:
// 1. Упомянули @botUsername (или просто botUsername в тексте как отдельное слово)
// 2. Ответ на сообщение самого бота
// 3. Команда (/start и т.д.)
// 4. Сработал триггер из WATCHLIST (в тексте, цитате ИЛИ в URL ссылок)
// ═══════════════════════════════════════════════════════════════
function shouldAnswer(msg, botUsername) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    // В личных чатах всегда отвечаем; если botUsername не задан — тоже отвечаем (страховка)
    if (!isGroup || !botUsername) return true;

    const targetUsername = botUsername.toLowerCase().replace(/^@/, '');
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const fullText = text + ' ' + replyText;

    // 1. Прямое упоминание бота через @
    if (fullText.includes('@' + targetUsername)) return true;

    // 2. Username как отдельное слово (чтобы "tangjeebot" сработало, но "mytangjeebot" — нет)
    const usernameRe = new RegExp('(^|[^a-z0-9_])' + targetUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9_]|$)');
    if (usernameRe.test(fullText)) return true;

    // 3. Команды
    if (/^\/\w+/.test(text)) return true;

    // 4. Ответ на сообщение самого бота
    const repliedFrom = msg.reply_to_message && msg.reply_to_message.from;
    if (repliedFrom && repliedFrom.is_bot) {
        const repliedUsername = (repliedFrom.username || '').toLowerCase().replace(/^@/, '');
        if (repliedUsername === targetUsername) return true;
    }

    // 5. ТРИГГЕРЫ (в тексте + цитате + URL ссылок) — ключевое исправление для групп
    if (checkTriggers(msg)) return true;

    return false;
}

// ═══════════════════════════════════════════════════════════════
// ЦЕЛЬ 1: Глубокий профилинг собеседника (метаданные)
// ═══════════════════════════════════════════════════════════════
function analyzeUserProfile(msg) {
    const from = msg.from || {};
    const username = from.username || '';
    const firstName = from.first_name || '';
    const lastName = from.last_name || '';
    let profileNotes = [];

    if (username) {
        if (/\d{3,}|[_-]{2,}|666|dark|lord|edgy/i.test(username)) {
            profileNotes.push(`юзернейм @${username} кричит о попытках быть крутым или мрачным`);
        } else if (/sunny|kitten|cute|baby/i.test(username)) {
            profileNotes.push(`юзернейм @${username} слишком слащавый и подозрительный`);
        } else {
            profileNotes.push(`юзернейм @${username} стандартный и скучный`);
        }
    }
    if (firstName && lastName) {
        profileNotes.push(`полное имя "${firstName} ${lastName}" выдает серьезность или попытку казаться взрослым`);
    } else if (firstName && !lastName) {
        profileNotes.push(`одно имя "${firstName}" выдает анонимность или игривость`);
    }
    return profileNotes.length > 0 ? profileNotes.join('; ') : 'профиль пользователя не дает интересных зацепок';
}

// ═══════════════════════════════════════════════════════════════
// Получение аватарки пользователя для Gemini Vision (ЦЕЛЬ 1)
// ═══════════════════════════════════════════════════════════════
async function getUserAvatar(userId) {
    try {
        const res = await telegram('getUserProfilePhotos', { user_id: userId, limit: 1 });
        if (res.result && res.result.total_count > 0) {
            const photo = res.result.photos[0].pop(); // highest resolution
            const file = await telegram('getFile', { file_id: photo.file_id });
            if (file.result && file.result.file_path) {
                const token = process.env.TELEGRAM_BOT_TOKEN;
                const imgRes = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`);
                if (imgRes.ok) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    const mime = 'image/jpeg';
                    return { inline_data: { mime_type: mime, data: buf.toString('base64') } };
                }
            }
        }
    } catch (e) {
        // Игнорируем ошибки получения аватарки, чтобы не ломать основной поток
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// Читает ссылки из сообщения. Любая ошибка здесь не должна ломать ответ.
// ═══════════════════════════════════════════════════════════════
async function readLinks(msg, c) {
    const empty = { text: '', media: [], note: '' };
    if (!c.linksEnabled) return empty;
    try {
        const urls = extractUrls(msg, c.maxLinks);
        if (!urls.length) return empty;
        const results = await parseLinks(urls);
        return describeLinks(results);
    } catch (e) {
        console.error('Link parsing error:', e.message);
        return empty;
    }
}

module.exports = async (req, res) => {
    // GET: проверка работоспособности
    if (req.method === 'GET') {
        const query = req.query || {};
        if (query.cron === 'true') return handlePulseRequest(req, res, { daily: true });
        return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational', memory: memory.isPersistent() ? 'redis' : 'in-process' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // POST: обновления Telegram
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) {
        return res.status(401).json({ error: 'Bad webhook secret' });
    }

    const update = parseBody(req);
    const msg = update && update.message;
    if (!msg || !msg.chat) return res.status(200).json({ status: 'No message payload' });
    if (await memory.seenUpdate(update.update_id)) return res.status(200).json({ status: 'duplicate' });

    const c = cfg();
    // Страховка: если BOT_USERNAME не задан в ENV, используем 'tangjeebot'
    const botUsername = c.botUsername || process.env.BOT_USERNAME || 'tangjeebot';

    if (!shouldAnswer(msg, botUsername)) return res.status(200).json({ status: 'ignored (not addressed)' });

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const deadline = Date.now() + 25000;

    try {
        telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

        // Вложение, ссылки и аватарка читаются ПАРАЛЛЕЛЬНО для максимальной скорости (ЦЕЛЬ 1, 3)
        const [incoming, linkInfo, userAvatar] = await Promise.all([
            readIncoming(msg),
            readLinks(msg, c),
            msg.from ? getUserAvatar(msg.from.id) : Promise.resolve(null)
        ]);

        let userText = incoming.userText;
        if (botUsername) userText = userText.replace(new RegExp('@' + botUsername + '\\b', 'gi'), '').trim();

        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил бота - поздоровайся в образе)';
        }

        // ЦЕЛЬ 1 и 2Б: Профилирование и чтение цитат
        const userProfile = analyzeUserProfile(msg);
        const replied = msg.reply_to_message;
        const repliedText = replied && (replied.text || replied.caption);

        // Получаем историю ДО формирования контекста, чтобы проверить длину
        const history = await memory.getHistory(chatId);

        // ═══════════════════════════════════════════════════════════════
        // ИСПРАВЛЕНИЕ СИМПТОМА 1: Профилирование применяется ТОЛЬКО если:
        // - это первое сообщение в истории (history.length === 0)
        // - ИЛИ пользователь прямо просит оценить внешность/ник
        // Это предотвращает зацикливание на аватарке в каждом сообщении.
        // ═══════════════════════════════════════════════════════════════
        const fullTextLower = (userText + ' ' + (repliedText || '')).toLowerCase();
        const isExplicitProfileRequest = /оцени|внешность|ник|аватарка|как я выгляжу|кто я/.test(fullTextLower);
        const shouldProfile = history.length === 0 || isExplicitProfileRequest;

        let contextBlocks = [];

        // Интеллектуальное чтение цитат (ЦЕЛЬ 2Б)
        if (repliedText) {
            const repliedFrom = replied.from;
            const authorName = repliedFrom ? (repliedFrom.first_name || repliedFrom.username || 'Неизвестный') : 'Неизвестный';
            contextBlocks.push(`[ОН ОТВЕЧАЕТ НА СООБЩЕНИЕ ОТ ${authorName}: "${repliedText.slice(0, 500)}"]. Прокомментируй содержание этого сообщения от лица Танг. Не отвечай автору напрямую, если текущий собеседник не просил об этом. Оцени суть сказанного в цитате. Если в цитате есть триггерные слова (Жак, Ман Го, Лао Рен, родители и т.д.) - реагируй на них.`);
        }

        // Глубокий профилинг (ЦЕЛЬ 1) — ТОЛЬКО при первом контакте или явном запросе
        if (shouldProfile && userProfile) {
            contextBlocks.push(`[ДОСЬЕ ПОЛЬЗОВАТЕЛЯ: ${userProfile}]. Используй эту информацию для персонализированного, язвительного комментария ДО начала основного диалога. В следующих сообщениях НЕ ПОВТОРЯЙ эти детали дословно — максимум вскользь ("твой портрет", "твоя физиономия").`);
        }

        const who = isGroup ? `[${displayName(msg.from)}]: ` : '';
        const spoken = userText || (incoming.hint || linkInfo.text ? '' : 'Привет');

        const textBlock = [
            ...contextBlocks,
            spoken ? who + spoken : (isGroup ? `[${displayName(msg.from)}] прислал вложение` : ''),
            incoming.hint,
            incoming.docText,
            linkInfo.text  // <-- ЗДЕСЬ приходят разобранные ссылки на телеграм-каналы, YouTube, сайты
        ].filter(Boolean).join('\n');

        // Собираем все медиа: вложения, аватарку и превью из ссылок (ЦЕЛЬ 3)
        const mediaParts = [incoming.media, userAvatar, ...linkInfo.media].filter(Boolean);
        const hasMedia = mediaParts.length > 0;
        const opts = { userLen: userText.length + incoming.docText.length + linkInfo.text.length, hasMedia, deadline };

        let reply;
        try {
            const parts = [{ text: textBlock }, ...mediaParts];
            reply = (await generateReply(buildContents(history, parts), opts)).text;
        } catch (e) {
            if (!hasMedia || e.status === 401) throw e;
            // Модель не приняла вложение - второй заход без него, но с честной пометкой
            console.error('Retry without media:', e.message);
            const parts = [{ text: textBlock + '\n[Само вложение или картинка по ссылке обработать не удалось: их содержимое тебе недоступно, не выдумывай его.]' }];
            reply = (await generateReply(buildContents(history, parts), { ...opts, hasMedia: false })).text;
        }

        await sendMessage(chatId, reply);

        // Память и расписание пульса (ЦЕЛЬ 4): человек активен, значит следующий «сам по себе» пост - через случайную паузу
        const histUser = [who + spoken, incoming.histNote, linkInfo.note].filter(Boolean).join(' ') || who + '[вложение]';
        const nextPulse = Date.now() + (c.pulseMin + Math.random() * (c.pulseMax - c.pulseMin)) * 60000;
        await Promise.all([
            memory.addHistory(chatId, [{ r: 'u', t: histUser }, { r: 'm', t: reply }]),
            memory.touchChat(chatId),
            memory.setMeta(chatId, { next: nextPulse, unanswered: 0 })
        ]);

        return res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('Webhook processing error:', error);
        try { await sendMessage(chatId, randomFallback()); } catch (_) { /* ignore */ }
        // Всегда 200, иначе Telegram будет бесконечно повторять доставку
        return res.status(200).json({ status: 'error_handled', message: error.message });
    }
};
