"""
Snap every CRASH accident point onto the nearest REAL drivable Chennai road.

Deterministic, offline-repeatable: the OSM drive network is downloaded ONCE and cached
to chennai_drive.graphml; reruns load that file, so the same input always yields the same
output. Only latitude/longitude are changed — every other field is preserved byte-for-byte.

Run (needs network only on the first run, to download the road graph):
    python _snap_to_roads.py
Outputs (this folder): accidents.backup.json (once), accidents.snapped.json,
chennai_drive.graphml (cache). Also writes ../../project/preview.html for eyeballing.
"""
import json, os, statistics, shutil
try:
    # Verify HTTPS via the OS trust store — needed behind a TLS-inspecting corporate
    # proxy (Galent) whose root CA is in the Windows store but not Python's certifi.
    # No pymongo here, so the global inject is safe (unlike in the backend).
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass
import osmnx as ox
from shapely.geometry import Point, LineString
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))                 # .../CRASH/data
SRC     = os.path.join(HERE, "accidents.json")
BACKUP  = os.path.join(HERE, "accidents.backup.json")
GRAPH   = os.path.join(HERE, "chennai_drive.graphml")
OUT     = os.path.join(HERE, "accidents.snapped.json")
PREVIEW = os.path.abspath(os.path.join(HERE, "..", "..", "project", "preview.html"))
MARGIN  = 0.02                 # ~2.2 km padding around the data so edge points have roads
NETWORK = "drive"              # widen to "drive_service"/"all" if median snap dist is large

ox.settings.use_cache = True
ox.settings.log_console = False


def load_graph(bbox):
    """Load the cached drive graph, else download it for bbox and save (deterministic reruns)."""
    if os.path.exists(GRAPH):
        print(f"  loading cached road graph: {os.path.basename(GRAPH)}")
        return ox.load_graphml(GRAPH)
    west, south, east, north = bbox
    print(f"  downloading OSM '{NETWORK}' network for bbox {bbox} (first run only)…")
    G = ox.graph_from_bbox(bbox=(west, south, east, north), network_type=NETWORK,
                           simplify=True, retain_all=True, truncate_by_edge=True)
    ox.save_graphml(G, GRAPH)
    print(f"  saved {os.path.basename(GRAPH)}")
    return G


