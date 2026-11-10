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
        // Берём чаты, активные за последние 14 дней (как было), но фильтрация по lastActivity будет ниже
        (await memory.activeChats(now - c.pulseActiveDays * 86400000)).forEach((id) => ids.add(String(id)));
    }

    for (const id of shuffle([...ids])) {
        if (summary.sent >= c.pulseMaxChats || Date.now() > deadline - 4000) break;
        
        let meta = null;
        if (persistent && !force) {
            meta = await memory.getMeta(id);
            if (!meta) continue;

            const lastActivity = meta.lastActivity || now;
            const timeSinceActivity = now - lastActivity;

            // Симптом 4: Если чат мёртв (последнее сообщение > 24 часов назад), молчим, не спамим
            if (timeSinceActivity > 24 * 60 * 60 * 1000) {
                summary.skipped.push(`${id}: мёртвый чат`);
                continue;
            }

            // Если активность свежая (< 2 часов), строго соблюдаем лимиты unanswered
            if (timeSinceActivity < 2 * 60 * 60 * 1000) {
                if ((meta.unanswered || 0) >= c.pulseMaxUnanswered) {
                    summary.skipped.push(`${id}: ждёт ответа`);
                    continue;
                }
                if (now < meta.next) {
                    summary.skipped.push(`${id}: рано`);
                    continue;
                }
            } else {
                // Активность была, но не совсем свежая. Даём редкий шанс "разбудить", но проверяем таймер
                if (now < meta.next) {
                    summary.skipped.push(`${id}: рано`);
                    continue;
                }
            }
        }

        try {
            const history = await memory.getHistory(id);
            // Если истории нет, не пишем в пустоту
            if (!history || history.length === 0) {
                summary.skipped.push(`${id}: нет истории`);
                continue;
            }

            const contents = buildContents(history, [{ text: PULSE_PROMPT }]);
            const { text } = await generateReply(contents, { userLen: 200, deadline });
            
            await sendMessage(id, text);
            await memory.addHistory(id, [{ r: 'm', t: text }]);
            
            if (persistent) {
                await memory.setMeta(id, { 
                    ...meta, 
                    next: Date.now() + randInterval(c), 
                    unanswered: ((meta && meta.unanswered) || 0) + 1 
                });
            }
            summary.sent++;
        } catch (e) {
            console.error(`Pulse error for ${id}:`, e.message);
            summary.errors.push(`${id}: ${e.message.slice(0, 120)}`);
            if (/HTTP 403|chat not found|bot was kicked|user is deactivated/i.test(e.message)) {
                await memory.removeChat(id);
            }
        }
    }
    return summary;
}

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
