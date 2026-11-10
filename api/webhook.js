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
// ЖЁСТКИЙ WATCHLIST. Проверка через includes.
// ═══════════════════════════════════════════════════════════════
const WATCHLIST = [
    'tangjeebot', 'танг', 'танджи', 'танг джи рина',
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
// Извлекает все URL-строки из сообщения
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
// Проверка триггеров: текст + цитата + URL
// ═══════════════════════════════════════════════════════════════
function checkTriggers(msg) {
    const text = String(msg.text || msg.caption || '').toLowerCase();
    const replyText = String((msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) || '').toLowerCase();
    const urls = extractRawUrls(msg).join(' ');
    const fullText = text + ' ' + replyText + ' ' + urls;
    
    // Для отладки в Vercel Logs (можно раскомментировать, если всё ещё есть проблемы)
    // console.log('TRIGGER CHECK:', { fullText: fullText.slice(0, 100), match: WATCHLIST.some(kw => fullText.includes(kw)) });
    
    return WATCHLIST.some(kw => fullText.includes(kw));
}

// ═══════════════════════════════════════════════════════════════
// Решение: отвечать в группах
// ═══════════════════════════════════════════════════════════════
function shouldAnswer(msg, botUsername) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!isGroup) return true; // В ЛС отвечаем всегда

    // 1. ПРОВЕРКА ТРИГГЕРОВ (Приоритет №1 для групп)
    if (checkTriggers(msg)) return true;

    const targetUsername = botUsername ? botUsername.toLowerCase().replace(/^@/, '') : '';
    const text = String(msg.text || msg.caption || '').toLowerCase();
    const replyText = String((msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) || '').toLowerCase();
    const fullText = text + ' ' + replyText;

    // 2. Прямое упоминание через @
    if (targetUsername && fullText.includes('@' + targetUsername)) return true;

    // 3. Username как отдельное слово
    if (targetUsername) {
        const usernameRe = new RegExp('(^|[^a-z0-9_])' + targetUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9_]|$)');
        if (usernameRe.test(fullText)) return true;
    }

    // 4. Команды
    if (/^\/\w+/.test(text)) return true;

    // 5. Ответ на сообщение самого бота
    const repliedFrom = msg.reply_to_message && msg.reply_to_message.from;
    if (repliedFrom && repliedFrom.is_bot && targetUsername) {
        const repliedUsername = (repliedFrom.username || '').toLowerCase().replace(/^@/, '');
        if (repliedUsername === targetUsername) return true;
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════
// Профилирование собеседника (метаданные)
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
// Получение аватарки пользователя для Gemini Vision
// ═══════════════════════════════════════════════════════════════
async function getUserAvatar(userId) {
    try {
        const res = await telegram('getUserProfilePhotos', { user_id: userId, limit: 1 });
        if (res.result && res.result.total_count > 0) {
            const photo = res.result.photos[0].pop();
            const file = await telegram('getFile', { file_id: photo.file_id });
            if (file.result && file.result.file_path) {
                const token = process.env.TELEGRAM_BOT_TOKEN;
                const imgRes = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`);
                if (imgRes.ok) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    return { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } };
                }
            }
        }
    } catch (e) {
        // Игнорируем ошибки
    }
    return null;
}

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
    if (req.method === 'GET') {
        const query = req.query || {};
        if (query.cron === 'true') return handlePulseRequest(req, res, { daily: true });
        return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational', memory: memory.isPersistent() ? 'redis' : 'in-process' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) {
        return res.status(401).json({ error: 'Bad webhook secret' });
    }

    const update = parseBody(req);
    const msg = update && update.message;
    if (!msg || !msg.chat) return res.status(200).json({ status: 'No message payload' });
    if (await memory.seenUpdate(update.update_id)) return res.status(200).json({ status: 'duplicate' });

    const c = cfg();
    const botUsername = (c.botUsername || process.env.BOT_USERNAME || 'tangjeebot').trim();

    if (!shouldAnswer(msg, botUsername)) {
        return res.status(200).json({ status: 'ignored (not addressed)' });
    }

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const deadline = Date.now() + 25000;

    try {
        telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

        // Читаем базовые данные параллельно
        const [incoming, linkInfo] = await Promise.all([
            readIncoming(msg),
            readLinks(msg, c)
        ]);

        let userText = incoming.userText;
        if (botUsername) userText = userText.replace(new RegExp('@' + botUsername + '\\b', 'gi'), '').trim();

        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил бота - поздоровайся в образе)';
        }

        const history = await memory.getHistory(chatId);
        const replied = msg.reply_to_message;
        const repliedText = replied && (replied.text || replied.caption);

        // ═══════════════════════════════════════════════════════════════
        // ИСПРАВЛЕНИЕ 1: Профилирование ТОЛЬКО если история пуста (первое сообщение) 
        // ИЛИ если пользователь прямо просит.
        // ═══════════════════════════════════════════════════════════════
        const fullTextLower = (userText + ' ' + (repliedText || '')).toLowerCase();
        const isExplicitProfileRequest = /оцени|внешность|ник|аватарка|как я выгляжу|кто я/.test(fullTextLower);
        
        // Если в истории уже есть ответы бота ('m'), значит мы уже знакомы, не профилируем снова.
        const hasBotRepliedBefore = history.some(h => h.r === 'm');
        const shouldProfile = !hasBotRepliedBefore || isExplicitProfileRequest;

        let contextBlocks = [];

        if (repliedText) {
            const repliedFrom = replied.from;
            const authorName = repliedFrom ? (repliedFrom.first_name || repliedFrom.username || 'Неизвестный') : 'Неизвестный';
            contextBlocks.push(`[ОН ОТВЕЧАЕТ НА СООБЩЕНИЕ ОТ ${authorName}: "${repliedText.slice(0, 500)}"]. Прокомментируй содержание этого сообщения от лица Танг. Не отвечай автору напрямую, если текущий собеседник не просил об этом. Оцени суть сказанного в цитате. Если в цитате есть триггерные слова - реагируй на них.`);
        }

        if (shouldProfile && msg.from) {
            const userProfile = analyzeUserProfile(msg);
            if (userProfile) {
                contextBlocks.push(`[ДОСЬЕ ПОЛЬЗОВАТЕЛЯ: ${userProfile}]. Используй эту информацию для персонализированного, язвительного комментария ДО начала основного диалога. В следующих сообщениях НЕ ПОВТОРЯЙ эти детали дословно.`);
            }
        }

        const who = isGroup ? `[${displayName(msg.from)}]: ` : '';
        const spoken = userText || (incoming.hint || linkInfo.text ? '' : 'Привет');

        const textBlock = [
            ...contextBlocks,
            spoken ? who + spoken : (isGroup ? `[${displayName(msg.from)}] прислал вложение` : ''),
            incoming.hint,
            incoming.docText,
            linkInfo.text
        ].filter(Boolean).join('\n');

        // ═══════════════════════════════════════════════════════════════
        // ИСПРАВЛЕНИЕ 2: Аватарка запрашивается и добавляется в mediaParts 
        // ТОЛЬКО если shouldProfile === true. Это на 100% убирает зацикливание.
        // ═══════════════════════════════════════════════════════════════
        let userAvatar = null;
        if (shouldProfile && msg.from) {
            userAvatar = await getUserAvatar(msg.from.id);
        }

        const mediaParts = [incoming.media, userAvatar, ...linkInfo.media].filter(Boolean);
        const hasMedia = mediaParts.length > 0;
        const opts = { userLen: userText.length + incoming.docText.length + linkInfo.text.length, hasMedia, deadline };

        let reply;
        try {
            const parts = [{ text: textBlock }, ...mediaParts];
            reply = (await generateReply(buildContents(history, parts), opts)).text;
        } catch (e) {
            if (!hasMedia || e.status === 401) throw e;
            console.error('Retry without media:', e.message);
            const parts = [{ text: textBlock + '\n[Само вложение или картинка по ссылке обработать не удалось: их содержимое тебе недоступно, не выдумывай его.]' }];
            reply = (await generateReply(buildContents(history, parts), { ...opts, hasMedia: false })).text;
        }

        await sendMessage(chatId, reply);

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
        return res.status(200).json({ status: 'error_handled', message: error.message });
    }
};
