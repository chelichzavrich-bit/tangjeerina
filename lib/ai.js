// ============================================================================
// AI.JS v3.1 - ПРОФИЛИНГ ПОЛЬЗОВАТЕЛЯ + АНАЛИЗ АВАТАРОК
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SYSTEM_INSTRUCTION, PULSE_PROMPT, COLD_TROLL_PRIORITY } = require("./persona");
const { readMemory, writeMemory } = require("./memory");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============================================================================
// ПРОФИЛИНГ ПОЛЬЗОВАТЕЛЯ (USER PROFILING)
// ============================================================================

const USER_PROFILE_SCHEMA = {
  userId: String,
  firstInteraction: Date,
  messageCount: Number,
  vulnerabilityTriggers: Array, // ["Ман Го", "семья", "ЛНР", ...]
  jokeStyle: String, // "dark", "absurd", "sweet", "toxic", "mixed"
  emotionalResponse: String, // "cold", "warm", "defensive", "open"
  likelyGender: String, // "M", "F", "N", "unclear"
  estimatedAge: Number,
  topicPreferences: Array, // ["мошенничество", "Жак", "тролль", ...]
  trollResistance: Number, // 0-100 (легко ли засадить в ловушку)
  attachmentLevel: Number, // 0-100 (насколько привязан к Танг)
  lastAvatarAnalysis: Object, // { url, colors, mood, description }
};

/**
 * Анализирует сообщение пользователя и обновляет профиль
 */
async function profileUser(userId, message, avatarUrl = null) {
  let profile = await readMemory(`profile:${userId}`);

  if (!profile) {
    profile = {
      userId,
      firstInteraction: new Date(),
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
Проанализируй это сообщение пользователя от первого лица Танг Джи Рины. Дай короткие ответы в JSON:
Сообщение: "${message}"

Ответь в JSON (БЕЗ markdown):
{
  "jokeStyle": "dark|absurd|sweet|toxic|mixed",
  "emotionalTone": "cold|warm|defensive|open|neutral",
  "likelyGender": "M|F|N|unclear",
  "estimatedAge": number или null,
  "vulnerabilityDetected": ["trigger1", "trigger2"] или [],
  "topicKeywords": ["keyword1", "keyword2"],
  "trollResistance": number 0-100
}
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(analysisPrompt);
    const analysisText = result.response.text();
    const analysis = JSON.parse(analysisText);

    // Обновляем профиль
    profile.jokeStyle = analysis.jokeStyle;
    profile.emotionalResponse = analysis.emotionalTone;
    profile.likelyGender = analysis.likelyGender;
    if (analysis.estimatedAge) profile.estimatedAge = analysis.estimatedAge;
    profile.trollResistance = Math.max(profile.trollResistance, analysis.trollResistance);
    profile.topicPreferences = [...new Set([...profile.topicPreferences, ...analysis.topicKeywords])];
    profile.vulnerabilityTriggers = [...new Set([...profile.vulnerabilityTriggers, ...analysis.vulnerabilityDetected])];

    // Рост привязанности, если упомянул Танг или Жака
    if (message.toLowerCase().includes("танг") || message.toLowerCase().includes("жак")) {
      profile.attachmentLevel = Math.min(100, profile.attachmentLevel + 5);
    }
  } catch (e) {
    console.error("Profile analysis error:", e.message);
  }

  // === АНАЛИЗ АВАТАРКИ (если есть) ===
  if (avatarUrl) {
    profile.lastAvatarAnalysis = await analyzeAvatar(avatarUrl);
  }

  // Сохраняем профиль
  await writeMemory(`profile:${userId}`, profile);
  return profile;
}

/**
 * Анализирует аватар пользователя (описание, цвета, мудрость)
 */
async function analyzeAvatar(avatarUrl) {
  const avatarPrompt = `
Ты - Танг Джи Рина. Твоя работа - анализировать аватарки пользователей и давать едкие комментарии.
Аватарка по URL: ${avatarUrl}

Ответь в JSON (БЕЖ markdown):
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
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: await fetch(avatarUrl).then(r => r.arrayBuffer()).then(b => Buffer.from(b).toString("base64")),
        },
      },
      avatarPrompt,
    ]);

    const analysisText = result.response.text();
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
  // Профилируем юзера
  const profile = await profileUser(userId, userMessage, avatarUrl);

  // Создаём PULSE (внутренний пульс персонажа на данный момент)
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

    // Логируем для отладки
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

// ============================================================================
// ЭКСПОРТ
// ============================================================================

module.exports = {
  generateResponse,
  profileUser,
  analyzeAvatar,
  USER_PROFILE_SCHEMA,
};
