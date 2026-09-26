"""Объекты на карте сайта из выгрузки amoCRM.

Читает все CSV из data/ (экспорт сделок amoCRM) и tools/objects_extra.json,
собирает список объектов и переписывает в index.html данные плашек карты —
SITE.objects между // CRM-OBJECTS:BEGIN и // CRM-OBJECTS:END.

Правила:
  • воронка «База клиентов» — все сделки с адресом и типом объекта; другие воронки —
    только сделки, у которых «Дата окончания монтажа» уже наступила; с «Причиной отказа» — нет;
  • имена и телефоны не выводятся; сделки одного контакта по одному адресу склеиваются;
  • населённый пункт определяется по словарю PLACES/TOWNS, без геокодеров;
  • в плашке — улица и номер дома (без офиса и квартиры); у частных домов, дач, квартир и СНТ —
    улица без номера дома;
  • камеры — поле «Камер (шт)», поверх него objects_extra.json → cams (по ID сделки),
    а где пусто — повторяемая оценка по типу объекта (в отчёте помечена ≈).

Запуск из папки сайта: python3 tools/build_objects.py   (--dry-run — только отчёт, без записи)
"""
import csv, glob, hashlib, json, os, re, sys
from collections import defaultdict
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HTML = os.path.join(ROOT, "index.html")
BASE_FUNNEL = "База клиентов"

# ---------------------------------------------------------------- places
# Точки на карте сайта (data-obj у .pin) и заголовки плашек
PINS = {"samara": "Самарская область", "volgograd": "Волгоград", "vladimir": "Владимир", "omsk": "Омск",
        "krasnodar": "Краснодар", "moscow": "Москва", "spb": "Санкт-Петербург", "ufa": "Уфа"}
# Города вне Самарской области; всё остальное относится к точке samara
CITY_PIN = {"Волгоград": "volgograd", "Владимир": "vladimir", "Омск": "omsk", "Краснодар": "krasnodar",
            "Москва": "moscow", "Санкт-Петербург": "spb", "Уфа": "ufa"}

# Населённые пункты: широта, долгота (Википедия / Викиданные); координаты пока не нужны — точек объектов на карте нет
TOWNS = {
    "Самара": (53.1959, 50.1002), "Самарская обл.": (53.1959, 50.1002),  # СНТ без посёлка — в самарское скопление
    "Тольятти": (53.5078, 49.4204), "Новокуйбышевск": (53.0959, 49.9462), "Кинель": (53.2210, 50.6340),
    "Кинельский р-н": (53.2210, 50.6340),  # точнее района не знаем — точка в Кинеле
    "Усть-Кинельский": (53.2684, 50.5814), "Смышляевка": (53.2555, 50.3899), "Черноречье": (53.1605, 50.3849),
    "Лопатино": (53.0779, 50.2172), "Богатое": (53.0614, 51.3331), "Заглядовка": (53.6058, 50.2789),
    "Кордон": (52.5861, 49.1025), "Алексеевский": (52.5325, 49.8341), "Алексеевка": (53.25, 50.5),
    "Борское": (53.0292, 51.7014), "Царевщина": (53.4333, 50.1167), "Безенчук": (52.9818, 49.4359),
    "Жареный Бугор": (53.5450, 50.2808), "Водинский массив": (53.3718, 50.3409), "Чёрновский": (53.1834, 50.4629),
    "Прибрежный": (53.4879, 49.8589), "Новосемейкино": (53.3733, 50.3458), "Старая Бинарадка": (53.5796, 49.9648),
    "Бинарадка": (53.5796, 49.9648), "Преображенка": (53.0857, 50.1203), "Красноармейское": (52.7228, 50.0356),
    "Шилан": (53.4914, 50.6217), "Ягодное": (53.6131, 49.0453),
    "Волгоград": (48.7080, 44.5133), "Владимир": (56.1290, 40.4066), "Омск": (54.9885, 73.3242),
    "Краснодар": (45.0355, 38.9753), "Москва": (55.7558, 37.6173), "Санкт-Петербург": (59.9343, 30.3351),
    "Уфа": (54.7388, 55.9721),
}

