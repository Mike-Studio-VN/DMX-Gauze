# pytest-only: runs gauze_ctl against a fake TD `op`/`project` to check CHOP <-> config precedence.
import builtins
import importlib
import os
import types

import artpoll
import gauze_core
import gauze_store

IDS = ["G1M", "M13"] + [f"M{i:02d}" for i in range(1, 13)]


class FakeChop:
    def __init__(self):
        self.tune = {}
        self.min = {}
        self.max = {}
        self.layout = {}

    def ensure(self):
        pass

    def write(self, cfg):
        self.tune = {k: float(cfg[k]) for k in ("speed_default", "fine_default", "lock", "out_len")}
        self.min = {m: float(cfg["limits"][m]["min"]) for m in IDS}
        self.max = {m: float(cfg["limits"][m]["max"]) for m in IDS}
        self.layout = gauze_core.layout_to_chop(cfg["layout"])

    def read(self):
        return {"tune": dict(self.tune), "limits": {m: {"min": self.min[m], "max": self.max[m]} for m in IDS},
                "layout": gauze_core.layout_from_chop(self.layout)}


def load_ctl(tmp_path):
    fake = FakeChop()
    mods = {"/project1/gauze/artpoll": artpoll, "/project1/gauze/gauze_core": gauze_core,
            "/project1/gauze/gauze_store": gauze_store, "/project1/gauze/chop": fake}
    builtins.op = lambda p: types.SimpleNamespace(module=mods[p]) if p in mods else None
    builtins.project = types.SimpleNamespace(folder=str(tmp_path))
    ctl = importlib.import_module("gauze_ctl")
    ctl = importlib.reload(ctl)
    ctl.on_start()
    return ctl, fake


def test_start_seeds_chop_from_json(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    assert ch.tune["out_len"] == 512 and ch.tune["lock"] == 77
    assert len(ctl.universe()) == 512


def test_chop_edit_applies_and_persists(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    ch.tune["out_len"], ch.tune["lock"], ch.max["G1M"] = 8.0, 80.0, 50.0
    ctl._sync_chop()
    assert len(ctl.universe()) == 8 and ctl.universe()[3] == 80
    assert ctl.mods["G1M"]["max"] == 50
    assert gauze_store.load(ctl.CFG_PATH)["out_len"] == 8  # persisted


def test_invalid_chop_edit_reverts_and_keeps_config(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    ch.tune["out_len"] = 7.0  # odd -> invalid
    ctl._sync_chop()
    assert ch.tune["out_len"] == 512 and ctl.cfg["out_len"] == 512


def test_ui_limits_update_chop(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    ctl._handle({"cmd": "set_limits", "ids": ["M13"], "min": 10, "max": 90})
    assert (ch.min["M13"], ch.max["M13"]) == (10.0, 90.0)
    ctl._sync_chop()  # must not treat the UI write as a CHOP edit
    assert ctl.cfg["limits"]["M13"] == {"min": 10, "max": 90}


def test_layout_edit_while_disabled_persists_but_output_unchanged(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    before = ctl.universe()
    ch.layout["layout"]["num_layers"] = 3.0
    ch.layout["layout"]["L3_n"] = 2.0
    ctl._sync_chop()
    assert gauze_store.load(ctl.CFG_PATH)["layout"]["num_layers"] == 3
    assert ctl.universe() == before and list(ctl.mods) == ["G1M", "M13"]


def test_enable_layout_switches_units_and_keeps_state(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["M13"], "target": 40, "speed": 50})
    ch.layout["layout"]["enabled"] = 1.0
    ch.layout["layer_props"]["L1_sync"] = 0.0  # L1: 12 separate modules now
    ch.layout["mod_motor"]["M13_addr"] = 0.0   # auto
    ctl._sync_chop()
    assert len(ctl.mods) == 13 and "M13" in ctl.mods and ctl.mods["M13"]["target"] == 40
    assert ctl.mods["M13"]["speed"] == 50 and ctl.mods["M01"]["target"] == 0
    assert len(ctl.universe()) == 512 and ctl.universe()[0:4] == [0, 0, 100, 77]  # M01 at address 1


def test_invalid_layout_edit_is_reverted(tmp_path):
    ctl, ch = load_ctl(tmp_path)
    ch.layout["layout"]["enabled"] = 1.0
    ch.layout["mod_motor"]["M13_addr"] = 3.0  # overlaps L1 block 1..4
    ctl._sync_chop()
    assert ch.layout["layout"]["enabled"] == 0.0 and not ctl.cfg["layout"]["enabled"]
    assert list(ctl.mods) == ["G1M", "M13"]


def test_patch_locked_while_layout_enabled(tmp_path):
    import pytest
    ctl, ch = load_ctl(tmp_path)
    ch.layout["layout"]["enabled"] = 1.0
    ctl._sync_chop()
    with pytest.raises(ValueError, match="layout"):
        ctl._handle({"cmd": "save_settings", "settings": {"patch": {"mode": "separate", "addresses": {"M01": 1}}}})
