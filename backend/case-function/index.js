// Автокейсы «Мой Дозор»: сделка amoCRM на этапе «Проверено» → черновик кейса в MAX → кнопка «Опубликовать» → кейс на сайте.
// Яндекс Облако → Cloud Functions, Node.js 22, файлы: index.js, render.js, package.json (sharp для сжатия фото).
// Подробная настройка — README.md рядом.
//
// Как устроено:
//   amoCRM (Webhook на этапе «Проверено») и MAX (нажатия кнопок, ответы на черновик) вызывают функцию по HTTP.
//   Она отвечает сразу, а тяжёлую работу (фото, текст, публикация) кладёт заданием в бакет jobs/.
//   Триггер-таймер раз в минуту запускает функцию, и она выполняет задания. Правки черновика ответом — сразу.
//
// В бакете: jobs/ — очередь; drafts/<сделка>.json и drafts/<сделка>/<n>.webp — черновики; mids/<сообщение>.json —
// какое сообщение MAX к какой сделке; waiting/<сделка>.json — ждём фото; published/<сделка>.json — адрес страницы.
//
// Переменные окружения (задаются в настройках функции, в код не вписывать):
//   HOOK_SECRET       любой длинный пароль: он есть в адресах для amoCRM и MAX, без него функция ничего не делает
//   AMO_DOMAIN, AMO_TOKEN  как в функции заявок (moidozor-lead)
//   MAX_TOKEN, MAX_CHAT_ID как в функции заявок: черновики приходят в ту же группу
//   DRIVE_SCRIPT_URL  адрес скрипта «Мой Дозор фото» (…/exec), DRIVE_SECRET — его пароль
//   GITHUB_TOKEN      ключ GitHub (только репозиторий сайта, Contents: Read and write)
//   FOLDER_ID         каталог Яндекс Облака (b1g…) — для YandexGPT
//   BUCKET            необязательно: бакет, по умолчанию moidozor-cases
//   GITHUB_REPO       необязательно: по умолчанию 01fevralev-alt/moi-dozor-site
//   SELF_URL          необязательно: адрес этой функции, если определился неверно
// У функции должен быть сервисный аккаунт с ролями ai.languageModels.user и storage.editor.

// sharp (сжатие фото) грузим только когда нужен: если он не встал, остальное — проверка, кнопки, правки — работает
let sharpLib = null;
const loadSharp = () => sharpLib || (sharpLib = require("sharp"));
const crypto = require("crypto");
const { renderCase, addToSitemap } = require("./render.js");

const env = name => (process.env[name] || "").trim();
const BUCKET = () => env("BUCKET") || "moidozor-cases";
const REPO = () => env("GITHUB_REPO") || "01fevralev-alt/moi-dozor-site";
const SITE_URL = "https://xn--d1agelkcbq.xn--p1ai/";
const MAX_PHOTOS = 15;          // сколько фото брать в черновик
const WAIT_DAYS = 14;           // сколько дней ждать фото
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); // по Самаре

let IAM = "";   // токен сервисного аккаунта из context — для бакета и YandexGPT

