import { describe, expect, it } from 'vitest'
import { ch1ToPos, cmsToCh3, posToCh1, stepPositionM } from './convert'
import { GauzeCore } from './core'
import { MockDriver } from './drivers'
import { LOCK_VALUE } from './dmx'
import { createDefaultProject, normalizeProject } from './preset'
import {
  LinearFollowPlanner,
  cueRepDistanceCm,
  planTimelineFollow,
  resolveClipSegmentSpeed,
  retimeSegmentToSpeed,
  speedDisplayValue,
  speedStoredFromInput,
  storedSpeedAsCms,
  heightRange,
  keyframeCh1,
  keyframeHeightDisplay,
  keyframeHeightFromInput,
  mToCh1Raw,
  applyCueValues,
  cueSpeedSummary,
  stepSpeed,
  stepWithPosition,
  momentModePatch,
  updateClipKeyframeHeight,
} from './timeline'
import type { CueButton, ModuleCfg, TimelineClip } from './types'

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

describe('giá trị lưu NGUYÊN theo đơn vị nhập; đổi menu chỉ đổi hiển thị', () => {
  it('CH3 100 lưu 100; sang cm/s rồi về CH3 vẫn 100 (không trôi do làm tròn), mọi max module', () => {
    for (const max of [80, 120, 300]) {
      const stored = speedStoredFromInput('ch3', 100)
      expect(stored).toBe(100)
      // hiển thị tạm theo cm/s, giá trị lưu không đổi
      const cms = speedDisplayValue('cms', 'ch3', stored, 100, max)!
      expect(cms).toBeCloseTo((100 / 255) * max, 1)
      // quay lại menu CH3: cùng đơn vị với giá trị lưu ⇒ đúng số đã lưu, không qua cm/s
      expect(speedDisplayValue('ch3', 'ch3', stored, 100, max)).toBe(100)
    }
  })
  it('cm/s 41,8 và giây 2,5 cũng giữ nguyên; giây với quãng 0 không đổi được', () => {
    expect(speedDisplayValue('cms', 'cms', 41.8, 100, 120)).toBe(41.8)
    expect(speedDisplayValue('sec', 'sec', 2.5, 100, 120)).toBe(2.5)
    expect(speedDisplayValue('sec', 'cms', 40, 100, 120)).toBe(2.5)
    expect(speedDisplayValue('sec', 'cms', 40, 0, 120)).toBeNull()
    expect(storedSpeedAsCms('sec', 2, 0, 120)).toBeNull()
    expect(speedStoredFromInput('ch3', 999)).toBe(255)
    expect(speedStoredFromInput('ch3', 0)).toBe(1)
    expect(speedStoredFromInput('cms', 41.8)).toBe(41.8)
  })
  it('cue: vị trí lưu kèm đơn vị (CH1 128 → đúng 128, không qua m); quãng đại diện dùng m tương đương', () => {
    const m = { id: 'm1', minHeight: 0, length: 2.55 }
    expect(stepPositionM({ position: 128, unit: 'ch1' }, 2.55)).toBe(ch1ToPos(128, 2.55))
    expect(stepPositionM({ position: 1, unit: undefined }, 2.55)).toBe(1)
    expect(cueRepDistanceCm([{ moduleId: 'm1', position: 100, unit: 'ch1' }], [m], () => 0)).toBeCloseTo(100, 6)
    expect(cueRepDistanceCm([{ moduleId: 'm1', position: 1 }], [m], () => 0.2)).toBeCloseTo(80, 6)
    expect(cueRepDistanceCm([{ moduleId: 'm1', position: 0 }], [m], () => 0)).toBe(0)
  })
})

