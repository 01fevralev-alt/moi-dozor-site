/* Цели Метрики «активный визит» — для сегментов ретаргетинга. Подключается одной строкой на всех страницах.
   active_60  — 60 секунд активного времени: вкладка видима и за последние 15 секунд было действие
                (прокрутка, мышь, касание, клавиша);
   active_120 — 120 секунд активного времени и прокрутка хотя бы до середины страницы.
   Время копится за визит (между страницами одной вкладки), каждая цель — один раз за визит. */
(function () {
  var ID = 99939047, KEY = "dozor_active", IDLE = 15000;
  var st = { t: 0, s: false, g: {} };
  try { st = JSON.parse(sessionStorage.getItem(KEY)) || st; } catch (e) {}
  st.g = st.g || {};
  if (st.g.active_60 && st.g.active_120) return;

  var last = 0;
  function act() { last = Date.now(); }
  ["scroll", "mousemove", "touchstart", "keydown", "pointerdown", "wheel"].forEach(function (ev) {
    addEventListener(ev, act, { passive: true, capture: true });
  });

  function scrolled() {
    var h = document.documentElement.scrollHeight;
    return h <= innerHeight || (scrollY + innerHeight) / h >= 0.5;
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  function fire(name) {
    if (st.g[name]) return;
    st.g[name] = 1;
    try { if (window.ym) ym(ID, "reachGoal", name); } catch (e) {}
  }

  var timer = setInterval(function () {
    if (document.visibilityState !== "visible" || Date.now() - last > IDLE) return;
    st.t++;
    if (!st.s && scrolled()) st.s = true;
    if (st.t >= 60) fire("active_60");
    if (st.t >= 120 && st.s) fire("active_120");
    if (st.t % 5 === 0 || st.g.active_120) save();
    if (st.g.active_60 && st.g.active_120) { save(); clearInterval(timer); }
  }, 1000);
  addEventListener("pagehide", save);
})();
