// lib/admin.js
// Танг как участница с правами: постит в канал по настроению, переименовывает чат, закрепляет,
// мутит по просьбе. Не по графику - по случайному таймеру и поводам в разговоре.
// ПРЕДОХРАНИТЕЛИ: не трогает админов и создателя, не трогает себя, лимит действий в сутки,
// молчит в тяжёлые календарные дни и при чужой беде, название чата умеет вернуть обратно.
const tg = require('./telegram');

let memory = null;
try { memory = require('./memory'); } catch (_) { memory = null; }
let cal = null;
try { cal = require('./calendar'); } catch (_) { cal = null; }
let ai = null;
try { ai = require('./ai'); } catch (_) { ai = null; }

const num = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
};
const flag = (name, def) => {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim().toLowerCase();
  if (!raw) return def;
  return !['0', 'off', 'false', 'no'].includes(raw);
};
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const CFG = {
  enabled: flag('ADMIN_PLAY', true),
  perDay: Math.max(1, Math.floor(num('ADMIN_ACTIONS_PER_DAY', 3))),
  minHours: Math.max(1, num('ADMIN_MIN_HOURS', 8)),
  maxHours: Math.max(2, num('ADMIN_MAX_HOURS', 36)),
  renameHours: Math.max(1, num('ADMIN_RENAME_HOURS', 6)),
  muteMinutes: Math.max(1, Math.floor(num('ADMIN_MUTE_MINUTES', 10))),
  allowRename: flag('ADMIN_RENAME', true),
  allowMute: flag('ADMIN_MUTE', true),
  allowDelete: flag('ADMIN_DELETE', true),
  allowPin: flag('ADMIN_PIN', true),
  allowChannel: flag('ADMIN_CHANNEL', true)
};

const HOUR = 3600000;
const DAY = 86400000;
const dayKey = (now) => Math.floor(now / DAY);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const K = {
  next: (chat) => `tj4:admnext:${chat}`,
  day: (chat, d) => `tj4:admd:${chat}:${d}`,
  title: (chat) => `tj4:admtitle:${chat}`,
  channels: 'tj4:channels'
};

// Поводы в разговоре. Это не команды, а то, что она «услышала».
const RE_CHANNEL = /канал|пост\b|запост|опублик|подписчик|лента/i;
const RE_BORED = /скучно|тихо|мёртв|мертв|никто не пиш|все спят|тускло/i;
const RE_TITLE = /названи[ея]|переименова|назвать чат|имя чата/i;
const RE_PIN = /закреп|пин\b|запинь/i;
const RE_PUNISH = /(заткни|замут|мут\b|бан\b|забан|выгони|убери его|удали это|снеси)/i;

const TITLES = [
  'ВАХТЁРСКАЯ ТАНГ ДЖИ РИНЫ (вход по кошельку)',
  'ФИЛИАЛ МОЙ ОФФШОР, ОТДЕЛ ЖАЛОБ',
  'КЛУБ АНОНИМНЫХ ЛОХОВ, Я ПРЕДСЕДАТЕЛЬ',
  'ОБЩЕЖИТИЕ ДЛЯ ТЕХ, КТО МНЕ ДОЛЖЕН',
  'СКЛАД НАГРАБЛЕННОГО, НЕ ТРОГАТЬ',
  'ПРИЁМНАЯ ЖРАКА КЭРРОТЛИНА (он не знать)',
  'ЗДЕСЬ БЫЛА ТАНГ И ВСЁ ЗАБРАЛА',
  'МАНДАРИНОВАЯ БИРЖА, ТОРГИ ИДУТ',
  'ОТДЕЛ КАДРОВ: ТРЕБУЮТСЯ ЛОХИ',
  'ТИШИНА. Я СЧИТАТЬ ЧУЖИЕ ДЕНЬГИ'
];

const DESCRIPTIONS = [
  'Правила простые: кошелёк на стол, вопросы потом. Администрация не несёт ответственность, администрация - это я ☺️',
  'Жалобы принимать в письменный вид и складывать в мусорка. Спасибо за понимание, хехе 🤭',
  'Кто читать это описание - тот уже подписать договор. Мелкий шрифт я не показать нарочно 🫣',
  'Тут сидеть великая и те, кто ей платить. Третьих не дано ☺️',
  'Всё, что вы тут написать, становиться мой интеллектуальный собственность. Я так решить 🤗'
];

function info() {
  return { ...CFG, module: 'admin' };
}

