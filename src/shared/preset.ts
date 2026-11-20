import { autoAssign } from './addressing'
import { ARTNET_PORT, DEFAULT_SPEED, DEFAULT_TARGET_IP, H2_MAX_SPEED_CMS, LOCK_VALUE, MODULE_MAX_SPEED_LIMIT_CMS } from './dmx'
import { DEFAULT_DMX_TRANSPORT_HZ, normalizeDmxTransportRate } from './dmxTransport'
import { KINET_PORT, SACN_PORT, defaultPortForDriver } from './protocols'
import { FPS_OPTIONS, LTC_FPS_OPTIONS } from './timecode'
import { DEFAULT_MOTION_SPEED_CMS, defaultCueSpeedCms, defaultMotionSpeedCms, fitDefaultMotionDuration, roundUpMotionDuration, segmentDistCm } from './timeline'

export const CURRENT_SCHEMA_VERSION = 2
import type {
  ClipKeyframe,
  CueButton,
  CueStep,
  DriverId,
  Fps,
  Layer,
  LtcFps,
  ModuleCfg,
  OutputSettings,
  Project,
  Settings,
  TimelineClip,
  TimelineKey,
  Transform3D,
} from './types'

const VALID_DRIVERS = new Set<DriverId>(['artnet', 'sacn', 'kinet', 'enttec-pro', 'enttec-mk2', 'serial', 'mock'])
const VALID_FPS = new Set<Fps>(FPS_OPTIONS)
const VALID_LTC_FPS = new Set<LtcFps>(LTC_FPS_OPTIONS)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function failProject(msg: string): never {
  throw new Error(`Dự án không hợp lệ: ${msg}`)
}

function reqString(v: unknown, label: string, allowEmpty = true): string {
  if (typeof v !== 'string') failProject(`${label} phải là chuỗi`)
  if (!allowEmpty && v.trim().length === 0) failProject(`${label} không được rỗng`)
  return v
}

function reqFinite(v: unknown, label: string, min?: number, max?: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) failProject(`${label} phải là số hữu hạn`)
  if (integer && !Number.isInteger(v)) failProject(`${label} phải là số nguyên`)
  if (min !== undefined && v < min) failProject(`${label} nhỏ hơn ${min}`)
  if (max !== undefined && v > max) failProject(`${label} lớn hơn ${max}`)
  return v
}

function reqOptionalBool(v: unknown, label: string, fallback: boolean): boolean {
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') failProject(`${label} phải là boolean`)
  return v
}

function validateTransform(v: unknown, label: string, fallback: Transform3D): Transform3D {
  if (v === undefined) return fallback
  if (!isRecord(v)) failProject(`${label} phải là object Transform3D`)
  const readTuple = (arr: unknown, axisLabel: string, minVal?: number): [number, number, number] => {
    if (!Array.isArray(arr) || arr.length !== 3) failProject(`${axisLabel} phải gồm 3 phần tử`)
    return [
      reqFinite(arr[0], `${axisLabel}[0]`, minVal),
      reqFinite(arr[1], `${axisLabel}[1]`, minVal),
      reqFinite(arr[2], `${axisLabel}[2]`, minVal),
    ]
  }
  return {
    position: readTuple(v.position, `${label}.position`),
    rotation: readTuple(v.rotation, `${label}.rotation`),
    scale: readTuple(v.scale, `${label}.scale`, 0.01),
  }
}

