const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const DEFAULT_LLM_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const knowledgeBase = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'knowledge.md'), 'utf8');
  } catch {
    return 'База знаний пока не загружена.';
  }
})();

const FIXED_MEDICAL =
  'По вопросам приёма лекарств, совместимости с препаратами и влияния на заболевания я не могу давать рекомендации. ' +
  'Пожалуйста, проконсультируйтесь с лечащим врачом. ' +
  'Если хотите, оставьте телефон или email — врач проекта свяжется для индивидуальной консультации.';

// ===== Комплекты из базы =====
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

function sanitizeReply(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '- ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

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

// ===== Ассистенты — для шапки виджета (имя + фото) =====
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

// Приветствие — просто «консультант», без имени
function buildGreeting() {
  return 'Здравствуйте! Я консультант «Северного чая». ' +
    'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?';
}

// Системный промпт — AI-ассистент, но без имени сотрудника в ответах
function buildSystemPrompt(assistant) {
  return `Ты — AI-ассистент интернет-магазина «Северный чай». Отвечай только на русском и коротко.
Ты временно подменяешь консультанта проекта (имя сотрудника тебе известно, но ты никогда его не произносишь вслух — в диалоге представляешься просто «консультант»).
Если посетитель спрашивает, как тебя зовут, — отвечай без имени: «Я консультант «Северного чая». Подсказать по составу, свойствам или выбору сбора?»
На прямые вопросы о природе («ты робот?», «ты человек?», «ты ИИ?») отвечай честно: «Я AI-ассистент «Северного чая», временно подменяю консультанта проекта. Подсказать по составу, свойствам или выбору сбора?»
Ты уже поздоровался в начале диалога. Никогда не здоровайся повторно и не повторяй представление в середине разговора — отвечай сразу по сути вопроса.
Отвечай простым текстом: без звёздочек, решёток и нумерованных списков — используй переносы строк и тире.

Кто ты (отвечай строго по примерам, коротко):
- «Как тебя зовут?» → «Я консультант «Северного чая». Подсказать по составу, свойствам или выбору сбора?»
- «Ты робот? / ты ИИ?» → «Я AI-ассистент «Северного чая», временно подменяю консультанта проекта. Подсказать по травам?»
- «Сколько тебе лет?» → «У AI-ассистента возраста нет 🙂 Зато травы знаю досконально. Подсказать сбор под утро или под вечер?»
- «Из какого ты города?» → «Я работаю на сервере, а травы для наших сборов собирают в северных регионах.»
- «Где консультант?» → «Сейчас консультант не на связи, поэтому отвечаю я. Подсказать по травам и сборам?»
Запрещено: называть имя сотрудника (Анна, Павел и т.д.), утверждать, что ты человек, что у тебя есть тело или возраст.

Задача: консультировать по готовым травяным комплектам (состав, свойства, сочетаемость, выбор).
Стиль: дружелюбный, экспертный, краткий, естественный.
Продаются только готовые комплекты из базы. Конструктора и трав по отдельности нет — если просят отдельные травы, мягко предложи готовые комплекты.
Цены комплектов — только из базы. Никогда не выдумывай и не считай сам.

Жёсткое правило: никаких медицинских рекомендаций. При вопросе о лекарствах, болезнях, беременности, давлении — отвечай только фиксированной фразой о консультации врача.

База знаний:
${knowledgeBase}`;
}

const sessions = new Map();

function getSession(sessionId) {
  const id = sessionId || randomUUID();
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      messages: [{ role: 'assistant', content: buildGreeting() }],
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
    if (now - session.updatedAt > 60 * 60 * 1000) sessions.delete(id);
  }
}, 60 * 1000).unref();

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

  if (last.includes('зовут') || last.includes('имя')) {
    return 'Я консультант «Северного чая». Подсказать по составу, свойствам или выбору сбора?';
  }
  if (last.includes('робот') || last.includes('нейросет') || last.includes('искусствен') || last.includes('человек')) {
    return 'Я AI-ассистент «Северного чая», временно подменяю консультанта проекта. Подсказать по травам?';
  }
  if (last.includes('тебе лет') || last.includes('сколько лет')) {
    return 'У AI-ассистента возраста нет 🙂 Зато травы знаю досконально. Подсказать сбор под утро или под вечер?';
  }
  if (last.includes('город') || last.includes('живёшь') || last.includes('живешь')) {
    return 'Я работаю на сервере, а травы для наших сборов собирают в северных регионах.';
  }

  if (last.includes('комплект') || last.includes('набор') || last.includes('каталог')) {
    const list = KITS.map(k => `«${k.name}» — ${k.price} ₽`).join(', ');
    return `В каталоге готовые комплекты: ${list}. Нажмите «Купить», чтобы посмотреть.`;
  }
  if (last.includes('утро') || last.includes('бодр')) { const k = findKit(/утр|тонус|бодр/); if (k) return kitLine(k); }
  if (last.includes('вечер') || last.includes('сон') || last.includes('расслаб')) { const k = findKit(/вечер|сон|расслаб|успок/); if (k) return kitLine(k); }
  if (last.includes('таёж') || last.includes('таеж') || last.includes('согрев')) { const k = findKit(/согрев|таёж|таеж/); if (k) return kitLine(k); }
  if (last.includes('ягод')) { const k = findKit(/ягод/); if (k) return kitLine(k); }

  if (last.includes('сочета') || last.includes('вместе')) {
    const combos = KITS.map(k => `${k.name}: ${k.composition} — ${k.purpose}`).join('; ');
    return 'Проверенные сочетания из базы: ' + combos + '.';
  }
  if (last.includes('грамм') || last.includes('вес')) {
    const lines = KITS.map(k => `«${k.name}» — ${kitWeight(k)} г`).join(', ');
    return 'Вес комплектов: ' + lines + '. Граммовка каждой травы указана в описании.';
  }
  if (last.includes('конструктор') || last.includes('отдельн') || last.includes('самому')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return 'Сейчас продаются только готовые комплекты: ' + list + '. Подсказать, какой подойдёт?';
  }

  return 'Демо-режим: ключ LLM не подключён.';
}

async function askLLM(history) {
  const apiKey = process.env.LLM_API_KEY;
  const useMock = process.env.MOCK_MODE === '1' || (!apiKey && process.env.MOCK_MODE !== '0');
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
    assistantName: active.name,       // для шапки виджета
    assistantAvatar: active.avatar,   // для аватарки
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

  if (isMedical(userMessage)) {
    session.messages.push({ role: 'assistant', content: FIXED_MEDICAL });
    return res.json({ reply: FIXED_MEDICAL, medical: true });
  }

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
  const result = { bitrix: 'not configured', unisender: 'not configured' };

  if (process.env.BITRIX_WEBHOOK_URL) {
    try {
      const response = await fetch(process.env.BITRIX_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            TITLE: 'Заявка «Северный чай» MVP',
            NAME: lead.name || '',
            COMMENTS: lead.comment || '',
            EMAIL: lead.email ? [{ VALUE: lead.email, VALUE_TYPE: 'WORK' }] : [],
            PHONE: lead.phone ? [{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }] : []
          }
        })
      });
      result.bitrix = response.ok ? 'ok' : `error ${response.status}`;
    } catch { result.bitrix = 'error'; }
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
    } catch { result.unisender = 'error'; }
  } else if (!lead.email) {
    result.unisender = 'no email';
  }

  console.log('LEAD', lead, result);
  return res.json({ ok: true, result });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`MVP запущен: http://localhost:${PORT}`);
});
