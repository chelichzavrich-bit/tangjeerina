// lib/crosschat.js
// Распознавание пользователей между чатами. Танг помнит, кто есть кто, даже если они в разных группах.

const memory = require('./memory');

// ───────────── ХРАНЕНИЕ ПОЛЬЗОВАТЕЛЕЙ ─────────────
// tj4:users:<userId> - глобальные данные пользователя: {name, username, chats: [chatId1, chatId2], lastSeen, notes}

async function getUserGlobal(userId) {
  try {
    const [data] = await memory.exec([['GET', `tj4:users:${userId}`]]);
    if (!data) return null;
    return JSON.parse(data);
  } catch (e) {
    console.error('getUserGlobal:', e.message);
    return null;
  }
}

async function updateUserGlobal(userId, userData) {
  try {
    const existing = await getUserGlobal(userId) || {};
    const merged = {
      ...existing,
      ...userData,
      lastSeen: Date.now()
    };
    await memory.exec([
      ['SET', `tj4:users:${userId}`, JSON.stringify(merged), 'EX', 86400 * 30] // 30 дней
    ]);
    return merged;
  } catch (e) {
    console.error('updateUserGlobal:', e.message);
    return null;
  }
}

async function addUserToChat(userId, chatId, userData) {
  try {
    const existing = await getUserGlobal(userId) || {};
    const chats = existing.chats || [];
    if (!chats.includes(chatId)) chats.push(chatId);
    const merged = {
      ...existing,
      ...userData,
      chats,
      lastSeen: Date.now()
    };
    await memory.exec([
      ['SET', `tj4:users:${userId}`, JSON.stringify(merged), 'EX', 86400 * 30]
    ]);
    return merged;
  } catch (e) {
    console.error('addUserToChat:', e.message);
    return null;
  }
}

// ───────────── ЗАМЕТКИ О ПОЛЬЗОВАТЕЛЕ ─────────────
async function addNote(userId, note) {
  try {
    const existing = await getUserGlobal(userId) || {};
    const notes = existing.notes || [];
    notes.push({ text: note, ts: Date.now() });
    const merged = { ...existing, notes };
    await memory.exec([
      ['SET', `tj4:users:${userId}`, JSON.stringify(merged), 'EX', 86400 * 30]
    ]);
    return notes;
  } catch (e) {
    console.error('addNote:', e.message);
    return null;
  }
}

// ───────────── ПОИСК ПОЛЬЗОВАТЕЛЯ ПО НИКУ ─────────────
async function findUserByUsername(username) {
  // Это требует сканирования всех пользователей, что неэффективно в Redis
  // Вместо этого будем искать по известным пользователям в текущем чате
  return null;
}

// ───────────── КОНТЕКСТ ПОЛЬЗОВАТЕЛЯ ─────────────
function buildUserContext(userData, currentChatId) {
  if (!userData) return '';
  const otherChats = (userData.chats || []).filter(c => c !== currentChatId);
  const notes = (userData.notes || []).slice(-5).map(n => n.text).join('; ');
  
  let context = `[ГЛОБАЛЬНАЯ ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ: `;
  if (userData.name) context += `имя: ${userData.name}, `;
  if (userData.username) context += `@${userData.username}, `;
  if (otherChats.length > 0) context += `встречается в ${otherChats.length} других чатах, `;
  if (notes) context += `заметки: ${notes}`;
  context += `]`;
  
  return context;
}

module.exports = {
  getUserGlobal,
  updateUserGlobal,
  addUserToChat,
  addNote,
  findUserByUsername,
  buildUserContext
};
