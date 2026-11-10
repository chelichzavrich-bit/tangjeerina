// Обёртка над Gemini REST Interactions API: цепочка моделей, повторы при блокировке фильтром, динамический лимит токенов.
const { SYSTEM_INSTRUCTION, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA, COLD_TROLL_PRIORITY, RETRY_PREFIX } = require('./persona');
const { cfg } = require('./config');

// COLD_TROLL_PRIORITY идёт последним, чтобы старые заметки про «яростный текст» не перебивали новый протокол
const FULL_SYSTEM = SYSTEM_INSTRUCTION + RUNTIME_NOTE + RUNTIME_NOTE_EXTRA + COLD_TROLL_PRIORITY;

function modelChain() {
    // В Interactions API основной и самой стабильной моделью является gemini-3.8-flash
    return [
        process.env.GEMINI_MODEL,
        'gemini-3.8-flash',
        'gemini-3.8-pro'
    ].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
}

const SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

// Превращает историю из старого формата [{r:'u'|'m', t}] + новые части в формат шагов Interactions API
function buildContents(history, newParts) {
    const steps = [];
    
    // Переносим историю в понятный для Interactions API формат (stateless mode)
    for (const h of history || []) {
        if (h && h.t) {
            if (h.r === 'u') {
                steps.push({ type: 'user_input', content: [{ type: 'text', text: h.t }] });
            } else {
                steps.push({ type: 'model_output', content: [{ type: 'text', text: h.t }] });
            }
        }
    }
    
    // Добавляем текущий ввод пользователя
    // Если newParts — это массив элементов, извлекаем текст и медиа
    const currentContent = [];
    for (const part of newParts || []) {
        if (typeof part === 'string') {
            currentContent.push({ type: 'text', text: part });
        } else if (part && part.text) {
            currentContent.push({ type: 'text', text: part.text });
        } else if (part && part.inline_data) {
            // Передача изображений/аватарок
            currentContent.push({ 
                type: 'image', 
                data: part.inline_data.data, 
                mime_type: part.inline_data.mime_type 
            });
        }
    }

    if (currentContent.length === 0) {
        currentContent.push({ type: 'text', text: 'Привет' });
    }

    steps.push({ type: 'user_input', content: currentContent });
    return steps;
}

function cleanReply(text) {
    return text
        .replace(/\s*[—–]\s*/g, ' - ')   // персонажу запрещено длинное тире
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function trimToSentence(text) {
    const m = /^[\s\S]*[.!?…~)*»"'\u{1F300}-\u{1FAFF}]/u.exec(text);
    return m && m.length > text.length * 0.4 ? m.trim() : text;
}

function pickMaxTokens(userLen, hasMedia) {
    const base = cfg().maxOutputTokens;
    return !hasMedia && userLen < 40 ? Math.round(base * 0.75) : base;
}

async function callGemini({ model, contents, system, temperature, maxTokens, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
        // Новый эндпоинт Google Interactions API
        const url = "https://googleapis.com";
        
        // Формируем payload для Interactions API в stateless режиме (store: false)
        const bodyPayload = {
            model: model,
            store: false,
            input: [
                {
                    type: "system_instruction",
                    content: [{ type: "text", text: system }]
                },
                ...contents // Сюда передаются все шаги истории и текущий ввод
            ],
            generationConfig: { 
                temperature: temperature, 
                maxOutputTokens: maxTokens 
            },
            safetySettings: SAFETY_SETTINGS
        };
        
        r = await fetch(url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'x-goog-api-key': process.env.GEMINI_API_KEY,
                'Api-Revision': '2026-05-20'
            },
            body: JSON.stringify(bodyPayload),
            signal: ctrl.signal
        });
    } catch (e) {
        const err = new Error("Gemini " + model + " network error: " + e.message);
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
    
    // Парсинг текста ответа из структуры шагов Interactions API
    let text = '';
    let finishReason = '';
    
    if (data.steps && Array.isArray(data.steps)) {
        // Ищем последний шаг вывода модели
        const outputStep = data.steps.reverse().find(s => s.type === 'model_output');
        if (outputStep && outputStep.content && Array.isArray(outputStep.content)) {
            text = outputStep.content
                .filter(p => p.type === 'text' && p.text)
                .map(p => p.text)
                .join('')
                .trim();
        }
        if (outputStep && outputStep.finish_reason) {
            finishReason = outputStep.finish_reason;
        }
    }
        
    return {
        text,
        finishReason: finishReason,
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
                lastError = new Error("Gemini " + model + ": empty reply (finish=" + (res.finishReason || '-') + ")");
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
