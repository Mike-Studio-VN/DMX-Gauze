import { describe, expect, it } from 'vitest'
import { cmsToCh3 } from './convert'
import { createDefaultProject, normalizeProject } from './preset'
import { LinearFollowPlanner, cmsToSeconds, planTimelineFollow, resolveKeyframeSpeed, secondsToCms, segmentDistCm } from './timeline'
import type { ModuleCfg, TimelineClip } from './types'

const mod: ModuleCfg = {
  id: 'm1', name: 'M1', layerId: 'l', length: 4, width: 1, minHeight: 0, maxHeight: 4,
  startAddress: 1, maxSpeedCms: 100, defaultSpeed: 100,
}
const clipOf = (mode: 'linear' | 'smooth', p1: object = {}): TimelineClip => ({
  id: 'c', layerId: 'l', moduleId: 'm1', startTime: 0, duration: 10, curveMode: mode,
  keyframes: [
    { id: 'a', offset: 0, height: 0, ...p1 },
    { id: 'b', offset: 2, height: 1 },
    { id: 'c', offset: 10, height: 1 },
  ],
})
const move = (c: TimelineClip, t: number, look = 0.06) => {
  const plan = planTimelineFollow([mod], [c], [], t, look, null, new LinearFollowPlanner())
  const cmd = plan.commands[0]
  return { speed: cmd?.type === 'move' ? (cmd.speed as { value: number }).value : null, warnings: plan.warnings }
}

describe('resolveKeyframeSpeed', () => {
  it('auto = quãng/thời gian, kẹp [1,max]', () => {
    expect(resolveKeyframeSpeed({}, 100, 2, 120)).toMatchObject({ mode: 'auto', cms: 50, tooSlow: false })
    expect(resolveKeyframeSpeed({}, 1000, 2, 120).cms).toBe(120)
    expect(resolveKeyframeSpeed({}, 0, 2, 120).cms).toBe(1)
  })
  it('manual: 0 → 1, vượt max → kẹp + overMax, quá chậm → tooSlow', () => {
    expect(resolveKeyframeSpeed({ speedMode: 'manual', manualSpeedCms: 0 }, 100, 2, 120).cms).toBe(1)
    const over = resolveKeyframeSpeed({ speedMode: 'manual', manualSpeedCms: 500 }, 100, 2, 120)
    expect(over).toMatchObject({ cms: 120, overMax: true, tooSlow: false })
    expect(resolveKeyframeSpeed({ speedMode: 'manual', manualSpeedCms: 10 }, 100, 2, 120).tooSlow).toBe(true)
  })
  it('thời gian rất ngắn không chia 0', () => {
    expect(Number.isFinite(resolveKeyframeSpeed({}, 100, 0, 120).autoCms)).toBe(true)
    expect(resolveKeyframeSpeed({ speedMode: 'manual', manualSpeedCms: 30 }, 100, 0, 120).tooSlow).toBe(true)
  })
  it('CH3 qua hàm convert hiện có', () => {
    expect(cmsToCh3(resolveKeyframeSpeed({ speedMode: 'manual', manualSpeedCms: 60 }, 100, 2, 120).cms)).toBe(128)
  })
})

describe('planner theo mode', () => {
  it('Thẳng: auto giữ nguyên (100cm/2s = 50), manual thay bằng giá trị nhập, một lệnh mỗi đoạn', () => {
    expect(move(clipOf('linear'), 0).speed).toBeCloseTo(50.2, 1) // quãng 1 m lượng tử hoá CH1 (4 m/255) = 100.39 cm
    const m = move(clipOf('linear', { speedMode: 'manual', manualSpeedCms: 80 }), 0)
    expect(m.speed).toBe(80)
    expect(m.warnings).toEqual([])
  })
  it('Thẳng: manual quá chậm / vượt max cảnh báo', () => {
    expect(move(clipOf('linear', { speedMode: 'manual', manualSpeedCms: 10 }), 0).warnings[0]).toMatch(/không kịp/)
    const over = move(clipOf('linear', { speedMode: 'manual', manualSpeedCms: 999 }), 0)
    expect(over.speed).toBe(100)
    expect(over.warnings[0]).toMatch(/kẹp/)
  })
  it('Thẳng: không gửi lại trong cùng đoạn', () => {
    const planner = new LinearFollowPlanner()
    const c = clipOf('linear', { speedMode: 'manual', manualSpeedCms: 80 })
    expect(planTimelineFollow([mod], [c], [], 0, 0.06, null, planner).commands).toHaveLength(1)
    expect(planTimelineFollow([mod], [c], [], 0.5, 0.06, null, planner).commands).toHaveLength(0)
  })
  it('Mượt: manual đặt CH3 cố định trong đoạn, ngoài đoạn dùng auto', () => {
    const c = clipOf('smooth', { speedMode: 'manual', manualSpeedCms: 30 })
    expect(move(c, 0.5).speed).toBe(30)
    expect(move(clipOf('smooth'), 0.5).speed).not.toBe(30)
  })
})

