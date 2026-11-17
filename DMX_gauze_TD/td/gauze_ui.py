"""Native TouchDesigner UI (Perform window 1280x720). Builds /project1/gauze/ui and handles its panels.

Source of truth is the Text DAT /project1/gauze/gauze_ui. Logic stays in ctl; this file only draws
widgets and turns clicks into ctl._handle(...) messages.
"""
G = "/project1/gauze"
UI = G + "/ui"
W, H = 1280, 720
FLASH_FRAMES = 9  # ~150 ms at 60 fps

C = {
    "bg": (0.07, 0.08, 0.10), "panel": (0.106, 0.122, 0.16), "btn": (0.15, 0.17, 0.23),
    "accent": (0.30, 0.55, 1.0), "ok": (0.18, 0.75, 0.44), "warn": (0.91, 0.66, 0.23),
    "bad": (0.90, 0.28, 0.30), "text": (0.91, 0.92, 0.95), "muted": (0.54, 0.58, 0.65),
    "stop": (0.29, 0.12, 0.14), "input": (0.05, 0.06, 0.08),
    # function colours: green = up, blue = down, red = stop, violet = 3 m rail
    "up": (0.12, 0.40, 0.31), "up2": (0.16, 0.56, 0.42), "down": (0.15, 0.28, 0.55), "down2": (0.22, 0.42, 0.78),
    "stopbtn": (0.62, 0.15, 0.18), "violet": (0.62, 0.46, 0.95), "chip": (0.19, 0.22, 0.30),
}
ICON = {"up": "\u25b2", "down": "\u25bc", "stop": "\u25a0"}  # ▲ ▼ ■  (the font has no gear glyph)
# The Button COMP ignores bgcolor in this TD build, so function is shown by a coloured strip (a container, which
# does honour bgcolor) on the button's left edge plus the label colour.
FG = {"up": (0.62, 0.95, 0.78), "up2": (0.62, 0.95, 0.78), "down": (0.65, 0.80, 1.0), "down2": (0.65, 0.80, 1.0),
      "stopbtn": (1.0, 0.62, 0.62), "accent": (1.0, 1.0, 1.0)}
STRIP_KEYS = ("up", "up2", "down", "down2", "stopbtn", "accent", "violet")
STRIP_W = 6
LABEL = {"G1M": "1 m group (12 modules)", "M13": "3 m module"}
PROP_FIELDS = (("len", "Length m"), ("wid", "Width m"), ("addr", "Address"), ("mspd", "Max cm/s"))
PROP_KEY = {"f_len": "length", "f_wid": "width", "f_addr": "addr", "f_mspd": "max_speed"}  # field -> layout module prop
DEFAULT_SPEED = 100
SLOTS = 16  # rows for modules / positions; layout mode has at most 16 units (core.MAX_MODULES)
LEGACY_PRESETS = [f"{ICON['up']}  1 m Up 0%", f"{ICON['down']}  1 m Down 100%", f"{ICON['up']}  3 m Up 0%",
                  f"{ICON['down']}  3 m Down 100%", f"{ICON['up']}  All Up", f"{ICON['down']}  All Down"]


# ---------- pure helpers (no TD objects; unit-tested offline) ----------

def unit_label(m, layers=None, short=False):
    """Display name of a controllable unit. layers = cfg['layout']['layers'] in layout mode, None in legacy mode."""
    if layers is None:
        t = LABEL.get(m["id"], m["id"])
        return t.split(" (")[0] if short else t
    li = m["layer"]
    if m["id"].startswith("L"):  # synced layer: one unit for the whole layer
        n = layers[li]["modules"]
        return f"L{li + 1}" if short else f"Layer {li + 1} - {n} modules synced"
    return f"L{li + 1} {m['id']}"


def preset_labels(layout_on, n_layers=0):
    """6 preset buttons = 3 Up/Down pairs: legacy 1 m / 3 m / All; layout: layer 1 / layer 2 (if any) / All."""
    if not layout_on:
        return list(LEGACY_PRESETS)
    out = []
    for k in (1, 2):
        out += [f"{ICON['up']}  Layer {k} Up 0%", f"{ICON['down']}  Layer {k} Down 100%"] if k <= n_layers else ["-", "-"]
    return out + [f"{ICON['up']}  All Up", f"{ICON['down']}  All Down"]


