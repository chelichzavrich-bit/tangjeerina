// Вся генерация: цепочка Gemini (все ключи x все модели), потом Groq.
// У каждого запроса есть таймаут, чтобы функция не умирала по лимиту Vercel.
const { SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, RETRY_PREFIX } = require('./persona');
const { EXTRA_RULES } = require('./prompts');
const { cfg } = require('./config');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PER_CALL_MS = 9000;   // максимум на один запрос к Gemini
const ALT_RESERVE_MS = 5000; // резерв времени для Groq

function geminiKeys() {
    return String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
}

const modelChain = [
    process.env.GEMINI_MODEL,
    'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash',
    'gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-flash-latest'
].filter(Boolean);

const systemText = [SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, EXTRA_RULES]
    .filter(Boolean).join('\n\n');

function cleanReply(t) {
    let s = String(t || '').trim();
    s = s.replace(/^\s*\[?Танг\]?\s*[:：]\s*/i, '');
    s = s.replace(/^[\s>*_#-]*\s*(Танг Джи Рина|Tang Jee Rina|Танджи)\s*[:：]\s*/i, '');
    s = s.replace(/^#{1,6}\s*/gm, '');
    s = s.replace(/\*\*(.+?)\*\*/g, '$1');
    s = s.replace(/__(.+?)__/g, '$1');
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

// Склеивание истории и текущего сообщения. Логика не менялась.
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

// ───────────── запасной провайдер: Groq ─────────────
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
            body: JSON.stringify({ model: prov.model, messages, temperature: 0.9, max_tokens: 1024 })
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
    const geminiDeadline = deadline - ALT_RESERVE_MS; // оставляем время Groq
    const keys = geminiKeys();
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
                        const text = cleanReply(raw);
                        if (text && !looksLikeRefusal(text)) return { text, model };
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
    if (alt) return alt;
    throw lastError || new Error('All providers failed');
}

module.exports = { generateReply, buildContents, cleanReply, looksLikeRefusal };
