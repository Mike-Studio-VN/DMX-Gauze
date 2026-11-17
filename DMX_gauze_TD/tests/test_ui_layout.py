# pytest-only: gauze_ui against fake widgets + the real ctl (fake CHOP), legacy vs layout mode.
import builtins
import importlib
import types

import pytest

import test_chop_sync as tcs

SLOTS = 16


class P:  # parameter proxy: .val / .eval()
    def __init__(self, d, k):
        self.d, self.k = d, k

    def eval(self):
        return self.d.get(self.k)

    @property
    def val(self):
        return self.d.get(self.k)

    @val.setter
    def val(self, v):
        self.d[self.k] = v


class Pars:
    def __init__(self):
        object.__setattr__(self, "d", {})

    def __getattr__(self, k):
        return P(self.d, k)

    def __setattr__(self, k, v):
        self.d[k] = v


class Panel:
    def __init__(self):
        object.__setattr__(self, "d", {"field": ""})

    def __getattr__(self, k):
        return P(self.d, k)

    def __setattr__(self, k, v):
        self.d[k] = v


class W:
    valid = True

    def __init__(self, name):
        self.name, self.par, self.panel, self.kids = name, Pars(), Panel(), {}
        self.path = "/ui/" + name

    def op(self, n):
        return self.kids[n]


def make_ui():
    ws = {}
    names = ["pg_main", "pg_settings", "pg_presets", "pg_manual", "tab_presets", "tab_manual", "mode_linked", "mode_separate",
             "sel_hint", "l_len", "l_wid", "l_addr", "l_mspd", "f_len", "f_wid", "f_addr", "f_mspd", "f_min", "f_max", "f_speed", "dot", "status_text", "msg", "s_ip", "s_net", "s_sub", "s_uni", "s_cal1", "s_cal3"]
    names += [f"{p}_{i}" for p in ("mod", "pos", "al", "a") for i in range(SLOTS)]
    names += ["man_up", "man_down", "man_stop", "f_mspeed", "mod_0_s", "mod_1_s", "tab_presets_s", "pre_0_s"]
    names += ["stop_1m", "stop_3m", "stop_all"] + [f"lay_{i}" for i in range(4)] + [f"pre_{i}" for i in range(6)]
    for n in names:
        ws[n] = W(n)
    for i in range(SLOTS):
        r = ws[f"pos_{i}"]
        r.kids = {"p_name": W("p_name"), "p_track": W("p_track"), "p_val": W("p_val")}
        r.kids["p_track"].kids = {"p_bar": W("p_bar")}
    ws["s_ip"].panel.field = "255.255.255.255"
    for k, v in (("s_net", 0), ("s_sub", 0), ("s_uni", 0), ("s_cal1", 20), ("s_cal3", 60)):
        ws[k].panel.field = v
    return ws


def setup(tmp_path):
    ctl, ch = tcs.load_ctl(tmp_path)
    ws = make_ui()
    ui_root = types.SimpleNamespace(findChildren=lambda name: [ws[name]] if name in ws else [])
    old = builtins.op
    builtins.op = lambda p: ui_root if p == "/project1/gauze/ui" else (
        types.SimpleNamespace(module=ctl) if p == "/project1/gauze/ctl" else old(p))
    builtins.run = lambda *a, **k: None
    import gauze_ui
    ui = importlib.reload(gauze_ui)
    ui._cache.clear()
    ui._st.update({"sel": set(), "view": "main", "tab": "presets", "selkey": None})
    return ctl, ch, ws, ui


class PV:
    def __init__(self, owner, name, val):
        self.owner, self.name, self.val = owner, name, val


def enable_layout(ch, ctl):
    ch.layout["layout"]["enabled"] = 1.0
    ch.layout["layer_props"]["L1_sync"] = 0.0
    ch.layout["mod_motor"]["M13_addr"] = 0.0
    ctl._sync_chop()
    assert ctl._layout_on()


