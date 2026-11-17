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

  // Đồng hồ nội bộ khi Play
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

  // LTC Audio Input
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

  // Kéo scrub trên ruler
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

  // Kéo thân clip hoặc tay nắm trái/phải
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

  // Thả Module từ Cây màn vào Track của Layer trên Timeline
  const handleDropModuleOnTrack = (e: React.DragEvent, layerId: string) => {
    e.preventDefault()
    setDragOverLayerId(null)
    const modId = e.dataTransfer.getData('application/x-gauze-module') || e.dataTransfer.getData('text/plain')
    const mod = project.modules.find((m) => m.id === modId)
    if (!mod) return

    const rect = e.currentTarget.getBoundingClientRect()
    const dropSec = Math.max(0, Number(((e.clientX - rect.left) / pxPerSec).toFixed(2)))

    // Mặc định chiều dài thả ban đầu là 0m (Key 1 ở 0m, Key 2 cũng ở 0m sau 2s để thành thanh clip giống video editor)
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
    const rel = clamp(Number((time - selectedClip.startTime).toFixed(2)), 0, Math.max(selectedClip.duration, time - selectedClip.startTime))
    const nextDur = Math.max(selectedClip.duration, rel)
    const curHeight = Number(clamp(snapshot?.modules[selectedClipMod.id]?.pos ?? 0, selectedClipMod.minHeight, selectedClipMod.maxHeight).toFixed(2))
    const kfId = `kf-${Date.now()}`
    const kfs = [...selectedClip.keyframes, { id: kfId, offset: rel, height: curHeight }].sort((a, b) => a.offset - b.offset)
    updateClip(selectedClip.id, { duration: nextDur, keyframes: kfs })
    setSelectedKeyId(kfId)
  }

  const timelineWidth = Math.ceil(maxTime * pxPerSec)
  const ticks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, i) => i)

  return (
    <div className="flex h-full flex-col gap-2 text-xs">
      {/* Thanh điều khiển Timeline */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded bg-bg px-2.5 py-1 font-mono text-sm font-bold text-brand tabular-nums">
            <Clock size={14} />
            {formatTc(time, fps)}
          </span>

          <button
            type="button"
            onClick={() => {
              setLtcActive(false)
              setPlaying(!playing)
            }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-brand px-3 py-1 font-semibold text-brand-fg hover:brightness-110"
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? 'Dừng' : 'Phát'}
          </button>

          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              seekTo(project.settings.timeline.startTime)
            }}
            title="Về timecode bắt đầu"
            className="cursor-pointer rounded-md border border-line bg-panel-2 p-1.5 text-muted hover:text-fg"
          >
            <RotateCcw size={14} />
          </button>

          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              setLtcActive(!ltcActive)
            }}
            title="Nhận xung LTC từ Line-in / USB Audio"
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 font-medium ${
              ltcActive ? 'border-ok bg-ok/15 text-ok' : 'border-line bg-panel-2 text-muted hover:text-fg'
            }`}
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
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-danger/60 bg-danger/15 px-2 py-1 text-[11px] font-medium text-danger"
            >
              <AlertTriangle size={13} />
              {unfeasibleIssues.length} đoạn quá tốc độ!
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center rounded border border-line bg-panel-2">
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.max(24, z - 12))}
              title="Thu nhỏ timeline"
              className="cursor-pointer p-1 text-muted hover:text-fg"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.min(140, z + 12))}
              title="Phóng to timeline"
              className="cursor-pointer p-1 text-muted hover:text-fg"
            >
              <ZoomIn size={13} />
            </button>
          </div>

          <input
            value={tcInput}
            onChange={(e) => setTcInput(e.target.value)}
            onBlur={applyStartTc}
            title="Timecode bắt đầu (hh:mm:ss:ff)"
            className="w-24 rounded border border-line bg-bg px-2 py-1 font-mono text-[11px] text-fg"
          />
          <select
            value={fps}
            onChange={(e) => updateTimelineSettings({ fps: Number(e.target.value) as Fps })}
            className="rounded border border-line bg-bg px-1.5 py-1 text-[11px] text-fg"
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
              className="inline-flex cursor-pointer items-center gap-1 rounded bg-info px-2 py-1 text-[11px] font-semibold text-slate-950"
            >
              <Plus size={13} />
              Key tại {time.toFixed(1)}s
            </button>
          )}
        </div>
      </div>

      {/* Khung NLE Timeline (Track trái + Ruler & Clips phải) */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-bg">
        {/* Cột nhãn Layer Track */}
        <div className="flex w-36 shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex h-6 items-center border-b border-line px-2 text-[10px] font-semibold text-muted uppercase">
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
                  className={`flex h-12 w-full cursor-pointer items-center gap-1.5 border-b border-line/60 px-2 text-left text-[11px] font-medium transition ${
                    isLayerSel ? 'bg-info/15 text-info' : 'text-fg/85 hover:bg-panel-2'
                  }`}
                >
                  <Layers size={12} className="shrink-0 text-info" />
                  <span className="truncate">{layer.name}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Vùng Ruler + Track Clips cuộn ngang */}
        <div ref={trackAreaRef} className="relative min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto">
          <div style={{ width: timelineWidth }} className="relative min-h-full">
            {/* Thước thời gian (bấm/kéo để di chuyển playhead) */}
            <div
              onPointerDown={startRulerScrub}
              className="sticky top-0 z-20 flex h-6 cursor-ew-resize items-end border-b border-line bg-panel/95 select-none"
            >
              {ticks.map((sec) => (
                <div
                  key={sec}
                  style={{ left: sec * pxPerSec }}
                  className="absolute bottom-0 flex flex-col items-start border-l border-line/80 pl-1 text-[10px] text-muted tabular-nums"
                >
                  {sec}s
                </div>
              ))}
            </div>

            {/* Các Track tương ứng từng Layer */}
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
                  className={`relative h-12 border-b border-line/60 transition ${
                    isDragOver
                      ? 'bg-brand/15 ring-1 ring-brand/60 ring-inset'
                      : isLayerSel
                        ? 'bg-info/5'
                        : 'bg-bg/60'
                  }`}
                >
                  {/* Vạch lưới mờ mỗi giây */}
                  {ticks.map((sec) => (
                    <div
                      key={sec}
                      style={{ left: sec * pxPerSec }}
                      className="pointer-events-none absolute top-0 bottom-0 border-l border-line/25"
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
                    const widthPx = Math.max(44, clip.duration * pxPerSec)

                    // Vẽ đường cong chiều cao (SVG waveform/keyframe curve) bên trong clip theo theme
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

                    const borderCls = badSeg
                      ? 'border-danger bg-danger/15'
                      : isSelected
                        ? 'border-brand bg-brand/20'
                        : 'border-info/80 bg-info/15 hover:border-info'

                    const handleCls = badSeg ? 'bg-danger' : isSelected ? 'bg-brand' : 'bg-info'

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
                        className={`group absolute top-1.5 bottom-1.5 flex cursor-grab items-center overflow-hidden rounded-xl border-2 select-none active:cursor-grabbing ${borderCls}`}
                      >
                        {/* Đồ thị chiều cao bên trong clip */}
                        {sortedKfs.length >= 2 && (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            className="pointer-events-none absolute inset-0 h-full w-full opacity-45"
                          >
                            <polygon points={areaPts} fill={badSeg ? '#f87171' : isSelected ? '#f7842e' : '#8db8ff'} fillOpacity="0.25" />
                            <polyline
                              points={pts}
                              fill="none"
                              stroke={badSeg ? '#f87171' : isSelected ? '#f7842e' : '#8db8ff'}
                              strokeWidth="3"
                            />
                          </svg>
                        )}

                        {/* Tay nắm trái (bo tròn giống ảnh mẫu) */}
                        <div
                          onPointerDown={(e) => startClipDrag(e, clip, 'trim-left')}
                          title="Kéo để đổi thời điểm bắt đầu"
                          className="z-10 flex h-full w-2.5 shrink-0 cursor-ew-resize items-center justify-center"
                        >
                          <span className={`h-4 w-1 rounded-full ${handleCls}`} />
                        </div>

                        {/* Nội dung clip */}
                        <div className="z-10 flex min-w-0 flex-1 items-center justify-between gap-1 px-1">
                          <span className="truncate text-[11px] font-semibold text-fg">
                            {mod?.name ?? 'Module'}
                          </span>
                          {badSeg ? (
                            <span className="flex shrink-0 items-center gap-0.5 rounded bg-danger/90 px-1 py-0.5 text-[9px] font-bold text-black">
                              <AlertTriangle size={9} />
                              {badSeg.requiredCms.toFixed(0)}cm/s
                            </span>
                          ) : maxReq > 0 ? (
                            <span className="shrink-0 text-[10px] text-info/90 tabular-nums">
                              {maxReq.toFixed(0)}cm/s
                            </span>
                          ) : null}
                        </div>

                        {/* Tay nắm phải (bo tròn giống ảnh mẫu) */}
                        <div
                          onPointerDown={(e) => startClipDrag(e, clip, 'trim-right')}
                          title="Kéo để chỉnh độ dài thời gian clip"
                          className="z-10 flex h-full w-2.5 shrink-0 cursor-ew-resize items-center justify-center"
                        >
                          <span className={`h-4 w-1 rounded-full ${handleCls}`} />
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

      {/* Thanh chỉnh Keyframe cho Clip đang chọn (tính & kiểm tra tốc độ theo maxSpeedCms) */}
      {selectedClip && selectedClipMod && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2/70 px-2.5 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-brand">{selectedClipMod.name}</span>
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
                      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                        active ? 'border-brand bg-brand/15' : 'border-line bg-bg'
                      }`}
                    >
                      <span className="text-[10px] text-info">K{idx + 1}</span>
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
                        className="w-11 bg-transparent text-right text-[11px] text-brand tabular-nums outline-none"
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
                  <span className="flex items-center gap-1 text-[11px] font-medium text-danger">
                    <AlertTriangle size={12} />
                    Cần {bad.requiredCms.toFixed(0)} cm/s &gt; tối đa {bad.maxSpeedCms} cm/s (cần ≥ {bad.minDurationSec.toFixed(2)}s)
                  </span>
                )
              })()
            ) : (
              <span className="text-[11px] text-ok">
                Tốc độ hợp lệ (tối đa {selectedClipMod.maxSpeedCms} cm/s)
              </span>
            )}
            <button
              type="button"
              onClick={() => deleteClip(selectedClip.id)}
              title="Xoá clip này (Delete)"
              className="cursor-pointer rounded p-1 text-muted hover:bg-danger/20 hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
