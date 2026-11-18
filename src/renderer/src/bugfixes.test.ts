import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { computeManualMotionProgress, resolveCueButtonBaselines } from '@shared/convert';
import { createDefaultProject, normalizeProject } from '@shared/preset';
import { pickFirstVisibleHit } from '@shared/stage3d';
import { FPS_OPTIONS } from '@shared/timecode';
import type { TimelineClip } from '@shared/types';
import { PropertiesPanel } from './components/PropertiesPanel';
import { GauzeTree } from './components/GauzeTree';
import { KilnSelect } from './components/KilnSelect';
import { SettingsModal } from './components/SettingsModal';
import { ModeButtons, ModeManual } from './components/ControlDeck';
import { createWebBridge } from './services/bridge';
import { useAppStore } from './store/useAppStore';

interface FakeAnchorClick {
  href: string;
  download: string;
}

function setupBrowserEnv(opts?: {
  openFileContent?: string;
  openFileName?: string;
  canceledOpen?: boolean;
}) {
  const storage = new Map<string, string>();
  const downloads: FakeAnchorClick[] = [];
  const writtenChunks: string[] = [];
  let pickerError: Error | null = null;
  let writableCloseCalls = 0;

  const localStorageMock = {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, val: string) => {
      storage.set(key, String(val));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  };

  let createdBlobCount = 0;
  const revokeObjectURL = vi.fn();
  const createObjectURL = vi.fn(() => `blob:mock-${++createdBlobCount}`);

  const createElement = vi.fn((tag: string) => {
    const listeners: Record<string, Array<() => void>> = {};
    const fakeFile = {
      name: opts?.openFileName ?? 'imported.gauze',
      text: async () => opts?.openFileContent ?? '{}',
    };
    const el = {
      tagName: tag.toUpperCase(),
      type: '',
      accept: '',
      download: '',
      href: '',
      files: opts?.canceledOpen ? [] : [fakeFile],
      onchange: null as (() => void) | null,
      oncancel: null as (() => void) | null,
      addEventListener: (event: string, cb: () => void) => {
        (listeners[event] ??= []).push(cb);
      },
      click: vi.fn(() => {
        if (tag === 'a') {
          downloads.push({ href: el.href, download: el.download });
        } else if (tag === 'input') {
          queueMicrotask(() => {
            if (opts?.canceledOpen) {
              el.oncancel?.();
              for (const fn of listeners.cancel ?? []) fn();
            } else {
              el.onchange?.();
              for (const fn of listeners.change ?? []) fn();
            }
          });
        }
      }),
      remove: vi.fn(),
    };
    return el;
  });

  const bodyAppendChild = vi.fn();
  const windowObj: Record<string, unknown> = {
    localStorage: localStorageMock,
  };

  vi.stubGlobal('localStorage', localStorageMock);
  vi.stubGlobal('window', windowObj);
  vi.stubGlobal('document', {
    createElement,
    body: { appendChild: bodyAppendChild },
  });
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

  const installSavePicker = (fileName = 'picked.gauze') => {
    windowObj.showSaveFilePicker = vi.fn(async () => {
      if (pickerError) throw pickerError;
      return {
        name: fileName,
        createWritable: async () => {
          if (pickerError) throw pickerError;
          return {
            write: async (text: string) => {
              if (pickerError) throw pickerError;
              writtenChunks.push(text);
            },
            close: async () => {
              writableCloseCalls += 1;
            },
          };
        },
      };
    });
  };

  return {
    storage,
    downloads,
    writtenChunks,
    revokeObjectURL,
    snapshotStorage: () => Object.fromEntries(storage.entries()),
    installSavePicker,
    setPickerError: (err: Error | null) => {
      pickerError = err;
    },
    getWritableCloseCalls: () => writableCloseCalls,
  };
}

