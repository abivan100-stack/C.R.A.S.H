"""
Snap every CRASH accident/incident point onto a REAL drivable Chennai road, IN PLACE,
for every shared data file the app loads (accidents.json + citizen_seed.json).

Root cause: the simulated points were scattered with a random offset around junction
centres, so some landed on buildings/parks/water.

Snapping is CLASS-AWARE: each point goes to the nearby road that minimises
    distance_metres * class_weight
so busy roads (motorway/trunk/primary/secondary) attract comparatively MORE accidents
than minor streets (residential/service) — matching real crash geography — while a
point with only a small street nearby still lands on that street. Lower weight = more
attractive. Nothing random: fixed weights + a deterministic nearest search.

Design (deterministic + idempotent):
  * OSM drive network downloaded ONCE, cached to chennai_drive.graphml (this folder);
    reruns load it from disk -> same input always yields the same output.
  * Each file is snapped FROM its <name>.backup.json (the true original) and written
    back to <name>.json in place. ONLY latitude/longitude change; every other field and
    the record order are preserved.

Run:  python snap_to_roads.py   (network needed only on the first run, to fetch the graph)
"""
import json, os, shutil, statistics
try:
    import truststore                       # verify HTTPS via the OS trust store (Galent TLS proxy)
    truststore.inject_into_ssl()
except Exception:
    pass
import numpy as np
import osmnx as ox
from shapely import STRtree
from shapely.geometry import Point

HERE  = os.path.dirname(os.path.abspath(__file__))
DATA  = os.path.abspath(os.path.join(HERE, "..", "data"))
GRAPH = os.path.join(HERE, "chennai_drive.graphml")
FILES = ["accidents.json", "citizen_seed.json"]
MARGIN, NETWORK = 0.02, "drive"

# Lower weight = more attractive. Big roads pull accidents onto them; a big road up to
# ~ (street_weight / road_weight)x farther than a small street still wins. Tune here.
WEIGHT = {
    "motorway": 0.20, "motorway_link": 0.26, "trunk": 0.20, "trunk_link": 0.26,
    "primary": 0.27, "primary_link": 0.33, "secondary": 0.38, "secondary_link": 0.44,
    "tertiary": 0.64, "tertiary_link": 0.70, "unclassified": 1.00, "road": 1.00,
    "residential": 1.85, "living_street": 2.15, "service": 2.55, "track": 2.90,
}
DEFAULT_W = 1.40
SEARCH_R  = 300.0     # metres: hard cap — a point never moves farther than this to reach a road

HIGHWAY = {"motorway", "trunk", "primary", "secondary",
           "motorway_link", "trunk_link", "primary_link", "secondary_link"}
MID = {"tertiary", "tertiary_link"}

ox.settings.use_cache = True
ox.settings.log_console = False


def rep_class(h):
    """OSM 'highway' can be a str or a list; represent an edge by its MOST major class."""
    if isinstance(h, list):
        return min(h, key=lambda x: WEIGHT.get(x, DEFAULT_W))
    return h

def edge_weight(h):
    return WEIGHT.get(rep_class(h), DEFAULT_W)

def tier_of(h):
    c = rep_class(h)
    return "highway" if c in HIGHWAY else ("mid" if c in MID else "street")


def backup_path(name):
    return os.path.join(DATA, name[:-5] + ".backup.json")

def load_original(name):
    src, bak = os.path.join(DATA, name), backup_path(name)
    if not os.path.exists(bak):
        shutil.copyfile(src, bak); print(f"  backed up {name} -> {os.path.basename(bak)}")
    else:
        print(f"  backup exists for {name} (snapping from it)")
    with open(bak, "r", encoding="utf-8") as f:
        return json.load(f)

def is_compact(name):
    with open(backup_path(name), "r", encoding="utf-8") as f:
        return "\n" not in f.read(60)

def load_graph(bbox):
    if os.path.exists(GRAPH):
        print(f"  loading cached road graph: {os.path.basename(GRAPH)}"); return ox.load_graphml(GRAPH)
    w, s, e, n = bbox
    print(f"  downloading OSM '{NETWORK}' network for bbox {bbox} (first run only)...")
    G = ox.graph_from_bbox(bbox=(w, s, e, n), network_type=NETWORK, simplify=True,
                           retain_all=True, truncate_by_edge=True)
    ox.save_graphml(G, GRAPH); return G


