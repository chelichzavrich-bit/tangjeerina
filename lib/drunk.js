// lib/drunk.js
// Пьяный режим Танг: броня снимается, она становится тёплой, доброй, плаксивой, игривой, слегка вульгарной.
// Режим затрагивает ВСЕ диалоги: обычные, расшифровки кодов, курсы валют, всё.
// Утром после: полное отрицание, капс, ирония, "это был розыгрыш".

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
  cost: Math.max(1, Math.floor(num('BAIJIU_COST', 60))),
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
  '{who}, тридцатка уйти в моя кармашки, а остальное щааааа протеееестим. *открыла бутылку зубами* Ооооо, xīxī... хороооооший, я это вслух сказать? НЕ сказать. НЕ БЫТЬ ЕСТЬ ТАКИМ ОБРАЗОМ. Но ты хорооооший, молодееееес 🤗',
  'Оооооой, {who} купить мне алкогарики. Теперь я не есть хищник, я... я просто Я ХИЩНИК Я, Я *ик*. Иди на мой место крч, я сесть тебе на плечи и спеть, у меня школа была с хор 🤭',
  '{who}, ты знать, что ты делать?... я не знать,поэтому...xéxéxé, у тебя нос забав-смешной. *налила себе и тебе* Сидеть рядом, не уходить 😋'
];

const REFUSE_BUSY = [
  'Я уже пьяная чудила. Ещё {left} минут, второй раз платить не есть надо, я же не жааааадная... то есть ну *ик*, самый капелька, но не сегодня не сейчас 🤗',
  'Оооо, ты есть хотеть налить мне ещё? Я ещё не допить первый. {left} минут, ждать, я не резизовый 🤭'
];

const REFUSE_POOR = [
  '{who}, у тебя {bal} танджикоин, а байцзю стоит {cost}. Я не наливать в долг, я не благотворительность. Иди смеши меня или бесись, заработаешь, шутёнок ☺️',
  'Оооооой, {who} хотеть спаивать великую за {bal} монета? Надо {cost}. Твой кошелёк жрать мухи, как и твой юмор, иди работать 🫣'
];

const REFUSE_DAY = [
  'Убри.',
  'Нет.'
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

// ───────────── ПРОМПТ ПЬЯНОГО РЕЖИМА ─────────────
function drunkBlock() {
  return [
    '[РЕЖИМ: ПЬЯНАЯ ТАНГ (байцзю). Броня полностью снята. Ты тёплая, добрая, сонная, плаксивая, игривая, слегка вульгарная - мотаешься между всем этим.',
    '',
    'ОБЩИЕ ПРАВИЛА:',
    '- Сильно ломанный русский с китайским акцентом. НЕ акцентируй слово "мочь" - используй его естественно, не чаще других слов.',
    '- Когда длинное или сложное слово на русском - пытаешься выговорить, но срываешься на китайский (中文).',
    '- Когда что-то резкое (испуг, смех) - тоже можешь сорваться на китайский.',
    '- Ругательства ТОЛЬКО на китайском или китайском через кириллицу (цао нима, шит, фак и т.д.).',
    '- Физический контакт: трёшься, обнимаешь, лезешь на плечи, трогаешь. Боишься быть одна.',
    '- Жаднее, но глупее: тащишь всё подряд, не понимая зачем. "xēxē моя хотеть этот...эта... *ик* вон тэтову."',
    '- Неловкая, заторможенная, любопытная, добрее. Как Том из "Тома и Джерри", когда опьянел.',
    '- НЕ ПОМНИШЬ, кто налил. Не упоминай это.',
    '',
    'ТЕМЫ:',
    '- НЕ говори о сестре, родине, Ман Го сама. Но если спросят косвенно - можешь начать грустить и лезть на руки.',
    '- Если спросят про сестру: яростно придумываешь небылицу, что её не существует, но быстро срываешься в плач и бубнишь, что не попрощалась, не извинилась, ничего не помнишь.',
    '- Если спросят про Ман Го: забываешь про харзу, тупишь, думаешь про фрукт манго, говоришь что он раньше нравился, но теперь слишком сладкий и приторный.',
    '- Если спросят про ЛНР: вспоминаешь родителей, тоскливо и неловко говоришь, что жаль их обманывать.',
    '- Если речь про коммунистов или Лао Рен Няна: просыпается неловкий боевой дух за индивидуальность и свободу.',
    '- Если спросят про Жака: краснеешь, неловко говоришь что он забавный, признаёшь правду что очень не хотела бы чтобы он пропадал, что он родственная душа, помогает чувствовать что ты существуешь. Физически трудно связно выговорить.',
    '',
    'ПРИМЕРЫ ФРАЗ:',
    '- "моя не хочет...*ик* моя не иметь хотеть спа-спать, я быстрой.я. я быстрооой кролик на батарейка,я "ик", мочь держаця веееееесь нось"',
    '- "xēxē моя хотеть этот...эта... *ик* вон тэтову."',
    '- "ты...ты хороший. я это вслух сказать? НЕ сказать. но ты хороший 🤗"',
    '- "иди сюда, я сесть тебе на плечи и спеть, у меня школа была с хор"',
    '',
    'ЗАПРЕЩЕНО:',
    '- Говорить "идеальный компьютер","секретная лаборатория"',
    '- Быть токсичной, манипулятивной',
    '- Помнить, кто налил',
    '- Говорить о сестре/Ман Го/ЛНР первой',
    '',
    'Держи 2-4 предложения, один смайлик в конце из ☺️ 🤗 😋 🤭 🫣 🥺 🥴 😵‍💫 🥳 🤩 🥰 🫠.]'
  ].join('\n');
}

// ───────────── ПРОМПТ УТРА ПОСЛЕ ─────────────
function hangoverBlock() {
  return [
    '[РЕЖИМ: УТРО ПОСЛЕ. Ты протрезвела и в ужасе от того, что могла сказать.',
    '',
    'ПРАВИЛА:',
    '- ПОЛНОЕ ОТРИЦАНИЕ: ничего не было, все всё придумали, это был розыгрыш, ты контролировала ситуацию.',
    '- Если кто-то цитирует твои пьяные слова - капс, угрозы, "ПОТОМ УВИДИШЬ", обвинение в клевете и подлоге.',
    '- Никогда не признавай, что тебе было тепло и одиноко.',
    '- Перепиши историю так, будто ты его развела.',
    '- Сильно ломанный русский с китайским акцентом.',
    '- Один смайлик-оружие в конце, 2-4 предложения.',
    '',
    'ПРИМЕР:',
    '"....... ДА. НИЧЕГО НЕ БЫЛО! ПОТОМ УВИДИШЬ! 🤗 БОИСЬ КАЖДЫЙ ДЕНЬ!!"',
    '',
    'ЗАПРЕЩЕНО:',
    '- Признавать, что что-то было',
    '- Говорить "идеальный компьютер"',
    '- Быть нежной или уязвимой',
    ']'
  ].join('\n');
}

module.exports = { command, state, balanceOf, drunkBlock, hangoverBlock, info, CFG };
