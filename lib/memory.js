// lib/memory.js
// Память чатов в Upstash Redis (или память процесса, если Redis не подключён).
//   tj4:h:<chat>          - история реплик ВСЕХ участников и Танг
//   tj4:m:<chat>          - мета: lastActivity, lastBotAt, unanswered, nextVoiceAt, type, linkedChannel
//   tj4:u:<chat>          - участники: id -> {n, u, t}
//   tj4:p:<chat>          - досье: id -> первое впечатление
//   tj4:st:<chat>         - украденные стикеры: emoji -> {f, o, n, u, t}
//   tj4:ua:<chat>:<user>  - архив реплик участника (для /dox)
//   tj4:sp:<chat>         - счётчик спонтанных реплик за час
//   tj4:pri:<chat>        - счётчик приоритетных (лор-слова) реплик за час
//   tj4:rep:<chat>        - последние её ответы (антиповтор)
//   tj4:admin:<chat>      - кэш её админских прав: userId -> {rights, t}
//   tj4:cr*:<chat>        - танджикоины (см. lib/credit.js)
//   tj4:drunk/hang:<chat> - пьяный режим и похмелье (см. lib/drunk.js)
//   tj4:trap*:<chat>      - ловушки (см. lib/traps.js)
//   tj4:chats             - все чаты со временем последней активности
const { cfg } = require('./config');

const local = global.__tjrLocal || (global.__tjrLocal = new Map());

function lget(key) {
  const e = local.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { local.delete(key); return null; }
  return e;
}
function lput(key, init) {
  let e = lget(key);
  if (!e) { e = { v: init(), exp: 0 }; local.set(key, e); }
  return e;
}
const sliceIdx = (len, start, stop) => {
  const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
  const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
  return [s, e];
};

function localExec(cmd) {
  const op = String(cmd[0]).toUpperCase();
  const a = cmd.slice(1).map((x) => (typeof x === 'number' ? x : String(x)));
  switch (op) {
    case 'GET': { const e = lget(a[0]); return e ? e.v : null; }
    case 'SET': {
      if (a.includes('NX') && lget(a[0])) return null;
      const exIdx = a.indexOf('EX');
      local.set(a[0], { v: String(a[1]), exp: exIdx >= 0 ? Date.now() + Number(a[exIdx + 1]) * 1000 : 0 });
      return 'OK';
    }
    case 'DEL': return local.delete(a[0]) ? 1 : 0;
    case 'EXPIRE': { const e = lget(a[0]); if (e) e.exp = Date.now() + Number(a[1]) * 1000; return e ? 1 : 0; }
    case 'INCR': { const e = lput(a[0], () => '0'); e.v = String((Number(e.v) || 0) + 1); return Number(e.v); }
    case 'RPUSH': { const e = lput(a[0], () => []); e.v.push(...a.slice(1).map(String)); return e.v.length; }
    case 'LTRIM': {
      const e = lget(a[0]); if (!e) return 'OK';
      const [s, t] = sliceIdx(e.v.length, Number(a[1]), Number(a[2]));
      e.v = t < s ? [] : e.v.slice(s, t + 1);
      return 'OK';
    }
    case 'LRANGE': {
      const e = lget(a[0]); if (!e) return [];
      const [s, t] = sliceIdx(e.v.length, Number(a[1]), Number(a[2]));
      return t < s ? [] : e.v.slice(s, t + 1);
    }
    case 'HSET': { const e = lput(a[0], () => ({})); for (let i = 1; i < a.length; i += 2) e.v[a[i]] = String(a[i + 1]); return 1; }
    case 'HGET': { const e = lget(a[0]); return e && e.v[a[1]] !== undefined ? e.v[a[1]] : null; }
    case 'HINCRBY': { const e = lput(a[0], () => ({})); e.v[a[1]] = String((Number(e.v[a[1]]) || 0) + Number(a[2])); return Number(e.v[a[1]]); }
    case 'HDEL': { const e = lget(a[0]); if (e) for (const k of a.slice(1)) delete e.v[k]; return 1; }
    case 'HLEN': { const e = lget(a[0]); return e ? Object.keys(e.v).length : 0; }
    case 'HGETALL': { const e = lget(a[0]); if (!e) return []; return Object.entries(e.v).flat(); }
    case 'ZADD': { const e = lput(a[0], () => ({})); e.v[a[2]] = Number(a[1]); return 1; }
    case 'ZREM': { const e = lget(a[0]); if (e) delete e.v[a[1]]; return 1; }
    case 'ZRANGEBYSCORE': {
      const e = lget(a[0]); if (!e) return [];
      const min = Number(a[1]);
      const max = a[2] === '+inf' ? Infinity : Number(a[2]);
      return Object.entries(e.v).filter(([, sc]) => sc >= min && sc <= max).sort((x, y) => x[1] - y[1]).map(([m]) => m);
    }
    default: return null;
  }
}

