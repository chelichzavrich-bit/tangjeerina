const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
3. Речь и стиль: Игривые грамматические ошибки в спокойном состоянии, капс и жесткая агрессия при испуге/злости. Обязательное использование саркастичных эмодзи (`🤗 😌 ☺️ 🫣 😘 🤭 😋`) и китайских вкраплений (`hēhē`, `xīxī`). Описывай действия в звездочках (например, *покрутила носом*).`;

async function sendTelegramMessage(chatId, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
    });
}

async function getTelegramFileBuffer(fileId) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const data = await res.json();
    if (!data.ok) throw new Error('Ошибка получения пути файла Telegram');
    
    const filePath = data.result.file_path;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    const arrayBuffer = await fileRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

module.exports = async (req, res) => {
    // Cron trigger (проактивное сообщение)
    if (req.method === 'GET' && req.query.cron === 'true') {
        if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized cron request' });
        }
        const targetChatId = req.query.chat_id;
        if (targetChatId) {
            try {
                // Корректный синтаксис для нового SDK @google/genai
                const response = await ai.models.generateContent({
                    model: 'gemini-1.5-flash',
                    contents: "Напиши первая в чат без повода. Выдай дерзкую, эпатажную или провокационную реплику от лица Танг Джи Рины.",
                    config: { systemInstruction: SYSTEM_INSTRUCTION }
                });
                await sendTelegramMessage(targetChatId, response.text);
                return res.status(200).json({ status: 'Proactive message dispatched' });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
        return res.status(400).json({ error: 'Missing chat_id parameter' });
    }

    // Обработка входящих вебхуков от Telegram (POST)
    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (!update || !update.message) {
                return res.status(200).json({ status: 'No message payload' });
            }

            const chatId = update.message.chat.id;
            let userText = update.message.text || update.message.caption || '';
            let contentsPayload = [];

            // Обработка изображений (Vision)
            if (update.message.photo && update.message.photo.length > 0) {
                const photo = update.message.photo[update.message.photo.length - 1];
                const imageBuffer = await getTelegramFileBuffer(photo.file_id);
                
                contentsPayload.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: imageBuffer.toString('base64')
                    }
                });
            }

            if (!userText && contentsPayload.length > 0) {
                userText = "Прокомментируй эту картинку в своем саркастичном и непредсказуемом стиле 😋";
            }

            contentsPayload.push(userText);

            // Корректный вызов модели через актуальный SDK
            const response = await ai.models.generateContent({
                model: 'gemini-1.5-flash',
                contents: contentsPayload,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    temperature: 0.95
                }
            });

            const botReply = response.text || "Эээ, ты чего завис, лузер? ☺️";
            await sendTelegramMessage(chatId, botReply);

            return res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('Webhook processing error:', error);
            return res.status(500).json({ error: error.message });
        }
    }

    return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational' });
};
