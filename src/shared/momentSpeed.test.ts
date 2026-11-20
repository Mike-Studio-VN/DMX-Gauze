import { describe, expect, it } from 'vitest'
import { cmsToCh3 } from './convert'
import { createDefaultProject, normalizeProject } from './preset'
import {
  LinearFollowPlanner,
  manualRawCms,
  momentSpeedValue,
  planTimelineFollow,
  representativeSegmentIndex,
  resolveClipSegmentSpeed,
} from './timeline'
import type { ModuleCfg, TimelineClip } from './types'

// length 2.55 m → 1 bước CH1 = 1 cm (độ cao tròn cm không bị lượng tử hoá); max 100 cm/s.
const mod: ModuleCfg = {
  id: 'm1', name: 'M1', layerId: 'l', length: 2.55, width: 1, minHeight: 0, maxHeight: 2.55,
  startAddress: 1, maxSpeedCms: 100, defaultSpeed: 100,
}
// 3 đoạn: P1→P2 100 cm / 4 s, P2→P3 50 cm / 2 s, P3→P4 50 cm / 4 s
const clip = (over: Partial<TimelineClip> = {}, p1: object = {}): TimelineClip => ({
  id: 'c', layerId: 'l', moduleId: 'm1', startTime: 0, duration: 12, curveMode: 'linear',
  keyframes: [
    { id: 'a', offset: 0, height: 0, ...p1 },
    { id: 'b', offset: 4, height: 1 },
    { id: 'c', offset: 6, height: 1.5 },
    { id: 'd', offset: 10, height: 2 },
  ],
  ...over,
})
// Tốc độ planner gửi ở đầu từng đoạn (t = 0, 4, 6) — mỗi đoạn dùng planner mới.
const speeds = (c: TimelineClip) =>
  [0, 4, 6].map((t) => {
    const plan = planTimelineFollow([mod], [c], [], t, 0.06, null, new LinearFollowPlanner())
    const cmd = plan.commands[0]
    return { v: cmd?.type === 'move' ? (cmd.speed as { value: number }).value : null, w: plan.warnings }
  })

