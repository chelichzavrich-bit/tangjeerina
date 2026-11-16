// Чтение ссылок и профилей: YouTube, Telegram, Reddit, Twitter (Nitter), сайты, картинки.
const { cfg } = require('./config');
const { telegram } = require('./telegram');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_HTML_BYTES = 1024 * 1024;

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

// ───────────────────────── СПЕЦИАЛЬНЫЙ СКРЕЙПИНГ ПРОФИЛЕЙ TELEGRAM ─────────────────────────
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
        // Фильтруем стандартную заглушку Telegram
        if (avatarUrl && avatarUrl.includes('telegram.org/img/')) avatarUrl = null;

        let avatarMedia = null;
        if (avatarUrl) {
            try {
                const imgRes = await fetch(avatarUrl);
                if (imgRes.ok) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    if (buf.length < 5 * 1024 * 1024) { // макс 5 МБ
                        avatarMedia = { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } };
                    }
                }
            } catch (_) { /* игнорируем ошибки загрузки картинки */ }
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

// ───────────────────────── REDDIT JSON (БЕСПЛАТНО) ─────────────────────────
async function fetchRedditJson(url) {
    try {
        // Reddit отдает JSON, если добавить .json к URL (убираем query params)
        const cleanUrl = url.split('?')[0] + '.json';
        const res = await fetch(cleanUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || data.length < 2) return null;
        
        const post = data[0].data.children[0].data;
        const comments = data[1].data.children.slice(0, 5).map(c => c.data); // топ 5 комментариев
        
        return {
            type: 'reddit',
            title: post.title,
            author: post.author,
            score: post.score,
            text: post.selftext ? cut(post.selftext, 500) : '[Ссылка на картинку/видео]',
            comments: comments.map(c => `${c.author}: ${cut(c.body, 150)}`).join('\n')
        };
    } catch (_) {
        return null;
    }
}

// ───────────────────────── TWITTER / X ЧЕРЕЗ NITTER ─────────────────────────
async function fetchTwitterViaNitter(url) {
    try {
        // Используем публичный инстанс Nitter для обхода блокировок X
        const nitterUrl = url.replace(/(https?:\/\/)?(www\.)?(twitter|x)\.com\//i, 'https://nitter.privacydev.net/');
        const res = await fetch(nitterUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
        if (!res.ok) return null;
        const html = await res.text();
        const meta = parseMeta(html);
        
        // Nitter иногда кладет текст твита в og:description
        const text = meta.get('og:description') || '';
        const title = meta.get('og:title') || '';
        
        if (!text && !title) return null;
        return { type: 'twitter', title, text: cut(text, 600) };
    } catch (_) {
        return null;
    }
}

// ───────────────────────── ОСНОВНОЙ ПАРСИНГ ─────────────────────────
async function parseLink(rawUrl) {
    const c = cfg();
    let u;
    try { u = new URL(rawUrl); } catch (_) { return { type: 'web', url: rawUrl, error: 'bad url' }; }
    
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname;

    // 1. Telegram профиль (если это не пост и не инвайт)
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
        const tw = await fetchTwitterViaNitter(rawUrl);
        if (tw) return { ...tw, url: rawUrl };
    }

    // 4. YouTube (базовый oEmbed + мета, как было, но надежнее)
    if (host === 'youtu.be' || host.includes('youtube.com')) {
        const id = host === 'youtu.be' ? path.split('/')[1] : u.searchParams.get('v');
        if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
            try {
                const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { headers: { 'User-Agent': UA } });
                const data = await oembed.json();
                return { type: 'youtube', url: rawUrl, title: data.title || 'YouTube Video', author: data.author_name || 'Unknown' };
            } catch (_) { /* fallback to web */ }
        }
    }

    // 5. Обычный веб-сайт
    try {
        const res = await fetch(rawUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
        if (!res.ok) return { type: 'web', url: rawUrl, error: `HTTP ${res.status}` };
        const html = await res.text();
        const meta = parseMeta(html);
        
        // Если это картинка по Content-Type
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
            if (r.bio) lines.push(`Описание (Bio): ${r.bio}`);
            if (r.avatar) lines.push(`(Ты видишь его аватарку выше)`);
            lines.push(`Это данные для анализа. Оцени его ник, био и внешность на фото в своём стиле.`);
            notes.push(`[профиль TG @${r.url.split('/').pop()}]`);
            return;
        }

        if (r.type === 'reddit') {
            lines.push(`[REDDIT ПОСТ]: "${r.title}" (Автор: u/${r.author}, Рейтинг: ${r.score})`);
            if (r.text && r.text !== '[Ссылка на картинку/видео]') lines.push(`Текст: ${r.text}`);
            if (r.comments) lines.push(`Топ комментарии:\n${r.comments}`);
            lines.push(`Используй это, чтобы посмеяться над автором или комментариями.`);
            notes.push(`[reddit пост: ${cut(r.title, 50)}]`);
            return;
        }

        if (r.type === 'twitter') {
            lines.push(`[TWITTER/X ТВИТ]: ${r.title}`);
            if (r.text) lines.push(`Содержание: ${r.text}`);
            lines.push(`Проанализируй этот твит и высмей его.`);
            notes.push(`[twitter твит]`);
            return;
        }

        if (r.type === 'youtube') {
            lines.push(`[YOUTUBE ВИДЕО]: "${r.title}"`);
            lines.push(`Канал: ${r.author}`);
            lines.push(`Оцени название и автора, подколи их.`);
            notes.push(`[youtube: ${cut(r.title, 50)}]`);
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
        notes.push(`[веб: ${cut(r.title, 50)}]`);
    });

    return { text: lines.join('\n\n'), media, note: notes.join(' ') };
}

module.exports = { parseLink, describeLinks, getTgProfile };