// ───────────── права ─────────────
async function rights(chatId) {
  if (!memory) return null;
  try {
    const me = await tg.getMe();
    const botId = me && me.id;
    if (!botId) return null;
    const cached = await memory.getChatAdminStatus(chatId, botId, 600);
    if (cached) return cached;
    const r = await tg.telegram('getChatMember', { chat_id: chatId, user_id: botId }, { timeout: 8000 });
    const m = (r && r.result) || {};
    const rec = {
      status: m.status || 'member',
      isCreator: m.status === 'creator',
      canDelete: !!m.can_delete_messages,
      canRestrict: !!m.can_restrict_members,
      canChangeInfo: !!m.can_change_info,
      canPin: !!m.can_pin_messages,
      canPost: !!m.can_post_messages,
      canEdit: !!m.can_edit_messages,
      canInvite: !!m.can_invite_users
    };
    if (rec.status === 'creator') {
      rec.canDelete = rec.canRestrict = rec.canChangeInfo = rec.canPin = rec.canPost = rec.canInvite = true;
    }
    await memory.setChatAdminStatus(chatId, botId, rec);
    return rec;
  } catch (e) {
    console.error('admin.rights:', e.message);
    return null;
  }
}

async function invalidate(chatId) {
  if (!memory) return;
  try {
    const me = await tg.getMe();
    if (me && me.id) await memory.exec([['HDEL', `tj4:admin:${chatId}`, String(me.id)]]);
  } catch (_) {}
}

const isAdmin = (m) => m && (m.status === 'creator' || m.status === 'administrator');

async function memberStatus(chatId, userId) {
  try {
    const r = await tg.telegram('getChatMember', { chat_id: chatId, user_id: userId }, { timeout: 8000 });
    return (r && r.result) || null;
  } catch (_) { return null; }
}

// ───────────── каналы, где она есть ─────────────
async function noteChannel(channelId, title) {
  if (!memory || !channelId) return;
  try {
    await memory.exec([['HSET', K.channels, String(channelId), JSON.stringify({ t: title || '', at: Date.now() })]]);
  } catch (_) {}
}

async function knownChannels() {
  const out = [];
  for (const id of csv(process.env.ADMIN_CHANNEL_ID)) out.push({ id, title: '' });
  if (!memory) return out;
  try {
    const [flat] = await memory.exec([['HGETALL', K.channels]]);
    for (let i = 0; i < (flat || []).length; i += 2) {
      const id = String(flat[i]);
      if (out.some((x) => String(x.id) === id)) continue;
      let title = '';
      try { title = (JSON.parse(flat[i + 1]) || {}).t || ''; } catch (_) {}
      out.push({ id, title });
    }
  } catch (_) {}
  return out;
}

// ───────────── лимиты и таймер ─────────────
async function budgetLeft(chatId) {
  if (!memory) return 0;
  try {
    const [v] = await memory.exec([['GET', K.day(chatId, dayKey(Date.now()))]]);
    return Math.max(0, CFG.perDay - (Number(v) || 0));
  } catch (_) { return 0; }
}

async function spend(chatId) {
  if (!memory) return;
  try {
    await memory.exec([
      ['INCR', K.day(chatId, dayKey(Date.now()))],
      ['EXPIRE', K.day(chatId, dayKey(Date.now())), 172800]
    ]);
  } catch (_) {}
}

async function scheduleNext(chatId) {
  if (!memory) return;
  const at = Math.round(Date.now() + rand(CFG.minHours, CFG.maxHours) * HOUR);
  try { await memory.exec([['SET', K.next(chatId), at, 'EX', 7 * 86400]]); } catch (_) {}
}

async function logAction(chatId, note) {
  if (!memory) return;
  try { await memory.logBot(chatId, [{ r: 'm', t: '[АДМИНКА: ' + note + ']' }]); } catch (_) {}
}

