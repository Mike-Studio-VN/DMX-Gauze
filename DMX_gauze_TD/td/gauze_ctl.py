"""TouchDesigner glue: module state, WebSocket protocol, per-frame tick, ArtPoll.

Loaded by the Text DAT /project1/gauze/ctl (file-synced). All logic worth testing
lives in gauze_core / artpoll / gauze_store; this file only wires them to TD.
"""
import json
import os
import socket
import subprocess
import sys
import time

GROUP = "/project1/gauze"
# Source of truth is the Text DATs inside the .toe; sibling modules are loaded from them.
artpoll = op(GROUP + "/artpoll").module  # noqa: F821  (TD global)
core = op(GROUP + "/gauze_core").module  # noqa: F821
store = op(GROUP + "/gauze_store").module  # noqa: F821
chop = op(GROUP + "/chop").module  # noqa: F821  (editable tuning CHOPs, see gauze_chop.py)

# Only user data (saved settings) lives outside the .toe.
CFG_PATH = os.path.join(project.folder, "config", "gauze.json")  # noqa: F821
ART_PORT = 6454
DMX_IN = "/project1/gauze_test/dmx_in"  # optional test-branch DMX In CHOP; needs UDP 6454 when set to Art-Net
CONNECTED_S = 6.0
POLL_EVERY_S = 2.0
UI_EVERY_FRAMES = 6  # refresh the panel at ~10 Hz

cfg = {}
mods = {}
_sock = None
_t_start = time.time()
_last_poll = 0.0
_frame = 0
_last_reply = None
_node = None
_was_connected = False
disc = artpoll.Discovery()  # decides whether this module may hold UDP 6454 (see artpoll.Discovery)
_seen = None  # last CHOP snapshot we applied or wrote; a difference means a dev edited a CHOP


def _now():
    return time.time()


def _layout_on():
    return bool(cfg["layout"]["enabled"])


def _ents():
    return {e["id"]: e for e in core.layout_entities(cfg["layout"])}


def _ids():
    if _layout_on():
        return list(_ents())
    if cfg["patch"]["mode"] == "linked":
        return ["G1M", "M13"]
    return [f"M{i:02d}" for i in range(1, 14)]


def _type(mid):
    return "3m" if mid == "M13" else "1m"


def _t100(m):
    """Effective seconds-at-speed-100 for this unit's CURRENT speed, so rate = speed / _t100 follows the whole
    calibration table (same model as core.seconds_to_speed / core.travel_time)."""
    return core.travel_time(m["speed"], _cal_points(m)) * m["speed"] / 100.0


def _rebuild():
    old = {k: dict(v) for k, v in mods.items()}
    now = _now()
    mods.clear()
    if _layout_on():  # keep runtime state of units that survive the change; new units start at target 0
        for e in core.layout_entities(cfg["layout"]):
            m = {"id": e["id"], "type": e["type"], "layer": e["layer"], "start": 0.0, "target": 0.0, "t0": now,
                 "speed": e["speed"], "fine": cfg["fine_default"], "lock": cfg["lock"], "min": e["min"], "max": e["max"],
                 "t100": core.travel_s_at_100(e)}
            o = old.get(e["id"])
            if o:
                m.update(start=core.clamp_target(_pos(o, now), e["min"], e["max"]), speed=o["speed"])
                m["target"] = core.clamp_target(o["target"], e["min"], e["max"])
            mods[e["id"]] = m
        return
    for mid in _ids():
        lim = cfg["limits"].get(mid, {"min": 0, "max": 100})
        mods[mid] = {
            "id": mid, "type": _type(mid), "start": 0.0, "target": 0.0, "t0": _now(),
            "speed": cfg["speed_default"], "fine": cfg["fine_default"], "lock": cfg["lock"],
            "min": lim["min"], "max": lim["max"],
        }