// Внешний сервис иногда не отвечает несколько секунд (проверено 27.09) — повторяем
async function http(url, init = {}, { tries = 3, ms = 20000, what = url.split("/")[2] } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
      if (r.status >= 500 && i < tries - 1) { last = new Error(`${what} ${r.status}`); await sleep(1500 * (i + 1)); continue; }
      return r;
    } catch (e) { last = new Error(`${what}: ${e.cause?.code || e.message}`); await sleep(1500 * (i + 1)); }
  }
  throw last;
}
async function httpJson(url, init, opts) {
  const r = await http(url, init, opts);
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts?.what || url.split("/")[2]} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/* ---------- Бакет Object Storage (вход по токену сервисного аккаунта) ---------- */
const s3url = key => `https://storage.yandexcloud.net/${BUCKET()}/${key.split("/").map(encodeURIComponent).join("/")}`;
const s3 = (method, key, body, type) => http(s3url(key), {
  method, body, headers: { "X-YaCloud-SubjectToken": IAM, ...(type ? { "Content-Type": type } : {}) }
}, { what: "Object Storage" });
async function getJson(key) {
  const r = await s3("GET", key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Object Storage ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function putJson(key, data) {
  const r = await s3("PUT", key, JSON.stringify(data), "application/json");
  if (!r.ok) throw new Error(`Object Storage ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function getBin(key) {
  const r = await s3("GET", key);
  if (!r.ok) throw new Error(`Object Storage ${r.status}: нет файла ${key}`);
  return Buffer.from(await r.arrayBuffer());
}
async function putBin(key, buf, type) {
  const r = await s3("PUT", key, buf, type);
  if (!r.ok) throw new Error(`Object Storage ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
const del = key => s3("DELETE", key).catch(() => {});
async function list(prefix) {
  const r = await http(`https://storage.yandexcloud.net/${BUCKET()}?list-type=2&prefix=${encodeURIComponent(prefix)}`,
    { headers: { "X-YaCloud-SubjectToken": IAM } }, { what: "Object Storage" });
  const xml = await r.text();
  if (!r.ok) throw new Error(`Object Storage ${r.status}: ${xml.slice(0, 200)}`);
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
}
const queue = (kind, lead, extra = {}) => putJson(`jobs/${Date.now()}-${lead}-${kind}.json`, { kind, lead, ...extra });

/* ---------- amoCRM ---------- */
const amoDomain = () => env("AMO_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const amo = (path, body, method) => httpJson(`https://${amoDomain()}${path}`, {
  method: method || (body ? "POST" : "GET"),
  headers: { Authorization: `Bearer ${env("AMO_TOKEN")}`, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined
}, { what: "amoCRM" });

// Поле сделки по названию: первое значение (у списков — текст варианта, у дат — секунды)
function field(lead, name) {
  const f = (lead.custom_fields_values || []).find(x => x.field_name?.trim().toLowerCase() === name.toLowerCase());
  const v = f?.values?.[0];
  return v ? (v.value ?? v.enum ?? "") : "";
}
const num = v => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
const PRIVATE = /частн|дач|квартир|снт/i;
// «Расшифровка счета» монтажника — по прайсу, с суммами. На сайт идут только работы: суммы вырезаем
const noPrices = s => String(s).split(/^\s*итого/im)[0].replace(/\s*\d[\d\s]*(?:[.,]\d+)?\s*(?:₽|руб\.?|р\.)/gi, "").replace(/[ \t]+/g, " ")
  .split("\n").map(l => l.trim()).filter(Boolean).join("\n");

// Даты amoCRM — секунды; показываем по Самаре
const ddmm = sec => { const d = new Date((sec + 4 * 3600) * 1000), p = n => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`; };
// «Как проходил проект» — только по датам из сделки, без нейросети
function timeline({ inspect, start, end, result, cams }) {
  const out = [];
  if (inspect) out.push({ date: ddmm(inspect), title: "Осмотр", text: "Осмотрели объект и подготовили смету" });
  if (start) {
    const days = end && end >= start ? Math.round((end - start) / 86400) + 1 : 1;
    out.push({ date: end && end > start ? `${ddmm(start)} – ${ddmm(end)}` : ddmm(start), title: "Монтаж",
      text: `${cams ? `Установили ${cams} ${cams % 10 === 1 && cams % 100 !== 11 ? "камеру" : [2, 3, 4].includes(cams % 10) && ![12, 13, 14].includes(cams % 100) ? "камеры" : "камер"}` : "Смонтировали систему"}, ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"} работ` });
  }
  if (end || start) out.push({ date: ddmm(end || start), title: "Сдача", text: /акт/i.test(result) ? "Настроили доступ с телефона, подписали акт" : "Настроили доступ с телефона и сдали объект" });
  return out;
}

async function readLead(id) {
  const lead = await amo(`/api/v4/leads/${id}`);
  const g = name => String(field(lead, name) ?? "").trim();
  const start = Number(field(lead, "Дата начала монтажа")), end = Number(field(lead, "Дата окончания монтажа"));
  const inspect = Number(field(lead, "Дата осмотра"));
  const bill = g("Расшифровка счета");
  // Кабель: сколько монтажник по факту затратил UTP (улица + внутри); пусто — берём из строк «Протяжка UTP … 107м» в счёте
  const billUtp = [...bill.matchAll(/UTP[^\n]*?(\d+)\s*м(?![а-яё])/gi)].reduce((s, m) => s + Number(m[1]), 0);
  const cable = (num(g("Затрачено UTP улица")) || 0) + (num(g("Затрачено UTP внутренний")) || 0) || billUtp;
  const link = g("Папка Контент");
  return {
    id, type: g("Тип объекта") || "Объект", city: g("Город"), addrRaw: g("Адрес"),
    private: PRIVATE.test(g("Тип объекта")) || /B2C|частн/i.test(g("Тип клиента")),
    placement: g("Размещение"), service: g("Тип услуги"), note: g("Примечание к монтажу").slice(0, 600),
    works: noPrices(bill).slice(0, 1200),
    timeline: timeline({ inspect, start, end, result: g("Результат монтажа"), cams: num(g("Камер (шт)")) }),
    cams: num(g("Камер (шт)")), cable: cable || null,
    days: start && end && end >= start ? Math.round((end - start) / 86400) + 1 : null,
    folder: (link.match(/folders\/([\w-]+)/) || link.match(/[?&]id=([\w-]+)/) || [])[1] || "",
    photosFlag: g("Фото и видео загружены?")
  };
}

/* ---------- Фото: скрипт Google «Мой Дозор фото» ---------- */
const drive = params => httpJson(`${env("DRIVE_SCRIPT_URL")}?key=${encodeURIComponent(env("DRIVE_SECRET"))}&${params}`,
  { redirect: "follow" }, { what: "Google Диск", ms: 60000 }).then(d => {
    if (!d.ok) throw new Error(`Google Диск: ${d.error}`);
    return d;
  });

// Список фото папки: без дублей, по времени; если много — равномерно из всей съёмки (разные точки объекта)
async function listPhotos(folder) {
  if (!folder) return [];
  const { files } = await drive(`folder=${encodeURIComponent(folder)}`);
  const seen = new Set();
  const all = files.filter(f => { const k = `${f.name}|${f.size}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.date + a.name).localeCompare(b.date + b.name));
  if (all.length <= MAX_PHOTOS) return all;
  return Array.from({ length: MAX_PHOTOS }, (_, i) => all[Math.round(i * (all.length - 1) / (MAX_PHOTOS - 1))]);
}

// Фото для сайта: 1600 px по длинной стороне, webp. Превью для MAX: 640 px с крупным номером в углу.
async function processPhoto(buf, n) {
  const img = loadSharp()(buf, { failOn: "none" }).rotate();
  const site = await img.clone().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const badge = Buffer.from(`<svg width="84" height="84" xmlns="http://www.w3.org/2000/svg"><circle cx="42" cy="42" r="36" fill="#E08A1E"/><text x="42" y="56" font-family="sans-serif" font-size="40" font-weight="700" fill="#fff" text-anchor="middle">${n}</text></svg>`);
  const preview = await img.clone().resize({ width: 640, height: 640, fit: "inside" }).composite([{ input: badge, top: 12, left: 12 }]).jpeg({ quality: 78 }).toBuffer();
  return { site, preview };
}

// Несколько задач одновременно, но не больше limit
async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------- YandexGPT ---------- */
const SYSTEM = `Ты пишешь кейсы для сайта «Мой Дозор» — компании из Самары, которая ставит видеонаблюдение под ключ.
Голос — живая компания, которая рассказывает о своей работе: от «мы», тепло, по-человечески, с конкретикой из жизни клиента.
Объясняй, зачем клиенту это было нужно и что это даёт ему в быту или в работе: «уезжая на работу, открывает телефон и видит, кто у ворот».
Без канцелярита и штампов («эффективно», «обеспечить безопасность», «комплексное решение», «позволило»), без восклицаний.
Исправляй орфографические, пунктуационные и грамматические ошибки во всех исходных текстах: счёт монтажника, заметка менеджера, история руководителя. На сайт — только грамотный текст.
Пункты списков — без точки в конце.

Факты — строго из данных и истории: не выдумывай цифры, сроки, марки, события и слова клиента. Раскрывать факты можно: объяснить их смысл для клиента.
Если есть история от руководителя — это главный источник: опирайся на неё.
Не упоминай имя клиента, телефоны, названия компаний. Никогда не пиши цены, суммы и стоимость работ.
Из заметки менеджера бери только то, что говорит о задаче клиента или об объекте; рабочие заметки («ждём, пока клиент…») не переносить.
Если кабель прокладывал сам клиент — не приписывай прокладку кабеля нам.
Не описывай точное расположение камер и слепые зоны объекта.

Словарь — как мы говорим:
- «видео в реальном времени» или «смотреть онлайн»; никогда не «живое видео»;
- запись и архив — это регистратор и жёсткий диск; коммутатор к записи не относится, он питает камеры и связывает их с регистратором;
- «доступ с телефона», «архив», «ИК-подсветка», «уличные камеры».

Каждый кейс — свой: не повторяй формулировки из списка «уже на сайте» и начинай заголовок и lead по-разному.
Пиши живо и образно, но без выдумок: цепляющая деталь из истории или из типа объекта лучше общих слов.

ОБРАЗЕЦ МАНЕРЫ (выдуманный объект; из него нельзя брать ни факты, ни фразы — только интонацию):
{"title": "Спокойно уезжать с дачи на всю неделю",
 "lead": "Четыре камеры смотрят на калитку, гараж и сад, а хозяйка проверяет их в перерыве на работе. Если кто-то появится у забора ночью — это будет на записи.",
 "task": ["Зимой на участок дважды заходили посторонние, и каждый раз узнавали об этом только весной."]}

Ответ — только JSON, без пояснений.`;
const SCHEMA = `{
  "addr": "адрес для сайта: город, улица и номер дома; без офиса, квартиры, подъезда, корпуса; если объект частный (дом, дача, квартира) — город и улица без номера дома",
  "title": "задача клиента одной фразой до 70 символов, с глагола: «Видеть…», «Контролировать…», «Закрыть…»",
  "lead": "2 предложения: что сделали и как это помогает клиенту в жизни или работе",
  "task": ["если есть история — 2 абзаца по ней: зачем клиенту понадобилось видеонаблюдение и что было важно на объекте; если истории нет — 1 абзац о типичной задаче для такого объекта, без выдуманных подробностей"],
  "done": ["3–4 обобщённых пункта «что сделали» (камеры, запись, доступ с телефона, обучение); не повторяй дословно работы монтажника — полный перечень выводится на странице отдельно"],
  "result": ["до 3 живых пунктов «что изменилось для клиента» — только из истории; если истории нет — пустой массив"],
  "works": ["работы монтажника из счёта в читаемом виде, по одной строке на работу, в том же порядке: исправь опечатки и обрывки фраз («Монтаж 6 камер улица» → «Монтаж 6 уличных камер», «комутатора» → «коммутатора»); ничего не добавляй, не объединяй и не выбрасывай"]
}`;

async function gpt(user) {
  const d = await httpJson("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: { Authorization: `Bearer ${IAM}`, "x-folder-id": env("FOLDER_ID"), "Content-Type": "application/json" },
    body: JSON.stringify({
      modelUri: `gpt://${env("FOLDER_ID")}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.75, maxTokens: "1500" },
      messages: [{ role: "system", text: SYSTEM }, { role: "user", text: user }]
    })
  }, { what: "YandexGPT", ms: 40000 });
  const text = d.result?.alternatives?.[0]?.message?.text || "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(json); } catch { throw new Error(`YandexGPT ответил не JSON: ${text.slice(0, 200)}`); }
}

const clean = (c, raw) => ({
  type: raw.type, city: raw.city,
  addr: String(c.addr || raw.city).replace(/,?\s*(оф(ис)?|кв(артира)?|пом(ещение)?|подъезд)\.?\s*\S+/gi, "").trim(),
  title: String(c.title || "").trim().slice(0, 90),
  lead: String(c.lead || "").trim(),
  task: (Array.isArray(c.task) ? c.task : [c.task]).map(s => String(s || "").trim()).filter(Boolean).slice(0, 3),
  done: items(c.done, 6),
  result: items(c.result, 4),
  nums: [raw.cams, raw.cable, raw.days],
  works: works(c.works, raw.works),
  timeline: raw.timeline || []   // хронология — из дат сделки, без нейросети
});
// Пункт списка: без точки и точки с запятой в конце
const items = (list, max) => (Array.isArray(list) ? list : []).map(s => String(s || "").trim().replace(/[.;,]+$/, "")).filter(Boolean).slice(0, max);
// Работы: исправленные нейросетью, если она не потеряла и не добавила строки; иначе — как в счёте
function works(fixed, bill) {
  const orig = items(String(bill || "").split("\n"), 15);
  const got = items(fixed, 15);
  return got.length && Math.abs(got.length - orig.length) <= 1 ? got : orig;
}

// avoid — формулировки уже опубликованных кейсов: нейросеть не должна их повторять
function writeCase(raw, story = "", avoid = []) {
  const data = [
    `Тип объекта: ${raw.type}`, `Город: ${raw.city || "—"}`, `Адрес из CRM: ${raw.addrRaw || "—"}`,
    `Частный объект: ${raw.private ? "да" : "нет"}`, `Размещение камер: ${raw.placement || "—"}`, `Услуга: ${raw.service || "—"}`,
    `Камер: ${raw.cams ?? "—"}`, `Кабеля, м: ${raw.cable ?? "—"}`, `Дней монтажа: ${raw.days ?? "—"}`,
    `Заметка менеджера перед монтажом: ${raw.note || "—"}`,
    `Работы монтажника (из счёта, без цен):\n${raw.works || "—"}`,
    ...(/под ключ/i.test(raw.service) || !raw.service ? ["Всегда входит в монтаж под ключ: настройка записи на регистратор, удалённый доступ с телефона, обучение клиента"] : []),
    `История от руководителя: ${story || "—"}`
  ].join("\n");
  const already = avoid.length ? `\n\nУже на сайте (эти формулировки не повторять):\n${avoid.map(x => `- ${x}`).join("\n")}` : "";
  return gpt(`Данные объекта:\n${data}${already}\n\nНапиши кейс в формате JSON:\n${SCHEMA}`).then(c => clean(c, raw));
}

const rewriteCase = (d, wish) => gpt(`Вот кейс в JSON:\n${JSON.stringify(caseFields(d.case), null, 1)}\n` +
  (d.story ? `История от руководителя: ${d.story}\n` : "") +
  (d.avoid?.length ? `Уже на сайте (эти формулировки не повторять):\n${d.avoid.map(x => `- ${x}`).join("\n")}\n` : "") +
  `\nПерепиши его по просьбе: «${wish}». ` +
  `Цифры и факты не меняй, новых не придумывай. Верни JSON в той же форме:\n${SCHEMA}`)
  .then(c => clean(c, { ...d.raw, cams: d.case.nums[0], cable: d.case.nums[1], days: d.case.nums[2], works: (d.case.works || []).join("\n"), timeline: d.case.timeline || [] }));
const caseFields = c => ({ addr: c.addr, title: c.title, lead: c.lead, task: c.task, done: c.done, result: c.result, works: c.works });

/* ---------- MAX ---------- */
const MAX_API = "https://platform-api2.max.ru";
const max = (path, body, method) => httpJson(MAX_API + path, {
  method: method || (body ? "POST" : "GET"),
  headers: { Authorization: env("MAX_TOKEN"), "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined
}, { what: "MAX" });

async function uploadImage(buf) {
  const { url } = await max("/uploads?type=image", {});
  const form = new FormData();
  form.append("data", new Blob([buf], { type: "image/jpeg" }), "photo.jpg");
  return httpJson(url, { method: "POST", body: form }, { what: "MAX загрузка" });
}

// Сообщение в группу; lead — чтобы ответ на него попал в нужный черновик. Фото сразу после загрузки
// бывают «не готовы» — тогда ждём и повторяем.
async function say(html, { lead, buttons, images, reply } = {}) {
  const attachments = [];
  if (images) images.forEach(p => attachments.push({ type: "image", payload: p }));
  if (buttons) attachments.push({ type: "inline_keyboard", payload: { buttons } });
  const body = { text: html, format: "html", ...(attachments.length ? { attachments } : {}), ...(reply ? { link: { type: "reply", mid: reply } } : {}) };
  let res;
  for (let i = 0; i < 5; i++) {
    try { res = await max(`/messages?chat_id=${encodeURIComponent(env("MAX_CHAT_ID"))}&disable_link_preview=true`, body); break; }
    catch (e) { if (!/not\.ready|attachment/i.test(e.message) || i === 4) throw e; await sleep(1500 * (i + 1)); }
  }
  const mid = res?.message?.body?.mid;
  if (mid && lead) await putJson(`mids/${mid}.json`, { lead });
  return mid;
}
const btn = (text, payload) => ({ type: "callback", text, payload });

/* ---------- Черновик: текст для MAX и разбор правок ---------- */
const FIELDS = [["Адрес", "addr"], ["Заголовок", "title"], ["Кратко", "lead"], ["Задача", "task"]];
const NUMS = [["Камер", 0], ["Кабель, м", 1], ["Дней монтажа", 2]];
const used = d => d.photos.filter(p => !d.off.includes(p.n));

function draftText(d) {
  const c = d.case, on = used(d);
  const photos = d.photos.length
    ? `📷 Фото: ${on.map(p => p.n).join(", ") || "все убраны"}${on.length ? ` · обложка — ${d.cover}` : ""}`
    : "📷 <b>Фото нет</b> — кейс выйдет отдельной страницей, на главной его не будет";
  const lines = [
    `📝 <b>${d.update ? "Обновление кейса" : "Черновик кейса"}${d.pos ? ` ${d.pos}` : ""}</b> · <a href="https://${esc(amoDomain())}/leads/detail/${d.lead}">сделка №${d.lead}</a>`,
    ...(d.textFromSite ? [`♻️ Текст${d.photosFromSite ? " и фото" : ""} — как на сайте; из CRM обновлены цифры и даты. Переписать текст — ответьте, например, «перепиши».`] : []),
    photos, "",
    `Тип: ${esc(c.type)} · Город: ${esc(c.city)}`,
    ...FIELDS.map(([label, k]) => `${label}: ${esc(Array.isArray(c[k]) ? c[k].join(" ") : c[k]) || "—"}`),
    "Сделали:", ...c.done.map(s => `- ${esc(s)}`),
    ...(c.result?.length ? ["Что изменилось:", ...c.result.map(s => `- ${esc(s)}`)] : []),
    ...NUMS.map(([label, i]) => `${label}: ${c.nums[i] ?? "—"}`),
    ...(c.nums[2] > 5 ? [`⚠️ <b>Монтаж ${c.nums[2]} дней</b> — проверьте даты начала и окончания монтажа в сделке. Исправили — напишите в группу <code>кейс ${d.lead}</code>.`] : []),
    `<i>Из CRM на страницу:</i> ${c.timeline?.length ? `ход работ (${c.timeline.map(t => `${esc(t.title.toLowerCase())} ${esc(t.date)}`).join(" · ")})` : "дат нет"}` +
      `${c.works?.length ? ` · работ по счёту: ${c.works.length}` : ""}`, "",
    d.story ? "✍️ История учтена." : "✍️ <b>Для подробной страницы</b> ответьте: <code>история:</code> с чем пришёл клиент · что было особенного на объекте · что изменилось. Можно надиктовать голосом → текстом.",
    "",
    "<i>Правки — ответом на это сообщение:</i>",
    "• <code>оставить 2, 4, 7</code> · <code>обложка 4</code> · <code>убрать 3</code> · <code>вернуть 3</code>",
    "  (номер фото — в углу, когда откроете фото; можно несколько строк в одном сообщении)",
    "• весь текст с «Заголовок:», «Сделали:»… — заменю целиком",
    "• пожелание («короче», «добавь, что работали ночью») — перепишу",
    "• старые сделки: напишите в группу <code>кейс 6912345</code> (номер из адреса сделки) — пришлю черновик",
    "⚠️ Проверьте фото: нет ли лиц, номеров машин и схемы слепых зон."
  ];
  return lines.join("\n");
}

function draftButtons(d) {
  const L = d.lead;
  return used(d).length
    ? [[btn("✅ Опубликовать", `pub:${L}`), btn("✖️ Отклонить", `rej:${L}`)], [btn("🔄 Собрать заново", `redo:${L}`)]]
    : [[btn("✅ Опубликовать без фото", `pub:${L}`), btn("⏳ Ждать фото", `wait:${L}`)], [btn("✖️ Отклонить", `rej:${L}`), btn("🔄 Собрать заново", `redo:${L}`)]];
}
const dropMessage = mid => mid && max(`/messages?message_id=${encodeURIComponent(mid)}`, undefined, "DELETE").catch(e => console.warn(e.message));
// Текст черновика с кнопками; прежний текст этого черновика удаляем — в группе всегда один живой черновик. Сохранить d — дело вызывающего.
async function sendDraft(d) {
  if (d.summary) await dropMessage(d.summary);
  d.summary = await say(draftText(d), { lead: d.lead, buttons: draftButtons(d) });
  d.mids = [...(d.mids || []), d.summary].filter(Boolean);
}

// Текст, скопированный из черновика и исправленный: берём поля, которые узнали; остальное оставляем
const LISTS = [["Сделали", "done"], ["Что изменилось", "result"]];
function parseFull(text, c) {
  if (!/(^|\n)\s*Заголовок\s*:/i.test(text)) return null;
  const out = { ...c, nums: [...c.nums] };
  const lists = {};
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^([А-Яа-яЁё ,]+?)\s*:\s*(.*)$/);
    const f = m && FIELDS.find(([label]) => label.toLowerCase() === m[1].toLowerCase());
    const n = m && NUMS.find(([label]) => label.toLowerCase() === m[1].toLowerCase());
    const l = m && LISTS.find(([label]) => label.toLowerCase() === m[1].toLowerCase());
    if (l) { list = l[1]; lists[list] = m[2] ? [m[2]] : []; continue; }
    if (f || n) list = null;
    if (f) out[f[1]] = f[1] === "task" ? (m[2] ? [m[2]] : []) : m[2];
    else if (n) out.nums[n[1]] = num(m[2]);
    else if (list && /^[-•—*]\s*/.test(line)) lists[list].push(line.replace(/^[-•—*]\s*/, ""));
  }
  Object.assign(out, lists);
  return out;
}

