// «Пульс»: бот сам пишет в чат, когда там тишина. Вызывается по HTTP (api/pulse.js) снаружи.
const { cfg } = require('./config');
const memory = require('./memory');
const { sendMessage, telegram } = require('./telegram');
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

// ═══════════════════════════════════════════════════════════════
// Логика ежедневного голосового пинга по списку ID
// ═══════════════════════════════════════════════════════════════
async function handleDailyVoicePing() {
    const voiceFileId = process.env.DAILY_VOICE_FILE_ID;
    const targetsEnv = process.env.VOICE_PING_TARGETS || '';
    const probability = parseFloat(process.env.VOICE_PING_PROBABILITY || '0.3');
    const today = new Date().toISOString().split('T')[0]; // Формат: "YYYY-MM-DD"
    
    if (!voiceFileId) {
        console.warn('[Voice Ping] DAILY_VOICE_FILE_ID не задан в ENV. Пропущено.');
        return { status: 'skipped', reason: 'No file_id' };
    }

    const targets = targetsEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
    if (targets.length === 0) {
        console.warn('[Voice Ping] VOICE_PING_TARGETS пуст в ENV. Пропущено.');
        return { status: 'skipped', reason: 'No targets' };
    }

    const chatIds = await memory.activeChats(Date.now() - 14 * 86400000);
    let sentCount = 0;
    let skippedCount = 0;

    for (const chatId of shuffle(chatIds)) {
        if (sentCount >= 3) break; // Лимит на один прогон, чтобы уложиться в 10 сек Vercel

        try {
            let meta = await memory.getMeta(chatId);
            if (!meta) meta = {};
            
            // 1. Если сегодня в этом чате уже пинговали — пропускаем
            if (meta.lastVoicePing === today) {
                skippedCount++;
                continue;
            }

            // 2. Бросаем кубик вероятности
            if (Math.random() > probability) {
                skippedCount++;
                continue;
            }

            // 3. Выбираем случайную жертву из списка
            const targetIdStr = targets[Math.floor(Math.random() * targets.length)];
            const targetId = parseInt(targetIdStr, 10);
            
            // Страховка: если в ENV попал нечисловой символ, пропускаем этого юзера
            if (isNaN(targetId)) {
                console.warn(`[Voice Ping] Невалидный ID в списке: ${targetIdStr}`);
                continue;
            }
            
            // 4. Пытаемся получить username для красивого тега
            let mentionText = 'Специально для тебя, лошок ☺️';
            try {
                const memberRes = await telegram('getChatMember', { chat_id: chatId, user_id: targetId });
                if (memberRes && memberRes.result && memberRes.result.user) {
                    const user = memberRes.result.user;
                    if (user.username) {
                        mentionText = `@${user.username}, специально для тебя, лошок ☺️`;
                    } else if (user.first_name) {
                        mentionText = `${user.first_name}, специально для тебя, лошок ☺️`;
                    }
                }
            } catch (e) {
                // Если пользователя нет в чате или он заблокировал бота, используем дефолтный текст
                console.warn(`[Voice Ping] Не удалось получить данные пользователя ${targetId} в чате ${chatId}`);
            }

            // 5. Отправляем голосовое
            await telegram('sendVoice', {
                chat_id: chatId,
                voice: voiceFileId,
                caption: mentionText
            });

            // 6. Обновляем дату последнего пинга
            meta.lastVoicePing = today;
            await memory.setMeta(chatId, meta);
            
            sentCount++;
            console.log(`[Voice Ping] Успешно отправлено в чат ${chatId}, цель: ${targetId}`);
            
        } catch (e) {
            console.error(`[Voice Ping] Критическая ошибка для чата ${chatId}:`, e.message);
            if (/HTTP 403|chat not found|bot was kicked|user is deactivated/i.test(e.message)) {
                await memory.removeChat(chatId);
            }
        }
    }

    return { status: 'success', sent: sentCount, skipped: skippedCount };
}

// ═══════════════════════════════════════════════════════════════
// ОСНОВНАЯ ЛОГИКА PULSE (текстовая проактивность)
// ═══════════════════════════════════════════════════════════════
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
            if ((meta.unanswered || 0) >= c.pulseMaxUnanswered) { 
                summary.skipped.push(`${id}: ждёт ответа`); 
                continue; 
            }
            if (now < meta.next) { 
                summary.skipped.push(`${id}: рано`); 
                continue; 
            }
        }

        try {
            const history = await memory.getHistory(id);
            const contents = buildContents(history, [{ text: PULSE_PROMPT }]);
            const { text } = await generateReply(contents, { userLen: 200, deadline });
            await sendMessage(id, text);
            await memory.addHistory(id, [{ r: 'm', t: text }]);
            if (persistent) {
                await memory.setMeta(id, { 
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

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТЧИК ЗАПРОСА (маршрутизация)
// ═══════════════════════════════════════════════════════════════
async function handlePulseRequest(req, res, opts = {}) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const q = req.query || {};
    
    try {
        // Если запрошен daily=1, запускаем обычный pulse, а затем с вероятностью — голосовой пинг
        if (opts.daily || q.daily === '1' || q.daily === 'true') {
            const summary = await runPulse({ daily: true, chatId: q.chat_id || null });
            const voiceResult = await handleDailyVoicePing();
            summary.voicePing = voiceResult;
            return res.status(200).json(summary);
        }
        
        // Обычный force запуск (без voice ping)
        const summary = await runPulse({
            force: q.force === '1' || q.force === 'true',
            chatId: q.chat_id || null
        });
        return res.status(200).json(summary);
        
    } catch (e) {
        console.error('Pulse handler error:', e);
        return res.status(500).json({ error: e.message });
    }
}

module.exports = { runPulse, handlePulseRequest, inQuietHours, handleDailyVoicePing };
