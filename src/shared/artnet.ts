// Gói tin Art-Net (không phụ thuộc Node Buffer, dùng được ở main và renderer).
const ID = [0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00] // "Art-Net\0"
const OP_POLL = 0x2000
const OP_POLL_REPLY = 0x2100
const OP_DMX = 0x5000

export function portAddress(net: number, subnet: number, universe: number): number {
  return ((net & 0x7f) << 8) | ((subnet & 0x0f) << 4) | (universe & 0x0f)
}

function header(len: number, op: number): Uint8Array {
  const b = new Uint8Array(len)
  b.set(ID, 0)
  b[8] = op & 0xff // OpCode little-endian
  b[9] = op >> 8
  return b
}

export function buildArtPoll(): Uint8Array {
  const b = header(14, OP_POLL)
  b[10] = 0 // ProtVerHi
  b[11] = 14 // ProtVerLo
  b[12] = 0 // TalkToMe
  b[13] = 0 // DiagPriority
  return b
}

export function buildArtDmx(seq: number, net: number, subnet: number, universe: number, data: Uint8Array): Uint8Array {
  let len = Math.min(512, Math.max(2, data.length))
  if (len % 2) len += 1 // độ dài phải chẵn
  const b = header(18 + len, OP_DMX)
  b[10] = 0
  b[11] = 14
  b[12] = seq & 0xff
  b[13] = 0 // Physical
  b[14] = ((subnet & 0x0f) << 4) | (universe & 0x0f) // SubUni
  b[15] = net & 0x7f
  b[16] = len >> 8
  b[17] = len & 0xff
  b.set(data.subarray(0, len), 18)
  return b
}

export interface ArtPollReply {
  ip: string
  name: string
  longName: string
}

function cstr(b: Uint8Array, start: number, max: number): string {
  let s = ''
  for (let i = start; i < start + max && b[i] !== 0; i += 1) s += String.fromCharCode(b[i])
  return s
}

export function parseArtPollReply(b: Uint8Array): ArtPollReply | null {
  if (b.length < 108) return null
  for (let i = 0; i < 8; i += 1) if (b[i] !== ID[i]) return null
  if (((b[9] << 8) | b[8]) !== OP_POLL_REPLY) return null
  return {
    ip: `${b[10]}.${b[11]}.${b[12]}.${b[13]}`,
    name: cstr(b, 26, 18),
    longName: cstr(b, 44, 64),
  }
}

/** Dựng ArtPollReply (dùng cho test / node giả lập). */
export function buildArtPollReply(ip: [number, number, number, number], name: string, longName = name): Uint8Array {
  const b = header(239, OP_POLL_REPLY)
  b.set(ip, 10)
  b[14] = 0x36 // port 6454 little-endian
  b[15] = 0x19
  for (let i = 0; i < Math.min(17, name.length); i += 1) b[26 + i] = name.charCodeAt(i)
  for (let i = 0; i < Math.min(63, longName.length); i += 1) b[44 + i] = longName.charCodeAt(i)
  return b
}
