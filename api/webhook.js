// Telegram webhook: Танг Джи Рина (Vercel + Google Gemini).
const { cfg } = require('../lib/config');
const memory = require('../lib/memory');
const { telegram, sendMessage } = require('../lib/telegram');
const { readIncoming } = require('../lib/files');
const { extractUrls, parseLinks, describeLinks } = require('../lib/links');
const { generateReply, buildContents } = require('../lib/ai');
const { randomFallback } = require('../lib/fallbacks');
const { handlePulseRequest } = require('../lib/pulse');

// ЯВНЫЙ СПИСОК ТРИГГЕРОВ (гарантирует активацию, не зависит от экспорта persona.js)
const WATCHLIST = [
    'tangjeebot', 'танг', 'танджи', 'жак', 'жрак', 'даорен', 'дао рен', 'лао рен',
    'манго', 'ман го', 'мандарин', 'звезда', 'лампа', 'бывший', 'харза', 'деньги',
    'золото', 'лнр', 'чингчонг', 'крольчиха'
];

function parseBody(req) {
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return null; }
    }
    return req.body || null;
}

const displayName = (from) => (from && (from.first_name || from.username)) || 'Аноним';

// Проверка триггеров в основном тексте И в тексте цитаты
function checkTriggers(msg) {
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const fullText = text + ' ' + replyText;
    return WATCHLIST.some(kw => fullText.includes(kw));
}

function shouldAnswer(msg, botUsername) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!isGroup) return true; // В личных чатах отвечаем всегда

    // СТРАХОВКА: если BOT_USERNAME не задан в ENV, используем 'tangjeebot'
    const targetUsername = (botUsername || 'tangjeebot').toLowerCase().replace(/^@/, '');
    
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const fullText = text + ' ' + replyText;

    // 1. Прямое упоминание @tangjeebot или просто tangjeebot в тексте
    if (fullText.includes('@' + targetUsername) || fullText.includes(' ' + targetUsername) || fullText.startsWith(targetUsername)) {
        return true;
    }

    // 2. Команды
    if (/^\/\w+/.test(text)) return true;

    // 3. Ответ на сообщение самого бота
    const repliedFrom = msg.reply_to_message && msg.reply_to_message.from;
    if (repliedFrom && repliedFrom.is_bot) {
        const repliedUsername = (repliedFrom.username || '').toLowerCase().replace(/^@/, '');
        if (repliedUsername === targetUsername) return true;
    }

    // 4. АКТИВАЦИЯ ПО WATCHLIST (Симптом 2 и 3: реакция на ключевые слова, даже в цитатах, без @)
    if (checkTriggers(msg)) return true;

    return false;
}

