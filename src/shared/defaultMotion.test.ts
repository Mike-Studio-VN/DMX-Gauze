import { describe, expect, it } from 'vitest'
import { ch3ToCms, durationToCh3, cmsToCh3, snapPos } from './convert'
import { GauzeCore } from './core'
import { MockDriver } from './drivers'
import { LOCK_VALUE } from './dmx'
import { createDefaultProject, normalizeProject } from './preset'
import {
  buildLayerMotionClips,
  buildPresetPatchForClips,
  clipPeakSpeedCms,
  CURVE_PRESETS,
  DEFAULT_MOTION_SPEED_CMS,
  defaultCueSpeedCms,
  defaultMotionSpeedCms,
  fitDefaultMotionDuration,
  LAYER_MOTION_PRESETS,
  planTimelineFollow,
  segmentDistCm,
} from './timeline'
import type { TimelineClip } from './types'

describe('default motion within 50 cm/s on each module scale', () => {
  it('retimes the template moments for peak ease speed and limits every bundled cue', () => {
    const project = createDefaultProject()
    expect(DEFAULT_MOTION_SPEED_CMS).toBe(50)
    expect(project.clips?.[0].duration).toBeGreaterThan(4)
    expect(project.clips?.[1].duration).toBeGreaterThan(6)
    for (const clip of project.clips ?? []) {
      const mod = project.modules.find((m) => m.id === clip.moduleId)!
      expect(clipPeakSpeedCms(clip, mod)).toBeLessThanOrEqual(defaultMotionSpeedCms(mod))
      expect(clip.keyframes.at(-1)?.offset).toBe(clip.duration)
    }
    for (const cue of project.buttons) {
      for (const step of cue.steps) {
        const mod = project.modules.find((m) => m.id === step.moduleId)!
        const dist = Math.max(segmentDistCm(mod, mod.minHeight, step.position), segmentDistCm(mod, mod.maxHeight, step.position))
        const ch3 = cue.speedUnit === 'sec'
          ? durationToCh3(dist / 100, cue.speedValue, mod.maxSpeedCms).ch3
          : cmsToCh3(cue.speedValue, mod.maxSpeedCms)
        expect(ch3ToCms(ch3, mod.maxSpeedCms)).toBeLessThanOrEqual(Math.min(50, mod.maxSpeedCms))
      }
    }
    expect(normalizeProject(JSON.parse(JSON.stringify(project))).clips).toEqual(project.clips)
    expect(normalizeProject(JSON.parse(JSON.stringify(project))).buttons).toEqual(project.buttons)
  })

  it('sends the largest safe CH3 step for mixed module limits, including modules slower than 50', () => {
    const project = createDefaultProject()
    const modules = [30, 80, 120, 200].map((maxSpeedCms, i) => ({ ...project.modules[i], maxSpeedCms }))
    const clips = modules.map((mod) => fitDefaultMotionDuration({
      ...project.clips![0], moduleId: mod.id,
    }, mod))
    const core = new GauzeCore((_cfg, events) => new MockDriver(events), () => 1000)
    core.configure({ modules, output: project.settings.output, lockValue: LOCK_VALUE })
    core.start()
    core.command({ type: 'lock', locked: false })
    const commands = planTimelineFollow(modules, clips, [], 2).commands
    for (const command of commands) expect(core.command(command).ok).toBe(true)
    const expected = [255, 159, 106, 63]
    expect(commands).toHaveLength(modules.length)
    const cueSpeed = defaultCueSpeedCms(modules)
    for (const [i, mod] of modules.entries()) {
      const limit = Math.min(50, mod.maxSpeedCms)
      const ch3 = core.snapshot().modules[mod.id].ch3
      expect(ch3).toBeLessThanOrEqual(expected[i])
      expect(ch3ToCms(ch3, mod.maxSpeedCms)).toBeLessThanOrEqual(limit)
      expect(clipPeakSpeedCms(clips[i], mod)).toBeLessThanOrEqual(limit)
      expect(ch3ToCms(cmsToCh3(cueSpeed, mod.maxSpeedCms), mod.maxSpeedCms)).toBeLessThanOrEqual(limit)
    }
    for (const speed of [{ unit: 'sec', value: 0.5 }, { unit: 'cms', value: 200 }] as const) {
      expect(core.command({
        type: 'move', ids: modules.map(({ id }) => id), target: 1, speed: { ...speed, limitCms: 50 },
      }).ok).toBe(true)
      expect(modules.map(({ id }) => core.snapshot().modules[id].ch3)).toEqual(expected)
    }
    core.stop()
  })

  it('retimes all Layer and curve presets for travel including clamped 8-bit distances', () => {
    const project = createDefaultProject()
    const back = { ...project.modules.at(-1)!, minHeight: 0.27, maxHeight: 2.93 }
    const protectedClip: TimelineClip = {
      id: 'existing', layerId: back.layerId, moduleId: back.id, startTime: 5, duration: 2,
      keyframes: [{ id: 'hold', offset: 0, height: 0.6 }],
    }
    for (const { id: presetId } of LAYER_MOTION_PRESETS) {
      const [clip] = buildLayerMotionClips({
        layerId: back.layerId, modules: [back], existingClips: [protectedClip], presetId, startTime: 0, duration: 4,
      })
      expect(clipPeakSpeedCms(clip, back)).toBeLessThanOrEqual(DEFAULT_MOTION_SPEED_CMS)
      expect(clip.startTime + clip.duration <= 5 || clip.startTime >= 7).toBe(true)
    }

    const flat = fitDefaultMotionDuration({ ...protectedClip, startTime: 0, duration: 4 }, back)
    expect(flat.duration).toBe(4)
    for (const { id: presetId } of CURVE_PRESETS) {
      const [clip] = buildPresetPatchForClips([flat], [back], [flat.id], { presetId })!
      expect(clipPeakSpeedCms(clip, back)).toBeLessThanOrEqual(DEFAULT_MOTION_SPEED_CMS)
    }
    const next = { ...protectedClip, id: 'next' }
    expect(buildPresetPatchForClips([flat, next], [back], [flat.id], { presetId: 'sine' })).toBeNull()
  })

  it('limits Auto seeks, tracking, pre-roll and holds while preserving legacy and explicit Manual speeds', () => {
    const project = createDefaultProject()
    const mod = project.modules[0]
    for (const curveMode of ['smooth', 'linear'] as const) {
      const clip = { ...project.clips![0], curveMode }
      const far = { modules: { [mod.id]: { pos: 0.8, target: 0.8, ch3: 255, moving: true } } }
      for (const [time, lookahead] of [[0, 0], [0, 0.06], [1, 0.06], [1.9, 0], [1.9, 0.06], [99, 0.06]]) {
        const cmd = planTimelineFollow([mod], [clip], [], time, lookahead, far).commands[0]
        if (cmd?.type !== 'move' || cmd.speed.value === undefined) throw new Error('Expected an Auto move')
        expect(ch3ToCms(cmsToCh3(cmd.speed.value, mod.maxSpeedCms), mod.maxSpeedCms)).toBeLessThanOrEqual(50)
      }
      const manual = { ...clip, keyframes: clip.keyframes.map((point) => ({
        ...point, speedMode: 'manual' as const, manualSpeedCms: 80,
      })) }
      expect(planTimelineFollow([mod], [manual], [], 1, 0.06, far).commands[0]).toMatchObject({ speed: { value: 80 } })
    }

    const legacyClip: TimelineClip = {
      id: 'legacy', layerId: mod.layerId, moduleId: mod.id, startTime: 0, duration: 1, curveMode: 'linear',
      keyframes: [{ id: 'from', offset: 0, height: 0 }, { id: 'to', offset: 1, height: 1 }],
    }
    const legacyCue = { ...project.buttons[0], speedUnit: 'cms' as const, speedValue: 60, autoSpeedLimitCms: undefined }
    const saved = JSON.parse(JSON.stringify({ ...project, clips: [legacyClip], buttons: [legacyCue] }))
    const restored = normalizeProject(saved)
    expect(restored.clips).toEqual([legacyClip])
    expect(restored.buttons).toEqual([JSON.parse(JSON.stringify(legacyCue))])
    expect(planTimelineFollow([mod], restored.clips!, [], 0).commands[0]).toMatchObject({
      target: snapPos(1, mod), speed: { value: 100 },
    })
  })
})
