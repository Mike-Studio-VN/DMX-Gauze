// Hằng số theo spec màn gauze 4 kênh (đã chốt với người dùng 17/11).
export const CHANNELS_PER_MODULE = 4
export const CH = { POSITION: 0, FINE: 1, SPEED: 2, LOCK: 3 } as const
export const LOCK_VALUE = 77
/** Nút Sent: CH4 phát giá trị này (77) trong SENT_PULSE_MS rồi tự về 0 và giữ 0. */
export const SENT_CH4_PULSE_VALUE = 77
export const SENT_PULSE_MS = 500
export const DEFAULT_SPEED = 100
/** Tốc độ tối đa MẶC ĐỊNH cho module mới (H2, cm/s). Thang CH3 thực tế lấy từ `maxSpeedCms` của từng module (255 = maxSpeedCms). */
export const H2_MAX_SPEED_CMS = 120
export const DMX_UNIVERSE_SIZE = 512
export const DEFAULT_TARGET_IP = '255.255.255.255'
export const ARTNET_PORT = 6454

/** Dải địa chỉ [start, end] (1-based, inclusive) mà một module chiếm. */
export function addressRange(start: number): [number, number] {
  return [start, start + CHANNELS_PER_MODULE - 1]
}

/** Địa chỉ hợp lệ: 1..509 để đủ 4 kênh trong universe 512. */
export function isValidStartAddress(start: number): boolean {
  return Number.isInteger(start) && start >= 1 && start + CHANNELS_PER_MODULE - 1 <= DMX_UNIVERSE_SIZE
}

/** Hai module có chồng lấn kênh (cùng universe) hay không. */
export function rangesOverlap(a: number, b: number): boolean {
  const [a0, a1] = addressRange(a)
  const [b0, b1] = addressRange(b)
  return a0 <= b1 && b0 <= a1
}

export function isValidIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim())
  return !!m && m.slice(1).every((p) => Number(p) <= 255)
}

export function isLoopbackTarget(ip: string): boolean {
  const s = ip.trim().toLowerCase()
  return s === 'localhost' || s === '::1' || s === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(s)
}