describe('lưu/đọc keyframe speed', () => {
  it('round-trip manual; project cũ = auto, không có field', () => {
    const p = createDefaultProject()
    p.clips = [clipOf('linear', { speedMode: 'manual', manualSpeedCms: 42.5 })]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.clips?.[0].keyframes[0]).toMatchObject({ speedMode: 'manual', manualSpeedCms: 42.5 })
    expect(back).toEqual(normalizeProject(p))
    expect(back.clips?.[0].keyframes[1]).not.toHaveProperty('speedMode')
    const old = normalizeProject({ ...JSON.parse(JSON.stringify(p)), clips: [clipOf('linear')] })
    expect(old.clips?.[0].keyframes.every((k) => k.speedMode === undefined)).toBe(true)
  })
  it('từ chối mode/giá trị sai', () => {
    const p = JSON.parse(JSON.stringify(createDefaultProject()))
    p.clips = [clipOf('linear', { speedMode: 'weird' })]
    expect(() => normalizeProject(p)).toThrow(/speedMode/)
    p.clips = [clipOf('linear', { speedMode: 'manual' })]
    expect(() => normalizeProject(p)).toThrow(/manualSpeedCms/)
  })
})

describe('đổi s ⇄ cm/s theo quãng đường thực tế', () => {
  it('hai chiều cho giá trị tương đương, quãng 0 không chia cho 0', () => {
    expect(cmsToSeconds(100, 50)).toBe(2)
    expect(secondsToCms(100, 2, 120)).toBe(50)
    const cms = 37.5
    expect(secondsToCms(80, cmsToSeconds(80, cms)!, 120)).toBeCloseTo(cms, 10)
    expect(secondsToCms(100, 0.1, 120)).toBe(120) // kẹp trần
    expect(secondsToCms(100, 1000, 120)).toBe(1) // kẹp sàn
    expect(cmsToSeconds(0, 50)).toBeNull()
    expect(secondsToCms(0, 2, 120)).toBeNull()
    expect(secondsToCms(100, 0, 120)).toBeNull()
  })

  it('quãng đường dùng độ cao đã kẹp min–max và lượng tử hoá CH1', () => {
    const m = { length: 2.55, minHeight: 0.5, maxHeight: 2 }
    expect(segmentDistCm(m, 0, 99)).toBeCloseTo(150, 6) // 0→0.5, 99→2.0
    expect(segmentDistCm(m, 1, 1)).toBe(0)
    expect(segmentDistCm({ length: 4, minHeight: 0, maxHeight: 4 }, 0, 1)).toBeCloseTo(100.39, 2) // 64×4/255 m
  })
})

describe('project cũ & CH2 tĩnh', () => {
  it('ch2Fine round-trip, mặc định không có field; homeOffsetMm cũ được giữ nguyên (không mất dữ liệu)', () => {
    const p = createDefaultProject()
    p.modules[0].ch2Fine = 200
    p.modules[1].homeOffsetMm = 12.5 // dữ liệu v1.0.5–1.0.7
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.modules[0].ch2Fine).toBe(200)
    expect(back.modules[1].homeOffsetMm).toBe(12.5)
    expect(back.modules[2]?.ch2Fine).toBeUndefined()
    const raw = JSON.parse(JSON.stringify(p))
    raw.modules[0].ch2Fine = 256
    expect(() => normalizeProject(raw)).toThrow(/ch2Fine/)
  })
})