/* ---------- Сборка черновика ---------- */
async function buildDraft(leadId, { update = false } = {}) {
  const raw = await readLead(leadId);
  const old = await getJson(`drafts/${leadId}.json`);
  const published = await getJson(`published/${leadId}.json`);
  const photos = await listPhotos(raw.folder).catch(e => { console.error(e); return []; });
  const d = {
    lead: leadId, status: "draft", update: update || Boolean(published), slug: published?.slug || null,
    created: new Date().toISOString(), raw, case: null, photos: [], off: [], cover: 1
  };
  // Старые фото этого черновика больше не нужны
  for (const key of await list(`drafts/${leadId}/`)) await del(key);

  const previews = [];
  await pool(photos, 3, async (f, i) => {
    try {
      const { data } = await drive(`file=${encodeURIComponent(f.id)}`);
      const { site, preview } = await processPhoto(Buffer.from(data, "base64"), i + 1);
      const key = `drafts/${leadId}/${i + 1}.webp`;
      await putBin(key, site, "image/webp");
      d.photos[i] = { n: i + 1, drive: f.id, key, hash: crypto.createHash("md5").update(f.id).digest("hex").slice(0, 6) };
      previews[i] = preview;
    } catch (e) { console.warn(`Фото ${f.name} пропущено: ${e.message}`); } // одно битое фото не должно ронять весь черновик
  });
  d.photos = d.photos.filter(Boolean);
  const batch = await getJson(BATCH);
  if (batch?.current === leadId && batch.list.length > 1) d.pos = `${batch.done + 1} из ${batch.list.length}`;

  // Обновление опубликованного кейса: фото, обложка и текст — как на сайте (источник правды — cases.json на GitHub).
  // Фото узнаём по «отпечатку» в имени файла: NN-<md5(id на Диске)>.webp. Из CRM свежие только цифры и даты.
  const all = await publishedCases();
  const site = published ? all.find(c => c.slug === published.slug) || null : null;
  // Чем уже сказано в других кейсах — чтобы тексты не повторялись
  d.avoid = all.filter(c => c !== site).flatMap(c => [c.title, ...(c.done || [])]).filter(Boolean).slice(0, 40);
  if (site) {
    const hashes = (site.photos || []).map(p => (p.match(/-([0-9a-f]{6})\.webp$/) || [])[1]).filter(Boolean);
    const byHash = new Map(d.photos.map(p => [p.hash, p.n]));
    if (hashes.some(h => byHash.has(h))) {
      d.off = d.photos.filter(p => !hashes.includes(p.hash)).map(p => p.n);
      d.cover = byHash.get(hashes[0]) || used(d)[0]?.n || 1;
      d.photosFromSite = true;
    }
  }
  // Иначе (или если фото на сайте не нашлись): ручная работа из прежнего черновика —
  // выбор фото и обложка (фото узнаём по id на Google Диске)
  if (old && !d.photosFromSite) {
    const byDrive = new Map(d.photos.map(p => [p.drive, p.n]));
    const was = n => byDrive.get(old.photos?.find(p => p.n === n)?.drive);
    d.off = (old.off || []).map(was).filter(Boolean);
    d.cover = was(old.cover) || d.cover;
    if (d.off.includes(d.cover)) d.cover = used(d)[0]?.n || 1;
  }
  d.story = old?.story || "";
  d.addrManual = old?.addrManual || false;
  if (site) {
    // Текст уже одобрен и опубликован — не переписываем; переписать можно ответом «перепиши»
    d.case = { type: raw.type || site.type, city: raw.city || site.city, addr: site.addr, title: site.title, lead: site.lead,
      task: site.task || [], done: site.done || [], result: site.result || [], works: site.works || [],
      nums: [raw.cams, raw.cable, raw.days], timeline: raw.timeline?.length ? raw.timeline : site.timeline || [] };
    d.textFromSite = true;
  } else {
    d.case = await writeCase(raw, d.story, d.avoid);
    if (d.addrManual && old?.case?.addr) d.case.addr = old.case.addr;
  }
  await putJson(`drafts/${leadId}.json`, d);

  await sendDraft(d);
  // Превью по 10 в сообщении, с номерами на фото
  for (let i = 0; i < previews.length; i += 10) {
    const chunk = previews.slice(i, i + 10).filter(Boolean);
    const images = await pool(chunk, 3, buf => uploadImage(buf));
    d.mids.push(await say(`Фото ${i + 1}–${i + chunk.length} · сделка №${leadId}`, { lead: leadId, images }));
  }
  await putJson(`drafts/${leadId}.json`, d);
  // Прежний черновик этой сделки (и «Собираю заново…») убираем из группы; сообщения об опубликованном кейсе не трогаем
  if (old && !["published", "publishing"].includes(old.status)) for (const m of old.mids || []) await dropMessage(m);
}

