# DMX Gauze Controller — Design

Date: 2026-11-17. Status: draft, waiting for approval.

## Intent
Operators raise and lower gauze screens (VDF H2 winches, 4-channel firmware) from one simple local web UI. TouchDesigner (TD) is the runtime engine: it serves the UI and sends Art-Net. The TD MCP is used only while building the TD network, never at runtime.

## Goals
- 13 modules: 12 × 1 m (M01–M12) and 1 × 3 m (M13).
- Control: up, down, stop, speed, go-to-percent.
- Main screen, 2 columns: Properties (left), Control (right).
- Settings page: connection (IP default 255.255.255.255), DMX patch, speed calibration.
- Connection status always visible in the header.
- Click animation on every button.
- Windows installer that installs the .toe, the web files and a shortcut that starts TD in Perform mode.

## Non-goals
- No cue lists, timeline, scheduling or multi-user login.
- No sACN, no MIDI/OSC input.
- No per-winch fault readback (the winch does not send any).
- No standalone .exe without TD (Approach B, rejected).

## Anti-goals
- A UI action that moves a screen the operator did not select.
- Showing "Connected" when it only means "Art-Net is being sent".
- A screen moving after the app starts, before an operator action.

## Constraints
- Art-Net is one-way. "Connected" means an Art-Net node answered ArtPoll. It cannot confirm a winch received the data.
- Manual: speed 0 = brake; winch needs speed > 0 to move. Max 15 winches per DMX chain, one address each, address range 1–504.
- Existing project `DMX_Gauze.toe` already has `dmxout1` (Art-Net, 255.255.255.255, 60 Hz, universe 0, empty routing table) and `mcp_webserver_base` (the MCP's own server — do not reuse its port).
- Dev on macOS, target Windows. No Windows-only TD operators.

## Approaches considered
- **A. TD as engine (chosen).** TD sends Art-Net and serves the UI via a second Web Server DAT + WebSocket. Installer ships .toe + web files. Needs TD installed on the target (confirmed).
- B. Standalone Electron/Node app. Real .exe, no TD. Rejected: user wants TD as the controller.
- C. Electron UI + TD backend. Rejected: two things to install and run.

## DMX model (my assumptions, to confirm on real hardware)
| Ch | Function | Value |
|----|----------|-------|
| 1 | Position target | 0–255 ↔ 0–100 % (0 = up/home, 255 = full down) |
| 2 | Fine tune | 0 (unused in v1, editable in Settings) |
| 3 | Speed | 0–255, default 100 |
| 4 | Safe lock | 77 always |

- **Up / Down / Stop (Mode 2):** Up = target 0, Down = target 255, Stop = freeze CH1 at the current estimated position. TD keeps an estimated position per module (speed × time) — an estimate, not a reading. Stop must also be possible by setting CH3 = 0 (brake); choose in calibration.
- **Seconds input:** seconds → speed via a calibration table in Settings (travel time at speed 100 measured once). Linear interpolation; clamp to 1–255.
- **Min/Max height (Properties):** per-module limits in %. CH1 target is clamped to [min, max] before it is sent. Limits apply to every control path.
- **Patch:**
  - *Linked mode:* M01–M12 share one 4-channel address; M13 has its own.
  - *Separate mode:* every module has its own start address (4 ch each, 52 ch total).
  - Settings holds net/subnet/universe and the address per module. TD builds the `dmxout1` routing table from it.

## UI
```
┌ Gauze Control            ● Connected  255.255.255.255  [⚙] ┐
├ Properties (selected)  ┬ Control   [Presets | Manual]        │
│ ☑ M01 … ☑ M12 ☑ M13    │ Presets: 6 buttons                  │
│ Min [  0 ]  Max [100]  │  1m Up 0%   1m Down 100%            │
│ Speed [100]            │  3m Up 0%   3m Down 100%            │
│                        │  All Up     All Down                │
│                        │ Manual: ⏮0%  ▲  ■  ▼  ⏭100%         │
│                        │  Speed [   ]  Seconds [   ]         │
└────────────────────────┴─────────────────────────────────────┘
```
- Controls act only on the selected modules. Nothing selected → buttons disabled, with a hint.
- Preset buttons "Up 0%" / "Down 100%" respect each module's min/max.
- Status states: Connected (ArtPoll reply < 6 s ago), Searching, Disconnected. Text plus colour, never colour alone. Header shows last reply time.
- Click animation: short press-scale + ripple (~150 ms), disabled under `prefers-reduced-motion`.
- Stop button is always enabled and visually dominant.

## Architecture
- TD: `dmxout1` (Art-Net out), a control script (state per module, clamps, patch → channel array), ArtPoll sender/receiver for status, Web Server DAT on its own port serving static UI and a WebSocket for commands and state.
- Web UI: plain HTML/CSS/JS, no build step.
- State persisted to a JSON file next to the .toe (patch, limits, calibration, last IP).
- Installer: Inno Setup, installs to Program Files, creates desktop shortcut running `TouchDesigner.exe DMX_Gauze.toe` in Perform mode.

## Left to the builder
- Port numbers, file layout, WebSocket message schema.
- ArtPoll implementation details (UDP DAT vs a Python socket in the script).
- Exact animation timing and colours.
- Test approach for TD logic (pure-Python helpers with asserts, UI checked in the browser).

## Open items (need real hardware, not blocking the build)
1. Does CH1 = 0 mean fully up? Direction may be reversed.
2. Does CH3 = 0 or freezing CH1 give the safer stop?
3. Travel time at speed 100 for the 1 m and 3 m modules.
4. Does the unit send anything back? If not, status stays "node reachable" only.
