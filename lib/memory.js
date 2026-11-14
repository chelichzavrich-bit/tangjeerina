// Память чатов. Всё лежит в Upstash Redis.
// Префикс tj4: - свежий, чтобы не столкнуться с ключами прошлых версий.
//   tj4:h:<chat>  - история реплик ВСЕХ участников и Танг
//   tj4:m:<chat>  - служебные поля: lastActivity, lastBotAt, unanswered, nextVoiceAt, ...
//   tj4:u:<chat>  - участники чата: id -> {n, u, t}
//   tj4:p:<chat>  - досье: id -> первое впечатление (значит ник/аву уже комментировали)
//   tj4:chats     - все чаты с временем последней активности
const { cfg } = require('./config');

const local = global.__tjrLocal || (global.__tjrLocal = new Map());

function lget(key) {
    const e = local.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { local.delete(key); return null; }
    return e;
}
function lput(key, type, init) {
    let e = lget(key);
    if (!e) { e = { type, v: init(), exp: 0 }; local.set(key, e); }
    return e;
}
const sliceIdx = (len, start, stop) => {
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? len + stop : stop;
    return [s, Math.min(e, len - 1)];
};
function localExec(cmd) {
    const op = String(cmd[0]).toUpperCase();
    const a = cmd.slice(1).map((x) => (typeof x === 'number' ? x : String(x)));
    switch (op) {
        case 'GET': { const e = lget(a[0]); return e ? e.v : null; }
        case 'SET': {
            const nx = a.includes('NX');
            if (nx && lget(a[0])) return null;
            const exIdx = a.indexOf('EX');
            local.set(a[0], { type: 'string', v: String(a[1]), exp: exIdx >= 0 ? Date.now() + Number(a[exIdx + 1]) * 1000 : 0 });
            return 'OK';
        }
        case 'DEL': return local.delete(a[0]) ? 1 : 0;
        case 'EXPIRE': { const e = lget(a[0]); if (e) e.exp = Date.now() + Number(a[1]) * 1000; return e ? 1 : 0; }
        case 'RPUSH': { const e = lput(a[0], 'list', () => []); e.v.push(...a.slice(1).map(String)); return e.v.length; }
        case 'LTRIM': {
            const e = lget(a[0]); if (!e) return 'OK';
            const [s, t] = sliceIdx(e.v.length, Number(a[1]), Number(a[2]));
            e.v = e.v.slice(s, t + 1); return 'OK';
        }
        case 'LRANGE': {
            const e = lget(a[0]); if (!e) return [];
            const [s, t] = sliceIdx(e.v.length, Number(a[1]), Number(a[2]));
            return e.v.slice(s, t + 1);
        }
        case 'HSET': { const e = lput(a[0], 'hash', () => ({})); for (let i = 1; i < a.length; i += 2) e.v[a[i]] = String(a[i + 1]); return 1; }
        case 'HINCRBY': { const e = lput(a[0], 'hash', () => ({})); e.v[a[1]] = String((Number(e.v[a[1]]) || 0) + Number(a[2])); return Number(e.v[a[1]]); }
        case 'HDEL': { const e = lget(a[0]); if (e) delete e.v[a[1]]; return 1; }
        case 'HGETALL': { const e = lget(a[0]); if (!e) return []; return Object.entries(e.v).flat(); }
        case 'ZADD': { const e = lput(a[0], 'zset', () => ({})); e.v[a[2]] = Number(a[1]); return 1; }
        case 'ZREM': { const e = lget(a[0]); if (e) delete e.v[a[1]]; return 1; }
        case 'ZRANGEBYSCORE': {
            const e = lget(a[0]); if (!e) return [];
            const min = Number(a[1]);
            return Object.entries(e.v).filter(([, sc]) => (Number.isFinite(min) ? sc >= min : true)).map(([m]) => m);
        }
        default: throw new Error('local memory: unsupported command ' + op);
    }
}

function redisConf() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}
function isPersistent() { return !!redisConf(); }