def main():
    originals = {name: load_original(name) for name in FILES}
    all_lat = [r["lat"] for recs in originals.values() for r in recs]
    all_lng = [r["lng"] for recs in originals.values() for r in recs]
    bbox = (min(all_lng) - MARGIN, min(all_lat) - MARGIN, max(all_lng) + MARGIN, max(all_lat) + MARGIN)

    Gp = ox.project_graph(load_graph(bbox))
    crs = Gp.graph["crs"]
    from pyproj import Transformer
    to_proj = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    to_wgs  = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    edges = ox.convert.graph_to_gdfs(Gp, nodes=False, edges=True, fill_edge_geometry=True)
    geoms   = edges.geometry.tolist()
    weights = np.array([edge_weight(h) for h in edges["highway"].tolist()])
    tiers   = [tier_of(h) for h in edges["highway"].tolist()]
    tree = STRtree(geoms)
    print(f"  graph CRS {crs} | edges {len(geoms)} | class-weighted snap (radius {SEARCH_R:.0f} m)")

    print("\n================= SNAP REPORT =================")
    examples = []
    for name in FILES:
        recs = originals[name]
        n = len(recs)
        xs, ys = to_proj.transform([r["lng"] for r in recs], [r["lat"] for r in recs])
        out, dists = [], []
        tally = {"highway": 0, "mid": 0, "street": 0}
        base_tally = {"highway": 0, "mid": 0, "street": 0}    # pure-nearest baseline, for comparison
        for r, x, y in zip(recs, xs, ys):
            pt = Point(x, y)
            cand = np.asarray(tree.query(pt.buffer(SEARCH_R)))   # bbox pre-filter
            if len(cand) == 0:
                cand = np.array([tree.nearest(pt)])
            d = np.array([pt.distance(geoms[i]) for i in cand])
            within = d <= SEARCH_R                               # keep only roads truly within the radius
            if within.any():
                cand, d = cand[within], d[within]               # bounds the move to <= SEARCH_R
            else:
                k = int(np.argmin(d)); cand, d = cand[k:k+1], d[k:k+1]   # rare: nearest road is beyond R
            j_near = cand[int(np.argmin(d))]                    # nearest by pure distance (baseline)
            j_sel  = cand[int(np.argmin(d * weights[cand]))]    # class-weighted choice
            g = geoms[j_sel]
            sp = g.interpolate(g.project(pt))
            lng2, lat2 = to_wgs.transform(sp.x, sp.y)
            new = dict(r); new["lat"], new["lng"] = round(lat2, 6), round(lng2, 6)
            out.append(new); dists.append(pt.distance(sp))
            tally[tiers[j_sel]] += 1
            base_tally[tiers[j_near]] += 1
            examples.append((pt.distance(sp), name, r["id"], tiers[j_sel]))

        sep = (",", ":") if is_compact(name) else None
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=sep) if sep else json.dump(out, f, ensure_ascii=False, indent=2)

        pct = lambda t, tl: f"{100.0*tl[t]/n:4.1f}%"
        print(f"\n[{name}]  in/out {n}/{len(out)}  ({'MATCH' if n==len(out) else 'MISMATCH!'})")
        print(f"  snap dist mean/median/max : {statistics.mean(dists):.1f} / {statistics.median(dists):.1f} / {max(dists):.1f} m")
        print(f"  road-class distribution   :  highway {tally['highway']} ({pct('highway',tally)})   "
              f"mid {tally['mid']} ({pct('mid',tally)})   street {tally['street']} ({pct('street',tally)})")
        print(f"  (pure-nearest baseline)   :  highway {base_tally['highway']} ({pct('highway',base_tally)})   "
              f"mid {base_tally['mid']} ({pct('mid',base_tally)})   street {base_tally['street']} ({pct('street',base_tally)})")

    print("\nfarthest-moved (top 5, all files):")
    for d, name, _id, tr in sorted(examples, reverse=True)[:5]:
        print(f"  {name:<18} id {str(_id):>5}  {d:7.1f} m  -> {tr}")
    print("==============================================")
    print("Wrote in place:", ", ".join(FILES))


if __name__ == "__main__":
    main()
