// lib/ai.js
// Gemini (цепочка моделей x ключи) -> Groq -> фолбэк в вызывающем коде.
// Квоты: 429 запоминается в Redis до сброса, мёртвые модели пропускаются мгновенно.
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

// Lite первыми: у них суточная квота больше. Алиас gemini-flash-latest намеренно НЕ используем -
// он указывает на самый новый flash с самым жёстким лимитом.
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
  // В тексте 429 указано реальное имя модели (алиас может указывать на другую) - глушим оба.
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
// Модель может съехать на правильный русский - эти замены держат акцент всегда.
function accentize(s) {
  let t = String(s || '');
  t = t.replace(/\b(могу|можешь|можем|могут|можете|умею|умеешь|умеет|умеем)\b/gi, 'мочь');
  t = t.replace(/\bчто\b/gi, 'цто');
  t = t.replace(/\bчеловек([а-я]{0,3})\b/gi, 'целовек$1');
  t = t.replace(/\bхорошо\b/gi, 'харосо');
  t = t.replace(/\bконечно\b/gi, 'конешно');
  t = t.replace(/\bобязательно\b/gi, 'обязателно');
  if (Math.random() < 0.3) t = t.replace(/\bочень\b/i, 'ооооцень');
  return t;
}

// «Идеальный компьютер» - только если спросили про её голову/мозг. Иначе подменяем.
function deComputerize(s, asked) {
  if (asked) return s;
  if (!/идеальн\w*\s+компьютер/i.test(s)) return s;
  const subs = ['мой голова', 'моя башка', 'мой умный голова', 'моя кроличья голова'];
  return s.replace(/идеальн\w*\s+компьютер\w*/gi, () => subs[Math.floor(Math.random() * subs.length)]);
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

async function callGemini(model, key, contents, generationConfig, deadline, withSafety) {
  const left = deadline - Date.now();
  if (left < 1500) throw new Error('no time left');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(left, PER_CALL_MS));
  try {
    const body = { systemInstruction: { parts: [{ text: SYSTEM_TEXT }] }, contents, generationConfig };
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

function toOpenAIMessages(contents) {
  const msgs = [{ role: 'system', content: SYSTEM_TEXT }];
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

async function tryGroq(contents, deadline, cleanOpts) {
  if (!process.env.GROQ_API_KEY) return null;
  const extra = String(process.env.GROQ_MODELS || process.env.GROQ_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
  const messages = toOpenAIMessages(contents);
  for (const model of [...new Set([...extra, ...GROQ_MODELS])]) {
    if (Date.now() > deadline - 2500) break;
    try {
      const text = cleanReply(await callGroq(model, messages, deadline), cleanOpts);
      if (text && !looksLikeRefusal(text)) return { text, model: `groq:${model}` };
    } catch (e) {
      console.error(`Groq ${model}: ${e.message}`);
    }
  }
  return null;
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
  let lastError = null;
  let tried = 0;

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
          if ((quota[model + '|' + kid] || 0) > Date.now()) continue; // квота: пропускаем молча и мгновенно
          for (let attempt = 0; attempt < 2; attempt++) {
            if (Date.now() > geminiDeadline - 1500) break;
            const useContents = attempt === 0 ? contents : [{ role: 'user', parts: [{ text: RETRY_PREFIX }] }, ...contents];
            const gc = attempt === 0 ? genConfig(model, c) : { maxOutputTokens: c.maxOutputTokens };
            tried++;
            try {
              const raw = await callGemini(model, key, useContents, gc, geminiDeadline, attempt === 0);
              const text = cleanReply(raw, cleanOpts);
              if (text && !looksLikeRefusal(text)) return { text, model };
              lastError = new Error('refusal: ' + text.slice(0, 80));
            } catch (e) {
              lastError = e;
              if (e.status === 429) {
                await markQuota(model, key, e.message);
                break; // никакой второй попытки на мёртвой квоте
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

  const alt = await tryGroq(contents, deadline, cleanOpts);
  if (alt) return alt;
  throw lastError || new Error('All providers failed');
}

module.exports = { generateReply, buildContents, cleanReply, looksLikeRefusal, accentize, STATIC_MODELS };