# Как узнать населённый пункт по адресу (шаблоны по нормализованному адресу; порядок важен).
# Адрес без населённого пункта считается самарским: в CRM так пишут улицы Самары.
PLACES = [
    (r"\bусть кинельск\w*", "Усть-Кинельский"),
    (r"\bкинельск\w* (район|р н)\b", "Кинельский р-н"),
    (r"\bкинел\w*", "Кинель"),
    (r"\bстарая бинарадк\w*", "Старая Бинарадка"),
    (r"\bбинарадк\w*", "Бинарадка"),
    (r"\bягодн\w*", "Ягодное"),
    (r"\bтольятт\w*", "Тольятти"),
    (r"\bновокуйбышевск\w*", "Новокуйбышевск"),
    (r"\bсмышляевк\w*", "Смышляевка"),              # «Смышляевское шоссе» — это Самара
    (r"\bчерноречь\w*", "Черноречье"),
    (r"\bлопатин\w*", "Лопатино"),
    (r"\bбогатое\b", "Богатое"),
    (r"\bзаглядовк\w*", "Заглядовка"),
    (r"\bк[ао]рдон\b", "Кордон"),
    (r"\bалексеевский\b", "Алексеевский"),
    (r"\bалексеевк\w*", "Алексеевка"),
    (r"\bборское\b", "Борское"),
    (r"\bцаревщин\w*", "Царевщина"),
    (r"\bбезенчук\w*", "Безенчук"),
    (r"\bжарен\w* бугор\w*", "Жареный Бугор"),
    (r"\bводинск\w*( массив\w*)?", "Водинский массив"),
    (r"\bчерновск\w*", "Чёрновский"),
    (r"\bприбре[гж]\w*", "Прибрежный"),
    (r"\bновосемейкин\w*", "Новосемейкино"),
    (r"\bпреображенк\w*", "Преображенка"),
    (r"\bкрасноармейское\b", "Красноармейское"),
    (r"\bшилан\w*", "Шилан"),
    (r"\bволгоград\w*", "Волгоград"),
    (r"\bвладимир\b", "Владимир"),
    (r"\bомск\b", "Омск"),
    (r"\bкраснодар\b", "Краснодар"),
    (r"\bзубчанинов\w*|\bрубеж\w*|\bгорел\w* хутор\w*|\bпросек\w*|\bкерамик\w*|\bкрасная глинка", "Самара"),
    (r"\bснт\b", "Самарская обл."),
]
SETTLEMENT_WORD = re.compile(r"\b(с|село|п|пос|поселок|пгт|деревня|район|р н|хутор|снт)\b")
LEAD_TOWN = re.compile(r"(?i)^\s*((г|город)\.?\s*)?(" + "|".join(map(re.escape, TOWNS)) + r")\s*,")  # «Тольятти, …»

# Посёлки в черте Самары остаются в адресе (None — не показываем)
SAMARA_AREAS = [
    (r"\bзубчанинов\w*", "пос. Зубчаниновка"),
    (r"\bрубеж\w*", "пос. Рубёжное"),
    (r"\bгорел\w* хутор\w*", "пос. Горелый Хутор"),
    (r"\bкрасная глинка", "пос. Красная Глинка"),
    (r"\bза керамик\w*|\bкерамик\w*", None),
]
# «8 просека», «9ая просека», «7линия», «2 проезд», «проезд 8» → «8-я просека», «7-я линия», «2-й проезд»
NUMBERED = [
    (r"(?i)\b(\d+)\s*-?(?:ая|я)?\s*просек\w*|(?:^|,)\s*просек\w*\s*(\d+)\b", "{}-я просека"),
    (r"(?i)\b(\d+)\s*-?(?:ая|я)?\s*лини\w*|(?:^|,)\s*лини\w*\s*(\d+)\b", "{}-я линия"),
    (r"(?i)\b(\d+)\s*-?(?:ый|ой|й)?\s*проезд\w*|(?:^|,)\s*проезд\s*(\d+)\b", "{}-й проезд"),
]