describe('Renderer & Web Bridge regression tests (Bugs 3, 6, 8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Bug 3: updateModule updates clip.layerId so moving layers preserves moments on old-layer removal', () => {
    vi.useFakeTimers();
    try {
      setupBrowserEnv();
      const base = createDefaultProject();
      const frontLayer = base.layers[0];
      const backLayer = base.layers[1];
      expect(frontLayer).toBeTruthy();
      expect(backLayer).toBeTruthy();

      const targetMod = base.modules.find((m) => m.layerId === frontLayer.id)!;
      const backMod = base.modules.find((m) => m.layerId === backLayer.id)!;
      expect(targetMod).toBeTruthy();
      expect(backMod).toBeTruthy();

      const movedClip: TimelineClip = {
        id: 'clip-move-repro',
        layerId: frontLayer.id,
        moduleId: targetMod.id,
        startTime: 1,
        duration: 5,
        curveMode: 'smooth',
        keyframes: [
          { id: 'kf-1', offset: 0, height: 0 },
          { id: 'kf-2', offset: 5, height: 1.8 },
        ],
      };

      useAppStore.setState({
        project: {
          ...base,
          layers: base.layers.map((l) => ({ ...l, syncLayer: false })),
          clips: [movedClip],
        },
        selectedIds: [targetMod.id],
        dirty: false,
        past: [],
        future: [],
      });

      useAppStore.getState().updateModule(targetMod.id, { layerId: backLayer.id });

      const afterMove = useAppStore.getState().project;
      expect(afterMove.modules.find((m) => m.id === targetMod.id)?.layerId).toBe(backLayer.id);
      expect(afterMove.clips?.find((c) => c.id === movedClip.id)?.layerId).toBe(backLayer.id);

      useAppStore.getState().removeLayer(frontLayer.id);

      const afterDeleteOldLayer = useAppStore.getState().project;
      expect(afterDeleteOldLayer.layers.some((l) => l.id === frontLayer.id)).toBe(false);
      const preserved = afterDeleteOldLayer.clips?.find((c) => c.id === movedClip.id);
      expect(preserved).toBeDefined();
      expect(preserved?.layerId).toBe(backLayer.id);
      expect(preserved?.moduleId).toBe(targetMod.id);

      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Bug 6: web bridge actually downloads or writes on repeated saves and rejects malformed imports without clobbering saved state', async () => {
    const project = createDefaultProject();
    project.modules[0].name = 'Saved Web Project';

    const env = setupBrowserEnv();
    const bridge = createWebBridge();

    // First and second fallback saves must BOTH trigger an actual download.
    const res1 = await bridge.saveProjectFile(project);
    expect(res1.saved).toBe(true);
    expect(env.downloads.length).toBe(1);

    project.modules[0].name = 'Edited Second Save';
    const res2 = await bridge.saveProjectFile(project);
    expect(res2.saved).toBe(true);
    expect(env.downloads.length).toBe(2);
    expect(env.downloads[1].download).toBe(res2.filePath);

    // Clear name and test File System Access handle repeated writes + honest error reporting.
    await bridge.clearCurrentFile();
    env.installSavePicker('show-cue.gauze');

    const picked = await bridge.saveProjectAs(project);
    expect(picked).toEqual({ saved: true, filePath: 'show-cue.gauze' });
    expect(env.writtenChunks.length).toBe(1);

    project.modules[0].name = 'Third Save Via Handle';
    const handleRes2 = await bridge.saveProjectFile(project);
    expect(handleRes2).toEqual({ saved: true, filePath: 'show-cue.gauze' });
    expect(env.writtenChunks.length).toBe(2);
    expect(env.writtenChunks[1]).toContain('Third Save Via Handle');
    expect(env.getWritableCloseCalls()).toBe(2);

    // Write failure must propagate so the store can show an error toast (not resolve quietly).
    env.setPickerError(new Error('Disk write failure'));
    await expect(bridge.saveProjectFile(project)).rejects.toThrow('Disk write failure');
    env.setPickerError(null);

    // AbortError in saveProjectAs must return { saved: false } while keeping or clearing active filename.
    const abortErr = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
    env.setPickerError(abortErr);
    const canceledSaveAs = await bridge.saveProjectAs(project);
    expect(canceledSaveAs).toEqual({ saved: false, filePath: 'show-cue.gauze' });
    await bridge.clearCurrentFile();
    const canceledAfterClear = await bridge.saveProjectAs(project);
    expect(canceledAfterClear).toEqual({ saved: false, filePath: null });
    env.setPickerError(null);

    // Malformed import via openProjectFile must reject and preserve existing localStorage state.
    await bridge.saveProject(project);
    const savedBefore = env.snapshotStorage();

    const envBadImport = setupBrowserEnv({
      openFileName: 'broken.gauze',
      openFileContent: '{"version":1,"layers":[],"modules":[]}',
    });
    for (const [k, v] of Object.entries(savedBefore)) {
      envBadImport.storage.set(k, v);
    }
    const bridgeBadImport = createWebBridge();
    await expect(bridgeBadImport.openProjectFile()).rejects.toThrow();
    expect(envBadImport.snapshotStorage()).toEqual(savedBefore);
  });

  it('Bug 8: pickFirstVisibleHit ignores hitboxes inside hidden layer/root groups while raw Raycaster includes them', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const rootFront = new THREE.Group();
    const layerFront = new THREE.Group();
    const hitboxFront = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 0.2),
      new THREE.MeshBasicMaterial(),
    );
    hitboxFront.position.set(0, 0, 2);
    layerFront.add(hitboxFront);
    rootFront.add(layerFront);
    scene.add(rootFront);

    const rootBack = new THREE.Group();
    const layerBack = new THREE.Group();
    const hitboxBack = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 0.2),
      new THREE.MeshBasicMaterial(),
    );
    hitboxBack.position.set(0, 0, -2);
    layerBack.add(hitboxBack);
    rootBack.add(layerBack);
    scene.add(rootBack);

    scene.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const targets = [hitboxFront, hitboxBack];

    // Visible front hitbox is picked first.
    const hitsAllVisible = raycaster.intersectObjects(targets, false);
    expect(hitsAllVisible[0].object).toBe(hitboxFront);
    expect(hitsAllVisible.some((h) => h.object === hitboxBack)).toBe(true);
    expect(pickFirstVisibleHit(hitsAllVisible)?.object).toBe(hitboxFront);

    // Hidden layer group: raw raycaster still returns hidden hitboxFront first, filter skips to hitboxBack.
    layerFront.visible = false;
    const hitsHiddenLayer = raycaster.intersectObjects(targets, false);
    expect(hitsHiddenLayer[0].object).toBe(hitboxFront);
    expect(pickFirstVisibleHit(hitsHiddenLayer)?.object).toBe(hitboxBack);

    // Hidden root group: raw raycaster still returns hidden hitboxFront first, filter skips to hitboxBack.
    layerFront.visible = true;
    rootFront.visible = false;
    const hitsHiddenRoot = raycaster.intersectObjects(targets, false);
    expect(hitsHiddenRoot[0].object).toBe(hitboxFront);
    expect(pickFirstVisibleHit(hitsHiddenRoot)?.object).toBe(hitboxBack);

    // Both hidden -> returns null.
    layerBack.visible = false;
    expect(pickFirstVisibleHit(hitsHiddenRoot)).toBeNull();
  });

  it('Layer motion presets use common forward base, preserve old clips untouched, resolve sync/loop conflicts, and follow mixed lengths accurately through store -> GauzeCore', async () => {
    vi.useFakeTimers();
    try {
      const { GauzeCore } = await import('@shared/core');
      const { MockDriver } = await import('@shared/drivers');
      const { buildTimelineFollowCommands } = await import('@shared/timeline');

      setupBrowserEnv();
      const base = createDefaultProject();
      const targetLayer = { ...base.layers[0], id: 'layer-a', syncLayer: true };
      const otherLayer = { ...base.layers[1], id: 'layer-b', syncLayer: false };
      const emptyLayer = { id: 'layer-empty', name: 'Empty', visible: true, syncLayer: false };

      const mLong = {
        ...base.modules[0],
        id: 'm-long',
        layerId: 'layer-a',
        length: 3.0,
        minHeight: 0,
        maxHeight: 3.0,
        dmxLoop: true,
        startAddress: 1,
      };
      const mShort = {
        ...base.modules[0],
        id: 'm-short',
        layerId: 'layer-a',
        length: 1.0,
        minHeight: 0,
        maxHeight: 1.0,
        dmxLoop: true,
        startAddress: 1,
      };
      const mOther = {
        ...base.modules[0],
        id: 'm-b1',
        layerId: 'layer-b',
        length: 4.0,
        minHeight: 0,
        maxHeight: 4.0,
        startAddress: 9,
      };

      // Existing [10..14] on m-long and future [20..22] on m-short with height 0.7 must BOTH remain untouched.
      const existingAtHead: TimelineClip = {
        id: 'existing-head',
        layerId: 'layer-a',
        moduleId: 'm-long',
        startTime: 10,
        duration: 4,
        curveMode: 'linear',
        keyframes: [
          { id: 'ek1', offset: 0, height: 0.2 },
          { id: 'ek2', offset: 4, height: 1.0 },
        ],
      };
      const existingFuture: TimelineClip = {
        id: 'existing-future',
        layerId: 'layer-a',
        moduleId: 'm-short',
        startTime: 20,
        duration: 2,
        curveMode: 'linear',
        keyframes: [
          { id: 'fk1', offset: 0, height: 0.7 },
          { id: 'fk2', offset: 2, height: 0.2 },
        ],
      };

      const { getBridge } = await import('./services/bridge');
      const core = new GauzeCore((_cfg, ev) => new MockDriver(ev));
      const commandsSeen: Array<{ type: string }> = [];
      const bridge = getBridge();
      const cmdSpy = vi.spyOn(bridge, 'command').mockImplementation(async (cmd) => {
        commandsSeen.push(cmd);
        return core.command(cmd);
      });

      useAppStore.setState({
        project: {
          ...base,
          layers: [targetLayer, otherLayer, emptyLayer],
          modules: [mLong, mShort, mOther],
          clips: [existingAtHead, existingFuture],
        },
        playheadTime: 10,
      });

      // Empty layer and invalid inputs do nothing cleanly.
      expect(useAppStore.getState().applyLayerMotionPreset('layer-empty', 'all-up')).toBe(0);
      expect(useAppStore.getState().applyLayerMotionPreset('layer-a', 'all-up', { duration: Number.NaN })).toBe(0);

      // Apply 'all-down' at playhead 10s with duration 4s:
      // 1) Common forward base moves BOTH m-long and m-short together to 14..18 (never backward to 6..10!).
      // 2) Old clips (existingAtHead & existingFuture height 0.7) remain 100% untouched.
      // 3) syncLayer & dmxLoop are resolved so mixed lengths reach independent targets (3m vs 1m).
      const countDown = useAppStore.getState().applyLayerMotionPreset('layer-a', 'all-down', { duration: 4 });
      expect(countDown).toBe(2);
      expect(commandsSeen).toEqual([]); // No immediate physical command on preset creation!

      const state = useAppStore.getState();
      expect(state.project.layers.find((l) => l.id === 'layer-a')?.syncLayer).toBe(false);
      expect(state.project.modules.find((m) => m.id === 'm-long')?.dmxLoop).toBe(false);
      expect(state.project.modules.find((m) => m.id === 'm-short')?.dmxLoop).toBe(false);

      const clips = state.project.clips ?? [];
      expect(clips.find((c) => c.id === 'existing-future')?.keyframes[0].height).toBe(0.7);
      expect(clips.find((c) => c.id === 'existing-head')?.keyframes).toEqual(existingAtHead.keyframes);

      const longDown = clips.find((c) => c.moduleId === 'm-long' && c.id !== 'existing-head')!;
      const shortDown = clips.find((c) => c.moduleId === 'm-short' && c.id !== 'existing-future')!;
      expect(longDown.startTime).toBe(14);
      expect(shortDown.startTime).toBe(14);
      expect(longDown.keyframes.map((k) => k.height)).toEqual([0, 3]);
      expect(shortDown.keyframes.map((k) => k.height)).toEqual([0, 1]);

      // Real follow -> store.sendCommand -> GauzeCore verification at end of all-down (t=18s):
      core.configure({
        modules: state.project.modules,
        output: state.project.settings.output,
        lockValue: state.project.settings.lockValue,
      });
      core.command({ type: 'lock', locked: false });
      const cmds = buildTimelineFollowCommands(state.project.modules, clips, [], 18, 0, core.snapshot());
      for (const cmd of cmds) {
        await useAppStore.getState().sendCommand(cmd, { quietWarnings: true });
      }
      const snap = core.snapshot();
      expect(snap.modules['m-long'].target).toBe(3);
      expect(snap.modules['m-short'].target).toBe(1);

      // Actual createWebBridge saveProject -> loadProject preserves old moments untouched (0.7 stays 0.7).
      await bridge.saveProject(state.project);
      const reloaded = await bridge.loadProject();
      expect(reloaded.project.clips?.find((c) => c.id === 'existing-future')?.keyframes[0].height).toBe(0.7);
      expect(reloaded.project.clips?.find((c) => c.id === 'existing-head')?.keyframes).toEqual(
        existingAtHead.keyframes,
      );

      cmdSpy.mockRestore();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Manual addressMode resolves valid dmxLoop to conflict-free addresses and atomically rejects when Universe 0 is full', async () => {
    vi.useFakeTimers();
    try {
      const { conflictMap, validateAddress } = await import('@shared/addressing');
      setupBrowserEnv();
      const base = createDefaultProject();
      const layerA = { ...base.layers[0], id: 'layer-a', syncLayer: false };
      const layerB = { ...base.layers[1], id: 'layer-b', syncLayer: false };
      const long3 = { ...base.modules[0], id: 'm-long', layerId: 'layer-a', length: 3, maxHeight: 3, startAddress: 1, dmxLoop: false };
      const short1 = { ...base.modules[0], id: 'm-short', layerId: 'layer-a', length: 1, maxHeight: 1, startAddress: 1, dmxLoop: true };
      const otherMod = { ...base.modules[0], id: 'm-other', layerId: 'layer-b', startAddress: 5, dmxLoop: false };

      const sendCommandSpy = vi.fn(async () => ({ ok: true }));
      const origManualSendCommand = useAppStore.getState().sendCommand;
      useAppStore.setState({
        project: {
          ...base,
          layers: [layerA, layerB],
          modules: [long3, short1, otherMod],
          clips: [],
          settings: { ...base.settings, addressMode: 'manual' },
        },
        playheadTime: 4,
        sendCommand: sendCommandSpy,
      });
      try {

      const created = useAppStore.getState().applyLayerMotionPreset('layer-a', 'wave', { duration: 4, staggerSec: 0.5 });
      expect(created).toBe(2);

      const afterManual = useAppStore.getState().project;
      expect(afterManual.modules.find((m) => m.id === 'm-long')?.startAddress).toBe(1);
      expect(afterManual.modules.find((m) => m.id === 'm-other')?.startAddress).toBe(5);
      expect(afterManual.modules.find((m) => m.id === 'm-short')?.startAddress).toBe(9);
      expect(afterManual.modules.find((m) => m.id === 'm-short')?.dmxLoop).toBe(false);
      expect(conflictMap(afterManual.modules).size).toBe(0);
      for (const m of afterManual.modules) {
        expect(validateAddress(afterManual.modules, m.id, m.startAddress)).toBeNull();
      }
      expect(sendCommandSpy).not.toHaveBeenCalled();

      // Now fill all 128 4-channel slots (1..509) across Universe 0 -> manual loop separation must reject atomically.
      const fullOtherMods = Array.from({ length: 127 }, (_, idx) => ({
        ...base.modules[0],
        id: `m-fill-${idx}`,
        layerId: 'layer-b',
        startAddress: 5 + idx * 4,
        dmxLoop: false,
      }));
      const fullModules = [
        { ...long3, startAddress: 1, dmxLoop: false },
        { ...short1, startAddress: 1, dmxLoop: true },
        ...fullOtherMods,
      ];
      useAppStore.setState({
        project: {
          ...base,
          layers: [layerA, layerB],
          modules: fullModules,
          clips: [],
          settings: { ...base.settings, addressMode: 'manual' },
        },
        playheadTime: 4,
        sendCommand: sendCommandSpy,
      });

      expect(useAppStore.getState().applyLayerMotionPreset('layer-a', 'wave')).toBe(0);
      const afterReject = useAppStore.getState().project;
      expect(afterReject.clips).toEqual([]);
      expect(afterReject.modules.find((m) => m.id === 'm-short')?.dmxLoop).toBe(true);
      expect(afterReject.modules.find((m) => m.id === 'm-short')?.startAddress).toBe(1);
      expect(sendCommandSpy).not.toHaveBeenCalled();

      vi.clearAllTimers();
      } finally {
        useAppStore.setState({ sendCommand: origManualSendCommand });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('Marquee multi-clip selection and atomic group wave preset preserve timings, per-module limits, unselected clips, and undo history', async () => {
    vi.useFakeTimers();
    try {
      const { computeMarqueeSelectedClipIds } = await import('@shared/timeline');
      setupBrowserEnv();

      // Marquee intersection across lanes & reverse drag direction (bottom-right -> top-left)
      const rects = [
        { id: 'c1', left: 100, top: 40, right: 200, bottom: 80 },
        { id: 'c2', left: 150, top: 100, right: 250, bottom: 140 },
        { id: 'c-out', left: 320, top: 40, right: 420, bottom: 80 },
      ];
      expect(computeMarqueeSelectedClipIds(rects, { x1: 220, y1: 120, x2: 120, y2: 60 })).toEqual(['c1', 'c2']);

      const base = createDefaultProject();
      const layerA = { ...base.layers[0], id: 'layer-a', syncLayer: false };
      const mLong = { ...base.modules[0], id: 'm-long', layerId: 'layer-a', length: 3, minHeight: 0.2, maxHeight: 2.5, startAddress: 1 };
      const mShort = { ...base.modules[0], id: 'm-short', layerId: 'layer-a', length: 1.4, minHeight: 0.1, maxHeight: 2.0, startAddress: 5 };

      const clip1: TimelineClip = {
        id: 'c1',
        layerId: 'layer-a',
        moduleId: 'm-long',
        startTime: 1,
        duration: 4,
        curveMode: 'linear',
        keyframes: [
          { id: 'k1', offset: 0, height: 0.2 },
          { id: 'k2', offset: 4, height: 0.2 },
        ],
      };
      const clip2: TimelineClip = {
        id: 'c2',
        layerId: 'layer-a',
        moduleId: 'm-short',
        startTime: 2.5,
        duration: 6,
        curveMode: 'smooth',
        keyframes: [
          { id: 'k3', offset: 0, height: 0.1 },
          { id: 'k4', offset: 6, height: 0.1 },
        ],
      };
      const clipUnselected: TimelineClip = {
        id: 'c-unselected',
        layerId: 'layer-a',
        moduleId: 'm-long',
        startTime: 10,
        duration: 3,
        curveMode: 'linear',
        keyframes: [
          { id: 'k5', offset: 0, height: 0.2 },
          { id: 'k6', offset: 3, height: 1.9 },
        ],
      };

      const origSendCommand = useAppStore.getState().sendCommand;
      const sendCommandSpy = vi.fn(async () => ({ ok: true }));
      useAppStore.setState({
        project: {
          ...base,
          layers: [layerA],
          modules: [mLong, mShort],
          clips: [clip1, clip2, clipUnselected],
        },
        past: [],
        future: [],
        selectedClipId: null,
        selectedClipIds: [],
        sendCommand: sendCommandSpy,
      });
      try {

      useAppStore.getState().selectTimelineClips(['c1', 'c2']);
      expect(useAppStore.getState().selectedClipIds).toEqual(['c1', 'c2']);

      // Apply 'sine' wave preset atomically across both selected clips
      const applied = useAppStore.getState().applyPresetToSelectedClips({ presetId: 'sine' });
      expect(applied).toBe(true);
      expect(sendCommandSpy).not.toHaveBeenCalled();

      const after = useAppStore.getState();
      expect(after.past).toHaveLength(1); // single undo transaction
      const nextClips = after.project.clips ?? [];
      expect(nextClips.map((c) => c.id)).toEqual(['c1', 'c2', 'c-unselected']);

      const next1 = nextClips.find((c) => c.id === 'c1')!;
      const next2 = nextClips.find((c) => c.id === 'c2')!;
      const nextUn = nextClips.find((c) => c.id === 'c-unselected')!;

      // Preserves individual startTime, duration, moduleId, and scales 0-100% per module's own [lo, hi]
      expect(next1.startTime).toBe(1);
      expect(next1.duration).toBe(4);
      expect(Math.max(...next1.keyframes.map((k) => k.height))).toBeCloseTo(2.5, 2);

      expect(next2.startTime).toBe(2.5);
      expect(next2.duration).toBe(6);
      expect(Math.max(...next2.keyframes.map((k) => k.height))).toBeCloseTo(1.4, 2); // clamped to mShort.length=1.4!

      // Unselected clip untouched
      expect(nextUn).toEqual(clipUnselected);

      // Deleting c1 prunes selectedClipIds cleanly
      useAppStore.getState().deleteClip('c1');
      expect(useAppStore.getState().selectedClipIds).toEqual(['c2']);

      // Selecting another module or layer clears multi-clip selection so PropertiesPanel switches cleanly
      useAppStore.getState().selectTimelineClips(['c2', 'c-unselected']);
      expect(useAppStore.getState().selectedClipIds).toEqual(['c2', 'c-unselected']);
      useAppStore.getState().selectModule('m-short');
      expect(useAppStore.getState().selectedClipId).toBeNull();
      expect(useAppStore.getState().selectedClipIds).toEqual([]);
      useAppStore.getState().selectTimelineClips(['c2', 'c-unselected']);
      useAppStore.getState().selectLayer('layer-a');
      expect(useAppStore.getState().selectedClipIds).toEqual([]);

      // Group timing edit (endTime) + atomic overlap rejection + Delete multi-selection in 1 undo step
      const g1: TimelineClip = {
        id: 'g1',
        layerId: 'layer-a',
        moduleId: 'm-long',
        startTime: 1,
        duration: 2,
        curveMode: 'linear',
        keyframes: [
          { id: 'gk1', offset: 0, height: 0.2 },
          { id: 'gk2', offset: 2, height: 1.5 },
        ],
      };
      const g2: TimelineClip = {
        id: 'g2',
        layerId: 'layer-a',
        moduleId: 'm-short',
        startTime: 2,
        duration: 2,
        curveMode: 'smooth',
        keyframes: [
          { id: 'gk3', offset: 0, height: 0.1 },
          { id: 'gk4', offset: 2, height: 1.0 },
        ],
      };
      const blocker: TimelineClip = {
        id: 'g-blocker',
        layerId: 'layer-a',
        moduleId: 'm-long',
        startTime: 6,
        duration: 2,
        curveMode: 'linear',
        keyframes: [
          { id: 'gk5', offset: 0, height: 0.2 },
          { id: 'gk6', offset: 2, height: 0.2 },
        ],
      };
      useAppStore.setState({
        project: {
          ...base,
          layers: [layerA],
          modules: [mLong, mShort],
          clips: [g1, g2, blocker],
        },
        past: [],
        future: [],
      });
      useAppStore.getState().selectTimelineClips(['g1', 'g2']);

      // Infeasible group endTime=7 collides with g-blocker [6..8] on m-long -> rejects atomically, leaving g2 untouched!
      expect(useAppStore.getState().updateSelectedClipsTiming({ endTime: 7 })).toBe(false);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 'g2')?.duration).toBe(2);

      // Feasible group endTime=5 updates g1 (dur 4, start 1) and g2 (dur 3, start 2) in 1 undo step.
      expect(useAppStore.getState().updateSelectedClipsTiming({ endTime: 5 })).toBe(true);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 'g1')?.duration).toBe(4);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 'g2')?.duration).toBe(3);

      // Delete multi-selection via deleteSelection deletes both g1 and g2 in 1 undo step and preserves blocker.
      useAppStore.getState().deleteSelection();
      expect(useAppStore.getState().project.clips?.map((c) => c.id)).toEqual(['g-blocker']);
      expect(useAppStore.getState().selectedClipIds).toEqual([]);
      useAppStore.getState().undo();
      expect(useAppStore.getState().project.clips?.map((c) => c.id)).toEqual(['g1', 'g2', 'g-blocker']);

      // toggleLayerSync uses the currently selected module in that layer as sync source.
      useAppStore.setState({
        project: {
          ...base,
          layers: [layerA],
          modules: [mLong, mShort],
          clips: [g1, g2],
        },
        selectedIds: ['m-short'],
      });
      useAppStore.getState().toggleLayerSync('layer-a');
      const syncedShort = (useAppStore.getState().project.clips ?? []).filter((c) => c.moduleId === 'm-short');
      const syncedLong = (useAppStore.getState().project.clips ?? []).filter((c) => c.moduleId === 'm-long');
      expect(syncedShort[0].startTime).toBe(2); // m-short kept its own startTime=2 as source!
      expect(syncedLong[0].startTime).toBe(2); // m-long mirrored m-short's startTime=2!

      // Multi-clip synchronized left/right drag: preserves relative spacing, clamps at 0 & unselected collision, 1 undo step.
      const s1: TimelineClip = { ...g1, id: 's1', moduleId: 'm-long', startTime: 2, duration: 2 };
      const s2: TimelineClip = { ...g2, id: 's2', moduleId: 'm-short', startTime: 5, duration: 2 };
      const sWall: TimelineClip = { ...blocker, id: 's-wall', moduleId: 'm-short', startTime: 9, duration: 2 };
      useAppStore.setState({
        project: {
          ...base,
          layers: [layerA],
          modules: [mLong, mShort],
          clips: [s1, s2, sWall],
        },
        past: [],
        future: [],
      });
      useAppStore.getState().selectTimelineClips(['s1', 's2']);
      const origStarts = new Map([
        ['s1', 2],
        ['s2', 5],
      ]);

      // Drag left by -5s -> clamped at -2s because s1 is at 2s (0 boundary), keeping relative 3s gap!
      expect(useAppStore.getState().moveSelectedClipsByDelta(origStarts, -5, 'multi-drag-1')).toBe(-2);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 's1')?.startTime).toBe(0);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 's2')?.startTime).toBe(3);

      // Drag right by +4s -> clamped at +2s because s2 [5..7] hits sWall [9..11] at delta +2s!
      expect(useAppStore.getState().moveSelectedClipsByDelta(origStarts, 4, 'multi-drag-1')).toBe(2);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 's1')?.startTime).toBe(4);
      expect(useAppStore.getState().project.clips?.find((c) => c.id === 's2')?.startTime).toBe(7);
      expect(useAppStore.getState().past).toHaveLength(1); // single undo transaction for entire drag!

      vi.clearAllTimers();
      } finally {
        useAppStore.setState({ sendCommand: origSendCommand });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('Notification settings filter kinds, respect enable/duration/dedup, dismiss cleanly, and react to E-Stop/Save events', async () => {
    vi.useFakeTimers();
    try {
      const env = setupBrowserEnv();
      useAppStore.setState({
        toast: null,
        notificationSettings: {
          enabled: true,
          durationMs: 2000,
          kinds: { info: true, success: true, warn: true, error: true },
        },
      });

      // Notify emits structured title + text + semantic icon and auto-hides after configured durationMs.
      useAppStore.getState().notify('Cảnh báo test', 'warn', { title: 'Giới hạn', icon: 'warn' });
      expect(useAppStore.getState().toast).toMatchObject({
        title: 'Giới hạn',
        text: 'Cảnh báo test',
        kind: 'warn',
        icon: 'warn',
      });
      vi.advanceTimersByTime(2000);
      expect(useAppStore.getState().toast).toBeNull();

      // Dedup suppresses identical consecutive toast within 800ms; dismissToast clears immediately.
      useAppStore.getState().notify('Same msg', 'info', { title: 'T' });
      const firstId = useAppStore.getState().toast?.id;
      vi.advanceTimersByTime(100);
      useAppStore.getState().notify('Same msg', 'info', { title: 'T' });
      expect(useAppStore.getState().toast?.id).toBe(firstId);
      useAppStore.getState().dismissToast();
      expect(useAppStore.getState().toast).toBeNull();

      // Per-kind filter & global toggle + localStorage persistence.
      useAppStore.getState().updateNotificationSettings({ kinds: { info: false, success: true, warn: true, error: true } });
      expect(env.storage.get('dmx-gauze-notifications-v1')).toContain('"info":false');
      useAppStore.getState().notify('Suppressed info', 'info');
      expect(useAppStore.getState().toast).toBeNull();

      useAppStore.getState().updateNotificationSettings({ enabled: false });
      useAppStore.getState().notify('Suppressed error', 'error');
      expect(useAppStore.getState().toast).toBeNull();

      // Re-enable and verify E-Stop command emits estop icon/error notification.
      const { getBridge } = await import('./services/bridge');
      vi.spyOn(getBridge(), 'command').mockResolvedValueOnce({ ok: true });
      useAppStore.getState().updateNotificationSettings({ enabled: true });
      expect(useAppStore.getState().notificationSettings).toEqual({
        enabled: true,
        durationMs: 2000,
        kinds: { info: false, success: true, warn: true, error: true },
      });
      const estopRes = await useAppStore.getState().sendCommand({ type: 'estop' });
      expect(estopRes).toEqual({ ok: true });
      expect(useAppStore.getState().toast).toMatchObject({
        kind: 'error',
        icon: 'estop',
        title: 'E-Stop kích hoạt',
      });

      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updateModulesBatch updates transform, sizes, layer, unique names in 1 undo and rejects colliding/overflow DMX addresses atomically', () => {
    setupBrowserEnv();
    const project = createDefaultProject();
    project.settings.addressMode = 'manual';
    const [m1, m2, m3] = project.modules;
    m1.startAddress = 1;
    m2.startAddress = 5;
    m3.startAddress = 25;
    m1.minHeight = 0.2;
    m2.minHeight = 0.8;
    const clipForM1: TimelineClip = {
      id: 'clip-m1',
      moduleId: m1.id,
      layerId: m1.layerId,
      startTime: 1,
      duration: 2,
      curveMode: 'smooth',
      keyframes: [
        { id: 'k1', offset: 0, height: 0.5 },
        { id: 'k2', offset: 2, height: 1.5 },
      ],
    };
    project.clips = [clipForM1];
    useAppStore.setState({ project, past: [], future: [] });

    // Batch update sizes, maxSpeedCms, defaultSpeed, transform (Y stays locked to 0), unique names, and layerId in 1 undo step.
    const err1 = useAppStore.getState().updateModulesBatch([m1.id, m2.id], {
      nameBase: 'Cánh',
      maxSpeedCms: 140,
      defaultSpeed: 180,
      transformAxis: { field: 'position', index: 0, value: 2.5 },
    });
    expect(err1).toBeNull();
    let mods = useAppStore.getState().project.modules;
    expect(mods[0].name).toBe('Cánh 1');
    expect(mods[1].name).toBe('Cánh 2');
    expect(mods[0].maxSpeedCms).toBe(140);
    expect(mods[1].maxSpeedCms).toBe(140);
    expect(mods[0].defaultSpeed).toBe(180);
    expect(mods[1].defaultSpeed).toBe(180);
    expect(mods[0].transform?.position).toEqual([2.5, 0, mods[0].transform?.position[2]]);
    expect(mods[1].transform?.position).toEqual([2.5, 0, mods[1].transform?.position[2]]);
    expect(useAppStore.getState().past.length).toBe(1);

    // Atomic rejection on colliding DMX address (m3 occupies 25..28, so base=21 puts m2 at 25..28 -> conflict)
    const beforeSnapshot = useAppStore.getState().project;
    const conflictErr = useAppStore.getState().updateModulesBatch([m1.id, m2.id], { startAddressBase: 21 });
    expect(conflictErr).toBeTruthy();
    expect(useAppStore.getState().project).toBe(beforeSnapshot);
    expect(useAppStore.getState().past.length).toBe(1);

    // Atomic rejection on >512 capacity (base=509 puts m2 at 513 -> overflow)
    const capErr = useAppStore.getState().updateModulesBatch([m1.id, m2.id], { startAddressBase: 509 });
    expect(capErr).toBeTruthy();
    expect(useAppStore.getState().project).toBe(beforeSnapshot);

    // Valid sequential DMX assignment succeeds atomically (401..408 avoids all 24 default modules)
    const okAddrErr = useAppStore.getState().updateModulesBatch([m1.id, m2.id], { startAddressBase: 401 });
    expect(okAddrErr).toBeNull();
    mods = useAppStore.getState().project.modules;
    expect(mods[0].startAddress).toBe(401);
    expect(mods[1].startAddress).toBe(405);

    // Undo reverts the DMX change cleanly in 1 step, and a second undo reverts the whole first batch
    useAppStore.getState().undo();
    expect(useAppStore.getState().project.modules[0].startAddress).toBe(1);
    expect(useAppStore.getState().project.modules[1].startAddress).toBe(5);
    useAppStore.getState().undo();
    expect(useAppStore.getState().project.modules[0].name).toBe(m1.name);
    expect(useAppStore.getState().project.modules[1].name).toBe(m2.name);
  });

  it('PropertiesPanel renders em-dash (—) for differing values in multi-select Moment and Module views', () => {
    setupBrowserEnv();
    const project = createDefaultProject();
    const [m1, m2] = project.modules;
    m1.minHeight = 0.1;
    m2.minHeight = 0.9;
    m1.startAddress = 1;
    m2.startAddress = 5;
    project.clips = [
      {
        id: 'c1',
        moduleId: m1.id,
        layerId: m1.layerId,
        startTime: 0,
        duration: 2,
        curveMode: 'smooth',
        keyframes: [
          { id: 'k1', offset: 0, height: 0.2 },
          { id: 'k2', offset: 2, height: 1.0 },
        ],
      },
      {
        id: 'c2',
        moduleId: m2.id,
        layerId: m2.layerId,
        startTime: 1,
        duration: 3,
        curveMode: 'linear',
        keyframes: [
          { id: 'k3', offset: 0, height: 0.2 },
          { id: 'k4', offset: 3, height: 1.2 },
        ],
      },
    ];

    // Multi-select Moment view shows — (never 'mixed') and includes speed summary + 7 presets
    useAppStore.setState({
      project,
      selectedClipIds: ['c1', 'c2'],
      selectedClipId: 'c1',
      selectedIds: [],
      selectedLayerId: null,
    });
    const momentHtml = renderToStaticMarkup(
      React.createElement(PropertiesPanel, { overrideState: useAppStore.getState() }),
    );
    expect(momentHtml).toContain('Đang chọn 2 moment');
    expect(momentHtml).toContain('placeholder="—"');
    expect(momentHtml).toContain('Độ dài: —');
    expect(momentHtml).not.toContain('mixed');

    // Multi-select Module view shows full parity fields & — for differing values
    useAppStore.setState({
      project,
      selectedClipIds: [],
      selectedClipId: null,
      selectedIds: [m1.id, m2.id],
      selectedLayerId: null,
    });
    const modHtml = renderToStaticMarkup(
      React.createElement(PropertiesPanel, { overrideState: useAppStore.getState() }),
    );
    expect(modHtml).toContain('Đang chọn 2 module');
    expect(modHtml).toContain('Transform 3D');
    expect(modHtml).toContain('Y dính vào Layer');
    expect(modHtml).toContain('Giám sát 4 kênh DMX');
    expect(modHtml).toContain('Kênh —');
    expect(modHtml).toContain('placeholder="—"');
  });

  it('GauzeTree toggles Chọn hết -> Bỏ chọn hết, SettingsModal omits Dự án & Preset, and ModeManual renders wave cards', () => {
    setupBrowserEnv();
    const project = createDefaultProject();

    useAppStore.setState({ project, selectedIds: [project.modules[0].id] });
    const treePartialHtml = renderToStaticMarkup(
      React.createElement(GauzeTree, { overrideState: useAppStore.getState() }),
    );
    expect(treePartialHtml).toContain(`Chọn hết (${project.modules.length})`);
    expect(treePartialHtml).not.toContain('Bỏ chọn hết');

    useAppStore.getState().selectAll();
    expect(useAppStore.getState().selectedIds).toHaveLength(project.modules.length);
    const treeAllHtml = renderToStaticMarkup(
      React.createElement(GauzeTree, { overrideState: useAppStore.getState() }),
    );
    expect(treeAllHtml).toContain('Bỏ chọn hết');

    useAppStore.getState().deselectAll();
    expect(useAppStore.getState().selectedIds).toEqual([]);

    useAppStore.setState({ project, settingsOpen: true, settingsTab: 'network' });
    const settingsHtml = renderToStaticMarkup(
      React.createElement(SettingsModal, { overrideState: useAppStore.getState() }),
    );
    expect(settingsHtml).toContain('Thông báo');
    expect(settingsHtml).not.toContain('Dự án &amp; Preset');
    expect(settingsHtml).not.toContain('Dự án & Preset');

    const stoppedSnap = {
      t: 0,
      frame: new Array(512).fill(0),
      status: {
        state: 'online' as const,
        driver: 'mock' as const,
        ip: '127.0.0.1',
        port: 6454,
        portAddress: 0,
        sendHz: 25,
        nodes: [],
        message: null,
        warning: null,
      },
      locked: false,
      modules: {
        [project.modules[0].id]: {
          pos:
            0.38 * Math.min(project.modules[0].length, project.modules[0].maxHeight) +
            0.62 * project.modules[0].minHeight,
          target: project.modules[0].minHeight,
          ch3: 100,
          moving: false,
        },
      },
    };
    useAppStore.setState({ project, selectedIds: [project.modules[0].id], snapshot: stoppedSnap });
    const manualHtml = renderToStaticMarkup(
      React.createElement(ModeManual, { overrideState: useAppStore.getState() }),
    );
    expect(manualHtml).toContain('manual-card-up');
    expect(manualHtml).toContain('manual-card-stop');
    expect(manualHtml).toContain('manual-card-down');
    expect(manualHtml).toContain('Chạm để chạy lên');
    expect(manualHtml).toContain('Dừng module chọn');
    expect(manualHtml).toContain('Chạm để chạy xuống');
    expect(manualHtml).toContain('manual-wave-fill-body');
    // Cả 3 nút đều chia sẻ cùng 1 data-wave-pct="62" khi đang dừng giữa chừng
    const pctMatches = manualHtml.match(/data-wave-pct="62"/g) ?? [];
    expect(pctMatches).toHaveLength(3);
  });

  it('ModeButtons renders 4-col Cue Pad grid and CueButton layer/module editing moves to PropertiesPanel', () => {
    setupBrowserEnv();
    const project = createDefaultProject();
    project.buttons[0] = { ...project.buttons[0], loop: true, slotIndex: 0 };

    const modId = project.buttons[0].steps[0].moduleId;
    useAppStore.setState({
      project,
      activeTab: 'buttons',
      focusScope: 'buttons',
      selectedButtonId: project.buttons[1]?.id ?? project.buttons[0].id,
      lastFiredButtonId: project.buttons[0].id,
      lastFiredButtonBaselines: { [modId]: { start: 0, goal: 1 } },
      snapshot: {
        t: Date.now(),
        locked: false,
        frame: [],
        modules: { [modId]: { pos: 0.65, target: 1, ch3: 100, moving: true } },
        status: { state: 'idle', driver: 'mock', ip: '', port: 6454, portAddress: 0, sendHz: 0, nodes: [], message: null, warning: null },
      },
    });

    const customHtml = renderToStaticMarkup(
      React.createElement(ModeButtons, { overrideState: useAppStore.getState() }),
    );
    expect(customHtml).toContain('cue-pad-slot');
    // Cue cũ đang chạy giữ viền xanh + body xanh đậm nhưng bar xanh tối hơn (cue-pad-prev)
    expect(customHtml).toContain('cue-pad group active cue-pad-prev');
    // Slider bar chiều cao bằng nền text module (role="progressbar" bọc dải footer MODULES) & chạy theo tiến trình thực tế (65%)
    expect(customHtml).toContain('role="progressbar"');
    expect(customHtml).toContain('data-cue-progress="65"');
    // Hình vuông trước tên cue đổi thành nút Play / Pause
    expect(customHtml).toContain(`Tạm dừng ${project.buttons[0].name}`);
    expect(customHtml).toContain(`Phát ${project.buttons[1].name}`);
    // Cue được click vào bar chỉ sáng bar (bar-selected), không ảnh hưởng body (không có active)
    expect(customHtml).toContain('cue-pad group bar-selected');
    // Bar có draggable để kéo thả đổi vị trí
    expect(customHtml).toContain('draggable="true"');
    // Ô trống không có nút tạo cue khi ấn vào
    expect(customHtml).toContain('cue-pad cue-pad-empty');
    expect(customHtml).not.toContain('Tạo nút Cue ở ô');
    expect(customHtml).toContain('Tạo Cue');
    expect(customHtml).toContain(`${project.buttons[0].steps.length} MODULES`);
    expect(customHtml).toContain('4S');
    // Không còn chỉnh Layer/Module ở ControlDeck (panel timeline/custom) nữa
    expect(customHtml).not.toContain('Cả layer (m):');

    // Kéo thả bar sang ô cue khác để đổi vị trí (swap hoặc chuyển sang ô trống)
    useAppStore.getState().moveButtonToSlot(project.buttons[0].id, 2);
    const swapped = useAppStore.getState().project.buttons;
    expect(swapped.find((b) => b.id === project.buttons[0].id)?.slotIndex).toBe(2);
    expect(swapped.find((b) => b.id === project.buttons[2]?.id)?.slotIndex).toBe(0);
    useAppStore.getState().moveButtonToSlot(project.buttons[0].id, 7);
    expect(
      useAppStore.getState().project.buttons.find((b) => b.id === project.buttons[0].id)?.slotIndex,
    ).toBe(7);

    // Pause rồi ấn Play lại: giữ nguyên mốc start ban đầu để slider chạy tiếp từ % đang dừng (không nhảy về 0%)
    const steps = [{ moduleId: modId, position: 1 }];
    const initialBaselines = resolveCueButtonBaselines(
      steps,
      project.modules,
      { modules: { [modId]: { pos: 0, target: 0, ch3: 100, moving: false } } },
      null,
    );
    const pausedSnap = { modules: { [modId]: { pos: 0.45, target: 0.45, ch3: 100, moving: false } } };
    const resumedBaselines = resolveCueButtonBaselines(steps, project.modules, pausedSnap, initialBaselines);
    expect(resumedBaselines[modId].start).toBe(0);
    expect(Math.round(computeManualMotionProgress(resumedBaselines, project.modules, pausedSnap).progress * 100)).toBe(45);

    useAppStore.setState({
      selectedButtonId: project.buttons[0].id,
      lastFiredButtonId: null,
      lastFiredButtonBaselines: {},
      snapshot: null,
    });

    const propsHtml = renderToStaticMarkup(
      React.createElement(PropertiesPanel, { overrideState: useAppStore.getState() }),
    );
    expect(propsHtml).toContain('NÚT CUE');
    expect(propsHtml).toContain('LAYER &amp; MODULE CHẠY');
    expect(propsHtml).toContain('Chế độ đơn vị chiều cao');
    expect(propsHtml).toContain('Đổi đơn vị m / %');
    expect(propsHtml).toContain('text-center');
    expect(propsHtml).toContain('Áp dụng cho các layer');
    expect(propsHtml).not.toContain('Lấy 3D');
    expect(propsHtml).not.toContain('LOOP');
    expect(propsHtml).toContain(project.layers[0].name);
    expect(propsHtml).toContain(project.modules[0].name);
  });

  it('auto-updates UDP port on protocol switch and renders themed KilnSelect dropdowns + aligned rows in SettingsModal', () => {
    setupBrowserEnv();
    const project = createDefaultProject();
    project.settings.output.driver = 'artnet';
    project.settings.output.port = 6454;
    project.settings.timeline.fps = 60;

    // Network tab: uses custom KilnSelect (no native <select>), flex-col aligned fields,
    // and surfaces localhost Art-Net info + status warning in UI
    project.settings.output.ip = '127.0.0.1';
    useAppStore.setState({
      project,
      settingsOpen: true,
      settingsTab: 'network',
      snapshot: {
        t: Date.now(),
        locked: false,
        frame: [],
        modules: {},
        status: {
          state: 'searching',
          driver: 'artnet',
          ip: '127.0.0.1',
          port: 6454,
          portAddress: 0,
          sendHz: 25,
          nodes: [],
          message: null,
          warning: 'Cổng 6454 đang bận — đã tắt nghe ArtPollReply, vẫn gửi ArtDmx bình thường.',
        },
      },
    });
    const netSettingsHtml = renderToStaticMarkup(
      React.createElement(SettingsModal, { overrideState: useAppStore.getState() }),
    );
    expect(netSettingsHtml).not.toContain('<select');
    expect(netSettingsHtml).toContain('role="combobox"');
    expect(netSettingsHtml).toContain('Art-Net');
    expect(netSettingsHtml).toContain('grid-cols-2 items-end gap-3');
    expect(netSettingsHtml).toContain('Cổng 6454 đang bận');
    expect(netSettingsHtml).toContain('Đích localhost: app gửi ArtDmx qua cổng động');

    // Open KilnSelect renders grouped theme menu & 40/50/60 fps options
    const openDriverHtml = renderToStaticMarkup(
      React.createElement(KilnSelect, {
        value: 'artnet',
        defaultOpen: true,
        onChange: () => {},
        options: [
          { value: 'artnet', label: 'Art-Net', badge: 'Ưu tiên', description: 'UDP mạng LAN', group: 'Mạng LAN' },
          { value: 'sacn', label: 'sACN E1.31', description: 'UDP Multicast / Unicast', group: 'Mạng LAN' },
          { value: 'mock', label: 'Mock', description: 'Mô phỏng nội bộ', group: 'Thử nghiệm' },
        ],
      }),
    );
    expect(openDriverHtml).toContain('role="listbox"');
    expect(openDriverHtml).toContain('Mạng LAN');
    expect(openDriverHtml).toContain('Ưu tiên');
    expect(openDriverHtml).toContain('Thử nghiệm');

    const openFpsHtml = renderToStaticMarkup(
      React.createElement(KilnSelect, {
        value: '60',
        defaultOpen: true,
        onChange: () => {},
        options: FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })),
      }),
    );
    expect(openFpsHtml).toContain('40 fps');
    expect(openFpsHtml).toContain('50 fps');
    expect(openFpsHtml).toContain('60 fps');

    useAppStore.setState({ project, settingsOpen: true, settingsTab: 'ltc' });
    const ltcSettingsHtml = renderToStaticMarkup(
      React.createElement(SettingsModal, { overrideState: useAppStore.getState() }),
    );
    expect(ltcSettingsHtml).not.toContain('<select');
    expect(ltcSettingsHtml).toContain('60 fps');
    expect(ltcSettingsHtml).toContain('không khớp chuẩn LTC SMPTE');
    expect(ltcSettingsHtml).toContain('30 fps');

    useAppStore.getState().updateOutputSettings({ driver: 'sacn' });
    expect(useAppStore.getState().project.settings.output.port).toBe(5568);
    expect(useAppStore.getState().project.settings.output.sacnUniverse).toBe(1);

    useAppStore.getState().updateOutputSettings({ driver: 'artnet' });
    expect(useAppStore.getState().project.settings.output.port).toBe(6454);

    useAppStore.getState().updateOutputSettings({ driver: 'kinet' });
    expect(useAppStore.getState().project.settings.output.port).toBe(6038);
  });
});