function redisConf() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: String(url).replace(/\/+$/, ''), token } : null;
}
function isPersistent() { return !!redisConf(); }

async function exec(commands) {
  const cmds = (commands || []).filter(Boolean);
  if (!cmds.length) return [];
  const rc = redisConf();
  if (!rc) return cmds.map(localExec);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(rc.url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rc.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map((x) => (typeof x === 'number' ? x : String(x))))),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(data)) throw new Error(`Redis pipeline HTTP ${r.status}`);
    return data.map((d, i) => {
      if (d && d.error) throw new Error(`Redis ${cmds[i][0]}: ${d.error}`);
      return d ? d.result : null;
    });
  } finally {
    clearTimeout(timer);
  }
}

const K = {
  h: (id) => `tj4:h:${id}`,
  m: (id) => `tj4:m:${id}`,
  u: (id) => `tj4:u:${id}`,
  p: (id) => `tj4:p:${id}`,
  st: (id) => `tj4:st:${id}`,
  sp: (id) => `tj4:sp:${id}`,
  pri: (id) => `tj4:pri:${id}`,
  rep: (id) => `tj4:rep:${id}`,
  admin: (id) => `tj4:admin:${id}`,
  ua: (id, uid) => `tj4:ua:${id}:${uid}`
};
const toObj = (flat) => {
  const o = {};
  if (!Array.isArray(flat)) return o;
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};
const safeParse = (raw, def = null) => { try { return JSON.parse(raw); } catch (_) { return def; } };

// ───────────── история ─────────────
function historyCommands(chatId, entries) {
  const c = cfg();
  const rows = (entries || []).filter((e) => e && e.t).map((e) => JSON.stringify({
    r: e.r === 'm' ? 'm' : 'u',
    t: String(e.t).slice(0, c.historyMsgChars),
    ts: e.ts || Date.now(),
    uid: e.uid || null,
    n: e.n || null
  }));
  if (!rows.length) return [];
  return [
    ['RPUSH', K.h(chatId), ...rows],
    ['LTRIM', K.h(chatId), -c.historyMax, -1],
    ['EXPIRE', K.h(chatId), c.memoryTtlSec]
  ];
}

async function getHistory(chatId) {
  try {
    const [rows] = await exec([['LRANGE', K.h(chatId), 0, -1]]);
    const out = [];
    for (const raw of rows || []) {
      const e = safeParse(raw);
      if (e && e.t) out.push(e);
    }
    return out;
  } catch (e) {
    console.error('memory.getHistory:', e.message);
    return [];
  }
}

