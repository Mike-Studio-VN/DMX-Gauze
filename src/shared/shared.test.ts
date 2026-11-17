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

  it('không cho moment cùng module chồng chéo và đồng bộ key cuối-đầu liên tiếp', async () => {
    const { resolveClipStartNoOverlap, syncModuleClipsContinuity } = await import('./timeline')
    const c1 = {
      id: 'c1',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 1,
      duration: 4,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 4, height: 0.8 },
      ],
    }
    const c2 = {
      id: 'c2',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 3, // chồng lấn vào c1 (1..5)
      duration: 3,
      keyframes: [
        { id: 'k3', offset: 0, height: 0.2 },
        { id: 'k4', offset: 3, height: 0 },
      ],
    }

    // Đặt vị trí không chồng chéo khi có moment từ 1..5
    expect(resolveClipStartNoOverlap([c1], 3, 3)).toBe(5)

    // Đồng bộ không chồng chéo + khớp key cuối c1 (0.8) -> key đầu c2 (0.8)
    const synced = syncModuleClipsContinuity([c1, c2], 'm1')
    expect(synced[0].startTime).toBe(1)
    expect(synced[1].startTime).toBe(5)
    expect(synced[1].keyframes[0].height).toBe(0.8)

    // Kéo key đầu c2 -> 0.45 thì key cuối c1 đồng bộ theo về 0.45
    const edited = syncModuleClipsContinuity(
      [
        synced[0],
        { ...synced[1], keyframes: [{ id: 'k3', offset: 0, height: 0.45 }, synced[1].keyframes[1]] },
      ],
      'm1',
      { clipId: 'c2', edge: 'start' },
    )
    expect(edited[0].keyframes[1].height).toBe(0.45)
    expect(edited[1].keyframes[0].height).toBe(0.45)
  })

  it('mode Loop DMX cho phép các module cùng layer dùng chung 4 kênh không báo trùng', async () => {
    const { autoAssign, conflictMap, validateAddress } = await import('./addressing')
    const p = createDefaultProject()
    const mods = p.modules.map((m, idx) =>
      idx === 1 || idx === 2 ? { ...m, dmxLoop: true } : m,
    )
    const assigned = autoAssign(p.layers, mods)
    expect(assigned[0].startAddress).toBe(1)
    expect(assigned[1].startAddress).toBe(1)
    expect(assigned[2].startAddress).toBe(1)
    expect(assigned[3].startAddress).toBe(5)
    expect(conflictMap(assigned).size).toBe(0)
    expect(validateAddress(assigned, assigned[1].id, 1)).toBeNull()
    expect(validateAddress(assigned, assigned[1].id, 3)).not.toBeNull()
  })

  it('dựng gói DMX chuẩn cho sACN E1.31, KiNET v1/v2, Enttec Pro/Mk2 và Generic Serial', async () => {
    const {
      sacnMulticastIp,
      buildSacnPacket,
      buildKinetV1Packet,
      buildKinetV2Packet,
      buildEnttecProFrame,
      buildEnttecMk2Frame,
      buildSerialDmxFrame,
    } = await import('./protocols')

    expect(sacnMulticastIp(1)).toBe('239.255.0.1')
    expect(sacnMulticastIp(258)).toBe('239.255.1.2')

    const dmx = new Uint8Array([128, 64, 100, 77])
    const sacn = buildSacnPacket({ universe: 3, seq: 12, priority: 120, data: dmx })
    expect(sacn.length).toBe(126 + 4)
    expect(String.fromCharCode(...sacn.subarray(4, 13))).toBe('ASC-E1.17')
    expect(sacn[108]).toBe(120)
    expect(sacn[111]).toBe(12)
    expect((sacn[113] << 8) | sacn[114]).toBe(3)
    expect(sacn[125]).toBe(0)
    expect(sacn[126]).toBe(128)

    const kv1 = buildKinetV1Packet(5, 2, dmx)
    expect(kv1.length).toBe(24 + 512)
    expect(kv1[24]).toBe(128)

    const kv2 = buildKinetV2Packet(9, 0, 3, dmx)
    expect(kv2.length).toBe(24 + 4)
    expect(kv2[16]).toBe(3)
    expect(kv2[24]).toBe(128)

    const pro = buildEnttecProFrame(dmx)
    expect(pro[0]).toBe(0x7e)
    expect(pro[1]).toBe(0x06)
    expect(pro[4]).toBe(0x00)
    expect(pro[5]).toBe(128)
    expect(pro[pro.length - 1]).toBe(0xe7)

    const mk2p2 = buildEnttecMk2Frame(dmx, 2)
    expect(mk2p2[1]).toBe(0xa9)

    const ascii = buildSerialDmxFrame(dmx, 'ascii')
    expect(new TextDecoder().decode(ascii)).toBe('DMX:128,64,100,77\n')
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

  it('chỉnh sửa, chèn và xoá điểm keyframe trong moment theo thời gian timeline và % hành trình', async () => {
    const {
      heightToPercent,
      insertClipKeyframe,
      percentToHeight,
      removeClipKeyframe,
      updateClipKeyframeHeight,
      updateClipKeyframeTimelineTime,
    } = await import('./timeline')
    const mod = { minHeight: 0, maxHeight: 3, length: 3 }
    expect(heightToPercent(1.5, mod)).toBe(50)
    expect(percentToHeight(50, mod)).toBe(1.5)
    expect(heightToPercent(2.4, mod)).toBe(80)
    expect(percentToHeight(80, mod)).toBe(2.4)

    const clip = {
      id: 'c-edit',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 2,
      duration: 4,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 4, height: 3 },
      ],
    }
    expect(removeClipKeyframe(clip, 'k1')).toBeNull()

    const inserted = insertClipKeyframe(clip, 0, 3)
    expect(inserted.keyframes).toHaveLength(3)
    expect(inserted.keyframes[1]).toMatchObject({ id: inserted.newKeyId, offset: 2, height: 1.5 })

    const withMid = { ...clip, keyframes: inserted.keyframes }
    const hRes = updateClipKeyframeHeight(withMid, 'k1', percentToHeight(25, mod))
    expect(hRes.syncEdge).toBe('start')
    expect(hRes.keyframes[0].height).toBeCloseTo(0.75, 2)

    // K2 đang ở timeline 2+4 = 6s -> đổi thành 8s trên timeline
    const tEnd = updateClipKeyframeTimelineTime(withMid, 'k2', 8)
    expect(tEnd.startTime).toBe(2)
    expect(tEnd.duration).toBe(6)
    expect(tEnd.keyframes[2].offset).toBe(6)

    // K1 đang ở timeline 2s -> dời sớm về 1s trên timeline, các điểm sau giữ nguyên thời gian timeline
    const tStart = updateClipKeyframeTimelineTime(withMid, 'k1', 1)
    expect(tStart.startTime).toBe(1)
    expect(tStart.duration).toBe(5)
    expect(tStart.keyframes.map((k) => tStart.startTime + k.offset)).toEqual([1, 4, 6])

    const removed = removeClipKeyframe(withMid, inserted.newKeyId)
    expect(removed).toHaveLength(2)
  })

  it('nội suy độ cao timeline qua evaluateModuleTimelineHeight cho cả moment mượt, thẳng và key cũ', async () => {
    const { evaluateModuleTimelineHeight } = await import('./timeline')
    const mod = { id: 'm1', minHeight: 0, maxHeight: 3, length: 3 }
    const smoothClip = {
      id: 'c-smooth',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 1,
      duration: 4,
      curveMode: 'smooth' as const,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 2, height: 3 },
        { id: 'k3', offset: 4, height: 0 },
      ],
    }
    expect(evaluateModuleTimelineHeight([smoothClip], [], mod, 0.5)).toBe(0)
    expect(evaluateModuleTimelineHeight([smoothClip], [], mod, 3)).toBe(3)
    const midSmooth = evaluateModuleTimelineHeight([smoothClip], [], mod, 2)
    expect(midSmooth).not.toBeNull()
    expect(midSmooth!).toBeGreaterThan(0)
    expect(midSmooth!).toBeLessThan(3)

    const linearClip = {
      id: 'c-lin',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 2,
      duration: 4,
      curveMode: 'linear' as const,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 4, height: 2 },
      ],
    }
    expect(evaluateModuleTimelineHeight([linearClip], [], mod, 4)).toBeCloseTo(1, 3)
    expect(evaluateModuleTimelineHeight([linearClip], [], mod, 10)).toBe(2)

    const legacyKeys = [
      { id: 'tk1', time: 1, label: 'Start', targets: { m1: 0 } },
      { id: 'tk2', time: 5, label: 'End', targets: { m1: 2 } },
    ]
    expect(evaluateModuleTimelineHeight([], legacyKeys, mod, 3)).toBeCloseTo(1, 3)
  })
})

