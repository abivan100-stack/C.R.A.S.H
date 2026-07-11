"""
Snap every CRASH accident/incident point onto the nearest REAL drivable Chennai road,
IN PLACE, for every shared data file the app loads (accidents.json + citizen_seed.json).

Root cause: the simulated points were scattered with a random offset around junction
centres, so some landed on buildings/parks/water. This moves each point to the nearest
point ON the nearest road edge.

Design (deterministic + idempotent):
  * The OSM drive network is downloaded ONCE and cached to chennai_drive.graphml (this
    folder); reruns load it from disk -> same input always yields the same output.
  * Each file is snapped FROM its <name>.backup.json (created once, the true original),
    then written back to <name>.json in place. Rerunning is safe and reproducible.
  * ONLY latitude/longitude change; every other field and the record order are preserved.

Run (network needed only on the very first run, to fetch the graph):
    python snap_to_roads.py
"""
import json, os, shutil, statistics
try:
    # Verify HTTPS via the OS trust store — needed behind a TLS-inspecting corporate
    # proxy (Galent) whose root CA is in the Windows store but not Python's certifi.
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass
import osmnx as ox
from shapely.geometry import Point, LineString
from pyproj import Transformer

HERE  = os.path.dirname(os.path.abspath(__file__))          # .../CRASH/scripts
DATA  = os.path.abspath(os.path.join(HERE, "..", "data"))
GRAPH = os.path.join(HERE, "chennai_drive.graphml")
FILES = ["accidents.json", "citizen_seed.json"]             # every shared file that feeds the maps
MARGIN  = 0.02                 # ~2.2 km padding so edge points still have roads nearby
NETWORK = "drive"              # widen to "drive_service"/"all" if median snap dist is large

ox.settings.use_cache = True
ox.settings.log_console = False


def backup_path(name):
    return os.path.join(DATA, name[:-5] + ".backup.json")   # foo.json -> foo.backup.json


def load_original(name):
    """Return the ORIGINAL records for a file, creating its backup once if missing."""
    src, bak = os.path.join(DATA, name), backup_path(name)
    if not os.path.exists(bak):
        shutil.copyfile(src, bak)
        print(f"  backed up {name} -> {os.path.basename(bak)}")
    else:
        print(f"  backup exists for {name} (snapping from it)")
    with open(bak, "r", encoding="utf-8") as f:
        return json.load(f)


def is_compact(name):
    """Match the file's original JSON style (compact vs indented) so only coords change."""
    with open(backup_path(name), "r", encoding="utf-8") as f:
        head = f.read(60)
    return "\n" not in head


def load_graph(bbox):
    if os.path.exists(GRAPH):
        print(f"  loading cached road graph: {os.path.basename(GRAPH)}")
        return ox.load_graphml(GRAPH)
    west, south, east, north = bbox
    print(f"  downloading OSM '{NETWORK}' network for bbox {bbox} (first run only)...")
    G = ox.graph_from_bbox(bbox=(west, south, east, north), network_type=NETWORK,
                           simplify=True, retain_all=True, truncate_by_edge=True)
    ox.save_graphml(G, GRAPH)
    return G


def edge_geometry(Gp, u, v, k):
    data = Gp.edges[u, v, k]
    if "geometry" in data:
        return data["geometry"]
    return LineString([(Gp.nodes[u]["x"], Gp.nodes[u]["y"]),
                       (Gp.nodes[v]["x"], Gp.nodes[v]["y"])])


def main():
    originals = {name: load_original(name) for name in FILES}

    all_lat = [r["lat"] for recs in originals.values() for r in recs]
    all_lng = [r["lng"] for recs in originals.values() for r in recs]
    bbox = (min(all_lng) - MARGIN, min(all_lat) - MARGIN, max(all_lng) + MARGIN, max(all_lat) + MARGIN)

    G  = load_graph(bbox)
    Gp = ox.project_graph(G)                     # metric UTM CRS
    crs = Gp.graph["crs"]
    print(f"  projected graph CRS: {crs} | nodes={len(Gp.nodes)} edges={len(Gp.edges)}")
    to_proj = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    to_wgs  = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    examples = []   # (dist, file, id, orig, snapped) across all files
    print("\n================= SNAP REPORT =================")
    for name in FILES:
        recs = originals[name]
        n = len(recs)
        lats = [r["lat"] for r in recs]
        lngs = [r["lng"] for r in recs]
        xs, ys = to_proj.transform(lngs, lats)
        edges, _ = ox.distance.nearest_edges(Gp, xs, ys, return_dist=True)

        out, dists, snapped_proj = [], [], []
        for r, (u, v, k), x, y in zip(recs, edges, xs, ys):
            pt = Point(x, y)
            line = edge_geometry(Gp, u, v, k)
            sp = line.interpolate(line.project(pt))
            lng2, lat2 = to_wgs.transform(sp.x, sp.y)
            new = dict(r)                            # copy -> preserves fields + order
            new["lat"], new["lng"] = round(lat2, 6), round(lng2, 6)
            out.append(new)
            snapped_proj.append((sp.x, sp.y))
            d = pt.distance(sp)
            dists.append(d)
            examples.append((d, name, r["id"], (r["lat"], r["lng"]), (new["lat"], new["lng"])))

        # verify snapped points sit ON the network (residual distance to nearest edge ~ 0)
        _, resid = ox.distance.nearest_edges(Gp, [p[0] for p in snapped_proj],
                                             [p[1] for p in snapped_proj], return_dist=True)

        sep = (",", ":") if is_compact(name) else None
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
            if sep:
                json.dump(out, f, ensure_ascii=False, separators=sep)
            else:
                json.dump(out, f, ensure_ascii=False, indent=2)

        moved = sum(1 for d in dists if d > 1.0)
        print(f"\n[{name}]  in/out {n}/{len(out)}  ({'MATCH' if n == len(out) else 'MISMATCH!'})")
        print(f"  points moved (>1 m) : {moved} ({100.0*moved/n:.1f}%)")
        print(f"  snap dist  mean/median/max : {statistics.mean(dists):.1f} / "
              f"{statistics.median(dists):.1f} / {max(dists):.1f} m")
        print(f"  snapped-point residual to road (max): {max(resid):.3f} m")
        if statistics.median(dists) > 40:
            print("  ! median > 40 m -> consider NETWORK='drive_service'/'all' (delete graphml to redownload)")

    print("\nfarthest-off BEFORE snapping (top 5, all files):")
    for d, name, _id, o, s in sorted(examples, reverse=True)[:5]:
        print(f"  {name:<18} id {str(_id):>5}  {d:7.1f} m  ({o[0]:.5f},{o[1]:.5f}) -> ({s[0]:.5f},{s[1]:.5f})")
    print("==============================================")
    print("Wrote in place:", ", ".join(FILES))


if __name__ == "__main__":
    main()
