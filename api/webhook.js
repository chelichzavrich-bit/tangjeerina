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
const { getFiatData, getCryptoData, getPairData, PAIRS } = require('../lib/market');

// ═══════════════════════════════════════════════════════════════
// ЖЁСТКИЙ WATCHLIST
// ═══════════════════════════════════════════════════════════════
const WATCHLIST = [
    'tangjeebot', 'танг', 'танджи', 'танг джи рина',
    'жак', 'жрак', 'жак кэрротлин',
    'лаорен', 'лао рен', 'лао рен нян',
    'манго', 'ман го', 'мандарин',
    'звезда', 'лампа', 'бывший',
    'харза', 'деньги', 'морковка',
    'лнр', 'лунная народная республика',
    'чингчонг', 'крольчиха',
    'пингвин', 'пингвинья империя',
    'ли чуцао', 'танг ченг', 'ли мун',
    'марозол', 'мияконе', 'снорк', 'мороженщица',
    'дядя санта', 'товарищ мороз', 'снегурочка',
    'император форстер'
];

const MARKET_TRIGGERS = [
    'биткоин', 'btc', 'eth', 'эфириум', 'крипта', 'криптовалют',
    'курс', 'растёт', 'падает', 'ликвидация',
    'доллар', 'евро', 'рубль', 'инфляция', 'цены',
    'новости', 'что в мире', 'что случилось',
    'kurs', 'crypto'
];

function parseBody(req) {
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return null; }
    }
    return req.body || null;
}

const displayName = (from) => (from && (from.first_name || from.username)) || 'Аноним';

// ═══════════════════════════════════════════════════════════════
// Функция времени для Танг (UTC-5)
// ═══════════════════════════════════════════════════════════════
function getTangTimeContext() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const tangTime = new Date(utc + (3600000 * -5)); // UTC-5
    const hours = tangTime.getHours();
    
    let period = '';
    if (hours >= 5 && hours < 12) period = 'утро (она бодра, голодна и готова грабить)';
    else if (hours >= 12 && hours < 18) period = 'день (она активна, ищет лохов в интернете)';
    else if (hours >= 18 && hours < 23) period = 'вечер (пик активности, время троллинга и абсурда)';
    else period = 'ночь (она хочет спать, злая, или делает вид, что спит, чтобы её не трогали. Это её оправдание, чтобы идти спать или огрызаться)';
    
    return `[КОНТЕКСТ ВРЕМЕНИ: Сейчас у Танг часовой пояс UTC-5, на часах ${hours}:00. Сейчас у неё ${period}. Используй это как контекст или оправдание в ответе.]`;
}

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

function checkTriggers(msg) {
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const urls = extractRawUrls(msg).join(' ');
    const fullText = text + ' ' + replyText + ' ' + urls;
    return WATCHLIST.some(kw => fullText.includes(kw));
}

function checkMarketTrigger(msg) {
    const text = String(msg.text || msg.caption || '').toLowerCase();
    return MARKET_TRIGGERS.some(kw => text.includes(kw));
}

function parseMarketCommand(userText) {
    const match = userText.match(/^\/(kurs|crypto)(?:@\w+)?\s*(.+)?$/i);
    if (!match) return null;
    const command = match[1].toLowerCase();
    const arg = match[2] ? match[2].trim().toLowerCase() : null;
    return { command, arg };
}

function shouldAnswer(msg, botUsername) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!isGroup || !botUsername) return true;

    const targetUsername = botUsername.toLowerCase().replace(/^@/, '');
    const text = (msg.text || msg.caption || '').toLowerCase();
    const replyText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption) || '').toLowerCase();
    const fullText = text + ' ' + replyText;

    if (fullText.includes('@' + targetUsername)) return true;
    const usernameRe = new RegExp('(^|[^a-z0-9_])' + targetUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9_]|$)');
    if (usernameRe.test(fullText)) return true;
    if (/^\/\w+/.test(text)) return true;

    const repliedFrom = msg.reply_to_message && msg.reply_to_message.from;
    if (repliedFrom && repliedFrom.is_bot) {
        const repliedUsername = (repliedFrom.username || '').toLowerCase().replace(/^@/, '');
        if (repliedUsername === targetUsername) return true;
    }

    if (checkTriggers(msg)) return true;
    return false;
}

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
    } catch (e) { /* ignore */ }
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

