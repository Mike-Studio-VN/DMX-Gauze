import { buildArtPoll } from './artnet'
import type { DriverId, NodeInfo, OutputSettings } from './types'

export interface DriverEvents {
  onNode(n: NodeInfo): void
  /** Lỗi cứng (socket hỏng...). null = hết lỗi. */
  onError(msg: string | null): void
  /** Cảnh báo mềm. null = hết cảnh báo. */
  onWarn(msg: string | null): void
}

export interface OutputDriver {
  readonly id: DriverId
  start(): void
  send(net: number, subUni: number, data: Uint8Array): void
  poll(): void
  stop(): void
}

export type DriverFactory = (cfg: OutputSettings, ev: DriverEvents) => OutputDriver

/** Driver mô phỏng: không gửi gì ra mạng, giả lập một node Art-Net phản hồi ArtPoll. */
export class MockDriver implements OutputDriver {
  readonly id = 'mock' as const
  last: Uint8Array = new Uint8Array(0)
  sent = 0
  constructor(
    private readonly ev: DriverEvents,
    private readonly warn: string | null = null,
  ) {}
  start(): void {
    this.ev.onWarn(this.warn)
  }
  send(_net: number, _subUni: number, data: Uint8Array): void {
    this.last = data
    this.sent += 1
  }
  poll(): void {
    void buildArtPoll()
    this.ev.onNode({ ip: '127.0.0.1', name: 'Mock Node', longName: 'Node Art-Net mô phỏng', lastSeen: Date.now() })
  }
  stop(): void {
    /* no-op */
  }
}
