import { autoAssign } from './addressing'
import { ARTNET_PORT, DEFAULT_SPEED, DEFAULT_TARGET_IP, H2_MAX_SPEED_CMS, LOCK_VALUE } from './dmx'
import { syncModuleClipsContinuity } from './timeline'
import type { Layer, ModuleCfg, Project, Settings, TimelineClip, Transform3D } from './types'

export function defaultLayerTransform(index: number): Transform3D {
  const z = index === 0 ? 1.2 : index === 1 ? -1.4 : -1.4 - (index - 1) * 2.2
  return { position: [0, 3.6, z], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

export function defaultModuleTransform(): Transform3D {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

export function normalizeProject(p: Project): Project {
  const layers: Layer[] = p.layers.map((l, idx) => ({
    ...l,
    visible: l.visible ?? true,
    syncLayer: l.syncLayer ?? false,
    transform: l.transform ?? defaultLayerTransform(idx),
  }))
  const modules: ModuleCfg[] = p.modules.map((m) => ({
    ...m,
    visible: m.visible ?? true,
    dmxLoop: m.dmxLoop ?? false,
    transform: m.transform ?? defaultModuleTransform(),
  }))
  let clips: TimelineClip[] = p.clips ?? []
  const modIds = new Set(clips.map((c) => c.moduleId))
  for (const modId of modIds) {
    clips = syncModuleClipsContinuity(clips, modId)
  }
  return {
    ...p,
    layers,
    modules,
    clips,
  }
}

export function createBlankProject(baseSettings?: Settings): Project {
  const layerId = `layer-${Date.now()}`
  const mod: ModuleCfg = {
    id: `m-${Date.now()}`,
    name: 'Màn 1',
    layerId,
    visible: true,
    transform: defaultModuleTransform(),
    length: 1,
    width: 1,
    minHeight: 0,
    maxHeight: 1,
    startAddress: 1,
    maxSpeedCms: H2_MAX_SPEED_CMS,
    defaultSpeed: DEFAULT_SPEED,
  }
  const settings: Settings = baseSettings
    ? structuredClone(baseSettings)
    : {
        output: {
          driver: 'mock',
          ip: DEFAULT_TARGET_IP,
          port: ARTNET_PORT,
          net: 0,
          subnet: 0,
          universe: 0,
          sendHz: 40,
        },
        addressMode: 'auto',
        lockValue: LOCK_VALUE,
        ltc: { deviceId: '', channel: 'left', freewheelFrames: 10, offsetFrames: 0 },
        timeline: { startTime: 0, fps: 25 },
      }
  return {
    version: 1,
    layers: [{ id: layerId, name: 'Lớp 1', visible: true, transform: defaultLayerTransform(0) }],
    modules: [mod],
    buttons: [],
    keys: [],
    clips: [],
    settings,
  }
}

export function createDefaultProject(): Project {
  const frontId = 'layer-front'
  const backId = 'layer-back'

  const frontModules: ModuleCfg[] = Array.from({ length: 12 }, (_, i) => ({
    id: `m-front-${i + 1}`,
    name: `Trước ${i + 1}`,
    layerId: frontId,
    visible: true,
    transform: defaultModuleTransform(),
    length: 1,
    width: 1,
    minHeight: 0,
    maxHeight: 1,
    startAddress: 1 + i * 4,
    maxSpeedCms: H2_MAX_SPEED_CMS,
    defaultSpeed: DEFAULT_SPEED,
  }))

  const backModule: ModuleCfg = {
    id: 'm-back-1',
    name: 'Sau 1 (3m)',
    layerId: backId,
    visible: true,
    transform: defaultModuleTransform(),
    length: 3,
    width: 4,
    minHeight: 0,
    maxHeight: 3,
    startAddress: 49,
    maxSpeedCms: H2_MAX_SPEED_CMS,
    defaultSpeed: DEFAULT_SPEED,
  }

  const layers: Layer[] = [
    { id: frontId, name: 'Lớp trước (12 × 1m)', visible: true, transform: defaultLayerTransform(0) },
    { id: backId, name: 'Lớp sau (1 × 3m)', visible: true, transform: defaultLayerTransform(1) },
  ]

  const modules = autoAssign(layers, [...frontModules, backModule])

  const defaultClips: TimelineClip[] = [
    {
      id: 'clip-demo-1',
      layerId: frontId,
      moduleId: frontModules[0].id,
      startTime: 1,
      duration: 4,
      curveMode: 'smooth',
      keyframes: [
        { id: 'kf-1', offset: 0, height: 0 },
        { id: 'kf-2', offset: 1, height: 0.7 },
        { id: 'kf-3', offset: 2, height: 1 },
        { id: 'kf-4', offset: 3, height: 0.7 },
        { id: 'kf-5', offset: 4, height: 0 },
      ],
    },
    {
      id: 'clip-demo-2',
      layerId: backId,
      moduleId: backModule.id,
      startTime: 2,
      duration: 6,
      curveMode: 'smooth',
      keyframes: [
        { id: 'kf-6', offset: 0, height: 0 },
        { id: 'kf-7', offset: 1.5, height: 1.4 },
        { id: 'kf-8', offset: 3, height: 2.4 },
        { id: 'kf-9', offset: 4.5, height: 1.4 },
        { id: 'kf-10', offset: 6, height: 0 },
      ],
    },
  ]

  return {
    version: 1,
    layers,
    modules,
    buttons: [
      {
        id: 'cue-all-down',
        name: 'Hạ tất cả',
        steps: modules.map((m) => ({ moduleId: m.id, position: m.maxHeight })),
        speedUnit: 'sec',
        speedValue: 4,
      },
      {
        id: 'cue-wave',
        name: 'Sóng lớp trước',
        steps: frontModules.map((m, i) => ({
          moduleId: m.id,
          position: Number((0.2 + 0.8 * Math.sin((i / 11) * Math.PI)).toFixed(2)),
        })),
        speedUnit: 'cms',
        speedValue: 60,
      },
      {
        id: 'cue-home',
        name: 'Về 0 toàn bộ',
        steps: modules.map((m) => ({ moduleId: m.id, position: 0 })),
        speedUnit: 'sec',
        speedValue: 3,
      },
    ],
    keys: [],
    clips: defaultClips,
    settings: {
      output: {
        driver: 'mock',
        ip: DEFAULT_TARGET_IP,
        port: ARTNET_PORT,
        net: 0,
        subnet: 0,
        universe: 0,
        sendHz: 40,
      },
      addressMode: 'auto',
      lockValue: LOCK_VALUE,
      ltc: {
        deviceId: '',
        channel: 'left',
        freewheelFrames: 10,
        offsetFrames: 0,
      },
      timeline: {
        startTime: 0,
        fps: 25,
      },
    },
  }
}
