import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Layers,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { clamp } from '@shared/convert'
import { addressRange } from '@shared/dmx'
import { LtcDecoder } from '@shared/ltc'
import { FPS_OPTIONS, formatTc, parseTc, tcToSeconds } from '@shared/timecode'
import {
  CURVE_PRESETS,
  type CurvePresetId,
  TimelineRunner,
  analyzeClipSpeeds,
  analyzeTimeline,
  buildCurveKeyframes,
  resolveClipBoundsNoOverlap,
  resolveClipStartNoOverlap,
} from '@shared/timeline'
import type { ClipKeyframe, Fps, ModuleCfg, TimelineClip } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

const MIN_CLIP_DUR = 0.4
const CLIP_MIN_W = 24
const CURVE_COLORS = ['#F7842E', '#FFCB72', '#7FDDA8', '#8DB8FF', '#FF9A4D']
const BODY_H = 40
const DOT_PAD_X = 6
const DOT_PAD_Y = 7

interface Pt {
  x: number
  y: number
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

function mapKeyframesToPts(
  kfs: ClipKeyframe[],
  duration: number,
  minH: number,
  maxH: number,
  width: number,
  height: number,
  padX = DOT_PAD_X,
  padY = DOT_PAD_Y,
): Pt[] {
  const usableW = Math.max(4, width - padX * 2)
  const usableH = Math.max(4, height - padY * 2)
  const span = Math.max(0.1, maxH - minH)
  const dur = Math.max(0.01, duration)
  return kfs.map((k) => {
    const tNorm = clamp(k.offset / dur, 0, 1)
    const hNorm = clamp((k.height - minH) / span, 0, 1)
    return {
      x: padX + tNorm * usableW,
      y: padY + (1 - hNorm) * usableH,
    }
  })
}

/** Sinh path cubic Bezier mượt (Catmull-Rom có giới hạn dọc) cho từng đoạn i -> i+1 */
function segmentPath(pts: Pt[], i: number, mode: 'smooth' | 'linear', minY: number, maxY: number): string {
  const p1 = pts[i]
  const p2 = pts[i + 1]
  if (!p1 || !p2) return ''
  if (mode === 'linear' || pts.length < 3) {
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  const p0 = pts[i - 1] ?? p1
  const p3 = pts[i + 2] ?? p2
  const segMinY = Math.max(minY, Math.min(p1.y, p2.y) - 3)
  const segMaxY = Math.min(maxY, Math.max(p1.y, p2.y) + 3)

  const c1x = clamp(p1.x + (p2.x - p0.x) / 6, p1.x, p2.x)
  const c1y = clamp(p1.y + (p2.y - p0.y) / 6, segMinY, segMaxY)
  const c2x = clamp(p2.x - (p3.x - p1.x) / 6, p1.x, p2.x)
  const c2y = clamp(p2.y - (p3.y - p1.y) / 6, segMinY, segMaxY)

  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
}

function fullCurvePath(pts: Pt[], mode: 'smooth' | 'linear', minY: number, maxY: number): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = segmentPath(pts, i, mode, minY, maxY)
    const cmdStart = seg.indexOf(' L ') >= 0 ? seg.indexOf(' L ') : seg.indexOf(' C ')
    if (cmdStart >= 0) d += seg.slice(cmdStart)
  }
  return d
}

