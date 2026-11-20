// Quy đổi mét / tốc độ / giây ⇄ giá trị DMX (xem plan mục 8.2).
import type { ModuleCfg, Snapshot } from './types'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

type PosRange = Pick<ModuleCfg, 'length' | 'minHeight' | 'maxHeight'>

/** Dải CH1 hợp lệ [lo, hi] (0..255) ứng với [minHeight, min(maxHeight,length)]; không vượt ra ngoài khoảng của module. */
export function ch1Range(m: PosRange): [number, number] {
  const hiM = Math.min(m.maxHeight, m.length)
  const loM = Math.min(Math.max(m.minHeight, 0), hiM)
  const k = m.length > 0 ? 255 / m.length : 0
  let lo = Math.ceil(loM * k - 1e-9)
  let hi = Math.floor(hiM * k + 1e-9)
  if (lo > hi) lo = hi = Math.round(loM * k) // khoảng quá hẹp: không có mã nào nằm gọn bên trong
  return [clamp(lo, 0, 255), clamp(hi, 0, 255)]
}

/** Vị trí (m) → CH1 (8-bit): round(pos/length × 255), kẹp trong khoảng min–max của module. */
export function posToCh1(pos: number, m: PosRange): number {
  const [lo, hi] = ch1Range(m)
  const raw = m.length > 0 ? Math.round((pos / m.length) * 255) : 0
  return clamp(raw, lo, hi)
}

/** Vị trí (m) của một bước cue theo đơn vị đã lưu: ch1 → ch1ToPos (không kẹp min–max), m → nguyên số. */
export function stepPositionM(step: { position: number; unit?: 'm' | 'ch1' }, length: number): number {
  return step.unit === 'ch1' ? ch1ToPos(clamp(Math.round(step.position), 0, 255), length) : step.position
}

export function ch1ToPos(ch1: number, length: number): number {
  return Math.round((ch1 / 255) * length * 1e6) / 1e6 // bỏ nhiễu dấu phẩy động (1.4999999999999998)
}

/** Vị trí thực tế sau khi kẹp min–max và lượng tử hoá CH1. */
export function snapPos(pos: number, m: PosRange): number {
  return ch1ToPos(posToCh1(pos, m), m.length)
}

/** Tốc độ tối đa của module (cm/s) = "Tốc độ max" người dùng nhập; đồng thời là thang CH3 (255 = maxSpeedCms). */
export function speedCap(m: Pick<ModuleCfg, 'maxSpeedCms'>): number {
  return Math.max(1, m.maxSpeedCms)
}

/** CH3 → tốc độ cm/s (tuyến tính, 255 = maxSpeedCms của module). */
export function ch3ToCms(ch3: number, maxSpeedCms: number): number {
  return (ch3 / 255) * Math.max(1, maxSpeedCms)
}

/** Sai số làm tròn cho phép khi ceil (đơn vị CH3): vd 47.06 cm/s (≈100.0025) với max 120 vẫn ra 100, không nhảy 101. */
const CH3_CEIL_EPS = 0.01

/**
 * Tốc độ cm/s → CH3 theo thang của module (255 = maxSpeedCms), làm tròn LÊN (không chậm hơn yêu cầu nên đoạn
 * không đến muộn), kẹp 1..255 (0 là phanh). Max 120: 47.06 → 100, 60 → 128; max 80: 40 → 128, 80 → 255.
 */
export function cmsToCh3(cms: number, maxSpeedCms: number): number {
  return clamp(Math.ceil((cms / Math.max(1, maxSpeedCms)) * 255 - CH3_CEIL_EPS), 1, 255)
}

export interface DurationConv {
  ch3: number
  /** Thời gian tối thiểu (s) mà motor đi được quãng này ở tốc độ tối đa. */
  minSeconds: number
  tooFast: boolean
}

/** Quãng đường (m) trong N giây → CH3 theo thang maxSpeedCms của module. Làm tròn LÊN (có sai số epsilon). */
export function durationToCh3(distM: number, seconds: number, maxSpeedCms: number): DurationConv {
  const max = Math.max(1, maxSpeedCms)
  const dist = Math.abs(distM)
  const needCms = (dist * 100) / Math.max(seconds, 0.01)
  const ch3 = clamp(Math.ceil((needCms / max) * 255 - CH3_CEIL_EPS), 1, 255)
  return { ch3, minSeconds: (dist * 100) / max, tooFast: needCms > max + 1e-6 }
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
  let totalSpan = 0
  let totalMoved = 0
  let maxEta = 0
  let anyMoving = false
  let allReached = true

  for (const [id, base] of entries) {
    const mod = modById.get(id)
    const st = snapshot?.modules[id]
    const curPos = st?.pos ?? base.start
    const span = base.goal - base.start
    const absSpan = Math.abs(span)
    const distLeft = Math.abs(base.goal - curPos)

    if (st?.moving) anyMoving = true
    if (distLeft > 0.008) allReached = false

    if (absSpan >= 0.005) {
      const p = clamp((curPos - base.start) / span, 0, 1)
      totalSpan += absSpan
      totalMoved += p * absSpan
    }

    if (distLeft > 0.008 && mod) {
      const ch3 = st?.ch3 && st.ch3 > 0 ? st.ch3 : mod.defaultSpeed
      const speedCms = Math.max(1, ch3ToCms(ch3, mod.maxSpeedCms))
      const eta = (distLeft * 100) / speedCms
      if (eta > maxEta) maxEta = eta
    }
  }

  const progress = totalSpan >= 0.005 ? clamp(totalMoved / totalSpan, 0, 1) : 1
  return {
    progress: allReached ? 1 : progress,
    etaSec: allReached ? 0 : maxEta,
    anyMoving,
    reached: allReached,
  }
}

