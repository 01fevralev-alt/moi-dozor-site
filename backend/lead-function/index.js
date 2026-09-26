// Приём заявок с сайта «Мой Дозор»: Яндекс Облако → Cloud Functions, среда Node.js 18+.
// Заявка создаётся сделкой в amoCRM и дублируется в Telegram-группу.
// Если amoCRM недоступна, заявка всё равно приходит в Telegram с пометкой.
//
// Переменные окружения (задаются в настройках функции, в код не вписывать):
//   TG_TOKEN         токен бота от @BotFather
//   TG_CHAT_ID       номер группы, например -5236379545
//   AMO_DOMAIN       адрес CRM, например moidozor.amocrm.ru
//   AMO_TOKEN        долгосрочный токен интеграции amoCRM
//   AMO_PIPELINE_ID  необязательно: воронка (без неё — основная)
//   AMO_STATUS_ID    необязательно: этап воронки (без него — первый этап)
//   ALLOWED_ORIGINS  адреса сайта через запятую; пусто — принимать откуда угодно

const CHANNELS = { call: "позвонить", telegram: "написать в Telegram", max: "написать в MAX", whatsapp: "написать в WhatsApp" };
const SOURCES = {
  hero: "форма на главном экране", tasks: "форма «Узнаёте?»", result: "форма «Что вы получите»", final: "форма внизу страницы",
  side: "кнопка в меню", mbar: "нижняя панель", status: "строка статуса", faq: "вопросы", case: "«Хочу так же» в кейсах",
  engineer: "«Пригласить инженера»", tour: "«Записаться на экскурсию»", estimate: "смета", modal: "окно заявки"
};

const env = name => (process.env[name] || "").trim();
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

async function toAmo(lead) {
  const domain = env("AMO_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const api = (path, body) => fetch(`https://${domain}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("AMO_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error(`amoCRM ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  });

  const deal = {
    name: `Заявка с сайта: ${lead.phone}`,
    _embedded: {
      tags: [{ name: "сайт" }],
      contacts: [{
        name: lead.name || `Клиент ${lead.phone}`,
        custom_fields_values: [{ field_code: "PHONE", values: [{ value: lead.phone, enum_code: "WORK" }] }]
      }]
    }
  };
  if (env("AMO_PIPELINE_ID")) deal.pipeline_id = Number(env("AMO_PIPELINE_ID"));
  if (env("AMO_STATUS_ID")) deal.status_id = Number(env("AMO_STATUS_ID"));

  const [created] = await api("/api/v4/leads/complex", [deal]);
  const id = created?.id;
  if (id) {
    const text = [`Связаться: ${CHANNELS[lead.channel] || lead.channel}`, `Откуда: ${SOURCES[lead.source] || lead.source}`, lead.page && `Страница: ${lead.page}`]
      .filter(Boolean).join("\n");
    await api(`/api/v4/leads/${id}/notes`, [{ note_type: "common", params: { text } }]).catch(() => {});
  }
  return id;
}

async function toTelegram(html) {
  const send = chat_id => fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true })
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
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(405, headers, { ok: false });
  if (!originOk) return reply(403, headers, { ok: false });

  let data;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
    data = JSON.parse(raw);
  } catch {
    return reply(400, headers, { ok: false, error: "bad json" });
  }

  // Скрытое поле-ловушка: люди его не видят и не заполняют, спам-боты заполняют.
  if (data.website) return reply(200, headers, { ok: true });

  const lead = {
    phone: clip(data.phone, 20),
    name: clip(data.name, 80),
    channel: clip(data.channel, 20),
    source: clip(data.source, 30),
    page: clip(data.page, 200)
  };
  if (!/^\+7\d{10}$/.test(lead.phone)) return reply(400, headers, { ok: false, error: "phone" });

  let amoId = null, amoError = null;
  if (env("AMO_DOMAIN") && env("AMO_TOKEN")) {
    try { amoId = await toAmo(lead); } catch (e) { amoError = e.message; console.error(e); }
  }

  const p = lead.phone;
  const phoneText = `+7 (${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8, 10)}-${p.slice(10)}`;
  const amoLine = amoId
    ? `<a href="https://${esc(env("AMO_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, ""))}/leads/detail/${amoId}">Сделка в amoCRM №${amoId}</a>`
    : amoError ? `⚠️ В amoCRM не записалось — внесите вручную` : null;
  const lines = [`🔔 <b>Заявка с сайта</b>`, ``, `📞 ${phoneText}`];
  if (lead.name) lines.push(`👤 ${esc(lead.name)}`);
  lines.push(
    `💬 ${esc(CHANNELS[lead.channel] || lead.channel || "—")}`,
    `📍 ${esc(SOURCES[lead.source] || lead.source || "—")}`,
    `🕒 ${samaraTime()} (Самара)`
  );
  if (amoLine) lines.push(``, amoLine);
  const msg = lines.join("\n");

  let tgError = null;
  try { await toTelegram(msg); } catch (e) { tgError = e.message; console.error(e); }

  const delivered = Boolean(amoId) || !tgError;
  return reply(delivered ? 200 : 502, headers, { ok: delivered });
};
