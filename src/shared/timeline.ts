import type { Command, ModuleCfg, TimelineClip, TimelineKey } from './types'

const MIN_DURATION = 0.05

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
