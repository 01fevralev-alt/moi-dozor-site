// «Мой Дозор»: отдаёт фото из «Папок Контент» функции автокейсов в Яндекс Облаке (backend/case-function).
// Google Apps Script «Мой Дозор фото» в аккаунте с папками AppSheet, развёрнут как веб-приложение:
// запуск от имени «Я», доступ «Все». Адрес …/exec и пароль — в переменных функции DRIVE_SCRIPT_URL и DRIVE_SECRET.
// Работает от имени владельца и только читает. Файлы вне папки ROOT не отдаёт.
//   ?key=…               → {"ok":true,"hello":"Мой Дозор"} — проверка
//   ?key=…&folder=ID     → список фото папки объекта (с вложенными папками до 2 уровней)
//   ?key=…&file=ID       → одно фото в base64
// После правок кода: «Начать развертывание» → «Управление развертываниями» → ✏️ → «Новая версия» (адрес не меняется).

const SECRET = "ВСТАВЬТЕ-СЮДА-ПАРОЛЬ";         // в репозитории пароля нет — он только в скрипте и в функции
const ROOT = "14BNoUNtiVJXXCbZLgV72qeqSjDlYToo-"; // общая папка, в которой лежат все «Папки Контент»
const TEST_FOLDER = "ВСТАВЬТЕ-ID-ПАПКИ-ОБЪЕКТА"; // для проверки: «Папка Контент» одного объекта с фото

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!SECRET || p.key !== SECRET) return json({ ok: false, error: "key" });
  try {
    if (p.folder) {
      const folder = DriveApp.getFolderById(p.folder);
      if (!inside(folder)) return json({ ok: false, error: "outside" });
      return json({ ok: true, files: images(folder, 0) });
    }
    if (p.file) {
      const file = DriveApp.getFileById(p.file);
      if (!inside(file)) return json({ ok: false, error: "outside" });
      const blob = file.getBlob();
      return json({ ok: true, name: file.getName(), type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) });
    }
    return json({ ok: true, hello: "Мой Дозор" });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Фото в папке объекта и во вложенных папках (до 2 уровней)
function images(folder, depth) {
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (/^image\//.test(f.getMimeType())) out.push({ id: f.getId(), name: f.getName(), size: f.getSize(), date: f.getDateCreated().toISOString() });
  }
  if (depth < 2) {
    const sub = folder.getFolders();
    while (sub.hasNext()) out.push(...images(sub.next(), depth + 1));
  }
  return out;
}

// Лежит ли файл или папка внутри ROOT: идём вверх по родительским папкам
function inside(item) {
  const seen = {};
  let level = [item];
  for (let i = 0; i < 10 && level.length; i++) {
    const next = [];
    for (const x of level) {
      if (x.getId() === ROOT) return true;
      const parents = x.getParents();
      while (parents.hasNext()) {
        const p = parents.next();
        if (!seen[p.getId()]) { seen[p.getId()] = 1; next.push(p); }
      }
    }
    level = next;
  }
  return false;
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// Проверка в редакторе: выбрать «test» в списке функций → «Выполнить» → смотреть журнал внизу
function test() {
  const t0 = Date.now();
  const r = doGet({ parameter: { key: SECRET, folder: TEST_FOLDER } });
  Logger.log((Date.now() - t0) + " мс: " + r.getContent().slice(0, 800));
}
