import dgram from 'node:dgram'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import { SACN_PORT, buildSacnPacket, sacnMulticastIp } from '@shared/protocols'
import type { OutputSettings } from '@shared/types'
import { UdpSocketLifecycle } from './udpSocketLifecycle'

/**
 * Driver sACN (ANSI E1.31) qua UDP (cổng 5568 mặc định).
 * Hỗ trợ Multicast (239.255.x.y theo Universe) lẫn Unicast IP.
 */
export class SacnDriver implements OutputDriver {
  readonly id = 'sacn' as const
  private readonly life = new UdpSocketLifecycle()
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  private targetUniverse(): number {
    return Math.min(63999, Math.max(1, Math.round(this.cfg.sacnUniverse ?? this.cfg.universe + 1)))
  }

  private targetPort(): number {
    return this.cfg.port > 0 && this.cfg.port !== 6454 ? this.cfg.port : SACN_PORT
  }

  private targetIp(): string {
    if (this.cfg.sacnMulticast !== false) return sacnMulticastIp(this.targetUniverse())
    return this.cfg.ip || '127.0.0.1'
  }

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.life.attach(sock)

    sock.on('error', (err) => {
      if (!this.life.closing) this.ev.onError(`Lỗi UDP sACN E1.31: ${err.message}`)
    })

    sock.bind(0, () => {
      try {
        sock.setBroadcast(true)
        if (this.cfg.sacnMulticast !== false) sock.setMulticastTTL(4)
        if (!this.life.markReady()) return
        this.ev.onError(null)
        this.ev.onWarn(null)
      } catch (err) {
        if (!this.life.closing) {
          this.ev.onError(`Không khởi tạo được sACN E1.31: ${(err as Error).message}`)
        }
      }
    })
  }

  send(_net: number, _subUni: number, data: Uint8Array): void {
    this.life.trackSend(
      (sock, done) => {
        this.seq = (this.seq + 1) & 0xff
        const universe = this.targetUniverse()
        const ip = this.targetIp()
        const port = this.targetPort()
        const pkt = buildSacnPacket({
          universe,
          seq: this.seq,
          priority: this.cfg.sacnPriority ?? 100,
          sourceName: 'DMX Gauze',
          data,
        })
        sock.send(pkt, port, ip, (err) => {
          const closing = this.life.closing
          done()
          if (closing) return
          if (err) this.ev.onError(`Gửi sACN E1.31 thất bại: ${err.message}`)
          else {
            this.ev.onError(null)
            this.ev.onNode({
              ip,
              name: `sACN U${universe}`,
              longName: `E1.31 ${this.cfg.sacnMulticast !== false ? 'Multicast' : 'Unicast'} (${ip}:${port})`,
              lastSeen: Date.now(),
            })
          }
        })
      },
      (err) => {
        if (!this.life.closing) this.ev.onError(`Gửi sACN E1.31 thất bại: ${(err as Error).message}`)
      },
    )
  }

  poll(): void {
    // sACN gửi dữ liệu trực tiếp qua multicast/unicast; cập nhật thông tin đích nếu đã sẵn sàng
    if (!this.life.ready || this.life.closing) return
    const universe = this.targetUniverse()
    const ip = this.targetIp()
    const port = this.targetPort()
    this.ev.onNode({
      ip,
      name: `sACN U${universe}`,
      longName: `E1.31 ${this.cfg.sacnMulticast !== false ? 'Multicast' : 'Unicast'} (${ip}:${port})`,
      lastSeen: Date.now(),
    })
  }

  stop(): void {
    this.life.stop()
  }
}
