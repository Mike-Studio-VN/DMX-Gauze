import type { ClipKeyframe, Command, ModuleCfg, TimelineClip, TimelineKey } from './types'

const MIN_DURATION = 0.05

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

/** Trả về danh sách các đoạn chuyển động giữa 2 key và kiểm tra có vượt tốc độ tối đa của module không. */
export function analyzeClipSpeeds(clip: TimelineClip, mod: ModuleCfg | undefined): SegmentIssue[] {
  if (!mod || clip.keyframes.length < 2) return []
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const out: SegmentIssue[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const dt = Math.max(0.001, b.offset - a.offset)
    const distCm = Math.abs(b.height - a.height) * 100
    const requiredCms = distCm / dt
    const minDurationSec = distCm / Math.max(1, mod.maxSpeedCms)
    out.push({
      clipId: clip.id,
      moduleId: mod.id,
      moduleName: mod.name,
      fromTime: clip.startTime + a.offset,
      toTime: clip.startTime + b.offset,
      fromHeight: a.height,
      toHeight: b.height,
      requiredCms,
      maxSpeedCms: mod.maxSpeedCms,
      minDurationSec,
      feasible: requiredCms <= mod.maxSpeedCms + 1e-3,
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
): number {
  const desired = Math.max(0, preferredStart)
  const others = sameModuleClips
    .filter((c) => c.id !== ignoreClipId)
    .sort((a, b) => a.startTime - b.startTime)
  if (others.length === 0) return Number(desired.toFixed(2))

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
    const cand = Math.max(gapStart, Math.min(desired, maxAllowed))
    const dist = Math.abs(cand - desired)
    if (dist < bestDist - 1e-6) {
      bestDist = dist
      bestStart = cand
    }
  }
  return Number(Math.max(0, bestStart).toFixed(2))
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
    minStart: prev ? Number((prev.startTime + prev.duration).toFixed(2)) : 0,
    maxEnd: next ? Number(next.startTime.toFixed(2)) : Number.POSITIVE_INFINITY,
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
    const startTime = Number(Math.max(cursor, Math.max(0, c.startTime)).toFixed(2))
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

/** Chuyển mảng TimelineClip thành TimelineKey[] theo từng module để chạy thống nhất. */
export function clipsToKeys(clips: TimelineClip[]): TimelineKey[] {
  const keys: TimelineKey[] = []
  for (const c of clips) {
    const sorted = [...c.keyframes].sort((a, b) => a.offset - b.offset)
    for (const kf of sorted) {
      keys.push({
        id: `${c.id}:${kf.id}`,
        time: c.startTime + kf.offset,
        targets: { [c.moduleId]: kf.height },
      })
    }
  }
  return keys.sort((a, b) => a.time - b.time)
}

/**
 * Chuyển key timeline thành lệnh di chuyển. Mỗi đoạn giữa 2 key gửi một lệnh:
 * đích = key sau, thời gian = phần còn lại của đoạn (tự truyền speed phù hợp theo tốc độ của module).
 */
export class TimelineRunner {
  private last = new Map<string, string>()

  reset(): void {
    this.last.clear()
  }

  update(time: number, keys: TimelineKey[], clips?: TimelineClip[]): Command[] {
    const allKeys = clips && clips.length > 0 ? [...keys, ...clipsToKeys(clips)] : keys
    const moduleIds = new Set<string>()
    for (const k of allKeys) for (const id of Object.keys(k.targets)) moduleIds.add(id)
    const cmds: Command[] = []
    for (const id of moduleIds) {
      const ks = allKeys.filter((k) => k.targets[id] !== undefined).sort((a, b) => a.time - b.time)
      if (!ks.length) continue
      const prev = this.last.get(id)
      let sig: string
      if (time < ks[0].time) sig = 'pre'
      else if (time >= ks[ks.length - 1].time) sig = 'end'
      else {
        let j = 0
        while (j + 1 < ks.length - 1 && ks[j + 1].time <= time) j += 1
        sig = `seg:${j}`
      }
      if (sig === prev) continue
      this.last.set(id, sig)
      if (sig === 'pre') continue
      if (sig === 'end') {
        const natural = ks.length >= 2 && prev === `seg:${ks.length - 2}`
        if (!natural) cmds.push({ type: 'move', ids: [id], target: ks[ks.length - 1].targets[id], speed: { unit: 'default' } })
        continue
      }
      const j = Number(sig.slice(4))
      const next = ks[j + 1]
      cmds.push({
        type: 'move',
        ids: [id],
        target: next.targets[id],
        speed: { unit: 'sec', value: Math.max(MIN_DURATION, next.time - time) },
      })
    }
    return cmds
  }
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
  const targetAbs = Math.max(minAllowed, Math.min(maxAllowed, Number(rawTimelineTime.toFixed(2))))

  const absPoints = clip.keyframes
    .map((k) => ({
      ...k,
      absTime: k.id === keyframeId ? targetAbs : Number((clip.startTime + k.offset).toFixed(2)),
    }))
    .sort((a, b) => a.absTime - b.absTime)

  let startTime = Number(Math.max(minAllowed, absPoints[0]?.absTime ?? clip.startTime).toFixed(2))
  const lastAbs = absPoints[absPoints.length - 1]?.absTime ?? startTime + MIN_CLIP_DUR
  const duration = Number(Math.max(MIN_CLIP_DUR, lastAbs - startTime).toFixed(2))
  if (Number.isFinite(maxAllowed) && startTime + duration > maxAllowed) {
    startTime = Number(Math.max(minAllowed, maxAllowed - duration).toFixed(2))
  }

  const keyframes = absPoints.map(({ absTime, ...kf }) => ({
    ...kf,
    offset: Number(Math.max(0, Math.min(duration, absTime - startTime)).toFixed(2)),
  }))
  if (keyframes.length >= 2) {
    keyframes[0].offset = 0
    keyframes[keyframes.length - 1].offset = duration
  }

  return { startTime, duration, keyframes }
}

/** Cập nhật độ cao của 1 điểm và trả về biên đồng bộ nếu là điểm đầu/cuối. */
export function updateClipKeyframeHeight(
  clip: TimelineClip,
  keyframeId: string,
  height: number,
): { keyframes: ClipKeyframe[]; syncEdge?: 'start' | 'end' } {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const idx = sorted.findIndex((k) => k.id === keyframeId)
  const syncEdge = idx === 0 ? 'start' : idx === sorted.length - 1 ? 'end' : undefined
  const keyframes = sorted.map((k) => (k.id === keyframeId ? { ...k, height } : k))
  return { keyframes, syncEdge }
}

/** Chèn thêm 1 điểm mới vào khoảng thời gian rộng nhất trong moment. */
export function insertClipKeyframe(
  clip: TimelineClip,
  minHeight: number,
  maxHeight: number,
): { keyframes: ClipKeyframe[]; newKeyId: string } {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  let bestOffset = Number((clip.duration / 2).toFixed(2))
  let bestHeight = Number(((minHeight + maxHeight) / 2).toFixed(2))

  if (sorted.length >= 2) {
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
        if (c.curveMode === 'linear') {
          return Math.max(minH, Math.min(maxH, Number((p1.height + (p2.height - p1.height) * u).toFixed(3))))
        }
        // Nội suy Catmull-Rom khớp với đồ thị mượt trên Timeline
        const p0 = sorted[seg - 1] ?? p1
        const p3 = sorted[seg + 2] ?? p2
        const c1 = p1.height + (p2.height - p0.height) / 6
        const c2 = p2.height - (p3.height - p1.height) / 6
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
