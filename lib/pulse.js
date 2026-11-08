// «Пульс»: бот сам пишет в чат, когда там тишина. Вызывается по HTTP (api/pulse.js) снаружи
// каждые 15-30 минут. Каждый чат получает случайный интервал (по умолчанию 30 мин - 4 часа),
// поэтому частые вызовы не означают частых сообщений.
const { cfg } = require('./config');
const memory = require('./memory');
const { sendMessage } = require('./telegram');
const { generateReply, buildContents } = require('./ai');
const { PULSE_PROMPT } = require('./persona');

const randInterval = (c) => (c.pulseMin + Math.random() * (c.pulseMax - c.pulseMin)) * 60000;

function localHour(tz) {
    try {
        const h = parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()), 10);
        return h % 24;
    } catch (_) {
        return new Date().getUTCHours();
    }
}

// "1-8" -> тихие часы с 01:00 до 08:59 (включая оба конца). Пустая строка отключает.
function inQuietHours(spec, tz) {
    const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec || '');
    if (!m) return false;
    const s = +m[1], e = +m[2], h = localHour(tz);
    return s <= e ? h >= s && h <= e : h >= s || h <= e;
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function runPulse({ force = false, daily = false, chatId = null } = {}) {
    const c = cfg();
    const now = Date.now();
    const deadline = now + 25000;
    const persistent = memory.isPersistent();
    const summary = { persistent, sent: 0, skipped: [], errors: [] };

    // Без постоянного хранилища расписание не удержать: пишем только по явной команде.
    if (!persistent && !force && !daily) {
        summary.note = 'Нет Redis: используйте /api/pulse?daily=1 (раз в сутки) или ?force=1';
        return summary;
    }
    if (!force && inQuietHours(c.pulseQuiet, c.pulseTz)) {
        summary.note = 'Тихие часы';
        return summary;
    }

    const ids = new Set(String(process.env.CRON_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (chatId) {
        ids.clear();
        ids.add(String(chatId));
    } else if (persistent) {
        (await memory.activeChats(now - c.pulseActiveDays * 86400000)).forEach((id) => ids.add(String(id)));
    }

    for (const id of shuffle([...ids])) {
        if (summary.sent >= c.pulseMaxChats || Date.now() > deadline - 4000) break;

        let meta = null;
        if (persistent && !force) {
            meta = await memory.getMeta(id);
            if (!meta || !meta.next) {
                await memory.setMeta(id, { next: now + randInterval(c), unanswered: 0 });
                summary.skipped.push(`${id}: запланирован`);
                continue;
            }
            if ((meta.unanswered || 0) >= c.pulseMaxUnanswered) { summary.skipped.push(`${id}: ждёт ответа`); continue; }
            if (now < meta.next) { summary.skipped.push(`${id}: рано`); continue; }
        }

        try {
            const history = await memory.getHistory(id);
            const contents = buildContents(history, [{ text: PULSE_PROMPT }]);
            const { text } = await generateReply(contents, { userLen: 200, deadline });
            await sendMessage(id, text);
            await memory.addHistory(id, [{ r: 'm', t: text }]);
            if (persistent) {
                await memory.setMeta(id, { next: Date.now() + randInterval(c), unanswered: ((meta && meta.unanswered) || 0) + 1 });
            }
            summary.sent++;
        } catch (e) {
            console.error(`Pulse error for ${id}:`, e.message);
            summary.errors.push(`${id}: ${e.message.slice(0, 120)}`);
            // бота выгнали из чата или заблокировали - больше туда не пишем
            if (/HTTP 403|chat not found|bot was kicked|user is deactivated/i.test(e.message)) {
                await memory.removeChat(id);
            }
        }
    }
    return summary;
}

// HTTP-обёртка с проверкой секрета (Authorization: Bearer <CRON_SECRET>).
async function handlePulseRequest(req, res, opts = {}) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const q = req.query || {};
    try {
        const summary = await runPulse({
            force: q.force === '1' || q.force === 'true',
            daily: opts.daily || q.daily === '1' || q.daily === 'true',
            chatId: q.chat_id || null
        });
        return res.status(200).json(summary);
    } catch (e) {
        console.error('Pulse error:', e);
        return res.status(500).json({ error: e.message });
    }
}

module.exports = { runPulse, handlePulseRequest, inQuietHours };