def base_color(name):
    """Colour key a button returns to after its click flash. Function, not position, decides the colour."""
    if name.startswith("stop_") or name == "man_stop":
        return "stopbtn"
    if name.startswith("pre_"):
        i = int(name[4:])
        return ("up", "down")[i % 2] if i < 4 else ("up2", "down2")[i % 2]
    if name == "man_up":
        return "up"
    if name == "man_down":
        return "down"
    if name == "save_settings":
        return "accent"
    return "btn"


def preset_specs(layout_on):
    return ("L0", "L0", "L1", "L1", "all", "all") if layout_on else ("1m", "1m", "3m", "3m", "all", "all")


def group_ids(mods, spec):
    """spec: 'all' | '1m'/'3m' (legacy type) | 'L<i>' (layer index i)."""
    if spec == "all":
        return list(mods)
    if spec[0] == "L":
        return [i for i, x in mods.items() if x.get("layer") == int(spec[1:])]
    return [i for i, x in mods.items() if x["type"] == spec]


def addr_rows(ents):
    """Read-only patch lines for layout mode: (label, start address)."""
    return [(e["id"], e["addr"]) for e in ents]

_st = {"sel": set(), "tab": "presets", "view": "main", "selkey": None, "mid": ""}
_cache = {}


def _ctl():
    return op(G + "/ctl").module  # noqa: F821  (TD global)


def _w(name):
    o = _cache.get(name)
    if o is None or not o.valid:
        found = op(UI).findChildren(name=name)  # noqa: F821
        o = _cache[name] = found[0] if found else None
    return o


def _set(par, v):
    if par.eval() != v:
        par.val = v


def _rgb(o, prefix, c):
    for k, v in zip("rgb", c):
        getattr(o.par, prefix + k).val = v


# ---------- widget factories ----------

def _box(parent, name, x, y, w, h, bg=None, show=True):
    o = parent.create(containerCOMP, name)  # noqa: F821
    o.par.x, o.par.y, o.par.w, o.par.h = x, y, w, h
    o.par.bgalpha = 1 if bg else 0
    if bg:
        _rgb(o, "bgcolor", bg)
    o.par.display = show
    return o


def _text(parent, name, x, y, w, h, s, size=14, color="text", bg="panel", just="left"):
    o = parent.create(textCOMP, name)  # noqa: F821
    o.par.x, o.par.y, o.par.w, o.par.h = x, y, w, h
    o.par.text = s
    o.par.fontsize = size
    _rgb(o, "fontcolor", C[color])
    _rgb(o, "bgcolor", C[bg])
    o.par.justifyh = just
    o.par.justifyv = "center"
    return o


def _strip_color(bg):
    return C[bg] if bg in STRIP_KEYS else C["chip"]


def _button(parent, name, label, x, y, w, h, kind="momentary", bg="btn", size=16, group=None):
    st = _box(parent, name + "_s", x, y, STRIP_W, h, _strip_color(bg))  # colour marker, left edge
    o = parent.create(buttonCOMP, name)  # noqa: F821
    o.name = name  # create() appends a digit to button names
    o.par.x, o.par.y, o.par.w, o.par.h = x + STRIP_W + 2, y, w - STRIP_W - 2, h
    o.par.label = label
    o.par.fontsize = size
    o.par.buttontype = kind
    if group:
        o.par.buttongroup = group
    _rgb(o, "color", FG.get(bg, C["text"]))
    return o


def _vis(name, on):
    """Show/hide a button together with its colour strip."""
    for n in (name, name + "_s"):
        w = _w(n)
        if w is not None:
            _set(w.par.display, on)


def _paint(name, strip_key, fg=None):
    s = _w(name + "_s")
    if s is not None:
        _rgb(s, "bgcolor", _strip_color(strip_key))
    if fg is not None and _w(name) is not None:
        _rgb(_w(name), "color", fg)


def _field(parent, name, x, y, w, h, kind="float"):
    o = parent.create(fieldCOMP, name)  # noqa: F821
    o.par.x, o.par.y, o.par.w, o.par.h = x, y, w, h
    o.par.fieldtype = kind
    o.par.bgalpha = 1
    _rgb(o, "bgcolor", C["input"])
    return o


