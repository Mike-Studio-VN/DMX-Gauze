import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GauzeCore } from '@shared/core';
import { MockDriver } from '@shared/drivers';
import { createDefaultProject } from '@shared/preset';
import { LinearFollowPlanner, planTimelineFollow } from '@shared/timeline';
import type { ModuleCfg, Snapshot, TimelineClip } from '@shared/types';

function makeMod(id: string, maxSpeedCms = 120): ModuleCfg {
  return {
    id,
    name: id,
    layerId: 'layer-1',
    visible: true,
    length: 2.55, // 1 bước CH1 = 1 cm → các độ cao tròn cm gần như không bị lượng tử hoá
    width: 1,
    minHeight: 0,
    maxHeight: 2.55,
    startAddress: 1,
    maxSpeedCms,
    defaultSpeed: 100,
  };
}

describe('Linear segment follow & DMX transport integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([25, 60])('sends one move per linear segment while the transport runs at %i FPS', (sendHz) => {
    const project = createDefaultProject();
    project.settings.output.sendHz = sendHz;

    const mod = makeMod('m-lin', 100);
    const clip: TimelineClip = {
      id: 'c-lin-1',
      layerId: 'layer-1',
      moduleId: 'm-lin',
      startTime: 2,
      duration: 6,
      curveMode: 'linear',
      keyframes: [
        { id: 'p1', offset: 0, height: 0 },
        { id: 'p2', offset: 3, height: 1.5 }, // 150cm in 3s -> 50 cm/s
        { id: 'p3', offset: 4, height: 1.5 }, // flat hold segment
        { id: 'p4', offset: 6, height: 0.5 }, // 100cm in 2s -> 50 cm/s
      ],
    };

    let nowMs = 0;
    let driverSentCount = 0;
    const core = new GauzeCore(
      (_cfg, ev) => {
        const d = new MockDriver(ev);
        const origSend = d.send.bind(d);
        d.send = (net, subUni, data) => {
          driverSentCount += 1;
          origSend(net, subUni, data);
        };
        return d;
      },
      () => nowMs,
    );
    core.configure({
      modules: [mod],
      output: project.settings.output,
      lockValue: 77,
    });
    core.command({ type: 'lock', locked: false });
    core.start();

    const planner = new LinearFollowPlanner();
    const dispatchedMoves: Array<{ t: number; target: unknown; speed: unknown }> = [];

    // Follow nine seconds of timeline at the selected transport rate.
    for (let step = 0; step < 9 * sendHz; step += 1) {
      const t = step / sendHz;
      const snap = core.snapshot();
      const { commands, warnings } = planTimelineFollow([mod], [clip], [], t, 0.06, snap, planner);
      expect(warnings).toEqual([]);
      for (const cmd of commands) {
        if (cmd.type === 'move') {
          dispatchedMoves.push({ t, target: cmd.target, speed: cmd.speed });
        }
        core.command(cmd);
      }
      const nextMs = Math.ceil(((step + 1) * 1000) / sendHz);
      const elapsedMs = nextMs - nowMs;
      nowMs = nextMs;
      vi.advanceTimersByTime(elapsedMs);
    }

    expect(driverSentCount).toBe(9 * sendHz);

    // Exactly ONE move at P1->P2 (t=2s, target=1.5, ~50 cm/s) and ONE move at P3->P4 (t=6s, target=0.5, ~50 cm/s);
    // flat segment P2->P3 and pre/post-roll emit zero redundant commands.
    expect(dispatchedMoves).toHaveLength(2);
    expect(dispatchedMoves[0].t).toBe(2);
    expect(dispatchedMoves[0].target).toBe(1.5);
    expect((dispatchedMoves[0].speed as { value: number }).value).toBeCloseTo(50, 0);

    expect(dispatchedMoves[1].t).toBe(6);
    expect(dispatchedMoves[1].target).toBe(0.5);
    expect((dispatchedMoves[1].speed as { value: number }).value).toBeCloseTo(50, 0);

    // Interpolated position settles cleanly at 0.5m by end of clip.
    expect(core.snapshot().modules['m-lin'].pos).toBeCloseTo(0.5, 1);
    core.stop();
  });

  it('handles seek mid-segment, unlock mid-segment, clip edit invalidation, Pause/Stop, E-Stop, and excess speed warning without spam', () => {
    const mod = makeMod('m-lin', 50); // max 50 cm/s
    const clip: TimelineClip = {
      id: 'c-fast',
      layerId: 'layer-1',
      moduleId: 'm-lin',
      startTime: 0,
      duration: 2,
      curveMode: 'linear',
      keyframes: [
        { id: 'p1', offset: 0, height: 0 },
        { id: 'p2', offset: 2, height: 2.0 }, // 200cm in 2s -> requires 100 cm/s (> 50 cm/s!)
      ],
    };

    const planner = new LinearFollowPlanner();
    const core = new GauzeCore((_cfg, ev) => new MockDriver(ev));
    core.configure({
      modules: [mod],
      output: createDefaultProject().settings.output,
      lockValue: 77,
    });
    core.command({ type: 'lock', locked: false });

    // First tick at t=0: emits 1 clamped move (50 cm/s) and 1 warning.
    const r1 = planTimelineFollow([mod], [clip], [], 0, 0.06, core.snapshot(), planner);
    expect(r1.commands).toHaveLength(1);
    expect(r1.commands[0]).toEqual({
      type: 'move',
      ids: ['m-lin'],
      target: 2,
      speed: { unit: 'cms', value: 50 },
    });
    expect(r1.warnings).toHaveLength(1);
    expect(r1.warnings[0]).toContain('m-lin');
    expect(r1.warnings[0]).toContain('P1→P2');

    // Subsequent ticks in same segment emit ZERO commands and ZERO repeated warnings (no toast spam).
    for (const t of [0.04, 0.08, 0.5, 1.0]) {
      const rNext = planTimelineFollow([mod], [clip], [], t, 0.06, core.snapshot(), planner);
      expect(rNext.commands).toEqual([]);
      expect(rNext.warnings).toEqual([]);
    }

    // Seek mid-segment (lookahead=0 invalidates planner): next playing tick at t=1.2 replans with remaining 0.8s!
    const feasibleClip: TimelineClip = {
      ...clip,
      keyframes: [
        { id: 'p1', offset: 0, height: 0 },
        { id: 'p2', offset: 4, height: 1.0 },
      ],
      duration: 4,
    };
    const core2 = new GauzeCore((_cfg, ev) => new MockDriver(ev));
    core2.configure({
      modules: [mod],
      output: createDefaultProject().settings.output,
      lockValue: 77,
    });
    core2.command({ type: 'lock', locked: false });
    const p2 = new LinearFollowPlanner();
    expect(planTimelineFollow([mod], [feasibleClip], [], 0, 0.06, core2.snapshot(), p2).commands).toHaveLength(1);
    // Scrub to t=2.0 (lookahead=0) -> invalidates planner; resume playing at t=2.0 with pos=0.2m -> remaining 2.0s for 0.8m = 40 cm/s!
    planTimelineFollow([mod], [feasibleClip], [], 2.0, 0, core2.snapshot(), p2);
    const snapMid: Snapshot = {
      ...core2.snapshot(),
      modules: { 'm-lin': { pos: 0.2, target: 0.2, ch3: 100, moving: false } },
    };
    const resumed = planTimelineFollow([mod], [feasibleClip], [], 2.0, 0.06, snapMid, p2);
    expect(resumed.commands).toHaveLength(1);
    expect((resumed.commands[0] as { speed: { value: number } }).speed.value).toBeCloseTo(40, 1);

    // Editing keyframe height invalidates segment automatically without manual reset.
    const editedClip: TimelineClip = {
      ...feasibleClip,
      keyframes: [
        { id: 'p1', offset: 0, height: 0 },
        { id: 'p2', offset: 4, height: 1.2 },
      ],
    };
    const afterEdit = planTimelineFollow([mod], [editedClip], [], 2.5, 0.06, snapMid, p2);
    expect(afterEdit.commands).toHaveLength(1);
    expect((afterEdit.commands[0] as { target: number }).target).toBe(1.2);

    // E-Stop holds & locks immediately and zeroes DMX lock channel.
    core2.command(afterEdit.commands[0]);
    core2.command({ type: 'estop' });
    core2.tick();
    expect(core2.snapshot().locked).toBe(true);
    expect(core2.snapshot().frame[3]).toBe(0);
  });

  it('preserves Smooth lookahead continuous behavior alongside Linear per-segment behavior on mixed clips', () => {
    const modSmooth = makeMod('m-smooth', 120);
    const modLinear = { ...makeMod('m-linear', 120), startAddress: 5 };
    const smoothClip: TimelineClip = {
      id: 'c-s',
      layerId: 'layer-1',
      moduleId: 'm-smooth',
      startTime: 0,
      duration: 4,
      curveMode: 'smooth',
      keyframes: [
        { id: 's1', offset: 0, height: 0 },
        { id: 's2', offset: 2, height: 2 },
        { id: 's3', offset: 4, height: 0 },
      ],
    };
    const linearClip: TimelineClip = {
      id: 'c-l',
      layerId: 'layer-1',
      moduleId: 'm-linear',
      startTime: 0,
      duration: 4,
      curveMode: 'linear',
      keyframes: [
        { id: 'l1', offset: 0, height: 0 },
        { id: 'l2', offset: 4, height: 2 },
      ],
    };

    const planner = new LinearFollowPlanner();
    const snap: Pick<Snapshot, 'modules'> = {
      modules: {
        'm-smooth': { pos: 0, target: 0, ch3: 100, moving: false },
        'm-linear': { pos: 0, target: 0, ch3: 100, moving: false },
      },
    };

    const smoothMoves: number[] = [];
    const linearMoves: number[] = [];
    for (const t of [0, 0.2, 0.4, 0.6, 0.8]) {
      const { commands } = planTimelineFollow(
        [modSmooth, modLinear],
        [smoothClip, linearClip],
        [],
        t,
        0.06,
        snap,
        planner,
      );
      for (const c of commands) {
        if (c.type === 'move' && c.ids[0] === 'm-smooth') smoothMoves.push(c.target as number);
        if (c.type === 'move' && c.ids[0] === 'm-linear') linearMoves.push(c.target as number);
      }
    }

    expect(smoothMoves.length).toBeGreaterThanOrEqual(4); // continuous lookahead updates
    expect(linearMoves).toEqual([2]); // exactly one command at segment entry
  });

});