describe('Save errors are reported and out-of-range inputs are clamped', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('autosave and Ctrl+S failures raise an error toast instead of failing silently', async () => {
    vi.useFakeTimers();
    setupBrowserEnv();
    const { getBridge } = await import('./services/bridge');
    const bridge = getBridge();
    vi.spyOn(bridge, 'saveProject').mockRejectedValue(new Error('disk full'));
    vi.spyOn(bridge, 'saveProjectFile').mockRejectedValue(new Error('disk full'));
    useAppStore.getState().updateNotificationSettings({
      enabled: true,
      kinds: { info: true, success: true, warn: true, error: true },
    });
    useAppStore.getState().updateOutputSettings({ sendHz: 25 });
    await vi.advanceTimersByTimeAsync(300);
    expect(useAppStore.getState().toast).toMatchObject({ kind: 'error', title: 'Lỗi lưu' });
    useAppStore.getState().dismissToast();
    await vi.advanceTimersByTimeAsync(1000); // qua cửa sổ chống toast trùng 800 ms
    await useAppStore.getState().saveCurrentProject();
    expect(useAppStore.getState().toast).toMatchObject({ kind: 'error', title: 'Lỗi lưu' });
    expect(useAppStore.getState().dirty).toBe(true);
  });

  it('a localStorage quota failure in the real web bridge reaches the error toast', async () => {
    vi.useFakeTimers();
    setupBrowserEnv();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    useAppStore.getState().updateNotificationSettings({
      enabled: true,
      kinds: { info: true, success: true, warn: true, error: true },
    });
    useAppStore.getState().updateOutputSettings({ sendHz: 25 });
    await vi.advanceTimersByTimeAsync(300);
    expect(useAppStore.getState().toast).toMatchObject({ kind: 'error', title: 'Lỗi lưu' });
    expect(useAppStore.getState().toast?.text).toContain('QuotaExceededError');
    // Các thao tác file chỉ dùng localStorage làm cache nên vẫn phải thành công khi quota đầy.
    const { getBridge } = await import('./services/bridge');
    await expect(getBridge().saveProjectFile(useAppStore.getState().project)).resolves.toMatchObject({ saved: true });
  });

  it('module and LTC values are clamped to what normalizeProject accepts', () => {
    vi.useFakeTimers();
    setupBrowserEnv();
    const id = useAppStore.getState().project.modules[0].id;
    useAppStore.getState().updateModule(id, { length: 600, width: 900, maxSpeedCms: 20000 });
    useAppStore.getState().updateLtcSettings({ offsetFrames: 900, freewheelFrames: 1000 });
    const { project } = useAppStore.getState();
    expect(() => normalizeProject(project)).not.toThrow();
    expect(project.modules[0].length).toBe(500);
    expect(project.settings.ltc.offsetFrames).toBe(600);
  });
});
