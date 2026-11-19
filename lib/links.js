// Глубокий парсинг ссылок: Telegram каналы, YouTube (с превью и статистикой), Reddit, Twitter, обычные сайты.
// Работает без платных API ключей, используя публичные эндпоинты и мета-теги.
const { cfg } = require('./config');

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

// Извлекает ID видео из любого YouTube URL (включая /shorts/)
function extractVideoId(host, path, u) {
    if (host === 'youtu.be') return path.split('/')[1];
    if (path.startsWith('/shorts/')) return path.split('/')[2];
    return u.searchParams.get('v');
}

// Загружает превью видео через официальный CDN YouTube (всегда работает, без API)
async function loadYouTubeThumbnail(videoId) {
    try {
        // Пытаемся maxresdefault, если нет - fallback на hqdefault
        const urls = [
            `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        ];
        for (const url of urls) {
            const res = await fetch(url, { headers: { 'User-Agent': UA } });
            if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > 1000) { // фильтруем заглушки
                    return { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } };
                }
            }
        }
    } catch (_) {}
    return null;
}

// ───────────────────────── TELEGRAM КАНАЛЫ И ПРОФИЛИ ─────────────────────────
async function getTgProfile(handle) {
    const clean = handle.replace('@', '').trim();
    if (!clean || clean.length < 4) return null;
    try {
        const url = `https://t.me/${clean}`;
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': UA, 
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            } 
        });
        if (!res.ok) return null;
        const html = await res.text();
        const meta = parseMeta(html);
        
        let avatarUrl = meta.get('og:image');
        if (avatarUrl && (avatarUrl.includes('telegram.org/img/') || avatarUrl.includes('telegram.org/img/t_logo'))) {
            avatarUrl = null;
        }

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

        let name = meta.get('og:title') ? meta.get('og:title').replace('Telegram: ', '') : clean;
        let bio = meta.get('og:description') || null;
        
        return {
            type: 'tg_profile',
            handle: clean,
            name: name,
            bio: bio,
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

// ───────────────────────── YOUTUBE (МАКСИМАЛЬНО НАДЕЖНЫЙ ПАРСИНГ) ─────────────────────────
async function fetchYouTubeDeep(url, host, path, u) {
    const videoId = extractVideoId(host, path, u);
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;

    let result = { 
        type: 'youtube', 
        url, 
        videoId,
        title: 'YouTube Video', 
        author: 'Unknown', 
        views: null, 
        description: '',
        thumbnail: null
    };

    // УРОВЕНЬ 1: oEmbed (самый надежный, всегда работает)
    try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { 
            headers: { 'User-Agent': UA, 'Accept': 'application/json' } 
        });
        if (oembedRes.ok) {
            const oembedData = await oembedRes.json();
            if (oembedData.title) result.title = oembedData.title;
            if (oembedData.author_name) result.author = oembedData.author_name;
        }
    } catch (_) {}

    // УРОВЕНЬ 2: Piped API (несколько инстансов с фолбэком)
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.adminforge.de',
        'https://pipedapi.in.projectsegfau.lt'
    ];
    
    for (const pipedInstance of pipedInstances) {
        try {
            const streamRes = await fetch(`${pipedInstance}/streams/${videoId}`, { 
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(5000)
            });
            if (streamRes.ok) {
                const streamData = await streamRes.json();
                if (streamData.title) result.title = streamData.title;
                if (streamData.uploader) result.author = streamData.uploader;
                if (streamData.views) result.views = formatNumber(streamData.views);
                if (streamData.shortDescription) result.description = cut(streamData.shortDescription, 300);
                
                const channelIdMatch = streamData.uploaderUrl && streamData.uploaderUrl.match(/\/channel\/([a-zA-Z0-9_-]+)/);
                const channelId = channelIdMatch ? channelIdMatch[1] : null;

                if (channelId) {
                    try {
                        const channelRes = await fetch(`${pipedInstance}/channel/${channelId}`, { 
                            headers: { 'User-Agent': UA },
                            signal: AbortSignal.timeout(5000)
                        });
                        if (channelRes.ok) {
                            const channelData = await channelRes.json();
                            if (channelData.name) result.channelName = channelData.name;
                            if (channelData.subscriberCount) result.subscribers = formatNumber(channelData.subscriberCount);
                            
                            if (channelData.relatedStreams && channelData.relatedStreams.length > 0) {
                                result.recentVideos = channelData.relatedStreams.slice(0, 3).map(v => ({
                                    title: v.title,
                                    url: `https://youtube.com${v.url}`
                                }));
                            }
                        }
                    } catch (_) {}
                }
                break; // Успех - выходим из цикла инстансов
            }
        } catch (_) {
            continue; // Пробуем следующий инстанс
        }
    }

    // УРОВЕНЬ 3: Фолбэк на мета-теги страницы YouTube
    if (!result.views || result.views === null) {
        try {
            const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { 
                headers: { 
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                } 
            });
            if (res.ok) {
                const html = await res.text();
                const meta = parseMeta(html);
                
                if (!result.title || result.title === 'YouTube Video') {
                    if (meta.get('og:title')) result.title = meta.get('og:title');
                }
                if (!result.author || result.author === 'Unknown') {
                    if (meta.get('og:site_name')) result.author = meta.get('og:site_name');
                }
                if (!result.description) {
                    if (meta.get('og:description')) result.description = cut(meta.get('og:description'), 300);
                }
                
                // Ищем viewCount в нескольких форматах
                const viewPatterns = [
                    /"viewCount":"(\d+)"/,
                    /"viewCount":\s*"(\d+)"/,
                    /"videoViewCount":\s*"(\d+)"/,
                    /"shortViewCount":\s*"(\d+)"/
                ];
                for (const pattern of viewPatterns) {
                    const viewMatch = html.match(pattern);
                    if (viewMatch) {
                        result.views = formatNumber(parseInt(viewMatch[1], 10));
                        break;
                    }
                }
            }
        } catch (_) {}
    }

    // УРОВЕНЬ 4: Загружаем превью через официальный CDN YouTube
    result.thumbnail = await loadYouTubeThumbnail(videoId);

    return result;
}