def test_pure_helpers():
    import gauze_ui as u
    assert u.unit_label({"id": "G1M"}) == "1 m group (12 modules)"
    layers = [{"modules": 12}, {"modules": 1}]
    assert u.unit_label({"id": "L1", "layer": 0}, layers) == "Layer 1 - 12 modules synced"
    assert u.unit_label({"id": "M13", "layer": 1}, layers, short=True) == "L2 M13"
    assert u.preset_labels(False) == u.LEGACY_PRESETS
    up, dn = u.ICON["up"], u.ICON["down"]
    assert u.preset_labels(True, 1) == [f"{up}  Layer 1 Up 0%", f"{dn}  Layer 1 Down 100%", "-", "-", f"{up}  All Up", f"{dn}  All Down"]
    assert [u.base_color(f"pre_{i}") for i in range(6)] == ["up", "down", "up", "down", "up2", "down2"]
    assert u.base_color("stop_3m") == u.base_color("man_stop") == "stopbtn" and u.base_color("sel_all") == "btn"
    mods = {"a": {"type": "1m", "layer": 0}, "b": {"type": "3m", "layer": 1}}
    assert u.group_ids(mods, "L1") == ["b"] and u.group_ids(mods, "3m") == ["b"] and u.group_ids(mods, "all") == ["a", "b"]


