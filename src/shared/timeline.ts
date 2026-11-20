import { ch1Range, ch1ToPos, ch3ToCms, clamp, cmsToCh3, snapPos, speedCap, stepPositionM } from './convert'
import { parseTc, snapDeltaToFps, snapTimeToFps } from './timecode'
import type { ClipKeyframe, Command, CueButton, CueStep, Fps, ModuleCfg, Snapshot, TimelineClip, TimelineKey } from './types'

const MIN_DURATION = 0.05

export const DEFAULT_MOTION_SPEED_CMS = 50

export function defaultMotionSpeedCh3(mod: ModuleCfg, limit = DEFAULT_MOTION_SPEED_CMS): number {
  const max = speedCap(mod)
  const cap = Math.min(max, limit)
  const ch3 = cmsToCh3(cap, max)
  // Timing conversion rounds up. Use the preceding step if that would exceed the motion cap.
  return ch3ToCms(ch3, max) > cap ? ch3 - 1 : ch3
}

export function defaultMotionSpeedCms(mod: ModuleCfg, limit = DEFAULT_MOTION_SPEED_CMS): number {
  return ch3ToCms(defaultMotionSpeedCh3(mod, limit), speedCap(mod))
}

export function defaultCueSpeedCms(modules: ModuleCfg[]): number {
  const speed = Math.min(DEFAULT_MOTION_SPEED_CMS, ...modules.map((mod) => defaultMotionSpeedCms(mod)))
  return Math.floor(speed * 100 + 1e-9) / 100
}

export function roundUpMotionDuration(seconds: number): number {
  return Math.ceil(seconds * 2 - 1e-9) / 2
}

export function clipAutoSpeedCms(mod: ModuleCfg, clip?: TimelineClip): number {
  return clip?.autoSpeedLimitCms === undefined ? speedCap(mod) : defaultMotionSpeedCms(mod, clip.autoSpeedLimitCms)
}

function clipAtTime(clips: TimelineClip[], time: number): TimelineClip | undefined {
  const next = clips.findIndex((clip) => clip.startTime > time)
  return next < 0 ? clips.at(-1) : clips[Math.max(0, next - 1)]
}

export type CurvePresetId = 'flat' | 'sine' | 'bell' | 'triangle' | 'hold' | 'double' | 'steps'

export interface CurvePresetMeta {
  id: CurvePresetId
  label: string
  /** Tỉ lệ (từ 0..1 thời gian, 0..1 biên độ min..max). Đầu và cuối mặc định là 0. */
  points: Array<[number, number]>
}

export const CURVE_PRESETS: CurvePresetMeta[] = [
  {
    id: 'flat',
    label: 'Phẳng (0–0)',
    points: [
      [0, 0],
      [1, 0],
    ],
  },
  {
    id: 'sine',
    label: 'Sóng Sin',
    points: [
      [0, 0],
      [0.25, 0.71],
      [0.5, 1],
      [0.75, 0.71],
      [1, 0],
    ],
  },
  {
    id: 'bell',
    label: 'Vòm mượt',
    points: [
      [0, 0],
      [0.2, 0.25],
      [0.5, 1],
      [0.8, 0.25],
      [1, 0],
    ],
  },
  {
    id: 'triangle',
    label: 'Đỉnh nhọn',
    points: [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ],
  },
  {
    id: 'hold',
    label: 'Lên giữ đỉnh',
    points: [
      [0, 0],
      [0.25, 1],
      [0.75, 1],
      [1, 0],
    ],
  },
  {
    id: 'double',
    label: '2 nhịp sóng',
    points: [
      [0, 0],
      [0.2, 0.85],
      [0.5, 0.2],
      [0.8, 1],
      [1, 0],
    ],
  },
  {
    id: 'steps',
    label: 'Bậc thang',
    points: [
      [0, 0],
      [0.25, 0.45],
      [0.5, 0.75],
      [0.75, 1],
      [1, 0],
    ],
  },
]