def _cal_points(m):
    """[[speed, full_travel_s]] for this unit: its own length/max-speed in layout mode, else the type calibration."""
    return [[100, m["t100"]]] if "t100" in m else cfg["calibration"][m["type"]]


def _pos(m, now=None):
    now = _now() if now is None else now
    return core.estimate_position(m["start"], m["target"], m["speed"], _t100(m), now - m["t0"])


def _apply_dmx_params():
    d = op(GROUP + "/dmxout1")  # noqa: F821
    for name, key in (("netaddress", "ip"), ("net", "net"), ("subnet", "subnet"), ("universe", "universe")):
        if d is not None and hasattr(d.par, name):
            getattr(d.par, name).val = cfg[key]


def _ensure():
    # The module can cook before on_start (project load, or the DAT text was just edited).
    if not cfg:
        on_start()


def on_start():
    global cfg, _t_start
    cfg = store.load(CFG_PATH)
    _rebuild()  # every module starts at target 0 / speed default; nothing is moved
    _t_start = _now()
    _apply_dmx_params()
    try:
        chop.ensure()
        _push_chop()
    except Exception as e:  # DMX must keep running if the tuning network is broken
        print("gauze: CHOP tuning network unavailable:", e)


def _push_chop():
    global _seen
    chop.write(cfg)
    _seen = chop.read()


def _push_chop_safe():
    if _seen is not None:  # network exists; keep the CHOP in step with a UI edit
        _push_chop()


def _apply_chop(cur):
    """Validate everything, then save + apply. Raises ValueError with nothing changed."""
    global cfg
    t = core.sanitize_tune(cur["tune"])
    new = json.loads(json.dumps(cfg))
    new.update(t)
    new["layout"] = core.sanitize_layout(cur["layout"])
    for mid, lim in cur["limits"].items():
        core.validate_limits(lim["min"], lim["max"])
        new["limits"][mid] = {"min": lim["min"], "max": lim["max"]}
    store.save(CFG_PATH, new)  # also checks out_len against the patch
    layout_changed = new["layout"] != cfg["layout"]
    was_on = _layout_on()
    cfg = new
    now = _now()
    if layout_changed and (was_on or _layout_on()):
        _rebuild()
    for m in mods.values():
        m["fine"], m["lock"] = t["fine_default"], t["lock"]
        if _layout_on():
            continue
        lim = cur["limits"][m["id"]]
        if (m["min"], m["max"]) != (lim["min"], lim["max"]):
            _anchor(m, now)
            m["min"], m["max"] = lim["min"], lim["max"]
            m["target"] = core.clamp_target(m["target"], m["min"], m["max"])


def _sync_chop():
    global _seen
    if _seen is None:
        return
    try:
        cur = chop.read()
        if cur == _seen:
            return
        try:
            _apply_chop(cur)
        except ValueError as e:
            print("gauze: CHOP edit rejected, reset to config:", e)
        _push_chop()  # accepted: normalise; rejected: revert to the config
    except Exception as e:
        print("gauze: CHOP sync failed:", e)
        _seen = None


# ---------- protocol ----------

def conn_state():
    now = _now()
    if _last_reply is not None and now - _last_reply < CONNECTED_S:
        return "connected"
    if _last_reply is None and now - _t_start < CONNECTED_S:
        return "searching"
    return "disconnected"


def state_msg():
    _ensure()
    now = _now()
    return {
        "type": "state",
        "modules": [
            {"id": m["id"], "type": m["type"], "layer": m.get("layer"), "pos": round(_pos(m, now), 1), "target": m["target"],
             "speed": m["speed"], "min": m["min"], "max": m["max"]}
            for m in mods.values()
        ],
        "conn": {"state": conn_state(),
                 "age_s": None if _last_reply is None else round(now - _last_reply, 1),
                 "ip": cfg["ip"], "node": _node, "discovery": discovery_msg()},
    }


