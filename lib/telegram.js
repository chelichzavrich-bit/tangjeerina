// lib/telegram.js
// Единственная точка общения с Bot API: таймауты, ретрай на 429, реакции, стикеры, аватарки.
const API = 'https://api.telegram.org';

// Эмодзи, которые боту разрешено ставить как реакцию (Bot API setMessageReaction).
const ALLOWED_REACTIONS = new Set([
  '👍','👎','❤','🔥','🥰','👏','😁','🤔','🤯','😱','🤬','😢','🎉','🤩','🤮','💩','🙏','👌','🕊','🤡',
  '🥴','😍','🌚','🌭','💯','🤣','⚡','🍌','🏆','💔','🤨','😐','🍓','🍾','💋','😈','😴','😭','🤓',
  '👻','👨‍💻','👀','🎃','🙈','😇','😨','🤝','✍','🤗','🫡','🎅','🎄','☃','💅','🤪','🗿','🆒','💘','🙉',
  '🦄','😘','💊','🙊','😎','👾','🤷','😡'
]);
// Любимые смайлики персоны, которых нет в списке реакций - подменяем на близкие разрешённые.
const REACTION_ALIAS = {
  '☺':'🥰','☺️':'🥰','😊':'🥰','🙂':'👀','😉':'😎','😋':'😍','🤭':'🤣','🫣':'🙈','🥱':'😴',
  '😌':'😎','🫢':'🙊','😧':'😨','🤢':'🤮','🐰':'🦄','🐾':'👀','🔮':'👀','❤️':'❤','❓':'🤔','⭐':'🏆','📌':'👀'
};

function normalizeReaction(emoji) {
  const raw = String(emoji || '').trim();
  const bare = raw.replace(/\uFE0F/g, '');
  if (ALLOWED_REACTIONS.has(bare)) return bare;
  if (REACTION_ALIAS[bare]) return REACTION_ALIAS[bare];
  if (REACTION_ALIAS[raw]) return REACTION_ALIAS[raw];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function telegram(method, payload = {}, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const timeout = Math.max(1000, opts.timeout || 15000);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      const raw = await r.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) { /* не JSON */ }
      if (data && data.ok) return data;
      const desc = (data && data.description) || raw.slice(0, 200) || `HTTP ${r.status}`;
      const retryAfter = data && data.parameters && data.parameters.retry_after;
      lastErr = new Error(`Telegram ${method}: ${desc}`);
      if (retryAfter && attempt === 0 && retryAfter <= 5) {
        await sleep(retryAfter * 1000 + 200);
        continue;
      }
      throw lastErr;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Telegram ${method}: timeout ${timeout}ms`) : e;
      if (attempt === 0 && /timeout|fetch failed|ECONNRESET|socket hang up/i.test(lastErr.message)) continue;
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`Telegram ${method} failed`);
}

// Делит длинный текст на части <= limit, стараясь резать по абзацам, строкам, предложениям, пробелам.
function splitMessage(text, limit = 4000) {
  const chunks = [];
  let rest = String(text || '');
  while (rest.length > limit) {
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', '! ', '? ', ' ']) {
      const i = rest.lastIndexOf(sep, limit);
      if (i > limit * 0.5) { cut = i + sep.length; break; }
    }
    if (cut < 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest);
  return chunks.length ? chunks : ['...'];
}

// Отправляет текст по порядку. Ответом (reply) оформляется только первая часть.
async function sendMessage(chatId, text, opts = {}) {
  const o = typeof opts === 'number' ? { replyTo: opts } : (opts || {});
  const chunks = splitMessage(text, 4000);
  let first = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i], disable_web_page_preview: true };
    if (o.threadId) payload.message_thread_id = o.threadId;
    if (i === 0 && o.replyTo) {
      payload.reply_parameters = { message_id: o.replyTo, allow_sending_without_reply: true };
    }
    try {
      const r = await telegram('sendMessage', payload);
      if (!first) first = r.result;
    } catch (e) {
      if (i === 0 && payload.reply_parameters) {
        delete payload.reply_parameters;
        const r = await telegram('sendMessage', payload);
        if (!first) first = r.result;
      } else throw e;
    }
  }
  return first;
}

async function setReaction(chatId, messageId, emoji) {
  const e = normalizeReaction(emoji);
  if (!e || !messageId) return false;
  try {
    await telegram('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: e }]
    }, { timeout: 8000 });
    return true;
  } catch (err) {
    console.error('setReaction:', err.message);
    return false;
  }
}

async function sendSticker(chatId, fileId, opts = {}) {
  const payload = { chat_id: chatId, sticker: fileId };
  if (opts.threadId) payload.message_thread_id = opts.threadId;
  if (opts.replyTo) payload.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  const r = await telegram('sendSticker', payload);
  return r.result;
}

async function answerCallback(id, text) {
  try {
    await telegram('answerCallbackQuery', { callback_query_id: id, text: text || undefined }, { timeout: 8000 });
  } catch (_) { /* кнопка протухла - не критично */ }
}

async function sendChatAction(chatId, action = 'typing') {
  try { await telegram('sendChatAction', { chat_id: chatId, action }, { timeout: 6000 }); } catch (_) {}
}

async function getMe() {
  if (global.__tjrMe) return global.__tjrMe;
  const r = await telegram('getMe', {}, { timeout: 8000 });
  global.__tjrMe = r.result || {};
  return global.__tjrMe;
}

async function botUsername() {
  const env = String(process.env.BOT_USERNAME || '').replace(/^@/, '').trim().toLowerCase();
  if (env) return env;
  try {
    const me = await getMe();
    return String(me.username || '').toLowerCase();
  } catch (_) { return ''; }
}

// Скачивает файл по file_id. Возвращает Buffer или null, если файл слишком большой.
async function downloadFile(fileId, maxBytes = 8 * 1024 * 1024) {
  const info = await telegram('getFile', { file_id: fileId }, { timeout: 10000 });
  const result = info && info.result;
  if (!result || !result.file_path) return null;
  if (result.file_size && result.file_size > maxBytes) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${API}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`Telegram file download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  } finally {
    clearTimeout(timer);
  }
}

// Аватарка любого пользователя как часть для Gemini (inline_data) или null.
async function fetchAvatar(userId, maxBytes = 4 * 1024 * 1024) {
  if (!userId) return null;
  try {
    const r = await telegram('getUserProfilePhotos', { user_id: userId, limit: 1 }, { timeout: 8000 });
    const photos = r.result && r.result.photos;
    if (!photos || !photos.length) return null;
    const best = photos[0][photos[0].length - 1];
    const buf = await downloadFile(best.file_id, maxBytes);
    if (!buf) return null;
    return { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } };
  } catch (e) {
    console.error('fetchAvatar:', e.message);
    return null;
  }
}

module.exports = {
  telegram, sendMessage, splitMessage, setReaction, sendSticker, answerCallback,
  sendChatAction, downloadFile, fetchAvatar, getMe, botUsername, normalizeReaction, ALLOWED_REACTIONS
};