describe('gửi DMX: mọi đơn vị đều ra byte CH1/CH3, không còn nhánh m/cm/s thô', () => {
  const project = createDefaultProject()
  const modOf = (max: number): ModuleCfg => ({ ...mod(max), id: 'm', startAddress: 1, length: 2.55, minHeight: 0.1, maxHeight: 2.0 })
  const run = (cmds: object[], max = 120) => {
    const m = modOf(max)
    const core = new GauzeCore((_cfg, ev) => new MockDriver(ev))
    core.configure({ modules: [m], output: project.settings.output, lockValue: LOCK_VALUE })
    core.command({ type: 'lock', locked: false })
    for (const c of cmds) core.command(c as never)
    core.tick()
    const f = core.snapshot().frame
    core.stop()
    return { ch1: f[0], ch3: f[2], m }
  }
  it('vị trí: m → posToCh1 (kẹp min–max); CH1 nhập → đúng byte (kẹp theo min–max module)', () => {
    const m = modOf(120)
    expect(run([{ type: 'move', ids: ['m'], target: 1, speed: { unit: 'cms', value: 50 } }]).ch1).toBe(posToCh1(1, m)) // 100
    expect(run([{ type: 'move', ids: ['m'], target: { ch1: 128 }, speed: { unit: 'cms', value: 50 } }]).ch1).toBe(128)
    // ngoài dải: kẹp theo min–max module (0,1 m → 10, 2,0 m → 200)
    expect(run([{ type: 'move', ids: ['m'], target: { ch1: 0 }, speed: { unit: 'cms', value: 50 } }]).ch1).toBe(10)
    expect(run([{ type: 'move', ids: ['m'], target: { ch1: 255 }, speed: { unit: 'cms', value: 50 } }]).ch1).toBe(200)
    expect(run([{ type: 'move', ids: ['m'], target: 99, speed: { unit: 'cms', value: 50 } }]).ch1).toBe(200)
  })
  it('tốc độ: cm/s → cmsToCh3 theo max; s → durationToCh3 (quãng thực); CH3 nhập → đúng số (kẹp 1..255)', () => {
    const go = (speed: object, max = 120) => run([{ type: 'move', ids: ['m'], target: 1.1, speed }], max).ch3
    expect(go({ unit: 'cms', value: 60 })).toBe(cmsToCh3(60, 120)) // 128
    expect(go({ unit: 'cms', value: 150 }, 300)).toBe(128) // max 300 (>120)
    expect(go({ unit: 'sec', value: 2 })).toBe(Math.ceil(((110 / 2) / 120) * 255 - 0.01)) // quãng thực 0 → 1,1 m = 110 cm
    expect(go({ unit: 'ch3', value: 100 })).toBe(100)
    expect(go({ unit: 'ch3', value: 100 }, 300)).toBe(100) // không qua cm/s
    expect(go({ unit: 'ch3', value: 999 })).toBe(255)
    expect(go({ unit: 'ch3', value: 0 })).toBe(1)
  })
  it('timeline: moment CH3 nhập thẳng → lệnh unit ch3 đúng số; cm/s → unit cms (core đổi sang CH3)', () => {
    const m = modOf(300)
    const c = clip()
    c.speedMode = 'manual'
    c.speedUnit = 'ch3'
    c.speedValue = 100
    const planner = new LinearFollowPlanner()
    const cmd = planTimelineFollow([m], [c], [], 10, 0.06, null, planner).commands[0]
    expect(cmd).toMatchObject({ type: 'move', speed: { unit: 'ch3', value: 100 } })
    c.speedUnit = 'cms'
    c.speedValue = 60
    const cmd2 = planTimelineFollow([m], [c], [], 10, 0.06, null, new LinearFollowPlanner()).commands[0]
    expect(cmd2).toMatchObject({ type: 'move', speed: { unit: 'cms' } })
  })
})

