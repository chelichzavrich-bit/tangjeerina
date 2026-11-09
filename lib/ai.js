// ============================================================================
// AI.JS v3.1 - ПРОФИЛИНГ ПОЛЬЗОВАТЕЛЯ + АНАЛИЗ АВАТАРОК + ГЕНЕРАЦИЯ ОТВЕТОВ
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SYSTEM_INSTRUCTION, PULSE_PROMPT, COLD_TROLL_PRIORITY, RETRY_PREFIX, RUNTIME_NOTE, RUNTIME_NOTE_EXTRA } = require("./persona");
const { readMemory, writeMemory } = require("./memory");
const { cfg } = require("./config");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// COLD_TROLL_PRIORITY идёт последним, чтобы старые заметки про «яростный текст» не перебивали новый протокол
const FULL_SYSTEM = SYSTEM_INSTRUCTION + RUNTIME_NOTE + RUNTIME_NOTE_EXTRA + COLD_TROLL_PRIORITY;

function modelChain() {
    return [
        process.env.GEMINI_MODEL,
        'gemini-1.5-flash',
        'gemini-1.5-pro',
        'gemini-2.0-flash'
    ].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
}

const SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

// ============================================================================
// ПРОФИЛИНГ ПОЛЬЗОВАТЕЛЯ (USER PROFILING)
// ============================================================================

async function profileUser(userId, message, avatarUrl = null) {
  let profile = await readMemory(`profile:${userId}`);

  if (!profile) {
    profile = {
      userId,
      firstInteraction: new Date().toISOString(),
      messageCount: 0,
      vulnerabilityTriggers: [],
      jokeStyle: "unknown",
      emotionalResponse: "unknown",
      likelyGender: "unknown",
      estimatedAge: null,
      topicPreferences: [],
      trollResistance: 50,
      attachmentLevel: 0,
      lastAvatarAnalysis: null,
    };
  }

  profile.messageCount += 1;

  const analysisPrompt = `
Проанализируй это сообщение пользователя. Дай короткие ответы строго в JSON формате БЕЗ markdown и без обратных кавычек:
Сообщение: "${message}"

{
  "jokeStyle": "dark|absurd|sweet|toxic|mixed",
  "emotionalTone": "cold|warm|defensive|open|neutral",
  "likelyGender": "M|F|N|unclear",
  "estimatedAge": 25,
  "vulnerabilityDetected": [],
  "topicKeywords": [],
  "trollResistance": 50
}
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(analysisPrompt);
    let analysisText = result.response.text().trim();
    
    if (analysisText.startsWith("```json")) {
      analysisText = analysisText.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    } else if (analysisText.startsWith("```")) {
      analysisText = analysisText.replace(/^```\n?/, "").replace(/\n?```$/, "").trim();
    }

    const analysis = JSON.parse(analysisText);

    profile.jokeStyle = analysis.jokeStyle || profile.jokeStyle;
    profile.emotionalResponse = analysis.emotionalTone || profile.emotionalResponse;
    profile.likelyGender = analysis.likelyGender || profile.likelyGender;
    if (analysis.estimatedAge) profile.estimatedAge = analysis.estimatedAge;
    profile.trollResistance = Math.max(profile.trollResistance, analysis.trollResistance || 50);
    
    if (analysis.topicKeywords && Array.isArray(analysis.topicKeywords)) {
      profile.topicPreferences = [...new Set([...profile.topicPreferences, ...analysis.topicKeywords])];
    }
    if (analysis.vulnerabilityDetected && Array.isArray(analysis.vulnerabilityDetected)) {
      profile.vulnerabilityTriggers = [...new Set([...profile.vulnerabilityTriggers, ...analysis.vulnerabilityDetected])];
    }

    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes("танг") || lowerMsg.includes("жак") || lowerMsg.includes("танджи")) {
      profile.attachmentLevel = Math.min(100, profile.attachmentLevel + 5);
    }
  } catch (e) {
    console.error("Profile analysis error:", e.message);
  }

  if (avatarUrl) {
    try {
      profile.lastAvatarAnalysis = await analyzeAvatar(avatarUrl);
    } catch (e) {
      console.error("Avatar analysis skip:", e.message);
    }
  }

  await writeMemory(`profile:${userId}`, profile, 60 * 60 * 24 * 30);
  return profile;
}

