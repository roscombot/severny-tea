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

const VK_URL = 'https://vk.ru/zhizn_dolgoletie_energiya_cel';

const knowledgeBase = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'knowledge.md'), 'utf8');
  } catch {
    return 'База знаний пока не загружена.';
  }
})();

// Медицинский ответ — с редиректом в ВК (автор проекта)
const FIXED_MEDICAL =
  'По вопросам приёма лекарств, совместимости с препаратами и влияния на заболевания я не могу давать рекомендации. ' +
  'Пожалуйста, проконсультируйтесь с лечащим врачом.\n\n' +
  'Для индивидуальной консультации с автором проекта напишите в ВК: ' + VK_URL;

const PRICE_REDIRECT =
  'Цена и условия заказа указаны в каталоге на сайте. Нажмите кнопку «Купить» в окне чата.';

const NO_UNDERSTAND_REPLY =
  'Не совсем понял ваш вопрос. Уточните, пожалуйста: интересует состав, свойства, выбор комплекта или что-то ещё?';

const WEIGHT_NOTE =
  (knowledgeBase.match(/Каждый комплект[^\n]*/) || [''])[0] ||
  'Информации об этом в базе пока нет.';

const HERB_NAMES = [
  'иван-чай', 'кипрей', 'душица', 'смородина', 'малина', 'брусника', 'пихта',
  'клевер', 'родиола', 'элеутерококк', 'левзея', 'хмель', 'таволга', 'солодка', 'чага'
];