function validateSettings(rawSettings: unknown, legacySchema: boolean): Settings {
  if (!isRecord(rawSettings)) failProject('thiếu hoặc sai settings')
  if (!isRecord(rawSettings.output)) failProject('thiếu hoặc sai settings.output')
  const rawOut = rawSettings.output
  const driver = rawOut.driver as DriverId
  if (!VALID_DRIVERS.has(driver)) failProject('settings.output.driver không hợp lệ')
  const ip = reqString(rawOut.ip, 'settings.output.ip')
  // Giữ nguyên custom port; chỉ migrate port 6454 trên dự án legacy v1.0.0 (schemaVersion < 2) khi dùng sACN/KiNET
  // vì v1.0.0 từng dịch 6454 -> 5568/6038 lúc gửi mà không ghi lại port vào file dự án.
  let port =
    rawOut.port === undefined || rawOut.port === null
      ? (defaultPortForDriver(driver) ?? ARTNET_PORT)
      : reqFinite(rawOut.port, 'settings.output.port', 1, 65535, true)
  if (legacySchema && port === ARTNET_PORT) {
    if (driver === 'sacn') port = SACN_PORT
    else if (driver === 'kinet') port = KINET_PORT
  }
  const output: OutputSettings = {
    driver,
    ip,
    port,
    net: reqFinite(rawOut.net, 'settings.output.net', 0, 127, true),
    subnet: reqFinite(rawOut.subnet, 'settings.output.subnet', 0, 15, true),
    universe: reqFinite(rawOut.universe, 'settings.output.universe', 0, 15, true),
    sendHz: normalizeDmxTransportRate(
      rawOut.sendHz === undefined ? undefined : reqFinite(rawOut.sendHz, 'settings.output.sendHz', 1, 120),
    ),
  }
  if (rawOut.sacnUniverse !== undefined) {
    output.sacnUniverse = reqFinite(rawOut.sacnUniverse, 'settings.output.sacnUniverse', 1, 63999, true)
  }
  if (rawOut.sacnPriority !== undefined) {
    output.sacnPriority = reqFinite(rawOut.sacnPriority, 'settings.output.sacnPriority', 0, 200, true)
  }
  if (rawOut.sacnMulticast !== undefined) {
    output.sacnMulticast = reqOptionalBool(rawOut.sacnMulticast, 'settings.output.sacnMulticast', true)
  }
  if (rawOut.kinetVersion !== undefined) {
    if (rawOut.kinetVersion !== 1 && rawOut.kinetVersion !== 2) failProject('settings.output.kinetVersion phải là 1 hoặc 2')
    output.kinetVersion = rawOut.kinetVersion
  }
  if (rawOut.kinetPort !== undefined) {
    output.kinetPort = reqFinite(rawOut.kinetPort, 'settings.output.kinetPort', 1, 16, true)
  }
  if (rawOut.serialPort !== undefined) {
    output.serialPort = reqString(rawOut.serialPort, 'settings.output.serialPort')
  }
  if (rawOut.baudRate !== undefined) {
    output.baudRate = reqFinite(rawOut.baudRate, 'settings.output.baudRate', 1, 10000000, true)
  }
  if (rawOut.enttecMk2Port !== undefined) {
    if (rawOut.enttecMk2Port !== 1 && rawOut.enttecMk2Port !== 2) failProject('settings.output.enttecMk2Port phải là 1 hoặc 2')
    output.enttecMk2Port = rawOut.enttecMk2Port
  }
  if (rawOut.serialFormat !== undefined) {
    if (rawOut.serialFormat !== 'raw' && rawOut.serialFormat !== 'enttec' && rawOut.serialFormat !== 'ascii') {
      failProject('settings.output.serialFormat không hợp lệ')
    }
    output.serialFormat = rawOut.serialFormat
  }

  const addressMode = rawSettings.addressMode
  if (addressMode !== 'auto' && addressMode !== 'manual') failProject('settings.addressMode không hợp lệ')
  const lockValue = reqFinite(rawSettings.lockValue, 'settings.lockValue', 0, 255, true)

  if (!isRecord(rawSettings.ltc)) failProject('thiếu hoặc sai settings.ltc')
  const rawLtc = rawSettings.ltc
  if (rawLtc.channel !== 'left' && rawLtc.channel !== 'right') failProject('settings.ltc.channel không hợp lệ')
  const ltc: Settings['ltc'] = {
    deviceId: reqString(rawLtc.deviceId, 'settings.ltc.deviceId'),
    channel: rawLtc.channel,
    freewheelFrames: reqFinite(rawLtc.freewheelFrames, 'settings.ltc.freewheelFrames', 0, 600),
    offsetFrames: reqFinite(rawLtc.offsetFrames, 'settings.ltc.offsetFrames', -600, 600),
  }
  if (rawLtc.fps !== undefined) {
    const ltcFps = rawLtc.fps as LtcFps
    if (!VALID_LTC_FPS.has(ltcFps)) failProject('settings.ltc.fps không hợp lệ')
    ltc.fps = ltcFps
  }

  if (!isRecord(rawSettings.timeline)) failProject('thiếu hoặc sai settings.timeline')
  const rawTl = rawSettings.timeline
  const fps = rawTl.fps as Fps
  if (!VALID_FPS.has(fps)) failProject('settings.timeline.fps không hợp lệ')
  const timeline: Settings['timeline'] = {
    startTime: reqFinite(rawTl.startTime, 'settings.timeline.startTime', 0),
    fps,
  }

  return { output, addressMode, lockValue, ltc, timeline }
}

