/*
  Виджет «Северный чай».
  Подключение:
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
    console.log('NC Widget: не задан apiUrl');
    return;
  }

  var style = document.createElement('style');
  style.textContent = [
    '#nc-launcher{position:fixed;right:18px;bottom:18px;width:58px;height:58px;border-radius:999px;border:none;background:#0f766e;color:#fff;font-size:26px;line-height:1;cursor:pointer;z-index:99998;display:none;box-shadow:0 12px 35px rgba(0,0,0,.22)}',
    '#nc-widget{position:fixed;right:18px;bottom:88px;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 110px);background:#fff;border:1px solid #e5e7eb;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.18);display:none;flex-direction:column;overflow:hidden;z-index:99999;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px;color:#111827;text-align:left}',
    '#nc-widget *{box-sizing:border-box}',
    '#nc-widget .nc-header{background:#0f766e;color:#fff;padding:12px 14px;display:flex;align-items:center;gap:10px}',
    '#nc-widget .nc-avatar{width:38px;height:38px;border-radius:999px;background:#fff;color:#0f766e;font-weight:800;display:flex;align-items:center;justify-content:center;flex:0 0 auto;overflow:hidden}',
    '#nc-widget .nc-avatar img{width:100%;height:100%;object-fit:cover;border-radius:999px;display:block}',
    '#nc-widget .nc-name{font-weight:700}',
    '#nc-widget .nc-status{font-size:12px;opacity:.9}',
    '#nc-widget .nc-close{margin-left:auto;border:none;background:transparent;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px}',
    '#nc-widget .nc-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:9px;background:#f8fafc}',
    '#nc-widget .nc-msg{max-width:84%;padding:9px 11px;border-radius:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;font-size:14px}',
    '#nc-widget .nc-user{align-self:flex-end;background:#0f766e;color:#fff;border-bottom-right-radius:4px}',
    '#nc-widget .nc-bot{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}',
    '#nc-widget .nc-order{display:block;margin:10px 12px;padding:11px 12px;border-radius:12px;background:#f59e0b;color:#111827;text-align:center;font-weight:800;text-decoration:none}',
    '#nc-widget .nc-input{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb;background:#fff}',
    '#nc-widget .nc-input input{flex:1;padding:11px 12px;border:1px solid #d1d5db;border-radius:10px;outline:none;font:inherit}',
    '#nc-widget .nc-input button{padding:11px 14px;border:none;border-radius:10px;background:#0f766e;color:#fff;font-size:18px;cursor:pointer}',
    '@media(max-width:480px){#nc-widget{right:12px;left:12px;width:auto;bottom:80px;height:68vh}}'
  ].join('');
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.innerHTML =
    '<button id="nc-launcher" aria-label="Открыть консультанта">💬</button>' +
    '<div id="nc-widget" role="dialog" aria-label="Консультант Северный чай">' +
      '<div class="nc-header">' +
        '<div class="nc-avatar" id="nc-avatar">А</div>' +
        '<div>' +
          '<div class="nc-name" id="nc-name">Анна</div>' +
          '<div class="nc-status">онлайн</div>' +
        '</div>' +
        '<button class="nc-close" id="nc-close" aria-label="Закрыть">×</button>' +
      '</div>' +
      '<div class="nc-messages" id="nc-messages"></div>' +
      '<a class="nc-order" id="nc-order" href="#">Купить</a>' +
      '<div class="nc-input">' +
        '<input id="nc-input" placeholder="Спросите про состав, свойства или выбор..." />' +
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
    launcher.style.display = 'block';

    if (messagesEl.children.length === 0) {
      addMessage('bot', window.__nc_greeting ||
        'Здравствуйте! Я консультант «Северного чая». ' +
        'Подсказать по составу, свойствам, сочетаемости трав или выбору комплекта?');
    }
    inputEl.focus();
  }

  fetch(API_URL + '/api/config')
    .then(function (r) { return r.json(); })
    .then(function (sc) {
      // Имя и фото в шапке — из конфига сервера
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
        launcher.style.display = 'block';
        openWidget();
      }, delay);
    })
    .catch(function () {
      console.log('NC Widget: сервер недоступен');
    });

  launcher.addEventListener('click', openWidget);
  closeBtn.addEventListener('click', function () { widget.style.display = 'none'; });

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