/** Tạo danh sách keyframe từ đồ thị mẫu; luôn giữ key đầu và cuối ở minHeight (mặc định 0). */
export function buildCurveKeyframes(
  presetId: CurvePresetId,
  duration: number,
  minHeight: number,
  maxHeight: number,
): ClipKeyframe[] {
  const preset = CURVE_PRESETS.find((p) => p.id === presetId) ?? CURVE_PRESETS[0]
  const lo = Math.max(0, minHeight)
  const hi = Math.max(lo, maxHeight)
  const now = Date.now()
  return preset.points.map(([tNorm, hNorm], idx) => ({
    id: `kf-${now}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
    offset: Number((tNorm * duration).toFixed(2)),
    height: Number((lo + hNorm * (hi - lo)).toFixed(2)),
  }))
}

export type LayerMotionPresetId = 'all-up' | 'all-down' | 'wave' | 'wave-reverse' | 'alternating-wave'

export const DEFAULT_ALTERNATING_WAVE_AMPLITUDE_CM = 10

export interface LayerMotionOptions {
  duration?: number
  staggerSec?: number
  amplitudeCm?: number
  firstUp?: 'odd' | 'even'
}

export interface LayerMotionPresetMeta {
  id: LayerMotionPresetId
  label: string
}

export const LAYER_MOTION_PRESETS: LayerMotionPresetMeta[] = [
  { id: 'all-up', label: 'Tất cả lên' },
  { id: 'all-down', label: 'Tất cả xuống' },
  { id: 'wave', label: 'Sóng' },
  { id: 'wave-reverse', label: 'Sóng ngược' },
  { id: 'alternating-wave', label: 'Sóng so le' },
]

/** Tìm thời điểm gốc chung >= startTime sao cho toàn bộ cửa sổ [base + offset_i, base + offset_i + dur] không đụng clip cũ. */
function findCommonForwardBaseStart(
  ordered: ModuleCfg[],
  existingClips: TimelineClip[],
  baseStart: number,
  duration: number,
  staggerSec: number,
  isWave: boolean,
): number {
  let candidate = baseStart
  const byMod = new Map<string, TimelineClip[]>()
  for (const mod of ordered) {
    byMod.set(
      mod.id,
      existingClips
        .filter((c) => c.moduleId === mod.id)
        .sort((a, b) => a.startTime - b.startTime),
    )
  }

  for (let guard = 0; guard <= existingClips.length + 2; guard += 1) {
    let advanced = false
    for (let idx = 0; idx < ordered.length; idx += 1) {
      const mod = ordered[idx]
      const offset = isWave ? idx * staggerSec : 0
      const winStart = Number((candidate + offset).toFixed(2))
      const winEnd = Number((winStart + duration).toFixed(2))
      for (const c of byMod.get(mod.id) ?? []) {
        const cStart = Math.max(0, c.startTime)
        const cEnd = cStart + Math.max(MIN_DURATION, c.duration)
        if (winStart < cEnd - 1e-6 && winEnd > cStart + 1e-6) {
          // Round forward so a clip ending between centiseconds never leaves the windows overlapping.
          const nextBase = Math.ceil((cEnd - offset) * 100 - 1e-8) / 100
          if (nextBase > candidate + 1e-6) {
            candidate = nextBase
            advanced = true
          }
        }
      }
    }
    if (!advanced) break
  }

  return Number(Math.max(baseStart, candidate).toFixed(2))
}

function buildAlternatingWaveKeyframes(
  clipId: string,
  mod: ModuleCfg,
  period: number,
  requestedAmplitudeCm: number,
  risesFirst: boolean,
  startingHeight: number | null,
): ClipKeyframe[] {
  const hi = Math.min(Math.max(0, mod.maxHeight), mod.length)
  const lo = clamp(mod.minHeight, 0, hi)
  const segments = 8
  // Smooth interpolation constrains the Bézier controls to the segment's endpoints.
  // Its peak speed is bounded by 3 × the largest sample delta divided by the segment duration.
  const maxSpeedAmplitude = (speedCap(mod) * period) / (100 * 3 * segments * Math.SQRT1_2)
  const amplitude = Math.min(requestedAmplitudeCm / 100, (hi - lo) / 2, maxSpeedAmplitude)
  const center = clamp(startingHeight ?? lo, lo + amplitude, Math.max(lo + amplitude, hi - amplitude))
  // DMX position is drop length, so a negative displacement raises the curtain.
  const direction = risesFirst ? -1 : 1
  return Array.from({ length: segments + 1 }, (_, i) => ({
    id: `${clipId}-kf-${i}`,
    offset: (i * period) / segments,
    height: i === segments
      ? center
      : clamp(center + direction * amplitude * Math.sin((2 * Math.PI * i) / segments), lo, hi),
  }))
}

/** Tạo danh sách moment chuyển động trên Timeline cho các module thuộc 1 layer (không ghi đè hoặc sửa moment cũ). */
export function buildLayerMotionClips(opts: LayerMotionOptions & {
  layerId: string
  modules: ModuleCfg[]
  existingClips: TimelineClip[]
  presetId: LayerMotionPresetId
  startTime: number
  duration: number
}): TimelineClip[] {
  const {
    layerId, modules, existingClips, presetId, startTime, duration, staggerSec = 0.35,
    amplitudeCm = DEFAULT_ALTERNATING_WAVE_AMPLITUDE_CM, firstUp = 'odd',
  } = opts
  if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) return []
  if (!Number.isFinite(staggerSec) || staggerSec < 0) return []
  if (presetId === 'alternating-wave' && (!Number.isFinite(amplitudeCm) || amplitudeCm < 0)) return []

  const layerMods = modules.filter((m) => m.layerId === layerId)
  if (layerMods.length === 0) return []

  const safeStart = Math.max(0, Number(startTime.toFixed(2)))
  const safeDuration = Math.max(0.4, Number(duration.toFixed(2)))
  const safeStagger = Math.max(0, Number(staggerSec.toFixed(2)))
  const ordered = presetId === 'wave-reverse' ? [...layerMods].reverse() : layerMods
  const isWave = presetId === 'wave' || presetId === 'wave-reverse'

  const usedIds = new Set(existingClips.map((c) => c.id))
  const now = Date.now()
  let period = safeDuration
  for (;;) {
    const commonBase = findCommonForwardBaseStart(
      ordered,
      existingClips,
      safeStart,
      period,
      safeStagger,
      isWave,
    )

    const created = ordered.map((mod, idx): TimelineClip => {
      const hi = Math.min(Math.max(0, mod.maxHeight), mod.length)
      const lo = Math.min(Math.max(0, mod.minHeight), hi)
      const placedStart = isWave ? Number((commonBase + idx * safeStagger).toFixed(2)) : commonBase

      let clipId = `clip-lp-${now}-${idx}-${Math.random().toString(36).slice(2, 6)}`
      while (usedIds.has(clipId)) {
        clipId = `clip-lp-${now}-${idx}-${Math.random().toString(36).slice(2, 7)}`
      }
      usedIds.add(clipId)

      let keyframes: ClipKeyframe[]
      let curveMode: 'smooth' | 'linear' = 'linear'
      if (presetId === 'all-up') {
        keyframes = [
          { id: `kf-lp-${now}-${idx}-0-${Math.random().toString(36).slice(2, 5)}`, offset: 0, height: Number(hi.toFixed(2)) },
          { id: `kf-lp-${now}-${idx}-1-${Math.random().toString(36).slice(2, 5)}`, offset: period, height: Number(lo.toFixed(2)) },
        ]
      } else if (presetId === 'all-down') {
        keyframes = [
          { id: `kf-lp-${now}-${idx}-0-${Math.random().toString(36).slice(2, 5)}`, offset: 0, height: Number(lo.toFixed(2)) },
          { id: `kf-lp-${now}-${idx}-1-${Math.random().toString(36).slice(2, 5)}`, offset: period, height: Number(hi.toFixed(2)) },
        ]
      } else if (presetId === 'alternating-wave') {
        curveMode = 'smooth'
        const risingParity = firstUp === 'odd' ? 0 : 1
        const startingHeight = evaluateModuleTimelineHeight(existingClips, [], mod, placedStart)
        keyframes = buildAlternatingWaveKeyframes(
          clipId, mod, period, amplitudeCm, idx % 2 === risingParity, startingHeight,
        )
      } else {
        curveMode = 'smooth'
        keyframes = buildCurveKeyframes('sine', period, lo, hi).map((k, kIdx) => ({
          ...k,
          id: `kf-lp-${now}-${idx}-${kIdx}-${Math.random().toString(36).slice(2, 5)}`,
        }))
      }

      return {
        id: clipId,
        layerId,
        moduleId: mod.id,
        startTime: placedStart,
        duration: period,
        curveMode,
        autoSpeedLimitCms: DEFAULT_MOTION_SPEED_CMS,
        keyframes,
      }
    })
    const required = Math.max(...created.map((clip, i) => defaultMotionDuration(clip, ordered[i])))
    if (required <= period) return created
    // Recheck placement with the common duration so synchronization and existing clips are preserved.
    period = required
  }
}

export interface SegmentIssue {
  clipId: string
  moduleId: string
  moduleName: string
  fromTime: number
  toTime: number
  fromHeight: number
  toHeight: number
  requiredCms: number
  maxSpeedCms: number
  minDurationSec: number
  feasible: boolean
}

export interface KeyframeSpeed {
  mode: 'auto' | 'manual'
  /** Tốc độ tự tính (cm/s) = quãng / thời gian, kẹp [1, max]. */
  autoCms: number
  /** Tốc độ sẽ phát (cm/s) theo mode, kẹp [1, max]. */
  cms: number
  /** Manual nhập vượt tốc độ tối đa (đã bị kẹp). */
  overMax: boolean
  /** Manual quá chậm: không tới đích kịp thời gian đoạn. */
  tooSlow: boolean
}

/** Quãng đường thực tế (cm) giữa 2 độ cao sau khi kẹp min–max và lượng tử hoá CH1 (8-bit). */
export function segmentDistCm(mod: Pick<ModuleCfg, 'length' | 'minHeight' | 'maxHeight'>, h1: number, h2: number): number {
  return Math.abs(snapPos(h2, mod) - snapPos(h1, mod)) * 100
}

/** cm/s → giây cho quãng distCm; quãng = 0 hoặc tốc độ ≤ 0 → null (không chia cho 0). */
export function cmsToSeconds(distCm: number, cms: number): number | null {
  return distCm > 1e-9 && cms > 0 ? distCm / cms : null
}

/** giây → cm/s (kẹp [1, capCms]); quãng = 0 hoặc thời gian ≤ 0 → null. */
export function secondsToCms(distCm: number, seconds: number, capCms: number): number | null {
  return distCm > 1e-9 && seconds > 0 ? clamp(distCm / seconds, 1, Math.max(1, capCms)) : null
}

/** Tốc độ của đoạn đi từ điểm `kf` (distCm: quãng tới điểm kế, dtSec: thời gian tới điểm kế). */
export function resolveKeyframeSpeed(
  kf: Pick<ClipKeyframe, 'speedMode' | 'manualSpeedCms'>,
  distCm: number,
  dtSec: number,
  maxSpeedCms: number,
  autoSpeedLimitCms = maxSpeedCms,
): KeyframeSpeed {
  const max = Math.max(1, maxSpeedCms)
  const autoCms = clamp(distCm / Math.max(0.001, dtSec), 1, Math.min(max, autoSpeedLimitCms))
  if (kf.speedMode !== 'manual') return { mode: 'auto', autoCms, cms: autoCms, overMax: false, tooSlow: false }
  const raw = Number.isFinite(kf.manualSpeedCms) ? (kf.manualSpeedCms as number) : autoCms
  const cms = clamp(raw, 1, max)
  return {
    mode: 'manual',
    autoCms,
    cms,
    overMax: raw > max + 1e-3,
    tooSlow: distCm / cms > dtSec + 0.02 && distCm > 0.15,
  }
}

/** Moment có cài đặt tốc độ riêng ở mức moment không (nếu không: hành vi cũ theo từng điểm). */
export function clipSpeedKey(clip: Pick<TimelineClip, 'speedMode' | 'speedUnit' | 'speedValue'>, p1: Pick<ClipKeyframe, 'speedMode' | 'manualSpeedCms'>): string {
  if (clip.speedMode === undefined) return p1.speedMode === 'manual' ? `leg${p1.manualSpeedCms}` : 'a'
  return clip.speedMode === 'auto' ? 'a' : `m:${clip.speedUnit ?? 'cms'}:${clip.speedValue}`
}

/** Moment/điểm này dùng tốc độ manual cho đoạn đi từ p1? (mức moment ưu tiên; thiếu → theo điểm cũ). */
export function isSegmentManual(clip: Pick<TimelineClip, 'speedMode'>, p1: Pick<ClipKeyframe, 'speedMode'>): boolean {
  return clip.speedMode === undefined ? p1.speedMode === 'manual' : clip.speedMode === 'manual'
}

/**
 * Tốc độ manual thô (cm/s, CHƯA kẹp) của đoạn đi từ p1 với quãng distCm; null = auto (hoặc không áp được: giây với quãng 0).
 * cm/s → cùng tốc độ mọi đoạn; CH3 → cùng CH3 (đổi theo max của module); giây → mỗi đoạn đi trong `value` s (cm/s = quãng/giây).
 */
export function manualRawCms(
  clip: Pick<TimelineClip, 'speedMode' | 'speedUnit' | 'speedValue'>,
  p1: Pick<ClipKeyframe, 'speedMode' | 'manualSpeedCms'>,
  distCm: number,
  maxSpeedCms: number,
): number | null {
  if (!isSegmentManual(clip, p1)) return null
  if (clip.speedMode === undefined) return Number.isFinite(p1.manualSpeedCms) ? (p1.manualSpeedCms as number) : null
  const v = clip.speedValue
  if (v === undefined || !Number.isFinite(v)) return null
  switch (clip.speedUnit ?? 'cms') {
    case 'ch3':
      return ch3ToCms(clamp(Math.round(v), 1, 255), maxSpeedCms)
    case 'sec':
      return distCm > 1e-9 && v > 0 ? distCm / v : null
    default:
      return v
  }
}

/** Giá trị nhập tương đương (theo kiểu `unit`) của tốc độ `cms` trên đoạn đại diện dài repDistCm; giây với quãng 0 → null. */
export function momentSpeedValue(unit: 'cms' | 'sec' | 'ch3', cms: number, repDistCm: number, maxSpeedCms: number): number | null {
  if (unit === 'cms') return Number(cms.toFixed(1))
  if (unit === 'ch3') return cmsToCh3(cms, maxSpeedCms)
  const s = cmsToSeconds(repDistCm, cms)
  return s === null ? null : Number(s.toFixed(2))
}

/** Đoạn đại diện để đổi đơn vị: đoạn có quãng đường dài nhất (đầu tiên nếu hoà). */
export function representativeSegmentIndex(distsCm: number[]): number {
  let best = 0
  distsCm.forEach((d, i) => {
    if (d > distsCm[best]) best = i
  })
  return best
}

/**
 * Đặt tốc độ `cms` cho đoạn đi TỚI điểm `kfId` (Auto, sửa cột cm/s hoặc CH3): thời lượng đoạn = quãng ÷ cm/s, các điểm
 * sau dịch cùng một lượng để giữ nguyên thời lượng các đoạn còn lại. Không đổi thứ tự điểm (đoạn tối thiểu 0,02 s).
 * Bị chặn bởi moment kế bên (`bounds.maxEnd`): vượt thì kẹp ⇒ tốc độ đạt được thấp hơn yêu cầu.
 * Điểm đầu hoặc quãng đường 0 ⇒ null (không chia 0, không đổi gì).
 */
export function retimeSegmentToSpeed(
  clip: TimelineClip,
  kfId: string,
  cms: number,
  mod: ModuleCfg,
  bounds?: { minStart: number; maxEnd: number },
): { startTime: number; duration: number; keyframes: ClipKeyframe[] } | null {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const idx = sorted.findIndex((k) => k.id === kfId)
  if (idx < 1 || !Number.isFinite(cms)) return null
  const dist = segmentDistCm(mod, sorted[idx - 1].height, sorted[idx].height)
  if (dist <= 1e-9) return null
  const oldDt = sorted[idx].offset - sorted[idx - 1].offset
  let delta = dist / clamp(cms, 1, speedCap(mod)) - oldDt
  delta = Math.max(delta, 0.02 - oldDt)
  const last = sorted[sorted.length - 1].offset
  if (bounds && Number.isFinite(bounds.maxEnd)) delta = Math.min(delta, bounds.maxEnd - clip.startTime - last)
  if (!Number.isFinite(delta)) return null
  const keyframes = sorted.map((k, j) => (j >= idx ? { ...k, offset: Number((k.offset + delta).toFixed(4)) } : k))
  return { startTime: clip.startTime, duration: keyframes[keyframes.length - 1].offset, keyframes }
}

/** Tốc độ thực của đoạn p1→p2 trong clip theo cài đặt moment (hoặc điểm cũ), kèm cờ cảnh báo. */
export function resolveClipSegmentSpeed(
  clip: TimelineClip,
  p1: ClipKeyframe,
  p2: ClipKeyframe,
  mod: ModuleCfg,
): KeyframeSpeed {
  const distCm = segmentDistCm(mod, p1.height, p2.height)
  const dt = p2.offset - p1.offset
  const cap = speedCap(mod)
  const raw = manualRawCms(clip, p1, distCm, cap)
  return resolveKeyframeSpeed(raw === null ? {} : { speedMode: 'manual', manualSpeedCms: raw }, distCm, dt, cap, clipAutoSpeedCms(mod, clip))
}

/** Đoạn manual đang chạy tại `time` trong clip active; null nếu auto/ngoài đoạn. */
function manualSegmentAt(clips: TimelineClip[], mod: ModuleCfg, time: number): { c: TimelineClip; p1: ClipKeyframe; p2: ClipKeyframe } | null {
  const c = clips.find((x) => x.moduleId === mod.id && time >= x.startTime && time < x.startTime + x.duration)
  if (!c || c.keyframes.length < 2) return null
  const sorted = [...c.keyframes].sort((a, b) => a.offset - b.offset)
  const rel = time - c.startTime
  if (rel < sorted[0].offset || rel >= sorted[sorted.length - 1].offset) return null
  let seg = 0
  while (seg + 1 < sorted.length && sorted[seg + 1].offset <= rel) seg += 1
  const p1 = sorted[seg]
  return isSegmentManual(c, p1) ? { c, p1, p2: sorted[seg + 1] } : null
}

/** Tốc độ manual (cm/s) của đoạn đang chạy tại `time`; null nếu auto/ngoài đoạn. */
function manualSpeedAt(clips: TimelineClip[], mod: ModuleCfg, time: number): number | null {
  const seg = manualSegmentAt(clips, mod, time)
  if (!seg) return null
  const r = resolveClipSegmentSpeed(seg.c, seg.p1, seg.p2, mod)
  return r.mode === 'manual' ? r.cms : null
}

/** CH3 nhập thẳng ở mức moment (đơn vị CH3): gửi đúng số đó (kẹp 1..255), không qua cm/s. null nếu không phải. */
export function momentManualCh3(clip: Pick<TimelineClip, 'speedMode' | 'speedUnit' | 'speedValue'>): number | null {
  return clip.speedMode === 'manual' && clip.speedUnit === 'ch3' && Number.isFinite(clip.speedValue)
    ? clamp(Math.round(clip.speedValue as number), 1, 255)
    : null
}

/** Trả về danh sách các đoạn chuyển động giữa 2 key và kiểm tra có vượt tốc độ tối đa của module không. */
export function analyzeClipSpeeds(clip: TimelineClip, mod: ModuleCfg | undefined): SegmentIssue[] {
  if (!mod || clip.keyframes.length < 2) return []
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const out: SegmentIssue[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const dt = Math.max(0.001, b.offset - a.offset)
    const distCm = segmentDistCm(mod, a.height, b.height)
    const requiredCms = distCm / dt
    const minDurationSec = distCm / Math.max(1, speedCap(mod))
    out.push({
      clipId: clip.id,
      moduleId: mod.id,
      moduleName: mod.name,
      fromTime: clip.startTime + a.offset,
      toTime: clip.startTime + b.offset,
      fromHeight: a.height,
      toHeight: b.height,
      requiredCms,
      maxSpeedCms: speedCap(mod),
      minDurationSec,
      feasible: requiredCms <= speedCap(mod) + 1e-3,
    })
  }
  return out
}

export function analyzeTimeline(clips: TimelineClip[], modules: ModuleCfg[]): SegmentIssue[] {
  const modMap = new Map(modules.map((m) => [m.id, m]))
  return clips.flatMap((c) => analyzeClipSpeeds(c, modMap.get(c.moduleId)))
}

/** Tìm vị trí startTime không bị chồng chéo với các moment khác cùng module. */
export function resolveClipStartNoOverlap(
  sameModuleClips: TimelineClip[],
  duration: number,
  preferredStart: number,
  ignoreClipId?: string,
  fps?: Fps,
): number {
  const desired = fps ? snapTimeToFps(preferredStart, fps) : Math.max(0, preferredStart)
  const others = sameModuleClips
    .filter((c) => c.id !== ignoreClipId)
    .sort((a, b) => a.startTime - b.startTime)
  if (others.length === 0) return Number(desired.toFixed(4))

  const intervals: Array<[number, number]> = []
  let cursor = 0
  for (const c of others) {
    const start = Math.max(0, c.startTime)
    if (start > cursor) intervals.push([cursor, start])
    cursor = Math.max(cursor, start + Math.max(MIN_DURATION, c.duration))
  }
  intervals.push([cursor, Number.POSITIVE_INFINITY])

  let bestStart = cursor
  let bestDist = Number.POSITIVE_INFINITY
  for (const [gapStart, gapEnd] of intervals) {
    if (gapEnd - gapStart + 1e-6 < duration) continue
    const maxAllowed = gapEnd === Number.POSITIVE_INFINITY ? desired : gapEnd - duration
    const rawCand = Math.max(gapStart, Math.min(desired, maxAllowed))
    const snappedCand = fps ? snapTimeToFps(rawCand, fps) : rawCand
    const cand =
      snappedCand >= gapStart - 1e-6 && snappedCand <= maxAllowed + 1e-6
        ? snappedCand
        : rawCand
    const dist = Math.abs(cand - desired)
    if (dist < bestDist - 1e-6) {
      bestDist = dist
      bestStart = cand
    }
  }
  return Number(Math.max(0, bestStart).toFixed(4))
}

/** Giới hạn trái/phải khi trim moment để không chồng chéo moment liền kề. */
export function resolveClipBoundsNoOverlap(
  sameModuleClips: TimelineClip[],
  clip: TimelineClip,
): { minStart: number; maxEnd: number } {
  const sorted = [...sameModuleClips].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  const idx = sorted.findIndex((c) => c.id === clip.id)
  if (idx < 0) return { minStart: 0, maxEnd: Number.POSITIVE_INFINITY }
  const prev = idx > 0 ? sorted[idx - 1] : null
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null
  return {
    minStart: prev ? Number((prev.startTime + prev.duration).toFixed(4)) : 0,
    maxEnd: next ? Number(next.startTime.toFixed(4)) : Number.POSITIVE_INFINITY,
  }
}

/**
 * Chuẩn hoá toàn bộ moment của một module:
 * 1) Không chồng chéo thời gian.
 * 2) Key cuối của moment trước luôn khớp độ cao với key đầu của moment ngay sau.
 */
export function syncModuleClipsContinuity(
  clips: TimelineClip[],
  moduleId: string,
  edited?: { clipId: string; edge: 'start' | 'end' },
): TimelineClip[] {
  const others = clips.filter((c) => c.moduleId !== moduleId)
  const modClips = clips
    .filter((c) => c.moduleId === moduleId)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
    .map((c) => ({
      ...c,
      keyframes: [...c.keyframes].sort((a, b) => a.offset - b.offset),
    }))

  let cursor = 0
  for (let i = 0; i < modClips.length; i++) {
    const c = modClips[i]
    const startTime = Number(Math.max(cursor, Math.max(0, c.startTime)).toFixed(4))
    modClips[i] = { ...c, startTime }
    cursor = startTime + Math.max(MIN_DURATION, c.duration)
  }

  if (edited?.edge === 'start') {
    const idx = modClips.findIndex((c) => c.id === edited.clipId)
    if (idx > 0 && modClips[idx].keyframes.length > 0 && modClips[idx - 1].keyframes.length > 0) {
      const targetH = modClips[idx].keyframes[0].height
      const prevKfs = [...modClips[idx - 1].keyframes]
      prevKfs[prevKfs.length - 1] = { ...prevKfs[prevKfs.length - 1], height: targetH }
      modClips[idx - 1] = { ...modClips[idx - 1], keyframes: prevKfs }
    }
  }

  for (let i = 0; i < modClips.length - 1; i++) {
    const prevKfs = modClips[i].keyframes
    const nextKfs = modClips[i + 1].keyframes
    if (prevKfs.length === 0 || nextKfs.length === 0) continue
    const endH = prevKfs[prevKfs.length - 1].height
    if (nextKfs[0].height !== endH) {
      const patched = [...nextKfs]
      patched[0] = { ...patched[0], height: endH }
      modClips[i + 1] = { ...modClips[i + 1], keyframes: patched }
    }
  }

  return [...others, ...modClips].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
}

const MIN_CLIP_DUR = 0.2

/** Quy đổi độ cao (m) của module sang tỉ lệ phần trăm hành trình 0–100%. */
export function heightToPercent(
  height: number,
  mod: Pick<ModuleCfg, 'minHeight' | 'maxHeight' | 'length'>,
): number {
  const minH = mod.minHeight
  const maxH = Math.max(minH + 0.01, mod.maxHeight ?? mod.length)
  const pct = ((height - minH) / (maxH - minH)) * 100
  return Number(Math.max(0, Math.min(100, pct)).toFixed(1))
}

/** Quy đổi tỉ lệ phần trăm hành trình 0–100% về độ cao (m) của module. */
export function percentToHeight(
  percent: number,
  mod: Pick<ModuleCfg, 'minHeight' | 'maxHeight' | 'length'>,
): number {
  const minH = mod.minHeight
  const maxH = Math.max(minH + 0.01, mod.maxHeight ?? mod.length)
  const pct = Math.max(0, Math.min(100, percent))
  return Number((minH + (pct / 100) * (maxH - minH)).toFixed(3))
}

/** Cập nhật thời gian trên timeline (s) của 1 điểm và tính lại startTime, duration, offset. */
export function updateClipKeyframeTimelineTime(
  clip: TimelineClip,
  keyframeId: string,
  rawTimelineTime: number,
  bounds?: { minStart: number; maxEnd: number },
): { startTime: number; duration: number; keyframes: ClipKeyframe[] } {
  const minAllowed = bounds ? bounds.minStart : 0
  const maxAllowed = bounds && Number.isFinite(bounds.maxEnd) ? bounds.maxEnd : Number.POSITIVE_INFINITY
  const targetAbs = Math.max(minAllowed, Math.min(maxAllowed, Number(rawTimelineTime.toFixed(4))))

  const absPoints = clip.keyframes
    .map((k) => ({
      ...k,
      absTime: k.id === keyframeId ? targetAbs : Number((clip.startTime + k.offset).toFixed(4)),
    }))
    .sort((a, b) => a.absTime - b.absTime)

  let startTime = Number(Math.max(minAllowed, absPoints[0]?.absTime ?? clip.startTime).toFixed(4))
  const lastAbs = absPoints[absPoints.length - 1]?.absTime ?? startTime + MIN_CLIP_DUR
  const duration = Number(Math.max(MIN_CLIP_DUR, lastAbs - startTime).toFixed(4))
  if (Number.isFinite(maxAllowed) && startTime + duration > maxAllowed) {
    startTime = Number(Math.max(minAllowed, maxAllowed - duration).toFixed(4))
  }

  const keyframes = absPoints.map(({ absTime, ...kf }) => ({
    ...kf,
    offset: Number(Math.max(0, Math.min(duration, absTime - startTime)).toFixed(4)),
  }))
  if (keyframes.length >= 2) {
    keyframes[0].offset = 0
    keyframes[keyframes.length - 1].offset = duration
  }

  return { startTime, duration, keyframes }
}

/** Cập nhật `startTime` của moment theo toạ độ Timeline (giây), chặn chồng chéo lân cận. */
export function updateClipStartTime(
  clip: TimelineClip,
  rawStart: number,
  bounds?: { minStart: number; maxEnd: number },
): Partial<TimelineClip> | null {
  if (!Number.isFinite(rawStart)) return null
  const minStart = Math.max(0, Number((bounds?.minStart ?? 0).toFixed(4)))
  if (bounds && Number.isFinite(bounds.maxEnd)) {
    const boundMax = Number(bounds.maxEnd.toFixed(4))
    if (boundMax - minStart < clip.duration - 1e-6) return null
  }
  const maxStart =
    bounds && Number.isFinite(bounds.maxEnd)
      ? Math.max(minStart, Number((bounds.maxEnd - clip.duration).toFixed(4)))
      : Number.POSITIVE_INFINITY
  const startTime = Number(clamp(rawStart, minStart, maxStart).toFixed(4))
  return { startTime }
}

/** Cập nhật điểm kết thúc (giây tuyệt đối trên Timeline) -> co giãn duration & offset keyframe tỉ lệ thuận. */
export function updateClipEndTime(
  clip: TimelineClip,
  rawEnd: number,
  bounds?: { minStart: number; maxEnd: number },
  minDur = 0.4,
): Partial<TimelineClip> | null {
  if (!Number.isFinite(rawEnd)) return null
  const safeMinDur = Math.max(MIN_DURATION, minDur)
  const minEnd = Number((clip.startTime + safeMinDur).toFixed(4))
  if (bounds && Number.isFinite(bounds.maxEnd)) {
    const boundMax = Number(bounds.maxEnd.toFixed(4))
    if (boundMax < minEnd - 1e-6) return null
  }
  const maxEnd =
    bounds && Number.isFinite(bounds.maxEnd)
      ? Number(bounds.maxEnd.toFixed(4))
      : Number.POSITIVE_INFINITY
  const clampedEnd = clamp(Number(rawEnd.toFixed(4)), minEnd, maxEnd)
  const duration = Math.max(safeMinDur, Number((clampedEnd - clip.startTime).toFixed(4)))
  const ratio = duration / Math.max(0.01, clip.duration)
  const keyframes = clip.keyframes.map((k) => ({
    ...k,
    offset: Number((k.offset * ratio).toFixed(4)),
  }))
  return { duration, keyframes }
}

/** Cập nhật độ cao của 1 điểm và trả về biên đồng bộ nếu là điểm đầu/cuối. */
export function updateClipKeyframeHeight(
  clip: TimelineClip,
  keyframeId: string,
  height: number,
  ch1?: number, // CH1 nhập thẳng (lưu nguyên); thiếu = nhập theo m (xoá ch1 cũ)
): { keyframes: ClipKeyframe[]; syncEdge?: 'start' | 'end' } {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const idx = sorted.findIndex((k) => k.id === keyframeId)
  const syncEdge = idx === 0 ? 'start' : idx === sorted.length - 1 ? 'end' : undefined
  const keyframes = sorted.map((k) => (k.id === keyframeId ? { ...k, height, ch1 } : k))
  return { keyframes, syncEdge }
}

/** Chèn thêm 1 điểm mới vào khoảng thời gian rộng nhất trong moment (hoặc tại toạ độ chỉ định). */
export function insertClipKeyframe(
  clip: TimelineClip,
  minHeight: number,
  maxHeight: number,
  target?: { offset: number; height: number },
): { keyframes: ClipKeyframe[]; newKeyId: string } {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  let bestOffset = Number((clip.duration / 2).toFixed(2))
  let bestHeight = Number(((minHeight + maxHeight) / 2).toFixed(2))

  if (target) {
    const safeMinOff = Math.min(clip.duration / 2, 0.02)
    const safeMaxOff = Math.max(safeMinOff, clip.duration - 0.02)
    bestOffset = clamp(Number(target.offset.toFixed(2)), safeMinOff, safeMaxOff)
    bestHeight = Number(target.height.toFixed(2))
  } else if (sorted.length >= 2) {
    let bestGap = -1
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const gap = sorted[i + 1].offset - sorted[i].offset
      if (gap > bestGap) {
        bestGap = gap
        bestOffset = Number(((sorted[i].offset + sorted[i + 1].offset) / 2).toFixed(2))
        bestHeight = Number(((sorted[i].height + sorted[i + 1].height) / 2).toFixed(2))
      }
    }
  }

  const clampedHeight = Math.max(minHeight, Math.min(maxHeight, bestHeight))
  const newKeyId = `kf-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
  const keyframes = [...sorted, { id: newKeyId, offset: bestOffset, height: clampedHeight }].sort(
    (a, b) => a.offset - b.offset,
  )
  return { keyframes, newKeyId }
}

/** Xoá 1 điểm nếu moment vẫn còn tối thiểu 2 điểm; trả về null nếu không thể xoá. */
export function removeClipKeyframe(clip: TimelineClip, keyframeId: string): ClipKeyframe[] | null {
  if (clip.keyframes.length <= 2) return null
  return clip.keyframes.filter((k) => k.id !== keyframeId)
}

/** Điểm điều khiển cubic Bezier dùng chung cho nội suy evaluator và đường cong SVG. */
function computeSegmentControlValues(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  count: number,
  mode: 'smooth' | 'linear',
  minBound: number,
  maxBound: number,
): { c1: number; c2: number } {
  if (mode === 'linear' || count < 3) {
    return {
      c1: v1 + (v2 - v1) / 3,
      c2: v1 + (2 * (v2 - v1)) / 3,
    }
  }
  const segLo = Math.max(minBound, Math.min(v1, v2))
  const segHi = Math.min(maxBound, Math.max(v1, v2))
  return {
    c1: clamp(v1 + (v2 - v0) / 6, segLo, segHi),
    c2: clamp(v2 - (v3 - v1) / 6, segLo, segHi),
  }
}

/** Tốc độ đỉnh của quỹ đạo, tính cả dung sai vị trí do lượng tử CH1 ở các điểm. */
export function clipPeakSpeedCms(clip: TimelineClip, mod: ModuleCfg): number {
  const points = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const hi = Math.min(mod.maxHeight, mod.length)
  const lo = clamp(mod.minHeight, 0, hi)
  const mode = clip.curveMode ?? 'smooth'
  const peak = (heights: number[], i: number) => {
    const start = heights[i]
    const end = heights[i + 1]
    if (mode === 'linear' || points.length < 3) return Math.abs(end - start)
    const { c1, c2 } = computeSegmentControlValues(
      heights[i - 1] ?? start, start, end, heights[i + 2] ?? end, points.length, mode, lo, hi,
    )
    const d0 = c1 - start
    const d1 = c2 - c1
    const d2 = end - c2
    // The derivative is a quadratic Bézier, with at most one interior extremum.
    const u = (d0 - d1) / (d0 - 2 * d1 + d2)
    const inside = u > 0 && u < 1 ? (1 - u) ** 2 * d0 + 2 * (1 - u) * u * d1 + u ** 2 * d2 : 0
    return 3 * Math.max(Math.abs(d0), Math.abs(d2), Math.abs(inside))
  }
  const raw = points.map(({ height }) => clamp(height, lo, hi))
  const snapped = raw.map((height) => snapPos(height, mod))
  return points.slice(1).reduce((max, point, i) => {
    const seconds = Math.max(0.0001, point.offset - points[i].offset)
    return Math.max(max, 100 * Math.max(peak(raw, i), peak(snapped, i)) / seconds)
  }, 0)
}

export function defaultMotionDuration(clip: TimelineClip, mod: ModuleCfg): number {
  const autoSpeedLimitCms = clip.autoSpeedLimitCms ?? DEFAULT_MOTION_SPEED_CMS
  const required = clip.duration * clipPeakSpeedCms(clip, mod) / defaultMotionSpeedCms(mod, autoSpeedLimitCms)
  return required > clip.duration + 1e-9 ? roundUpMotionDuration(required) : clip.duration
}

export function fitDefaultMotionDuration(clip: TimelineClip, mod: ModuleCfg): TimelineClip {
  const autoSpeedLimitCms = clip.autoSpeedLimitCms ?? DEFAULT_MOTION_SPEED_CMS
  const duration = defaultMotionDuration(clip, mod)
  if (duration === clip.duration) return { ...clip, autoSpeedLimitCms }
  const keyframes = clip.keyframes.map((point) => ({ ...point, offset: point.offset / clip.duration * duration }))
  return { ...clip, duration, keyframes, autoSpeedLimitCms }
}

/** Đánh giá độ cao mục tiêu (m) của một module tại thời điểm `time` trên timeline. */
export function evaluateModuleTimelineHeight(
  clips: TimelineClip[],
  keys: TimelineKey[],
  mod: Pick<ModuleCfg, 'id' | 'minHeight' | 'maxHeight' | 'length'>,
  time: number,
): number | null {
  const minH = mod.minHeight
  const maxH = Math.min(mod.length, Math.max(minH, mod.maxHeight))
  const modClips = clips
    .filter((c) => c.moduleId === mod.id && c.keyframes.length > 0)
    .sort((a, b) => a.startTime - b.startTime)

  if (modClips.length > 0) {
    for (let i = 0; i < modClips.length; i += 1) {
      const c = modClips[i]
      const sorted = [...c.keyframes].sort((a, b) => a.offset - b.offset)
      if (time <= c.startTime) {
        if (i === 0) return Math.max(minH, Math.min(maxH, sorted[0].height))
        const prevSorted = [...modClips[i - 1].keyframes].sort((a, b) => a.offset - b.offset)
        return Math.max(minH, Math.min(maxH, prevSorted[prevSorted.length - 1].height))
      }
      if (time <= c.startTime + c.duration) {
        const rel = time - c.startTime
        if (sorted.length === 1 || rel <= sorted[0].offset) {
          return Math.max(minH, Math.min(maxH, sorted[0].height))
        }
        if (rel >= sorted[sorted.length - 1].offset) {
          return Math.max(minH, Math.min(maxH, sorted[sorted.length - 1].height))
        }
        let seg = 0
        while (seg + 1 < sorted.length && sorted[seg + 1].offset < rel) seg += 1
        const p1 = sorted[seg]
        const p2 = sorted[seg + 1]
        const span = Math.max(0.0001, p2.offset - p1.offset)
        const u = Math.max(0, Math.min(1, (rel - p1.offset) / span))
        const mode = c.curveMode ?? 'smooth'
        if (mode === 'linear' || sorted.length < 3) {
          return Math.max(minH, Math.min(maxH, Number((p1.height + (p2.height - p1.height) * u).toFixed(3))))
        }
        const p0 = sorted[seg - 1] ?? p1
        const p3 = sorted[seg + 2] ?? p2
        const { c1, c2 } = computeSegmentControlValues(
          p0.height,
          p1.height,
          p2.height,
          p3.height,
          sorted.length,
          mode,
          minH,
          maxH,
        )
        const inv = 1 - u
        const h =
          inv * inv * inv * p1.height +
          3 * inv * inv * u * c1 +
          3 * inv * u * u * c2 +
          u * u * u * p2.height
        return Math.max(minH, Math.min(maxH, Number(h.toFixed(3))))
      }
    }
    const lastSorted = [...modClips[modClips.length - 1].keyframes].sort((a, b) => a.offset - b.offset)
    return Math.max(minH, Math.min(maxH, lastSorted[lastSorted.length - 1].height))
  }

  const modKeys = keys
    .filter((k) => k.targets[mod.id] !== undefined)
    .sort((a, b) => a.time - b.time)
  if (modKeys.length === 0) return null
  if (time <= modKeys[0].time) return Math.max(minH, Math.min(maxH, modKeys[0].targets[mod.id]))
  for (let i = 0; i < modKeys.length - 1; i += 1) {
    const a = modKeys[i]
    const b = modKeys[i + 1]
    if (time <= b.time) {
      const u = (time - a.time) / Math.max(0.0001, b.time - a.time)
      const h = a.targets[mod.id] + (b.targets[mod.id] - a.targets[mod.id]) * u
      return Math.max(minH, Math.min(maxH, Number(h.toFixed(3))))
    }
  }
  return Math.max(minH, Math.min(maxH, modKeys[modKeys.length - 1].targets[mod.id]))
}

/** Bộ giữ trạng thái đoạn tuyến tính (Thẳng) đang chạy cho từng module để chỉ gửi 1 lệnh mỗi đoạn P. */
export class LinearFollowPlanner {
  private readonly active = new Map<string, string>()

  reset(): void {
    this.active.clear()
  }

  invalidateModule(moduleId: string): void {
    this.active.delete(moduleId)
  }

  getActiveKey(moduleId: string): string | undefined {
    return this.active.get(moduleId)
  }

  setActiveKey(moduleId: string, key: string): void {
    this.active.set(moduleId, key)
  }
}

export interface TimelineFollowPlan {
  commands: Command[]
  warnings: string[]
}

function buildSmoothMoveCommand(
  mod: ModuleCfg,
  clips: TimelineClip[],
  keys: TimelineKey[],
  time: number,
  lookaheadSec: number,
  autoCap: number,
  snap?: Pick<Snapshot, 'modules'> | null,
): Command | null {
  const hNow = evaluateModuleTimelineHeight(clips, keys, mod, time)
  if (hNow === null) return null
  // Đích thực tế sau lượng tử hoá CH1: so sánh dedupe với target đã snap trong core.
  const hAhead = snapPos(
    lookaheadSec > 0 ? (evaluateModuleTimelineHeight(clips, keys, mod, time + lookaheadSec) ?? hNow) : hNow,
    mod,
  )

  const st = snap?.modules[mod.id]
  const curPos = st?.pos ?? hNow
  const curTarget = st?.target ?? curPos
  if (st && Math.abs(hAhead - curTarget) < 0.0015 && Math.abs(hAhead - curPos) < 0.0015) {
    return null
  }

  let speedCms: number
  if (lookaheadSec <= 0) {
    speedCms = autoCap
  } else {
    const velCurveCms = (Math.abs(hAhead - hNow) * 100) / Math.max(0.02, lookaheadSec)
    const lagError = Math.abs(hNow - curPos)
    speedCms =
      lagError > 0.08
        ? autoCap
        : clamp(velCurveCms + (lagError * 100) / 0.25, 1, autoCap)
    speedCms = manualSpeedAt(clips, mod, time) ?? speedCms
  }
  const seg = lookaheadSec > 0 ? manualSegmentAt(clips, mod, time) : null
  const ch3Direct = seg ? momentManualCh3(seg.c) : null

  return {
    type: 'move',
    ids: [mod.id],
    target: hAhead,
    speed: ch3Direct !== null ? { unit: 'ch3', value: ch3Direct } : { unit: 'cms', value: Number(speedCms.toFixed(2)) },
  }
}

/**
 * Lập kế hoạch lệnh DMX cho Timeline:
 * - Chế độ Mượt (`smooth`): bám liên tục theo lookahead.
 * - Chế độ Thẳng (`linear`): gửi đúng 1 lệnh target + speed hiệu chuẩn ở đầu mỗi đoạn P (hoặc sau seek/unlock),
 *   giữ ổn định trong suốt đoạn, không gửi lại mỗi khung hình, và cảnh báo 1 lần nếu đoạn vượt quá tốc độ tối đa.
 */
export function planTimelineFollow(
  modules: ModuleCfg[],
  clips: TimelineClip[],
  keys: TimelineKey[],
  time: number,
  lookaheadSec = 0.06,
  snap?: Pick<Snapshot, 'modules'> | null,
  planner?: LinearFollowPlanner,
): TimelineFollowPlan {
  const commands: Command[] = []
  const warnings: string[] = []

  for (const mod of modules) {
    const modClips = clips
      .filter((c) => c.moduleId === mod.id && c.keyframes.length > 0)
      .sort((a, b) => a.startTime - b.startTime)
    const autoCap = Math.min(
      clipAutoSpeedCms(mod, clipAtTime(modClips, time)),
      clipAutoSpeedCms(mod, clipAtTime(modClips, time + Math.max(0, lookaheadSec))),
    )

    if (lookaheadSec <= 0 || modClips.length === 0) {
      planner?.invalidateModule(mod.id)
      const cmd = buildSmoothMoveCommand(mod, clips, keys, time, lookaheadSec, autoCap, snap)
      if (cmd) commands.push(cmd)
      continue
    }

    const activeIdx = modClips.findIndex((c) => time >= c.startTime && time < c.startTime + c.duration)
    const activeClip = activeIdx >= 0 ? modClips[activeIdx] : null

    if (activeClip && (activeClip.curveMode ?? 'smooth') !== 'linear') {
      planner?.invalidateModule(mod.id)
      const cmd = buildSmoothMoveCommand(mod, clips, keys, time, lookaheadSec, autoCap, snap)
      if (cmd) commands.push(cmd)
      continue
    }

    const minH = mod.minHeight
    const maxH = Math.min(mod.length, Math.max(minH, mod.maxHeight))
    const clampH = (h: number) => snapPos(Math.max(minH, Math.min(maxH, h)), mod)

    let targetH: number
    let segKey: string
    let remainingSec: number | null = null
    let segLabel = ''
    let defaultFromH: number
    let manualSeg: { clip: TimelineClip; p1: ClipKeyframe } | null = null

    if (activeClip) {
      const sorted = [...activeClip.keyframes].sort((a, b) => a.offset - b.offset)
      const rel = time - activeClip.startTime
      if (sorted.length === 1 || rel < sorted[0].offset) {
        targetH = clampH(sorted[0].height)
        defaultFromH = targetH
        const rem = sorted[0].offset - rel
        remainingSec = rem > 0.02 ? rem : null
        segKey = `pre:${activeClip.id}:${sorted[0].id}:${activeClip.startTime}:${sorted[0].offset}:${targetH}:${minH}:${maxH}:${speedCap(mod)}`
      } else if (rel >= sorted[sorted.length - 1].offset) {
        targetH = clampH(sorted[sorted.length - 1].height)
        defaultFromH = targetH
        segKey = `tail:${activeClip.id}:${sorted[sorted.length - 1].id}:${activeClip.startTime}:${activeClip.duration}:${targetH}:${minH}:${maxH}`
      } else {
        let seg = 0
        while (seg + 1 < sorted.length && sorted[seg + 1].offset <= rel) seg += 1
        const p1 = sorted[seg]
        const p2 = sorted[seg + 1]
        targetH = clampH(p2.height)
        defaultFromH = clampH(p1.height)
        remainingSec = Math.max(0.02, activeClip.startTime + p2.offset - time)
        segLabel = `P${seg + 1}→P${seg + 2}`
        manualSeg = isSegmentManual(activeClip, p1) ? { clip: activeClip, p1 } : null
        segKey = `seg:${activeClip.id}:${p1.id}:${p2.id}:${activeClip.startTime}:${activeClip.duration}:${p1.offset}:${p2.offset}:${targetH}:${minH}:${maxH}:${speedCap(mod)}:${clipSpeedKey(activeClip, p1)}`
      }
    } else if (time < modClips[0].startTime) {
      if ((modClips[0].curveMode ?? 'smooth') !== 'linear') {
        planner?.invalidateModule(mod.id)
        const cmd = buildSmoothMoveCommand(mod, clips, keys, time, lookaheadSec, autoCap, snap)
        if (cmd) commands.push(cmd)
        continue
      }
      const firstSorted = [...modClips[0].keyframes].sort((a, b) => a.offset - b.offset)
      targetH = clampH(firstSorted[0].height)
      defaultFromH = targetH
      segKey = `preroll:${modClips[0].id}:${firstSorted[0].id}:${modClips[0].startTime}:${targetH}:${minH}:${maxH}`
    } else {
      let prevIdx = 0
      for (let i = 0; i < modClips.length; i += 1) {
        if (modClips[i].startTime + modClips[i].duration <= time) prevIdx = i
      }
      const prevClip = modClips[prevIdx]
      if ((prevClip.curveMode ?? 'smooth') !== 'linear') {
        planner?.invalidateModule(mod.id)
        const cmd = buildSmoothMoveCommand(mod, clips, keys, time, lookaheadSec, autoCap, snap)
        if (cmd) commands.push(cmd)
        continue
      }
      const prevSorted = [...prevClip.keyframes].sort((a, b) => a.offset - b.offset)
      const lastKf = prevSorted[prevSorted.length - 1]
      targetH = clampH(lastKf.height)
      defaultFromH = targetH
      segKey = `hold:${prevClip.id}:${lastKf.id}:${prevClip.startTime}:${prevClip.duration}:${targetH}:${minH}:${maxH}`
    }

    segKey = `${autoCap}:${segKey}`
    if (planner && planner.getActiveKey(mod.id) === segKey) {
      continue
    }
    planner?.setActiveKey(mod.id, segKey)

    const st = snap?.modules[mod.id]
    const curPos = st?.pos ?? defaultFromH
    const curTarget = st?.target ?? curPos
    if (st && Math.abs(targetH - curPos) < 0.0015 && Math.abs(targetH - curTarget) < 0.0015) {
      continue
    }

    const distM = Math.abs(targetH - curPos)
    let speedCms: number
    let ch3Direct: number | null = null
    const rawManual = manualSeg ? manualRawCms(manualSeg.clip, manualSeg.p1, distM * 100, speedCap(mod)) : null
    if (rawManual !== null && remainingSec !== null && distM >= 0.0015) {
      const r = resolveKeyframeSpeed({ speedMode: 'manual', manualSpeedCms: rawManual }, distM * 100, remainingSec, speedCap(mod))
      speedCms = r.cms
      ch3Direct = manualSeg ? momentManualCh3(manualSeg.clip) : null
      if (r.overMax) {
        warnings.push(`${mod.name} (${segLabel}): tốc độ manual ${rawManual.toFixed(1)} cm/s > tối đa ${speedCap(mod)} cm/s, đã kẹp`)
      }
      if (r.tooSlow) {
        warnings.push(
          `${mod.name} (${segLabel}): manual ${r.cms.toFixed(0)} cm/s không kịp tới đích trong ${remainingSec.toFixed(2)}s (cần ${((distM * 100) / r.cms).toFixed(2)}s)`,
        )
      }
    } else if (remainingSec === null || distM < 0.0015) {
      speedCms = autoCap
    } else {
      const requiredCms = (distM * 100) / remainingSec
      if (requiredCms > autoCap + 1e-3) {
        const achievableSec = (distM * 100) / autoCap
        warnings.push(
          `${mod.name} (${segLabel || 'đoạn thẳng'}): cần ${requiredCms.toFixed(0)} cm/s (> ${Number(autoCap.toFixed(2))} cm/s, cần ${achievableSec.toFixed(2)}s thay vì ${remainingSec.toFixed(2)}s)`,
        )
        speedCms = autoCap
      } else {
        speedCms = clamp(requiredCms, 1, autoCap)
      }
    }

    commands.push({
      type: 'move',
      ids: [mod.id],
      target: targetH,
      speed: ch3Direct !== null ? { unit: 'ch3', value: ch3Direct } : { unit: 'cms', value: Number(speedCms.toFixed(2)) },
    })
  }

  return { commands, warnings }
}

/**
 * Tạo tập lệnh DMX theo dõi đường cong timeline (Mượt dùng lookahead liên tục, Thẳng dùng từng đoạn P).
 */
export function buildTimelineFollowCommands(
  modules: ModuleCfg[],
  clips: TimelineClip[],
  keys: TimelineKey[],
  time: number,
  lookaheadSec = 0.06,
  snap?: Pick<Snapshot, 'modules'> | null,
  planner?: LinearFollowPlanner,
): Command[] {
  return planTimelineFollow(modules, clips, keys, time, lookaheadSec, snap, planner).commands
}

export interface MarqueeClipRect {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

export interface MarqueeBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Trả về danh sách ID clip giao với vùng kéo chọn (hỗ trợ kéo theo mọi hướng). */
export function computeMarqueeSelectedClipIds(rects: readonly MarqueeClipRect[], box: MarqueeBox): string[] {
  const minX = Math.min(box.x1, box.x2)
  const maxX = Math.max(box.x1, box.x2)
  const minY = Math.min(box.y1, box.y2)
  const maxY = Math.max(box.y1, box.y2)
  return rects
    .filter((r) => r.right >= minX && r.left <= maxX && r.bottom >= minY && r.top <= maxY)
    .map((r) => r.id)
}

/** Áp dụng mẫu sóng hoặc chế độ đường, giữ chỗ cho những moment có giới hạn Auto. */
export function buildPresetPatchForClips(
  clips: TimelineClip[],
  modules: ModuleCfg[],
  targetClipIds: readonly string[],
  opts: { presetId?: CurvePresetId; curveMode?: 'smooth' | 'linear' },
): TimelineClip[] | null {
  if (targetClipIds.length === 0 || (!opts.presetId && !opts.curveMode)) return null
  const targetSet = new Set(targetClipIds)
  const modMap = new Map(modules.map((m) => [m.id, m]))
  let matched = 0

  for (const c of clips) {
    if (!targetSet.has(c.id)) continue
    if (!modMap.has(c.moduleId)) return null
    matched += 1
  }
  if (matched === 0) return null

  const nextClips = clips.map((c, idx) => {
    if (!targetSet.has(c.id)) return c
    const mod = modMap.get(c.moduleId)!
    const hi = Math.min(mod.length, Math.max(mod.minHeight, mod.maxHeight))
    const lo = Math.min(Math.max(0, mod.minHeight), hi)
    const nextCurveMode: 'smooth' | 'linear' =
      opts.curveMode ??
      (opts.presetId === 'triangle' || opts.presetId === 'steps' || opts.presetId === 'hold' ? 'linear' : 'smooth')
    const keyframes = opts.presetId
      ? buildCurveKeyframes(opts.presetId, c.duration, lo, hi).map((kf, kIdx) => ({
          ...kf,
          id: `kf-grp-${Date.now()}-${idx}-${kIdx}-${Math.random().toString(36).slice(2, 5)}`,
        }))
      : c.keyframes
    const updated = {
      ...c,
      curveMode: nextCurveMode,
      keyframes,
    }
    return opts.presetId || c.autoSpeedLimitCms !== undefined ? fitDefaultMotionDuration(updated, mod) : updated
  })

  const overlaps = nextClips.some((c, idx) => c.duration > clips[idx].duration && nextClips.some((other) =>
    other.id !== c.id && other.moduleId === c.moduleId &&
    c.startTime < other.startTime + other.duration - 1e-6 && c.startTime + c.duration > other.startTime + 1e-6,
  ))
  return overlaps ? null : nextClips
}

/** Cập nhật đồng loạt `startTime` hoặc `endTime` cho nhóm clip đang chọn, từ chối nguyên tử nếu vượt biên/chồng lấn. */
export function buildTimingPatchForSelectedClips(
  clips: TimelineClip[],
  targetClipIds: readonly string[],
  opts: { startTime?: number; endTime?: number },
  minDur = 0.4,
): TimelineClip[] | null {
  if (targetClipIds.length === 0) return null
  if (opts.startTime === undefined && opts.endTime === undefined) return null
  if (opts.startTime !== undefined && (!Number.isFinite(opts.startTime) || opts.startTime < 0)) return null
  if (opts.endTime !== undefined && (!Number.isFinite(opts.endTime) || opts.endTime < minDur)) return null

  const targetSet = new Set(targetClipIds)
  const unselected = clips.filter((c) => !targetSet.has(c.id))
  let matched = 0

  const nextClips = clips.map((c) => {
    if (!targetSet.has(c.id)) return c
    matched += 1
    const othersSameMod = unselected.filter((u) => u.moduleId === c.moduleId)

    if (opts.startTime !== undefined) {
      const nextStart = Number(Math.max(0, opts.startTime).toFixed(2))
      const nextEnd = nextStart + c.duration
      const collides = othersSameMod.some((u) => {
        const uEnd = u.startTime + Math.max(MIN_DURATION, u.duration)
        return nextStart < uEnd - 1e-6 && nextEnd > u.startTime + 1e-6
      })
      if (collides) return null
      return { ...c, startTime: nextStart }
    }

    const rawEnd = Number(opts.endTime!.toFixed(2))
    if (rawEnd < Number((c.startTime + minDur).toFixed(2)) - 1e-6) return null
    const nextClipAfter = othersSameMod
      .filter((u) => u.startTime >= c.startTime + c.duration - 1e-6)
      .sort((a, b) => a.startTime - b.startTime)[0]
    const maxEnd = nextClipAfter ? Number(nextClipAfter.startTime.toFixed(2)) : Number.POSITIVE_INFINITY
    if (rawEnd > maxEnd + 1e-6) return null

    const patch = updateClipEndTime(c, rawEnd, { minStart: 0, maxEnd }, minDur)
    if (!patch) return null
    return { ...c, ...patch }
  })

  if (matched === 0 || nextClips.some((c) => c === null)) return null
  const resolved = nextClips as TimelineClip[]

  // Kiểm tra hai clip cùng module không tự chồng lấn nhau sau khi cập nhật nhóm.
  const byMod = new Map<string, TimelineClip[]>()
  for (const c of resolved) {
    const arr = byMod.get(c.moduleId) ?? []
    arr.push(c)
    byMod.set(c.moduleId, arr)
  }
  for (const modClips of byMod.values()) {
    const sorted = [...modClips].sort((a, b) => a.startTime - b.startTime)
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const endA = sorted[i].startTime + Math.max(MIN_DURATION, sorted[i].duration)
      if (endA > sorted[i + 1].startTime + 1e-6) return null
    }
  }

  return resolved
}

/** Tính delta tịnh tiến hợp lệ (giữ nguyên khoảng cách tương đối, chặn biên 0 và clip không được chọn) rồi tạo mảng clip mới. */
export function buildMultiClipShiftPatch(
  clips: TimelineClip[],
  selectedIds: readonly string[],
  rawDeltaSec: number,
  origStarts?: ReadonlyMap<string, number>,
  fps?: Fps,
): { clips: TimelineClip[]; delta: number } | null {
  if (!Number.isFinite(rawDeltaSec) || selectedIds.length === 0) return null
  const selSet = new Set(selectedIds)
  const selected = clips.filter((c) => selSet.has(c.id))
  if (selected.length === 0) return null
  const unselected = clips.filter((c) => !selSet.has(c.id))

  let minDelta = Number.NEGATIVE_INFINITY
  let maxDelta = Number.POSITIVE_INFINITY

  for (const s of selected) {
    const baseStart = origStarts?.get(s.id) ?? s.startTime
    minDelta = Math.max(minDelta, -baseStart)
    const baseEnd = baseStart + Math.max(MIN_DURATION, s.duration)

    for (const u of unselected) {
      if (u.moduleId !== s.moduleId) continue
      const uEnd = u.startTime + Math.max(MIN_DURATION, u.duration)
      if (uEnd <= baseStart + 1e-6) {
        minDelta = Math.max(minDelta, uEnd - baseStart)
      } else if (u.startTime >= baseEnd - 1e-6) {
        maxDelta = Math.min(maxDelta, u.startTime - baseEnd)
      }
    }
  }

  if (minDelta > maxDelta + 1e-6) return null
  const candidateDelta = fps ? snapDeltaToFps(rawDeltaSec, fps) : rawDeltaSec
  const delta = Number(clamp(candidateDelta, minDelta, maxDelta).toFixed(4))
  const nextClips = clips.map((c) => {
    if (!selSet.has(c.id)) return c
    const baseStart = origStarts?.get(c.id) ?? c.startTime
    return { ...c, startTime: Number(Math.max(0, baseStart + delta).toFixed(4)) }
  })
  return { clips: nextClips, delta }
}

/** Phân tích chuỗi người dùng nhập khi double-click nhãn playhead (số giây như "3.5", "3,5", "12s" hoặc timecode "hh:mm:ss:ff"). */
export function parseTimelineSecondsInput(raw: string, fps: Fps, dropFrame?: boolean): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.includes(':') || trimmed.includes(';')) {
    return parseTc(trimmed, fps, dropFrame)
  }
  const normalized = trimmed.replace(/s$/i, '').trim().replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null
  const num = Number(normalized)
  return Number.isFinite(num) ? num : null
}

export interface CurvePt {
  x: number
  y: number
}

export interface CurvePad {
  left: number
  right: number
  top: number
  bottom: number
}

function normalizeCurvePad(padX: number | CurvePad, padY?: number): CurvePad {
  if (typeof padX === 'object') return padX
  const y = padY ?? padX
  return { left: padX, right: padX, top: y, bottom: y }
}

/** Quy đổi danh sách keyframe sang toạ độ SVG (dùng chung cho Timeline và Thuộc tính Moment). */
export function mapKeyframesToPts(
  kfs: ClipKeyframe[],
  duration: number,
  minH: number,
  maxH: number,
  width: number,
  height: number,
  padX: number | CurvePad = 6,
  padY = 5,
): CurvePt[] {
  const pad = normalizeCurvePad(padX, padY)
  const usableW = Math.max(4, width - pad.left - pad.right)
  const usableH = Math.max(4, height - pad.top - pad.bottom)
  const span = Math.max(0.1, maxH - minH)
  const dur = Math.max(0.01, duration)
  return kfs.map((k) => {
    const tNorm = clamp(k.offset / dur, 0, 1)
    const hNorm = clamp((k.height - minH) / span, 0, 1)
    return {
      x: pad.left + tNorm * usableW,
      y: pad.top + (1 - hNorm) * usableH,
    }
  })
}

/** Sinh path cubic Bezier mượt khớp hoàn toàn với hàm nội suy evaluateModuleTimelineHeight cho đoạn i -> i+1. */
export function segmentPath(
  pts: CurvePt[],
  i: number,
  mode: 'smooth' | 'linear',
  minY: number,
  maxY: number,
): string {
  const p1 = pts[i]
  const p2 = pts[i + 1]
  if (!p1 || !p2) return ''
  if (mode === 'linear' || pts.length < 3) {
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  const p0 = pts[i - 1] ?? p1
  const p3 = pts[i + 2] ?? p2
  const dx = p2.x - p1.x
  const c1x = p1.x + dx / 3
  const c2x = p1.x + (2 * dx) / 3
  const { c1: c1y, c2: c2y } = computeSegmentControlValues(p0.y, p1.y, p2.y, p3.y, pts.length, mode, minY, maxY)

  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
}

/** Nối toàn bộ các đoạn thành 1 SVG path khép mở liên tục. */
export function fullCurvePath(pts: CurvePt[], mode: 'smooth' | 'linear', minY: number, maxY: number): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = segmentPath(pts, i, mode, minY, maxY)
    const cmdStart = seg.indexOf(' L ') >= 0 ? seg.indexOf(' L ') : seg.indexOf(' C ')
    if (cmdStart >= 0) d += seg.slice(cmdStart)
  }
  return d
}

