// Память диалогов и список активных чатов.
// Если задан Upstash Redis - данные хранятся постоянно.
// Если нет - используется оперативная память процесса (часто сбрасывается).
// Префикс tj3: - свежий, чтобы не столкнуться с чужими типами ключей от прошлых версий.
const { cfg } = require('./config');
const store = global.__tjrStore || (global.__tjrStore = { kv: new Map(), zset: new Map() });

function redisConf() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function isPersistent() { return !!redisConf(); }

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

const histKey = (chatId) => `tj3:h:${chatId}`;
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

async function touchChat(chatId, ts = Date.now()) {
    try {
        if (isPersistent()) {
            await redis(['ZADD', 'tj3:chats', ts, String(chatId)]);
            const meta = await getJSON(`tj3:m:${chatId}`, { unanswered: 0 });
            meta.lastActivity = ts;
            await setJSON(`tj3:m:${chatId}`, meta, 60 * 60 * 24 * 30);
        } else {
            store.zset.set(String(chatId), ts);
            const key = `tj3:m:${chatId}`;
            const meta = store.kv.get(key);
            if (meta) {
                meta.v.lastActivity = ts;
                store.kv.set(key, meta);
            }
        }
    } catch (e) {
        console.error('memory.touchChat:', e.message);
    }
}

async function activeChats(sinceTs) {
    try {
        if (isPersistent()) {
            const r = await redis(['ZRANGEBYSCORE', 'tj3:chats', sinceTs, '+inf']);
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
            await redis(['ZREM', 'tj3:chats', String(chatId)]);
        } else {
            store.zset.delete(String(chatId));
        }
        await kvDel(`tj3:m:${chatId}`);
    } catch (e) {
        console.error('memory.removeChat:', e.message);
    }
}

const META_TTL = 60 * 60 * 24 * 30;
const getMeta = (chatId) => getJSON(`tj3:m:${chatId}`, null);
const setMeta = (chatId, meta) => setJSON(`tj3:m:${chatId}`, meta, META_TTL);

async function seenUpdate(updateId) {
    if (updateId === undefined || updateId === null) return false;
    const key = `tj3:u:${updateId}`;
    try {
        if (isPersistent()) {
            const r = await redis(['SET', key, '1', 'NX', 'EX', 600]);
            return r === null;
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
    getMeta, setMeta, seenUpdate
};
