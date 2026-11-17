// Quy đổi mét / tốc độ / giây ⇄ giá trị DMX (xem plan mục 8.2).

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Vị trí (m) → CH1 (coarse) + CH2 (fine) dạng 16-bit. */
export function posToDmx(pos: number, length: number): { coarse: number; fine: number } {
  const v = Math.round(clamp(length > 0 ? pos / length : 0, 0, 1) * 65535)
  return { coarse: v >> 8, fine: v & 0xff }
}

export function dmxToPos(coarse: number, fine: number, length: number): number {
  return (((coarse << 8) | fine) / 65535) * length
}

/** CH3 → tốc độ cm/s (tuyến tính, 255 = maxSpeed). */
export function ch3ToCms(ch3: number, maxSpeedCms: number): number {
  return (ch3 / 255) * maxSpeedCms
}

/** Tốc độ cm/s → CH3 (1..255; 0 là phanh nên không dùng khi chạy). */
export function cmsToCh3(cms: number, maxSpeedCms: number): number {
  return clamp(Math.ceil((cms / maxSpeedCms) * 255), 1, 255)
}

export interface DurationConv {
  ch3: number
  /** Thời gian tối thiểu (s) mà motor đi được quãng này ở tốc độ tối đa. */
  minSeconds: number
  tooFast: boolean
}

/** Quãng đường (m) trong N giây → CH3. */
export function durationToCh3(distM: number, seconds: number, maxSpeedCms: number): DurationConv {
  const dist = Math.abs(distM)
  const minSeconds = (dist * 100) / maxSpeedCms
  const ideal = ((dist * 100) / Math.max(seconds, 0.01) / maxSpeedCms) * 255
  return { ch3: clamp(Math.ceil(ideal), 1, 255), minSeconds, tooFast: ideal > 255 }
}
