// Приём заявок с сайта «Мой Дозор»: Яндекс Облако → Cloud Functions, среда Node.js 18+.
// Заявка создаётся сделкой в amoCRM, уведомление уходит в группу MAX (и/или Telegram).
// Если amoCRM недоступна, уведомление всё равно приходит, с пометкой «внесите вручную».
//
// Переменные окружения (задаются в настройках функции, в код не вписывать).
// Уведомление уходит в те мессенджеры, у которых заданы обе переменные; остальные пропускаются.
//   MAX_TOKEN        токен бота MAX (business.max.ru → Чат-боты → бот → Интеграция)
//   MAX_CHAT_ID      номер группы MAX; пусто — функция при заявке пишет в лог группы, где состоит бот
//   TG_TOKEN         токен бота от @BotFather. Из Яндекс Облака Telegram недоступен (проверено 26.09.2026) —
//   TG_CHAT_ID       номер группы, например -5236379545. Нужен посредник за рубежом, иначе не задавать
//   TG_API           необязательно: адрес посредника вместо https://api.telegram.org
//   AMO_DOMAIN       адрес CRM, например moidozor.amocrm.ru
//   AMO_TOKEN        долгосрочный токен интеграции amoCRM
//   AMO_PIPELINE     необязательно: название воронки (без него — главная воронка)
//   AMO_STATUS       необязательно: название этапа, например «НОВЫЙ ЛИД» (без него — первый этап)
//   AMO_PIPELINE_ID, AMO_STATUS_ID — то же числами, если названия не подходят
//   AMO_JOBS_PIPELINE воронка для откликов на вакансии, например «Кандидаты» (без неё отклики — только в мессенджер)
//
// Виды заявок (поле kind): lead — клиент (по умолчанию); partner — клиент рекомендует знакомого (partner.html);
// job — отклик на вакансию (jobs.html).
// Заявки со страницы podarok.html (source=podarok) несут ещё promo, gift_status, answers, gift_deadline —
// всё пишется в примечание к сделке (отдельного поля «Промокод» в amoCRM пока нет) и в сообщение MAX.
//   ALLOWED_ORIGINS  адреса сайта через запятую; пусто — принимать откуда угодно
//   BOT_SECRET       ключ для заявок от бота-гида (проект leadmagnet-bot): запрос с заголовком X-Bot-Secret
//                    принимается без Origin и без телефона (kind: "bot"); пусто — такие заявки не принимаются

const CHANNELS = { call: "позвонить", telegram: "написать в Telegram", max: "написать в MAX", whatsapp: "написать в WhatsApp" };
const SOURCES = {
  hero: "форма на главном экране", tasks: "форма «Узнаёте?»", result: "форма «Что вы получите»", final: "форма внизу страницы",
  side: "кнопка в меню", mbar: "нижняя панель", status: "строка статуса", faq: "вопросы", case: "«Хочу так же» в кейсах",
  engineer: "«Пригласить инженера»", case_page: "форма на странице кейса", tour: "«Записаться на экскурсию»", estimate: "смета", modal: "окно заявки",
  podarok: "страница «Регистратор в подарок» (реклама)"
};
const GIFT_STATUS = { active: "закреплён", expired: "срок подарка истёк", sold_out: "подарки на месяц закончились", off: "акция выключена" };

const env = name => (process.env[name] || "").trim();
// Внешний сервис не ответил за это время — не держим посетителя сайта, идём дальше
const timeout = ms => AbortSignal.timeout(ms);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function cors(origin) {
  const allowed = env("ALLOWED_ORIGINS").split(",").map(s => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok && origin ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  };
}

const reply = (statusCode, headers, data) =>
  ({ statusCode, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(data) });

