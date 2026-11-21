// lib/traps.js
// Случайные фишинговые ловушки-пародии. Живут 5 минут, потом протухают.
// НИКАКИХ внешних ссылок и НИКАКОГО сбора данных: всё внутри Telegram, «поле юзернейма» подставляется
// из открытого профиля самого нажавшего. Насмешки детерминированные - 0 запросов к квоте.
const { telegram, sendMessage, answerCallback } = require('./telegram');

let memory = null;
try { memory = require('./memory'); } catch (_) { memory = null; }
let credit = null;
try { credit = require('./credit'); } catch (_) { credit = null; }
let cal = null;
try { cal = require('./calendar'); } catch (_) { cal = null; }

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

const CFG = {
  enabled: flag('TRAPS', true),
  windowSec: Math.max(60, Math.floor(num('TRAP_WINDOW_SECONDS', 300))),
  minHours: Math.max(1, num('TRAP_MIN_HOURS', 6)),
  maxHours: Math.max(2, num('TRAP_MAX_HOURS', 30)),
  perDay: Math.max(1, Math.floor(num('TRAP_PER_DAY', 2))),
  reward: Math.max(1, Math.floor(num('TRAP_REWARD', 3))),
  maxVictims: Math.max(1, Math.floor(num('TRAP_MAX_VICTIMS', 3)))
};

const HOUR = 3600000;
const DAY = 86400000;
const dayKey = (now) => Math.floor(now / DAY);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const K = {
  active: (chat) => `tj4:trap:${chat}`,
  next: (chat) => `tj4:trapnext:${chat}`,
  day: (chat, d) => `tj4:trapd:${chat}:${d}`
};

