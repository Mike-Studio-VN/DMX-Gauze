"""Pure gauze logic. No TouchDesigner imports, so it runs under pytest."""
import math

BLOCK = 4          # channels per module: position, fine, speed, lock
MAX_ADDR = 504     # manual: DMX address range 1-504


def pct_to_dmx(pct):
    return max(0, min(255, round(pct * 255 / 100)))


def clamp_target(pct, lo, hi):
    return max(lo, min(hi, pct))


def validate_limits(lo, hi):
    if not (0 <= lo <= hi <= 100):
        raise ValueError("limits must satisfy 0 <= min <= max <= 100")


def seconds_to_speed(seconds, points):
    """points: [[speed, travel_s], ...] measured full-travel time per speed (validate_calibration: faster = shorter).
    Linear between measured points; outside them speed x travel stays constant (inverse proportion),
    which is also the single-point model. Inverse of travel_time()."""
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) \
            or not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("seconds must be a finite number > 0")
    pts = sorted(((t, s) for s, t in points))  # by travel time ascending = speed descending
    if seconds <= pts[0][0]:
        speed = pts[0][1] * pts[0][0] / seconds
    elif seconds >= pts[-1][0]:
        speed = pts[-1][1] * pts[-1][0] / seconds
    else:
        speed = pts[0][1]
        for (t0, s0), (t1, s1) in zip(pts, pts[1:]):
            if t0 <= seconds <= t1:
                speed = s0 + (s1 - s0) * (seconds - t0) / (t1 - t0)
                break
    return max(1, min(255, round(speed)))


def travel_time(speed, points):
    """Seconds for a full 0-100 % travel at CH3 `speed`; the exact inverse of seconds_to_speed (before rounding)."""
    if not speed > 0:
        raise ValueError("speed must be > 0")
    pts = sorted((s, t) for s, t in points)  # by speed ascending
    if speed <= pts[0][0]:
        return pts[0][1] * pts[0][0] / speed
    if speed >= pts[-1][0]:
        return pts[-1][1] * pts[-1][0] / speed
    for (s0, t0), (s1, t1) in zip(pts, pts[1:]):
        if s0 <= speed <= s1:
            return t0 + (t1 - t0) * (speed - s0) / (s1 - s0)


def validate_calibration(cal):
    """Both '1m' and '3m' need >= 1 point [speed 1-255, travel_s > 0], all finite, travel times distinct
    (seconds_to_speed divides by their difference). Raises ValueError only."""
    if not isinstance(cal, dict):
        raise ValueError("calibration must be an object")
    for t in ("1m", "3m"):
        pts = cal.get(t)
        if not isinstance(pts, (list, tuple)) or not 1 <= len(pts) <= 32:
            raise ValueError(f"calibration[{t}] needs 1-32 [speed, travel_s] points")
        for p in pts:
            if not isinstance(p, (list, tuple)) or len(p) != 2:
                raise ValueError(f"calibration[{t}] point must be [speed, travel_s]")
            for v, lo, hi, nm in ((p[0], 1, 255, "speed"), (p[1], 1e-3, 1e6, "travel_s")):
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
                    raise ValueError(f"calibration[{t}] {nm} {v!r} must be a finite number {lo}-{hi}")
        if len({p[1] for p in pts}) != len(pts):
            raise ValueError(f"calibration[{t}] travel times must be distinct")
        by_t = sorted(pts, key=lambda p: p[1])
        if any(a[0] <= b[0] for a, b in zip(by_t, by_t[1:])):
            raise ValueError(f"calibration[{t}] must be monotonic: a higher speed needs a shorter travel time")


def speed_for_seconds(seconds, distance, points):
    """CH3 speed that covers `distance` percent of travel in `seconds`; None when there is nothing to move.
    points are measured FULL-travel times, so the equivalent full-travel time is seconds * 100 / distance."""
    seconds_to_speed(seconds, points)  # validates seconds even when distance is 0
    if not distance > 1e-9:
        return None
    return seconds_to_speed(seconds * 100.0 / distance, points)


def estimate_position(start, target, speed, travel_s_at_100, elapsed):
    rate = speed / travel_s_at_100  # percent per second
    step = rate * max(0, elapsed)
    if target >= start:
        return min(target, start + step)
    return max(target, start - step)


def validate_patch(mode, addresses):
    if mode not in ("linked", "separate"):
        raise ValueError(f"unknown patch mode: {mode!r}")
    for key, a in addresses.items():
        if isinstance(a, bool) or not isinstance(a, int) or not 1 <= a <= MAX_ADDR - BLOCK + 1:
            raise ValueError(f"{key}: address {a!r} out of range 1-{MAX_ADDR - BLOCK + 1}")
    ordered = sorted(addresses.values())
    for a, b in zip(ordered, ordered[1:]):
        if b - a < BLOCK:
            raise ValueError(f"addresses {a} and {b} overlap ({BLOCK} channels each)")