// ---- Đơn vị hiển thị/nhập: GIÁ TRỊ LƯU giữ nguyên theo đơn vị người dùng nhập; đổi menu chỉ đổi cách hiển thị ----

export type SpeedViewUnit = 'cms' | 'sec' | 'ch3'

/** Giá trị đã lưu → cm/s tương đương (ch3 theo thang max module, sec theo quãng đại diện); null nếu giây với quãng 0. */
export function storedSpeedAsCms(unit: SpeedViewUnit, value: number, repDistCm: number, maxSpeedCms: number): number | null {
  if (unit === 'cms') return value
  if (unit === 'ch3') return ch3ToCms(clamp(Math.round(value), 1, 255), maxSpeedCms)
  return repDistCm > 1e-9 && value > 0 ? repDistCm / value : null
}

/**
 * Giá trị HIỂN THỊ của tốc độ đã lưu (storedUnit, value) theo menu `view`: cùng đơn vị → đúng số đã lưu (không quy đổi);
 * khác đơn vị → quy đổi tạm (không ghi đè). null khi không đổi được (giây với quãng 0).
 */
export function speedDisplayValue(
  view: SpeedViewUnit,
  storedUnit: SpeedViewUnit,
  value: number,
  repDistCm: number,
  maxSpeedCms: number,
): number | null {
  if (view === storedUnit) return value
  const cms = storedSpeedAsCms(storedUnit, value, repDistCm, maxSpeedCms)
  if (cms === null) return null
  if (view === 'cms') return Number(cms.toFixed(2))
  if (view === 'ch3') return cmsToCh3(cms, maxSpeedCms)
  return repDistCm > 1e-9 ? Number((repDistCm / cms).toFixed(2)) : null
}

