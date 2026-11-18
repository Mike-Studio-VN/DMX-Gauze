import { portAddress } from './artnet'
import { ARTNET_PORT, CH, CHANNELS_PER_MODULE, DMX_UNIVERSE_SIZE, SENT_CH4_PULSE_VALUE, SENT_PULSE_MS } from './dmx'
import { ch3ToCms, clamp, cmsToCh3, durationToCh3, posToCh1, snapPos, speedCap } from './convert'
import { DEFAULT_DMX_TRANSPORT_HZ, normalizeDmxTransportRate, startDmxFrameLoop } from './dmxTransport'
import type { DriverFactory, DriverEvents, OutputDriver } from './drivers'
import { defaultMotionSpeedCh3 } from './timeline'
import type {
  Command,
  CommandResult,
  ConnectionStatus,
  CoreConfig,
  ModuleCfg,
  ModuleState,
  NodeInfo,
  OutputSettings,
  Snapshot,
} from './types'

const NODE_TIMEOUT_MS = 6000
const POLL_EVERY_MS = 2500

function limits(m: ModuleCfg): [number, number] {
  const hi = Math.min(m.maxHeight, m.length)
  const lo = Math.min(Math.max(m.minHeight, 0), hi)
  return [lo, hi]
}

/**
 * Lõi điều khiển: giữ trạng thái màn (vị trí ước lượng), dựng khung DMX, gửi qua driver,
 * theo dõi kết nối. Không phụ thuộc môi trường nên chạy được ở main (Art-Net thật) và renderer (mock).
 */
export class GauzeCore {
  private cfg: CoreConfig | null = null
  private modules = new Map<string, ModuleCfg>()
  private states = new Map<string, ModuleState>()
  private locked = true
  private driver: OutputDriver | null = null
  private driverKey = ''
  private nodes = new Map<string, NodeInfo>()
  private driverError: string | null = null
  private driverWarn: string | null = null
  private everOnline = false
  private framesSent = 0
  private rateWindowStart = 0
  private measuredHz = 0
  private frame = new Uint8Array(DMX_UNIVERSE_SIZE)
  /** Khoá theo module, nạp từ ModuleCfg.locked mỗi lần configure. */
  private moduleLocks = new Set<string>()
  /** Xung Sent đang chạy (CH4=77 tới `until`, CH2 = ch2). */
  private pulses = new Map<string, { until: number; ch2: number }>()
  /** Module đã hết xung: CH4 giữ 0 tới khi nhận lệnh move kế tiếp. */
  private zeroHold = new Set<string>()
  private sendHz: number = DEFAULT_DMX_TRANSPORT_HZ
  private stopFrameLoop: (() => void) | null = null
  private lastTick = 0
  private lastPoll = 0
  private flushLen = 2
  private lastSentRoute: { net: number; subUni: number } | null = null
  private listeners = new Set<(s: Snapshot) => void>()