def _setfield(name, v):
    f = _w(name)
    if f is not None and str(f.panel.field.val) != str(v):
        f.panel.field = v


def _getfield(name):
    return str(_w(name).panel.field.val).strip()


# ---------- build ----------

def build():
    if op(UI) is not None:  # noqa: F821
        op(UI).destroy()  # noqa: F821
    _cache.clear()
    g = op(G)  # noqa: F821
    ui = g.create(containerCOMP, "ui")  # noqa: F821
    ui.par.w, ui.par.h = W, H
    _rgb(ui, "bgcolor", C["bg"])
    ui.par.bgalpha = 1

    # header
    _text(ui, "title", 20, H - 56, 400, 44, "Gauze Control", 26, bg="bg")
    st = _box(ui, "status", 640, H - 56, 540, 44, C["panel"])
    _box(st, "dot", 14, 14, 16, 16, C["bad"])
    _text(st, "status_text", 40, 2, 490, 40, "Disconnected", 16)
    _button(ui, "open_settings", "Settings", 1160, H - 56, 100, 44, size=14)
    _text(ui, "msg", 20, 6, 1240, 30, "", 15, color="bad", bg="bg")

    # main page
    pg = _box(ui, "pg_main", 0, 40, W, H - 110, None)
    left = _box(pg, "props", 20, 0, 400, 600, C["panel"])
    _text(left, "h_props", 16, 566, 200, 24, "PROPERTIES", 13, "muted")
    _button(left, "sel_all", "Select all", 16, 530, 100, 30, size=12, bg="chip")
    _button(left, "sel_none", "None", 124, 530, 70, 30, size=12, bg="chip")
    for i in range(4):  # layout mode: select every unit of layer i+1 (hidden in legacy mode)
        _button(left, f"lay_{i}", f"L{i + 1}", 202 + i * 46, 530, 42, 30, size=12, bg="chip")
    for i in range(SLOTS):
        _button(left, f"mod_{i}", "", 16, 496 - i * 24, 368, 22, "toggledown", size=12)
    for j, (nm, lab) in enumerate((("min", "Min height %"), ("max", "Max height %"), ("speed", "Speed 1-255"))):
        _text(left, f"l_{nm}", 16 + j * 122, 52, 116, 20, lab, 12, "muted")
        _field(left, f"f_{nm}", 16 + j * 122, 14, 116, 34)
    for j, (nm, lab) in enumerate(PROP_FIELDS):  # layout mode only: edit the layout CHOP values of the selection
        _text(left, f"l_{nm}", 16 + j * 92, 112, 88, 16, lab, 11, "muted")
        _field(left, f"f_{nm}", 16 + j * 92, 78, 86, 30)
    _text(left, "sel_hint", 150, 566, 234, 20, "Select at least one module.", 12, "muted", just="right")

    right = _box(pg, "ctl_panel", 440, 0, 820, 600, C["panel"])
    _text(right, "h_ctl", 16, 566, 200, 24, "CONTROL", 13, "muted")
    _button(right, "tab_presets", "Presets", 16, 520, 120, 36, "radiodown", "accent", 15, "tabs")
    _button(right, "tab_manual", "Manual", 144, 520, 120, 36, "radiodown", "btn", 15, "tabs")

    for i, (k, lab) in enumerate((("1m", "Stop 1 m"), ("3m", "Stop 3 m"), ("all", "Stop All"))):  # always visible
        _button(right, f"stop_{k}", f"{ICON['stop']}  {lab}", 440 + i * 124, 520, 116, 36, bg="stopbtn", size=14)

    pre = _box(right, "pg_presets", 0, 280, 820, 230, None)
    for i, n in enumerate(LEGACY_PRESETS):
        _button(pre, f"pre_{i}", n, 16 + (i % 2) * 400, 150 - (i // 2) * 76, 388, 66, bg=base_color(f"pre_{i}"), size=18)

    man = _box(right, "pg_manual", 0, 280, 820, 230, None, show=False)
    for i, (k, lab) in enumerate((("up", f"{ICON['up']}  Up"), ("stop", f"{ICON['stop']}  Stop"),
                                  ("down", f"{ICON['down']}  Down"))):
        _button(man, f"man_{k}", lab, 16 + i * 268, 120, 258, 100, bg=base_color(f"man_{k}"), size=22)
    _text(man, "l_mspeed", 16, 84, 150, 20, "Speed 1-255", 12, "muted")
    _field(man, "f_mspeed", 16, 44, 150, 34)
    _text(man, "run_hint", 180, 44, 600, 34, "Select modules, then Up / Down. Speed applies to the move.", 12, "muted")

    for i in range(SLOTS):
        row = _box(right, f"pos_{i}", 16, 256 - i * 16, 788, 14, None)
        _text(row, "p_name", 0, 0, 130, 14, "", 11, "muted")
        _box(row, "p_track", 140, 2, 560, 9, C["bg"])
        _box(row.op("p_track"), "p_bar", 0, 0, 1, 9, C["accent"])
        _text(row, "p_val", 710, 0, 78, 14, "", 11, "muted", just="right")

    # settings page
    sp = _box(ui, "pg_settings", 0, 40, W, H - 110, C["panel"], show=False)
    _text(sp, "h_set", 20, 560, 300, 30, "SETTINGS", 14, "muted")
    for nm, lab, x, y, w, kind in (("s_ip", "Art-Net IP", 20, 480, 260, "string"), ("s_net", "Net", 300, 480, 100, "integer"),
                                   ("s_sub", "Subnet", 420, 480, 100, "integer"), ("s_uni", "Universe", 540, 480, 100, "integer"),
                                   ("s_cal1", "1 m travel s @100", 20, 380, 200, "float"), ("s_cal3", "3 m travel s @100", 240, 380, 200, "float")):
        _text(sp, "l_" + nm, x, y + 38, w, 20, lab, 12, "muted")
        _field(sp, nm, x, y, w, 34, kind)
    _button(sp, "mode_linked", "Linked (1 m share one address)", 20, 300, 320, 40, "radiodown", "accent", 14, "mode")
    _button(sp, "mode_separate", "Separate (one address each)", 350, 300, 320, 40, "radiodown", "btn", 14, "mode")
    for i in range(SLOTS):
        _text(sp, f"al_{i}", 20 + (i % 7) * 175, 240 - (i // 7) * 66, 160, 18, "", 12, "muted")
        _field(sp, f"a_{i}", 20 + (i % 7) * 175, 204 - (i // 7) * 66, 160, 32, "integer")
    _button(sp, "save_settings", "Save", 20, 20, 140, 44, bg="accent", size=16)
    _button(sp, "close_settings", "Back", 172, 20, 140, 44, size=16)

    # window + panel execute
    win = g.op("win") or g.create(windowCOMP, "win")  # noqa: F821
    win.par.winop = UI
    win.par.winw, win.par.winh = W, H
    win.par.title = "Gauze Control"
    cb = ("def onValueChange(panelValue, prev):\n"
          "    op('/project1/gauze/gauze_ui').module.on_panel(panelValue)\n    return\n")
    for nm, kind, val in (("ui_pe", buttonCOMP, "state"), ("ui_pe_field", fieldCOMP, "*")):  # noqa: F821
        pe = g.op(nm) or g.create(panelexecuteDAT, nm)  # noqa: F821
        pe.text = cb
        pe.par.panels = " ".join(c.path for c in ui.findChildren(type=kind))  # no depth arg: depth=N matches nothing
        pe.par.panelvalue = val
        pe.par.offtoon = False
        pe.par.valuechange = True
        pe.par.active = True
    _st["selkey"] = None
    update(force=True)
    _prefill_speed()  # after the panel executes exist, so the field change is handled normally


RESYNC_UPDATES = 6  # ~0.6 s of updates: a freshly opened window resets its fields a moment after it appears


def _window_changed():
    """True once when the Window COMP has just opened/closed (its fields are reset to 0.0 then)."""
    w = op(G + "/win")  # noqa: F821
    now_open = bool(w is not None and getattr(w, "isOpen", False))
    if now_open == _st.get("win_open"):
        return False
    _st["win_open"] = now_open
    if now_open:
        _st["resync"] = RESYNC_UPDATES
    return True


def _fields_unsettled():
    """Field callbacks fired by the window's own 0.0 reset are not user edits and must never reach ctl."""
    return _window_changed() or _st.get("resync", 0) > 0


def _watch_window():
    """Opening the Window COMP resets every field to 0.0. Re-fill them when the window (re)opens."""
    _window_changed()
    if _st.get("resync", 0) > 0:
        _st["resync"] -= 1
        _st["selkey"] = None  # makes update() rewrite the Properties fields
        _prefill_speed()


def _prefill_speed():
    """Manual speed field starts at the configured default speed (100) instead of 0, which would send speed 1."""
    c = _ctl()
    c._ensure()
    _setfield("f_mspeed", c.cfg.get("speed_default", DEFAULT_SPEED))


# ---------- behaviour ----------

def _msg(s):
    m = _w("msg")
    if m is not None:
        m.par.text = s
        run(f"op('{m.path}').par.text = ''", delayFrames=60 * 5)  # noqa: F821


def flash(o, base="btn"):
    # click animation: the strip snaps to white and fades back to the button's own colour after ~150 ms
    st = _w(o.name + "_s")
    if st is None:
        return
    _rgb(st, "bgcolor", (1.0, 1.0, 1.0))
    run("o = op(%r)\nfor k, v in zip('rgb', %r):\n    getattr(o.par, 'bgcolor' + k).val = v" % (st.path, _strip_color(base)),  # noqa: F821
        delayFrames=FLASH_FRAMES)


def _ids():
    return list(_ctl().mods)


def _layout_on():
    return _ctl()._layout_on()


def _layers():
    return _ctl().cfg["layout"]["layers"] if _layout_on() else None


def _group(g):
    return group_ids(_ctl().mods, g)


def _num(name):
    t = _getfield(name)
    if t == "":
        return None
    return float(t)


def _send(msg, resync=False):
    try:
        return _ctl()._handle(msg)
    except (ValueError, KeyError, TypeError) as e:
        _msg(str(e))
        if resync:  # a rejected edit must not leave the fields showing values that were not applied
            _st["selkey"] = None
            update()
        return None


def _move(ids, target, **extra):
    if ids:
        _send({"cmd": "move", "ids": ids, "target": target, **extra})


def on_panel(pv):
    o = pv.owner
    n = o.name
    if pv.name == "field":
        return _on_field(n)
    if pv.name != "state":
        return
    on = bool(pv.val)
    if n.startswith("mod_"):
        ids = _ids()
        i = int(n[4:])
        if i < len(ids):
            (_st["sel"].add if on else _st["sel"].discard)(ids[i])
        return update(force=True)
    if not on:
        return
    flash(o, "accent" if n.startswith(("tab_", "mode_")) else base_color(n))
    if n == "sel_all":
        _st["sel"] = set(_ids())
    elif n == "sel_none":
        _st["sel"] = set()
    elif n.startswith("tab_"):
        _st["tab"] = n[4:]
    elif n.startswith("stop_"):  # freeze every unit of that group at its estimated position; ignores the selection
        ids = _group(n[5:])
        if ids:
            _send({"cmd": "stop", "ids": ids})
    elif n.startswith("lay_"):
        _st["sel"] |= set(_group("L" + n[4:]))
    elif n.startswith("pre_"):
        i = int(n[4:])
        _move(_group(preset_specs(_layout_on())[i]), 0 if i % 2 == 0 else 100)
    elif n in ("man_up", "man_down"):
        t = 0 if n == "man_up" else 100
        try:
            sp = _num("f_mspeed")
        except ValueError:
            return _msg("Speed must be a number.")
        sel = sorted(_st["sel"])
        _move(sel, t, **({} if sp is None else {"speed": sp}))
    elif n == "man_stop":
        _send({"cmd": "stop", "ids": sorted(_st["sel"]) or _ids()})  # nothing selected: stop all
    elif n == "open_settings":
        _fill_settings()
        _st["view"] = "settings"
    elif n == "close_settings":
        _st["view"] = "main"
    elif n == "save_settings":
        _save_settings()
    elif n in ("mode_linked", "mode_separate"):
        _st["mode"] = n[5:]
        _render_addrs()
    update(force=True)


def _on_field(n):
    if _fields_unsettled():
        return
    sel = sorted(_st["sel"])
    if n in ("f_min", "f_max"):
        try:
            lo, hi = _num("f_min"), _num("f_max")
        except ValueError:
            return _msg("Min and Max must be numbers.")
        if lo is not None and hi is not None and sel:
            _send({"cmd": "set_limits", "ids": sel, "min": lo, "max": hi}, resync=True)
    elif n in PROP_KEY and sel and _layout_on():
        try:
            v = _num(n)
        except ValueError:
            return _msg("Value must be a number.")
        if v is not None:
            _send({"cmd": "set_props", "ids": sel, "props": {PROP_KEY[n]: v}}, resync=True)
    elif n == "f_speed" and sel:
        try:
            sp = _num("f_speed")
        except ValueError:
            return _msg("Speed must be a number.")
        if sp is not None:
            _send({"cmd": "set_speed", "ids": sel, "speed": sp}, resync=True)


def _fill_settings():
    s = _ctl().settings_msg()["settings"]
    _setfield("s_ip", s["ip"]); _setfield("s_net", s["net"]); _setfield("s_sub", s["subnet"]); _setfield("s_uni", s["universe"])
    _setfield("s_cal1", s["calibration"]["1m"][0][1]); _setfield("s_cal3", s["calibration"]["3m"][0][1])
    _st["mode"] = s["patch"]["mode"]
    _st["addrs"] = dict(s["patch"]["addresses"])
    _st["layout_on"] = _layout_on()
    _render_addrs()


def _render_addrs():
    if _layout_on():  # patch is owned by the layout CHOPs: show resolved addresses, read-only
        rows = addr_rows(core_ents())
        for i in range(SLOTS):
            on = i < len(rows)
            _show(f"al_{i}", on)
            _show(f"a_{i}", False)
            if on:
                _w(f"al_{i}").par.text = f"{unit_label(_ctl().mods[rows[i][0]], _layers()) if rows[i][0] in _ctl().mods else rows[i][0]}: addr {rows[i][1]}"
        _st["keys"] = []
        return
    keys = ["G1M", "M13"] if _st.get("mode") == "linked" else [f"M{i:02d}" for i in range(1, 14)]
    for i in range(SLOTS):
        on = i < len(keys)
        for nm in (f"al_{i}", f"a_{i}"):
            _show(nm, on)
        if on:
            _w(f"al_{i}").par.text = "1 m group" if keys[i] == "G1M" else keys[i]
            _setfield(f"a_{i}", _st["addrs"].get(keys[i], 1 + 4 * i))
    _st["keys"] = keys


def _show(name, on):
    for n in (name, name + "_s"):  # a UI built before this version lacks the extra widgets: skip them
        w = _w(n)
        if w is not None:
            w.par.display = on


def core_ents():
    c = _ctl()
    return c.core.layout_entities(c.cfg["layout"])


def _save_settings():
    try:
        s = {"ip": _getfield("s_ip"), "net": int(_getfield("s_net")), "subnet": int(_getfield("s_sub")),
             "universe": int(_getfield("s_uni")),
             "calibration": {"1m": [[100, float(_getfield("s_cal1"))]], "3m": [[100, float(_getfield("s_cal3"))]]}}
        if not _layout_on():  # layout mode: patch comes from the layout CHOPs and cannot be edited here
            s["patch"] = {"mode": _st["mode"], "addresses": {k: int(_getfield(f"a_{i}")) for i, k in enumerate(_st["keys"])}}
    except ValueError:
        return _msg("Settings contain a value that is not a number.")
    if _send({"cmd": "save_settings", "settings": s}) is not None:
        _msg("")
        _w("msg").par.text = "Saved"
        run(f"op('{_w('msg').path}').par.text = ''", delayFrames=120)  # noqa: F821
        _st["view"] = "main"


def update(force=False):
    if op(UI) is None:  # noqa: F821
        return build()
    c = _ctl()
    c._ensure()
    _watch_window()
    mods = c.mods
    ids = list(mods)
    _st["sel"] &= set(ids)
    sel = sorted(_st["sel"])
    # pages
    _set(_w("pg_main").par.display, _st["view"] == "main")
    _set(_w("pg_settings").par.display, _st["view"] == "settings")
    _set(_w("pg_presets").par.display, _st["tab"] == "presets")
    _set(_w("pg_manual").par.display, _st["tab"] == "manual")
    for nm in ("tab_presets", "tab_manual"):
        on = nm == "tab_" + _st["tab"]
        _paint(nm, "accent" if on else "btn", FG["accent"] if on else C["muted"])
        _set(_w(nm).par.value0, 1 if on else 0)
    lay_on = c._layout_on()
    layers = c.cfg["layout"]["layers"] if lay_on else None
    for nm in ("mode_linked", "mode_separate"):
        on = nm == "mode_" + _st.get("mode", "linked")
        _show(nm, not lay_on)
        _paint(nm, "accent" if on else "btn", FG["accent"] if on else C["muted"])
        _set(_w(nm).par.value0, 1 if on else 0)
    n_layers = c.cfg["layout"]["num_layers"] if lay_on else 0
    for i in range(4):
        _show(f"lay_{i}", lay_on and i < n_layers)
    for i, lab in enumerate(preset_labels(lay_on, n_layers)):
        b = _w(f"pre_{i}")
        _set(b.par.label, lab)
        _vis(f"pre_{i}", lab != "-")
    # module list
    for i in range(SLOTS):
        b = _w(f"mod_{i}")
        if b is None:
            continue
        vis = i < len(ids)
        _vis(f"mod_{i}", vis)
        if vis:
            _set(b.par.label, unit_label(mods[ids[i]], layers))
            on = ids[i] in _st["sel"]
            _set(b.par.value0, 1 if on else 0)
            _paint(f"mod_{i}", "accent" if on else ("violet" if mods[ids[i]]["type"] == "3m" else "btn"),
                   FG["accent"] if on else C["text"])
    _set(_w("sel_hint").par.display, not sel)
    for nm, _lab in PROP_FIELDS:  # layout properties are only editable in layout mode
        _show(f"l_{nm}", lay_on)
        _show(f"f_{nm}", lay_on)
    key = ",".join(sel)
    if key != _st["selkey"]:  # do not overwrite fields while someone is typing
        _st["selkey"] = key
        pick = lambda f: mods[sel[0]][f] if sel and all(mods[i][f] == mods[sel[0]][f] for i in sel) else ""
        _setfield("f_min", pick("min")); _setfield("f_max", pick("max")); _setfield("f_speed", pick("speed"))
        if lay_on:
            ents = c._ents()
            lm = c.cfg["layout"]["modules"]
            for fld, key in PROP_KEY.items():
                vals = {lm[ents[i]["mi"]][key] for i in sel}
                _setfield(fld, vals.pop() if len(vals) == 1 else "")
    # connection
    st = c.state_msg()
    conn = st["conn"]
    colour = {"connected": "ok", "searching": "warn", "disconnected": "bad"}[conn["state"]]
    _rgb(_w("dot"), "bgcolor", C[colour])
    age = "" if conn["age_s"] is None else f"last reply {conn['age_s']}s ago"
    word = {"connected": "Connected", "searching": "Searching...", "disconnected": "Disconnected"}[conn["state"]]
    _set(_w("status_text").par.text, "  ".join(x for x in (word, conn["ip"], conn["node"] or "", age, conn.get("discovery") or "") if x))
    # positions
    for i in range(SLOTS):
        row = _w(f"pos_{i}")
        if row is None:
            continue
        vis = i < len(st["modules"])
        _set(row.par.display, vis)
        if vis:
            m = st["modules"][i]
            _set(row.op("p_name").par.text, unit_label(mods[m["id"]], layers, short=True))
            _rgb(row.op("p_track").op("p_bar"), "bgcolor", C["violet"] if mods[m["id"]]["type"] == "3m" else C["accent"])
            _set(row.op("p_track").op("p_bar").par.w, max(1, 560 * m["pos"] / 100.0))
            _set(row.op("p_val").par.text, f"{round(m['pos'])}% est.")
