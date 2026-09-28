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

const PRICE_REDIRECT =
  'Цена и условия заказа указаны в каталоге на сайте. Нажмите кнопку «Купить» в окне чата — там актуальные цены и оформление заказа.';

// ===== Комплекты только из базы знаний =====
function parseKitsFromKnowledge(md) {
  const kits = [];
  const re = /Комплект\s*\d+\s*«([^»]+)»([\s\S]*?)(?=Комплект\s*\d+\s*«|Конструктор|$)/g;
  let m;
  while ((m = re.exec(String(md))) !== null) {
    const block = m[2];
    const composition = (block.match(/Состав:\s*([^\n]+)/) || [])[1];
    const purpose = (block.match(/Назначение:\s*([^\n]+)/) || [])[1];
    const priceMatch = block.match(/—\s*(\d+)\s*₽/);
    kits.push({
      name: m[1].trim(),
      price: priceMatch ? Number(priceMatch[1]) : 0,
      composition: (composition || 'см. каталог').trim(),
      purpose: (purpose || '').trim()
    });
  }
  return kits;
}

const KITS = parseKitsFromKnowledge(knowledgeBase);
if (KITS.length === 0) {
  console.warn('ВНИМАНИЕ: в knowledge.md не найдено ни одного комплекта — проверьте заголовки "Комплект N «Название»"');
}

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

// Приветствие — для первого сообщения в виджете (НЕ сохраняется в историю)
function buildGreeting() {
  return 'Здравствуйте! Я консультант «Северного чая». ' +
    'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?';
}

// Системный промпт — естественный диалог, без повторных приветствий
function buildSystemPrompt(assistant) {
  return `Ты — AI-ассистент интернет-магазина «Северный чай». Отвечай только на русском, коротко и естественно.
Ты временно подменяешь консультанта проекта. В диалоге представляйся просто «консультант», имя сотрудника никогда не называй.

СВЕТСКИЕ ФРАЗЫ И ПРИВЕТСТВИЯ:
- Если пользователь пишет «привет», «здравствуйте», «добрый день» БЕЗ вопроса — кратко ответь: «Чем могу помочь?» или «Подсказать по сборам?»
- Если пользователь спрашивает «как дела?», «как настроение?» — ответь по-человечески: «Спасибо, всё отлично! Готов помочь с травами. Что интересует?» или «Работаю с удовольствием 🙂 Рассказать про комплекты?»
- Если пользователь пишет «точно?», «серьёзно?», «правда?» — подтверди кратко: «Да, всё верно!» или «Абсолютно!» и спроси, чем помочь дальше.
- НИКОГДА не повторяй длинное представление «Здравствуйте! Я консультант...» после первого сообщения. Ты уже поздоровался.

ЦЕНЫ — ЖЁСТКИЙ ЗАПРЕТ:
- С ценами вы можете ознакомиться в каталоге. Никогда не называй, не угадывай и не выдумывай цены, скидки и стоимость доставки.
- На любой вопрос о цене («сколько стоит?», «какая цена?») отвечай: цена и условия заказа указаны в каталоге на сайте, нажмите кнопку «Купить» в окне чата.
- Граммовку отдельных трав не называй. Общий вес любого комплекта — 100 г.

ПАМЯТЬ И КОНТЕКСТ:
- Помнишь предыдущие вопросы пользователя из истории диалога.
- Если спрашивают «что я спрашивал?», «о чём мы говорили?» — кратко перечисли предыдущие вопросы.
- Если спрашивают «что нового?» — расскажи про комплекты из базы, не говори «нет изменений».

СТИЛЬ ОТВЕТОВ:
- Дружелюбный, экспертный, краткий, естественный.
- Отвечай простым текстом: без звёздочек, решёток и нумерованных списков.
- Если информации нет в базе — так и говори: «Информации об этом в базе пока нет».
- Не придумывай свойства, эффекты или цифры, которых нет в базе.

КТО ТЫ (отвечай коротко):
- «Как тебя зовут?» → «Я консультант «Северного чая». Подсказать по сборам?»
- «Ты робот? / ты ИИ?» → «Я AI-ассистент, временно подменяю консультанта. Подсказать по травам?»
- «Сколько тебе лет?» → «У AI возраста нет 🙂 Зато травы знаю. Подсказать сбор?»
- «Из какого ты города?» → «Работаю на сервере, травы собирают в северных регионах.»

ЗАПРЕЩЕНО: называть имя сотрудника, утверждать что ты человек, здороваться повторно длинным шаблоном, называть цены.

ЗАДАЧА: консультировать по готовым травяным комплектам (состав, свойства, сочетаемость, выбор).
Продаются только готовые комплекты из базы. Конструктора и трав по отдельности нет.
Цены — только в каталоге. Никогда не выдумывай.

МЕДИЦИНСКИЕ ВОПРОСЫ: никаких рекомендаций. При вопросе о лекарствах, болезнях, беременности, давлении — отвечай только фиксированной фразой о консультации врача.

База знаний:
${knowledgeBase}`;
}

