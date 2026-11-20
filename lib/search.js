// lib/search.js
// Поиск без платных ключей: YouTube (скрейп выдачи или API-ключ), Reddit, DuckDuckGo (+lite), Wikipedia.
// Наружу никогда не бросает: пустой результат = «ворота закрыты», бот злится в образе.
const TIMEOUT_MS = 7000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function jfetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8', ...(opts.headers || {}) };
  const rest = { ...opts };
  delete rest.headers;
  try {
    const r = await fetch(url, { ...rest, headers, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally {
    clearTimeout(timer);
  }
}
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
const cleanQuery = (q) => String(q || '').replace(/@\w+/g, '').replace(/\/\w+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// ───────────── YouTube ─────────────
async function searchYouTube(query, limit = 4) {
  const q = cleanQuery(query);
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const r = await jfetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}&q=${encodeURIComponent(q)}&key=${key}`);
      const d = await r.json();
      const items = (d && d.items) || [];
      const lines = items.map((it) => {
        const id = it.id && it.id.videoId;
        if (!id) return null;
        const sn = it.snippet || {};
        return '- ' + String(sn.title || '').slice(0, 140) + ' | https://youtu.be/' + id + ' | ' + (sn.channelTitle || '');
      }).filter(Boolean);
      if (lines.length) return lines;
    } catch (e) { console.error('searchYouTube api:', e.message); }
  }
  try {
    const r = await jfetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&hl=ru', { headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
    const html = await r.text();
    const re = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"([^"]+)"\}\][\s\S]*?"ownerText":\{"runs":\[\{"text":"([^"]+)"/g;
    const out = [];
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
      out.push('- ' + decodeHtml(m[2]).slice(0, 140) + ' | https://youtu.be/' + m[1] + ' | ' + decodeHtml(m[3]));
    }
    return out;
  } catch (e) {
    console.error('searchYouTube scrape:', e.message);
    return [];
  }
}

// ───────────── Reddit ─────────────
async function searchReddit(query, limit = 5) {
  try {
    const r = await jfetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(cleanQuery(query))}&sort=relevance&t=year&limit=${limit}&raw_json=1`, { headers: { Accept: 'application/json' } });
    const d = await r.json();
    const kids = (d && d.data && d.data.children) || [];
    return kids.map((c) => {
      const p = c && c.data;
      if (!p || !p.title) return null;
      const url = p.url && /^https?:/.test(p.url) ? p.url : 'https://www.reddit.com' + (p.permalink || '');
      const snip = String(p.selftext || '').replace(/\s+/g, ' ').slice(0, 140);
      return '- [r/' + p.subreddit + '] ' + String(p.title).slice(0, 150) + ' | ' + url + (snip ? ' | ' + snip : '');
    }).filter(Boolean);
  } catch (e) {
    console.error('searchReddit:', e.message);
    return [];
  }
}

// ───────────── Веб ─────────────
async function searchWeb(query, limit = 5) {
  const q = encodeURIComponent(cleanQuery(query));
  const out = [];
  try {
    const r = await jfetch('https://html.duckduckgo.com/html/?q=' + q);
    const html = await r.text();
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
      let href = decodeHtml(m[1]);
      const mm = /[?&]uddg=([^&]+)/.exec(href);
      if (mm) { try { href = decodeURIComponent(mm[1]); } catch (_) { /* оставляем */ } }
      if (!/^https?:/.test(href)) continue;
      const title = decodeHtml(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 150);
      out.push('- ' + (title || 'без названия') + ' | ' + href);
    }
  } catch (e) { console.error('searchWeb ddg:', e.message); }

  if (!out.length) {
    try {
      const r = await jfetch('https://lite.duckduckgo.com/lite/?q=' + q);
      const html = await r.text();
      const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < limit) {
        const href = decodeHtml(m[1]);
        if (!/^https?:/.test(href)) continue;
        out.push('- ' + decodeHtml(m[2].replace(/<[^>]+>/g, '')).trim().slice(0, 150) + ' | ' + href);
      }
    } catch (e) { console.error('searchWeb lite:', e.message); }
  }
  return out;
}

async function searchWiki(query, limit = 3) {
  try {
    const q = encodeURIComponent(cleanQuery(query));
    const r = await jfetch(`https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=${limit}`, { headers: { Accept: 'application/json' } });
    const d = await r.json();
    const items = (d && d.query && d.query.search) || [];
    return items.map((it) => '- ' + it.title + ' | https://ru.wikipedia.org/wiki/' + encodeURIComponent(it.title.replace(/ /g, '_')) + ' | ' + decodeHtml(String(it.snippet || '').replace(/<[^>]+>/g, '')).slice(0, 140));
  } catch (e) {
    console.error('searchWiki:', e.message);
    return [];
  }
}

async function searchInternet(query, opts = {}) {
  const q = String(query || '').toLowerCase();
  const wantVideo = /ютуб|youtube|видео|ролик|трейлер|клип/.test(q);
  const wantReddit = /реддит|reddit|мем|сабреддит|тред/.test(q);
  const jobs = [];
  const labels = [];
  if (wantVideo) { jobs.push(searchYouTube(query)); labels.push('YouTube'); }
  if (wantReddit) { jobs.push(searchReddit(query)); labels.push('Reddit'); }
  if (!jobs.length) {
    jobs.push(searchWeb(query), searchReddit(query));
    labels.push('веб', 'Reddit');
  }
  const results = await Promise.all(jobs);
  const chunks = [];
  const used = [];
  results.forEach((lines, i) => {
    if (lines && lines.length) { chunks.push('[' + labels[i] + ']:\n' + lines.join('\n')); used.push(labels[i]); }
  });
  if (!chunks.length) {
    const wiki = await searchWiki(query);
    if (wiki.length) { chunks.push('[Wikipedia]:\n' + wiki.join('\n')); used.push('Wikipedia'); }
  }
  return { text: chunks.join('\n\n'), sources: used };
}

module.exports = { searchInternet, searchReddit, searchYouTube, searchWeb, searchWiki };
