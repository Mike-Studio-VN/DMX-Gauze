# TD-only test of the native UI handlers (synchronous: calls on_panel directly). Seeded as /project1/gauze/test_ui.
import contextlib
import os
import tempfile

G = "/project1/gauze"
ctl = op(G + "/ctl").module  # noqa: F821
ui = op(G + "/gauze_ui").module  # noqa: F821


class PV:
    def __init__(self, owner, name, val):
        self.owner, self.name, self.val = owner, name, val


def w(name):
    return ui._w(name)


def press(name):
    ui.on_panel(PV(w(name), "state", 1))


def field(name, text):
    w(name).panel.field = text


def universe():
    return ctl.universe()


@contextlib.contextmanager
def fresh():
    real = ctl.CFG_PATH
    ctl.CFG_PATH = os.path.join(tempfile.mkdtemp(), "c.json")
    ctl.cfg.clear(); ctl.mods.clear()
    old = dict(ui._st)
    ui._st.update({"sel": set(), "tab": "presets", "view": "main", "selkey": None})
    for f in ("f_min", "f_max", "f_speed"):
        field(f, "")
    ui.update(force=True)
    try:
        yield
    finally:
        ctl.CFG_PATH = real
        ctl.cfg.clear(); ctl.mods.clear()
        ui._st.clear(); ui._st.update(old)
        ui.update(force=True)


def test_toggle_selects_module():
    with fresh():
        ui.on_panel(PV(w("mod_0"), "state", 1))
        assert ui._st["sel"] == {"G1M"}
        ui.on_panel(PV(w("mod_0"), "state", 0))
        assert ui._st["sel"] == set()


def test_presets_move_their_group_only():
    with fresh():
        press("pre_1")  # 1 m Down 100%
        assert universe()[0] == 255 and universe()[4] == 0
        press("pre_3")  # 3 m Down 100%
        assert universe()[4] == 255
        press("pre_4")  # All Up
        assert universe()[0] == 0 and universe()[4] == 0
        press("pre_5")  # All Down
        assert universe()[0] == 255 and universe()[4] == 255


def test_manual_needs_selection_but_stop_does_not():
    with fresh():
        press("man_down")  # nothing selected: no move
        assert universe()[0] == 0
        press("pre_5")
        press("man_stop")  # nothing selected: stops everything
        assert universe()[0] < 255 and universe()[4] < 255


def test_manual_down_and_stop_on_selection():
    with fresh():
        ui.on_panel(PV(w("mod_1"), "state", 1))  # M13
        press("man_down")
        assert universe()[4] == 255 and universe()[0] == 0
        press("man_stop")
        assert universe()[4] < 255


def test_limits_clamp_presets():
    with fresh():
        ui.on_panel(PV(w("mod_0"), "state", 1))
        field("f_min", "10"); field("f_max", "90")
        ui.on_panel(PV(w("f_min"), "field", "10"))
        press("pre_1")
        assert universe()[0] == 230  # 90 % of 255


def test_bad_limits_rejected_and_fields_resync():
    with fresh():
        ui.on_panel(PV(w("mod_0"), "state", 1))
        field("f_min", "60")
        ui.on_panel(PV(w("f_min"), "field", "60"))  # valid on its own: (60, 100)
        field("f_max", "40")
        ui.on_panel(PV(w("f_max"), "field", "40"))  # now (60, 40): rejected
        m = ctl.mods["G1M"]
        assert m["min"] <= m["max"]
        assert w("msg").par.text.eval() != ""
        assert float(ui._getfield("f_max")) == m["max"] and float(ui._getfield("f_min")) == m["min"]


def test_settings_validation_and_save():
    with fresh():
        press("open_settings")
        assert ui._st["view"] == "settings"
        field("s_ip", "999.1.1.1")
        press("save_settings")
        assert ctl.cfg["ip"] != "999.1.1.1" and w("msg").par.text.eval()
        field("s_ip", "192.168.1.255")
        press("save_settings")
        assert ctl.cfg["ip"] == "192.168.1.255" and ui._st["view"] == "main"
        press("open_settings")
        field("s_ip", "255.255.255.255")
        press("save_settings")
        assert ctl.cfg["ip"] == "255.255.255.255"
