// Сайт работает только по https: http и www переадресуем на основной адрес
if (location.protocol === "http:" && !/^(localhost|127\.|192\.168\.)/.test(location.hostname)) location.replace("https://" + location.host.replace(/^www\./, "") + location.pathname + location.search + location.hash);
/* Подстраницы (partner.html, jobs.html, cases/*.html): Метрика, плашка cookie, маска телефона, отправка формы.
   Всё по образцу index.html; адрес функции и счётчик — те же. */
// Корень сайта — от адреса этого скрипта: страницы лежат и в корне, и в cases/
const BASE = new URL(".", document.currentScript.src).href;
const SITE = {
  phone: "+79057239958",
  phoneText: "+7 (905) 723-99-58",
  metrika: 99939047,
  leadEndpoint: "https://functions.yandexcloud.net/d4eirdv1tglmcebcq8qj"
};

/* ---------- Яндекс Метрика ---------- */
(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
m[i].l=1*new Date();
for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
ym(SITE.metrika, "init", { webvisor: true, clickmap: true, trackLinks: true, accurateTrackBounce: true });

function goal(name, params){
  try { if (window.ym) ym(SITE.metrika, "reachGoal", name, params); } catch {}
}
const AD_KEYS = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","yclid"];
const adTags = (() => {
  const q = new URLSearchParams(location.search), fresh = {};
  AD_KEYS.forEach(k => { if (q.get(k)) fresh[k] = q.get(k).slice(0, 150); });
  try {
    if (Object.keys(fresh).length) sessionStorage.setItem("dozor_ad", JSON.stringify(fresh));
    return JSON.parse(sessionStorage.getItem("dozor_ad") || "{}");
  } catch { return fresh; }
})();
const metrikaClientId = () => new Promise(res => {
  if (!window.ym) return res("");
  const t = setTimeout(() => res(""), 700);
  try { ym(SITE.metrika, "getClientID", id => { clearTimeout(t); res(String(id || "")); }); } catch { clearTimeout(t); res(""); }
});

async function sendLead(payload){
  const ym_uid = await metrikaClientId();
  payload = { ...payload, page: location.pathname, ...(ym_uid ? { ym_uid } : {}), ...(Object.keys(adTags).length ? { ad: adTags } : {}) };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    // text/plain — «простой» запрос без предварительной CORS-проверки; функция всё равно разбирает JSON
    const r = await fetch(SITE.leadEndpoint, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload), signal: ctrl.signal });
    // Заявка ушла — окно лид-магнита этому посетителю больше само не открываем (leadmagnet.js)
    if (r.ok) try { localStorage.setItem("lead_sent", Date.now()); } catch {}
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

const $$ = (s, r = document) => [...r.querySelectorAll(s)];
$$("[data-phone-link]").forEach(a => a.href = "tel:" + SITE.phone);
$$("[data-phone-text]").forEach(a => a.textContent = SITE.phoneText);
$$("[data-year]").forEach(s => s.textContent = new Date().getFullYear());

/* ---------- Маска телефона ---------- */
function digitsOf(v){
  let d = v.replace(/\D/g, "");
  if (d[0] === "8" || d[0] === "7") d = d.slice(1);
  return d.slice(0, 10);
}
function formatPhone(d){
  if (!d.length) return "";
  let s = "+7 (" + d.slice(0, 3);
  if (d.length >= 3) s += ") " + d.slice(3, 6);
  if (d.length >= 6) s += "-" + d.slice(6, 8);
  if (d.length >= 8) s += "-" + d.slice(8, 10);
  return s;
}
$$("[data-phone]").forEach(inp => {
  let prev = "";
  inp.addEventListener("input", e => {
    let d = digitsOf(inp.value);
    if (e.inputType === "deleteContentBackward" && d === prev) d = d.slice(0, -1);
    prev = d;
    inp.value = formatPhone(d);
    if (d.length === 10) inp.removeAttribute("aria-invalid");
  });
  inp.addEventListener("focus", () => { if (!inp.value) inp.value = "+7 ("; });
  inp.addEventListener("blur", () => { if (!digitsOf(inp.value).length) inp.value = ""; });
});

/* ---------- Формы: data-kind="lead" (страница кейса или отрасли) | "partner" | "job" ---------- */
// Поле-ловушка для спам-ботов: людям не видно, боты заполняют — такие заявки функция молча отбрасывает
$$("form[data-kind]").forEach(f => f.insertAdjacentHTML("beforeend",
  '<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">'));

