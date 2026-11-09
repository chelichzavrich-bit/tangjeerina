// Обёртка над Gemini REST: цепочка моделей, повторы при блокировке фильтром, динамический лимит токенов.
const { SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, RETRY_PREFIX } = require('./persona');
const { cfg } = require('./config');

// COLD_TROLL_PRIORITY идёт последним, чтобы старые заметки про «яростный текст» не перебивали новый протокол
const FULL_SYSTEM = SYSTEM_INSTRUCTION + RUNTIME_NOTE + RUNTIME_NOTE_EXTRA + COLD_TROLL_PRIORITY;

function modelChain() {
    // Базовый список гарантированно живых моделей для v1beta
    const models = [
        process.env.GEMINI_MODEL,
        'gemini-2.5-flash',         
        'gemini-1.5-flash-latest',  
        'gemini-1.5-pro-latest',    
        'gemini-1.5-flash-8b',      
        'gemini-2.0-flash'          
    ];

    return models
        .filter(Boolean)
        // Защита: отсекаем любой мусор, который мог застрять в переменных окружения
        .filter(m => typeof m === 'string' && !m.includes('{') && !m.includes('http') && !m.includes('.com'))
        // Убираем дубликаты
        .filter((m, i, a) => a.indexOf(m) === i);
}

const SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

// Памятная история [{r:'u'|'m', t}] + новые части пользователя -> contents для Gemini.
function buildContents(history, newParts) {
    const contents = [];
    const push = (role, parts) => {
        const last = contents[contents.length - 1];
        if (last && last.role === role) {
            const lastPart = last.parts[last.parts.length - 1];
            if (lastPart && lastPart.text !== undefined && parts && parts.text !== undefined) {
                lastPart.text += '\n' + parts.text;
                last.parts.push(...parts.slice(1));
            } else {
                last.parts.push(...parts);
            }
        } else {
            contents.push({ role, parts: [...parts] });
        }
    };
    for (const h of history || []) {
        if (h && h.t) push(h.r === 'u' ? 'user' : 'model', [{ text: h.t }]);
    }
    if (contents.length && contents.role !== 'user') {
        contents.unshift({ role: 'user', parts: [{ text: '(разговор уже идёт)' }] });
    }
    push('user', newParts);
    return contents;
}

function cleanReply(text) {
    return text
        .replace(/\s*[—–]\s*/g, ' - ')   // персонажу запрещено длинное тире
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

// Если ответ оборвался по лимиту токенов - режем по последнему законченному предложению.
function trimToSentence(text) {
    const m = /^[\s\S]*[.!?…~)*»"'\u{1F300}-\u{1FAFF}]/u.exec(text);
    return m && m.length > text.length * 0.4 ? m.trim() : text;
}

// Лимит токенов: короткие реплики - короче, но с запасом (модель может "думать").
function pickMaxTokens(userLen, hasMedia) {
    const base = cfg().maxOutputTokens;
    return !hasMedia && userLen < 40 ? Math.round(base * 0.75) : base;
}

async function callGemini({ model, contents, system, temperature, maxTokens, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
        // Абсолютно прямая и надежная конкатенация строки URL без использования обратных кавычек
        const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
        
        r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents,
                generationConfig: { temperature, maxOutputTokens: maxTokens },
                safetySettings: SAFETY_SETTINGS
            }),
            signal: ctrl.signal
        });
    } catch (e) {
        const err = new Error("Gemini " + model + " " + (e.name === 'AbortError' ? 'timeout' : 'network error: ' + e.message));
        err.status = 504;
        throw err;
    } finally {
        clearTimeout(timer);
    }
    
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) { }
    
    if (!r.ok) {
        const err = new Error("Gemini " + model + " HTTP " + r.status + ": " + ((data.error && data.error.message) || raw.slice(0, 300)));
        err.status = r.status;
        throw err;
    }
    
    // Стабильный разбор массива кандидатов [0] в соответствии со спецификацией v1beta
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
        ? cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
        : '';
        
    return {
        text,
        finishReason: (cand && cand.finishReason) || '',
        blockReason: (data.promptFeedback && data.promptFeedback.blockReason) || ''
    };
}

async function generateReply(contents, { userLen = 0, hasMedia = false, deadline = Date.now() + 25000 } = {}) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    const baseTokens = pickMaxTokens(userLen, hasMedia);
    const attempts = [
        { temperature: 1.0, system: FULL_SYSTEM, maxTokens: baseTokens },
        { temperature: 0.7, system: RETRY_PREFIX + FULL_SYSTEM, maxTokens: Math.max(baseTokens, 2000) }
    ];
    let lastError = new Error('No model available');
    for (const model of modelChain()) {
        for (let i = 0; i < attempts.length; i++) {
            const left = deadline - Date.now();
            if (left < 1500) throw lastError;
            try {
                const res = await callGemini({
                    model, contents, ...attempts[i], timeoutMs: Math.min(20000, left - 500)
                });
                if (res.text) {
                    const text = res.finishReason === 'MAX_TOKENS' ? trimToSentence(res.text) : res.text;
                    return { text: cleanReply(text), model };
                }
                lastError = new Error("Gemini " + model + ": empty reply (finish=" + (res.finishReason || '-') + ", block=" + (res.blockReason || '-') + ")");
                console.error(String(lastError.message));
            } catch (e) {
                lastError = e;
                console.error(String(e.message));
                if (e.status === 401) throw e;   
                break;                            
            }
        }
    }
    throw lastError;
}

module.exports = { generateReply, buildContents, cleanReply, trimToSentence, pickMaxTokens, modelChain };
