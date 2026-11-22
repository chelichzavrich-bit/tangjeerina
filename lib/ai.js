// lib/ai.js
// Gemini (цепочка моделей x ключи) -> Groq -> фолбэк в вызывающем коде.
// Квоты: 429 запоминается в Redis до сброса, мёртвые модели пропускаются мгновенно.
// Анти-повтор: бот анализирует свои прошлые реплики и запрещает себе затасканные начала и обороты.
const { SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, RETRY_PREFIX } = require('./persona');
const { EXTRA_RULES } = require('./prompts');
const { cfg } = require('./config');
const memory = require('./memory');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PER_CALL_MS = 10000;
const ALT_RESERVE_MS = 7000;
const QUOTA_KEY = 'tj4:quota';

const SYSTEM_TEXT = [SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, EXTRA_RULES]
  .filter(Boolean).join('\n');

const STATIC_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.6-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'gemini-4-hydrogen'
];

function geminiKeys() {
  return String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
function envModels() {
  return String(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || '')
    .split(',').map((s) => s.trim().replace(/^models\//, '')).filter(Boolean);
}
function keyId(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ───────────── память квот ─────────────
let qCache = { at: 0, map: {} };

async function loadQuota() {
  if (Date.now() - qCache.at < 10000) return qCache.map;
  try {
    const [flat] = await memory.exec([['HGETALL', QUOTA_KEY]]);
    const map = {};
    for (let i = 0; i < (flat || []).length; i += 2) map[flat[i]] = Number(flat[i + 1]) || 0;
    qCache = { at: Date.now(), map };
  } catch (_) { /* остаётся кэш процесса */ }
  return qCache.map;
}

function parseRetryMs(msg) {
  const s = String(msg || '');
  const m = /retry in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*([\d.]+)?\s*s?/i.exec(s);
  let sec = 0;
  if (m) sec = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  const daily = /per day|requests per day|\bRPD\b|daily/i.test(s);
  if (!sec) sec = daily ? 3600 : 60;
  return Math.min(Math.max(Math.round(sec * 1000), 30000), 24 * 3600 * 1000);
}

async function markQuota(model, key, message) {
  const until = Date.now() + parseRetryMs(message);
  const kid = keyId(key);
  const names = [model];
  const real = /model:\s*([a-z0-9.\-]+)/i.exec(String(message || ''));
  if (real && real[1] && real[1] !== model) names.push(real[1]);
  const cmds = [];
  for (const n of names) {
    qCache.map[n + '|' + kid] = until;
    cmds.push(['HSET', QUOTA_KEY, n + '|' + kid, until]);
  }
  cmds.push(['EXPIRE', QUOTA_KEY, 86400]);
  try { await memory.exec(cmds); } catch (_) { /* кэш процесса всё равно работает */ }
  console.warn(`Quota: ${names.join('/')} key#${kid} отдыхает ${Math.round((until - Date.now()) / 60000)} мин`);
}

async function discoverModels(key) {
  const cache = global.__tjrModels;
  if (cache && Date.now() - cache.at < 3600000) return cache.list;
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: ctrl.signal });
    const d = await r.json().catch(() => null);
    const list = ((d && d.models) || [])
      .filter((m) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /flash|hydrogen/i.test(n))
      .filter((n) => !/image|tts|live|native-audio|transcribe|robotics|computer|omni|banana|embedding|aqa/i.test(n));
    global.__tjrModels = { at: Date.now(), list };
    return list;
  } catch (_) {
    global.__tjrModels = { at: Date.now(), list: [] };
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function thinkingLevelFor(model) {
  const forced = cfg().thinkingLevel;
  if (forced) return forced;
  if (/^gemini-2\.5/.test(model)) return 'low';
  if (/flash-lite|^gemini-3\.6-flash$|^gemini-3-flash/.test(model)) return 'minimal';
  return 'low';
}

function genConfig(model, c) {
  const g = { maxOutputTokens: c.maxOutputTokens };
  if (/^gemini-2\.5/.test(model)) {
    g.temperature = 0.95;
    g.topP = 0.95;
    g.thinkingConfig = { thinkingBudget: 0 };
  } else {
    g.thinkingConfig = { thinkingLevel: thinkingLevelFor(model) };
  }
  return g;
}

const SAFETY = [
  'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY'
].map((category) => ({ category, threshold: process.env.GEMINI_SAFETY || 'BLOCK_ONLY_HIGH' }));

// ───────────── акцент: детерминированная подстраховка ─────────────
function accentize(s) {
  let t = String(s || '');
  t = t.replace(/\b(могу|можешь|можем|могут|можете|умею|умеешь|умеет|умеем)\b/gi, 'мочь');
  t = t.replace(/\bчто\b/gi, 'цто');
  t = t.replace(/\bчеловек([а-я]{0,3})\b/gi, 'целовек$1');
  t = t.replace(/\bхорошо\b/gi, 'харосо');
  t = t.replace(/\bконечно\b/gi, 'конешно');
  t = t.replace(/\bобязательно\b/gi, 'обязателно');
  if (Math.random() < 0.2) t = t.replace(/\bочень\b/i, 'ооооцень');
  return t;
}

function deComputerize(s, asked) {
  if (asked) return s;
  if (!/идеальн\w*\s+компьютер/i.test(s)) return s;
  const subs = ['мой голова', 'моя башка', 'мой умный голова', 'моя кроличья голова'];
  return s.replace(/идеальн\w*\s+компьютер\w*/gi, () => subs[Math.floor(Math.random() * subs.length)]);
}

// ───────────── АНТИ-ПОВТОР ─────────────
// Всё, что здесь, работает без модели: сравнивает новый ответ с её же прошлыми репликами.

// Фразы, запрещённые навсегда (по просьбе хозяина).
const BANNED_SOURCES = [
  'восемьдесят\\s+один\\s+рубл\\w*(?:\\s+шестьдесят\\s+девять\\s+копе\\w*)?',
  'восьмидесят\\w*\\s+один\\s+рубл\\w*',
  'секретн\\w*\\s+лаборатори\\w*'
];
const BANNED_RE = BANNED_SOURCES.map((s) => new RegExp(s, 'i'));
const BANNED_RE_G = BANNED_SOURCES.map((s) => new RegExp(s, 'gi'));

// Нормализация для сравнения: убираем эмодзи, тянущиеся гласные и пунктуацию.
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/([аеёиоуыэюяaeiou])\1{1,}/gu, '$1')
    .replace(/[^а-яёa-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Междометные начала («Ооооооо», «Ой», «Какоооой», «Ахаха») считаются ОДНИМ классом.
const INTERJ = /^(о+|ой|ои|ах+|аха+|эх+|эхей|эй+|ай+|айяй|уи+|ух+|ха+|хехе|хихи|бу+у|чщ+|ненене|какой|како|оцень|ну)(\s|$)/;

function openingKey(s) {
  const t = normText(s);
  if (!t) return '';
  if (INTERJ.test(t)) return 'interj';
  return t.split(' ').slice(0, 2).join(' ');
}

function grams(t, n) {
  const w = t.split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
  return out;
}

// Собирает «щит» из её собственных реплик, которые уже есть в contents.
function buildGuard(contents) {
  const mine = [];
  for (const item of contents || []) {
    if (!item || item.role !== 'model') continue;
    for (const p of item.parts || []) if (p && p.text) mine.push(String(p.text));
  }
  const normed = mine.slice(-8).map(normText).filter(Boolean);

  const openCount = new Map();
  for (const t of normed) {
    const k = openingKey(t);
    if (k) openCount.set(k, (openCount.get(k) || 0) + 1);
  }
  const bannedOpenings = [...openCount.entries()].filter(([, c]) => c >= 2).map(([k]) => k);

  const cnt = new Map();
  for (const t of normed) {
    const seen = new Set([...grams(t, 3), ...grams(t, 4)]);
    for (const g of seen) cnt.set(g, (cnt.get(g) || 0) + 1);
  }
  const stale = [...cnt.entries()]
    .filter(([g, c]) => c >= 3 && g.length >= 12)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 10)
    .map(([g]) => g);

  const lastForms = normed.slice(-3).map((t) => t.split(' ').slice(0, 3).join(' ')).filter(Boolean);

  let block = '';
  if (normed.length) {
    const lines = ['[АНТИ-ПОВТОР. ЭТОТ БЛОК ГЛАВНЕЕ СТИЛИСТИЧЕСКИХ ПРИМЕРОВ ВЫШЕ.]'];
    lines.push('Твои прошлые реплики уже есть в диалоге. Повторяться нельзя: ни словами, ни началом, ни построением фразы.');
    if (bannedOpenings.includes('interj')) {
      lines.push('ЗАПРЕЩЕНО начинать с междометия: «Оооо», «Ой», «Ооооой», «Какоооой», «Ахаха», «Ну». Начни сразу с существа дела.');
    }
    const otherOpens = bannedOpenings.filter((k) => k !== 'interj');
    if (otherOpens.length) lines.push('ЗАПРЕЩЁННЫЕ начала (уже были): ' + otherOpens.slice(0, 6).map((k) => '«' + k + '…»').join(', ') + '.');
    if (stale.length) lines.push('ЗАТАСКАННЫЕ обороты, не использовать вообще: ' + stale.map((g) => '«' + g + '»').join(', ') + '.');
    if (lastForms.length) lines.push('Последние зачины были такие: ' + lastForms.map((t) => '«' + t + '…»').join(', ') + '. Сделай иначе.');
    lines.push('Смени ФОРМУ реплики: если раньше была небылица-хвастовство, сейчас задай вопрос, предложи сделку, брось короткое обвинение, опиши одно действие или откажись сухо. Не повторяй схему «междометие + обращение + похвала + удар».');
    lines.push('Не выдумывай себе лабораторию, институт, звание или должность, если уже выдумывала их раньше в этом диалоге. Придумай другое.');
    lines.push('Числа курса и суммы пиши ЦИФРАМИ, не прописью.');
    lines.push('Речь: сильный ломаный русский с китайским акцентом.');
    block = '\n\n' + lines.join('\n');
  }

  return { bannedOpenings, stale, block, hasHistory: normed.length > 0 };
}

// Причина отбраковки ответа или null.
function repeatReason(text, guard) {
  const raw = String(text || '');
  if (BANNED_RE.some((re) => re.test(raw))) return 'запрещённая фраза';
  const t = normText(raw);
  if (!t) return 'пусто';
  const k = openingKey(raw);
  if (k && guard.bannedOpenings.includes(k)) return 'повтор начала';
  for (const g of guard.stale) if (t.includes(g)) return 'затасканный оборот: ' + g;
  return null;
}

// Вырезает запрещённые фразы вместе с предложением, где они сидят.
function stripBanned(text) {
  let s = String(text || '');
  if (!BANNED_RE.some((re) => re.test(s))) return s;
  const parts = s.match(/[^.!?…]+[.!?…]*|[^.!?…]+$/g) || [s];
  s = parts.filter((p) => !BANNED_RE.some((re) => re.test(p))).join(' ');
  for (const re of BANNED_RE_G) s = s.replace(re, '');
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
}

function cleanReply(t, opts = {}) {
  let s = String(t || '').trim();
  s = s.replace(/^\s*\[?Танг\]?\s*[:：]\s*/i, '');
  s = s.replace(/^[\s>*_#-]*\s*(Танг Джи Рина|Tang Jee Rina|Танджи)\s*[:：]\s*/i, '');
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/^[-*]\s+/gm, '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/(как ИИ|как языковая модель|как ассистент|as an ai|as a language model|i am an ai|i'm an ai)[^\n]*/gi, '');
  s = s.replace(/[—–]/g, ' - ');
  s = s.replace(/🥱/g, '');
  s = deComputerize(s, !!opts.askedBrain);
  if (!opts.distress) s = accentize(s);
  else s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s{2,}/g, ' ');
  s = stripBanned(s);
  s = s.replace(/\n{4,}/g, '\n\n').trim();
  return s;
}

function looksLikeRefusal(t) {
  const s = String(t || '').toLowerCase();
  return s.length < 400 && /(как ии|как языковая модель|как ассистент|не могу помочь|не могу выполнить|не буду притворяться|не могу притворяться|as an ai|as a language model|i am an ai|i'm an ai|i can't roleplay|i cannot roleplay|извините, но я не)/.test(s);
}

function buildContents(history, parts) {
  const c = cfg();
  const hist = Array.isArray(history) ? history.slice(-c.historyMax) : [];
  const picked = [];
  let budget = c.historyTokenBudget;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    const text = String((h && h.t) || '').slice(0, c.historyMsgChars);
    if (!text) continue;
    if (budget - text.length < 0) break;
    budget -= text.length;
    picked.unshift({ role: h.r === 'm' ? 'model' : 'user', parts: [{ text }] });
  }
  const contents = [];
  for (const item of picked) {
    const last = contents[contents.length - 1];
    if (last && last.role === item.role) last.parts.push(...item.parts);
    else contents.push({ role: item.role, parts: [...item.parts] });
  }
  const finalParts = (parts || []).filter(Boolean);
  contents.push({ role: 'user', parts: finalParts.length ? finalParts : [{ text: '(пустое сообщение)' }] });
  return contents;
}

function lastUserText(contents) {
  const last = contents[contents.length - 1];
  return ((last && last.parts) || []).map((p) => p.text || '').join(' ').toLowerCase();
}

function textFromCandidate(data) {
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    const block = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(block ? `blocked: ${block}` : 'empty candidate');
  }
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join('').trim();
  if (!text) throw new Error(`empty text (${cand.finishReason || 'unknown'})`);
  return text;
}