/** Giá trị người dùng nhập theo `unit` → giá trị lưu (nguyên số; CH3 làm tròn nguyên 1..255, còn lại ≥ 0,1). */
export function speedStoredFromInput(unit: SpeedViewUnit, raw: number): number {
  return unit === 'ch3' ? clamp(Math.round(raw), 1, 255) : Math.max(0.1, raw)
}

export function cueSpeedView(b: Pick<CueButton, 'speedUnit' | 'speedView'>): SpeedViewUnit {
  return b.speedView ?? b.speedUnit
}

/** Quãng đường đại diện (cm) của cue: lớn nhất |đích − vị trí hiện tại|; nếu 0 thì lớn nhất |đích − minHeight|. */
export function cueRepDistanceCm(
  steps: ReadonlyArray<{ moduleId: string; position: number; unit?: 'm' | 'ch1' }>,
  modules: ReadonlyArray<Pick<ModuleCfg, 'id' | 'minHeight' | 'length'>>,
  posOf: (moduleId: string) => number | undefined,
): number {
  const mod = new Map(modules.map((m) => [m.id, m]))
  let fromPos = 0
  let fromMin = 0
  for (const s of steps) {
    const m = mod.get(s.moduleId)
    if (!m) continue
    const goal = stepPositionM(s, m.length)
    fromPos = Math.max(fromPos, Math.abs(goal - (posOf(s.moduleId) ?? m.minHeight)) * 100)
    fromMin = Math.max(fromMin, Math.abs(goal - m.minHeight) * 100)
  }
  return fromPos > 1e-9 ? fromPos : fromMin
}

