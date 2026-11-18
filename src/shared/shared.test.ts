import { describe, expect, it } from 'vitest'
import { autoAssign, conflictMap, nextFree, validateAddress } from './addressing'
import { buildArtDmx, buildArtPoll, buildArtPollReply, parseArtPollReply, portAddress } from './artnet'
import { ch3ToCms, cmsToCh3, dmxToPos, durationToCh3, homeOffsetSteps, posToDmx } from './convert'
import { LtcDecoder } from './ltc'
import { createDefaultProject, normalizeProject } from './preset'
import { formatTc, parseTc } from './timecode'
import { analyzeClipSpeeds } from './timeline'

describe('convert', () => {
  it('chuyển đổi vị trí 16-bit chính xác với hành trình 1m và 3m', () => {
    const mid1 = posToDmx(0.5, 1)
    expect(mid1.coarse).toBe(128)
    expect(dmxToPos(mid1.coarse, mid1.fine, 1)).toBeCloseTo(0.5, 3)

    const mid3 = posToDmx(1.5, 3)
    expect(mid3.coarse).toBe(128)
    expect(dmxToPos(mid3.coarse, mid3.fine, 3)).toBeCloseTo(1.5, 3)
  })

  it('home offset: mm → bước 16-bit, chỉ áp tại target 0', () => {
    expect(homeOffsetSteps(40, 1)).toBe(2621)
    expect(homeOffsetSteps(1000, 1)).toBe(2621) // kẹp 40 mm
    expect(homeOffsetSteps(-5, 1)).toBe(0)
    expect(posToDmx(0, 1, 40)).toEqual({ coarse: 10, fine: 0x3d })
    expect(posToDmx(0.5, 1, 40)).toEqual(posToDmx(0.5, 1))
  });

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

  it('tính tiến độ & ETA cho nút Lên/Xuống ở chế độ Manual', async () => {
    const { computeManualMotionProgress } = await import('./convert')
    const p = createDefaultProject()
    const m = { ...p.modules[0], id: 'm1', minHeight: 0, maxHeight: 3, length: 3, maxSpeedCms: 100 }
    // Đang đi xuống từ 0m -> 3m, hiện tại ở 1.5m với ch3=255 (100 cm/s -> còn 1.5s)
    const downRes = computeManualMotionProgress(
      { m1: { start: 0, goal: 3 } },
      [m],
      { modules: { m1: { pos: 1.5, target: 3, ch3: 255, moving: true } } },
    )
    expect(downRes.progress).toBeCloseTo(0.5, 3)
    expect(downRes.etaSec).toBeCloseTo(1.5, 2)
    expect(downRes.anyMoving).toBe(true)
    expect(downRes.reached).toBe(false)

    // Đang đi lên từ 2m -> 0m, đã chạm 0m
    const upDone = computeManualMotionProgress(
      { m1: { start: 2, goal: 0 } },
      [m],
      { modules: { m1: { pos: 0, target: 0, ch3: 255, moving: false } } },
    )
    expect(upDone.progress).toBe(1)
    expect(upDone.etaSec).toBe(0)
    expect(upDone.reached).toBe(true)

    // Nhiều module có quãng đường khác nhau: m1 đã ở đích (span=0), m2 đi 2m đang ở 1m -> đúng 50%
    const m2 = { ...m, id: 'm2' }
    const mixedSpan = computeManualMotionProgress(
      { m1: { start: 0, goal: 0 }, m2: { start: 0, goal: 2 } },
      [m, m2],
      {
        modules: {
          m1: { pos: 0, target: 0, ch3: 255, moving: false },
          m2: { pos: 1, target: 2, ch3: 255, moving: true },
        },
      },
    )
    expect(mixedSpan.progress).toBeCloseTo(0.5, 3)
  })

  it('tính vị trí sóng Lên/Xuống đúng tỉ lệ % (0%, 25%, 50%, 75%, 100%)', async () => {
    const { computeManualWaveLayout } = await import('./convert')

    expect(computeManualWaveLayout('up', 'run', 0)).toEqual({
      ratio: 0,
      percent: 0,
      transform: 'translate3d(0, calc(100.000%), 0)',
    })
    expect(computeManualWaveLayout('up', 'run', 0.25).transform).toBe('translate3d(0, calc(75.000%), 0)')
    expect(computeManualWaveLayout('up', 'run', 0.5).transform).toBe('translate3d(0, calc(50.000%), 0)')
    expect(computeManualWaveLayout('up', 'run', 1)).toEqual({
      ratio: 1,
      percent: 100,
      transform: 'translate3d(0, calc(0.000%), 0)',
    })

    expect(computeManualWaveLayout('down', 'run', 0)).toEqual({
      ratio: 0,
      percent: 0,
      transform: 'translate3d(0, calc(-100.000%), 0)',
    })
    expect(computeManualWaveLayout('down', 'run', 0.25).transform).toBe('translate3d(0, calc(-75.000%), 0)')
    expect(computeManualWaveLayout('down', 'run', 0.75).transform).toBe('translate3d(0, calc(-25.000%), 0)')
    expect(computeManualWaveLayout('down', 'run', 1)).toEqual({
      ratio: 1,
      percent: 100,
      transform: 'translate3d(0, calc(-0.000%), 0)',
    })
  })

  it('tính mức sóng chung cho cả 3 nút Manual và giữ nguyên % khi dừng giữa chừng', async () => {
    const { computeSharedManualWaveLevel } = await import('./convert')
    const p = createDefaultProject()
    const m1 = { ...p.modules[0], id: 'm1', minHeight: 0, maxHeight: 2, length: 2 }

    // Ở đỉnh (0m -> 100%)
    expect(
      computeSharedManualWaveLevel(['m1'], [m1], { modules: { m1: { pos: 0, target: 0, ch3: 100, moving: false } } }),
    ).toEqual({
      ratio: 1,
      percent: 100,
      moving: false,
    })

    // Đang hạ xuống giữa chừng 0.76m/2m -> còn 62%, sau đó Dừng (moving=false) vẫn giữ đúng 62%
    expect(
      computeSharedManualWaveLevel(['m1'], [m1], { modules: { m1: { pos: 0.76, target: 2, ch3: 100, moving: true } } }),
    ).toEqual({
      ratio: 0.62,
      percent: 62,
      moving: true,
    })
    expect(
      computeSharedManualWaveLevel(['m1'], [m1], { modules: { m1: { pos: 0.76, target: 0.76, ch3: 100, moving: false } } }),
    ).toEqual({
      ratio: 0.62,
      percent: 62,
      moving: false,
    })

    // Hạ hết (2m -> 0%)
    expect(
      computeSharedManualWaveLevel(['m1'], [m1], { modules: { m1: { pos: 2, target: 2, ch3: 100, moving: false } } }),
    ).toEqual({
      ratio: 0,
      percent: 0,
      moving: false,
    })
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

  it('analyzeClipSpeeds cảnh báo đoạn vượt tốc độ tối đa', () => {
    const p = createDefaultProject()
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

    const { parseTimelineSecondsInput } = await import('./timeline')
    expect(parseTimelineSecondsInput('3.09', 25)).toBeCloseTo(3.09, 3)
    expect(parseTimelineSecondsInput('3,5s', 25)).toBeCloseTo(3.5, 3)
    expect(parseTimelineSecondsInput('12', 25)).toBe(12)
    expect(parseTimelineSecondsInput('00:00:05:00', 25)).toBeCloseTo(5, 3)
    expect(parseTimelineSecondsInput('abc', 25)).toBeNull()

    const { insertClipKeyframe, mapKeyframesToPts, segmentPath } = await import('./timeline')
    const baseClip = {
      id: 'c-graph',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 1,
      duration: 4,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 4, height: 3 },
      ],
    }
    const customInsert = insertClipKeyframe(baseClip, 0, 3, { offset: 1.5, height: 2.25 })
    expect(customInsert.keyframes[1]).toMatchObject({ id: customInsert.newKeyId, offset: 1.5, height: 2.25 })
    const pts = mapKeyframesToPts(customInsert.keyframes, baseClip.duration, 0, 3, 280, 138, {
      left: 30,
      right: 12,
      top: 14,
      bottom: 20,
    })
    expect(pts).toHaveLength(3)
    expect(pts[0]).toEqual({ x: 30, y: 118 })
    expect(pts[2]).toEqual({ x: 268, y: 14 })
    expect(segmentPath(pts, 0, 'smooth', 14, 118)).toContain('C ')
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

describe('timeline -> GauzeCore end-to-end execution', () => {
  it('rèm thực sự chạy lên xuống chính xác theo timeline (cả pre-roll từ vị trí lệch, mượt Catmull-Rom và khung DMX)', async () => {
    const { GauzeCore } = await import('./core')
    const { MockDriver } = await import('./drivers')
    const { CH, LOCK_VALUE } = await import('./dmx')
    const { dmxToPos } = await import('./convert')
    const { buildTimelineFollowCommands, evaluateModuleTimelineHeight } = await import('./timeline')

    let now = 10_000
    const core = new GauzeCore((_cfg, ev) => new MockDriver(ev), () => now)
    const p = createDefaultProject()
    core.configure({
      modules: p.modules,
      output: p.settings.output,
      lockValue: LOCK_VALUE,
    })
    core.start()
    core.command({ type: 'lock', locked: false })

    // Giả lập Trước 1 đang thả ở 0.8m (từ chế độ Manual trước đó)
    core.command({ type: 'move', ids: ['m-front-1'], target: 0.8, speed: { unit: 'cms', value: 120 } })
    for (let i = 0; i < 40; i += 1) {
      now += 25
      core.tick()
    }
    expect(core.snapshot().modules['m-front-1'].pos).toBeCloseTo(0.8, 2)

    // Chạy timeline từ t=0s..8.2s: bước mô phỏng core 20ms, cập nhật follow command mỗi 40ms
    const sampled: Record<number, { front: number; back: number }> = {}
    let nextFollowT = 0
    for (let ms = 0; ms <= 8200; ms += 20) {
      const t = ms / 1000
      if (t + 1e-6 >= nextFollowT) {
        nextFollowT += 0.04
        const snap = core.snapshot()
        const cmds = buildTimelineFollowCommands(p.modules, p.clips ?? [], p.keys, t, 0.06, snap)
        for (const cmd of cmds) {
          const res = core.command(cmd)
          expect(res.ok).toBe(true)
        }
      }
      now += 20
      core.tick()
      if ([1000, 2000, 3000, 4000, 5000, 6500, 8100].includes(ms)) {
        const s = core.snapshot()
        sampled[ms] = {
          front: s.modules['m-front-1'].pos,
          back: s.modules['m-back-1'].pos,
        }
      }
    }

    // 1) Pre-roll đưa Trước 1 từ 0.8m về 0.0m trước khi sóng bắt đầu ở 1s
    expect(sampled[1000].front).toBeLessThan(0.05)
    // 2) Trước 1 đi xuống ~0.7m (2s) -> đỉnh 1.0m (3s) -> đi lên ~0.7m (4s) -> về 0.0m (5s)
    expect(sampled[2000].front).toBeGreaterThan(0.62)
    expect(sampled[2000].front).toBeLessThan(0.78)
    expect(sampled[3000].front).toBeGreaterThan(0.95)
    expect(sampled[4000].front).toBeGreaterThan(0.62)
    expect(sampled[4000].front).toBeLessThan(0.78)
    expect(sampled[5000].front).toBeLessThan(0.08)

    // 3) Sau 1 (3m) đi xuống ~2.4m (5s) rồi thu về 0.0m (8s)
    expect(sampled[5000].back).toBeGreaterThan(2.3)
    expect(sampled[8100].back).toBeLessThan(0.05)

    // 4) Kiểm tra frame DMX thực sự xuất CH4=77 và vị trí khớp chiều dài cuối clip
    const finalSnap = core.snapshot()
    expect(finalSnap.frame[CH.LOCK]).toBe(77)
    expect(dmxToPos(finalSnap.frame[CH.POSITION], finalSnap.frame[CH.FINE], 1)).toBeCloseTo(0, 2)

    // 5) Đảm bảo đoạn giữ đỉnh phẳng không bị võng vượt biên trong evaluateModuleTimelineHeight
    const holdClip = {
      id: 'hold-test',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 0,
      duration: 5,
      curveMode: 'smooth' as const,
      keyframes: [
        { id: 'h1', offset: 0, height: 0 },
        { id: 'h2', offset: 1, height: 0.5 },
        { id: 'h3', offset: 4, height: 0.5 },
        { id: 'h4', offset: 5, height: 0 },
      ],
    }
    expect(evaluateModuleTimelineHeight([holdClip], [], { id: 'm1', minHeight: 0, maxHeight: 1, length: 1 }, 2.5)).toBe(0.5)
    core.stop()
  })
})

describe('regression tests: project validation, curve agreement & LTC freewheel', () => {
  it('normalizeProject từ chối dự án thiếu settings hoặc có thông số không hợp lệ (P1)', async () => {
    const { normalizeProject } = await import('./preset')
    expect(() => normalizeProject({ version: 1, layers: [], modules: [] })).toThrow()
    expect(() => normalizeProject(null)).toThrow()

    const base = createDefaultProject()
    expect(() => normalizeProject({ ...base, settings: undefined })).toThrow()
    expect(() => normalizeProject({ ...base, settings: { ...base.settings, output: undefined } })).toThrow()
    expect(() =>
      normalizeProject({
        ...base,
        settings: { ...base.settings, output: { ...base.settings.output, port: Number.NaN } },
      }),
    ).toThrow()
    expect(() =>
      normalizeProject({
        ...base,
        modules: [{ ...base.modules[0], length: -1 }],
      }),
    ).toThrow()

    // Dự án hợp lệ thiếu field tuỳ chọn vẫn được chuẩn hoá tốt
    const minimalValid = {
      ...base,
      clips: undefined,
      layers: base.layers.map(({ id, name }) => ({ id, name })),
      modules: base.modules.map((m) => {
        const clone = { ...m }
        delete clone.visible
        delete clone.dmxLoop
        delete clone.transform
        return clone
      }),
    }
    const normalized = normalizeProject(minimalValid)
    expect(normalized.settings.output.driver).toBe('mock')
    expect(normalized.layers[0].visible).toBe(true)
    expect(normalized.modules[0].dmxLoop).toBe(false)
    expect(normalized.clips).toEqual([])
  })

  it('đồ thị SVG smooth 2 điểm và nhiều điểm (cách đều / không đều) khớp chính xác với evaluator (P2)', async () => {
    const { evaluateModuleTimelineHeight, mapKeyframesToPts, segmentPath } = await import('./timeline')
    const mod = { id: 'm1', minHeight: 0, maxHeight: 3, length: 3 }
    const W = 280
    const H = 138
    const pad = { left: 30, right: 12, top: 14, bottom: 20 }
    const usableH = H - pad.top - pad.bottom

    const parseSvgYAtX = (d: string, targetX: number): number => {
      const m = d.match(/^M ([\d.-]+) ([\d.-]+) (L|C) (.+)$/)
      if (!m) throw new Error(`Invalid SVG path: ${d}`)
      const x1 = Number(m[1])
      const y1 = Number(m[2])
      if (m[3] === 'L') {
        const [x2, y2] = m[4].split(' ').map(Number)
        const t = (targetX - x1) / Math.max(1e-6, x2 - x1)
        return y1 + (y2 - y1) * t
      }
      const nums = m[4].replaceAll(',', '').split(/\s+/).map(Number)
      const [c1x, c1y, c2x, c2y, x2, y2] = nums
      // Giải tìm t từ B_x(t) = targetX bằng bisection (B_x đơn điệu tăng)
      let lo = 0
      let hi = 1
      for (let iter = 0; iter < 30; iter += 1) {
        const mid = (lo + hi) / 2
        const inv = 1 - mid
        const bx = inv ** 3 * x1 + 3 * inv ** 2 * mid * c1x + 3 * inv * mid ** 2 * c2x + mid ** 3 * x2
        if (bx < targetX) lo = mid
        else hi = mid
      }
      const t = (lo + hi) / 2
      const inv = 1 - t
      return inv ** 3 * y1 + 3 * inv ** 2 * t * c1y + 3 * inv * t ** 2 * c2y + t ** 3 * y2
    }

    const twoPtClip = {
      id: 'c2',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 1,
      duration: 4,
      curveMode: 'smooth' as const,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 4, height: 3 },
      ],
    }
    const twoPts = mapKeyframesToPts(twoPtClip.keyframes, twoPtClip.duration, 0, 3, W, H, pad)
    const twoPath = segmentPath(twoPts, 0, 'smooth', pad.top, H - pad.bottom)
    for (let u = 0.05; u <= 0.95; u += 0.1) {
      const tAbs = twoPtClip.startTime + u * twoPtClip.duration
      const x = twoPts[0].x + u * (twoPts[1].x - twoPts[0].x)
      const renderedH = ((H - pad.bottom - parseSvgYAtX(twoPath, x)) / usableH) * 3
      const evalH = evaluateModuleTimelineHeight([twoPtClip], [], mod, tAbs)!
      expect(Math.abs(renderedH - evalH)).toBeLessThan(0.01)
    }

    const multiUnevenClip = {
      id: 'cm',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 2,
      duration: 5,
      curveMode: 'smooth' as const,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 0.5, height: 0.8 },
        { id: 'k3', offset: 2.2, height: 2.7 },
        { id: 'k4', offset: 3.9, height: 1.1 },
        { id: 'k5', offset: 5, height: 0 },
      ],
    }
    const mPts = mapKeyframesToPts(multiUnevenClip.keyframes, multiUnevenClip.duration, 0, 3, W, H, pad)
    for (let seg = 0; seg < multiUnevenClip.keyframes.length - 1; seg += 1) {
      const d = segmentPath(mPts, seg, 'smooth', pad.top, H - pad.bottom)
      const k1 = multiUnevenClip.keyframes[seg]
      const k2 = multiUnevenClip.keyframes[seg + 1]
      for (let step = 1; step <= 8; step += 1) {
        const u = step / 9
        const tAbs = multiUnevenClip.startTime + k1.offset + u * (k2.offset - k1.offset)
        const x = mPts[seg].x + u * (mPts[seg + 1].x - mPts[seg].x)
        const renderedH = ((H - pad.bottom - parseSvgYAtX(d, x)) / usableH) * 3
        const evalH = evaluateModuleTimelineHeight([multiUnevenClip], [], mod, tAbs)!
        expect(Math.abs(renderedH - evalH)).toBeLessThan(0.01)
      }
    }
  })

  it('LtcClockTracker ngoại suy trớn giới hạn trong freewheelFrames và dừng dứt khoát khi lost (P2)', async () => {
    const { LtcClockTracker } = await import('./ltc')
    const tracker = new LtcClockTracker()
    const fps = 25
    const freewheelFrames = 10 // 400ms @ 25fps

    expect(tracker.onDecodedFrame(12, 1000)).toBe(12)
    expect(tracker.poll(1050, fps, freewheelFrames)).toEqual({
      status: 'lock',
      timeSec: 12,
      shouldFollow: false,
      shouldStop: false,
    })

    // Mất tín hiệu 240ms (< 400ms): trạng thái freewheel và timeline chạy trớn tới 12.24s
    const fw = tracker.poll(1240, fps, freewheelFrames)
    expect(fw.status).toBe('freewheel')
    expect(fw.shouldFollow).toBe(true)
    expect(fw.shouldStop).toBe(false)
    expect(fw.timeSec).toBeCloseTo(12.24, 3)

    // Vượt quá 400ms (+550ms -> gap 550ms > 400ms): chạm ngưỡng tối đa 12.40s rồi chuyển lost và stop đúng 1 lần
    const lost1 = tracker.poll(1550, fps, freewheelFrames)
    expect(lost1.status).toBe('lost')
    expect(lost1.timeSec).toBeCloseTo(12.4, 3)
    expect(lost1.shouldFollow).toBe(false)
    expect(lost1.shouldStop).toBe(true)

    // Các lần poll tiếp theo khi lost không đẩy thời gian trôi thêm và không spam stop
    const lost2 = tracker.poll(2000, fps, freewheelFrames)
    expect(lost2).toEqual({
      status: 'lost',
      timeSec: null,
      shouldFollow: false,
      shouldStop: false,
    })

    // Có tín hiệu lại -> lock trở lại
    expect(tracker.onDecodedFrame(15, 2100)).toBe(15)
    expect(tracker.poll(2120, fps, freewheelFrames).status).toBe('lock')
  })

  it('updateClipEndTime và updateClipStartTime giữ đúng tỉ lệ keyframe, min duration, bounds và từ chối NaN', async () => {
    const { updateClipEndTime, updateClipStartTime } = await import('./timeline')
    const clip = {
      id: 'c1',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 2,
      duration: 4,
      curveMode: 'linear' as const,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 2, height: 2 },
        { id: 'k3', offset: 4, height: 0 },
      ],
    }

    expect(updateClipEndTime(clip, Number.NaN)).toBeNull()
    expect(updateClipStartTime(clip, Number.POSITIVE_INFINITY)).toBeNull()

    // Kéo kết thúc từ 6s -> 8s: duration thành 6s, keyframe co giãn tỉ lệ 1.5x (0, 3, 6)
    const expanded = updateClipEndTime(clip, 8, { minStart: 0, maxEnd: 10 })!
    expect(expanded.duration).toBe(6)
    expect(expanded.keyframes?.map((k) => k.offset)).toEqual([0, 3, 6])

    // Chặn min duration 0.4s khi nhập kết thúc <= startTime
    const minClamped = updateClipEndTime(clip, 1.5, { minStart: 0, maxEnd: 10 })!
    expect(minClamped.duration).toBe(0.4)
    expect(minClamped.keyframes?.map((k) => k.offset)).toEqual([0, 0.2, 0.4])

    // Chặn không vượt quá clip kế tiếp (maxEnd = 7.25)
    const maxClamped = updateClipEndTime(clip, 9, { minStart: 0, maxEnd: 7.25 })!
    expect(maxClamped.duration).toBe(5.25)

    // Từ chối nếu khe trống tới clip kế tiếp nhỏ hơn minDuration (vd: [0..0.2], clip kế tiếp bắt đầu ở 0.3)
    const shortClip = { ...clip, startTime: 0, duration: 0.2 }
    expect(updateClipEndTime(shortClip, 0.25, { minStart: 0, maxEnd: 0.3 })).toBeNull()

    // Chỉnh startTime tôn trọng biên trái/phải
    expect(updateClipStartTime(clip, 0.5, { minStart: 1.2, maxEnd: 7.5 })).toEqual({ startTime: 1.2 })
    expect(updateClipStartTime(clip, 5, { minStart: 1.2, maxEnd: 7.5 })).toEqual({ startTime: 3.5 })
  })

  it('hỗ trợ timeline 40/50/60 fps: timecode, snap, kéo moment, LTC giữ rate riêng, migrate Art-Net+5568 -> 6454', async () => {
    const {
      FPS_OPTIONS,
      LTC_FPS_OPTIONS,
      formatTc,
      isStandardLtcFps,
      parseTc,
      resolveLtcFps,
      snapDeltaToFps,
      snapTimeToFps,
    } = await import('./timecode')
    const {
      buildMultiClipShiftPatch,
      resolveClipStartNoOverlap,
      syncModuleClipsContinuity,
    } = await import('./timeline')
    const { normalizeProject } = await import('./preset')
    const { resolveOutputSettingsPatch } = await import('./protocols')

    expect(FPS_OPTIONS).toEqual([24, 25, 29.97, 30, 40, 50, 60])
    expect(LTC_FPS_OPTIONS).toEqual([24, 25, 29.97, 30])

    // Timecode & snap ở 40, 50, 60 fps
    expect(formatTc(1.025, 40)).toBe('00:00:01:01')
    expect(parseTc('00:00:01:39', 40)).toBeCloseTo(1.975, 4)
    expect(parseTc('00:00:01:40', 40)).toBeNull()
    expect(snapTimeToFps(0.024, 40)).toBe(0.025)

    expect(formatTc(1.02, 50)).toBe('00:00:01:01')
    expect(parseTc('00:00:01:49', 50)).toBeCloseTo(1.98, 4)
    expect(parseTc('00:00:01:50', 50)).toBeNull()
    expect(snapTimeToFps(0.021, 50)).toBe(0.02)

    const f60 = snapTimeToFps(0.017, 60)
    expect(f60).toBe(0.0167)
    expect(formatTc(f60, 60)).toBe('00:00:00:01')
    expect(formatTc(59 / 60, 60)).toBe('00:00:00:59')
    expect(parseTc('00:00:00:59', 60)).toBeCloseTo(59 / 60, 4)
    expect(parseTc('00:00:00:60', 60)).toBeNull()
    expect(snapDeltaToFps(0.034, 60)).toBe(0.0333)

    // Kéo moment & sync giữ chính xác toạ độ snap của 40/60 fps (không bị làm tròn sai về 2 số thập phân)
    const c1 = {
      id: 'm40-1',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 0.025,
      duration: 1,
      keyframes: [
        { id: 'k1', offset: 0, height: 0 },
        { id: 'k2', offset: 1, height: 1 },
      ],
    }
    const c2 = {
      id: 'm40-2',
      layerId: 'l1',
      moduleId: 'm1',
      startTime: 2,
      duration: 1,
      keyframes: [
        { id: 'k3', offset: 0, height: 1 },
        { id: 'k4', offset: 1, height: 0 },
      ],
    }
    expect(resolveClipStartNoOverlap([c2], 1, 0.024, undefined, 40)).toBe(0.025)
    expect(resolveClipStartNoOverlap([c2], 1, 0.017, undefined, 60)).toBe(0.0167)
    const synced40 = syncModuleClipsContinuity([c1, c2], 'm1')
    expect(synced40[0].startTime).toBe(0.025)

    const shifted60 = buildMultiClipShiftPatch(
      [{ ...c1, startTime: 1 }],
      ['m40-1'],
      0.017,
      new Map([['m40-1', 1]]),
      60,
    )!
    expect(shifted60.delta).toBe(0.0167)
    expect(shifted60.clips[0].startTime).toBe(1.0167)

    // LTC chuẩn chỉ 24/25/29.97/30: khi timeline >30 fps thì LTC giữ rate riêng, không giả vờ hỗ trợ 40/50/60
    expect(isStandardLtcFps(30)).toBe(true)
    expect(isStandardLtcFps(40)).toBe(false)
    expect(isStandardLtcFps(50)).toBe(false)
    expect(isStandardLtcFps(60)).toBe(false)
    expect(resolveLtcFps(60)).toBe(30)
    expect(resolveLtcFps(50, 25)).toBe(25)
    expect(resolveLtcFps(25)).toBe(25)

    // 1) Legacy v1.0.0 (không có schemaVersion) sACN/KiNET với port 6454 -> migrate về 5568/6038 theo đúng hành vi gửi v1.0.0
    const legacySacn6454 = createDefaultProject()
    delete legacySacn6454.schemaVersion
    legacySacn6454.settings.output.driver = 'sacn'
    legacySacn6454.settings.output.port = 6454
    const normLegacySacn = normalizeProject(legacySacn6454)
    expect(normLegacySacn.settings.output.port).toBe(5568)
    expect(normLegacySacn.schemaVersion).toBe(2)

    const legacyKinet6454 = createDefaultProject()
    delete legacyKinet6454.schemaVersion
    legacyKinet6454.settings.output.driver = 'kinet'
    legacyKinet6454.settings.output.port = 6454
    const normLegacyKinet = normalizeProject(legacyKinet6454)
    expect(normLegacyKinet.settings.output.port).toBe(6038)
    expect(normLegacyKinet.schemaVersion).toBe(2)

    // 2) Legacy v1.0.0 với custom port khác (vd Art-Net 5568/6038, sACN 6038, KiNET 5568) vẫn giữ nguyên
    const legacyBroadcastArtNet5568 = createDefaultProject()
    delete legacyBroadcastArtNet5568.schemaVersion
    legacyBroadcastArtNet5568.settings.output.driver = 'artnet'
    legacyBroadcastArtNet5568.settings.output.port = 5568
    expect(normalizeProject(legacyBroadcastArtNet5568).settings.output.port).toBe(5568)

    const legacySacn6038 = createDefaultProject()
    delete legacySacn6038.schemaVersion
    legacySacn6038.settings.output.driver = 'sacn'
    legacySacn6038.settings.output.port = 6038
    expect(normalizeProject(legacySacn6038).settings.output.port).toBe(6038)

    // 3) Dự án mới v1.0.1 (schemaVersion: 2): mọi custom port dương (kể cả sACN 6454, KiNET 6454, Art-Net 5568/6038) đều được giữ nguyên
    const explicitSacn6454 = createDefaultProject()
    explicitSacn6454.settings.output = resolveOutputSettingsPatch(explicitSacn6454.settings.output, { driver: 'sacn', port: 6454 })
    expect(normalizeProject(explicitSacn6454).settings.output.port).toBe(6454)

    const explicitKinet6454 = createDefaultProject()
    explicitKinet6454.settings.output = resolveOutputSettingsPatch(explicitKinet6454.settings.output, { driver: 'kinet', port: 6454 })
    expect(normalizeProject(explicitKinet6454).settings.output.port).toBe(6454)

    const broadcastArtNet6038 = createDefaultProject()
    broadcastArtNet6038.settings.output.driver = 'artnet'
    broadcastArtNet6038.settings.output.port = 6038
    expect(normalizeProject(broadcastArtNet6038).settings.output.port).toBe(6038)

    const missingArtNetPort = createDefaultProject()
    missingArtNetPort.settings.output.driver = 'artnet'
    delete (missingArtNetPort.settings.output as { port?: number }).port
    const filledArtNet = normalizeProject(missingArtNetPort)
    expect(filledArtNet.settings.output.port).toBe(6454)

    const customArtNet = createDefaultProject()
    customArtNet.settings.output.driver = 'artnet'
    customArtNet.settings.output.port = 6455
    expect(normalizeProject(customArtNet).settings.output.port).toBe(6455)

    // Lưu / mở project 60 fps + ltc.fps riêng, từ chối ltc.fps > 30
    const hiFps = createDefaultProject()
    hiFps.settings.timeline.fps = 60
    hiFps.settings.ltc.fps = 25
    const normHi = normalizeProject(hiFps)
    expect(normHi.settings.timeline.fps).toBe(60)
    expect(normHi.settings.ltc.fps).toBe(25)
    const badLtcFps = createDefaultProject()
    ;(badLtcFps.settings.ltc as { fps?: number }).fps = 60
    expect(() => normalizeProject(badLtcFps)).toThrow()

    // Đổi giao thức thì port tự đổi theo, sACN map sacnUniverse ?? universe + 1
    const sacnOut = resolveOutputSettingsPatch(filledArtNet.settings.output, { driver: 'sacn' })
    expect(sacnOut.port).toBe(5568)
    expect(sacnOut.sacnUniverse).toBe(filledArtNet.settings.output.universe + 1)
    const backToArtNet = resolveOutputSettingsPatch(sacnOut, { driver: 'artnet' })
    expect(backToArtNet.port).toBe(6454)
  })
})

describe('project round-trip của trường mới', () => {
  it('homeOffsetMm + locked + output.sendHz giữ nguyên qua serialize → parse', () => {
    const project = createDefaultProject()
    project.modules[0].homeOffsetMm = 12.5
    project.modules[0].locked = true
    project.modules[1].homeOffsetMm = 40
    const back = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(project))))
    expect(back).toEqual(normalizeProject(project))
    expect(back.modules[0]).toMatchObject({ homeOffsetMm: 12.5, locked: true })
    expect(back.modules[1].homeOffsetMm).toBe(40)
  })

  it('project cũ không có trường mới vẫn mở được, mặc định: không offset, không khoá', () => {
    const project = createDefaultProject()
    const raw = JSON.parse(JSON.stringify(project))
    for (const m of raw.modules) {
      delete m.homeOffsetMm
      delete m.locked
      m.fineTune = 100 // trường v1.0.4 bị bỏ qua
    }
    const back = normalizeProject(raw)
    expect(back.modules.every((m) => m.homeOffsetMm === undefined && m.locked === undefined && !('fineTune' in m))).toBe(true)
  })
})