async function analyzeAvatar(avatarUrl) {
  const avatarPrompt = `
Ты - Танг Джи Рина. Твоя работа - анализировать аватарки пользователей и давать едкие комментарии.
Ответь строго в JSON формате БЕЗ markdown и без обратных кавычек:
{
  "colors": ["color1", "color2"],
  "mood": "happy|sad|angry|confused|boring|cringe",
  "description": "одна фраза, что это за аватарка",
  "tangsComment": "едкое замечание от Танг (20-30 символов)",
  "personality": "что это говорит о владельце"
}
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const response = await fetch(avatarUrl);
    if (!response.ok) throw new Error("Failed to fetch avatar");
    const arrayBuffer = await response.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString("base64");

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Data,
        },
      },
      avatarPrompt,
    ]);

    let analysisText = result.response.text().trim();
    if (analysisText.startsWith("```json")) {
      analysisText = analysisText.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    } else if (analysisText.startsWith("```")) {
      analysisText = analysisText.replace(/^```\n?/, "").replace(/\n?```$/, "").trim();
    }

    return JSON.parse(analysisText);
  } catch (e) {
    console.error("Avatar analysis error:", e.message);
    return {
      colors: ["unknown"],
      mood: "unknown",
      description: "Аватарку не смог просмотреть",
      tangsComment: "Фотошоп 💣",
      personality: "unknown",
    };
  }
}

// ============================================================================
// ГЕНЕРАЦИЯ ОТВЕТОВ (GENERATE REPLY & BUILD CONTENTS)
// ============================================================================

function buildContents(history, newParts) {
    const contents = [];
    const push = (role, parts) => {
        const last = contents[contents.length - 1];
        if (last && last.role === role) {
            const lastPart = last.parts[last.parts.length - 1];
            if (lastPart && lastPart.text !== undefined && parts[0] && parts[0].text !== undefined) {
                lastPart.text += '\n' + parts[0].text;
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
    if (contents.length && contents[0].role !== 'user') {
        contents.unshift({ role: 'user', parts: [{ text: '(разговор уже идёт)' }] });
    }
    push('user', newParts);
    return contents;
}

function cleanReply(text) {
    return text
        .replace(/\s*[—–]\s*/g, ' - ')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function trimToSentence(text) {
    const m = /^[\s\S]*[.!?…~)*»"'\u{1F300}-\u{1FAFF}]/u.exec(text);
    return m && m[0].length > text.length * 0.4 ? m[0].trim() : text;
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
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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
        const err = new Error(`Gemini ${model} ${e.name === 'AbortError' ? 'timeout' : 'network error: ' + e.message}`);
        err.status = 504;
        throw err;
    } finally {
        clearTimeout(timer);
    }
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) { /* не JSON */ }
    if (!r.ok) {
        const err = new Error(`Gemini ${model} HTTP ${r.status}: ${(data.error && data.error.message) || raw.slice(0, 300)}`);
        err.status = r.status;
        throw err;
    }
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
                lastError = new Error(`Gemini ${model}: empty reply (finish=${res.finishReason || '-'}, block=${res.blockReason || '-'})`);
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

async function generateResponse(userId, userMessage, avatarUrl = null) {
  const profile = await profileUser(userId, userMessage, avatarUrl);

  const pulseContext = `
[CHAOS HEARTBEAT - ТЕКУЩЕЕ СОСТОЯНИЕ ТАНГ]
- Привязанность к пользователю: ${profile.attachmentLevel}/100
- Сопротивление троллингу пользователя: ${profile.trollResistance}/100
- Уязвимые точки: ${profile.vulnerabilityTriggers.join(", ") || "нет"}
- Стиль юзера: ${profile.jokeStyle}
- Эмоциональный тон: ${profile.emotionalResponse}
${profile.lastAvatarAnalysis ? `- Аватарка юзера: ${profile.lastAvatarAnalysis.tangsComment}` : ""}
`;

  const fullPrompt = `${SYSTEM_INSTRUCTION}

${PULSE_PROMPT}

${COLD_TROLL_PRIORITY}

${pulseContext}

Сообщение пользователя (userId: ${userId}, сообщений: ${profile.messageCount}):
"${userMessage}"

Ответь от первого лица как Танг Джи Рина. Будь естественна, нерегулярна, иногда противоречива.
Используй эмодзи 💣🔫⚡🐰🥕😈 если подходит.
Длина: 1-5 предложений обычно, но иногда можешь развернуться.`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(fullPrompt);
    const response = result.response.text();

    console.log(`[PROFILE ${userId}]`, {
      jokeStyle: profile.jokeStyle,
      attachmentLevel: profile.attachmentLevel,
      trollResistance: profile.trollResistance,
    });

    return response;
  } catch (e) {
    console.error("Response generation error:", e.message);
    return "Что-то пошло не так с моей головой... Спроси потом. 💣";
  }
}

module.exports = {
  generateResponse,
  profileUser,
  analyzeAvatar,
  generateReply,
  buildContents,
  cleanReply,
  trimToSentence,
  pickMaxTokens,
  modelChain
};
