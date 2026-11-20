// lib/ai.js
// Генерация: цепочка моделей Gemini x все ключи, затем Groq, затем (в вызывающем коде) фолбэк-реплика.
// ВАЖНО (2026): у Gemini 3.x/4.x temperature/top_p/top_k упразднены, а запрос НЕ может заканчиваться
// репликой роли model. Для новых моделей шлём thinkingConfig.thinkingLevel вместо них.
const { SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, RETRY_PREFIX } = require('./persona');
const { EXTRA_RULES } = require('./prompts');
const { cfg } = require('./config');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PER_CALL_MS = 13000;
const ALT_RESERVE_MS = 8000;

const SYSTEM_TEXT = [SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, EXTRA_RULES]
  .filter(Boolean).join('\n');

// Порядок: сначала быстрые и дешёвые, потом тяжёлые. Несуществующие модели отбрасываются по 404.
const STATIC_MODELS = [
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
];

function geminiKeys() {
  return String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
function envModels() {
  return String(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || '')
    .split(',').map((s) => s.trim().replace(/^models\//, '')).filter(Boolean);
}

// Один раз в час спрашиваем у Google список живых моделей - цепочка самовосстанавливается.
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
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY'
].map((category) => ({ category, threshold: process.env.GEMINI_SAFETY || 'BLOCK_ONLY_HIGH' }));

function cleanReply(t) {
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
  s = s.replace(/\n{4,}/g, '\n\n').trim();
  return s;
}

function looksLikeRefusal(t) {
  const s = String(t || '').toLowerCase();
  return s.length < 400 && /(как ии|как языковая модель|как ассистент|не могу помочь|не могу выполнить|не буду притворяться|не могу притворяться|as an ai|as a language model|i am an ai|i'm an ai|i can't roleplay|i cannot roleplay|извините, но я не)/.test(s);
}

// История + текущее сообщение. Подряд идущие реплики одной роли объединяем, бюджет выбираем с конца,
// последняя реплика всегда user (иначе Gemini 3.6+ вернёт 400).
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
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_TEXT }] },
      contents,
      generationConfig
    };
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

// ───────────── запасной провайдер: Groq (текст) ─────────────
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

async function tryGroq(contents, deadline) {
  if (!process.env.GROQ_API_KEY) return null;
  const extra = String(process.env.GROQ_MODELS || process.env.GROQ_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
  const messages = toOpenAIMessages(contents);
  for (const model of [...new Set([...extra, ...GROQ_MODELS])]) {
    if (Date.now() > deadline - 2500) break;
    try {
      const text = cleanReply(await callGroq(model, messages, deadline));
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
  let lastError = null;

  if (keys.length) {
    const discovered = await discoverModels(keys[0]);
    const chain = [...new Set([...envModels(), ...STATIC_MODELS, ...discovered])];
    const badKeys = new Set();
    const badModels = new Set();
    for (const model of chain) {
      if (badModels.has(model) || Date.now() > geminiDeadline - 2000) continue;
      for (const key of keys) {
        if (badKeys.has(key) || Date.now() > geminiDeadline - 1500) break;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (Date.now() > geminiDeadline - 1500) break;
          const useContents = attempt === 0
            ? contents
            : [{ role: 'user', parts: [{ text: RETRY_PREFIX }] }, ...contents];
          const gc = attempt === 0 ? genConfig(model, c) : { maxOutputTokens: c.maxOutputTokens };
          try {
            const raw = await callGemini(model, key, useContents, gc, geminiDeadline, attempt === 0);
            const text = cleanReply(raw);
            if (text && !looksLikeRefusal(text)) return { text, model };
            lastError = new Error('refusal: ' + text.slice(0, 80));
          } catch (e) {
            lastError = e;
            console.error(`Gemini ${model} (key #${keys.indexOf(key) + 1}, try ${attempt + 1}): ${e.message}`);
            if (e.status === 404) { badModels.add(model); break; }
            if (e.status === 401 || e.status === 403) { badKeys.add(key); break; }
            if (attempt === 0) continue; // второй заход: без safetySettings и без лишних параметров
            break;
          }
        }
      }
    }
  } else {
    lastError = new Error('GEMINI_API_KEY is not set');
  }

  const alt = await tryGroq(contents, deadline);
  if (alt) return alt;
  throw lastError || new Error('All providers failed');
}

module.exports = { generateReply, buildContents, cleanReply, looksLikeRefusal, STATIC_MODELS };
