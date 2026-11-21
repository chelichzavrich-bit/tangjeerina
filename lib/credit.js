// lib/credit.js
// Танджикоин (социальный кредит Танг). Начисляется МОЛЧА, без единого уведомления.
// Источники начисления:
//   1) служебный тег [КРЕДИТ:+2] в ответе модели - срезается до отправки, стоит 0 запросов;
//   2) детерминированные сигналы (комплимент, ярость, шутка, потраченное время) - работают даже на фолбэках.
// Хранение: tj4:cr:<chat> (hash userId -> баланс), tj4:crn:<chat> (hash userId -> имя/ник),
//           tj4:crl:<chat> (hash userId -> JSON причин), tj4:crt:<chat> (hash userId -> ts последнего начисления).

let memory = null;
try { memory = require('./memory'); } catch (_) { memory = null; }
let cal = null;
try { cal = require('./calendar'); } catch (_) { cal = null; }

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

const C = {
  enabled: flag('CREDIT', true),
  perMessageMax: Math.max(1, Math.floor(num('CREDIT_PER_MESSAGE_MAX', 3))),
  perDayMax: Math.max(1, Math.floor(num('CREDIT_PER_DAY_MAX', 30))),
  gapSec: Math.max(0, num('CREDIT_GAP_SECONDS', 120)),
  compliment: Math.max(0, Math.floor(num('CREDIT_COMPLIMENT', 2))),
  rage: Math.max(0, Math.floor(num('CREDIT_RAGE', 2))),
  joke: Math.max(0, Math.floor(num('CREDIT_JOKE', 1))),
  attention: Math.max(0, Math.floor(num('CREDIT_ATTENTION', 1))),
  attentionEvery: Math.max(1, Math.floor(num('CREDIT_ATTENTION_EVERY', 8))),
  lore: Math.max(0, Math.floor(num('CREDIT_LORE', 1))),
  penalty: Math.max(0, Math.floor(num('CREDIT_PENALTY', 2)))
};

const K = {
  bal: (id) => `tj4:cr:${id}`,
  names: (id) => `tj4:crn:${id}`,
  last: (id) => `tj4:crl:${id}`,
  ts: (id) => `tj4:crt:${id}`,
  cnt: (id, uid, day) => `tj4:crd:${id}:${uid}:${day}`,
  att: (id, uid) => `tj4:cra:${id}:${uid}`
};

const DAY = 86400000;
const dayKey = (now) => Math.floor(now / DAY);
const toObj = (flat) => {
  const o = {};
  if (!Array.isArray(flat)) return o;
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};
const safeParse = (raw, def) => { try { return JSON.parse(raw); } catch (_) { return def; } };
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

// ───────────── сигналы в тексте ─────────────
const RE_COMPLIMENT = /(ты|танджи|танг)\s+(умн\w*|красив\w*|лучш\w*|крут\w*|гениальн\w*|милая|милашка|прелест\w*|богин\w*|королев\w*|сексуальн\w*|офигенн\w*|ахуенн\w*|великолепн\w*|обожа\w*|любим\w*)|ты\s+мне\s+нравишься|люблю\s+тебя|обожаю\s+тебя|лучшая\s+крольчиха|моя\s+любимая\s+крольчиха|tang\s+is\s+(smart|cute|best)|you\s+are\s+(smart|cute|the\s+best)|i\s+love\s+you/i;
const RE_LAUGH = /(хаха|ахаха|хпхп|хихи|хехе|хех|буугага|ржу|умора|угар|порвал\w*|лол|lol|lmao|😂|🤣)/i;
const RE_WHINE = /(я\s+никому\s+не\s+нужен|я\s+никому\s+не\s+нужна|все\s+меня\s+ненавидят|всё\s+бессмысленно|я\s+устал\s+жить|зачем\s+я\s+вообще|нытьё|пожалейте\s+меня|я\s+такой\s+одинокий)/i;
const RE_INSULT = /(тупая|дура|идиотка|тварь|мразь|сука|шлюха|кобыла|уродина|заткнись|отвали|ненавижу\s+тебя|ты\s+бесполезн\w*)/i;
const RE_LORE = /(жак|жрак|кэрротлин|мандарин|морковк|лнр|лао\s?рен|крольчиха|вахтёрск|вахтерск|звезд\w*\s+ёлк|пингвин)/i;

