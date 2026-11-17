// Quy đổi mét / tốc độ / giây ⇄ giá trị DMX (xem plan mục 8.2).
import type { ModuleCfg, Snapshot } from './types'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Vị trí (m) → CH1 (coarse) + CH2 (fine) dạng 16-bit. */
export function posToDmx(pos: number, length: number): { coarse: number; fine: number } {
  const v = Math.round(clamp(length > 0 ? pos / length : 0, 0, 1) * 65535)
  return { coarse: v >> 8, fine: v & 0xff }
}

export function dmxToPos(coarse: number, fine: number, length: number): number {
  return (((coarse << 8) | fine) / 65535) * length
}

/** CH3 → tốc độ cm/s (tuyến tính, 255 = maxSpeed). */
export function ch3ToCms(ch3: number, maxSpeedCms: number): number {
  return (ch3 / 255) * maxSpeedCms
}

/** Tốc độ cm/s → CH3 (1..255; 0 là phanh nên không dùng khi chạy). */
export function cmsToCh3(cms: number, maxSpeedCms: number): number {
  return clamp(Math.ceil((cms / maxSpeedCms) * 255), 1, 255)
}

export interface DurationConv {
  ch3: number
  /** Thời gian tối thiểu (s) mà motor đi được quãng này ở tốc độ tối đa. */
  minSeconds: number
  tooFast: boolean
}

/** Quãng đường (m) trong N giây → CH3. */
export function durationToCh3(distM: number, seconds: number, maxSpeedCms: number): DurationConv {
  const dist = Math.abs(distM)
  const minSeconds = (dist * 100) / maxSpeedCms
  const ideal = ((dist * 100) / Math.max(seconds, 0.01) / maxSpeedCms) * 255
  return { ch3: clamp(Math.ceil(ideal), 1, 255), minSeconds, tooFast: ideal > 255 }
}

export interface ManualMotionBaseline {
  start: number
  goal: number
}

export interface ManualMotionProgress {
  /** Tỉ lệ hoàn thành 0..1 trên quãng đường hiện tại. */
  progress: number
  /** Thời gian còn lại ước tính (giây, lớn nhất trong nhóm module đang chạy). */
  etaSec: number
  /** Còn ít nhất 1 module đang chuyển động theo snapshot. */
  anyMoving: boolean
  /** Tất cả module đều đã chạm ngưỡng mục tiêu. */
  reached: boolean
}

/** Tính tiến độ (0..1) và thời gian còn lại (s) cho animation dọc của nút Lên / Xuống ở Manual. */
export function computeManualMotionProgress(
  baselines: Record<string, ManualMotionBaseline>,
  modules: ModuleCfg[],
  snapshot: Pick<Snapshot, 'modules'> | null,
): ManualMotionProgress {
  const entries = Object.entries(baselines)
  if (entries.length === 0) {
    return { progress: 1, etaSec: 0, anyMoving: false, reached: true }
  }
  const modById = new Map(modules.map((m) => [m.id, m]))
  let sumProgress = 0
  let maxEta = 0
  let anyMoving = false
  let allReached = true

  for (const [id, base] of entries) {
    const mod = modById.get(id)
    const st = snapshot?.modules[id]
    const curPos = st?.pos ?? base.start
    const span = base.goal - base.start
    const distLeft = Math.abs(base.goal - curPos)

    if (st?.moving) anyMoving = true
    if (distLeft > 0.008) allReached = false

    const p = Math.abs(span) < 0.005 ? 1 : clamp((curPos - base.start) / span, 0, 1)
    sumProgress += p

    if (distLeft > 0.008 && mod) {
      const ch3 = st?.ch3 && st.ch3 > 0 ? st.ch3 : mod.defaultSpeed
      const speedCms = Math.max(1, ch3ToCms(ch3, mod.maxSpeedCms))
      const eta = (distLeft * 100) / speedCms
      if (eta > maxEta) maxEta = eta
    }
  }

  const progress = clamp(sumProgress / entries.length, 0, 1)
  return {
    progress: allReached ? 1 : progress,
    etaSec: allReached ? 0 : maxEta,
    anyMoving,
    reached: allReached,
  }
}
