import { describe, expect, it } from 'vitest'
import { dmxToPos } from './convert'
import { GauzeCore } from './core'
import { CH } from './dmx'
import { MockDriver } from './drivers'
import { createDefaultProject, normalizeProject } from './preset'
import { buildLayerMotionClips, evaluateModuleTimelineHeight, planTimelineFollow } from './timeline'
import type { TimelineClip } from './types'

function fixture() {
  const project = createDefaultProject()
  const [layer, otherLayer] = project.layers
  const [first, second, third] = project.modules
  const modules = [
    first,
    { ...project.modules.find((mod) => mod.layerId === otherLayer.id)! },
    second,
    third,
  ]
  return { project, layerId: layer.id, modules }
}

describe('alternating Layer wave', () => {
  it('generates one shared cycle in Layer order and reverses the phase when requested', () => {
    const { layerId, modules } = fixture()
    const [odd, , even, nextOdd] = modules
    const options = {
      layerId, modules, existingClips: [], presetId: 'alternating-wave', startTime: 2, duration: 4,
    } satisfies Parameters<typeof buildLayerMotionClips>[0]
    const clips = buildLayerMotionClips(options)
    expect(clips.map((clip) => clip.moduleId)).toEqual([odd.id, even.id, nextOdd.id])
    expect(clips.map((clip) => [clip.startTime, clip.duration])).toEqual([[2, 4], [2, 4], [2, 4]])

    const height = (time: number) => modules.filter((mod) => mod.layerId === layerId)
      .map((mod) => evaluateModuleTimelineHeight(clips, [], mod, time))
    expect(height(2)).toEqual([0.1, 0.1, 0.1])
    expect(height(3)).toEqual([0, 0.2, 0])
    expect(height(5)).toEqual([0.2, 0, 0.2])
    expect(height(6)).toEqual(height(2))

    const reversed = buildLayerMotionClips({ ...options, duration: 8, amplitudeCm: 5, firstUp: 'even' })
    expect(evaluateModuleTimelineHeight(reversed, [], odd, 4)).toBeCloseTo(0.1)
    expect(evaluateModuleTimelineHeight(reversed, [], even, 4)).toBeCloseTo(0)
    expect(evaluateModuleTimelineHeight(reversed, [], odd, 8)).toBeCloseTo(0)
  })

  it('clamps travel and amplitude, avoids overlap and survives project JSON round trips', () => {
    const { project, layerId, modules } = fixture()
    const [first, , second, third] = modules
    const narrow = { ...first, length: 0.22, minHeight: 0.201, maxHeight: 0.22 }
    const slow = { ...second, maxSpeedCms: 1 }
    const fixed = { ...third, minHeight: 0.25, maxHeight: 0.25 }
    const existing: TimelineClip = {
      id: 'existing', layerId, moduleId: narrow.id, startTime: 0, duration: 2.003,
      keyframes: [{ id: 'hold', offset: 0, height: 0.215 }],
    }
    const options = {
      layerId, modules: [narrow, slow, fixed], existingClips: [existing], presetId: 'alternating-wave',
      startTime: 1, duration: 4, amplitudeCm: 1_000,
    } satisfies Parameters<typeof buildLayerMotionClips>[0]
    const clips = buildLayerMotionClips(options)
    expect(clips.map((clip) => clip.startTime)).toEqual([2.01, 2.01, 2.01])
    const [narrowClip, slowClip, fixedClip] = clips
    expect(Math.min(...narrowClip.keyframes.map((point) => point.height))).toBeCloseTo(0.201)
    expect(Math.max(...narrowClip.keyframes.map((point) => point.height))).toBeCloseTo(0.22)
    expect(slowClip.keyframes[2].height - slowClip.keyframes[0].height).toBeLessThan(0.003)
    expect(fixedClip.keyframes.every((point) => point.height === 0.25)).toBe(true)
    expect(buildLayerMotionClips({ ...options, amplitudeCm: Number.NaN })).toEqual([])
    expect(buildLayerMotionClips({ ...options, amplitudeCm: -1 })).toEqual([])

    const saved = normalizeProject(JSON.parse(JSON.stringify({
      ...project, modules: options.modules, clips: [existing, ...clips],
    })))
    expect(saved.clips?.slice(1)).toEqual(clips)
    expect(saved.clips?.[0].keyframes).toEqual(existing.keyframes)
  })

  it('drives opposing DMX targets and snapshot positions throughout Timeline playback', () => {
    const { project, layerId, modules } = fixture()
    const pair = [modules[0], modules[2]]
    const clips = buildLayerMotionClips({
      layerId, modules: pair, existingClips: [], presetId: 'alternating-wave', startTime: 0, duration: 4,
    })
    let driver: MockDriver | undefined
    let now = 0
    const core = new GauzeCore((_cfg, events) => (driver = new MockDriver(events)), () => now)
    core.configure({ modules: pair, output: project.settings.output, lockValue: project.settings.lockValue })
    core.command({ type: 'lock', locked: false })

    const runUntil = (seconds: number) => {
      while (now < seconds * 1000) {
        const plan = planTimelineFollow(pair, clips, [], now / 1000, 0.04, core.snapshot())
        for (const command of plan.commands) expect(core.command(command).ok).toBe(true)
        now += 40
        core.tick()
      }
      const snapshot = core.snapshot()
      return pair.map((mod) => {
        const address = mod.startAddress - 1
        const frame = driver!.last
        const target = dmxToPos(frame[address + CH.POSITION], frame[address + CH.FINE], mod.length)
        expect(target).toBeCloseTo(snapshot.modules[mod.id].target, 4)
        return { target, displayedDrop: snapshot.modules[mod.id].pos }
      })
    }

    try {
      const [oddFirst, evenFirst] = runUntil(1)
      const [oddSecond, evenSecond] = runUntil(3)
      expect(oddFirst.target).toBeLessThan(evenFirst.target)
      expect(oddFirst.displayedDrop).toBeLessThan(evenFirst.displayedDrop)
      expect(oddSecond.target).toBeGreaterThan(evenSecond.target)
      expect(oddSecond.displayedDrop).toBeGreaterThan(evenSecond.displayedDrop)
    } finally {
      core.stop()
    }
  })
})