def settings_msg():
    _ensure()
    return {"type": "settings", "settings": {k: cfg[k] for k in ("ip", "net", "subnet", "universe", "patch", "calibration")}}


def _targets(msg):
    ids = msg.get("ids")
    if not isinstance(ids, list):
        raise ValueError("ids must be a list")
    return [mods[i] for i in ids if i in mods]  # unknown ids and empty list: no-op


def _num(v, name):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        raise ValueError(f"{name} must be a number")
    return v


def _anchor(m, now):
    m["start"] = _pos(m, now)
    m["t0"] = now


def _handle(msg):
    _ensure()
    cmd = msg.get("cmd")
    now = _now()
    if cmd == "move":
        target = _num(msg.get("target"), "target")
        if not 0 <= target <= 100:
            raise ValueError("target must be 0-100")
        mlist = _targets(msg)
        speed = None
        if "seconds" not in msg and "speed" in msg:
            speed = max(1, min(255, round(_num(msg["speed"], "speed"))))
        plan = []  # validate every module before changing any
        for m in mlist:
            dest = core.clamp_target(target, m["min"], m["max"])
            sp = speed
            if "seconds" in msg:  # time to cover the REMAINING distance from the current estimated position
                sp = core.speed_for_seconds(msg["seconds"], abs(dest - _pos(m, now)), _cal_points(m))
            plan.append((m, dest, sp))
        for m, dest, sp in plan:
            _anchor(m, now)
            if sp is not None:
                m["speed"] = sp
            m["target"] = dest
    elif cmd == "stop":
        for m in _targets(msg):
            _anchor(m, now)
            m["target"] = m["start"]  # freeze CH1 at the estimated position
    elif cmd == "set_limits":
        lo, hi = _num(msg.get("min"), "min"), _num(msg.get("max"), "max")
        core.validate_limits(lo, hi)
        for m in _targets(msg):
            m["min"], m["max"] = lo, hi
            if _layout_on():
                cfg["layout"]["modules"][_ents()[m["id"]]["mi"]].update(min=lo, max=hi)
            else:
                cfg["limits"][m["id"]] = {"min": lo, "max": hi}
            _anchor(m, now)
            m["target"] = core.clamp_target(m["target"], lo, hi)
        store.save(CFG_PATH, cfg)
        _push_chop_safe()
    elif cmd == "set_speed":
        sp = max(1, min(255, round(_num(msg.get("speed"), "speed"))))
        for m in _targets(msg):
            _anchor(m, now)
            m["speed"] = sp
    elif cmd == "set_props":  # layout mode: edit module properties; mirrored into the layout CHOPs
        _set_props(msg)
    elif cmd == "get_settings":
        return settings_msg()
    elif cmd == "save_settings":
        _save_settings(msg.get("settings"))
        return settings_msg()
    else:
        raise ValueError(f"unknown cmd: {cmd!r}")
    return None


PROP_KEYS = {"length", "width", "addr", "max_speed"}


def _set_props(msg):
    global cfg
    if not _layout_on():
        raise ValueError("set_props needs layout.enabled = 1")
    props = msg.get("props")
    if not isinstance(props, dict) or not props or not set(props) <= PROP_KEYS:
        raise ValueError(f"props must be a non-empty object with keys from {sorted(PROP_KEYS)}")
    for k, v in props.items():
        _num(v, k)
    mlist = _targets(msg)
    new = json.loads(json.dumps(cfg))
    ents = _ents()
    for m in mlist:
        new["layout"]["modules"][ents[m["id"]]["mi"]].update(props)
    new["layout"] = core.validate_layout(new["layout"], cfg["out_len"])  # ranges, overlap, out_len; nothing changed yet
    store.save(CFG_PATH, new)
    cfg = new
    _rebuild()  # keeps every unit's position/target; length/max_speed change the speed model from now on
    _push_chop_safe()


