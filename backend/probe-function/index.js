// Проверка связи из Яндекс Облака: открываются ли сервисы, нужные для автокейсов.
// Ничего не создаёт и не меняет. Запуск: консоль функции → «Тестирование» → «Запустить тест».
// Переменные не обязательны. Если задан MAX_TOKEN, заодно проверяем, может ли бот MAX получать события (webhook).
//   DRIVE_FOLDER  необязательно: ссылка на любую «Папку Контент», открытую «по ссылке», — проверим, читается ли она

const env = name => (process.env[name] || "").trim();

// Любой ответ сервера (даже 401 или 404) значит, что сервис доступен. Ошибка или тайм-аут — недоступен.
async function probe(name, url, init = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    return { name, ok: true, status: r.status, ms: Date.now() - t0, sample: text.slice(0, 160).replace(/\s+/g, " ") };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: `${e.name}: ${e.cause?.code || e.message}` };
  }
}

module.exports.handler = async () => {
  const checks = [
    probe("Google Диск API", "https://www.googleapis.com/drive/v3/files?pageSize=1"),
    probe("Google вход сервисного аккаунта", "https://oauth2.googleapis.com/token", { method: "POST" }),
    probe("Google Диск (сайт)", "https://drive.google.com/"),
    probe("GitHub API", "https://api.github.com/repos/01fevralev-alt/moi-dozor-site"),
    probe("YandexGPT", "https://llm.api.cloud.yandex.net/foundationModels/v1/completion", { method: "POST" }),
    probe("Object Storage", "https://storage.yandexcloud.net/")
  ];
  const folder = env("DRIVE_FOLDER").match(/folders\/([\w-]+)|id=([\w-]+)/);
  if (folder) checks.push(probe("Папка по ссылке", `https://drive.google.com/embeddedfolderview?id=${folder[1] || folder[2]}`));
  if (env("MAX_TOKEN")) checks.push(probe("MAX: подписки бота", "https://platform-api2.max.ru/subscriptions", { headers: { Authorization: env("MAX_TOKEN") } }));

  const results = await Promise.all(checks);
  const summary = results.map(r => `${r.ok ? "✅" : "❌"} ${r.name}: ${r.ok ? `${r.status}, ${r.ms} мс` : r.error}`);
  console.log(summary.join("\n"));
  return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ summary, results }, null, 2) };
};