/* ---------- Публикация: один коммит в GitHub ---------- */
const gh = (path, body, method) => httpJson(`https://api.github.com/repos/${REPO()}${path}`, {
  method: method || (body ? "POST" : "GET"),
  headers: { Authorization: `Bearer ${env("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "moidozor-case" },
  body: body ? JSON.stringify(body) : undefined
}, { what: "GitHub" });
async function ghFile(path) {
  try { const f = await gh(`/contents/${path}?ref=main`); return Buffer.from(f.content, "base64").toString("utf8"); }
  catch (e) { if (/ 404/.test(e.message)) return null; throw e; }
}
async function ghDir(path) {
  try { return (await gh(`/contents/${path}?ref=main`)).map(f => f.path); }
  catch (e) { if (/ 404/.test(e.message)) return []; throw e; }
}

const TR = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const translit = s => String(s).toLowerCase().replace(/[а-яё]/g, c => TR[c] ?? "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function publish(leadId) {
  const d = await getJson(`drafts/${leadId}.json`);
  if (!d || d.status !== "publishing") return;
  const cases = JSON.parse(await ghFile("cases.json") || "[]");
  const template = await ghFile("cases/_template.html");
  if (!template) throw new Error("в репозитории нет cases/_template.html");
  const sitemap = await ghFile("sitemap.xml");

  // Имя страницы: у повторной публикации — прежнее, у новой — «тип-город», при совпадении с другим объектом — с номером
  let slug = d.slug;
  if (!slug) {
    const base = translit(`${d.case.type} ${d.case.city}`) || `obekt-${leadId}`;
    slug = base;
    for (let k = 2; cases.some(c => c.slug === slug) || await ghFile(`cases/${slug}.html`); k++) slug = `${base}-${k}`;
  }
  const on = used(d);
  const ordered = [...on.filter(p => p.n === d.cover), ...on.filter(p => p.n !== d.cover)];
  const photos = ordered.map((p, i) => ({ p, path: `assets/cases/${slug}/${String(i + 1).padStart(2, "0")}-${p.hash}.webp` }));
  const entry = { slug, date: today(), ...d.case, photos: photos.map(x => x.path), url: `cases/${slug}.html` };
  const rest = cases.filter(c => c.slug !== slug);
  const nextCases = [entry, ...rest];

  // Дерево изменений: фото, страница, cases.json, sitemap.xml; старые фото этого кейса — удалить
  const tree = [];
  for (const { p, path } of photos) {
    const blob = await gh("/git/blobs", { content: (await getBin(p.key)).toString("base64"), encoding: "base64" });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const old of await ghDir(`assets/cases/${slug}`)) if (!photos.some(x => x.path === old)) tree.push({ path: old, mode: "100644", type: "blob", sha: null });
  tree.push({ path: entry.url, mode: "100644", type: "blob", content: renderCase(template, entry, rest) });
  tree.push({ path: "cases.json", mode: "100644", type: "blob", content: JSON.stringify(nextCases, null, 2) + "\n" });
  if (sitemap) tree.push({ path: "sitemap.xml", mode: "100644", type: "blob", content: addToSitemap(sitemap, entry) });

  for (let attempt = 0; ; attempt++) {
    const ref = await gh("/git/ref/heads/main");
    const parent = await gh(`/git/commits/${ref.object.sha}`);
    const t = await gh("/git/trees", { base_tree: parent.tree.sha, tree });
    const commit = await gh("/git/commits", { message: `Кейс: ${d.case.type}, ${d.case.city} (сделка ${leadId})`, tree: t.sha, parents: [ref.object.sha] });
    try { await gh("/git/refs/heads/main", { sha: commit.sha }, "PATCH"); break; }
    catch (e) { if (attempt >= 2 || !/ 422/.test(e.message)) throw e; await sleep(2000); } // кто-то запушил одновременно — повторяем
  }

  const url = SITE_URL + entry.url;
  await dropMessage(d.summary);                     // «⏳ Публикую…» больше не нужно — ниже придёт «✅ опубликован»
  Object.assign(d, { status: "published", slug, published: new Date().toISOString() });
  await putJson(`drafts/${leadId}.json`, d);
  await putJson(`published/${leadId}.json`, { slug, url });
  await amo(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text: `Кейс на сайте: ${url}` } }]).catch(e => console.warn(e.message));
  if (!on.length) await putJson(`waiting/${leadId}.json`, { until: Date.now() + WAIT_DAYS * 864e5, last: Date.now() });
  await say(`✅ <b>Кейс опубликован</b> · сделка №${leadId}\n<a href="${esc(url)}">${esc(url)}</a>\nНа сайте появится через 1–2 минуты.` +
    (on.length ? "" : `\nФото нет — ${WAIT_DAYS} дней раз в день проверяю папку и пришлю обновление, если появятся.`), { lead: leadId });
  await nextInBatch(leadId);
}

/* ---------- Кнопки и ответы из MAX ---------- */
// Ответ на нажатие: всплывающая строка, а сообщение с кнопками заменяется текстом — видно, что нажатие сработало
async function answer(cb, msg, note, text, buttons) {
  const message = text ? { text, format: "html", attachments: buttons ? [{ type: "inline_keyboard", payload: { buttons } }] : [] } : undefined;
  try { await max(`/answers?callback_id=${encodeURIComponent(cb.callback_id)}`, { notification: note, ...(message ? { message } : {}) }); }
  catch (e) {
    console.warn(e.message);
    const mid = msg?.body?.mid;
    if (message && mid) await max(`/messages?message_id=${encodeURIComponent(mid)}`, message, "PUT").catch(e2 => console.warn(e2.message));
  }
}

async function onCallback(cb, msg) {
  const [action, id] = String(cb.payload || "").split(":");
  const lead = Number(id);
  const d = lead && await getJson(`drafts/${lead}.json`);
  const redo = [[btn("🔄 Собрать заново", `redo:${lead}`)]];
  if (!d) return answer(cb, msg, "Черновик не найден");
  if (action === "redo") {
    await queue("build", lead);
    return answer(cb, msg, "Собираю заново", `🔄 Собираю заново черновик по сделке №${lead} — пришлю через 1–2 минуты.`);
  }
  if (d.status !== "draft")
    return answer(cb, msg, { publishing: "Уже публикую", published: "Уже опубликовано", rejected: "Черновик отклонён — нажмите «Собрать заново»", waiting: "Жду фото" }[d.status] || "Уже обработано");
  if (action === "pub") {
    d.status = "publishing";
    await putJson(`drafts/${lead}.json`, d);
    await queue("publish", lead);
    return answer(cb, msg, "Публикую", `⏳ Публикую кейс по сделке №${lead} — около минуты.`);
  }
  if (action === "rej") {
    d.status = "rejected";
    await putJson(`drafts/${lead}.json`, d);
    await answer(cb, msg, "Отклонено", `✖️ Черновик по сделке №${lead} отклонён.`, redo);
    return nextInBatch(lead);
  }
  if (action === "wait") {
    d.status = "waiting";
    await putJson(`drafts/${lead}.json`, d);
    await putJson(`waiting/${lead}.json`, { until: Date.now() + WAIT_DAYS * 864e5, last: Date.now() });
    await answer(cb, msg, "Жду фото", `⏳ Жду фото по сделке №${lead}: ${WAIT_DAYS} дней раз в день проверяю папку. Появятся — пришлю новый черновик.`, redo);
    return nextInBatch(lead);
  }
  return answer(cb, msg, "Готово");
}

// «кейс 6912345», «кейсы 6912345, 6898765» или ссылки на сделки — черновики по старым сделкам без переноса по воронке.
// Без номера («кейс хороший») — не команда.
function parseCaseCommand(text) {
  if (!/^кейс[ыа]?(?=[\s:,]|$)/i.test(text)) return null;
  const ids = [...text.matchAll(/leads\/detail\/(\d{5,10})/g)].map(m => Number(m[1]));
  for (const m of text.replace(/https?:\/\/\S+/g, " ").matchAll(/(?<!\d)\d{5,10}(?!\d)/g)) ids.push(Number(m[0]));
  return ids.length ? [...new Set(ids)] : null;
}

// Очередь «кейсы N1, N2…»: черновики по одному. Следующий — после «Опубликовать», «Отклонить» или «Ждать фото».
// batch.json: { list: [сделки по порядку], done: сколько пройдено, current: сделка в работе }
const BATCH = "batch.json";
const numList = list => list.map(l => `№${l}`).join(", ");
async function caseCommand(ids, mid) {
  const b = await getJson(BATCH);
  if (b?.list?.length) {
    const add = ids.filter(l => !b.list.includes(l));
    b.list.push(...add);
    await putJson(BATCH, b);
    return say(`➕ ${add.length ? `Добавил в очередь: ${numList(add)}.` : "Эти сделки уже в очереди."} Осталось ${b.list.length - b.done}, сейчас в работе №${b.current}.`, { reply: mid });
  }
  const list = ids.slice(0, 30);
  await putJson(BATCH, { list, done: 0, current: list[0] });
  await queue("build", list[0]);
  await say(list.length > 1
    ? `📥 Очередь: ${list.length} ${[2, 3, 4].includes(list.length % 10) && ![12, 13, 14].includes(list.length % 100) ? "сделки" : "сделок"} (${numList(list)}). Присылаю по одному: следующий — после «Опубликовать», «Отклонить» или «Ждать фото». Первый, №${list[0]}, — через 1–2 минуты.`
    : `📥 Собираю черновик №${list[0]} — пришлю через 1–2 минуты.`, { reply: mid });
}
// С черновиком закончили — следующий из очереди (если эта сделка сейчас в работе)
async function nextInBatch(lead) {
  const b = await getJson(BATCH);
  if (!b || b.current !== lead) return;
  b.done++;
  if (b.done >= b.list.length) {
    await del(BATCH);
    if (b.list.length > 1) await say(`🏁 Очередь кейсов пройдена: ${b.list.length}.`);
    return;
  }
  b.current = b.list[b.done];
  await putJson(BATCH, b);
  await queue("build", b.current);
}
async function publishedCases() {
  try { return JSON.parse(await ghFile("cases.json") || "[]"); }
  catch (e) { console.warn(e.message); return []; }
}

async function onReply(msg) {
  const replyTo = msg.link?.type === "reply" ? msg.link.message?.mid : null;
  const text = String(msg.body?.text || "").trim();
  if (!text) return;
  if (!replyTo) {                                     // обычная переписка в группе — не наша, кроме команды «кейс N»
    if (/^очередь\s+(сброс|стоп|отмена|очистить)/i.test(text)) { await del(BATCH); return say("Очередь кейсов очищена.", { reply: msg.body?.mid }); }
    const ids = parseCaseCommand(text);
    return ids ? caseCommand(ids, msg.body?.mid) : undefined;
  }
  const ref = await getJson(`mids/${replyTo}.json`);
  if (!ref) return;
  const d = await getJson(`drafts/${ref.lead}.json`);
  const mid = msg.body?.mid;
  if (!d || d.status !== "draft") return say("Этот черновик уже не редактируется: он опубликован, отклонён или ждёт фото.", { reply: mid });

  // Команды про фото — каждая строка отдельно: «оставить 2, 4, 7» и «обложка 4» можно одним сообщением
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.every(l => /^(убра|верн|остав|обложк)/i.test(l))) {
    for (const l of lines) {
      const nums = (l.match(/\d+/g) || []).map(Number).filter(n => d.photos.some(p => p.n === n));
      if (/^убра/i.test(l)) d.off = [...new Set([...d.off, ...nums])];
      else if (/^верн/i.test(l)) d.off = d.off.filter(n => !nums.includes(n));
      else if (/^остав/i.test(l) && nums.length) {
        d.off = d.photos.map(p => p.n).filter(n => !nums.includes(n));
        if (!nums.includes(d.cover)) d.cover = nums[0];
      } else if (/^обложк/i.test(l) && nums.length) { d.cover = nums[0]; d.off = d.off.filter(n => n !== d.cover); }
    }
  } else if (/^истори/i.test(text)) {
    d.story = text.replace(/^истори[яю]\s*[:\-—]?\s*/i, "").slice(0, 1500);
    try { d.case = { ...(await writeCase({ ...d.raw, cams: d.case.nums[0], cable: d.case.nums[1], days: d.case.nums[2] }, d.story)), addr: d.case.addr }; }
    catch (e) { console.error(e); return say(`Не получилось переписать: ${esc(e.message)}`, { reply: mid }); }
  } else {
    const full = parseFull(text, d.case);
    if (full) { if (full.addr !== d.case.addr) d.addrManual = true; d.case = full; }
    else {
      try { d.case = await rewriteCase(d, text.slice(0, 500)); }
      catch (e) { console.error(e); return say(`Не получилось переписать: ${esc(e.message)}`, { reply: mid }); }
    }
  }
  if (d.off.includes(d.cover)) d.cover = used(d)[0]?.n || 1;
  await sendDraft(d);
  await putJson(`drafts/${d.lead}.json`, d);
}

/* ---------- Таймер: задания из очереди и проверка «ждём фото» ---------- */
async function worker() {
  const t0 = Date.now();
  for (const key of (await list("jobs/")).sort()) {
    if (Date.now() - t0 > 60e3) break;               // остальное — в следующую минуту
    const job = await getJson(key);
    await del(key);                                   // сразу забираем, чтобы следующий запуск не взял его второй раз
    if (!job) continue;
    try {
      if (job.kind === "build") await buildDraft(job.lead, job);
      if (job.kind === "publish") await publish(job.lead);
    } catch (e) {
      console.error(e);
      if (job.kind === "publish") {
        const d = await getJson(`drafts/${job.lead}.json`).catch(() => null);
        if (d) { d.status = "draft"; await putJson(`drafts/${job.lead}.json`, d).catch(() => {}); }
      }
      await say(`⚠️ Не получилось ${job.kind === "publish" ? "опубликовать" : "собрать"} кейс по сделке №${job.lead}: ${esc(e.message)}\n` +
        (job.kind === "publish" ? "Черновик на месте — можно нажать «Опубликовать» ещё раз." : "Можно нажать «Собрать заново» позже."),
        { lead: job.lead, buttons: [...(job.kind === "publish" ? [[btn("✅ Опубликовать ещё раз", `pub:${job.lead}`)]] : []), [btn("🔄 Собрать заново", `redo:${job.lead}`)]] }).catch(() => {});
      if (job.kind === "build") await nextInBatch(job.lead).catch(() => {});   // черновик не собрался — не держим очередь
    }
  }
  // Раз в сутки: не появились ли фото у тех, кого ждём
  for (const key of await list("waiting/")) {
    const w = await getJson(key), lead = Number(key.match(/(\d+)\.json$/)?.[1]);
    if (!w || !lead) continue;
    if (Date.now() > w.until) { await del(key); continue; }
    if (Date.now() - w.last < 864e5) continue;
    w.last = Date.now();
    await putJson(key, w);
    const raw = await readLead(lead).catch(() => null);
    const photos = raw ? await listPhotos(raw.folder).catch(() => []) : [];
    if (photos.length) { await del(key); await queue("build", lead, { update: true }); }
  }
}

/* ---------- Проверка настроек: открыть адрес функции с ?setup=1&s=HOOK_SECRET ---------- */
async function setup(selfUrl) {
  const s = encodeURIComponent(env("HOOK_SECRET"));
  const amoHook = `${selfUrl}?src=amo&s=${s}`, maxHook = `${selfUrl}?src=max&s=${s}`;
  const check = async (name, fn) => { try { return `✅ ${name}${(await fn()) || ""}`; } catch (e) { return `❌ ${name}: ${e.message}`; } };
  const lines = await Promise.all([
    check("Сжатие фото (sharp)", async () => { loadSharp(); }),
    check("Бакет", async () => { await putJson("setup-check.json", { t: Date.now() }); await del("setup-check.json"); }),
    check("YandexGPT", async () => { await gpt('Ответь JSON {"ok":true}'); }),
    check("amoCRM", async () => ` — ${(await amo("/api/v4/account")).name}`),
    check("Скрипт Google Диска", async () => { await drive("ping=1"); }),
    check("GitHub", async () => { await ghFile("cases.json"); }),
    check("MAX: подписка бота на события", async () => {
      const { subscriptions = [] } = await max("/subscriptions");
      if (!subscriptions.some(x => x.url === maxHook))
        await max("/subscriptions", { url: maxHook, update_types: ["message_created", "message_callback"] });
      return " — включена";
    })
  ]);
  return [
    "Проверка настроек автокейсов «Мой Дозор»", "", ...lines, "",
    "Адрес для Webhook в amoCRM (этап «Проверено»):", amoHook, "",
    "Если какая-то строка с ❌ — пришлите этот экран (адреса можно замазать)."
  ].join("\n");
}

/* ---------- Вход ---------- */
function parseForm(body) {
  const ids = new Set();
  for (const [k, v] of new URLSearchParams(body)) if (/^leads\[(status|add|update)\]\[\d+\]\[id\]$/.test(k)) ids.add(Number(v));
  return [...ids].filter(Boolean);
}
const text200 = (body = "ok") => ({ statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body });

module.exports.handler = async (event, context) => {
  IAM = context?.token?.access_token || "";
  // Таймер
  if (!event.httpMethod && Array.isArray(event.messages)) { await worker(); return { ok: true }; }

  const q = event.queryStringParameters || {};
  if (!env("HOOK_SECRET") || q.s !== env("HOOK_SECRET")) return { statusCode: 403, body: "forbidden" };
  const body = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
  const selfUrl = env("SELF_URL") || `https://functions.yandexcloud.net/${context.functionName}`;

  if (q.setup) return text200(await setup(selfUrl));

  if (q.src === "amo") {
    // amoCRM может прислать одну и ту же сделку дважды — черновик моложе 10 минут не пересобираем
    for (const lead of parseForm(body)) {
      const d = await getJson(`drafts/${lead}.json`);
      if (d && d.status === "draft" && Date.now() - Date.parse(d.created) < 10 * 60e3) continue;
      await queue("build", lead);
    }
    return text200();
  }

  if (q.src === "max") {
    let u = {};
    try { u = JSON.parse(body); } catch {}
    const chat = String(u.message?.recipient?.chat_id ?? "");
    try {
      if (u.update_type === "message_callback") await onCallback(u.callback, u.message);
      else if (u.update_type === "message_created" && !u.message?.sender?.is_bot && chat === env("MAX_CHAT_ID")) await onReply(u.message);
    } catch (e) { console.error(e); }
    return text200();
  }
  return text200("Мой Дозор: автокейсы");
};
