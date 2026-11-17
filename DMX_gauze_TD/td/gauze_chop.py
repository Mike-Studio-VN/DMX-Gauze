"""Editable CHOP front-panel for gauze tuning. Text DAT /project1/gauze/chop.

EDIT POINTS (Constant CHOPs in /project1/gauze, one sample each):
  tune        speed_default 1-255 | fine_default 0-255 | lock 0-255 (safe-lock, keep 77) | out_len even 2-512 (DMX slots sent)
  limits_min  one channel per module id (G1M, M13, M01..M12), % of travel 0-100
  limits_max  same, must be >= limits_min
LAYOUT CHOPs (only drive output when layout.enabled = 1; 0 = legacy G1M/M13 + limits_* above):
  layout       enabled 0/1 | num_layers 1-4 | L<n>_n = modules in layer n (total <= 16)
  layer_props  L<n>_sync (1 = whole layer shares ONE 4-ch block, unit "L<n>") | L<n>_visible
  layer_xform  L<n>_px,py,pz | rx,ry,rz (deg) | sx,sy,sz   (stored for the UI/3D, no DMX effect)
  mod_geom     M<nn>_length (m) | _width (m, 3D only)      nn = module number across layers, M01..M16
  mod_height   M<nn>_min | _max  (% of travel 0-100)
  mod_motor    M<nn>_addr (DMX start, 0 = auto, 4 ch each) | _max_speed (cm/s at CH3=255)
  mod_misc     M<nn>_speed (default CH3 1-255) | _visible
Signal path: universe (Script) -> dmx_limit (Limit, clamp 0-255) -> dmx_out (Null) -> dmxout1. Channel c1.. = DMX slot 1..

SOURCE OF TRUTH: config/gauze.json. On start JSON -> CHOP. While running, the last edit wins and is
mirrored to the other side (CHOP edit -> JSON saved; UI edit -> CHOP updated). Invalid CHOP edits are
rejected and the CHOP is reset to the current config (printed in the textport). Patch addresses stay in the UI.
Changing the .toe node values alone is NOT persistent: the next start re-seeds them from JSON.
"""
GROUP = "/project1/gauze"
core = op(GROUP + "/gauze_core").module  # noqa: F821
IDS = ["G1M", "M13"] + [f"M{i:02d}" for i in range(1, 13)]
TUNE = ("speed_default", "fine_default", "lock", "out_len")


def _need(n, *names):
    missing = [x for x in names if not hasattr(n.par, x)]
    if missing:
        raise RuntimeError(f"{n.path} ({n.OPType}) has no parameter {missing}: unsupported TD build")


def _const(g, name, channels, x, y, note):
    n = g.op(name) or g.create(constantCHOP, name)  # noqa: F821
    n.nodeX, n.nodeY, n.comment = x, y, note
    n.seq.const.numBlocks = len(channels)  # Constant CHOP: par sequence `const`, max 40 blocks
    _need(n, *[f"const{i}{s}" for i in range(len(channels)) for s in ("name", "value")])
    for i, ch in enumerate(channels):
        n.par[f"const{i}name"] = ch
    return n


def ensure():
    """Idempotent. Never changes dmxout1 until every new node is verified; on any error removes
    the nodes it created and restores dmxout1's original input, then re-raises."""
    g = op(GROUP)  # noqa: F821
    dmx = g.op("dmxout1")
    old_in = dmx.inputs[0] if dmx.inputs else None
    lay_names = core.layout_chop_names()
    created = [n for n in ("tune", "limits_min", "limits_max", "dmx_limit", "dmx_out", *lay_names) if g.op(n) is None]
    try:
        _const(g, "tune", TUNE, 0, -200, "EDIT: speed_default 1-255, fine_default 0-255, lock 0-255 (77), out_len even 2-512. JSON mirrors this.")
        _const(g, "limits_min", IDS, 0, -350, "EDIT: min height % (0-100) per module id. <= limits_max.")
        _const(g, "limits_max", IDS, 0, -500, "EDIT: max height % (0-100) per module id. >= limits_min.")
        for k, (node, chans) in enumerate(lay_names.items()):
            _const(g, node, chans, 300, -200 - 150 * k, f"EDIT (layout): see gauze_chop.py header. Channels: {chans[0]}...")
        lim = g.op("dmx_limit") or g.create(limitCHOP, "dmx_limit")  # noqa: F821
        _need(lim, "type", "min", "max")
        lim.nodeX, lim.nodeY, lim.comment = 750, 120, "Safety: clamp every DMX slot to 0-255."
        lim.par.type, lim.par.min, lim.par.max = "clamp", 0, 255
        out = g.op("dmx_out") or g.create(nullCHOP, "dmx_out")  # noqa: F821
        out.nodeX, out.nodeY, out.comment = 875, 120, "Final DMX frame, c1 = slot 1. Feeds dmxout1."
        read()  # raises if a channel failed to appear
        lim.inputConnectors[0].connect(g.op("universe"))
        out.inputConnectors[0].connect(lim)
        dmx.inputConnectors[0].connect(out)  # last step: the only change to the live output path
    except Exception:
        if old_in is not None:
            dmx.inputConnectors[0].connect(old_in)
        for n in created:
            if g.op(n) is not None:
                g.op(n).destroy()
        raise


def write(cfg):
    g = op(GROUP)  # noqa: F821
    for i, k in enumerate(TUNE):
        g.op("tune").par[f"const{i}value"] = cfg[k]
    for i, mid in enumerate(IDS):
        lim = cfg["limits"].get(mid, {"min": 0, "max": 100})
        g.op("limits_min").par[f"const{i}value"] = lim["min"]
        g.op("limits_max").par[f"const{i}value"] = lim["max"]
    for node, vals in core.layout_to_chop(cfg["layout"]).items():
        for i, v in enumerate(vals.values()):
            g.op(node).par[f"const{i}value"] = v


def read():
    g = op(GROUP)  # noqa: F821
    return {
        "tune": {k: g.op("tune")[k].eval() for k in TUNE},
        "limits": {m: {"min": g.op("limits_min")[m].eval(), "max": g.op("limits_max")[m].eval()} for m in IDS},
        "layout": core.layout_from_chop({node: {c: g.op(node)[c].eval() for c in chans}
                                         for node, chans in core.layout_chop_names().items()}),
    }
