import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject, normalizeProject } from '@shared/preset';
import type { Command, TimelineClip } from '@shared/types';

interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}

const hookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  effects: [] as Array<{ deps?: unknown[]; cleanup?: void | (() => void); fn: () => void | (() => void) }>,
  pendingEffects: [] as number[],
  cursor: 0,
  component: null as null | (() => VNode),
  lastTree: null as VNode | null,
  renderScheduled: false,
  reset() {
    for (const eff of this.effects) {
      if (typeof eff?.cleanup === 'function') eff.cleanup();
    }
    this.states = [];
    this.refs = [];
    this.memos = [];
    this.effects = [];
    this.pendingEffects = [];
    this.cursor = 0;
    this.component = null;
    this.lastTree = null;
    this.renderScheduled = false;
  },
  depsEqual(a?: unknown[], b?: unknown[]) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => Object.is(v, b[i]));
  },
  flushEffects() {
    while (this.pendingEffects.length > 0) {
      const idx = this.pendingEffects.shift()!;
      const eff = this.effects[idx];
      if (!eff) continue;
      if (typeof eff.cleanup === 'function') {
        eff.cleanup();
        eff.cleanup = undefined;
      }
      eff.cleanup = eff.fn();
    }
  },
  render() {
    if (!this.component) return null;
    this.cursor = 0;
    this.lastTree = this.component();
    this.flushEffects();
    return this.lastTree;
  },
}));

vi.mock('react', () => {
  const React = {
    Fragment: Symbol.for('react.fragment'),
    useState: <T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
      const idx = hookRuntime.cursor++;
      if (!(idx in hookRuntime.states)) {
        hookRuntime.states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setter = (next: T | ((prev: T) => T)) => {
        const prev = hookRuntime.states[idx] as T;
        const val = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (!Object.is(prev, val)) {
          hookRuntime.states[idx] = val;
          if (!hookRuntime.renderScheduled) {
            hookRuntime.renderScheduled = true;
            try {
              hookRuntime.render();
            } finally {
              hookRuntime.renderScheduled = false;
            }
          }
        }
      };
      return [hookRuntime.states[idx] as T, setter];
    },
    useRef: <T>(initial: T) => {
      const idx = hookRuntime.cursor++;
      if (!(idx in hookRuntime.refs)) {
        hookRuntime.refs[idx] = { current: initial };
      }
      return hookRuntime.refs[idx] as { current: T };
    },
    useMemo: <T>(factory: () => T, deps: unknown[]) => {
      const idx = hookRuntime.cursor++;
      const prev = hookRuntime.memos[idx];
      if (!prev || !hookRuntime.depsEqual(prev.deps, deps)) {
        hookRuntime.memos[idx] = { deps, value: factory() };
      }
      return hookRuntime.memos[idx].value as T;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = hookRuntime.cursor++;
      const prev = hookRuntime.effects[idx];
      if (!prev || !deps || !hookRuntime.depsEqual(prev.deps, deps)) {
        hookRuntime.effects[idx] = { deps, cleanup: prev?.cleanup, fn };
        hookRuntime.pendingEffects.push(idx);
      }
    },
    useSyncExternalStore: <T>(_subscribe: (onChange: () => void) => () => void, getSnapshot: () => T) =>
      getSnapshot(),
  };
  return { ...React, default: React };
});

vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: Record<string, unknown>): VNode => ({ type, props });
  return { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') };
});

vi.mock('zustand', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    create: <T>(initializer: import('zustand/vanilla').StateCreator<T>) => {
      const store = createStore<T>(initializer);
      const useBoundStore = (selector?: (state: T) => unknown) =>
        selector ? selector(store.getState()) : store.getState();
      return Object.assign(useBoundStore, store);
    },
  };
});

vi.mock('lucide-react', () => {
  const icon = (name: string) => () => ({ type: 'icon', props: { name } });
  return {
    AlertCircle: icon('AlertCircle'),
    AlertTriangle: icon('AlertTriangle'),
    ArrowDown: icon('ArrowDown'),
    ArrowLeft: icon('ArrowLeft'),
    ArrowUp: icon('ArrowUp'),
    Check: icon('Check'),
    ChevronDown: icon('ChevronDown'),
    ChevronLeft: icon('ChevronLeft'),
    ChevronRight: icon('ChevronRight'),
    Clock: icon('Clock'),
    Eye: icon('Eye'),
    EyeOff: icon('EyeOff'),
    HelpCircle: icon('HelpCircle'),
    Layers: icon('Layers'),
    Link2: icon('Link2'),
    Magnet: icon('Magnet'),
    Pause: icon('Pause'),
    Play: icon('Play'),
    Plus: icon('Plus'),
    Settings: icon('Settings'),
    RefreshCw: icon('RefreshCw'),
    RotateCcw: icon('RotateCcw'),
    SkipBack: icon('SkipBack'),
    SkipForward: icon('SkipForward'),
    Trash2: icon('Trash2'),
    Waves: icon('Waves'),
    WifiOff: icon('WifiOff'),
    ZoomIn: icon('ZoomIn'),
    ZoomOut: icon('ZoomOut'),
  };
});

import { TimelineEditor } from './components/TimelineEditor';
import { DraftInput, NumberField } from './components/DraftInput';
import { PropertiesPanel } from './components/PropertiesPanel';
import { LtcSettingsPanel } from './components/LtcSettingsPanel';
import { getBridge } from './services/bridge';
import { useAppStore } from './store/useAppStore';

function writeBcdBits(bits: number[], start: number, val: number, count: number): void {
  for (let i = 0; i < count; i += 1) {
    bits[start + i] = (val >> i) & 1;
  }
}

