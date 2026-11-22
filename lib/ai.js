// Вся генерация: цепочка Gemini (все ключи x все модели), потом Groq.
// Плюс анти-повторный фильтр: сравнивает ответ с её же прошлыми репликами в истории,
// ловит затёртые фразы и одинаковые начала, при повторе - одна перегенерация с нуля.
const { SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, RETRY_PREFIX } = require('./persona');
const { EXTRA_RULES, ANTI_REPEAT_RULES } = require('./prompts');
const { cfg } = require('./config');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PER_CALL_MS = 9000;
const ALT_RESERVE_MS = 5000;

function geminiKeys() {
  return String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
const modelChain = [
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash',
  'gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-flash-latest'
].filter(Boolean);
const systemText = [SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, ANTI_REPEAT_RULES, EXTRA_RULES]
  .filter(Boolean).join('\n');

// ───────────── анти-повтор ─────────────
// Фразы, которые она затёрла до дыр. Встретились - вырезаем/переписываем.
const BANNED_PHRASES = [
  'восемьдесят один рубль шестьдесят девять',
  'восемьдесят один рубль',
  'моя секретная лаборатория',
  'секретная лаборатория',
  'наш великий'
];
// Разрешённые, но не чаще раза в несколько ответов.
const OVERUSED_PHRASES = [
  'идеальный компьютер', 'колхозан', 'с тебя двадцатка', 'с тебя двадцатка за услуга',
  'харе лупасить', 'харе лупатасить', 'не оцень то и хотелось', 'я грызун',
  'моя монеточка', 'встать колени', 'самая свободная', 'поплац', 'днр днр'
];
const ANTI_RETRY_PREFIX = '[СТОП. Твой вариант слишком похож на то, что ты уже говорила в этом чате ранее. Полный запрет на повтор: другое начало, другой механизм лжи, другой ритм, другие слова. Перепиши с нуля, характер тот же.]';

function cleanReply(t) {
  let s = String(t || '').trim();
  s = s.replace(/^\s*\[?Танг\]?\s*[:：]\s*/i, '');
  s = s.replace(/^[\s>*_#-]*\s*(Танг Джи Рина|Tang Jee Rina|Танджи)\s*[:：]\s*/i, '');
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__\s*/g, '$1');
  s = s.replace(/^[-*]\s+/gm, '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/(как ИИ|как языковая модель|как ассистент|as an ai|as a language model|i am an ai|i'm an ai|language model)[^\n]*/gi, '');
  s = s.replace(/\n{4,}/g, '\n\n').trim();
  return s;
}
function looksLikeRefusal(t) {
  const s = String(t || '').toLowerCase();
  return s.length < 400 && /(как ИИ|как языковая модель|как ассистент|не могу помочь|не могу выполнить|не буду притворяться|не могу притворяться|as an ai|as a language model|i am an ai|i'm an ai|language model|i can't roleplay|i cannot roleplay)/.test(s);
}

// Её прошлые реплики прямо из contents (role model) - без доступа к памяти.
function recentModelReplies(contents, n = 6) {
  const out = [];
  for (let i = contents.length - 1; i >= 0 && out.length < n; i--) {
    const c = contents[i];
    if (!c || c.role !== 'model') continue;
    const text = (c.parts || []).map((p) => p.text || '').join(' ').trim();
    if (text.length > 3) out.push(text);
  }
  return out;
}
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function wordSet(s, k) {
  const w = norm(s).split(' ').filter(Boolean);
  if (w.length < k) return new Set(w.length ? [w.join(' ')] : []);
  const g = new Set();
  for (let i = 0; i + k <= w.length; i++) g.add(w.slice(i, i + k).join(' '));
  return g;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function firstLetters(s, n = 14) {
  return norm(s).replace(/\s/g, '').slice(0, n);
}

// Оценка похожести нового ответа на её последние реплики. true = повтор.
function isRepeat(text, recent) {
  const s = norm(text);
  if (!s) return false;
  const low = String(text).toLowerCase();
  for (const b of BANNED_PHRASES) if (low.includes(b)) return true;
  for (const o of OVERUSED_PHRASES) {
    if (low.includes(o)) {
      let cnt = 0;
      for (const r of recent.slice(0, 4)) if (String(r).toLowerCase().includes(o)) cnt++;
      if (cnt >= 2) return true;
    }
  }
  const starts = recent.slice(0, 3).map((r) => firstLetters(r));
  const st = firstLetters(text);
  if (st.length >= 8 && starts.some((x) => x.length >= 8 && x === st)) return true;
  // паттерн-ловушка "Ооооо..."
  const ooo = /^о{3,}/.test(s);
  if (ooo && recent.slice(0, 3).filter((r) => /^о{3,}/.test(norm(r))).length >= 2) return true;
  // лексическое сходство
  const k = norm(text).split(' ').length >= 10 ? 4 : 3;
  const g = wordSet(text, k);
  for (const r of recent) {
    if (jaccard(g, wordSet(r, k)) >= 0.45) return true;
  }
  return false;
}
function cutBanned(text) {
  let s = String(text || '');
  for (const b of BANNED_PHRASES) {
    s = s.replace(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}
function similarityScore(text, recent) {
  const k = norm(text).split(' ').length >= 10 ? 4 : 3;
  const g = wordSet(text, k);
  let max = 0;
  for (const r of recent) max = Math.max(max, jaccard(g, wordSet(r, k)));
  return max;
}

// ───────────── склейка истории ─────────────
function buildContents(history, parts) {
  const c = cfg();
  const contents = [];
  let budget = c.historyTokenBudget || 8000;
  const hist = Array.isArray(history) ? history.slice(-c.historyMax) : [];
  for (const h of hist) {
    const text = String(h.t || '').slice(0, c.historyMsgChars);
    if (budget - text.length < 0) break;
    budget -= text.length;
    contents.push({ role: h.r === 'm' ? 'model' : 'user', parts: [{ text }] });
  }
  contents.push({ role: 'user', parts });
  return contents;
}

async function callGemini(model, key, contents, genConfig, deadline) {
  const left = deadline - Date.now();
  if (left < 1500) throw new Error('no time left');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(left, PER_CALL_MS));
  try {
    const r = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: genConfig
      })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${data && data.error ? data.error.message : ''}`.trim());
    const cand = data && data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '';
    if (!text) throw new Error('empty candidate');
    return text;
  } finally {
    clearTimeout(t);
  }
}

const ALT_PROVIDERS = [
  {
    name: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: () => process.env.GROQ_API_KEY,
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    headers: (k) => ({ Authorization: `Bearer ${k}` })
  }
];
function toOpenAIMessages(contents) {
  const msgs = [{ role: 'system', content: systemText }];
  let images = 0;
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = [];
    for (const p of c.parts || []) {
      if (p.text) parts.push({ type: 'text', text: p.text });
      else if (p.inline_data && /^image\//.test(p.inline_data.mime_type || '') && images < 3) {
        images++;
        parts.push({ type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } });
      }
    }
    if (!parts.length) parts.push({ type: 'text', text: '(пустое сообщение)' });
    msgs.push({ role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  return msgs;
}
async function callAltProvider(prov, messages, deadline) {
  const left = deadline - Date.now();
  if (left < 2500) throw new Error('no time left');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(left, 12000));
  try {
    const r = await fetch(prov.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...prov.headers(prov.key()) },
      signal: ctrl.signal,
      body: JSON.stringify({ model: prov.model, messages, temperature: 1.0, max_tokens: 1024 })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) throw new Error(`${prov.name} HTTP ${r.status}`);
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error(`${prov.name} empty`);
    return text;
  } finally {
    clearTimeout(t);
  }
}
async function tryAltProviders(contents, deadline) {
  for (const prov of ALT_PROVIDERS) {
    if (!prov.key()) continue;
    try {
      const raw = await callAltProvider(prov, toOpenAIMessages(contents), deadline);
      const text = cleanReply(raw);
      if (text && !looksLikeRefusal(text)) return { text, model: `${prov.name}:${prov.model}` };
    } catch (e) {
      console.error(`Alt provider ${prov.name} failed: ${e.message}`);
    }
  }
  return null;
}

async function generateReply(contents, opts = {}) {
  const c = cfg();
  const deadline = opts.deadline || Date.now() + 22000;
  const geminiDeadline = deadline - ALT_RESERVE_MS;
  const keys = geminiKeys();
  const recent = recentModelReplies(contents);
  let lastError = null;
  let stop = false;

  if (keys.length) {
    for (const model of modelChain) {
      if (stop) break;
      for (const key of keys) {
        if (Date.now() > geminiDeadline - 1500) { stop = true; break; }
        for (let attempt = 0; attempt < 2; attempt++) {
          if (Date.now() > geminiDeadline - 1500) { stop = true; break; }
          const useContents = attempt === 0 ? contents : [{ role: 'user', parts: [{ text: RETRY_PREFIX }] }, ...contents];
          try {
            const raw = await callGemini(model, key, useContents, {
              temperature: attempt === 0 ? 0.9 : 0.7,
              maxOutputTokens: c.maxOutputTokens || 1536,
              topP: 0.95
            }, geminiDeadline);
            let text = cleanReply(raw);
            if (text && !looksLikeRefusal(text)) {
              // анти-повтор: одна перегенерация, если ответ похож на её же прошлые реплики
              if (recent.length && isRepeat(text, recent) && Date.now() < geminiDeadline - 4500) {
                const retryContents = [...contents, { role: 'user', parts: [{ text: ANTI_RETRY_PREFIX }] }];
                try {
                  const raw2 = await callGemini(model, key, retryContents, {
                    temperature: 1.05,
                    maxOutputTokens: c.maxOutputTokens || 1536,
                    topP: 0.98
                  }, geminiDeadline);
                  const text2 = cleanReply(raw2);
                  if (text2 && !looksLikeRefusal(text2)) {
                    if (!isRepeat(text2, recent)) text = text2;
                    else if (similarityScore(text2, recent) < similarityScore(text, recent)) text = text2;
                  }
                } catch (_) { /* оставляем первый вариант */ }
              }
              return { text: cutBanned(text), model };
            }
            lastError = new Error('refusal: ' + text.slice(0, 80));
          } catch (e) {
            lastError = e;
            console.error(`Gemini ${model} (key #${keys.indexOf(key) + 1}): ${e.message}`);
            break;
          }
        }
      }
    }
  } else {
    lastError = new Error('GEMINI_API_KEY is not set');
  }

  const alt = await tryAltProviders(contents, deadline);
  if (alt) {
    let text = alt.text;
    if (recent.length && isRepeat(text, recent) && Date.now() < deadline - 4000) {
      try {
        const raw2 = await callAltProvider(ALT_PROVIDERS[0], toOpenAIMessages([...contents, { role: 'user', parts: [{ text: ANTI_RETRY_PREFIX }] }]), deadline);
        const text2 = cleanReply(raw2);
        if (text2 && !looksLikeRefusal(text2) && !isRepeat(text2, recent)) text = text2;
      } catch (_) {}
    }
    return { text: cutBanned(text), model: alt.model };
  }
  throw lastError || new Error('All providers failed');
}

module.exports = { generateReply, buildContents, cleanReply, looksLikeRefusal, isRepeat };
