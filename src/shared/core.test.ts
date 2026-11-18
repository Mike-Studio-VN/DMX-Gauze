import { describe, expect, it, vi } from 'vitest'
import { GauzeCore } from './core'
import { MockDriver } from './drivers'
import { CH, LOCK_VALUE } from './dmx'
import { DMX_TRANSPORT_RATES } from './dmxTransport'
import { createDefaultProject, normalizeProject } from './preset'

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

  it('home offset chỉ áp ở target 0; khi chạy không đụng CH2', () => {
    const project = createDefaultProject()
    const template = { ...project.modules[0], length: 1, minHeight: 0, maxHeight: 0.5, maxSpeedCms: 120 }
    const modules = [
      { ...template, id: 'm-a', startAddress: 1, homeOffsetMm: 40 },
      { ...template, id: 'm-b', startAddress: 5, homeOffsetMm: 40 },
    ]
    const send = vi.fn<MockDriver['send']>()
    const core = new GauzeCore((_cfg, events) => Object.assign(new MockDriver(events), { send }))
    try {
      core.configure({ modules, output: project.settings.output, lockValue: LOCK_VALUE })
      core.command({ type: 'lock', locked: false })
      core.tick()
      expect(send.mock.lastCall?.[2]).toEqual(Uint8Array.of(10, 0x3d, 100, LOCK_VALUE, 10, 0x3d, 100, LOCK_VALUE))
      core.command({ type: 'move', ids: ['m-a'], target: 1.5, speed: { unit: 'cms', value: 120 } })
      core.tick()
      expect(core.snapshot().modules['m-a'].target).toBe(0.5)
      expect(send.mock.lastCall?.[2]?.slice(0, 2)).toEqual(Uint8Array.of(0x80, 0x00))
    } finally {
      core.stop()
    }
  })

  describe('manual override (Sent)', () => {
    const setup = () => {
      const project = createDefaultProject()
      const modules = [
        { ...project.modules[0], id: 'm-a', startAddress: 1, length: 1, minHeight: 0, maxHeight: 0.5 },
        { ...project.modules[0], id: 'm-b', startAddress: 5, length: 1, minHeight: 0, maxHeight: 0.5 },
      ]
      const core = new GauzeCore((_cfg, events) => new MockDriver(events))
      core.configure({ modules, output: project.settings.output, lockValue: LOCK_VALUE })
      return core
    }

    it('khoá bật → Sent bị chặn, không tạo override; khoá tắt → gửi đúng 4 giá trị, module khác không đổi', () => {
      const core = setup()
      try {
        core.command({ type: 'lock', locked: true })
        core.tick()
        const locked = [...core.snapshot().frame.slice(0, 8)]
        const res = core.command({ type: 'override', id: 'm-a', values: [10, 20, 30, 77] })
        expect(res.ok).toBe(false)
        core.tick()
        expect([...core.snapshot().frame.slice(0, 8)]).toEqual(locked)
        expect(core.snapshot().overrides).toEqual({})

        core.command({ type: 'lock', locked: false })
        expect(core.command({ type: 'override', id: 'm-a', values: [10, 20, 30, 77] }).ok).toBe(true)
        core.tick()
        core.tick()
        const f = core.snapshot().frame
        expect([...f.slice(0, 4)]).toEqual([10, 20, 30, 77])
        expect([...f.slice(4, 8)]).toEqual([0, 0, 100, 77]) // module khác dùng frame thường
      } finally {
        core.stop()
      }
    })

    it('bật khoá khi đang có override → override bị xoá, CH4 về 0', () => {
      const core = setup()
      try {
        core.command({ type: 'lock', locked: false })
        core.command({ type: 'override', id: 'm-a', values: [10, 20, 30, 77] })
        core.tick()
        core.command({ type: 'lock', locked: true })
        core.tick()
        expect(core.snapshot().overrides).toEqual({})
        expect(core.snapshot().frame[3]).toBe(0)
      } finally {
        core.stop()
      }
    })

    it('kẹp CH1/CH2 theo max của module, từ chối giá trị ngoài 0–255, clearOverride trả về frame thường', () => {
      const core = setup()
      try {
        expect(core.command({ type: 'override', id: 'm-a', values: [256, 0, 0, 0] }).ok).toBe(false)
        expect(core.command({ type: 'override', id: 'm-a', values: [1.5, 0, 0, 0] }).ok).toBe(false)
        expect(core.command({ type: 'override', id: 'nope', values: [0, 0, 0, 0] }).ok).toBe(false)
        core.command({ type: 'lock', locked: false })
        core.command({ type: 'override', id: 'm-a', values: [255, 255, 50, 77] })
        core.tick()
        expect([...core.snapshot().frame.slice(0, 4)]).toEqual([0x80, 0x00, 50, 77]) // 0.5 m → 32768
        core.command({ type: 'clearOverride', id: 'm-a' })
        core.tick()
        expect(core.snapshot().overrides).toEqual({})
        expect(core.snapshot().frame[3]).toBe(77)
      } finally {
        core.stop()
      }
    })
  })

  it('xoá sạch byte DMX cũ khi xoá module, đổi địa chỉ, đổi output/route hoặc dừng (P1 safety)', () => {
    let now = 2000
    const sentFrames: Array<{ net: number; subUni: number; data: Uint8Array }> = []
    const drivers: Array<{ stopped: boolean }> = []
    const core = new GauzeCore((_cfg, ev) => {
      const state = { stopped: false }
      drivers.push(state)
      const inner = new MockDriver(ev)
      return {
        id: 'mock',
        start: () => inner.start(),
        send: (net, subUni, data) => {
          inner.send(net, subUni, data)
          sentFrames.push({ net, subUni, data: data.slice() })
        },
        poll: () => inner.poll(),
        stop: () => {
          state.stopped = true
          inner.stop()
        },
      }
    }, () => now)

    const p = createDefaultProject()
    const modA = { ...p.modules[0], id: 'mA', startAddress: 1 } // CH 1-4 (idx 0..3)
    const modB = { ...p.modules[1], id: 'mB', startAddress: 5 } // CH 5-8 (idx 4..7)
    core.configure({ modules: [modA, modB], output: p.settings.output, lockValue: LOCK_VALUE })
    core.start()
    core.command({ type: 'lock', locked: false })
    core.command({ type: 'move', ids: ['mA', 'mB'], target: 0.5, speed: { unit: 'cms', value: 120 } })
    now += 50
    core.tick()

    expect(core.snapshot().frame[0 + CH.LOCK]).toBe(77)
    expect(core.snapshot().frame[4 + CH.LOCK]).toBe(77)

    // Repro chính: xoá A trong khi B ở địa chỉ cao hơn vẫn tồn tại, rồi E-Stop -> CH4 của A phải về 0 ngay
    core.configure({ modules: [modB], output: p.settings.output, lockValue: LOCK_VALUE })
    expect(core.snapshot().frame[0 + CH.LOCK]).toBe(0)
    expect(core.snapshot().frame[0 + CH.POSITION]).toBe(0)
    core.command({ type: 'estop' })
    now += 50
    core.tick()
    const afterRemoveA = sentFrames[sentFrames.length - 1]
    expect(afterRemoveA.data[0 + CH.LOCK]).toBe(0)
    expect(afterRemoveA.data[4 + CH.LOCK]).toBe(0)

    // Mở khoá lại với A+B rồi xoá B (địa chỉ cao nhất) -> frame kế tiếp vẫn phải ghi 0 xoá vùng cũ CH5-8
    core.configure({ modules: [modA, modB], output: p.settings.output, lockValue: LOCK_VALUE })
    core.command({ type: 'lock', locked: false })
    core.command({ type: 'move', ids: ['mB'], target: 0.8, speed: { unit: 'cms', value: 120 } })
    now += 50
    core.tick()
    expect(sentFrames[sentFrames.length - 1].data[4 + CH.LOCK]).toBe(77)

    core.configure({ modules: [modA], output: p.settings.output, lockValue: LOCK_VALUE })
    now += 50
    core.tick()
    const clearedHigh = sentFrames[sentFrames.length - 1]
    expect(clearedHigh.data.length).toBeGreaterThanOrEqual(8)
    expect(clearedHigh.data[4 + CH.LOCK]).toBe(0)
    expect(clearedHigh.data[4 + CH.POSITION]).toBe(0)

    // Repatch A từ CH 1-4 sang CH 9-12 -> byte cũ 0..3 về 0
    core.configure({ modules: [{ ...modA, startAddress: 9 }], output: p.settings.output, lockValue: LOCK_VALUE })
    expect(core.snapshot().frame[0 + CH.LOCK]).toBe(0)
    expect(core.snapshot().frame[8 + CH.LOCK]).toBe(77)

    // Đổi output route (universe 0 -> 1): route cũ (0) phải nhận frame xoá an toàn trước khi đóng driver
    const beforeSwitchCount = sentFrames.length
    core.configure({
      modules: [{ ...modA, startAddress: 9 }],
      output: { ...p.settings.output, universe: 1 },
      lockValue: LOCK_VALUE,
    })
    const flushOnOldRoute = sentFrames[beforeSwitchCount]
    expect(flushOnOldRoute.subUni).toBe(0)
    expect(flushOnOldRoute.data.every((b) => b === 0)).toBe(true)
    expect(drivers[0].stopped).toBe(true)

    // Stop gửi frame khoá an toàn, xoá frame snapshot và khoá lại
    now += 50
    core.tick()
    core.stop()
    const lastStopSent = sentFrames[sentFrames.length - 1]
    expect(lastStopSent.subUni).toBe(1)
    expect(lastStopSent.data.every((b) => b === 0)).toBe(true)
    expect(core.snapshot().locked).toBe(true)
    expect(core.snapshot().frame.every((b) => b === 0)).toBe(true)
  })
})

