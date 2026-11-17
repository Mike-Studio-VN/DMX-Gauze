# Framework-free: runs under pytest on disk and under /project1/gauze/run_tests inside TouchDesigner.
try:
    import artpoll as a
except ImportError:  # inside TouchDesigner
    a = op("/project1/gauze/artpoll").module  # noqa: F821


def _reply(ip=(192, 168, 1, 50), short=b"Node1", long=b"Test Node Long"):
    p = bytearray(239)
    p[0:8] = b"Art-Net\x00"
    p[8:10] = b"\x00\x21"
    p[10:14] = bytes(ip)
    p[26:26 + len(short)] = short
    p[44:44 + len(long)] = long
    return bytes(p)


def test_build_poll_bytes():
    assert a.build_poll() == b"Art-Net\x00\x00\x20\x00\x0e\x00\x00"


def test_parse_reply_valid():
    r = a.parse_reply(_reply())
    assert r == {"ip": "192.168.1.50", "short_name": "Node1", "long_name": "Test Node Long"}


def test_parse_reply_garbage():
    assert a.parse_reply(b"") is None
    assert a.parse_reply(b"hello") is None
    assert a.parse_reply(a.build_poll()) is None
    assert a.parse_reply(_reply()[:100]) is None
    assert a.parse_reply(None) is None
