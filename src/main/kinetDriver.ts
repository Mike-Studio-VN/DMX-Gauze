import dgram from 'node:dgram'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import {
  KINET_PORT,
  buildKinetPollPacket,
  buildKinetV1Packet,
  buildKinetV2Packet,
  isKinetPollReply,
} from '@shared/protocols'
import type { OutputSettings } from '@shared/types'

/**
 * Driver KiNET (Color Kinetics) qua UDP (cổng 6038 mặc định).
 * Hỗ trợ KiNET v1 (DMXOUT) và KiNET v2 (PORT_OUT).
 */
export class KinetDriver implements OutputDriver {
  readonly id = 'kinet' as const
  private sock: dgram.Socket | null = null
  private ready = false
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  private targetPort(): number {
    return this.cfg.port > 0 && this.cfg.port !== 6454 ? this.cfg.port : KINET_PORT
  }

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.sock = sock

    sock.on('error', (err) => {
      this.ev.onError(`Lỗi UDP KiNET: ${err.message}`)
    })

    sock.on('message', (msg, rinfo) => {
      if (!isKinetPollReply(msg)) return
      this.ev.onNode({
        ip: rinfo.address,
        name: `KiNET PSU (${rinfo.address})`,
        longName: `Color Kinetics KiNET v${this.cfg.kinetVersion ?? 2}`,
        lastSeen: Date.now(),
      })
    })

    sock.bind(0, () => {
      try {
        sock.setBroadcast(true)
        this.ready = true
        this.ev.onError(null)
        this.ev.onWarn(null)
      } catch (err) {
        this.ev.onError(`Không khởi tạo được KiNET: ${(err as Error).message}`)
      }
    })
  }

  send(_net: number, _subUni: number, data: Uint8Array): void {
    if (!this.sock || !this.ready) return
    this.seq = (this.seq + 1) >>> 0
    const port = this.targetPort()
    const kinetPort = Math.min(16, Math.max(1, Math.round(this.cfg.kinetPort ?? 1)))
    const ver = this.cfg.kinetVersion ?? 2
    const pkt =
      ver === 1
        ? buildKinetV1Packet(this.seq, kinetPort, data)
        : buildKinetV2Packet(this.seq, this.cfg.universe, kinetPort, data)

    const ip = this.cfg.ip || '255.255.255.255'
    this.sock.send(pkt, port, ip, (err) => {
      if (err) this.ev.onError(`Gửi KiNET thất bại: ${err.message}`)
      else {
        this.ev.onError(null)
        if (ip !== '255.255.255.255') {
          this.ev.onNode({
            ip,
            name: `KiNET v${ver} P${kinetPort}`,
            longName: `KiNET đích ${ip}:${port}`,
            lastSeen: Date.now(),
          })
        }
      }
    })
  }

  poll(): void {
    if (!this.sock || !this.ready) return
    const pkt = buildKinetPollPacket()
    this.sock.send(pkt, this.targetPort(), this.cfg.ip || '255.255.255.255', (err) => {
      if (err) this.ev.onWarn(`KiNET Poll lỗi: ${err.message}`)
    })
  }

  stop(): void {
    this.ready = false
    if (this.sock) {
      try {
        this.sock.close()
      } catch {
        /* ignore */
      }
      this.sock = null
    }
  }
}