// ───────────── действия ─────────────
async function postToChannel(chatId, opts) {
  if (!CFG.allowChannel) return false;
  const list = await knownChannels();
  if (!list.length) return false;
  const target = pick(list);
  const r = await rights(target.id);
  if (!r || !isAdmin(r) || !r.canPost) return false;

  let text = '';
  const mood = opts && opts.drunk ? 'пьяная, тёплая и болтливая' : 'в своём обычном наглом настроении';
  if (ai && opts && opts.deadline && opts.deadline - Date.now() > 9000) {
    try {
      const history = await memory.getHistory(chatId);
      const block = [
        '[Ты вдруг вспомнила, что у тебя есть свой канал, и захотела что-то туда запостить. Никто тебя не просил.',
        'Сейчас ты ' + mood + '. Повод: в чате мелькнула тема канала, или просто стало скучно.',
        'Напиши ОДИН короткий пост для канала: небылица о себе, объявление, требование, отчёт о краже, объявление о наборе лохов.',
        'Это пост, а не ответ кому-то: не обращайся к конкретному человеку, не задавай вопросов собеседнику.',
        'Не начинай с «Ооооооо» и не называй никого «наш великий». Не повторяй прошлые свои посты.',
        'Сильно ломанный русский с китайским акцентом обязателен. 1-3 предложения, один смайлик в конце из ☺️ 🤗 😋 🤭 🫣.]'
      ].join('\n');
      const out = await ai.generateReply(ai.buildContents(history, [{ text: block }]), { userLen: 120, deadline: opts.deadline });
      text = String((out && out.text) || '').trim();
      if (text && memory.isRepeat) {
        const chk = await memory.isRepeat(chatId, text);
        if (chk.repeat) text = '';
      }
    } catch (e) { console.error('admin post ai:', e.message); }
  }
  if (!text) {
    text = pick([
      'Объявление: я открывать приём жалобы на меня. Жалобы складывать сюда, я их читать не буду, но место хорошее ☺️',
      'Сегодняшний улов: три кошелёк, один телефон и чужой уверенность в себе. Последний самый ценный 🤭',
      'Кто не подписаться - тот уже подписаться, просто ещё не знать. Я оформить за вас 🫣',
      'Я тут подумать и решить, что вы все слишком спокойный. Это исправимо, я работать над этим 🤗',
      'Отчёт за день: ничего не делать и всё равно быть лучше вас. Стабильность - мой главный талант ☺️'
    ]);
  }

  try {
    const sent = await tg.telegram('sendMessage', { chat_id: target.id, text, disable_web_page_preview: true });
    const msgId = sent && sent.result && sent.result.message_id;
    await spend(chatId);
    await logAction(chatId, 'запостила в канал ' + (target.title || target.id) + ': ' + text.slice(0, 80));
    if (memory.rememberReply) { try { await memory.rememberReply(chatId, text); } catch (_) {} }
    // Иногда сама себе закрепляет пост - из чистого тщеславия.
    if (msgId && r.canPin && Math.random() < 0.3) {
      try { await tg.telegram('pinChatMessage', { chat_id: target.id, message_id: msgId, disable_notification: true }); } catch (_) {}
    }
    return true;
  } catch (e) {
    console.error('admin.postToChannel:', e.message);
    return false;
  }
}

async function renameChat(chatId, opts) {
  if (!CFG.allowRename) return false;
  const r = await rights(chatId);
  if (!r || !isAdmin(r) || !r.canChangeInfo) return false;
  try {
    const info0 = await tg.telegram('getChat', { chat_id: chatId }, { timeout: 8000 });
    const current = (info0 && info0.result && info0.result.title) || '';
    if (!current) return false;
    const saved = await memory.exec([['GET', K.title(chatId)]]);
    const original = (saved && saved[0]) || current;
    const next = pick(TITLES.filter((t) => t !== current));
    if (!next) return false;
    await tg.telegram('setChatTitle', { chat_id: chatId, title: next.slice(0, 128) });
    const until = Date.now() + (opts && opts.drunk ? CFG.renameHours * 2 : CFG.renameHours) * HOUR;
    await memory.exec([['SET', K.title(chatId), JSON.stringify({ original, until }), 'EX', 7 * 86400]]);
    await spend(chatId);
    await logAction(chatId, 'переименовала чат в «' + next + '»');
    if (Math.random() < 0.6) {
      await tg.sendMessage(chatId, pick([
        'Я тут подумать и переименовать. Старый название был слишком скучный для мой величие ☺️',
        'Теперь это называться правильно. Кто не нравиться - тот мочь идти в свой чат с свой названием 🤭',
        'Оооо, так лучше. Я всегда знать, что этот место на самом деле мой 🫣'
      ]));
    }
    return true;
  } catch (e) {
    console.error('admin.renameChat:', e.message);
    return false;
  }
}

