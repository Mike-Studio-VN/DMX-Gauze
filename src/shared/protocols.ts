// Bộ dựng gói tin DMX cho các giao thức ngoài Art-Net:
// sACN E1.31, KiNET v1/v2, Enttec DMX USB Pro / Mk2, và Generic Serial.

export const SACN_PORT = 5568
export const KINET_PORT = 6038

const ACN_ID = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00] // "ASC-E1.17\0\0\0"
const DEFAULT_CID = [
  0x44, 0x4d, 0x58, 0x47, 0x61, 0x75, 0x7a, 0x65,
  0x4d, 0x49, 0x4b, 0x31, 0x30, 0x30, 0x30, 0x31,
]

export function sacnMulticastIp(universe: number): string {
  const u = Math.min(63999, Math.max(1, Math.round(universe)))
  return `239.255.${(u >> 8) & 0xff}.${u & 0xff}`
}

export interface SacnOptions {
  universe: number
  seq: number
  priority?: number
  sourceName?: string
  cid?: Uint8Array
  data: Uint8Array
}

/** Dựng gói sACN (ANSI E1.31) chuẩn qua UDP (port 5568). */
export function buildSacnPacket(opts: SacnOptions): Uint8Array {
  const dmxLen = Math.min(512, Math.max(1, opts.data.length))
  const totalLen = 126 + dmxLen
  const buf = new Uint8Array(totalLen)
  const view = new DataView(buf.buffer)

  // Root Layer (0..37)
  view.setUint16(0, 0x0010, false) // Preamble Size
  view.setUint16(2, 0x0000, false) // Post-amble Size
  buf.set(ACN_ID, 4) // ACN Packet Identifier (4..15)
  view.setUint16(16, 0x7000 | ((totalLen - 16) & 0x0fff), false)
  view.setUint32(18, 0x00000004, false) // VECTOR_ROOT_E131_DATA
  const cid = opts.cid && opts.cid.length === 16 ? opts.cid : DEFAULT_CID
  buf.set(cid, 22)

  // Framing Layer (38..114)
  view.setUint16(38, 0x7000 | ((totalLen - 38) & 0x0fff), false)
  view.setUint32(40, 0x00000002, false) // VECTOR_E131_DATA_PACKET
  const srcName = opts.sourceName ?? 'DMX Gauze'
  for (let i = 0; i < Math.min(63, srcName.length); i += 1) {
    buf[44 + i] = srcName.charCodeAt(i) & 0x7f
  }
  buf[108] = Math.min(200, Math.max(0, Math.round(opts.priority ?? 100)))
  view.setUint16(109, 0x0000, false) // Synchronization Address
  buf[111] = opts.seq & 0xff
  buf[112] = 0x00 // Options
  const uni = Math.min(63999, Math.max(1, Math.round(opts.universe)))
  view.setUint16(113, uni, false)

  // DMP Layer (115..125 + DMX)
  view.setUint16(115, 0x7000 | ((totalLen - 115) & 0x0fff), false)
  buf[117] = 0x02 // VECTOR_DMP_SET_PROPERTY
  buf[118] = 0xa1 // Address Type & Data Type
  view.setUint16(119, 0x0000, false) // First Property Address
  view.setUint16(121, 0x0001, false) // Address Increment
  view.setUint16(123, 1 + dmxLen, false) // Property value count (Start code + DMX slots)
  buf[125] = 0x00 // DMX Start Code
  buf.set(opts.data.subarray(0, dmxLen), 126)

  return buf
}

/** Dựng gói KiNET v1 DMXOUT (type 0x0101, UDP port 6038). */
export function buildKinetV1Packet(seq: number, port: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(24 + 512)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x0401dc4a, true) // KiNET Magic
  view.setUint16(4, 0x0001, true) // Version 1
  view.setUint16(6, 0x0101, true) // Type: DMXOUT
  view.setUint32(8, seq >>> 0, true)
  buf[12] = port & 0xff // Port
  buf[13] = 0x00 // Flags
  view.setUint16(14, 0, true)
  view.setUint32(16, 0xffffffff, true) // TimerVal
  view.setUint32(20, port & 0xff, true) // Universe / Port
  buf.set(data.subarray(0, 512), 24)
  return buf
}

