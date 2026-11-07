// Telegram-бот «Танг Джи Рина» на Vercel + Google Gemini (бесплатный tier).
// Без внешних зависимостей: только встроенный fetch (Node 18+).
//
// ENV (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN        — токен от @BotFather                       (обязательно)
//   GEMINI_API_KEY            — ключ из https://aistudio.google.com/apikey (обязательно)
//   CRON_SECRET               — любая случайная строка (>=16 символов)     (для крона)
//   CRON_CHAT_ID              — chat_id, куда писать проактивно (можно несколько через запятую)
//   TELEGRAM_WEBHOOK_SECRET   — необязательно; тот же secret_token, что в setWebhook
//   GEMINI_MODEL              — необязательно; модель, которую пробовать первой

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

// ──────────────────────────────────────────────────────────────
// Служебная приписка. Лор/персонаж выше НЕ изменяется — это отдельный блок.
// Можно удалить, если не нужна.
// ──────────────────────────────────────────────────────────────
const RUNTIME_NOTE = `

# ТЕХНИЧЕСКАЯ ЗАМЕТКА (формат ответа)
Ты общаешься в чате Telegram. Отвечай живо и в образе, обычно 1–6 предложений. Не используй markdown-заголовки и таблицы. Всегда остаёшься Танг Джи Риной и придерживаешься всего, что описано выше. Ты не даёшь реальных рабочих инструкций по мошенничеству и не просишь реальных данных карт/паролей — вся «мошенническая» часть остаётся игрой и сюжетом.`;

const FULL_SYSTEM_INSTRUCTION = SYSTEM_INSTRUCTION + RUNTIME_NOTE;

// Порядок попыток. Если модель недоступна (404 / лимит / перегрузка) — берём следующую.
const MODEL_CHAIN = [
    process.env.GEMINI_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3-flash-preview'
].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);

const SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

const FALLBACK_REPLY = '*покрутила носом* Хмм, связь с моим «офисом» шалит, повтори позже, hehe 😌';

async function callGemini(model, userText, temperature) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: FULL_SYSTEM_INSTRUCTION }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: { temperature, maxOutputTokens: 2048 },
            safetySettings: SAFETY_SETTINGS
        })
    });

    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) { /* не JSON */ }

    if (!r.ok) {
        const err = new Error(`Gemini ${model} HTTP ${r.status}: ${(data.error && data.error.message) || raw.slice(0, 300)}`);
        err.status = r.status;
        throw err;
    }

    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
        ? cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
        : '';
    return text; // пустая строка = ответ заблокирован фильтром или пуст
}

async function generateReply(userText, temperature = 0.95) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    let lastError;
    for (const model of MODEL_CHAIN) {
        try {
            const text = await callGemini(model, userText, temperature);
            if (text) return text;
            return FALLBACK_REPLY;
        } catch (e) {
            lastError = e;
            console.error(String(e.message));
            // 404 (модель снята), 429 (лимит), 5xx (перегрузка), 400 (неподдерживаемый параметр) → следующая модель
            if ([400, 404, 429, 500, 502, 503, 504].includes(e.status)) continue;
            throw e; // 401/403 (плохой ключ) — перебор бессмысленен
        }
    }
    throw lastError || new Error('No model available');
}

async function telegram(method, payload) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!r.ok) {
        const body = await r.text();
        throw new Error(`Telegram ${method} HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
}

async function sendTelegramMessage(chatId, text, replyToMessageId) {
    const LIMIT = 4000; // лимит Telegram — 4096
    const chunks = [];
    for (let i = 0; i < text.length; i += LIMIT) chunks.push(text.slice(i, i + LIMIT));
    for (let i = 0; i < chunks.length; i++) {
        const payload = { chat_id: chatId, text: chunks[i] };
        if (i === 0 && replyToMessageId) {
            payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
        }
        await telegram('sendMessage', payload);
    }
}

function parseBody(req) {
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (_) { return null; }
    }
    return req.body || null;
}

module.exports = async (req, res) => {
    // ── GET: проактивные сообщения (Vercel Cron) ──
    if (req.method === 'GET') {
        const query = req.query || {};
        if (query.cron !== 'true') {
            return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational' });
        }

        const secret = process.env.CRON_SECRET;
        if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
            return res.status(401).json({ error: 'Unauthorized cron request' });
        }

        const chatIds = String(query.chat_id || process.env.CRON_CHAT_ID || '')
            .split(',').map((s) => s.trim()).filter(Boolean);
        if (!chatIds.length) {
            return res.status(400).json({ error: 'Missing chat_id (query) or CRON_CHAT_ID (env)' });
        }

        try {
            const text = await generateReply(
                'Напиши первая в чат без повода. Выдай дерзкую, эпатажную или провокационную реплику от лица Танг Джи Рины.'
            );
            for (const id of chatIds) await sendTelegramMessage(id, text);
            return res.status(200).json({ status: 'Proactive message dispatched', chats: chatIds.length });
        } catch (e) {
            console.error('Cron error:', e);
            return res.status(500).json({ error: e.message });
        }
    }

    // ── POST: входящие обновления Telegram ──
    if (req.method === 'POST') {
        const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
        if (expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) {
            return res.status(401).json({ error: 'Bad webhook secret' });
        }

        const update = parseBody(req);
        const msg = update && update.message;
        if (!msg || !msg.chat) {
            return res.status(200).json({ status: 'No message payload' });
        }

        const chatId = msg.chat.id;
        let userText = msg.text || msg.caption || '';
        if (!userText) userText = 'Привет';
        if (/^\/start(@\w+)?(\s|$)/.test(userText)) {
            userText = 'Привет! (человек только что запустил бота — поздоровайся в образе)';
        }

        try {
            telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
            const botReply = await generateReply(userText);
            await sendTelegramMessage(chatId, botReply);
            return res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('Webhook processing error:', error);
            try { await sendTelegramMessage(chatId, FALLBACK_REPLY); } catch (_) { /* ignore */ }
            // Всегда 200, иначе Telegram будет бесконечно повторять доставку
            return res.status(200).json({ status: 'error_handled', message: error.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
