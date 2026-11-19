import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Layers,
  Link2,
  Magnet,
  Pause,
  Play,
  Plus,
  Settings,
  SkipBack,
  SkipForward,
  WifiOff,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { clamp } from '@shared/convert'
import { addressRange } from '@shared/dmx'
import { startDmxFrameLoop } from '@shared/dmxTransport'
import { LtcClockTracker, LtcDecoder } from '@shared/ltc'
import {
  FPS_OPTIONS,
  formatTc,
  isStandardLtcFps,
  nominalFps,
  realFps,
  resolveLtcFps,
  snapTimeToFps,
  tcToSeconds,
} from '@shared/timecode'
import {
  LinearFollowPlanner,
  analyzeClipSpeeds,
  analyzeTimeline,
  buildCurveKeyframes,
  DEFAULT_MOTION_SPEED_CMS,
  computeMarqueeSelectedClipIds,
  fullCurvePath,
  heightToPercent,
  mapKeyframesToPts,
  parseTimelineSecondsInput,
  planTimelineFollow,
  resolveClipBoundsNoOverlap,
  resolveClipStartNoOverlap,
  segmentPath,
} from '@shared/timeline'
import type { ClipKeyframe, Fps, ModuleCfg, TimelineClip } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

const MIN_CLIP_DUR = 0.4
const CLIP_MIN_W = 24
const CURVE_COLORS = ['#F7842E', '#C58A5B', '#A86A3E', '#DE9D68', '#8F5B38']
const BODY_H = 28
const DOT_PAD_X = 6
const DOT_PAD_Y = 5
const FOLLOWING_LTC = 'Đang theo LTC'

function followsLtc(): boolean {
  return useAppStore.getState().ltcActive
}

function heightToY(h: number, minH: number, maxH: number, height: number, padY = DOT_PAD_Y): number {
  const usableH = Math.max(4, height - padY * 2)
  const span = Math.max(0.1, maxH - minH)
  const hNorm = clamp((h - minH) / span, 0, 1)
  return padY + (1 - hNorm) * usableH
}

function buildTrackConnectorSegments(
  modClips: TimelineClip[],
  minH: number,
  maxH: number,
  pxPerSec: number,
  timelineWidth: number,
  height: number,
  padX = DOT_PAD_X,
  padY = DOT_PAD_Y,
): Array<[number, number, number, number]> {
  const sortedClips = [...modClips].sort((a, b) => a.startTime - b.startTime)
  if (sortedClips.length === 0) {
    const y = heightToY(minH, minH, maxH, height, padY)
    return [[0, y, timelineWidth, y]]
  }

  const clipMeta = sortedClips.map((c) => {
    const kfs = [...c.keyframes].sort((a, b) => a.offset - b.offset)
    const left = c.startTime * pxPerSec
    const width = Math.max(CLIP_MIN_W, c.duration * pxPerSec)
    const startY = heightToY(kfs[0]?.height ?? minH, minH, maxH, height, padY)
    const endY = heightToY(kfs[kfs.length - 1]?.height ?? minH, minH, maxH, height, padY)
    return { left, width, startY, endY }
  })

  const segs: Array<[number, number, number, number]> = []
  segs.push([0, clipMeta[0].startY, clipMeta[0].left + padX, clipMeta[0].startY])
  for (let i = 0; i < clipMeta.length - 1; i++) {
    const a = clipMeta[i]
    const b = clipMeta[i + 1]
    segs.push([a.left + a.width - padX, a.endY, b.left + padX, b.startY])
  }
  const last = clipMeta[clipMeta.length - 1]
  segs.push([last.left + last.width - padX, last.endY, timelineWidth, last.endY])
  return segs
}