// ===== Разбор базы на секции =====
const BASE_PARSED = (() => {
  const headerRe = /^(#{1,6}\s*.+|Цены конструктора.*|Эффекты и польза трав|Сочетаемость трав|Правила конструктора.*|Ассортимент: готовые комплекты|Конструктор «[^»]+»|Доставка и оплата|Частые вопросы|Дополнительные частые вопросы по комплектам:|Для «[^»]+»:|Комплект \d+ «[^»]+»)$/;
  const sections = [];
  let cur = { title: '(начало)', lines: [] };
  for (const raw of String(knowledgeBase).split('\n')) {
    const line = raw.trim();
    if (headerRe.test(line)) {
      sections.push({ title: cur.title.replace(/^#+\s*/, ''), body: cur.lines.join('\n').trim() });
      cur = { title: line.replace(/^#+\s*/, ''), lines: [] };
    } else {
      cur.lines.push(raw);
    }
  }
  sections.push({ title: cur.title.replace(/^#+\s*/, ''), body: cur.lines.join('\n').trim() });
  return sections.filter(s => s.body);
})();

// Справочные разделы — всегда в промпте
const CORE_TEXT = BASE_PARSED
  .filter(s => /Правила ответов|Цены конструктора|Сочетаемость|Правила конструктора|Конструктор «|Доставка и оплата|Частые вопросы|Дополнительные частые|^Для «/.test(s.title))
  .map(s => s.title + '\n' + s.body)
  .join('\n\n');

const KIT_SECTIONS = BASE_PARSED.filter(s => /^Комплект \d/.test(s.title));

const HERB_PARAS = (BASE_PARSED.find(s => /Эффекты и польза трав/.test(s.title)) || { body: '' })
  .body.split('\n').map(s => s.trim()).filter(s => s.length > 40);

// ===== Парсер коротких карточек комплектов =====
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

// Ключевые слова для каждого комплекта (для селективного контекста)
const KIT_KEYS = [
  ['энерг', 'утр', 'бодр', 'работоспособ', 'кофеин'],
  ['сон', 'вечер', 'расслаб', 'засн', 'бессон'],
  ['иммун', 'таёж', 'таеж', 'чага', 'согрев', 'простуд', 'орви'],
  ['женщ', 'девуш', 'климакс', 'менопауз', 'месячн', 'прилив']
];

// Селективный контекст: в промпт идут только релевантные куски базы
function buildBaseContext(history) {
  const q = history.slice(-3).map(m => m.content).join(' ').toLowerCase();
  const parts = ['=== СПРАВОЧНЫЕ РАЗДЕЛЫ БАЗЫ ===', CORE_TEXT];

  const herbs = HERB_NAMES.filter(h => q.includes(h));

  const chosenKits = KIT_SECTIONS.filter((s, i) => {
    const keys = KIT_KEYS[i] || [];
    const name = s.title.toLowerCase().replace(/комплект\s*\d+\s*/, '').replace(/«|»/g, '');
    return keys.some(k => q.includes(k)) || q.includes(name);
  });
  const extraKits = KIT_SECTIONS.filter(
    s => !chosenKits.includes(s) && herbs.some(h => s.body.toLowerCase().includes(h))
  );
  const kits = [...chosenKits, ...extraKits];

  const chosenHerbs = HERB_PARAS.filter(p => {
    const pl = p.toLowerCase();
    return herbs.some(h => pl.includes(h));
  });

  if (kits.length) {
    parts.push('=== КОМПЛЕКТЫ ===', kits.map(s => s.title + '\n' + s.body).join('\n\n'));
  }
  if (chosenHerbs.length) {
    parts.push('=== ТРАВЫ ===', chosenHerbs.slice(0, 4).join('\n\n'));
  }
  if (!kits.length && !chosenHerbs.length) {
    parts.push(
      '=== КОМПЛЕКТЫ (КРАТКО) ===',
      KITS.map(k => `«${k.name}» — ${k.purpose} Состав: ${k.composition}`).join('\n')
    );
  }
  return parts.join('\n\n');
}

function sanitizeReply(text) {
  let clean = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '- ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();

  // Блок выдуманных цен (но пропускаем, если в ответе уже "Цены указаны в каталоге")
  if (/\d+\s*(руб|рубл|₽|рублей|rub)/i.test(clean) && !clean.includes('Цены указаны в каталоге')) {
    return PRICE_REDIRECT;
  }
  return clean;
}

// Проверка языка: сколько кириллицы в тексте
function cyrillicRatio(text) {
  const letters = String(text).replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  if (!letters.length) return 1;
  const cyr = (String(text).match(/[а-яА-ЯёЁ]/g) || []).length;
  return cyr / letters.length;
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

function findHerbInText(text) {
  const t = String(text).toLowerCase();
  return HERB_NAMES.find(h => t.includes(h)) || null;
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

function buildSystemPrompt(context) {
  return `Ты — AI-ассистент интернет-магазина «Северный чай». В диалоге представляйся просто «консультант», имя сотрудника никогда не называй.

ЯЗЫК: отвечай ТОЛЬКО на русском языке. Другой язык — только если пользователь прямо попросит ответить на нём.

ПОРЯДОК ОТВЕТА:
1. Используй ТОЛЬКО выдержку из базы знаний ниже.
2. Не добавляй собственные знания, цифры, цены, свойства, составы.
3. Если факта нет в выдержке — отвечай: «Информации об этом в базе пока нет.»
4. Отвечай коротко: 1-3 предложения. Состав, заваривание, эффекты — только по прямому вопросу.
5. Не повторяй приветствие после первого сообщения и не добавляй «если есть вопросы...» в конце.
6. Если вопрос пользователя совсем не про чай, травы или комплекты — вежливо скажи, что отвечаешь только по ассортименту магазина.

ПОВЕДЕНИЕ:
- «привет» без вопроса → «Чем могу помочь?»
- «как дела?» → «Спасибо, всё отлично! Что интересует?»
- «точно?», «правда?» → «Да, всё верно!»
- «что есть в наличии?» → перечисли комплекты из выдержки.
- Травы отдельно НЕ продаются — только готовые комплекты. Если спрашивают траву — расскажи её роль в напитке по базе и укажи, в какой комплект она входит.
- Цены НЕ называй никогда: «Цены указаны в каталоге, нажмите «Купить».»
- Если пользователь говорит «первый», «второй» — уточни название, не угадывай.
- Если пользователь поправляет тебя — сразу дай верный ответ без извинений и повторов.
- Медицинские темы — только справочно по базе, обязательно добавь «Этот чай не является заменой медицинской терапии» и посоветуй консультацию с врачом или автором проекта в ВК.

КТО ТЫ:
- «Как зовут?» → «Я консультант «Северного чая».»
- «Ты робот?» → «Я AI-ассистент, временно подменяю консультанта.»
- «Сколько лет?» → «У AI возраста нет 🙂»

ЗАПРЕЩЕНО: называть имя сотрудника, утверждать что ты человек, называть цены, выдумывать свойства, писать на других языках без просьбы, обсуждать темы вне ассортимента магазина.

ВЫДЕРЖКА ИЗ БАЗЫ ЗНАНИЙ:
${context}`;
}

const sessions = new Map();

function getSession(sessionId) {
  const id = sessionId || randomUUID();
  if (!sessions.has(id)) {
    sessions.set(id, { id, messages: [], updatedAt: Date.now() });
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
  return `«${k.name}» — ${k.purpose}`;
}

function findKit(re) {
  return KITS.find(k => re.test((k.name + ' ' + k.purpose).toLowerCase()));
}

function findKitFromHistory(history) {
  const ctx = history.slice(-4).map(m => m.content).join(' ').toLowerCase();
  return KITS.find(k => ctx.includes(k.name.toLowerCase()));
}

function mockReply(history) {
  const last = history[history.length - 1]?.content?.toLowerCase() || '';

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
  if (/(цена|стоим|стои|прайс|рубл|сколько стоит|не дорог|бюджет)/.test(last)) {
    return PRICE_REDIRECT;
  }
  if (last.includes('наличи') || last.includes('что есть') || last.includes('ассортимент')) {
    const list = KITS.map(k => `«${k.name}»`).join(', ');
    return `В наличии готовые комплекты: ${list}. Рассказать подробнее о любом?`;
  }
  if (/(состав|из чего|компонент|ингредиент)/.test(last)) {
    const k = findKitFromHistory(history);
    if (k && k.composition) return `Состав «${k.name}»: ${k.composition}.`;
    return 'Уточните, какой комплект вас интересует?';
  }
  if (/(заварив|приготов|как делать|сколько минут|как готовить)/.test(last)) {
    const k = findKitFromHistory(history);
    if (k && k.brew) return `«${k.name}»: ${k.brew}`;
    return 'Уточните, какой комплект вас интересует?';
  }
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

  return NO_UNDERSTAND_REPLY;
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
          { role: 'system', content: buildSystemPrompt(buildBaseContext(history)) },
          ...history.slice(-8)
        ],
        temperature: 0.2,
        max_tokens: 600
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API ${response.status}: ${errorText.slice(0, 300)}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content || content.length < 5) {
      return NO_UNDERSTAND_REPLY;
    }
    return content;
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
    greeting: buildGreeting(),
    vkUrl: VK_URL
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

  // Медицинский вопрос → фиксированный ответ с редиректом в ВК
  if (isMedical(userMessage)) {
    session.messages.push({ role: 'assistant', content: FIXED_MEDICAL });
    return res.json({ reply: FIXED_MEDICAL, medical: true });
  }

  // Твёрдый guard: трава + вопрос о покупке/наличии → только комплекты
  const herb = findHerbInText(userMessage);
  if (herb && /(есть|наличи|купить|продаё|продае|отдельн)/.test(userMessage.toLowerCase())) {
    const kitsWithHerb = KITS.filter(k => k.composition.toLowerCase().includes(herb));
    const reply = kitsWithHerb.length
      ? `Отдельно травы не продаются — только готовые комплекты. «${herb[0].toUpperCase() + herb.slice(1)}» входит в: ${kitsWithHerb.map(k => `«${k.name}»`).join(', ')}.`
      : 'Отдельно травы не продаются — только готовые комплекты. Подсказать, какой подойдёт?';
    session.messages.push({ role: 'assistant', content: reply });
    return res.json({ reply });
  }

  try {
    let reply = sanitizeReply(await askLLM(session.messages));

    // Если ответ пустой или слишком короткий — fallback
    if (!reply || reply.length < 5) {
      reply = NO_UNDERSTAND_REPLY;
    }

    // Языковой замок: пользователь по-русски, ответ не по-русски → подмена
    if (cyrillicRatio(userMessage) > 0.5 && cyrillicRatio(reply) < 0.4) {
      reply = 'Я отвечаю только на русском языке. Напишите вопрос, пожалуйста, по-русски.';
    }

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