// Все события вымышленные, бренды и домены не используются.
const TEMPLATES = [
  {
    title: 'ВСЕМИРНЫЙ СЪЕЗД ЛОХОВ',
    bait: 'ВНИМАНИЕ. Открыта регистрация на ВСЕМИРНЫЙ СЪЕЗД ЛОХОВ 2015 в XM-CITY. Участие бесплатное, каждому мандарин и грамота. Мест мало, я лично считатьdelegate.',
    form: 'РЕГИСТРАЦИЯ НА СЪЕЗД ЛОХОВ. Заполнить одно поле, остальное я знать сама.',
    close: 'РЕГИСТРАЦИЯ ЗАКРЫТА. Съезд перенесён в мой карман.'
  },
  {
    title: 'РОЗЫГРЫШ АЙФОНА ОТ ПИНГВИНЬЕЙ ИМПЕРИИ',
    bait: 'Оооооой, Пингвинья Империя раздавать телефончик каждому сотому. Я быть официальный спонсор, у меня есть печать, я её сама нарисовала. То есть получила.',
    form: 'ПОЛУЧИТЬ ПРИЗ. Ввести юзернейм, приз придёт сам, я лично донести.',
    close: 'РОЗЫГРЫШ ОКОНЧЕН. Все призы у меня, спасибо за участие.'
  },
  {
    title: 'БАНК ГОЛДЕН МОРКОВ',
    bait: 'Банк «Голден Морков» открывать вклад под триста процент годовых. Лицензия есть, три штуки, я их у одного знакомого взять. Он не против, он не знать.',
    form: 'ОТКРЫТЬ ВКЛАД. Поле одно: юзернейм. Паспорт не надо, я и так всё видеть.',
    close: 'БАНК ЛОПНУЛ. Вклады застрахованы мной, я платить мандаринами.'
  },
  {
    title: 'КАСТИНГ НА ЛУЧШУЮ ПОДРУЖКУ ЖАКА',
    bait: 'Официальный кастинг на роль ЛУЧШАЯ ОДНА И ПОДРУЖКА ЖАКА КЭРРОТЛИНА. Требования: не чукча, не пингвин, уметь молчать. Роль занята, но я рассмотреть заявки, hēhē.',
    form: 'ЗАЯВКА НА РОЛЬ. Ввести юзернейм, я передать его в комиссию. Комиссия - это я.',
    close: 'КАСТИНГ ЗАКРЫТ. Роль осталась у меня, вы все不合格.'
  },
  {
    title: 'ФЕСТИВАЛЬ МАНДАРИНОВ XM-CITY',
    bait: 'Фестиваль мандаринов в XM-CITY! Бесплатный вход, бесплатная кожура, бесплатный вывоз кошельков... то есть сувениров. Регистрация обязательная, охрана злая.',
    form: 'ВХОД НА ФЕСТИВАЛЬ. Юзернейм в поле, браслет придёт в личку.',
    close: 'ФЕСТИВАЛЬ ОКОНЧЕН. Мандарины кончились, я виновата, но не признаю.'
  },
  {
    title: 'КУРСЫ ВОДИТЕЛЕЙ: ТРИ ПРАВА ЗА ДЕНЬ',
    bait: 'Ускоренные курсы вождения: ТРИ водительских права за один день, как у одного моего знакомого палочника. Экзамен не нужен, я сама инспектор.',
    form: 'ЗАПИСЬ НА КУРСЫ. Ввести юзернейм, права выдать сразу.',
    close: 'КУРСЫ ЗАКРЫТЫ. Права я оставить себе, их теперь четыре.'
  },
  {
    title: 'БЕСПЛАТНАЯ ХИМЧИСТКА ХУДИ',
    bait: 'Акция: химчистка худи бесплатно, только сегодня, только для первых трёх. Я тестировать на своём, результат отличный, если не считать что оно село.',
    form: 'ЗАКАЗАТЬ ХИМЧИСТКУ. Юзернейм в поле, курьер (я) придёт ночью.',
    close: 'АКЦИЯ ЗАКОНЧЕНА. Худи постираны, чужие я забрать себе.'
  },
  {
    title: 'ПЕРЕПИСЬ ЖИТЕЛЕЙ XMS',
    bait: 'Официальная перепись населения XMS. Кто не заполнить - тот призрак без документов, как я. Заполнить одно поле, это займёт две секунды, я обещать.',
    form: 'ПЕРЕПИСЬ. Поле: юзернейм. Остальное я дописать сама, у меня хорошая фантазия.',
    close: 'ПЕРЕПИСЬ ЗАВЕРШЕНА. Всех переписали в мой блокнот.'
  },
  {
    title: 'ПРЯМОЙ ЭФИР: ЖАК ПРИЗНАЁТСЯ',
    bait: 'СРОЧНО. Прямой эфир: Жак Кэрротлин признаваться в чём-то важном. Я организовать трансляцию, я же его лучшая подружка. Вход по регистрации, не опаздывать.',
    form: 'ВХОД В ЭФИР. Ввести юзернейм. Что он скажет - я не знать, но я записать.',
    close: 'ЭФИР ОТМЕНЁН. Он ничего не сказать, как всегда. Я тоже ничего не сказать.'
  },
  {
    title: 'ЧЕМПИОНАТ МИРА ПО СПОРУ С ТАНГ',
    bait: 'Открыт чемпионат мира по спору со мной. Призовой фонд двадцатка, судья тоже я. Проигравший отдаёт кошелёк, выигравший... ещё не было такого.',
    form: 'ЗАЯВКА НА ЧЕМПИОНАТ. Юзернейм в поле, поражение придёт автоматически.',
    close: 'ЧЕМПИОНАТ ОКОНЧЕН. Я победить, не участвуя.'
  }
];

const MOCKS = [
  '{who}, ты только что ввести свой юзернейм на сайте «{title}». Который я сделать за две минуты на краденом телефоне. Поздравляю, ты официально мой клиент 🤭',
  '{who}, попался! «{title}» - это я, кнопка - это я, приз - это тоже я. Ты даже не спросить, где лицензия ☺️',
  'Оооооой, {who}, ты нажать «вы уверены» на «{title}». Уверенность - это единственное, что ты мне сегодня подарить 🤗',
  '{who}, я не воровать твой данные, ты сам их отдать. Разница огромная, особенно для суда, hēhē. «{title}» закрыт 😋',
  '{who}, registering на «{title}»... мой голова не выдерживать такой доверчивость. Я записать тебя в блокнот под буквой Л 🫣',
  'Смотрите все: {who} поверить в «{title}». Я даже не стараться, я просто написать красивое слово. Спасибо за ужин ☺️',
  '{who}, ты выбрать «не уверены», но нажать-то нажать. Данные ушли туда же, куда и у уверенных. «{title}» благодарит 🤭',
  '{who}, поздравляю, ты пройти мой тест на доверчивость. Результат: провален блестяще. «{title}» был учебный 🤗'
];

