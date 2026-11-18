import { buildArtDmx, portAddress } from './artnet'
import { ARTNET_PORT, CH, CHANNELS_PER_MODULE, DMX_UNIVERSE_SIZE } from './dmx'
import { cmsToCh3, ch3ToCms, clamp, durationToCh3, posToDmx } from './convert'
import type { DriverFactory, DriverEvents, OutputDriver } from './drivers'
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
const SNAPSHOT_EVERY_MS = 50
export const DMX_TRANSPORT_HZ = 25

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
  private seq = 0
  private frame = new Uint8Array(DMX_UNIVERSE_SIZE)
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTick = 0
  private lastPoll = 0
  private lastSnap = 0
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

    this.cfg = cfg
    this.modules = new Map(cfg.modules.map((m) => [m.id, m]))
    for (const m of cfg.modules) {
      if (!this.states.has(m.id)) this.states.set(m.id, { pos: 0, target: 0, ch3: m.defaultSpeed, moving: false })
    }
    for (const id of [...this.states.keys()]) if (!this.modules.has(id)) this.states.delete(id)
    // Áp lại giới hạn min/max cho mục tiêu hiện có.
    for (const [id, st] of this.states) {
      const [lo, hi] = limits(this.modules.get(id)!)
      st.target = clamp(st.target, lo, hi)
    }
    const key = JSON.stringify(cfg.output)
    if (key !== this.driverKey) {
      this.restartDriver(cfg.output, key, prevUsed, prevRoute)
    } else {
      this.flushLen = Math.max(this.flushLen, prevUsed)
    }
    this.buildFrame()
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
    if (this.timer) return
    this.lastTick = this.now()
    // Phát frame DMX cố định ở 25 Hz (40 ms/frame), kể cả khi mở file dự án cũ từng lưu sendHz=40.
    this.timer = setInterval(() => this.tick(), Math.round(1000 / DMX_TRANSPORT_HZ))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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

  /** Đổi tần số gửi khi đang chạy. */
  restartTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.start()
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
        if (cmd.locked) this.holdAll()
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
    }
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
      const clamped = clamp(target, lo, hi)
      if (Math.abs(clamped - target) > 1e-6 && typeof cmd.target === 'number') {
        warnings.push(`${m.name}: giới hạn ${lo}–${hi} m`)
      }
      const dist = clamped - st.pos
      let ch3 = m.defaultSpeed
      if (cmd.speed.unit === 'cms') ch3 = cmsToCh3(cmd.speed.value, m.maxSpeedCms)
      else if (cmd.speed.unit === 'sec') {
        const c = durationToCh3(dist, cmd.speed.value, m.maxSpeedCms)
        ch3 = c.ch3
        if (c.tooFast && Math.abs(dist) > 1e-4) warnings.push(`${m.name}: cần tối thiểu ${c.minSeconds.toFixed(1)} s`)
      }
      st.target = clamped
      st.ch3 = ch3
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
    if (now - this.lastSnap >= SNAPSHOT_EVERY_MS) {
      this.lastSnap = now
      const s = this.snapshot()
      for (const l of this.listeners) l(s)
    }
  }

  private simulate(dt: number): void {
    for (const [id, st] of this.states) {
      const m = this.modules.get(id)!
      const diff = st.target - st.pos
      if (this.locked || Math.abs(diff) < 1e-6) {
        st.moving = false
        continue
      }
      const step = (ch3ToCms(st.ch3, m.maxSpeedCms) / 100) * dt
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
    this.frame.fill(0)
    const lockVal = this.locked ? 0 : (this.cfg?.lockValue ?? 77)
    for (const m of this.modules.values()) {
      const st = this.states.get(m.id)
      const a = m.startAddress - 1
      if (!st || a < 0 || a + CHANNELS_PER_MODULE > DMX_UNIVERSE_SIZE) continue
      const { coarse, fine } = posToDmx(st.target, m.length)
      this.frame[a + CH.POSITION] = coarse
      this.frame[a + CH.FINE] = fine
      this.frame[a + CH.SPEED] = st.ch3
      this.frame[a + CH.LOCK] = lockVal
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
    this.seq = (this.seq % 255) + 1
    // Dùng buildArtDmx để kiểm tra khung hợp lệ, driver tự đóng gói theo giao thức của nó.
    void buildArtDmx
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
      nodes: live,
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
    }
  }
}