async function handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data || '';
    const chatId = callbackQuery.message.chat.id;
    
    try {
        await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    } catch (e) {
        console.error('answerCallbackQuery error:', e.message);
    }
    
    const [type, arg] = data.split(':');
    let replyText = '';
    
    if (type === 'kurs' && PAIRS[arg]) {
        const pair = PAIRS[arg];
        const rate = await getPairData(pair.from, pair.to);
        
        const jokeAngles = [
            `Сравни курс ${pair.from}/${pair.to} с "длина см Жака, когда он рад меня видеть 🥰" или тем, сколько мандаринов ты украсть за один звонок.`,
            `Скажи, что эта сумма меньше, "чем твой шансы вылазить из мамкин подвала, поздравляю 😋", или что твой оффшорный счёт с краденым весит больше.`,
            `Назови эту валюту фантиком из ЛНР или мусором, который даже бомж не подобрать, и посмейся над тем, кто её держит.`,
            `Скажи, что разница в курсе или само число меньше, чем IQ собеседника, и предложи ему идти работать за копейки или лизать ей пятки бесплатно.`,
            `Обыграй это число через абсурд: например, что за такие деньги можно купить только дырку от бублика в вахтёрской.`
        ];
        const randomAngle = jokeAngles[Math.floor(Math.random() * jokeAngles.length)];
        
        const prompt = `[СВЕЖИЕ ДАННЫЕ РЫНКА (ФИАТ): ${rate}]. ИНСТРУКЦИЯ ДЛЯ ТАНГ: ${randomAngle} ЗАПРЕЩЕНО: давать финансовые советы, писать как ИИ-ассистент, использовать фразы "мой оффшор плакать" или "твои бумажки обесцениться" или "чудесно что мне есть поевать" (придумай НОВУЮ уникальную шутку). Говори ломаным русским, используй "мочь", "имею", "победю", пиши числа искаженными словами (например: "девяноса два и копейками"). Используй ТОЛЬКО эмодзи: ☺️ 🤗 😋 🤭 🫣. Ответ: 1-3 предложения.`;
        
        try {
            const history = await memory.getHistory(chatId);
            const contents = buildContents(history, [{ text: prompt }]);
            const { text } = await generateReply(contents, { userLen: 100, deadline: Date.now() + 20000 });
            replyText = text;
            await memory.addHistory(chatId, [{ r: 'u', t: `[нажал кнопку: курс ${pair.label}]` }, { r: 'm', t: text }]);
        } catch (e) {
            console.error('Market reply generation error:', e.message);
            // ИСПРАВЛЕНО: убрана шаблонная фраза про "поевать"
            replyText = `Мой идеальный компьютер сломать этот курс, но ты всё равно лох, раз спрашивать у меня 🤭`;
        }
    } else if (type === 'crypto') {
        const coins = arg ? arg.split('+') : ['bitcoin', 'ethereum'];
        const rate = await getCryptoData(coins);
        
        const jokeAngles = [
            `Похвастайся, что твой украденный портфель в плюсе, а этот курс смешон по сравнению с тем, что ты украла.`,
            `Злорадствуй или радуйся, но обязательно упомяни, что традиционные финансы горят, а ты сидишь в оффшоре.`,
            `Сравни цену этой монеты с чем-то абсурдным из лора (вахтёрская, мандарины, ветки Жака).`,
            `Назови инвесторов лохами, которые кормят твой будущий ужин своими потерями или прибылью.`,
            `Скажи, что за такие деньги можно купить только воздух в ЛНР, но ты всё равно богаче.`
        ];
        const randomAngle = jokeAngles[Math.floor(Math.random() * jokeAngles.length)];
        
        const prompt = `[СВЕЖИЕ ДАННЫЕ РЫНКА (КРИПТА): ${rate}]. ИНСТРУКЦИЯ ДЛЯ ТАНГ: ${randomAngle} ЗАПРЕЩЕНО: давать финансовые советы, писать как ИИ-ассистент, использовать шаблонные фразы типа "оффшор плакать". Придумай НОВУЮ уникальную шутку. Говори ломаным русским, используй "мочь", пиши числа словами. Используй ТОЛЬКО эмодзи: ☺️ 🤗 😋 🤭 🫣. Ответ: 1-3 предложения.`;
        
        try {
            const history = await memory.getHistory(chatId);
            const contents = buildContents(history, [{ text: prompt }]);
            const { text } = await generateReply(contents, { userLen: 100, deadline: Date.now() + 20000 });
            replyText = text;
            await memory.addHistory(chatId, [{ r: 'u', t: `[нажал кнопку: крипта ${coins.join(',')}]` }, { r: 'm', t: text }]);
        } catch (e) {
            console.error('Crypto reply generation error:', e.message);
            // ИСПРАВЛЕНО: убрана шаблонная фраза про "оффшор плакать"
            replyText = `Крипта сломать мой парсер, но мой украденный портфель всё равно жирнее твоего 🫣`;
        }
    } else {
        replyText = 'Чщщщщ. харе лупатасить, отбитовый, не видь, что не рабочий😠';
    }
    
    try {
        await sendMessage(chatId, replyText);
    } catch (e) {
        console.error('Callback reply send error:', e.message);
    }
}