const pingOf = (u) => (u && u.username) ? '@' + u.username : ((u && u.first_name) || 'ты');
const nameOf = (u) => (u && (u.first_name || u.username)) || 'Аноним';

function info() {
  return { ...CFG };
}

async function getActive(chatId) {
  if (!memory) return null;
  try {
    const [raw] = await memory.exec([['GET', K.active(chatId)]]);
    if (!raw) return null;
    const a = JSON.parse(raw);
    return a && a.id ? a : null;
  } catch (_) { return null; }
}

async function saveActive(chatId, a, ttlSec) {
  try {
    await memory.exec([['SET', K.active(chatId), JSON.stringify(a), 'EX', ttlSec]]);
  } catch (e) { console.error('traps.saveActive:', e.message); }
}

async function clearActive(chatId) {
  try { await memory.exec([['DEL', K.active(chatId)]]); } catch (_) {}
}

async function scheduleNext(chatId, now) {
  const at = Math.round(now + rand(CFG.minHours, CFG.maxHours) * HOUR);
  try { await memory.exec([['SET', K.next(chatId), at, 'EX', 7 * 86400]]); } catch (_) {}
  return at;
}

async function closeTrap(chatId, a, expired, note) {
  const text = a.close + (expired ? '\n(время вышло, никто не успеть, вы скучные)' : '') + (note ? '\n' + note : '');
  try {
    await telegram('editMessageText', { chat_id: chatId, message_id: a.msgId, text });
  } catch (_) {
    try { await telegram('deleteMessage', { chat_id: chatId, message_id: a.msgId }); } catch (_) {}
  }
  await clearActive(chatId);
}

// Ленивая уборка: вызывается на каждом сообщении группы, стоит один GET.
async function sweep(chatId) {
  if (!CFG.enabled || !memory) return false;
  const a = await getActive(chatId);
  if (!a) return false;
  if (Date.now() <= a.expiresAt) return false;
  await closeTrap(chatId, a, true);
  return true;
}

// Планировщик: бросает ловушку, когда подошло случайное время.
async function maybeDrop(msg) {
  if (!CFG.enabled || !memory) return false;
  if (!msg || !msg.chat) return false;
  const chatId = msg.chat.id;
  if (!(msg.chat.type === 'group' || msg.chat.type === 'supergroup')) return false;
  if (cal && typeof cal.gamesAllowed === 'function' && !cal.gamesAllowed()) return false;

  try {
    const now = Date.now();
    const [nextRaw, activeRaw, cntRaw] = await memory.exec([
      ['GET', K.next(chatId)],
      ['GET', K.active(chatId)],
      ['GET', K.day(chatId, dayKey(now))]
    ]);
    if (!nextRaw) { await scheduleNext(chatId, now); return false; }
    if (now < Number(nextRaw)) return false;
    if (activeRaw) {
      try {
        const a = JSON.parse(activeRaw);
        if (a && a.expiresAt > now) return false;
      } catch (_) { /* битая запись - перезапишем */ }
    }
    if (Number(cntRaw) >= CFG.perDay) { await scheduleNext(chatId, now); return false; }
    if (!(await memory.acquireLock('trap:' + chatId, 120))) return false;

    const t = pick(TEMPLATES);
    const id = Math.random().toString(36).slice(2, 8);
    const text = t.bait + '\n\nРегистрация закрываться через ' + Math.round(CFG.windowSec / 60) + ' минут, я не ждать.';
    const sent = await telegram('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '🎫 ЗАРЕГИСТРИРОВАТЬСЯ', callback_data: 'trap:open:' + id }]] }
    });
    const msgId = sent && sent.result && sent.result.message_id;
    if (!msgId) return false;

    await saveActive(chatId, {
      id, msgId, title: t.title, form: t.form, close: t.close,
      expiresAt: now + CFG.windowSec * 1000, caught: [], opened: false
    }, CFG.windowSec + 900);
    await memory.exec([
      ['INCR', K.day(chatId, dayKey(now))],
      ['EXPIRE', K.day(chatId, dayKey(now)), 172800]
    ]);
    await scheduleNext(chatId, now);
    await memory.logBot(chatId, [{ r: 'm', t: '[вбросила ловушку «' + t.title + '»]' }]);
    return true;
  } catch (e) {
    console.error('traps.maybeDrop:', e.message);
    return false;
  }
}

