const API = 'https://api.telegram.org';

async function telegram(method, payload) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const r = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`Telegram ${method} HTTP ${r.status}: ${body.slice(0, 300)}`);
    try { return JSON.parse(body); } catch (_) { return {}; }
}

// Делит длинный текст на части <= limit, стараясь резать по абзацам, строкам, предложениям, пробелам.
function splitMessage(text, limit = 4000) {
    const chunks = [];
    let rest = String(text);
    while (rest.length > limit) {
        let cut = -1;
        for (const sep of ['\n\n', '\n', '. ', '! ', '? ', ' ']) {
            const i = rest.lastIndexOf(sep, limit);
            if (i > limit * 0.5) { cut = i + sep.length; break; }
        }
        if (cut < 0) cut = limit;
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest.length) chunks.push(rest);
    return chunks;
}

// Отправляет сообщения строго по порядку. Ответом (reply) оформляется только первая часть.
async function sendMessage(chatId, text, replyToMessageId) {
    const chunks = splitMessage(text || '...');
    for (let i = 0; i < chunks.length; i++) {
        const payload = { chat_id: chatId, text: chunks[i] };
        if (i === 0 && replyToMessageId) {
            payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
        }
        await telegram('sendMessage', payload);
    }
}

// Скачивает файл по file_id. Возвращает Buffer или null, если файл слишком большой.
async function downloadFile(fileId, maxBytes) {
    const info = await telegram('getFile', { file_id: fileId });
    const result = info && info.result;
    if (!result || !result.file_path) return null;
    if (result.file_size && result.file_size > maxBytes) return null;
    const r = await fetch(`${API}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`);
    if (!r.ok) throw new Error(`Telegram file download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
}

module.exports = { telegram, sendMessage, splitMessage, downloadFile };
