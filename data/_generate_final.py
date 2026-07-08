"""FINAL enriched accidents.json — a realistic, city-wide accident simulation.

  * ~29 real Chennai junctions/areas with tiered, realistic densities — the worst
    black-spots (Kathipara/Guindy, Adyar/Madhya Kailash, Koyambedu) are heaviest;
    the rest taper down. The TOP-10 emerges from the simulation, not a fixed list.
  * Hotspot clusters are dense (tight scatter); background areas are lighter/looser.
  * Every `cause` well represented; Over-speeding & Two-wheeler lead city-wide;
    each area has a distinct dominant cause for varied interventions.
  * TEMPORAL TREND per area (Phase 2 — emerging hotspots): each area has a `trend`
    k in [-1, 1] shaping how its monthly rate changes Jul 2024 -> Jun 2026.
    k>0 = rising (OMR/IT corridor & growing outer suburbs), k~0 = stable,
    k<0 = improving (mature central areas after signal/traffic upgrades).
    Total per-area volume is UNCHANGED by the trend — only WHEN incidents fall
    across the 24 months shifts — so the volume-ranked top-10 is unaffected.
  * Deterministic (seeded).
"""
import json, math, random
from datetime import date, timedelta

random.seed(131313)

LAT_MIN, LAT_MAX = 12.83, 13.22
LNG_MIN, LNG_MAX = 80.03, 80.32
START, END = date(2024, 7, 1), date(2026, 6, 30)
SPAN = (END - START).days

CAUSES = ["Over-speeding", "Wrong-side driving", "Signal jumping", "Drunken driving",
          "Mobile phone use", "Hit and run", "Pothole / bad road",
          "Pedestrian crossing error", "Improper overtaking", "Vehicle defect", "Poor visibility"]
VEHICLES = ["Two-wheeler", "Car", "Auto-rickshaw", "Bus (MTC/Private)",
            "Lorry / Truck", "LCV / Van", "Bicycle", "Unknown (fled)"]

CAUSE_BASE = {
    "Over-speeding": 0.215, "Wrong-side driving": 0.095, "Signal jumping": 0.105,
    "Drunken driving": 0.075, "Mobile phone use": 0.09, "Hit and run": 0.055,
    "Pothole / bad road": 0.08, "Pedestrian crossing error": 0.075,
    "Improper overtaking": 0.085, "Vehicle defect": 0.04, "Poor visibility": 0.035,
}
VEH_BASE = {
    "Two-wheeler": 0.42, "Car": 0.20, "Auto-rickshaw": 0.12, "Bus (MTC/Private)": 0.07,
    "Lorry / Truck": 0.07, "LCV / Van": 0.05, "Bicycle": 0.03, "Unknown (fled)": 0.04,
}