describe('DMX transport rate', () => {
  it.each(DMX_TRANSPORT_RATES)('sends %i frames per second through the active driver', (sendHz) => {
    vi.useFakeTimers()
    const send = vi.fn()
    const core = new GauzeCore((_cfg, ev) => Object.assign(new MockDriver(ev), { send }))
    const cfg = { modules: [], output: { ...createDefaultProject().settings.output, sendHz }, lockValue: LOCK_VALUE }

    try {
      core.configure(cfg)
      core.start()
      vi.advanceTimersByTime(500)
      core.configure(cfg)
      vi.advanceTimersByTime(1500)
      expect(send).toHaveBeenCalledTimes(sendHz * 2)
      expect(core.status().sendHz).toBe(sendHz)
    } finally {
      core.stop()
      vi.useRealTimers()
    }
  })

  it('switches the running cadence without reopening the driver or flushing the route', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const stop = vi.fn()
    const factory = vi.fn<ConstructorParameters<typeof GauzeCore>[0]>((_cfg, ev) =>
      Object.assign(new MockDriver(ev), { send, stop }),
    )
    const core = new GauzeCore(factory)
    const project = createDefaultProject()
    const cfg = { modules: project.modules, output: project.settings.output, lockValue: LOCK_VALUE }

    try {
      core.configure(cfg)
      core.start()
      core.command({ type: 'lock', locked: false })
      vi.advanceTimersByTime(1000)
      expect(send).toHaveBeenCalledTimes(25)

      core.configure({ ...cfg, output: { ...cfg.output, sendHz: 60 } })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(stop).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(25)
      expect(core.snapshot().locked).toBe(false)

      vi.advanceTimersByTime(1000)
      expect(send).toHaveBeenCalledTimes(85)
      expect(core.status().sendHz).toBe(60)
      core.stop()
      const framesAfterStop = send.mock.calls.length
      vi.advanceTimersByTime(1000)
      expect(send).toHaveBeenCalledTimes(framesAfterStop)
    } finally {
      core.stop()
      vi.useRealTimers()
    }
  })
})

