// lib/links.js
// Глубокий разбор ссылок без платных ключей: Telegram (профиль + посты через t.me/s/), YouTube,
// Reddit, Twitter/X, обычные сайты и картинки. Везде таймауты и фолбэки.
const { cfg } = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function cut(s, n) {
  const t = String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const slice = t.slice(0, n);
  const sp = slice.lastIndexOf(' ');
  return (sp > n * 0.6 ? slice.slice(0, sp) : slice).trimEnd() + '…';
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
function cleanHtml(s) {
  return decodeEntities(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function parseMeta(html) {
  const map = new Map();
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    const re = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !map.has(key)) map.set(key, decodeEntities(attrs.content).trim());
  }
  return map;
}
function formatNumber(num) {
  if (!num && num !== 0) return null;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

async function tfetch(url, opts = {}, ms) {
  const timeout = ms || cfg().linkTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8', ...(opts.headers || {}) };
  const rest = { ...opts };
  delete rest.headers;
  try {
    return await fetch(url, { redirect: 'follow', ...rest, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isSafeUrl(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd')) return false;
  return true;
}

// Достаёт ссылки из текста и сущностей Telegram (включая зашитые text_link).
function extractUrls(msg, limit = 2) {
  const text = msg.text || msg.caption || '';
  const ents = msg.entities || msg.caption_entities || [];
  const out = [];
  const add = (raw) => {
    let s = String(raw || '').trim().replace(/[.,!?;:)\]}»"'…]+$/, '');
    if (!s) return;
    if (!/^https?:\/\//i.test(s)) {
      if (/^(www\.|t\.me\/|telegram\.me\/|youtu\.be\/|youtube\.com\/)/i.test(s)) s = 'https://' + s;
      else return;
    }
    try {
      const u = new URL(s);
      if (!isSafeUrl(u)) return;
      const key = u.href.replace(/\/$/, '');
      if (!out.some((x) => x.replace(/\/$/, '') === key)) out.push(u.href);
    } catch (_) { /* мусор */ }
  };
  for (const e of ents) {
    if (e.type === 'text_link' && e.url) add(e.url);
    else if (e.type === 'url') add(text.slice(e.offset, e.offset + e.length));
  }
  const re = /(?:https?:\/\/|www\.|(?:t\.me|telegram\.me|youtu\.be|youtube\.com)\/)[^\s<>"«»]+/gi;
  for (const m of text.matchAll(re)) add(m[0]);
  return out.slice(0, Math.max(1, limit));
}

async function imagePart(url, maxBytes) {
  try {
    const r = await tfetch(url, {}, 7000);
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return { inline_data: { mime_type: ct, data: buf.toString('base64') } };
  } catch (_) { return null; }
}

// ───────────── TELEGRAM ─────────────
async function getTgPosts(handle) {
  try {
    const r = await tfetch('https://t.me/s/' + encodeURIComponent(handle), {}, 7000);
    if (!r.ok) return [];
    const html = await r.text();
    const blocks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
    const posts = [];
    for (const b of blocks.slice(-6)) {
      const idm = /data-post="([^"]+)"/.exec(b);
      const tm = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
      const vm = /tgme_widget_message_views">([^<]+)</.exec(b);
      const txt = tm ? cut(cleanHtml(tm[1]), 300) : '';
      if (!txt && !/tgme_widget_message_photo|tgme_widget_message_video/.test(b)) continue;
      posts.push({ id: idm ? idm[1] : '', text: txt || '[фото/видео без текста]', views: vm ? vm[1].trim() : null });
    }
    return posts.slice(-3);
  } catch (_) { return []; }
}

async function getTgPost(handle, id) {
  try {
    const r = await tfetch(`https://t.me/${handle}/${id}?embed=1&mode=tme`, {}, 7000);
    if (!r.ok) return null;
    const html = await r.text();
    const tm = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    const vm = /tgme_widget_message_views">([^<]+)</.exec(html);
    const am = /tgme_widget_message_owner_name[^>]*><span[^>]*>([\s\S]*?)<\/span>/i.exec(html);
    const meta = parseMeta(html);
    const text = tm ? cut(cleanHtml(tm[1]), 700) : '';
    if (!text && !meta.get('og:description')) return null;
    const img = meta.get('og:image');
    return {
      type: 'tg_post',
      handle,
      postId: id,
      author: am ? cleanHtml(am[1]) : handle,
      text: text || cut(meta.get('og:description') || '', 500),
      views: vm ? vm[1].trim() : null,
      media: img && !/telegram\.org\/img\//i.test(img) ? await imagePart(img, cfg().linkMaxImageBytes) : null
    };
  } catch (_) { return null; }
}

async function getTgProfile(handle) {
  const clean = String(handle || '').replace(/^@/, '').trim();
  if (!clean || clean.length < 3 || !/^[A-Za-z0-9_]+$/.test(clean)) return null;
  try {
    const r = await tfetch('https://t.me/' + clean, {}, 7000);
    if (!r.ok) return null;
    const html = await r.text();
    const meta = parseMeta(html);
    const name = (meta.get('og:title') || clean).replace(/^Telegram:\s*/, '');
    const bio = meta.get('og:description') || '';
    const extra = cleanHtml((/<div class="tgme_page_extra">([\s\S]*?)<\/div>/i.exec(html) || [])[1] || '');
    const isChannel = /подписчик|subscriber|участник|members/i.test(extra) || /tgme_page_post/.test(html);
    const img = meta.get('og:image');
    const avatar = (img && !/telegram\.org\/img\//i.test(img)) ? await imagePart(img, cfg().linkMaxImageBytes) : null;
    const posts = isChannel ? await getTgPosts(clean) : [];
    if (!name && !bio && !avatar && !posts.length) return null;
    return { type: 'tg_profile', handle: clean, name, bio, extra, isChannel, avatar, posts };
  } catch (_) { return null; }
}

// ───────────── YOUTUBE ─────────────
async function fetchYouTube(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;
  let id = null;
  if (host === 'youtu.be') id = path.split('/').filter(Boolean)[0];
  else if (/^\/(shorts|live|embed)\//.test(path)) id = path.split('/').filter(Boolean)[1];
  else id = u.searchParams.get('v');
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;

  const out = {
    type: 'youtube', videoId: id, title: '', author: '', channelUrl: '',
    views: null, subscribers: null, description: '', thumbnail: null, channelAvatar: null, recent: []
  };

  try {
    const r = await tfetch(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json`, { headers: { Accept: 'application/json' } }, 5000);
    if (r.ok) {
      const d = await r.json();
      out.title = d.title || '';
      out.author = d.author_name || '';
      out.channelUrl = d.author_url || '';
    }
  } catch (_) { /* идём дальше */ }

  try {
    const r = await tfetch(`https://www.youtube.com/watch?v=${id}&hl=ru`, { headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI' } }, 8000);
    if (r.ok) {
      const html = await r.text();
      const meta = parseMeta(html);
      if (!out.title) out.title = meta.get('og:title') || '';
      if (!out.description) out.description = cut(meta.get('og:description') || '', 300);
      const vc = /"viewCount":"(\d+)"/.exec(html);
      if (vc) out.views = formatNumber(Number(vc[1]));
      const subs = /"subscriberCountText":\{"simpleText":"([^"]+)"/.exec(html) || /"subscriberCountText":\{[^}]*?"simpleText":"([^"]+)"/.exec(html);
      if (subs) out.subscribers = subs[1];
      const owner = /"ownerChannelName":"([^"]+)"/.exec(html);
      if (owner && !out.author) out.author = owner[1];
      const cid = /"channelId":"([A-Za-z0-9_-]{20,})"/.exec(html);
      if (cid && !out.channelUrl) out.channelUrl = 'https://www.youtube.com/channel/' + cid[1];
      const av = /"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/.exec(html);
      if (av) out.channelAvatar = await imagePart(av[1].replace(/\\u0026/g, '&'), 1500000);
    }
  } catch (_) { /* превью всё равно будет */ }

  out.thumbnail = await imagePart(`https://img.youtube.com/vi/${id}/hqdefault.jpg`, cfg().linkMaxImageBytes);

  if (out.channelUrl) {
    try {
      const r = await tfetch(out.channelUrl.replace(/\/$/, '') + '/videos?hl=ru', { headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI' } }, 6000);
      if (r.ok) {
        const html = await r.text();
        const re = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})","thumbnail"[\s\S]*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
        let m;
        while ((m = re.exec(html)) && out.recent.length < 3) out.recent.push({ title: m[2], url: 'https://youtu.be/' + m[1] });
      }
    } catch (_) { /* не критично */ }
  }
  return out;
}

// ───────────── REDDIT ─────────────
async function fetchReddit(u) {
  const path = u.pathname.replace(/\/$/, '');
  for (const base of ['https://www.reddit.com', 'https://old.reddit.com']) {
    try {
      const r = await tfetch(base + path + '.json?raw_json=1&limit=5', { headers: { Accept: 'application/json' } }, 6000);
      if (!r.ok) continue;
      const d = await r.json();
      if (!Array.isArray(d) || !d[0]) continue;
      const p = d[0].data.children[0].data;
      const kids = (d[1] && d[1].data && d[1].data.children) || [];
      const comments = kids.filter((x) => x.kind === 't1').slice(0, 3)
        .map((x) => ({ author: x.data.author, score: x.data.score, text: cut(x.data.body, 200) }));
      const dest = p.url_overridden_by_dest || '';
      return {
        type: 'reddit', title: p.title, author: p.author, score: p.score, subreddit: p.subreddit,
        text: cut(p.selftext || '', 500), comments,
        media: /\.(jpg|jpeg|png|webp)$/i.test(dest) ? await imagePart(dest, cfg().linkMaxImageBytes) : null
      };
    } catch (_) { /* следующий хост */ }
  }
  return null;
}

// ───────────── TWITTER / X ─────────────
async function fetchTweet(u) {
  const m = /\/status\/(\d+)/.exec(u.pathname);
  if (m) {
    try {
      const r = await tfetch('https://api.fxtwitter.com/status/' + m[1], { headers: { Accept: 'application/json' } }, 6000);
      if (r.ok) {
        const d = await r.json();
        const t = d && d.tweet;
        if (t) {
          const photo = t.media && t.media.photos && t.media.photos[0];
          return {
            type: 'twitter',
            author: (t.author && t.author.name) || '',
            handle: (t.author && t.author.screen_name) || '',
            text: cut(t.text || '', 500),
            likes: t.likes, views: t.views,
            media: photo ? await imagePart(photo.url, cfg().linkMaxImageBytes) : null
          };
        }
      }
    } catch (_) { /* пробуем oembed */ }
  }
  try {
    const r = await tfetch('https://publish.twitter.com/oembed?url=' + encodeURIComponent(u.href), { headers: { Accept: 'application/json' } }, 6000);
    if (!r.ok) return null;
    const d = await r.json();
    const tm = d.html && /<p[^>]*>([\s\S]*?)<\/p>/.exec(d.html);
    const text = tm ? cleanHtml(tm[1]) : '';
    if (!text && !d.author_name) return null;
    return { type: 'twitter', author: d.author_name || '', handle: '', text: cut(text, 400), media: null };
  } catch (_) { return null; }
}

// ───────────── обычный сайт ─────────────
async function fetchGeneric(rawUrl) {
  const r = await tfetch(rawUrl, {}, cfg().linkTimeoutMs);
  if (!r.ok) return { type: 'web', url: rawUrl, error: 'HTTP ' + r.status };
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (/^image\//.test(ct)) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > cfg().linkMaxImageBytes) return { type: 'web', url: rawUrl, error: 'картинка слишком большая' };
    return { type: 'image', url: rawUrl, media: { inline_data: { mime_type: ct, data: buf.toString('base64') } } };
  }
  const html = await r.text();
  const meta = parseMeta(html);
  const titleTag = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  const title = meta.get('og:title') || cleanHtml(titleTag) || new URL(rawUrl).hostname;
  const description = meta.get('og:description') || meta.get('description') || '';
  const body = cut(cleanHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')), cfg().linkTextChars);
  const og = meta.get('og:image');
  let media = null;
  if (og) {
    try { media = await imagePart(new URL(og, rawUrl).href, cfg().linkMaxImageBytes); } catch (_) { media = null; }
  }
  return { type: 'web', url: rawUrl, title: cut(title, 160), description: cut(description, 300), text: body, media };
}

async function parseLink(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { return { type: 'web', url: rawUrl, error: 'битая ссылка' }; }
  if (!isSafeUrl(u)) return { type: 'web', url: rawUrl, error: 'внутренний адрес, туда не лезу' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;

  if (host === 't.me' || host === 'telegram.me') {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return { type: 'web', url: rawUrl, error: 'пустая ссылка' };
    const first = parts[0];
    if (first === 'c') return { type: 'web', url: rawUrl, error: 'это приватный канал, внутрь не пускают' };
    if (first.toLowerCase() === 's' && parts[1]) {
      const posts = await getTgPosts(parts[1]);
      return { type: 'tg_profile', handle: parts[1], name: parts[1], bio: '', extra: '', isChannel: true, avatar: null, posts, url: rawUrl };
    }
    if (first.startsWith('+') || ['joinchat', 'addstickers', 'share', 'iv', 'proxy', 'socks'].includes(first.toLowerCase())) {
      return { type: 'web', url: rawUrl, error: 'закрытая ссылка-приглашение, содержимое недоступно' };
    }
    if (parts[1] && /^\d+$/.test(parts[1])) {
      const post = await getTgPost(first, parts[1]);
      if (post) return { ...post, url: rawUrl };
    }
    const profile = await getTgProfile(first);
    if (profile) return { ...profile, url: rawUrl };
    return { type: 'web', url: rawUrl, error: 'профиль закрыт или не существует' };
  }

  if (host.includes('reddit.com')) {
    const rd = await fetchReddit(u);
    if (rd) return { ...rd, url: rawUrl };
  }
  if (['twitter.com', 'x.com', 'mobile.twitter.com', 'fxtwitter.com', 'vxtwitter.com'].includes(host)) {
    const tw = await fetchTweet(u);
    if (tw) return { ...tw, url: rawUrl };
  }
  if (host === 'youtu.be' || host.includes('youtube.com')) {
    const yt = await fetchYouTube(u);
    if (yt) return { ...yt, url: rawUrl };
  }
  try {
    return await fetchGeneric(rawUrl);
  } catch (e) {
    return { type: 'web', url: rawUrl, error: e.name === 'AbortError' ? 'сайт не ответил вовремя' : e.message };
  }
}

async function parseLinks(urls, opts = {}) {
  const list = (urls || []).slice(0, opts.limit || cfg().maxLinks);
  const budget = opts.deadline ? Math.max(4000, opts.deadline - Date.now() - 4000) : 14000;
  return Promise.all(list.map((u) => Promise.race([
    parseLink(u).catch((e) => ({ type: 'web', url: u, error: e.message })),
    new Promise((res) => setTimeout(() => res({ type: 'web', url: u, error: 'сайт тупит и не открылся' }), budget))
  ])));
}

function describeLinks(results) {
  const lines = [];
  const media = [];
  const notes = [];
  const push = (m, label) => {
    if (!m) return '';
    media.push(m);
    return '(картинка №' + media.length + ' - ' + label + ', она приложена к сообщению)';
  };

  for (const r of results || []) {
    if (r.error) {
      lines.push('[Ссылка ' + r.url + ' не открылась: ' + r.error + '. Содержимое недоступно - отреагируй на этот факт, не выдумывай его.]');
      continue;
    }
    if (r.type === 'tg_profile') {
      lines.push('[TELEGRAM ' + (r.isChannel ? 'КАНАЛ' : 'ПРОФИЛЬ') + ' @' + r.handle + ']');
      lines.push('Название: ' + r.name);
      if (r.bio) lines.push('Описание: ' + r.bio);
      if (r.extra) lines.push('Статистика: ' + r.extra);
      const label = push(r.avatar, 'аватарка @' + r.handle);
      if (label) lines.push(label);
      if (r.posts && r.posts.length) {
        lines.push('Последние посты:');
        r.posts.forEach((p, i) => lines.push((i + 1) + '. ' + p.text + (p.views ? ' [просмотров: ' + p.views + ']' : '')));
      }
      lines.push('Задача: высмей аудиторию, тематику и название. Мало подписчиков - добей за никчёмность, много - скажи, что это стадо, которое смотрит этот бред. Это НЕ аватарка собеседника.');
      notes.push('[tg: @' + r.handle + ']');
      continue;
    }
    if (r.type === 'tg_post') {
      lines.push('[TELEGRAM ПОСТ ' + r.handle + '/' + r.postId + ', автор: ' + r.author + (r.views ? ', просмотров: ' + r.views : '') + ']');
      lines.push('Текст: ' + r.text);
      const label = push(r.media, 'картинка из поста');
      if (label) lines.push(label);
      lines.push('Задача: разнеси содержание поста и его аудиторию.');
      notes.push('[tg пост ' + r.handle + ']');
      continue;
    }
    if (r.type === 'reddit') {
      lines.push('[REDDIT r/' + r.subreddit + '] "' + r.title + '" (u/' + r.author + ', рейтинг ' + r.score + ')');
      if (r.text) lines.push('Текст: ' + r.text);
      (r.comments || []).forEach((c) => lines.push('Комментарий u/' + c.author + ' (' + c.score + '): ' + c.text));
      const label = push(r.media, 'картинка из поста reddit');
      if (label) lines.push(label);
      lines.push('Задача: посмейся над автором или комментатором.');
      notes.push('[reddit: ' + cut(r.title, 40) + ']');
      continue;
    }
    if (r.type === 'twitter') {
      lines.push('[ТВИТ от ' + r.author + (r.handle ? ' (@' + r.handle + ')' : '') + ']');
      lines.push('Текст: ' + r.text);
      if (r.likes) lines.push('Лайков: ' + r.likes);
      const label = push(r.media, 'картинка из твита');
      if (label) lines.push(label);
      lines.push('Задача: высмей твит и его автора.');
      notes.push('[твит]');
      continue;
    }
    if (r.type === 'youtube') {
      lines.push('[YOUTUBE ВИДЕО] "' + (r.title || 'без названия') + '"');
      lines.push('Канал: ' + (r.author || 'неизвестен'));
      if (r.subscribers) lines.push('Подписчики канала: ' + r.subscribers);
      if (r.views) lines.push('Просмотры видео: ' + r.views);
      if (r.description) lines.push('Описание: ' + r.description);
      if (r.recent && r.recent.length) {
        lines.push('Последние видео канала:');
        r.recent.forEach((v) => lines.push('- ' + v.title));
      }
      const t = push(r.thumbnail, 'превью ролика');
      if (t) lines.push(t);
      const a = push(r.channelAvatar, 'аватарка КАНАЛА, не собеседника');
      if (a) lines.push(a);
      lines.push('Задача: оцени канал, автора, подписчиков, просмотры и превью. Подколи тематику и популярность. Читай надписи на превью.');
      notes.push('[youtube: ' + cut(r.title, 40) + ']');
      continue;
    }
    if (r.type === 'image') {
      const label = push(r.media, 'картинка по ссылке');
      lines.push('[ИЗОБРАЖЕНИЕ ПО ССЫЛКЕ] ' + label + ' Оцени то, что на ней, и прочитай надписи.');
      notes.push('[картинка по ссылке]');
      continue;
    }
    lines.push('[ВЕБ-СТРАНИЦА: ' + (r.title || r.url) + ']');
    if (r.description) lines.push('Описание: ' + r.description);
    if (r.text) lines.push('Начало текста: ' + r.text);
    const label = push(r.media, 'обложка страницы');
    if (label) lines.push(label);
    lines.push('Используй это для насмешки, не пересказывай сухо.');
    notes.push('[веб: ' + cut(r.title || r.url, 40) + ']');
  }
  return { text: lines.join('\n'), media, note: notes.join(' ') };
}

module.exports = { extractUrls, parseLink, parseLinks, describeLinks, getTgProfile, getTgPosts, getTgPost };
