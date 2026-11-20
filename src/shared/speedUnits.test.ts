import { describe, expect, it } from 'vitest'
import { cmsToCh3 } from './convert'
import { createDefaultProject, normalizeProject } from './preset'
import {
  cueRepDistanceCm,
  cueSpeedDisplay,
  cueSpeedFromInput,
  cueSpeedSwitch,
  resolveClipSegmentSpeed,
  retimeSegmentToSpeed,
} from './timeline'
import type { ModuleCfg, TimelineClip } from './types'

const mod = (maxSpeedCms = 100): ModuleCfg => ({
  id: 'm', name: 'M', layerId: 'l', length: 2.55, width: 1, minHeight: 0, maxHeight: 2.55,
  startAddress: 1, maxSpeedCms, defaultSpeed: 100,
})
// P1→P2 100 cm / 4 s, P2→P3 50 cm / 4 s, P3→P4 0 cm / 2 s
const clip = (): TimelineClip => ({
  id: 'c', layerId: 'l', moduleId: 'm', startTime: 10, duration: 10, curveMode: 'linear', speedMode: 'auto',
  keyframes: [
    { id: 'a', offset: 0, height: 0 },
    { id: 'b', offset: 4, height: 1 },
    { id: 'c', offset: 8, height: 1.5 },
    { id: 'd', offset: 10, height: 1.5 },
  ],
})
const offsets = (k: { keyframes: { offset: number }[] }) => k.keyframes.map((x) => x.offset)

describe('sửa cột cm/s | CH3 ở Auto: dời các điểm sau, giữ thứ tự', () => {
  it('cm/s hai chiều: 50 cm/s trên đoạn 100 cm → 2 s, các điểm sau dịch −2 s', () => {
    const r = retimeSegmentToSpeed(clip(), 'b', 50, mod())!
    expect(offsets(r)).toEqual([0, 2, 6, 8])
    expect(r.duration).toBe(8)
    const next = { ...clip(), ...r }
    expect(resolveClipSegmentSpeed(next, next.keyframes[0], next.keyframes[1], mod()).cms).toBeCloseTo(50, 5)
    // và ngược lại về 25 cm/s → 4 s
    expect(offsets(retimeSegmentToSpeed(next, 'b', 25, mod())!)).toEqual([0, 4, 8, 10])
  })
  it('CH3 theo max module (>120): max 300, CH3 128 ≈ 150,6 cm/s', () => {
    const cms = (128 / 255) * 300
    const r = retimeSegmentToSpeed(clip(), 'b', cms, mod(300))!
    const next = { ...clip(), ...r }
    expect(cmsToCh3(resolveClipSegmentSpeed(next, next.keyframes[0], next.keyframes[1], mod(300)).cms, 300)).toBe(128)
  })
  it('kẹp [1, max], đoạn tối thiểu 0,02 s, không đổi thứ tự', () => {
    expect(offsets(retimeSegmentToSpeed(clip(), 'b', 99999, mod())!)[1]).toBeCloseTo(1, 4) // kẹp 100 cm/s → 1 s
    expect(offsets(retimeSegmentToSpeed(clip(), 'b', 0, mod())!)[1]).toBeCloseTo(100, 4) // kẹp 1 cm/s → 100 s
    const r = retimeSegmentToSpeed(clip(), 'c', 1, mod())!
    expect(offsets(r)).toEqual([...offsets(r)].sort((a, b) => a - b))
  })
  it('chặn bởi moment kế bên (maxEnd): kẹp, không tràn', () => {
    const r = retimeSegmentToSpeed(clip(), 'b', 1, mod(), { minStart: 0, maxEnd: 25 })!
    expect(10 + r.duration).toBeLessThanOrEqual(25)
  })
  it('quãng 0 và điểm đầu: null (không chia 0)', () => {
    expect(retimeSegmentToSpeed(clip(), 'd', 50, mod())).toBeNull() // P3→P4 quãng 0
    expect(retimeSegmentToSpeed(clip(), 'a', 50, mod())).toBeNull()
    expect(retimeSegmentToSpeed(clip(), 'b', Number.NaN, mod())).toBeNull()
  })
})

