# pytest-only, fake clock + fake TD (no TouchDesigner, no output): calibration validation (P1),
# move-by-seconds over the remaining distance (P2), re-anchoring when calibration/layout changes (P3).
import copy
import json
import math
import os

import pytest

import gauze_core as c
import gauze_store as store
import test_chop_sync as tcs

GOOD = {"1m": [[100, 20]], "3m": [[100, 60]]}


def ctl_clock(tmp_path):
    ctl, ch = tcs.load_ctl(tmp_path)
    clock = [1000.0]
    ctl._now = lambda: clock[0]
    ctl._rebuild()  # restart unit timers on the fake clock
    return ctl, ch, clock


def pos(ctl, mid):
    return ctl._pos(ctl.mods[mid])


# ---- P1: calibration schema ----

@pytest.mark.parametrize("bad", [
    None, [], {}, {"1m": GOOD["1m"]}, {"1m": [], "3m": GOOD["3m"]},
    {"1m": [[0, 20]], "3m": GOOD["3m"]}, {"1m": [[100, 0]], "3m": GOOD["3m"]},
    {"1m": [[100, -5]], "3m": GOOD["3m"]}, {"1m": [[256, 20]], "3m": GOOD["3m"]},
    {"1m": [[100, math.nan]], "3m": GOOD["3m"]}, {"1m": [[100, math.inf]], "3m": GOOD["3m"]},
    {"1m": [[True, 20]], "3m": GOOD["3m"]}, {"1m": [["100", 20]], "3m": GOOD["3m"]},
    {"1m": [[100]], "3m": GOOD["3m"]}, {"1m": [100, 20], "3m": GOOD["3m"]}, {"1m": "x", "3m": GOOD["3m"]},
    {"1m": GOOD["1m"], "3m": [[100, 60], [50, 60]]},  # duplicate travel time -> interpolation divide by zero
])
def test_validate_calibration_rejects(bad):
    with pytest.raises(ValueError):
        c.validate_calibration(bad)


def test_validate_calibration_accepts_defaults_and_curves():
    c.validate_calibration(GOOD)
    c.validate_calibration({"1m": [[50, 40], [100, 20]], "3m": [[100, 60]]})
    c.validate_calibration(store.DEFAULTS["calibration"])


def test_store_validate_and_save_reject_without_writing(tmp_path):
    cfg = copy.deepcopy(store.DEFAULTS)
    cfg["calibration"]["1m"] = [[100, 0]]
    path = str(tmp_path / "g.json")
    with pytest.raises(ValueError):
        store.save(path, cfg)
    assert not os.path.exists(path)


def test_bad_calibration_save_is_atomic(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 100})
    clock[0] += 5
    before = (copy.deepcopy(ctl.cfg), copy.deepcopy(ctl.mods), ctl.universe(), os.path.exists(ctl.CFG_PATH))
    for bad in ({"1m": [[100, 0]], "3m": [[100, 60]]}, {"1m": [[100, math.nan]], "3m": [[100, 60]]}, {"1m": []}):
        with pytest.raises(ValueError):
            ctl._handle({"cmd": "save_settings", "settings": {"calibration": bad}})
        assert (ctl.cfg, ctl.mods, ctl.universe(), os.path.exists(ctl.CFG_PATH)) == before
    assert pos(ctl, "G1M") == 25  # still computes, no ZeroDivisionError
    ctl._handle({"cmd": "stop", "ids": ["G1M"]})
    assert ctl.mods["G1M"]["target"] == 25


# ---- P2: seconds = time for the remaining distance ----

def test_core_speed_for_seconds():
    assert c.speed_for_seconds(10, 50, [[100, 20]]) == 100
    assert c.speed_for_seconds(5, 50, [[100, 20]]) == 200
    assert c.speed_for_seconds(20, 100, [[100, 20]]) == 100
    assert c.speed_for_seconds(7, 0, [[100, 20]]) is None
    for bad in (0, -1, math.nan, "a", True):
        with pytest.raises(ValueError):
            c.speed_for_seconds(bad, 0, [[100, 20]])