OUT_LEN_DEFAULT = 512


def validate_out_len(n, patch):
    """Art-Net DMX length: even, 2-512, and long enough to hold every patched block."""
    if isinstance(n, bool) or not isinstance(n, int) or n % 2 or not 2 <= n <= 512:
        raise ValueError(f"out_len {n!r} must be an even integer 2-512 (Art-Net)")
    need = max(patch["addresses"].values(), default=1) + BLOCK - 1
    if n < need:
        raise ValueError(f"out_len {n} too short: patch needs {need} slots")


def sanitize_tune(raw):
    """CHOP floats -> validated ints. raw keys: speed_default, fine_default, lock, out_len."""
    ranges = {"speed_default": (1, 255), "fine_default": (0, 255), "lock": (0, 255), "out_len": (2, 512)}
    out = {}
    for k, (lo, hi) in ranges.items():
        v = raw[k]
        if not math.isfinite(v) or not lo <= round(v) <= hi:
            raise ValueError(f"{k}: {v!r} out of range {lo}-{hi}")
        out[k] = round(v)
    return out


def build_universe(patch, modules, length=OUT_LEN_DEFAULT):
    u = [0] * length
    for key, addr in patch["addresses"].items():
        m = modules.get(key)
        if m is None:
            continue
        i = addr - 1
        u[i:i + BLOCK] = [pct_to_dmx(m["target"]), m["fine"], m["speed"], m["lock"]]
    return u


# ---------- layer / module layout (edited through the layout CHOPs, see gauze_chop.py) ----------
MAX_LAYERS = 4
MAX_MODULES = 16  # across all layers; module n is M{n:02d}


def default_xform():
    return [0, 0, 0, 0, 0, 0, 1, 1, 1]  # pos xyz, rot xyz (deg), scale xyz


def default_layout():
    """Same shape as the CHOP data. Equivalent to the legacy 'linked' patch: L1 = 12 synced 1 m modules
    on one address, L2 = one 3 m module. enabled=0 keeps the legacy G1M/M13 behaviour."""
    mod = {"length": 1.0, "width": 1.0, "min": 0, "max": 100, "addr": 0, "max_speed": 12.75, "speed": 100, "visible": 1}
    mods = [dict(mod) for _ in range(MAX_MODULES)]
    mods[0]["addr"] = 1
    mods[12].update(length=3.0, addr=5)
    layers = [{"modules": 12, "sync": 1, "visible": 1, "xform": default_xform()},
              {"modules": 1, "sync": 0, "visible": 1, "xform": default_xform()}]
    layers += [{"modules": 0, "sync": 0, "visible": 1, "xform": default_xform()} for _ in range(MAX_LAYERS - 2)]
    return {"enabled": 0, "num_layers": 2, "layers": layers, "modules": mods}


def _num(v, name, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"{name}: {v!r} out of range {lo}-{hi}")
    return v


def sanitize_layout(raw):
    """CHOP floats (or stored values) -> validated layout. Only active layers/modules are range-checked."""
    nl = round(_num(raw["num_layers"], "num_layers", 1, MAX_LAYERS))
    out = {"enabled": 1 if round(_num(raw["enabled"], "enabled", 0, 1)) else 0, "num_layers": nl, "layers": [], "modules": []}
    total = 0
    for i, L in enumerate(raw["layers"]):
        on = i < nl
        n = round(_num(L["modules"], f"L{i + 1} modules", 1 if on else 0, MAX_MODULES)) if on else 0
        total += n
        out["layers"].append({"modules": n, "sync": 1 if round(L["sync"]) else 0, "visible": 1 if round(L["visible"]) else 0,
                              "xform": [float(_num(x, f"L{i + 1} xform", -1e6, 1e6)) for x in L["xform"]]})
    if total > MAX_MODULES:
        raise ValueError(f"total modules {total} > {MAX_MODULES}")
    for i, m in enumerate(raw["modules"]):
        if i >= total:
            out["modules"].append(dict(m))  # inactive slot: keep whatever is there
            continue
        n = f"M{i + 1:02d}"
        lo, hi = _num(m["min"], n + " min", 0, 100), _num(m["max"], n + " max", 0, 100)
        validate_limits(lo, hi)
        out["modules"].append({
            "length": float(_num(m["length"], n + " length", 0.01, 100)), "width": float(_num(m["width"], n + " width", 0.01, 100)),
            "min": lo, "max": hi, "addr": round(_num(m["addr"], n + " addr", 0, MAX_ADDR - BLOCK + 1)),
            "max_speed": float(_num(m["max_speed"], n + " max_speed", 0.01, 1000)),
            "speed": round(_num(m["speed"], n + " speed", 1, 255)), "visible": 1 if round(m["visible"]) else 0})
    return out


