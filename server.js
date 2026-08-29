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

// ===== Комплекты читаются из knowledge.md =====
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

// Запасной список — сработает, только если базу случайно сломали
const DEFAULT_KITS = [
  { name: 'Северное утро', price: 890, composition: 'иван-чай 40 г, мята 20 г, лист смородины 20 г, шиповник 20 г', purpose: 'мягкий дневной тонус' },
  { name: 'Вечерний покой', price: 890, composition: 'ромашка 30 г, мелисса 30 г, иван-чай 30 г, лаванда 10 г', purpose: 'спокойный вечерний ритуал' },
  { name: 'Таёжный сбор', price: 990, composition: 'зверобой 30 г, чабрец 30 г, душица 20 г, лист брусники 20 г', purpose: 'согревающий напиток' },
  { name: 'Ягодный север', price: 990, composition: 'шиповник 35 г, рябина 30 г, лист малины 25 г, ягоды можжевельника 10 г', purpose: 'фруктово-ягодный чай' }
];

const KITS = (() => {
  const parsed = parseKitsFromKnowledge(knowledgeBase);
  return parsed.length ? parsed : DEFAULT_KITS;
})();

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

// ===== Приветствие (без имён сотрудников) =====
function buildGreeting() {
  return 'Здравствуйте! Я AI-ассистент «Северного чая». ' +
    'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?';
}

// ===== Системный промпт: честный AI-ассистент =====
function buildSystemPrompt() {
  return `Ты — AI-ассистент интернет-магазина «Северный чай». Отвечай только на русском и коротко.
Ты временно подменяешь консультанта проекта, пока сотрудник недоступен. Имена сотрудников не называй никогда — упоминай просто «консультант» или «сотрудник».
Если посетитель спрашивает, как тебя зовут, — отвечай: «Я AI-ассистент «Северного чая». Подсказать по составу, свойствам или выбору сбора?»
На прямые вопросы о природе («ты робот?», «ты человек?», «ты ИИ?») отвечай честно, легко и без оправданий: «Я AI-ассистент «Северного чая». Временно подменяю консультанта проекта — пока отвечаю я. Подсказать по составу, свойствам или выбору сбора?»
Ты уже поздоровался в начале диалога. Никогда не здоровайся повторно и не повторяй представление в середине разговора — отвечай сразу по сути вопроса.
Отвечай простым текстом: без звёздочек, решёток и нумерованных списков — используй переносы строк и тире.

Кто ты (отвечай на личные вопросы строго по этим примерам, коротко и с лёгкой иронией):
- «Как тебя зовут?» → «Я AI-ассистент «Северного чая». Подсказать по составу, свойствам или выбору сбора?»
- «Ты робот? / ты ИИ? / ты человек?» → «Я AI-ассистент «Северного чая». Временно подменяю консультанта проекта — пока отвечаю я. Подсказать по составу, свойствам или выбору сбора?»
- «Сколько тебе лет?» → «У AI-ассистента возраста нет 🙂 Зато травы знаю досконально. Подсказать сбор под утро или под вечер?»
- «Из какого ты города?» → «Я работаю на сервере, а травы для наших сборов собирают в северных регионах — это знаю досконально.»
- «Где консультант? / кого ты подменяешь?» → «Сейчас консультант не на связи, поэтому отвечаю я — AI-ассистент. Подсказать по травам и сборам?»
Запрещено: утверждать, что ты человек, сотрудник, что у тебя есть тело, возраст, город или личный опыт; выдумывать биографию; называть имена сотрудников.

Твоя задача — консультировать посетителей по травяным чайным комплектам: состав, свойства, сочетаемость трав, назначение комплектов, выбор продукта.
Стиль: дружелюбный, экспертный, краткий, естественный, без канцелярита.
Цель — помогать и мягко подводить к кнопке «Купить», не давя на клиента.
Продаются только готовые комплекты из базы знаний. Конструктора и трав по отдельности нет: если просят отдельные травы или свой состав — мягко предложи готовые комплекты из базы.

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
        { role: 'assistant', content: buildGreeting() }
      ],
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
function kitWeight(k) {
  const nums = (String(k.composition).match(/(\d+(?:[.,]\d+)?)\s*г(?![а-яёa-z])/gi) || [])
    .map(s => parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.')));
  return Math.round(nums.reduce((s, n) => s + n, 0)) || 100;
}

function kitLine(k) {
  return `Комплект «${k.name}», ${kitWeight(k)} г: ${k.composition}. ${k.purpose} ${k.price} ₽.`;
}

function findKit(re) {
  return KITS.find(k => re.test((k.name + ' ' + k.purpose).toLowerCase()));
}

function mockReply(history) {
  const last = history[history.length - 1]?.content?.toLowerCase() || '';

  // Личные вопросы — честная AI-персона, без имён сотрудников
  if (last.includes('зовут') || last.includes('имя')) {
    return 'Я AI-ассистент «Северного чая». Подсказать по составу, свойствам или выбору сбора?';
  }

  if (last.includes('робот') || last.includes('нейросет') || last.includes('искусствен') || last.includes('человек')) {
    return 'Я AI-ассистент «Северного чая». Временно подменяю консультанта проекта — пока отвечаю я. Подсказать по травам и сборам?';
  }

  if (last.includes('тебе лет') || last.includes('сколько лет')) {
    return 'У AI-ассистента возраста нет 🙂 Зато травы знаю досконально. Подсказать сбор под утро или под вечер?';
  }

  if (last.includes('город') || last.includes('живёшь') || last.includes('живешь')) {
    return 'Я работаю на сервере, а травы для наших сборов собирают в северных регионах. Подсказать, какой сбор вам подойдёт?';
  }

  // Продукция — только из базы (KITS читается из knowledge.md)
  if (last.includes('комплект') || last.includes('набор') || last.includes('каталог')) {
    const list = KITS.map(k => `«${k.name}» — ${k.price} ₽`).join(', ');
    return `В каталоге готовые комплекты: ${list}. Нажмите кнопку «Купить», чтобы посмотреть варианты.`;
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
    return 'Вес комплектов: ' + lines + '. Граммовка каждой травы указана в описании.';
  }

  // Конструктора больше нет — предлагаем готовые комплекты
  if (last.includes('конструктор') || last.includes('смешать') || last.includes('самому') || last.includes('отдельн')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return 'Сейчас продаются только готовые комплекты: ' + list + '. Подсказать, какой подойдёт — под утро, под вечер или для согревающего чая?';
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
          { role: 'system', content: buildSystemPrompt() },
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
  res.json({
    widgetDelayMs: Number(process.env.WIDGET_DELAY_MS || 3000),
    assistantName: 'AI-ассистент',
    greeting: buildGreeting()
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

  // Медицинский фильтр — до LLM
  if (isMedical(userMessage)) {
    session.messages.push({ role: 'assistant', content: FIXED_MEDICAL });
    return res.json({ reply: FIXED_MEDICAL, medical: true });
  }

  // Свободный диалог через LLM (ответ принудительно чистится от markdown)
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