function signals(text, opts = {}) {
  const s = String(text || '');
  const low = s.toLowerCase();
  const letters = (s.match(/[\p{L}]/gu) || []).length;
  const caps = (s.match(/[\p{Lu}]/gu) || []).length;
  const rage = (letters >= 12 && caps / letters > 0.6) || (s.match(/!/g) || []).length >= 3 || RE_INSULT.test(low);
  return {
    compliment: RE_COMPLIMENT.test(low),
    laugh: RE_LAUGH.test(low),
    whine: RE_WHINE.test(low),
    rage,
    lore: RE_LORE.test(low),
    long: s.length > 220,
    distress: !!opts.distress
  };
}

// ───────────── теги в ответе модели ─────────────
const RE_TAG = /\[\s*(?:КРЕДИТ|CREDIT|COIN|КОИН)\s*:\s*([+-]?\d{1,2})(?:\s*[|\s]\s*([^\]]{0,40}))?\]/gi;

function stripTags(text) {
  const raw = String(text || '');
  const found = [];
  let m;
  RE_TAG.lastIndex = 0;
  while ((m = RE_TAG.exec(raw))) {
    found.push({ delta: clamp(parseInt(m[1], 10) || 0, -C.perMessageMax, C.perMessageMax), reason: String(m[2] || '').trim() });
  }
  const clean = raw.replace(RE_TAG, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, tags: found };
}

function tagBlock() {
  if (!C.enabled) return '';
  return '[ТАНДЖИКОИН, СЛУЖЕБНОЕ: у тебя есть личная валюта - танджикоин. Ты молча ведёшь счёт тому, насколько человек тебе интересен. В САМОМ КОНЦЕ ответа допиши служебный тег [КРЕДИТ:+N] или [КРЕДИТ:-N], где N от 1 до ' + C.perMessageMax + '. Система срежет тег и начислит молча, никто в чате этого не увидит и не получит уведомления. Ставь + если он тебя рассмешил, сделал комплимент, попался на твою уловку, яростно бесится и тратит на тебя время, поддержал твою небылицу или полез в твой лор. Ставь - если он ноет, скучный, обесценивает тебя или игнорирует твои провокации. Если ничего не чувствуешь - тег не ставь вообще. НИКОГДА не упоминай танджикоины, счёт, рейтинг и сам тег в тексте реплики: это тайна, о которой знают только те, кто сам спросит командой /credit. В режиме реальной беды собеседника тег не ставь.]';
}

// ───────────── начисление ─────────────
async function award(chatId, user, delta, reason, opts = {}) {
  const out = { applied: 0, reason: '', balance: null };
  if (!C.enabled || !memory || !user || !user.id || user.is_bot) return out;
  if (opts.distress) return out;
  let d = clamp(Math.trunc(delta) || 0, -C.perMessageMax, C.perMessageMax);
  if (!d) return out;

  const uid = String(user.id);
  const now = Date.now();
  try {
    const [tsFlat, cntRaw] = await memory.exec([
      ['HGET', K.ts(chatId), uid],
      ['GET', K.cnt(chatId, uid, dayKey(now))]
    ]);
    const lastTs = Number(tsFlat) || 0;
    const today = Number(cntRaw) || 0;

    if (d > 0) {
      if (!opts.force && now - lastTs < C.gapSec * 1000) return out;
      if (today >= C.perDayMax) return out;
      d = Math.min(d, C.perDayMax - today);
    }
    if (!d) return out;

    const [bal, newCnt] = await memory.exec([
      ['HINCRBY', K.bal(chatId), uid, d],
      ['INCR', K.cnt(chatId, uid, dayKey(now))],
      ['EXPIRE', K.cnt(chatId, uid, dayKey(now)), 172800],
      ['HSET', K.ts(chatId), uid, now],
      ['HSET', K.names(chatId), uid, JSON.stringify({
        n: user.first_name || user.username || 'Аноним',
        u: user.username || '',
        t: now
      })],
      ['HSET', K.last(chatId), uid, JSON.stringify({ d, r: String(reason || '').slice(0, 60), t: now })]
    ]);
    out.applied = d;
    out.reason = String(reason || '');
    out.balance = Number(bal) || 0;
    if (Number(newCnt) > C.perDayMax) { /* дневной потолок, дальше только минусы */ }
  } catch (e) {
    console.error('credit.award:', e.message);
  }
  return out;
}

