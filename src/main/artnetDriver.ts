import dgram from 'node:dgram'
import { buildArtDmx, buildArtPoll, parseArtPollReply } from '@shared/artnet'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import type { OutputSettings } from '@shared/types'
import { UdpSocketLifecycle } from './udpSocketLifecycle'

/**
 * Driver Art-Net qua UDP (cổng 6454 mặc định).
 * Hỗ trợ broadcast (255.255.255.255) lẫn unicast IP trong Settings.
 */
export class ArtNetDriver implements OutputDriver {
  readonly id = 'artnet' as const
  private readonly life = new UdpSocketLifecycle()
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.life.attach(sock)

    sock.on('error', (err) => {
      if (!this.life.closing) this.ev.onError(`Lỗi UDP Art-Net: ${err.message}`)
    })

    sock.on('message', (msg, rinfo) => {
      const reply = parseArtPollReply(msg)
      if (!reply) return
      this.ev.onNode({
        ip: reply.ip === '0.0.0.0' ? rinfo.address : reply.ip,
        name: reply.name || rinfo.address,
        longName: reply.longName || reply.name || 'Art-Net Node',
        lastSeen: Date.now(),
      })
    })

    sock.bind(this.cfg.port, () => {
      try {
        sock.setBroadcast(true)
        if (!this.life.markReady()) return
        this.ev.onError(null)
        this.ev.onWarn(null)
      } catch (err) {
        if (!this.life.closing) {
          this.ev.onError(`Không bật được broadcast: ${(err as Error).message}`)
        }
      }
    })
  }

  send(net: number, subUni: number, data: Uint8Array): void {
    this.life.trackSend(
      (sock, done) => {
        this.seq = (this.seq % 255) + 1
        const subnet = (subUni >> 4) & 0x0f
        const universe = subUni & 0x0f
        const pkt = buildArtDmx(this.seq, net, subnet, universe, data)
        sock.send(pkt, this.cfg.port, this.cfg.ip, (err) => {
          const closing = this.life.closing
          done()
          if (closing) return
          if (err) this.ev.onError(`Gửi ArtDmx thất bại: ${err.message}`)
          else this.ev.onError(null)
        })
      },
      (err) => {
        if (!this.life.closing) this.ev.onError(`Gửi ArtDmx thất bại: ${(err as Error).message}`)
      },
    )
  }

  poll(): void {
    this.life.trackSend((sock, done) => {
      const pkt = buildArtPoll()
      sock.send(pkt, this.cfg.port, this.cfg.ip, (err) => {
        const closing = this.life.closing
        done()
        if (closing) return
        if (err) this.ev.onWarn(`ArtPoll lỗi: ${err.message}`)
      })
    })
  }

  stop(): void {
    this.life.stop()
  }
}
