"""Load/save config/gauze.json. Pure Python, never raises on load."""
import copy
import ipaddress
import json
import os

try:
    import gauze_core
except ImportError:  # inside TouchDesigner the sibling module lives in a Text DAT
    gauze_core = op("/project1/gauze/gauze_core").module  # noqa: F821

_IDS = ["G1M", "M13"] + [f"M{i:02d}" for i in range(1, 13)]

DEFAULTS = {
    "ip": "255.255.255.255",
    "net": 0,
    "subnet": 0,
    "universe": 0,
    "patch": {"mode": "linked", "addresses": {"G1M": 1, "M13": 5}},
    "limits": {i: {"min": 0, "max": 100} for i in _IDS},
    # [[speed, travel_s]] placeholders, measure on real hardware
    "calibration": {"1m": [[100, 20]], "3m": [[100, 60]]},
    "speed_default": 100,
    "fine_default": 0,
    "lock": 77,
    "out_len": 512,  # DMX slots sent; even, 2-512. Mirrored in CHOP /project1/gauze/tune
    "layout": gauze_core.default_layout(),  # layers/modules; drives output only when layout.enabled = 1
    "perform_on_start": True,  # open the UI as a Perform window when the project starts
}


def _validate(cfg):
    try:
        ipaddress.IPv4Address(cfg["ip"])
    except (ipaddress.AddressValueError, ValueError, TypeError, KeyError):
        raise ValueError("invalid IP address")
    gauze_core.validate_patch(cfg["patch"]["mode"], cfg["patch"]["addresses"])
    gauze_core.validate_calibration(cfg["calibration"])
    gauze_core.validate_out_len(cfg["out_len"], cfg["patch"])
    gauze_core.validate_layout(cfg["layout"], cfg["out_len"])
    for lim in cfg["limits"].values():
        gauze_core.validate_limits(lim["min"], lim["max"])


def load(path):
    cfg = copy.deepcopy(DEFAULTS)
    try:
        with open(path) as f:
            cfg.update(json.load(f))
        _validate(cfg)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return copy.deepcopy(DEFAULTS)
    return cfg


def save(path, cfg):
    _validate(cfg)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)