# ---------------------------------------------------------------- object types
TYPE_LABEL = {"мкд": "МКД", "пвз": "ПВЗ", "мед.центр": "Медцентр", "медцентр": "Медцентр",
              "склад + офис": "Склад и офис", "другое": "Объект"}
PRIVATE = {"Частный дом", "Дача", "Квартира"}
RANK = {w: i for i, w in enumerate(["Склад", "База", "Производство", "Цех", "Завод", "Офис", "Медцентр", "ПВЗ",
                                    "Магазин", "Помещение", "Территория", "МКД", "Объект", "Частный", "Дача", "Квартира"])}


def estimate_cams(kind, seed):
    """Правдоподобное число камер, пока нет точного: одинаковое при каждой сборке."""
    if kind in ("Частный дом", "Дача"):
        lo, hi = 4, 6
    elif kind == "Квартира":
        lo, hi = 2, 4
    elif kind in ("Офис", "Помещение", "Медцентр", "ПВЗ", "Магазин", "Объект"):
        lo, hi = 4, 8
    else:
        lo, hi = 6, 12
    return lo + int(hashlib.md5(f"cams:{seed}".encode()).hexdigest(), 16) % (hi - lo + 1)


# ---------------------------------------------------------------- address → street and house number
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^0-9a-zа-я]+", " ", s.lower().replace("ё", "е"))).strip()
raw_re = lambda pat: pat.replace("е", "[её]").replace(" ", r"[\s-]+")  # шаблон PLACES для исходного текста

ORDINAL = re.compile(r"^\d+-?(я|й|ая|ый|ой|ий)$", re.I)
HOUSE_WORD = re.compile(r"^(д|дом|зд|здание|стр|строение|корп|корпус|к|лит|литера|офис|оф|кв|уч|участок|пом|помещение|подъезд)\.?$", re.I)
STREET_KIND = re.compile(r"^(ул\.|пр\.|проезд|трасса|ЖК|ТЦ|БЦ|ТРЦ|мкр)\s|\s(проезд|шоссе|тупик|переулок|бульвар|набережная|площадь|дорога|линия)$", re.I)
FIX = {"ул. Карла Маркса": "пр. Карла Маркса", "Гаражные проезд": "Гаражный проезд",
       "ново вокзальный тупик": "Ново-Вокзальный тупик", "ул. Нижние пески": "Нижние Пески",
       "ул. Заводскок": None}  # None — улица в CRM непонятна, показываем только населённый пункт


def house_of(tokens):
    """Номер дома из хвоста адреса: «д. 16, к. 10» → «16 к10», «1Ак1» → «1А к1». Офис, квартиру, подъезд не берём."""
    toks = [t.strip(".,") for t in tokens if t.strip(".,")]
    out, i = "", 0
    while i < len(toks):
        t, nxt = toks[i], toks[i + 1] if i + 1 < len(toks) else ""
        glued = re.fullmatch(r"(\d+[а-яa-z]?(?:/\d+[а-яa-z]?)?)?(к|корп|стр)\.?(\d+)", t, re.I)  # «1Ак1», «к2», «корп.5»
        if glued and (glued[1] or out) and not (glued[1] and out):
            out = (glued[1] or out) + (" стр. " if glued[2].lower() == "стр" else " к") + glued[3]
        elif not out and re.fullmatch(r"(д|дом|зд|здание|уч|участок)", t, re.I):
            pass
        elif not out and re.fullmatch(r"\d+[а-яa-z]?(/\d+[а-яa-z]?)?", t, re.I):
            out = t
        elif out and nxt.isdigit() and re.fullmatch(r"(к|корп|корпус|стр|строение)", t, re.I):
            out += (" стр. " if t.lower().startswith("стр") else " к") + nxt
            i += 1
        elif out and re.fullmatch(r"лит|литера", t, re.I) and re.fullmatch(r"[а-яёa-z]", nxt, re.I):
            out += " лит. " + nxt.upper()
            i += 1
        else:
            break
        i += 1
    return out or None