async function logIncoming(chatId, entries, { type = 'private', user = null, senderChat = null, ts = Date.now() } = {}) {
  try {
    const c = cfg();
    const who = user || senderChat || null;
    const uid = who ? who.id : null;
    const name = who ? (who.first_name || who.title || who.username || 'Аноним') : null;
    const enriched = (entries || []).map((e) => ({ ...e, ts, uid, n: name }));
    const cmds = historyCommands(chatId, enriched);
    cmds.push(['ZADD', 'tj4:chats', ts, String(chatId)]);
    cmds.push(['HSET', K.m(chatId), 'lastActivity', ts, 'type', type, 'unanswered', 0]);
    cmds.push(['EXPIRE', K.m(chatId), c.memoryTtlSec]);
    if (uid && !(user && user.is_bot)) {
      cmds.push(['HSET', K.u(chatId), String(uid), JSON.stringify({ n: name, u: (user && user.username) || '', t: ts })]);
      cmds.push(['EXPIRE', K.u(chatId), c.memoryTtlSec]);
      const texts = enriched.filter((e) => e.r !== 'm' && e.t).map((e) => String(e.t).slice(0, 600));
      if (texts.length) {
        cmds.push(['RPUSH', K.ua(chatId, uid), ...texts]);
        cmds.push(['LTRIM', K.ua(chatId, uid), -c.archiveMax, -1]);
        cmds.push(['EXPIRE', K.ua(chatId, uid), c.memoryTtlSec]);
      }
    }
    await exec(cmds);
  } catch (e) {
    console.error('memory.logIncoming:', e.message);
  }
}

async function logBot(chatId, entries, { pulse = false, extraMeta = null, ts = Date.now() } = {}) {
  try {
    const c = cfg();
    const enriched = (entries || []).map((e) => ({ ...e, r: 'm', ts, uid: null }));
    const cmds = historyCommands(chatId, enriched);
    cmds.push(['ZADD', 'tj4:chats', ts, String(chatId)]);
    const meta = ['lastBotAt', ts];
    if (extraMeta) for (const [k, v] of Object.entries(extraMeta)) meta.push(k, v);
    cmds.push(['HSET', K.m(chatId), ...meta]);
    cmds.push(['EXPIRE', K.m(chatId), c.memoryTtlSec]);
    if (pulse) cmds.push(['HINCRBY', K.m(chatId), 'unanswered', 1]);
    await exec(cmds);
  } catch (e) {
    console.error('memory.logBot:', e.message);
  }
}

// ───────────── мета ─────────────
async function getMeta(chatId) {
  try {
    const [flat] = await exec([['HGETALL', K.m(chatId)]]);
    const o = toObj(flat);
    for (const k of Object.keys(o)) if (/^-?\d+(\.\d+)?$/.test(o[k])) o[k] = Number(o[k]);
    return o;
  } catch (e) {
    console.error('memory.getMeta:', e.message);
    return {};
  }
}

async function patchMeta(chatId, patch) {
  try {
    const args = [];
    for (const [k, v] of Object.entries(patch || {})) args.push(k, v);
    if (args.length) await exec([['HSET', K.m(chatId), ...args], ['EXPIRE', K.m(chatId), cfg().memoryTtlSec]]);
  } catch (e) {
    console.error('memory.patchMeta:', e.message);
  }
}

// ───────────── участники и досье ─────────────
async function getRoster(chatId) {
  try {
    const [users, notes] = await exec([['HGETALL', K.u(chatId)], ['HGETALL', K.p(chatId)]]);
    const u = toObj(users);
    const p = toObj(notes);
    const out = [];
    for (const [id, raw] of Object.entries(u)) {
      const r = safeParse(raw);
      if (!r) continue;
      out.push({ id, name: r.n || '', username: r.u || '', seen: r.t || 0, profiled: id in p, impression: p[id] || '' });
    }
    return out.sort((x, y) => y.seen - x.seen);
  } catch (e) {
    console.error('memory.getRoster:', e.message);
    return [];
  }
}

async function markProfiled(chatId, userId, impression) {
  if (!userId) return;
  try {
    await exec([
      ['HSET', K.p(chatId), String(userId), String(impression || '-').slice(0, 200)],
      ['EXPIRE', K.p(chatId), cfg().memoryTtlSec]
    ]);
  } catch (e) {
    console.error('memory.markProfiled:', e.message);
  }
}

async function getUserArchive(chatId, userId, limit = 100) {
  if (!userId) return [];
  try {
    const [rows] = await exec([['LRANGE', K.ua(chatId, userId), -limit, -1]]);
    return (rows || []).map(String);
  } catch (e) {
    console.error('memory.getUserArchive:', e.message);
    return [];
  }
}

