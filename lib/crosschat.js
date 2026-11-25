// lib/crosschat.js
// Глобальная память о людях: она узнаёт человека в другом чате и помнит, что он там говорил.
// ПРИВАТНОСТЬ: содержимое личных переписок НИКОГДА не всплывает в группах.
// Из лички берётся только сам факт знакомства, без единой цитаты.
let memory = null;
try { memory = require('./memory'); } catch (_) { memory = null; }

const num = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
};
const flag = (name, def) => {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim().toLowerCase();
  if (!raw) return def;
  return !['0', 'off', 'false', 'no'].includes(raw);
};

const CFG = {
  enabled: flag('CROSSCHAT', true),
  ttlSec: Math.max(3600, Math.round(num('CROSSCHAT_TTL_DAYS', 60) * 86400)),
  maxChats: Math.max(2, Math.floor(num('CROSSCHAT_MAX_CHATS', 12))),
  quotesFrom: Math.max(1, Math.floor(num('CROSSCHAT_QUOTE_CHATS', 2))),
  quotesEach: Math.max(1, Math.floor(num('CROSSCHAT_QUOTES_EACH', 3)))
};

const K = {
  user: (uid) => `tj4:gu:${uid}`
};

const safeParse = (raw, def) => { try { return JSON.parse(raw); } catch (_) { return def; } };

function info() { return { ...CFG, module: 'crosschat' }; }

async function profile(userId) {
  if (!memory || !userId) return null;
  try {
    const [raw] = await memory.exec([['GET', K.user(String(userId))]]);
    return safeParse(raw, null);
  } catch (e) {
    console.error('crosschat.profile:', e.message);
    return null;
  }
}

// Запоминаем человека глобально. Вызывается на каждом его сообщении.
async function remember(user, chatId, chatType) {
  if (!CFG.enabled || !memory || !user || !user.id || user.is_bot) return null;
  const uid = String(user.id);
  try {
    const now = Date.now();
    const prev = (await profile(uid)) || {};
    const chats = Array.isArray(prev.chats) ? prev.chats.slice() : [];
    const type = chatType || 'group';
    const idx = chats.findIndex((x) => String(x.id) === String(chatId));
    if (idx >= 0) {
      chats[idx] = { id: String(chatId), type, t: now };
    } else {
      chats.push({ id: String(chatId), type, t: now });
    }
    chats.sort((a, b) => (b.t || 0) - (a.t || 0));
    const rec = {
      n: user.first_name || user.username || prev.n || 'Аноним',
      u: user.username || prev.u || '',
      chats: chats.slice(0, CFG.maxChats),
      msgs: (Number(prev.msgs) || 0) + 1,
      first: prev.first || now,
      t: now
    };
    await memory.exec([['SET', K.user(uid), JSON.stringify(rec), 'EX', CFG.ttlSec]]);
    return rec;
  } catch (e) {
    console.error('crosschat.remember:', e.message);
    return null;
  }
}

// Блок для промпта: кого она уже знает и что он говорил в ДРУГИХ группах.
async function context(userId, currentChatId) {
  if (!CFG.enabled || !memory || !userId) return '';
  const p = await profile(userId);
  if (!p) return '';
  const others = (p.chats || []).filter((x) => String(x.id) !== String(currentChatId));
  if (!others.length) return '';

  const publicOthers = others.filter((x) => x.type !== 'private');
  const hadPrivate = others.some((x) => x.type === 'private');

  const lines = [];
  lines.push('[ТЫ УЖЕ ЗНАЕШЬ ЭТОГО ЧЕЛОВЕКА: ' + (p.n || 'Аноним') + (p.u ? ' (@' + p.u + ')' : '') +
    ', он мелькает ещё в ' + others.length + ' чат(ах), всего ты видела от него ' + (p.msgs || 0) + ' реплик.]');

  let quoted = 0;
  for (const ch of publicOthers) {
    if (quoted >= CFG.quotesFrom) break;
    try {
      const rows = await memory.getUserArchive(ch.id, userId, CFG.quotesEach);
      const clean = (rows || [])
        .map((s) => String(s).replace(/^\[[^\]]+\]\s*:?\s*/, '').trim())
        .filter((s) => s && !s.startsWith('['))
        .slice(-CFG.quotesEach);
      if (clean.length) {
        lines.push('В другой группе он писал: ' + clean.map((s) => '«' + s.slice(0, 160) + '»').join('; '));
        quoted++;
      }
    } catch (_) { /* чат мог быть удалён */ }
  }

  if (hadPrivate) {
    lines.push('Он ещё писал тебе в личку. Что там было - НЕ цитируй и не намекай на содержание при людях, это не твой товар на этот раз.');
  }
  lines.push('Используй это как рычаг: можешь припомнить ему прошлое, сравнить его поведение там и тут, подколоть за постоянство. Но не выдумывай того, чего в данных нет.');
  return lines.join('\n');
}

module.exports = { remember, context, profile, info, CFG };
