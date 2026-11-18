import { describe, expect, it } from 'vitest'
import { ch3ToCms, cmsToCh3, durationToCh3, snapPos } from './convert'
import { DEFAULT_SPEED } from './dmx'
import { createDefaultProject, normalizeProject } from './preset'
import {
  buildLayerMotionClips,
  buildPresetPatchForClips,
  clipPeakSpeedCms,
  CURVE_PRESETS,
  DEFAULT_MOTION_SPEED_CMS,
  fitDefaultMotionDuration,
  LAYER_MOTION_PRESETS,
  planTimelineFollow,
  segmentDistCm,
} from './timeline'
import type { TimelineClip } from './types'

describe('default motion at the recommended CH3 speed', () => {
  it('retimes the template moments for peak ease speed and limits every bundled cue', () => {
    const project = createDefaultProject()
    expect(DEFAULT_MOTION_SPEED_CMS).toBe(ch3ToCms(DEFAULT_SPEED))
    expect(project.clips?.[0].duration).toBeGreaterThan(4)
    expect(project.clips?.[1].duration).toBeGreaterThan(6)
    for (const clip of project.clips ?? []) {
      const mod = project.modules.find((m) => m.id === clip.moduleId)!
      expect(clipPeakSpeedCms(clip, mod)).toBeLessThanOrEqual(DEFAULT_MOTION_SPEED_CMS)
      expect(clip.keyframes.at(-1)?.offset).toBe(clip.duration)
    }
    for (const cue of project.buttons) {
      for (const step of cue.steps) {
        const mod = project.modules.find((m) => m.id === step.moduleId)!
        const dist = Math.max(segmentDistCm(mod, mod.minHeight, step.position), segmentDistCm(mod, mod.maxHeight, step.position))
        const ch3 = cue.speedUnit === 'sec' ? durationToCh3(dist / 100, cue.speedValue).ch3 : cmsToCh3(cue.speedValue)
        expect(ch3).toBeLessThanOrEqual(DEFAULT_SPEED)
      }
    }
    expect(normalizeProject(JSON.parse(JSON.stringify(project))).clips).toEqual(project.clips)
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
        expect(cmsToCh3(cmd.speed.value)).toBeLessThanOrEqual(DEFAULT_SPEED)
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
    const legacyCue = { ...project.buttons[0], speedUnit: 'cms' as const, speedValue: 60 }
    const saved = JSON.parse(JSON.stringify({ ...project, clips: [legacyClip], buttons: [legacyCue] }))
    const restored = normalizeProject(saved)
    expect(restored.clips).toEqual([legacyClip])
    expect(restored.buttons).toEqual([legacyCue])
    expect(planTimelineFollow([mod], restored.clips!, [], 0).commands[0]).toMatchObject({
      target: snapPos(1, mod), speed: { value: 100 },
    })
  })
})