// ---- Độ cao các điểm trong moment: lưu NGUYÊN theo đơn vị nhập (m hoặc CH1); đổi menu chỉ đổi hiển thị ----

type HeightMod = Pick<ModuleCfg, 'length' | 'minHeight' | 'maxHeight'>

/** CH1 đã nhập của điểm, chỉ khi còn khớp `height` (height bị sửa chỗ khác ⇒ bỏ qua). */
export function keyframeCh1(kf: Pick<ClipKeyframe, 'height' | 'ch1'>, mod: Pick<ModuleCfg, 'length'>): number | undefined {
  return kf.ch1 !== undefined && Math.abs(ch1ToPos(kf.ch1, mod.length) - kf.height) < 1e-4 ? kf.ch1 : undefined
}

export function mToCh1Raw(m: number, length: number): number {
  return clamp(Math.round((m / Math.max(0.001, length)) * 255), 0, 255)
}

/** Giá trị hiển thị độ cao của điểm theo menu: cùng đơn vị lưu → đúng số lưu; khác → quy đổi tạm. */
export function keyframeHeightDisplay(kf: Pick<ClipKeyframe, 'height' | 'ch1'>, view: 'm' | 'ch1', mod: Pick<ModuleCfg, 'length'>): number {
  const stored = keyframeCh1(kf, mod)
  if (view === 'ch1') return stored ?? mToCh1Raw(kf.height, mod.length)
  return Number(kf.height.toFixed(3))
}

