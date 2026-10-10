/* Лид-магнит «Как снизить смету на 23%»: значок в углу и окно выбора объекта → бот в MAX или Telegram
   присылает PDF за подписку на канал (проект leadmagnet-bot). Подключается на главной и отраслевых страницах:
   <link rel="stylesheet" href="leadmagnet.css"> и <script src="leadmagnet.js" defer></script>.
   Цели Метрики: leadmagnet_open_badge|exit|timer|scroll, leadmagnet_type_<тип>, leadmagnet_go_max|tg. */
(function () {
  // ---- настройки ----
  var LEADMAGNET_ON = true;          // false — значок и окно не показываются
  var BOT_TG = "moidozor_gid_bot";   // ник бота Telegram
  var BOT_MAX = "";                  // ник бота MAX; пусто — кнопка MAX скрыта, только Telegram
  var BADGE_DELAY = 15000;           // значок через 15 секунд
  var EXIT_COOLDOWN_DAYS = 7;        // окно само (при уходе/таймер/прокрутка) — не чаще раза в 7 дней
  var BADGE_HIDE_DAYS = 1;           // значок, скрытый крестиком, — снова через сутки
  var PREVIEW = false;               // true — окно при уходе срабатывает всегда (для проверки)
  var METRIKA = 99939047;

  if (!LEADMAGNET_ON) return;
  var LINKS = {
    tg: function (t) { return "https://t.me/" + BOT_TG + "?start=gid_" + t; },
    max: BOT_MAX ? function (t) { return "https://max.ru/" + BOT_MAX + "?start=gid_" + t; } : null
  };
  var TYPES = [
    { id: "dom", name: "Частный дом", of: "частного дома", cover: "для частного дома", page: "dom",
      icon: '<path d="M4 15 16 5l12 10"/><path d="M7 13v13h18V13"/><path d="M13 26v-7h6v7"/>' },
    { id: "sklad", name: "Склад", of: "склада", cover: "для склада", page: "sklady",
      icon: '<path d="M3 13 16 6l13 7v13H3z"/><path d="M9 26V17h14v9M9 20.5h14"/>' },
    { id: "proizvodstvo", name: "Производство", of: "производства", cover: "для производства", page: "proizvodstvo",
      icon: '<path d="M3 26V14l7 4v-4l7 4v-4l7 4V6h4v20z"/><path d="M8 22h3M14 22h3M20 22h3"/>' },
    { id: "magazin", name: "Магазин или офис", of: "магазина или офиса", cover: "для магазина и офиса", page: "",
      icon: '<path d="M4 12 6 5h20l2 7"/><path d="M4 12c0 2 2 3 4 3s4-1 4-3c0 2 2 3 4 3s4-1 4-3c0 2 2 3 4 3s4-1 4-3"/><path d="M6 15v11h20V15M13 26v-6h6v6"/>' },
    { id: "territoriya", name: "Территория или база", of: "территории", cover: "для территории и базы", page: "territorii",
      icon: '<path d="M5 27V9l2-3 2 3v18M15 27V9l2-3 2 3v18M25 27V9l2-3 2 3v18"/><path d="M3 13h28M3 21h28"/>' },
    { id: "mkd", name: "Многоквартирный дом", of: "многоквартирного дома", cover: "для многоквартирного дома", page: "mkd",
      icon: '<path d="M7 27V5h18v22"/><path d="M4 27h24M11 9h3M18 9h3M11 14h3M18 14h3M11 19h3M18 19h3M14 27v-4h4v4"/>' }
  ];
  var APPS = LINKS.max ? "MAX или Telegram" : "Telegram";

  var logo = '<svg viewBox="0 0 120 120" fill="none" aria-hidden="true"><path d="M100 44 V88 A12 12 0 0 1 88 100 H32 A12 12 0 0 1 20 88 V32 A12 12 0 0 1 32 20 H76" stroke="#fff" stroke-width="8"/><circle cx="92" cy="28" r="11" fill="#E08A1E"/></svg>';
  // паттерн «Разрыв в ритме»: штрих 3px, шаг 16px, высота 32px, один штрих пропущен — на его месте янтарная точка
  var pattern = (function () {
    var r = "", n = 13, gap = 9;
    for (var i = 0; i < n; i++) {
      var x = i * 16 + 1;
      r += i === gap ? '<circle cx="' + (x + 1.5) + '" cy="16" r="4.5" fill="#E08A1E"/>'
                     : '<rect x="' + x + '" y="0" width="3" height="32" fill="#59626E" fill-opacity=".55"/>';
    }
    return '<svg class="lm-cv-pat" viewBox="0 0 ' + (n * 16 - 13) + ' 32" aria-hidden="true">' + r + "</svg>";
  })();
  function coverHTML(t) {
    return '<div class="lm-cv-top">' + logo + 'Мой Дозор<span class="lm-cv-tag">От наших инженеров</span></div>' +
      '<div class="lm-cv-pct">−23%</div>' + pattern +
      '<div class="lm-cv-title">Видео&shy;наблюдение ' + (t ? t.cover : "для вашего объекта") + " дешевле</div>" +
      '<div class="lm-cv-sub"><b>Без потери качества.</b> Куда уходят деньги в смете и где можно сэкономить</div>' +
      '<div class="lm-cv-foot"><span>мойдозор.рф</span><span>' + new Date().getFullYear() + "</span></div>";
  }

  // ---- разметка ----
  var wrap = document.createElement("div");
  wrap.innerHTML =
    '<div class="lm-badge" id="lmBadge">' +
      '<div class="lm-bubble"><b>Как снизить смету на 23%?</b>PDF от наших инженеров</div>' +
      '<button type="button" class="lm-doc" id="lmBadgeBtn" aria-label="Открыть бесплатный гид: как снизить смету на 23%">' +
        '<span class="lm-dot"></span><div class="lm-cover" data-cover></div></button>' +
      '<button type="button" class="lm-x" id="lmBadgeX" aria-label="Скрыть">×</button>' +
    "</div>" +
    '<div class="lm-ov" id="lmOv" role="dialog" aria-modal="true" aria-labelledby="lmTitle" aria-hidden="true">' +
      '<div class="lm" id="lm">' +
        '<button type="button" class="lm-close" id="lmClose" aria-label="Закрыть">✕</button>' +
        '<div class="lm-doc lm-doc-big" id="lmBigDoc" aria-hidden="true"><div class="lm-cover" data-cover></div></div>' +
        '<div id="lmStep1" class="lm-s1">' +
          '<span class="lm-eb"><i></i>PDF от наших инженеров</span>' +
          '<h2 id="lmTitle">Как сделать видеонаблюдение на&nbsp;23% дешевле — <em>и&nbsp;не&nbsp;потерять в&nbsp;качестве?</em></h2>' +
          '<p class="lm-sub">Наши инженеры разобрали это по шагам на реальном расчёте: куда уходят деньги в&nbsp;смете и&nbsp;где можно сэкономить без вреда для системы.</p>' +
          '<div class="lm-stepl"><span class="lm-stepn">1</span><div><b>Выберите свой объект</b><span>Пришлём PDF-файл именно под него в&nbsp;' + APPS + "</span></div></div>" +
          '<div class="lm-types" id="lmTypes"></div>' +
          '<p class="lm-note">На опыте 180+ наших объектов. Расчёт на примере 8 камер.</p>' +
          '<button type="button" class="lm-no" data-lm-close>Нет, спасибо</button>' +
        "</div>" +
        '<div id="lmStep2" hidden><div class="lm-s2"><div>' +
          '<button type="button" class="lm-back" id="lmBack">← Другой объект</button>' +
          '<span class="lm-eb"><i></i>Файл готов</span>' +
          '<h2 id="lmS2title"></h2>' +
          '<ul class="lm-inside">' +
            "<li>Куда уходят деньги в&nbsp;смете — в&nbsp;процентах</li>" +
            "<li>5 способов сэкономить и&nbsp;сколько даёт каждый</li>" +
            '<li id="lmScheme"></li>' +
            "<li>На&nbsp;чём экономить нельзя</li>" +
          "</ul>" +
          '<div class="lm-stepl"><span class="lm-stepn">2</span><div><b id="lmGetTitle"></b><span>Бот пришлёт PDF в течение минуты</span></div></div>' +
          '<div class="lm-get"><div class="lm-qr" id="lmQr"></div><div>' +
            '<div class="lm-get-t"><b>Наведите камеру телефона</b>Откроется <span id="lmQrApp"></span>. Файл придёт в течение минуты.</div>' +
            (LINKS.max ? '<div class="lm-tabs"><button type="button" class="on" data-app="max">MAX</button><button type="button" data-app="tg">Telegram</button></div>' : "") +
          "</div></div>" +
          '<div class="lm-btns">' +
            (LINKS.max ? '<a class="lm-btn lm-btn-accent" id="lmGoMax" href="#" target="_blank" rel="noopener">Получить в MAX</a>' : "") +
            '<a class="lm-btn ' + (LINKS.max ? "lm-btn-ghost" : "lm-btn-accent") + '" id="lmGoTg" href="#" target="_blank" rel="noopener">Получить в Telegram</a>' +
          "</div>" +
          '<p class="lm-fine">Подпишитесь на наш канал — и бот сразу пришлёт файл. В канале наши объекты и разборы инженеров.</p>' +
        '</div><div class="lm-spacer"></div></div></div>' +
      "</div>" +
    "</div>";
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

  var $ = function (s) { return document.querySelector(s); };
  var ov = $("#lmOv"), lm = $("#lm"), badge = $("#lmBadge");
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var goal = function (name) { try { if (window.ym) ym(METRIKA, "reachGoal", name); } catch (e) {} };
  var touch = matchMedia("(hover:none)").matches;
  if (touch) lm.classList.add("lm-touch");

  // На отраслевой странице — обложка её объекта, на главной — склад (основной сегмент)
  var pageName = location.pathname.split("/").pop().replace(/\.html$/, "");
  var pageType = TYPES.filter(function (t) { return t.page && t.page === pageName; })[0];
  var cur = pageType || TYPES[1], app = LINKS.max ? "max" : "tg", lastFocus = null;

  $("#lmBadge [data-cover]").innerHTML = coverHTML(cur);
  $("#lmTypes").innerHTML = TYPES.map(function (t) {
    return '<button type="button" class="lm-type" data-t="' + t.id + '"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' + t.icon + "</svg>" + t.name + "</button>";
  }).join("");
  var typeById = function (id) { return TYPES.filter(function (t) { return t.id === id; })[0]; };

  // QR-код: библиотека грузится, только когда окно открыли на компьютере
  var qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    if (!qrLib) qrLib = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "assets/vendor/qrcode.js"; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return qrLib;
  }
  function drawQR() {
    var name = app === "tg" ? "Telegram" : "MAX", url = LINKS[app](cur.id), box = $("#lmQr");
    $("#lmQrApp").textContent = name;
    $("#lmGetTitle").textContent = "Получите файл в " + (LINKS.max ? name : "Telegram");
    if (touch) return;
    loadQr().then(function () {
      var q = qrcode(0, "M"); q.addData(url); q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }).catch(function () { box.innerHTML = "QR-код не загрузился — нажмите кнопку ниже"; });
  }
  function setCover(t) {
    var d = $("#lmBigDoc");
    d.querySelector("[data-cover]").innerHTML = coverHTML(t);
    d.classList.remove("swap"); void d.offsetWidth; d.classList.add("swap");
  }
  function step(n) {
    $("#lmStep1").hidden = n !== 1; $("#lmStep2").hidden = n !== 2;
    lm.classList.toggle("step2", n === 2);
    if (n === 1) setCover(null);
    if (n === 2) {
      setCover(cur);
      $("#lmS2title").innerHTML = "Как снизить смету " + cur.of + " <em>на&nbsp;23%</em>";
      $("#lmScheme").textContent = "Схема камер для " + cur.of;
      $("#lmGoTg").href = LINKS.tg(cur.id);
      if (LINKS.max) $("#lmGoMax").href = LINKS.max(cur.id);
      drawQR();
      goal("leadmagnet_type_" + cur.id);
      setTimeout(function () { ($("#lmGoMax") || $("#lmGoTg")).focus(); }, 50);
    }
  }
  // Другое окно сайта (заявка) уже открыто — своё не показываем
  var otherModal = function () { return !!document.querySelector("dialog[open]"); };
  function open(src) {
    if (ov.classList.contains("on") || otherModal()) return;
    lastFocus = document.activeElement;
    step(1);
    ov.classList.add("on"); ov.setAttribute("aria-hidden", "false");
    badge.classList.remove("on");
    store.set("lm_shown", Date.now());
    setTimeout(function () { $("#lmTypes .lm-type").focus(); }, 50);
    goal("leadmagnet_open_" + src);
  }
  function close() {
    if (!ov.classList.contains("on")) return;
    ov.classList.remove("on"); ov.setAttribute("aria-hidden", "true");
    if (badgeAllowed()) setTimeout(showBadge, 400);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  $("#lmTypes").addEventListener("mouseover", function (e) {
    var b = e.target.closest(".lm-type"), d = $("#lmBigDoc");
    if (b && b.dataset.t !== d.dataset.t) { d.dataset.t = b.dataset.t; setCover(typeById(b.dataset.t)); }
  });
  $("#lmTypes").addEventListener("mouseleave", function () { $("#lmBigDoc").dataset.t = ""; setCover(null); });
  $("#lmTypes").addEventListener("click", function (e) {
    var b = e.target.closest(".lm-type");
    if (!b) return;
    cur = typeById(b.dataset.t); step(2);
  });
  $("#lmBack").addEventListener("click", function () { step(1); $("#lmTypes .lm-type").focus(); });
  Array.prototype.forEach.call(document.querySelectorAll("#lmOv .lm-tabs button"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("#lmOv .lm-tabs button"), function (x) { x.classList.toggle("on", x === b); });
      app = b.dataset.app; drawQR();
    });
  });
  $("#lmClose").addEventListener("click", close);
  $("[data-lm-close]").addEventListener("click", close);
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  document.addEventListener("keydown", function (e) {
    if (!ov.classList.contains("on")) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;
    // фокус не уходит из окна
    var f = Array.prototype.filter.call(lm.querySelectorAll("button,a[href]"), function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  $("#lmBadgeBtn").addEventListener("click", function () { open("badge"); });
  $("#lmBadgeX").addEventListener("click", function () { badge.classList.remove("on"); store.set("lm_badge_hidden", Date.now()); });
  $("#lmGoTg").addEventListener("click", function () { goal("leadmagnet_go_tg"); });
  if (LINKS.max) $("#lmGoMax").addEventListener("click", function () { goal("leadmagnet_go_max"); });

  // ---- значок: над нижней панелью «Оставить заявку» и полосой cookie на телефоне ----
  function placeBadge() {
    var bottom = innerWidth <= 820 ? 16 : 28;
    Array.prototype.forEach.call(document.querySelectorAll("#mbar, .cookie"), function (el) {
      if (el.hidden || getComputedStyle(el).display === "none" || el.classList.contains("is-hidden")) return;
      var r = el.getBoundingClientRect();
      if (r.height && r.top < innerHeight && r.right > innerWidth - 160) bottom = Math.max(bottom, innerHeight - r.top + 26);
    });
    badge.style.bottom = bottom + "px";
  }
  var raf = 0;
  function placeSoon() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; placeBadge(); }); }
  addEventListener("resize", placeSoon);
  addEventListener("scroll", placeSoon, { passive: true });
  // Панель и cookie появляются и прячутся сами — следим за их классами и атрибутом hidden
  if (window.MutationObserver) Array.prototype.forEach.call(document.querySelectorAll("#mbar, .cookie"), function (el) {
    new MutationObserver(function () { placeSoon(); setTimeout(placeBadge, 300); }).observe(el, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
  });
  function showBadge() { placeBadge(); badge.classList.add("on"); }
  var badgeAllowed = function () { return Date.now() - (+store.get("lm_badge_hidden") || 0) > BADGE_HIDE_DAYS * 864e5; };
  if (badgeAllowed()) setTimeout(showBadge, BADGE_DELAY);

  // ---- окно само: уход с вкладки (компьютер), 40 секунд или прокрутка 60% (телефон) ----
  // Не чаще раза в EXIT_COOLDOWN_DAYS и не тем, кто уже оставил заявку (lead_sent ставят формы сайта)
  var allowed = function () {
    return PREVIEW || (Date.now() - (+store.get("lm_shown") || 0) > EXIT_COOLDOWN_DAYS * 864e5 && !store.get("lead_sent"));
  };
  document.addEventListener("mouseout", function (e) { if (!e.relatedTarget && e.clientY <= 0 && allowed()) open("exit"); });
  if (touch) {
    setTimeout(function () { if (allowed()) open("timer"); }, 40000);
    addEventListener("scroll", function f() {
      if (scrollY > (document.documentElement.scrollHeight - innerHeight) * 0.6 && allowed()) {
        removeEventListener("scroll", f); open("scroll");
      }
    }, { passive: true });
  }
})();