  constructor(
    private readonly factory: DriverFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  configure(cfg: CoreConfig): void {
    const prevUsed = this.usedLength()
    const prevRoute =
      this.lastSentRoute ??
      (this.cfg ? { net: this.cfg.output.net, subUni: (this.cfg.output.subnet << 4) | this.cfg.output.universe } : null)

    const wasLocked = this.moduleLocks
    this.cfg = cfg
    this.modules = new Map(cfg.modules.map((m) => [m.id, m]))
    for (const m of cfg.modules) {
      if (!this.states.has(m.id)) this.states.set(m.id, { pos: 0, target: 0, ch3: m.defaultSpeed, moving: false })
    }
    for (const id of [...this.states.keys()]) if (!this.modules.has(id)) this.states.delete(id)
    for (const id of [...this.pulses.keys()]) if (!this.modules.has(id)) this.pulses.delete(id)
    for (const id of [...this.zeroHold]) if (!this.modules.has(id)) this.zeroHold.delete(id)
    this.moduleLocks = new Set(cfg.modules.filter((m) => m.locked).map((m) => m.id))
    for (const id of this.moduleLocks) {
      if (!wasLocked.has(id)) this.hold(id) // vừa khoá: đứng yên
    }
    // Áp lại giới hạn min/max cho mục tiêu hiện có.
    for (const [id, st] of this.states) {
      const [lo, hi] = limits(this.modules.get(id)!)
      st.target = snapPos(clamp(st.target, lo, hi), this.modules.get(id)!)
    }
    const { sendHz, ...driverSettings } = cfg.output
    const key = JSON.stringify(driverSettings)
    if (key !== this.driverKey) {
      this.restartDriver(cfg.output, key, prevUsed, prevRoute)
    } else {
      this.flushLen = Math.max(this.flushLen, prevUsed)
    }
    this.buildFrame()

    const nextHz = normalizeDmxTransportRate(sendHz)
    if (nextHz !== this.sendHz) {
      this.sendHz = nextHz
      this.framesSent = 0
      this.measuredHz = 0
      this.rateWindowStart = this.now()
      if (this.stopFrameLoop) {
        this.stopFrameLoop()
        this.stopFrameLoop = startDmxFrameLoop(this.sendHz, () => this.tick())
      }
    }
  }

  private flushZeroRoute(driver: OutputDriver | null, route: { net: number; subUni: number } | null, len: number): void {
    if (!driver || !route) return
    const n = Math.min(DMX_UNIVERSE_SIZE, Math.max(2, len))
    driver.send(route.net, route.subUni, new Uint8Array(n))
  }

  private restartDriver(
    out: OutputSettings,
    key: string,
    prevUsed = this.usedLength(),
    prevRoute: { net: number; subUni: number } | null = this.lastSentRoute,
  ): void {
    if (this.driver) {
      this.flushZeroRoute(this.driver, prevRoute, Math.max(prevUsed, this.flushLen))
      this.driver.stop()
    }
    this.lastSentRoute = null
    this.flushLen = 2
    this.nodes.clear()
    this.driverError = null
    this.driverWarn = null
    this.everOnline = false
    this.framesSent = 0
    this.rateWindowStart = this.now()
    this.driverKey = key
    const ev: DriverEvents = {
      // Node tự dựng (confirmed:false) lưu khoá riêng để không ghi đè / bị phản hồi thật ghi đè cùng IP.
      onNode: (n) => this.nodes.set(n.confirmed === false ? `${n.ip}#unconfirmed` : n.ip, n),
      onError: (m) => {
        this.driverError = m
      },
      onWarn: (m) => {
        this.driverWarn = m
      },
    }
    this.driver = this.factory(out, ev)
    this.driver.start()
    this.driver.poll()
    this.lastPoll = this.now()
  }

  start(): void {
    if (this.stopFrameLoop) return
    this.lastTick = this.now()
    this.rateWindowStart = this.lastTick
    this.framesSent = 0
    this.measuredHz = 0
    this.stopFrameLoop = startDmxFrameLoop(this.sendHz, () => this.tick())
  }

  stop(): void {
    this.stopFrameLoop?.()
    this.stopFrameLoop = null
    const flushTargetLen = Math.max(this.usedLength(), this.flushLen)
    const route =
      this.lastSentRoute ??
      (this.cfg ? { net: this.cfg.output.net, subUni: (this.cfg.output.subnet << 4) | this.cfg.output.universe } : null)
    this.holdAll()
    this.locked = true
    this.frame.fill(0)
    if (this.driver) {
      this.flushZeroRoute(this.driver, route, flushTargetLen)
      this.driver.stop()
    }
    this.driver = null
    this.driverKey = ''
    this.lastSentRoute = null
    this.flushLen = 2
  }

  pollNow(): void {
    this.driver?.poll()
    this.lastPoll = this.now()
  }

  // ---- Lệnh ----

  command(cmd: Command): CommandResult {
    switch (cmd.type) {
      case 'lock':
        this.locked = cmd.locked
        if (cmd.locked) {
          this.holdAll()
        }
        return { ok: true }
      case 'estop':
        this.holdAll()
        this.locked = true
        return { ok: true }
      case 'stop': {
        const ids = cmd.ids === 'all' ? [...this.states.keys()] : cmd.ids
        for (const id of ids) this.hold(id)
        return { ok: true }
      }
      case 'move':
        return this.move(cmd)
      case 'sendFine':
        return this.sendFine(cmd.id, cmd.ch2)
    }
  }

  private sendFine(id: string, ch2: number): CommandResult {
    const st = this.states.get(id)
    if (!this.modules.has(id) || !st) return { ok: false, message: 'Không tìm thấy module.' }
    if (!Number.isInteger(ch2) || ch2 < 0 || ch2 > 255) return { ok: false, message: 'CH2 phải là số nguyên 0–255.' }
    // Giữ nguyên chỗ: CH1 = vị trí đang giữ (nếu đang chạy thì dừng tại chỗ), không đặt đích mới; CH3 theo hành vi hiện có.
    if (st.moving || Math.abs(st.target - st.pos) > 1e-6) this.hold(id)
    this.pulses.set(id, { until: this.now() + SENT_PULSE_MS, ch2 })
    this.zeroHold.delete(id)
    return { ok: true }
  }

  private hold(id: string): void {
    const st = this.states.get(id)
    if (st) {
      st.target = st.pos
      st.moving = false
    }
  }

  private holdAll(): void {
    for (const id of this.states.keys()) this.hold(id)
  }

  private move(cmd: Extract<Command, { type: 'move' }>): CommandResult {
    if (this.locked) return { ok: false, message: 'Đang khoá an toàn. Mở khoá để điều khiển.' }
    const warnings: string[] = []
    for (const id of cmd.ids) {
      const m = this.modules.get(id)
      const st = this.states.get(id)
      if (!m || !st) continue
      if (this.moduleLocks.has(id)) {
        warnings.push(`${m.name}: module đang khoá, bỏ qua.`)
        continue
      }
      this.zeroHold.delete(id) // move hợp lệ: trở lại điều khiển bình thường (CH4 theo khoá)
      const [lo, hi] = limits(m)
      let target: number
      switch (cmd.target) {
        case 'min':
          target = lo
          break
        case 'max':
          target = hi
          break
        case 'zero':
          target = 0
          break
        case 'length':
          target = m.length
          break
        default:
          target = cmd.target
      }
      const clamped = snapPos(clamp(target, lo, hi), m) // đích thực tế sau lượng tử hoá CH1
      if (Math.abs(clamped - target) > 1e-6 && typeof cmd.target === 'number') {
        warnings.push(`${m.name}: giới hạn ${lo}–${hi} m`)
      }
      const dist = clamped - st.pos
      let ch3 = m.defaultSpeed
      const capCh3 = cmsToCh3(speedCap(m))
      if (cmd.speed.unit === 'cms') ch3 = Math.min(cmsToCh3(cmd.speed.value), capCh3)
      else if (cmd.speed.unit === 'sec') {
        const c = durationToCh3(dist, cmd.speed.value, speedCap(m))
        ch3 = c.ch3
        if (c.tooFast && Math.abs(dist) > 1e-4) warnings.push(`${m.name}: cần tối thiểu ${c.minSeconds.toFixed(1)} s`)
      }
      st.target = clamped
      const speedLimit = cmd.speed.unit === 'default' ? undefined : cmd.speed.limitCms
      const motionCap = speedLimit === undefined ? capCh3 : defaultMotionSpeedCh3(m, speedLimit)
      st.ch3 = Math.min(ch3, motionCap)
    }
    return { ok: true, warnings: warnings.length ? warnings : undefined }
  }

  // ---- Vòng lặp ----

  /** Public để test chạy với đồng hồ giả. */
  tick(): void {
    const now = this.now()
    const dt = Math.min(0.25, Math.max(0, (now - this.lastTick) / 1000))
    this.lastTick = now
    this.simulate(dt)
    this.buildFrame()
    this.sendFrame(now)
    if (now - this.lastPoll >= POLL_EVERY_MS) this.pollNow()
    // Mỗi tick phát đúng một snapshot.
    const s = this.snapshot()
    for (const l of this.listeners) l(s)
  }

  private simulate(dt: number): void {
    for (const [id, st] of this.states) {
      const diff = st.target - st.pos
      if (this.locked || this.moduleLocks.has(id) || Math.abs(diff) < 1e-6) {
        st.moving = false
        continue
      }
      const step = (ch3ToCms(st.ch3) / 100) * dt
      if (Math.abs(diff) <= step) {
        st.pos = st.target
        st.moving = false
      } else {
        st.pos += Math.sign(diff) * step
        st.moving = true
      }
    }
  }

  private buildFrame(): void {
    const nowMs = this.now()
    for (const [id, p] of this.pulses) {
      if (nowMs >= p.until) {
        this.pulses.delete(id) // hết xung: CH4 về 0 và giữ 0
        this.zeroHold.add(id)
      }
    }
    this.frame.fill(0)
    const lockVal = this.locked ? 0 : (this.cfg?.lockValue ?? 77)
    for (const m of this.modules.values()) {
      const st = this.states.get(m.id)
      const a = m.startAddress - 1
      if (!st || a < 0 || a + CHANNELS_PER_MODULE > DMX_UNIVERSE_SIZE) continue
      this.frame[a + CH.POSITION] = posToCh1(st.target, m)
      // CH2: nơi DUY NHẤT ghi CH2 — giá trị người dùng nhập (cfg.ch2Fine hoặc ch2 của xung Sent), không phụ thuộc vị trí/lệnh/khoá.
      const pulse = this.pulses.get(m.id)
      this.frame[a + CH.FINE] = pulse ? pulse.ch2 : clamp(Math.round(m.ch2Fine ?? 0), 0, 255)
      this.frame[a + CH.SPEED] = st.ch3
      if (pulse) this.frame[a + CH.LOCK] = SENT_CH4_PULSE_VALUE
      else this.frame[a + CH.LOCK] = this.zeroHold.has(m.id) || this.moduleLocks.has(m.id) ? 0 : lockVal
    }
  }

  private usedLength(): number {
    let max = 2
    for (const m of this.modules.values()) max = Math.max(max, m.startAddress - 1 + CHANNELS_PER_MODULE)
    return Math.min(DMX_UNIVERSE_SIZE, max)
  }

  private sendFrame(now: number): void {
    if (!this.driver || !this.cfg) return
    const o = this.cfg.output
    const subUni = (o.subnet << 4) | o.universe
    if (this.lastSentRoute && (this.lastSentRoute.net !== o.net || this.lastSentRoute.subUni !== subUni)) {
      this.flushZeroRoute(this.driver, this.lastSentRoute, Math.max(this.flushLen, this.usedLength()))
    }
    const sendLen = Math.min(DMX_UNIVERSE_SIZE, Math.max(this.usedLength(), this.flushLen))
    this.driver.send(o.net, subUni, this.frame.slice(0, sendLen))
    this.lastSentRoute = { net: o.net, subUni }
    this.flushLen = 2
    this.framesSent += 1
    if (now - this.rateWindowStart >= 1000) {
      this.measuredHz = Math.round((this.framesSent * 1000) / (now - this.rateWindowStart))
      this.framesSent = 0
      this.rateWindowStart = now
    }
  }

  // ---- Trạng thái ----

  status(): ConnectionStatus {
    const o = this.cfg?.output
    const now = this.now()
    const live = [...this.nodes.values()].filter((n) => now - n.lastSeen <= NODE_TIMEOUT_MS)
    const confirmed = live.some((n) => n.confirmed !== false)
    if (confirmed) this.everOnline = true
    let state: ConnectionStatus['state']
    if (!this.driver) state = 'idle'
    else if (this.driverError) state = 'error'
    else if (confirmed) state = 'online'
    else if (live.length) state = 'sending'
    else if (this.everOnline) state = 'lost'
    else state = 'searching'
    return {
      state,
      driver: o?.driver ?? 'mock',
      ip: o?.ip ?? '',
      port: o?.port ?? ARTNET_PORT,
      portAddress: o ? portAddress(o.net, o.subnet, o.universe) : 0,
      sendHz: this.measuredHz,
      nodes: live.filter((n) => n.confirmed !== false), // danh sách discovery chỉ gồm thiết bị thật đã phản hồi
      message: this.driverError,
      warning: this.driverWarn,
    }
  }

  snapshot(): Snapshot {
    const modules: Record<string, ModuleState> = {}
    for (const [id, st] of this.states) modules[id] = { ...st }
    return {
      t: this.now(),
      modules,
      locked: this.locked,
      status: this.status(),
      frame: this.frame.slice(),
      pulsing: [...this.pulses.keys()],
      moduleLocks: [...this.moduleLocks],
    }
  }
}
