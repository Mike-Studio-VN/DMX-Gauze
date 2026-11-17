export type DriverId = 'mock' | 'artnet'
export type Fps = 24 | 25 | 29.97 | 30

export interface OutputSettings {
  driver: DriverId
  /** IP đích. Mặc định 255.255.255.255 (broadcast). */
  ip: string
  port: number
  /** Art-Net port-address: net (0-127), subnet (0-15), universe (0-15). */
  net: number
  subnet: number
  universe: number
  sendHz: number
}

export interface Layer {
  id: string
  name: string
}

export interface ModuleCfg {
  id: string
  name: string
  layerId: string
  /** Hành trình thả tối đa (m) ứng với DMX 255. */
  length: number
  /** Bề rộng hiển thị 3D (m). */
  width: number
  minHeight: number
  maxHeight: number
  /** Địa chỉ DMX bắt đầu (1-based), chiếm 4 kênh. */
  startAddress: number
  /** Tốc độ tối đa motor (cm/s) ứng với CH3 = 255. */
  maxSpeedCms: number
  /** Giá trị CH3 mặc định. */
  defaultSpeed: number
}

export type SpeedUnit = 'cms' | 'sec'
export interface SpeedSpec {
  unit: SpeedUnit
  value: number
}

export interface CueStep {
  moduleId: string
  position: number
}

export interface CueButton {
  id: string
  name: string
  steps: CueStep[]
  speedUnit: SpeedUnit
  speedValue: number
}

export interface TimelineKey {
  id: string
  /** Timecode tuyệt đối (giây). */
  time: number
  targets: Record<string, number>
}

export interface LtcSettings {
  deviceId: string
  channel: 'left' | 'right'
  freewheelFrames: number
  offsetFrames: number
}

export interface Settings {
  output: OutputSettings
  addressMode: 'auto' | 'manual'
  lockValue: number
  ltc: LtcSettings
  timeline: { startTime: number; fps: Fps }
}

export interface Project {
  version: 1
  layers: Layer[]
  modules: ModuleCfg[]
  buttons: CueButton[]
  keys: TimelineKey[]
  settings: Settings
}

// ---- Runtime ----

export interface ModuleState {
  pos: number
  target: number
  ch3: number
  moving: boolean
}

export interface NodeInfo {
  ip: string
  name: string
  longName: string
  lastSeen: number
}

export type ConnState = 'idle' | 'searching' | 'online' | 'lost' | 'error'

export interface ConnectionStatus {
  state: ConnState
  driver: DriverId
  ip: string
  port: number
  portAddress: number
  sendHz: number
  nodes: NodeInfo[]
  message: string | null
  /** Cảnh báo mềm (không phải lỗi). */
  warning: string | null
}

export interface Snapshot {
  t: number
  modules: Record<string, ModuleState>
  locked: boolean
  status: ConnectionStatus
  frame: Uint8Array
}

export interface CoreConfig {
  modules: ModuleCfg[]
  output: OutputSettings
  lockValue: number
}

export type MoveTarget = number | 'min' | 'max' | 'zero' | 'length'
export type Command =
  | { type: 'move'; ids: string[]; target: MoveTarget; speed: SpeedSpec | { unit: 'default'; value?: number } }
  | { type: 'stop'; ids: string[] | 'all' }
  | { type: 'estop' }
  | { type: 'lock'; locked: boolean }

export interface CommandResult {
  ok: boolean
  message?: string
  warnings?: string[]
}