// ───────────────────────── ОСНОВНОЙ ПАРСИНГ ─────────────────────────
async function parseLink(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (_) { return { type: 'web', url: rawUrl, error: 'bad url' }; }
    
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname;

    // 1. Telegram профиль или канал
    if (host === 't.me' || host === 'telegram.me') {
        const parts = path.split('/').filter(Boolean);
        if (parts.length >= 1 && !parts[0].startsWith('+') && !['share', 'addstickers', 'joinchat', 's'].includes(parts[0].toLowerCase())) {
            const handle = parts[0];
            const profile = await getTgProfile(handle);
            if (profile) {
                profile.url = rawUrl;
                return profile;
            }
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

    // 4. YouTube (включая /shorts/)
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
            const handle = r.handle || r.url.split('/').pop().replace(/\/$/, '').split('?')[0];
            lines.push(`[TELEGRAM КАНАЛ/ПРОФИЛЬ: @${handle}]:`);
            lines.push(`Название: ${r.name}`);
            if (r.bio) lines.push(`Описание/Статистика: ${r.bio}`);
            if (r.avatar) lines.push(`(Ты видишь аватарку/логотип выше)`);
            lines.push(`Твоя задача: проанализировать этот ТГ-канал или профиль. Обрати внимание на количество подписчиков и постов в описании (если есть). Высмей аудиторию, тематику, название или то, насколько этот канал бесполезен. Если подписчиков мало - добей его за никчемность. Если много - скажи, что это стадо дебилов, которое смотрит этот бред.`);
            notes.push(`[tg: @${handle}]`);
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
            if (r.thumbnail) {
                media.push(r.thumbnail);
                lines.push(`(Ты видишь превью видео выше)`);
            }
            lines.push(`Оцени канал, автора, количество подписчиков, просмотров и его последние видео. Подколи их тематику, популярность или то, насколько они странные. Если превью загружено - прокомментируй его.`);
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