def layout_entities(lay):
    """Controllable units, in order. A synced layer is ONE unit 'L<n>' (one 4-channel block, props of its
    first module); other layers give one unit per module 'M<nn>'. addr 0 = auto (next free block from 1)."""
    ents, gi = [], 0
    for li, L in enumerate(lay["layers"][:lay["num_layers"]]):
        picks = [(f"L{li + 1}", gi)] if L["sync"] else [(f"M{gi + j + 1:02d}", gi + j) for j in range(L["modules"])]
        for eid, mi in picks:
            m = lay["modules"][mi]
            ents.append({"id": eid, "layer": li, "mi": mi, "addr": m["addr"], "min": m["min"], "max": m["max"],
                         "speed": m["speed"], "length": m["length"], "max_speed": m["max_speed"],
                         "type": "3m" if m["length"] >= 2 else "1m"})
        gi += L["modules"]
    used = {e["addr"] for e in ents if e["addr"]}
    nxt = 1
    for e in ents:
        if e["addr"] == 0:
            while any(abs(nxt - u) < BLOCK for u in used):
                nxt += 1
            e["addr"] = nxt
            used.add(nxt)
    return ents


def travel_s_at_100(ent):
    """Seconds to travel the full length at speed 100 (CH3 = 255 gives max_speed cm/s)."""
    return ent["length"] * 100 / (ent["max_speed"] * 100 / 255)


def validate_layout(lay, out_len):
    lay = sanitize_layout(lay)
    if lay["enabled"]:
        addrs = {e["id"]: e["addr"] for e in layout_entities(lay)}
        validate_patch("separate", addrs)
        validate_out_len(out_len, {"addresses": addrs})
    return lay


# CHOP <-> layout mapping. One Constant CHOP per group; channel names are the edit labels.
_XF = ("px", "py", "pz", "rx", "ry", "rz", "sx", "sy", "sz")
_MG = {"mod_geom": ("length", "width"), "mod_height": ("min", "max"), "mod_motor": ("addr", "max_speed"),
       "mod_misc": ("speed", "visible")}


def layout_chop_names():
    """{node: [channel names]} for every layout Constant CHOP."""
    n = {"layout": ["enabled", "num_layers"] + [f"L{i + 1}_n" for i in range(MAX_LAYERS)],
         "layer_props": [f"L{i + 1}_{k}" for k in ("sync", "visible") for i in range(MAX_LAYERS)],
         "layer_xform": [f"L{i + 1}_{k}" for i in range(MAX_LAYERS) for k in _XF]}
    for node, props in _MG.items():
        n[node] = [f"M{i + 1:02d}_{p}" for i in range(MAX_MODULES) for p in props]
    return n


def layout_to_chop(lay):
    d = {"layout": {"enabled": lay["enabled"], "num_layers": lay["num_layers"]},
         "layer_props": {}, "layer_xform": {}}
    for i, L in enumerate(lay["layers"]):
        d["layout"][f"L{i + 1}_n"] = L["modules"]
        d["layer_props"][f"L{i + 1}_sync"], d["layer_props"][f"L{i + 1}_visible"] = L["sync"], L["visible"]
        d["layer_xform"].update({f"L{i + 1}_{k}": v for k, v in zip(_XF, L["xform"])})
    for node, props in _MG.items():
        d[node] = {f"M{i + 1:02d}_{p}": m[p] for i, m in enumerate(lay["modules"]) for p in props}
    return {k: {c: d[k][c] for c in names} for k, names in layout_chop_names().items()}


def layout_from_chop(d):
    """Inverse of layout_to_chop (values may be floats); result still needs sanitize_layout."""
    lay = {"enabled": d["layout"]["enabled"], "num_layers": d["layout"]["num_layers"], "layers": [], "modules": []}
    for i in range(MAX_LAYERS):
        lay["layers"].append({"modules": d["layout"][f"L{i + 1}_n"], "sync": d["layer_props"][f"L{i + 1}_sync"],
                              "visible": d["layer_props"][f"L{i + 1}_visible"],
                              "xform": [d["layer_xform"][f"L{i + 1}_{k}"] for k in _XF]})
    for i in range(MAX_MODULES):
        lay["modules"].append({p: d[node][f"M{i + 1:02d}_{p}"] for node, props in _MG.items() for p in props})
    return lay
