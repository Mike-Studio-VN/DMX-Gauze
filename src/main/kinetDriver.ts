import dgram from 'node:dgram'
import { ARTNET_PORT } from '@shared/dmx'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import {
  KINET_PORT,
  SACN_PORT,
  buildKinetPollPacket,
  buildKinetV1Packet,
  buildKinetV2Packet,
  isKinetPollReply,
} from '@shared/protocols'
import type { OutputSettings } from '@shared/types'
import { UdpSocketLifecycle } from './udpSocketLifecycle'

/**
 * Driver KiNET (Color Kinetics) qua UDP (cổng 6038 mặc định).
 * Hỗ trợ KiNET v1 (DMXOUT) và KiNET v2 (PORT_OUT).
 */
export class KinetDriver implements OutputDriver {
  readonly id = 'kinet' as const
  private readonly life = new UdpSocketLifecycle()
  private seq = 0

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {}

  private targetPort(): number {
    return this.cfg.port > 0 && this.cfg.port !== ARTNET_PORT && this.cfg.port !== SACN_PORT
      ? this.cfg.port
      : KINET_PORT
  }

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.life.attach(sock)

    sock.on('error', (err) => {
      if (!this.life.closing) this.ev.onError(`Lỗi UDP KiNET: ${err.message}`)
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
        if (!this.life.markReady()) return
        this.ev.onError(null)
        this.ev.onWarn(null)
      } catch (err) {
        if (!this.life.closing) {
          this.ev.onError(`Không khởi tạo được KiNET: ${(err as Error).message}`)
        }
      }
    })
  }

  send(_net: number, _subUni: number, data: Uint8Array): void {
    this.life.trackSend(
      (sock, done) => {
        this.seq = (this.seq + 1) >>> 0
        const port = this.targetPort()
        const kinetPort = Math.min(16, Math.max(1, Math.round(this.cfg.kinetPort ?? 1)))
        const ver = this.cfg.kinetVersion ?? 2
        const pkt =
          ver === 1
            ? buildKinetV1Packet(this.seq, kinetPort, data)
            : buildKinetV2Packet(this.seq, this.cfg.universe, kinetPort, data)

        const ip = this.cfg.ip || '255.255.255.255'
        sock.send(pkt, port, ip, (err) => {
          const closing = this.life.closing
          done()
          if (closing) return
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
      },
      (err) => {
        if (!this.life.closing) this.ev.onError(`Gửi KiNET thất bại: ${(err as Error).message}`)
      },
    )
  }

  poll(): void {
    this.life.trackSend((sock, done) => {
      const pkt = buildKinetPollPacket()
      sock.send(pkt, this.targetPort(), this.cfg.ip || '255.255.255.255', (err) => {
        const closing = this.life.closing
        done()
        if (closing) return
        if (err) this.ev.onWarn(`KiNET Poll lỗi: ${err.message}`)
      })
    })
  }

  stop(): void {
    this.life.stop()
  }
}