describe('tốc độ mức moment', () => {
  it('Auto: mọi đoạn tự tính quãng ÷ thời gian (25 cm/s ở đoạn 1)', () => {
    const s = speeds(clip({ speedMode: 'auto' }))
    expect(s[0].v).toBeCloseTo(25, 0)
    expect(s.every((x) => x.v !== null && x.v <= 100)).toBe(true)
  })

  it.each([
    ['cm/s', { speedMode: 'manual', speedUnit: 'cms', speedValue: 60 } as const, [60, 60, 60]],
    ['CH3', { speedMode: 'manual', speedUnit: 'ch3', speedValue: 128 } as const, [128, 128, 128]], // CH3 nhập thẳng: lệnh mang đúng số CH3, không qua cm/s
  ])('Manual %s: mọi đoạn cùng tốc độ', (_n, over, expected) => {
    const s = speeds(clip(over))
    expected.forEach((e, i) => expect(s[i].v).toBeCloseTo(e, 1))
  })

  it('Manual s: mỗi đoạn đi trong N giây (cm/s = quãng ÷ s) mà không dời điểm', () => {
    const c = clip({ speedMode: 'manual', speedUnit: 'sec', speedValue: 2 })
    const s = speeds(c)
    expect(s[0].v).toBeCloseTo(50, 0) // 100 cm / 2 s (quãng thực 100.0)
    expect(c.keyframes.map((k) => k.offset)).toEqual([0, 4, 6, 10]) // không đổi điểm/thứ tự
    expect(s[0].w).toEqual([]) // 2 s < 4 s: tới sớm, không cảnh báo
  })

  it('vượt max → kẹp + cảnh báo; quá chậm → cảnh báo', () => {
    const over = speeds(clip({ speedMode: 'manual', speedUnit: 'cms', speedValue: 999 }))
    expect(over[0].v).toBe(100)
    expect(over[0].w[0]).toMatch(/kẹp/)
    const slow = speeds(clip({ speedMode: 'manual', speedUnit: 'cms', speedValue: 5 }))
    expect(slow[0].v).toBe(5)
    expect(slow[0].w[0]).toMatch(/không kịp/)
    const ch3over = speeds(clip({ speedMode: 'manual', speedUnit: 'ch3', speedValue: 999 })) // kẹp 255
    expect(ch3over[0].v).toBe(255)
  })

  it('moment cũ (không có speedMode) giữ hành vi theo từng điểm; mức moment ưu tiên và bỏ qua điểm', () => {
    const legacy = clip({}, { speedMode: 'manual', manualSpeedCms: 33 })
    expect(speeds(legacy)[0].v).toBe(33) // y như cũ
    expect(speeds(legacy)[1].v).not.toBe(33) // đoạn 2 vẫn auto như cũ
    const upgraded = clip({ speedMode: 'manual', speedUnit: 'cms', speedValue: 70 }, { speedMode: 'manual', manualSpeedCms: 33 })
    expect(speeds(upgraded).map((x) => x.v)).toEqual([70, 70, 70])
    const auto = clip({ speedMode: 'auto' }, { speedMode: 'manual', manualSpeedCms: 33 })
    expect(speeds(auto)[0].v).not.toBe(33)
  })

  it('đổi kiểu nhập hai chiều cho giá trị tương đương trên đoạn đại diện (dài nhất); quãng 0 → null', () => {
    const rep = 200 // cm
    const cms = 80
    const sec = momentSpeedValue('sec', cms, rep, 100)! // 2.5 s
    const ch3 = momentSpeedValue('ch3', cms, rep, 100)! // ceil(80/100×255)=204
    expect(sec).toBe(2.5)
    expect(ch3).toBe(204)
    // ngược lại: s → cm/s → s, CH3 → cm/s → CH3
    expect(momentSpeedValue('sec', rep / sec, rep, 100)).toBe(sec)
    const back = manualRawCms({ speedMode: 'manual', speedUnit: 'ch3', speedValue: ch3 }, {}, rep, 100)!
    expect(cmsToCh3(back, 100)).toBe(ch3)
    expect(momentSpeedValue('cms', cms, rep, 100)).toBe(80)
    expect(momentSpeedValue('sec', 50, 0, 100)).toBeNull()
    expect(manualRawCms({ speedMode: 'manual', speedUnit: 'sec', speedValue: 2 }, {}, 0, 100)).toBeNull()
    expect(representativeSegmentIndex([100, 50, 200, 200])).toBe(2)
    expect(representativeSegmentIndex([0, 0])).toBe(0)
  })

  it('resolveClipSegmentSpeed: manual s quá ngắn bị kẹp max + overMax', () => {
    const c = clip({ speedMode: 'manual', speedUnit: 'sec', speedValue: 0.1 })
    const r = resolveClipSegmentSpeed(c, c.keyframes[0], c.keyframes[1], mod)
    expect(r.cms).toBe(100)
    expect(r.overMax).toBe(true)
  })

  it('lưu/đọc: round-trip mức moment; moment cũ không ghi field; giá trị sai bị từ chối', () => {
    const p = createDefaultProject()
    p.clips = [
      clip({ speedMode: 'manual', speedUnit: 'ch3', speedValue: 100 }),
      { ...clip({ speedMode: 'auto' }), id: 'c2' },
      { ...clip(), id: 'c3' },
    ]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.clips?.[0]).toMatchObject({ speedMode: 'manual', speedUnit: 'ch3', speedValue: 100 })
    expect(back.clips?.[1]).toMatchObject({ speedMode: 'auto' })
    expect(back.clips?.[2]).not.toHaveProperty('speedMode')
    const bad = JSON.parse(JSON.stringify(p))
    bad.clips[0].speedUnit = 'kmh'
    expect(() => normalizeProject(bad)).toThrow(/speedUnit/)
    bad.clips[0].speedUnit = 'cms'
    delete bad.clips[0].speedValue
    expect(() => normalizeProject(bad)).toThrow(/speedValue/)
  })
})
