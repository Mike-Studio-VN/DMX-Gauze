import dgram from 'node:dgram'
import { buildArtDmx, buildArtPoll, parseArtPollReply } from '@shared/artnet'
import { ARTNET_PORT, isLoopbackTarget } from '@shared/dmx'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import type { OutputSettings } from '@shared/types'
import { UdpSocketLifecycle } from './udpSocketLifecycle'

const LOOPBACK_POLL_WINDOW_MS = 1500

/**
 * Driver Art-Net qua UDP (cổng mặc định 6454, tôn trọng mọi custom port người dùng cấu hình).
 * - Socket gửi luôn bind cổng động (0) để không xung đột cổng 6454 với receiver cục bộ (vd: TD dmx_in),
 *   và vẫn nhận ArtPollReply gửi về cổng nguồn động.
 * - Nghe ArtPollReply chuẩn trên UDP 6454:
 *   + Đích LAN: giữ listener 6454 (tắt + cảnh báo mềm nếu 6454 đang bận).
 *   + Đích loopback (localhost/127.0.0.1): nếu receiver đặt cổng khác 6454 thì nghe 6454 bình thường;
 *     nếu receiver dùng đúng 6454 thì chỉ mở listener ngắn hạn khi quét (reuseAddr: false, tự đóng sau
 *     1.5 s) để vẫn nhận phản hồi chuẩn 6454 mà không chiếm giữ/giành gói của receiver cục bộ.
 */
export class ArtNetDriver implements OutputDriver {
  readonly id = 'artnet' as const
  private readonly life = new UdpSocketLifecycle()
  private rxSock: dgram.Socket | null = null
  private rxCloseTimer: ReturnType<typeof setTimeout> | null = null
  private rxDisabled = false
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  private targetPort(): number {
    return this.cfg.port > 0 ? this.cfg.port : ARTNET_PORT
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

  private clearRxTimer(): void {
    if (this.rxCloseTimer) {
      clearTimeout(this.rxCloseTimer)
      this.rxCloseTimer = null
    }
  }

  private closeRxSocket(): void {
    this.clearRxTimer()
    const rx = this.rxSock
    this.rxSock = null
    if (!rx) return
    try {
      rx.close()
    } catch {
      /* ignore */
    }
  }

  private ensurePollReplyListener(explicit: boolean): void {
    if (this.life.closing) return
    const loopbackSamePort = isLoopbackTarget(this.cfg.ip) && this.targetPort() === ARTNET_PORT
    if (loopbackSamePort && !explicit) return
    if (explicit && loopbackSamePort) {
      this.rxDisabled = false
    }
    if (this.rxSock || this.rxDisabled) return

    const listenPort = ARTNET_PORT
    const rx = dgram.createSocket({ type: 'udp4', reuseAddr: !loopbackSamePort })
    this.rxSock = rx

    const disableRx = (reason: string) => {
      this.rxDisabled = true
      this.clearRxTimer()
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
      const bindDone = () => {
        if (this.life.closing || this.rxSock !== rx) {
          try {
            rx.close()
          } catch {
            /* ignore */
          }
          return
        }
        if (loopbackSamePort) {
          this.clearRxTimer()
          this.rxCloseTimer = setTimeout(() => {
            if (this.rxSock === rx) this.closeRxSocket()
          }, LOOPBACK_POLL_WINDOW_MS)
          this.rxCloseTimer.unref?.()
        }
      }
      if (loopbackSamePort) {
        rx.bind(listenPort, '127.0.0.1', bindDone)
      } else {
        rx.bind(listenPort, bindDone)
      }
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

  poll(explicit = true): void {
    this.ensurePollReplyListener(explicit)
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
