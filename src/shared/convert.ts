// Quy đổi mét / tốc độ / giây ⇄ giá trị DMX (xem plan mục 8.2).
import { DMX_FINE_TUNE_LIMIT } from './dmx'
import type { ModuleCfg, Snapshot } from './types'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function normalizeDmxFineTune(offset: number): number {
  return Number.isFinite(offset) ? clamp(Math.round(offset), -DMX_FINE_TUNE_LIMIT, DMX_FINE_TUNE_LIMIT) : 0
}

/** Vị trí (m) → CH1 (coarse) + CH2 (fine), cộng độ lệch trước khi tách hai byte. */
export function posToDmx(pos: number, length: number, fineTune = 0): { coarse: number; fine: number } {
  const position = Math.round(clamp(length > 0 ? pos / length : 0, 0, 1) * 65535)
  const calibrated = clamp(position + normalizeDmxFineTune(fineTune), 0, 65535)
  return { coarse: calibrated >> 8, fine: calibrated & 0xff }
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
  steps: ReadonlyArray<{ moduleId: string; position: number }>,
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
    const goal = clamp(s.position, lo, hi)
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
