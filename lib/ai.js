// ============================================================================
// AI.JS v3.1 - ПРОФИЛИНГ ПОЛЬЗОВАТЕЛЯ + АНАЛИЗ АВАТАРОК
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SYSTEM_INSTRUCTION, PULSE_PROMPT, COLD_TROLL_PRIORITY } = require("./persona");
const { readMemory, writeMemory } = require("./memory");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Анализирует сообщение пользователя и обновляет профиль
 */
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

  // === АНАЛИЗ СООБЩЕНИЯ ===
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
    
    // Очистка от markdown-обёртки, если модель её добавила
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

  // === АНАЛИЗ АВАТАРКИ (если есть URL) ===
  if (avatarUrl) {
    try {
      profile.lastAvatarAnalysis = await analyzeAvatar(avatarUrl);
    } catch (e) {
      console.error("Avatar analysis skip:", e.message);
    }
  }

  // Сохраняем профиль (TTL 30 дней)
  await writeMemory(`profile:${userId}`, profile, 60 * 60 * 24 * 30);
  return profile;
}

/**
 * Анализирует аватар пользователя
 */
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

/**
 * Генерирует ответ от Танг с учётом профиля и пульса
 */
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
};