def street_of(raw, place_pat):
    """(улица, номер дома); улица None, если в адресе только населённый пункт."""
    s = re.sub(r"\(.*?\)", " ", raw)
    s = re.split(r"(?<=\d)\.\s+(?=[А-ЯЁ])", s)[0]  # «… 80/1. По навигатору …» — только первое предложение
    m = re.search(r"трасс\w*\s+([А-ЯЁ][\w]+)\s*[-—–]\s*([А-ЯЁ][\w]+)", s)
    if m:
        km = re.search(r"(\d+)\s*км", s)
        return f"трасса {m[1]} — {m[2]}", km and f"{km[1]} км"
    s = LEAD_TOWN.sub(",", s)
    s = re.sub(r"(?i)\b(ул|уд)\b[\s,.]*", "ул. ", s)  # «ул,», «ул.Озерная», опечатка «уд.»
    # посёлок в черте Самары, СНТ, номерные просеки, линии и проезды — начало адреса
    head = []
    for pat, label in SAMARA_AREAS:
        m = re.search(r"(?i)\b((пос[её]лок|пос|п)\.?\s*)?(?:" + raw_re(pat) + ")", s)
        if m:
            head += [label] if label else []
            s = s[:m.start()] + "," + s[m.end():]
    m = re.search(r"(?i)\bснт\s+([^,\d]+)", s)
    if m:
        head.append("СНТ «" + " ".join(w.capitalize() for w in m[1].split()) + "»")
        s = s[:m.start()] + "," + s[m.end():]
    for pat, fmt in NUMBERED:
        m = re.search(pat, s)
        if m:
            head.append(fmt.format(m[1] or m[2]))
            s = s[:m.start()] + "," + s[m.end():]
    s = re.sub(r"(?i)самарская\s+обл(асть|\.)?", ",", s)
    s = re.sub(r"(?i)[\w-]+ский\s+(район|р-н)", ",", s)
    s = re.sub(r"(?i)\b(г|город)\.?\s+[А-ЯЁ][\w-]+", ",", s)
    s = re.sub(r"(?i)\bсамара\b|\bадрес\b", ",", s)
    if place_pat:
        s = re.sub(r"(?i)\b((село|с|пос[её]лок|пос|п|пгт|снт)\.?\s*)?(?:" + raw_re(place_pat) + ")", ",", s)
    parts = s.split(",")
    street, house = None, house_of(s.replace(",", " ").split())
    for n, part in enumerate(parts):
        ws = part.split()
        cut = next((j for j, w in enumerate(ws) if not ORDINAL.match(w) and
                    (w[0].isdigit() or HOUSE_WORD.match(w) or re.match(r"^[пк]\d", w, re.I))), len(ws))
        st = " ".join(ws[:cut]).strip(" .")
        if not re.search(r"[А-ЯЁа-яё]{2}", st):
            continue
        st = re.sub(r"(?i)^(пр|пр-т|просп|проспект)\.?\s+", "пр. ", st)
        st = re.sub(r"(?i)^проезд\s+", "проезд ", st)
        st = re.sub(r"(?i)^(жк|тц|бц|трц)\s+(.+)$", lambda m: f"{m[1].upper()} «{m[2]}»", st)
        st = re.sub(r"(?<=[А-Яа-яЁё])-([а-яё])", lambda m: "-" + m[1].upper(), st)  # «Ново-садовая» → «Ново-Садовая»
        if not STREET_KIND.search(st):
            st = "ул. " + st
        street, house = FIX.get(st, st), house_of(ws[cut:] + [w for p in parts[n + 1:] for w in p.split()])
        break
    return ", ".join(head + ([street] if street else [])) or None, house