describe('lưu/đọc đơn vị', () => {
  it('moment: speedUnit+speedValue nguyên số nhập, speedView lưu cả khi Auto; cue: unit từng bước + speedView; project cũ như cũ', () => {
    const p = createDefaultProject()
    p.clips = [
      { ...clip(), speedMode: 'manual', speedUnit: 'ch3', speedValue: 100, speedView: 'cms' },
      { ...clip(), id: 'c2', speedMode: 'auto', speedView: 'ch3' },
      { ...clip(), id: 'c3', speedMode: undefined, speedView: 'sec' },
    ]
    const modId = p.modules[0].id
    p.buttons = [
      { ...p.buttons[0], steps: [{ moduleId: modId, position: 128, unit: 'ch1' }], positionUnit: 'ch1', speedUnit: 'ch3', speedValue: 100, speedView: 'cms' },
      { ...p.buttons[1], id: 'b2' },
    ]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.clips?.[0]).toMatchObject({ speedMode: 'manual', speedUnit: 'ch3', speedValue: 100, speedView: 'cms' })
    expect(back.clips?.[1]).toMatchObject({ speedMode: 'auto', speedView: 'ch3' })
    expect(back.clips?.[2]).toMatchObject({ speedView: 'sec' })
    expect(back.clips?.[2]).not.toHaveProperty('speedMode')
    expect(back.buttons[0].steps[0]).toMatchObject({ position: 128, unit: 'ch1' })
    expect(back.buttons[0]).toMatchObject({ speedUnit: 'ch3', speedValue: 100, speedView: 'cms' })
    // project cũ: bước không có unit, nút chỉ cms|sec
    expect(back.buttons[1].steps.every((s) => s.unit === undefined)).toBe(true)
    expect(back.buttons[1]).not.toHaveProperty('speedView')
    const bad = JSON.parse(JSON.stringify(normalizeProject(p)))
    bad.buttons[0].steps[0].position = 300
    expect(() => normalizeProject(bad)).toThrow(/position/)
    bad.buttons[0].steps[0].position = 128
    bad.buttons[0].speedUnit = 'kmh'
    expect(() => normalizeProject(bad)).toThrow(/speedUnit/)
  })
})

