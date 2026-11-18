# DMX Gauze Release Notes

## v1.0.1 (2026-11-18)

### Desktop App (`DMX Gauze`)
- **Art-Net Ephemeral Send & Localhost Coexistence**: `ArtNetDriver` now binds an ephemeral UDP port (`0`) for sending `ArtDmx`, so output never blocks if port `6454` is occupied and never steals `127.0.0.1:6454` from local receivers. Non-loopback `ArtPollReply` listening on `6454` activates only during node discovery and degrades gracefully with a clear UI warning if `6454` is busy.
- **Default Port Standardization**: Default UDP port is `6454` for Art-Net, `5568` for sACN E1.31 (`sacnUniverse ?? universe + 1`), and `6038` for KiNET; switching protocols automatically updates the port while saved projects preserve all configured positive custom ports (defaulting only when `port` is absent).
- **Timeline 40 / 50 / 60 fps & Frame Snap**: Added `40`, `50`, and `60 fps` timeline options alongside `24`, `25`, `29.97`, and `30 fps` with frame-accurate timecode formatting/parsing, frame snap toggle (`Alt` to bypass), and 4-decimal moment/keyframe dragging precision. DMX transport remains locked at `25 Hz` (`40 ms/frame`). Standard SMPTE LTC (`24 / 25 / 29.97 / 30 fps`) keeps its own rate and displays a mismatch warning when the timeline is above `30 fps`.
- **Cue Pad, Multi-Select & UI Polish**: Added 4-column Cue Pad grid with slot reordering and resume-from-pause progress bars, multi-select moment/module editing, notification toast settings, and custom themed Kiln dropdown menus (`KilnSelect`) with aligned settings rows.
- **Application Icon**: Packaged macOS (`icon.icns`), Windows (`icon.ico`), and runtime window/dock icons using the Mikmap logo (`src/renderer/src/assets/mik-logo.png`).

### Known Limitations
- **Same-Host Loopback Discovery on UDP `6454` (`127.0.0.1` / `localhost`)**: Per the Art-Net specification (`0x1936` = `6454` for both source and destination), standard `ArtPollReply` packets return to UDP `6454`. When a local receiver on the same host owns `127.0.0.1:6454`, `DMX Gauze` sends `ArtDmx` from an ephemeral UDP port (`bind(0)`) and skips binding `6454` to avoid contention or packet stealing; discovery status is therefore indeterminate (does not indicate the receiver is offline). Capturing replies on the ephemeral source port is supplementary compatibility only (not a substitute for standard `6454` discovery). Full same-host discovery requires receiver-assisted forwarding to a registered loopback endpoint or a separately assigned controller IP with address-specific node binding.

## v1.0.0 (2026-11-17)
- Initial release with 25 Hz linear segments, multi-select editing, notifications, and Manual wave UI.