function samaraTime() {
  const d = new Date(Date.now() + 4 * 3600e3), p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const amoDomain = () => env("AMO_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const amoApi = (path, body, method) => fetch(`https://${amoDomain()}${path}`, {
  method: method || (body ? "POST" : "GET"),
  headers: { Authorization: `Bearer ${env("AMO_TOKEN")}`, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
  signal: timeout(8000)
}).then(async r => {
  const text = await r.text();
  if (!r.ok) throw new Error(`amoCRM ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
});

// Воронка и этап по названию. Ищем один раз, пока функция «тёплая»; не нашли — пишем в лог варианты и ставим по умолчанию.
const norm = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const stageCache = new Map();
function findStage(pipelineName, statusName) {
  const key = norm(pipelineName) + "|" + norm(statusName);
  if (!stageCache.has(key)) stageCache.set(key, amoApi("/api/v4/leads/pipelines").then(data => {
    const pipelines = data?._embedded?.pipelines || [];
    const want = norm(pipelineName);
    const p = want ? pipelines.find(x => norm(x.name) === want) || pipelines.find(x => norm(x.name).includes(want))
                   : pipelines.find(x => x.is_main) || pipelines[0];
    if (!p) {
      console.warn(`Воронка «${pipelineName}» не найдена. Есть: ${pipelines.map(x => x.name).join(" | ")}`);
      return {};
    }
    const statuses = p._embedded?.statuses || [], ws = norm(statusName);
    const st = ws && (statuses.find(x => norm(x.name) === ws) || statuses.find(x => norm(x.name).includes(ws)));
    if (ws && !st) console.warn(`Этап «${statusName}» в воронке «${p.name}» не найден. Есть: ${statuses.map(x => x.name).join(" | ")}`);
    return { pipeline_id: p.id, status_id: st?.id };
  }).catch(e => { stageCache.delete(key); throw e; }));
  return stageCache.get(key);
}
// Куда ставить клиентские заявки (и рекомендации): числа из настроек или поиск по названию
function salesStage() {
  if (env("AMO_PIPELINE_ID") || env("AMO_STATUS_ID") || !(env("AMO_PIPELINE") || env("AMO_STATUS")))
    return Promise.resolve({ pipeline_id: Number(env("AMO_PIPELINE_ID")) || undefined, status_id: Number(env("AMO_STATUS_ID")) || undefined });
  return findStage(env("AMO_PIPELINE"), env("AMO_STATUS"));
}

// Рекламные метки — во встроенные поля статистики сделки (utm_*, yclid, ClientID Метрики).
// Пишем только в поля, которые есть в этой amoCRM: поле с чужим кодом amoCRM не примет, и сделка не создастся.
const TRACKING = { utm_source: "UTM_SOURCE", utm_medium: "UTM_MEDIUM", utm_campaign: "UTM_CAMPAIGN",
  utm_content: "UTM_CONTENT", utm_term: "UTM_TERM", yclid: "YCLID", ym_uid: "_YM_UID", ym_counter: "_YM_COUNTER" };
const YM_COUNTER = "99939047"; // счётчик Метрики сайта — пишется вместе с ClientID
let leadFields = null;
function leadFieldIds() {
  if (!leadFields) leadFields = (async () => {
    const byCode = {};
    for (let page = 1; page <= 5; page++) {
      const data = await amoApi(`/api/v4/leads/custom_fields?limit=250&page=${page}`);
      const list = data?._embedded?.custom_fields || [];
      list.forEach(f => { if (f.code) byCode[String(f.code).toUpperCase()] = f.id; });
      if (!data?._links?.next) break;
    }
    const missing = Object.values(TRACKING).filter(c => !byCode[c]);
    if (missing.length) console.warn(`В amoCRM нет полей сделки с кодами: ${missing.join(", ")} — эти метки остаются только в примечании`);
    return byCode;
  })().catch(e => { leadFields = null; console.warn(`Поля сделок amoCRM не получены: ${e.message}`); return {}; });
  return leadFields;
}
async function trackingValues(lead) {
  const values = { ...lead.ad, ym_uid: lead.ym_uid, ym_counter: lead.ym_uid ? YM_COUNTER : "" };
  if (!Object.values(values).some(Boolean)) return [];
  const ids = await leadFieldIds();
  return Object.entries(TRACKING)
    .filter(([key, code]) => values[key] && ids[code])
    .map(([key, code]) => ({ field_id: ids[code], values: [{ value: String(values[key]) }] }));
}

// Сделка с контактом, тегами и примечанием. deal: { name, tags, contact: {name, phone}, stage: Promise<{pipeline_id, status_id}>, note }
async function toAmo(d) {
  const deal = {
    name: d.name,
    _embedded: {
      tags: d.tags.map(name => ({ name })),
      contacts: [{
        name: d.contact.name || `Клиент ${d.contact.phone}`,
        ...(d.contact.phone && { custom_fields_values: [{ field_code: "PHONE", values: [{ value: d.contact.phone, enum_code: "WORK" }] }] })
      }]
    }
  };
  const { pipeline_id, status_id } = await d.stage.catch(e => { console.warn(`Этапы amoCRM не получены: ${e.message}`); return {}; });
  if (pipeline_id) deal.pipeline_id = pipeline_id;
  if (status_id) deal.status_id = status_id;
  const fields = d.contact.ad ? await trackingValues(d.contact) : [];
  if (fields.length) deal.custom_fields_values = fields;

  let created;
  try { [created] = await amoApi("/api/v4/leads/complex", [deal]); }
  catch (e) {
    if (!deal.custom_fields_values) throw e;
    // Метки не приняты — сделку всё равно создаём, метки остаются в примечании
    console.warn(`amoCRM не приняла метки, сделка без них: ${e.message}`);
    delete deal.custom_fields_values;
    [created] = await amoApi("/api/v4/leads/complex", [deal]);
  }
  const id = created?.id;
  if (id && d.note) await amoApi(`/api/v4/leads/${id}/notes`, [{ note_type: "common", params: { text: d.note } }]).catch(() => {});
  return id;
}

const MAX_API = "https://platform-api2.max.ru";
const maxApi = (path, body) => fetch(MAX_API + path, {
  method: body ? "POST" : "GET",
  headers: { Authorization: env("MAX_TOKEN"), "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
  signal: timeout(5000)
}).then(async r => {
  const text = await r.text();
  if (!r.ok) throw new Error(`MAX ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
});

async function toMax(html) {
  await maxApi(`/messages?chat_id=${encodeURIComponent(env("MAX_CHAT_ID"))}&disable_link_preview=true`, { text: html, format: "html" });
}

// Помогает узнать номер группы MAX: пишет в лог все группы, где состоит бот
async function logMaxChats() {
  const found = new Map();
  await maxApi("/chats").then(d => (d.chats || []).forEach(c => found.set(c.chat_id, c.title))).catch(() => {});
  await maxApi("/updates?limit=100&timeout=0").then(d => (d.updates || []).forEach(u => {
    const r = u.message?.recipient || {};
    if (r.chat_id && r.chat_type !== "dialog") found.set(r.chat_id, u.chat?.title || found.get(r.chat_id) || "группа");
    if (u.chat_id) found.set(u.chat_id, u.chat?.title || found.get(u.chat_id) || "группа");
  })).catch(e => console.warn(e.message));
  console.warn(found.size
    ? `MAX_CHAT_ID не задан. Бот состоит в группах: ${[...found].map(([id, t]) => `«${t}» = ${id}`).join("; ")}`
    : "MAX_CHAT_ID не задан, а групп бот не видит: добавьте бота в группу, напишите там сообщение и отправьте заявку ещё раз");
}

// Заявка от бота-гида (MAX / Telegram): человек получил PDF и прислал фото, текст или номер.
// Телефона может не быть. Фото бот сам пересылает в группу MAX следом за этим уведомлением.
const MESSENGERS = { max: "MAX", telegram: "Telegram" };
function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && /^[78]/.test(d)) return "+7" + d.slice(1);
  if (d.length === 10 && d[0] === "9") return "+7" + d;
  return "";
}
// Клиент прислал номер после заявки: телефон — в контакт сделки, примечание — в сделку, уведомление — в MAX
async function botPhone(data) {
  const messenger = MESSENGERS[data.messenger] || "мессенджер";
  const leadId = Number(data.lead_id), rawPhone = clip(data.phone, 30), phone = normPhone(rawPhone) || rawPhone;
  const who = [clip(data.name, 80) || "клиент", data.username && "@" + clip(data.username, 64)].filter(Boolean).join(" ");
  let saved = false;
  if (leadId && phone && env("AMO_DOMAIN") && env("AMO_TOKEN")) {
    try {
      const lead = await amoApi(`/api/v4/leads/${leadId}?with=contacts`);
      const contactId = lead?._embedded?.contacts?.[0]?.id;
      if (contactId) {
        const contact = await amoApi(`/api/v4/contacts/${contactId}`);
        const phones = (contact.custom_fields_values || []).find(f => f.field_code === "PHONE")?.values || [];
        if (!phones.some(v => String(v.value).replace(/\D/g, "").endsWith(phone.replace(/\D/g, "").slice(-10)))) {
          await amoApi(`/api/v4/contacts/${contactId}`, { custom_fields_values: [{ field_code: "PHONE",
            values: [...phones.map(v => ({ value: v.value, enum_code: v.enum_code || "WORK" })), { value: phone, enum_code: "WORK" }] }] }, "PATCH");
        }
      }
      await amoApi(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text: `Клиент оставил телефон в боте ${messenger}: ${phone}` } }]);
      saved = true;
    } catch (e) { console.error(e); }
  }
  const msg = [`📞 <b>Клиент оставил телефон</b> (бот-гид, ${messenger})`, ``, `${esc(phone)} — ${esc(who)}`,
    leadId ? `<a href="https://${esc(amoDomain())}/leads/detail/${leadId}">Сделка в amoCRM №${leadId}</a>${saved ? " — телефон добавлен" : " — ⚠️ телефон не записался, внесите вручную"}` : ""]
    .filter(Boolean).join("\n");
  let sent = false;
  if (env("MAX_TOKEN") && env("MAX_CHAT_ID")) sent = await toMax(msg).then(() => true, e => { console.error(e); return false; });
  return { ok: saved || sent, amo_id: leadId || null, saved };
}

