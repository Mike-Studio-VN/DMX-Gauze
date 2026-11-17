"""Dev tool: listen for Art-Net on UDP 6454 and print DMX slots that changed.

Usage: python3 tools/artnet_capture.py [--poll-reply]
  --poll-reply  also answer ArtPoll with a fake node, to test the status chip.
"""
import socket
import struct
import sys

reply_mode = "--poll-reply" in sys.argv
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
if hasattr(socket, "SO_REUSEPORT"):
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.bind(("", 6454))
print("listening on UDP 6454 ...")

last = {}
while True:
    data, addr = s.recvfrom(2048)
    if data[:8] != b"Art-Net\x00" or len(data) < 10:
        continue
    op = struct.unpack("<H", data[8:10])[0]
    if op == 0x2000 and reply_mode:  # ArtPoll -> fake ArtPollReply
        p = bytearray(239)
        p[0:10] = b"Art-Net\x00\x00\x21"
        p[10:14] = bytes([127, 0, 0, 1])
        p[26:35] = b"FakeNode\x00"
        s.sendto(bytes(p), ("255.255.255.255", 6454))
    elif op == 0x5000 and len(data) >= 18:  # ArtDMX
        uni = data[14] | (data[15] << 8)
        n = struct.unpack(">H", data[16:18])[0]
        slots = list(data[18:18 + n])
        prev = last.get(uni)
        if slots != prev:
            last[uni] = slots
            blocks = [(i + 1, slots[i:i + 4]) for i in range(0, min(len(slots), 64), 4) if any(slots[i:i + 4])]
            print(f"universe {uni}: " + "  ".join(f"@{a} CH1-4={b}" for a, b in blocks))
