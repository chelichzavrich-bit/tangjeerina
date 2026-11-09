// Память диалогов и список активных чатов.
// Если задан Upstash Redis (бесплатно через Vercel Marketplace) - данные хранятся постоянно.
// Если нет - используется оперативная память процесса: она живёт, пока "тёплая" функция Vercel не уснёт
// (то есть часто сбрасывается), поэтому проактивность по расписанию без Redis не работает.
const { cfg } = require('./config');

const store = global.__tjrStore || (global.__tjrStore = { kv: new Map(), zset: new Map() });

function redisConf() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function isPersistent() {
    return !!redisConf();
}

async function redis(command) {
    const rc = redisConf();
    const r = await fetch(rc.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${rc.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(`Redis ${command[0]} failed: ${data.error || r.status}`);
    return data.result;
}

// ── примитивы (с откатом на память процесса) ──
async function kvGet(key) {
    if (isPersistent()) return redis(['GET', key]);
    const e = store.kv.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { store.kv.delete(key); return null; }
    return e.v;
}

async function kvSet(key, value, ttlSec) {
    if (isPersistent()) return redis(ttlSec ? ['SET', key, value, 'EX', Math.round(ttlSec)] : ['SET', key, value]);
    store.kv.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
    return 'OK';
}

async function kvDel(key) {
    if (isPersistent()) return redis(['DEL', key]);
    store.kv.delete(key);
    return 1;
}

async function getJSON(key, fallback) {
    try {
        const raw = await kvGet(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        console.error('memory.getJSON:', e.message);
        return fallback;
    }
}

async function setJSON(key, obj, ttlSec) {
    try {
        await kvSet(key, JSON.stringify(obj), ttlSec);
    } catch (e) {
        console.error('memory.setJSON:', e.message);
    }
}

// ── история диалога: [{r:'u'|'m', t:'текст'}] ──
const histKey = (chatId) => `tjr:h:${chatId}`;

async function getHistory(chatId) {
    const h = await getJSON(histKey(chatId), []);
    return Array.isArray(h) ? h : [];
}

async function addHistory(chatId, entries) {
    const c = cfg();
    const history = await getHistory(chatId);
    for (const e of entries) {
        if (!e || !e.t) continue;
        history.push({ r: e.r, t: String(e.t).slice(0, c.historyMsgChars) });
    }
    const trimmed = history.slice(-c.historyMax);
    await setJSON(histKey(chatId), trimmed, c.memoryTtlSec);
    return trimmed;
}

// ── активные чаты (для проактивных сообщений) ──
async function touchChat(chatId, ts = Date.now()) {
    try {
        if (isPersistent()) return await redis(['ZADD', 'tjr:chats', ts, String(chatId)]);
        store.zset.set(String(chatId), ts);
    } catch (e) {
        console.error('memory.touchChat:', e.message);
    }
}

async function activeChats(sinceTs) {
    try {
        if (isPersistent()) {
            const r = await redis(['ZRANGEBYSCORE', 'tjr:chats', sinceTs, '+inf']);
            return Array.isArray(r) ? r : [];
        }
        return [...store.zset.entries()].filter(([, ts]) => ts >= sinceTs).map(([id]) => id);
    } catch (e) {
        console.error('memory.activeChats:', e.message);
        return [];
    }
}

async function removeChat(chatId) {
    try {
        if (isPersistent()) {
            await redis(['ZREM', 'tjr:chats', String(chatId)]);
        } else {
            store.zset.delete(String(chatId));
        }
        await kvDel(`tjr:m:${chatId}`);
    } catch (e) {
        console.error('memory.removeChat:', e.message);
    }
}

// ── расписание пульса для чата: {next: ms, unanswered: n} ──
const META_TTL = 60 * 60 * 24 * 30;
const getMeta = (chatId) => getJSON(`tjr:m:${chatId}`, null);
const setMeta = (chatId, meta) => setJSON(`tjr:m:${chatId}`, meta, META_TTL);

// ── защита от повторной доставки одного и того же update Telegram ──
async function seenUpdate(updateId) {
    if (updateId === undefined || updateId === null) return false;
    const key = `tjr:u:${updateId}`;
    try {
        if (isPersistent()) {
            const r = await redis(['SET', key, '1', 'NX', 'EX', 600]);
            return r === null; // null = ключ уже был
        }
        const e = store.kv.get(key);
        if (e && e.exp > Date.now()) return true;
        store.kv.set(key, { v: '1', exp: Date.now() + 600000 });
        return false;
    } catch (e) {
        console.error('memory.seenUpdate:', e.message);
        return false;
    }
}

module.exports = {
    isPersistent, getHistory, addHistory, touchChat, activeChats, removeChat,
    getMeta, setMeta, seenUpdate,
    // Добавлено для работы профилирования в ai.js:
    readMemory: async (key) => {
        const raw = await kvGet(key);
        return raw ? JSON.parse(raw) : null;
    },
    writeMemory: async (key, value, ttlSec = 60 * 60 * 24 * 30) => {
        await kvSet(key, JSON.stringify(value), ttlSec);
    }
};
