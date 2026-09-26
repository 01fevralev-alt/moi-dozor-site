// Страница кейса из шаблона cases/_template.html и записи из cases.json.
// Без зависимостей: работает и в функции Яндекс Облака, и в браузере (для проверки шаблона).
//
// Запись кейса (cases.json, новые первыми):
//   slug    имя страницы латиницей: cases/<slug>.html, фото в assets/cases/<slug>/
//   date    дата публикации, 2026-09-27
//   type    тип объекта: «Склад»          city  город: «Самара»
//   addr    адрес для сайта (у частных — без номера дома)
//   title   задача одной фразой: «Найти, куда уходит товар между приёмкой и отгрузкой»
//   lead    1–2 предложения под заголовком        task  абзацы «Задача клиента» (массив, можно пустой)
//   done    «Что сделали», 3–6 пунктов            nums  [камер, метров кабеля, дней монтажа], null — неизвестно
//   result  «Что изменилось» — только если руководитель прислал историю
//   works   работы из счёта монтажника без цен          timeline  [{date, title, text}] — даты из сделки
//   photos  пути от корня сайта, первое — обложка; пусто — кейс без фото (на главной не показывается)
//   url     cases/<slug>.html

const SITE_URL = "https://xn--d1agelkcbq.xn--p1ai/";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
// Первая буква строчная, если это не аббревиатура («ПВЗ», «IP-камеры»)
const lcFirst = s => /^.[А-ЯЁA-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
const known = v => v !== null && v !== undefined && v !== "";

function facts(c) {
  const [cams, cable, days] = c.nums || [];
  return [
    ["Объект", c.type],
    ["Город", c.city],
    known(cams) && ["Камер", cams],
    known(cable) && ["Кабеля", `${cable} м`],
    known(days) && ["Монтаж", `${days} ${plural(+days, ["день", "дня", "дней"])}`]
  ].filter(Boolean);
}

function seoTitle(c) {
  const [cams, , days] = c.nums || [];
  const tail = [known(cams) && `${cams} ${plural(+cams, ["камера", "камеры", "камер"])}`,
                known(days) && `за ${days} ${plural(+days, ["день", "дня", "дней"])}`].filter(Boolean).join(" ");
  return `Видеонаблюдение: ${lcFirst(c.type)}, ${c.city}${tail ? ` — ${tail}` : ""}`;
}

// Частые вопросы по типу объекта: для посетителя и для поиска. Факты — как на главной (гарантия, смета, доступ с телефона).
const WARRANTY = ["Какая гарантия?", "3 года на оборудование и 1 год на монтажные работы. Если в гарантийный срок что-то перестало работать — приезжаем и чиним бесплатно."];
const FAQ = [
  [/частн|дом|дач|коттедж|квартир|снт/i, "частного дома", [
    ["Сколько камер нужно для частного дома?", "Обычно 4–6: въезд и калитка, двор, периметр участка, при необходимости — вход в дом. Точное число — после осмотра или по фото участка; смету пришлём в 3 вариантах."],
    ["Можно смотреть камеры с телефона?", "Да. Настраиваем доступ с телефона: живое видео и архив. Доступ можно дать и членам семьи."],
    ["Будет ли видно ночью?", "Ставим камеры с ИК-подсветкой: двор и въезд видны и в темноте."]]],
  [/склад|баз|логист|терминал/i, "склада", [
    ["Сколько камер нужно складу?", "Считаем от задач: по камере на ворота, отдельная — на зону приёмки, на ряды стеллажей и периметр. Точное число — после осмотра, в смете в 3 вариантах."],
    ["Будет ли виден номер машины ночью?", "Да, если камеру над воротами правильно подобрать и поставить: с ИК-подсветкой и под нужным углом."],
    ["Сколько хранится архив?", "Рассчитываем архив под вашу задачу — например, чтобы записи хватало до следующей инвентаризации."]]],
  [/магазин|пвз|пункт выдачи|торг|аптек|салон/i, "магазина", [
    ["Какие камеры нужны магазину?", "Над кассой — чтобы видеть деньги и чек, в зале — чтобы видеть покупателей у полок, у входа и на складе. Число зависит от площади; смету пришлём в 3 вариантах."],
    ["Можно понять, кто выносит товар?", "Да: камеры ставим так, чтобы в кадре были руки у полок и касса, а архив позволял разобрать любой день."],
    ["Можно смотреть магазин с телефона?", "Да, настраиваем доступ с телефона для владельца и управляющего — живое видео и архив."]]],
  [/производ|цех|завод|стро|мастерск|автосерв/i, "производства", [
    ["Подойдут ли камеры для цеха и улицы?", "Да, ставим камеры в защищённом корпусе: они работают в пыли, в мороз и в жару."],
    ["Можно ли контролировать объект ночью и в выходные?", "Да: ИК-подсветка для ночной записи и доступ с телефона — видно, что происходит, когда на объекте никого нет."],
    ["Сколько времени занимает монтаж?", "Зависит от объекта. Точный срок пишем в смете и в договоре; монтаж идёт так, чтобы не мешать работе."]]],
  [/офис|медцентр|клиник|кабинет|учебн/i, "офиса", [
    ["Сколько камер нужно офису?", "Обычно вход, ресепшен, коридоры и зоны с ценным оборудованием. Точное число — после осмотра; смету пришлём в 3 вариантах."],
    ["Можно смотреть камеры с телефона?", "Да, настраиваем доступ с телефона — живое видео и архив."],
    ["Можно доработать уже установленную систему?", "Да. Инженер приедет, проверит, что работает, и скажет, что доработать, а что заменить."]]]
];
const FAQ_DEFAULT = ["объекта", [
  ["От чего зависит стоимость?", "От количества камер, их разрешения, длины кабельных трасс и глубины архива. Смету пришлём в 3 вариантах за 15 минут."],
  ["Можно смотреть камеры с телефона?", "Да, настраиваем доступ с телефона — живое видео и архив."],
  ["Сколько времени занимает монтаж?", "Зависит от объекта. Точный срок пишем в смете и в договоре."]]];
function faqFor(type) {
  const [, name, items] = FAQ.find(([re]) => re.test(type)) || [null, ...FAQ_DEFAULT];
  return { name, items: [...items, WARRANTY] };
}

const figure = (cls, inner) => `<figure class="shot case-hero-shot${cls}" style="margin-left:0;margin-right:0">
        <span class="vf tl"></span><span class="vf tr"></span><span class="vf bl"></span><span class="vf br"></span>
        ${inner}
      </figure>`;

// other — остальные кейсы из cases.json (для блока «Другие объекты»)
function renderCase(template, c, other = []) {
  const photos = c.photos || [];
  const pageUrl = SITE_URL + c.url;
  const label = `${c.type}, ${c.addr}`;
  const description = [label, facts(c).slice(2).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join(", "), c.lead]
    .filter(Boolean).join(". ").replace(/\.\./g, ".").slice(0, 200);

  const hero = photos.length
    ? figure("", `<span class="shot-cam">CAM 01</span><span class="shot-rec"><i></i>REC</span>
        <img src="../${esc(photos[0])}" alt="${esc(label)}" width="1600" height="1200" fetchpriority="high">`)
    : figure(" case-plaque", `<p><span>Объект</span><b>${esc(c.type)}</b><span>${esc(c.addr)}</span></p>`);

  const taskSection = c.task?.length ? `<section class="sec" aria-labelledby="h-task">
    <div class="wrap">
      <div class="story">
        <div><h2 id="h-task">Задача клиента</h2><p class="sec-sub">С чем к нам пришли</p></div>
        <div>${c.task.map(p => `<p>${esc(p)}</p>`).join("")}</div>
      </div>
    </div>
  </section>` : "";

  const doneSection = c.done?.length ? `<section class="sec" aria-labelledby="h-solution">
    <div class="wrap">
      <h2 id="h-solution">Что сделали</h2>
      <ul class="ticks">${c.done.map(d => `
        <li><svg width="22" height="22"><use href="#i-check"/></svg>${esc(d)}</li>`).join("")}
      </ul>
    </div>
  </section>` : "";

  const gallerySection = photos.length > 1 ? `<section class="sec" aria-labelledby="h-photos">
    <div class="wrap">
      <h2 id="h-photos">Фото с объекта</h2>
      <p class="sec-sub">Снимки после сдачи работ. Нажмите на фото, чтобы посмотреть крупно.</p>
      <div class="gallery">${photos.map((p, i) => `
        <button type="button" aria-label="Фото ${i + 1} из ${photos.length}"><img src="../${esc(p)}" alt="${esc(`${label} — фото ${i + 1}`)}" loading="lazy"></button>`).join("")}
      </div>
    </div>
  </section>` : "";

  const tl = c.timeline || [];
  const timelineSection = tl.length ? `<section class="sec" aria-labelledby="h-steps">
    <div class="wrap">
      <h2 id="h-steps">Как проходил проект</h2>
      <ol class="timeline" data-n="${tl.length}">${tl.map(t => `
        <li class="card"><small>${esc(t.date)}</small><b>${esc(t.title)}</b><span>${esc(t.text)}</span></li>`).join("")}
      </ol>
    </div>
  </section>` : "";

  const worksSection = c.works?.length ? `<section class="sec" aria-labelledby="h-works">
    <div class="wrap">
      <h2 id="h-works">Работы на объекте</h2>
      <p class="sec-sub">Полный перечень — что сделали монтажники.</p>
      <ul class="ticks">${c.works.map(w => `
        <li><svg width="22" height="22"><use href="#i-check"/></svg>${esc(w)}</li>`).join("")}
      </ul>
    </div>
  </section>` : "";

  const resultSection = c.result?.length ? `<section class="sec" aria-labelledby="h-result">
    <div class="wrap">
      <h2 id="h-result">Что изменилось</h2>
      <ul class="ticks">${c.result.map(r => `
        <li><svg width="22" height="22"><use href="#i-check"/></svg>${esc(r)}</li>`).join("")}
      </ul>
    </div>
  </section>` : "";

  const faq = faqFor(c.type);
  const faqSection = `<section class="sec" aria-labelledby="h-faq">
    <div class="wrap">
      <h2 id="h-faq">Частые вопросы о видеонаблюдении для ${esc(faq.name)}</h2>
      <div class="faq">${faq.items.map(([q, a]) => `
        <details><summary>${esc(q)}<i></i></summary><p>${esc(a)}</p></details>`).join("")}
      </div>
    </div>
  </section>`;

  const more = other.filter(o => o.slug !== c.slug).slice(0, 3).map(o => `
        <a class="card" href="../${esc(o.url)}"><small>${esc(o.type)} · ${esc(o.city)}</small><b>${esc(o.title)}</b><span>Смотреть →</span></a>`).join("")
    || `
        <a class="card" href="../#objects"><small>Мой Дозор</small><b>Все наши работы и карта объектов</b><span>Смотреть →</span></a>`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Главная", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Наши работы", item: SITE_URL + "#objects" },
        { "@type": "ListItem", position: 3, name: `${c.type}, ${c.city}` }] },
      { "@type": "Article", headline: seoTitle(c), about: "Монтаж видеонаблюдения", datePublished: c.date, inLanguage: "ru",
        ...(photos.length ? { image: SITE_URL + photos[0] } : {}),
        author: { "@type": "Organization", name: "Мой Дозор" },
        publisher: { "@type": "Organization", name: "Мой Дозор", url: SITE_URL } },
      { "@type": "FAQPage", mainEntity: faq.items.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }
    ]
  }).replace(/</g, "\\u003c");

  const fill = {
    seoTitle: esc(seoTitle(c)),
    description: esc(description),
    pageUrl: esc(pageUrl),
    ogImage: photos.length ? `<meta property="og:image" content="${esc(SITE_URL + photos[0])}">` : "",
    jsonLd,
    crumb: esc(`${c.type}, ${c.city}`),
    h1: `${esc(`${c.type}, ${c.city}`)}: <em>${esc(lcFirst(c.title))}</em>`,
    lead: c.lead ? `<p class="lead">${esc(c.lead)}</p>` : "",
    hero,
    kfacts: facts(c).map(([k, v]) => `<div class="kfact card"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join(""),
    taskSection, doneSection, gallerySection, timelineSection, worksSection, resultSection, faqSection,
    caseRef: esc(label.slice(0, 120)),
    more
  };
  return template
    .split("\n").filter(line => !line.includes("<!--template-only-->")).join("\n")
    .replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? "");
}

// Строка в sitemap.xml: новая — добавляем, существующая — обновляем дату
function addToSitemap(xml, c) {
  const loc = SITE_URL + c.url;
  const line = `  <url><loc>${loc}</loc><lastmod>${c.date}</lastmod><priority>0.8</priority></url>`;
  const re = new RegExp(`^.*<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>.*$`, "m");
  return re.test(xml) ? xml.replace(re, line) : xml.replace("</urlset>", `${line}\n</urlset>`);
}

if (typeof module !== "undefined") module.exports = { renderCase, addToSitemap, seoTitle, plural, faqFor };