def edge_geometry(Gp, u, v, k):
    """Projected-CRS geometry of an edge; straight node-to-node line if it has none."""
    data = Gp.edges[u, v, k]
    if "geometry" in data:
        return data["geometry"]
    return LineString([(Gp.nodes[u]["x"], Gp.nodes[u]["y"]),
                       (Gp.nodes[v]["x"], Gp.nodes[v]["y"])])


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        recs = json.load(f)
    n_in = len(recs)
    print(f"loaded {n_in} accident records")

    # backup ONCE (never clobber an existing backup)
    if not os.path.exists(BACKUP):
        shutil.copyfile(SRC, BACKUP)
        print(f"backed up original -> {os.path.basename(BACKUP)}")
    else:
        print(f"backup already exists -> {os.path.basename(BACKUP)} (left as-is)")

    lats = [r["lat"] for r in recs]
    lngs = [r["lng"] for r in recs]
    bbox = (min(lngs) - MARGIN, min(lats) - MARGIN, max(lngs) + MARGIN, max(lats) + MARGIN)

    G = load_graph(bbox)
    Gp = ox.project_graph(G)                     # metric UTM CRS
    crs = Gp.graph["crs"]
    print(f"  projected graph CRS: {crs} | nodes={len(Gp.nodes)} edges={len(Gp.edges)}")

    to_proj = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    to_wgs  = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    xs, ys = to_proj.transform(lngs, lats)       # accident points in metric CRS

    print("  finding nearest road edge for every point…")
    edges, dist_to_edge = ox.distance.nearest_edges(Gp, xs, ys, return_dist=True)

    snapped, snap_dists = [], []
    for i, (u, v, k) in enumerate(edges):
        pt = Point(xs[i], ys[i])
        line = edge_geometry(Gp, u, v, k)
        sp = line.interpolate(line.project(pt))  # nearest point ON the road geometry
        snapped.append((sp.x, sp.y))
        snap_dists.append(pt.distance(sp))       # metres (projected CRS)

    # verify snapped points now lie ON the network (distance to nearest edge ~ 0)
    sx = [p[0] for p in snapped]
    sy = [p[1] for p in snapped]
    _, resid = ox.distance.nearest_edges(Gp, sx, sy, return_dist=True)
    max_resid = max(resid)

    # build output: copy each record, change ONLY lat/lng
    out = []
    for r, (px, py) in zip(recs, snapped):
        new = dict(r)
        lng2, lat2 = to_wgs.transform(px, py)
        new["lat"] = round(lat2, 6)
        new["lng"] = round(lng2, 6)
        out.append(new)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))   # match the original's compact format

    # ---- report ----
    moved = sum(1 for d in snap_dists if d > 1.0)
    within = lambda t: 100.0 * sum(1 for d in snap_dists if d <= t) / n_in
    order = sorted(range(n_in), key=lambda i: snap_dists[i], reverse=True)
    print("\n================= SNAP REPORT =================")
    print(f"records in / out         : {n_in} / {len(out)}  ({'MATCH' if n_in == len(out) else 'MISMATCH!'})")
    print(f"points moved (>1 m)      : {moved}  ({100.0*moved/n_in:.1f}%)")
    print(f"snap distance  mean      : {statistics.mean(snap_dists):.1f} m")
    print(f"               median    : {statistics.median(snap_dists):.1f} m")
    print(f"               max       : {max(snap_dists):.1f} m")
    print(f"within 5 m / 10 m / 25 m : {within(5):.1f}% / {within(10):.1f}% / {within(25):.1f}%")
    print(f"snapped-point residual to road (max): {max_resid:.3f} m  (should be ~0 -> all sit on a road)")
    print("\nfarthest-off BEFORE snapping (top 5):")
    for i in order[:5]:
        r = recs[i]
        print(f"  id {r['id']:>5} [{r['area']}]  {snap_dists[i]:7.1f} m  "
              f"({r['lat']:.5f},{r['lng']:.5f}) -> ({out[i]['lat']:.5f},{out[i]['lng']:.5f})")
    if statistics.median(snap_dists) > 40:
        print("\n  ! median > 40 m — consider NETWORK='drive_service' or 'all' and delete the graphml to redownload.")
    print("==============================================")

    # ---- throwaway preview (original vs snapped over OSM) ----
    orig_arr = [[round(r["lat"], 6), round(r["lng"], 6)] for r in recs]
    snap_arr = [[o["lat"], o["lng"]] for o in out]
    html = PREVIEW_TMPL.replace("__SNAP__", json.dumps(snap_arr)).replace("__ORIG__", json.dumps(orig_arr))
    with open(PREVIEW, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\nwrote preview -> {PREVIEW}")
    print(f"wrote snapped -> {OUT}")


PREVIEW_TMPL = """<!doctype html><html><head><meta charset="utf-8">
<title>CRASH snap preview</title><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{height:100%;margin:0}.leaflet-control-layers,.info{font:13px system-ui}
.info{position:absolute;z-index:1000;top:8px;left:50px;background:#fff;padding:6px 10px;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.3)}</style></head>
<body><div id="map"></div><div class="info">Toggle <b>Original</b> vs <b>Snapped</b> (top-right). Zoom in — snapped dots should sit on roads.</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
var SNAP=__SNAP__, ORIG=__ORIG__;
var map=L.map('map',{preferCanvas:true}).setView([13.05,80.23],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
var origL=L.layerGroup(), snapL=L.layerGroup();
ORIG.forEach(function(p){L.circleMarker(p,{radius:2,weight:0,fillColor:'#2980b9',fillOpacity:.5}).addTo(origL);});
SNAP.forEach(function(p){L.circleMarker(p,{radius:2,weight:0,fillColor:'#c0392b',fillOpacity:.75}).addTo(snapL);});
snapL.addTo(map);
L.control.layers(null,{'Snapped (red, on roads)':snapL,'Original (blue)':origL},{collapsed:false}).addTo(map);
</script></body></html>"""


if __name__ == "__main__":
    main()