export function TimelineEditor() {
  const {
    project,
    snapshot,
    selectedClipId,
    selectedTimelineLayerId,
    selectTimelineClip,
    selectTimelineLayer,
    addClip,
    updateClip,
    deleteClip,
    updateTimelineSettings,
    sendCommand,
    notify,
  } = useAppStore()

  const fps = project.settings.timeline.fps
  const clips = useMemo(() => project.clips ?? [], [project.clips])
  const [time, setTime] = useState(project.settings.timeline.startTime)
  const [playing, setPlaying] = useState(false)
  const [ltcActive, setLtcActive] = useState(false)
  const [ltcStatus, setLtcStatus] = useState<'off' | 'lock' | 'freewheel' | 'lost'>('off')
  const [tcInput, setTcInput] = useState(formatTc(project.settings.timeline.startTime, fps))
  const [pxPerSec, setPxPerSec] = useState(64)
  const [collapsedLayers, setCollapsedLayers] = useState<Record<string, boolean>>({})
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)

  const runnerRef = useRef(new TimelineRunner())
  const timeRef = useRef(time)
  timeRef.current = time
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const keysRef = useRef(project.keys)
  keysRef.current = project.keys

  const maxTime = useMemo(
    () => Math.max(20, ...clips.map((c) => c.startTime + c.duration + 4), ...project.keys.map((k) => k.time + 4)),
    [clips, project.keys],
  )

  const allIssues = useMemo(() => analyzeTimeline(clips, project.modules), [clips, project.modules])
  const unfeasibleIssues = useMemo(() => allIssues.filter((i) => !i.feasible), [allIssues])

  useEffect(() => {
    setTcInput(formatTc(project.settings.timeline.startTime, fps))
  }, [project.settings.timeline.startTime, fps])

  useEffect(() => {
    if (!playing || ltcActive) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const next = Math.min(maxTime, timeRef.current + dt)
      setTime(next)
      const cmds = runnerRef.current.update(next, keysRef.current, clipsRef.current)
      for (const c of cmds) void sendCommand(c)
      if (next >= maxTime) setPlaying(false)
      else raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, ltcActive, maxTime, sendCommand])

  useEffect(() => {
    if (!ltcActive) {
      setLtcStatus('off')
      return
    }
    let stopped = false
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let lastFrameAt = 0

    const startLtc = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: project.settings.ltc.deviceId ? { deviceId: { exact: project.settings.ltc.deviceId } } : true,
        })
        if (stopped) return
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const proc = ctx.createScriptProcessor(2048, 2, 1)
        const dec = new LtcDecoder(
          ctx.sampleRate,
          (f) => {
            lastFrameAt = performance.now()
            setLtcStatus('lock')
            const sec = tcToSeconds(f, fps) + project.settings.ltc.offsetFrames / fps
            setTime(sec)
            const cmds = runnerRef.current.update(sec, keysRef.current, clipsRef.current)
            for (const c of cmds) void sendCommand(c)
          },
          fps === 29.97 ? 30 : fps,
        )
        proc.onaudioprocess = (ev) => {
          const chIdx = project.settings.ltc.channel === 'right' && ev.inputBuffer.numberOfChannels > 1 ? 1 : 0
          dec.push(ev.inputBuffer.getChannelData(chIdx))
        }
        src.connect(proc)
        proc.connect(ctx.destination)
        setLtcStatus('lost')
      } catch (err) {
        notify(`Không mở được ngõ âm thanh LTC: ${(err as Error).message}`, 'error')
        setLtcActive(false)
      }
    }
    void startLtc()

    const watch = setInterval(() => {
      if (!lastFrameAt) return
      const gapMs = performance.now() - lastFrameAt
      const fwMs = (project.settings.ltc.freewheelFrames / fps) * 1000
      if (gapMs > fwMs) setLtcStatus('lost')
      else if (gapMs > 80) setLtcStatus('freewheel')
    }, 80)

    return () => {
      stopped = true
      clearInterval(watch)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [ltcActive, fps, project.settings.ltc, sendCommand, notify])

  const applyStartTc = () => {
    const sec = parseTc(tcInput, fps)
    if (sec === null) {
      notify('Timecode không hợp lệ (định dạng hh:mm:ss:ff)', 'warn')
      return
    }
    updateTimelineSettings({ startTime: sec })
    runnerRef.current.reset()
    setTime(sec)
  }

  const seekTo = (t: number) => {
    runnerRef.current.reset()
    setTime(clamp(t, 0, maxTime))
  }

  const startRulerScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const updateFromClientX = (clientX: number) => {
      const rect = el.getBoundingClientRect()
      const t = (clientX - rect.left) / pxPerSec
      seekTo(Number(t.toFixed(2)))
    }
    updateFromClientX(e.clientX)
    const onMove = (ev: PointerEvent) => updateFromClientX(ev.clientX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startClipDrag = (
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: 'move' | 'trim-left' | 'trim-right',
  ) => {
    e.stopPropagation()
    selectTimelineClip(clip.id)
    const startX = e.clientX
    const origStart = clip.startTime
    const origDur = clip.duration
    const origKfs = clip.keyframes

    const onMove = (ev: PointerEvent) => {
      const dxSec = (ev.clientX - startX) / pxPerSec
      const sameModClips = clipsRef.current.filter((c) => c.moduleId === clip.moduleId)
      if (mode === 'move') {
        const nextStart = resolveClipStartNoOverlap(sameModClips, origDur, origStart + dxSec, clip.id)
        updateClip(clip.id, { startTime: nextStart }, `clip-move-${clip.id}`)
      } else if (mode === 'trim-right') {
        const bounds = resolveClipBoundsNoOverlap(sameModClips, clip)
        const maxDur = Number.isFinite(bounds.maxEnd)
          ? Math.max(MIN_CLIP_DUR, bounds.maxEnd - origStart)
          : Number.POSITIVE_INFINITY
        const nextDur = Math.min(maxDur, Math.max(MIN_CLIP_DUR, Number((origDur + dxSec).toFixed(2))))
        const ratio = nextDur / Math.max(0.01, origDur)
        const nextKfs = origKfs.map((k) => ({ ...k, offset: Number((k.offset * ratio).toFixed(2)) }))
        updateClip(clip.id, { duration: nextDur, keyframes: nextKfs }, `clip-trim-${clip.id}`)
      } else {
        const bounds = resolveClipBoundsNoOverlap(sameModClips, clip)
        const minShift = bounds.minStart - origStart
        const maxShift = origDur - MIN_CLIP_DUR
        const clampedShift = Math.max(minShift, Math.min(maxShift, dxSec))
        const nextStart = Number((origStart + clampedShift).toFixed(2))
        const nextDur = Number((origDur - clampedShift).toFixed(2))
        const ratio = nextDur / Math.max(0.01, origDur)
        const nextKfs = origKfs.map((k) => ({ ...k, offset: Number((k.offset * ratio).toFixed(2)) }))
        updateClip(clip.id, { startTime: nextStart, duration: nextDur, keyframes: nextKfs }, `clip-trim-${clip.id}`)
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
    selectTimelineClip(clip.id)
    setSelectedKeyId(kfId)
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

      const nextOffset = isFirst
        ? 0
        : isLast
          ? clip.duration
          : clamp(Number((tNorm * clip.duration).toFixed(2)), 0.05, Math.max(0.05, clip.duration - 0.05))
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
      startTime: Math.max(0, Number(startSec.toFixed(2))),
      duration: dur,
      curveMode: 'smooth',
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
    const dropSec = Math.max(0, Number(((e.clientX - rect.left) / pxPerSec).toFixed(2)))
    createDefaultWaveClip(mod, layerId, dropSec)
  }

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null
  const selectedClipMod = selectedClip ? project.modules.find((m) => m.id === selectedClip.moduleId) : undefined
  const selectedClipIssues = useMemo(
    () => (selectedClip ? analyzeClipSpeeds(selectedClip, selectedClipMod) : []),
    [selectedClip, selectedClipMod],
  )

  const applyPresetToSelected = (presetId: CurvePresetId) => {
    if (!selectedClip || !selectedClipMod) return
    const kfs = buildCurveKeyframes(
      presetId,
      selectedClip.duration,
      selectedClipMod.minHeight,
      selectedClipMod.maxHeight,
    )
    const sameMod = clips.filter((c) => c.moduleId === selectedClip.moduleId).sort((a, b) => a.startTime - b.startTime)
    const idx = sameMod.findIndex((c) => c.id === selectedClip.id)
    const prevClip = idx > 0 ? sameMod[idx - 1] : null
    const nextClip = idx >= 0 && idx < sameMod.length - 1 ? sameMod[idx + 1] : null
    if (prevClip && prevClip.keyframes.length > 0 && kfs.length > 0) {
      const prevKfs = [...prevClip.keyframes].sort((a, b) => a.offset - b.offset)
      kfs[0] = { ...kfs[0], height: prevKfs[prevKfs.length - 1].height }
    }
    if (nextClip && nextClip.keyframes.length > 0 && kfs.length > 1) {
      const nextKfs = [...nextClip.keyframes].sort((a, b) => a.offset - b.offset)
      kfs[kfs.length - 1] = { ...kfs[kfs.length - 1], height: nextKfs[0].height }
    }
    const curveMode: 'smooth' | 'linear' =
      presetId === 'triangle' || presetId === 'steps' || presetId === 'hold' ? 'linear' : 'smooth'
    updateClip(selectedClip.id, { keyframes: kfs, curveMode })
    setSelectedKeyId(kfs[Math.min(1, kfs.length - 1)]?.id ?? null)
  }

  const addKeyframeToSelected = () => {
    if (!selectedClip || !selectedClipMod) return
    const rel = clamp(
      Number((time - selectedClip.startTime).toFixed(2)),
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
      offset: Number((tNorm * clip.duration).toFixed(2)),
      height: Number((minH + hNorm * (maxH - minH)).toFixed(2)),
    }
    const kfs = [...clip.keyframes, nextKf].sort((a, b) => a.offset - b.offset)
    selectTimelineClip(clip.id)
    updateClip(clip.id, { keyframes: kfs })
    setSelectedKeyId(kfId)
  }

  const timelineWidth = Math.ceil(maxTime * pxPerSec)
  const ticks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, i) => i)

  return (
    <div className="flex h-full flex-col gap-2 text-xs">
      {/* Thanh điều khiển Timeline */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-black/35 px-3 font-mono text-[13px] font-bold text-[#FFB26B] tabular-nums shadow-[inset_0_0_0_1px_var(--line2)]">
            <Clock size={13} className="text-brand" />
            {formatTc(time, fps)}
          </span>

          <button
            type="button"
            onClick={() => {
              setLtcActive(false)
              setPlaying(!playing)
            }}
            className="kiln-btn kiln-btn-primary h-7 px-3.5 text-xs"
          >
            {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            {playing ? 'Dừng' : 'Phát'}
          </button>

          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              seekTo(project.settings.timeline.startTime)
            }}
            title="Về timecode bắt đầu"
            className="kiln-btn h-7 w-7 px-0 text-muted hover:text-fg"
          >
            <RotateCcw size={13} />
          </button>

          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              setLtcActive(!ltcActive)
            }}
            title="Nhận xung LTC từ Line-in / USB Audio"
            className={`kiln-btn h-7 px-2.5 text-[11px] ${ltcActive ? 'border-ok text-ok' : 'text-muted'}`}
          >
            {ltcActive ? <Mic size={13} /> : <MicOff size={13} />}
            LTC {ltcStatus === 'lock' ? '· Lock' : ltcStatus === 'freewheel' ? '· FW' : ltcActive ? '· Chờ' : 'Tắt'}
          </button>

          {unfeasibleIssues.length > 0 && (
            <button
              type="button"
              onClick={() => {
                selectTimelineClip(unfeasibleIssues[0].clipId)
                seekTo(unfeasibleIssues[0].fromTime)
              }}
              title="Có đoạn chuyển động vượt tốc độ tối đa của module. Bấm để xem."
              className="kiln-btn kiln-btn-danger h-7 px-2.5 text-[11px]"
            >
              <AlertTriangle size={12} />
              {unfeasibleIssues.length} đoạn quá tốc độ!
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="kiln-seg">
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.max(28, z - 12))}
              title="Thu nhỏ timeline"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-muted hover:text-fg"
            >
              <ZoomOut size={12} />
            </button>
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.min(150, z + 12))}
              title="Phóng to timeline"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-muted hover:text-fg"
            >
              <ZoomIn size={12} />
            </button>
          </div>

          <input
            value={tcInput}
            onChange={(e) => setTcInput(e.target.value)}
            onBlur={applyStartTc}
            onKeyDown={(e) => e.key === 'Enter' && applyStartTc()}
            title="Timecode bắt đầu (hh:mm:ss:ff)"
            className="kiln-field h-7 w-24 px-2 font-mono text-[11px]"
          />
          <select
            value={fps}
            onChange={(e) => updateTimelineSettings({ fps: Number(e.target.value) as Fps })}
            className="kiln-field h-7 px-2 text-[11px]"
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
              title="Thêm keyframe tại Playhead"
              className="kiln-btn kiln-btn-cue h-7 px-2.5 text-[11px]"
            >
              <Plus size={12} />
              Key tại {time.toFixed(1)}s
            </button>
          )}
        </div>
      </div>

      {/* Khung NLE Waveform đồng bộ cuộn dọc & ngang */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-2xl bg-[#0A0706] shadow-[inset_0_0_0_1px_var(--line)]">
        <div style={{ width: 168 + timelineWidth }} className="relative min-h-full">
          {/* Header Top Sticky: Corner + Time Ruler */}
          <div className="sticky top-0 z-30 flex h-6 border-b border-line bg-[#130D0A]">
            <div className="sticky left-0 z-30 flex w-[168px] shrink-0 items-center justify-between border-r border-line bg-[#130D0A] px-2.5 text-[10px] font-semibold tracking-wider text-muted uppercase">
              <span>Layer / Module</span>
              <span className="text-[9px] opacity-75">Wave</span>
            </div>
            <div
              onPointerDown={startRulerScrub}
              style={{ width: timelineWidth }}
              className="relative h-6 cursor-ew-resize select-none"
            >
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
                      collapsed ? 'h-14' : 'h-8'
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
                    className={`relative transition ${collapsed ? 'h-14' : 'h-8'} ${
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

                    return (
                      <div key={mod.id} className="flex border-b border-white/[0.06]">
                        {/* Nhãn Module bên trái */}
                        <div className="sticky left-0 z-20 flex h-16 w-[168px] shrink-0 items-center justify-between gap-1.5 border-r border-line bg-[#110C09] pr-2 pl-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                style={{ backgroundColor: seriesColor }}
                                className="size-2 shrink-0 rounded-full"
                              />
                              <span className="truncate text-[11px] font-medium text-fg">{mod.name}</span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-muted tabular-nums">
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
                            onClick={() => createDefaultWaveClip(mod, layer.id, modClips.length ? time : 0)}
                            title={`Tạo đường sóng mới (mặc định 0 → 0) cho ${mod.name}`}
                            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/[0.06] text-muted hover:bg-brand/25 hover:text-[#FFB26B]"
                          >
                            <Plus size={11} />
                          </button>
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
                            const dropSec = Math.max(0, Number(((e.clientX - rect.left) / pxPerSec).toFixed(2)))
                            createDefaultWaveClip(mod, layer.id, dropSec)
                          }}
                          style={{ width: timelineWidth }}
                          className={`relative h-16 transition ${
                            dragOverTarget === dropId ? 'bg-brand/12 shadow-[inset_0_0_0_1px_var(--acc)]' : 'bg-[#0A0706]'
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
                                className="pointer-events-none absolute top-[20px] left-0 z-[1]"
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

                          {modClips.length === 0 && (
                            <div className="pointer-events-none relative z-[2] flex h-full items-center pl-3 text-[10.5px] text-muted/55">
                              Double-click hoặc bấm + bên trái để tạo moment sóng (0 → 0)...
                            </div>
                          )}

                          {modClips.map((clip) => {
                            const issues = analyzeClipSpeeds(clip, mod)
                            const badSeg = issues.find((i) => !i.feasible)
                            const maxReq = issues.reduce((mx, i) => Math.max(mx, i.requiredCms), 0)
                            const isSelected = selectedClipId === clip.id
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
                            const handleColor = badSeg ? 'bg-danger' : isSelected ? 'bg-[#1C0E04]' : 'bg-info'

                            return (
                              <div
                                key={clip.id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  selectTimelineClip(clip.id)
                                }}
                                style={{ left: leftPx, width: widthPx }}
                                className={`kiln-clip absolute top-1 bottom-1 z-[2] flex flex-col select-none ${
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
                                <div className="clip-body relative h-[40px] w-full overflow-hidden">
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

                                    {/* Chấm keyframe kéo thả 2D */}
                                    {sortedKfs.map((kf, idx) => {
                                      const pt = pts[idx]
                                      if (!pt) return null
                                      const activeKf = isSelected && selectedKeyId === kf.id
                                      const prevBad = idx > 0 && issues[idx - 1] && !issues[idx - 1].feasible
                                      const nextBad = idx < issues.length && issues[idx] && !issues[idx].feasible
                                      const dotColor = prevBad || nextBad ? '#FF7D6E' : baseStroke

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
                                            {`K${idx + 1}: ${kf.offset.toFixed(2)}s · ${kf.height.toFixed(2)}m (Kéo để chỉnh · Chuột phải xoá điểm)`}
                                          </title>
                                          <circle cx={pt.x} cy={pt.y} r={8} fill="transparent" />
                                          {activeKf && (
                                            <circle cx={pt.x} cy={pt.y} r={6} fill={dotColor} fillOpacity={0.3} />
                                          )}
                                          <circle
                                            cx={pt.x}
                                            cy={pt.y}
                                            r={activeKf ? 4.2 : 3.4}
                                            fill={dotColor}
                                            stroke="#FBF3EA"
                                            strokeWidth={activeKf ? 1.8 : 1.4}
                                          />
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
            style={{ left: 168 + time * pxPerSec }}
            className="pointer-events-none absolute top-6 bottom-0 z-10 w-0.5 bg-brand shadow-[0_0_8px_#f7842e]"
          >
            <div className="-ml-1.5 h-2 w-3.5 rounded-b-sm bg-brand" />
          </div>
        </div>
      </div>

      {/* Thanh đồ thị mẫu (Curve Presets) + Chỉnh Keyframe chính xác cho Clip đang chọn */}
      {selectedClip && selectedClipMod && (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-black/30 px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--line)]">
          {/* Hàng 1: Đồ thị mẫu & Kiểu nội suy */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-[#FFB26B]">{selectedClipMod.name}</span>
              <span className="text-[10.5px] text-muted">Mẫu sóng:</span>
              {CURVE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPresetToSelected(preset.id)}
                  title={`Áp dụng đồ thị mẫu "${preset.label}" (đầu/cuối 0)`}
                  className="kiln-btn h-5.5 gap-1.5 px-2 text-[10.5px] text-[#C2B3A4] hover:text-fg"
                >
                  <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true" className="shrink-0">
                    <polyline
                      fill="none"
                      stroke="#FFB26B"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={preset.points.map(([tx, hy]) => `${(1 + tx * 14).toFixed(1)},${(8.5 - hy * 7).toFixed(1)}`).join(' ')}
                    />
                  </svg>
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className="kiln-seg">
                {(
                  [
                    ['smooth', 'Mượt'],
                    ['linear', 'Thẳng'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateClip(selectedClip.id, { curveMode: m })}
                    className={`kiln-seg-btn h-5 px-2 text-[10px] ${(selectedClip.curveMode ?? 'smooth') === m ? 'on' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {selectedClipIssues.some((i) => !i.feasible) ? (
                (() => {
                  const bad = selectedClipIssues.find((i) => !i.feasible)!
                  return (
                    <span className="kiln-chip danger">
                      <AlertTriangle size={11} />
                      Cần {bad.requiredCms.toFixed(0)} cm/s &gt; {bad.maxSpeedCms} cm/s (≥ {bad.minDurationSec.toFixed(2)}s)
                    </span>
                  )
                })()
              ) : (
                <span className="kiln-chip ok">Hợp lệ (≤ {selectedClipMod.maxSpeedCms} cm/s)</span>
              )}

              <button
                type="button"
                onClick={() => deleteClip(selectedClip.id)}
                title="Xoá clip này (Delete)"
                className="cursor-pointer rounded-full p-1 text-muted hover:bg-danger/20 hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Hàng 2: Danh sách các chấm Keyframe đang có */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-muted">Điểm ({selectedClip.keyframes.length}):</span>
            {[...selectedClip.keyframes]
              .sort((a, b) => a.offset - b.offset)
              .map((kf, idx, arr) => {
                const active = selectedKeyId === kf.id
                const syncEdge = idx === 0 ? 'start' : idx === arr.length - 1 ? 'end' : undefined
                return (
                  <div
                    key={kf.id}
                    onClick={() => setSelectedKeyId(kf.id)}
                    className={`flex items-center gap-1 rounded-xl px-2 py-0.5 ${
                      active
                        ? 'bg-brand/15 shadow-[inset_0_0_0_1.5px_var(--acc)]'
                        : 'bg-black/35 shadow-[inset_0_0_0_1px_var(--line)]'
                    }`}
                  >
                    <span className="text-[10px] font-semibold text-info">K{idx + 1}</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      title="Thời gian tương đối trong clip (s)"
                      value={kf.offset}
                      onChange={(e) => {
                        const offset = Math.max(0, Number(e.target.value) || 0)
                        const nextKfs = selectedClip.keyframes
                          .map((x) => (x.id === kf.id ? { ...x, offset } : x))
                          .sort((a, b) => a.offset - b.offset)
                        const nextDur = Math.max(MIN_CLIP_DUR, ...nextKfs.map((x) => x.offset))
                        updateClip(selectedClip.id, { duration: nextDur, keyframes: nextKfs }, `kf-${kf.id}`)
                      }}
                      className="w-10 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
                    />
                    <span className="text-[10px] text-muted">s</span>
                    <input
                      type="number"
                      step="0.1"
                      min={selectedClipMod.minHeight}
                      max={selectedClipMod.maxHeight}
                      title={`Chiều cao màn (m) [${selectedClipMod.minHeight}..${selectedClipMod.maxHeight}]`}
                      value={kf.height}
                      onChange={(e) => {
                        const h = clamp(Number(e.target.value) || 0, selectedClipMod.minHeight, selectedClipMod.maxHeight)
                        const nextKfs = selectedClip.keyframes.map((x) => (x.id === kf.id ? { ...x, height: h } : x))
                        updateClip(selectedClip.id, { keyframes: nextKfs }, `kfh-${kf.id}`, syncEdge)
                      }}
                      className="w-10 bg-transparent text-right text-[11px] text-[#FFB26B] tabular-nums outline-none"
                    />
                    <span className="text-[10px] text-muted">m</span>
                    {selectedClip.keyframes.length > 2 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const nextKfs = selectedClip.keyframes.filter((x) => x.id !== kf.id)
                          updateClip(selectedClip.id, { keyframes: nextKfs })
                        }}
                        title="Xoá điểm"
                        className="cursor-pointer text-muted hover:text-danger"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}