export function TimelineEditor({ modeTabs }: { modeTabs?: ReactNode }) {
  const {
    project,
    snapshot,
    selectedIds,
    selectedClipId,
    selectedClipIds,
    selectedKeyId,
    selectedTimelineLayerId,
    selectModule,
    selectTimelineClip,
    selectTimelineClips,
    selectTimelineKey: setSelectedKeyId,
    selectTimelineLayer,
    toggleLayerSync,
    addClip,
    updateClip,
    moveSelectedClipsByDelta,
    updateTimelineSettings,
    setSettingsOpen,
    setPlayheadTime,
    ltcActive,
    setLtcActive,
    ltcDropFrame,
    setLtcDropFrame,
    sendCommand,
    holdTimelineTargets,
    notify,
  } = useAppStore()

  const storedFps = project.settings.timeline.fps
  const dmxHz = project.settings.output.sendHz
  const ltcMatched = isStandardLtcFps(storedFps)
  const effectiveLtcFps = resolveLtcFps(storedFps, project.settings.ltc.fps)
  const fps = ltcActive ? effectiveLtcFps : storedFps
  const dropFrame = ltcActive ? ltcDropFrame : undefined
  const formatTimelineTc = (sec: number) => formatTc(sec, fps, dropFrame)
  const clips = useMemo(() => project.clips ?? [], [project.clips])
  const [time, setTime] = useState(project.settings.timeline.startTime)

  useEffect(() => {
    setPlayheadTime(time)
  }, [time, setPlayheadTime])
  const [playing, setPlaying] = useState(false)
  const localTransportRef = useRef<'idle' | 'local'>('idle')
  const [ltcStatus, setLtcStatus] = useState<'off' | 'lock' | 'freewheel' | 'lost'>('off')
  const [snapToFrame, setSnapToFrame] = useState(true)
  const [pxPerSec, setPxPerSec] = useState(64)
  const [editingHead, setEditingHead] = useState(false)
  const [headInput, setHeadInput] = useState('')
  const headCanceledRef = useRef(false)
  const [collapsedLayers, setCollapsedLayers] = useState<Record<string, boolean>>({})
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [dragTimeTip, setDragTimeTip] = useState<{ x: number; y: number; text: string } | null>(null)

  const rulerRef = useRef<HTMLDivElement>(null)
  const tracksScrollRef = useRef<HTMLDivElement>(null)
  const tracksContainerRef = useRef<HTMLDivElement>(null)
  const marqueeDraggedRef = useRef(false)
  const clipDraggedRef = useRef(false)
  const marqueeCleanupRef = useRef<(() => void) | null>(null)
  const scrubCleanupRef = useRef<(() => void) | null>(null)
  const timeRef = useRef(time)
  timeRef.current = time
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const keysRef = useRef(project.keys)
  keysRef.current = project.keys
  const modulesRef = useRef(project.modules)
  modulesRef.current = project.modules
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const sendCommandRef = useRef(sendCommand)
  sendCommandRef.current = sendCommand
  const lastScrubSendRef = useRef(0)
  const playbackLastTickRef = useRef(0)
  const linearPlannerRef = useRef(new LinearFollowPlanner())
  const ltcClockRef = useRef(new LtcClockTracker())
  const ltcSessionStartedRef = useRef(false)

  const maxTime = useMemo(
    () => Math.max(20, ...clips.map((c) => c.startTime + c.duration + 4), ...project.keys.map((k) => k.time + 4)),
    [clips, project.keys],
  )

  const allIssues = useMemo(() => analyzeTimeline(clips, project.modules), [clips, project.modules])
  const unfeasibleIssues = useMemo(() => allIssues.filter((i) => !i.feasible), [allIssues])

  const dispatchTimelineFollow = (t: number, lookaheadSec: number) => {
    const snap = snapshotRef.current
    if (snap?.locked) {
      linearPlannerRef.current.reset()
      return
    }
    const { commands, warnings } = planTimelineFollow(
      modulesRef.current,
      clipsRef.current,
      keysRef.current,
      t,
      lookaheadSec,
      snap,
      linearPlannerRef.current,
    )
    if (warnings.length > 0) notify(warnings[0], 'warn')
    for (const c of commands) void sendCommandRef.current(c, { quietWarnings: true, source: 'timeline' })
  }
  const dispatchFollowRef = useRef(dispatchTimelineFollow)
  dispatchFollowRef.current = dispatchTimelineFollow

  useEffect(() => () => {
    marqueeCleanupRef.current?.()
    scrubCleanupRef.current?.()
    setLtcActive(false)
  }, [setLtcActive])

  useEffect(() => {
    if (snapshot?.locked) {
      linearPlannerRef.current.reset()
      if (playing) {
        localTransportRef.current = 'idle'
        setPlaying(false)
      }
    }
  }, [snapshot?.locked, playing])

  useEffect(() => {
    if (!ltcActive) {
      ltcSessionStartedRef.current = false
      return
    }
    localTransportRef.current = 'idle'
    setPlaying(false)
    scrubCleanupRef.current?.()
    setEditingHead(false)
    holdTimelineTargets()
  }, [ltcActive, holdTimelineTargets])

  useEffect(() => {
    if (!playing || ltcActive) return
    const stopPlayback = startDmxFrameLoop(dmxHz, (now) => {
      if (localTransportRef.current !== 'local' || followsLtc()) return
      const dt = (now - playbackLastTickRef.current) / 1000
      playbackLastTickRef.current = now
      const next = Math.min(maxTime, timeRef.current + dt)
      timeRef.current = next
      setTime(next)
      if (next >= maxTime) {
        linearPlannerRef.current.reset()
        dispatchFollowRef.current(maxTime, 0)
        localTransportRef.current = 'idle'
        stopPlayback()
        setPlaying(false)
      } else {
        dispatchFollowRef.current(next, 0.06)
      }
    })
    return stopPlayback
  }, [playing, ltcActive, maxTime, dmxHz])

  const { deviceId, channel, offsetFrames, freewheelFrames } = project.settings.ltc
  useEffect(() => {
    if (!ltcActive) {
      setLtcStatus('off')
      return
    }
    const planner = linearPlannerRef.current
    let stopped = false
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let heldTime = ltcSessionStartedRef.current ? timeRef.current : null
    ltcSessionStartedRef.current = true
    const clock = ltcClockRef.current
    const currentInput = () => {
      const { ltcActive: active, project: currentProject } = useAppStore.getState()
      const { ltc, timeline } = currentProject.settings
      return !stopped && active && ltc.deviceId === deviceId && ltc.channel === channel &&
        ltc.offsetFrames === offsetFrames && resolveLtcFps(timeline.fps, ltc.fps) === effectiveLtcFps
    }
    planner.reset()
    setLtcStatus('lost')
    setLtcDropFrame(undefined)

    const startLtc = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        })
        if (!currentInput()) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const proc = ctx.createScriptProcessor(2048, 2, 1)
        const dec = new LtcDecoder(
          ctx.sampleRate,
          (f) => {
            if (!currentInput()) return
            const nowMs = performance.now()
            const ltcRate = realFps(effectiveLtcFps)
            const rawSec = tcToSeconds(f, effectiveLtcFps) + offsetFrames / ltcRate
            // A replacement input may be behind the published clock after freewheel.
            if (heldTime !== null && Math.max(0, rawSec) < heldTime) return
            heldTime = null
            const { timeSec, discontinuity } = clock.onDecodedFrame(rawSec, nowMs)
            if (discontinuity) planner.reset()
            if (effectiveLtcFps === 29.97) setLtcDropFrame(f.df)
            setLtcStatus('lock')
            timeRef.current = timeSec
            setTime(timeSec)
          },
          nominalFps(effectiveLtcFps),
        )
        proc.onaudioprocess = (ev) => {
          if (!currentInput()) return
          const chIdx = channel === 'right' && ev.inputBuffer.numberOfChannels > 1 ? 1 : 0
          dec.push(ev.inputBuffer.getChannelData(chIdx))
        }
        src.connect(proc)
        proc.connect(ctx.destination)
        setLtcStatus('lost')
      } catch (err) {
        if (!currentInput()) return
        notify(`Không mở được ngõ âm thanh LTC: ${(err as Error).message}`, 'error')
        setLtcStatus('lost')
      }
    }
    void startLtc()

    return () => {
      stopped = true
      clock.reset()
      planner.reset()
      holdTimelineTargets()
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [ltcActive, effectiveLtcFps, deviceId, channel, offsetFrames, notify, holdTimelineTargets, setLtcDropFrame])

  useEffect(() => {
    if (!ltcActive) return
    return startDmxFrameLoop(dmxHz, (now) => {
      if (!followsLtc()) return
      const res = ltcClockRef.current.poll(now, realFps(effectiveLtcFps), freewheelFrames)
      setLtcStatus(res.status)
      if (res.timeSec !== null) {
        timeRef.current = res.timeSec
        setTime(res.timeSec)
        if (res.shouldFollow) dispatchFollowRef.current(res.timeSec, 0.06)
      }
      if (res.shouldStop) {
        linearPlannerRef.current.reset()
        holdTimelineTargets()
      }
    })
  }, [ltcActive, effectiveLtcFps, freewheelFrames, dmxHz, holdTimelineTargets])

  const previewTimelineAt = (t: number) => {
    if (followsLtc()) return
    linearPlannerRef.current.reset()
    dispatchTimelineFollow(t, 0)
  }

  const seekTo = (t: number, forcePreview = true) => {
    if (followsLtc()) return
    const clampedT = clamp(t, 0, maxTime)
    linearPlannerRef.current.reset()
    timeRef.current = clampedT
    setTime(clampedT)
    if (!forcePreview) return
    const now = performance.now()
    if (now - lastScrubSendRef.current >= 1000 / dmxHz) {
      lastScrubSendRef.current = now
      previewTimelineAt(clampedT)
    }
  }

  const quantizeTime = (sec: number) =>
    snapToFrame ? snapTimeToFps(sec, fps) : Math.max(0, Number(sec.toFixed(2)))

  const commitHeadInput = () => {
    if (headCanceledRef.current) {
      headCanceledRef.current = false
      setEditingHead(false)
      return
    }
    const parsed = parseTimelineSecondsInput(headInput, fps, dropFrame)
    if (parsed !== null) {
      const targetSec = snapToFrame ? snapTimeToFps(parsed, fps) : Number(parsed.toFixed(4))
      const clampedT = clamp(targetSec, 0, maxTime)
      seekTo(clampedT, true)
      previewTimelineAt(clampedT)
    }
    setEditingHead(false)
  }

  const scrubRulerFromClientX = (clientX: number, rectLeft: number) => {
    const t = quantizeTime((clientX - rectLeft) / pxPerSec)
    const latestT = clamp(t, 0, maxTime)
    seekTo(latestT, true)
    return latestT
  }

  const trackScrub = (onMove: (ev: PointerEvent) => void, finish: () => void) => {
    scrubCleanupRef.current?.()
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cleanup)
      scrubCleanupRef.current = null
    }
    const onUp = () => {
      cleanup()
      finish()
    }
    scrubCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cleanup)
  }

  const startHeadOrScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (editingHead || followsLtc()) return
    const startX = e.clientX
    let moved = false
    let latestT = timeRef.current
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return
      moved = true
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect) return
      latestT = scrubRulerFromClientX(ev.clientX, rect.left)
    }
    trackScrub(onMove, () => {
      if (moved) previewTimelineAt(latestT)
    })
  }

  const startRulerScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (followsLtc()) return
    const el = e.currentTarget
    let latestT = scrubRulerFromClientX(e.clientX, el.getBoundingClientRect().left)
    const onMove = (ev: PointerEvent) => {
      latestT = scrubRulerFromClientX(ev.clientX, el.getBoundingClientRect().left)
    }
    trackScrub(onMove, () => previewTimelineAt(latestT))
  }

  const startClipDrag = (
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: 'move' | 'trim-left' | 'trim-right',
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const isMultiMove = mode === 'move' && selectedClipIds.length > 1 && selectedClipIds.includes(clip.id)
    if (!isMultiMove) {
      selectTimelineClip(clip.id)
    }
    clipDraggedRef.current = false
    const startX = e.clientX
    const origStart = clip.startTime
    const origDur = clip.duration
    const origKfs = clip.keyframes
    const origStarts = isMultiMove
      ? new Map(clipsRef.current.filter((c) => selectedClipIds.includes(c.id)).map((c) => [c.id, c.startTime]))
      : null
    const multiDragKey = isMultiMove ? `clip-multi-move-${Date.now()}` : ''

    const updateTooltip = (ev: PointerEvent, text: string) => {
      const container = tracksContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setDragTimeTip({
        x: Math.max(174, ev.clientX - rect.left + 10),
        y: Math.max(28, ev.clientY - rect.top - 26),
        text,
      })
    }

    const onMove = (ev: PointerEvent) => {
      if (!clipDraggedRef.current && Math.abs(ev.clientX - startX) < 3) return
      clipDraggedRef.current = true
      const dxSec = (ev.clientX - startX) / pxPerSec
      const activeSnapFps = snapToFrame && !ev.altKey ? fps : undefined
      if (isMultiMove && origStarts) {
        const appliedDelta = moveSelectedClipsByDelta(origStarts, dxSec, multiDragKey, activeSnapFps)
        if (appliedDelta !== null) {
          const nextS = Math.max(0, origStart + appliedDelta)
          const sign = appliedDelta >= 0 ? '+' : ''
          updateTooltip(
            ev,
            `${formatTimelineTc(nextS)} · ${nextS.toFixed(2)}s → ${(nextS + origDur).toFixed(2)}s (${sign}${appliedDelta.toFixed(2)}s)`,
          )
        }
        return
      }
      const sameModClips = clipsRef.current.filter((c) => c.moduleId === clip.moduleId)
      if (mode === 'move') {
        const nextStart = resolveClipStartNoOverlap(sameModClips, origDur, origStart + dxSec, clip.id, activeSnapFps)
        updateClip(clip.id, { startTime: nextStart }, `clip-move-${clip.id}`)
        updateTooltip(ev, `${formatTimelineTc(nextStart)} · ${nextStart.toFixed(2)}s → ${(nextStart + origDur).toFixed(2)}s`)
      } else if (mode === 'trim-right') {
        const bounds = resolveClipBoundsNoOverlap(sameModClips, clip)
        const maxDur = Number.isFinite(bounds.maxEnd)
          ? Math.max(MIN_CLIP_DUR, bounds.maxEnd - origStart)
          : Number.POSITIVE_INFINITY
        const rawEnd = origStart + origDur + dxSec
        const snappedEnd = activeSnapFps ? snapTimeToFps(rawEnd, activeSnapFps) : Number(rawEnd.toFixed(2))
        const nextDur = Math.min(maxDur, Math.max(MIN_CLIP_DUR, Number((snappedEnd - origStart).toFixed(4))))
        const ratio = nextDur / Math.max(0.01, origDur)
        const nextKfs = origKfs.map((k) => ({ ...k, offset: Number((k.offset * ratio).toFixed(4)) }))
        updateClip(clip.id, { duration: nextDur, keyframes: nextKfs }, `clip-trim-${clip.id}`)
        updateTooltip(
          ev,
          `${formatTimelineTc(origStart + nextDur)} · ${origStart.toFixed(2)}s → ${(origStart + nextDur).toFixed(2)}s (${nextDur.toFixed(2)}s)`,
        )
      } else {
        const bounds = resolveClipBoundsNoOverlap(sameModClips, clip)
        const origEnd = origStart + origDur
        const rawStart = origStart + dxSec
        const snappedStart = activeSnapFps ? snapTimeToFps(rawStart, activeSnapFps) : Number(rawStart.toFixed(2))
        const nextStart = Number(
          Math.max(bounds.minStart, Math.min(origEnd - MIN_CLIP_DUR, snappedStart)).toFixed(4),
        )
        const nextDur = Number(Math.max(MIN_CLIP_DUR, origEnd - nextStart).toFixed(4))
        const ratio = nextDur / Math.max(0.01, origDur)
        const nextKfs = origKfs.map((k) => ({ ...k, offset: Number((k.offset * ratio).toFixed(4)) }))
        updateClip(clip.id, { startTime: nextStart, duration: nextDur, keyframes: nextKfs }, `clip-trim-${clip.id}`)
        updateTooltip(
          ev,
          `${formatTimelineTc(nextStart)} · ${nextStart.toFixed(2)}s → ${(nextStart + nextDur).toFixed(2)}s (${nextDur.toFixed(2)}s)`,
        )
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDragTimeTip(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const startKeyframeDrag = (
    e: React.PointerEvent,
    clip: TimelineClip,
    mod: ModuleCfg | undefined,
    kfId: string,
    widthPx: number,
    heightPx: number,
  ) => {
    e.stopPropagation()
    e.preventDefault()
    selectTimelineClip(clip.id, kfId)
    const svgEl = e.currentTarget.closest('svg')
    if (!svgEl) return

    const minH = mod?.minHeight ?? 0
    const maxH = Math.max(minH + 0.1, mod?.maxHeight ?? mod?.length ?? 1)
    const usableW = Math.max(4, widthPx - DOT_PAD_X * 2)
    const usableH = Math.max(4, heightPx - DOT_PAD_Y * 2)
    const baseKfs = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
    const baseIdx = baseKfs.findIndex((k) => k.id === kfId)
    const isFirst = baseIdx === 0
    const isLast = baseIdx === baseKfs.length - 1
    const syncEdge = isFirst ? 'start' : isLast ? 'end' : undefined

    const applyPointer = (clientX: number, clientY: number) => {
      const rect = svgEl.getBoundingClientRect()
      const localX = clamp((clientX - rect.left) * (widthPx / Math.max(1, rect.width)), DOT_PAD_X, widthPx - DOT_PAD_X)
      const localY = clamp((clientY - rect.top) * (heightPx / Math.max(1, rect.height)), DOT_PAD_Y, heightPx - DOT_PAD_Y)

      const tNorm = clamp((localX - DOT_PAD_X) / usableW, 0, 1)
      const hNorm = clamp(1 - (localY - DOT_PAD_Y) / usableH, 0, 1)

      const rawAbs = clip.startTime + tNorm * clip.duration
      const snappedOff = snapToFrame
        ? Number((snapTimeToFps(rawAbs, fps) - clip.startTime).toFixed(4))
        : Number((tNorm * clip.duration).toFixed(2))
      const nextOffset = isFirst
        ? 0
        : isLast
          ? clip.duration
          : clamp(snappedOff, 0.05, Math.max(0.05, clip.duration - 0.05))
      const nextHeight = Number((minH + hNorm * (maxH - minH)).toFixed(2))

      const nextKfs = baseKfs
        .map((k) => (k.id === kfId ? { ...k, offset: nextOffset, height: nextHeight } : k))
        .sort((a, b) => a.offset - b.offset)

      updateClip(clip.id, { keyframes: nextKfs }, `kf-drag-${kfId}`, syncEdge)
    }

    const onMove = (ev: PointerEvent) => applyPointer(ev.clientX, ev.clientY)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const createDefaultWaveClip = (mod: ModuleCfg, layerId: string, startSec: number) => {
    const clipId = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
    const dur = 4
    const keyframes = buildCurveKeyframes('flat', dur, mod.minHeight, mod.maxHeight)
    const clip: TimelineClip = {
      id: clipId,
      layerId,
      moduleId: mod.id,
      startTime: Math.max(0, Number(startSec.toFixed(4))),
      duration: dur,
      curveMode: 'smooth',
      autoSpeedLimitCms: DEFAULT_MOTION_SPEED_CMS,
      keyframes,
    }
    addClip(clip)
    setSelectedKeyId(keyframes[1]?.id ?? keyframes[0]?.id ?? null)
    notify(`Đã tạo sóng mặc định (0 → 0) cho "${mod.name}" tại ${startSec.toFixed(2)}s`, 'info')
  }

  const handleDropModule = (e: React.DragEvent, layerId: string, targetMod?: ModuleCfg) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverTarget(null)
    const modId = e.dataTransfer.getData('application/x-gauze-module') || e.dataTransfer.getData('text/plain')
    const mod = targetMod ?? project.modules.find((m) => m.id === modId)
    if (!mod) return

    const rect = e.currentTarget.getBoundingClientRect()
    const dropSec = quantizeTime((e.clientX - rect.left) / pxPerSec)
    createDefaultWaveClip(mod, layerId, dropSec)
  }

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null
  const selectedClipMod = selectedClip ? project.modules.find((m) => m.id === selectedClip.moduleId) : undefined

  const addKeyframeToSelected = () => {
    if (!selectedClip || !selectedClipMod) return
    const rel = clamp(
      Number((time - selectedClip.startTime).toFixed(4)),
      0,
      Math.max(selectedClip.duration, time - selectedClip.startTime),
    )
    const nextDur = Math.max(selectedClip.duration, rel)
    const curHeight = Number(
      clamp(
        snapshot?.modules[selectedClipMod.id]?.pos ?? selectedClipMod.minHeight,
        selectedClipMod.minHeight,
        selectedClipMod.maxHeight,
      ).toFixed(2),
    )
    const kfId = `kf-${Date.now()}`
    const kfs = [...selectedClip.keyframes, { id: kfId, offset: rel, height: curHeight }].sort(
      (a, b) => a.offset - b.offset,
    )
    updateClip(selectedClip.id, { duration: nextDur, keyframes: kfs })
    setSelectedKeyId(kfId)
  }

  const insertKeyframeAtDoubleClick = (
    e: React.MouseEvent<SVGSVGElement>,
    clip: TimelineClip,
    mod: ModuleCfg | undefined,
    widthPx: number,
    heightPx: number,
  ) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const localX = clamp((e.clientX - rect.left) * (widthPx / Math.max(1, rect.width)), DOT_PAD_X, widthPx - DOT_PAD_X)
    const localY = clamp((e.clientY - rect.top) * (heightPx / Math.max(1, rect.height)), DOT_PAD_Y, heightPx - DOT_PAD_Y)
    const minH = mod?.minHeight ?? 0
    const maxH = Math.max(minH + 0.1, mod?.maxHeight ?? mod?.length ?? 1)
    const usableW = Math.max(4, widthPx - DOT_PAD_X * 2)
    const usableH = Math.max(4, heightPx - DOT_PAD_Y * 2)
    const tNorm = clamp((localX - DOT_PAD_X) / usableW, 0, 1)
    const hNorm = clamp(1 - (localY - DOT_PAD_Y) / usableH, 0, 1)
    const kfId = `kf-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`
    const nextKf: ClipKeyframe = {
      id: kfId,
      offset: clamp(
        snapToFrame
          ? Number((snapTimeToFps(clip.startTime + tNorm * clip.duration, fps) - clip.startTime).toFixed(4))
          : Number((tNorm * clip.duration).toFixed(2)),
        0,
        clip.duration,
      ),
      height: Number((minH + hNorm * (maxH - minH)).toFixed(2)),
    }
    const kfs = [...clip.keyframes, nextKf].sort((a, b) => a.offset - b.offset)
    selectTimelineClip(clip.id)
    updateClip(clip.id, { keyframes: kfs })
    setSelectedKeyId(kfId)
  }

  const startMarqueeSelect = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 2) return
    const container = tracksContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const startX = e.clientX - rect.left
    const startY = e.clientY - rect.top
    if (startX < 168) return

    e.preventDefault()
    marqueeCleanupRef.current?.()
    marqueeDraggedRef.current = false
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    let lastClientX = e.clientX
    let lastClientY = e.clientY
    let autoScrollRaf = 0
    let active = true

    const computeHits = (curX: number, curY: number) => {
      const cRect = container.getBoundingClientRect()
      const els = container.querySelectorAll<HTMLElement>('[data-clip-id]')
      const clipRects = Array.from(els).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.dataset.clipId!,
          left: r.left - cRect.left,
          top: r.top - cRect.top,
          right: r.right - cRect.left,
          bottom: r.bottom - cRect.top,
        }
      })
      return computeMarqueeSelectedClipIds(clipRects, { x1: startX, y1: startY, x2: curX, y2: curY })
    }

    const updateFromClient = (clientX: number, clientY: number) => {
      const cRect = container.getBoundingClientRect()
      const curX = Math.max(168, clientX - cRect.left)
      const curY = Math.max(0, clientY - cRect.top)
      if (!marqueeDraggedRef.current && Math.hypot(curX - startX, curY - startY) < 4) return
      marqueeDraggedRef.current = true
      setMarquee({
        x: Math.min(startX, curX),
        y: Math.min(startY, curY),
        w: Math.abs(curX - startX),
        h: Math.abs(curY - startY),
      })
      selectTimelineClips(computeHits(curX, curY), { additive })
    }

    const stepAutoScroll = () => {
      if (!active) return
      const scrollEl = tracksScrollRef.current
      if (scrollEl && marqueeDraggedRef.current) {
        const sRect = scrollEl.getBoundingClientRect()
        const edge = 28
        const topZone = sRect.top + 24 + edge
        const bottomZone = sRect.bottom - edge
        let dy = 0
        if (lastClientY > bottomZone) {
          dy = Math.min(14, Math.max(3, Math.round((lastClientY - bottomZone) * 0.4)))
        } else if (lastClientY < topZone) {
          dy = -Math.min(14, Math.max(3, Math.round((topZone - lastClientY) * 0.4)))
        }
        if (dy !== 0) {
          const prevTop = scrollEl.scrollTop
          scrollEl.scrollTop = Math.max(0, Math.min(scrollEl.scrollHeight - scrollEl.clientHeight, prevTop + dy))
          if (scrollEl.scrollTop !== prevTop) {
            updateFromClient(lastClientX, lastClientY)
          }
        }
      }
      autoScrollRaf = requestAnimationFrame(stepAutoScroll)
    }

    const onMove = (ev: PointerEvent) => {
      lastClientX = ev.clientX
      lastClientY = ev.clientY
      updateFromClient(ev.clientX, ev.clientY)
      if (!autoScrollRaf && marqueeDraggedRef.current) {
        autoScrollRaf = requestAnimationFrame(stepAutoScroll)
      }
    }

    const stopLoop = () => {
      active = false
      if (autoScrollRaf) {
        cancelAnimationFrame(autoScrollRaf)
        autoScrollRaf = 0
      }
    }

    const finish = (ev?: PointerEvent) => {
      stopLoop()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      marqueeCleanupRef.current = null
      if (ev && marqueeDraggedRef.current) {
        updateFromClient(ev.clientX, ev.clientY)
      }
      setMarquee(null)
    }
    const onUp = (ev: PointerEvent) => finish(ev)
    const onCancel = () => {
      marqueeDraggedRef.current = false
      finish()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    marqueeCleanupRef.current = () => {
      stopLoop()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setMarquee(null)
    }
  }

  const timelineWidth = Math.ceil(maxTime * pxPerSec)
  const playheadX = Math.min(time, maxTime) * pxPerSec
  const ticks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, i) => i)

  const isLtcLive = ltcActive && (ltcStatus === 'lock' || ltcStatus === 'freewheel')
  const sequenceEnd = Math.max(
    project.settings.timeline.startTime,
    0,
    ...clips.map((c) => c.startTime + c.duration),
    ...project.keys.map((k) => k.time),
  )
  const cueTimes = [
    ...new Set([0, ...clips.map((c) => c.startTime), ...project.keys.map((k) => k.time), sequenceEnd]),
  ].sort((a, b) => a - b)

  const togglePlay = () => {
    if (followsLtc()) return
    if (localTransportRef.current === 'local') {
      localTransportRef.current = 'idle'
      setPlaying(false)
      linearPlannerRef.current.reset()
      holdTimelineTargets()
      return
    }
    if (snapshot?.locked) {
      notify('Đang khoá an toàn — bấm "Đang khoá" để mở khoá và chạy mô phỏng rèm', 'warn')
    }
    if (time >= maxTime - 0.05) {
      timeRef.current = project.settings.timeline.startTime
      setTime(project.settings.timeline.startTime)
    }
    localTransportRef.current = 'local'
    playbackLastTickRef.current = performance.now()
    linearPlannerRef.current.reset()
    dispatchTimelineFollow(timeRef.current, 0.06)
    setPlaying(true)
  }

  return (
    <div className="timeline-editor flex h-full min-w-0 flex-col gap-2 text-xs">
      <div className="timeline-heading">
        {modeTabs}
        <div className="timeline-timecode" aria-label="Timecode hiện tại">
          <button
            type="button"
            aria-label={ltcActive ? 'Tắt nhận LTC' : 'Bật nhận LTC'}
            aria-pressed={ltcActive}
            onClick={() => setLtcActive(!followsLtc())}
            title={
              !ltcActive
                ? ltcMatched
                  ? 'Bấm để đồng bộ với bộ Timecode ngoài (LTC)'
                  : `Bấm để đồng bộ LTC (Timeline ${storedFps} fps sẽ theo LTC ${effectiveLtcFps} fps)`
                : isLtcLive
                  ? 'Đang kết nối bộ Timecode ngoài (Live) · Bấm để ngắt đồng bộ'
                  : 'Không kết nối được bộ Timecode ngoài · Bấm để tắt đồng bộ'
            }
            className={`inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition ${
              !ltcActive
                ? 'bg-white/[0.06] text-[#D2C2B3] hover:bg-white/[0.12] hover:text-fg'
                : isLtcLive
                  ? 'bg-ok/15 text-ok shadow-[inset_0_0_0_1px_rgba(127,221,168,0.38)]'
                  : 'bg-danger/15 text-danger shadow-[inset_0_0_0_1px_rgba(255,125,110,0.38)]'
            }`}
          >
            {!ltcActive ? (
              <>
                <Clock size={12} />
                <span>Timecode</span>
              </>
            ) : isLtcLive ? (
              <>
                <span className="size-2 rounded-full bg-ok shadow-[0_0_6px_rgba(127,221,168,0.85)]" />
                <span>Live</span>
              </>
            ) : (
              <>
                <WifiOff size={12} />
                <span>Mất kết nối</span>
              </>
            )}
          </button>

          {!ltcActive && !ltcMatched && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true, 'ltc')}
              title={`LTC chuẩn chỉ 24/25/29.97/30 fps (không hỗ trợ ${storedFps} fps). Khi bật, Timeline sẽ theo LTC ${effectiveLtcFps} fps.`}
              className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-full bg-warn/15 px-2 text-[10px] font-medium text-warn shadow-[inset_0_0_0_1px_rgba(255,203,114,0.35)]"
            >
              <AlertTriangle size={10} />
              <span>LTC {effectiveLtcFps}fps</span>
            </button>
          )}

          <output className="kiln-readout">{formatTimelineTc(time)}</output>

          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'ltc')}
            title="Cài đặt Timecode (LTC)"
            aria-label="Cài đặt Timecode"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-white/[0.06] text-muted transition hover:bg-white/[0.12] hover:text-[#FFB26B]"
          >
            <Settings size={12} />
          </button>
        </div>
      </div>

      <div className="timeline-toolbar">
        <div className="timeline-transport">
          <button
            type="button"
            className="timeline-icon"
            title={ltcActive ? FOLLOWING_LTC : 'Về timecode bắt đầu'}
            aria-label="Về timecode bắt đầu"
            disabled={ltcActive}
            onClick={() => {
              if (followsLtc()) return
              localTransportRef.current = 'idle'
              setPlaying(false)
              seekTo(project.settings.timeline.startTime)
            }}
          >
            <SkipBack size={13} />
          </button>
          <button
            type="button"
            className="timeline-icon"
            title={ltcActive ? FOLLOWING_LTC : 'Mốc trước'}
            aria-label="Mốc trước"
            disabled={ltcActive}
            onClick={() => seekTo([...cueTimes].reverse().find((t) => t < time - 0.01) ?? 0)}
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            className="timeline-play"
            title={ltcActive ? FOLLOWING_LTC : playing ? 'Tạm dừng' : 'Phát'}
            aria-label={playing ? 'Tạm dừng' : 'Phát'}
            disabled={ltcActive}
            onClick={togglePlay}
          >
            {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <button
            type="button"
            className="timeline-icon"
            title={ltcActive ? FOLLOWING_LTC : 'Mốc tiếp theo'}
            aria-label="Mốc tiếp theo"
            disabled={ltcActive}
            onClick={() => seekTo(cueTimes.find((t) => t > time + 0.01) ?? sequenceEnd)}
          >
            <ChevronRight size={13} />
          </button>
          <button
            type="button"
            className="timeline-icon"
            title={ltcActive ? FOLLOWING_LTC : 'Về cuối sóng'}
            aria-label="Về cuối sóng"
            disabled={ltcActive}
            onClick={() => {
              if (followsLtc()) return
              localTransportRef.current = 'idle'
              setPlaying(false)
              seekTo(sequenceEnd)
            }}
          >
            <SkipForward size={13} />
          </button>
        </div>

        <div className="timeline-position">
          <span>{formatTimelineTc(time)}</span>
          <span className="text-muted">/</span>
          <span>{formatTimelineTc(sequenceEnd)}</span>
        </div>

        <div className="timeline-tools">
          {unfeasibleIssues.length > 0 && (
            <button
              type="button"
              className="timeline-issue"
              title={`${unfeasibleIssues.length} đoạn vượt tốc độ tối đa — bấm để xem`}
              aria-label={`${unfeasibleIssues.length} đoạn vượt tốc độ tối đa`}
              onClick={() => {
                selectTimelineClip(unfeasibleIssues[0].clipId)
                seekTo(unfeasibleIssues[0].fromTime)
              }}
            >
              <AlertTriangle size={13} />
              <span>{unfeasibleIssues.length}</span>
            </button>
          )}

          <button
            type="button"
            className="timeline-icon"
            title="Thu nhỏ timeline"
            aria-label="Thu nhỏ timeline"
            onClick={() => setPxPerSec((z) => Math.max(28, z - 12))}
          >
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            className="timeline-icon"
            title="Phóng to timeline"
            aria-label="Phóng to timeline"
            onClick={() => setPxPerSec((z) => Math.min(150, z + 12))}
          >
            <ZoomIn size={13} />
          </button>

          <button
            type="button"
            onClick={() => setSnapToFrame((v) => !v)}
            aria-pressed={snapToFrame}
            title={
              snapToFrame
                ? `Đang bật Snap theo khung hình (${fps} fps) · Giữ Alt khi kéo để bỏ qua tạm thời`
                : 'Đang tắt Snap theo khung hình · Bấm để bật'
            }
            className={`kiln-btn h-7 px-2 text-[10.5px] ${
              snapToFrame
                ? 'bg-brand/20 text-[#FFB26B] shadow-[inset_0_0_0_1px_rgba(247,132,46,.38)]'
                : 'text-muted'
            }`}
          >
            <Magnet size={12} />
            <span>Snap</span>
          </button>

          <select
            aria-label="Tốc độ khung hình"
            value={fps}
            disabled={ltcActive}
            title={ltcActive ? `Đang link theo LTC: ${fps} fps` : undefined}
            onChange={(e) => updateTimelineSettings({ fps: Number(e.target.value) as Fps })}
            className="timeline-fps kiln-field h-7 px-2 text-[11px] disabled:cursor-default"
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>

          {selectedClip && (
            <button
              type="button"
              onClick={addKeyframeToSelected}
              title="Thêm Point tại Playhead"
              aria-label="Thêm Point tại Playhead"
              className="kiln-btn kiln-btn-cue h-7 px-2.5 text-[11px]"
            >
              <Plus size={12} />
              Point
            </button>
          )}
        </div>
      </div>

      {/* Khung NLE Waveform đồng bộ cuộn dọc & ngang */}
      <div
        ref={tracksScrollRef}
        className="timeline-tracks min-h-0 min-w-0 flex-1 overflow-auto rounded-xl bg-[#0A0706] shadow-[inset_0_0_0_1px_var(--line)]"
      >
        <div
          ref={tracksContainerRef}
          onPointerDown={startMarqueeSelect}
          onContextMenu={(e) => {
            if (marqueeDraggedRef.current) {
              e.preventDefault()
              marqueeDraggedRef.current = false
            }
          }}
          style={{ width: 168 + timelineWidth }}
          className="relative min-h-full select-none"
        >
          {/* Header Top Sticky: Corner + Time Ruler */}
          <div className="sticky top-0 z-30 flex h-6 border-b border-line bg-[#130D0A]">
            <div className="sticky left-0 z-30 flex w-[168px] shrink-0 items-center justify-between border-r border-line bg-[#130D0A] px-2.5 text-[10px] font-semibold tracking-wider text-muted uppercase">
              <span>Layer / Module</span>
              <span className="text-[9px] opacity-75">Wave</span>
            </div>
            <div
              ref={rulerRef}
              onPointerDown={startRulerScrub}
              title={ltcActive ? FOLLOWING_LTC : undefined}
              style={{ width: timelineWidth }}
              className="relative h-6 cursor-ew-resize select-none"
            >
              <div
                role={editingHead ? undefined : 'button'}
                aria-disabled={ltcActive || undefined}
                tabIndex={editingHead || ltcActive ? undefined : 0}
                aria-label={editingHead ? undefined : `Thời gian playhead ${time.toFixed(2)}s, double-click để nhập số`}
                onPointerDown={startHeadOrScrub}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (followsLtc()) return
                  headCanceledRef.current = false
                  setHeadInput(time.toFixed(2))
                  setEditingHead(true)
                }}
                onKeyDown={(e) => {
                  if (!followsLtc() && !editingHead && (e.key === 'Enter' || e.key === 'F2')) {
                    e.preventDefault()
                    headCanceledRef.current = false
                    setHeadInput(time.toFixed(2))
                    setEditingHead(true)
                  }
                }}
                title={time > maxTime ? `${formatTimelineTc(time)} · ngoài vùng dựng` : ltcActive ? FOLLOWING_LTC : 'Kéo để tua · Double-click để nhập số giây'}
                className={`timeline-ruler-marker ${editingHead ? 'editing' : ''}`}
                style={{ left: editingHead ? Math.max(28, playheadX) : playheadX }}
              >
                {editingHead ? (
                  <input
                    autoFocus
                    aria-label="Nhập thời gian playhead (s)"
                    value={headInput}
                    onFocus={(e) => e.currentTarget.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setHeadInput(e.target.value)}
                    onBlur={commitHeadInput}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitHeadInput()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        headCanceledRef.current = true
                        setEditingHead(false)
                      }
                    }}
                    className="w-12 bg-transparent text-center text-[10px] leading-none font-semibold text-[#172438] tabular-nums outline-none"
                  />
                ) : (
                  `${time.toFixed(2)}s`
                )}
              </div>
              {ticks.map((sec) => (
                <div
                  key={sec}
                  style={{ left: sec * pxPerSec }}
                  className="absolute bottom-0 flex flex-col items-start border-l border-line pl-1 text-[10px] text-muted tabular-nums"
                >
                  {sec}s
                </div>
              ))}
            </div>
          </div>

          {/* Các Layer & dòng Module con */}
          {project.layers.map((layer) => {
            const mods = project.modules.filter((m) => m.layerId === layer.id)
            const collapsed = Boolean(collapsedLayers[layer.id])
            const isLayerSel = selectedTimelineLayerId === layer.id
            const layerClips = clips.filter((c) => c.layerId === layer.id)

            return (
              <div key={layer.id}>
                {/* Hàng Layer */}
                <div className="flex border-b border-line">
                  <div
                    className={`sticky left-0 z-20 flex w-[168px] shrink-0 items-center justify-between border-r border-line px-2 transition ${
                      collapsed ? 'h-14' : 'h-6'
                    } ${isLayerSel ? 'bg-[#281A10] text-[#FFB26B]' : 'bg-[#150F0B] text-fg'}`}
                  >
                    <button
                      type="button"
                      onClick={() => setCollapsedLayers((s) => ({ ...s, [layer.id]: !s[layer.id] }))}
                      title={collapsed ? 'Mở rộng các dòng module' : 'Thu gọn thành đồ thị tổng hợp'}
                      className="cursor-pointer rounded-full p-0.5 text-muted hover:bg-white/10 hover:text-fg"
                    >
                      {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => selectTimelineLayer(layer.id)}
                      title="Chọn Layer track (Ctrl+C, Ctrl+V, Delete)"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-1 text-left text-[11px] font-semibold"
                    >
                      <Layers size={12} className={`shrink-0 ${isLayerSel ? 'text-brand' : 'text-info'}`} />
                      <span className="truncate">{layer.name}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted">({mods.length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleLayerSync(layer.id)
                      }}
                      title={layer.syncLayer ? 'Đang bật Sync Layer — Bấm để tắt' : 'Bật Sync Layer để các module chạy giống nhau'}
                      className={`ml-1 inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-full px-1.5 text-[9.5px] font-semibold transition ${
                        layer.syncLayer
                          ? 'bg-brand/25 text-[#FFB26B] shadow-[inset_0_0_0_1px_rgba(247,132,46,.45)]'
                          : 'text-muted hover:bg-white/10 hover:text-fg'
                      }`}
                    >
                      <Link2 size={10} />
                      {layer.syncLayer ? 'Sync' : ''}
                    </button>
                  </div>

                  {/* Vùng track của Layer (khi thu gọn hiện overlay đa đường sóng như mẫu) */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOverTarget(`layer:${layer.id}`)
                    }}
                    onDragLeave={() => setDragOverTarget(null)}
                    onDrop={(e) => handleDropModule(e, layer.id)}
                    onClick={() => selectTimelineLayer(layer.id)}
                    style={{ width: timelineWidth }}
                    className={`relative transition ${collapsed ? 'h-14' : 'h-6'} ${
                      dragOverTarget === `layer:${layer.id}`
                        ? 'bg-brand/15 shadow-[inset_0_0_0_1px_var(--acc)]'
                        : isLayerSel
                          ? 'bg-brand/[0.04]'
                          : 'bg-[#0E0A08]'
                    }`}
                  >
                    {ticks.map((sec) => (
                      <div
                        key={sec}
                        style={{ left: sec * pxPerSec }}
                        className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-white/[0.05]"
                      />
                    ))}

                    {collapsed ? (
                      <>
                        {/* Lưới ngang đứt nét cho chế độ thu gọn đa sóng */}
                        <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-dashed border-white/[0.06]" />
                        <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-dashed border-white/[0.06]" />

                        {layerClips.length === 0 ? (
                          <div className="pointer-events-none flex h-full items-center pl-3 text-[10.5px] text-muted/65">
                            Mở rộng layer để vẽ sóng từng module...
                          </div>
                        ) : (
                          <>
                            {mods.map((mod, modIdx) => {
                              const mClips = layerClips.filter((c) => c.moduleId === mod.id)
                              if (mClips.length === 0) return null
                              const color = CURVE_COLORS[modIdx % CURVE_COLORS.length]
                              const minH = mod.minHeight
                              const maxH = Math.max(minH + 0.1, mod.maxHeight ?? mod.length)
                              const segs = buildTrackConnectorSegments(
                                mClips,
                                minH,
                                maxH,
                                pxPerSec,
                                timelineWidth,
                                56,
                                4,
                                8,
                              )
                              return (
                                <svg
                                  key={`line-${mod.id}`}
                                  width={timelineWidth}
                                  height={56}
                                  viewBox={`0 0 ${timelineWidth} 56`}
                                  className="pointer-events-none absolute inset-0"
                                >
                                  {segs.map(([x1, y1, x2, y2], sIdx) => (
                                    <line
                                      key={sIdx}
                                      x1={x1}
                                      y1={y1}
                                      x2={x2}
                                      y2={y2}
                                      stroke={color}
                                      strokeWidth={1.5}
                                      strokeOpacity={0.55}
                                    />
                                  ))}
                                </svg>
                              )
                            })}
                            {layerClips.map((clip) => {
                            const modIdx = Math.max(
                              0,
                              mods.findIndex((m) => m.id === clip.moduleId),
                            )
                            const mod = mods[modIdx]
                            const color = CURVE_COLORS[modIdx % CURVE_COLORS.length]
                            const issues = analyzeClipSpeeds(clip, mod)
                            const hasBad = issues.some((i) => !i.feasible)
                            const stroke = hasBad ? '#FF7D6E' : color
                            const w = Math.max(CLIP_MIN_W, clip.duration * pxPerSec)
                            const h = 56
                            const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
                            const minH = mod?.minHeight ?? 0
                            const maxH = Math.max(minH + 0.1, mod?.maxHeight ?? mod?.length ?? 1)
                            const pts = mapKeyframesToPts(sorted, clip.duration, minH, maxH, w, h, 4, 8)
                            const d = fullCurvePath(pts, clip.curveMode ?? 'smooth', 6, h - 6)

                            return (
                              <svg
                                key={clip.id}
                                width={w}
                                height={h}
                                viewBox={`0 0 ${w} ${h}`}
                                style={{ left: clip.startTime * pxPerSec }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  selectTimelineClip(clip.id)
                                }}
                                className="absolute top-0 cursor-pointer overflow-visible"
                              >
                                <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeOpacity={0.9} />
                                {pts.map((p, idx) => (
                                  <circle
                                    key={sorted[idx]?.id ?? idx}
                                    cx={p.x}
                                    cy={p.y}
                                    r={3}
                                    fill={stroke}
                                    stroke="#FBF3EA"
                                    strokeWidth={1.3}
                                  />
                                ))}
                              </svg>
                            )
                          })}
                          </>
                        )}
                      </>
                    ) : (
                      <div className="pointer-events-none flex h-full items-center px-3 text-[10px] text-muted/70">
                        {layerClips.length > 0
                          ? `${layerClips.length} sóng trên ${mods.length} module`
                          : 'Kéo thả module hoặc tạo sóng ở từng dòng bên dưới'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Các dòng Module con khi Layer mở rộng */}
                {!collapsed &&
                  mods.map((mod, modIdx) => {
                    const modClips = clips.filter((c) => c.moduleId === mod.id)
                    const seriesColor = CURVE_COLORS[modIdx % CURVE_COLORS.length]
                    const [chStart, chEnd] = addressRange(mod.startAddress)
                    const dropId = `mod:${mod.id}`
                    const isModSelected = selectedIds.includes(mod.id)

                    return (
                      <div key={mod.id} className="flex border-b border-white/[0.06]">
                        {/* Nhãn Module bên trái (khung bo tròn 4 góc nằm trong ô sticky) */}
                        <div className="sticky left-0 z-20 flex h-14 w-[168px] shrink-0 items-center border-r border-line bg-[#0D0907] p-1">
                          <div
                            onClick={(e) => selectModule(mod.id, { multi: e.metaKey || e.ctrlKey, range: e.shiftKey })}
                            title={`Chọn ${mod.name} (Ctrl/Shift để chọn nhiều)`}
                            className={`timeline-module relative flex h-full w-full cursor-pointer items-center justify-between gap-1.5 overflow-hidden rounded-xl pr-2 pl-3.5 transition ${
                              isModSelected
                                ? 'bg-[#2B1A0E] shadow-[inset_0_0_0_1px_rgba(247,132,46,0.45)]'
                                : 'bg-[#17110C] shadow-[inset_0_0_0_1px_rgba(255,206,160,0.08)] hover:bg-[#1E1610]'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  style={{ backgroundColor: isModSelected ? '#F7842E' : seriesColor }}
                                  className="timeline-module-stripe"
                                />
                                <span
                                  className={`truncate text-[11px] font-medium ${
                                    isModSelected ? 'text-[#FFB26B]' : 'text-[#D2C2B3]'
                                  }`}
                                >
                                  {mod.name}
                                </span>
                              </div>
                              <div
                                className={`mt-0.5 flex items-center gap-1 text-[9.5px] tabular-nums ${
                                  isModSelected ? 'text-[#D4A47C]' : 'text-[#8A7766]'
                                }`}
                              >
                                <span>
                                  CH {chStart}–{chEnd}
                                </span>
                                <span>·</span>
                                <span>
                                  {mod.minHeight.toFixed(1)}–{mod.maxHeight.toFixed(1)}m
                                </span>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                createDefaultWaveClip(mod, layer.id, modClips.length ? time : 0)
                              }}
                              title={`Tạo đường sóng mới (mặc định 0 → 0) cho ${mod.name}`}
                              className={`flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition ${
                                isModSelected
                                  ? 'bg-[linear-gradient(135deg,#FFC590_0%,#FF9442_50%,#F0701B_100%)] text-[#1C0E04] shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] hover:brightness-110'
                                  : 'bg-[#281D16] text-[#9E8A78] shadow-[inset_0_0_0_1px_rgba(255,214,170,0.12)] hover:bg-[#36261C] hover:text-[#D2C2B3]'
                              }`}
                            >
                              <Plus size={11} />
                            </button>
                          </div>
                        </div>

                        {/* Làn Waveform riêng của Module */}
                        <div
                          onDragOver={(e) => {
                            e.preventDefault()
                            setDragOverTarget(dropId)
                          }}
                          onDragLeave={() => setDragOverTarget(null)}
                          onDrop={(e) => handleDropModule(e, layer.id, mod)}
                          onDoubleClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            const dropSec = quantizeTime((e.clientX - rect.left) / pxPerSec)
                            createDefaultWaveClip(mod, layer.id, dropSec)
                          }}
                          style={{ width: timelineWidth }}
                          className={`relative h-14 transition ${
                            dragOverTarget === dropId
                              ? 'bg-brand/12 shadow-[inset_0_0_0_1px_var(--acc)]'
                              : isModSelected
                                ? 'bg-brand/[0.03]'
                                : 'bg-[#0A0706]'
                          }`}
                        >
                          {/* Lưới ngang & dọc đứt nét */}
                          <div className="pointer-events-none absolute inset-x-0 top-1/4 border-t border-dashed border-white/[0.045]" />
                          <div className="pointer-events-none absolute inset-x-0 top-2/4 border-t border-dashed border-white/[0.06]" />
                          <div className="pointer-events-none absolute inset-x-0 top-3/4 border-t border-dashed border-white/[0.045]" />

                          {ticks.map((sec) => (
                            <div
                              key={sec}
                              style={{ left: sec * pxPerSec }}
                              className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-white/[0.045]"
                            />
                          ))}

                          {/* Dòng line xuyên suốt từ đầu (0s) đến cuối timeline nối các moment của Module */}
                          {(() => {
                            const modMinH = mod.minHeight
                            const modMaxH = Math.max(modMinH + 0.1, mod.maxHeight ?? mod.length)
                            const connectorSegs = buildTrackConnectorSegments(
                              modClips,
                              modMinH,
                              modMaxH,
                              pxPerSec,
                              timelineWidth,
                              BODY_H,
                            )
                            return (
                              <svg
                                width={timelineWidth}
                                height={BODY_H}
                                viewBox={`0 0 ${timelineWidth} ${BODY_H}`}
                                className="pointer-events-none absolute top-[22px] left-0 z-[1]"
                              >
                                {connectorSegs.map(([x1, y1, x2, y2], sIdx) => (
                                  <line
                                    key={sIdx}
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                    stroke={seriesColor}
                                    strokeWidth={1.75}
                                    strokeOpacity={modClips.length > 0 ? 0.78 : 0.38}
                                  />
                                ))}
                              </svg>
                            )
                          })()}

                          {modClips.map((clip) => {
                            const issues = analyzeClipSpeeds(clip, mod)
                            const badSeg = issues.find((i) => !i.feasible)
                            const maxReq = issues.reduce((mx, i) => Math.max(mx, i.requiredCms), 0)
                            const isSelected = selectedClipId === clip.id || selectedClipIds.includes(clip.id)
                            const leftPx = clip.startTime * pxPerSec
                            const widthPx = Math.max(CLIP_MIN_W, clip.duration * pxPerSec)

                            const sortedKfs = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
                            const minH = mod.minHeight
                            const maxH = Math.max(minH + 0.1, mod.maxHeight ?? mod.length)
                            const mode = clip.curveMode ?? 'smooth'
                            const pts = mapKeyframesToPts(sortedKfs, clip.duration, minH, maxH, widthPx, BODY_H)
                            const baseStroke = isSelected ? '#F7842E' : seriesColor
                            const areaPath =
                              pts.length >= 2
                                ? `${fullCurvePath(pts, mode, DOT_PAD_Y, BODY_H - DOT_PAD_Y)} L ${pts[pts.length - 1].x.toFixed(1)} ${BODY_H} L ${pts[0].x.toFixed(1)} ${BODY_H} Z`
                                : ''
                            const handleColor = 'bg-white/90'

                            return (
                              <div
                                key={clip.id}
                                data-clip-id={clip.id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (clipDraggedRef.current) {
                                    clipDraggedRef.current = false
                                    return
                                  }
                                  selectTimelineClip(clip.id)
                                }}
                                style={{ left: leftPx, width: widthPx }}
                                className={`kiln-clip absolute top-1.5 z-[2] flex flex-col select-none ${
                                  badSeg ? 'bad' : isSelected ? 'sel' : ''
                                }`}
                              >
                                {/* Bar trên mảnh để kéo dời clip và chỉnh 2 đầu */}
                                <div
                                  onPointerDown={(e) => startClipDrag(e, clip, 'move')}
                                  title={`${mod.name} · Kéo để dời vị trí clip, kéo 2 đầu để chỉnh độ dài`}
                                  className="clip-bar flex h-[16px] shrink-0 cursor-grab items-center justify-between gap-1 px-1 text-[9.5px] font-semibold active:cursor-grabbing"
                                >
                                  <div
                                    onPointerDown={(e) => startClipDrag(e, clip, 'trim-left')}
                                    className="flex h-full w-2 shrink-0 cursor-ew-resize items-center justify-center"
                                  >
                                    <span className={`h-2.5 w-1 rounded-full ${handleColor}`} />
                                  </div>
                                  <span className="truncate tabular-nums">
                                    {badSeg
                                      ? `⚠ ${badSeg.requiredCms.toFixed(0)}cm/s`
                                      : `${clip.duration.toFixed(1)}s${maxReq > 0 ? ` · ${maxReq.toFixed(0)}cm/s` : ' · 0–0'}`}
                                  </span>
                                  <div
                                    onPointerDown={(e) => startClipDrag(e, clip, 'trim-right')}
                                    className="flex h-full w-2 shrink-0 cursor-ew-resize items-center justify-center"
                                  >
                                    <span className={`h-2.5 w-1 rounded-full ${handleColor}`} />
                                  </div>
                                </div>

                                {/* Vùng đồ thị SVG tương tác */}
                                <div className="clip-body relative h-[28px] w-full overflow-hidden">
                                  <svg
                                    width={widthPx}
                                    height={BODY_H}
                                    viewBox={`0 0 ${widthPx} ${BODY_H}`}
                                    onDoubleClick={(e) => insertKeyframeAtDoubleClick(e, clip, mod, widthPx, BODY_H)}
                                    className="block h-full w-full cursor-crosshair"
                                  >
                                    {/* Đường đứt nét tham chiếu 0m / mid */}
                                    <line
                                      x1={0}
                                      y1={BODY_H - DOT_PAD_Y}
                                      x2={widthPx}
                                      y2={BODY_H - DOT_PAD_Y}
                                      stroke="rgba(255,255,255,0.08)"
                                      strokeDasharray="3 3"
                                      strokeWidth={1}
                                    />
                                    <line
                                      x1={0}
                                      y1={BODY_H / 2}
                                      x2={widthPx}
                                      y2={BODY_H / 2}
                                      stroke="rgba(255,255,255,0.05)"
                                      strokeDasharray="3 3"
                                      strokeWidth={1}
                                    />

                                    {areaPath && (
                                      <path
                                        d={areaPath}
                                        fill={badSeg ? '#FF7D6E' : baseStroke}
                                        fillOpacity={isSelected ? 0.14 : 0.08}
                                      />
                                    )}

                                    {/* Đoạn nối mép trái/phải để đường line liền mạch ra ngoài clip */}
                                    {pts.length >= 2 && (
                                      <>
                                        <line
                                          x1={0}
                                          y1={pts[0].y}
                                          x2={pts[0].x}
                                          y2={pts[0].y}
                                          stroke={seriesColor}
                                          strokeWidth={1.75}
                                          strokeOpacity={0.78}
                                        />
                                        <line
                                          x1={pts[pts.length - 1].x}
                                          y1={pts[pts.length - 1].y}
                                          x2={widthPx}
                                          y2={pts[pts.length - 1].y}
                                          stroke={seriesColor}
                                          strokeWidth={1.75}
                                          strokeOpacity={0.78}
                                        />
                                      </>
                                    )}

                                    {/* Vẽ từng đoạn để highlight đoạn quá tốc độ */}
                                    {pts.length >= 2 &&
                                      pts.slice(0, -1).map((_, idx) => {
                                        const segIssue = issues[idx]
                                        const segBad = segIssue && !segIssue.feasible
                                        const d = segmentPath(pts, idx, mode, DOT_PAD_Y, BODY_H - DOT_PAD_Y)
                                        return (
                                          <path
                                            key={idx}
                                            d={d}
                                            fill="none"
                                            stroke={segBad ? '#FF7D6E' : baseStroke}
                                            strokeWidth={segBad ? 2.5 : isSelected ? 2.2 : 1.75}
                                            strokeLinecap="round"
                                          />
                                        )
                                      })}

                                    {/* Chấm keyframe kéo thả 2D (vẽ điểm đang chọn sau cùng để nổi bật lên trên cùng) */}
                                    {[...sortedKfs]
                                      .map((kf, idx) => ({ kf, idx, activeKf: isSelected && selectedKeyId === kf.id }))
                                      .sort((a, b) => Number(a.activeKf) - Number(b.activeKf))
                                      .map(({ kf, idx, activeKf }) => {
                                        const pt = pts[idx]
                                        if (!pt) return null
                                        const prevBad = idx > 0 && issues[idx - 1] && !issues[idx - 1].feasible
                                        const nextBad = idx < issues.length && issues[idx] && !issues[idx].feasible
                                        const dotColor = prevBad || nextBad ? '#FF7D6E' : baseStroke
                                        const tagOnLeft = pt.x > widthPx - 28
                                        const tagX = tagOnLeft ? Math.max(2, pt.x - 24) : Math.min(widthPx - 22, pt.x + 7)
                                        const tagY = pt.y > BODY_H / 2 ? Math.max(1, pt.y - 14) : Math.min(BODY_H - 12, pt.y + 3)

                                        return (
                                          <g
                                            key={kf.id}
                                            onPointerDown={(e) => startKeyframeDrag(e, clip, mod, kf.id, widthPx, BODY_H)}
                                            onContextMenu={(e) => {
                                              e.preventDefault()
                                              e.stopPropagation()
                                              if (clip.keyframes.length <= 2) {
                                                notify('Mỗi đường sóng cần giữ ít nhất 2 điểm (đầu & cuối)', 'warn')
                                                return
                                              }
                                              const nextKfs = clip.keyframes.filter((k) => k.id !== kf.id)
                                              updateClip(clip.id, { keyframes: nextKfs })
                                            }}
                                            className="cursor-grab active:cursor-grabbing"
                                          >
                                            <title>
                                              {`P${idx + 1}: ${(clip.startTime + kf.offset).toFixed(2)}s · ${heightToPercent(kf.height, mod)}% (Kéo để chỉnh · Chuột phải xoá điểm)`}
                                            </title>
                                            {activeKf && (
                                              <>
                                                <line
                                                  x1={pt.x}
                                                  y1={0}
                                                  x2={pt.x}
                                                  y2={BODY_H}
                                                  stroke="#FFCB72"
                                                  strokeWidth={1}
                                                  strokeDasharray="2 2"
                                                  strokeOpacity={0.8}
                                                />
                                                <circle cx={pt.x} cy={pt.y} r={8.5} fill="#F7842E" fillOpacity={0.32} />
                                                <circle cx={pt.x} cy={pt.y} r={6.4} fill="none" stroke="#FFCB72" strokeWidth={1.3} />
                                              </>
                                            )}
                                            <circle cx={pt.x} cy={pt.y} r={8} fill="transparent" />
                                            <circle
                                              cx={pt.x}
                                              cy={pt.y}
                                              r={activeKf ? 4.8 : 3.2}
                                              fill={activeKf ? '#FBF3EA' : dotColor}
                                              stroke={activeKf ? '#F7842E' : '#FBF3EA'}
                                              strokeWidth={activeKf ? 2 : 1.2}
                                            />
                                            {activeKf && (
                                              <g transform={`translate(${tagX}, ${tagY})`} className="pointer-events-none">
                                                <rect
                                                  width={19}
                                                  height={11}
                                                  rx={3}
                                                  fill="#1C0E04"
                                                  fillOpacity={0.92}
                                                  stroke="#FFCB72"
                                                  strokeWidth={0.9}
                                                />
                                                <text
                                                  x={9.5}
                                                  y={8}
                                                  textAnchor="middle"
                                                  fill="#FFCB72"
                                                  fontSize={7.5}
                                                  fontWeight={700}
                                                >
                                                  P{idx + 1}
                                                </text>
                                              </g>
                                            )}
                                          </g>
                                        )
                                      })}
                                  </svg>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
              </div>
            )
          })}

          {/* Vạch Playhead dọc xuyên qua toàn bộ Tracks */}
          <div
            style={{ left: 168 + playheadX }}
            className="timeline-playhead pointer-events-none absolute top-6 bottom-0 z-10 w-0.5"
          >
            <div className="timeline-playhead-tip" />
          </div>
          {marquee && (
            <div
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
              className="pointer-events-none absolute z-30 rounded-sm border border-[#F7842E] bg-[#F7842E]/15"
            />
          )}
          {dragTimeTip && (
            <div
              style={{ left: dragTimeTip.x, top: dragTimeTip.y }}
              className="pointer-events-none absolute z-40 rounded-md bg-[#1C0E04]/95 px-2 py-0.5 text-[10.5px] font-semibold text-[#FFD08A] tabular-nums shadow-[0_0_0_1px_var(--acc)]"
            >
              {dragTimeTip.text}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
