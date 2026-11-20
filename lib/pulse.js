// lib/pulse.js
// «Пульс»: сама пишет в тихий чат, голосовой пинг раз в ~2 дня, календарные поводы.
const { cfg } = require('./config');
const memory = require('./memory');
const { sendMessage, telegram } = require('./telegram');
const { generateReply, buildContents } = require('./ai');
const { PULSE_PROMPT, VOICE_CAPTIONS } = require('./prompts');
const { timeContext, rosterContext } = require('./context');
const cal = require('./calendar');

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
  const s = +m[1];
  const e = +m[2];
  const h = localHour(tz);
  return s <= e ? (h >= s && h <= e) : (h >= s || h <= e);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const isDeadChatError = (msg) => /HTTP 403|chat not found|bot was kicked|bot is not a member|user is deactivated|chat_write_forbidden/i.test(String(msg));

// ───────────── голосовой пинг (без Gemini) ─────────────
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
      const r = await telegram('getChatMember', { chat_id: chatId, user_id: Number(v.id) }, { timeout: 8000 });
      const u = r && r.result && r.result.user;
      if (u) { v.name = u.first_name || ''; v.username = u.username || ''; }
    } catch (_) { /* упомянем без имени */ }
  }
  return v;
}

function buildCaption(victim) {
  const template = pickOne(VOICE_CAPTIONS);
  const name = victim.username ? '@' + victim.username : (victim.name || 'лошок');
  const caption = template.replace('{name}', name);
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
  // В тяжёлые лорные дни голосовые приколы неуместны.
  if (!force && !cal.gamesAllowed()) return { status: 'skipped', reason: 'календарь: не тот день', reasons };

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
        if (!meta.nextVoiceAt) {
          await memory.patchMeta(chatId, { nextVoiceAt: Math.round(now + rand(1, 24) * HOUR) });
          reasons.push(chatId + ': запланировано');
          continue;
        }
        if (now < meta.nextVoiceAt) { reasons.push(chatId + ': рано'); continue; }
      }
      if (!(await memory.acquireLock('voice:' + chatId, 300))) { reasons.push(chatId + ': занят'); continue; }

      const victim = await pickVictim(chatId, now);
      if (!victim) { reasons.push(chatId + ': некого пинговать'); continue; }

      const { caption, caption_entities } = buildCaption(victim);
      const payload = { chat_id: chatId, voice: pickOne(files), caption };
      if (caption_entities) payload.caption_entities = caption_entities;
      await telegram('sendVoice', payload);

      const next = now + c.voiceEveryHours * HOUR - 4 * HOUR + rand(0, 12) * HOUR;
      await memory.logBot(chatId, [{ r: 'm', t: '[отправила заготовленное голосовое для ' + (victim.name || victim.username || 'участника') + ': «' + caption.slice(0, 120) + '»]' }], {
        extraMeta: { lastVoicePingAt: now, nextVoiceAt: Math.round(next) }
      });
      sent++;
    } catch (e) {
      console.error('[Voice Ping] ' + chatId + ':', e.message);
      reasons.push(/wrong file|file_id|file not found/i.test(e.message)
        ? chatId + ': BAD_FILE_ID (file_id должен быть получен ЭТИМ ботом)'
        : chatId + ': ' + e.message.slice(0, 120));
      if (isDeadChatError(e.message)) await memory.removeChat(chatId);
    }
  }
  return { status: 'success', sent, force, reasons };
}

// ───────────── тишина и календарные поводы ─────────────
async function runSilencePulse({ force = false, chatId = null } = {}) {
  const c = cfg();
  const now = Date.now();
  const deadline = now + Math.min(c.workBudgetMs, 50000);
  const persistent = memory.isPersistent();
  const calState = cal.state();
  const occasion = cal.pulseOccasion();
  const summary = { persistent, sent: 0, skipped: [], errors: [], calendar: calState.key || 'none' };

  if (!persistent && !force) {
    summary.note = 'Нет Redis: бот не знает, где тихо. Подключи Upstash Redis.';
    return summary;
  }
  if (!force && inQuietHours(c.pulseQuiet, c.pulseTz)) { summary.note = 'Тихие часы'; return summary; }

  const ids = new Set(csv(process.env.CRON_CHAT_ID));
  if (chatId) { ids.clear(); ids.add(String(chatId)); }
  else if (persistent) (await memory.activeChats(now - c.pulseActiveDays * 24 * HOUR)).forEach((id) => ids.add(String(id)));

  for (const id of shuffle([...ids])) {
    if (summary.sent >= c.pulseMaxChats || Date.now() > deadline - 6000) break;
    try {
      const meta = await memory.getMeta(id);
      if (!force && meta.type && meta.type !== 'group' && meta.type !== 'supergroup') {
        summary.skipped.push(id + ': не группа');
        continue;
      }

      let occasionPrompt = null;
      if (occasion && String(meta.calTag || '') !== occasion.tag) {
        occasionPrompt = occasion.prompt; // календарный повод минует ожидание тишины
      } else if (!force) {
        if (!cal.pulseAllowed()) { summary.skipped.push(id + ': календарь молчит'); continue; }
        const quietFor = Math.min(now - (meta.lastActivity || 0), now - (meta.lastBotAt || 0));
        if (quietFor < c.silenceHours * HOUR) { summary.skipped.push(id + ': ещё не тихо'); continue; }
        if ((meta.unanswered || 0) >= c.pulseMaxUnanswered) { summary.skipped.push(id + ': ждёт ответа'); continue; }
      }

      const [history, roster] = await Promise.all([memory.getHistory(id), memory.getRoster(id)]);
      if (!history.length) { summary.skipped.push(id + ': нет истории'); continue; }
      if (!(await memory.acquireLock('pulse:' + id, 180))) { summary.skipped.push(id + ': занят'); continue; }

      const recent = history.filter((h) => h.r === 'u').slice(-5).map((h) => h.t).join('\n');
      const parts = [{
        text: [
          cal.loreContext(),
          calState.block,
          cal.reminderBlock(),
          timeContext(),
          rosterContext(roster),
          recent ? 'ПОСЛЕДНИЕ СООБЩЕНИЯ В ЧАТЕ (используй как мишень для троллинга):\n' + recent : '',
          occasionPrompt || PULSE_PROMPT
        ].filter(Boolean).join('\n')
      }];
      let text = (await generateReply(buildContents(history, parts), { userLen: 200, deadline })).text;
      text = cal.limitReply(text);
      await sendMessage(id, text);
      await memory.logBot(id, [{ r: 'm', t: text }], {
        pulse: true,
        extraMeta: occasionPrompt ? { calTag: occasion.tag } : null
      });
      summary.sent++;
    } catch (e) {
      console.error('Pulse error for ' + id + ':', e.message);
      summary.errors.push(id + ': ' + String(e.message).slice(0, 120));
      if (isDeadChatError(e.message)) await memory.removeChat(id);
    }
  }
  return summary;
}

// ───────────── вход ─────────────
//   /api/pulse                    - обычный тик (голос + тишина/календарь)
//   /api/pulse?voice=1            - только голос (&voice_force=1 - прямо сейчас)
//   /api/pulse?force=1&chat_id=ID - тест: написать в чат немедленно
//   /api/pulse?daily=1            - то же, что тик (Vercel Cron)
async function handlePulseRequest(req, res, opts = {}) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!secret || auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'Unauthorized' });

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
    const voicePing = await handleVoicePing(voiceForce);
    let summary;
    try {
      summary = await runSilencePulse({ chatId: q.chat_id || null });
    } catch (e) {
      console.warn('[Pulse] silence failed:', e.message);
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