/**
 * Tạo (hoặc giữ nguyên khi resume sau khi pause) mốc start/goal cho thanh tiến trình Cue:
 * nếu tiếp tục chính Cue đang dở và các module vẫn nằm trong hành trình cũ, giữ nguyên `start`
 * để slider chạy tiếp từ % đang tạm dừng thay vì nhảy về 0%.
 */
export function resolveCueButtonBaselines(
  steps: ReadonlyArray<{ moduleId: string; position: number; unit?: 'm' | 'ch1' }>,
  modules: ModuleCfg[],
  snapshot: Pick<Snapshot, 'modules'> | null,
  previous?: Record<string, ManualMotionBaseline> | null,
): Record<string, ManualMotionBaseline> {
  const modById = new Map(modules.map((m) => [m.id, m]))
  const out: Record<string, ManualMotionBaseline> = {}
  for (const s of steps) {
    const m = modById.get(s.moduleId)
    if (!m) continue
    const hi = Math.min(m.maxHeight, m.length)
    const lo = Math.min(Math.max(m.minHeight, 0), hi)
    const curPos = snapshot?.modules[m.id]?.pos ?? lo
    const goal = clamp(stepPositionM(s, m.length), lo, hi)
    const prev = previous?.[m.id]
    const sameGoal = prev !== undefined && Math.abs(prev.goal - goal) < 1e-4
    const minBound = Math.min(prev?.start ?? curPos, goal)
    const maxBound = Math.max(prev?.start ?? curPos, goal)
    const inSpan = sameGoal && curPos >= minBound - 0.005 && curPos <= maxBound + 0.005
    out[m.id] = {
      start: inSpan && prev ? prev.start : curPos,
      goal,
    }
  }
  return out
}

export interface SharedWaveLevel {
  /** Tỉ lệ độ cao chung (1 = ở đỉnh minHeight, 0 = hạ hết maxHeight). */
  ratio: number
  /** Phần trăm độ cao (0..100). */
  percent: number
  /** Có module nào đang chuyển động hay không. */
  moving: boolean
}

/**
 * Tính mức sóng chung cho cả 3 nút Manual (Lên / Dừng / Xuống) theo vị trí thực tế của module:
 * - Lên (về minHeight): mức sóng dâng lên (0% -> 100%).
 * - Xuống (về maxHeight): mức sóng hạ xuống (100% -> 0%).
 * - Dừng: giữ nguyên vị trí hiện tại nên mức sóng giữ nguyên tại % đang dừng.
 */
export function computeSharedManualWaveLevel(
  selectedIds: string[],
  modules: ModuleCfg[],
  snapshot: Pick<Snapshot, 'modules'> | null,
): SharedWaveLevel {
  const idSet = new Set(selectedIds)
  const mods = modules.filter((m) => idSet.has(m.id))
  if (mods.length === 0) {
    return { ratio: 0.32, percent: 32, moving: false }
  }
  let totalSpan = 0
  let totalLifted = 0
  let unweightedSum = 0
  let moving = false

  for (const m of mods) {
    const lo = m.minHeight
    const hi = Math.min(m.length, m.maxHeight)
    const span = Math.max(0, hi - lo)
    const st = snapshot?.modules[m.id]
    if (st?.moving) moving = true
    const curPos = st?.pos ?? lo
    const ratio = span >= 0.005 ? clamp((hi - curPos) / span, 0, 1) : 1
    unweightedSum += ratio
    if (span >= 0.005) {
      totalSpan += span
      totalLifted += ratio * span
    }
  }

  const ratio = totalSpan >= 0.005 ? clamp(totalLifted / totalSpan, 0, 1) : clamp(unweightedSum / mods.length, 0, 1)
  return {
    ratio,
    percent: Math.round(ratio * 100),
    moving,
  }
}

export interface ManualWaveLayout {
  /** Tỉ lệ lấp đầy thực tế trong [0, 1] dùng để kiểm tra & render. */
  ratio: number
  /** Phần trăm hiển thị (0..100). */
  percent: number
  /** Chuỗi CSS transform `translate3d(...)` neo chính xác đường sóng theo tỉ lệ %. */
  transform: string
}

/**
 * Tính vị trí mặt sóng theo đúng tỉ lệ %:
 * - `up` (Lên): mặt sóng đi từ đáy (0% -> translateY(100%)) lên đỉnh (100% -> translateY(0%)).
 * - `down` (Xuống): mặt sóng đi từ đỉnh (0% -> translateY(-100%)) xuống đáy (100% -> translateY(0%)).
 */
export function computeManualWaveLayout(
  dir: 'up' | 'down',
  phase: 'idle' | 'run',
  progress: number,
  idleRatio = 0.32,
): ManualWaveLayout {
  const ratio = phase === 'run' ? clamp(progress, 0, 1) : clamp(idleRatio, 0, 1)
  const percent = Math.round(ratio * 100)
  const remainPct = (1 - ratio) * 100
  if (dir === 'up') {
    return {
      ratio,
      percent,
      transform: `translate3d(0, calc(${remainPct.toFixed(3)}%), 0)`,
    }
  }
  if (phase === 'idle') {
    return {
      ratio,
      percent,
      transform: `translate3d(0, ${remainPct.toFixed(3)}%, 0)`,
    }
  }
  return {
    ratio,
    percent,
    transform: `translate3d(0, calc(-${remainPct.toFixed(3)}%), 0)`,
  }
}