describe('độ cao điểm trong moment: lưu nguyên m hoặc CH1', () => {
  const m = { ...mod(120), length: 2.55, minHeight: 0.1, maxHeight: 2.0 }
  it('nhập CH1 lưu nguyên số (kẹp theo min–max), height = m tương đương; nhập m bỏ ch1', () => {
    expect(keyframeHeightFromInput(128, 'ch1', m)).toEqual({ height: ch1ToPos(128, 2.55), ch1: 128 })
    expect(keyframeHeightFromInput(0, 'ch1', m).ch1).toBe(10) // min 0,1 m
    expect(keyframeHeightFromInput(255, 'ch1', m).ch1).toBe(200) // max 2,0 m
    expect(keyframeHeightFromInput(1.234, 'm', m)).toEqual({ height: 1.234 })
    expect(keyframeHeightFromInput(9, 'm', m).height).toBe(2)
    expect(heightRange(m, 'ch1')).toEqual([10, 200])
    expect(heightRange(m, 'm')).toEqual([0.1, 2])
  })
  it('đổi menu chỉ đổi hiển thị, hai chiều giữ giá trị lưu; height bị sửa chỗ khác thì ch1 cũ bị bỏ qua', () => {
    const kf = { height: ch1ToPos(100, 2.55), ch1: 100 }
    expect(keyframeHeightDisplay(kf, 'ch1', m)).toBe(100)
    expect(keyframeHeightDisplay(kf, 'm', m)).toBeCloseTo(1, 3)
    expect(keyframeHeightDisplay(kf, 'ch1', m)).toBe(100) // quay lại vẫn 100
    const dragged = { height: 1.5, ch1: 100 } // kéo thả đổi height, ch1 cũ lệch
    expect(keyframeCh1(dragged, m)).toBeUndefined()
    expect(keyframeHeightDisplay(dragged, 'ch1', m)).toBe(mToCh1Raw(1.5, 2.55))
    expect(keyframeHeightDisplay({ height: 1 }, 'm', m)).toBe(1)
  })
  it('updateClipKeyframeHeight ghi/xoá ch1 theo đơn vị nhập', () => {
    const c = clip()
    const withCh1 = updateClipKeyframeHeight(c, 'b', ch1ToPos(100, 2.55), 100).keyframes.find((k) => k.id === 'b')!
    expect(withCh1.ch1).toBe(100)
    const back = updateClipKeyframeHeight({ ...c, keyframes: [{ ...c.keyframes[0] }, withCh1, c.keyframes[2], c.keyframes[3]] }, 'b', 1.2).keyframes.find((k) => k.id === 'b')!
    expect(back.ch1).toBeUndefined()
  })
  it('gửi DMX: điểm nhập CH1 100 → byte CH1 = 100 (qua planner + core), kẹp theo min–max', () => {
    const mm = { ...modOf2(), id: 'm' }
    const run = (kfCh1: number) => {
      const c: TimelineClip = {
        id: 'c', layerId: 'l', moduleId: 'm', startTime: 0, duration: 4, curveMode: 'linear', speedMode: 'auto',
        keyframes: [
          { id: 'a', offset: 0, height: ch1ToPos(kfCh1, 2.55), ch1: kfCh1 },
          { id: 'b', offset: 4, height: ch1ToPos(kfCh1, 2.55), ch1: kfCh1 },
        ],
      }
      const core = new GauzeCore((_cfg, ev) => new MockDriver(ev))
      core.configure({ modules: [mm], output: createDefaultProject().settings.output, lockValue: LOCK_VALUE })
      core.command({ type: 'lock', locked: false })
      for (const cmd of planTimelineFollow([mm], [c], [], 0, 0.06, null, new LinearFollowPlanner()).commands) core.command(cmd)
      core.tick()
      const f = core.snapshot().frame[0]
      core.stop()
      return f
    }
    expect(run(100)).toBe(100)
    expect(run(128)).toBe(128)
    expect(run(250)).toBe(200) // kẹp theo maxHeight 2,0 m
  })
  it('lưu/đọc: positionUnit moment + ch1 điểm round-trip; project cũ mặc định m', () => {
    const p = createDefaultProject()
    p.clips = [
      { ...clip(), positionUnit: 'ch1', keyframes: clip().keyframes.map((k, i) => (i === 1 ? { ...k, ch1: 100 } : k)) },
      { ...clip(), id: 'c2' },
    ]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.clips?.[0].positionUnit).toBe('ch1')
    expect(back.clips?.[0].keyframes[1].ch1).toBe(100)
    expect(back.clips?.[1]).not.toHaveProperty('positionUnit')
    expect(back.clips?.[1].keyframes.every((k) => k.ch1 === undefined)).toBe(true)
    const bad = JSON.parse(JSON.stringify(normalizeProject(p)))
    bad.clips[0].keyframes[1].ch1 = 300
    expect(() => normalizeProject(bad)).toThrow(/ch1/)
    bad.clips[0].keyframes[1].ch1 = 100
    bad.clips[0].positionUnit = 'pct'
    expect(() => normalizeProject(bad)).toThrow(/positionUnit/)
  })
})

function modOf2(): ModuleCfg {
  return { ...mod(120), startAddress: 1, length: 2.55, minHeight: 0.1, maxHeight: 2.0 }
}

