"""Main map (Russia, Mercator 2:1) + magnifier («лупа») of Samara oblast.

Sources (public domain, Natural Earth): world-atlas countries-50m (TopoJSON),
ne_10m_admin_1_states_provinces, ne_10m_rivers_lake_centerlines (GeoJSON).
Output: map2.json with SVG path strings and positions for the site.
"""
import json, math, os, random

HERE = os.path.dirname(__file__)
merc = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
inv_merc = lambda y: math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


class View:
    """Rectangular lon/lat window in Mercator, mapped to a W×H viewBox."""

    def __init__(self, lon0, lon1, lat_top, W, H):
        self.lon0, self.lon1, self.W, self.H = lon0, lon1, W, H
        span = math.radians(lon1 - lon0) * H / W
        self.y1 = merc(lat_top)
        self.y0 = self.y1 - span
        self.lat0, self.lat1 = inv_merc(self.y0), lat_top
        self.k = W / math.radians(lon1 - lon0)

    def xy(self, lon, lat):
        return (math.radians(lon - self.lon0) * self.k, (self.y1 - merc(lat)) * self.k)

    def inside(self, p):
        return self.lon0 <= p[0] <= self.lon1 and self.lat0 <= p[1] <= self.lat1


def dp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1e-9
    idx, dmax = 0, -1
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / L
        if d > dmax:
            idx, dmax = i, d
    if dmax > eps:
        return dp(pts[: idx + 1], eps)[:-1] + dp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def fmt(v):
    return "L".join(f"{x:.1f} {y:.1f}" for x, y in v)


def lines(view, pts, eps=0.8, min_len=3):
    """Open polyline cut where it leaves the window (no artificial edges)."""
    segs, cur = [], []
    for p in pts:
        if view.inside(p):
            cur.append(p)
        elif cur:
            segs.append(cur); cur = []
    if cur:
        segs.append(cur)
    out = []
    for seg in segs:
        if len(seg) < 2:
            continue
        v = [view.xy(*p) for p in seg]
        if len(v) > 3 and v[0] == v[-1]:
            # closed ring: split at the farthest point so simplification keeps its shape
            m = max(range(len(v)), key=lambda i: math.hypot(v[i][0] - v[0][0], v[i][1] - v[0][1]))
            v = dp(v[: m + 1], eps)[:-1] + dp(v[m:], eps)
        else:
            v = dp(v, eps)
        if sum(math.hypot(v[i + 1][0] - v[i][0], v[i + 1][1] - v[i][1]) for i in range(len(v) - 1)) >= min_len:
            out.append("M" + fmt(v))
    return "".join(out)


def clip_poly(view, poly):
    def clip(poly, inside, cross):
        out, prev = [], poly[-1] if poly else None
        for cur in poly:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
        return out
    lx = lambda x0: (lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])))
    ly = lambda y0: (lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0))
    poly = clip(poly, lambda p: p[0] >= view.lon0, lx(view.lon0))
    if poly: poly = clip(poly, lambda p: p[0] <= view.lon1, lx(view.lon1))
    if poly: poly = clip(poly, lambda p: p[1] >= view.lat0, ly(view.lat0))
    if poly: poly = clip(poly, lambda p: p[1] <= view.lat1, ly(view.lat1))
    return poly


def fill(view, ring, eps=0.8):
    c = clip_poly(view, ring)
    if len(c) < 3:
        return ""
    v = [view.xy(*p) for p in c]
    m = max(range(len(v)), key=lambda i: math.hypot(v[i][0] - v[0][0], v[i][1] - v[0][1]))
    v = dp(v[: m + 1], eps)[:-1] + dp(v[m:] + [v[0]], eps)
    return "M" + fmt(v[:-1]) + "Z" if len(v) >= 4 else ""


# ---------------------------------------------------------------- data
topo = json.load(open(os.path.join(HERE, "countries-50m.json")))
sx, sy = topo["transform"]["scale"]; tx, ty = topo["transform"]["translate"]
arcs = []
for arc in topo["arcs"]:
    x = y = 0; pts = []
    for dx, dy in arc:
        x += dx; y += dy; pts.append((x * sx + tx, y * sy + ty))
    arcs.append(pts)


def ring_coords(ring):
    out = []
    for a in ring:
        pts = arcs[a] if a >= 0 else list(reversed(arcs[~a]))
        out.extend(pts if not out else pts[1:])
    return out


adm = json.load(open(os.path.join(HERE, "ne_10m_admin_1_states_provinces.geojson")))
rus_regions = [f for f in adm["features"] if f["properties"].get("adm0_a3") == "RUS"]
samara = next(f for f in rus_regions if f["properties"].get("name") == "Samara")
rivers = json.load(open(os.path.join(HERE, "ne_10m_rivers_lake_centerlines.geojson")))
volga = [f for f in rivers["features"] if f["properties"].get("name") == "Volga"]


def geo_rings(g):
    if g["type"] == "Polygon":
        return [[tuple(p) for p in r] for r in g["coordinates"]]
    return [[tuple(p) for p in r] for poly in g["coordinates"] for r in poly]


