# pytest-only: who may hold UDP 6454 (ArtPoll discovery vs DMX In Art-Net). Fake sockets / fake dmx_in / fake clock.
import builtins
import types

import artpoll as ap
import test_chop_sync as tcs


def run_steps(d, plan):
    """plan: list of (now, wants, sock_open) -> flat list of (now, action)"""
    out = []
    for now, wants, sock in plan:
        out += [(now, a) for a in d.step(now, wants, sock)]
    return out


def test_parse_lsof():
    assert ap.parse_lsof_udp("p80169\nf20\nn*:6454\nf49\nn127.0.0.1:6454\n") == ["*:6454", "127.0.0.1:6454"]
    assert ap.parse_lsof_udp("") == []


def test_state_machine_pauses_toggles_and_verifies():
    d = ap.Discovery()
    assert not d.blocked(0)
    assert run_steps(d, [(0, False, True)]) == []  # no dmx_in: discovery untouched
    acts = [a for _, a in run_steps(d, [(1, True, True)])]
    assert acts == ["close_sock", "toggle_dmx_in"] and d.blocked(1.1)
    assert run_steps(d, [(1.5, True, False)]) == []  # not due yet
    assert [a for _, a in run_steps(d, [(1 + ap.HOLD_S + ap.VERIFY_AFTER_S, True, False)])] == ["verify"]
    assert d.verified(5, True) == [] and d.warning is None and d.paused


def test_blocked_during_toggle_even_though_active_flickers_off():
    d = ap.Discovery()
    d.step(0, True, True)
    d.step(0.1, False, False)  # dmx_in momentarily Active=False during the toggle
    assert d.blocked(0.1) and d.paused  # ctl must not grab 6454 in this window
    d.step(ap.HOLD_S + 0.1, True, False)
    assert d.paused


def test_failed_bind_retries_then_warns_loudly():
    d = ap.Discovery()
    d.step(0, True, False)
    t = 10
    for k in range(ap.MAX_TRIES - 1):
        assert d.verified(t, False) == ["toggle_dmx_in"] and d.warning is None
        t += 10
    assert d.verified(t, False) == [] and "could NOT bind UDP 6454" in d.warning


def test_unknown_bind_state_is_reported_not_assumed():
    d = ap.Discovery()
    d.step(0, True, False)
    assert d.verified(5, None) == [] and "cannot verify" in d.warning


def test_resumes_discovery_when_dmx_in_turned_off():
    d = ap.Discovery()
    d.step(0, True, True)
    d.step(ap.HOLD_S + 1, False, False)
    assert not d.paused and not d.blocked(ap.HOLD_S + 1) and d.warning is None


# ---- ctl integration (fake sockets, fake dmx_in) ----

class FakeSock:
    def __init__(self, *a):
        self.bound, self.closed, self.sent = None, False, []

    def setsockopt(self, *a): pass
    def setblocking(self, *a): pass
    def bind(self, addr): self.bound = addr
    def close(self): self.closed = True
    def sendto(self, data, addr): self.sent.append(addr)
    def recvfrom(self, n): raise BlockingIOError


class FakeSocketModule:
    AF_INET, SOCK_DGRAM, SOL_SOCKET, SO_REUSEADDR, SO_REUSEPORT, SO_BROADCAST = 2, 2, 1, 2, 3, 4
    made = []
    @classmethod
    def socket(cls, *a):
        s = FakeSock(*a); cls.made.append(s); return s


class FakeDmxIn:
    """dmx_in CHOP stand-in: .par.active can be read via eval() and assigned."""
    def __init__(self):
        self.act, self.iface, self.toggles = False, "artnet", 0
        outer = self
        class Par:
            interface = types.SimpleNamespace(eval=lambda: outer.iface)
            active = types.SimpleNamespace(eval=lambda: outer.act)
            def __setattr__(self, k, v):
                assert k == "active"
                if v is False:
                    outer.toggles += 1
                outer.act = v
        self.par = Par()


def make(tmp_path, bound_result=True):
    ctl, ch = tcs.load_ctl(tmp_path)
    FakeSocketModule.made = []
    ctl.socket = FakeSocketModule
    ctl._sock = None
    ctl.disc = ap.Discovery()
    ctl._warned[0] = None
    din = FakeDmxIn()
    queued = []
    base = builtins.op
    builtins.op = lambda p: din if p == ctl.DMX_IN else base(p)
    builtins.run = lambda code, delayFrames=0: queued.append(code)
    ctl._lsof_udp_6454 = lambda: bound_result
    return ctl, din, queued


def tick(ctl, din, q, t):
    ctl._poll_artnet(t)
    if q:  # the delayed run(): dmx_in Active goes back on a few frames after the release
        assert "active = True" in q[-1]
        din.act = True
        q.clear()


def test_default_discovery_still_binds_6454_without_dmx_in(tmp_path):
    ctl, din, q = make(tmp_path)
    ctl._poll_artnet(100.0)
    assert ctl._sock is not None and ctl._sock.bound == ("", 6454)  # real-device discovery unchanged


def test_dmx_in_artnet_takes_over_6454_and_is_verified(tmp_path):
    ctl, din, q = make(tmp_path)
    ctl._poll_artnet(100.0)  # discovery socket open
    first = ctl._sock
    din.act = True
    tick(ctl, din, q, 101.0)
    assert first.closed and ctl._sock is None and din.toggles == 1  # port released, dmx_in re-activated
    for t in (101.5, 102.0, 104.5, 105.0):
        tick(ctl, din, q, t)
    assert ctl._sock is None and ctl.disc.warning is None
    assert "paused" in ctl.discovery_msg() and len(FakeSocketModule.made) == 1  # never re-opened 6454
    assert din.act is True


def test_unbound_dmx_in_warns_visibly(tmp_path, capsys):
    ctl, din, q = make(tmp_path, bound_result=False)
    din.act = True
    t = 100.0
    for _ in range(40):
        tick(ctl, din, q, t)
        t += 1.5
    assert "could NOT bind UDP 6454" in ctl.discovery_msg()
    assert "WARNING" in capsys.readouterr().out
    assert din.toggles >= 2  # retried by toggling Active before giving up


def test_discovery_resumes_after_dmx_in_off(tmp_path):
    ctl, din, q = make(tmp_path)
    din.act = True
    for t in (100, 101, 104, 105):
        tick(ctl, din, q, t)
    din.act = False
    for t in (106, 109):
        ctl._poll_artnet(t)
    assert ctl._sock is not None and ctl._sock.bound == ("", 6454) and ctl.discovery_msg() is None
