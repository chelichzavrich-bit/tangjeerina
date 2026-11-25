// lib/admin.js
// Админские функции Telegram для Танг. Все действия выполняются в образе персонажа.

const { telegram } = require('./telegram');
const memory = require('./memory');

// ───────────── ПРОВЕРКА ПРАВ ─────────────
async function checkAdminRights(chatId, botUsername) {
  try {
    const r = await telegram('getChatMember', {
      chat_id: chatId,
      user_id: botUsername
    });
    const status = r.result && r.result.status;
    return status === 'creator' || status === 'administrator';
  } catch (e) {
    console.error('checkAdminRights:', e.message);
    return false;
  }
}

async function getBotId(botUsername) {
  try {
    const r = await telegram('getMe', {});
    return r.result && r.result.id;
  } catch (e) {
    console.error('getBotId:', e.message);
    return null;
  }
}

// ───────────── БАН/КИК ─────────────
async function banUser(chatId, userId, reason, duration) {
  try {
    const payload = {
      chat_id: chatId,
      user_id: userId
    };
    if (duration) payload.until_date = Math.floor(Date.now() / 1000) + duration;
    await telegram('banChatMember', payload);
    return true;
  } catch (e) {
    console.error('banUser:', e.message);
    return false;
  }
}

async function unbanUser(chatId, userId) {
  try {
    await telegram('unbanChatMember', {
      chat_id: chatId,
      user_id: userId
    });
    return true;
  } catch (e) {
    console.error('unbanUser:', e.message);
    return false;
  }
}

// ───────────── РЕДАКТИРОВАНИЕ СООБЩЕНИЙ ─────────────
async function editMessage(chatId, messageId, newText) {
  try {
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: newText
    });
    return true;
  } catch (e) {
    console.error('editMessage:', e.message);
    return false;
  }
}

// ───────────── ИЗМЕНЕНИЕ ЧАТА ─────────────
async function setChatTitle(chatId, title) {
  try {
    await telegram('setChatTitle', {
      chat_id: chatId,
      title: title
    });
    return true;
  } catch (e) {
    console.error('setChatTitle:', e.message);
    return false;
  }
}

async function setChatDescription(chatId, description) {
  try {
    await telegram('setChatDescription', {
      chat_id: chatId,
      description: description
    });
    return true;
  } catch (e) {
    console.error('setChatDescription:', e.message);
    return false;
  }
}

// ───────────── ПУБЛИКАЦИЯ В КАНАЛЕ ─────────────
async function postToChannel(channelId, text, replyToMessageId) {
  try {
    const payload = {
      chat_id: channelId,
      text: text
    };
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    const r = await telegram('sendMessage', payload);
    return r.result && r.result.message_id;
  } catch (e) {
    console.error('postToChannel:', e.message);
    return null;
  }
}

// ───────────── ЗАКРЕПЛЕНИЕ СООБЩЕНИЯ ─────────────
async function pinMessage(chatId, messageId) {
  try {
    await telegram('pinChatMessage', {
      chat_id: chatId,
      message_id: messageId
    });
    return true;
  } catch (e) {
    console.error('pinMessage:', e.message);
    return false;
  }
}

// ───────────── УДАЛЕНИЕ СООБЩЕНИЯ ─────────────
async function deleteMessage(chatId, messageId) {
  try {
    await telegram('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
    return true;
  } catch (e) {
    console.error('deleteMessage:', e.message);
    return false;
  }
}

// ───────────── ОГРАНИЧЕНИЕ ПОЛЬЗОВАТЕЛЯ (read-only) ─────────────
async function restrictUser(chatId, userId, duration) {
  try {
    const payload = {
      chat_id: chatId,
      user_id: userId,
      permissions: {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }
    };
    if (duration) payload.until_date = Math.floor(Date.now() / 1000) + duration;
    await telegram('restrictChatMember', payload);
    return true;
  } catch (e) {
    console.error('restrictUser:', e.message);
    return false;
  }
}

module.exports = {
  checkAdminRights,
  getBotId,
  banUser,
  unbanUser,
  editMessage,
  setChatTitle,
  setChatDescription,
  postToChannel,
  pinMessage,
  deleteMessage,
  restrictUser
};