function encodeSmpteBiphaseFrame(
  h: number,
  m: number,
  s: number,
  f: number,
  sampleRate = 48000,
  fps = 25,
  startPhase = 1,
  dropFrame = false,
): { samples: Float32Array; endPhase: number } {
  const bits = new Array<number>(80).fill(0);
  writeBcdBits(bits, 0, f % 10, 4);
  writeBcdBits(bits, 8, Math.floor(f / 10), 2);
  bits[10] = Number(dropFrame);
  writeBcdBits(bits, 16, s % 10, 4);
  writeBcdBits(bits, 24, Math.floor(s / 10), 3);
  writeBcdBits(bits, 32, m % 10, 4);
  writeBcdBits(bits, 40, Math.floor(m / 10), 3);
  writeBcdBits(bits, 48, h % 10, 4);
  writeBcdBits(bits, 56, Math.floor(h / 10), 2);
  const sync = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
  for (let i = 0; i < 16; i += 1) bits[64 + i] = sync[i];

  const samplesPerBit = Math.round(sampleRate / (fps * 80));
  const halfBit = Math.floor(samplesPerBit / 2);
  const out = new Float32Array(80 * samplesPerBit);
  let phase = startPhase;
  let pos = 0;
  for (const bit of bits) {
    phase = -phase;
    for (let i = 0; i < halfBit; i += 1) out[pos++] = phase * 0.8;
    if (bit === 1) phase = -phase;
    for (let i = halfBit; i < samplesPerBit; i += 1) out[pos++] = phase * 0.8;
  }
  return { samples: out, endPhase: phase };
}

function collectNodes(node: unknown, out: VNode[] = []): VNode[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
    return out;
  }
  const v = node as VNode;
  if ('type' in v && 'props' in v) {
    out.push(v);
    if (v.props?.children !== undefined) collectNodes(v.props.children, out);
  }
  return out;
}

function extractText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in (node as VNode)) {
    return extractText((node as VNode).props.children);
  }
  return '';
}

function mockLtcAudio(open: () => Promise<{ getTracks: () => TestTrack[] }>) {
  const getUserMedia = vi.fn(open);
  const processors: Array<{ connect: () => void; onaudioprocess?: (event: unknown) => void }> = [];
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  vi.stubGlobal('AudioContext', class {
    sampleRate = 48000;
    destination = {};
    createMediaStreamSource() { return { connect: vi.fn() }; }
    createScriptProcessor() {
      const processor = { connect: vi.fn() };
      processors.push(processor);
      return processor;
    }
    close = vi.fn(async () => {});
  });
  return { getUserMedia, processors };
}

interface TestTrack {
  stop: () => void;
  onended?: (() => void) | null;
}