describe('cue: áp dụng chung vị trí + tốc độ cho module đang tích', () => {
  const mk = (id: string, length: number, minHeight: number, maxHeight: number, maxSpeedCms = 120): ModuleCfg => ({
    ...mod(maxSpeedCms), id, name: id.toUpperCase(), length, minHeight, maxHeight, startAddress: 1,
  })
  const mods = [mk('a', 1, 0, 1), mk('b', 3, 0.5, 2.5), mk('c', 2.55, 0, 2.55, 300)]
  const base = (over: Partial<CueButton> = {}): CueButton => ({
    id: 'q', name: 'Q', speedUnit: 'cms', speedValue: 30,
    steps: [{ moduleId: 'a', position: 0.2 }, { moduleId: 'b', position: 1 }], // c bỏ tích
    ...over,
  })

  it('tích nhiều module: Áp dụng m ghi đúng cho module tích, kẹp theo từng module, module bỏ tích giữ nguyên', () => {
    const r = applyCueValues(base(), mods, { pos: 2, spd: null })
    expect(r.btn.steps).toEqual([{ moduleId: 'a', position: 1 }, { moduleId: 'b', position: 2 }]) // a kẹp 1 m
    expect(r.clamped).toEqual(['A'])
    expect(r.btn.speedValue).toBe(30) // ô tốc độ trống = không đổi
    expect(r.btn.steps.find((s) => s.moduleId === 'c')).toBeUndefined()
    const r2 = applyCueValues(base(), mods, { pos: 0.1, spd: null })
    expect(r2.btn.steps[1].position).toBe(0.5) // b: kẹp lên minHeight 0,5
    expect(r2.clamped).toEqual(['B'])
  })
  it('CH1: lưu nguyên số (unit ch1), kẹp trong dải CH1 từng module; khác length cho m tương đương khác nhau', () => {
    const b = base({ positionUnit: 'ch1' })
    const r = applyCueValues(b, mods, { pos: 128, spd: null })
    expect(r.btn.steps).toEqual([
      { moduleId: 'a', position: 128, unit: 'ch1' },
      { moduleId: 'b', position: 128, unit: 'ch1' },
    ])
    expect(r.clamped).toEqual([])
    const hi = applyCueValues(b, mods, { pos: 250, spd: null })
    expect(hi.btn.steps.map((s) => s.position)).toEqual([250, 212]) // a: trong dải; b: kẹp floor(2,5/3×255)=212
    expect(hi.clamped).toEqual(['B'])
    expect(stepPositionM(r.btn.steps[0], 1)).not.toBeCloseTo(stepPositionM(r.btn.steps[1], 3), 2)
  })
  it('tốc độ: ghi vào TỪNG bước đang tích (nguyên theo đơn vị đang chọn), tốc độ chung giữ nguyên; cue luôn Manual; ô trống không đổi', () => {
    const cms = applyCueValues(base({ speedView: 'cms' }), mods, { pos: null, spd: 45 })
    expect(cms.btn.steps.every((s) => s.speedUnit === 'cms' && s.speedValue === 45)).toBe(true)
    expect(cms.btn).toMatchObject({ speedUnit: 'cms', speedValue: 30 }) // chung giữ nguyên
    const ch3 = applyCueValues(base({ speedView: 'ch3' }), mods, { pos: null, spd: 100 })
    expect(ch3.btn.steps.every((s) => s.speedUnit === 'ch3' && s.speedValue === 100)).toBe(true)
    expect(ch3.btn.speedView).toBe('ch3')
    const sec = applyCueValues(base({ speedView: 'sec' }), mods, { pos: null, spd: 2.5 })
    expect(sec.btn.steps.every((s) => s.speedUnit === 'sec' && s.speedValue === 2.5)).toBe(true)
    // cue cũ vốn Auto (autoSpeedLimitCms) vẫn nhập được như Manual
    const legacyAuto = applyCueValues(base({ autoSpeedLimitCms: 50 }), mods, { pos: null, spd: 99 })
    expect(legacyAuto.reason).toBeUndefined()
    expect(legacyAuto.btn.steps.every((s) => s.speedValue === 99)).toBe(true)
    expect(applyCueValues(base(), mods, { pos: null, spd: null }).reason).toBe('nothing')
    // cả hai cùng lúc; sửa vị trí sau đó vẫn giữ tốc độ riêng
    const both = applyCueValues(base({ positionUnit: 'ch1', speedView: 'ch3' }), mods, { pos: 100, spd: 100 })
    expect(both.btn.steps.every((s) => s.position === 100 && s.unit === 'ch1' && s.speedUnit === 'ch3' && s.speedValue === 100)).toBe(true)
    const repos = applyCueValues({ ...both.btn, positionUnit: 'ch1' }, mods, { pos: 50, spd: null })
    expect(repos.btn.steps.every((s) => s.position === 50 && s.speedValue === 100)).toBe(true)
    // module bỏ tích (c) không có bước ⇒ không bị đụng
    expect(both.btn.steps.find((s) => s.moduleId === 'c')).toBeUndefined()
  })
  it('không tích module nào: không áp dụng', () => {
    expect(applyCueValues(base({ steps: [] }), mods, { pos: 1, spd: 5 }).reason).toBe('none-selected')
  })
  it('phát cue ra đúng CH1/CH3 từng module: m → posToCh1 theo length, CH1 nhập → đúng byte, CH3 nhập → đúng số, cm/s → theo max module', () => {
    const run = (steps: CueButton['steps'], speed: { unit: 'cms' | 'sec' | 'ch3'; value: number }) => {
      const core = new GauzeCore((_cfg, ev) => new MockDriver(ev))
      const ms = mods.map((m, i) => ({ ...m, startAddress: 1 + i * 4 }))
      core.configure({ modules: ms, output: createDefaultProject().settings.output, lockValue: LOCK_VALUE })
      core.command({ type: 'lock', locked: false })
      for (const s of steps) core.command({ type: 'move', ids: [s.moduleId], target: s.unit === 'ch1' ? { ch1: s.position } : s.position, speed })
      core.tick()
      const f = core.snapshot().frame
      core.stop()
      return f
    }
    const f = run([{ moduleId: 'a', position: 0.5 }, { moduleId: 'b', position: 128, unit: 'ch1' }, { moduleId: 'c', position: 1 }], { unit: 'ch3', value: 100 })
    expect(f[0]).toBe(posToCh1(0.5, mods[0])) // 0,5/1×255 → 128
    expect(f[4]).toBe(128) // CH1 nhập thẳng (trong dải b: 42..212)
    expect(f[8]).toBe(posToCh1(1, mods[2])) // length 2,55
    expect([f[2], f[6], f[10]]).toEqual([100, 100, 100]) // CH3 nhập thẳng
    const g = run([{ moduleId: 'a', position: 0.5 }, { moduleId: 'c', position: 1 }], { unit: 'cms', value: 60 })
    expect(g[2]).toBe(cmsToCh3(60, 120)) // module max 120 → 128
    expect(g[10]).toBe(cmsToCh3(60, 300)) // module max 300 → 51
  })
  it('lưu/đọc: bước CH1 + project cũ (không unit) round-trip', () => {
    const p = createDefaultProject()
    const id = p.modules[0].id
    p.buttons = [{ ...p.buttons[0], steps: [{ moduleId: id, position: 128, unit: 'ch1' }], positionUnit: 'ch1' }, { ...p.buttons[1], id: 'b2' }]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.buttons[0].steps[0]).toMatchObject({ position: 128, unit: 'ch1' })
    expect(back.buttons[1].steps.every((s) => s.unit === undefined)).toBe(true)
  })
})

