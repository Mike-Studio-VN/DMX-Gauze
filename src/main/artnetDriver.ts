import dgram from 'node:dgram'
import { buildArtDmx, buildArtPoll, parseArtPollReply } from '@shared/artnet'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import type { OutputSettings } from '@shared/types'

/**
 * Driver Art-Net qua UDP (cổng 6454 mặc định).
 * Hỗ trợ broadcast (255.255.255.255) lẫn unicast IP trong Settings.
 */
export class ArtNetDriver implements OutputDriver {
  readonly id = 'artnet' as const
  private sock: dgram.Socket | null = null
  private ready = false
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.sock = sock

    sock.on('error', (err) => {
      this.ev.onError(`Lỗi UDP Art-Net: ${err.message}`)
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
        this.ready = true
        this.ev.onError(null)
        this.ev.onWarn(null)
      } catch (err) {
        this.ev.onError(`Không bật được broadcast: ${(err as Error).message}`)
      }
    })
  }

  send(net: number, subUni: number, data: Uint8Array): void {
    if (!this.sock || !this.ready) return
    this.seq = (this.seq % 255) + 1
    const subnet = (subUni >> 4) & 0x0f
    const universe = subUni & 0x0f
    const pkt = buildArtDmx(this.seq, net, subnet, universe, data)
    this.sock.send(pkt, this.cfg.port, this.cfg.ip, (err) => {
      if (err) this.ev.onError(`Gửi ArtDmx thất bại: ${err.message}`)
      else this.ev.onError(null)
    })
  }

  poll(): void {
    if (!this.sock || !this.ready) return
    const pkt = buildArtPoll()
    this.sock.send(pkt, this.cfg.port, this.cfg.ip, (err) => {
      if (err) this.ev.onWarn(`ArtPoll lỗi: ${err.message}`)
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