def test_move_half_travel_in_ten_seconds(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 50, "seconds": 10})
    assert ctl.mods["G1M"]["speed"] == 100
    clock[0] += 10
    assert pos(ctl, "G1M") == 50
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 0, "seconds": 5})  # from 50 back in 5 s
    assert ctl.mods["G1M"]["speed"] == 200
    clock[0] += 5
    assert pos(ctl, "G1M") == 0


def test_move_seconds_from_mid_motion_clamped_and_zero_distance(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 100})
    clock[0] += 10  # at 50
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 0, "seconds": 5})
    clock[0] += 5
    assert pos(ctl, "G1M") == 0
    ctl._handle({"cmd": "set_limits", "ids": ["G1M"], "min": 0, "max": 40})
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "seconds": 8})  # clamped to 40: 40% in 8 s
    assert ctl.mods["G1M"]["target"] == 40 and ctl.mods["G1M"]["speed"] == 100
    clock[0] += 8
    assert pos(ctl, "G1M") == 40
    sp = ctl.mods["G1M"]["speed"]
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 40, "seconds": 3})  # already there: no divide, speed kept
    assert ctl.mods["G1M"]["speed"] == sp and pos(ctl, "G1M") == 40


def test_move_seconds_uses_each_modules_own_calibration(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M", "M13"], "target": 50, "seconds": 30})
    assert ctl.mods["G1M"]["speed"] == 33 and ctl.mods["M13"]["speed"] == 100  # 1 m: 60 s full, 3 m: 60 s full
    assert abs(core_time(ctl, "M13")) < 1e-9


def core_time(ctl, mid):
    m = ctl.mods[mid]
    return 30 - 50 / (m["speed"] / ctl._t100(m))  # seconds still missing at the planned speed


def test_move_is_all_or_nothing(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    before = copy.deepcopy(ctl.mods)
    for bad in (0, -3, math.nan, "x", True):
        with pytest.raises(ValueError):
            ctl._handle({"cmd": "move", "ids": ["G1M", "M13"], "target": 50, "seconds": bad})
        assert ctl.mods == before
    ctl.cfg["calibration"]["3m"] = []  # a module whose calibration cannot be used must not leave G1M half-moved
    with pytest.raises(Exception):
        ctl._handle({"cmd": "move", "ids": ["G1M", "M13"], "target": 50, "seconds": 10})
    assert ctl.mods == before


def test_layout_mode_seconds_uses_length_and_speed(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    tcs_enable(ctl, ch)
    ctl._rebuild()
    ctl._handle({"cmd": "move", "ids": ["M13"], "target": 50, "seconds": 30})  # 3 m, t100 = 60 s
    assert ctl.mods["M13"]["speed"] == 100
    clock[0] += 30
    assert pos(ctl, "M13") == 50


def tcs_enable(ctl, ch):
    ch.layout["layout"]["enabled"] = 1.0
    ch.layout["layer_props"]["L1_sync"] = 0.0
    ch.layout["mod_motor"]["M13_addr"] = 0.0
    ctl._sync_chop()
    assert ctl._layout_on()


# ---- P3: re-anchor when the rate changes ----

def test_calibration_change_does_not_jump_position(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 100})
    clock[0] += 10
    assert pos(ctl, "G1M") == 50
    ctl._handle({"cmd": "save_settings", "settings": {"calibration": {"1m": [[100, 40]], "3m": [[100, 60]]}}})
    assert pos(ctl, "G1M") == 50  # no jump to 25 or 100
    clock[0] += 10
    assert pos(ctl, "G1M") == 75  # new rate 100/40 per s
    ctl._handle({"cmd": "stop", "ids": ["G1M"]})
    assert ctl.mods["G1M"]["target"] == 75
    assert json.load(open(ctl.CFG_PATH))["calibration"]["1m"] == [[100, 40]]


def test_stop_right_after_calibration_change_keeps_estimate(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 100})
    clock[0] += 10
    ctl._handle({"cmd": "save_settings", "settings": {"calibration": {"1m": [[100, 40]], "3m": [[100, 60]]}}})
    ctl._handle({"cmd": "stop", "ids": ["G1M"]})
    assert ctl.mods["G1M"]["target"] == 50


def test_layout_edit_via_chop_does_not_jump_position(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    tcs_enable(ctl, ch)
    ctl._handle({"cmd": "move", "ids": ["M13"], "target": 100, "speed": 100})
    clock[0] += 30
    assert pos(ctl, "M13") == 50
    ch.layout["mod_motor"]["M13_max_speed"] = 6.375  # half speed => t100 120 s
    ctl._sync_chop()
    assert pos(ctl, "M13") == 50
    clock[0] += 30
    assert pos(ctl, "M13") == 75


# ---- multi-point tables: estimator and Seconds use ONE model ----

def test_non_monotonic_table_rejected():
    for bad in ([[100, 20], [50, 10]], [[100, 20], [200, 25]]):  # faster must mean shorter
        with pytest.raises(ValueError):
            c.validate_calibration({"1m": bad, "3m": GOOD["3m"]})


def test_travel_time_is_inverse_of_seconds_to_speed():
    pts = [[50, 40], [100, 20], [200, 15]]
    for sp in (25, 50, 75, 100, 150, 200, 255):
        assert abs(c.seconds_to_speed(c.travel_time(sp, pts), pts) - sp) <= 1
    assert c.travel_time(100, [[100, 20]]) == 20 and c.travel_time(200, [[100, 20]]) == 10  # single point unchanged


def run_move(tmp_path, table, target, seconds):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl.cfg["calibration"]["1m"] = table  # in-memory only: tables validated separately
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": target, "seconds": seconds})
    return ctl, clock


@pytest.mark.parametrize("table,target,seconds", [
    ([[100, 20], [200, 15]], 100, 15),        # reviewer repro 1: speed 200 and the table says 15 s
    ([[100, 20], [200, 15]], 100, 17.5),      # between the points
    ([[100, 20], [200, 10]], 50, 20),         # reviewer repro 2: slower than any measured point -> extrapolated
    ([[50, 40], [100, 20], [200, 15]], 80, 30),
    ([[100, 20], [200, 15]], 40, 5),         # speed 240
])
def test_seconds_end_to_end_multi_point(tmp_path, table, target, seconds):
    ctl, clock = run_move(tmp_path, table, target, seconds)
    tol = max(0.05 * seconds, 0.3)  # CH3 is an integer, so the speed is rounded
    clock[0] += seconds - tol
    assert pos(ctl, "G1M") < target
    clock[0] += 2 * tol
    assert pos(ctl, "G1M") == pytest.approx(target, abs=0.01)


def test_repro_one_not_done_at_ten_seconds(tmp_path):
    ctl, clock = run_move(tmp_path, [[100, 20], [200, 15]], 100, 15)
    assert ctl.mods["G1M"]["speed"] == 200
    clock[0] += 10
    assert pos(ctl, "G1M") == pytest.approx(100 * 10 / 15, abs=0.01)  # 66.7 %, not 100 %


def test_unreachable_seconds_saturate_at_255_and_estimate_stays_consistent(tmp_path):
    ctl, clock = run_move(tmp_path, [[100, 20], [200, 15]], 40, 4)  # needs speed 300 > 255
    assert ctl.mods["G1M"]["speed"] == 255
    need = 0.4 * c.travel_time(255, [[100, 20], [200, 15]])  # the estimator's own time at the capped speed
    clock[0] += need - 0.01
    assert pos(ctl, "G1M") < 40
    clock[0] += 0.02
    assert pos(ctl, "G1M") == pytest.approx(40, abs=0.01)


# ---- non-inverse-linear tables, partial distances, re-anchor and Stop under multi-point ----

TABLES = [
    [[100, 20], [200, 15]],
    [[50, 60], [100, 20], [255, 5]],           # strongly non-inverse-linear (speed*time not constant)
    [[30, 90], [120, 24], [180, 14], [250, 9]],
]


def arrival_time(ctl, mid):
    """First time (0.01 s steps) at which the estimated position reaches the target; fake clock is restored."""
    m = ctl.mods[mid]
    t0 = ctl._now()
    for k in range(1, 20000):
        ctl._now = lambda k=k: t0 + k * 0.01
        if abs(ctl._pos(m, t0 + k * 0.01) - m["target"]) < 1e-9:
            ctl._now = lambda: t0
            return k * 0.01
    raise AssertionError("never arrives")


@pytest.mark.parametrize("table", TABLES)
@pytest.mark.parametrize("target", [10, 37, 50, 90, 100])
@pytest.mark.parametrize("seconds", [2, 6, 12, 30, 80])
def test_seconds_arrival_matches_request_when_feasible(tmp_path, table, target, seconds):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl.cfg["calibration"]["1m"] = table
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": target, "seconds": seconds})
    sp = ctl.mods["G1M"]["speed"]
    arrive = arrival_time(ctl, "G1M")
    # the model's own time at the chosen integer speed
    assert arrive == pytest.approx(target / 100 * c.travel_time(sp, table), abs=0.02)
    if 1 < sp < 255:  # not saturated: the request itself is met, within integer-speed rounding
        assert arrive == pytest.approx(seconds, rel=0.5 / sp + 0.01, abs=0.05)  # CH3 is an integer: <= half a step off
    else:  # saturated: physically cannot do better/worse; direction is right
        assert (arrive >= seconds) if sp == 255 else (arrive <= seconds)


@pytest.mark.parametrize("table", TABLES)
def test_set_speed_mid_move_reanchors_and_stop_keeps_position(tmp_path, table):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl.cfg["calibration"]["1m"] = table
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 100})
    clock[0] += 4
    p = pos(ctl, "G1M")
    assert p == pytest.approx(4 * 100 / c.travel_time(100, table))
    ctl._handle({"cmd": "set_speed", "ids": ["G1M"], "speed": 200})
    assert pos(ctl, "G1M") == pytest.approx(p)  # no jump when the rate table row changes
    clock[0] += 2
    assert pos(ctl, "G1M") == pytest.approx(p + 2 * 100 / c.travel_time(200, table))
    q = pos(ctl, "G1M")
    ctl._handle({"cmd": "stop", "ids": ["G1M"]})
    assert ctl.mods["G1M"]["target"] == pytest.approx(q)
    clock[0] += 50
    assert pos(ctl, "G1M") == pytest.approx(q)


