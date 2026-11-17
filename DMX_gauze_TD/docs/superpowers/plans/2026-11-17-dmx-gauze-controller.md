# DMX Gauze Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web UI served by TouchDesigner that moves 13 gauze modules (12 × 1 m, 1 × 3 m) over Art-Net DMX and shows live Art-Net node status.

**Architecture:** Logic lives in pure Python modules under `td/` (unit-tested outside TD with pytest). A thin TD glue script builds the 512-channel universe each frame into a Script CHOP feeding the existing `dmxout1`, answers a WebSocket from a second Web Server DAT, and polls ArtPoll. The web UI is static HTML/CSS/JS. The TD MCP is used only to build the network; nothing at runtime depends on it.

**Tech Stack:** TouchDesigner 2025.32460 (Python 3.11), pytest, vanilla JS, Inno Setup (Windows installer).

**Spec:** `docs/superpowers/specs/2026-11-17-dmx-gauze-design.md`

**Repo note:** `/Users/hex_macstudio_01/RND/DMX_gauze` is not a git repository, so there are no commit steps. Run `git init` first if you want history.

## Global Constraints

- Channels: CH1 position target 0–255 ↔ 0–100 % (0 = up, 255 = down); CH2 fine tune default 0; CH3 speed default 100; CH4 safe lock always 77.
- Speed 0 = brake. A move command must never send speed 0; clamp speed to 1–255.
- Default IP `255.255.255.255`, Art-Net port 6454, `dmxout1` at 60 Hz. DMX address range 1–504; max 15 winches per chain.
- 13 modules: `M01`–`M12` (1 m), `M13` (3 m). Linked mode: M01–M12 share one 4-channel address, M13 has its own. Separate mode: 13 × 4 = 52 channels.
- Min/max height clamps apply to every control path (presets, manual, seconds, all-buttons).
- Status states exactly: `connected` (ArtPoll reply < 6 s ago), `searching`, `disconnected`. Text plus colour, never colour alone.
- Click animation ~150 ms press-scale + ripple; off under `prefers-reduced-motion`. Stop button always enabled.
- Do not reuse `/project1/mcp_webserver_base` or its port (9981). Dev on macOS, target Windows: no OS-specific operators or paths.
- No cue lists, sACN, MIDI/OSC, login, or per-winch fault readback.

## Review Focus

1. **Seconds = 0, negative, empty or non-numeric** → rejected with an inline message, no motion, no divide-by-zero. (Task 1)
2. **Min > max, or values outside 0–100** → rejected; limits stay unchanged. (Task 1)
3. **Nothing selected** → control buttons disabled with a hint; a stale WebSocket `move` with empty `ids` does nothing. (Tasks 4, 5)
4. **App start or WebSocket drop/reconnect** → no module moves until the operator acts; header shows `disconnected`/`searching` immediately on drop. (Tasks 4, 5)
5. **Overlapping or out-of-range patch addresses, invalid IP string, corrupt/missing state file** → Settings refuses to save with a message; the app falls back to defaults and still starts. (Tasks 1, 3, 6)

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `td/gauze_core.py` | Pure logic: percent↔DMX, clamping, seconds→speed, position estimate, patch validation, universe build |
| `td/artpoll.py` | Pure Art-Net ArtPoll builder and ArtPollReply parser |
| `td/gauze_store.py` | Load/save `config/gauze.json`, defaults, corrupt-file fallback |
| `td/gauze_ctl.py` | TD glue: module state, WebSocket handler, per-frame tick, ArtPoll socket |
| `web/index.html`, `web/app.css`, `web/app.js` | Main screen, Settings page, WebSocket client |
| `config/gauze.json` | Default patch, limits, calibration, IP |
| `tests/test_core.py`, `tests/test_artpoll.py`, `tests/test_store.py` | pytest |
| `tools/artnet_capture.py` | Dev tool: listen on UDP 6454, print CH1–CH4 per address |
| `installer/gauze.iss` | Inno Setup script |
| `DMX_Gauze.toe` | Modify via MCP |

---

### Task 1: Core logic

**Files:**
- Create: `td/gauze_core.py`
- Test: `tests/test_core.py`

