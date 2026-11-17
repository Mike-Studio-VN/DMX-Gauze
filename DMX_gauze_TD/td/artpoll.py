"""Art-Net ArtPoll builder and ArtPollReply parser (pure, no TD imports)."""

_HEADER = b"Art-Net\x00"


def build_poll():
    # OpCode 0x2000 little-endian, ProtVer 14 big-endian, TalkToMe 0, Priority 0
    return _HEADER + b"\x00\x20" + b"\x00\x0e" + b"\x00\x00"


def _text(b):
    return b.split(b"\x00", 1)[0].decode("ascii", "replace")


def parse_reply(data):
    try:
        if len(data) < 207 or data[:8] != _HEADER or data[8:10] != b"\x00\x21":
            return None
        return {
            "ip": ".".join(str(x) for x in data[10:14]),
            "short_name": _text(data[26:44]),
            "long_name": _text(data[44:108]),
        }
    except TypeError:
        return None


# ---------- who may hold UDP 6454 (Art-Net) ----------
# ArtPollReply comes back to port 6454, and the DMX In CHOP (Art-Net) needs the same port. Only one socket in
# this process can have it, so while a DMX In (Art-Net) is active the discovery socket stays closed.
HOLD_S = 2.0        # keep discovery off while dmx_in is being toggled (Active off -> on)
VERIFY_AFTER_S = 1.0
MAX_TRIES = 3


def parse_lsof_udp(out):
    """Local names (e.g. '*:6454') of the UDP sockets in `lsof -F n` output."""
    return [ln[1:] for ln in out.splitlines() if ln.startswith("n") and ":" in ln]


class Discovery:
    """Pure state machine. ctl calls step() every frame and executes the returned actions:
    'close_sock' (release 6454), 'toggle_dmx_in' (Active off -> on so it binds), 'verify' (is dmx_in bound?)."""

    def __init__(self):
        self.paused = False
        self.hold_until = 0.0
        self.verify_at = None
        self.tries = 0
        self.warning = None

    def blocked(self, now):
        return self.paused or now < self.hold_until

    def _rebind(self, now):
        self.hold_until = now + HOLD_S
        self.verify_at = now + HOLD_S + VERIFY_AFTER_S
        self.tries += 1

    def step(self, now, wants, sock_open):
        acts = []
        if wants and not self.paused:
            self.paused, self.tries, self.warning = True, 0, None
            if sock_open:
                acts.append("close_sock")
            acts.append("toggle_dmx_in")
            self._rebind(now)
        elif not wants and self.paused and now >= self.hold_until:
            self.paused, self.verify_at, self.warning = False, None, None  # dmx_in is off: discovery may resume
        elif wants and self.verify_at is not None and now >= self.verify_at:
            self.verify_at = None
            acts.append("verify")
        return acts

    def verified(self, now, bound):
        """bound: True / False / None (cannot tell). Returns ['toggle_dmx_in'] for a retry."""
        if bound:
            self.warning = None
            return []
        if bound is None:
            self.warning = "dmx_in Art-Net: cannot verify the UDP 6454 bind on this OS (no lsof)"
            return []
        if self.tries < MAX_TRIES:
            self._rebind(now)
            return ["toggle_dmx_in"]
        self.warning = ("dmx_in Art-Net could NOT bind UDP 6454 after %d tries: another process holds the port "
                        "(is the app listening on 6454?). Use sACN, or stop the other listener." % MAX_TRIES)
        return []