/** Dải độ cao hợp lệ theo đơn vị: m = [min, min(max,length)]; CH1 = ch1Range (kẹp theo min–max module). */
export function heightRange(mod: HeightMod, view: 'm' | 'ch1'): [number, number] {
  if (view === 'ch1') return ch1Range(mod)
  const lo = Math.max(0, mod.minHeight)
  return [lo, Math.min(mod.length, Math.max(lo, mod.maxHeight))]
}

/** Nhập độ cao theo đơn vị đang chọn → {height (m), ch1?}. CH1 lưu nguyên số (kẹp theo min–max), m lưu số m (bỏ ch1). */
export function keyframeHeightFromInput(raw: number, view: 'm' | 'ch1', mod: HeightMod): { height: number; ch1?: number } {
  if (view === 'ch1') {
    const [lo, hi] = ch1Range(mod)
    const ch1 = clamp(Math.round(raw), lo, hi)
    return { height: ch1ToPos(ch1, mod.length), ch1 }
  }
  const [lo, hi] = heightRange(mod, 'm')
  return { height: clamp(raw, lo, hi) }
}

// ---- Cue: áp dụng chung vị trí + tốc độ cho các module đang được tích ----

/** Một bước cue từ số người dùng nhập theo `unit`: m kẹp [min, max] (2 chữ số), CH1 làm tròn + kẹp ch1Range của module. */
export function cueStepFromInput(raw: number, unit: 'm' | 'ch1', m: Pick<ModuleCfg, 'id' | 'length' | 'minHeight' | 'maxHeight'>): CueStep {
  if (unit === 'ch1') {
    const [lo, hi] = ch1Range(m)
    return { moduleId: m.id, position: clamp(Math.round(raw), lo, hi), unit: 'ch1' }
  }
  return { moduleId: m.id, position: Number(clamp(raw, m.minHeight, m.maxHeight).toFixed(2)) }
}

