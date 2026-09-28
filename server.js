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
  'Цена и условия заказа указаны в каталоге на сайте. Нажмите кнопку «Купить» в окне чата.';

// Вес комплекта — из базы (раздел «Частые вопросы»)
const WEIGHT_NOTE =
  (knowledgeBase.match(/Каждый комплект[^\n]*/) || [''])[0] ||
  'Информации об этом в базе пока нет.';

// ===== Парсер комплектов из базы =====
function parseKitsFromKnowledge(md) {
  const kits = [];
  const re = /Комплект\s*\d+\s*«([^»]+)»([\s\S]*?)(?=Комплект\s*\d+\s*«|Конструктор|$)/g;
  let m;
  while ((m = re.exec(String(md))) !== null) {
    const block = m[2];
    const composition = (block.match(/Состав:\s*([^\n]+)/) || [])[1];
    const purpose = (block.match(/Назначение:\s*([^\n]+)/) || [])[1];
    const brew = (block.match(/Заваривание:\s*([^\n]+)/) || [])[1];
    kits.push({
      name: m[1].trim(),
      composition: (composition || '').trim(),
      purpose: (purpose || '').trim(),
      brew: (brew || '').trim()
    });
  }
  return kits;
}

const KITS = parseKitsFromKnowledge(knowledgeBase);
if (KITS.length === 0) {
  console.warn('ВНИМАНИЕ: в knowledge.md не найдено комплектов');
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

function buildGreeting() {
  return 'Здравствуйте! Я консультант «Северного чая». ' +
    'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?';
}

function buildSystemPrompt(assistant) {
  return `Ты — AI-ассистент интернет-магазина «Северный чай». Отвечай только на русском, коротко и естественно.
Ты временно подменяешь консультанта проекта. В диалоге представляйся просто «консультант», имя сотрудника никогда не называй.

СВЕТСКИЕ ФРАЗЫ:
- «привет», «здравствуйте» без вопроса → «Чем могу помочь?»
- «как дела?» → «Спасибо, всё отлично! Что интересует?»
- «точно?», «правда?» → «Да, всё верно!»
- НИКОГДА не повторяй длинное представление после первого сообщения.

ЦЕНЫ — ЖЁСТКИЙ ЗАПРЕТ:
- Никогда не называй, не угадывай и не выдумывай цены.
- На вопрос о цене: «Цены указаны в каталоге, нажмите «Купить».»

СТИЛЬ ОТВЕТОВ — КОРОТКО И ПО ДЕЛУ:
- Максимум 2-3 предложения на простой вопрос.
- НЕ выдавай состав, заваривание или эффекты БЕЗ прямого вопроса.
- На «что посоветуешь для вечера?» → ТОЛЬКО: «"Сон и восстановление" — вечерний ритуал расслабления.»
- Состав выдавай только если спрашивают «из чего?», «состав?», «компоненты?».
- Заваривание выдавай только если спрашивают «как заваривать?», «как готовить?».
- НЕ добавляй «Если есть вопросы о составе...» — лишнее.
- Не повторяй одну информацию дважды в ответе.

ПАМЯТЬ:
- Если спрашивают «что я спрашивал?» — перечисли предыдущие вопросы.
- Если пользователь говорит «первый», «второй» — уточни название, не угадывай.

КТО ТЫ:
- «Как зовут?» → «Я консультант «Северного чая».»
- «Ты робот?» → «Я AI-ассистент, временно подменяю консультанта.»
- «Сколько лет?» → «У AI возраста нет.»

ЗАПРЕЩЕНО: называть имя сотрудника, утверждать что ты человек, здороваться повторно, называть цены, выдумывать свойства.

База знаний:
${knowledgeBase}`;
}

const sessions = new Map();

function getSession(sessionId) {
  const id = sessionId || randomUUID();
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      messages: [],
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

// КОРОТКАЯ карточка — только название + назначение
function kitLine(k) {
  return `«${k.name}» — ${k.purpose}`;
}

function findKit(re) {
  return KITS.find(k => re.test((k.name + ' ' + k.purpose).toLowerCase()));
}

// Ищет комплект по контексту последних реплик
function findKitFromHistory(history) {
  const ctx = history.slice(-4).map(m => m.content).join(' ').toLowerCase();
  return KITS.find(k => ctx.includes(k.name.toLowerCase()));
}

function mockReply(history) {
  const last = history[history.length - 1]?.content?.toLowerCase() || '';

  // Светские фразы
  if (/^(привет|здравствуй|добрый|хай|hello|hi)[\s!?.]*$/i.test(last)) {
    return 'Здравствуйте! Чем могу помочь?';
  }
  if (/(как дела|как настроение|как ты)/.test(last)) {
    return 'Спасибо, всё отлично! Что интересует?';
  }
  if (/^(точно|серьёзно|серьезно|правда|да\?)[\s!?.]*$/i.test(last)) {
    return 'Да, всё верно!';
  }

  if (last.includes('зовут') || last.includes('имя')) {
    return 'Я консультант «Северного чая».';
  }
  if (last.includes('робот') || last.includes('нейросет') || last.includes('искусствен') || last.includes('человек')) {
    return 'Я AI-ассистент, временно подменяю консультанта.';
  }
  if (last.includes('тебе лет') || last.includes('сколько лет')) {
    return 'У AI возраста нет 🙂';
  }
  if (last.includes('город') || last.includes('живёшь') || last.includes('живешь')) {
    return 'Работаю на сервере, травы собирают в северных регионах.';
  }

  // Цены
  if (/(цена|стоим|стои|прайс|рубл|сколько стоит|не дорог|бюджет)/.test(last)) {
    return PRICE_REDIRECT;
  }

  // Состав — ТОЛЬКО по прямому запросу
  if (/(состав|из чего|компонент|ингредиент)/.test(last)) {
    const k = findKitFromHistory(history);
    if (k && k.composition) return `Состав «${k.name}»: ${k.composition}.`;
    return 'Уточните, какой комплект вас интересует?';
  }

  // Заваривание — ТОЛЬКО по прямому запросу
  if (/(заварив|приготов|как делать|сколько минут|как готовить)/.test(last)) {
    const k = findKitFromHistory(history);
    if (k && k.brew) return `«${k.name}»: ${k.brew}`;
    return 'Уточните, какой комплект вас интересует?';
  }

  // Граммовка — из базы
  if (last.includes('грамм') || last.includes('вес')) {
    return WEIGHT_NOTE;
  }

  if (last.includes('что нового') || last.includes('новости') || last.includes('изменилось')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return 'В ассортименте: ' + list + '.';
  }
  if (last.includes('что я спрашивал') || last.includes('о чём мы говорили') || last.includes('о чем мы говорили')) {
    const userQuestions = history.filter(m => m.role === 'user').map(m => m.content);
    if (userQuestions.length > 1) {
      return 'Вы спрашивали: ' + userQuestions.slice(0, -1).join('; ') + '.';
    }
    return 'Это ваш первый вопрос.';
  }

  if (last.includes('комплект') || last.includes('набор') || last.includes('каталог')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return `Готовые комплекты: ${list}. Цены — в каталоге.`;
  }

  // Рекомендации — КОРОТКО
  if (last.includes('утро') || last.includes('бодр')) { const k = findKit(/утр|тонус|бодр|энерг/); if (k) return kitLine(k); }
  if (last.includes('вечер') || last.includes('сон') || last.includes('расслаб')) { const k = findKit(/вечер|сон|расслаб|успок/); if (k) return kitLine(k); }
  if (last.includes('таёж') || last.includes('таеж') || last.includes('согрев') || last.includes('иммун')) { const k = findKit(/иммун|таёж|таеж|согрев/); if (k) return kitLine(k); }
  if (last.includes('женщ') || last.includes('девуш')) { const k = findKit(/женск/); if (k) return kitLine(k); }

  if (last.includes('сочета') || last.includes('вместе')) {
    return 'Информация о сочетаемости в базе пока отсутствует.';
  }
  if (last.includes('конструктор') || last.includes('отдельн') || last.includes('самому')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return 'Только готовые комплекты: ' + list + '.';
  }

  return 'Уточните, пожалуйста, вопрос. Подсказать по выбору комплекта?';
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
            TITLE: 'Заявка «Северный чай»',
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
            tags: 'severny-chay'
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
