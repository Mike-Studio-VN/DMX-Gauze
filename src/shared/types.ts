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
  /** Tần số phát frame DMX đã chọn cho dự án. */
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
  /** CH2 (fine) tĩnh, 0..255, phát nguyên giá trị này; không bị vị trí/timeline/cue/wave/LTC thay đổi. Mặc định 0. */
  ch2Fine?: number
  /** @deprecated v1.0.5–1.0.7 (mm, mã hoá 16-bit cũ). Chỉ giữ lại trong file để không mất dữ liệu, không còn tác dụng. */
  homeOffsetMm?: number
  /** Giá trị CH3 mặc định. */
  defaultSpeed: number
}

export type SpeedUnit = 'cms' | 'sec'
export interface SpeedSpec {
  unit: SpeedUnit
  value: number
  limitCms?: number
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
  /** Trần tốc độ tự động của cue mặc định, bỏ khi người dùng đặt tốc độ riêng. */
  autoSpeedLimitCms?: number
  /** Đơn vị nhập vị trí trong panel cue: 'm' (mặc định) hoặc 'ch1' (0–255 ↔ 0 → length module). Chỉ là cách hiển thị; step.position luôn là m. */
  positionUnit?: 'm' | 'ch1'
  /** 'ch3' = hiển thị/nhập tốc độ cue theo CH3 (lưu vẫn là cm/s qua speedUnit 'cms', thang = Tốc độ max module tham chiếu). */
  speedView?: 'ch3'
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
  /** Tốc độ đoạn đi từ điểm này tới điểm kế: 'auto' (mặc định, tính từ quãng/thời gian) hoặc 'manual'. */
  speedMode?: 'auto' | 'manual'
  /** Tốc độ nhập tay (cm/s) khi speedMode = 'manual'; kẹp [1, maxSpeedCms] lúc phát. */
  manualSpeedCms?: number
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
  /** Giới hạn tốc độ Auto của moment mới (cm/s). */
  autoSpeedLimitCms?: number
  /**
   * Tốc độ mức moment (áp cho MỌI đoạn). Thiếu = moment cũ: dùng `speedMode/manualSpeedCms` của từng điểm.
   * 'auto' = mọi đoạn tự tính từ quãng/thời gian; 'manual' = dùng `speedUnit` + `speedValue`.
   */
  speedMode?: 'auto' | 'manual'
  /**
   * Kiểu nhập/hiển thị: cm/s (cùng tốc độ), giây (mỗi đoạn đi trong N giây), hoặc CH3 trực tiếp (1..255). Mặc định 'cms'.
   * Lưu cả khi Auto/moment cũ (chỉ là đơn vị hiển thị, đổi cột các điểm theo đơn vị này).
   */
  speedUnit?: 'cms' | 'sec' | 'ch3'
  speedValue?: number
  keyframes: ClipKeyframe[]
}

export interface LtcSettings {
  deviceId: string
  channel: 'left' | 'right'
  freewheelFrames: number
  offsetFrames: number
  /** Tốc độ khung hình riêng của LTC In (chuẩn SMPTE chỉ 24/25/29.97/30). */
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
  /** Tên project (đã trim, ≤ PROJECT_NAME_MAX). Thiếu → mặc định. */
  name?: string
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
  /** false = node do driver tự dựng, không phải thiết bị trả lời. */
  confirmed?: boolean
}

/** 'sending' = đang gửi nhưng thiết bị không phản hồi được (sACN, Serial), không đồng nghĩa online. */
export type ConnState = 'idle' | 'searching' | 'sending' | 'online' | 'lost' | 'error'

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
  /** Override đang phát theo module id → [CH1..CH4] đã gửi. */
  /** Module đang trong xung Sent (CH4=77). */
  pulsing?: string[]
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
  /**
   * Nút Sent (chỉ để TEST): CH2 = `ch2` (0–255); CH4 = 77 trong SENT_PULSE_MS rồi về 0 và giữ 0 (tới khi module nhận lệnh move
   * kế tiếp). Không bị chặn bởi khoá tổng. `ch1`/`ch3` (0–255) tuỳ chọn: có thì phát ĐÚNG giá trị đó (không kẹp min/max,
   * không quy đổi; ch3=0 là phanh) và giữ sau xung — module chạy thật; thiếu thì giữ chỗ như cũ (CH1 hiện tại, CH3 hiện có).
   */
  | { type: 'sendFine'; id: string; ch2: number; ch1?: number; ch3?: number }

export interface CommandResult {
  ok: boolean
  message?: string
  warnings?: string[]
}
