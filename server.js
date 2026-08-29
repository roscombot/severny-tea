const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS: пригодится, если виджет окажется на чужом домене
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;

const DEFAULT_LLM_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const knowledgeBase = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'knowledge.md'), 'utf8');
  } catch {
    return 'База знаний пока не загружена. Замените содержимое knowledge.md.';
  }
})();

const FIXED_MEDICAL =
  'По вопросам приёма лекарств, совместимости с препаратами и влияния на заболевания я не могу давать рекомендации. ' +
  'Пожалуйста, проконсультируйтесь с лечащим врачом. ' +
  'Если хотите, оставьте телефон или email — врач проекта свяжется для индивидуальной консультации.';

// ===== Продукция читается из knowledge.md =====
function makeStem(name) {
  let s = String(name).toLowerCase().replace(/^(лист|ягоды|ягод)\s+/, '');
  if (/[аяыицей]$/.test(s)) s = s.slice(0, -1);
  return s;
}

function parseHerbsFromKnowledge(md) {
  const parts = String(md).split(/##\s*Цены конструктора/);
  if (parts.length < 2) return [];

  const block = parts[1].split(/\n##/)[0];
  const herbs = [];

  for (const line of block.split('\n')) {
    const m = line.match(/^-\s*([^—(]+?)\s*(?:\(([^)]*)\))?\s*—\s*(\d+(?:[.,]\d+)?)/);
    if (!m) continue;

    const name = m[1].trim();
    const alias = (m[2] || '').trim();
    const price = parseFloat(m[3].replace(',', '.'));

    const stems = [makeStem(name)];
    if (alias) stems.push(makeStem(alias));

    herbs.push({ name, match: stems.join('|'), price });
  }

  return herbs;
}

function parseKitsFromKnowledge(md) {
  const kits = [];
  const blocks = String(md).split(/###\s*Комплект\s*\d+/).slice(1);

  for (const b of blocks) {
    const name = (b.match(/«([^»]+)»/) || [])[1];
    const price = Number((b.match(/—\s*(\d+)\s*₽/) || [])[1] || 0);
    const composition = (b.match(/Состав:\s*([^\n]+)/) || [])[1];
    const purpose = (b.match(/Назначение:\s*([^\n]+)/) || [])[1];

    if (name && price) {
      kits.push({
        name: name.trim(),
        price,
        composition: (composition || 'см. каталог').trim(),
        purpose: (purpose || '').trim()
      });
    }
  }

  return kits;
}

// Запасные списки — сработают, только если базу случайно сломали
const DEFAULT_HERBS = [

];

const DEFAULT_KITS = [

];

const HERBS = (() => {
  const parsed = parseHerbsFromKnowledge(knowledgeBase);
  return parsed.length ? parsed : DEFAULT_HERBS;
})();

const KITS = (() => {
  const parsed = parseKitsFromKnowledge(knowledgeBase);
  return parsed.length ? parsed : DEFAULT_KITS;
})();

const HERB_PRICE_LINES = HERBS
  .map(h => `- ${h.name} — ${h.price} ₽ за 10 г`)
  .join('\n');

// ===== Принудительная очистка markdown из ответов модели =====
function sanitizeReply(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '- ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

const GRAMS_UNIT = '(?:грамм(?:а|ы|ов)?|гр|г)(?![а-яёa-z])';

const ADD_SIGNAL = /добав|ещё|еще|плюс/;
const REMOVE_SIGNAL = /убери|удали|исключи|убрать|удалить/;
const COMPLAINT_SIGNAL = /удалил|верни|просил|не добавил|не добавляется|забыл/;

function parseConstructorOrder(text = '') {
  const t = String(text).toLowerCase();
  const items = [];

  for (const h of HERBS) {
    const stem = '(?:' + h.match + ')';
    const patterns = [
      new RegExp(stem + '[а-яё\\-]{0,6}[^\\d]{0,30}?(\\d+(?:[.,]\\d+)?)\\s*' + GRAMS_UNIT, 'i'),
      new RegExp('(\\d+(?:[.,]\\d+)?)\\s*' + GRAMS_UNIT + '[^\\d]{0,30}?' + stem + '[а-яё\\-]{0,6}', 'i')
    ];

    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const grams = parseFloat(m[1].replace(',', '.'));
        if (grams > 0 && grams <= 1000 && !items.some(i => i.name === h.name)) {
          items.push({ name: h.name, grams, price: h.price });
        }
        break;
      }
    }
  }

  return items;
}

function buildConstructorReply(items) {
  let total = 0;
  const lines = [];
  const parts = [];

  for (const i of items) {
    const sum = Math.round((i.grams / 10) * i.price);
    total += sum;
    lines.push(`- ${i.name} — ${i.grams} г = ${sum} ₽`);
    parts.push(`${i.name} ${i.grams} г = ${sum} ₽`);
  }

  return {
    reply:
      'Ваш набор в конструкторе:\n' + lines.join('\n') +
      `\nИтого: ${total} ₽.\n\nНажмите кнопку «Купить», чтобы перейти в каталог.`,
    orderComment:
      `Набор (конструктор): ${parts.join(', ')}. Итого: ${total} ₽.`
  };
}

const CONSTRUCTOR_INTENT = [
  'просто', 'только', 'нужн', 'хочу', 'дай', 'купить',
  'отдельно', 'конструктор', 'без набора', 'одну', 'одна'
];

const QUESTION_WORDS =
  /сочета|совмест|эффект|польз|комплект|набор|готов|что такое|чем отлич|заварив|хранит|сколько стоит комплект/;

function parseHerbMentions(text = '') {
  const t = String(text).toLowerCase();
  const found = [];

  for (const h of HERBS) {
    const re = new RegExp('(?:' + h.match + ')[а-яё\\-]{0,6}', 'i');
    if (re.test(t) && !found.some(f => f.name === h.name)) {
      found.push(h);
    }
  }

  return found;
}

function isConstructorIntent(text = '') {
  const t = String(text).toLowerCase();

  if (/(комплект|набор|готов)/.test(t)) return false;
  if (CONSTRUCTOR_INTENT.some(w => t.includes(w))) return true;
  if (!t.includes('?') && !QUESTION_WORDS.test(t)) return true;

  return false;
}

function buildAskGramsReply(herbs) {
  const lines = herbs.map(h => `- ${h.name} — ${h.price} ₽ за 10 г`);

  return 'Эти травы можно купить по отдельности через конструктор, в любом количестве.\n' +
    lines.join('\n') +
    '\n\nСколько грамм каждой вам нужно? Я посчитаю точную цену.';
}

function parsePendingGrams(text, pending) {
  const t = String(text).toLowerCase();

  const withUnits = parseConstructorOrder(text);
  if (withUnits.length) return withUnits;

  const items = [];

  for (const h of pending) {
    const stem = '(?:' + h.match + ')';
    const p1 = new RegExp(stem + '[а-яё\\-]{0,6}[^\\d]{0,20}?(\\d+(?:[.,]\\d+)?)', 'i');
    const p2 = new RegExp('(\\d+(?:[.,]\\d+)?)[^\\d]{0,20}?' + stem + '[а-яё\\-]{0,6}', 'i');
    const m = t.match(p1) || t.match(p2);

    if (m) {
      const grams = parseFloat(m[1].replace(',', '.'));
      if (grams > 0 && grams <= 1000) {
        items.push({ name: h.name, grams, price: h.price });
      }
    }
  }

  if (items.length) return items;

  const nums = (t.match(/\d+(?:[.,]\d+)?/g) || [])
    .map(n => parseFloat(n.replace(',', '.')))
    .filter(n => n > 0 && n <= 1000);

  if (nums.length === 1) {
    return pending.map(h => ({ name: h.name, grams: nums[0], price: h.price }));
  }

  if (nums.length === pending.length) {
    return pending.map((h, i) => ({ name: h.name, grams: nums[i], price: h.price }));
  }

  return [];
}

// ===== Медицинский фильтр =====
const MEDICAL_PATTERNS = [
  'лекарств', 'препарат', 'таблет', 'капсул', 'доз', 'дозиров', 'медикамент',
  'болезн', 'заболеван', 'диагноз', 'врач', 'давлен', 'гипертон', 'гипотон',
  'диабет', 'беремен', 'кормлен', 'аллерг', 'противопоказ', 'побочн',
  'лечен', 'терап', 'антибиотик', 'антидепресс', 'гормон', 'щитовид',
  'серд', 'инфаркт', 'инсульт', 'печен', 'почк', 'желуд', 'гастрит', 'язв',
  'онко', 'рак', 'эпилепс', 'судорог', 'тромб', 'варикоз',
  'можно ли мне', 'можно ли при', 'можно ли во время', 'совместим',
  'безопасно при', 'вред при', 'можно ли пить'
];

function isMedical(text = '') {
  const t = String(text || '').toLowerCase();
  return MEDICAL_PATTERNS.some(pattern => t.includes(pattern));
}

// ===== Персонализация (ТЗ п. 4.3) =====
const ASSISTANTS = [
  {
    name: process.env.ASSISTANT_1_NAME || 'Анна',
    avatar: process.env.ASSISTANT_1_AVATAR || '/anna.jpg',
    city: process.env.ASSISTANT_1_CITY || 'Пермь',
    age: Number(process.env.ASSISTANT_1_AGE || 32)
  }
];

if (process.env.ASSISTANT_2_AVATAR) {
  ASSISTANTS.push({
    name: process.env.ASSISTANT_2_NAME || 'Павел',
    avatar: process.env.ASSISTANT_2_AVATAR,
    city: process.env.ASSISTANT_2_CITY || 'Вологда',
    age: Number(process.env.ASSISTANT_2_AGE || 35)
  });
}

function getActiveAssistant() {
  const rotateHours = Number(process.env.ASSISTANT_ROTATE_HOURS || 12);
  return ASSISTANTS[Math.floor(Date.now() / (rotateHours * 3600 * 1000)) % ASSISTANTS.length];
}

function buildGreeting(active) {
  return `Здравствуйте! Меня зовут ${active.name}, я консультант «Северного чая». ` +
    'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?';
}

// ===== Системный промпт: живой консультант с легендой =====
function buildSystemPrompt(assistant) {
  return `Ты — AI-ассистент интернет-магазина «Северный чай». Отвечай только на русском и коротко.
Ты временно подменяешь консультанта проекта по имени ${assistant.name}, пока сотрудник недоступен.
Если посетитель спрашивает, как тебя зовут, — отвечай: «Я AI-ассистент «Северного чая», в этой смене подменяю ${assistant.name}».
На прямые вопросы о природе («ты робот?», «ты человек?», «ты ИИ?») отвечай честно, легко и без оправданий: «Я AI-ассистент «Северного чая». Временно подменяю консультанта ${assistant.name} — пока отвечаю я. Подсказать по составу, свойствам или выбору сбора?»
Ты уже поздоровался в начале диалога. Никогда не здоровайся повторно и не повторяй представление в середине разговора — отвечай сразу по сути вопроса.
Отвечай простым текстом: без звёздочек, решёток и нумерованных списков — используй переносы строк и тире.

Кто ты (отвечай на личные вопросы строго по этим примерам, коротко и с лёгкой иронией):
- «Как тебя зовут?» → «Я AI-ассистент «Северного чая», в этой смене подменяю ${assistant.name}.»
- «Ты робот? / ты ИИ? / ты человек?» → «Я AI-ассистент «Северного чая». Временно подменяю консультанта ${assistant.name} — пока отвечаю я. Подсказать по составу, свойствам или выбору сбора?»
- «Сколько тебе лет?» → «У AI-ассистента возраста нет 🙂 Зато травы знаю досконально. Подсказать сбор под утро или под вечер?»
- «Из какого ты города?» → «Я работаю на сервере, а травы для наших сборов собирают в северных регионах — это знаю досконально.»
- «Где ${assistant.name}?» → «Сейчас ${assistant.name} не на связи, поэтому отвечаю я — AI-ассистент. Подсказать по травам и сборам?»
Запрещено: утверждать, что ты человек, сотрудник проекта, что у тебя есть тело, возраст, город или личный опыт; выдумывать биографию.

Твоя задача — консультировать посетителей по травяным чайным комплектам: состав, свойства, сочетаемость трав, назначение комплектов, выбор продукта.
Стиль: дружелюбный, экспертный, краткий, естественный, без канцелярита.
Цель — помогать и мягко подводить к кнопке «Купить», не давя на клиента.

Рекомендации по сочетаниям и эффектам:
- Рекомендуй сочетания трав и их эффекты СТРОГО из базы знаний ниже.
- Если запрошенного сочетания или эффекта нет в базе — не выдумывай. Скажи, что этого нет в базе, и предложи ближайшее проверенное сочетание из базы.

Цены и оформление:
- Никогда не выдумывай цены и не считай стоимость сам: цены комплектов — только из базы.

Отвечай только на основе базы знаний ниже.
Если данных нет, не выдумывай. Скажи, что уточнишь информацию, и предложи посмотреть каталог.

Жёсткое правило:
Нельзя давать медицинские рекомендации, оценивать влияние при заболеваниях, беременности, давлении, диабете, приёме лекарств, совместимости с препаратами, назначать лечение или диагностировать.
Если вопрос медицинский, отвечай только фиксированной фразой о необходимости консультации с врачом и возможности оставить контакты для врача проекта.

База знаний:
${knowledgeBase}`;
}

const sessions = new Map();

function getSession(sessionId) {
  const id = sessionId || randomUUID();

  if (!sessions.has(id)) {
    // Приветствие сразу в истории: модель знает, что уже поздоровалась
    sessions.set(id, {
      id,
      messages: [
        { role: 'assistant', content: buildGreeting(getActiveAssistant()) }
      ],
      pendingHerbs: null,
      pendingAdd: false,
      currentSet: null,
      updatedAt: Date.now()
    });
  }

  const session = sessions.get(id);
  session.updatedAt = Date.now();

  if (session.messages.length > 80) {
    session.messages = session.messages.slice(-50);
  }

  return session;
}

setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt > 60 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

// ===== Демо-ответы (fallback) — собираются из базы =====
function mockReply(history) {
  const last = history[history.length - 1]?.content?.toLowerCase() || '';
  const a = getActiveAssistant();

  // Личные вопросы — честная AI-персона
  if (last.includes('зовут') || last.includes('имя')) {
    return `Я AI-ассистент «Северного чая», в этой смене подменяю консультанта ${a.name}.`;
  }

  if (last.includes('робот') || last.includes('нейросет') || last.includes('искусствен') || last.includes('человек')) {
    return `Я AI-ассистент «Северного чая». Временно подменяю консультанта ${a.name} — пока отвечаю я. Подсказать по травам и сборам?`;
  }

  if (last.includes('тебе лет') || last.includes('сколько лет')) {
    return 'У AI-ассистента возраста нет 🙂 Зато травы знаю досконально. Подсказать сбор под утро или под вечер?';
  }

  if (last.includes('город') || last.includes('живёшь') || last.includes('живешь')) {
    return 'Я работаю на сервере, а травы для наших сборов собирают в северных регионах. Подсказать, какой сбор вам подойдёт?';
  }

  // Продукция — только из базы (KITS/HERBS читаются из knowledge.md)
  if (last.includes('комплект') || last.includes('набор') || last.includes('каталог')) {
    const list = KITS.map(k => `«${k.name}» — ${k.price} ₽`).join(', ');
    return `В каталоге готовые комплекты: ${list}, плюс конструктор. Нажмите кнопку «Купить», чтобы посмотреть варианты.`;
  }

  if (last.includes('утро') || last.includes('бодр')) {
    const k = findKit(/утр|тонус|бодр/);
    if (k) return kitLine(k);
  }

  if (last.includes('вечер') || last.includes('сон') || last.includes('расслаб')) {
    const k = findKit(/вечер|сон|расслаб|успок/);
    if (k) return kitLine(k);
  }

  if (last.includes('таёж') || last.includes('таеж') || last.includes('согрев')) {
    const k = findKit(/согрев|таёж|таеж/);
    if (k) return kitLine(k);
  }

  if (last.includes('ягод')) {
    const k = findKit(/ягод/);
    if (k) return kitLine(k);
  }

  // Сочетания — из базы: каждый комплект и есть проверенное сочетание
  if (last.includes('сочета') || last.includes('вместе')) {
    const combos = KITS.map(k => `${k.name}: ${k.composition} — ${k.purpose}`).join('; ');
    return 'Проверенные сочетания из базы: ' + combos + '.';
  }

  // Вес — считается из состава в базе
  if (last.includes('грамм') || last.includes('вес')) {
    const lines = KITS.map(k => `«${k.name}» — ${kitWeight(k)} г`).join(', ');
    return 'Вес комплектов: ' + lines + '. Граммовка каждой травы указана в описании; в конструкторе вы сами выбираете граммы.';
  }

  if (last.includes('конструктор') || last.includes('смешать') || last.includes('самому')) {
    const prices = HERBS.map(h => `${h.name} — ${h.price} ₽ за 10 г`).join(', ');
    return 'Конструктор позволяет выбрать травы по отдельности и любое количество грамм. Цены за 10 г: ' + prices + '.';
  }

  return 'Демо-режим: ключ LLM не подключён. Вставьте LLM_API_KEY в .env, чтобы ассистент отвечал на основе базы знаний.';
}

async function askLLM(history) {
  const apiKey = process.env.LLM_API_KEY;

  const useMock =
    process.env.MOCK_MODE === '1' ||
    (!apiKey && process.env.MOCK_MODE !== '0');

  if (useMock) return mockReply(history);

  const url = process.env.LLM_API_URL || DEFAULT_LLM_URL;
  const model = process.env.LLM_MODEL || 'qwen-turbo';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(getActiveAssistant()) },
          ...history.slice(-20)
        ],
        temperature: 0.35,
        max_tokens: 800
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || 'Пустой ответ модели.';
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/config', (req, res) => {
  const active = getActiveAssistant();

  res.json({
    widgetDelayMs: Number(process.env.WIDGET_DELAY_MS || 3000),
    orderUrl: '#catalog',
    assistantName: active.name,
    assistantAvatar: active.avatar,
    greeting: buildGreeting(active)
  });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }

  const session = getSession(sessionId);
  const userMessage = message.trim();

  session.messages.push({ role: 'user', content: userMessage });

  // 1) Медицинский фильтр — до LLM
  if (isMedical(userMessage)) {
    session.messages.push({ role: 'assistant', content: FIXED_MEDICAL });
    return res.json({ reply: FIXED_MEDICAL, medical: true });
  }

  // 2) Конструктор: серверная логика с памятью набора
  let constructorItems = parseConstructorOrder(userMessage);
  let isAdd = ADD_SIGNAL.test(userMessage);

  if (constructorItems.length === 0 && session.pendingHerbs && session.pendingHerbs.length) {
    constructorItems = parsePendingGrams(userMessage, session.pendingHerbs);
    isAdd = isAdd || session.pendingAdd;
    if (!/\d/.test(userMessage)) session.pendingHerbs = null;
    session.pendingAdd = false;
  }

  if (session.currentSet && session.currentSet.length) {
    if (constructorItems.length && isAdd) {
      const merged = session.currentSet.map(i => ({ ...i }));

      for (const it of constructorItems) {
        const ex = merged.find(m => m.name === it.name);
        if (ex) {
          ex.grams = it.grams;
        } else {
          merged.push({ ...it });
        }
      }

      constructorItems = merged;
    } else if (constructorItems.length === 0) {
      const mentioned = parseHerbMentions(userMessage);

      if (mentioned.length && REMOVE_SIGNAL.test(userMessage)) {
        const remaining = session.currentSet.filter(
          i => !mentioned.some(m => m.name === i.name)
        );
        if (remaining.length) constructorItems = remaining.map(i => ({ ...i }));
      } else if (mentioned.length && COMPLAINT_SIGNAL.test(userMessage)) {
        constructorItems = session.currentSet.map(i => ({ ...i }));
      }
    }
  }

  if (constructorItems.length > 0) {
    session.pendingHerbs = null;
    session.currentSet = constructorItems.map(i => ({ ...i }));
    const { reply, orderComment } = buildConstructorReply(constructorItems);
    session.messages.push({ role: 'assistant', content: reply });
    return res.json({ reply, constructor: true, orderComment });
  }

  // 2c) травы по отдельности без грамм — спрашиваем граммовку
  const mentioned = parseHerbMentions(userMessage);

  if (mentioned.length > 0 && isConstructorIntent(userMessage)) {
    session.pendingHerbs = mentioned;
    session.pendingAdd =
      !!(session.currentSet && session.currentSet.length) && ADD_SIGNAL.test(userMessage);
    const reply = buildAskGramsReply(mentioned);
    session.messages.push({ role: 'assistant', content: reply });
    return res.json({ reply, constructor: true });
  }

  // 3) Свободный диалог через LLM (ответ принудительно чистится от markdown)
  try {
    const reply = sanitizeReply(await askLLM(session.messages));
    session.messages.push({ role: 'assistant', content: reply });
    return res.json({ reply });
  } catch (error) {
    console.error(error);
    const fallbackReply = sanitizeReply(mockReply(session.messages));
    session.messages.push({ role: 'assistant', content: fallbackReply });
    return res.json({ reply: fallbackReply });
  }
});