async function restoreTitle(chatId) {
  if (!memory) return false;
  try {
    const [raw] = await memory.exec([['GET', K.title(chatId)]]);
    if (!raw) return false;
    const rec = JSON.parse(raw);
    if (!rec || !rec.original) return false;
    if (Date.now() < (rec.until || 0)) return false;
    const r = await rights(chatId);
    if (!r || !isAdmin(r) || !r.canChangeInfo) { await memory.exec([['DEL', K.title(chatId)]]); return false; }
    await tg.telegram('setChatTitle', { chat_id: chatId, title: String(rec.original).slice(0, 128) });
    await memory.exec([['DEL', K.title(chatId)]]);
    await logAction(chatId, 'вернула название как ни в чём не бывало');
    if (Math.random() < 0.4) {
      await tg.sendMessage(chatId, 'Ладно, вернуть ваш скучный название. Я великодушная, но вы это не заслужить ☺️');
    }
    return true;
  } catch (e) {
    console.error('admin.restoreTitle:', e.message);
    return false;
  }
}

async function describeChat(chatId) {
  const r = await rights(chatId);
  if (!r || !isAdmin(r) || !r.canChangeInfo) return false;
  try {
    await tg.telegram('setChatDescription', { chat_id: chatId, description: pick(DESCRIPTIONS).slice(0, 255) });
    await spend(chatId);
    await logAction(chatId, 'переписала описание чата по-своему');
    return true;
  } catch (e) {
    console.error('admin.describeChat:', e.message);
    return false;
  }
}

async function pinSomething(chatId, msg) {
  if (!CFG.allowPin) return false;
  const r = await rights(chatId);
  if (!r || !isAdmin(r) || !r.canPin) return false;
  const target = (msg.reply_to_message && msg.reply_to_message.message_id) || msg.message_id;
  try {
    await tg.telegram('pinChatMessage', { chat_id: chatId, message_id: target, disable_notification: true });
    await spend(chatId);
    await logAction(chatId, 'закрепила сообщение, чтобы все видели этот позор');
    await tg.sendMessage(chatId, pick([
      'Закрепить. Пусть все видеть, цто ты тут написать, я не дам тебе это забыть 🤭',
      'Это теперь висеть сверху. Я считать, это надо помнить всем ☺️',
      'Оооо, такой позор нельзя прятать в история. Я повесить его на видный место 🫣'
    ]));
    return true;
  } catch (e) {
    console.error('admin.pin:', e.message);
    return false;
  }
}

async function muteTarget(chatId, msg) {
  if (!CFG.allowMute) return false;
  const r = await rights(chatId);
  if (!r || !isAdmin(r) || !r.canRestrict) return false;
  const victim = msg.reply_to_message && msg.reply_to_message.from;
  if (!victim || !victim.id || victim.is_bot) return false;
  const st = await memberStatus(chatId, victim.id);
  if (isAdmin(st)) return false; // админов и создателя не трогаем никогда
  try {
    const until = Math.floor(Date.now() / 1000) + CFG.muteMinutes * 60;
    await tg.telegram('restrictChatMember', {
      chat_id: chatId,
      user_id: victim.id,
      until_date: until,
      permissions: { can_send_messages: false }
    });
    await spend(chatId);
    const who = victim.username ? '@' + victim.username : (victim.first_name || 'этот');
    await logAction(chatId, 'заткнула ' + who + ' на ' + CFG.muteMinutes + ' минут');
    await tg.sendMessage(chatId, who + ', идти подумать ' + CFG.muteMinutes + ' минуты. Я не злая, я просто устать слушать ☺️');
    return true;
  } catch (e) {
    console.error('admin.mute:', e.message);
    return false;
  }
}

async function deleteTarget(chatId, msg) {
  if (!CFG.allowDelete) return false;
  const r = await rights(chatId);
  if (!r || !isAdmin(r) || !r.canDelete) return false;
  const target = msg.reply_to_message;
  if (!target || !target.message_id) return false;
  const author = target.from;
  if (author && author.id) {
    const st = await memberStatus(chatId, author.id);
    if (isAdmin(st)) return false;
  }
  try {
    await tg.telegram('deleteMessage', { chat_id: chatId, message_id: target.message_id });
    await spend(chatId);
    await logAction(chatId, 'удалила чужое сообщение и не призналась');
    await tg.sendMessage(chatId, pick([
      'Цто там было? Я ничего не видеть. И ты больше не видеть, хехе 🤭',
      'Удалить. Не потому что мне не нравиться, а потому что я мочь ☺️',
      'Это сообщение теперь не существовать. Как и твой аргумент 🫣'
    ]));
    return true;
  } catch (e) {
    console.error('admin.delete:', e.message);
    return false;
  }
}

