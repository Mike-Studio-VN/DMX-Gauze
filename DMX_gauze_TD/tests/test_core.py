# Framework-free: runs under pytest on disk and under /project1/gauze/run_tests inside TouchDesigner.
import contextlib

try:
    import gauze_core as c
except ImportError:  # inside TouchDesigner
    c = op("/project1/gauze/gauze_core").module  # noqa: F821


@contextlib.contextmanager
def raises(exc):
    try:
        yield
    except exc:
        return
    raise AssertionError(f"expected {exc.__name__}")


def test_pct_to_dmx_endpoints():
    assert c.pct_to_dmx(0) == 0
    assert c.pct_to_dmx(100) == 255
    assert c.pct_to_dmx(50) == 128
    assert c.pct_to_dmx(-5) == 0
    assert c.pct_to_dmx(120) == 255


def test_clamp_target():
    assert c.clamp_target(5, 10, 90) == 10
    assert c.clamp_target(95, 10, 90) == 90
    assert c.clamp_target(50, 10, 90) == 50


def test_validate_limits_rejects_bad():
    for lo, hi in [(60, 40), (-1, 50), (0, 101)]:
        with raises(ValueError):
            c.validate_limits(lo, hi)


def test_validate_limits_accepts_good():
    c.validate_limits(0, 100)
    c.validate_limits(20, 20)


def test_seconds_to_speed_inverse():
    pts = [[100, 20]]
    assert c.seconds_to_speed(20, pts) == 100
    assert c.seconds_to_speed(10, pts) == 200
    assert c.seconds_to_speed(1000, pts) == 2
    assert c.seconds_to_speed(0.01, pts) == 255


def test_seconds_to_speed_interpolates():
    assert c.seconds_to_speed(30, [[50, 40], [100, 20]]) == 75


def test_seconds_to_speed_rejects_bad_input():
    for bad in [0, -3, float("nan"), float("inf"), "x", None]:
        with raises(ValueError):
            c.seconds_to_speed(bad, [[100, 20]])


def test_estimate_position_no_overshoot():
    assert c.estimate_position(0, 100, 100, 20, 10) == 50
    assert c.estimate_position(0, 100, 100, 20, 999) == 100
    assert c.estimate_position(100, 0, 100, 20, 10) == 50
    assert c.estimate_position(100, 0, 100, 20, 999) == 0


def test_validate_patch_overlap_fails():
    with raises(ValueError):
        c.validate_patch("separate", {"M01": 1, "M02": 3})


def test_validate_patch_out_of_range_fails():
    with raises(ValueError):
        c.validate_patch("linked", {"G1M": 502, "M13": 1})
    with raises(ValueError):
        c.validate_patch("linked", {"G1M": 0, "M13": 5})


def test_validate_patch_duplicates_fail():
    with raises(ValueError):
        c.validate_patch("linked", {"G1M": 5, "M13": 5})


def test_validate_patch_unknown_mode_fails():
    with raises(ValueError):
        c.validate_patch("weird", {"G1M": 1, "M13": 5})


def test_validate_patch_valid():
    c.validate_patch("linked", {"G1M": 1, "M13": 5})
    sep = {f"M{i:02d}": 1 + 4 * (i - 1) for i in range(1, 14)}
    c.validate_patch("separate", sep)
    assert sep["M13"] == 49


def test_build_universe_linked():
    patch = {"mode": "linked", "addresses": {"G1M": 1, "M13": 5}}
    mods = {
        "G1M": {"target": 100, "speed": 100, "fine": 0, "lock": 77},
        "M13": {"target": 0, "speed": 80, "fine": 0, "lock": 77},
    }
    u = c.build_universe(patch, mods)
    assert len(u) == 512
    assert u[0:4] == [255, 0, 100, 77]
    assert u[4:8] == [0, 0, 80, 77]
    assert not any(u[8:])


