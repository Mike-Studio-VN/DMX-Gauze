import { describe, expect, it } from 'vitest'
import { GauzeCore } from './core'
import { MockDriver } from './drivers'
import { CH, LOCK_VALUE } from './dmx'
import { createDefaultProject } from './preset'

describe('GauzeCore', () => {
  it('mặc định khoá an toàn (CH4=0), mở khoá mới gửi CH4=77 và di chuyển trong min/max', () => {
    let now = 1000
    let lastDriver: MockDriver | null = null
    const core = new GauzeCore((_cfg, ev) => {
      lastDriver = new MockDriver(ev)
      return lastDriver
    }, () => now)

    const p = createDefaultProject()
    core.configure({
      modules: [p.modules[0]], // length=1, min=0, max=1, startAddress=1
      output: p.settings.output,
      lockValue: LOCK_VALUE,
    })
    core.start()

    // Bị khoá -> từ chối move
    expect(core.command({ type: 'move', ids: [p.modules[0].id], target: 0.5, speed: { unit: 'cms', value: 120 } }).ok).toBe(false)
    core.tick()
    expect(core.snapshot().frame[CH.LOCK]).toBe(0)

    // Mở khoá -> cho phép move, clamp vào min/max
    core.command({ type: 'lock', locked: false })
    const res = core.command({ type: 'move', ids: [p.modules[0].id], target: 2, speed: { unit: 'cms', value: 120 } })
    expect(res.ok).toBe(true)
    expect(res.warnings?.length).toBe(1)

    now += 250 // 0.25s * 120cm/s = 0.3m
    core.tick()
    now += 250 // tổng 0.5s = 0.6m
    core.tick()
    const snap = core.snapshot()
    expect(snap.frame[CH.LOCK]).toBe(77)
    expect(snap.modules[p.modules[0].id].pos).toBeCloseTo(0.6, 2)
    expect(snap.modules[p.modules[0].id].target).toBe(1)

    // E-Stop khoá lại ngay và giữ vị trí hiện tại
    core.command({ type: 'estop' })
    core.tick()
    const after = core.snapshot()
    expect(after.locked).toBe(true)
    expect(after.frame[CH.LOCK]).toBe(0)
    expect(after.modules[p.modules[0].id].target).toBeCloseTo(0.6, 2)
    expect(lastDriver!.sent).toBeGreaterThan(0)
    core.stop()
  })
})