describe('stage3d', () => {
  it('quy đổi đồng nhất giữa hệ toạ độ World chung và offset cục bộ của Module/Layer xoay & scale', async () => {
    const { computeModuleBasePositions, getModuleWorldPosition, worldPositionToModuleOffset } = await import('./stage3d')
    const p = createDefaultProject()
    const layer2Rotated = {
      id: 'layer-rot',
      name: 'Lớp xoay',
      transform: { position: [1, 4, 2] as [number, number, number], rotation: [0, 90, 0] as [number, number, number], scale: [2, 1, 1] as [number, number, number] },
    }
    const modRot = {
      ...p.modules[0],
      id: 'm-rot',
      layerId: 'layer-rot',
      width: 2,
      transform: { position: [0.5, 0, -0.25] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
    }
    const layers = [p.layers[0], layer2Rotated]
    const mods = [...p.modules.filter((m) => m.layerId === p.layers[0].id), modRot]
    const baseMap = computeModuleBasePositions(layers, mods)
    expect(baseMap.get('m-rot')).toBe(0)

    const world = getModuleWorldPosition(layer2Rotated, 1, modRot, baseMap.get('m-rot') ?? 0)
    expect(world[0]).toBeCloseTo(0.75, 3)
    expect(world[1]).toBeCloseTo(4, 3)
    expect(world[2]).toBeCloseTo(1, 3)

    const recovered = worldPositionToModuleOffset(layer2Rotated, 1, baseMap.get('m-rot') ?? 0, [0.75, 4, 1])
    expect(recovered[0]).toBeCloseTo(0.5, 3)
    expect(recovered[1]).toBe(0)
    expect(recovered[2]).toBeCloseTo(-0.25, 3)
  })
})
