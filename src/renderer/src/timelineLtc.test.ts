import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '@shared/preset';
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
    AlertTriangle: icon('AlertTriangle'),
    ChevronDown: icon('ChevronDown'),
    ChevronLeft: icon('ChevronLeft'),
    ChevronRight: icon('ChevronRight'),
    Clock: icon('Clock'),
    Layers: icon('Layers'),
    Link2: icon('Link2'),
    Pause: icon('Pause'),
    Play: icon('Play'),
    Plus: icon('Plus'),
    Settings: icon('Settings'),
    SkipBack: icon('SkipBack'),
    SkipForward: icon('SkipForward'),
    WifiOff: icon('WifiOff'),
    ZoomIn: icon('ZoomIn'),
    ZoomOut: icon('ZoomOut'),
  };
});

import { TimelineEditor } from './components/TimelineEditor';
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
): { samples: Float32Array; endPhase: number } {
  const bits = new Array<number>(80).fill(0);
  writeBcdBits(bits, 0, f % 10, 4);
  writeBcdBits(bits, 8, Math.floor(f / 10), 2);
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

describe('TimelineEditor real LTC decode -> freewheel -> lost stop integration (Bug 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    hookRuntime.reset();

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

  it('decodes LTC audio, advances playhead & move commands through bounded freewheel, and sends exactly one stop(all) on lost', async () => {
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

    const dispatched: Command[] = [];
    const sendCommandSpy = vi.fn(async (cmd: Command) => {
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
      sendCommand: sendCommandSpy,
    });

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
    expect(extractText(hookRuntime.lastTree)).toContain('Live');
    const lockMoveCount = dispatched.filter((c) => c.type === 'move').length;
    expect(lockMoveCount).toBeGreaterThanOrEqual(1);

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
    expect(afterFreewheelMoves).toBeGreaterThan(lockMoveCount);
    expect(dispatched.filter((c) => c.type === 'stop')).toHaveLength(0);

    // Cross past freewheelFrames -> must transition to lost/disconnected and fire stop(all) ONCE.
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(35);
    }

    const lostNodes = collectNodes(hookRuntime.lastTree);
    const lostOutputTc = extractText(lostNodes.find((n) => n.type === 'output'));
    expect(extractText(hookRuntime.lastTree)).toContain('Mất kết nối');
    // Capped at 3.08s + 0.40s = 3.48s (00:00:03:12), never drifting unboundedly after lost.
    expect(lostOutputTc).toBe('00:00:03:12');

    const stops = dispatched.filter((c) => c.type === 'stop');
    expect(stops).toEqual([{ type: 'stop', ids: 'all' }]);

    // Clean unmount/cleanup verification.
    hookRuntime.reset();
    expect(trackStopSpy).toHaveBeenCalled();
  });
});
