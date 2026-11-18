// Bộ giải mã LTC (SMPTE linear timecode, biphase mark) từ mẫu audio.
export interface LtcFrame {
  h: number
  m: number
  s: number
  f: number
  df: boolean
}

// Sync word: bit 64..79 truyền theo thứ tự 0011 1111 1111 1101.
const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]

function bcd(bits: number[], start: number, len: number): number {
  let v = 0
  for (let i = 0; i < len; i += 1) v |= bits[start + i] << i
  return v
}

export class LtcDecoder {
  private readonly bitPeriod: number
  private period: number
  private sign = 0
  private since = 0
  private half = false
  private bits: number[] = []
  private maxF = 0
  private frameCount = 0

  constructor(
    sampleRate: number,
    private readonly onFrame: (f: LtcFrame) => void,
    nominalFps = 30,
    private readonly hysteresis = 0.02,
  ) {
    this.bitPeriod = sampleRate / (nominalFps * 80)
    this.period = this.bitPeriod
  }

  /** Số fps ước lượng từ frame lớn nhất đã thấy. */
  get detectedFps(): number {
    return this.maxF + 1
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i += 1) {
      const x = samples[i]
      this.since += 1
      let s = this.sign
      if (x > this.hysteresis) s = 1
      else if (x < -this.hysteresis) s = -1
      if (s !== this.sign) {
        if (this.sign !== 0) this.interval(this.since)
        this.sign = s
        this.since = 0
      }
      if (this.since > this.period * 8) {
        // mất tín hiệu
        this.since = 0
        this.half = false
        this.bits = []
      }
    }
  }

  private interval(d: number): void {
    const short = d < this.period * 0.75
    if (short) {
      if (this.half) {
        this.half = false
        this.period = this.period * 0.9 + d * 2 * 0.1
        this.bit(1)
      } else this.half = true
    } else {
      if (this.half) {
        // lỗi nhịp: bỏ nửa bit treo
        this.half = false
        this.bits = []
        return
      }
      this.period = this.period * 0.9 + d * 0.1
      this.bit(0)
    }
  }

  private bit(b: number): void {
    this.bits.push(b)
    if (this.bits.length > 80) this.bits.shift()
    if (this.bits.length < 80) return
    for (let i = 0; i < 16; i += 1) if (this.bits[64 + i] !== SYNC[i]) return
    const bs = this.bits
    const f = bcd(bs, 0, 4) + 10 * bcd(bs, 8, 2)
    const s = bcd(bs, 16, 4) + 10 * bcd(bs, 24, 3)
    const m = bcd(bs, 32, 4) + 10 * bcd(bs, 40, 3)
    const h = bcd(bs, 48, 4) + 10 * bcd(bs, 56, 2)
    if (f > 29 || s > 59 || m > 59 || h > 23) return
    this.frameCount += 1
    if (this.frameCount % 120 === 0) this.maxF = 0
    this.maxF = Math.max(this.maxF, f)
    this.onFrame({ h, m, s, f, df: bs[10] === 1 })
    this.bits = []
  }
}

export type LtcClockStatus = 'off' | 'lock' | 'freewheel' | 'lost'

export interface LtcClockPollResult {
  status: Exclude<LtcClockStatus, 'off'>
  timeSec: number | null
  shouldFollow: boolean
  shouldStop: boolean
}

export interface LtcDecodedTime {
  timeSec: number
  discontinuity: boolean
}

/**
 * Bộ theo dõi đồng hồ LTC kèm nội suy chạy trớn (freewheel) có giới hạn trong `freewheelFrames`
 * và chuyển trạng thái `lost` dứt khoát khi quá ngưỡng.
 */
export class LtcClockTracker {
  private lastFrameAtMs: number | null = null
  private lastSec = 0
  private lastPublishedSec = 0
  private stopDispatchedOnLoss = false

  reset(): void {
    this.lastFrameAtMs = null
    this.lastSec = 0
    this.lastPublishedSec = 0
    this.stopDispatchedOnLoss = false
  }

  onDecodedFrame(sec: number, nowMs: number): LtcDecodedTime {
    // Only consecutive source timestamps can identify a seek. The published
    // clock may already be ahead of a late, but sequential, audio frame.
    const discontinuity = this.lastFrameAtMs !== null && (sec < this.lastSec || sec - this.lastSec > 0.25)
    this.lastFrameAtMs = nowMs
    this.lastSec = sec
    if (discontinuity) this.lastPublishedSec = Math.max(0, sec)
    this.stopDispatchedOnLoss = false
    return { timeSec: this.advanceTo(sec), discontinuity }
  }

  private advanceTo(sec: number): number {
    this.lastPublishedSec = Math.max(this.lastPublishedSec, sec)
    return this.lastPublishedSec
  }

  poll(nowMs: number, fps: number, freewheelFrames: number): LtcClockPollResult {
    if (this.lastFrameAtMs === null) {
      return { status: 'lost', timeSec: null, shouldFollow: false, shouldStop: false }
    }
    const gapMs = Math.max(0, nowMs - this.lastFrameAtMs)
    const fwSec = Math.max(0, freewheelFrames) / Math.max(1, fps)
    const fwMs = fwSec * 1000

    const lockGraceMs = 80
    if (gapMs <= Math.max(lockGraceMs, fwMs)) {
      const status = gapMs <= lockGraceMs ? 'lock' : 'freewheel'
      const timeSec = this.advanceTo(this.lastSec + gapMs / 1000)
      return { status, timeSec, shouldFollow: true, shouldStop: false }
    }

    const boundedEndSec = this.lastSec + fwSec
    const finalSec = fwMs > 0 && this.lastPublishedSec < boundedEndSec ? this.advanceTo(boundedEndSec) : null
    const shouldStop = !this.stopDispatchedOnLoss
    this.stopDispatchedOnLoss = true
    return {
      status: 'lost',
      timeSec: finalSec,
      shouldFollow: false,
      shouldStop,
    }
  }
}
