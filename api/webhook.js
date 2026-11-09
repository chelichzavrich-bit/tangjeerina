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
const { TRIGGER_KEYWORDS } = require('../lib/persona');

function parseBody(req) {
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return null; }
    }
    return req.body || null;
}

const displayName = (from) => (from && (from.first_name || from.username)) || 'Аноним';

// Проверка триггерных слов для принудительной активации
function checkTriggers(msg) {
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const fullText = text + ' ' + replyText;
    return TRIGGER_KEYWORDS.some(kw => fullText.includes(kw));
}

// В группах отвечаем только на упоминание/ответ боту/команду, если задан BOT_USERNAME, ИЛИ если сработал триггер.
function shouldAnswer(msg, botUsername) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!isGroup || !botUsername) return true;
    
    const text = (msg.text || msg.caption || '').toLowerCase();
    if (text.includes('@' + botUsername.toLowerCase())) return true;
    if (/^\/\w+/.test(text)) return true;
    
    const repliedFrom = msg.reply_to_message && msg.reply_to_message.from;
    if (repliedFrom && repliedFrom.is_bot && (repliedFrom.username || '').toLowerCase() === botUsername.toLowerCase()) return true;
    
    // ЦЕЛЬ 2А: Система триггеров (принудительная активация)
    if (checkTriggers(msg)) return true;
    
    return false;
}

// ЦЕЛЬ 1: Глубокий профилинг собеседника (метаданные)
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

// Получение аватарки пользователя для Gemini Vision
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
                    return { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } };
                }
            }
        }
    } catch (e) {
        // Игнорируем ошибки получения аватарки, чтобы не ломать основной поток
    }
    return null;
}

// Читает ссылки из сообщения. Любая ошибка здесь не должна ломать ответ.
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
    // ── GET: проверка работоспособности ──
    if (req.method === 'GET') {
        const query = req.query || {};
        if (query.cron === 'true') return handlePulseRequest(req, res, { daily: true });
        return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational', memory: memory.isPersistent() ? 'redis' : 'in-process' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── POST: обновления Telegram ──
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) {
        return res.status(401).json({ error: 'Bad webhook secret' });
    }

    const update = parseBody(req);
    const msg = update && update.message;
    if (!msg || !msg.chat) return res.status(200).json({ status: 'No message payload' });
    if (await memory.seenUpdate(update.update_id)) return res.status(200).json({ status: 'duplicate' });

    const c = cfg();
    if (!shouldAnswer(msg, c.botUsername)) return res.status(200).json({ status: 'ignored (not addressed)' });

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const deadline = Date.now() + 25000;

    try {
        telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

        // Вложение и ссылки читаются параллельно
        const [incoming, linkInfo, userAvatar] = await Promise.all([
            readIncoming(msg), 
            readLinks(msg, c),
            msg.from ? getUserAvatar(msg.from.id) : Promise.resolve(null)
        ]);

        let userText = incoming.userText;
        if (c.botUsername) userText = userText.replace(new RegExp('@' + c.botUsername + '\\b', 'gi'), '').trim();
        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил бота - поздоровайся в образе)';
        }

        // ЦЕЛЬ 1 и 2Б: Профилирование и чтение цитат
        const userProfile = analyzeUserProfile(msg);
        const replied = msg.reply_to_message;
        const repliedText = replied && (replied.text || replied.caption);
        
        let contextBlocks = [];
        
        // Интеллектуальное чтение цитат
        if (repliedText) {
            contextBlocks.push(`[ОН ОТВЕЧАЕТ НА СООБЩЕНИЕ: "${repliedText.slice(0, 500)}"]. Прокомментируй содержание этого сообщения от лица Танг. Не отвечай автору напрямую, если он не обратился к ней. Оцени суть сказанного.`);
        }
        
        // Глубокий профилинг
        if (userProfile) {
            contextBlocks.push(`[ДОСЬЕ ПОЛЬЗОВАТЕЛЯ: ${userProfile}]. Используй эту информацию для персонализированного, язвительного комментария ДО начала основного диалога.`);
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

        const history = await memory.getHistory(chatId);
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