**Interfaces:**
- Produces:
  - `pct_to_dmx(pct: float) -> int` — `round(pct*255/100)`, clamped 0–255.
  - `clamp_target(pct: float, lo: float, hi: float) -> float`
  - `validate_limits(lo: float, hi: float) -> None` — raises `ValueError` unless `0 <= lo <= hi <= 100`.
  - `seconds_to_speed(seconds: float, points: list[list[float]]) -> int` — `points` = `[[speed, travel_s], ...]`. Interpolate linearly on travel time between points, clamp to the end points; with a single point use inverse proportion `speed*travel_s/seconds`. Result clamped 1–255. Raises `ValueError` if `seconds` is not finite or `<= 0`.
  - `estimate_position(start: float, target: float, speed: int, travel_s_at_100: float, elapsed: float) -> float` — moves toward `target` at `speed/100 * 100/travel_s_at_100` percent per second, never overshoots.
  - `validate_patch(mode: str, addresses: dict[str, int]) -> None` — `mode` is `"linked"` or `"separate"`; raises `ValueError` on out-of-range (1–504 minus 3 for the last 4-channel block), duplicate or overlapping blocks, or unknown mode. In linked mode the keys are `"G1M"` (the 1 m group) and `"M13"`.
  - `build_universe(patch: dict, modules: dict[str, dict]) -> list[int]` — 512 ints. Each module dict has `target`, `speed`, `fine`, `lock`; writes `[pct_to_dmx(target), fine, speed, lock]` at the module's address (1-based). In linked mode `modules["G1M"]` is written once.

- [ ] **Step 1: Write failing tests in `tests/test_core.py`**
  - `test_pct_to_dmx_endpoints`: `0→0`, `100→255`, `50→128`, `-5→0`, `120→255`.
  - `test_clamp_target`: `clamp_target(5, 10, 90) == 10`, `clamp_target(95, 10, 90) == 90`.
  - `test_validate_limits_rejects_min_gt_max`: `(60, 40)` and `(-1, 50)` and `(0, 101)` raise `ValueError`.
  - `test_seconds_to_speed_inverse`: `points=[[100, 20]]`; `seconds=20 → 100`, `seconds=10 → 200`, `seconds=1000 → 2`, `seconds=0.01 → 255`.
  - `test_seconds_to_speed_interpolates`: `points=[[50, 40], [100, 20]]`; `seconds=30 → 75`.
  - `test_seconds_to_speed_rejects_bad_input`: `0`, `-3`, `float("nan")`, `float("inf")` raise `ValueError`.
  - `test_estimate_position_no_overshoot`: `estimate_position(0, 100, 100, 20, 10) == 50`; with `elapsed=999` returns `100`; moving up from 100 to 0 mirrors it.
  - `test_validate_patch_*`: overlap (`{"M01":1,"M02":3}` separate) fails; address 502 fails (block would end at 505); duplicates fail; a valid 13-module separate patch at `1,5,9,…,49` passes; linked `{"G1M":1,"M13":5}` passes; unknown mode fails.
  - `test_build_universe_linked`: `patch={"mode":"linked","addresses":{"G1M":1,"M13":5}}`, `G1M` target 100/speed 100, `M13` target 0/speed 80 → `u[0:4]==[255,0,100,77]`, `u[4:8]==[0,0,80,77]`, `len(u)==512`, rest zero.
  - `test_build_universe_separate`: M02 lands at its own address and M01 is untouched.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hex_macstudio_01/RND/DMX_gauze && python3 -m pytest tests/test_core.py -v` (if pytest is missing: `python3 -m pip install pytest`)
Expected: collection error / `ModuleNotFoundError: gauze_core` (add `td/` to the path in `tests/conftest.py`: `sys.path.insert(0, "td")`).

- [ ] **Step 3: Implement the functions above in `td/gauze_core.py`** — stdlib only, no TD imports (so it imports in pytest).

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest tests/test_core.py -v`
Expected: all PASS.

---

### Task 2: ArtPoll codec

**Files:**
- Create: `td/artpoll.py`
- Test: `tests/test_artpoll.py`

**Interfaces:**
- Produces:
  - `build_poll() -> bytes` — 14-byte ArtPoll packet: `b"Art-Net\x00"`, OpCode `0x2000` little-endian, ProtVer `0x000e` big-endian, TalkToMe `0x00`, Priority `0x00`.
  - `parse_reply(data: bytes) -> dict | None` — returns `{"ip": str, "short_name": str, "long_name": str}` for a valid ArtPollReply (OpCode `0x2100`, length ≥ 207, header `Art-Net\x00`); `None` for anything else, never raises.