def test_legacy_mode_unchanged(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    ui.update(force=True)
    assert ws["mod_0"].par.d["label"] == "1 m group (12 modules)" and ws["mod_0"].par.d["display"]
    assert not ws["mod_2"].par.d["display"] and not ws["lay_0"].par.d["display"]
    assert ws["pre_0"].par.d["label"].endswith("1 m Up 0%")
    ui.on_panel(PV(ws["pre_3"], "state", 1))  # 3 m Down 100%
    assert ctl.mods["M13"]["target"] == 100 and ctl.mods["G1M"]["target"] == 0


def test_layout_mode_dynamic_rows_and_layer_control(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    enable_layout(ch, ctl)
    ui.update(force=True)
    shown = [i for i in range(SLOTS) if ws[f"mod_{i}"].par.d["display"]]
    assert shown == list(range(13)) and ws["mod_0"].par.d["label"] == "L1 M01" and ws["mod_12"].par.d["label"] == "L2 M13"
    assert ws["lay_0"].par.d["display"] and ws["lay_1"].par.d["display"] and not ws["lay_2"].par.d["display"]
    assert not ws["mode_linked"].par.d["display"]
    assert ws["pre_0"].par.d["label"].endswith("Layer 1 Up 0%") and ws["pre_4"].par.d["label"].endswith("All Up")
    ui.on_panel(PV(ws["lay_1"], "state", 1))  # select layer 2
    assert ui._st["sel"] == {"M13"}
    ui.on_panel(PV(ws["pre_0"], "state", 1))  # Layer 1 Up (target 0): nothing moves away
    ui.on_panel(PV(ws["pre_1"], "state", 1))  # Layer 1 Down 100%
    assert all(ctl.mods[f"M{i:02d}"]["target"] == 100 for i in range(1, 13)) and ctl.mods["M13"]["target"] == 0
    ui.update(force=True)
    assert ws["pos_12"].kids["p_name"].par.d["text"] == "L2 M13" and not ws["pos_13"].par.d["display"]


def test_layout_mode_settings_readonly_patch_and_save(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    enable_layout(ch, ctl)
    ui.update(force=True)
    ui._fill_settings()
    assert ws["al_0"].par.d["text"] == "L1 M01: addr 1" and not ws["a_0"].par.d["display"] and ws["al_12"].par.d["display"]
    assert ws["al_12"].par.d["text"].startswith("L2 M13: addr ")
    ui._save_settings()  # must not send a patch (would be rejected in layout mode)
    assert ui._st["view"] == "main" and ctl.cfg["layout"]["enabled"] == 1


def test_ui_built_by_older_version_still_updates(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    for n in [f"lay_{i}" for i in range(4)] + [f"{p}_{i}" for p in ("mod", "pos", "al", "a") for i in range(13, SLOTS)]:
        del ws[n]  # old build: 13 slots, no layer buttons
    ui.update(force=True)
    enable_layout(ch, ctl)
    ui.update(force=True)  # layout mode on an old widget set: extra widgets skipped, no exception
    ui._fill_settings()


def _moving(tmp_path, layout=False):
    ctl, ch, ws, ui = setup(tmp_path)
    clock = [1000.0]
    ctl._now = lambda: clock[0]
    if layout:
        enable_layout(ch, ctl)
    ctl._rebuild()
    ctl._handle({"cmd": "move", "ids": list(ctl.mods), "target": 100, "speed": 100})
    clock[0] += 10  # 1 m units at 50 %, the 3 m unit at 16.7 %
    return ctl, ws, ui


def press_stop(ui, ws, k):
    ui.on_panel(PV(ws[f"stop_{k}"], "state", 1))


def test_stop_buttons_stop_only_their_group(tmp_path):
    ctl, ws, ui = _moving(tmp_path)
    ui._st["sel"] = {"G1M"}  # the selection must not matter
    press_stop(ui, ws, "3m")
    assert ctl.mods["M13"]["target"] == pytest.approx(100 / 6) and ctl.mods["G1M"]["target"] == 100
    press_stop(ui, ws, "1m")
    assert ctl.mods["G1M"]["target"] == pytest.approx(50)


def test_stop_all_button(tmp_path):
    ctl, ws, ui = _moving(tmp_path)
    press_stop(ui, ws, "all")
    assert ctl.mods["G1M"]["target"] == pytest.approx(50) and ctl.mods["M13"]["target"] == pytest.approx(100 / 6)


def test_stop_buttons_in_layout_mode_group_by_length(tmp_path):
    ctl, ws, ui = _moving(tmp_path, layout=True)
    press_stop(ui, ws, "3m")
    assert ctl.mods["M13"]["target"] == pytest.approx(100 / 6)
    assert all(ctl.mods[f"M{i:02d}"]["target"] == 100 for i in range(1, 13))
    press_stop(ui, ws, "1m")
    assert all(ctl.mods[f"M{i:02d}"]["target"] == pytest.approx(50) for i in range(1, 13))


def test_properties_fields_visible_and_edit_layout_chop(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    ui.update(force=True)
    assert not ws["f_len"].par.d["display"]  # legacy mode: layout properties hidden
    enable_layout(ch, ctl)
    ui.on_panel(PV(ws["mod_12"], "state", 1))  # select M13 (3 m unit)
    ui.update(force=True)
    assert ws["f_len"].par.d["display"] and float(ws["f_len"].panel.d["field"]) == 3.0
    ws["f_len"].panel.field = "2.5"
    ui.on_panel(PV(ws["f_len"], "field", "2.5"))
    assert ctl.cfg["layout"]["modules"][12]["length"] == 2.5
    assert ch.layout["mod_geom"]["M13_length"] == 2.5  # mirrored into the CHOP
    assert abs(ctl.mods["M13"]["t100"] - 2.5 * 100 / (12.75 * 100 / 255)) < 1e-9


def test_set_props_validation_and_state(tmp_path):
    import copy as _c
    ctl, ch, ws, ui = setup(tmp_path)
    with pytest.raises(ValueError, match="layout.enabled"):
        ctl._handle({"cmd": "set_props", "ids": ["M13"], "props": {"length": 2}})
    enable_layout(ch, ctl)
    ctl._handle({"cmd": "move", "ids": ["M13"], "target": 40, "speed": 50})
    before = (_c.deepcopy(ctl.cfg), _c.deepcopy(ctl.mods))
    for bad in ({}, {"visible": 1}, {"length": 0}, {"addr": 3}, {"max_speed": float("nan")}, {"width": "x"}):
        with pytest.raises(ValueError):
            ctl._handle({"cmd": "set_props", "ids": ["M13"], "props": bad})
        assert (ctl.cfg, ctl.mods) == before  # rejected edits change nothing
    ctl._handle({"cmd": "set_props", "ids": ["M13"], "props": {"addr": 9, "width": 1.5}})
    assert ctl.mods["M13"]["target"] == 40 and ctl.mods["M13"]["speed"] == 50  # state kept
    assert ctl.universe()[8:12] == [102, 0, 50, 77]
    assert ch.layout["mod_motor"]["M13_addr"] == 9 and ch.layout["mod_geom"]["M13_width"] == 1.5


def test_strip_colours_follow_selection_and_type(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    ui.update(force=True)
    col = lambda n: tuple(ws[n].par.d[k] for k in ("bgcolorr", "bgcolorg", "bgcolorb"))
    assert col("mod_0_s") == ui.C["chip"] and col("mod_1_s") == ui.C["violet"]  # 1 m neutral, 3 m violet
    assert col("tab_presets_s") == ui.C["accent"]
    ui.on_panel(PV(ws["mod_0"], "state", 1))
    assert col("mod_0_s") == ui.C["accent"] and ws["mod_0"].par.d["colorr"] == 1.0  # selected: accent strip, white text


def test_manual_up_down_use_speed_field(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    ui.on_panel(PV(ws["mod_0"], "state", 1))  # G1M
    ws["f_mspeed"].panel.field = "150"
    ui.on_panel(PV(ws["man_down"], "state", 1))
    assert ctl.mods["G1M"]["target"] == 100 and ctl.mods["G1M"]["speed"] == 150 and ctl.mods["M13"]["target"] == 0
    ui.on_panel(PV(ws["man_up"], "state", 1))
    assert ctl.mods["G1M"]["target"] == 0
    assert ui.DEFAULT_SPEED == 100
    for gone in ("man_0", "man_100", "run"):  # removed controls are inert
        ui.on_panel(PV(W(gone), "state", 1))
    assert ctl.mods["G1M"]["target"] == 0


def test_prefill_speed_uses_configured_default(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    ui._prefill_speed()
    assert float(ws["f_mspeed"].panel.d["field"]) == 100
    ctl.cfg["speed_default"] = 120
    ui._prefill_speed()
    assert float(ws["f_mspeed"].panel.d["field"]) == 120


def test_window_open_refills_reset_fields(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    win = types.SimpleNamespace(isOpen=False)
    base = builtins.op
    builtins.op = lambda p: win if p == "/project1/gauze/win" else base(p)
    ui.update(force=True)
    ui.on_panel(PV(ws["mod_0"], "state", 1))  # G1M selected
    for n in ("f_mspeed", "f_min", "f_max", "f_speed"):
        ws[n].panel.field = "0.0"  # what opening the window does
    ui.update()
    assert ws["f_mspeed"].panel.d["field"] == "0.0"  # closed window: nothing is touched
    win.isOpen = True
    ui.update()
    assert float(ws["f_mspeed"].panel.d["field"]) == 100
    assert float(ws["f_max"].panel.d["field"]) == 100 and float(ws["f_speed"].panel.d["field"]) == 100
    ws["f_mspeed"].panel.field = "0.0"  # reset again shortly after opening
    ui.update()
    assert float(ws["f_mspeed"].panel.d["field"]) == 100
    for _ in range(ui.RESYNC_UPDATES + 1):
        ui.update()
    ws["f_mspeed"].panel.field = "200"  # user edit afterwards is left alone
    ui.update()
    assert ws["f_mspeed"].panel.d["field"] == "200"


def test_window_open_reset_never_writes_to_ctl(tmp_path):
    ctl, ch, ws, ui = setup(tmp_path)
    win = types.SimpleNamespace(isOpen=False)
    base = builtins.op
    builtins.op = lambda p: win if p == "/project1/gauze/win" else base(p)
    ui.update(force=True)
    ui.on_panel(PV(ws["mod_0"], "state", 1))  # G1M selected
    before = (dict(ctl.cfg["limits"]["G1M"]), ctl.mods["G1M"]["speed"])
    win.isOpen = True  # the window opens and resets its fields: the callbacks arrive BEFORE the next update()
    for n in ("f_min", "f_max", "f_speed"):
        ws[n].panel.field = "0.0"
        ui.on_panel(PV(ws[n], "field", "0.0"))
    assert (ctl.cfg["limits"]["G1M"], ctl.mods["G1M"]["speed"]) == before
    for _ in range(ui.RESYNC_UPDATES + 1):  # settle
        ui.update()
    ws["f_max"].panel.field = "80"
    ui.on_panel(PV(ws["f_max"], "field", "80"))  # a real edit afterwards still works
    assert ctl.cfg["limits"]["G1M"]["max"] == 80