// Полный разбор одного сообщения: теги модели + детерминированные сигналы.
async function processMessage({ chatId, user, userText, reply, mode = 'direct', history = [], distress = false }) {
  const res = { text: String(reply || ''), applied: 0, reason: '', balance: null };
  if (!C.enabled || !user || !user.id || distress || mode === 'distress') {
    res.text = stripTags(reply).text;
    return res;
  }
  const stripped = stripTags(reply);
  res.text = stripped.text;

  const sig = signals(userText, { distress });
  let delta = 0;
  let reason = '';

  if (stripped.tags.length) {
    const t = stripped.tags[0];
    delta = t.delta;
    reason = t.reason || (delta > 0 ? 'она сочла тебя забавным' : 'она сочла тебя скучным');
  } else {
    // Фолбэк-начисление: работает, даже когда модели нет и она отвечает отмазкой.
    if (sig.compliment) { delta = C.compliment; reason = 'ты её перехвалил, она это записала'; }
    else if (sig.rage) { delta = C.rage; reason = 'ты бесился, ей это понравилось'; }
    else if (sig.laugh) { delta = C.joke; reason = 'ты смеялся над её шуткой'; }
    else if (sig.whine) { delta = -C.penalty; reason = 'ты ныл, она это не любит'; }
    else if (sig.lore && mode === 'direct') { delta = C.lore; reason = 'ты полез в её лор'; }
  }

  // Потраченное на неё время - как у Жака. Каждое N-е обращение, отдельный счётчик.
  if (!delta && mode === 'direct' && C.attention > 0 && memory) {
    try {
      const [n] = await memory.exec([
        ['INCR', K.att(chatId, String(user.id))],
        ['EXPIRE', K.att(chatId, String(user.id)), 604800]
      ]);
      if (Number(n) % C.attentionEvery === 0) {
        delta = C.attention;
        reason = 'ты тратишь на неё слишком много времени';
      }
    } catch (_) { /* не критично */ }
  }

  if (!delta) return res;

  // В тяжёлые календарные дни ей не до поощрений, но минус за нытьё остаётся.
  if (cal && typeof cal.gamesAllowed === 'function' && !cal.gamesAllowed() && delta > 0) return res;

  const a = await award(chatId, user, delta, reason);
  res.applied = a.applied;
  res.reason = a.reason;
  res.balance = a.balance;
  return res;
}

// ───────────── команда /credit ─────────────
async function board(chatId) {
  if (!memory) return [];
  try {
    const [balFlat, nameFlat, lastFlat] = await memory.exec([
      ['HGETALL', K.bal(chatId)],
      ['HGETALL', K.names(chatId)],
      ['HGETALL', K.last(chatId)]
    ]);
    const bal = toObj(balFlat);
    const names = toObj(nameFlat);
    const last = toObj(lastFlat);
    const out = [];
    for (const [uid, v] of Object.entries(bal)) {
      const n = safeParse(names[uid], {}) || {};
      const l = safeParse(last[uid], null);
      out.push({
        id: uid,
        name: n.n || 'Аноним',
        username: n.u || '',
        coins: Number(v) || 0,
        lastReason: (l && l.r) || '',
        lastAt: (l && l.t) || 0
      });
    }
    return out.sort((a, b) => b.coins - a.coins || a.name.localeCompare(b.name));
  } catch (e) {
    console.error('credit.board:', e.message);
    return [];
  }
}

