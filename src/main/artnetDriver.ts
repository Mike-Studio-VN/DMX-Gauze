import dgram from 'node:dgram'
import { buildArtDmx, buildArtPoll, parseArtPollReply } from '@shared/artnet'
import { ARTNET_PORT, isLoopbackTarget } from '@shared/dmx'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import { KINET_PORT, SACN_PORT } from '@shared/protocols'
import type { OutputSettings } from '@shared/types'
import { UdpSocketLifecycle } from './udpSocketLifecycle'

/**
 * Driver Art-Net qua UDP (đích 6454 mặc định).
 * - Socket gửi luôn bind cổng động (0) để không xung đột cổng 6454 với receiver cục bộ (vd: TD dmx_in).
 * - Chỉ mở socket nghe ArtPollReply trên cổng 6454 khi quét node ở đích không phải localhost/127.0.0.1;
 *   nếu cổng 6454 bận thì tắt nhận ArtPollReply + báo cảnh báo mềm nhưng vẫn gửi ArtDmx bình thường.
 */
export class ArtNetDriver implements OutputDriver {
  readonly id = 'artnet' as const
  private readonly life = new UdpSocketLifecycle()
  private rxSock: dgram.Socket | null = null
  private rxDisabled = false
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  private targetPort(): number {
    return this.cfg.port > 0 && this.cfg.port !== SACN_PORT && this.cfg.port !== KINET_PORT
      ? this.cfg.port
      : ARTNET_PORT
  }

  private handleMessage = (msg: Uint8Array, rinfo: dgram.RemoteInfo): void => {
    const reply = parseArtPollReply(msg)
    if (!reply) return
    this.ev.onNode({
      ip: reply.ip === '0.0.0.0' ? rinfo.address : reply.ip,
      name: reply.name || rinfo.address,
      longName: reply.longName || reply.name || 'Art-Net Node',
      lastSeen: Date.now(),
    })
  }

  private closeRxSocket(): void {
    const rx = this.rxSock
    this.rxSock = null
    if (!rx) return
    try {
      rx.close()
    } catch {
      /* ignore */
    }
  }

  private ensurePollReplyListener(): void {
    if (this.life.closing || this.rxSock || this.rxDisabled) return
    if (isLoopbackTarget(this.cfg.ip)) return
    const listenPort = this.targetPort()
    const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.rxSock = rx

    const disableRx = (reason: string) => {
      this.rxDisabled = true
      if (this.rxSock === rx) this.rxSock = null
      try {
        rx.close()
      } catch {
        /* ignore */
      }
      if (!this.life.closing) {
        this.ev.onWarn(
          `Cổng ${listenPort} đang bận (${reason}) — đã tắt nghe ArtPollReply, vẫn gửi ArtDmx bình thường.`,
        )
      }
    }

    rx.on('error', (err) => {
      disableRx(err.message)
    })
    rx.on('message', this.handleMessage)

    try {
      rx.bind(listenPort, () => {
        if (this.life.closing || this.rxSock !== rx) {
          try {
            rx.close()
          } catch {
            /* ignore */
          }
        }
      })
    } catch (err) {
      disableRx((err as Error).message)
    }
  }

  start(): void {
    this.rxDisabled = false
    this.closeRxSocket()
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.life.attach(sock)

    sock.on('error', (err) => {
      if (!this.life.closing) this.ev.onError(`Lỗi UDP Art-Net: ${err.message}`)
    })

    sock.on('message', this.handleMessage)

    sock.bind(0, () => {
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
        sock.send(pkt, this.targetPort(), this.cfg.ip, (err) => {
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
    this.ensurePollReplyListener()
    this.life.trackSend((sock, done) => {
      const pkt = buildArtPoll()
      sock.send(pkt, this.targetPort(), this.cfg.ip, (err) => {
        const closing = this.life.closing
        done()
        if (closing) return
        if (err) this.ev.onWarn(`ArtPoll lỗi: ${err.message}`)
      })
    })
  }

  stop(): void {
    this.closeRxSocket()
    this.life.stop()
  }
}