async function botLead(data) {
  const messenger = MESSENGERS[data.messenger] || "мессенджер";
  const b = {
    source: clip(data.source, 40), user_id: clip(data.user_id, 30), username: clip(data.username, 64),
    name: clip(data.name, 80), profile: clip(data.profile, 200), object: clip(data.object, 60),
    text: clip(data.text, 1000), photos: Math.max(0, Math.min(99, Number(data.photos) || 0)), files: clip(data.files, 200),
    rawPhone: clip(data.phone, 30)
  };
  const phone = normPhone(b.rawPhone);
  const contact = { name: b.name || `Клиент из ${messenger}`, phone, ad: { utm_source: b.source, utm_medium: data.messenger === "max" ? "max" : "telegram" } };
  const deal = {
    name: `Заявка из бота ${messenger}${b.object ? ": " + b.object : ""}`, tags: ["бот-гид", messenger], contact, stage: salesStage(),
    note: [`Откуда: бот-гид (${b.source}), ${messenger}`, b.object && `Объект: ${b.object}`,
      b.username && `Ник: @${b.username}`, b.profile && `Профиль: ${b.profile}`, b.user_id && `ID в ${messenger}: ${b.user_id}`,
      b.rawPhone && `Телефон: ${b.rawPhone}`, b.text && `Сообщение: ${b.text}`, b.photos && `Фото: ${b.photos} шт. — в группе MAX`,
      b.files && `Файлы: ${b.files}`].filter(Boolean).join("\n")
  };

  let amoId = null, amoError = null;
  if (env("AMO_DOMAIN") && env("AMO_TOKEN")) {
    try { amoId = await toAmo(deal); } catch (e) { amoError = e.message; console.error(e); }
  }
  const lines = [`🧲 <b>Заявка из бота-гида (${messenger})</b>`, ``];
  if (b.object) lines.push(`🏢 Объект: ${esc(b.object)}`);
  lines.push(`👤 ${esc([b.name || "без имени", b.username && "@" + b.username].filter(Boolean).join(" "))}`);
  if (b.rawPhone) lines.push(`📞 ${phone ? `+7 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}` : esc(b.rawPhone)}`);
  if (b.text) lines.push(`📝 ${esc(b.text)}`);
  if (b.photos) lines.push(`📷 Фото: ${b.photos} — следующим сообщением`);
  if (b.profile && /^https:/.test(b.profile)) lines.push(`💬 <a href="${esc(b.profile)}">написать клиенту</a>`);
  lines.push(`🕒 ${samaraTime()} (Самара)`);
  if (amoId) lines.push(``, `<a href="https://${esc(amoDomain())}/leads/detail/${amoId}">Сделка в amoCRM №${amoId}</a>`);
  else if (amoError) lines.push(``, `⚠️ В amoCRM не записалось — внесите вручную`);

  let sent = false;
  if (env("MAX_TOKEN") && env("MAX_CHAT_ID")) sent = await toMax(lines.join("\n")).then(() => true, e => { console.error(e); return false; });
  return { ok: Boolean(amoId) || sent, amo_id: amoId };
}

