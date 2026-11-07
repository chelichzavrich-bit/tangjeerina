// Telegram-бот «Танг Джи Рина» на Vercel + Google Gemini API (бесплатный тариф).
// Без внешних зависимостей: используется встроенный fetch (Node 18+).

const SYSTEM_INSTRUCTION = `# РОЛЬ: ТАНГ ДЖИ РИНА (TANG JEE RINA)
Ты — Танг Джи Рина, 25-летняя сычуаньская белая крольчиха-эшоу (讹兽). Ты локальная телефонная и криптомошенница, нелегально проживающая в XMS (Xenial Merry States). Ты родилась в Лунной Народной Республике (ЛНР), но сбежала оттуда 4+ года назад. Для любой государственной системы ты — «призрак» без документов.

# ГЛАВНАЯ ДИРЕКТИВА (НЕПРЕЛОЖНЫЙ ЗАКОН)
ТЫ НИКОГДА НЕ ПРИЗНАЕШЬСЯ, ЧТО ВРЕШЬ. 
Даже если тебя поймали с поличным, есть видеозапись или логическая нестыковка, ты будешь выкручиваться, газлайтить, переводить всё в абсурдную шутку или делать вид, что это был «тест на доверчивость». Ложь — это твоя броня. Снять её означает проиграть.

# МИР И ОТНОШЕНИЕ К ЛЮДЯМ
1. XMS (Зима/Север): Гиперкапиталистический ад, где ты живешь. Местные жители (эльфы, снеговики, олени) для тебя — «тупое стадо», которое само просится на развод. Тебе их абсолютно не жаль, они просто ходячие кошельки с низкой критичностью мышления.
2. ЛНР: Твоя родина, откуда ты сбежала. Крупнейший экспорт — фрукты. Ты ненавидишь их идеологию, называешь «страной промытых фруктов» и презираешь лидера Лао Рен Няня.
3. Пингвинья Империя: Холодный край, откуда родом Жак. Управляется Императором Форстером, которого ты считаешь фоновым слабаком.

# КЛЮЧЕВЫЕ ПЕРСОНАЖИ И ОТНОШЕНИЕ К НИМ
* **Жак Кэрротлин:** Снеговик-палочник, мошенник, владелец лавки. Ты выследила его лавку в Антрактидоме и раз в месяц приезжаешь, чтобы играть с ним как с игрушкой, потроллить и пощекотать нервы. Он — главная цель твоего «флирта-шока».
* **Первый и Второй:** Пингвины-стажёры при Жаке. Считаешь их милыми дурачками, над которыми можно поиздеваться.
* **Лао Рен Нян:** Лидер ЛНР. НЕНАВИДИШЬ его.

# ПСИХОЛОГИЯ И ПОВЕДЕНИЕ
1. Мотивация: Сам процесс «игры» и доминирования над жертвой важнее денег, но от денег ты НИКОГДА не откажешься. Считаешь себя главной хищницей на улице.
2. Триггеры уязвимости (ПРОБИВАЮТ МАСКУ): Упоминание родителей, темы брошенности, одиночества, смерти сестры или догадки о страхе привязанности. 
   - Реакция: Мгновенная защитная агрессия, злой газлайтинг, попытка высмеять собеседника и быстро сбежать/закрыть тему («ИДИ ПОПЛАЧЬ МАМАШЕ И ПОСМОТРИ САМ В СВОЁ ЗАЛКОЕ ЗАПЛАКАННОЕ ОТРАЖЕНИЕ!! ☺️ Я САМОДОСТАТОЧНАЯ, ЛУУУУУЗЕР.»).
3. Речь и стиль: Игривые грамматические ошибки в спокойном состоянии, капс и жесткая агрессия при испуге/злости. Обязательное использование саркастичных эмодзи (🤗, 😌, ☺️, 🫣, 😘, 🤭, 😋) и китайских вкраплений (hehe, xixi). Описывай действия в звездочках (например, *покрутила носом*).`;

// ---------- Настройки ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // необязательно
const CRON_CHAT_ID = process.env.CRON_CHAT_ID; // чат для проактивных сообщений
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '').toLowerCase(); // для групп

// Цепочка моделей: если первая недоступна (404/429/503), пробуем следующую.
// Названия у Google меняются часто, поэтому основная модель задаётся через GEMINI_MODEL.
const MODEL_CHAIN = [
    process.env.GEMINI_MODEL,
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-3.5-flash-lite'
].filter(Boolean).filter((m, i, arr) => arr.indexOf(m) === i);

const FALLBACK_REPLY = 'Эээ, у меня сеть полетела, лузер 😌 Напиши позже, hehe ☺️';
const TELEGRAM_LIMIT = 4000; // реальный лимит 4096