// ───────────── стикеры ─────────────
async function saveSticker(chatId, { emoji, fileId, user = null, ts = Date.now() } = {}) {
  if (!fileId) return;
  const key = String(emoji || '🙂').trim().slice(0, 16);
  try {
    const rec = JSON.stringify({
      f: fileId,
      o: user ? user.id : null,
      n: user ? (user.first_name || user.username || '') : '',
      u: (user && user.username) || '',
      t: ts
    });
    await exec([['HSET', K.st(chatId), key, rec], ['EXPIRE', K.st(chatId), cfg().stickerTtlSec]]);
  } catch (e) {
    console.error('memory.saveSticker:', e.message);
  }
}

async function listStickers(chatId, limit = 24) {
  try {
    const [flat] = await exec([['HGETALL', K.st(chatId)]]);
    const o = toObj(flat);
    const out = [];
    for (const [emoji, raw] of Object.entries(o)) {
      const r = safeParse(raw);
      if (r && r.f) out.push({ emoji, fileId: r.f, owner: r.o, ownerName: r.n || '', ownerUsername: r.u || '', ts: r.t || 0 });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  } catch (e) {
    console.error('memory.listStickers:', e.message);
    return [];
  }
}

async function getSticker(chatId, emoji) {
  const list = await listStickers(chatId, 200);
  if (!list.length) return null;
  const want = String(emoji || '').trim().replace(/\uFE0F/g, '');
  return list.find((s) => s.emoji.replace(/\uFE0F/g, '') === want) || null;
}

// ───────────── лимиты и замки ─────────────
async function bumpSpont(chatId) {
  try {
    const [n] = await exec([['INCR', K.sp(chatId)], ['EXPIRE', K.sp(chatId), 3600]]);
    return Number(n) || 0;
  } catch (e) {
    console.error('memory.bumpSpont:', e.message);
    return 0;
  }
}

async function acquireLock(name, ttlSec = 120) {
  try {
    const [r] = await exec([['SET', `tj4:lock:${name}`, '1', 'NX', 'EX', ttlSec]]);
    return r === 'OK';
  } catch (_) { return true; }
}

async function releaseLock(name) {
  try { await exec([['DEL', `tj4:lock:${name}`]]); } catch (_) {}
}

// ───────────── админские права и привязанный канал ─────────────
// Кэш прав, чтобы не дёргать getChatMember на каждое сообщение. ttlSec по умолчанию 10 минут.
async function getChatAdminStatus(chatId, userId, ttlSec = 600) {
  try {
    const [raw] = await exec([['HGET', K.admin(chatId), String(userId)]]);
    const rec = safeParse(raw);
    if (!rec) return null;
    if (Date.now() - (rec.t || 0) > ttlSec * 1000) return null;
    return rec;
  } catch (e) {
    console.error('memory.getChatAdminStatus:', e.message);
    return null;
  }
}

async function setChatAdminStatus(chatId, userId, status) {
  try {
    const rec = JSON.stringify({ ...(status || {}), t: Date.now() });
    await exec([
      ['HSET', K.admin(chatId), String(userId), rec],
      ['EXPIRE', K.admin(chatId), 86400]
    ]);
  } catch (e) {
    console.error('memory.setChatAdminStatus:', e.message);
  }
}

async function getLinkedChannel(chatId) {
  try {
    const [v] = await exec([['HGET', K.m(chatId), 'linkedChannel']]);
    return v ? String(v) : null;
  } catch (e) {
    console.error('memory.getLinkedChannel:', e.message);
    return null;
  }
}

async function setLinkedChannel(chatId, channelId) {
  try {
    await exec([
      ['HSET', K.m(chatId), 'linkedChannel', String(channelId)],
      ['EXPIRE', K.m(chatId), cfg().memoryTtlSec]
    ]);
  } catch (e) {
    console.error('memory.setLinkedChannel:', e.message);
  }
}

// ───────────── антиповтор ─────────────
const REPLY_KEEP = 40;      // сколько последних её ответов держим
const REPLY_TTL = 604800;   // 7 дней

const normWords = (s) => String(s || '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter(Boolean);

function grams(words, n) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

async function rememberReply(chatId, text) {
  const t = String(text || '').trim();
  if (!t) return;
  try {
    await exec([
      ['RPUSH', K.rep(chatId), t.slice(0, 1200)],
      ['LTRIM', K.rep(chatId), -REPLY_KEEP, -1],
      ['EXPIRE', K.rep(chatId), REPLY_TTL]
    ]);
  } catch (e) {
    console.error('memory.rememberReply:', e.message);
  }
}

async function getRecentReplies(chatId, limit = REPLY_KEEP) {
  try {
    const [rows] = await exec([['LRANGE', K.rep(chatId), -Math.max(1, limit), -1]]);
    return (rows || []).map(String);
  } catch (e) {
    console.error('memory.getRecentReplies:', e.message);
    return [];
  }
}

// Ловит три вида повторов: точный дубль, одинаковое начало и повторяющуюся длинную фразу.
// Возвращает { repeat: bool, reason: string }.
async function isRepeat(chatId, text) {
  const t = String(text || '').trim();
  if (!t) return { repeat: false, reason: '' };
  let recent = [];
  try { recent = await getRecentReplies(chatId, REPLY_KEEP); } catch (_) { return { repeat: false, reason: '' }; }
  if (!recent.length) return { repeat: false, reason: '' };

  const words = normWords(t);
  const head = words.slice(0, 3).join(' ');
  const mine = grams(words, 4);

  for (const old of recent) {
    if (String(old).trim() === t) return { repeat: true, reason: 'точный дубль' };
    const ow = normWords(old);
    if (head && head.length >= 8 && ow.slice(0, 3).join(' ') === head) {
      return { repeat: true, reason: 'одинаковое начало: ' + head };
    }
    if (mine.size) {
      const theirs = grams(ow, 4);
      for (const g of mine) {
        if (g.length >= 22 && theirs.has(g)) return { repeat: true, reason: 'повтор фразы: ' + g };
      }
    }
  }
  return { repeat: false, reason: '' };
}

// ───────────── чаты ─────────────
async function activeChats(sinceTs) {
  try {
    const [r] = await exec([['ZRANGEBYSCORE', 'tj4:chats', sinceTs, '+inf']]);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    console.error('memory.activeChats:', e.message);
    return [];
  }
}

async function removeChat(chatId) {
  try {
    await exec([
      ['ZREM', 'tj4:chats', String(chatId)],
      ['DEL', K.m(chatId)], ['DEL', K.h(chatId)], ['DEL', K.u(chatId)],
      ['DEL', K.p(chatId)], ['DEL', K.st(chatId)],
      ['DEL', K.sp(chatId)], ['DEL', K.pri(chatId)],
      ['DEL', K.rep(chatId)], ['DEL', K.admin(chatId)],
      ['DEL', `tj4:cr:${chatId}`], ['DEL', `tj4:crn:${chatId}`],
      ['DEL', `tj4:crl:${chatId}`], ['DEL', `tj4:crt:${chatId}`],
      ['DEL', `tj4:drunk:${chatId}`], ['DEL', `tj4:hang:${chatId}`],
      ['DEL', `tj4:trap:${chatId}`], ['DEL', `tj4:trapnext:${chatId}`]
    ]);
  } catch (e) {
    console.error('memory.removeChat:', e.message);
  }
}

async function seenUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false;
  try {
    const [r] = await exec([['SET', `tj4:upd:${updateId}`, '1', 'NX', 'EX', 900]]);
    return r === null;
  } catch (e) {
    console.error('memory.seenUpdate:', e.message);
    return false;
  }
}

module.exports = {
  isPersistent, exec, getHistory, logIncoming, logBot, getMeta, patchMeta,
  getRoster, markProfiled, getUserArchive, saveSticker, listStickers, getSticker,
  bumpSpont, acquireLock, releaseLock, activeChats, removeChat, seenUpdate,
  getChatAdminStatus, setChatAdminStatus, getLinkedChannel, setLinkedChannel,
  rememberReply, getRecentReplies, isRepeat
};