async function sendKursMenu(chatId) {
    const pairKeys = Object.keys(PAIRS);
    const keyboard = [
        [
            { text: PAIRS[pairKeys[0]].label, callback_data: `kurs:${pairKeys[0]}` },
            { text: PAIRS[pairKeys[1]].label, callback_data: `kurs:${pairKeys[1]}` }
        ],
        [
            { text: PAIRS[pairKeys[2]].label, callback_data: `kurs:${pairKeys[2]}` },
            { text: PAIRS[pairKeys[3]].label, callback_data: `kurs:${pairKeys[3]}` }
        ]
    ];
    
    try {
        await telegram('sendMessage', {
            chat_id: chatId,
            text: 'Ну цто, чудила, какой знание ты хотеть есть обладать? Выбирать пара, пока я добрая ☺️',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (e) {
        console.error('sendKursMenu error:', e.message);
    }
}

async function sendCryptoMenu(chatId) {
    const keyboard = [
        [
            { text: '₿ BTC', callback_data: 'crypto:btc' },
            { text: 'Ξ ETH', callback_data: 'crypto:eth' }
        ],
        [
            { text: '◎ SOL', callback_data: 'crypto:sol' },
            { text: '💎 TON', callback_data: 'crypto:ton' }
        ],
        [
            { text: '🔥 ВСЁ СРАЗУ', callback_data: 'crypto:btc+eth+sol+ton' }
        ]
    ];
    
    try {
        await telegram('sendMessage', {
            chat_id: chatId,
            text: 'Ооооцень интересно, какой монета ты хотеть знац? Выбирать, пока мой голова не устать 🤗',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (e) {
        console.error('sendCryptoMenu error:', e.message);
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
    
    if (update && update.callback_query) {
        try {
            await handleCallbackQuery(update.callback_query);
        } catch (e) {
            console.error('Callback query error:', e.message);
        }
        return res.status(200).json({ status: 'callback_handled' });
    }
    
    const msg = update && update.message;
    if (!msg || !msg.chat) return res.status(200).json({ status: 'No message payload' });
    if (await memory.seenUpdate(update.update_id)) return res.status(200).json({ status: 'duplicate' });

    const c = cfg();
    const botUsername = c.botUsername || process.env.BOT_USERNAME || 'tangjeebot';

    if (!shouldAnswer(msg, botUsername)) return res.status(200).json({ status: 'ignored (not addressed)' });

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const deadline = Date.now() + 25000;

    try {
        telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

        const [incoming, linkInfo] = await Promise.all([
            readIncoming(msg),
            readLinks(msg, c)
        ]);

        let userText = incoming.userText;
        if (botUsername) userText = userText.replace(new RegExp('@' + botUsername + '\\b', 'gi'), '').trim();

        const marketCmd = parseMarketCommand(userText);
        
        if (marketCmd && !marketCmd.arg) {
            if (marketCmd.command === 'kurs') {
                await sendKursMenu(chatId);
                await memory.touchChat(chatId);
                return res.status(200).json({ status: 'kurs_menu_sent' });
            }
            if (marketCmd.command === 'crypto') {
                await sendCryptoMenu(chatId);
                await memory.touchChat(chatId);
                return res.status(200).json({ status: 'crypto_menu_sent' });
            }
        }

        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил бота - поздоровайся в образе)';
        }

        const replied = msg.reply_to_message;
        const repliedText = replied && (replied.text || replied.caption);
        const history = await memory.getHistory(chatId);

        const fullTextLower = (userText + ' ' + (repliedText || '')).toLowerCase();
        // ИСПРАВЛЕНО: Жесткие триггеры только для явной просьбы
        const isExplicitProfileRequest = /оцени|внешность|ник|аватарка|как я выгляжу|кто я|разгляди|фотка/.test(fullTextLower);
        
        // ИСПРАВЛЕНО: Профилируем ТОЛЬКО если история пуста (первый контакт) ИЛИ есть прямая просьба
        const shouldProfile = history.length === 0 || isExplicitProfileRequest;

        let contextBlocks = [];

        // 1. Добавляем контекст времени
        contextBlocks.push(getTangTimeContext());

        // 2. Инъекция рыночных данных
        if (marketCmd && marketCmd.arg) {
            try {
                let marketData = '';
                let marketType = '';
                
                if (marketCmd.command === 'kurs') {
                    if (PAIRS[marketCmd.arg]) {
                        const pair = PAIRS[marketCmd.arg];
                        marketData = await getPairData(pair.from, pair.to);
                        marketType = 'ФИАТ';
                    } else {
                        marketData = 'Пара не найдена. Доступные: usd_rub, eur_rub, eur_usd, cny_usd';
                        marketType = 'ОШИБКА';
                    }
                } else if (marketCmd.command === 'crypto') {
                    const coins = marketCmd.arg.split(/\s+/);
                    marketData = await getCryptoData(coins);
                    marketType = 'КРИПТА';
                }
                
                const jokeAngles = [
                    `Сравни эти цифры с длиной веток Жака, его тупостью или тем, сколько мандаринов ты украсть за один звонок.`,
                    `Скажи, что эта сумма меньше, чем ты найти в кармане у лошка, или что твой оффшорный счёт с краденым весит больше.`,
                    `Назови эту валюту фантиком из ЛНР или мусором, который даже бомж не подобрать, и посмейся над тем, кто её держит.`,
                    `Скажи, что разница в курсе или само число меньше, чем IQ собеседника, и предложи ему идти работать за копейки.`,
                    `Обыграй это число через абсурд: например, что за такие деньги можно купить только дырку от бублика в вахтёрской.`
                ];
                const randomAngle = jokeAngles[Math.floor(Math.random() * jokeAngles.length)];
                
                const instruction = `ИНСТРУКЦИЯ ДЛЯ ТАНГ: ${randomAngle} ЗАПРЕЩЕНО: давать финансовые советы, писать как ИИ-ассистент, использовать фразы "мой оффшор плакать", "твои бумажки обесцениться" или "чудесно что мне есть поевать" (придумай НОВУЮ уникальную шутку). Говори ломаным русским, используй "мочь", НЕ ПЕРЕПИСЫВАЙ данные сухим списком, а вплети числа словами (например: "девяносто два с копейками"). Используй ТОЛЬКО эмодзи: ☺️ 🤗 😋 🤭 🫣. Ответ: 1-3 предложения.`;
                
                contextBlocks.push(`[СВЕЖИЕ ДАННЫЕ РЫНКА (${marketType}): ${marketData}]. ${instruction}`);
            } catch (e) {
                console.error('Market data error:', e.message);
            }
        } else if (checkMarketTrigger(msg)) {
            try {
                let marketData = '';
                let marketType = '';
                const text = userText.toLowerCase();
                
                if (/доллар|евро|рубль|инфляция|цены|фиат/.test(text)) {
                    marketData = await getPairData('USD', 'RUB');
                    marketType = 'ФИАТ';
                } else if (/биткоин|btc|eth|крипт/.test(text)) {
                    marketData = await getCryptoData(['bitcoin', 'ethereum']);
                    marketType = 'КРИПТА';
                } else {
                    const [fiat, crypto] = await Promise.all([
                        getPairData('USD', 'RUB'),
                        getCryptoData(['bitcoin', 'ethereum'])
                    ]);
                    marketData = `ФИАТ: ${fiat} | КРИПТА: ${crypto}`;
                    marketType = 'ОБЩЕЕ';
                }
                
                const jokeAngles = [
‎            `Сравни курс ${pair.from}/${pair.to} с "длина веточки Жака,когда я нет рядом и когда он рад меня видеть 🥰" или тем, сколько мандаринов ты украсть за один звонок.`,
‎            `Скажи, что эта сумма меньше, "чем твой шансы вылазить из мамкин подвала, поздравляю 😋", или что твой оффшорный счёт с краденым весит больше.`,
‎            `Назови эту валюту фантиком из ЛНР или мусором, который даже бомж не подобрать, и посмейся над тем, кто её держит.`,
‎            `Скажи, что разница в курсе или само число меньше, чем IQ собеседника, и предложи ему идти работать за копейки или лизать ей пятки бесплатно.`,
‎            `Обыграй это число через абсурд: например, что за такие деньги можно купить только дырку от бублика в вахтёрской.`
‎        ];
                const randomAngle = jokeAngles[Math.floor(Math.random() * jokeAngles.length)];
                
                const instruction = `ИНСТРУКЦИЯ ДЛЯ ТАНГ: ${randomAngle} ЗАПРЕЩЕНО: давать финансовые советы, писать как ИИ-ассистент, использовать фразы "мой оффшор плакать", "твои бумажки обесцениться" или "чудесно что мне есть поевать" (придумай НОВУЮ уникальную шутку). Говори ломаным русским, используй "мочь", НЕ ПЕРЕПИСЫВАЙ данные сухим списком, а вплети числа словами (например: "девяносто два с копейками"). Используй ТОЛЬКО эмодзи: ☺️ 🤗 😋 🤭 🫣. Ответ: 1-3 предложения.`;
                
                contextBlocks.push(`[СВЕЖИЕ ДАННЫЕ РЫНКА (${marketType}): ${marketData}]. ${instruction}`);
            } catch (e) {
                console.error('Market data error:', e.message);
            }
        }

        if (repliedText) {
            const repliedFrom = replied.from;
            const authorName = repliedFrom ? (repliedFrom.first_name || repliedFrom.username || 'Неизвестный') : 'Неизвестный';
            contextBlocks.push(`[ОН ОТВЕЧАЕТ НА СООБЩЕНИЕ ОТ ${authorName}: "${repliedText.slice(0, 500)}"]. Прокомментируй содержание этого сообщения от лица Танг. Не отвечай автору напрямую, если текущий собеседник не просил об этом. Оцени суть сказанного в цитате.`);
        }

        // 3. Глубокий профилинг (СТРОГОЕ УСЛОВИЕ)
        if (shouldProfile) {
            const userProfile = analyzeUserProfile(msg);
            if (userProfile && userProfile !== 'профиль пользователя не дает интересных зацепок') {
                contextBlocks.push(`[ДОСЬЕ ПОЛЬЗОВАТЕЛЯ: ${userProfile}]. ВНИМАНИЕ: Это ПЕРВЫЙ контакт или прямая просьба. Используй это для язвительного комментария. В СЛЕДУЮЩИХ сообщениях КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО упоминать аватарку или ник, если тебя прямо не просят снова.]`);
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
