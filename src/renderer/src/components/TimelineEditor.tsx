import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
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
import { LtcDecoder } from '@shared/ltc'
import { FPS_OPTIONS, formatTc, parseTc, tcToSeconds } from '@shared/timecode'
import { TimelineRunner, analyzeClipSpeeds, analyzeTimeline } from '@shared/timeline'
import type { Fps, TimelineClip } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

const MIN_CLIP_DUR = 0.2

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
  const [pxPerSec, setPxPerSec] = useState(56)
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)

  const runnerRef = useRef(new TimelineRunner())
  const timeRef = useRef(time)
  timeRef.current = time
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const keysRef = useRef(project.keys)
  keysRef.current = project.keys
  const trackAreaRef = useRef<HTMLDivElement | null>(null)

  const maxTime = useMemo(
    () => Math.max(20, ...clips.map((c) => c.startTime + c.duration + 4), ...project.keys.map((k) => k.time + 4)),
    [clips, project.keys],
  )

  const allIssues = useMemo(() => analyzeTimeline(clips, project.modules), [clips, project.modules])
  const unfeasibleIssues = useMemo(() => allIssues.filter((i) => !i.feasible), [allIssues])

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
      if (mode === 'move') {
        const nextStart = Math.max(0, Number((origStart + dxSec).toFixed(2)))
        updateClip(clip.id, { startTime: nextStart }, `clip-move-${clip.id}`)
      } else if (mode === 'trim-right') {
        const nextDur = Math.max(MIN_CLIP_DUR, Number((origDur + dxSec).toFixed(2)))
        const ratio = nextDur / Math.max(0.01, origDur)
        const nextKfs = origKfs.map((k) => ({ ...k, offset: Number((k.offset * ratio).toFixed(2)) }))
        updateClip(clip.id, { duration: nextDur, keyframes: nextKfs }, `clip-trim-${clip.id}`)
      } else {
        const maxShift = origDur - MIN_CLIP_DUR
        const clampedShift = Math.max(-origStart, Math.min(maxShift, dxSec))
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

  const handleDropModuleOnTrack = (e: React.DragEvent, layerId: string) => {
    e.preventDefault()
    setDragOverLayerId(null)
    const modId = e.dataTransfer.getData('application/x-gauze-module') || e.dataTransfer.getData('text/plain')
    const mod = project.modules.find((m) => m.id === modId)
    if (!mod) return

    const rect = e.currentTarget.getBoundingClientRect()
    const dropSec = Math.max(0, Number(((e.clientX - rect.left) / pxPerSec).toFixed(2)))

    const clip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      layerId,
      moduleId: mod.id,
      startTime: dropSec,
      duration: 2,
      keyframes: [
        { id: `kf-${Date.now()}-1`, offset: 0, height: 0 },
        { id: `kf-${Date.now()}-2`, offset: 2, height: 0 },
      ],
    }
    addClip(clip)
    setSelectedKeyId(clip.keyframes[1].id)
    notify(`Đã thêm "${mod.name}" tại ${dropSec.toFixed(2)}s (mặc định 0m)`, 'info')
  }

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null
  const selectedClipMod = selectedClip ? project.modules.find((m) => m.id === selectedClip.moduleId) : undefined
  const selectedClipIssues = useMemo(
    () => (selectedClip ? analyzeClipSpeeds(selectedClip, selectedClipMod) : []),
    [selectedClip, selectedClipMod],
  )

  const addKeyframeToSelected = () => {
    if (!selectedClip || !selectedClipMod) return
    const rel = clamp(
      Number((time - selectedClip.startTime).toFixed(2)),
      0,
      Math.max(selectedClip.duration, time - selectedClip.startTime),
    )
    const nextDur = Math.max(selectedClip.duration, rel)
    const curHeight = Number(
      clamp(snapshot?.modules[selectedClipMod.id]?.pos ?? 0, selectedClipMod.minHeight, selectedClipMod.maxHeight).toFixed(2),
    )
    const kfId = `kf-${Date.now()}`
    const kfs = [...selectedClip.keyframes, { id: kfId, offset: rel, height: curHeight }].sort((a, b) => a.offset - b.offset)
    updateClip(selectedClip.id, { duration: nextDur, keyframes: kfs })
    setSelectedKeyId(kfId)
  }

  const timelineWidth = Math.ceil(maxTime * pxPerSec)
  const ticks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, i) => i)

  return (
    <div className="flex h-full flex-col gap-2 text-xs">
      {/* Thanh điều khiển Timeline chuẩn Kiln */}
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
              onClick={() => setPxPerSec((z) => Math.max(24, z - 12))}
              title="Thu nhỏ timeline"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-muted hover:text-fg"
            >
              <ZoomOut size={12} />
            </button>
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.min(140, z + 12))}
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
              title="Thêm keyframe vào clip đang chọn tại Playhead"
              className="kiln-btn kiln-btn-cue h-7 px-2.5 text-[11px]"
            >
              <Plus size={12} />
              Key tại {time.toFixed(1)}s
            </button>
          )}
        </div>
      </div>

      {/* Khung NLE Timeline nền #0A0706 phẳng */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl bg-[#0A0706] shadow-[inset_0_0_0_1px_var(--line)]">
        {/* Cột nhãn Layer Track */}
        <div className="flex w-36 shrink-0 flex-col border-r border-line bg-[#130D0A]">
          <div className="flex h-6 items-center border-b border-line px-2.5 text-[10px] font-semibold tracking-wider text-muted uppercase">
            Layer Track
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {project.layers.map((layer) => {
              const isLayerSel = selectedTimelineLayerId === layer.id
              return (
                <button
                  key={layer.id}
                  type="button"
                  onClick={() => selectTimelineLayer(layer.id)}
                  title="Chọn track layer (hỗ trợ Ctrl+C, Ctrl+V, Delete các clip của layer)"
                  className={`flex h-14 w-full cursor-pointer items-center gap-1.5 border-b border-line px-2.5 text-left text-[11px] font-medium transition ${
                    isLayerSel ? 'bg-brand/15 text-[#FFB26B]' : 'text-[#C2B3A4] hover:bg-white/5 hover:text-fg'
                  }`}
                >
                  <Layers size={12} className={`shrink-0 ${isLayerSel ? 'text-brand' : 'text-info'}`} />
                  <span className="truncate">{layer.name}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Vùng Ruler + Track Clips cuộn ngang */}
        <div ref={trackAreaRef} className="relative min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto">
          <div style={{ width: timelineWidth }} className="relative min-h-full">
            <div
              onPointerDown={startRulerScrub}
              className="sticky top-0 z-20 flex h-6 cursor-ew-resize items-end border-b border-line bg-[#130D0A]/95 select-none"
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

            {project.layers.map((layer) => {
              const layerClips = clips.filter((c) => c.layerId === layer.id)
              const isDragOver = dragOverLayerId === layer.id
              const isLayerSel = selectedTimelineLayerId === layer.id

              return (
                <div
                  key={layer.id}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOverLayerId(layer.id)
                  }}
                  onDragLeave={() => setDragOverLayerId(null)}
                  onDrop={(e) => handleDropModuleOnTrack(e, layer.id)}
                  onClick={() => selectTimelineLayer(layer.id)}
                  className={`relative h-14 border-b border-line transition ${
                    isDragOver
                      ? 'bg-brand/15 shadow-[inset_0_0_0_1px_var(--acc)]'
                      : isLayerSel
                        ? 'bg-info/5'
                        : 'bg-[#0A0706]'
                  }`}
                >
                  {ticks.map((sec) => (
                    <div
                      key={sec}
                      style={{ left: sec * pxPerSec }}
                      className="pointer-events-none absolute top-0 bottom-0 border-l border-white/[0.04]"
                    />
                  ))}

                  {layerClips.length === 0 && (
                    <div className="pointer-events-none flex h-full items-center pl-3 text-[11px] text-muted/60">
                      Kéo thả module từ Cây màn vào đây...
                    </div>
                  )}

                  {layerClips.map((clip) => {
                    const mod = project.modules.find((m) => m.id === clip.moduleId)
                    const issues = analyzeClipSpeeds(clip, mod)
                    const badSeg = issues.find((i) => !i.feasible)
                    const maxReq = issues.reduce((mx, i) => Math.max(mx, i.requiredCms), 0)
                    const isSelected = selectedClipId === clip.id
                    const leftPx = clip.startTime * pxPerSec
                    const widthPx = Math.max(54, clip.duration * pxPerSec)

                    const sortedKfs = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
                    const maxH = Math.max(0.2, mod?.length ?? 1)
                    const pts = sortedKfs
                      .map((k) => {
                        const x = (k.offset / Math.max(0.01, clip.duration)) * 100
                        const y = 90 - clamp(k.height / maxH, 0, 1) * 76
                        return `${x},${y}`
                      })
                      .join(' ')
                    const areaPts = sortedKfs.length ? `0,95 ${pts} 100,95` : ''

                    const curveColor = badSeg ? '#FF7D6E' : isSelected ? '#F7842E' : '#8DB8FF'
                    const handleColor = badSeg ? 'bg-danger' : isSelected ? 'bg-[#1C0E04]' : 'bg-info'

                    return (
                      <div
                        key={clip.id}
                        onPointerDown={(e) => startClipDrag(e, clip, 'move')}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectTimelineClip(clip.id)
                        }}
                        title={
                          badSeg
                            ? `Cảnh báo: Cần ${badSeg.requiredCms.toFixed(0)} cm/s > tối đa ${badSeg.maxSpeedCms} cm/s (tối thiểu ${badSeg.minDurationSec.toFixed(2)}s)`
                            : `${mod?.name ?? 'Module'} · Kéo để dời thời gian, kéo 2 đầu để chỉnh độ dài`
                        }
                        style={{ left: leftPx, width: widthPx }}
                        className={`kiln-clip absolute top-1 bottom-1 flex cursor-grab flex-col select-none active:cursor-grabbing ${
                          badSeg ? 'bad' : isSelected ? 'sel' : ''
                        }`}
                      >
                        {/* Bar tiêu đề tách riêng theo Kiln + 2 tay nắm bo tròn */}
                        <div className="clip-bar flex h-[20px] shrink-0 items-center justify-between gap-1 px-1 text-[10.5px] font-semibold">
                          <div
                            onPointerDown={(e) => startClipDrag(e, clip, 'trim-left')}
                            title="Kéo để đổi thời điểm bắt đầu"
                            className="flex h-full w-2 shrink-0 cursor-ew-resize items-center justify-center"
                          >
                            <span className={`h-3 w-1 rounded-full ${handleColor}`} />
                          </div>
                          <span className="truncate">{mod?.name ?? 'Module'}</span>
                          <div
                            onPointerDown={(e) => startClipDrag(e, clip, 'trim-right')}
                            title="Kéo để chỉnh độ dài thời gian clip"
                            className="flex h-full w-2 shrink-0 cursor-ew-resize items-center justify-center"
                          >
                            <span className={`h-3 w-1 rounded-full ${handleColor}`} />
                          </div>
                        </div>

                        {/* Body phẳng #0A0706 chứa đồ thị chiều cao + tốc độ */}
                        <div className="clip-body relative flex-1 overflow-hidden">
                          {sortedKfs.length >= 2 && (
                            <svg
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                              className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
                            >
                              <polygon points={areaPts} fill={curveColor} fillOpacity="0.18" />
                              <polyline points={pts} fill="none" stroke={curveColor} strokeWidth="3" />
                            </svg>
                          )}
                          <div className="relative z-10 flex h-full items-end justify-between px-2 pb-0.5 text-[9.5px] font-semibold">
                            <span className={badSeg ? 'text-danger' : isSelected ? 'text-[#FFB26B]' : 'text-info'}>
                              {badSeg ? `⚠ ${badSeg.requiredCms.toFixed(0)}cm/s` : maxReq > 0 ? `${maxReq.toFixed(0)}cm/s` : '0m'}
                            </span>
                            <span className="text-muted tabular-nums">{clip.duration.toFixed(1)}s</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {/* Vạch Playhead dọc */}
            <div
              style={{ left: time * pxPerSec }}
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-brand shadow-[0_0_8px_#f7842e]"
            >
              <div className="-ml-1.5 h-2.5 w-3.5 rounded-b-sm bg-brand" />
            </div>
          </div>
        </div>
      </div>

      {/* Thanh chỉnh Keyframe cho Clip đang chọn */}
      {selectedClip && selectedClipMod && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-black/30 px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--line)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[#FFB26B]">{selectedClipMod.name}</span>
            <span className="text-muted">({selectedClip.startTime.toFixed(2)}s)</span>

            <div className="flex flex-wrap items-center gap-1.5">
              {[...selectedClip.keyframes]
                .sort((a, b) => a.offset - b.offset)
                .map((kf, idx) => {
                  const active = selectedKeyId === kf.id
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
                        className="w-11 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
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
                          updateClip(selectedClip.id, { keyframes: nextKfs }, `kfh-${kf.id}`)
                        }}
                        className="w-11 bg-transparent text-right text-[11px] text-[#FFB26B] tabular-nums outline-none"
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
                          title="Xoá key"
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

          <div className="flex items-center gap-2">
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
      )}
    </div>
  )
}