def test_build_universe_separate():
    patch = {"mode": "separate", "addresses": {"M01": 1, "M02": 5}}
    mods = {
        "M01": {"target": 0, "speed": 100, "fine": 0, "lock": 77},
        "M02": {"target": 100, "speed": 50, "fine": 0, "lock": 77},
    }
    u = c.build_universe(patch, mods)
    assert u[0:4] == [0, 0, 100, 77]
    assert u[4:8] == [255, 0, 50, 77]


def test_out_len_rules():
    p = {"addresses": {"G1M": 1, "M13": 5}}
    c.validate_out_len(512, p)
    c.validate_out_len(8, p)
    for bad in (7, 6, 0, 514, 8.0, True):
        with raises(ValueError):
            c.validate_out_len(bad, p)


def test_build_universe_length():
    u = c.build_universe({"addresses": {"G1M": 1, "M13": 5}},
                         {"G1M": {"target": 100, "fine": 1, "speed": 2, "lock": 77}}, 8)
    assert u == [255, 1, 2, 77, 0, 0, 0, 0]
    assert len(c.build_universe({"addresses": {}}, {})) == 512


def test_sanitize_tune():
    ok = {"speed_default": 99.6, "fine_default": 0.0, "lock": 77.0, "out_len": 512.0}
    assert c.sanitize_tune(ok) == {"speed_default": 100, "fine_default": 0, "lock": 77, "out_len": 512}
    for k, v in (("speed_default", 0), ("lock", 256), ("out_len", float("nan"))):
        with raises(ValueError):
            c.sanitize_tune({**ok, k: v})


def test_default_layout_matches_legacy_linked_patch():
    lay = c.default_layout()
    lay["enabled"] = 1
    ents = c.layout_entities(c.validate_layout(lay, 512))
    assert [(e["id"], e["addr"], e["type"]) for e in ents] == [("L1", 1, "1m"), ("M13", 5, "3m")]
    assert round(c.travel_s_at_100(ents[0])) == 20 and round(c.travel_s_at_100(ents[1])) == 60  # legacy calibration


def test_layout_auto_addresses_and_counts():
    lay = c.default_layout()
    lay.update(enabled=1, num_layers=3)
    lay["layers"][0].update(modules=2, sync=0)
    lay["layers"][1].update(modules=1)
    lay["layers"][2].update(modules=2)
    for m in lay["modules"]:
        m["addr"] = 0
    lay["modules"][3]["addr"] = 9  # explicit slot in the middle
    ents = c.layout_entities(c.sanitize_layout(lay))
    assert [e["id"] for e in ents] == ["M01", "M02", "M03", "M04", "M05"]
    assert [e["addr"] for e in ents] == [1, 5, 13, 9, 17]  # auto skips blocks taken by explicit addresses


def test_layout_rejects_bad_input():
    base = c.default_layout()
    for mut in (lambda l: l.update(num_layers=5), lambda l: l["layers"][0].update(modules=0),
                lambda l: l["layers"][0].update(modules=16), lambda l: l["modules"][0].update(min=60, max=10),
                lambda l: l["modules"][0].update(speed=0), lambda l: l["modules"][0].update(addr=502)):
        import copy
        lay = copy.deepcopy(base)
        mut(lay)
        with raises(ValueError):
            c.sanitize_layout(lay)
    lay = copy.deepcopy(base)
    lay.update(enabled=1)
    lay["modules"][12]["addr"] = 3  # overlaps L1 block (1..4)
    with raises(ValueError):
        c.validate_layout(lay, 512)


def test_layout_chop_roundtrip_and_channel_limits():
    lay = c.sanitize_layout(c.default_layout())
    assert c.layout_from_chop(c.layout_to_chop(lay)) == lay
    names = c.layout_chop_names()
    assert max(len(v) for v in names.values()) <= 40  # Constant CHOP channel cap
    assert set(c.layout_to_chop(lay)) == set(names)
    assert all(list(c.layout_to_chop(lay)[k]) == names[k] for k in names)