def _save_settings(s):
    global cfg
    if not isinstance(s, dict):
        raise ValueError("settings must be an object")
    new = json.loads(json.dumps(cfg))
    if _layout_on() and "patch" in s and s["patch"] != cfg["patch"]:
        raise ValueError("patch is controlled by the layout CHOPs while layout.enabled = 1")
    for k in ("ip", "net", "subnet", "universe", "patch", "calibration"):
        if k in s:
            new[k] = s[k]
    store.save(CFG_PATH, new)  # validates; raises ValueError and writes nothing on failure
    mode_changed = new["patch"]["mode"] != cfg["patch"]["mode"]
    now = _now()
    for m in mods.values():  # freeze each unit's position with the OLD calibration before the rate changes
        _anchor(m, now)
    cfg = new
    if mode_changed:
        _rebuild()
    _apply_dmx_params()
    _push_chop_safe()


# ---------- universe + frame tick ----------

def universe():
    _ensure()
    patch = {"addresses": {i: e["addr"] for i, e in _ents().items()}} if _layout_on() else cfg["patch"]
    return core.build_universe(patch, mods, cfg["out_len"])


def _dmx_in_wants_artnet():
    d = op(DMX_IN)  # noqa: F821
    return d is not None and bool(d.par.active.eval()) and d.par.interface.eval() == "artnet"


def _lsof_udp_6454():
    """True/False: does this TD process own a UDP socket on 6454? None when it cannot be told."""
    try:
        r = subprocess.run(["lsof", "-nP", "-a", "-p", str(os.getpid()), f"-iUDP:{ART_PORT}", "-Fn"],
                           capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    return bool(artpoll.parse_lsof_udp(r.stdout))


def _toggle_dmx_in():
    d = op(DMX_IN)  # noqa: F821
    if d is not None:
        d.par.active = False
        run(f"op('{DMX_IN}').par.active = True", delayFrames=3)  # noqa: F821  (after this frame released 6454)


def _do(acts, now):
    global _sock
    for a in acts:
        if a == "close_sock" and _sock is not None:
            _sock.close()
            _sock = None
        elif a == "toggle_dmx_in":
            _toggle_dmx_in()
        elif a == "verify":
            _do(disc.verified(now, _lsof_udp_6454()), now)
    if disc.warning and disc.warning != _warned[0]:
        _warned[0] = disc.warning
        print("gauze: WARNING", disc.warning)


_warned = [None]


def discovery_msg():
    if disc.warning:
        return disc.warning
    return "ArtPoll discovery paused: DMX In (Art-Net) holds UDP 6454" if disc.paused else None


def _poll_artnet(now):
    global _sock, _last_poll, _last_reply, _node
    _do(disc.step(now, _dmx_in_wants_artnet(), _sock is not None), now)
    if disc.blocked(now):
        return  # 6454 belongs to dmx_in; real-device discovery resumes when it is off
    if _sock is None:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            s.bind(("", ART_PORT))
            s.setblocking(False)
            _sock = s
        except OSError:
            _sock = None
            return
    if now - _last_poll >= POLL_EVERY_S:
        _last_poll = now
        try:
            _sock.sendto(artpoll.build_poll(), (cfg["ip"], ART_PORT))
        except OSError:
            pass
    while True:
        try:
            data, _addr = _sock.recvfrom(1024)
        except (BlockingIOError, InterruptedError):
            break
        except OSError:
            _sock.close()
            _sock = None
            break
        r = artpoll.parse_reply(data)
        if r:
            _last_reply = now
            _node = r["short_name"] or r["ip"]


def on_frame():
    global _frame
    _ensure()
    now = _now()
    op(GROUP + "/universe").cook(force=True)  # noqa: F821
    _poll_artnet(now)
    _frame += 1
    if _frame % UI_EVERY_FRAMES == 0:
        _sync_chop()
    if _frame % UI_EVERY_FRAMES == 0:
        op(GROUP + "/gauze_ui").module.update()  # noqa: F821