const GOALS = { lead: "lead", partner: "partner_lead", job: "job_apply" };
$$("form[data-kind]").forEach(form => {
  const err = form.querySelector(".lf-err"), btn = form.querySelector("[type=submit]"), kind = form.dataset.kind;
  let started = false;
  form.addEventListener("input", () => { if (!started) { started = true; goal("form_start", { form: kind }); } });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.textContent = "";
    const v = name => form.elements[name]?.value.trim() || "";
    // Проверка телефонов по порядку: какой первым заполнен неверно — туда и курсор
    for (const inp of form.querySelectorAll("[data-phone]")) {
      if (digitsOf(inp.value).length !== 10) {
        err.textContent = inp.dataset.phoneErr || "Введите номер полностью: 10 цифр после +7";
        inp.setAttribute("aria-invalid", "true");
        inp.focus();
        return;
      }
    }
    const must = form.querySelector("[data-required-check]");
    if (must && !must.checked) { err.textContent = must.dataset.requiredCheck; must.focus(); return; }

    const phone = name => "+7" + digitsOf(v(name));
    const payload =
      kind === "partner" ? { kind, phone: phone("friend_phone"), name: v("friend_name"), note: v("note"), partner: { name: v("my_name"), phone: phone("my_phone") } } :
      kind === "job" ? { kind, phone: phone("phone"), name: v("name"), note: v("note"), experience: v("experience"), car: !!form.elements.car?.checked, selfemp: !!form.elements.selfemp?.checked } :
      { kind, phone: phone("phone"), name: v("name"), channel: "call", source: form.dataset.source || "case_page", ...(form.dataset.case ? { case_ref: form.dataset.case } : {}) };
    if (form.elements.website?.value) payload.website = form.elements.website.value;

    btn.disabled = true;
    const sent = await sendLead(payload);
    if (!sent) {
      goal("lead_error", { form: kind });
      btn.disabled = false;
      err.textContent = `Не получилось отправить. Попробуйте ещё раз или позвоните: ${SITE.phoneText}`;
      return;
    }
    goal(GOALS[kind], kind === "lead" ? { form: payload.source, channel: "call" } : undefined);
    if (kind === "lead") goal(form.dataset.case ? "lead_case" : "lead_industry", { form: payload.source });
    form.innerHTML = `<div class="done" role="status"><svg width="28" height="28"><use href="#i-ok"/></svg><div><b>${form.dataset.doneTitle}</b><p>${form.dataset.doneText}</p></div></div>`;
  });
});

/* ---------- Клики: звонок и мессенджеры ---------- */
document.addEventListener("click", e => {
  const a = e.target.closest("a");
  if (a?.matches('a[href^="tel:"]')) goal("call_click");
  else if (a?.dataset.messenger) goal("messenger_click", { messenger: a.dataset.messenger });
}, true);

/* ---------- Плашка cookie: до «Понятно»; Метрика работает сразу (выбор владельца, как на главной) ---------- */
(() => {
  let ok = false;
  try { ok = localStorage.getItem("dozor_cookie_ok") === "1"; } catch {}
  if (ok) return;
  document.body.insertAdjacentHTML("beforeend", `<div class="cookie" role="region" aria-label="Уведомление о cookie">
    <p>Сайт использует cookie и Яндекс Метрику, чтобы работать удобнее. Подробнее — в <a href="${BASE}policy.html#cookie">политике</a>.</p>
    <button class="btn btn-accent" type="button">Понятно</button></div>`);
  const box = document.body.lastElementChild;
  box.querySelector("button").addEventListener("click", () => {
    try { localStorage.setItem("dozor_cookie_ok", "1"); } catch {}
    box.remove();
  });
})();

/* ---------- Калькулятор партнёра ---------- */
(() => {
  const range = document.getElementById("calcRange");
  if (!range) return;
  const sum = document.getElementById("calcSum"), pay = document.getElementById("calcPay"), capNote = document.getElementById("calcCap"), gift = document.getElementById("calcGift");
  const rub = n => n.toLocaleString("ru-RU") + " ₽";
  let moved = false;
  const upd = () => {
    const v = +range.value, p = Math.min(Math.round(v * 0.1), 50000);
    sum.textContent = rub(v);
    pay.textContent = rub(p);
    capNote.hidden = v * 0.1 < 50000;
    // Подарок-регистратор знакомому — при договоре от 30 000 ₽
    if (gift) gift.textContent = v >= 30000 ? "+ регистратор за 7 250 ₽ — знакомому в подарок" : "Регистратор в подарок — при договоре от 30 000 ₽";
  };
  range.addEventListener("input", () => { upd(); if (!moved) { moved = true; goal("partner_calc"); } });
  upd();
})();

/* ---------- Галерея кейса: нажали на фото — открывается крупно; стрелки, свайп, Esc ---------- */
(() => {
  const btns = $$(".gallery button");
  if (!btns.length || typeof HTMLDialogElement !== "function") return;
  const srcs = btns.map(b => b.querySelector("img").src);
  document.body.insertAdjacentHTML("beforeend", `<dialog class="lbox" aria-label="Фото объекта">
    <div class="lbox-img"><img alt=""></div>
    <button class="lbox-x" type="button" aria-label="Закрыть">✕</button>
    <div class="lbox-bar"><button type="button" data-d="-1" aria-label="Предыдущее фото">←</button><span></span><button type="button" data-d="1" aria-label="Следующее фото">→</button></div>
  </dialog>`);
  const box = document.body.lastElementChild, img = box.querySelector("img"), pos = box.querySelector("span");
  const [prev, next] = box.querySelectorAll("[data-d]");
  let i = 0;
  const show = k => {
    i = Math.max(0, Math.min(srcs.length - 1, k));
    img.src = srcs[i];
    img.alt = btns[i].querySelector("img").alt;
    pos.textContent = `${i + 1} / ${srcs.length}`;
    prev.disabled = i === 0;
    next.disabled = i === srcs.length - 1;
  };
  btns.forEach((b, k) => b.addEventListener("click", () => { show(k); box.showModal(); goal("case_photo"); }));
  box.addEventListener("click", e => {
    const d = e.target.closest("[data-d]");
    if (d) show(i + +d.dataset.d);
    else if (e.target.closest(".lbox-x") || e.target === box || e.target.classList.contains("lbox-img")) box.close();
  });
  box.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") show(i - 1);
    if (e.key === "ArrowRight") show(i + 1);
  });
  let x0 = null;
  box.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener("touchend", e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1));
  }, { passive: true });
})();