function mockPcmInput() {
  const { processors } = mockLtcAudio(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
  let phase = 1;
  return {
    ready: () => vi.waitFor(() => expect(processors[0]?.onaudioprocess).toBeTypeOf('function')),
    feed(minute: number, second: number, frames: number[]) {
      for (const frame of frames) {
        vi.advanceTimersByTime(40);
        const pcm = encodeSmpteBiphaseFrame(0, minute, second, frame, 48000, 25, phase);
        phase = pcm.endPhase;
        processors[0].onaudioprocess!({ inputBuffer: { numberOfChannels: 1, getChannelData: () => pcm.samples } });
      }
    },
  };
}

describe('TimelineEditor real LTC decode -> freewheel -> lost stop integration (Bug 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    hookRuntime.reset();
    useAppStore.setState(useAppStore.getInitialState());

    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    });
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    hookRuntime.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('follows LTC through freewheel, ignores local seeks, and holds only Timeline targets on loss or stop', async () => {
    const project = createDefaultProject();
    project.settings.timeline.fps = 25;
    project.settings.ltc.freewheelFrames = 10; // 400 ms at 25 fps
    project.settings.ltc.offsetFrames = 0;

    const mod = project.modules[0];
    const clip: TimelineClip = {
      id: 'ltc-follow-clip',
      layerId: mod.layerId,
      moduleId: mod.id,
      startTime: 2,
      duration: 4,
      curveMode: 'smooth',
      keyframes: [
        { id: 'k0', offset: 0, height: 0 },
        { id: 'k1', offset: 4, height: Math.min(2, mod.maxHeight) },
      ],
    };
    project.clips = [clip];
    project.keys = [];

    const dispatched: Command[] = [];
    vi.spyOn(getBridge(), 'command').mockImplementation(async (cmd: Command) => {
      dispatched.push(cmd);
      return { ok: true };
    });

    useAppStore.setState({
      project,
      selectedIds: [mod.id],
      snapshot: {
        t: Date.now(),
        locked: false,
        modules: {
          [mod.id]: { pos: 0, target: 0, ch3: mod.defaultSpeed, moving: false },
        },
        status: {
          state: 'online',
          driver: 'mock',
          ip: '127.0.0.1',
          port: 6454,
          portAddress: 0,
          sendHz: 40,
          nodes: [],
          message: null,
          warning: null,
        },
        frame: [],
      },
    });

    const store = useAppStore.getState();
    const directMove: Command = { type: 'move', ids: [project.modules[1].id], target: 'max', speed: { unit: 'default' } };
    store.setActiveTab('manual');
    expect((await store.sendCommand(directMove, { source: 'manual' })).ok).toBe(true);
    store.setActiveTab('timeline');
    expect((await store.sendCommand(directMove, { source: 'manual' })).ok).toBe(false);
    expect((await store.sendCommand(directMove, { source: 'buttons' })).ok).toBe(false);
    expect(dispatched).toEqual([directMove]);
    dispatched.length = 0;

    let capturedProc: { onaudioprocess?: (ev: { inputBuffer: { numberOfChannels: number; getChannelData: (ch: number) => Float32Array } }) => void } | null = null;
    const trackStopSpy = vi.fn();

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: trackStopSpy }],
        })),
      },
    });
    vi.stubGlobal(
      'AudioContext',
      class FakeAudioContext {
        sampleRate = 48000;
        destination = {};
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
        createScriptProcessor() {
          capturedProc = {};
          return {
            connect: vi.fn(),
            set onaudioprocess(
              fn: (ev: { inputBuffer: { numberOfChannels: number; getChannelData: (ch: number) => Float32Array } }) => void,
            ) {
              capturedProc!.onaudioprocess = fn;
            },
          };
        }
        close = vi.fn(async () => {});
      },
    );

    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    const tree1 = hookRuntime.render();
    const ltcBtn = collectNodes(tree1).find(
      (n) => n.type === 'button' && String(n.props.title ?? '').includes('LTC'),
    );
    expect(ltcBtn).toBeDefined();

    // Activate LTC mode via real component button handler.
    (ltcBtn!.props.onClick as () => void)();
    hookRuntime.render();
    await vi.waitFor(() => expect(capturedProc?.onaudioprocess).toBeTypeOf('function'));

    // Feed consecutive 25fps LTC frames starting at 00:00:03:00 -> 00:00:03:02 (3.08s),
    // plus an edge sample to complete bit 79 of the last frame.
    let phase = 1;
    for (const frameNum of [0, 1, 2]) {
      vi.advanceTimersByTime(40);
      const enc = encodeSmpteBiphaseFrame(0, 0, 3, frameNum, 48000, 25, phase);
      phase = enc.endPhase;
      const buf =
        frameNum === 2
          ? Float32Array.from([...enc.samples, ...new Float32Array(24).fill(-phase * 0.8)])
          : enc.samples;
      capturedProc!.onaudioprocess!({
        inputBuffer: {
          numberOfChannels: 1,
          getChannelData: () => buf,
        },
      });
    }

    const lockNodes = collectNodes(hookRuntime.lastTree);
    const lockOutput = lockNodes.find((n) => n.type === 'output');
    expect(extractText(lockOutput)).toBe('00:00:03:02');
    expect(extractText(hookRuntime.lastTree)).toContain('Đã khóa (Lock)');
    const lockMoveCount = dispatched.filter((c) => c.type === 'move').length;
    expect(lockMoveCount).toBeGreaterThanOrEqual(1);
    const seek = lockNodes.find((n) => n.props['aria-label'] === 'Về cuối sóng');
    expect(seek?.props.disabled).toBe(true);
    (seek!.props.onClick as () => void)();
    expect(dispatched).toHaveLength(lockMoveCount);
    expect(extractText(collectNodes(hookRuntime.lastTree).find((n) => n.type === 'output'))).toBe('00:00:03:02');

    // Halt LTC audio and step through the 400ms (10 frames) freewheel window.
    const freewheelTimecodes: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      vi.advanceTimersByTime(35);
      const out = collectNodes(hookRuntime.lastTree).find((n) => n.type === 'output');
      freewheelTimecodes.push(extractText(out));
    }

    // Playhead must advance beyond locked frame 03:02 during freewheel and keep dispatching moves.
    expect(freewheelTimecodes.some((tc) => tc > '00:00:03:02')).toBe(true);
    const afterFreewheelMoves = dispatched.filter((c) => c.type === 'move').length;
    expect(useAppStore.getState().ltcReception.status).toBe('freewheel');
    expect(afterFreewheelMoves).toBeGreaterThan(lockMoveCount);
    expect(dispatched.filter((c) => c.type === 'stop')).toHaveLength(0);

    // Cross past freewheelFrames and hold only the module that LTC commanded.
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(35);
    }

    const lostNodes = collectNodes(hookRuntime.render());
    const lostOutputTc = extractText(lostNodes.find((n) => n.type === 'output'));
    expect(extractText(hookRuntime.lastTree)).toContain('Mất tín hiệu');
    // Capped at 3.08s + 0.40s = 3.48s (00:00:03:12), never drifting unboundedly after lost.
    expect(lostOutputTc).toBe('00:00:03:12');

    const stops = dispatched.filter((c) => c.type === 'stop');
    expect(stops).toEqual([{ type: 'stop', ids: [mod.id] }]);

    // A fresh incoming frame reacquires lock. Only the dedicated LTC button stops reception.
    capturedProc!.onaudioprocess!({ inputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(2048) } });
    for (const frameNum of [13, 14, 15, 16]) {
      vi.advanceTimersByTime(40);
      const enc = encodeSmpteBiphaseFrame(0, 0, 3, frameNum, 48000, 25, phase);
      phase = enc.endPhase;
      capturedProc!.onaudioprocess!({ inputBuffer: { numberOfChannels: 1, getChannelData: () => enc.samples } });
    }
    vi.advanceTimersByTime(40);
    expect(extractText(hookRuntime.render())).toContain('Đã khóa (Lock)');
    const stopLtc = collectNodes(hookRuntime.lastTree).find((n) => n.props['aria-label'] === 'Nhận timecode (LTC)');
    expect(stopLtc).toBeDefined();
    (stopLtc!.props.onClick as () => void)();
    hookRuntime.render();
    expect(dispatched.at(-1)).toEqual({ type: 'stop', ids: [mod.id] });
    const countAfterStop = dispatched.length;
    vi.advanceTimersByTime(500);
    expect(dispatched).toHaveLength(countAfterStop);
    expect(collectNodes(hookRuntime.lastTree).some((n) => n.props['aria-label'] === 'Phát')).toBe(true);

    // Clean unmount/cleanup verification.
    hookRuntime.reset();
    expect(trackStopSpy).toHaveBeenCalled();
  });

  it('keeps playhead and DMX moving forward through a keyframe when sequential LTC arrives late', async () => {
    const project = createDefaultProject();
    project.settings.timeline.fps = 60;
    project.settings.timeline.startTime = 1.5;
    project.settings.output.sendHz = 50;
    project.settings.ltc.fps = 25;
    project.settings.ltc.freewheelFrames = 10;
    project.settings.ltc.offsetFrames = 1;
    const mod = project.modules[0];
    project.clips = [{
      id: 'ltc-through-point', layerId: mod.layerId, moduleId: mod.id,
      startTime: 2, duration: 1, curveMode: 'linear',
      keyframes: [
        { id: 'p1', offset: 0, height: 0.1 },
        { id: 'p2', offset: 0.49, height: 0.3, speedMode: 'manual', manualSpeedCms: 20 },
        { id: 'p3', offset: 1, height: 0.5 },
      ],
    }];

    const notifySpy = vi.fn();
    const sendCommand = vi.fn<(command: Command) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    const observed: number[] = [];
    const setPlayheadTime = useAppStore.getState().setPlayheadTime;
    useAppStore.setState({
      project,
      selectedIds: [project.modules[0].id],
      snapshot: null,
      notify: notifySpy,
      sendCommand,
      setPlayheadTime: (time) => {
        observed.push(time);
        setPlayheadTime(time);
      },
    });

    let capturedProc: { onaudioprocess?: (ev: { inputBuffer: { numberOfChannels: number; getChannelData: (ch: number) => Float32Array } }) => void } | null = null;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
    vi.stubGlobal(
      'AudioContext',
      class FakeAudioContext {
        sampleRate = 48000;
        destination = {};
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
        createScriptProcessor() {
          capturedProc = {};
          return {
            connect: vi.fn(),
            set onaudioprocess(
              fn: (ev: { inputBuffer: { numberOfChannels: number; getChannelData: (ch: number) => Float32Array } }) => void,
            ) {
              capturedProc!.onaudioprocess = fn;
            },
          };
        }
        close = vi.fn(async () => {});
      },
    );

    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    const tree1 = hookRuntime.render();
    expect(extractText(tree1)).toContain('LTC 25fps');

    const ltcBtn = collectNodes(tree1).find(
      (n) => n.type === 'button' && String(n.props.title ?? '').includes('LTC'),
    );
    expect(ltcBtn).toBeDefined();
    (ltcBtn!.props.onClick as () => void)();
    hookRuntime.render();
    expect(notifySpy).not.toHaveBeenCalledWith(expect.stringContaining('60 fps'), 'warn');

    await vi.waitFor(() => expect(capturedProc?.onaudioprocess).toBeTypeOf('function'));

    let phase = 1;
    const feed = (second: number, frame: number, delay = 40) => {
      vi.advanceTimersByTime(delay);
      const enc = encodeSmpteBiphaseFrame(0, 0, second, frame, 48000, 25, phase);
      phase = enc.endPhase;
      capturedProc!.onaudioprocess!({
        inputBuffer: {
          numberOfChannels: 1,
          getChannelData: () => enc.samples,
        },
      });
    };
    // The final transition completing frame 09 arrives at the beginning of frame 10.
    for (const frame of [7, 8, 9, 10]) feed(2, frame);

    const out = collectNodes(hookRuntime.lastTree).find((n) => n.type === 'output');
    expect(extractText(out)).toBe('00:00:02:10');
    expect(observed.every((time, i) => i === 0 || time >= observed[i - 1])).toBe(true);

    // Delayed audio delivery crosses P2 in freewheel. The encoded LTC labels still increase by one frame.
    feed(2, 11, 120);
    vi.advanceTimersByTime(20);
    for (const frame of [12, 13, 14, 15]) feed(2, frame);
    const commands = sendCommand.mock.calls.map(([command]) => command);
    const targets = commands.flatMap((command) => command.type === 'move' ? [command.target] : []);
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
    expect(targets).toHaveLength(2);
    expect(targets[0]).toBeCloseTo(0.3, 2); // đích đã lượng tử hoá CH1 (1/255 m)
    expect(targets[1]).toBeCloseTo(0.5, 2);
    expect(commands.at(-1)).toMatchObject({ speed: { unit: 'cms', value: 20 } });

    // A real backward seek in the incoming labels must still move back to the beginning.
    feed(0, 0);
    feed(0, 1);
    expect(useAppStore.getState().playheadTime).toBeCloseTo(0.04);
    hookRuntime.reset();
  });

  it('switches the clock and clip snap to the LTC grid, then restores the saved Timeline FPS', () => {
    const saved = createDefaultProject();
    saved.settings.timeline.fps = 50;
    saved.settings.timeline.startTime = 1.092;
    saved.settings.output.sendHz = 60;
    delete saved.settings.ltc.fps;
    const project = normalizeProject(JSON.parse(JSON.stringify(saved)));
    const addClip = vi.fn<(clip: TimelineClip) => void>();
    useAppStore.setState({ project, addClip });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>(() => {}) },
    });

    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    const findNode = (type: string, ariaLabel?: string) =>
      collectNodes(hookRuntime.lastTree).find((node) =>
        node.type === type && (ariaLabel === undefined || node.props['aria-label'] === ariaLabel),
      );
    const dropAt = (seconds: number) => {
      const track = collectNodes(hookRuntime.lastTree).find((node) => typeof node.props.onDrop === 'function');
      const drop = track?.props.onDrop as (event: unknown) => void;
      drop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: seconds * 64,
        dataTransfer: { getData: () => project.modules[0].id },
        currentTarget: { getBoundingClientRect: () => ({ left: 0 }) },
      });
      return addClip.mock.lastCall?.[0].startTime;
    };
    hookRuntime.render();
    expect(findNode('select', 'Tốc độ khung hình')?.props).toMatchObject({ value: 50, disabled: false });
    expect(extractText(findNode('output'))).toBe('00:00:01:05');

    const ltcButton = collectNodes(hookRuntime.lastTree).find((node) =>
      node.type === 'button' && extractText(node) === 'Timecode',
    );
    (ltcButton!.props.onClick as () => void)();
    hookRuntime.render();
    expect(findNode('select', 'Tốc độ khung hình')?.props).toMatchObject({
      value: 30, disabled: true, title: 'Đang link theo LTC: 30 fps',
    });
    expect(extractText(findNode('output'))).toBe('00:00:01:03');
    expect(dropAt(0.026)).toBe(0.0333);

    const select25 = { ...project, settings: { ...project.settings, ltc: { ...project.settings.ltc, fps: 25 as const } } };
    useAppStore.setState({ project: select25 });
    hookRuntime.render();
    expect(findNode('select', 'Tốc độ khung hình')?.props).toMatchObject({ value: 25, disabled: true });
    expect(extractText(findNode('output'))).toBe('00:00:01:02');
    expect(dropAt(0.026)).toBe(0.04);

    (findNode('button', 'Nhận timecode (LTC)')!.props.onClick as () => void)();
    hookRuntime.render();
    expect(findNode('select', 'Tốc độ khung hình')?.props).toMatchObject({ value: 50, disabled: false });
    expect(extractText(findNode('output'))).toBe('00:00:01:05');
    expect(dropAt(0.026)).toBe(0.02);
    expect(useAppStore.getState().project).toBe(select25);
    expect(useAppStore.getState().project.settings.output.sendHz).toBe(60);
  });

  it.each([
    { dropFrame: false, firstFrame: 0, expected: '00:01:00:01' },
    { dropFrame: true, firstFrame: 2, expected: '00:01:00;03' },
  ])('displays 29.97 LTC numbering from the decoded DF bit ($dropFrame)', async ({ dropFrame, firstFrame, expected }) => {
    const project = createDefaultProject();
    project.settings.timeline.fps = 50;
    project.settings.ltc.fps = 29.97;
    project.clips = [{ ...project.clips![0], startTime: 60 }];
    useAppStore.setState({ project, sendCommand: async () => ({ ok: true }) });

    const processor: { connect: () => void; onaudioprocess?: (event: unknown) => void } = { connect: vi.fn() };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    vi.stubGlobal('AudioContext', class {
      sampleRate = 48000;
      destination = {};
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createScriptProcessor() { return processor; }
      close = vi.fn(async () => {});
    });

    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    const ltcButton = collectNodes(hookRuntime.render()).find((node) =>
      node.type === 'button' && extractText(node) === 'Timecode',
    );
    (ltcButton!.props.onClick as () => void)();
    hookRuntime.render();
    await vi.waitFor(() => expect(processor.onaudioprocess).toBeTypeOf('function'));

    let phase = 1;
    for (const frame of [firstFrame, firstFrame + 1, firstFrame + 2]) {
      vi.advanceTimersByTime(33);
      const encoded = encodeSmpteBiphaseFrame(0, 1, 0, frame, 48000, 29.97, phase, dropFrame);
      phase = encoded.endPhase;
      processor.onaudioprocess!({
        inputBuffer: { numberOfChannels: 1, getChannelData: () => encoded.samples },
      });
    }
    expect(useAppStore.getState().ltcDropFrame).toBe(dropFrame);
    expect(extractText(collectNodes(hookRuntime.lastTree).find((node) => node.type === 'output'))).toBe(expected);
    hookRuntime.reset();
    expect(useAppStore.getState().ltcActive).toBe(false);
  });

  it('accepts PCM after activating LTC through the shared store', async () => {
    const project = createDefaultProject();
    project.settings.ltc.fps = 25;
    useAppStore.setState({ project, sendCommand: async () => ({ ok: true }) });
    const input = mockPcmInput();
    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    hookRuntime.render();
    useAppStore.getState().setLtcActive(true);
    hookRuntime.render();
    await input.ready();
    input.feed(0, 3, [0, 1, 2]);
    expect(useAppStore.getState().playheadTime).toBeCloseTo(3.04);
    useAppStore.getState().setActiveTab('manual');
    expect(useAppStore.getState().ltcActive).toBe(false);
    input.feed(0, 3, [3, 4, 5]);
    expect(useAppStore.getState().playheadTime).toBeCloseTo(3.04);
  });

  it('follows absolute LTC past the editing ruler during lock and freewheel', async () => {
    const project = createDefaultProject();
    project.settings.ltc.fps = 25;
    project.settings.ltc.offsetFrames = 2;
    useAppStore.setState({ project, sendCommand: async () => ({ ok: true }) });
    const input = mockPcmInput();
    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    const toggle = collectNodes(hookRuntime.render()).find((node) => extractText(node) === 'Timecode' && node.type === 'button');
    (toggle!.props.onClick as () => void)();
    hookRuntime.render();
    await input.ready();
    input.feed(1, 0, [0, 1, 2]);
    expect(useAppStore.getState().playheadTime).toBeCloseTo(60.12);
    expect(extractText(collectNodes(hookRuntime.lastTree).find((node) => node.type === 'output'))).toBe('00:01:00:03');
    const marker = collectNodes(hookRuntime.lastTree).find((node) => String(node.props.className).startsWith('timeline-ruler-marker'));
    expect(marker?.props.title).toContain('ngoài vùng dựng');
    vi.advanceTimersByTime(125);
    expect(useAppStore.getState().playheadTime).toBeGreaterThan(60.12);
  });

  it('blocks local play, seek and ruler input while LTC owns the playhead, then restores local control', async () => {
    const project = createDefaultProject();
    project.settings.timeline.startTime = 1.2;
    project.settings.ltc.fps = 25;
    const sendCommand = vi.fn(async () => ({ ok: true }));
    useAppStore.setState({ project, sendCommand });
    const input = mockPcmInput();
    hookRuntime.component = () => TimelineEditor({}) as unknown as VNode;
    const find = (key: string, value: string) => collectNodes(hookRuntime.lastTree).find((node) => node.props[key] === value);
    const click = (node?: VNode) => {
      (node!.props.onClick as () => void)();
      hookRuntime.render();
    };
    hookRuntime.render();
    click(find('className', 'timeline-play'));
    vi.advanceTimersByTime(100);
    const localTime = useAppStore.getState().playheadTime;
    expect(localTime).toBeGreaterThan(1.2);
    click(collectNodes(hookRuntime.lastTree).find((node) => extractText(node) === 'Timecode' && node.type === 'button'));
    sendCommand.mockClear();
    await input.ready();
    click(find('className', 'timeline-play'));
    expect(useAppStore.getState().ltcActive).toBe(true);
    expect(find('className', 'timeline-play')?.props.disabled).toBe(true);
    click(find('aria-label', 'Mốc tiếp theo'));
    const ruler = collectNodes(hookRuntime.lastTree).find((node) => String(node.props.className).includes('cursor-ew-resize select-none'));
    const forbiddenRead = vi.fn(() => ({ left: 0 }));
    (ruler!.props.onPointerDown as (e: unknown) => void)({ clientX: 500, currentTarget: { getBoundingClientRect: forbiddenRead } });
    expect(forbiddenRead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(useAppStore.getState().playheadTime).toBe(localTime);
    expect(sendCommand).not.toHaveBeenCalled();

    input.feed(0, 2, [0, 1, 2]);
    const locked = useAppStore.getState().playheadTime;
    click(find('className', 'timeline-play'));
    click(find('aria-label', 'Về timecode bắt đầu'));
    input.feed(0, 2, [3, 4, 5]);
    expect(useAppStore.getState().playheadTime).toBeGreaterThan(locked);
    expect(sendCommand).toHaveBeenCalled();

    const held = useAppStore.getState().playheadTime;
    click(find('aria-label', 'Nhận timecode (LTC)'));
    expect(useAppStore.getState().ltcActive).toBe(false);
    expect(useAppStore.getState().playheadTime).toBe(held);
    click(find('aria-label', 'Về timecode bắt đầu'));
    expect(useAppStore.getState().playheadTime).toBe(1.2);
    click(find('className', 'timeline-play'));
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().playheadTime).toBeGreaterThan(1.2);
  });

  it('syncs the Settings switch with Timeline, reports permission denial, retries and releases late streams', async () => {
    const project = createDefaultProject();
    project.settings.timeline.fps = 50;
    project.settings.ltc.fps = 25;
    project.settings.ltc.offsetFrames = 2;
    useAppStore.setState({ project, activeTab: 'manual', notify: vi.fn(), sendCommand: async () => ({ ok: true }) });
    const track: TestTrack = { stop: vi.fn() };
    const lateTrack: TestTrack = { stop: vi.fn() };
    let resolveLate!: (stream: { getTracks: () => TestTrack[] }) => void;
    const lateStream = new Promise<{ getTracks: () => TestTrack[] }>((resolve) => { resolveLate = resolve; });
    const audio = mockLtcAudio(async () => ({ getTracks: () => [track] }));
    audio.getUserMedia
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce({ getTracks: () => [track] })
      .mockImplementationOnce(() => lateStream);

    hookRuntime.component = () => ({
      type: 'test',
      props: { children: [TimelineEditor({}), LtcSettingsPanel({ state: useAppStore.getState() })] },
    });
    const nodeWith = (key: string, value: unknown) => collectNodes(hookRuntime.lastTree).find((node) => node.props[key] === value);
    const click = (node?: VNode) => {
      (node!.props.onClick as () => void)();
      hookRuntime.render();
    };
    const timelineToggle = () => collectNodes(hookRuntime.lastTree).find((n) =>
      n.props['aria-label'] === 'Nhận timecode (LTC)' && 'aria-pressed' in n.props,
    );
    hookRuntime.render();
    expect(audio.getUserMedia).not.toHaveBeenCalled();
    expect(nodeWith('role', 'switch')?.props['aria-checked']).toBe(false);
    click(nodeWith('role', 'switch'));
    expect(useAppStore.getState().activeTab).toBe('timeline');
    expect(timelineToggle()?.props['aria-pressed']).toBe(true);
    expect(nodeWith('aria-label', 'Tốc độ khung hình')?.props).toMatchObject({ value: 25, disabled: true });
    await vi.waitFor(() => expect(useAppStore.getState().ltcReception.error).toContain('Chưa có quyền micrô'));
    hookRuntime.render();
    expect(extractText(nodeWith('role', 'alert'))).toContain('Chưa có quyền micrô');
    expect(extractText(hookRuntime.lastTree)).toContain('Mất tín hiệu');

    click(collectNodes(hookRuntime.lastTree).find((n) => n.type === 'button' && extractText(n) === 'Thử lại'));
    await vi.waitFor(() => expect(audio.processors[0]?.onaudioprocess).toBeTypeOf('function'));
    vi.advanceTimersByTime(200);
    expect(extractText(hookRuntime.render())).toContain('Đang chờ tín hiệu');
    let phase = 1;
    for (const frame of [0, 1, 2]) {
      vi.advanceTimersByTime(40);
      const encoded = encodeSmpteBiphaseFrame(0, 0, 3, frame, 48000, 25, phase);
      phase = encoded.endPhase;
      audio.processors[0].onaudioprocess!({ inputBuffer: { numberOfChannels: 1, getChannelData: () => encoded.samples } });
    }
    expect(extractText(hookRuntime.render())).toContain('Đã khóa (Lock)');
    expect(extractText(hookRuntime.lastTree)).toContain('00:00:03:01'); // Raw source, without the two-frame offset.
    expect(nodeWith('role', 'meter')?.props['aria-valuenow']).toBe(80);

    click(timelineToggle());
    expect(nodeWith('role', 'switch')?.props['aria-checked']).toBe(false);
    expect(nodeWith('aria-label', 'Tốc độ khung hình')?.props).toMatchObject({ value: 50, disabled: false });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ltcReception.status).toBe('off');

    click(timelineToggle());
    expect(nodeWith('role', 'switch')?.props['aria-checked']).toBe(true);
    click(nodeWith('role', 'switch'));
    expect(timelineToggle()?.props['aria-pressed']).toBe(false);
    resolveLate({ getTracks: () => [lateTrack] });
    await vi.waitFor(() => expect(lateTrack.stop).toHaveBeenCalledOnce());
    expect(audio.processors).toHaveLength(1);
  });

  it('shows a confident nominal FPS mismatch and holds the playhead across audio device replacement', async () => {
    const project = createDefaultProject();
    project.settings.timeline.fps = 25;
    const track: TestTrack = { stop: vi.fn() };
    const replacement: TestTrack = { stop: vi.fn() };
    const holdTimelineTargets = vi.fn();
    const audio = mockLtcAudio(async () => ({ getTracks: () => [replacement] }));
    audio.getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    useAppStore.setState({ project, holdTimelineTargets, notify: vi.fn(), sendCommand: async () => ({ ok: true }) });
    hookRuntime.component = () => ({
      type: 'test',
      props: { children: [TimelineEditor({}), LtcSettingsPanel({ state: useAppStore.getState() })] },
    });
    useAppStore.getState().setLtcActive(true);
    hookRuntime.render();
    await vi.waitFor(() => expect(audio.processors[0]?.onaudioprocess).toBeTypeOf('function'));
    let phase = 1;
    const feed = (input: number, second: number, frames: number[], fps: number) => {
      for (const frame of frames) {
        vi.advanceTimersByTime(40);
        const encoded = encodeSmpteBiphaseFrame(0, 0, second, frame, 48000, fps, phase);
        phase = encoded.endPhase;
        audio.processors[input].onaudioprocess!({ inputBuffer: { numberOfChannels: 1, getChannelData: () => encoded.samples } });
      }
    };
    feed(0, 3, Array.from({ length: 24 }, (_, i) => i), 24);
    feed(0, 4, [0, 1], 24);
    expect(useAppStore.getState().ltcReception.detectedFps).toBe(24);
    expect(extractText(hookRuntime.render())).toContain('Khác FPS đã chọn (25 fps)');
    const held = useAppStore.getState().playheadTime;

    useAppStore.setState({ project: { ...project, settings: { ...project.settings, ltc: { ...project.settings.ltc, deviceId: 'usb' } } } });
    hookRuntime.render();
    await vi.waitFor(() => expect(audio.processors[1]?.onaudioprocess).toBeTypeOf('function'));
    expect(audio.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'usb' } } });
    expect(track.stop).toHaveBeenCalledOnce();
    feed(1, 1, [0, 1, 2], 25);
    expect(useAppStore.getState().playheadTime).toBe(held);
    expect(useAppStore.getState().ltcReception).toMatchObject({ status: 'waiting', waitingForPosition: true });
    feed(1, 5, [0, 1, 2], 25);
    expect(useAppStore.getState().playheadTime).toBeGreaterThan(held);
    expect(useAppStore.getState().ltcReception.status).toBe('lock');
    replacement.onended!();
    expect(useAppStore.getState().ltcReception).toMatchObject({ status: 'lost', inputOpen: false });
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(holdTimelineTargets).toHaveBeenCalled();
  });
});