- [ ] **Step 1: Write failing tests**
  - `test_build_poll_bytes`: `build_poll() == b"Art-Net\x00\x00\x20\x00\x0e\x00\x00"`.
  - `test_parse_reply_valid`: a handcrafted 239-byte reply with IP `[192,168,1,50]` at offset 10, short name `"Node1"` at offset 26, long name at offset 44 → `{"ip":"192.168.1.50","short_name":"Node1","long_name":...}` (names NUL-trimmed).
  - `test_parse_reply_garbage`: `b""`, `b"hello"`, a poll packet, and a reply truncated to 100 bytes all return `None`.

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest tests/test_artpoll.py -v` → FAIL (module missing).

- [ ] **Step 3: Implement `build_poll` and `parse_reply` in `td/artpoll.py`** using `struct`/slicing; offsets per the Art-Net spec (IP at 10, ShortName at 26 length 18, LongName at 44 length 64).

- [ ] **Step 4: Run** — `python3 -m pytest tests/test_artpoll.py -v` → PASS.

---

### Task 3: Config store

**Files:**
- Create: `td/gauze_store.py`, `config/gauze.json`
- Test: `tests/test_store.py`

**Interfaces:**
- Consumes: `gauze_core.validate_patch`, `gauze_core.validate_limits`.
- Produces:
  - `DEFAULTS: dict` — `{"ip": "255.255.255.255", "net":0, "subnet":0, "universe":0, "patch": {"mode":"linked","addresses":{"G1M":1,"M13":5}}, "limits": {<id>: {"min":0,"max":100}}, "calibration": {"1m": [[100, 20]], "3m": [[100, 60]]}, "speed_default":100, "fine_default":0, "lock":77}` — calibration travel times are placeholders to be measured (spec open item 3).
  - `load(path: str) -> dict` — returns merged defaults on missing, unreadable or invalid JSON, or when the loaded patch/limits fail validation; never raises.
  - `save(path: str, cfg: dict) -> None` — validates IP (`ipaddress.IPv4Address`), patch, limits first; raises `ValueError` and writes nothing on failure; writes atomically (temp file then `os.replace`).

- [ ] **Step 1: Write failing tests** — `test_load_missing_returns_defaults`; `test_load_corrupt_returns_defaults` (file contains `{not json`); `test_save_rejects_bad_ip` (`"999.1.1.1"`, `""`, `"abc"`) and leaves the existing file bytes unchanged; `test_save_rejects_overlapping_patch`; `test_roundtrip`.
- [ ] **Step 2: Run** — `python3 -m pytest tests/test_store.py -v` → FAIL.
- [ ] **Step 3: Implement `td/gauze_store.py`; write `config/gauze.json` as a dump of `DEFAULTS`.**
- [ ] **Step 4: Run** — `python3 -m pytest -v` → all tests PASS.

---

### Task 4: TouchDesigner network (via MCP)

**Files:**
- Create: `td/gauze_ctl.py`
- Modify: `DMX_Gauze.toe` (via MCP `create_td_node`, `execute_python_script`, `update_td_node_parameters`)

**Interfaces:**
- Consumes: `gauze_core`, `artpoll`, `gauze_store`.
- Produces — WebSocket protocol (JSON text frames), on port **9982**:
  - Client → TD: `{"cmd":"move","ids":[str],"target":float}` with optional `"seconds":float` or `"speed":int`; `{"cmd":"stop","ids":[str]}`; `{"cmd":"set_limits","ids":[str],"min":float,"max":float}`; `{"cmd":"set_speed","ids":[str],"speed":int}`; `{"cmd":"get_settings"}`; `{"cmd":"save_settings","settings":{...}}`.
  - TD → client: `{"type":"state","modules":[{"id","type":"1m|3m","pos","target","speed","min","max"}],"conn":{"state":"connected|searching|disconnected","age_s":float|null,"ip":str,"node":str|null}}` on every change and every 500 ms; `{"type":"settings","settings":{...}}`; `{"type":"error","message":str}`.
  - Entities in `modules`: in linked mode `G1M` (the 12 × 1 m group, selectable only as a whole) and `M13`; in separate mode `M01`–`M13`.

- [ ] **Step 1: Inspect before building** — `get_td_nodes /project1` and read `dmxout1` params (already known: artnet, 255.255.255.255, 60 Hz, universe 0). Open the `Format` menu on `dmxout1` and pick the option that emits one 512-channel universe packet from one sample; note the choice in a comment in `gauze_ctl.py`.
- [ ] **Step 2: Create nodes under `/project1/gauze`** (Base COMP): `ctl` (Text DAT, `file` = `td/gauze_ctl.py`, sync on), `universe` (Script CHOP, 512 channels `c1…c512`, one sample, driven by `gauze_ctl.on_frame()`), `ui_ws` (Web Server DAT, port 9982, serves `web/` as static root and routes `/ws`), `tick` (Execute DAT, frame-start callback → `gauze_ctl.on_frame()`). Wire `universe` → `dmxout1` and set `dmxout1` routing table to map `c1…c512` to net/subnet/universe from config. At the top of `gauze_ctl.py`, `sys.path.insert(0, project.folder + "/td")` so `import gauze_core` etc. work.
- [ ] **Step 3: Implement in `td/gauze_ctl.py`:**
  - `on_start()` — load config via `gauze_store.load(project.folder + "/config/gauze.json")`; every module starts with `target = pos = 0`, `speed = speed_default`; **no motion command is issued at start** (CH1 holds 0).
  - `on_message(ws_client, text: str)` — parse JSON, validate, apply, reply; unknown/invalid → `{"type":"error",...}`; empty `ids` → ignored.
  - `on_frame()` — advance `estimate_position` per module, write `build_universe(...)` into the Script CHOP, poll the ArtPoll socket.
  - Move: `target = clamp_target(target, min, max)`; with `seconds`, `speed = seconds_to_speed(seconds, calibration[type])`; Stop sets `target = round(pos)` (freeze CH1 at the estimate).
  - ArtPoll: non-blocking UDP socket (`SO_BROADCAST`, `SO_REUSEADDR`) bound to port 6454; send `build_poll()` to `ip:6454` every 2 s; any valid `parse_reply` updates `last_reply`; state = `connected` if age < 6 s, `searching` if a poll was sent but none heard since start, `disconnected` after a previous `connected` timed out or on socket error.
  - `on_ws_close` / no clients — leave module state untouched.
- [ ] **Step 4: Verify the network** — run `get_td_node_errors` on `/project1/gauze` and `/project1/dmxout1` (expect none). Then via `execute_python_script` call `op('/project1/gauze/ctl').module.on_message(None, '{"cmd":"move","ids":["G1M"],"target":100}')` and read `op('/project1/gauze/universe')['c1'].eval()` → `255`, `c3` → `100`, `c4` → `77`. Repeat with `{"cmd":"move","ids":[],"target":100}` → no change. Expected: all as stated.

---

### Task 5: Main screen UI

**Files:**
- Create: `web/index.html`, `web/app.css`, `web/app.js`

**Interfaces:**
- Consumes: the Task 4 WebSocket protocol on `ws://<host>:9982/ws`.
- Produces: single-page UI; Settings is a second view in the same page (Task 6).

- [ ] **Step 1: Build the layout** per the spec sketch: header (title, status chip, IP, ⚙), left Properties column, right Control column with a Presets | Manual tab pair. Left column: checkbox list of entities (select all / none), Min and Max number inputs (0–100), Speed input (1–255, default 100) applying to the selected ones via `set_limits`/`set_speed`.
- [ ] **Step 2: Presets tab** — six buttons: `1m Up 0%`, `1m Down 100%`, `3m Up 0%`, `3m Down 100%`, `All Up`, `All Down`. They act on their fixed module group regardless of the checkboxes; Up/Down send `move` with target 0 / 100. (The spec says Mode 1 buttons are by module type; selection applies to Mode 2 only.)
- [ ] **Step 3: Manual tab** — five buttons on the selected modules: `⏮ 0%`, `▲ Up` (target 0), `■ Stop`, `▼ Down` (target 100), `⏭ 100%`; Speed input and Seconds input with a `Run` button (`move` with `seconds`, target = the last Up/Down intent, or the 0 %/100 % button pressed; Run is disabled until a direction is chosen). Inline message under the inputs for rejected values.
- [ ] **Step 4: Status chip and live positions** — render `conn.state` as text + colour + icon, show `age_s` as "last reply 1.2 s ago"; show each module's estimated `pos` as a small bar, labelled "estimated". On WebSocket close, show `disconnected` immediately and retry every 1 s; buttons disabled while closed.
- [ ] **Step 5: Animation** — on `pointerdown` add a class that scales to 0.96 for 150 ms and spawns a CSS ripple; wrap in `@media (prefers-reduced-motion: no-preference)`.
- [ ] **Step 6: Verify in the built-in browser** — with the TD project running, open `http://localhost:9982/`. Check: header status text updates; selecting `G1M` and pressing Down changes `c1` to 255 in TD; with nothing selected the Manual buttons are disabled with a hint; Stop is enabled even with nothing selected; reduced-motion emulation disables the ripple; kill the TD web server and confirm the header turns `disconnected` within 1 s. Expected: all hold.

---

### Task 6: Settings view

**Files:**
- Modify: `web/index.html`, `web/app.js`, `web/app.css`

**Interfaces:**
- Consumes: `get_settings` / `save_settings` / `settings` / `error` messages (Task 4).

- [ ] **Step 1: Settings form** — IP (default `255.255.255.255`), net/subnet/universe numbers, patch mode radio (Linked / Separate), address inputs (Linked: `1 m group`, `3 m`; Separate: M01–M13), and calibration travel time at speed 100 for 1 m and 3 m (seconds).
- [ ] **Step 2: Save flow** — `Save` sends `save_settings`; on `error`, show the message next to the form and keep editing; on success show "Saved" and apply the new IP to ArtPoll without restarting TD.
- [ ] **Step 3: In `gauze_ctl.py` handle `get_settings` / `save_settings`** — call `gauze_store.save`, rebuild entities when the patch mode changes (reset targets/positions to 0 without sending a move), update the ArtPoll destination.
- [ ] **Step 4: Verify** — in the browser: enter `999.1.1.1` → error shown, file unchanged; patch `1` and `3` in separate mode → overlap error; valid change → saved, `config/gauze.json` updated; reload the page and TD → values persist. Delete the config file → app starts on defaults.

---

### Task 7: Windows installer

**Files:**
- Create: `installer/gauze.iss`

- [ ] **Step 1: Write `installer/gauze.iss`** — installs `DMX_Gauze.toe`, `td/`, `web/`, `config/gauze.json` (do not overwrite an existing config: `onlyifdoesntexist`) to `{autopf}\DMX Gauze`; shortcut target `{reg:HKLM\SOFTWARE\Derivative\TouchDesigner,InstallPath|C:\Program Files\Derivative\TouchDesigner}\bin\TouchDesigner.exe` with parameter `"{app}\DMX_Gauze.toe"`; set the .toe to open in Perform mode (set the Perform-mode start from inside the .toe via the Project's `Window COMP`/`Perform` settings in Task 4, not the installer).
- [ ] **Step 2: Check path handling** — confirm `gauze_ctl.py` uses `project.folder` only (no hard-coded `/Users/...`) so the install location can change. Search: `grep -n "/Users/" td/*.py web/* ` → no output.
- [ ] **Step 3: Build** — on a Windows machine with Inno Setup: `ISCC.exe installer\gauze.iss`. Expected: `Output\DMXGauzeSetup.exe`. (This cannot be run on this Mac.)

---

### Task 8: End-to-end check

**Files:**
- Create: `tools/artnet_capture.py`

- [ ] **Step 1: Write `tools/artnet_capture.py`** — binds UDP 6454, parses ArtDMX packets (OpCode `0x5000`), prints universe and `CH1..CH4` for each active address on change.
- [ ] **Step 2: Capture test (no hardware)** — run the capture tool, press Down on `G1M`, then Stop, then `Run` with 10 s. Expected: CH1 goes to 255, freezes at an intermediate value after Stop, CH3 changes to the computed speed on Run, CH4 always 77, CH3 never 0 while moving. Repeat in Separate mode and check M02's block moves alone.
- [ ] **Step 3: ArtPoll test** — run a tiny local responder (a throwaway Python script replying with a valid ArtPollReply): header shows `connected` within 3 s, then `disconnected` within ~6 s of stopping it.
- [ ] **Step 4: Hardware checklist (operator, real screen)** — record in `docs/superpowers/specs/2026-11-17-dmx-gauze-design.md` under Open items: CH1 direction (0 = up?), safer stop (CH3 = 0 vs freeze CH1), measured travel times for 1 m / 3 m at speed 100 (enter into Settings), whether the unit sends any reply.

---

## Self-review notes

- **Spec coverage:** goals and Settings (Tasks 5–6), connection status (Tasks 2, 4, 5), min/max (Tasks 1, 4, 5), seconds→speed (Task 1), patch modes (Tasks 1, 3, 6), installer (Task 7), open items (Task 8).
- **My calls beyond the spec:** WebSocket/UI port 9982; Presets act on fixed groups regardless of selection (spec says presets are per-type/all); linked-mode `G1M` is selectable only as a whole; "Run" with seconds needs a chosen direction; calibration defaults (20 s / 60 s travel at speed 100) are placeholders.
- **Not verified:** exact `dmxout1` Format menu semantics and ArtPoll port-sharing on Windows — both are explicitly checked in Task 4 step 1 and Task 8.
