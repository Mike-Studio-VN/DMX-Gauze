# pytest-only: runs tools/td_install_chop.py against fake DATs holding the OLD ctl text, and checks
# the live state (targets, speeds, limits, DMX frame) survives the DAT swap, and that a failure rolls back.
import builtins
import os
import shutil
import types

import pytest

ROOT = os.path.dirname(os.path.dirname(__file__))
FAKE_CHOP = '''
IDS = ["G1M", "M13"] + [f"M{i:02d}" for i in range(1, 13)]
T = {}
def ensure():
    if FAIL[0]: raise RuntimeError("boom")
def write(cfg):
    T.update({k: float(cfg[k]) for k in ("speed_default", "fine_default", "lock", "out_len")})
def read():
    return {"tune": dict(T), "limits": {}}
FAIL = [False]
'''


class Dat:
    def __init__(self, g, text):
        self.g, self.text, self._mod = g, text, None
        self._src = None

    def destroy(self):
        self.g.d = {k: v for k, v in self.g.d.items() if v is not self}

    @property
    def module(self):
        if self._src != self.text:  # TD re-imports the module when the DAT text changes
            self._src, self._mod = self.text, types.ModuleType("m")
            exec(self.text, self._mod.__dict__)
        return self._mod


class G:
    def __init__(self, old_ctl, core, store):
        self.d = {"ctl": Dat(self, old_ctl), "gauze_core": Dat(self, core), "gauze_store": Dat(self, store),
                  "universe": object(),
                  "dmxout1": types.SimpleNamespace(par=types.SimpleNamespace(active=types.SimpleNamespace(eval=lambda: 1)))}

    def op(self, n):
        return self.d.get(n)

    def create(self, kind, name):
        self.d[name] = Dat(self, "")
        return self.d[name]


def env(tmp_path, fail=False):
    td = tmp_path / "td"
    shutil.copytree(os.path.join(ROOT, "td"), td)
    (td / "gauze_chop.py").write_text(FAKE_CHOP + f"\nFAIL[0] = {fail}\n")
    old = (td / "gauze_ctl.py").read_text()
    # OLD ctl: no chop import, no out_len, so the swap must carry state across.
    old = old.replace('chop = op(GROUP + "/chop").module  # noqa: F821  (editable tuning CHOPs, see gauze_chop.py)', "chop = None")
    old = old.replace('mods, cfg["out_len"])', "mods)")
    old = old.replace('return bool(cfg["layout"]["enabled"])', "return False")  # the old ctl knows no layout
    g = G(old, (td / "gauze_core.py").read_text(), (td / "gauze_store.py").read_text())
    mods = {"artpoll": (td / "artpoll.py").read_text()}
    g.d["artpoll"] = Dat(g, mods["artpoll"])
    g.d["chop"] = None
    del g.d["chop"]
    builtins.op = lambda p: g if p == "/project1/gauze" else g.d.get(p.rsplit("/", 1)[-1])
    builtins.project = types.SimpleNamespace(folder=str(tmp_path))
    builtins.textDAT = "textDAT"
    return g


def started(g, tmp_path):
    ctl = g.op("ctl").module
    ctl.CFG_PATH = str(tmp_path / "config" / "gauze.json")
    ctl.on_start()
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 60, "speed": 40})
    ctl._handle({"cmd": "set_limits", "ids": ["M13"], "min": 10, "max": 90})
    ctl.cfg.pop("out_len", None)  # simulate an old config object without the new keys
    ctl.cfg.pop("layout", None)
    return ctl


def run_installer():
    exec(open(os.path.join(ROOT, "tools", "td_install_chop.py")).read(), {})


def test_swap_preserves_state(tmp_path):
    g = env(tmp_path)
    ctl = started(g, tmp_path)
    before = (ctl.universe(), {k: dict(v) for k, v in ctl.mods.items()}, ctl.cfg["limits"]["M13"])
    run_installer()
    new = g.op("ctl").module
    assert new is not ctl and new.chop is not None  # really swapped to the new code
    assert new.universe() == before[0] and before[0][0:4] == [153, 0, 40, 77]
    assert new.mods == before[1] and new.cfg["limits"]["M13"] == before[2]
    assert new.cfg["layout"]["enabled"] == 0 and new.cfg["out_len"] == 512 and len(new.universe()) == 512


def test_failure_rolls_back_texts_and_state(tmp_path):
    g = env(tmp_path, fail=True)
    ctl = started(g, tmp_path)
    texts = {n: g.d[n].text for n in ("ctl", "gauze_core", "gauze_store")}
    before = (ctl.universe(), {k: dict(v) for k, v in ctl.mods.items()})
    with pytest.raises(RuntimeError, match="boom"):
        run_installer()
    assert {n: g.d[n].text for n in texts} == texts
    assert "chop" not in g.d  # created DAT removed
    back = g.op("ctl").module
    assert back.universe() == before[0] and back.mods == before[1]


def test_installer_ships_every_module_ctl_imports():
    src = open(os.path.join(ROOT, "tools", "td_install_chop.py")).read()
    ctl = open(os.path.join(ROOT, "td", "gauze_ctl.py")).read()
    for mod in ("artpoll", "gauze_core", "gauze_store", "chop"):
        if f'GROUP + "/{mod}"' in ctl:
            assert f"('{mod}'," in src, f"installer does not install {mod}"
    assert src.index("('artpoll'") < src.index("('ctl'")  # dependencies first
