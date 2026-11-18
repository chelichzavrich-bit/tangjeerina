// Чтение ссылок и профилей: YouTube, Telegram, Reddit, Twitter (Nitter), сайты, картинки.
const { cfg } = require('./config');
const { telegram } = require('./telegram');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cut(s, n) {
    const t = String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    const slice = t.slice(0, n);
    const sp = slice.lastIndexOf(' ');
    return (sp > n * 0.6 ? slice.slice(0, sp) : slice).trimEnd() + '…';
}

function decodeEntities(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function cleanHtml(s) {
    return decodeEntities(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseMeta(html) {
    const map = new Map();
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const attrs = {};
        const re = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
        let m;
        while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        const key = (attrs.property || attrs.name || '').toLowerCase();
        if (key && attrs.content !== undefined && !map.has(key)) map.set(key, decodeEntities(attrs.content).trim());
    }
    return map;
}

function formatNumber(num) {
    if (!num) return null;
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

// ───────────────────────── TELEGRAM ПРОФИЛЬ (t.me) ─────────────────────────
async function getTgProfile(username) {
    const clean = username.replace('@', '').trim();
    if (!clean || clean.length < 5) return null;
    try {
        const url = `https://t.me/${clean}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
        if (!res.ok) return null;
        const html = await res.text();
        const meta = parseMeta(html);
        
        let avatarUrl = meta.get('og:image');
        if (avatarUrl && avatarUrl.includes('telegram.org/img/')) avatarUrl = null;

        let avatarMedia = null;
        if (avatarUrl) {
            try {
                const imgRes = await fetch(avatarUrl);
                if (imgRes.ok) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    if (buf.length < 5 * 1024 * 1024) {
                        avatarMedia = { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } };
                    }
                }
            } catch (_) {}
        }

        return {
            type: 'tg_profile',
            name: meta.get('og:title') ? meta.get('og:title').replace('Telegram: ', '') : clean,
            bio: meta.get('og:description') || null,
            avatar: avatarMedia
        };
    } catch (_) {
        return null;
    }
}

// ───────────────────────── REDDIT JSON ─────────────────────────
async function fetchRedditJson(url) {
    try {
        const cleanUrl = url.split('?')[0] + '.json';
        const res = await fetch(cleanUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || data.length < 2) return null;
        
        const post = data[0].data.children[0].data;
        const comments = data[1].data.children.slice(0, 3).map(c => c.data);
        
        return {
            type: 'reddit',
            title: post.title,
            author: post.author,
            score: post.score,
            text: post.selftext ? cut(post.selftext, 500) : '[Ссылка на картинку/видео]',
            topComment: comments[0] ? `${comments[0].author}: ${cut(comments[0].body, 200)}` : null
        };
    } catch (_) {
        return null;
    }
}

// ───────────────────────── TWITTER / X (через официальный oEmbed) ─────────────────────────
async function fetchTwitterOembed(url) {
    try {
        const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
        const res = await fetch(oembedUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        
        const textMatch = data.html && data.html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        const text = textMatch ? cleanHtml(textMatch[1]) : '';
        const author = data.author_name || 'Unknown';
        
        if (!text && !data.author_name) return null;
        return { type: 'twitter', author, text: cut(text, 400) };
    } catch (_) {
        return null;
    }
}

// ───────────────────────── YOUTUBE (ГЛУБОКИЙ АНАЛИЗ ЧЕРЕЗ PIPED API) ─────────────────────────
async function fetchYouTubeDeep(url, host, path, u) {
    const id = host === 'youtu.be' ? path.split('/')[1] : u.searchParams.get('v');
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;

    let result = { type: 'youtube', url, title: 'YouTube Video', author: 'Unknown', views: null, description: '' };

    // Пробуем вытащить глубокие данные через публичный Piped API (без ключей)
    try {
        const pipedInstance = 'https://pipedapi.kavin.rocks';
        
        // 1. Получаем данные видео и ID канала
        const streamRes = await fetch(`${pipedInstance}/streams/${id}`, { headers: { 'User-Agent': UA } });
        if (streamRes.ok) {
            const streamData = await streamRes.json();
            result.title = streamData.title || result.title;
            result.author = streamData.uploader || result.author;
            result.views = streamData.views ? formatNumber(streamData.views) : null;
            result.description = streamData.shortDescription ? cut(streamData.shortDescription, 300) : '';
            
            const channelIdMatch = streamData.uploaderUrl && streamData.uploaderUrl.match(/\/channel\/([a-zA-Z0-9_-]+)/);
            const channelId = channelIdMatch ? channelIdMatch[1] : null;

            // 2. Если есть ID канала, тянем его статистику и последние видео
            if (channelId) {
                const channelRes = await fetch(`${pipedInstance}/channel/${channelId}`, { headers: { 'User-Agent': UA } });
                if (channelRes.ok) {
                    const channelData = await channelRes.json();
                    result.channelName = channelData.name || result.author;
                    result.subscribers = channelData.subscriberCount ? formatNumber(channelData.subscriberCount) : null;
                    
                    // Берём последние 3 видео канала
                    if (channelData.relatedStreams && channelData.relatedStreams.length > 0) {
                        result.recentVideos = channelData.relatedStreams.slice(0, 3).map(v => ({
                            title: v.title,
                            url: `https://youtube.com${v.url}`
                        }));
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Piped API failed, falling back to basic meta:', e.message);
        // Фолбэк: если Piped API недоступен, парсим базовые мета-теги со страницы YouTube
        try {
            const res = await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { 'User-Agent': UA } });
            if (res.ok) {
                const html = await res.text();
                const meta = parseMeta(html);
                if (meta.get('og:title')) result.title = meta.get('og:title');
                if (meta.get('author')) result.author = meta.get('author');
                const viewMatch = html.match(/"viewCount":"(\d+)"/);
                if (viewMatch) result.views = formatNumber(parseInt(viewMatch[1], 10));
            }
        } catch (_) {}
    }

    return result;
}