# area: (lat, lng, fatal, serious, slight, night, rain, fog, cause, dense?, trend)
# dense=True -> tight junction cluster; False -> lighter, looser residential area.
# trend  k>0 rising | k~0 stable | k<0 improving  (Jul 2024 -> Jun 2026)
AREAS = [
    # ---- major black-spots (heaviest) — worst already, broadly stable ----
    ("Guindy",        13.0089, 80.2013, 46, 208, 350, 0.55, 0.31, 0.05, "Over-speeding",              True,  0.05),
    ("Adyar",         13.0063, 80.2417, 34, 182, 306, 0.52, 0.29, 0.04, "Signal jumping",             True,  0.00),
    ("Koyambedu",     13.0694, 80.1948, 28, 146, 256, 0.58, 0.27, 0.06, "Over-speeding",              True,  0.08),
    # ---- heavy corridors / junctions ----
    ("Vandalur",      12.8916, 80.0817, 30, 112, 178, 0.56, 0.31, 0.06, "Over-speeding",              True,  0.58),  # GST rd sprawl — rising
    ("Poonamallee",   13.0475, 80.1140, 25, 108, 170, 0.52, 0.29, 0.06, "Improper overtaking",        True,  0.55),  # NH-4 bypass — rising
    ("Teynampet",     13.0402, 80.2470, 19, 104, 190, 0.44, 0.30, 0.03, "Signal jumping",             True, -0.35),  # signal upgrades — improving
    ("Tambaram",      12.9246, 80.1273, 25, 100, 168, 0.58, 0.32, 0.06, "Hit and run",                True,  0.35),  # suburban growth
    ("Sholinganallur",12.9010, 80.2279, 23, 98,  165, 0.63, 0.35, 0.07, "Drunken driving",            True,  0.62),  # OMR — rising fast
    ("Maduravoyal",   13.0656, 80.1620, 22, 92,  155, 0.54, 0.28, 0.06, "Over-speeding",              True,  0.50),  # bypass — rising
    ("Thoraipakkam",  12.9430, 80.2330, 18, 86,  150, 0.55, 0.33, 0.05, "Over-speeding",              True,  0.65),  # OMR — rising fastest
    # ---- medium junctions ----
    ("Vadapalani",    13.0521, 80.2126, 14, 90,  172, 0.47, 0.28, 0.04, "Mobile phone use",           True,  0.00),
    ("Perungudi",     12.9650, 80.2420, 15, 80,  142, 0.51, 0.33, 0.04, "Pothole / bad road",         True,  0.60),  # OMR — rising
    ("Padi",          13.0985, 80.1893, 16, 82,  145, 0.55, 0.26, 0.08, "Vehicle defect",             True,  0.05),
    ("Porur",         13.0359, 80.1567, 16, 80,  140, 0.50, 0.27, 0.05, "Over-speeding",              True,  0.52),  # IT + construction — rising
    ("T. Nagar",      13.0418, 80.2341, 8,  72,  166, 0.36, 0.24, 0.02, "Pedestrian crossing error",  True, -0.40),  # pedestrian mgmt — improving
    ("Velachery",     12.9791, 80.2210, 12, 74,  145, 0.45, 0.26, 0.03, "Signal jumping",             True,  0.12),
    ("Saidapet",      13.0210, 80.2230, 11, 68,  135, 0.46, 0.27, 0.04, "Pedestrian crossing error",  True, -0.30),  # improving
    ("Medavakkam",    12.9200, 80.1920, 12, 64,  124, 0.49, 0.28, 0.05, "Wrong-side driving",         True,  0.60),  # fast-growing residential — rising
    ("Ambattur",      13.1143, 80.1548, 12, 66,  126, 0.50, 0.25, 0.06, "Vehicle defect",             True,  0.30),
    # ---- lighter residential / background areas (looser scatter) ----
    ("Avadi",         13.1147, 80.1005, 9,  46,  120, 0.44, 0.24, 0.05, "Over-speeding",              False, 0.15),
    ("Chromepet",     12.9516, 80.1462, 9,  46,  118, 0.47, 0.26, 0.05, "Over-speeding",              False, 0.10),
    ("Pallavaram",    12.9675, 80.1500, 8,  44,  114, 0.48, 0.27, 0.05, "Improper overtaking",        False, 0.10),
    ("Nandanam",      13.0270, 80.2440, 7,  44,  114, 0.42, 0.25, 0.03, "Signal jumping",             False,-0.25),  # improving
    ("Mylapore",      13.0339, 80.2695, 6,  40,  110, 0.43, 0.26, 0.03, "Pedestrian crossing error",  False,-0.30),  # improving
    ("Thiruvanmiyur", 12.9830, 80.2594, 6,  40,  110, 0.44, 0.29, 0.03, "Pedestrian crossing error",  False,-0.20),
    ("Perambur",      13.1180, 80.2330, 7,  42,  112, 0.47, 0.24, 0.04, "Signal jumping",             False,-0.15),
    ("Anna Nagar",    13.0850, 80.2101, 6,  40,  110, 0.40, 0.23, 0.03, "Mobile phone use",           False, 0.00),
    ("Nungambakkam",  13.0600, 80.2420, 5,  38,  105, 0.39, 0.25, 0.03, "Signal jumping",             False,-0.35),  # improving
    ("Egmore",        13.0732, 80.2609, 6,  40,  108, 0.45, 0.26, 0.03, "Pedestrian crossing error",  False,-0.35),  # improving
]
DENSE_SIGMA, LOOSE_SIGMA = 0.00065, 0.0026


def sample(clat, clng, sigma):
    for _ in range(25):
        la, ln = random.gauss(clat, sigma), random.gauss(clng, sigma)
        if LAT_MIN <= la <= LAT_MAX and LNG_MIN <= ln <= LNG_MAX:
            return la, ln
    return max(LAT_MIN, min(LAT_MAX, clat)), max(LNG_MIN, min(LNG_MAX, clng))


def sample_day(k):
    """Day offset in [0, SPAN] drawn from the linear time-density
    f(t) = (1-k) + 2k*t on t in [0,1] (t = fraction of the 24-month span).
    k>0 skews incidents toward the present (rising), k<0 toward the past
    (improving), k=0 is uniform.  The density integrates to 1 for any k in
    [-1, 1], so the area's TOTAL count is unchanged — only timing shifts."""
    u = random.random()
    if abs(k) < 1e-9:
        t = u
    else:
        disc = (1 - k) ** 2 + 4 * k * u          # >= 0 for k in [-1,1], u in [0,1]
        t = (-(1 - k) + math.sqrt(disc)) / (2 * k)
        t = min(1.0, max(0.0, t))
    return int(round(t * SPAN))


def rand_dt(night_frac, k):
    d = START + timedelta(days=sample_day(k))
    if random.random() < night_frac:
        pool = list(range(18, 24)) + list(range(0, 6)); wts = [3, 4, 4, 3, 2, 2, 2, 2, 1, 1, 2, 3]
    else:
        pool = list(range(6, 18)); wts = [2, 3, 4, 4, 3, 3, 3, 3, 3, 4, 4, 3]
    h = random.choices(pool, weights=wts, k=1)[0]
    return f"{d.isoformat()} {h:02d}:{random.randint(0,59):02d}"