def test_calibration_swap_to_multipoint_mid_move_does_not_jump(tmp_path):
    ctl, ch, clock = ctl_clock(tmp_path)
    ctl._handle({"cmd": "move", "ids": ["G1M"], "target": 100, "speed": 100})
    clock[0] += 10
    ctl._handle({"cmd": "save_settings", "settings": {"calibration": {"1m": [[100, 40], [200, 30]], "3m": [[100, 60]]}}})
    assert pos(ctl, "G1M") == 50
    ctl._handle({"cmd": "set_speed", "ids": ["G1M"], "speed": 200})
    clock[0] += 3
    assert pos(ctl, "G1M") == pytest.approx(50 + 3 * 100 / 30)
    ctl._handle({"cmd": "stop", "ids": ["G1M"]})
    assert ctl.mods["G1M"]["target"] == pytest.approx(60)


def test_unsupported_tables_are_rejected_not_silently_wrong():
    for bad in ([[100, 20], [100, 15]],                 # same speed twice
                [[100, 20], [200, 20]],                  # same time twice
                [[100, 20], [200, 25]],                  # faster but slower
                [[100, 20], [150, 12], [120, 10]]):      # non-monotone in the middle
        with pytest.raises(ValueError):
            c.validate_calibration({"1m": bad, "3m": GOOD["3m"]})
    c.validate_calibration({"1m": TABLES[1], "3m": TABLES[2]})  # legitimate multi-point tables stay accepted
