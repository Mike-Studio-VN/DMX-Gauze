import { describe, expect, it } from 'vitest'
import { autoAssign, conflictMap, nextFree, validateAddress } from './addressing'
import { buildArtDmx, buildArtPoll, buildArtPollReply, parseArtPollReply, portAddress } from './artnet'
import { ch3ToCms, cmsToCh3, dmxToPos, durationToCh3, posToDmx } from './convert'
import { LtcDecoder } from './ltc'
import { createDefaultProject } from './preset'
import { formatTc, parseTc } from './timecode'
import { TimelineRunner, analyzeClipSpeeds } from './timeline'

describe('convert', () => {
  it('chuyển đổi vị trí 16-bit chính xác với hành trình 1m và 3m', () => {
    const mid1 = posToDmx(0.5, 1)
    expect(mid1.coarse).toBe(128)
    expect(dmxToPos(mid1.coarse, mid1.fine, 1)).toBeCloseTo(0.5, 3)

    const mid3 = posToDmx(1.5, 3)
    expect(mid3.coarse).toBe(128)
    expect(dmxToPos(mid3.coarse, mid3.fine, 3)).toBeCloseTo(1.5, 3)
  })

  it('quy đổi tốc độ H2 120 cm/s và thời gian sang CH3', () => {
    expect(ch3ToCms(255, 120)).toBeCloseTo(120, 5)
    expect(cmsToCh3(60, 120)).toBe(128)
    expect(cmsToCh3(0, 120)).toBe(1) // không bao giờ trả 0 (phanh)

    const r = durationToCh3(3, 5, 120) // 3m trong 5s = 60 cm/s
    expect(r.ch3).toBe(128)
    expect(r.tooFast).toBe(false)

    const fast = durationToCh3(3, 1, 120) // cần 300 cm/s > 120
    expect(fast.ch3).toBe(255)
    expect(fast.tooFast).toBe(true)
    expect(fast.minSeconds).toBeCloseTo(2.5, 3)
  })
})

describe('addressing & preset', () => {
  it('preset mặc định có 12 module 1m lớp trước và 1 module 3m lớp sau gán từ 1', () => {
    const p = createDefaultProject()
    expect(p.layers).toHaveLength(2)
    expect(p.modules).toHaveLength(13)
    expect(p.modules[0].startAddress).toBe(1)
    expect(p.modules[11].startAddress).toBe(45)
    expect(p.modules[12].startAddress).toBe(49)
    expect(p.modules[12].length).toBe(3)
    expect(conflictMap(p.modules).size).toBe(0)
  })

  it('chặn trùng kênh và tìm kênh trống kế tiếp', () => {
    const p = createDefaultProject()
    expect(validateAddress(p.modules, 'm-front-2', 3)).toContain('Trùng kênh')
    expect(validateAddress(p.modules, 'm-front-2', 5)).toBeNull()
    expect(validateAddress(p.modules, 'm-front-2', 510)).toContain('1–509')
    expect(nextFree(p.modules)).toBe(53)
    const reassigned = autoAssign(p.layers, p.modules.map((m) => ({ ...m, startAddress: 1 })))
    expect(reassigned[1].startAddress).toBe(5)
  })
})

describe('artnet packets', () => {
  it('đóng gói ArtDmx, ArtPoll và giải mã ArtPollReply', () => {
    expect(portAddress(0, 0, 0)).toBe(0)
    expect(portAddress(1, 2, 3)).toBe((1 << 8) | (2 << 4) | 3)
    const poll = buildArtPoll()
    expect(poll.length).toBe(14)
    expect(String.fromCharCode(...poll.subarray(0, 7))).toBe('Art-Net')

    const dmx = buildArtDmx(1, 0, 0, 0, new Uint8Array([10, 20, 100]))
    expect(dmx.length).toBe(18 + 4) // làm chẵn từ 3 -> 4
    expect(dmx[18]).toBe(10)

    const reply = buildArtPollReply([192, 168, 1, 50], 'Node-1', 'DMX Node')
    expect(parseArtPollReply(reply)).toEqual({ ip: '192.168.1.50', name: 'Node-1', longName: 'DMX Node' })
  })
})

