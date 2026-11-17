# Framework-free: runs under pytest on disk and under /project1/gauze/run_tests inside TouchDesigner.
import contextlib
import copy
import json
import os
import tempfile

try:
    import gauze_store as s
except ImportError:  # inside TouchDesigner
    s = op("/project1/gauze/gauze_store").module  # noqa: F821


@contextlib.contextmanager
def raises(exc):
    try:
        yield
    except exc:
        return
    raise AssertionError(f"expected {exc.__name__}")


@contextlib.contextmanager
def tmp():
    with tempfile.TemporaryDirectory() as d:
        yield os.path.join(d, "c.json")


def test_load_missing_returns_defaults():
    with tmp() as p:
        assert s.load(p) == s.DEFAULTS


def test_load_corrupt_returns_defaults():
    with tmp() as p:
        open(p, "w").write("{not json")
        assert s.load(p) == s.DEFAULTS


def test_load_invalid_patch_returns_defaults():
    cfg = copy.deepcopy(s.DEFAULTS)
    cfg["patch"]["addresses"] = {"G1M": 1, "M13": 2}
    with tmp() as p:
        open(p, "w").write(json.dumps(cfg))
        assert s.load(p) == s.DEFAULTS


def test_save_rejects_bad_ip():
    for ip in ["999.1.1.1", "", "abc"]:
        with tmp() as p:
            s.save(p, s.DEFAULTS)
            before = open(p, "rb").read()
            cfg = copy.deepcopy(s.DEFAULTS)
            cfg["ip"] = ip
            with raises(ValueError):
                s.save(p, cfg)
            assert open(p, "rb").read() == before


def test_save_rejects_overlapping_patch():
    cfg = copy.deepcopy(s.DEFAULTS)
    cfg["patch"] = {"mode": "separate", "addresses": {"M01": 1, "M02": 3}}
    with tmp() as p:
        with raises(ValueError):
            s.save(p, cfg)


def test_save_rejects_bad_limits():
    cfg = copy.deepcopy(s.DEFAULTS)
    cfg["limits"]["M13"] = {"min": 80, "max": 20}
    with tmp() as p:
        with raises(ValueError):
            s.save(p, cfg)


def test_roundtrip():
    cfg = copy.deepcopy(s.DEFAULTS)
    cfg["ip"] = "192.168.1.255"
    with tmp() as p:
        s.save(p, cfg)
        assert s.load(p) == cfg


def test_out_len_default_and_validation():
    assert s.DEFAULTS["out_len"] == 512
    cfg = copy.deepcopy(s.DEFAULTS)
    cfg["out_len"] = 6  # patch needs 8 slots
    with raises(ValueError):
        s._validate(cfg)