/** Đặt lại vị trí của bước nhưng GIỮ tốc độ riêng (speedUnit/speedValue) của nó. */
export function stepWithPosition(old: CueStep, next: CueStep): CueStep {
  return { ...next, ...(old.speedValue === undefined ? {} : { speedUnit: old.speedUnit, speedValue: old.speedValue }) }
}

/** Tốc độ hiệu lực của một bước: riêng của bước nếu có, không thì tốc độ chung của cue. */
export function stepSpeed(btn: Pick<CueButton, 'speedUnit' | 'speedValue'>, step: CueStep): { unit: SpeedViewUnit; value: number } {
  return step.speedValue !== undefined && step.speedUnit !== undefined
    ? { unit: step.speedUnit, value: step.speedValue }
    : { unit: btn.speedUnit, value: btn.speedValue }
}

/** Tóm tắt tốc độ các module của cue (cho nhãn nút): giống nhau → {unit,value}; khác nhau → null. Auto: dùng tốc độ chung. */
export function cueSpeedSummary(btn: Pick<CueButton, 'speedUnit' | 'speedValue' | 'steps' | 'autoSpeedLimitCms'>): { unit: SpeedViewUnit; value: number } | null {
  if (btn.autoSpeedLimitCms !== undefined || btn.steps.length === 0) return { unit: btn.speedUnit, value: btn.speedValue }
  const first = stepSpeed(btn, btn.steps[0])
  return btn.steps.every((s) => {
    const x = stepSpeed(btn, s)
    return x.unit === first.unit && x.value === first.value
  })
    ? first
    : null
}