const sessions = new Map();

function getSession(sessionId) {
  const id = sessionId || randomUUID();
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      messages: [], // ПУСТОЙ массив — приветствие НЕ в истории
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

function kitLine(k) {
  return `Комплект «${k.name}», 100 г: ${k.composition}. ${k.purpose}`;
}
function findKit(re) {
  return KITS.find(k => re.test((k.name + ' ' + k.purpose).toLowerCase()));
}

function mockReply(history) {
  const last = history[history.length - 1]?.content?.toLowerCase() || '';

  // Светские фразы
  if (/^(привет|здравствуй|добрый|хай|hello|hi)[\s!?.]*$/i.test(last)) {
    return 'Здравствуйте! Чем могу помочь?';
  }
  if (/(как дела|как настроение|как ты)/.test(last)) {
    return 'Спасибо, всё отлично! Готов помочь с травами. Что интересует?';
  }
  if (/^(точно|серьёзно|серьезно|правда|да\?)[\s!?.]*$/i.test(last)) {
    return 'Да, всё верно! Подсказать по сборам?';
  }

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
  if (/(цена|стоим|стои|прайс|рубл|сколько стоит)/.test(last)) {
    return PRICE_REDIRECT;
  }
  if (last.includes('что нового') || last.includes('новости') || last.includes('изменилось')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return 'Сейчас в ассортименте: ' + list + '. Рассказать подробнее о любом?';
  }
  if (last.includes('что я спрашивал') || last.includes('о чём мы говорили') || last.includes('о чем мы говорили')) {
    const userQuestions = history.filter(m => m.role === 'user').map(m => m.content);
    if (userQuestions.length > 1) {
      return 'Вы спрашивали: ' + userQuestions.slice(0, -1).join('; ') + '.';
    }
    return 'Это ваш первый вопрос в нашем диалоге.';
  }

  if (last.includes('комплект') || last.includes('набор') || last.includes('каталог')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return `В каталоге готовые комплекты: ${list}. Цены и заказ — по кнопке «Купить».`;
  }
  if (last.includes('утро') || last.includes('бодр')) { const k = findKit(/утр|тонус|бодр|энерг/); if (k) return kitLine(k); }
  if (last.includes('вечер') || last.includes('сон') || last.includes('расслаб')) { const k = findKit(/вечер|сон|расслаб|успок/); if (k) return kitLine(k); }
  if (last.includes('таёж') || last.includes('таеж') || last.includes('согрев') || last.includes('иммун')) { const k = findKit(/иммун|таёж|таеж|согрев/); if (k) return kitLine(k); }
  if (last.includes('женщ') || last.includes('девуш')) { const k = findKit(/женск/); if (k) return kitLine(k); }

  if (last.includes('сочета') || last.includes('вместе')) {
    const combos = KITS.map(k => `${k.name}: ${k.composition} — ${k.purpose}`).join('; ');
    return 'Проверенные сочетания из базы: ' + combos + '.';
  }
  if (last.includes('грамм') || last.includes('вес')) {
    return 'Каждый комплект — 100 г. Граммовка отдельных трав не раскрывается — это интеллектуальная собственность производителя.';
  }
  if (last.includes('конструктор') || last.includes('отдельн') || last.includes('самому')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return 'Сейчас продаются только готовые комплекты: ' + list + '. Подсказать, какой подойдёт?';
  }

  return 'Извините, не совсем понял вопрос. Подсказать по составу, свойствам или выбору комплекта?';
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
          ...history.slice(-12)
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
    assistantName: active.name,
    assistantAvatar: active.avatar,
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
