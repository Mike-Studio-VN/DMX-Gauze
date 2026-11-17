# TD-only test (needs op()); not collected by pytest. Seeded as /project1/gauze/test_ctl.
import contextlib
import os
import tempfile

ctl = op("/project1/gauze/ctl").module  # noqa: F821


@contextlib.contextmanager
def cold():
    # Simulate cooking before on_start, with settings saved to a temp file, never the real config.
    real = ctl.CFG_PATH
    ctl.CFG_PATH = os.path.join(tempfile.mkdtemp(), "c.json")
    ctl.cfg.clear()
    ctl.mods.clear()
    try:
        yield
    finally:
        ctl.CFG_PATH = real
        ctl.cfg.clear()  # next call reloads the real config
        ctl.mods.clear()


def test_universe_before_start_does_not_raise():
    with cold():
        u = ctl.universe()
        assert len(u) == 512
        assert u[0:4] == [0, 0, 100, 77]  # nothing moves at start


def test_state_msg_before_start():
    with cold():
        assert ctl.state_msg()["type"] == "state"


def test_move_clamps_to_limits_and_empty_ids_is_noop():
    with cold():
        ctl._handle({"cmd": "set_limits", "ids": ["M13"], "min": 10, "max": 90})
        ctl._handle({"cmd": "move", "ids": ["M13"], "target": 100})
        assert ctl.universe()[4] == 230  # 90 % -> 230
        before = ctl.universe()
        ctl._handle({"cmd": "move", "ids": [], "target": 0})
        assert ctl.universe() == before
        ctl._handle({"cmd": "set_limits", "ids": ["M13"], "min": 0, "max": 100})
        ctl._handle({"cmd": "move", "ids": ["M13"], "target": 0})


def test_bad_seconds_moves_nothing():
    with cold():
        for bad in (0, -1, "x"):
            try:
                ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "seconds": bad})
            except ValueError:
                pass
            else:
                raise AssertionError("expected ValueError")
        assert ctl.universe()[0] == 0


def test_speed_never_zero_while_moving():
    with cold():
        ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 0})
        assert ctl.universe()[2] >= 1


def test_stop_freezes_target():
    with cold():
        ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100})
        ctl._handle({"cmd": "stop", "ids": ["G1M"]})
        assert ctl.universe()[0] < 255


def test_saved_settings_reach_dmxout():
    d = op("/project1/gauze/dmxout1")  # noqa: F821
    with cold():
        try:
            ctl._handle({"cmd": "save_settings", "settings": {"ip": "192.168.1.255", "universe": 2, "subnet": 1}})
            assert d.par.netaddress.eval() == "192.168.1.255"
            assert d.par.universe.eval() == 2
            assert d.par.subnet.eval() == 1
        finally:
            ctl._handle({"cmd": "save_settings", "settings": {"ip": "255.255.255.255", "universe": 0, "subnet": 0}})