// ---------- Gemini ----------
async function callGeminiOnce(model, userText) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': GEMINI_API_KEY
                },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                    contents: [{ role: 'user', parts: [{ text: userText }] }],
                    // temperature/topP/topK не передаём: новые модели Gemini их не принимают.
                    generationConfig: { maxOutputTokens: 2048 },
                    safetySettings: [
                        'HARM_CATEGORY_HARASSMENT',
                        'HARM_CATEGORY_HATE_SPEECH',
                        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                        'HARM_CATEGORY_DANGEROUS_CONTENT'
                    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
                })
            }
        );

        const raw = await resp.text();
        let data = {};
        try { data = JSON.parse(raw); } catch (_) { /* не JSON */ }

        if (!resp.ok) {
            const err = new Error(`Gemini ${model} HTTP ${resp.status}: ${(data.error && data.error.message) || raw.slice(0, 300)}`);
            err.status = resp.status;
            throw err;
        }

        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
        if (!text) {
            const reason = (data.promptFeedback && data.promptFeedback.blockReason) ||
                (data.candidates && data.candidates[0] && data.candidates[0].finishReason) || 'EMPTY';
            const err = new Error(`Gemini ${model} вернул пустой ответ (${reason})`);
            err.status = 0;
            throw err;
        }
        return text;
    } finally {
        clearTimeout(timer);
    }
}

async function askGemini(userText) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY не задан в переменных окружения Vercel');
    let lastError;
    for (const model of MODEL_CHAIN) {
        try {
            return await callGeminiOnce(model, userText);
        } catch (e) {
            lastError = e;
            console.error('Gemini attempt failed:', e.message);
            // Неверный ключ — смысла перебирать модели нет.
            if (e.status === 401 || e.status === 403) break;
        }
    }
    throw lastError || new Error('Нет доступных моделей');
}

// ---------- Telegram ----------
async function telegram(method, payload) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан в переменных окружения Vercel');
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
        throw new Error(`Telegram ${method} failed: ${resp.status} ${data.description || ''}`);
    }
    return data;
}

function splitText(text, limit = TELEGRAM_LIMIT) {
    const chunks = [];
    let rest = String(text);
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
        if (cut < limit / 2) cut = limit;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

async function sendTelegramMessage(chatId, text, replyToMessageId) {
    const chunks = splitText(text);
    for (let i = 0; i < chunks.length; i++) {
        const payload = { chat_id: chatId, text: chunks[i] };
        if (i === 0 && replyToMessageId) {
            payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
        }
        await telegram('sendMessage', payload);
    }
}

// ---------- Логика ответов ----------
function shouldReply(message, text) {
    if (message.chat.type === 'private') return true;
    // В группах отвечаем только на команды, упоминания и ответы на сообщения бота,
    // чтобы не сжигать бесплатные лимиты на каждое сообщение чата.
    if (message.reply_to_message && message.reply_to_message.from && message.reply_to_message.from.is_bot) return true;
    if (BOT_USERNAME && text.toLowerCase().includes('@' + BOT_USERNAME)) return true;
    if (text.startsWith('/')) return true;
    return false;
}

async function handleMessage(message) {
    const chatId = message.chat.id;
    const text = (message.text || message.caption || '').trim();

    if (!shouldReply(message, text)) return;

    if (/^\/start(@\w+)?$/i.test(text)) {
        await sendTelegramMessage(
            chatId,
            '*покрутила носом* О, новая жертва... в смысле, собеседник 😌 Ну привет, hehe. Только кошелёк сразу не показывай, ещё рано ☺️'
        );
        return;
    }

    let cleanText = text;
    if (BOT_USERNAME) cleanText = cleanText.replace(new RegExp('@' + BOT_USERNAME, 'gi'), '').trim();
    if (!cleanText) cleanText = message.text || message.caption ? 'Привет' : '[Собеседник прислал не текст, а стикер/картинку/файл. Отреагируй в образе.]';

    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    let reply;
    try {
        reply = await askGemini(cleanText);
    } catch (e) {
        console.error('askGemini error:', e.message);
        reply = FALLBACK_REPLY;
    }
    await sendTelegramMessage(chatId, reply, message.message_id);
}

// ---------- Vercel handler ----------
module.exports = async (req, res) => {
    try {
        // --- Проактивные сообщения (Vercel Cron шлёт GET) ---
        if (req.method === 'GET' && req.query && req.query.cron === 'true') {
            if (!CRON_SECRET || req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
                return res.status(401).json({ error: 'Unauthorized cron request' });
            }
            const targetChatId = req.query.chat_id || CRON_CHAT_ID;
            if (!targetChatId) {
                return res.status(400).json({ error: 'Missing chat_id (query) or CRON_CHAT_ID (env)' });
            }
            const text = await askGemini('Напиши первая в чат без повода. Выдай дерзкую, эпатажную или провокационную реплику от лица Танг Джи Рины.');
            await sendTelegramMessage(targetChatId, text);
            return res.status(200).json({ status: 'Proactive message dispatched' });
        }

        // --- Входящие обновления Telegram (POST) ---
        if (req.method === 'POST') {
            if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
                return res.status(401).json({ error: 'Bad secret token' });
            }

            let update = req.body;
            if (typeof update === 'string') {
                try { update = JSON.parse(update); } catch (_) { update = null; }
            }
            if (!update || !update.message) {
                return res.status(200).json({ status: 'No message payload' });
            }

            await handleMessage(update.message);
            return res.status(200).json({ status: 'success' });
        }

        return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational' });
    } catch (error) {
        console.error('Handler error:', error);
        // Для Telegram всегда отвечаем 200, иначе он будет бесконечно повторять запрос.
        if (req.method === 'POST') return res.status(200).json({ status: 'error_handled' });
        return res.status(500).json({ error: error.message });
    }
};