describe('connection status without device feedback', () => {
  it('node tự dựng (confirmed:false) chỉ cho trạng thái "sending", node thật cho "online"', () => {
    const now = 1000
    const p = createDefaultProject()
    let confirmed = false
    const core = new GauzeCore((_c, ev) => {
      const d = new MockDriver(ev)
      d.poll = () => ev.onNode({ ip: '1.2.3.4', name: 'n', longName: 'n', lastSeen: now, ...(confirmed ? {} : { confirmed: false }) })
      return d
    }, () => now)
    core.configure({ modules: [p.modules[0]], output: p.settings.output, lockValue: LOCK_VALUE })
    expect(core.status().state).toBe('sending')
    confirmed = true
    core.pollNow()
    expect(core.status().state).toBe('online')
  })
})

describe('normalizeProject', () => {
  it('từ chối id module trùng nhau', () => {
    const p = createDefaultProject()
    p.modules[1].id = p.modules[0].id
    expect(() => normalizeProject(p)).toThrow(/id trùng/)
  })
})

describe('unconfirmed sends do not mask real discovery', () => {
  it('gửi chưa xác nhận cùng IP không ghi đè node thật; hết phản hồi thật thì về "sending", không "lost"', () => {
    let now = 1000
    const p = createDefaultProject()
    let emit: (c: boolean) => void = () => {}
    const core = new GauzeCore((_c, ev) => {
      emit = (c) => ev.onNode({ ip: '1.2.3.4', name: 'n', longName: 'n', lastSeen: now, ...(c ? {} : { confirmed: false }) })
      const d = new MockDriver(ev)
      d.poll = () => {}
      return d
    }, () => now)
    core.configure({ modules: [p.modules[0]], output: { ...p.settings.output, driver: 'kinet' }, lockValue: LOCK_VALUE })
    emit(true)
    emit(false) // send thành công cùng IP
    expect(core.status().state).toBe('online')
    expect(core.status().nodes).toHaveLength(1) // chỉ node thật, không có bản ghi gửi
    now += 7000 // phản hồi thật hết hạn (6 s), vẫn đang gửi
    emit(false)
    expect(core.status().state).toBe('sending')
    expect(core.status().nodes).toHaveLength(0)
  })
})
describe('snapshot rate', () => {
  it('phát đúng một snapshot cho mỗi tick, kể cả khi tick lệch hoặc bù (25 Hz)', () => {
    let now = 1000
    const p = createDefaultProject()
    const core = new GauzeCore((_c, ev) => new MockDriver(ev), () => now)
    core.configure({ modules: [p.modules[0]], output: p.settings.output, lockValue: LOCK_VALUE })
    let n = 0
    core.onSnapshot(() => (n += 1))
    for (const dt of [40, 40, 55, 25, 40, 12, 68, 40]) {
      now += dt
      core.tick()
    }
    expect(n).toBe(8)
  })
})
