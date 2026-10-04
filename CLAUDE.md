# Сайт мойдозор.рф

Сайт «Мой Дозор» (видеонаблюдение для бизнеса, Самара) и серверные функции к нему: приём заявок и автокейсы.
Репозиторий `01fevralev-alt/moi-dozor-site` — **публичный**: никаких секретов и данных клиентов в коде.

## Что где
- Страницы: `index.html` (главная, CSS+JS внутри), `partner.html`, `jobs.html`, `podarok.html` (одноэкранник для РСЯ,
  noindex), отраслевые `sklady.html`, `proizvodstvo.html`, `mkd.html`, `dom.html`, `territorii.html`; кейсы `cases/*.html`
  (их публикует функция `moidozor-case`); общие `pages.css`/`pages.js`; документы `policy.html`, `consent.html`.
- Конфиги: `cases.json`, `podarok-config.json`, `active-goals.js` (цели Метрики).
- `backend/` — функции Яндекс Облака и Apps Script, у каждой свой README с настройкой.
- `tools/` — генерация карты объектов (Python), перекодирование видео (Swift).
- Не в git: `video/` (ролики), `data/` (выгрузки amoCRM с данными клиентов).

## Как запускать
- Локально: `python3 -m http.server 5173` (`.claude/launch.json`), открыть `http://localhost:5173`.
- Публикация: коммит → Push origin в GitHub Desktop → хостинг сам забирает изменения в течение минуты.
- Функции `backend/*`: код вставляется в консоли Облака (Cloud Functions → функция → редактор), переменные — по README.
- Перед своими правками — Fetch/Pull: функция кейсов сама коммитит в репозиторий.

## Где работает
- Хостинг reg.ru Host-0 (`server185.hosting.reg.ru`, ISPmanager, Let's Encrypt), SSH-алиас `moidozor-hosting`.
  Деплой — cron `~/bin/sync-site.sh` (git fetch с GitHub → rsync в папку сайта).
- Функции в Яндекс Облаке (`cloud-moi-dozor`): `moidozor-lead` (заявки), `moidozor-case` (кейсы, таймер раз в минуту),
  `moidozor-probe` (проверка связи). Apps Script «Мой Дозор фото» — на script.google.com.
- Метрика — счётчик 99939047; Вебмастер подтверждён файлом `yandex_5e0683e42a1238ea.html` (не удалять).

## Секреты
Только в переменных функций Облака и в коде Apps Script на script.google.com. Названия — в `.env.example`.

## Связи
Общая карта: `/Users/ila/m-dozor/infra/INFRASTRUCTURE.md`.
- **amoCRM** — заявки создают сделки (`moidozor-lead`), этап «Проверено» запускает кейс (`moidozor-case`).
- **MAX** — уведомления о заявках и черновики кейсов. Telegram из Облака недоступен.
- **Google Диск** — фото кейсов из «Папки Контент» через Apps Script «Мой Дозор фото».
- **finance** — берёт из amoCRM источник лида (UTM, yclid, ClientID), которые пишет функция заявок.
- **yandex-direct** — реклама ведёт на сайт; `podarok.html` — посадочная для РСЯ.
- **brand** — цвета, шрифт Onest, логотипы (`/Users/ila/m-dozor/brand`).