// Роутер приоритетов для модели
function getPriorityDirective(userText, repliedText) {
    const fullText = (userText + ' ' + (repliedText || '')).toLowerCase();

    if (/ман го|тебя бросили|ты не сама научилась|бросил/.test(fullText)) {
        return "[ПРИОРИТЕТ 1: Сжатие, тишина, отрицание имени, без капса, без истерики. Профилирование молчит.]";
    }
    if (/любишь жака|чувства к жаку|нравишься жак|симпатия|неравнодушна/.test(fullText)) {
        return "[ПРИОРИТЕТ 2: Смена темы + абсурд, без капса, без истерики, подтекст не озвучивать. Профилирование молчит.]";
    }
    if (/дракон|лао рен|лнр-пропаганда|лунная народная республика/.test(fullText)) {
        return "[ПРИОРИТЕТ 3: Капс, паника, китайский, агрессия.]";
    }
    if (/ли чуцао|сестра|умершая сестра/.test(fullText)) {
        return "[ПРИОРИТЕТ 4: Капс, слёзы ярости, отрицание боли.]";
    }
    if (/родители|ли мун|скучают|отец|танг ченг/.test(fullText)) {
        return "[ПРИОРИТЕТ 5: Капс, газлайтинг, требование кошелька.]";
    }
    if (/кобыла|шлюха|урод|глупая|толстая|дебил|колхозан/.test(fullText)) {
        return "[ПРИОРИТЕТ 6: Cold Troll, зеркальное унижение, без капса, лениво, 1-4 предложения.]";
    }
    return "[ПРИОРИТЕТ 7: Обычный режим. Профилирование применять только если это первое сообщение или пользователь прямо просит оценить внешность/ник. Не повторять детали профиля из прошлых сообщений.]";
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
    // Используем fallback, если в ENV не задано
    const botUsername = c.botUsername || process.env.BOT_USERNAME || 'tangjeebot';
    
    if (!shouldAnswer(msg, botUsername)) {
        return res.status(200).json({ status: 'ignored (not addressed)' });
    }

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const deadline = Date.now() + 25000;

    try {
        telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

        const [incoming, linkInfo] = await Promise.all([readIncoming(msg), readLinks(msg, c)]);
        let userText = incoming.userText;
        
        // Удаляем упоминания бота из текста, чтобы не мешали генерации
        if (botUsername) {
            userText = userText.replace(new RegExp('@' + botUsername + '\\b', 'gi'), '').trim();
        }

        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил bot - поздоровайся в образе)';
        }

        const history = await memory.getHistory(chatId);
        const replied = msg.reply_to_message;
        const repliedText = replied && (replied.text || replied.caption);

        // 1. Применяем Роутер Приоритетов
        const priorityDirective = getPriorityDirective(userText, repliedText);
        let contextBlocks = [priorityDirective];

        // 2. Симптом 3: Усиленное чтение цитат
        if (repliedText) {
            const repliedFrom = replied.from;
            const authorName = repliedFrom ? (repliedFrom.first_name || repliedFrom.username || 'Неизвестный') : 'Неизвестный';
            contextBlocks.push(`[ВАЖНО: Это ответ на цитату от ${authorName}: "${repliedText.slice(0, 400)}"]. Твоя задача: прокомментировать содержание этой цитаты от лица Танг. Если в цитате есть триггерные слова, реагируй на них. Не отвечай автору цитаты напрямую, если текущий собеседник не просил об этом, но оцени суть сказанного в цитате.`);
        }

        // 3. Симптом 1: Профилирование ТОЛЬКО при первом контакте или явном запросе, И ТОЛЬКО если нет эмоционального триггера
        const isExplicitProfileRequest = /оцени|внешность|ник|аватарка|как я выгляжу|кто я/.test((userText + ' ' + (repliedText || '')).toLowerCase());
        const noEmotionalTrigger = priorityDirective.includes("ПРИОРИТЕТ 7");
        
        if (noEmotionalTrigger && (history.length === 0 || isExplicitProfileRequest)) {
            const userProfile = analyzeUserProfile(msg);
            if (userProfile) {
                contextBlocks.push(`[ДОСЬЕ ПОЛЬЗОВАТЕЛЯ (ИСПОЛЬЗОВАТЬ ВСКОЛЬЗЬ, НЕ ЦИТИРОВАТЬ ДОСЛОВНО В БУДУЩЕМ): ${userProfile}]`);
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

        const mediaParts = [incoming.media, ...linkInfo.media].filter(Boolean);
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

// Вспомогательная функция профилирования (оставлена без изменений логики, только вызов ограничен выше)
function analyzeUserProfile(msg) {
    const from = msg.from || {};
    const username = from.username || '';
    const firstName = from.first_name || '';
    const lastName = from.last_name || '';
    let profileNotes = [];
    
    if (username) {
        if (/\d{3,}\|[_-]{2,}\|666\|dark\|lord\|edgy/i.test(username)) {
            profileNotes.push(`юзернейм @${username} кричит о попытках быть крутым или мрачным`);
        } else if (/sunny\|kitten\|cute\|baby/i.test(username)) {
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