describe('Auto ⇄ Manual không mất giá trị Manual đã nhập', () => {
  it('moment: Auto giữ speedUnit/speedValue; về Manual dùng lại đúng giá trị (CH3 100 vẫn 100)', () => {
    const manual = { speedMode: 'manual' as const, speedUnit: 'ch3' as const, speedValue: 100 }
    const toAuto = momentModePatch(manual, 'auto', { unit: 'cms', value: 25 })
    expect(toAuto).toEqual({ speedMode: 'auto' }) // không đụng speedUnit/speedValue ⇒ giữ nguyên
    const asAuto = { ...manual, ...toAuto }
    expect(momentModePatch(asAuto, 'manual', { unit: 'cms', value: 25 })).toEqual({ speedMode: 'manual', speedUnit: 'ch3', speedValue: 100 })
    // chưa từng nhập: lấy giá trị tự tính
    expect(momentModePatch({ speedMode: 'auto' }, 'manual', { unit: 'cms', value: 25 })).toEqual({ speedMode: 'manual', speedUnit: 'cms', speedValue: 25 })
  })
  it('moment: lưu/đọc giữ giá trị Manual khi đang Auto', () => {
    const p = createDefaultProject()
    p.clips = [{ ...clip(), speedMode: 'auto', speedUnit: 'ch3', speedValue: 100 }]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.clips?.[0]).toMatchObject({ speedMode: 'auto', speedUnit: 'ch3', speedValue: 100 })
    // planner ở Auto bỏ qua giá trị đã cất
    const m = { ...mod(120), startAddress: 1 }
    const cmd = planTimelineFollow([m], [back.clips![0]], [], 10, 0.06, null, new LinearFollowPlanner()).commands[0]
    expect(cmd).toMatchObject({ speed: { unit: 'cms' } })
  })
})

