import { describe, expect, it, vi } from 'vitest'
import { GauzeCore } from './core'
import { MockDriver } from './drivers'
import { CH, LOCK_VALUE, SENT_PULSE_MS } from './dmx'
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

  it('CH1 8-bit theo min–max, CH2 tĩnh theo module (không đổi khi vị trí đổi), CH3 theo cm/s', () => {
    const project = createDefaultProject()
    const template = { ...project.modules[0], length: 1, minHeight: 0.1, maxHeight: 0.5, maxSpeedCms: 120 }
    const modules = [
      { ...template, id: 'm-a', startAddress: 1, ch2Fine: 40 },
      { ...template, id: 'm-b', startAddress: 5 },
    ]
    const send = vi.fn<MockDriver['send']>()
    const core = new GauzeCore((_cfg, events) => Object.assign(new MockDriver(events), { send }))
    try {
      core.configure({ modules, output: project.settings.output, lockValue: LOCK_VALUE })
      core.command({ type: 'lock', locked: false })
      core.tick()
      // target ban đầu 0 bị kẹp lên minHeight 0.1 → CH1 = ceil(25.5) = 26
      expect(send.mock.lastCall?.[2]).toEqual(Uint8Array.of(26, 40, 100, LOCK_VALUE, 26, 0, 100, LOCK_VALUE))
      core.command({ type: 'move', ids: ['m-a'], target: 1.5, speed: { unit: 'cms', value: 60 } })
      core.tick()
      expect(send.mock.lastCall?.[2]).toEqual(Uint8Array.of(127, 40, 128, LOCK_VALUE, 26, 0, 100, LOCK_VALUE)) // max 0.5 → floor(127.5)
      core.command({ type: 'move', ids: ['m-a'], target: 0.3, speed: { unit: 'cms', value: 120 } })
      core.tick()
      expect(send.mock.lastCall?.[2]?.slice(0, 3)).toEqual(Uint8Array.of(77, 40, 255)) // CH2 vẫn 40
    } finally {
      core.stop()
    }
  })

  describe('Sent (test fine tune)', () => {
    const cfgOf = (ch2Fine?: number) => {
      const project = createDefaultProject()
      const modules = [
        { ...project.modules[0], id: 'm-a', startAddress: 1, length: 1, minHeight: 0, maxHeight: 0.5, ch2Fine },
        { ...project.modules[0], id: 'm-b', startAddress: 5, length: 1, minHeight: 0, maxHeight: 0.5 },
      ]
      return { modules, output: project.settings.output, lockValue: LOCK_VALUE }
    }
    let now = 1000
    const setup = () => {
      now = 1000
      const core = new GauzeCore((_cfg, events) => new MockDriver(events), () => now)
      core.configure(cfgOf())
      return core
    }
    const tickAt = (core: GauzeCore, t: number) => {
      now = t
      core.tick()
      return [...core.snapshot().frame.slice(0, 8)]
    }

    it.each([true, false])('gửi được khi khoá tổng=%s: CH1 giữ nguyên, CH2 = giá trị nhập, CH4 = 77 rồi 0', (global) => {
      const core = setup()
      try {
        core.command({ type: 'lock', locked: global })
        const before = tickAt(core, 1000)
        expect(core.command({ type: 'sendFine', id: 'm-a', ch2: 123 }).ok).toBe(true)
        const during = tickAt(core, 1040)
        expect(during[0]).toBe(before[0]) // CH1 không đổi
        expect(during[1]).toBe(123) // CH2 = giá trị nhập
        expect(during[2]).toBe(before[2]) // CH3 theo hành vi hiện có
        expect(during[3]).toBe(77) // xung CH4
        expect(during.slice(4)).toEqual(before.slice(4)) // module khác không đổi
        expect(core.snapshot().pulsing).toEqual(['m-a'])
        const after = tickAt(core, 1000 + SENT_PULSE_MS + 40)
        expect(after[3]).toBe(0) // tự về 0
        expect(tickAt(core, 5000)[3]).toBe(0) // và giữ 0
        expect(core.snapshot().pulsing).toEqual([])
        expect(core.snapshot().modules['m-a'].target).toBe(0) // không có đích mới
      } finally {
        core.stop()
      }
    })

    it('đang chạy thì Sent dừng tại chỗ (không đặt đích mới); move kế tiếp trả CH4 về theo khoá', () => {
      const core = setup()
      try {
        core.command({ type: 'lock', locked: false })
        core.command({ type: 'move', ids: ['m-a'], target: 0.5, speed: { unit: 'cms', value: 10 } })
        tickAt(core, 1500)
        tickAt(core, 2000)
        const pos = core.snapshot().modules['m-a'].pos
        core.command({ type: 'sendFine', id: 'm-a', ch2: 9 })
        expect(core.snapshot().modules['m-a'].target).toBeCloseTo(pos, 9)
        tickAt(core, 6000)
        expect(core.snapshot().frame[3]).toBe(0)
        core.command({ type: 'move', ids: ['m-a'], target: 0.2, speed: { unit: 'cms', value: 10 } })
        expect(tickAt(core, 6040)[3]).toBe(LOCK_VALUE)
      } finally {
        core.stop()
      }
    })

    it('khoá tổng vẫn chặn move; từ chối CH2 ngoài 0–255 và module lạ', () => {
      const core = setup()
      try {
        core.command({ type: 'lock', locked: true })
        expect(core.command({ type: 'move', ids: ['m-b'], target: 0.3, speed: { unit: 'default' } }).ok).toBe(false)
        expect(core.command({ type: 'sendFine', id: 'm-a', ch2: 256 }).ok).toBe(false)
        expect(core.command({ type: 'sendFine', id: 'm-a', ch2: 1.5 }).ok).toBe(false)
        expect(core.command({ type: 'sendFine', id: 'nope', ch2: 1 }).ok).toBe(false)
      } finally {
        core.stop()
      }
    })

    it('CH2 chỉ đổi khi người dùng nhập: move/lock/estop/stop/khoá module/timeline không đụng CH2', () => {
      const core = new GauzeCore((_cfg, events) => new MockDriver(events), () => now)
      now = 1000
      core.configure(cfgOf(77))
      try {
        core.command({ type: 'lock', locked: false })
        const ch2 = () => [core.snapshot().frame[1], core.snapshot().frame[5]]
        tickAt(core, 1000)
        expect(ch2()).toEqual([77, 0])
        const steps: Array<() => void> = [
          () => core.command({ type: 'move', ids: ['m-a', 'm-b'], target: 0.4, speed: { unit: 'cms', value: 60 } }),
          () => core.command({ type: 'move', ids: ['m-a'], target: 'min', speed: { unit: 'sec', value: 2 } }),
          () => core.command({ type: 'stop', ids: 'all' }),
          () => core.command({ type: 'lock', locked: true }),
          () => core.command({ type: 'estop' }),
          () => core.configure(cfgOf(77)),
          () => core.configure(cfgOf(77)),
        ]
        let t = 1000
        for (const step of steps) {
          step()
          for (let i = 0; i < 5; i++) tickAt(core, (t += 200))
          expect(ch2()).toEqual([77, 0])
        }
        // chỉ đổi khi người dùng nhập: cfg mới hoặc Sent
        core.configure(cfgOf(5))
        tickAt(core, (t += 40))
        expect(ch2()[0]).toBe(5)
        core.command({ type: 'sendFine', id: 'm-a', ch2: 200 })
        tickAt(core, (t += 40))
        expect(ch2()[0]).toBe(200)
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