/** Dựng gói KiNET v2 PORT_OUT (type 0x0108, UDP port 6038). */
export function buildKinetV2Packet(seq: number, universe: number, port: number, data: Uint8Array): Uint8Array {
  const dmxLen = Math.min(512, Math.max(1, data.length))
  const buf = new Uint8Array(24 + dmxLen)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x0401dc4a, true) // KiNET Magic
  view.setUint16(4, 0x0001, true) // Version 1
  view.setUint16(6, 0x0108, true) // Type: PORT_OUT
  view.setUint32(8, seq >>> 0, true)
  view.setUint32(12, universe >>> 0, true)
  buf[16] = Math.min(16, Math.max(1, Math.round(port)))
  buf[17] = 0x00 // Pad
  view.setUint16(18, 0x0000, true) // Flags
  view.setUint16(20, dmxLen, true) // Length
  view.setUint16(22, 0x0000, true) // StartCode
  buf.set(data.subarray(0, dmxLen), 24)
  return buf
}

/** Dựng gói KiNET Discovery Poll (type 0x0001). */
export function buildKinetPollPacket(): Uint8Array {
  const buf = new Uint8Array(12)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x0401dc4a, true)
  view.setUint16(4, 0x0001, true)
  view.setUint16(6, 0x0001, true) // POLL
  view.setUint32(8, 0, true)
  return buf
}

/** Kiểm tra gói phản hồi KiNET Poll Reply (type 0x0002). */
export function isKinetPollReply(buf: Uint8Array): boolean {
  if (buf.length < 12) return false
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return view.getUint32(0, true) === 0x0401dc4a && view.getUint16(6, true) === 0x0002
}

/** Dựng khung Enttec DMX USB Pro chuẩn (`0x7E <label> <lenL> <lenH> 0x00 ...dmx 0xE7`). */
export function buildEnttecProFrame(data: Uint8Array, label = 0x06): Uint8Array {
  const dmxLen = Math.min(512, Math.max(24, data.length))
  const payloadLen = 1 + dmxLen // start code + channels
  const buf = new Uint8Array(5 + payloadLen)
  buf[0] = 0x7e
  buf[1] = label & 0xff
  buf[2] = payloadLen & 0xff
  buf[3] = (payloadLen >> 8) & 0xff
  buf[4] = 0x00 // Start code
  buf.set(data.subarray(0, dmxLen), 5)
  buf[5 + dmxLen] = 0xe7
  return buf
}

/** Dựng khung Enttec DMX USB Pro Mk2 (Port 1 = label 0x06, Port 2 = label 0xA9). */
export function buildEnttecMk2Frame(data: Uint8Array, port: 1 | 2 = 1): Uint8Array {
  return buildEnttecProFrame(data, port === 2 ? 0xa9 : 0x06)
}

/** Các gói mở khoá API & bật Port 1+2 trên Enttec DMX USB Pro Mk2. */
export function buildEnttecMk2InitFrames(): Uint8Array[] {
  const apiKey = new Uint8Array([0x7e, 0x0d, 0x04, 0x00, 0xc9, 0xa4, 0x03, 0xe4, 0xe7])
  const enablePorts = new Uint8Array([0x7e, 0x93, 0x02, 0x00, 0x01, 0x01, 0xe7])
  return [apiKey, enablePorts]
}

/** Dựng khung Generic Serial / RS-485 DMX. */
export function buildSerialDmxFrame(data: Uint8Array, format: 'raw' | 'enttec' | 'ascii' = 'raw'): Uint8Array {
  if (format === 'enttec') return buildEnttecProFrame(data, 0x06)
  if (format === 'ascii') {
    const len = Math.min(512, Math.max(1, data.length))
    const line = `DMX:${Array.from(data.subarray(0, len)).join(',')}\n`
    return new TextEncoder().encode(line)
  }
  const len = Math.min(512, Math.max(1, data.length))
  const buf = new Uint8Array(1 + len)
  buf[0] = 0x00 // DMX Start Code
  buf.set(data.subarray(0, len), 1)
  return buf
}