/**
 * Áp CẢ HAI giá trị cho các module ĐANG TÍCH (có trong steps): `pos` (theo btn.positionUnit, lưu nguyên vào từng CueStep,
 * kẹp theo min–max từng module) và `spd` (theo đơn vị đang chọn → speedUnit/speedValue của cue, chỉ khi Manual). null = không đổi.
 * Module bỏ tích giữ nguyên. `clamped` = tên module bị kẹp.
 */
export function applyCueValues(
  btn: CueButton,
  modules: ReadonlyArray<ModuleCfg>,
  input: { pos: number | null; spd: number | null },
): { btn: CueButton; clamped: string[]; reason?: 'none-selected' | 'nothing' | 'auto-speed' } {
  const modById = new Map(modules.map((m) => [m.id, m]))
  if (!btn.steps.some((s) => modById.has(s.moduleId))) return { btn, clamped: [], reason: 'none-selected' }
  const auto = btn.autoSpeedLimitCms !== undefined
  const speedGiven = input.spd !== null && !auto
  if (input.pos === null && !speedGiven) return { btn, clamped: [], reason: input.spd !== null ? 'auto-speed' : 'nothing' }
  const unit = btn.positionUnit ?? 'm'
  const clamped: string[] = []
  let next = btn
  if (input.pos !== null) {
    const wanted = unit === 'ch1' ? Math.round(input.pos) : Number(input.pos.toFixed(2))
    next = {
      ...next,
      steps: btn.steps.map((s) => {
        const m = modById.get(s.moduleId)
        if (!m) return s
        const stored = cueStepFromInput(input.pos as number, unit, m)
        if (stored.position !== wanted) clamped.push(m.name)
        return stepWithPosition(s, stored)
      }),
    }
  }
  if (speedGiven) {
    // Tốc độ ghi vào TỪNG bước của module đang tích (tốc độ riêng); tốc độ chung của cue giữ nguyên làm mặc định.
    const view = cueSpeedView(btn)
    const stored = speedStoredFromInput(view, input.spd as number)
    next = {
      ...next,
      steps: next.steps.map((s) => (modById.has(s.moduleId) ? { ...s, speedUnit: view, speedValue: stored } : s)),
      speedView: view,
      autoSpeedLimitCms: undefined,
    }
  }
  return { btn: next, clamped }
}

// ---- Chuyển Auto ⇄ Manual không mất giá trị Manual đã nhập ----

/** Patch khi đổi chế độ tốc độ moment. Auto giữ speedUnit/speedValue; Manual dùng lại giá trị đã lưu, nếu chưa có thì `fallback`. */
export function momentModePatch(
  clip: Pick<TimelineClip, 'speedMode' | 'speedUnit' | 'speedValue'>,
  target: 'auto' | 'manual',
  fallback: { unit: 'cms' | 'sec' | 'ch3'; value: number },
): Partial<Pick<TimelineClip, 'speedMode' | 'speedUnit' | 'speedValue'>> {
  if (target === 'auto') return { speedMode: 'auto' }
  if (clip.speedValue !== undefined && Number.isFinite(clip.speedValue)) {
    return { speedMode: 'manual', speedUnit: clip.speedUnit ?? 'cms', speedValue: clip.speedValue }
  }
  return { speedMode: 'manual', speedUnit: fallback.unit, speedValue: fallback.value }
}

/** Cue: Auto cất tốc độ Manual vào `manualSpeed` rồi dùng tốc độ mặc định; Manual khôi phục lại. */
export function cueModeSwitch(btn: CueButton, target: 'auto' | 'manual', defaultCms: number, autoLimitCms: number): CueButton {
  const isAuto = btn.autoSpeedLimitCms !== undefined
  if ((target === 'auto') === isAuto) return btn
  if (target === 'auto') {
    return {
      ...btn,
      manualSpeed: { unit: btn.speedUnit, value: btn.speedValue },
      speedUnit: 'cms',
      speedValue: defaultCms,
      speedView: undefined,
      autoSpeedLimitCms: autoLimitCms,
    }
  }
  const { manualSpeed, ...rest } = btn
  return manualSpeed
    ? { ...rest, speedUnit: manualSpeed.unit, speedValue: manualSpeed.value, speedView: undefined, autoSpeedLimitCms: undefined }
    : { ...rest, autoSpeedLimitCms: undefined }
}
