import { autoAssign } from './addressing'
import { ARTNET_PORT, DEFAULT_SPEED, DEFAULT_TARGET_IP, H2_MAX_SPEED_CMS, LOCK_VALUE } from './dmx'
import type { ModuleCfg, Project } from './types'

export function createDefaultProject(): Project {
  const frontId = 'layer-front'
  const backId = 'layer-back'

  const frontModules: ModuleCfg[] = Array.from({ length: 12 }, (_, i) => ({
    id: `m-front-${i + 1}`,
    name: `Trước ${i + 1}`,
    layerId: frontId,
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
    length: 3,
    width: 4,
    minHeight: 0,
    maxHeight: 3,
    startAddress: 49,
    maxSpeedCms: H2_MAX_SPEED_CMS,
    defaultSpeed: DEFAULT_SPEED,
  }

  const layers = [
    { id: frontId, name: 'Lớp trước (12 × 1m)' },
    { id: backId, name: 'Lớp sau (1 × 3m)' },
  ]

  const modules = autoAssign(layers, [...frontModules, backModule])

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
    keys: [
      {
        id: 'key-1',
        time: 0,
        targets: Object.fromEntries(modules.map((m) => [m.id, 0])),
      },
      {
        id: 'key-2',
        time: 5,
        targets: {
          ...Object.fromEntries(frontModules.map((m) => [m.id, 1])),
          [backModule.id]: 1.5,
        },
      },
      {
        id: 'key-3',
        time: 10,
        targets: {
          ...Object.fromEntries(frontModules.map((m) => [m.id, 0])),
          [backModule.id]: 3,
        },
      },
    ],
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
