import dgram from 'node:dgram'
import { buildArtDmx, buildArtPoll, parseArtPollReply } from '@shared/artnet'
import { ARTNET_PORT, isLoopbackTarget } from '@shared/dmx'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import type { OutputSettings } from '@shared/types'
import { UdpSocketLifecycle } from './udpSocketLifecycle'

/**
 * Driver Art-Net qua UDP (cổng mặc định 6454, tôn trọng mọi custom port người dùng cấu hình).
 * - Socket gửi luôn bind cổng động (0) để không xung đột cổng 6454 với receiver cục bộ (vd: TD dmx_in),
 *   và nhận ArtPollReply gửi về cổng nguồn động đó.
 * - Listener ArtPollReply trên cổng chuẩn 6454:
 *   + Đích LAN hoặc đích loopback dùng cổng đích != 6454: mở listener trên 6454 (tắt + cảnh báo mềm
 *     nếu 6454 bận, vẫn gửi ArtDmx bình thường).
 *   + Đích loopback dùng đúng cổng 6454: không bind 6454 để tránh chiếm/giành gói unicast trên cùng
 *     tuple (127.0.0.1, 6454) với receiver cục bộ (vd: TD dmx_in); nhận reply qua cổng nguồn động.
 */
export class ArtNetDriver implements OutputDriver {
  readonly id = 'artnet' as const
  private readonly life = new UdpSocketLifecycle()
  private rxSock: dgram.Socket | null = null
  private rxDisabled = false
  private warnNotified = false
  private receivedReply = false
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
    private readonly opts: { listenPort?: number } = {},
  ) {}

  private listenPort(): number {
    return this.opts.listenPort && this.opts.listenPort > 0 ? this.opts.listenPort : ARTNET_PORT
  }

  private targetPort(): number {
    return this.cfg.port > 0 ? this.cfg.port : ARTNET_PORT
  }

  private handleMessage = (msg: Uint8Array, rinfo: dgram.RemoteInfo): void => {
    const reply = parseArtPollReply(msg)
    if (!reply) return
    this.receivedReply = true
    this.ev.onWarn(null)
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
    const listenPort = this.listenPort()
    if (isLoopbackTarget(this.cfg.ip) && this.targetPort() === listenPort) {
      if (!this.receivedReply && !this.warnNotified) {
        this.warnNotified = true
        this.ev.onWarn(
          `Đích localhost:${listenPort}: không bind ${listenPort} để tránh tranh receiver cục bộ — trạng thái discovery không xác định (không đồng nghĩa receiver offline); vẫn gửi ArtDmx và nhận phản hồi bổ sung qua cổng nguồn động nếu node hỗ trợ.`,
        )
      }
      return
    }
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
          `Cổng ${listenPort} đang bận (${reason}) — đã tắt nghe ArtPollReply chuẩn, vẫn gửi ArtDmx và nhận phản hồi qua cổng nguồn động.`,
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
    this.warnNotified = false
    this.receivedReply = false
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
        if (!this.warnNotified && !this.rxDisabled) {
          this.ev.onWarn(null)
        }
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