const MEDALS = ['🥇', '🥈', '🥉'];
const TAILS = [
  'остальные даже не попали в мой блокнот, позор 🤭',
  'кто в минусе - тот работает на меня бесплатно ☺️',
  'это не деньги, это мой интерес, и он продаётся 🫣',
  'хочешь выше - смеши меня или бесись громче 🤗',
  'я считать всё, даже то, что вы забыли 😋'
];

function renderBoard(list, meId) {
  if (!list.length) {
    return 'Мой блокнот пустой, никто ещё не заслужить мой внимание. Начни с комплимент или истерики, я записать 🤭';
  }
  const top = list.slice(0, 10);
  const lines = top.map((r, i) => {
    const who = r.username ? '@' + r.username : r.name;
    const mark = MEDALS[i] || (i + 1) + '.';
    const sign = r.coins > 0 ? '+' + r.coins : String(r.coins);
    return mark + ' ' + who + ' - ' + sign;
  });
  let text = 'ТАНДЖИКОИН, мой личный счёт вашего достоинства:\n' + lines.join('\n');
  const mine = meId ? list.find((r) => String(r.id) === String(meId)) : null;
  if (mine && !top.some((r) => String(r.id) === String(meId))) {
    const place = list.indexOf(mine) + 1;
    text += '\nты на ' + place + ' место, ' + (mine.coins > 0 ? '+' + mine.coins : mine.coins) + ', и это позор';
  }
  const minus = list.filter((r) => r.coins < 0).length;
  if (minus) text += '\nв минусе ' + minus + ' чел, они мне должны';
  text += '\n' + pickOne(TAILS);
  return text;
}

function renderOne(row, place, total) {
  if (!row) {
    return 'Я на этот счёт ещё ничего не записать. Пусть сначала сделать что-нибудь интересное ☺️';
  }
  const who = row.username ? '@' + row.username : row.name;
  const sign = row.coins > 0 ? '+' + row.coins : String(row.coins);
  let text = who + ' - ' + sign + ' танджикоин, ' + place + ' место из ' + total + '.';
  if (row.lastReason) text += '\nпоследний раз я записать: ' + row.lastReason + '.';
  text += '\n' + (row.coins >= 0 ? 'мочь больше, если постараться 🤭' : 'он мне должен, и я не забыть 🫣');
  return text;
}

async function command(chatId, arg, meId) {
  const list = await board(chatId);
  const a = String(arg || '').trim().toLowerCase().replace(/^@/, '');
  if (!a) return renderBoard(list, meId);
  if (/^(я|me|мой|моя)$/.test(a)) {
    const idx = list.findIndex((r) => String(r.id) === String(meId));
    return renderOne(idx >= 0 ? list[idx] : null, idx + 1, list.length);
  }
  const idx = list.findIndex((r) => r.username.toLowerCase() === a || r.name.toLowerCase() === a);
  if (idx >= 0) return renderOne(list[idx], idx + 1, list.length);
  const part = list.findIndex((r) => (r.username && r.username.toLowerCase().includes(a)) || r.name.toLowerCase().includes(a));
  if (part >= 0) return renderOne(list[part], part + 1, list.length);
  return 'Такой в мой блокнот не значится, значит он ещё не заслужить даже строчки 🤭';
}

module.exports = {
  enabled: () => C.enabled,
  tagBlock, stripTags, signals, award, processMessage, board, command, renderBoard
};
