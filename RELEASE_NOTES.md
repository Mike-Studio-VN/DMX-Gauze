# DMX Gauze Release Notes

## v1.0.1 (2026-11-18)

### Desktop App (`DMX Gauze`)
- **Art-Net Ephemeral Send & Localhost Coexistence**: `ArtNetDriver` now binds an ephemeral UDP port (`0`) for sending `ArtDmx`, so output never blocks if port `6454` is occupied and never steals `127.0.0.1:6454` from local receivers (such as TouchDesigner `dmx_in`). Non-loopback `ArtPollReply` listening on `6454` activates only during node discovery and degrades gracefully with a clear UI warning if `6454` is busy.
- **Default Port Standardization**: Default UDP port is `6454` for Art-Net, `5568` for sACN E1.31 (`sacnUniverse ?? universe + 1`), and `6038` for KiNET; switching protocols automatically updates the port while saved projects preserve all configured positive custom ports (defaulting only when `port` is absent).
- **Timeline 40 / 50 / 60 fps & Frame Snap**: Added `40`, `50`, and `60 fps` timeline options alongside `24`, `25`, `29.97`, and `30 fps` with frame-accurate timecode formatting/parsing, frame snap toggle (`Alt` to bypass), and 4-decimal moment/keyframe dragging precision. DMX transport remains locked at `25 Hz` (`40 ms/frame`). Standard SMPTE LTC (`24 / 25 / 29.97 / 30 fps`) keeps its own rate and displays a mismatch warning when the timeline is above `30 fps`.
- **Cue Pad, Multi-Select & UI Polish**: Added 4-column Cue Pad grid with slot reordering and resume-from-pause progress bars, multi-select moment/module editing, notification toast settings, and custom themed Kiln dropdown menus (`KilnSelect`) with aligned settings rows.
- **Application Icon**: Packaged macOS (`icon.icns`), Windows (`icon.ico`), and runtime window/dock icons using the Mikmap logo (`src/renderer/src/assets/mik-logo.png`).

### TouchDesigner Controller (`DMX_gauze_TD`)
- **CHOP-Tunable Controller Network**: Included `DMX_gauze_TD` (`DMX_Gauze.toe`, `td/` modules, `config/gauze.json`, `installer/gauze.iss`, and 189 offline pytest cases) with CHOP-tunable parameters for layer count, modules per layer, layer/module geometry, motor limits, and stop buttons (`Stop 1 m` / `Stop 3 m` / `Stop All`).
- **Art-Net `dmx_in` & Port `6454` Coexistence**: Updated `td/artpoll.py` and `td/gauze_ctl.py` so ArtPoll discovery releases UDP `6454` while Art-Net `dmx_in` is active, re-binds and verifies via `lsof`, and warns cleanly if binding fails.
- **Safety & Requirements**: Ships with `dmxout1` `Active=OFF` and empty routing table (configure universe/patch before outputting to live hardware). Tested on TouchDesigner `099.2025` (`099.2025.32460`).

### Known Limitations
- Auto-resuming ArtPoll discovery in TD after toggling `dmx_in` Art-Net off is verified by unit tests and has not yet been measured in a live TD toggle pass.
- TD→App LTC sync was verified via WAV + `LtcDecoder`; live virtual audio loopback (e.g. BlackHole) and OS microphone/audio input permissions were not yet measured.
- Default `.toe` retains the local loopback test input configuration (`127.0.0.1`, rate `25`, `dmxout1` OFF).

## v1.0.0 (2026-11-17)
- Initial release with 25 Hz linear segments, multi-select editing, notifications, and Manual wave UI.