export function defaultLayerTransform(index: number): Transform3D {
  const z = index === 0 ? 1.2 : index === 1 ? -1.4 : -1.4 - (index - 1) * 2.2
  return { position: [0, 3.6, z], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

export function defaultModuleTransform(): Transform3D {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

function parseClipSpeed(c: Record<string, unknown>, label: string): Pick<TimelineClip, 'speedMode' | 'speedUnit' | 'speedValue'> {
  // speedUnit là lựa chọn hiển thị/nhập (cm/s | s | CH3), lưu cả khi Auto hoặc moment cũ.
  const unit = c.speedUnit as TimelineClip['speedUnit']
  if (unit !== undefined && unit !== 'cms' && unit !== 'sec' && unit !== 'ch3') failProject(`${label}.speedUnit phải là 'cms', 'sec' hoặc 'ch3'`)
  const u = unit === undefined ? {} : { speedUnit: unit }
  if (c.speedMode === undefined) return u // moment cũ: giữ hành vi theo từng điểm
  if (c.speedMode === 'auto') return { speedMode: 'auto', ...u }
  if (c.speedMode !== 'manual') failProject(`${label}.speedMode phải là 'auto' hoặc 'manual'`)
  return { speedMode: 'manual', speedUnit: unit ?? 'cms', speedValue: reqFinite(c.speedValue, `${label}.speedValue`, 0, 10000) }
}

function parseKeyframeSpeed(kf: Record<string, unknown>, label: string): Pick<ClipKeyframe, 'speedMode' | 'manualSpeedCms'> {
  if (kf.speedMode === undefined || kf.speedMode === 'auto') return {}
  if (kf.speedMode !== 'manual') failProject(`${label}.speedMode phải là 'auto' hoặc 'manual'`)
  return { speedMode: 'manual', manualSpeedCms: reqFinite(kf.manualSpeedCms, `${label}.manualSpeedCms`, 0, 10000) }
}

export const PROJECT_NAME_MAX = 80
export const DEFAULT_PROJECT_NAME = 'DMX Gauze Stage'

/** Trim, gộp khoảng trắng, cắt tối đa 80 ký tự; rỗng/không hợp lệ → tên mặc định. */
export function normalizeProjectName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, PROJECT_NAME_MAX).trim() : ''
  return s || DEFAULT_PROJECT_NAME
}

/** Tên file mặc định cho 'Lưu thành...': bỏ ký tự cấm trong tên file. */
export function projectFileName(name: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const base = normalizeProjectName(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  return `${base || DEFAULT_PROJECT_NAME}${PROJECT_FILE_EXT}`
}

/** Đuôi file project do người dùng lưu; nội dung vẫn là JSON. File .json cũ vẫn mở được. */
export const PROJECT_FILE_EXT = '.mikdmx'

/** Đảm bảo tên/đường dẫn kết thúc bằng .mikdmx: thêm nếu thiếu, đổi .json cũ, không nhân đôi đuôi. */
export function ensureProjectExt(path: string): string {
  return `${path.replace(/\.(json|mikdmx)$/i, '')}${PROJECT_FILE_EXT}`
}

export function normalizeProject(raw: unknown): Project {
  if (!isRecord(raw) || raw.version !== 1) failProject('version phải bằng 1')
  if (!Array.isArray(raw.layers)) failProject('thiếu mảng layers')
  if (!Array.isArray(raw.modules)) failProject('thiếu mảng modules')

  const schemaVer =
    typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 1
  const settings = validateSettings(raw.settings, schemaVer < CURRENT_SCHEMA_VERSION)

  const layers: Layer[] = raw.layers.map((item, idx) => {
    if (!isRecord(item)) failProject(`layers[${idx}] phải là object`)
    return {
      id: reqString(item.id, `layers[${idx}].id`, false),
      name: reqString(item.name, `layers[${idx}].name`),
      visible: reqOptionalBool(item.visible, `layers[${idx}].visible`, true),
      syncLayer: reqOptionalBool(item.syncLayer, `layers[${idx}].syncLayer`, false),
      transform: validateTransform(item.transform, `layers[${idx}].transform`, defaultLayerTransform(idx)),
    }
  })

  const modules: ModuleCfg[] = raw.modules.map((item, idx) => {
    if (!isRecord(item)) failProject(`modules[${idx}] phải là object`)
    const length = reqFinite(item.length, `modules[${idx}].length`, 0.2, 500)
    const width = reqFinite(item.width, `modules[${idx}].width`, 0.2, 500)
    const minHeight = reqFinite(item.minHeight, `modules[${idx}].minHeight`, 0, length)
    const maxHeight = reqFinite(item.maxHeight, `modules[${idx}].maxHeight`, minHeight, length + 1e-6)
    return {
      id: reqString(item.id, `modules[${idx}].id`, false),
      name: reqString(item.name, `modules[${idx}].name`),
      layerId: reqString(item.layerId, `modules[${idx}].layerId`, false),
      visible: reqOptionalBool(item.visible, `modules[${idx}].visible`, true),
      dmxLoop: reqOptionalBool(item.dmxLoop, `modules[${idx}].dmxLoop`, false),
      transform: validateTransform(item.transform, `modules[${idx}].transform`, defaultModuleTransform()),
      length,
      width,
      minHeight,
      maxHeight: Math.min(length, maxHeight),
      startAddress: reqFinite(item.startAddress, `modules[${idx}].startAddress`, 1, 509, true),
      maxSpeedCms: reqFinite(item.maxSpeedCms, `modules[${idx}].maxSpeedCms`, 1, MODULE_MAX_SPEED_LIMIT_CMS),
      // fineTune (±255 bước, v1.0.4) bị bỏ qua. homeOffsetMm (v1.0.5–1.0.7) được giữ nguyên nhưng không còn tác dụng.
      ...(item.ch2Fine === undefined ? {} : { ch2Fine: reqFinite(item.ch2Fine, `modules[${idx}].ch2Fine`, 0, 255, true) }),
      ...(item.homeOffsetMm === undefined
        ? {}
        : { homeOffsetMm: reqFinite(item.homeOffsetMm, `modules[${idx}].homeOffsetMm`, 0, 40) }),
      // `locked` (khoá theo module, v1.0.5–1.0.8) đã bỏ: giá trị trong file cũ bị bỏ qua, không ghi lại.
      defaultSpeed: reqFinite(item.defaultSpeed, `modules[${idx}].defaultSpeed`, 1, 255, true),
    }
  })

  for (const [label, items] of [['layers', layers], ['modules', modules]] as const) {
    if (new Set(items.map((i) => i.id)).size !== items.length) failProject(`${label} có id trùng nhau`)
  }

  let buttons: CueButton[] = []
  if (raw.buttons !== undefined) {
    if (!Array.isArray(raw.buttons)) failProject('buttons phải là mảng')
    buttons = raw.buttons.map((b, idx) => {
      if (!isRecord(b)) failProject(`buttons[${idx}] phải là object`)
      if (b.speedUnit !== 'cms' && b.speedUnit !== 'sec') failProject(`buttons[${idx}].speedUnit không hợp lệ`)
      if (!Array.isArray(b.steps)) failProject(`buttons[${idx}].steps phải là mảng`)
      const steps: CueStep[] = b.steps.map((s, sIdx) => {
        if (!isRecord(s)) failProject(`buttons[${idx}].steps[${sIdx}] phải là object`)
        return {
          moduleId: reqString(s.moduleId, `buttons[${idx}].steps[${sIdx}].moduleId`, false),
          position: reqFinite(s.position, `buttons[${idx}].steps[${sIdx}].position`, 0),
        }
      })
      return {
        id: reqString(b.id, `buttons[${idx}].id`, false),
        name: reqString(b.name, `buttons[${idx}].name`),
        steps,
        speedUnit: b.speedUnit,
        speedValue: reqFinite(b.speedValue, `buttons[${idx}].speedValue`, 0.01),
        ...(b.positionUnit === undefined || b.positionUnit === 'm'
          ? {}
          : b.positionUnit === 'ch1'
            ? { positionUnit: 'ch1' as const }
            : failProject(`buttons[${idx}].positionUnit phải là 'm' hoặc 'ch1'`)),
        ...(b.speedView === undefined
          ? {}
          : b.speedView === 'ch3' && b.speedUnit === 'cms'
            ? { speedView: 'ch3' as const }
            : failProject(`buttons[${idx}].speedView chỉ là 'ch3' khi speedUnit = 'cms'`)),
        ...(b.autoSpeedLimitCms === undefined ? {} : {
          autoSpeedLimitCms: reqFinite(b.autoSpeedLimitCms, `buttons[${idx}].autoSpeedLimitCms`, 1, DEFAULT_MOTION_SPEED_CMS),
        }),
        ...(b.slotIndex !== undefined
          ? { slotIndex: reqFinite(b.slotIndex, `buttons[${idx}].slotIndex`, 0, 128, true) }
          : {}),
        ...(b.loop !== undefined ? { loop: reqOptionalBool(b.loop, `buttons[${idx}].loop`, false) } : {}),
      }
    })
  }

  let keys: TimelineKey[] = []
  if (raw.keys !== undefined) {
    if (!Array.isArray(raw.keys)) failProject('keys phải là mảng')
    keys = raw.keys.map((k, idx) => {
      if (!isRecord(k)) failProject(`keys[${idx}] phải là object`)
      if (!isRecord(k.targets)) failProject(`keys[${idx}].targets phải là object`)
      const targets: Record<string, number> = {}
      for (const [mId, val] of Object.entries(k.targets)) {
        targets[mId] = reqFinite(val, `keys[${idx}].targets.${mId}`, 0)
      }
      return {
        id: reqString(k.id, `keys[${idx}].id`, false),
        time: reqFinite(k.time, `keys[${idx}].time`, 0),
        targets,
      }
    })
  }

  let clips: TimelineClip[] = []
  if (raw.clips !== undefined) {
    if (!Array.isArray(raw.clips)) failProject('clips phải là mảng')
    clips = raw.clips.map((c, idx) => {
      if (!isRecord(c)) failProject(`clips[${idx}] phải là object`)
      if (c.curveMode !== undefined && c.curveMode !== 'smooth' && c.curveMode !== 'linear') {
        failProject(`clips[${idx}].curveMode không hợp lệ`)
      }
      if (!Array.isArray(c.keyframes) || c.keyframes.length === 0) {
        failProject(`clips[${idx}].keyframes phải có ít nhất 1 điểm`)
      }
      const duration = reqFinite(c.duration, `clips[${idx}].duration`, 0.05)
      const keyframes: ClipKeyframe[] = c.keyframes.map((kf, kIdx) => {
        if (!isRecord(kf)) failProject(`clips[${idx}].keyframes[${kIdx}] phải là object`)
        return {
          id: reqString(kf.id, `clips[${idx}].keyframes[${kIdx}].id`, false),
          offset: Math.min(duration, reqFinite(kf.offset, `clips[${idx}].keyframes[${kIdx}].offset`, 0, duration + 0.05)),
          height: reqFinite(kf.height, `clips[${idx}].keyframes[${kIdx}].height`, 0),
          ...parseKeyframeSpeed(kf, `clips[${idx}].keyframes[${kIdx}]`),
        }
      })
      return {
        id: reqString(c.id, `clips[${idx}].id`, false),
        layerId: reqString(c.layerId, `clips[${idx}].layerId`, false),
        moduleId: reqString(c.moduleId, `clips[${idx}].moduleId`, false),
        startTime: reqFinite(c.startTime, `clips[${idx}].startTime`, 0),
        duration,
        curveMode: c.curveMode,
        ...(c.autoSpeedLimitCms === undefined ? {} : {
          autoSpeedLimitCms: reqFinite(c.autoSpeedLimitCms, `clips[${idx}].autoSpeedLimitCms`, 1, MODULE_MAX_SPEED_LIMIT_CMS),
        }),
        ...parseClipSpeed(c, `clips[${idx}]`),
        keyframes,
      }
    })
  }

  clips = clips.map((c) => ({
    ...c,
    keyframes: [...c.keyframes].sort((a, b) => a.offset - b.offset),
  }))

  return {
    version: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name: normalizeProjectName(raw.name),
    layers,
    modules,
    buttons,
    keys,
    clips,
    settings,
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
          sendHz: DEFAULT_DMX_TRANSPORT_HZ,
        },
        addressMode: 'auto',
        lockValue: LOCK_VALUE,
        ltc: { deviceId: '', channel: 'left', freewheelFrames: 10, offsetFrames: 0 },
        timeline: { startTime: 0, fps: 25 },
      }
  return {
    version: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
  const fullTravelSeconds = Math.max(...modules.map((mod) =>
    segmentDistCm(mod, mod.minHeight, mod.maxHeight) / defaultMotionSpeedCms(mod),
  ))
  const fullTravelDuration = roundUpMotionDuration(fullTravelSeconds)

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
    schemaVersion: CURRENT_SCHEMA_VERSION,
    layers,
    modules,
    buttons: [
      {
        id: 'cue-all-down',
        name: 'Hạ tất cả',
        steps: modules.map((m) => ({ moduleId: m.id, position: m.maxHeight })),
        speedUnit: 'sec',
        speedValue: fullTravelDuration,
        autoSpeedLimitCms: DEFAULT_MOTION_SPEED_CMS,
      },
      {
        id: 'cue-wave',
        name: 'Sóng lớp trước',
        steps: frontModules.map((m, i) => ({
          moduleId: m.id,
          position: Number((0.2 + 0.8 * Math.sin((i / 11) * Math.PI)).toFixed(2)),
        })),
        speedUnit: 'cms',
        speedValue: defaultCueSpeedCms(frontModules),
        autoSpeedLimitCms: DEFAULT_MOTION_SPEED_CMS,
      },
      {
        id: 'cue-home',
        name: 'Về 0 toàn bộ',
        steps: modules.map((m) => ({ moduleId: m.id, position: 0 })),
        speedUnit: 'sec',
        speedValue: fullTravelDuration,
        autoSpeedLimitCms: DEFAULT_MOTION_SPEED_CMS,
      },
    ],
    keys: [],
    clips: defaultClips.map((clip) => fitDefaultMotionDuration(clip, modules.find((mod) => mod.id === clip.moduleId)!)),
    settings: {
      output: {
        driver: 'mock',
        ip: DEFAULT_TARGET_IP,
        port: ARTNET_PORT,
        net: 0,
        subnet: 0,
        universe: 0,
        sendHz: DEFAULT_DMX_TRANSPORT_HZ,
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