def weather_of(rain, fog):
    r = random.random()
    return "rain" if r < rain else "fog" if r < rain + fog else "clear"


def weighted(w):
    keys = list(w); r = random.random() * sum(w.values()); acc = 0.0
    for k in keys:
        acc += w[k]
        if r <= acc:
            return k
    return keys[-1]


def pick_cause(severity, night, weather, area_cause):
    w = dict(CAUSE_BASE)
    w[area_cause] *= 4.5
    if area_cause != "Over-speeding":
        w["Over-speeding"] *= 0.45
    if night:
        for c, m in (("Drunken driving", 1.9), ("Hit and run", 1.6), ("Over-speeding", 1.3), ("Poor visibility", 1.5)):
            w[c] *= m
    if weather in ("rain", "fog"):
        for c, m in (("Pothole / bad road", 1.8), ("Poor visibility", 2.2), ("Over-speeding", 0.8)):
            w[c] *= m
    if severity == "fatal":
        for c, m in (("Over-speeding", 1.5), ("Wrong-side driving", 1.4), ("Drunken driving", 1.3)):
            w[c] *= m
    return weighted(w)


def pick_vehicle(cause, severity):
    w = dict(VEH_BASE)
    if cause == "Pedestrian crossing error":
        for v, m in (("Two-wheeler", 1.3), ("Bus (MTC/Private)", 1.8), ("Car", 1.3)): w[v] *= m
    if cause == "Hit and run":
        for v, m in (("Unknown (fled)", 4.5), ("Lorry / Truck", 1.8), ("Car", 1.3)): w[v] *= m
    if cause == "Drunken driving":
        for v, m in (("Two-wheeler", 1.4), ("Car", 1.3)): w[v] *= m
    if cause == "Improper overtaking":
        for v, m in (("Bus (MTC/Private)", 1.6), ("Lorry / Truck", 1.5)): w[v] *= m
    if severity == "fatal":
        for v, m in (("Lorry / Truck", 1.9), ("Bus (MTC/Private)", 1.6), ("Two-wheeler", 1.2)): w[v] *= m
    return weighted(w)


records = []
for (area, lat, lng, f, s, l, night, rain, fog, cause, dense, trend) in AREAS:
    sigma = DENSE_SIGMA if dense else LOOSE_SIGMA
    for sev, n in (("fatal", f), ("serious", s), ("slight", l)):
        for _ in range(n):
            la, ln = sample(lat, lng, sigma)
            dt = rand_dt(night, trend)
            hh = int(dt[11:13]); is_night = hh < 6 or hh >= 18
            wx = weather_of(rain, fog)
            cz = pick_cause(sev, is_night, wx, cause)
            records.append(dict(lat=round(la, 6), lng=round(ln, 6), severity=sev, datetime=dt,
                                weather=wx, cause=cz, vehicle=pick_vehicle(cz, sev), area=area))

random.shuffle(records)
records = [dict(id=i, lat=r["lat"], lng=r["lng"], severity=r["severity"], datetime=r["datetime"],
                weather=r["weather"], cause=r["cause"], vehicle=r["vehicle"], area=r["area"])
           for i, r in enumerate(records, 1)]

with open("accidents.json", "w") as fp:
    json.dump(records, fp, separators=(",", ":"))

# ---- verification: totals + emerging (recent 6 mo vs prior 18 mo) ----
from collections import Counter, defaultdict
print("total:", len(records), "| areas:", len(AREAS))
print("causes:", len(set(r["cause"] for r in records)), "min:", Counter(r["cause"] for r in records).most_common()[-1])
print("top cause:", Counter(r["cause"] for r in records).most_common(1)[0], "| top vehicle:", Counter(r["vehicle"] for r in records).most_common(1)[0])

CUT = date(2026, 1, 1)          # last 6 months = Jan–Jun 2026
rec = defaultdict(int); base = defaultdict(int)
for r in records:
    y, m, d = int(r["datetime"][:4]), int(r["datetime"][5:7]), int(r["datetime"][8:10])
    (rec if date(y, m, d) >= CUT else base)[r["area"]] += 1
print("\narea            recent  prior   rate-lift  trend")
rows = []
for (area, *_rest, trend) in AREAS:
    rr, bb = rec[area], base[area]
    lift = (rr / 6) / (bb / 18) if bb else float('inf')
    rows.append((lift, area, rr, bb, trend))
for lift, area, rr, bb, trend in sorted(rows, reverse=True):
    flag = "  <-- EMERGING" if (lift >= 1.5 and rr >= 8) else ("  (improving)" if lift < 0.85 else "")
    print(f"{area:<15} {rr:>5}  {bb:>5}   {lift:>6.2f}x   {trend:+.2f}{flag}")