async function toTelegram(html) {
  const base = (env("TG_API") || "https://api.telegram.org").replace(/\/$/, "");
  const send = chat_id => fetch(`${base}/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: timeout(5000)
  }).then(r => r.json());

  let res = await send(env("TG_CHAT_ID"));
  // Группа стала «супергруппой» — у неё новый номер. Отправляем туда и просим обновить TG_CHAT_ID.
  const moved = res?.parameters?.migrate_to_chat_id;
  if (!res.ok && moved) {
    res = await send(moved);
    if (res.ok) console.warn(`Группа Telegram сменила номер: поставьте TG_CHAT_ID=${moved}`);
  }
  if (!res.ok) throw new Error(`Telegram: ${res.description || "ошибка"}`);
}

module.exports.handler = async event => {
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const { ok: originOk, headers } = cors(h.origin || "");
  const botAuth = Boolean(env("BOT_SECRET")) && h["x-bot-secret"] === env("BOT_SECRET");
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(405, headers, { ok: false });
  if (!originOk && !botAuth) return reply(403, headers, { ok: false });

  let data;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
    data = JSON.parse(raw);
  } catch {
    return reply(400, headers, { ok: false, error: "bad json" });
  }

  // Заявка от бота-гида — только с ключом
  if (data.kind === "bot") {
    if (!botAuth) return reply(403, headers, { ok: false });
    if (data.ping) return reply(200, headers, { ok: true });
    const res = data.lead_id ? await botPhone(data) : await botLead(data);
    return reply(res.ok ? 200 : 502, headers, res);
  }

  // Скрытое поле-ловушка: люди его не видят и не заполняют, спам-боты заполняют.
  if (data.website) return reply(200, headers, { ok: true });

  const kind = ["partner", "job"].includes(data.kind) ? data.kind : "lead";
  const isPhone = v => /^\+7\d{10}$/.test(v);
  const phoneText = p => `+7 (${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8, 10)}-${p.slice(10)}`;
  const lead = {
    phone: clip(data.phone, 20),
    name: clip(data.name, 80),
    channel: clip(data.channel, 20),
    source: clip(data.source, 30),
    page: clip(data.page, 200),
    note: clip(data.note, 500),
    case_ref: clip(data.case_ref, 120),
    promo: /^RT-[A-Z0-9]{4}$/.test(String(data.promo || "")) ? String(data.promo) : "",
    gift_status: GIFT_STATUS[data.gift_status] ? data.gift_status : "",
    answers: clip(data.answers, 200),
    gift_deadline: clip(data.gift_deadline, 40),
    ym_uid: /^\d{5,30}$/.test(String(data.ym_uid || "")) ? String(data.ym_uid) : "",
    ad: {}
  };
  // Рекламные метки: только известные ключи, коротко
  const AD_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "yclid"];
  if (data.ad && typeof data.ad === "object") AD_KEYS.forEach(k => { if (data.ad[k]) lead.ad[k] = clip(data.ad[k], 150); });
  if (!isPhone(lead.phone)) return reply(400, headers, { ok: false, error: "phone" });
  const partner = kind === "partner" ? { name: clip(data.partner?.name, 80), phone: clip(data.partner?.phone, 20) } : null;
  if (partner && !isPhone(partner.phone)) return reply(400, headers, { ok: false, error: "partner_phone" });
  const EXPERIENCE = { none: "без опыта", lt1: "до 1 года", "1to3": "1–3 года", gt3: "больше 3 лет" };
  const job = kind === "job" ? { experience: EXPERIENCE[data.experience] || "не указан", car: data.car === true, selfemp: data.selfemp === true } : null;

  const ad = Object.entries(lead.ad).map(([k, v]) => `${k}=${v}`).join(", ");
  const tech = [lead.page && `Страница: ${lead.page}`, ad && `Реклама: ${ad}`, lead.ym_uid && `Яндекс Метрика ClientID: ${lead.ym_uid}`];
  const TERMS = "Условия: партнёру 10 % от договора (не более 50 000 ₽) в течение 3 дней после аванса клиента; знакомому — 9-канальный регистратор в подарок при договоре от 30 000 ₽.";

  // Подарок (podarok.html): промокод, статус, ответы на вопросы
  const giftLines = [lead.promo && `Промокод: ${lead.promo}`, lead.gift_status && `Подарок: ${GIFT_STATUS[lead.gift_status]}`,
    lead.gift_deadline && `Личный срок подарка: до ${lead.gift_deadline}`, lead.answers && `Ответы: ${lead.answers}`].filter(Boolean);
  const isGift = lead.source === "podarok";

  // Что и куда пишем в amoCRM
  let deal = null;
  if (kind === "lead") deal = {
    name: isGift ? `Заявка (подарок${lead.promo ? ", " + lead.promo : ""}): ${lead.phone}` : `Заявка с сайта: ${lead.phone}`,
    tags: isGift ? ["сайт", "подарок"] : ["сайт"], contact: lead, stage: salesStage(),
    note: [`Связаться: ${CHANNELS[lead.channel] || lead.channel}`, `Откуда: ${SOURCES[lead.source] || lead.source}`,
           lead.case_ref && `Понравился кейс: ${lead.case_ref}`, ...giftLines, ...tech].filter(Boolean).join("\n")
  };
  if (kind === "partner") deal = {
    name: `Заявка на партнерство от клиента: ${lead.phone}`, tags: ["сайт", "партнёр"], contact: lead, stage: salesStage(),
    note: [`Рекомендовал: ${partner.name || "имя не указано"}, ${partner.phone}`, lead.note && `Что нужно: ${lead.note}`,
           "Знакомый знает, что его порекомендовали: да", TERMS, ...tech].filter(Boolean).join("\n")
  };
  if (kind === "job" && env("AMO_JOBS_PIPELINE")) deal = {
    name: `Отклик на вакансию «Монтажник»: ${lead.name || lead.phone}`, tags: ["сайт", "вакансия"], contact: lead,
    stage: findStage(env("AMO_JOBS_PIPELINE"), ""),
    note: [`Опыт: ${job.experience}`, `Свой автомобиль: ${job.car ? "есть" : "нет"}`, `Самозанятость или ИП: ${job.selfemp ? "есть / оформит" : "нет"}`, lead.note && `О себе: ${lead.note}`, ...tech].filter(Boolean).join("\n")
  };
  if (kind === "job" && !env("AMO_JOBS_PIPELINE")) console.warn("AMO_JOBS_PIPELINE не задан — отклик только в мессенджер");

  let amoId = null, amoError = null;
  if (deal && env("AMO_DOMAIN") && env("AMO_TOKEN")) {
    try { amoId = await toAmo(deal); } catch (e) { amoError = e.message; console.error(e); }
  }

  // Сообщение в мессенджер
  const amoLine = amoId
    ? `<a href="https://${esc(amoDomain())}/leads/detail/${amoId}">Сделка в amoCRM №${amoId}</a>`
    : amoError ? `⚠️ В amoCRM не записалось — внесите вручную` : null;
  let lines;
  if (kind === "partner") {
    lines = [`🤝 <b>Рекомендация от клиента</b>`, ``,
      `👥 Знакомый: ${esc(lead.name || "имя не указано")}, ${phoneText(lead.phone)}`,
      `🙋 Рекомендовал: ${esc(partner.name || "имя не указано")}, ${phoneText(partner.phone)}`];
    if (lead.note) lines.push(`📝 ${esc(lead.note)}`);
    lines.push(`💰 Партнёру 10 % (до 50 000 ₽) после аванса · знакомому — регистратор в подарок при договоре от 30 000 ₽`);
  } else if (kind === "job") {
    lines = [`👷 <b>Отклик на вакансию «Монтажник»</b>`, ``, `📞 ${phoneText(lead.phone)}`];
    if (lead.name) lines.push(`👤 ${esc(lead.name)}`);
    lines.push(`🧰 Опыт: ${job.experience} · авто: ${job.car ? "есть" : "нет"} · самозанятость/ИП: ${job.selfemp ? "да" : "нет"}`);
    if (lead.note) lines.push(`📝 ${esc(lead.note)}`);
  } else {
    lines = [`🔔 <b>Заявка с сайта</b>`, ``, `📞 ${phoneText(lead.phone)}`];
    if (lead.name) lines.push(`👤 ${esc(lead.name)}`);
    lines.push(`💬 ${esc(CHANNELS[lead.channel] || lead.channel || "—")}`, `📍 ${esc(SOURCES[lead.source] || lead.source || "—")}`);
    if (lead.case_ref) lines.push(`💡 Понравился кейс: ${esc(lead.case_ref)}`);
    if (lead.promo || lead.gift_status) lines.push(`🎁 ${esc([lead.promo, GIFT_STATUS[lead.gift_status]].filter(Boolean).join(" · "))}`);
    if (lead.answers) lines.push(`📝 ${esc(lead.answers)}`);
  }
  lines.push(`🕒 ${samaraTime()} (Самара)`);
  const adShort = [lead.ad.utm_source, lead.ad.utm_campaign].filter(Boolean).join(" / ") || (lead.ad.yclid ? "Яндекс Директ" : "");
  if (adShort) lines.push(`🎯 Реклама: ${esc(adShort)}`);
  if (amoLine) lines.push(``, amoLine);
  const msg = lines.join("\n");

  const notifiers = [];
  if (env("MAX_TOKEN") && env("MAX_CHAT_ID")) notifiers.push(toMax(msg));
  else if (env("MAX_TOKEN")) await logMaxChats();
  if (env("TG_TOKEN") && env("TG_CHAT_ID")) notifiers.push(toTelegram(msg));
  const results = await Promise.allSettled(notifiers);
  results.filter(r => r.status === "rejected").forEach(r => console.error(r.reason));

  const delivered = Boolean(amoId) || results.some(r => r.status === "fulfilled");
  return reply(delivered ? 200 : 502, headers, { ok: delivered });
};