describe('timecode & timeline', () => {
  it('định dạng và parse timecode 25fps và 29.97 DF', () => {
    expect(formatTc(0, 25)).toBe('00:00:00:00')
    const s = parseTc('01:02:03:12', 25)
    expect(s).not.toBeNull()
    expect(formatTc(s!, 25)).toBe('01:02:03:12')
    expect(parseTc('00:00:00:25', 25)).toBeNull()
    expect(formatTc(60, 29.97)).toContain(';')
  })

  it('TimelineRunner phát lệnh khi qua đoạn giữa 2 key trong clips và cảnh báo vượt tốc độ', () => {
    const p = createDefaultProject()
    const runner = new TimelineRunner()
    const c0 = runner.update(1.1, p.keys, p.clips)
    expect(c0.length).toBeGreaterThanOrEqual(1)
    expect(c0[0].type).toBe('move')
    // Trong cùng đoạn không phát lặp lại
    expect(runner.update(1.5, p.keys, p.clips)).toHaveLength(0)

    // Key 1 ở 1s (0m), Key 2 ở 1.5s (1m) => cần 200 cm/s > max 150 cm/s => warning
    const mod = { ...p.modules[0], maxSpeedCms: 150 }
    const issues = analyzeClipSpeeds(
      {
        id: 'test-clip',
        layerId: mod.layerId,
        moduleId: mod.id,
        startTime: 1,
        duration: 0.5,
        keyframes: [
          { id: 'k1', offset: 0, height: 0 },
          { id: 'k2', offset: 0.5, height: 1 },
        ],
      },
      mod,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].requiredCms).toBeCloseTo(200, 1)
    expect(issues[0].feasible).toBe(false)
  })

  it('buildCurveKeyframes tạo đồ thị mẫu chuẩn 0-0 và đỉnh theo maxHeight', async () => {
    const { CURVE_PRESETS, buildCurveKeyframes } = await import('./timeline')
    expect(CURVE_PRESETS.length).toBeGreaterThanOrEqual(5)

    const flat = buildCurveKeyframes('flat', 4, 0, 1.5)
    expect(flat).toHaveLength(2)
    expect(flat[0]).toMatchObject({ offset: 0, height: 0 })
    expect(flat[1]).toMatchObject({ offset: 4, height: 0 })

    for (const presetId of ['sine', 'bell', 'triangle', 'double', 'hold', 'steps'] as const) {
      const kfs = buildCurveKeyframes(presetId, 6, 0, 2)
      expect(kfs[0].offset).toBe(0)
      expect(kfs[0].height).toBe(0)
      expect(kfs[kfs.length - 1].offset).toBe(6)
      expect(kfs[kfs.length - 1].height).toBe(0)
      expect(Math.max(...kfs.map((k) => k.height))).toBeCloseTo(2, 1)
    }
  })
})

describe('ltc decoder', () => {
  it('giải mã khung LTC chuẩn biphase mark ở 25fps', () => {
    const sr = 48000
    const fps = 25
    const samplesPerBit = sr / (fps * 80) // 24 mẫu / bit
    const bits = new Array(80).fill(0)
    // f=12 (units=2, tens=1), s=34, m=56, h=07
    const setBcd = (val: number, uStart: number, uLen: number, tStart: number, tLen: number) => {
      const u = val % 10
      const t = Math.floor(val / 10)
      for (let i = 0; i < uLen; i += 1) bits[uStart + i] = (u >> i) & 1
      for (let i = 0; i < tLen; i += 1) bits[tStart + i] = (t >> i) & 1
    }
    setBcd(12, 0, 4, 8, 2)
    setBcd(34, 16, 4, 24, 3)
    setBcd(56, 32, 4, 40, 3)
    setBcd(7, 48, 4, 56, 2)
    const sync = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
    for (let i = 0; i < 16; i += 1) bits[64 + i] = sync[i]

    // Mã hoá biphase mark 2 khung liên tiếp để decoder lock bit period
    const allBits = [...bits, ...bits]
    const pcm = new Float32Array(allBits.length * samplesPerBit)
    let level = 1
    let idx = 0
    for (const b of allBits) {
      level = -level // luôn đảo ở đầu bit
      const half = samplesPerBit / 2
      for (let i = 0; i < half; i += 1) pcm[idx++] = level
      if (b === 1) level = -level
      for (let i = half; i < samplesPerBit; i += 1) pcm[idx++] = level
    }

    const decoded: Array<{ h: number; m: number; s: number; f: number }> = []
    const dec = new LtcDecoder(sr, (f) => decoded.push(f), 25)
    dec.push(pcm)
    expect(decoded.length).toBeGreaterThanOrEqual(1)
    expect(decoded[0]).toMatchObject({ h: 7, m: 56, s: 34, f: 12 })
  })
})