// ───────────────────────── ОСНОВНОЙ ПАРСИНГ ─────────────────────────
async function parseLink(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (_) { return { type: 'web', url: rawUrl, error: 'bad url' }; }
    
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname;

    // 1. Telegram профиль
    if (host === 't.me' || host === 'telegram.me') {
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 1 && !parts[0].startsWith('+') && !['share', 'addstickers', 'joinchat'].includes(parts[0].toLowerCase())) {
            const profile = await getTgProfile(parts[0]);
            if (profile) return { ...profile, url: rawUrl };
        }
    }

    // 2. Reddit
    if (host.includes('reddit.com')) {
        const rd = await fetchRedditJson(rawUrl);
        if (rd) return { ...rd, url: rawUrl };
    }

    // 3. Twitter / X
    if (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') {
        const tw = await fetchTwitterOembed(rawUrl);
        if (tw) return { ...tw, url: rawUrl };
    }

    // 4. YouTube (Глубокий)
    if (host === 'youtu.be' || host.includes('youtube.com')) {
        const yt = await fetchYouTubeDeep(rawUrl, host, path, u);
        if (yt) return yt;
    }

    // 5. Обычный веб-сайт
    try {
        const res = await fetch(rawUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
        if (!res.ok) return { type: 'web', url: rawUrl, error: `HTTP ${res.status}` };
        const html = await res.text();
        const meta = parseMeta(html);
        
        const ctype = res.headers.get('content-type') || '';
        if (ctype.startsWith('image/')) {
            const buf = Buffer.from(await res.arrayBuffer());
            return { type: 'image', url: rawUrl, media: { inline_data: { mime_type: ctype.split(';')[0], data: buf.toString('base64') } } };
        }

        return {
            type: 'web',
            url: rawUrl,
            title: meta.get('og:title') || meta.get('title') || host,
            description: meta.get('og:description') || meta.get('description') || '',
            text: cut(cleanHtml(html), 800)
        };
    } catch (e) {
        return { type: 'web', url: rawUrl, error: e.message };
    }
}

function describeLinks(results) {
    const lines = [];
    const media = [];
    const notes = [];

    results.forEach((r) => {
        if (r.error) {
            lines.push(`[Ссылка ${r.url} не открылась: ${r.error}. Содержимое недоступно, отреагируй на этот факт.]`);
            return;
        }

        if (r.type === 'tg_profile') {
            if (r.avatar) media.push(r.avatar);
            lines.push(`[ПРОФИЛЬ TELEGRAM @${r.url.split('/').pop()}]:`);
            lines.push(`Имя: ${r.name}`);
            if (r.bio) lines.push(`Bio: ${r.bio}`);
            if (r.avatar) lines.push(`(Ты видишь его аватарку выше)`);
            lines.push(`Это данные для анализа. Оцени его ник, био и внешность на фото в своём стиле.`);
            notes.push(`[профиль TG @${r.url.split('/').pop()}]`);
            return;
        }

        if (r.type === 'reddit') {
            lines.push(`[REDDIT ПОСТ]: "${r.title}" (u/${r.author}, рейтинг: ${r.score})`);
            if (r.text && r.text !== '[Ссылка на картинку/видео]') lines.push(`Текст: ${r.text}`);
            if (r.topComment) lines.push(`Топ комментарий: ${r.topComment}`);
            lines.push(`Используй это, чтобы посмеяться над автором или комментарием.`);
            notes.push(`[reddit: ${cut(r.title, 40)}]`);
            return;
        }

        if (r.type === 'twitter') {
            lines.push(`[TWITTER/X ТВИТ от ${r.author}]:`);
            if (r.text) lines.push(`Содержание: ${r.text}`);
            lines.push(`Проанализируй этот твит и высмей его.`);
            notes.push(`[twitter твит]`);
            return;
        }

        if (r.type === 'youtube') {
            lines.push(`[YOUTUBE ВИДЕО]: "${r.title}"`);
            lines.push(`Канал/Автор: ${r.channelName || r.author}`);
            if (r.subscribers) lines.push(`Подписчики канала: ${r.subscribers}`);
            if (r.views) lines.push(`Просмотры видео: ${r.views}`);
            if (r.description) lines.push(`Описание: ${r.description}`);
            if (r.recentVideos && r.recentVideos.length > 0) {
                lines.push(`Последние видео на этом канале:`);
                r.recentVideos.forEach(v => lines.push(`- ${v.title}`));
            }
            lines.push(`Оцени канал, автора, количество подписчиков и его последние видео. Подколи их тематику, популярность или то, насколько они странные.`);
            notes.push(`[youtube: ${cut(r.title, 40)}]`);
            return;
        }

        if (r.type === 'image') {
            if (r.media) media.push(r.media);
            lines.push(`[ИЗОБРАЖЕНИЕ ПО ССЫЛКЕ]: Ты видишь эту картинку выше. Оцени её.`);
            notes.push(`[ссылка на картинку]`);
            return;
        }

        // Обычный веб
        lines.push(`[ВЕБ-СТРАНИЦА: ${r.title}]`);
        if (r.description) lines.push(`Описание: ${r.description}`);
        if (r.text) lines.push(`Начало текста: ${r.text}`);
        lines.push(`Используй эти данные для насмешки.`);
        notes.push(`[веб: ${cut(r.title, 40)}]`);
    });

    return { text: lines.join('\n\n'), media, note: notes.join(' ') };
}

module.exports = { parseLink, describeLinks, getTgProfile };