describe('cue: đổi đơn vị hai chiều (lưu chuẩn m + cm/s | s)', () => {
  const steps = [{ moduleId: 'm1', position: 1 }, { moduleId: 'm2', position: 0.4 }]
  const mods = [{ id: 'm1', minHeight: 0 }, { id: 'm2', minHeight: 0 }]
  it('quãng đại diện: theo vị trí hiện tại; =0 thì theo minHeight; hết cách = 0', () => {
    expect(cueRepDistanceCm(steps, mods, () => 0.2)).toBeCloseTo(80, 6)
    expect(cueRepDistanceCm(steps, mods, (id) => (id === 'm1' ? 1 : 0.4))).toBeCloseTo(100, 6)
    expect(cueRepDistanceCm([{ moduleId: 'm1', position: 0 }], mods, () => 0)).toBe(0)
  })
  it('cm/s ⇄ s ⇄ CH3 giữ tốc độ tương đương; quãng 0 → không đổi được', () => {
    const base = { speedUnit: 'cms' as const, speedValue: 50, speedView: undefined }
    const sec = cueSpeedSwitch(base, 'sec', 100)!
    expect(sec).toMatchObject({ speedUnit: 'sec', speedValue: 2 })
    const ch3 = cueSpeedSwitch(sec, 'ch3', 100)!
    expect(ch3).toMatchObject({ speedUnit: 'cms', speedValue: 50, speedView: 'ch3' })
    expect(cueSpeedDisplay(ch3, 100, 100)).toBe(128) // ceil(50/100×255 − 0,01)
    const back = cueSpeedSwitch(ch3, 'sec', 100)!
    expect(back).toMatchObject({ speedUnit: 'sec', speedValue: 2, speedView: undefined })
    expect(cueSpeedSwitch(base, 'sec', 0)).toBeNull()
    expect(cueSpeedSwitch({ speedUnit: 'sec', speedValue: 2, speedView: undefined }, 'ch3', 0)).toBeNull()
  })
  it('nhập CH3 → lưu cm/s theo max module (kể cả >120) và hiển thị lại đúng CH3', () => {
    const stored = cueSpeedFromInput({ speedUnit: 'cms', speedView: 'ch3' }, 100, 300)
    expect(stored.speedValue).toBeCloseTo((100 / 255) * 300, 6)
    expect(cueSpeedDisplay({ ...stored }, 300, 100)).toBe(100)
    expect(cueSpeedFromInput({ speedUnit: 'cms', speedView: 'ch3' }, 999, 300).speedValue).toBeCloseTo(300, 6)
    expect(cueSpeedFromInput({ speedUnit: 'sec', speedView: undefined }, 3, 120)).toMatchObject({ speedUnit: 'sec', speedValue: 3 })
  })
})

describe('lưu/đọc đơn vị', () => {
  it('speedUnit của moment lưu cả khi Auto/cũ; cue positionUnit/speedView round-trip; project cũ mặc định m + cm/s', () => {
    const p = createDefaultProject()
    p.clips = [
      { ...clip(), speedMode: 'auto', speedUnit: 'ch3' },
      { ...clip(), id: 'c2', speedMode: undefined, speedUnit: 'sec' },
    ]
    p.buttons = [{ ...p.buttons[0], positionUnit: 'ch1', speedUnit: 'cms', speedValue: 40, speedView: 'ch3' }, { ...p.buttons[1], id: 'b2' }]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.clips?.[0]).toMatchObject({ speedMode: 'auto', speedUnit: 'ch3' })
    expect(back.clips?.[1]).toMatchObject({ speedUnit: 'sec' })
    expect(back.clips?.[1]).not.toHaveProperty('speedMode')
    expect(back.buttons[0]).toMatchObject({ positionUnit: 'ch1', speedView: 'ch3', speedUnit: 'cms' })
    expect(back.buttons[1]).not.toHaveProperty('positionUnit')
    expect(back.buttons[1]).not.toHaveProperty('speedView')
    const bad = JSON.parse(JSON.stringify(normalizeProject(p)))
    bad.buttons[0].speedUnit = 'sec'
    expect(() => normalizeProject(bad)).toThrow(/speedView/)
    bad.buttons[0].speedView = undefined
    bad.buttons[0].positionUnit = 'pct'
    expect(() => normalizeProject(bad)).toThrow(/positionUnit/)
  })
})
