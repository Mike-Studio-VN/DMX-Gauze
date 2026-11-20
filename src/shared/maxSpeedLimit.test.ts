import { describe, expect, it } from 'vitest'
import { ch3ToCms, cmsToCh3, durationToCh3, speedCap } from './convert'
import { GauzeCore } from './core'
import { MockDriver } from './drivers'
import { H2_MAX_SPEED_CMS, LOCK_VALUE, MODULE_MAX_SPEED_LIMIT_CMS } from './dmx'
import { createDefaultProject, normalizeProject } from './preset'

describe('Tốc độ max không còn trần 120', () => {
  it.each([150, 300])('max %i: lưu/đọc lại giữ nguyên, speedCap không kẹp 120', (max) => {
    const p = createDefaultProject()
    p.modules[0].maxSpeedCms = max
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.modules[0].maxSpeedCms).toBe(max)
    expect(speedCap(back.modules[0])).toBe(max)
  })

  it('CH3 255 = max của module; durationToCh3 không kẹp 120', () => {
    expect(ch3ToCms(255, 300)).toBe(300)
    expect(cmsToCh3(300, 300)).toBe(255)
    expect(cmsToCh3(150, 300)).toBe(128)
    expect(durationToCh3(2.4, 1, 300).ch3).toBe(204) // 240 cm/s trên thang 300
    expect(durationToCh3(2.4, 1, 300).tooFast).toBe(false)
    expect(durationToCh3(4, 1, 300).tooFast).toBe(true) // 400 > 300
  })

  it('core: move 150 cm/s trên module max 300 → CH3 128; vượt max vẫn kẹp 255', () => {
    const project = createDefaultProject()
    const modules = [{ ...project.modules[0], id: 'm', startAddress: 1, length: 3, minHeight: 0, maxHeight: 3, maxSpeedCms: 300 }]
    const core = new GauzeCore((_cfg, ev) => new MockDriver(ev))
    try {
      core.configure({ modules, output: project.settings.output, lockValue: LOCK_VALUE })
      core.command({ type: 'lock', locked: false })
      core.command({ type: 'move', ids: ['m'], target: 1, speed: { unit: 'cms', value: 150 } })
      expect(core.snapshot().modules['m'].ch3).toBe(128)
      core.command({ type: 'move', ids: ['m'], target: 1, speed: { unit: 'cms', value: 999 } })
      expect(core.snapshot().modules['m'].ch3).toBe(255)
    } finally {
      core.stop()
    }
  })

  it('trần hợp lệ = 10000; H2 120 chỉ là mặc định; autoSpeedLimitCms > 120 được đọc', () => {
    expect(MODULE_MAX_SPEED_LIMIT_CMS).toBe(10000)
    expect(createDefaultProject().modules[0].maxSpeedCms).toBe(H2_MAX_SPEED_CMS)
    const p = JSON.parse(JSON.stringify(createDefaultProject()))
    p.modules[0].maxSpeedCms = 10000
    expect(normalizeProject(p).modules[0].maxSpeedCms).toBe(10000)
    p.modules[0].maxSpeedCms = 10001
    expect(() => normalizeProject(p)).toThrow(/maxSpeedCms/)
    p.modules[0].maxSpeedCms = 300
    p.clips = [{ id: 'c', layerId: p.layers[0].id, moduleId: p.modules[0].id, startTime: 0, duration: 4, autoSpeedLimitCms: 200,
      keyframes: [{ id: 'a', offset: 0, height: 0 }, { id: 'b', offset: 4, height: 1 }] }]
    expect(normalizeProject(p).clips?.[0].autoSpeedLimitCms).toBe(200)
  })

  it('project cũ (max 80/120) giữ nguyên giá trị đã lưu', () => {
    const p = createDefaultProject()
    p.modules[0].maxSpeedCms = 80
    p.modules[1].maxSpeedCms = 120
    const back = normalizeProject(JSON.parse(JSON.stringify(p)))
    expect([back.modules[0].maxSpeedCms, back.modules[1].maxSpeedCms]).toEqual([80, 120])
  })
})