# ---------------------------------------------------------------- read CRM
def read_deals():
    deals = {}
    for fn in sorted(glob.glob(os.path.join(ROOT, "data", "*.csv"))):
        with open(fn, newline="", encoding="utf-8-sig") as f:
            head = f.readline()
            f.seek(0)
            for r in csv.DictReader(f, delimiter=";" if head.count(";") > head.count(",") else ","):
                deals[r["ID"]] = r
    return deals


def parse_date(s):
    try:
        return datetime.strptime(s.strip()[:10], "%d.%m.%Y").date()
    except ValueError:
        return None


def collect(deals, warnings):
    objs = {}
    for r in deals.values():
        g = lambda k: (r.get(k) or "").strip()
        raw, kind = g("Адрес"), g("Тип объекта")
        if not kind or kind.lower() == "другое":
            kind = g("Объект_") or kind
        if not raw or raw.strip("'- ") == "" or not kind or g("Причина отказа"):
            continue
        if g("Воронка") != BASE_FUNNEL:
            done = parse_date(g("Дата окончания монтажа"))
            if not done or done > date.today():
                continue
        kind = TYPE_LABEL.get(kind.lower(), kind[:1].upper() + kind[1:].lower())
        n = norm(raw)
        town, pat = next(((t, p) for p, t in PLACES if re.search(p, n)), (None, None))
        if not town:
            city = g("Город")
            town = city if city in TOWNS else "Самара"
            if town == "Самара" and SETTLEMENT_WORD.search(n) and not re.search(r"\bсамара\b", n):
                warnings.append(f"{r['ID']}: не знаю населённый пункт «{raw}» — поставил в Самару; добавить в PLACES/TOWNS")
        street, house = street_of(raw, pat if town != "Самара" else None)  # посёлки Самары street_of разбирает сам
        who = hashlib.md5(g("Полное имя контакта").lower().encode()).hexdigest() if g("Полное имя контакта") else "id" + r["ID"]
        o = objs.setdefault((who, town, (street or "").lower()),
                            {"town": town, "street": street, "house": house, "types": [], "ids": [], "cams": None, "flat": False})
        if house and o["house"] and house != o["house"]:
            warnings.append(f"{r['ID']}: у одного клиента на {street} дома {o['house']} и {house} — склеил, показан {o['house']}")
        o["house"] = o["house"] or house
        if kind not in o["types"]:
            o["types"].append(kind)
        o["ids"].append(r["ID"])
        c = re.search(r"\d+", g("Камер (шт)"))
        if c:
            o["cams"] = max(o["cams"] or 0, int(c.group()))
        o["flat"] = o["flat"] or bool(re.search(r"\bкв\b", n))
    return list(objs.values())


# ---------------------------------------------------------------- build
def low(t):
    return t if t.isupper() else t[:1].lower() + t[1:]


