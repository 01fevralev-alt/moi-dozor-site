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

async function readLead(id) {
  const lead = await amo(`/api/v4/leads/${id}`);
  const g = name => String(field(lead, name) ?? "").trim();
  const start = Number(field(lead, "Дата начала монтажа")), end = Number(field(lead, "Дата окончания монтажа"));
  const cable = (num(g("Затрачено UTP улица")) || 0) + (num(g("Затрачено UTP внутренний")) || 0);
  const link = g("Папка Контент");
  return {
    id, type: g("Тип объекта") || "Объект", city: g("Город"), addrRaw: g("Адрес"),
    private: PRIVATE.test(g("Тип объекта")) || /B2C|частн/i.test(g("Тип клиента")),
    placement: g("Размещение"), service: g("Тип услуги"), note: g("Примечание к монтажу").slice(0, 600),
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
const SYSTEM = `Ты пишешь короткие кейсы для сайта компании «Мой Дозор» (монтаж видеонаблюдения для бизнеса, Самара).
Пиши по-русски, просто и конкретно, без канцелярита, восклицаний и рекламных штампов.
Используй только факты из данных. Не выдумывай цифры, проблемы клиента, сроки, марки оборудования.
Не упоминай имя клиента, телефоны, названия компаний, внутренние заметки о деньгах и сотрудниках.
Не описывай точное расположение камер и слепые зоны объекта. Ответ — только JSON, без пояснений.`;
const SCHEMA = `{
  "addr": "адрес для сайта: город, улица и номер дома; без офиса, квартиры, подъезда, корпуса; если объект частный (дом, дача, квартира) — город и улица без номера дома",
  "title": "задача клиента одной фразой до 70 символов, с глагола: «Видеть…», «Контролировать…», «Закрыть…»",
  "lead": "1–2 предложения: что сделали и что это дало клиенту",
  "task": ["1–2 коротких абзаца о задаче клиента — только если в данных есть основания, иначе пустой массив"],
  "done": ["3–5 коротких пунктов «что сделали» по данным: сколько камер, где (по полю «Размещение»), кабель, запись и доступ с телефона"]
}`;

async function gpt(user) {
  const d = await httpJson("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: { Authorization: `Bearer ${IAM}`, "x-folder-id": env("FOLDER_ID"), "Content-Type": "application/json" },
    body: JSON.stringify({
      modelUri: `gpt://${env("FOLDER_ID")}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.3, maxTokens: "1500" },
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
  done: (Array.isArray(c.done) ? c.done : []).map(s => String(s || "").trim()).filter(Boolean).slice(0, 6),
  nums: [raw.cams, raw.cable, raw.days]
});

function writeCase(raw) {
  const data = [
    `Тип объекта: ${raw.type}`, `Город: ${raw.city || "—"}`, `Адрес из CRM: ${raw.addrRaw || "—"}`,
    `Частный объект: ${raw.private ? "да" : "нет"}`, `Размещение камер: ${raw.placement || "—"}`, `Услуга: ${raw.service || "—"}`,
    `Камер: ${raw.cams ?? "—"}`, `Кабеля, м: ${raw.cable ?? "—"}`, `Дней монтажа: ${raw.days ?? "—"}`,
    `Заметка монтажника: ${raw.note || "—"}`
  ].join("\n");
  return gpt(`Данные объекта:\n${data}\n\nНапиши кейс в формате JSON:\n${SCHEMA}`).then(c => clean(c, raw));
}

const rewriteCase = (d, wish) => gpt(`Вот кейс в JSON:\n${JSON.stringify(caseFields(d.case), null, 1)}\n\nПерепиши его по просьбе: «${wish}». ` +
  `Цифры и факты не меняй, новых не придумывай. Верни JSON в той же форме:\n${SCHEMA}`).then(c => clean(c, { ...d.raw, cams: d.case.nums[0], cable: d.case.nums[1], days: d.case.nums[2] }));
const caseFields = c => ({ addr: c.addr, title: c.title, lead: c.lead, task: c.task, done: c.done });

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
    `📝 <b>${d.update ? "Обновление кейса" : "Черновик кейса"}</b> · <a href="https://${esc(amoDomain())}/leads/detail/${d.lead}">сделка №${d.lead}</a>`,
    photos, "",
    `Тип: ${esc(c.type)} · Город: ${esc(c.city)}`,
    ...FIELDS.map(([label, k]) => `${label}: ${esc(Array.isArray(c[k]) ? c[k].join(" ") : c[k]) || "—"}`),
    "Сделали:", ...c.done.map(s => `- ${esc(s)}`),
    ...NUMS.map(([label, i]) => `${label}: ${c.nums[i] ?? "—"}`), "",
    "<i>Правки — ответом на это сообщение:</i>",
    "• <code>убрать 3 7</code> · <code>вернуть 3</code> · <code>обложка 5</code>",
    "• весь текст с «Заголовок:», «Сделали:»… — заменю целиком",
    "• пожелание («короче», «добавь, что работали ночью») — перепишу",
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
const sendDraft = d => say(draftText(d), { lead: d.lead, buttons: draftButtons(d) });

// Текст, скопированный из черновика и исправленный: берём поля, которые узнали; остальное оставляем
function parseFull(text, c) {
  if (!/(^|\n)\s*Заголовок\s*:/i.test(text)) return null;
  const out = { ...c, nums: [...c.nums] };
  let inDone = false, done = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^([А-Яа-яЁё ,]+?)\s*:\s*(.*)$/);
    const f = m && FIELDS.find(([label]) => label.toLowerCase() === m[1].toLowerCase());
    const n = m && NUMS.find(([label]) => label.toLowerCase() === m[1].toLowerCase());
    if (m && /^сделали$/i.test(m[1])) { inDone = true; if (m[2]) done.push(m[2]); continue; }
    if (f || n) inDone = false;
    if (f) out[f[1]] = f[1] === "task" ? (m[2] ? [m[2]] : []) : m[2];
    else if (n) out.nums[n[1]] = num(m[2]);
    else if (inDone && /^[-•—*]\s*/.test(line)) done.push(line.replace(/^[-•—*]\s*/, ""));
  }
  if (done.length) out.done = done;
  return out;
}

/* ---------- Сборка черновика ---------- */
async function buildDraft(leadId, { update = false } = {}) {
  const raw = await readLead(leadId);
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
  d.case = await writeCase(raw);
  await putJson(`drafts/${leadId}.json`, d);

  await sendDraft(d);
  // Превью по 10 в сообщении, с номерами на фото
  for (let i = 0; i < previews.length; i += 10) {
    const chunk = previews.slice(i, i + 10).filter(Boolean);
    const images = await pool(chunk, 3, buf => uploadImage(buf));
    await say(`Фото ${i + 1}–${i + chunk.length} · сделка №${leadId}`, { lead: leadId, images });
  }
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
  Object.assign(d, { status: "published", slug, published: new Date().toISOString() });
  await putJson(`drafts/${leadId}.json`, d);
  await putJson(`published/${leadId}.json`, { slug, url });
  await amo(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text: `Кейс на сайте: ${url}` } }]).catch(e => console.warn(e.message));
  if (!on.length) await putJson(`waiting/${leadId}.json`, { until: Date.now() + WAIT_DAYS * 864e5, last: Date.now() });
  await say(`✅ <b>Кейс опубликован</b> · сделка №${leadId}\n<a href="${esc(url)}">${esc(url)}</a>\nНа сайте появится через 1–2 минуты.` +
    (on.length ? "" : `\nФото нет — ${WAIT_DAYS} дней раз в день проверяю папку и пришлю обновление, если появятся.`), { lead: leadId });
}

/* ---------- Кнопки и ответы из MAX ---------- */
async function onCallback(cb) {
  const [action, id] = String(cb.payload || "").split(":");
  const lead = Number(id);
  const d = lead && await getJson(`drafts/${lead}.json`);
  let note = "Готово";
  if (!d) note = "Черновик не найден";
  else if (action === "redo") { await queue("build", lead); note = "Собираю заново — пришлю через 1–2 минуты"; }
  else if (d.status !== "draft") note = { publishing: "Уже публикую", published: "Уже опубликовано", rejected: "Черновик отклонён — нажмите «Собрать заново»", waiting: "Жду фото" }[d.status] || "Уже обработано";
  else if (action === "pub") {
    d.status = "publishing";
    await putJson(`drafts/${lead}.json`, d);
    await queue("publish", lead);
    note = "Публикую — займёт около минуты";
  } else if (action === "rej") {
    d.status = "rejected";
    await putJson(`drafts/${lead}.json`, d);
    await say(`✖️ Черновик по сделке №${lead} отклонён. Собрать заново — кнопка «Собрать заново».`, { lead });
    note = "Отклонено";
  } else if (action === "wait") {
    d.status = "waiting";
    await putJson(`drafts/${lead}.json`, d);
    await putJson(`waiting/${lead}.json`, { until: Date.now() + WAIT_DAYS * 864e5, last: Date.now() });
    await say(`⏳ Жду фото по сделке №${lead}: ${WAIT_DAYS} дней раз в день проверяю папку. Появятся — пришлю новый черновик.`, { lead });
    note = "Жду фото";
  }
  await max(`/answers?callback_id=${encodeURIComponent(cb.callback_id)}`, { notification: note }).catch(e => console.warn(e.message));
}

async function onReply(msg) {
  const replyTo = msg.link?.type === "reply" ? msg.link.message?.mid : null;
  const text = String(msg.body?.text || "").trim();
  if (!replyTo || !text) return;                      // обычная переписка в группе — не наша
  const ref = await getJson(`mids/${replyTo}.json`);
  if (!ref) return;
  const d = await getJson(`drafts/${ref.lead}.json`);
  const mid = msg.body?.mid;
  if (!d || d.status !== "draft") return say("Этот черновик уже не редактируется: он опубликован, отклонён или ждёт фото.", { reply: mid });

  const nums = (text.match(/\d+/g) || []).map(Number).filter(n => d.photos.some(p => p.n === n));
  if (/^убра/i.test(text)) d.off = [...new Set([...d.off, ...nums])];
  else if (/^верн/i.test(text)) d.off = d.off.filter(n => !nums.includes(n));
  else if (/^обложк/i.test(text) && nums.length) { d.cover = nums[0]; d.off = d.off.filter(n => n !== d.cover); }
  else {
    const full = parseFull(text, d.case);
    if (full) d.case = full;
    else {
      try { d.case = await rewriteCase(d, text.slice(0, 500)); }
      catch (e) { console.error(e); return say(`Не получилось переписать: ${esc(e.message)}`, { reply: mid }); }
    }
  }
  if (d.off.includes(d.cover)) d.cover = used(d)[0]?.n || 1;
  await putJson(`drafts/${d.lead}.json`, d);
  await sendDraft(d);
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
        { lead: job.lead, buttons: [[btn("🔄 Собрать заново", `redo:${job.lead}`)]] }).catch(() => {});
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
      if (u.update_type === "message_callback") await onCallback(u.callback);
      else if (u.update_type === "message_created" && !u.message?.sender?.is_bot && chat === env("MAX_CHAT_ID")) await onReply(u.message);
    } catch (e) { console.error(e); }
    return text200();
  }
  return text200("Мой Дозор: автокейсы");
};