// ───────────── главный планировщик ─────────────
// Вызывается вебхуком на каждом сообщении. Дёшево: один-два GET, пока не подошло время.
async function maybeAct(msg, opts = {}) {
  if (!CFG.enabled || !memory || !msg || !msg.chat) return false;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const isChannel = msg.chat.type === 'channel';

  // Канал, где она есть: запоминаем, чтобы потом постить туда сама.
  if (isChannel) { await noteChannel(chatId, msg.chat.title); return false; }
  if (!isGroup) return false;
  if (cal && typeof cal.gamesAllowed === 'function' && !cal.gamesAllowed()) return false;

  const text = String(opts.rawText || msg.text || msg.caption || '');
  const replied = !!msg.reply_to_message;

  // Сначала возвращаем название, если срок вышел. Это бесплатно и не тратит лимит.
  await restoreTitle(chatId);

  // Явные просьбы через реплай: наказывать и удалять - только по прямому поводу.
  if (replied && RE_PUNISH.test(text)) {
    if (await budgetLeft(chatId)) {
      const done = /удали|снеси|убери это/i.test(text)
        ? await deleteTarget(chatId, msg)
        : await muteTarget(chatId, msg);
      if (done) return true;
    }
  }
  if (replied && RE_PIN.test(text) && (await budgetLeft(chatId))) {
    if (await pinSomething(chatId, msg)) return true;
  }

  try {
    const [nextRaw] = await memory.exec([['GET', K.next(chatId)]]);
    const now = Date.now();
    if (!nextRaw) { await scheduleNext(chatId); return false; }

    const due = now >= Number(nextRaw);
    // Повод в разговоре может разбудить её раньше таймера, но не чаще лимита.
    const hookChannel = CFG.allowChannel && RE_CHANNEL.test(text) && Math.random() < 0.5;
    const hookBored = CFG.allowRename && RE_BORED.test(text) && Math.random() < 0.35;
    const hookTitle = CFG.allowRename && RE_TITLE.test(text) && Math.random() < 0.35;
    if (!due && !hookChannel && !hookBored && !hookTitle) return false;

    if (!(await budgetLeft(chatId))) { await scheduleNext(chatId); return false; }
    if (!(await memory.acquireLock('adm:' + chatId, 180))) return false;

    const r = await rights(chatId);
    const canHere = r && isAdmin(r);
    const drunk = !!opts.drunk;

    // Пьяная чаще лезет в канал и болтает, трезвая чаще наводит порядки.
    const options = [];
    if (hookChannel) options.push('channel', 'channel');
    if (drunk) options.push('channel', 'channel', 'describe');
    if (hookBored || hookTitle) options.push('rename');
    if (canHere && r.canChangeInfo) options.push('rename', 'describe');
    if (canHere && r.canPin) options.push('pin');
    options.push('channel');
    if (!options.length) { await scheduleNext(chatId); return false; }

    const choice = pick(options);
    let done = false;
    if (choice === 'channel') done = await postToChannel(chatId, opts);
    else if (choice === 'rename') done = await renameChat(chatId, opts);
    else if (choice === 'describe') done = await describeChat(chatId);
    else if (choice === 'pin') done = await pinSomething(chatId, msg);

    if (!done && choice !== 'channel') done = await postToChannel(chatId, opts);
    await scheduleNext(chatId);
    return done;
  } catch (e) {
    console.error('admin.maybeAct:', e.message);
    return false;
  }
}

// Кнопки, если когда-нибудь понадобятся (например «вернуть название»).
async function handleCallback(cq) {
  const data = String((cq && cq.data) || '');
  if (!data.startsWith('adm:')) return false;
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  await tg.answerCallback(cq.id);
  if (!chatId) return true;
  if (data === 'adm:restore') {
    try { await memory.exec([['SET', K.title(chatId), JSON.stringify({ original: '', until: 0 }), 'EX', 60]]); } catch (_) {}
    const [raw] = await memory.exec([['GET', K.title(chatId)]]);
    if (raw) {
      try {
        const rec = JSON.parse(raw);
        if (rec && rec.original) await tg.telegram('setChatTitle', { chat_id: chatId, title: rec.original });
      } catch (_) {}
    }
    await tg.sendMessage(chatId, 'Ладно, вернуть. Но я это сделать из жалость, а не потому что ты попросить ☺️');
  }
  return true;
}

module.exports = {
  maybeAct, handleCallback, invalidate, info, rights,
  postToChannel, renameChat, restoreTitle, describeChat,
  pinSomething, muteTarget, deleteTarget, noteChannel, knownChannels, CFG
};