def main():
    dry = "--dry-run" in sys.argv
    extra = json.load(open(os.path.join(HERE, "objects_extra.json"), encoding="utf-8"))
    exact = {str(k): int(v) for k, v in extra.get("cams", {}).items()}
    warnings = []
    objs = collect(read_deals(), warnings)

    rows, est, by_pin = [], 0, defaultdict(list)
    for o in objs:
        kind = o["types"][0] if len(o["types"]) == 1 else ", ".join(
            [o["types"][0]] + [low(t) for t in o["types"][1:-1]]) + " и " + low(o["types"][-1])
        pin = CITY_PIN.get(o["town"], "samara")
        private = o["types"][0] in PRIVATE or o["flat"] or o["town"] == "Самарская обл."
        street = o["street"] and o["street"] + (", " + o["house"] if o["house"] and not private else "")
        addr = (street or o["town"]) if pin != "samara" else o["town"] + (", " + street if street else "")
        ids = sorted(o["ids"], key=int)
        cams = next((exact[i] for i in ids if i in exact), None) or o["cams"]
        mark = ""
        if not cams:
            cams, mark = estimate_cams(o["types"][0], ids[0]), "≈"
            est += 1
        item = {"pin": pin, "kind": kind, "addr": addr, "cams": cams, "town": o["town"], "ids": ids, "mark": mark,
                "private": private}
        rows.append(item)
        by_pin[pin].append(item)
    for d in extra.get("demo", []):
        item = {"pin": d["pin"], "kind": d["type"], "addr": d["addr"], "cams": d.get("cams"), "town": PINS[d["pin"]],
                "ids": ["пример"], "mark": "", "demo": True}
        by_pin[d["pin"]].append(item)

    rank = lambda it: (RANK.get(it["kind"].split()[0], 50), it["town"] != "Самара", it["town"],
                   it["addr"] == it["town"], it["addr"], it["ids"][0])  # без улицы — в конце своей группы
    for items in by_pin.values():
        items.sort(key=rank)

    # safety: no phones, flats or offices in what goes to the site; private objects — no house numbers
    for items in by_pin.values():
        for it in items:
            if re.search(r"\d{5,}|\+7|\bкв\b|\bофис\b", it["addr"], re.I) or (
                    it.get("private") and re.search(r"\d", re.sub(r"\d+-[яй]\b", "", it["addr"]))):
                sys.exit(f"СТОП: лишнее в адресе — «{it['addr']}» (сделки {it['ids']})")

    # ---- SITE.objects
    js = lambda v: json.dumps(v, ensure_ascii=False)
    sam = by_pin.get("samara", [])
    in_city = sum(1 for it in sam if it["town"] == "Самара")
    demo_pins = [PINS[p] for p, items in by_pin.items() if any(it.get("demo") for it in items)]
    warn = f"  // ⚠ Камеры у {est} объектов — оценка, заменить точными."
    if demo_pins:
        warn += f" {', '.join(demo_pins)} — тестовые адреса (demo), заменить реальными."
    out = ["  // CRM-OBJECTS:BEGIN — собирает tools/build_objects.py из выгрузки amoCRM (data/*.csv), руками не править.",
           warn, "  objects: {"]
    for key, city in PINS.items():
        items = by_pin.get(key, [])
        head = f"    {key}: {{ city: {js(city)}"
        if key == "samara" and sam:
            head += f", note: {js(f'{in_city} в Самаре, {len(sam) - in_city} по области')}"
        if any(it.get("demo") for it in items):
            head += ", demo: true"
        body = ",\n".join(f"      [{js(it['kind'])}, {js(it['addr'])}, {it['cams'] or 0}]" for it in items)
        out.append(f"{head}, items: [\n{body}\n    ] }}," if items else f"{head}, items: [] }},")
    out[-1] = out[-1].rstrip(",")
    out += ["  }", "  // CRM-OBJECTS:END"]
    block = "\n".join(out)

    # ---- report
    print(f"Объектов из CRM: {len(rows)}; тестовых: {sum(len(v) for v in by_pin.values()) - len(rows)}")
    for key, city in PINS.items():
        n = len(by_pin.get(key, []))
        print(f"  {key:<10} {city:<18} {n}" + (f"  ({in_city} в Самаре, {n - in_city} по области)" if key == "samara" else ""))
    print(f"Камеры: из CRM {sum(1 for it in rows if not it['mark'])}, оценка ≈ {est}")
    print("\nID сделки        точка      тип                      адрес                                   камеры")
    for it in sorted(rows, key=lambda it: (it["pin"], rank(it))):
        print(f"  {','.join(it['ids'])[:15]:<15} {it['pin']:<10} {it['kind']:<24} {it['addr']:<39} {it['mark']}{it['cams']}")
    for w in warnings:
        print("⚠", w)

    if dry:
        return
    html = open(HTML, encoding="utf-8").read()
    html, n = re.subn(r"(?ms)^[ \t]*// CRM-OBJECTS:BEGIN.*?// CRM-OBJECTS:END[^\n]*$", lambda m: block, html, count=1)
    if not n:
        sys.exit("СТОП: в index.html не нашёл маркеры // CRM-OBJECTS:BEGIN/END")
    open(HTML, "w", encoding="utf-8").write(html)
    print(f"\nindex.html обновлён: {len(PINS)} плашек")


if __name__ == "__main__":
    main()
