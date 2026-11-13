// «Пульс»: Танг сама пишет в чат. Вызывается по HTTP снаружи (GitHub Actions раз в час + Vercel Cron раз в сутки).
//  1) Тишина: если в чате никто не писал больше SILENCE_HOURS (12 ч) - пишет сама.
//  2) Голосовое: примерно раз в 2 дня пингует случайного участника заготовленным голосовым.
const { cfg } = require('./config');
const memory = require('./memory');
const { sendMessage, telegram } = require('./telegram');
const { generateReply, buildContents } = require('./ai');
const { PULSE_PROMPT, VOICE_CAPTIONS } = require('./prompts');
const { timeContext, rosterContext } = require('./context');

const HOUR = 3600000;
const rand = (min, max) => min + Math.random() * (max - min);
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

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

const isDeadChatError = (msg) => /HTTP 403|chat not found|bot was kicked|bot is not a member|user is deactivated/i.test(String(msg));

// ═══════════════════════════════════════════════════════════════
// ГОЛОСОВОЙ ПИНГ (не использует Gemini - работает даже при лимитах)
// Случайный участник чата + случайное заготовленное голосовое. Интервал ~48 ч + случайный разброс 0-8 ч.
// force=true - тестовый прогон без ожидания и без тихих часов.
// ═══════════════════════════════════════════════════════════════
async function pickVictim(chatId, now) {
    const roster = (await memory.getRoster(chatId)).filter((r) => now - r.seen < 14 * 24 * HOUR);
    const pool = roster.map((r) => ({ id: r.id, name: r.name, username: r.username }));
    for (const t of csv(process.env.VOICE_PING_TARGETS)) {
        if (!pool.some((p) => String(p.id) === t)) pool.push({ id: t });
    }
    if (!pool.length) return null;
    const v = pickOne(pool);
    if (!v.name && !v.username) {
        try {
            const r = await telegram('getChatMember', { chat_id: chatId, user_id: Number(v.id) });
            const u = r && r.result && r.result.user;
            if (u) { v.name = u.first_name || ''; v.username = u.username || ''; }
        } catch (_) { /* имя не узнали - упомянем без имени */ }
    }
    return v;
}

function buildCaption(victim) {
    const template = pickOne(VOICE_CAPTIONS);
    const name = victim.username ? `@${victim.username}` : (victim.name || 'лошок');
    const caption = template.replace('{name}', name);
    // У человека нет ника - пингуем через text_mention (работает по id и приходит ему как упоминание)
    if (!victim.username && victim.name && caption.startsWith(name)) {
        return { caption, caption_entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: Number(victim.id) } }] };
    }
    return { caption };
}

async function handleVoicePing(force = false, onlyChat = null) {
    const c = cfg();
    const now = Date.now();
    const files = csv(process.env.DAILY_VOICE_FILE_ID);
    const reasons = [];
    if (!files.length) return { status: 'skipped', reason: 'DAILY_VOICE_FILE_ID не задан', reasons };
    if (!force && inQuietHours(c.pulseQuiet, c.pulseTz)) return { status: 'skipped', reason: 'тихие часы', reasons };

    let chatIds = onlyChat ? [String(onlyChat)] : csv(process.env.VOICE_PING_CHAT_ID);
    const explicit = chatIds.length > 0;
    if (!explicit) chatIds = (await memory.activeChats(now - 7 * 24 * HOUR)).map(String);
    if (!chatIds.length) return { status: 'skipped', reason: 'нет чатов', reasons };

    let sent = 0;
    for (const chatId of shuffle(chatIds)) {
        if (sent >= 3) break;
        try {
            const meta = await memory.getMeta(chatId);
            if (!explicit && !force && meta.type && meta.type !== 'group' && meta.type !== 'supergroup') continue;

            if (!force) {
                // первый раз - просто назначаем случайное время в ближайшие сутки
                if (!meta.nextVoiceAt) {
                    await memory.patchMeta(chatId, { nextVoiceAt: now + rand(1, 24) * HOUR });
                    reasons.push(`${chatId}: запланировано`);
                    continue;
                }
                if (now < meta.nextVoiceAt) { reasons.push(`${chatId}: рано`); continue; }
            }

            const victim = await pickVictim(chatId, now);
            if (!victim) { reasons.push(`${chatId}: некого пинговать (нет участников и VOICE_PING_TARGETS)`); continue; }

            const { caption, caption_entities } = buildCaption(victim);
            const payload = { chat_id: chatId, voice: pickOne(files), caption };
            if (caption_entities) payload.caption_entities = caption_entities;
            await telegram('sendVoice', payload);

            const next = now + c.voiceEveryHours * HOUR - 4 * HOUR + rand(0, 12) * HOUR; // ~2 дня, +-
            await memory.logBot(chatId, [{ r: 'm', t: `[отправила заготовленное голосовое для ${victim.name || victim.username || 'участника'}: «${caption.slice(0, 120)}»]` }], {
                extraMeta: { lastVoicePingAt: now, nextVoiceAt: Math.round(next) }
            });
            sent++;
        } catch (e) {
            console.error(`[Voice Ping] ${chatId}:`, e.message);
            reasons.push(/wrong file|file_id|file not found/i.test(e.message)
                ? `${chatId}: BAD_FILE_ID (file_id должен быть получен ЭТИМ ботом)`
                : `${chatId}: ${e.message.slice(0, 120)}`);
            if (isDeadChatError(e.message)) await memory.removeChat(chatId);
        }
    }
    return { status: 'success', sent, force, reasons };
}

