const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

async function sendTelegramMessage(chatId, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
    });
}

module.exports = async (req, res) => {
    if (req.method === 'GET' && req.query.cron === 'true') {
        if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized cron request' });
        }
        const targetChatId = req.query.chat_id;
        if (targetChatId) {
            try {
                const model = genAI.getGenerativeModel({ 
                    model: 'gemini-1.5-flash',
                    systemInstruction: SYSTEM_INSTRUCTION
                });
                const result = await model.generateContent("Напиши первая в чат без повода. Выдай дерзкую, эпатажную или провокационную реплику от лица Танг Джи Рины.");
                const response = await result.response;
                await sendTelegramMessage(targetChatId, response.text());
                return res.status(200).json({ status: 'Proactive message dispatched' });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
        return res.status(400).json({ error: 'Missing chat_id parameter' });
    }

    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (!update || !update.message) {
                return res.status(200).json({ status: 'No message payload' });
            }

            const chatId = update.message.chat.id;
            const userText = update.message.text || update.message.caption || "Привет";

            const model = genAI.getGenerativeModel({ 
                model: 'gemini-1.5-flash',
                systemInstruction: SYSTEM_INSTRUCTION,
                generationConfig: { temperature: 0.95 }
            });

            const result = await model.generateContent(userText);
            const response = await result.response;
            const botReply = response.text() || "Эээ, ты чего завис, лузер? ☺️";
            
            await sendTelegramMessage(chatId, botReply);

            return res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('Webhook processing error:', error);
            return res.status(200).json({ status: 'error_handled', message: error.message });
        }
    }

    return res.status(200).json({ status: 'Tang Jee Rina Webhook API Operational' });
};