describe('Renderer numeric fields commit explicit edits', () => {
  const renderNumber = (field: VNode) => {
    const node = NumberField(field.props as unknown as Parameters<typeof NumberField>[0]) as unknown as VNode;
    return DraftInput(node.props as unknown as Parameters<typeof DraftInput<number>>[0]) as unknown as VNode;
  };
  const fieldInProperties = (container: string, select: (node: VNode) => boolean): VNode => {
    const panel = PropertiesPanel({}) as unknown as VNode;
    const section = collectNodes(panel).find((node) => typeof node.type === 'function' && node.type.name === container);
    const content = (section!.type as (props: VNode['props']) => VNode)(section!.props);
    const fields = collectNodes(content).filter((node) => node.type === NumberField);
    return renderNumber(fields.find(select)!);
  };
  const input = () => hookRuntime.lastTree!.props;
  const change = (value: string) => {
    (input().onChange as (event: unknown) => void)({ currentTarget: { value } });
  };
  const press = (key: string) => {
    (input().onKeyDown as (event: unknown) => void)({
      key, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    hookRuntime.render();
  };
  const blur = () => {
    (input().onBlur as () => void)();
    hookRuntime.render();
  };

  beforeEach(() => {
    hookRuntime.reset();
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    hookRuntime.reset();
    vi.restoreAllMocks();
  });

  it('selects all and holds empty, incomplete and decimal-comma edits until commit', () => {
    let saved = 6;
    const commit = vi.fn((value: number) => { saved = value; });
    hookRuntime.component = () => renderNumber({ type: NumberField, props: {
      value: saved, min: -10, max: 10, onCommit: commit,
    } });
    hookRuntime.render();
    const select = vi.fn();
    (input().onFocus as (event: unknown) => void)({ currentTarget: { select } });
    expect(select).toHaveBeenCalledOnce();

    for (const draft of ['', '-', '.', ',', '-3,', '-3,5']) {
      change(draft);
      expect(input().value).toBe(draft);
      expect(commit).not.toHaveBeenCalled();
    }
    press('Enter');
    blur();
    expect(commit.mock.calls).toEqual([[-3.5]]);
    expect(input().value).toBe('-3.5');

    change('90');
    expect(saved).toBe(-3.5);
    press('Enter');
    expect(saved).toBe(10);
    expect(input().value).toBe('10');

    change(',5');
    blur();
    expect(saved).toBe(0.5);
    for (const draft of ['', '-', 'abc']) {
      change(draft);
      press('Enter');
      expect(input().value).toBe('0.5');
    }
    change('2');
    press('Escape');
    blur();
    expect(input().value).toBe('0.5');
    expect(commit.mock.calls).toEqual([[-3.5], [10], [0.5]]);
  });

  it('stages a clamped CH2 monitor value on Enter without writing DMX or the project', () => {
    const project = createDefaultProject();
    const mod = project.modules[0];
    const command = vi.spyOn(getBridge(), 'command');
    useAppStore.setState({ project, selectedIds: [mod.id], selectedLayerId: null });
    // Select the second of the three editable channels by its position.
    function monitorField() {
      const panel = PropertiesPanel({}) as unknown as VNode;
      const monitor = collectNodes(panel).find((node) => typeof node.type === 'function' && node.type.name === 'ChannelMonitor')!;
      const tree = (monitor.type as (props: VNode['props']) => VNode)(monitor.props);
      const fields = collectNodes(tree).filter((node) => node.type === NumberField);
      expect(fields).toHaveLength(3);
      expect(extractText(tree)).toContain('CH4 Lock');
      return renderNumber(fields[1]);
    }
    hookRuntime.component = monitorField;
    hookRuntime.render();
    change('');
    expect(input().value).toBe('');
    change('800');
    expect(input().value).toBe('800');
    press('Enter');
    expect(input().value).toBe('255');
    expect(useAppStore.getState().project.modules[0].ch2Fine).toBe(mod.ch2Fine);
    expect(command).not.toHaveBeenCalled();
  });

  it('commits a moment point only on blur with the module height limit', () => {
    const project = createDefaultProject();
    const mod = project.modules[0];
    mod.minHeight = 0.1;
    mod.maxHeight = 0.8;
    const clip: TimelineClip = {
      id: 'draft-point', layerId: mod.layerId, moduleId: mod.id, startTime: 0, duration: 3, curveMode: 'linear',
      keyframes: [{ id: 'start', offset: 0, height: 0.2 }, { id: 'point', offset: 1.5, height: 0.4 }, { id: 'end', offset: 3, height: 0.6 }],
    };
    project.clips = [clip];
    const updateClip = vi.fn();
    useAppStore.setState({ project, selectedClipId: clip.id, selectedClipIds: [clip.id], updateClip });
    hookRuntime.component = () => fieldInProperties('MomentEditor', (node) =>
      String(node.props.title).startsWith('Độ cao (m)') && node.props.value === 0.4);
    hookRuntime.render();
    change('');
    change('3,7');
    expect(input().value).toBe('3,7');
    expect(updateClip).not.toHaveBeenCalled();
    blur();
    expect(updateClip).toHaveBeenCalledWith(clip.id, {
      keyframes: [clip.keyframes[0], { ...clip.keyframes[1], height: 0.8 }, clip.keyframes[2]],
    }, 'kfh-point', undefined);
  });

  it('commits the point speed as raw CH3 when the display unit is CH3', () => {
    const project = createDefaultProject();
    const mod = project.modules[0];
    mod.maxSpeedCms = 300;
    const clip: TimelineClip = {
      id: 'draft-ch3', layerId: mod.layerId, moduleId: mod.id, startTime: 0, duration: 3,
      speedMode: 'manual', speedUnit: 'cms', speedValue: 40, speedView: 'ch3',
      keyframes: [{ id: 'start', offset: 0, height: 0.2 }, { id: 'end', offset: 3, height: 0.6 }],
    };
    project.clips = [clip];
    const updateClip = vi.fn();
    useAppStore.setState({ project, selectedClipId: clip.id, selectedClipIds: [clip.id], updateClip });
    hookRuntime.component = () => fieldInProperties('MomentEditor', (node) => node.props['aria-label'] === 'CH3 tới P2');
    hookRuntime.render();
    change('');
    change('100');
    expect(input().value).toBe('100');
    expect(updateClip).not.toHaveBeenCalled();
    press('Enter');
    expect(updateClip).toHaveBeenCalledWith(clip.id, {
      speedMode: 'manual', speedUnit: 'ch3', speedValue: 100, speedView: 'ch3',
    }, 'momspd-draft-ch3', undefined);
  });

  it('commits a cue target in CH1 once and clamps it to the module range', () => {
    const project = createDefaultProject();
    const mod = project.modules[0];
    Object.assign(mod, { length: 2, minHeight: 0.2, maxHeight: 1.2 });
    const cue = { ...project.buttons[0], positionUnit: 'ch1' as const, steps: [{ moduleId: mod.id, position: 0.5 }] };
    project.buttons = [cue];
    const saveButton = vi.fn();
    useAppStore.setState({ project, focusScope: 'buttons', selectedButtonId: cue.id, saveButton });
    hookRuntime.component = () => fieldInProperties('CueButtonEditor', (node) => node.props['aria-label'] === `${mod.name} (CH1)`);
    hookRuntime.render();
    expect(input().value).toBe('64');
    change('');
    change('100');
    press('Escape');
    expect(input().value).toBe('64');
    expect(saveButton).not.toHaveBeenCalled();
    change('100');
    press('Enter');
    expect(saveButton).toHaveBeenLastCalledWith(expect.objectContaining({
      steps: [{ moduleId: mod.id, position: 100, unit: 'ch1' }],
    }), expect.any(String));
    change('255');
    blur();
    expect(saveButton).toHaveBeenLastCalledWith(expect.objectContaining({
      steps: [{ moduleId: mod.id, position: 153, unit: 'ch1' }],
    }), expect.any(String));
  });
});