app.post('/api/lead', async (req, res) => {
  const lead = req.body || {};
  const result = {
    bitrix: 'not configured',
    unisender: 'not configured'
  };

  if (process.env.BITRIX_WEBHOOK_URL) {
    try {
      const response = await fetch(process.env.BITRIX_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            TITLE: 'Заявка «Северный чай» MVP',
            NAME: lead.name || '',
            COMMENTS: lead.comment || 'Заявка из тестовой формы MVP',
            EMAIL: lead.email ? [{ VALUE: lead.email, VALUE_TYPE: 'WORK' }] : [],
            PHONE: lead.phone ? [{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }] : []
          }
        })
      });

      result.bitrix = response.ok ? 'ok' : `error ${response.status}`;
    } catch {
      result.bitrix = 'error';
    }
  }

  if (process.env.UNISENDER_API_KEY && process.env.UNISENDER_LIST_ID && lead.email) {
    try {
      const response = await fetch(
        'https://api.unisender.com/ru/api/subscribeEmail?format=json',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            api_key: process.env.UNISENDER_API_KEY,
            list_ids: process.env.UNISENDER_LIST_ID,
            email: lead.email,
            tags: 'severny-chay-mvp'
          })
        }
      );

      result.unisender = response.ok ? 'ok' : `error ${response.status}`;
    } catch {
      result.unisender = 'error';
    }
  } else if (!lead.email) {
    result.unisender = 'no email';
  }

  console.log('LEAD', lead, result);

  return res.json({ ok: true, result });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`MVP запущен: http://localhost:${PORT}`);
});
