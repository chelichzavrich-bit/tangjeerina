// Поисковый модуль Танг: Reddit (без ключа), YouTube (нужен YOUTUBE_API_KEY), DuckDuckGo (хрупкий, с фолбэком).
// Никогда не бросает ошибок наружу: при сбое движка возвращает пустой результат, и бот честно говорит «не нашла».
// Логика движков спрятана здесь, чтобы webhook оставался тонким (меньше поверхность для поломки).

const TIMEOUT_MS = 7000;
const UA = 'Mozilla/5.0 (compatible; TangJeeRinaBot/4.0; +research)';

async function jfetch(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': UA, ...(opts.headers || {}) },
            ...opts
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r;
    } finally {
        clearTimeout(t);
    }
}

// ───────────── Reddit (без ключа) ─────────────
async function searchReddit(query, limit = 5) {
    try {
        const q = encodeURIComponent(query);
        const r = await jfetch(`https://www.reddit.com/search.json?q=${q}&sort=relevance&t=month&limit=${limit}&raw_json=1`);
        const d = await r.json();
        const kids = (d && d.data && d.data.children) || [];
        const lines = kids.map((c) => {
            const p = c && c.data;
            if (!p || !p.title) return null;
            const url = p.url && /^https?:/.test(p.url) ? p.url : `https://www.reddit.com${p.permalink || ''}`;
            const sub = p.subreddit ? `r/${p.subreddit}` : 'reddit';
            const snip = String(p.selftext || '').replace(/\s+/g, ' ').slice(0, 160);
            return `- [${sub}] ${String(p.title).slice(0, 160)} | ${url}${snip ? ' | ' + snip : ''}`;
        }).filter(Boolean);
        return lines;
    } catch (e) {
        console.error('searchReddit:', e.message);
        return [];
    }
}

// ───────────── YouTube (нужен ключ, иначе пропускается) ─────────────
async function searchYouTube(query, limit = 4) {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) return [];
    try {
        const q = encodeURIComponent(query);
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}&q=${q}&key=${key}`;
        const r = await jfetch(url);
        const d = await r.json();
        const items = (d && d.items) || [];
        return items.map((it) => {
            const id = it && it.id && it.id.videoId;
            if (!id) return null;
            const sn = it.snippet || {};
            const desc = String(sn.description || '').replace(/\s+/g, ' ').slice(0, 140);
            return `- ${String(sn.title || '').slice(0, 160)} | https://www.youtube.com/watch?v=${id} | ${sn.channelTitle || ''}${desc ? ' | ' + desc : ''}`;
        }).filter(Boolean);
    } catch (e) {
        console.error('searchYouTube:', e.message);
        return [];
    }
}

// ───────────── DuckDuckGo (скрейпинг, хрупкий, фолбэк на пустой) ─────────────
function decodeHtml(s) {
    return String(s || '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
async function searchWeb(query, limit = 5) {
    try {
        const q = encodeURIComponent(query);
        const r = await jfetch(`https://html.duckduckgo.com/html/?q=${q}`);
        const html = await r.text();
        const out = [];
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = re.exec(html)) && out.length < limit) {
            let href = decodeHtml(m[1]);
            // DDG оборачивает ссылки в редирект-урл с uddg= — вытаскиваем оригинал
            const mm = /[?&]uddg=([^&]+)/.exec(href);
            if (mm) { try { href = decodeURIComponent(mm[1]); } catch (_) {} }
            if (!/^https?:/.test(href)) continue;
            const title = decodeHtml(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 160);
            out.push(`- ${title || 'без названия'} | ${href}`);
        }
        return out;
    } catch (e) {
        console.error('searchWeb:', e.message);
        return [];
    }
}

// ───────────── агрегатор: сам решает, какие движки дёргать ─────────────
// Возвращает { text, sources }. text пустой, если ничего не нашлось — бот скажет «ворота закрыты».
async function searchInternet(query) {
    const q = String(query || '').toLowerCase();
    const wantVideo = /ютуб|youtube|видео|ролик|трейлер|клип/.test(q);
    const wantReddit = /реддит|reddit|мем|сабреддит|trhead|тред/.test(q);
    const wantWeb = /погугли|интернет|сайт|статья|новост|google|ддак|ddg/.test(q);

    const jobs = [];
    const labels = [];
    if (wantVideo || (!wantReddit && !wantWeb)) { jobs.push(searchYouTube(query)); labels.push('YouTube'); }
    if (wantReddit || (!wantVideo && !wantWeb)) { jobs.push(searchReddit(query)); labels.push('Reddit'); }
    if (wantWeb || (!wantVideo && !wantReddit)) { jobs.push(searchWeb(query)); labels.push('веб'); }
    // если ничего не распознали явно — базовый набор: реддит + веб
    if (!jobs.length) { jobs.push(searchReddit(query), searchWeb(query)); labels.push('Reddit', 'веб'); }

    const results = await Promise.all(jobs);
    const chunks = [];
    const used = [];
    results.forEach((lines, i) => {
        if (lines && lines.length) { chunks.push(`[${labels[i]}]:\n${lines.join('\n')}`); used.push(labels[i]); }
    });
    return { text: chunks.join('\n\n'), sources: used };
}

module.exports = { searchInternet, searchReddit, searchYouTube, searchWeb };