async function exec(commands) {
    const rc = redisConf();
    if (!rc) return commands.map(localExec);
    const r = await fetch(rc.url + '/pipeline', {
        method: 'POST',
        headers: { Authorization: `Bearer ${rc.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands.map((c) => c.map((x) => (typeof x === 'number' ? x : String(x)))))
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(data)) throw new Error(`Redis pipeline failed: HTTP ${r.status}`);
    return data.map((d, i) => {
        if (d && d.error) throw new Error(`Redis ${commands[i][0]} failed: ${d.error}`);
        return d ? d.result : null;
    });
}

const K = {
    h: (id) => `tj4:h:${id}`,
    m: (id) => `tj4:m:${id}`,
    u: (id) => `tj4:u:${id}`,
    p: (id) => `tj4:p:${id}`
};

const toObj = (flat) => {
    const o = {};
    if (!Array.isArray(flat)) return o;
    for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
    return o;
};

async function getHistory(chatId) {
    try {
        const [rows] = await exec([['LRANGE', K.h(chatId), 0, -1]]);
        const out = [];
        for (const raw of rows || []) {
            try { const e = JSON.parse(raw); if (e && e.t) out.push(e); } catch (_) { /* битая строка */ }
        }
        return out;
    } catch (e) {
        console.error('memory.getHistory:', e.message);
        return [];
    }
}

function historyCommands(chatId, entries) {
    const c = cfg();
    const cmds = [];
    const rows = (entries || []).filter((e) => e && e.t).map((e) => JSON.stringify({ r: e.r, t: String(e.t).slice(0, c.historyMsgChars) }));
    if (!rows.length) return cmds;
    cmds.push(['RPUSH', K.h(chatId), ...rows]);
    cmds.push(['LTRIM', K.h(chatId), -c.historyMax, -1]);
    cmds.push(['EXPIRE', K.h(chatId), c.memoryTtlSec]);
    return cmds;
}

async function logIncoming(chatId, entries, { type = 'private', user = null, ts = Date.now() } = {}) {
    try {
        const cmds = historyCommands(chatId, entries);
        cmds.push(['ZADD', 'tj4:chats', ts, String(chatId)]);
        cmds.push(['HSET', K.m(chatId), 'lastActivity', ts, 'type', type, 'unanswered', 0]);
        if (user && user.id && !user.is_bot) {
            const rec = JSON.stringify({ n: user.first_name || user.username || 'Аноним', u: user.username || '', t: ts });
            cmds.push(['HSET', K.u(chatId), String(user.id), rec]);
        }
        await exec(cmds);
    } catch (e) {
        console.error('memory.logIncoming:', e.message);
    }
}

async function logBot(chatId, entries, { pulse = false, extraMeta = null, ts = Date.now() } = {}) {
    try {
        const cmds = historyCommands(chatId, entries);
        cmds.push(['ZADD', 'tj4:chats', ts, String(chatId)]);
        const meta = ['lastBotAt', ts];
        if (extraMeta) for (const [k, v] of Object.entries(extraMeta)) meta.push(k, v);
        cmds.push(['HSET', K.m(chatId), ...meta]);
        if (pulse) cmds.push(['HINCRBY', K.m(chatId), 'unanswered', 1]);
        await exec(cmds);
    } catch (e) {
        console.error('memory.logBot:', e.message);
    }
}

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
        if (args.length) await exec([['HSET', K.m(chatId), ...args]]);
    } catch (e) {
        console.error('memory.patchMeta:', e.message);
    }
}

async function getRoster(chatId) {
    try {
        const [users, notes] = await exec([['HGETALL', K.u(chatId)], ['HGETALL', K.p(chatId)]]);
        const u = toObj(users), p = toObj(notes);
        const out = [];
        for (const [id, raw] of Object.entries(u)) {
            try {
                const r = JSON.parse(raw);
                out.push({ id, name: r.n, username: r.u, seen: r.t || 0, profiled: id in p, impression: p[id] || '' });
            } catch (_) { /* пропускаем */ }
        }
        return out.sort((x, y) => y.seen - x.seen);
    } catch (e) {
        console.error('memory.getRoster:', e.message);
        return [];
    }
}

async function markProfiled(chatId, userId, impression) {
    try {
        await exec([['HSET', K.p(chatId), String(userId), String(impression || '-').slice(0, 200)]]);
    } catch (e) {
        console.error('memory.markProfiled:', e.message);
    }
}

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
        await exec([['ZREM', 'tj4:chats', String(chatId)], ['DEL', K.m(chatId)], ['DEL', K.h(chatId)], ['DEL', K.u(chatId)], ['DEL', K.p(chatId)]]);
    } catch (e) {
        console.error('memory.removeChat:', e.message);
    }
}

async function seenUpdate(updateId) {
    if (updateId === undefined || updateId === null) return false;
    try {
        const [r] = await exec([['SET', `tj4:upd:${updateId}`, '1', 'NX', 'EX', 600]]);
        return r === null;
    } catch (e) {
        console.error('memory.seenUpdate:', e.message);
        return false;
    }
}

module.exports = {
    isPersistent, getHistory, logIncoming, logBot, getMeta, patchMeta,
    getRoster, markProfiled, activeChats, removeChat, seenUpdate
};
