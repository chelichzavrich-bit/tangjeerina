// Telegram webhook: Танг Джи Рина (Vercel + Google Gemini).
// Логика разложена по модулям в папке lib/. Текст персонажа лежит в lib/persona.js.
const { cfg } = require('../lib/config');
const memory = require('../lib/memory');
const { telegram, sendMessage } = require('../lib/telegram');
const { readIncoming } = require('../lib/files');
const { readLinks } = require('../lib/links');
const { generateReply, buildContents } = require('../lib/ai');
const { randomFallback } = require('../lib/fallbacks');
const { handlePulseRequest } = require('../lib/pulse');

function parseBody(req) {
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return null; }
    }
    return req.body || null;
}

const displayName = (from) => (from && (from.first_name || from.username)) || 'Аноним';

// В группах отвечаем только на упоминание/ответ боту/команду, если задан BOT_USERNAME.
function shouldAnswer(msg, botUsername) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!isGroup || !botUsername) return true;
    const text = (msg.text || msg.caption || '').toLowerCase();
    if (text.includes('@' + botUsername.toLowerCase())) return true;
    if (/^\/\w+/.test(text)) return true;
    const repliedFrom = msg.reply_to_message && msg.reply_to_message.from;
    return !!(repliedFrom && repliedFrom.is_bot && (repliedFrom.username || '').toLowerCase() === botUsername.toLowerCase());
}

module.exports = async (req, res) => {
    // ── GET: проверка работоспособности (и старый путь крона ?cron=true -> теперь это пульс) ──
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

        // Вложения и ссылки читаем параллельно, чтобы не терять время
        const [incoming, links] = await Promise.all([
            readIncoming(msg),
            readLinks(msg).catch((e) => {
                console.error('Links error:', e.message);
                return { text: '', media: null, histNote: '', count: 0 };
            })
        ]);

        let userText = incoming.userText;
        if (c.botUsername) userText = userText.replace(new RegExp('@' + c.botUsername + '\\b', 'gi'), '').trim();
        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил бота - поздоровайся в образе)';
        }

        // Текст для модели
        const replied = msg.reply_to_message;
        const repliedText = replied && (replied.text || replied.caption);
        const context = repliedText ? `[Он отвечает на сообщение: "${repliedText.slice(0, 500)}"]` : '';
        const who = isGroup ? `[${displayName(msg.from)}]: ` : '';
        const spoken = userText || (incoming.hint || links.text ? '' : 'Привет');
        const textBlock = [
            context,
            spoken ? who + spoken : (isGroup ? `[${displayName(msg.from)}] прислал вложение` : ''),
            incoming.hint,
            incoming.docText,
            links.text
        ].filter(Boolean).join('\n');

        const history = await memory.getHistory(chatId);
        const mediaParts = [incoming.media, links.media].filter(Boolean);
        const hasMedia = mediaParts.length > 0;
        const opts = { userLen: userText.length + incoming.docText.length + links.text.length, hasMedia, deadline };

        let reply;
        try {
            const parts = [{ text: textBlock }, ...mediaParts];
            reply = (await generateReply(buildContents(history, parts), opts)).text;
        } catch (e) {
            if (!hasMedia || e.status === 401) throw e;
            // Модель не приняла вложение - второй заход без него, но с честной пометкой
            console.error('Retry without media:', e.message);
            const parts = [{ text: textBlock + '\n[Само вложение или картинку по ссылке обработать не удалось: их содержимое тебе недоступно, не выдумывай его.]' }];
            reply = (await generateReply(buildContents(history, parts), { ...opts, hasMedia: false })).text;
        }

        await sendMessage(chatId, reply);

        // Память и расписание пульса: человек активен, значит следующий «сам по себе» пост - через случайную паузу
        const histUser = [who + spoken, incoming.histNote, links.histNote].filter(Boolean).join(' ') || who + '[вложение]';
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
