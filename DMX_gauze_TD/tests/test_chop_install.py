# pytest-only: ensure() rollback with fake TD nodes (no TouchDesigner needed).
import builtins
import types

import pytest

import gauze_core

_g = types.SimpleNamespace(module=gauze_core)
builtins.op = lambda p: _g
import gauze_chop  # noqa: E402


class Par(types.SimpleNamespace):
    def __setitem__(self, k, v):
        setattr(self, k, v)


class Node:
    def __init__(self, kind, g, has):
        self.kind, self.g, self.inputs, self.path, self.OPType = kind, g, [], "/n", kind
        self.par = Par(**{k: 0 for k in has})
        self.seq = types.SimpleNamespace(const=types.SimpleNamespace(numBlocks=0))
        self.inputConnectors = [types.SimpleNamespace(connect=lambda n: self.inputs.__setitem__(slice(None), [n]))]

    def destroy(self):
        self.g.nodes = {k: v for k, v in self.g.nodes.items() if v is not self}


class Grp:
    def __init__(self, limit_pars):
        self.nodes = {"universe": Node("u", self, []), "dmxout1": Node("dmx", self, [])}
        self.nodes["dmxout1"].inputs = [self.nodes["universe"]]
        self.limit_pars = limit_pars

    def op(self, n):
        return self.nodes.get(n)

    def create(self, kind, name):
        has = {"const": [f"const{i}{s}" for i in range(40) for s in ("name", "value")],
               "limit": self.limit_pars, "null": []}[kind]
        self.nodes[name] = Node(kind, self, has)
        return self.nodes[name]


def setup(limit_pars):
    g = Grp(limit_pars)
    builtins.op = lambda p: g
    builtins.constantCHOP, builtins.limitCHOP, builtins.nullCHOP = "const", "limit", "null"
    gauze_chop.core = gauze_core
    gauze_chop.read = lambda: None  # read-back needs real CHOP channels; covered live
    return g


def test_unsupported_param_rolls_back():
    g = setup(["type", "min"])  # no `max`
    with pytest.raises(RuntimeError, match="no parameter"):
        gauze_chop.ensure()
    assert set(g.nodes) == {"universe", "dmxout1"}
    assert g.nodes["dmxout1"].inputs == [g.nodes["universe"]]


def test_ensure_wires_output_last_and_is_idempotent():
    g = setup(["type", "min", "max"])
    gauze_chop.ensure()
    gauze_chop.ensure()
    assert g.nodes["dmxout1"].inputs == [g.nodes["dmx_out"]]
    assert g.nodes["dmx_out"].inputs == [g.nodes["dmx_limit"]]
    assert g.nodes["dmx_limit"].inputs == [g.nodes["universe"]]
