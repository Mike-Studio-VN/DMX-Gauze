import type { Command, TimelineKey } from './types'

const MIN_DURATION = 0.05

/**
 * Chuyển key timeline thành lệnh di chuyển. Mỗi đoạn giữa 2 key gửi một lệnh:
 * đích = key sau, thời gian = phần còn lại của đoạn (không stream từng frame).
 */
export class TimelineRunner {
  private last = new Map<string, string>()

  reset(): void {
    this.last.clear()
  }

  update(time: number, keys: TimelineKey[]): Command[] {
    const moduleIds = new Set<string>()
    for (const k of keys) for (const id of Object.keys(k.targets)) moduleIds.add(id)
    const cmds: Command[] = []
    for (const id of moduleIds) {
      const ks = keys.filter((k) => k.targets[id] !== undefined).sort((a, b) => a.time - b.time)
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
