export type DriverId = 'artnet' | 'sacn' | 'kinet' | 'enttec-pro' | 'enttec-mk2' | 'serial' | 'mock'
export type LtcFps = 24 | 25 | 29.97 | 30
export type Fps = LtcFps | 40 | 50 | 60

export interface Transform3D {
  position: [number, number, number]
  /** Góc xoay theo độ (X, Y, Z). */
  rotation: [number, number, number]
  scale: [number, number, number]
}

export interface OutputSettings {
  driver: DriverId
  /** IP đích (Art-Net / sACN unicast / KiNET). Mặc định 255.255.255.255 (broadcast). */
  ip: string
  port: number
  /** Art-Net port-address: net (0-127), subnet (0-15), universe (0-15). */
  net: number
  subnet: number
  universe: number
  sendHz: number
  /** sACN E1.31: Universe 1–63999, mức ưu tiên 0–200, multicast 239.255.x.y. */
  sacnUniverse?: number
  sacnPriority?: number
  sacnMulticast?: boolean
  /** KiNET: v1 DMXOUT / v2 PORT_OUT và cổng ra 1–16. */
  kinetVersion?: 1 | 2
  kinetPort?: number
  /** USB / Serial (Enttec Pro, Enttec Mk2, Generic Serial). */
  serialPort?: string
  baudRate?: number
  enttecMk2Port?: 1 | 2
  serialFormat?: 'raw' | 'enttec' | 'ascii'
}

export interface Layer {
  id: string
  name: string
  visible?: boolean
  syncLayer?: boolean
  transform?: Transform3D
}

export interface ModuleCfg {
  id: string
  name: string
  layerId: string
  visible?: boolean
  dmxLoop?: boolean
  transform?: Transform3D
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
  /** Vị trí ô (0-based) trong lưới Cue Custom. */
  slotIndex?: number
  /** Hiển thị / đánh dấu lặp (LOOP) trên nút cue. */
  loop?: boolean
}

export interface TimelineKey {
  id: string
  /** Timecode tuyệt đối (giây). */
  time: number
  targets: Record<string, number>
}

export interface ClipKeyframe {
  id: string
  /** Thời điểm tương đối từ đầu clip (giây). */
  offset: number
  /** Chiều cao thả màn (m). */
  height: number
}

export interface TimelineClip {
  id: string
  layerId: string
  moduleId: string
  /** Thời điểm bắt đầu trên timeline (giây). */
  startTime: number
  /** Độ dài clip (giây). */
  duration: number
  /** Dạng đường cong hiển thị: mượt (spline) hoặc thẳng (linear). */
  curveMode?: 'smooth' | 'linear'
  keyframes: ClipKeyframe[]
}

export interface LtcSettings {
  deviceId: string
  channel: 'left' | 'right'
  freewheelFrames: number
  offsetFrames: number
  /** Tốc độ khung hình riêng của LTC In/Out (chuẩn SMPTE chỉ 24/25/29.97/30). */
  fps?: LtcFps
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
  /** Phiên bản lược đồ migration nội bộ (v1.0.0 không có hoặc < 2; v1.0.1 = 2). */
  schemaVersion?: number
  layers: Layer[]
  modules: ModuleCfg[]
  buttons: CueButton[]
  keys: TimelineKey[]
  clips?: TimelineClip[]
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