// ═══════════════════════════════════════════════════════════════
// ТИШИНА: чат молчит больше SILENCE_HOURS - Танг пишет сама
// ═══════════════════════════════════════════════════════════════
async function runSilencePulse({ force = false, chatId = null } = {}) {
    const c = cfg();
    const now = Date.now();
    const deadline = now + 25000;
    const persistent = memory.isPersistent();
    const summary = { persistent, sent: 0, skipped: [], errors: [] };

    if (!persistent && !force) { summary.note = 'Нет Redis: бот не знает, когда в чатах тихо. Подключите Upstash Redis.'; return summary; }
    if (!force && inQuietHours(c.pulseQuiet, c.pulseTz)) { summary.note = 'Тихие часы'; return summary; }

    const ids = new Set(csv(process.env.CRON_CHAT_ID));
    if (chatId) { ids.clear(); ids.add(String(chatId)); }
    else if (persistent) (await memory.activeChats(now - c.pulseActiveDays * 24 * HOUR)).forEach((id) => ids.add(String(id)));

    for (const id of shuffle([...ids])) {
        if (summary.sent >= c.pulseMaxChats || Date.now() > deadline - 5000) break;
        try {
            const meta = await memory.getMeta(id);
            if (!force) {
                const quietFor = Math.min(now - (meta.lastActivity || 0), now - (meta.lastBotAt || 0));
                if (quietFor < c.silenceHours * HOUR) { summary.skipped.push(`${id}: ещё не тихо`); continue; }
                if ((meta.unanswered || 0) >= c.pulseMaxUnanswered) { summary.skipped.push(`${id}: ждёт ответа`); continue; }
            }
            const [history, roster] = await Promise.all([memory.getHistory(id), memory.getRoster(id)]);
            const parts = [{ text: [timeContext(), rosterContext(roster), PULSE_PROMPT].filter(Boolean).join('\n') }];
            const { text } = await generateReply(buildContents(history, parts), { userLen: 200, deadline });
            await sendMessage(id, text);
            await memory.logBot(id, [{ r: 'm', t: text }], { pulse: true });
            summary.sent++;
        } catch (e) {
            console.error(`Pulse error for ${id}:`, e.message);
            summary.errors.push(`${id}: ${String(e.message).slice(0, 120)}`);
            if (isDeadChatError(e.message)) await memory.removeChat(id);
        }
    }
    return summary;
}

// ═══════════════════════════════════════════════════════════════
// ВХОДНАЯ ТОЧКА
//   /api/pulse                     - обычный «тик»: голосовой пинг + проверка тишины (его дёргает GitHub Actions)
//   /api/pulse?voice=1             - только голосовой пинг (+ &voice_force=1 - отправить сейчас)
//   /api/pulse?force=1&chat_id=ID  - тест: написать в чат сейчас, игнорируя таймеры
//   /api/pulse?daily=1             - то же, что обычный тик (для Vercel Cron)
// ═══════════════════════════════════════════════════════════════
async function handlePulseRequest(req, res, opts = {}) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const q = req.query || {};
    const on = (v) => v === '1' || v === 'true';
    const voiceForce = on(q.voice_force) || process.env.VOICE_PING_FORCE === '1';

    try {
        if (on(q.voice)) {
            return res.status(200).json({ voicePing: await handleVoicePing(voiceForce, q.chat_id || null) });
        }
        if (on(q.force)) {
            return res.status(200).json(await runSilencePulse({ force: true, chatId: q.chat_id || null }));
        }
        // обычный тик: голос идёт первым и не зависит от Gemini
        const voicePing = await handleVoicePing(voiceForce);
        let summary;
        try {
            summary = await runSilencePulse({ chatId: q.chat_id || null });
        } catch (e) {
            console.warn('[Pulse] silence pulse failed:', e.message);
            summary = { sent: 0, skipped: [], errors: [String(e.message).slice(0, 120)] };
        }
        summary.voicePing = voicePing;
        return res.status(200).json(summary);
    } catch (e) {
        console.error('Pulse handler error:', e);
        return res.status(500).json({ error: e.message });
    }
}

module.exports = { runSilencePulse, handlePulseRequest, inQuietHours, handleVoicePing };
