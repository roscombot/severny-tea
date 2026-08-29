/*
  Виджет «Северный чай» в стиле basyes.ru/tea.
  Подключение на сайте (перед </body>):

  <script>
    window.NC_WIDGET_CONFIG = {
      apiUrl: location.origin,
      catalogUrl: '#5',
      delayMs: 180000
    };
  </script>
  <script src="/widget.js" defer></script>
*/
(function () {
  'use strict';

  if (document.getElementById('nc-widget')) return;

  var cfg = window.NC_WIDGET_CONFIG || {};
  var API_URL = String(cfg.apiUrl || '').replace(/\/+$/, '');
  var CATALOG_URL = cfg.catalogUrl || '#catalog';
  var DELAY_MS = cfg.delayMs != null ? Number(cfg.delayMs) : null;

  if (!API_URL) {
    console.log('NC Widget: не задан apiUrl в NC_WIDGET_CONFIG');
    return;
  }

  var style = document.createElement('style');
  style.textContent = [
    '#nc-launcher{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:999px;border:1px solid rgba(201,160,108,.55);background:#0d1412;cursor:pointer;z-index:99998;display:none;align-items:center;justify-content:center;box-shadow:0 14px 40px rgba(0,0,0,.45)}',
    '#nc-launcher svg{width:26px;height:26px;fill:none;stroke:#c9a06c;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}',
    '#nc-widget{position:fixed;right:20px;bottom:92px;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 110px);background:#0f1513;border:1px solid #26332d;border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.5);display:none;flex-direction:column;overflow:hidden;z-index:99999;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px;color:#eef4ef;text-align:left}',
    '#nc-widget *{box-sizing:border-box}',
    '#nc-widget .nc-header{padding:14px 16px;border-bottom:1px solid #26332d;display:flex;align-items:center;gap:12px;background:linear-gradient(180deg,#121a17,#0f1513)}',
    '#nc-widget .nc-avatar{width:40px;height:40px;border-radius:999px;background:#16211c;border:1px solid rgba(201,160,108,.6);color:#c9a06c;font-weight:700;display:flex;align-items:center;justify-content:center;flex:0 0 auto;overflow:hidden}',
    '#nc-widget .nc-avatar img{width:100%;height:100%;object-fit:cover;border-radius:999px;display:block}',
    '#nc-widget .nc-brand{font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:#c9a06c;margin-bottom:2px}',
    '#nc-widget .nc-name{font-weight:600;font-size:14px;color:#f2ede2;line-height:1.2}',
    '#nc-widget .nc-status{font-size:10px;color:#7fa092;letter-spacing:.12em;text-transform:uppercase}',
    '#nc-widget .nc-kanji{margin-left:auto;font-size:18px;color:rgba(201,160,108,.5);line-height:1}',
    '#nc-widget .nc-close{margin-left:8px;border:none;background:transparent;color:#7fa092;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}',
    '#nc-widget .nc-close:hover{color:#c9a06c}',
    '#nc-widget .nc-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:9px;background:#0f1513}',
    '#nc-widget .nc-msg{max-width:84%;padding:10px 12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;font-size:13.5px}',
    '#nc-widget .nc-user{align-self:flex-end;background:#c9a06c;color:#181207;border-radius:14px 14px 4px 14px}',
    '#nc-widget .nc-bot{align-self:flex-start;background:#16211c;border:1px solid #26332d;color:#e7efe9;border-radius:14px 14px 14px 4px}',
    '#nc-widget .nc-order{display:block;margin:10px 14px;padding:12px;border-radius:12px;background:#c9a06c;color:#181207;text-align:center;font-weight:700;font-size:12px;letter-spacing:.16em;text-transform:uppercase;text-decoration:none}',
    '#nc-widget .nc-order:hover{background:#d8b07c}',
    '#nc-widget .nc-input{display:flex;gap:8px;padding:12px;border-top:1px solid #26332d;background:#0f1513}',
    '#nc-widget .nc-input input{flex:1;padding:11px 12px;background:#16211c;border:1px solid #26332d;border-radius:10px;outline:none;font:inherit;font-size:13px;color:#eef4ef}',
    '#nc-widget .nc-input input::placeholder{color:#5f7a6e}',
    '#nc-widget .nc-input input:focus{border-color:rgba(201,160,108,.5)}',
    '#nc-widget .nc-input button{padding:11px 14px;border:none;border-radius:10px;background:#c9a06c;color:#181207;font-size:16px;cursor:pointer}',
    '#nc-widget .nc-input button:hover{background:#d8b07c}',
    '@media(max-width:480px){#nc-widget{right:12px;left:12px;width:auto;bottom:88px;height:68vh}}'
  ].join('');
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.innerHTML =
    '<button id="nc-launcher" aria-label="Открыть консультанта">' +
      '<svg viewBox="0 0 24 24"><path d="M20 4C10.5 4.5 4.5 10.5 4 20c0 0 2.5 1 5.5 0C17 17.5 20 12 20 4z"/><path d="M4 20C8 12.5 13.5 8 20 4"/></svg>' +
    '</button>' +
    '<div id="nc-widget" role="dialog" aria-label="Консультант Северный чай">' +
      '<div class="nc-header">' +
        '<div class="nc-avatar" id="nc-avatar">А</div>' +
        '<div>' +
          '<div class="nc-brand">Basyes • Северный чай</div>' +
          '<div class="nc-name" id="nc-name">Анна</div>' +
          '<div class="nc-status">онлайн</div>' +
        '</div>' +
        '<div class="nc-kanji">茶</div>' +
        '<button class="nc-close" id="nc-close" aria-label="Закрыть">×</button>' +
      '</div>' +
      '<div class="nc-messages" id="nc-messages"></div>' +
      '<a class="nc-order" id="nc-order" href="#">Купить</a>' +
      '<div class="nc-input">' +
        '<input id="nc-input" placeholder="Спросите про сборы, свойства, подбор..." />' +
        '<button id="nc-send" title="Отправить">➤</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  var launcher = document.getElementById('nc-launcher');
  var widget = document.getElementById('nc-widget');
  var messagesEl = document.getElementById('nc-messages');
  var inputEl = document.getElementById('nc-input');
  var sendBtn = document.getElementById('nc-send');
  var closeBtn = document.getElementById('nc-close');
  var nameEl = document.getElementById('nc-name');
  var avatarEl = document.getElementById('nc-avatar');
  var orderBtn = document.getElementById('nc-order');

  var sessionId = sessionStorage.getItem('nc-session');
  if (!sessionId) {
    sessionId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    sessionStorage.setItem('nc-session', sessionId);
  }

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'nc-msg ' + (role === 'user' ? 'nc-user' : 'nc-bot');
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function sendMessage(text) {
    text = (text || '').trim();
    if (!text) return;

    addMessage('user', text);
    var typing = addMessage('bot', '...');

    fetch(API_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, message: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.textContent = data.reply || 'Не удалось получить ответ.';
      })
      .catch(function () {
        typing.textContent = 'Не получилось связаться с консультантом. Попробуйте ещё раз.';
      });
  }

  function openWidget() {
    widget.style.display = 'flex';
    launcher.style.display = 'flex';

    // Приветствие — каждый раз, когда диалог пуст (имя из конфига: Анна или Павел)
    if (messagesEl.children.length === 0) {
      var name = nameEl.textContent || 'консультант';
      addMessage('bot', window.__nc_greeting ||
        ('Здравствуйте! Я консультант «Северного чая». ' +
         'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?'));
    }

    inputEl.focus();
  }

  fetch(API_URL + '/api/config')
    .then(function (r) { return r.json(); })
    .then(function (sc) {
      nameEl.textContent = sc.assistantName || 'Анна';

      if (sc.assistantAvatar) {
        var initial = (sc.assistantName || 'А').charAt(0).toUpperCase();
        avatarEl.textContent = '';
        var img = document.createElement('img');
        img.src = API_URL + sc.assistantAvatar;
        img.alt = sc.assistantName || 'Консультант';
        img.onerror = function () {
          img.remove();
          avatarEl.textContent = initial;
        };
        avatarEl.appendChild(img);
      }

      if (sc.greeting) window.__nc_greeting = sc.greeting;

      var delay = DELAY_MS != null ? DELAY_MS : Number(sc.widgetDelayMs || 180000);
      setTimeout(function () {
        launcher.style.display = 'flex';
        openWidget();
      }, delay);
    })
    .catch(function () {
      console.log('NC Widget: сервер недоступен');
    });

  launcher.addEventListener('click', openWidget);

  closeBtn.addEventListener('click', function () {
    widget.style.display = 'none';
  });

  // «Купить»: виджет закрывается, страница плавно уходит к каталогу
  orderBtn.addEventListener('click', function (event) {
    event.preventDefault();
    widget.style.display = 'none';

    if (CATALOG_URL.charAt(0) === '#') {
      location.hash = CATALOG_URL;
      var anchor = CATALOG_URL.slice(1);
      var target = document.getElementById(anchor) ||
        document.querySelector('a[name="' + anchor + '"]');
      if (target && target.scrollIntoView) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      location.href = CATALOG_URL;
    }
  });

  sendBtn.addEventListener('click', function () {
    var t = inputEl.value;
    inputEl.value = '';
    sendMessage(t);
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var t = inputEl.value;
      inputEl.value = '';
      sendMessage(t);
    }
  });
})();