async function sprung(chatId, a, user, choice) {
  const uid = String(user.id);
  if ((a.caught || []).includes(uid)) {
    await answerCallback('');
    return;
  }
  a.caught = [...(a.caught || []), uid];
  const left = Math.max(60, Math.round((a.expiresAt - Date.now()) / 1000));
  await saveActive(chatId, a, left + 900);

  const line = pick(MOCKS).replace('{who}', pingOf(user)).replace('{title}', a.title);
  await sendMessage(chatId, line);

  if (credit && typeof credit.award === 'function') {
    try { await credit.award(chatId, user, CFG.reward, 'попался на её ловушку «' + a.title + '»', { force: true }); } catch (_) {}
  }
  try {
    await memory.logIncoming(chatId, [{ r: 'u', t: '[' + nameOf(user) + ']: [попался на ловушку «' + a.title + '», выбрал ' + (choice === 'yes' ? 'уверен' : 'не уверен') + ']' }], { type: 'group', user });
    await memory.logBot(chatId, [{ r: 'm', t: line }]);
  } catch (_) {}

  if (a.caught.length >= CFG.maxVictims) {
    await closeTrap(chatId, a, false, '(набралось достаточно лохов, я закрывать лавочку)');
  }
}

// Кнопки ловушки. Вызывается после шифров, до курсов.
async function handleCallback(cq) {
  const data = String((cq && cq.data) || '');
  if (!data.startsWith('trap:')) return false;
  const parts = data.split(':');
  const action = parts[1];
  const id = parts[2];
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;
  if (!chatId || !memory) { await answerCallback(cq.id); return true; }

  const a = await getActive(chatId);
  if (!a || a.id !== id) {
    await answerCallback(cq.id, 'Эта лавочка уже закрыта, лошара');
    return true;
  }
  if (Date.now() > a.expiresAt) {
    await answerCallback(cq.id, 'Поздно. Пять минут прошло, поезд ушёл');
    await closeTrap(chatId, a, true);
    return true;
  }
  const user = cq.from || {};

  if (action === 'open') {
    if ((a.caught || []).includes(String(user.id))) {
      await answerCallback(cq.id, 'Ты уже попался, второй раз не считается');
      return true;
    }
    await answerCallback(cq.id, 'Юзернейм ' + pingOf(user) + ' подставлен сам. Жми кнопку, я ждать');
    const formText = a.form + '\n\n┌────────────────────────┐\n│ Юзернейм: ' + pingOf(user) + ' ▮\n│ Пароль: не нужен, я и так знать\n└────────────────────────┘\nПоле заполнено автоматически из твоего открытого профиля. Осталось подтвердить.';
    try {
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text: formText,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Вы уверены?', callback_data: 'trap:yes:' + id },
            { text: '❌ Не уверены?', callback_data: 'trap:no:' + id }
          ]]
        }
      });
      a.opened = true;
      await saveActive(chatId, a, Math.max(60, Math.round((a.expiresAt - Date.now()) / 1000)) + 900);
    } catch (e) { console.error('traps form edit:', e.message); }
    return true;
  }

  if (action === 'yes' || action === 'no') {
    await answerCallback(cq.id, action === 'yes'
      ? 'Данные приняты. Спасибо за кошелёк'
      : 'Отказ принят. Данные всё равно приняты');
    await sprung(chatId, a, user, action);
    return true;
  }

  await answerCallback(cq.id);
  return true;
}

module.exports = { handleCallback, maybeDrop, sweep, info, CFG };