def geo_lines(g):
    if g["type"] == "LineString":
        return [[tuple(p) for p in g["coordinates"]]]
    return [[tuple(p) for p in l] for l in g["coordinates"]]


# ---------------------------------------------------------------- main map
M = View(20.0, 90.0, 62.5, 1200.0, 600.0)
russia_fill, ru_lines, other_lines, ru_arcs = [], [], [], set()
for g in topo["objects"]["countries"]["geometries"]:
    if g.get("id") != "643":
        continue
    polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
    for poly in polys:
        for ring in poly:
            russia_fill.append(fill(M, ring_coords(ring)))
            for a in ring:
                ru_arcs.add(a if a >= 0 else ~a)
for i, pts in enumerate(arcs):
    d = lines(M, pts)
    if d:
        (ru_lines if i in ru_arcs else other_lines).append(d)

grat = []
for lon in range(20, 91, 10):
    grat.append(lines(M, [(lon, M.lat0 + j * (M.lat1 - M.lat0) / 40) for j in range(41)], eps=0.3))
for lat in range(45, 63, 5):
    grat.append(lines(M, [(M.lon0 + j * (M.lon1 - M.lon0) / 70, lat) for j in range(71)], eps=0.3))

samara_main = "".join(fill(M, r, 0.5) for r in geo_rings(samara["geometry"]))
volga_main = "".join(lines(M, l, 0.6) for f in volga for l in geo_lines(f["geometry"]))

cities = {
    "samara": (50.1002, 53.1959), "tolyatti": (49.4204, 53.5078), "krasnodar": (38.9753, 45.0355),
    "volgograd": (44.5133, 48.7080), "vladimir": (40.4066, 56.1290), "omsk": (73.3242, 54.9885),
    "moscow": (37.6173, 55.7558), "spb": (30.3351, 59.9343), "ufa": (55.9721, 54.7388),
}
city_xy = {k: [round(c, 1) for c in M.xy(*v)] for k, v in cities.items()}

# magnifier placement (main viewBox units) and tangent connector lines from Samara
lupa = {"cx": 820.0, "cy": 425.0, "r": 150.0}
px, py = city_xy["samara"]
dx, dy = lupa["cx"] - px, lupa["cy"] - py
dist = math.hypot(dx, dy)
base = math.atan2(dy, dx)
off = math.asin(lupa["r"] / dist)
tlen = math.sqrt(dist ** 2 - lupa["r"] ** 2)
connectors = [[px, py, round(px + tlen * math.cos(base + s * off), 1), round(py + tlen * math.sin(base + s * off), 1)] for s in (-1, 1)]

# ---------------------------------------------------------------- magnifier content (400×400)
Z = View(47.3, 53.2, 55.0, 400.0, 400.0)
neighbors = []
for f in rus_regions:
    if f is samara:
        continue
    for r in geo_rings(f["geometry"]):
        d = lines(Z, r, 0.6)
        if d:
            neighbors.append(d)
samara_border = "".join(lines(Z, r, 0.5) for r in geo_rings(samara["geometry"]))
samara_fill = "".join(fill(Z, r, 0.5) for r in geo_rings(samara["geometry"]))
volga_z = "".join(lines(Z, l, 0.5) for f in volga for l in geo_lines(f["geometry"]))

towns = {
    "Самара": (50.1002, 53.1959), "Тольятти": (49.4204, 53.5078), "Сызрань": (48.4681, 53.1585),
    "Чапаевск": (49.7064, 52.9775), "Отрадный": (51.3500, 53.3667), "Новокуйбышевск": (49.9462, 53.0959),
    "Жигулёвск": (49.4945, 53.4011), "Кинель": (50.6340, 53.2210),
}
town_xy = {k: [round(c, 1) for c in Z.xy(*v)] for k, v in towns.items()}

# DEMO points until the CRM export arrives: jittered around towns (deterministic)
rnd = random.Random(7)
weights = {"Самара": 16, "Тольятти": 10, "Сызрань": 4, "Новокуйбышевск": 3, "Чапаевск": 2, "Жигулёвск": 2, "Отрадный": 2, "Кинель": 2}
dots = []
for t, n in weights.items():
    lon, lat = towns[t]
    for _ in range(n):
        dots.append([round(c, 1) for c in Z.xy(lon + rnd.gauss(0, 0.045), lat + rnd.gauss(0, 0.03))])

out = {
    "w": M.W, "h": M.H, "grat": "".join(grat), "russia": "".join(russia_fill), "ruLines": "".join(ru_lines),
    "others": "".join(other_lines), "samara": samara_main, "volga": volga_main, "cities": city_xy,
    "lupa": lupa, "connectors": connectors,
    "z": {"neighbors": "".join(neighbors), "border": samara_border, "fill": samara_fill, "volga": volga_z, "towns": town_xy, "dots": dots},
}
json.dump(out, open(os.path.join(HERE, "map2.json"), "w"), ensure_ascii=False)
print("main lat window", round(M.lat0, 2), "–", M.lat1)
print({k: len(v) for k, v in out.items() if isinstance(v, str)})
print({k: len(v) if isinstance(v, str) else v for k, v in out["z"].items() if k not in ("towns", "dots")}, "dots", len(dots))
print(city_xy)
