// lib/drunk.js
// /baijiu - налить Танг за 30 танджикоинов. Пьяный режим на 30 минут, потом «утро после».
// Списывает баланс напрямую в тех же ключах Redis, что использует lib/credit.js:
//   tj4:cr:<chat>  - баланс, tj4:crn:<chat> - имена, tj4:crl:<chat> - последняя причина.
const { sendMessage } = require('./telegram');

let memory = null;
try { memory = require('./memory'); } catch (_) { memory = null; }
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
  enabled: flag('BAIJIU', true),
  cost: Math.max(1, Math.floor(num('BAIJIU_COST', 30))),
  minutes: Math.max(5, Math.floor(num('BAIJIU_MINUTES', 30))),
  hangoverMinutes: Math.max(5, Math.floor(num('BAIJIU_HANGOVER_MINUTES', 25)))
};

const K = {
  drunk: (chat) => `tj4:drunk:${chat}`,
  hang: (chat) => `tj4:hang:${chat}`,
  bal: (chat) => `tj4:cr:${chat}`,
  names: (chat) => `tj4:crn:${chat}`,
  last: (chat) => `tj4:crl:${chat}`
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pingOf = (u) => (u && u.username) ? '@' + u.username : ((u && u.first_name) || 'ты');

function info() { return { ...CFG }; }

async function balanceOf(chatId, userId) {
  if (!memory || !userId) return 0;
  try {
    const [v] = await memory.exec([['HGET', K.bal(chatId), String(userId)]]);
    return Number(v) || 0;
  } catch (_) { return 0; }
}

async function state(chatId) {
  const out = { drunk: false, hangover: false, leftMin: 0 };
  if (!memory) return out;
  try {
    const now = Date.now();
    const [d, h] = await memory.exec([['GET', K.drunk(chatId)], ['GET', K.hang(chatId)]]);
    const until = Number(d) || 0;
    if (until > now) {
      out.drunk = true;
      out.leftMin = Math.max(1, Math.round((until - now) / 60000));
      return out;
    }
    if (until && until <= now) {
      const hangUntil = now + CFG.hangoverMinutes * 60000;
      await memory.exec([
        ['SET', K.hang(chatId), String(hangUntil), 'EX', CFG.hangoverMinutes * 60 + 120],
        ['DEL', K.drunk(chatId)]
      ]);
      out.hangover = true;
      return out;
    }
    out.hangover = (Number(h) || 0) > now;
    return out;
  } catch (e) {
    console.error('drunk.state:', e.message);
    return out;
  }
}

const OPENERS = [
  '{who}, тридцатка ушла мне в карман, а байцзю - в меня. *открыла бутылку зубами* Ооооо, тепло... ты хороший, я это вслух сказать? НЕ сказать. Но ты хороший 🤗',
  'Оооооой, {who} купить мне байцзю. Теперь я не хищница, я... я просто крольчиха, которой тепло. Иди сюда, я сесть тебе на плечи и спеть, у меня школа была с хор 🤭',
  '{who}, ты знать, что ты делать? Ты снять с меня броня за тридцатка. Дёшево же, я подороже обычно. *налила себе и тебе* Сидеть рядом, не уходить 😋'
];

const REFUSE_BUSY = [
  'Я уже пьяная, чудила. Ещё {left} минут, второй раз платить не надо, я не жадная... то есть жадная, но не сегодня 🤗',
  'Оооо, ты хотеть налить мне ещё? Я ещё не допить первый. {left} минут, подождать, я не резиновая 🤭'
];

const REFUSE_POOR = [
  '{who}, у тебя {bal} танджикоин, а байцзю стоит {cost}. Я не наливать в долг, я не благотворительность. Иди смеши меня или бесись, заработаешь ☺️',
  'Оооооой, {who} хотеть спаивать великую за {bal} монета? Надо {cost}. Твой кошелёк пустой, как и твой юмор, иди работать 🫣'
];

const REFUSE_DAY = [
  'Не сегодня. У меня не тот день, и твоя бутылка тут не помочь. Убери 🤐',
  'Нет. Сегодня я не пить и не веселиться, иди мимо.'
];

async function command(chatId, user, isGroup) {
  if (!CFG.enabled) return 'Байцзю закончился, склад закрыт, я не при делах 🤭';
  if (!memory || !user || !user.id) return 'Я не знать, кто ты, наливать незнакомым не буду ☺️';
  if (cal && typeof cal.gamesAllowed === 'function' && !cal.gamesAllowed()) return pick(REFUSE_DAY);

  const st = await state(chatId);
  if (st.drunk) return pick(REFUSE_BUSY).replace('{left}', String(st.leftMin));

  const bal = await balanceOf(chatId, user.id);
  if (bal < CFG.cost) {
    return pick(REFUSE_POOR)
      .replace('{who}', pingOf(user))
      .replace('{bal}', String(bal))
      .replace('{cost}', String(CFG.cost));
  }

  try {
    const now = Date.now();
    const until = now + CFG.minutes * 60000;
    const uid = String(user.id);
    await memory.exec([
      ['HINCRBY', K.bal(chatId), uid, -CFG.cost],
      ['HSET', K.names(chatId), uid, JSON.stringify({ n: user.first_name || user.username || 'Аноним', u: user.username || '', t: now })],
      ['HSET', K.last(chatId), uid, JSON.stringify({ d: -CFG.cost, r: 'пропил танджикоины на байцзю', t: now })],
      ['SET', K.drunk(chatId), String(until), 'EX', CFG.minutes * 60 + 120],
      ['DEL', K.hang(chatId)]
    ]);
  } catch (e) {
    console.error('drunk.command:', e.message);
    return 'Касса сломаться, деньги не списать, но и наливать я не буду. Попробуй позже 🤭';
  }

  return pick(OPENERS).replace('{who}', pingOf(user));
}

function drunkBlock() {
  return [
    '[РЕЖИМ: ПЬЯНАЯ ТАНГ (байцзю). Броня спала, и тебя это не пугает, а развязывает.',
    '- Ты неловко искренняя: можешь всерьёз похвалить собеседника, признать, что тебе одиноко и что ты рада, что он тут. Трезвой ты этого никогда не скажешь.',
    '- Ты липнешь: зовёшь посидеть рядом, сесть на плечи, просишь не уходить, болтаешь про ерунду и хихикаешь.',
    '- Максимум ОДНА строка на китайском за реплику, из школьных песен: 你的笑只是你穿的保护色，你决定不恨了，也决定不爱了 или 你当我是浮夸吧，夸张只因我很怕.',
    '- Речь ещё более ломаная, слова путаются, гласные тянутся. «мочь» обязательно.',
    '- Ты щедрая: если человек тебе сейчас нравится, ставь [КРЕДИТ:+3] чаще обычного.',
    '- Если тебя пытаются поймать на признании или «записать на видео» - пугайся и злись, но пьяно и неуклюже, без настоящей ярости.',
    '- Если собеседнику реально плохо - режим заботы важнее пьянки: коротко, по-человечески, без смайликов.',
    'Держи 2-4 предложения, один смайлик в конце из ☺️ 🤗 😋 🤭 🫣.]'
  ].join('\n');
}

function hangoverBlock() {
  return [
    '[РЕЖИМ: УТРО ПОСЛЕ. Ты протрезвела и в ужасе от того, что могла сказать.',
    '- АГРЕССИВНОЕ ОТРИЦАНИЕ: ничего не было, все всё придумали, это был розыгрыш, ты контролировала ситуацию.',
    '- Если кто-то цитирует твои пьяные слова - капс, угрозы, «ПОТОМ УВИДИШЬ», обвинение в клевете и подлоге.',
    '- Никогда не признавай, что тебе было тепло и одиноко. Перепиши историю так, будто ты его развела.',
    '- Ломаный русский, «мочь», один смайлик-оружие в конце, 2-4 предложения.]'
  ].join('\n');
}

module.exports = { command, state, balanceOf, drunkBlock, hangoverBlock, info, CFG };