describe('cue: tốc độ riêng từng module', () => {
  const mk = (id: string, maxSpeedCms: number, startAddress: number): ModuleCfg => ({ ...mod(maxSpeedCms), id, name: id, length: 2.55, minHeight: 0, maxHeight: 2.55, startAddress })
  const ms = [mk('a', 120, 1), mk('b', 300, 5), mk('c', 80, 9)]
  const btn = (steps: CueButton['steps'], over: Partial<CueButton> = {}): CueButton => ({ id: 'q', name: 'Q', speedUnit: 'cms', speedValue: 60, steps, ...over })
  // mô phỏng ControlDeck.fire: mỗi module dùng tốc độ của bước (hoặc tốc độ chung), target CH1 nhập thẳng → {ch1}
  const fire = (b: CueButton) => {
    const core = new GauzeCore((_cfg, ev) => new MockDriver(ev))
    core.configure({ modules: ms, output: createDefaultProject().settings.output, lockValue: LOCK_VALUE })
    core.command({ type: 'lock', locked: false })
    for (const s of b.steps) {
      const eff = stepSpeed(b, s) // cue luôn Manual
      core.command({ type: 'move', ids: [s.moduleId], target: s.unit === 'ch1' ? { ch1: s.position } : s.position, speed: { unit: eff.unit, value: eff.value } })
    }
    core.tick()
    const f = core.snapshot().frame
    core.stop()
    return f
  }
  it('CH3 riêng từng module gửi đúng; bước không có tốc độ riêng dùng tốc độ chung (cm/s theo max module)', () => {
    const f = fire(btn([
      { moduleId: 'a', position: 1, speedUnit: 'ch3', speedValue: 89 },
      { moduleId: 'b', position: 1, speedUnit: 'ch3', speedValue: 91 },
      { moduleId: 'c', position: 1 }, // không riêng → chung 60 cm/s theo max 80
    ]))
    expect([f[2], f[6]]).toEqual([89, 91]) // CH3 nhập thẳng, lệch nhau chút
    expect(f[10]).toBe(cmsToCh3(60, 80))
  })
  it('giây theo quãng đường thực của từng module; cm/s theo max từng module', () => {
    const f = fire(btn([
      { moduleId: 'a', position: 1, speedUnit: 'sec', speedValue: 2 },
      { moduleId: 'b', position: 1, speedUnit: 'cms', speedValue: 150 },
    ]))
    expect(f[2]).toBe(Math.ceil((100 / 2 / 120) * 255 - 0.01))
    expect(f[6]).toBe(cmsToCh3(150, 300))
  })
  it('cue cũ vốn Auto (có autoSpeedLimitCms) mở bình thường và phát theo tốc độ đã lưu như Manual (không còn trần auto)', () => {
    const f = fire(btn([{ moduleId: 'a', position: 1, speedUnit: 'ch3', speedValue: 200 }], { autoSpeedLimitCms: 50 }))
    expect(f[2]).toBe(200)
    const g = fire(btn([{ moduleId: 'a', position: 1 }], { autoSpeedLimitCms: 50, speedUnit: 'cms', speedValue: 100 }))
    expect(g[2]).toBe(cmsToCh3(100, 120)) // 213: không bị kẹp 50 cm/s
    const p = createDefaultProject()
    p.buttons = [{ ...p.buttons[0], autoSpeedLimitCms: 50 }]
    expect(normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p)))).buttons[0].autoSpeedLimitCms).toBe(50) // project cũ mở được
  })
  it('nhãn nút: giống nhau → một giá trị; khác nhau → null (NHIỀU TỐC ĐỘ); Auto → tốc độ chung', () => {
    const same = btn([{ moduleId: 'a', position: 1, speedUnit: 'ch3', speedValue: 89 }, { moduleId: 'b', position: 1, speedUnit: 'ch3', speedValue: 89 }])
    expect(cueSpeedSummary(same)).toEqual({ unit: 'ch3', value: 89 })
    expect(cueSpeedSummary(btn([{ moduleId: 'a', position: 1, speedUnit: 'ch3', speedValue: 89 }, { moduleId: 'b', position: 1, speedUnit: 'ch3', speedValue: 91 }]))).toBeNull()
    expect(cueSpeedSummary(btn([{ moduleId: 'a', position: 1, speedUnit: 'ch3', speedValue: 89 }, { moduleId: 'b', position: 1 }]))).toBeNull()
    expect(cueSpeedSummary(btn([{ moduleId: 'a', position: 1 }, { moduleId: 'b', position: 1 }]))).toEqual({ unit: 'cms', value: 60 })
  })
  it('lưu/đọc: tốc độ riêng của bước round-trip; project cũ (bước không có tốc độ) dùng tốc độ chung; giá trị sai bị từ chối', () => {
    const p = createDefaultProject()
    const id = p.modules[0].id
    p.buttons = [{ ...p.buttons[0], steps: [{ moduleId: id, position: 1, speedUnit: 'ch3', speedValue: 89 }] }, { ...p.buttons[1], id: 'b2' }]
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(p))))
    expect(back.buttons[0].steps[0]).toMatchObject({ speedUnit: 'ch3', speedValue: 89 })
    expect(back.buttons[1].steps.every((s) => s.speedUnit === undefined && s.speedValue === undefined)).toBe(true)
    expect(stepSpeed(back.buttons[1], back.buttons[1].steps[0])).toEqual({ unit: back.buttons[1].speedUnit, value: back.buttons[1].speedValue })
    const bad = JSON.parse(JSON.stringify(normalizeProject(p)))
    bad.buttons[0].steps[0].speedValue = 300
    expect(() => normalizeProject(bad)).toThrow(/speedValue/)
    bad.buttons[0].steps[0].speedValue = 89
    bad.buttons[0].steps[0].speedUnit = 'kmh'
    expect(() => normalizeProject(bad)).toThrow(/speedUnit/)
  })
  it('stepWithPosition giữ tốc độ riêng khi đổi vị trí', () => {
    const old = { moduleId: 'a', position: 1, speedUnit: 'ch3' as const, speedValue: 89 }
    expect(stepWithPosition(old, { moduleId: 'a', position: 128, unit: 'ch1' })).toEqual({ moduleId: 'a', position: 128, unit: 'ch1', speedUnit: 'ch3', speedValue: 89 })
    expect(stepWithPosition({ moduleId: 'a', position: 1 }, { moduleId: 'a', position: 2 })).toEqual({ moduleId: 'a', position: 2 })
  })
})