async function callGemini(model, key, contents, generationConfig, deadline, withSafety, system) {
  const left = deadline - Date.now();
  if (left < 1500) throw new Error('no time left');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(left, PER_CALL_MS));
  try {
    const body = { systemInstruction: { parts: [{ text: system || SYSTEM_TEXT }] }, contents, generationConfig };
    if (withSafety) body.safetySettings = SAFETY;
    const r = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} ${(data && data.error && data.error.message) || ''}`.trim());
      err.status = r.status;
      throw err;
    }
    return textFromCandidate(data);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout ${PER_CALL_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────── Groq ─────────────
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

function toOpenAIMessages(contents, system) {
  const msgs = [{ role: 'system', content: system || SYSTEM_TEXT }];
  for (const item of contents) {
    const role = item.role === 'model' ? 'assistant' : 'user';
    const text = (item.parts || []).map((p) => p.text || '').filter(Boolean).join('\n').trim();
    msgs.push({ role, content: text || '(пустое сообщение)' });
  }
  return msgs;
}

async function callGroq(model, messages, deadline) {
  const left = deadline - Date.now();
  if (left < 2500) throw new Error('no time left');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(left, 12000));
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: ctrl.signal,
      body: JSON.stringify({ model, messages, max_tokens: 1024 })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) {
      const err = new Error(`groq HTTP ${r.status} ${(data && data.error && data.error.message) || ''}`.trim());
      err.status = r.status;
      throw err;
    }
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('groq empty');
    return String(text);
  } finally {
    clearTimeout(timer);
  }
}

async function tryGroq(contents, deadline, cleanOpts, guard, system) {
  if (!process.env.GROQ_API_KEY) return null;
  const extra = String(process.env.GROQ_MODELS || process.env.GROQ_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
  const messages = toOpenAIMessages(contents, system);
  let spare = null;
  for (const model of [...new Set([...extra, ...GROQ_MODELS])]) {
    if (Date.now() > deadline - 2500) break;
    try {
      const text = cleanReply(await callGroq(model, messages, deadline), cleanOpts);
      if (!text || looksLikeRefusal(text)) continue;
      if (!repeatReason(text, guard)) return { text, model: `groq:${model}` };
      if (!spare) spare = { text, model: `groq:${model}` };
    } catch (e) {
      console.error(`Groq ${model}: ${e.message}`);
    }
  }
  return spare;
}

async function generateReply(contents, opts = {}) {
  const c = cfg();
  const deadline = opts.deadline || Date.now() + 25000;
  const geminiDeadline = deadline - ALT_RESERVE_MS;
  const keys = geminiKeys();
  const cleanOpts = {
    distress: !!opts.distress,
    askedBrain: /мозг|голов|компьютер|процессор|нейрон|как ты думаешь|ты умная/.test(lastUserText(contents))
  };

  // В режиме реальной беды анти-повтор не мешает: там важнее сказать по-человечески.
  const guard = opts.distress
    ? { bannedOpenings: [], stale: [], block: '', hasHistory: false }
    : buildGuard(contents);
  const system = SYSTEM_TEXT + guard.block;

  let lastError = null;
  let tried = 0;
  let spare = null; // повторяющийся, но живой ответ - лучше, чем молчание

  if (keys.length) {
    const quota = await loadQuota();
    const badKeys = new Set();
    const badModels = new Set();

    const tryChain = async (chain) => {
      for (const model of chain) {
        if (badModels.has(model) || Date.now() > geminiDeadline - 2500) continue;
        for (const key of keys) {
          if (badKeys.has(key) || badModels.has(model) || Date.now() > geminiDeadline - 2000) break;
          const kid = keyId(key);
          if ((quota[model + '|' + kid] || 0) > Date.now()) continue;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (Date.now() > geminiDeadline - 1500) break;
            const useContents = attempt === 0 ? contents : [{ role: 'user', parts: [{ text: RETRY_PREFIX }] }, ...contents];
            const gc = attempt === 0 ? genConfig(model, c) : { maxOutputTokens: c.maxOutputTokens };
            const sys = attempt === 0
              ? system
              : system + '\n\n[ПРЕДЫДУЩАЯ ПОПЫТКА ПОВТОРЯЛАСЬ. Напиши ДРУГУЮ реплику: другое начало, другие слова, другая форма. Никаких прежних оборотов.]';
            tried++;
            try {
              const raw = await callGemini(model, key, useContents, gc, geminiDeadline, attempt === 0, sys);
              const text = cleanReply(raw, cleanOpts);
              if (text && !looksLikeRefusal(text)) {
                const why = repeatReason(text, guard);
                if (!why) return { text, model };
                if (!spare) spare = { text, model };
                lastError = new Error('повтор (' + why + ')');
                continue;
              }
              lastError = new Error('refusal: ' + text.slice(0, 80));
            } catch (e) {
              lastError = e;
              if (e.status === 429) {
                await markQuota(model, key, e.message);
                break;
              }
              console.error(`Gemini ${model} (key #${keys.indexOf(key) + 1}, try ${attempt + 1}): ${e.message}`);
              if (e.status === 404) { badModels.add(model); break; }
              if (e.status === 401 || e.status === 403) { badKeys.add(key); break; }
              if (/timeout|no time left/i.test(e.message)) { badModels.add(model); break; }
              if (attempt === 0) continue;
              break;
            }
          }
        }
      }
      return null;
    };

    const first = await tryChain([...new Set([...envModels(), ...STATIC_MODELS])]);
    if (first) return first;
    if (Date.now() < geminiDeadline - 4000) {
      const disc = await discoverModels(keys[0]);
      const second = await tryChain([...new Set(disc)].filter((m) => !badModels.has(m)));
      if (second) return second;
    }
    if (!tried) lastError = new Error('все модели Gemini на суточной квоте, ждём сброса');
  } else {
    lastError = new Error('GEMINI_API_KEY is not set');
  }

  const alt = await tryGroq(contents, deadline, cleanOpts, guard, system);
  if (alt && !repeatReason(alt.text, guard)) return alt;
  if (spare) return spare;
  if (alt) return alt;
  throw lastError || new Error('All providers failed');
}

module.exports = {
  generateReply, buildContents, cleanReply, looksLikeRefusal, accentize, STATIC_MODELS,
  buildGuard, repeatReason, stripBanned
};
