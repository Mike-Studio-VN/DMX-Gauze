import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  HelpCircle,
  Layers,
  Link2,
  Plus,
  RotateCcw,
  Trash2,
  Waves,
} from 'lucide-react'
import { getBridge } from '../services/bridge'
import { layerLoopAddress } from '@shared/addressing'
import { ch3ToCms, clamp, cmsToCh3, speedCap } from '@shared/convert'
import { CH, SENT_CH4_PULSE_VALUE, SENT_PULSE_MS, addressRange } from '@shared/dmx'
import { defaultLayerTransform, defaultModuleTransform } from '@shared/preset'
import {
  computeModuleBasePositions,
  getModuleWorldPosition,
  worldPositionToModuleOffset,
} from '@shared/stage3d'
import {
  CURVE_PRESETS,
  type CurvePresetId,
  DEFAULT_ALTERNATING_WAVE_AMPLITUDE_CM,
  LAYER_MOTION_PRESETS,
  type LayerMotionPresetId,
  analyzeClipSpeeds,
  buildCurveKeyframes,
  clipAutoSpeedCms,
  fitDefaultMotionDuration,
  fullCurvePath,
  heightToPercent,
  insertClipKeyframe,
  mapKeyframesToPts,
  percentToHeight,
  removeClipKeyframe,
  resolveClipBoundsNoOverlap,
  cmsToSeconds,
  resolveKeyframeSpeed,
  secondsToCms,
  segmentDistCm,
  segmentPath,
  updateClipEndTime,
  updateClipKeyframeHeight,
  updateClipKeyframeTimelineTime,
  updateClipStartTime,
} from '@shared/timeline'
import type { ClipKeyframe, CueButton, Layer, ModuleCfg, SpeedUnit, TimelineClip, Transform3D } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

function TransformEditor({
  tf,
  lockY = false,
  onChange,
  onReset,
}: {
  tf: Transform3D
  lockY?: boolean
  onChange: (next: Transform3D) => void
  onReset: () => void
}) {
  const axes = ['X', 'Y', 'Z'] as const

  const updateAxis = (field: keyof Transform3D, idx: 0 | 1 | 2, val: number) => {
    const arr: [number, number, number] = [...tf[field]]
    arr[idx] = field === 'scale' ? Math.max(0.1, val || 0.1) : val || 0
    if (lockY && field === 'position' && idx === 1) arr[1] = 0
    onChange({ ...tf, [field]: arr })
  }

  return (
    <div className="space-y-2.5 border-b border-line pb-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Transform 3D</span>
        <button
          type="button"
          onClick={onReset}
          title="Đưa Position / Rotation / Scale về mặc định"
          className="kiln-btn h-6 px-2 text-[10.5px] text-[#C2B3A4]"
        >
          <RotateCcw size={11} />
          Mặc định
        </button>
      </div>

      {(
        [
          ['position', 'Vị trí World (m)', 0.1],
          ['rotation', 'Xoay (°)', 5],
          ['scale', 'Tỉ lệ (Scale)', 0.1],
        ] as const
      ).map(([field, label, step]) => (
        <div key={field} className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-[#C2B3A4]">
            <span>{label}</span>
            {lockY && field === 'position' && <span className="text-[10px] text-[#FFB26B]">Y dính vào Layer</span>}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {axes.map((ax, i) => {
              const disabled = lockY && field === 'position' && i === 1
              return (
                <label key={ax} className="kiln-field flex h-7 items-center gap-1 px-2">
                  <span className="text-[10px] font-semibold text-muted">{ax}</span>
                  <input
                    type="number"
                    step={step}
                    disabled={disabled}
                    value={Number(tf[field][i].toFixed(2))}
                    onChange={(e) => updateAxis(field, i as 0 | 1 | 2, Number(e.target.value))}
                    className="min-w-0 flex-1 bg-transparent text-right text-[11.5px] text-fg tabular-nums outline-none disabled:opacity-45"
                  />
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

const CURVE_W = 280
const CURVE_H = 138
const CURVE_PAD = { left: 30, right: 12, top: 14, bottom: 20 }

function MomentCurveGraph({
  clip,
  mod,
  selectedKeyId,
  onSelectKey,
  onUpdate,
}: {
  clip: TimelineClip
  mod: ModuleCfg
  selectedKeyId: string | null
  onSelectKey: (id: string | null) => void
  onUpdate: (patch: Partial<TimelineClip>, coalesceKey?: string, syncEdge?: 'start' | 'end') => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const minH = mod.minHeight
  const maxH = Math.max(minH + 0.1, Math.min(mod.length, mod.maxHeight))
  const mode = clip.curveMode ?? 'smooth'
  const issues = analyzeClipSpeeds(clip, mod)
  const pts = mapKeyframesToPts(sorted, clip.duration, minH, maxH, CURVE_W, CURVE_H, CURVE_PAD)

  const usableW = CURVE_W - CURVE_PAD.left - CURVE_PAD.right
  const usableH = CURVE_H - CURVE_PAD.top - CURVE_PAD.bottom
  const areaLine = fullCurvePath(pts, mode, CURVE_PAD.top, CURVE_H - CURVE_PAD.bottom)
  const areaFill =
    areaLine && pts.length >= 2
      ? `${areaLine} L ${pts[pts.length - 1].x.toFixed(1)} ${(CURVE_H - CURVE_PAD.bottom).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(CURVE_H - CURVE_PAD.bottom).toFixed(1)} Z`
      : ''

  const pointerToTarget = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    const svgX = clamp((clientX - rect.left) * (CURVE_W / Math.max(1, rect.width)), CURVE_PAD.left, CURVE_W - CURVE_PAD.right)
    const svgY = clamp((clientY - rect.top) * (CURVE_H / Math.max(1, rect.height)), CURVE_PAD.top, CURVE_H - CURVE_PAD.bottom)
    const tNorm = clamp((svgX - CURVE_PAD.left) / Math.max(1, usableW), 0, 1)
    const hNorm = clamp(1 - (svgY - CURVE_PAD.top) / Math.max(1, usableH), 0, 1)
    return {
      offset: Number((tNorm * clip.duration).toFixed(4)),
      height: Number((minH + hNorm * (maxH - minH)).toFixed(2)),
    }
  }

  const startDotDrag = (e: React.PointerEvent, kfId: string) => {
    e.stopPropagation()
    e.preventDefault()
    onSelectKey(kfId)
    const baseKfs = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
    const idx = baseKfs.findIndex((k) => k.id === kfId)
    if (idx < 0) return
    const isFirst = idx === 0
    const isLast = idx === baseKfs.length - 1
    const syncEdge = isFirst ? 'start' : isLast ? 'end' : undefined
    const minOff = idx > 0 ? Math.min(clip.duration, baseKfs[idx - 1].offset + 0.05) : 0
    const maxOff = idx < baseKfs.length - 1 ? Math.max(minOff, baseKfs[idx + 1].offset - 0.05) : clip.duration

    const apply = (clientX: number, clientY: number) => {
      const target = pointerToTarget(clientX, clientY)
      if (!target) return
      const nextOffset = isFirst ? 0 : isLast ? clip.duration : clamp(target.offset, minOff, maxOff)
      const nextHeight = clamp(target.height, minH, maxH)
      const nextKfs = baseKfs.map((k) => (k.id === kfId ? { ...k, offset: nextOffset, height: nextHeight } : k))
      onUpdate({ keyframes: nextKfs }, `curve-drag-${kfId}`, syncEdge)
    }

    const onMove = (ev: PointerEvent) => apply(ev.clientX, ev.clientY)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activeIdx = sorted.findIndex((k) => k.id === selectedKeyId)
  const activeKf = activeIdx >= 0 ? sorted[activeIdx] : null

  return (
    <div className="space-y-1.5 border-b border-line pb-3">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Curve</span>
          {activeKf && activeIdx >= 0 && (
            <span className="truncate text-[10px] font-semibold text-[#FFCB72] tabular-nums">
              P{activeIdx + 1}: {(clip.startTime + activeKf.offset).toFixed(2)}s · {heightToPercent(activeKf.height, mod)}%
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            const { keyframes, newKeyId } = insertClipKeyframe(clip, minH, maxH)
            onUpdate({ keyframes })
            onSelectKey(newKeyId)
          }}
          title="Thêm Point mới vào moment"
          className="kiln-btn kiln-btn-cue h-6 shrink-0 px-2.5 text-[10.5px]"
        >
          <Plus size={11} />
          Point
        </button>
      </div>

      <div className="overflow-hidden rounded-xl bg-[#0D0907] shadow-[inset_0_0_0_1px_var(--line2)]">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
          onDoubleClick={(e) => {
            const target = pointerToTarget(e.clientX, e.clientY)
            if (!target) return
            const { keyframes, newKeyId } = insertClipKeyframe(clip, minH, maxH, target)
            onUpdate({ keyframes })
            onSelectKey(newKeyId)
          }}
          className="block h-[138px] w-full cursor-crosshair select-none"
        >
          <defs>
            <linearGradient id="moment-prop-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F7842E" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#F7842E" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Lưới ngang (%) */}
          {[
            { pct: 100, label: '100%' },
            { pct: 50, label: '50%' },
            { pct: 0, label: '0%' },
          ].map(({ pct, label }) => {
            const y = CURVE_PAD.top + (1 - pct / 100) * usableH
            return (
              <g key={pct}>
                <line
                  x1={CURVE_PAD.left}
                  y1={y}
                  x2={CURVE_W - CURVE_PAD.right}
                  y2={y}
                  stroke="rgba(255,206,160,0.12)"
                  strokeDasharray={pct === 50 ? '2 3' : undefined}
                />
                <text x={CURVE_PAD.left - 4} y={y + 3} textAnchor="end" fill="#9A8B7D" fontSize={8}>
                  {label}
                </text>
              </g>
            )
          })}

          {/* Lưới dọc (thời gian timeline) */}
          {[0, 0.5, 1].map((frac) => {
            const x = CURVE_PAD.left + frac * usableW
            const sec = (clip.startTime + frac * clip.duration).toFixed(1)
            const anchor = frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle'
            return (
              <g key={frac}>
                <line
                  x1={x}
                  y1={CURVE_PAD.top}
                  x2={x}
                  y2={CURVE_H - CURVE_PAD.bottom}
                  stroke="rgba(255,206,160,0.1)"
                  strokeDasharray={frac === 0.5 ? '2 3' : undefined}
                />
                <text x={x} y={CURVE_H - 6} textAnchor={anchor} fill="#9A8B7D" fontSize={8}>
                  {sec}s
                </text>
              </g>
            )
          })}

          {areaFill && <path d={areaFill} fill="url(#moment-prop-area)" />}

          {/* Các đoạn đường cong (tô đỏ đoạn vượt tốc độ) */}
          {pts.length >= 2 &&
            pts.slice(0, -1).map((_, idx) => {
              const segBad = issues[idx] && !issues[idx].feasible
              const d = segmentPath(pts, idx, mode, CURVE_PAD.top, CURVE_H - CURVE_PAD.bottom)
              return (
                <path
                  key={idx}
                  d={d}
                  fill="none"
                  stroke={segBad ? '#FF7D6E' : '#F7842E'}
                  strokeWidth={segBad ? 2.8 : 2.3}
                  strokeLinecap="round"
                />
              )
            })}

          {/* Điểm K kéo thả trực tiếp */}
          {[...sorted]
            .map((kf, idx) => ({ kf, idx, active: kf.id === selectedKeyId }))
            .sort((a, b) => Number(a.active) - Number(b.active))
            .map(({ kf, idx, active }) => {
              const pt = pts[idx]
              if (!pt) return null
              const prevBad = idx > 0 && issues[idx - 1] && !issues[idx - 1].feasible
              const nextBad = idx < issues.length && issues[idx] && !issues[idx].feasible
              const dotColor = prevBad || nextBad ? '#FF7D6E' : '#F7842E'
              const tagX = pt.x > CURVE_W - CURVE_PAD.right - 26 ? pt.x - 24 : pt.x + 8
              const tagY = pt.y < CURVE_PAD.top + 16 ? pt.y + 4 : pt.y - 14

              return (
                <g
                  key={kf.id}
                  onPointerDown={(e) => startDotDrag(e, kf.id)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const nextKfs = removeClipKeyframe(clip, kf.id)
                    if (nextKfs) onUpdate({ keyframes: nextKfs })
                  }}
                  className="cursor-grab active:cursor-grabbing"
                >
                  <title>{`P${idx + 1}: ${(clip.startTime + kf.offset).toFixed(2)}s · ${heightToPercent(kf.height, mod)}%`}</title>
                  {active && (
                    <>
                      <line
                        x1={pt.x}
                        y1={CURVE_PAD.top}
                        x2={pt.x}
                        y2={CURVE_H - CURVE_PAD.bottom}
                        stroke="#FFCB72"
                        strokeWidth={1}
                        strokeDasharray="2 2"
                        strokeOpacity={0.65}
                      />
                      <line
                        x1={CURVE_PAD.left}
                        y1={pt.y}
                        x2={CURVE_W - CURVE_PAD.right}
                        y2={pt.y}
                        stroke="#FFCB72"
                        strokeWidth={1}
                        strokeDasharray="2 2"
                        strokeOpacity={0.45}
                      />
                      <circle cx={pt.x} cy={pt.y} r={9.5} fill="#F7842E" fillOpacity={0.28} />
                      <circle cx={pt.x} cy={pt.y} r={7} fill="none" stroke="#FFCB72" strokeWidth={1.3} />
                    </>
                  )}
                  <circle cx={pt.x} cy={pt.y} r={10} fill="transparent" />
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={active ? 5 : 3.8}
                    fill={active ? '#FBF3EA' : dotColor}
                    stroke={active ? '#F7842E' : '#FBF3EA'}
                    strokeWidth={active ? 2 : 1.3}
                  />
                  {active && (
                    <g transform={`translate(${tagX}, ${tagY})`} className="pointer-events-none">
                      <rect width={20} height={12} rx={3} fill="#1C0E04" stroke="#FFCB72" strokeWidth={0.9} />
                      <text x={10} y={8.5} textAnchor="middle" fill="#FFCB72" fontSize={8} fontWeight={700}>
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
}

function MomentEditor({
  clip,
  allClips,
  mod,
  selectedKeyId,
  onSelectKey,
  onBackToModule,
  onUpdate,
  onDelete,
  onPresetOverlap,
}: {
  clip: TimelineClip
  allClips: TimelineClip[]
  mod: ModuleCfg
  selectedKeyId: string | null
  onSelectKey: (id: string | null) => void
  onBackToModule: () => void
  onUpdate: (patch: Partial<TimelineClip>, coalesceKey?: string, syncEdge?: 'start' | 'end') => void
  onDelete: () => void
  onPresetOverlap: () => void
}) {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const sameModClips = allClips.filter((c) => c.moduleId === clip.moduleId)
  const bounds = resolveClipBoundsNoOverlap(sameModClips, clip)
  const issues = analyzeClipSpeeds(clip, mod)
  const bad = issues.find((i) => !i.feasible)
  const endTime = Number((clip.startTime + clip.duration).toFixed(4))
  const minEndTime = Number((clip.startTime + 0.4).toFixed(4))
  const maxStartTime = Number.isFinite(bounds.maxEnd)
    ? Math.max(bounds.minStart, Number((bounds.maxEnd - clip.duration).toFixed(4)))
    : Number.POSITIVE_INFINITY
  const [draftStart, setDraftStart] = useState<{ clipId: string; raw: string } | null>(null)
  const [draftEnd, setDraftEnd] = useState<{ clipId: string; raw: string } | null>(null)
  const [draftTime, setDraftTime] = useState<{ id: string; raw: string } | null>(null)
  const [speedUnit, setSpeedUnit] = useState<'cms' | 'sec'>('cms')
  const [draftPct, setDraftPct] = useState<{ id: string; raw: string } | null>(null)

  const commitStartTime = (rawVal: number) => {
    const patch = updateClipStartTime(clip, rawVal, bounds)
    if (patch) onUpdate(patch, `clip-start-${clip.id}`)
  }

  const commitEndTime = (rawVal: number) => {
    const patch = updateClipEndTime(clip, rawVal, bounds)
    if (patch) onUpdate(patch, `clip-end-${clip.id}`)
  }

  const commitTimelineTime = (kfId: string, rawVal: number) => {
    const patch = updateClipKeyframeTimelineTime(clip, kfId, rawVal, bounds)
    onUpdate(patch, `kf-${kfId}`)
  }

  const loM = Math.max(0, mod.minHeight)
  const hiM = Math.min(mod.length, Math.max(loM, mod.maxHeight))
  const commitHeight = (kfId: string, rawM: number) => {
    const h = clamp(rawM, loM, hiM)
    const { keyframes, syncEdge } = updateClipKeyframeHeight(clip, kfId, h)
    onUpdate({ keyframes }, `kfh-${kfId}`, syncEdge)
  }

  const applyPreset = (presetId: CurvePresetId) => {
    const kfs = buildCurveKeyframes(presetId, clip.duration, mod.minHeight, mod.maxHeight)
    const sameMod = allClips.filter((c) => c.moduleId === clip.moduleId).sort((a, b) => a.startTime - b.startTime)
    const idx = sameMod.findIndex((c) => c.id === clip.id)
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
    const fitted = fitDefaultMotionDuration({ ...clip, keyframes: kfs, curveMode }, mod)
    if (fitted.duration > clip.duration && clip.startTime + fitted.duration > bounds.maxEnd + 1e-6) {
      onPresetOverlap()
      return
    }
    onUpdate({
      keyframes: fitted.keyframes,
      curveMode,
      duration: fitted.duration,
      autoSpeedLimitCms: fitted.autoSpeedLimitCms,
    })
    onSelectKey(kfs[Math.min(1, kfs.length - 1)]?.id ?? null)
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line pb-2.5">
        <span className="kiln-chip acc">Moment · {mod.name}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onBackToModule}
            title={`Quay lại thuộc tính ${mod.name}`}
            className="kiln-btn h-6 px-2 text-[10.5px] text-[#C2B3A4]"
          >
            <ArrowLeft size={11} />
            Module
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Xoá moment này"
            aria-label="Xoá moment"
            className="cursor-pointer rounded-full p-1 text-muted hover:bg-danger/20 hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="space-y-2 border-b border-line pb-3">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
            <span className="shrink-0 text-[10px] text-muted">Bắt đầu</span>
            <input
              type="number"
              step="0.1"
              min={bounds.minStart}
              max={Number.isFinite(maxStartTime) ? maxStartTime : undefined}
              aria-label="Thời điểm bắt đầu (s)"
              value={draftStart?.clipId === clip.id ? draftStart.raw : clip.startTime}
              onFocus={() => setDraftStart({ clipId: clip.id, raw: String(clip.startTime) })}
              onChange={(e) => {
                const raw = e.target.value
                setDraftStart({ clipId: clip.id, raw })
                if (!raw.trim() || raw.endsWith('.')) return
                const num = Number(raw)
                if (Number.isFinite(num) && num >= bounds.minStart && num <= maxStartTime) {
                  commitStartTime(num)
                }
              }}
              onBlur={() => {
                if (draftStart?.clipId === clip.id) {
                  const num = Number(draftStart.raw)
                  if (draftStart.raw.trim() && Number.isFinite(num)) commitStartTime(num)
                  setDraftStart(null)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
            />
            <span className="shrink-0 text-[10px] text-muted">s</span>
          </label>

          <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
            <span className="shrink-0 text-[10px] text-muted">Kết thúc</span>
            <input
              type="number"
              step="0.1"
              min={minEndTime}
              max={Number.isFinite(bounds.maxEnd) ? Number(bounds.maxEnd.toFixed(2)) : undefined}
              aria-label="Thời điểm kết thúc (s)"
              value={draftEnd?.clipId === clip.id ? draftEnd.raw : endTime}
              onFocus={() => setDraftEnd({ clipId: clip.id, raw: String(endTime) })}
              onChange={(e) => {
                const raw = e.target.value
                setDraftEnd({ clipId: clip.id, raw })
                if (!raw.trim() || raw.endsWith('.')) return
                const num = Number(raw)
                if (Number.isFinite(num) && num >= minEndTime && num <= bounds.maxEnd) {
                  commitEndTime(num)
                }
              }}
              onBlur={() => {
                if (draftEnd?.clipId === clip.id) {
                  const num = Number(draftEnd.raw)
                  if (draftEnd.raw.trim() && Number.isFinite(num)) commitEndTime(num)
                  setDraftEnd(null)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
            />
            <span className="shrink-0 text-[10px] text-muted">s</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10.5px]">
          <span className="text-muted tabular-nums">Độ dài: {clip.duration.toFixed(2)}s</span>
          <div className="kiln-seg shrink-0">
            {(
              [
                ['smooth', 'Mượt'],
                ['linear', 'Thẳng'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => onUpdate({ curveMode: m })}
                className={`kiln-seg-btn h-5 px-2 text-[10px] ${(clip.curveMode ?? 'smooth') === m ? 'on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end text-[10.5px]">
          {bad ? (
            <span className="kiln-chip danger">
              <AlertTriangle size={10} />
              {bad.requiredCms.toFixed(0)} &gt; {bad.maxSpeedCms} cm/s
            </span>
          ) : (
            <span className="kiln-chip ok">Hợp lệ (≤ {speedCap(mod)} cm/s)</span>
          )}
        </div>
      </div>

      <MomentCurveGraph
        clip={clip}
        mod={mod}
        selectedKeyId={selectedKeyId}
        onSelectKey={onSelectKey}
        onUpdate={onUpdate}
      />

      <div className="space-y-1.5 border-b border-line pb-3">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Mẫu sóng</span>
        <div className="grid grid-cols-7 gap-1">
          {CURVE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              title={preset.label}
              aria-label={`Mẫu sóng ${preset.label}`}
              className="kiln-btn h-7 w-full px-0 text-[#C2B3A4] hover:text-fg"
            >
              <svg width="18" height="11" viewBox="0 0 20 12" aria-hidden="true" className="shrink-0">
                <polyline
                  fill="none"
                  stroke="#FFB26B"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={preset.points.map(([tx, hy]) => `${(1.5 + tx * 17).toFixed(1)},${(10 - hy * 8).toFixed(1)}`).join(' ')}
                />
              </svg>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-[#FFB26B] uppercase">
              Các điểm ({sorted.length})
            </span>
            {(() => {
              const activeIdx = sorted.findIndex((k) => k.id === selectedKeyId)
              return activeIdx >= 0 ? (
                <span className="rounded-md bg-brand px-1.5 py-0.5 text-[10px] font-bold text-[#1C0E04]">
                  P{activeIdx + 1}
                </span>
              ) : null
            })()}
          </div>
        </div>

        <p className="text-[10.5px] text-muted">Độ cao hợp lệ: {loM.toFixed(2)}–{hiM.toFixed(2)} m (nhập mét, tự kẹp)</p>
        <div className="space-y-1.5">
          {sorted.map((kf, idx) => {
            const active = selectedKeyId === kf.id
            const timelineTime = Number((clip.startTime + kf.offset).toFixed(4))
            const hM = Number(kf.height.toFixed(3))
            const prevTimelineTime = idx > 0 ? Number((clip.startTime + sorted[idx - 1].offset).toFixed(4)) : bounds.minStart
            const nextTimelineTime =
              idx < sorted.length - 1
                ? Number((clip.startTime + sorted[idx + 1].offset).toFixed(4))
                : bounds.maxEnd

            return (
              <div
                key={kf.id}
                onClick={() => onSelectKey(kf.id)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-xl px-2 py-1.5 transition ${
                  active
                    ? 'bg-brand/22 shadow-[inset_0_0_0_2px_var(--acc),0_0_16px_-6px_rgba(247,132,46,0.7)]'
                    : 'bg-black/30 opacity-80 shadow-[inset_0_0_0_1px_var(--line)] hover:opacity-100'
                }`}
              >
                <span
                  className={`inline-flex w-7 shrink-0 items-center justify-center rounded-md py-0.5 text-[10.5px] transition ${
                    active ? 'bg-brand font-bold text-[#1C0E04]' : 'font-semibold text-info'
                  }`}
                >
                  P{idx + 1}
                </span>
                <label className="flex min-w-0 flex-1 items-center gap-0.5">
                  <input
                    type="number"
                    step="0.1"
                    min={bounds.minStart}
                    max={Number.isFinite(bounds.maxEnd) ? bounds.maxEnd : undefined}
                    title="Thời gian của điểm trên Timeline (s)"
                    value={draftTime?.id === kf.id ? draftTime.raw : timelineTime}
                    onFocus={() => {
                      onSelectKey(kf.id)
                      setDraftTime({ id: kf.id, raw: String(timelineTime) })
                    }}
                    onChange={(e) => {
                      const raw = e.target.value
                      setDraftTime({ id: kf.id, raw })
                      if (!raw.trim() || raw.endsWith('.')) return
                      const num = Number(raw)
                      if (Number.isFinite(num) && num >= prevTimelineTime && num <= nextTimelineTime) {
                        commitTimelineTime(kf.id, num)
                      }
                    }}
                    onBlur={() => {
                      if (draftTime?.id === kf.id) {
                        const num = Number(draftTime.raw)
                        if (draftTime.raw.trim() && Number.isFinite(num)) commitTimelineTime(kf.id, num)
                        setDraftTime(null)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    className={`w-full min-w-0 bg-transparent text-right text-[11px] tabular-nums outline-none ${
                      active ? 'font-semibold text-fg' : 'text-fg'
                    }`}
                  />
                  <span className="text-[10px] text-muted">s</span>
                </label>
                <span className="text-muted">·</span>
                <label className="flex min-w-0 flex-1 items-center gap-0.5">
                  <input
                    type="number"
                    step="0.01"
                    min={loM}
                    max={hiM}
                    title={`Độ cao (m), hợp lệ ${loM.toFixed(2)}–${hiM.toFixed(2)} m`}
                    value={draftPct?.id === kf.id ? draftPct.raw : hM}
                    onFocus={() => {
                      onSelectKey(kf.id)
                      setDraftPct({ id: kf.id, raw: String(hM) })
                    }}
                    onChange={(e) => {
                      const raw = e.target.value
                      setDraftPct({ id: kf.id, raw })
                      if (!raw.trim() || raw.endsWith('.')) return
                      const num = Number(raw)
                      if (Number.isFinite(num)) commitHeight(kf.id, num)
                    }}
                    onBlur={() => {
                      if (draftPct?.id === kf.id) {
                        const num = Number(draftPct.raw)
                        if (draftPct.raw.trim() && Number.isFinite(num)) commitHeight(kf.id, num)
                        setDraftPct(null)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    className={`w-full min-w-0 bg-transparent text-right text-[11px] tabular-nums outline-none ${
                      active ? 'font-semibold text-[#FFD08A]' : 'text-[#FFB26B]'
                    }`}
                  />
                  <span className="text-[10px] text-muted">m</span>
                </label>
                {sorted.length > 2 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      const nextKfs = removeClipKeyframe(clip, kf.id)
                      if (nextKfs) onUpdate({ keyframes: nextKfs })
                    }}
                    title="Xoá điểm"
                    className="cursor-pointer px-0.5 text-muted hover:text-danger"
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {(() => {
        const idx = sorted.findIndex((k) => k.id === selectedKeyId)
        if (idx < 0) return null
        const kf = sorted[idx]
        const next = sorted[idx + 1]
        if (!next) {
          return <p className="text-[10.5px] text-muted">Điểm cuối: không có đoạn kế tiếp nên không đặt tốc độ.</p>
        }
        const cap = speedCap(mod)
        const distCm = segmentDistCm(mod, kf.height, next.height)
        const dt = next.offset - kf.offset
        const r = resolveKeyframeSpeed(kf, distCm, dt, cap, clipAutoSpeedCms(mod, clip))
        const secs = cmsToSeconds(distCm, r.cms)
        const setSpeed = (patch: Partial<ClipKeyframe>) =>
          onUpdate({ keyframes: sorted.map((k) => (k.id === kf.id ? { ...k, ...patch } : k)) }, `kfspd-${kf.id}`)
        const commitCms = (v: number) => {
          const nextCms = clamp(v, 1, cap)
          if (nextCms !== kf.manualSpeedCms) setSpeed({ speedMode: 'manual', manualSpeedCms: nextCms })
        }
        return (
          <div className="space-y-1.5 border-t border-line pt-2.5">
            <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">
              Tốc độ đoạn P{idx + 1} → P{idx + 2}
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/30 p-0.5 shadow-[inset_0_0_0_1px_var(--line)]" role="group" aria-label="Chế độ tốc độ">
              {(['auto', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={r.mode === m}
                  onClick={() =>
                    setSpeed(
                      m === 'auto'
                        ? { speedMode: undefined, manualSpeedCms: undefined }
                        : { speedMode: 'manual', manualSpeedCms: Number(r.autoCms.toFixed(1)) },
                    )
                  }
                  className={`cursor-pointer rounded-[10px] py-1 text-[11px] font-semibold capitalize transition ${
                    r.mode === m ? 'bg-brand/25 text-[#FFB26B]' : 'text-muted hover:text-fg'
                  }`}
                >
                  {m === 'auto' ? 'Auto' : 'Manual'}
                </button>
              ))}
            </div>
            {r.mode === 'auto' ? (
              <div className="flex items-center justify-between text-[11px] text-[#C2B3A4]">
                <span>Tự tính (chỉ đọc)</span>
                <span className="tabular-nums">
                  {r.autoCms.toFixed(1)} cm/s{cmsToSeconds(distCm, r.autoCms) !== null ? ` · ${cmsToSeconds(distCm, r.autoCms)!.toFixed(2)} s` : ''}
                </span>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px] text-[#C2B3A4]">
                  <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-black/30 p-0.5" role="group" aria-label="Đơn vị tốc độ">
                    {(['cms', 'sec'] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        aria-pressed={speedUnit === u}
                        onClick={() => setSpeedUnit(u)}
                        className={`cursor-pointer rounded-md px-2 py-0.5 text-[10.5px] font-semibold ${
                          speedUnit === u ? 'bg-brand/25 text-[#FFB26B]' : 'text-muted hover:text-fg'
                        }`}
                      >
                        {u === 'cms' ? 'cm/s' : 's'}
                      </button>
                    ))}
                  </div>
                  {speedUnit === 'cms' || secs === null ? (
                    <input
                      key={`${kf.id}-cms-${kf.manualSpeedCms}`}
                      type="number"
                      min={1}
                      max={cap}
                      step={1}
                      disabled={speedUnit === 'sec'}
                      defaultValue={Number(r.cms.toFixed(1))}
                      onBlur={(e) => {
                        const v = e.currentTarget.valueAsNumber
                        const n = Number.isFinite(v) ? clamp(v, 1, cap) : r.cms
                        e.currentTarget.value = String(n)
                        commitCms(n)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                      className="kiln-field h-7 w-24 px-2.5 text-xs tabular-nums"
                    />
                  ) : (
                    <input
                      key={`${kf.id}-sec-${kf.manualSpeedCms}`}
                      type="number"
                      min={Number((distCm / cap).toFixed(2))}
                      max={Number(distCm.toFixed(2))}
                      step={0.1}
                      defaultValue={Number(secs.toFixed(2))}
                      onBlur={(e) => {
                        const v = e.currentTarget.valueAsNumber
                        const n = Number.isFinite(v) ? secondsToCms(distCm, v, cap) : null
                        if (n !== null) commitCms(n)
                        else e.currentTarget.value = String(Number(secs.toFixed(2)))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                      className="kiln-field h-7 w-24 px-2.5 text-xs tabular-nums"
                    />
                  )}
                </div>
                <div className="text-[10.5px] text-muted tabular-nums">
                  {speedUnit === 'cms' ? (secs !== null ? `≈ ${secs.toFixed(2)} s cho ${distCm.toFixed(1)} cm` : 'Quãng đường = 0') : `≈ ${r.cms.toFixed(1)} cm/s`}
                  {' · '}CH3 {cmsToCh3(r.cms, cap)} (255 = {cap} cm/s; khuyến nghị CH3=100 ≈ {((100 / 255) * cap).toFixed(1)} cm/s)
                </div>
                {speedUnit === 'sec' && secs === null && (
                  <p className="text-[10.5px] text-muted">Quãng đường = 0: không đổi được sang giây, nhập theo cm/s.</p>
                )}
              </div>
            )}
            {r.mode === 'manual' && r.tooSlow && (
              <p className="flex items-start gap-1 text-[10.5px] text-warn">
                <AlertTriangle size={11} className="mt-px shrink-0" />
                Quá chậm: cần {(distCm / r.cms).toFixed(2)}s, đoạn chỉ có {dt.toFixed(2)}s (auto: {r.autoCms.toFixed(1)} cm/s).
              </p>
            )}
            {r.mode === 'manual' && r.overMax && (
              <p className="flex items-start gap-1 text-[10.5px] text-warn">
                <AlertTriangle size={11} className="mt-px shrink-0" />
                Vượt tối đa {cap} cm/s: đã kẹp.
              </p>
            )}
            {distCm / Math.max(0.001, dt) > cap + 1e-3 && (
              <p className="flex items-start gap-1 text-[10.5px] text-warn">
                <AlertTriangle size={11} className="mt-px shrink-0" />
                Vượt tốc độ tối đa {cap} cm/s: đoạn này không kịp thời gian.
              </p>
            )}
          </div>
        )
      })()}
    </div>
  )
}

function CueButtonEditor({
  btn,
  layers,
  modules,
  snapshotModules,
  onSave,
  onDelete,
  onBack,
}: {
  btn: CueButton
  layers: Layer[]
  modules: ModuleCfg[]
  snapshotModules: Record<string, { pos: number }>
  onSave: (next: CueButton, coalesceKey?: string) => void
  onDelete: () => void
  onBack: () => void
}) {
  const [heightUnit, setHeightUnit] = useState<'m' | 'pct'>('m')
  const [globalHeight, setGlobalHeight] = useState('1')
  const stepMap = new Map(btn.steps.map((s) => [s.moduleId, s.position]))
  const refMod = modules[0] ?? { minHeight: 0, maxHeight: 1, length: 1 }

  const switchHeightUnit = (nextUnit: 'm' | 'pct') => {
    if (nextUnit === heightUnit) return
    const cur = Number(globalHeight)
    if (Number.isFinite(cur)) {
      const converted =
        nextUnit === 'pct'
          ? heightToPercent(cur, refMod)
          : Number(percentToHeight(cur, refMod).toFixed(2))
      setGlobalHeight(String(converted))
    }
    setHeightUnit(nextUnit)
  }

  const toggleModule = (m: ModuleCfg) => {
    const exists = btn.steps.some((s) => s.moduleId === m.id)
    const steps = exists
      ? btn.steps.filter((s) => s.moduleId !== m.id)
      : [...btn.steps, { moduleId: m.id, position: Number((snapshotModules[m.id]?.pos ?? m.minHeight).toFixed(2)) }]
    onSave({ ...btn, steps })
  }

  const setModuleHeight = (m: ModuleCfg, rawPos: number) => {
    const pos = Number(clamp(rawPos, m.minHeight, m.maxHeight).toFixed(2))
    const exists = btn.steps.some((s) => s.moduleId === m.id)
    const steps = exists
      ? btn.steps.map((s) => (s.moduleId === m.id ? { ...s, position: pos } : s))
      : [...btn.steps, { moduleId: m.id, position: pos }]
    onSave({ ...btn, steps }, `cue-mod-${btn.id}-${m.id}`)
  }

  const toggleLayerInButton = (layerId: string) => {
    const mods = modules.filter((m) => m.layerId === layerId)
    const modIds = new Set(mods.map((m) => m.id))
    const allChecked = mods.length > 0 && mods.every((m) => stepMap.has(m.id))
    if (allChecked) {
      onSave({ ...btn, steps: btn.steps.filter((s) => !modIds.has(s.moduleId)) })
      return
    }
    const nextSteps = [...btn.steps]
    for (const m of mods) {
      if (!nextSteps.some((s) => s.moduleId === m.id)) {
        nextSteps.push({ moduleId: m.id, position: Number((snapshotModules[m.id]?.pos ?? m.minHeight).toFixed(2)) })
      }
    }
    onSave({ ...btn, steps: nextSteps })
  }

  const applyAllSelectedLayersHeight = (rawVal: number) => {
    const modById = new Map(modules.map((m) => [m.id, m]))
    const toTargetHeight = (m: ModuleCfg) => {
      const nextPos = heightUnit === 'pct' ? percentToHeight(rawVal, m) : rawVal
      return Number(clamp(nextPos, m.minHeight, m.maxHeight).toFixed(2))
    }
    if (btn.steps.length > 0) {
      const steps = btn.steps.map((s) => {
        const m = modById.get(s.moduleId)
        return m ? { ...s, position: toTargetHeight(m) } : s
      })
      onSave({ ...btn, steps })
      return
    }
    const steps = modules.map((m) => ({
      moduleId: m.id,
      position: toTargetHeight(m),
    }))
    onSave({ ...btn, steps })
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line pb-2.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onBack}
            title="Quay lại thông số Module / Layer"
            className="kiln-btn h-6 px-2.5 text-[11px] text-[#C2B3A4]"
          >
            <ArrowLeft size={12} />
            Module
          </button>
          <span className="kiln-chip cue uppercase">NÚT CUE ({btn.steps.length})</span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          title="Xoá nút Cue (Delete)"
          aria-label="Xoá nút Cue"
          className="cursor-pointer rounded-full p-1 text-muted hover:bg-danger/20 hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[11px] text-[#C2B3A4]">Tên nút Cue</span>
        <input
          value={btn.name}
          onChange={(e) => onSave({ ...btn, name: e.target.value }, `cue-name-${btn.id}`)}
          placeholder="Tên nút điều khiển"
          className="kiln-field h-9 w-full px-3 text-xs"
        />
      </label>

      <div className="space-y-1.5 border-b border-line pb-3">
        <span className="text-[11px] text-[#C2B3A4]">Thời lượng chạy</span>
        <div className="flex items-center gap-2">
          <div className="kiln-seg flex-1">
            {(
              [
                ['sec', 'Giây (s)'],
                ['cms', 'cm/s'],
              ] as const
            ).map(([unit, label]) => (
              <button
                key={unit}
                type="button"
                onClick={() => {
                  if (btn.speedUnit !== unit) onSave({ ...btn, speedUnit: unit as SpeedUnit, autoSpeedLimitCms: undefined })
                }}
                className={`kiln-seg-btn h-7 flex-1 px-2.5 text-[11px] ${btn.speedUnit === unit ? 'on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            type="number"
            min="0.5"
            step="0.5"
            aria-label="Giá trị tốc độ hoặc thời gian nút Cue"
            value={btn.speedValue}
            onChange={(e) =>
              onSave({ ...btn, speedValue: Math.max(0.1, Number(e.target.value) || 1), autoSpeedLimitCms: undefined }, `cue-spd-${btn.id}`)
            }
            className="kiln-field h-8 w-24 px-3 text-right text-xs tabular-nums"
          />
        </div>
      </div>

      <div className="space-y-2.5">
        <span className="block text-[11px] font-semibold tracking-wide text-muted uppercase">
          LAYER &amp; MODULE CHẠY
        </span>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                onSave({
                  ...btn,
                  steps: modules.map((m) => ({
                    moduleId: m.id,
                    position: Number((stepMap.get(m.id) ?? snapshotModules[m.id]?.pos ?? m.minHeight).toFixed(2)),
                  })),
                })
              }
              className="kiln-btn kiln-btn-cue h-7 px-3 text-[11px]"
            >
              Chọn hết
            </button>
            <button
              type="button"
              onClick={() => onSave({ ...btn, steps: [] })}
              className="kiln-btn h-7 px-3 text-[11px]"
            >
              Bỏ chọn
            </button>
          </div>

          <div className="kiln-seg" role="group" aria-label="Chế độ đơn vị chiều cao">
            {(
              [
                ['m', 'm'],
                ['pct', '%'],
              ] as const
            ).map(([unit, label]) => (
              <button
                key={unit}
                type="button"
                onClick={() => switchHeightUnit(unit)}
                aria-pressed={heightUnit === unit}
                className={`kiln-seg-btn h-7 px-2.5 text-[11px] font-semibold ${heightUnit === unit ? 'on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="kiln-field flex h-8 w-24 items-center rounded-full px-2.5">
            <input
              type="number"
              step={heightUnit === 'pct' ? '1' : '0.1'}
              min="0"
              max={heightUnit === 'pct' ? '100' : undefined}
              aria-label={`Chiều cao áp dụng cho các layer (${heightUnit === 'pct' ? '%' : 'm'})`}
              value={globalHeight}
              onChange={(e) => setGlobalHeight(e.target.value)}
              className="w-full min-w-0 border-0 bg-transparent text-center text-xs text-fg tabular-nums outline-none"
            />
            <button
              type="button"
              onClick={() => switchHeightUnit(heightUnit === 'm' ? 'pct' : 'm')}
              title="Đổi đơn vị m / %"
              className="shrink-0 cursor-pointer pl-1 text-[11px] font-medium text-muted hover:text-fg"
            >
              {heightUnit === 'pct' ? '%' : 'm'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => applyAllSelectedLayersHeight(Number(globalHeight) || 0)}
            className="kiln-btn kiln-btn-cue h-8 flex-1 justify-start px-3.5 text-[11.5px] font-semibold"
          >
            Áp dụng cho các layer
          </button>
        </div>

        <div className="space-y-2.5">
          {layers.map((layer) => {
            const mods = modules.filter((m) => m.layerId === layer.id)
            const selectedCount = mods.filter((m) => stepMap.has(m.id)).length
            const allChecked = mods.length > 0 && selectedCount === mods.length

            return (
              <div key={layer.id} className="kiln-layer space-y-1.5 p-2.5">
                <div className="flex items-center justify-between gap-2 pb-1">
                  <label className="flex cursor-pointer items-center gap-2 font-semibold text-info">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() => toggleLayerInButton(layer.id)}
                      className="h-4 w-4 rounded accent-brand"
                    />
                    <span>{layer.name}</span>
                  </label>
                  <span className="text-[11px] text-muted tabular-nums">
                    {selectedCount}/{mods.length}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {mods.map((m) => {
                    const checked = stepMap.has(m.id)
                    const pos = stepMap.get(m.id) ?? m.minHeight
                    const displayVal = heightUnit === 'pct' ? heightToPercent(pos, m) : pos
                    return (
                      <div
                        key={m.id}
                        className={`flex h-8 items-center justify-between gap-2 rounded-full px-2.5 transition ${
                          checked
                            ? 'bg-black/35 shadow-[inset_0_0_0_1.5px_#f7842e]'
                            : 'bg-black/15 opacity-60 shadow-[inset_0_0_0_1px_var(--line)]'
                        }`}
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleModule(m)}
                            className="h-4 w-4 shrink-0 rounded accent-brand"
                          />
                          <span className="truncate text-[11.5px]" title={`${m.name} (${m.minHeight}–${m.maxHeight}m)`}>
                            {m.name}
                          </span>
                        </label>
                        <div className="flex h-6 w-20 items-center rounded-full bg-white/[0.06] px-2 focus-within:ring-1 focus-within:ring-brand">
                          <input
                            type="number"
                            step={heightUnit === 'pct' ? '1' : '0.1'}
                            min={heightUnit === 'pct' ? 0 : m.minHeight}
                            max={heightUnit === 'pct' ? 100 : m.maxHeight}
                            aria-label={`${m.name} (${heightUnit === 'pct' ? '%' : 'm'})`}
                            value={displayVal}
                            onChange={(e) => {
                              const raw = Number(e.target.value) || 0
                              const nextM = heightUnit === 'pct' ? percentToHeight(raw, m) : raw
                              setModuleHeight(m, nextM)
                            }}
                            className="w-full min-w-0 border-0 bg-transparent text-center text-[11.5px] text-fg tabular-nums outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => switchHeightUnit(heightUnit === 'm' ? 'pct' : 'm')}
                            title="Đổi đơn vị m / %"
                            className="shrink-0 cursor-pointer pl-0.5 text-[10.5px] font-medium text-muted hover:text-fg"
                          >
                            {heightUnit === 'pct' ? '%' : 'm'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function PropertiesPanel(props: {
  overrideState?: Partial<ReturnType<typeof useAppStore.getState>>
}) {
  const overrideState = props?.overrideState
  const storeState = useAppStore()
  const {
    project,
    focusScope,
    activeTab,
    selectedIds,
    selectedLayerId,
    selectedButtonId,
    selectedClipId,
    selectedClipIds,
    selectedKeyId,
    snapshot,
    playheadTime,
    updateLayer,
    toggleLayerVisibility,
    toggleLayerSync,
    updateModule,
    updateModulesBatch,
    setModulesDmxLoop,
    setAddressMode,
    selectButton,
    saveButton,
    deleteButton,
    setFocusScope,
    selectTimelineClip,
    selectTimelineKey,
    updateClip,
    deleteClip,
    deleteSelection,
    applyPresetToSelectedClips,
    updateSelectedClipsTiming,
    applyLayerMotionPreset,
    syncLayerFromModule,
    notify,
  } = overrideState ? { ...storeState, ...overrideState } : storeState

  const activeButton =
    focusScope === 'buttons' && selectedButtonId
      ? project.buttons.find((b) => b.id === selectedButtonId) ?? null
      : null
  const selectedClips = (project.clips ?? []).filter((c) => selectedClipIds.includes(c.id))
  const activeClip = selectedClipId ? (project.clips ?? []).find((c) => c.id === selectedClipId) ?? null : null
  const activeClipMod = activeClip ? project.modules.find((m) => m.id === activeClip.moduleId) ?? null : null
  const activeLayer = selectedLayerId ? project.layers.find((l) => l.id === selectedLayerId) ?? null : null
  const activeLayerIdx = activeLayer ? project.layers.findIndex((l) => l.id === activeLayer.id) : 0

  const selected = project.modules.filter((m) => selectedIds.includes(m.id))
  const single = !activeLayer && selected.length === 1 ? selected[0] : null
  const isAuto = project.settings.addressMode === 'auto'

  const [addrInput, setAddrInput] = useState('')
  const [addrError, setAddrError] = useState<string | null>(null)
  const [layerPresetDur, setLayerPresetDur] = useState(4)
  const [waveAmplitudeCm, setWaveAmplitudeCm] = useState(DEFAULT_ALTERNATING_WAVE_AMPLITUDE_CM)
  const [waveFirstUp, setWaveFirstUp] = useState<'odd' | 'even'>('odd')
  const [layerStagger, setLayerStagger] = useState(0.35)
  const [draftGroupStart, setDraftGroupStart] = useState<{ key: string; raw: string } | null>(null)
  const [draftGroupEnd, setDraftGroupEnd] = useState<{ key: string; raw: string } | null>(null)
  const [draftModField, setDraftModField] = useState<{ key: string; raw: string } | null>(null)
  const [groupModError, setGroupModError] = useState<string | null>(null)

  useEffect(() => {
    if (single) {
      setAddrInput(String(single.startAddress))
      setAddrError(null)
    }
  }, [single?.id, single?.startAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trang cấu hình nút Cue (Custom): chọn Layer/Module & chiều cao trực tiếp trên panel Thông số
  if (activeButton) {
    return (
      <CueButtonEditor
        btn={activeButton}
        layers={project.layers}
        modules={project.modules}
        snapshotModules={snapshot?.modules ?? {}}
        onSave={saveButton}
        onDelete={() => deleteButton(activeButton.id)}
        onBack={() => {
          selectButton(null)
          setFocusScope('tree')
        }}
      />
    )
  }

  // Trang thuộc tính nhóm khi chọn nhiều Moment bằng kéo vùng chuột phải
  if (selectedClips.length > 1) {
    const groupKey = selectedClips.map((c) => c.id).join(',')
    const modes = new Set(selectedClips.map((c) => c.curveMode ?? 'smooth'))
    const commonMode = modes.size === 1 ? [...modes][0] : null
    const modCount = new Set(selectedClips.map((c) => c.moduleId)).size
    const starts = selectedClips.map((c) => Number(c.startTime.toFixed(2)))
    const ends = selectedClips.map((c) => Number((c.startTime + c.duration).toFixed(2)))
    const durs = selectedClips.map((c) => Number(c.duration.toFixed(2)))
    const commonStart = starts.every((v) => Math.abs(v - starts[0]) < 0.005) ? starts[0] : null
    const commonEnd = ends.every((v) => Math.abs(v - ends[0]) < 0.005) ? ends[0] : null
    const commonDur = durs.every((v) => Math.abs(v - durs[0]) < 0.005) ? durs[0] : null
    const modById = new Map(project.modules.map((m) => [m.id, m]))
    let maxGroupSpeedRatio = 0
    let groupSpeedOver = false
    for (const c of selectedClips) {
      const m = modById.get(c.moduleId)
      if (!m) continue
      const issues = analyzeClipSpeeds(c, m)
      for (const issue of issues) {
        if (!issue.feasible) groupSpeedOver = true
        const ratio = speedCap(m) > 0 ? issue.requiredCms / speedCap(m) : 0
        if (ratio > maxGroupSpeedRatio) maxGroupSpeedRatio = ratio
      }
    }

    const commitGroupTiming = (kind: 'start' | 'end', raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      const num = Number(trimmed)
      if (!Number.isFinite(num)) return
      updateSelectedClipsTiming(kind === 'start' ? { startTime: num } : { endTime: num })
    }

    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line pb-2.5">
          <span className="kiln-chip acc">Đang chọn {selectedClips.length} moment</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => selectTimelineClip(null)}
              className="kiln-btn h-6 px-2 text-[10.5px] text-[#C2B3A4]"
            >
              Bỏ chọn
            </button>
            <button
              type="button"
              onClick={() => deleteSelection()}
              title="Xoá tất cả moment đang chọn (Delete)"
              aria-label="Xoá tất cả moment đang chọn"
              className="cursor-pointer rounded-full p-1 text-muted hover:bg-danger/20 hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        <div className="space-y-2 border-b border-line pb-3">
          <div className="grid grid-cols-2 gap-1.5">
            <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
              <span className="shrink-0 text-[10px] text-muted">Bắt đầu</span>
              <input
                type="number"
                step="0.1"
                min="0"
                placeholder={commonStart === null ? '—' : undefined}
                aria-label="Thời điểm bắt đầu nhóm (s)"
                value={
                  draftGroupStart?.key === groupKey
                    ? draftGroupStart.raw
                    : commonStart !== null
                      ? String(commonStart)
                      : ''
                }
                onFocus={() =>
                  setDraftGroupStart({ key: groupKey, raw: commonStart !== null ? String(commonStart) : '' })
                }
                onChange={(e) => setDraftGroupStart({ key: groupKey, raw: e.target.value })}
                onBlur={() => {
                  if (draftGroupStart?.key === groupKey) {
                    commitGroupTiming('start', draftGroupStart.raw)
                    setDraftGroupStart(null)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none placeholder:text-muted/60"
              />
              <span className="shrink-0 text-[10px] text-muted">s</span>
            </label>

            <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
              <span className="shrink-0 text-[10px] text-muted">Kết thúc</span>
              <input
                type="number"
                step="0.1"
                min="0.4"
                placeholder={commonEnd === null ? '—' : undefined}
                aria-label="Thời điểm kết thúc nhóm (s)"
                value={
                  draftGroupEnd?.key === groupKey ? draftGroupEnd.raw : commonEnd !== null ? String(commonEnd) : ''
                }
                onFocus={() => setDraftGroupEnd({ key: groupKey, raw: commonEnd !== null ? String(commonEnd) : '' })}
                onChange={(e) => setDraftGroupEnd({ key: groupKey, raw: e.target.value })}
                onBlur={() => {
                  if (draftGroupEnd?.key === groupKey) {
                    commitGroupTiming('end', draftGroupEnd.raw)
                    setDraftGroupEnd(null)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none placeholder:text-muted/60"
              />
              <span className="shrink-0 text-[10px] text-muted">s</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10.5px]">
            <span className="text-muted tabular-nums">
              Độ dài: {commonDur !== null ? `${commonDur.toFixed(2)}s` : '—'}
            </span>
            <div className="flex items-center gap-1.5">
              {commonMode === null && <span className="text-[10px] text-muted">—</span>}
              <div className="kiln-seg shrink-0">
                {(
                  [
                    ['smooth', 'Mượt'],
                    ['linear', 'Thẳng'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => applyPresetToSelectedClips({ curveMode: m })}
                    className={`kiln-seg-btn h-5 px-2 text-[10px] ${commonMode === m ? 'on' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 text-[10.5px]">
            <span className="text-muted">Tốc độ nhóm</span>
            <span className={groupSpeedOver ? 'font-medium text-danger' : 'font-medium text-ok'}>
              {groupSpeedOver
                ? `Vượt tốc độ max (${Math.round(maxGroupSpeedRatio * 100)}%)`
                : `Hợp lệ (${Math.round(maxGroupSpeedRatio * 100)}%)`}
            </span>
          </div>
        </div>

        <div className="space-y-1.5 border-b border-line pb-3">
          <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Áp dụng Mẫu sóng chung
          </span>
          <div className="grid grid-cols-7 gap-1">
            {CURVE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPresetToSelectedClips({ presetId: preset.id })}
                title={preset.label}
                aria-label={`Áp dụng ${preset.label} cho ${selectedClips.length} moment`}
                className="kiln-btn h-7 w-full px-0 text-[#C2B3A4] hover:text-fg"
              >
                <svg width="18" height="11" viewBox="0 0 20 12" aria-hidden="true" className="shrink-0">
                  <polyline
                    fill="none"
                    stroke="#FFB26B"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={preset.points.map(([tx, hy]) => `${(1.5 + tx * 17).toFixed(1)},${(10 - hy * 8).toFixed(1)}`).join(' ')}
                  />
                </svg>
              </button>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-muted">
          Chỉnh đồng loạt {selectedClips.length} moment trên {modCount} module; giá trị khác nhau hiển thị{' '}
          <strong>—</strong> và chỉ ghi đè khi bạn sửa. Chọn 1 moment để chỉnh chi tiết từng điểm P1..Pn.
        </p>
      </div>
    )
  }

  // Trang thuộc tính riêng cho Moment đang chọn trên Timeline
  if (activeClip && activeClipMod) {
    return (
      <MomentEditor
        clip={activeClip}
        allClips={project.clips ?? []}
        mod={activeClipMod}
        selectedKeyId={selectedKeyId}
        onSelectKey={selectTimelineKey}
        onBackToModule={() => selectTimelineClip(null)}
        onUpdate={(patch, coalesceKey, syncEdge) => updateClip(activeClip.id, patch, coalesceKey, syncEdge)}
        onDelete={() => deleteClip(activeClip.id)}
        onPresetOverlap={() => notify('Không đủ chỗ để áp dụng mẫu sóng ở tốc độ Auto mặc định', 'warn')}
      />
    )
  }

  // Đang chọn Layer
  if (activeLayer) {
    const tf = activeLayer.transform ?? defaultLayerTransform(activeLayerIdx)
    const visible = activeLayer.visible ?? true
    const synced = activeLayer.syncLayer ?? false
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="kiln-chip acc">
            <Layers size={11} />
            Layer
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => toggleLayerSync(activeLayer.id)}
              title="Đồng bộ toàn bộ module trong lớp này di chuyển giống hệt nhau"
              className={`kiln-btn h-7 px-2.5 text-[11px] ${
                synced ? 'kiln-btn-primary' : 'text-[#C2B3A4]'
              }`}
            >
              <Link2 size={12} />
              {synced ? 'Sync: Bật' : 'Sync Layer'}
            </button>
            <button
              type="button"
              onClick={() => toggleLayerVisibility(activeLayer.id)}
              className="kiln-btn h-7 px-2.5 text-[11px]"
            >
              {visible ? <Eye size={12} className="text-ok" /> : <EyeOff size={12} className="text-warn" />}
              {visible ? 'Hiện' : 'Ẩn'}
            </button>
          </div>
        </div>

        <TransformEditor
          tf={tf}
          onChange={(nextTf) => updateLayer(activeLayer.id, { transform: nextTf }, `layer-tf-${activeLayer.id}`)}
          onReset={() => updateLayer(activeLayer.id, { transform: defaultLayerTransform(activeLayerIdx) })}
        />

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Tên Layer</span>
          <input
            value={activeLayer.name}
            onChange={(e) => updateLayer(activeLayer.id, { name: e.target.value }, `layer-name-${activeLayer.id}`)}
            className="kiln-field h-8 w-full px-3 text-[12.5px] font-medium"
          />
        </label>

        {(() => {
          const layerMods = project.modules.filter((m) => m.layerId === activeLayer.id)
          const presetIcon = (id: LayerMotionPresetId) => {
            if (id === 'all-up') return <ArrowUp size={12} className="shrink-0 text-[#FFB26B]" />
            if (id === 'all-down') return <ArrowDown size={12} className="shrink-0 text-[#FFB26B]" />
            return <Waves size={12} className="shrink-0 text-[#FFB26B]" />
          }
          return (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-[#FFB26B] uppercase">
                  Hiệu ứng chuyển động
                </span>
                <span className="text-[10px] text-muted tabular-nums">
                  {playheadTime.toFixed(2)}s · {layerMods.length} mod
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
                  <span className="shrink-0 text-[10px] text-muted">Thời lượng tối thiểu</span>
                  <input
                    type="number"
                    step="0.2"
                    min="0.4"
                    value={layerPresetDur}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v >= 0.4) setLayerPresetDur(v)
                    }}
                    className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
                  />
                  <span className="shrink-0 text-[10px] text-muted">s</span>
                </label>

                <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
                  <span className="shrink-0 text-[10px] text-muted">Lệch sóng</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    value={layerStagger}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v >= 0) setLayerStagger(v)
                    }}
                    className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
                  />
                  <span className="shrink-0 text-[10px] text-muted">s</span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {LAYER_MOTION_PRESETS.filter((preset) => preset.id !== 'alternating-wave').map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={layerMods.length === 0}
                    onClick={() =>
                      applyLayerMotionPreset(activeLayer.id, preset.id, {
                        duration: layerPresetDur,
                        staggerSec: layerStagger,
                      })
                    }
                    className="kiln-btn h-8 justify-start gap-1.5 px-2.5 text-[11px] text-fg disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {presetIcon(preset.id)}
                    <span className="truncate">{preset.label}</span>
                  </button>
                ))}
              </div>

              {activeTab === 'timeline' && (
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
                    <span className="shrink-0 text-[10px] text-muted">Biên độ</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={waveAmplitudeCm}
                      onChange={(e) => {
                        const value = Number(e.target.value)
                        if (Number.isFinite(value) && value >= 0) setWaveAmplitudeCm(value)
                      }}
                      className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
                    />
                    <span className="shrink-0 text-[10px] text-muted">cm</span>
                  </label>
                  <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
                    <span className="shrink-0 text-[10px] text-muted">Lên trước</span>
                    <select
                      value={waveFirstUp}
                      onChange={(e) => setWaveFirstUp(e.target.value === 'even' ? 'even' : 'odd')}
                      className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg outline-none"
                    >
                      <option value="odd">Lẻ</option>
                      <option value="even">Chẵn</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={layerMods.length === 0}
                    onClick={() => applyLayerMotionPreset(activeLayer.id, 'alternating-wave', {
                      duration: layerPresetDur,
                      amplitudeCm: waveAmplitudeCm,
                      firstUp: waveFirstUp,
                    })}
                    className="kiln-btn col-span-2 h-8 justify-start gap-1.5 px-2.5 text-[11px] text-fg disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {presetIcon('alternating-wave')}
                    Thêm cue Sóng so le · ≥ {layerPresetDur}s
                  </button>
                </div>
              )}

              <p className="text-[10.5px] text-muted">
                {layerMods.length === 0
                  ? 'Layer này chưa có module để tạo hiệu ứng.'
                  : 'Tạo moment trên Timeline tại vị trí playhead để xem và tinh chỉnh trước khi chạy.'}
              </p>
            </div>
          )
        })()}

        <p className="border-t border-line pt-3 text-[11px] text-muted">
          Toàn bộ module trong lớp giữ cạnh trên dính vào thanh truss của Layer. Bật <strong>Sync Layer</strong> để các module trong lớp chạy đồng nhất mọi chuyển động.
        </p>
      </div>
    )
  }

  if (selected.length === 0) {
    return <p className="text-xs text-muted">Chọn một Layer hoặc Module bên Layers để chỉnh thông số.</p>
  }

  if (!single) {
    const modGroupKey = selected.map((m) => m.id).join(',')
    const selectedIdsList = selected.map((m) => m.id)
    const allLoop = selected.every((m) => m.dmxLoop)
    const someLoop = selected.some((m) => m.dmxLoop)

    const commonStr = (vals: string[]): string | null =>
      vals.every((v) => v === vals[0]) ? vals[0] : null
    const commonNum = (vals: number[], eps = 0.005): number | null =>
      vals.every((v) => Math.abs(v - vals[0]) <= eps) ? vals[0] : null

    const commonName = commonStr(selected.map((m) => m.name))
    const commonLayerId = commonStr(selected.map((m) => m.layerId)) ?? ''
    const commonAddr = commonNum(selected.map((m) => m.startAddress), 0)
    const commonLength = commonNum(selected.map((m) => m.length))
    const commonWidth = commonNum(selected.map((m) => m.width))
    const commonMinH = commonNum(selected.map((m) => m.minHeight))
    const commonMaxH = commonNum(selected.map((m) => m.maxHeight))
    const commonMaxSpd = commonNum(selected.map((m) => m.maxSpeedCms), 0.5)
    const commonDefSpd = commonNum(selected.map((m) => m.defaultSpeed), 0)

    const tfCommon = (field: keyof Transform3D, idx: 0 | 1 | 2): number | null =>
      commonNum(
        selected.map((m) => Number(((m.transform ?? defaultModuleTransform())[field][idx]).toFixed(2))),
      )

    const frame = snapshot?.frame ?? []
    const posCmVals = selected.map((m) => Math.round((snapshot?.modules[m.id]?.pos ?? 0) * 100))
    const tgtCmVals = selected.map((m) => Math.round((snapshot?.modules[m.id]?.target ?? 0) * 100))
    const commonPosCm = commonNum(posCmVals, 0)
    const commonTgtCm = commonNum(tgtCmVals, 0)
    const chVals = (offset: number) =>
      commonNum(
        selected.map((m) => frame[m.startAddress - 1 + offset] ?? 0),
        0,
      )

    const commitModBatch = (key: string, fn: (raw: string) => string | null) => {
      if (draftModField?.key !== `${modGroupKey}:${key}`) return
      const raw = draftModField.raw
      setDraftModField(null)
      if (!raw.trim()) return
      const err = fn(raw)
      setGroupModError(err)
      if (err) notify(err, 'warn')
    }

    const renderNumField = (
      fieldKey: string,
      label: string,
      commonVal: number | null,
      opts: { step?: string; min?: string; max?: string; onCommit: (num: number) => string | null },
    ) => {
      const fullKey = `${modGroupKey}:${fieldKey}`
      const isEditing = draftModField?.key === fullKey
      return (
        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">{label}</span>
          <input
            type="number"
            step={opts.step}
            min={opts.min}
            max={opts.max}
            placeholder={commonVal === null ? '—' : undefined}
            aria-label={label}
            value={isEditing ? draftModField.raw : commonVal !== null ? String(commonVal) : ''}
            onFocus={() => setDraftModField({ key: fullKey, raw: commonVal !== null ? String(commonVal) : '' })}
            onChange={(e) => setDraftModField({ key: fullKey, raw: e.target.value })}
            onBlur={() =>
              commitModBatch(fieldKey, (raw) => {
                const n = Number(raw)
                return Number.isFinite(n) ? opts.onCommit(n) : null
              })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums placeholder:text-muted/60"
          />
        </label>
      )
    }

    const axes = ['X', 'Y', 'Z'] as const

    return (
      <div className="space-y-3.5 overflow-y-auto pr-0.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="kiln-chip acc">Đang chọn {selected.length} module</span>
        </div>

        <div className="space-y-2.5 border-b border-line pb-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Transform 3D</span>
            <button
              type="button"
              onClick={() => {
                setGroupModError(null)
                updateModulesBatch(selectedIdsList, { resetTransform: true })
              }}
              title="Đưa Position / Rotation / Scale về mặc định cho tất cả module đang chọn"
              className="kiln-btn h-6 px-2 text-[10.5px] text-[#C2B3A4]"
            >
              <RotateCcw size={11} />
              Mặc định
            </button>
          </div>

          {(
            [
              ['position', 'Vị trí World (m)', 0.1],
              ['rotation', 'Xoay (°)', 5],
              ['scale', 'Tỉ lệ (Scale)', 0.1],
            ] as const
          ).map(([field, label, step]) => (
            <div key={field} className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[#C2B3A4]">
                <span>{label}</span>
                {field === 'position' && <span className="text-[10px] text-[#FFB26B]">Y dính vào Layer</span>}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {axes.map((ax, idx) => {
                  const disabled = field === 'position' && idx === 1
                  const commonAxis = disabled ? 0 : tfCommon(field, idx as 0 | 1 | 2)
                  const tfKey = `${modGroupKey}:tf:${field}:${idx}`
                  const isEditing = draftModField?.key === tfKey
                  return (
                    <label key={ax} className="kiln-field flex h-7 items-center gap-1 px-2">
                      <span className="text-[10px] font-semibold text-muted">{ax}</span>
                      <input
                        type="number"
                        step={step}
                        disabled={disabled}
                        placeholder={commonAxis === null ? '—' : undefined}
                        aria-label={`${label} ${ax}`}
                        value={isEditing ? draftModField.raw : commonAxis !== null ? String(commonAxis) : ''}
                        onFocus={() =>
                          setDraftModField({ key: tfKey, raw: commonAxis !== null ? String(commonAxis) : '' })
                        }
                        onChange={(e) => setDraftModField({ key: tfKey, raw: e.target.value })}
                        onBlur={() =>
                          commitModBatch(`tf:${field}:${idx}`, (raw) => {
                            const n = Number(raw)
                            return Number.isFinite(n)
                              ? updateModulesBatch(selectedIdsList, {
                                  transformAxis: { field, index: idx as 0 | 1 | 2, value: n },
                                })
                              : null
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        className="min-w-0 flex-1 bg-transparent text-right text-[11.5px] text-fg tabular-nums outline-none placeholder:text-muted/60 disabled:opacity-45"
                      />
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Tên module (thêm số thứ tự tự động)</span>
          <input
            placeholder={commonName === null ? '—' : undefined}
            aria-label="Tên module nhóm"
            value={
              draftModField?.key === `${modGroupKey}:name`
                ? draftModField.raw
                : commonName ?? ''
            }
            onFocus={() => setDraftModField({ key: `${modGroupKey}:name`, raw: commonName ?? '' })}
            onChange={(e) => setDraftModField({ key: `${modGroupKey}:name`, raw: e.target.value })}
            onBlur={() =>
              commitModBatch('name', (raw) => updateModulesBatch(selectedIdsList, { nameBase: raw }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="kiln-field h-8 w-full px-2.5 text-xs placeholder:text-muted/60"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Lớp (Layer)</span>
          <select
            aria-label="Lớp (Layer) nhóm"
            value={commonLayerId}
            onChange={(e) => {
              if (!e.target.value) return
              const err = updateModulesBatch(selectedIdsList, { layerId: e.target.value })
              setGroupModError(err)
              if (err) notify(err, 'warn')
            }}
            className="kiln-field h-8 w-full px-2 text-xs"
          >
            {commonLayerId === '' && (
              <option value="" disabled>
                —
              </option>
            )}
            {project.layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
              DMX (UNI {project.settings.output.universe})
            </span>
            <button
              type="button"
              onClick={() => setAddressMode(isAuto ? 'manual' : 'auto')}
              className="text-[11px] text-[#FFB26B] hover:underline"
            >
              {isAuto ? 'Mở nhập tay' : 'Đặt lại tự động'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max="509"
              disabled={isAuto}
              placeholder={commonAddr === null ? '—' : undefined}
              aria-label="Địa chỉ DMX bắt đầu nhóm"
              value={
                draftModField?.key === `${modGroupKey}:addr`
                  ? draftModField.raw
                  : commonAddr !== null
                    ? String(commonAddr)
                    : ''
              }
              onFocus={() =>
                setDraftModField({ key: `${modGroupKey}:addr`, raw: commonAddr !== null ? String(commonAddr) : '' })
              }
              onChange={(e) => {
                setGroupModError(null)
                setDraftModField({ key: `${modGroupKey}:addr`, raw: e.target.value })
              }}
              onBlur={() =>
                commitModBatch('addr', (raw) => {
                  const n = Number(raw)
                  return Number.isFinite(n) ? updateModulesBatch(selectedIdsList, { startAddressBase: n }) : null
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="kiln-field h-8 w-24 px-2.5 text-xs tabular-nums placeholder:text-muted/60 disabled:opacity-55"
            />
            <span className="text-[11px] text-muted tabular-nums">
              {commonAddr !== null ? `Kênh ${commonAddr}–${commonAddr + 3}` : 'Kênh —'}
            </span>
          </div>
          {groupModError && <p className="text-[11px] text-danger">{groupModError}</p>}
          <button
            type="button"
            onClick={() => setModulesDmxLoop(selectedIdsList, !allLoop)}
            title="Dùng chung 4 kênh DMX cho các module trong cùng Layer"
            className={`kiln-btn h-7 w-full justify-start px-2.5 text-[11px] ${
              allLoop ? 'kiln-btn-primary' : 'text-[#C2B3A4]'
            }`}
          >
            <Link2 size={12} />
            {allLoop ? 'Loop DMX: Bật' : someLoop ? 'Loop DMX: —' : 'Loop DMX (Dùng chung 4 kênh)'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
          {renderNumField('length', 'Dài max (m)', commonLength, {
            step: '0.1',
            min: '0.2',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { length: v }),
          })}
          {renderNumField('width', 'Rộng 3D (m)', commonWidth, {
            step: '0.1',
            min: '0.2',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { width: v }),
          })}
          {renderNumField('minHeight', 'Min chiều cao (m)', commonMinH, {
            step: '0.1',
            min: '0',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { minHeight: v }),
          })}
          {renderNumField('maxHeight', 'Max chiều cao (m)', commonMaxH, {
            step: '0.1',
            min: '0.2',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { maxHeight: v }),
          })}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
          {renderNumField('maxSpeedCms', 'Tốc độ max (cm/s)', commonMaxSpd, {
            min: '10',
            max: '500',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { maxSpeedCms: v }),
          })}
          {renderNumField('defaultSpeed', 'CH3 mặc định', commonDefSpd, {
            min: '1',
            max: '255',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { defaultSpeed: v }),
          })}
        </div>

        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold tracking-wide text-muted uppercase">Giám sát 4 kênh DMX</span>
            <span className="text-[#C2B3A4] tabular-nums">
              {commonPosCm !== null ? commonPosCm : '—'} → {commonTgtCm !== null ? commonTgtCm : '—'} cm
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5 text-center text-[11px] tabular-nums">
            {(
              [
                ['CH1 Pos', chVals(CH.POSITION)],
                ['CH2 Fine', chVals(CH.FINE)],
                ['CH3 Spd', chVals(CH.SPEED)],
                ['CH4 Lock', chVals(CH.LOCK)],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="rounded-lg border border-line bg-[#16100C] p-1.5">
                <div className="text-[10px] text-muted">{label}</div>
                <div className="font-semibold text-fg">{v !== null ? v : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const [chStart, chEnd] = addressRange(single.startAddress)
  const baseIdx = single.startAddress - 1
  const frame = snapshot?.frame ?? []
  const ch1 = frame[baseIdx + CH.POSITION] ?? 0
  const ch2 = frame[baseIdx + CH.FINE] ?? 0
  const ch2Fine = single.ch2Fine ?? 0
  const ch3 = frame[baseIdx + CH.SPEED] ?? single.defaultSpeed
  const ch4 = frame[baseIdx + CH.LOCK] ?? 0
  const modTf = single.transform ?? defaultModuleTransform()

  const handleAddrChange = (raw: string) => {
    setAddrInput(raw)
    const num = Number(raw)
    if (!raw.trim() || Number.isNaN(num)) {
      setAddrError('Nhập số nguyên 1–509')
      return
    }
    const err = updateModule(single.id, { startAddress: num })
    setAddrError(err)
  }

  const loopSharedAddr = layerLoopAddress(project.modules, single.layerId, single.id)
  const [loopChStart, loopChEnd] = addressRange(single.dmxLoop ? single.startAddress : loopSharedAddr)
  const modLayerIdx = project.layers.findIndex((l) => l.id === single.layerId)
  const modLayer = modLayerIdx >= 0 ? project.layers[modLayerIdx] : null
  const baseX = computeModuleBasePositions(project.layers, project.modules).get(single.id) ?? 0
  const worldPos = modLayer ? getModuleWorldPosition(modLayer, modLayerIdx, single, baseX) : modTf.position
  const displayModTf: Transform3D = { ...modTf, position: worldPos }

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto pr-0.5 text-xs">
      <TransformEditor
        tf={displayModTf}
        lockY
        onChange={(nextWorldTf) => {
          const nextPos = modLayer
            ? worldPositionToModuleOffset(modLayer, modLayerIdx, baseX, [
                nextWorldTf.position[0],
                worldPos[1],
                nextWorldTf.position[2],
              ])
            : modTf.position
          updateModule(
            single.id,
            { transform: { ...nextWorldTf, position: nextPos } },
            `mod-tf-${single.id}`,
          )
        }}
        onReset={() => updateModule(single.id, { transform: defaultModuleTransform() })}
      />

      <label className="space-y-1">
        <span className="text-[11px] text-[#C2B3A4]">Tên module</span>
        <input
          value={single.name}
          onChange={(e) => updateModule(single.id, { name: e.target.value }, `mod-name-${single.id}`)}
          className="kiln-field h-8 w-full px-3 text-[12.5px] font-medium"
        />
      </label>

      <label className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[#C2B3A4]">Lớp (Layer)</span>
          {project.layers.find((l) => l.id === single.layerId)?.syncLayer && (
            <button
              type="button"
              onClick={() => syncLayerFromModule(single.layerId, single.id)}
              title="Đồng bộ các module còn lại trong Layer theo module đang chọn"
              className="cursor-pointer rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-semibold text-[#FFB26B] hover:bg-brand/30"
            >
              Sync theo module này
            </button>
          )}
        </div>
        <select
          value={single.layerId}
          onChange={(e) => updateModule(single.id, { layerId: e.target.value })}
          className="kiln-field h-8 w-full px-2.5 text-xs"
        >
          {project.layers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      {/* Địa chỉ DMX & Mode Loop DMX */}
      <div className="space-y-2 border-t border-line pt-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
            DMX (Uni {project.settings.output.universe})
            <span title="Mỗi module chiếm 4 kênh liên tiếp: vị trí 8-bit (0 → Dài max), fine tĩnh, tốc độ (255 = Tốc độ max của module), khoá 77">
              <HelpCircle size={12} className="text-muted" />
            </span>
          </span>
          {isAuto && (
            <button
              type="button"
              onClick={() => setAddressMode('manual')}
              className="cursor-pointer text-[11px] font-medium text-[#FFB26B] hover:underline"
            >
              Mở nhập tay
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="509"
            disabled={isAuto}
            value={addrInput}
            onChange={(e) => handleAddrChange(e.target.value)}
            className={`kiln-field h-7 w-24 px-2.5 text-xs tabular-nums disabled:opacity-55 ${
              addrError ? 'shadow-[inset_0_0_0_1.5px_var(--danger)]' : ''
            }`}
          />
          <span className="kiln-chip cue tabular-nums">
            Kênh {chStart}–{chEnd}
          </span>
          {single.dmxLoop && <span className="kiln-chip acc">Loop 4CH</span>}
        </div>

        <button
          type="button"
          onClick={() => updateModule(single.id, { dmxLoop: !single.dmxLoop })}
          title="Khi bật, module này dùng chung 4 kênh DMX với module chính trong Layer (nối dây Loop DMX)"
          className={`flex w-full cursor-pointer items-center justify-between rounded-xl px-2.5 py-1.5 text-[11px] transition ${
            single.dmxLoop
              ? 'bg-brand/15 text-[#FFB26B] shadow-[inset_0_0_0_1px_rgba(247,132,46,.4)]'
              : 'bg-white/[0.04] text-[#C2B3A4] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/[0.08]'
          }`}
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Link2 size={12} />
            Loop DMX (Dùng chung 4 kênh)
          </span>
          <span className="text-[10px] font-semibold tabular-nums">
            {single.dmxLoop ? `CH ${loopChStart}–${loopChEnd}` : 'Tắt'}
          </span>
        </button>

        <label className="block space-y-1">
          <span className="flex items-center gap-1 text-[11px] text-[#C2B3A4]">
            Fine tune CH2 (0–255)
            <span title="CH2 là kênh fine tĩnh: phát nguyên giá trị này, không đổi theo vị trí, timeline, cue, wave, manual hay LTC. Không có công thức mm→CH2 chính thức nên nhập thẳng giá trị DMX. Mặc định 0.">
              <HelpCircle size={11} />
            </span>
          </span>
          <input
            key={`${single.id}-fine-${ch2Fine}`}
            type="number"
            min={0}
            max={255}
            step={1}
            defaultValue={ch2Fine}
            onBlur={(e) => {
              const input = e.currentTarget
              const next = Number.isFinite(input.valueAsNumber) ? clamp(Math.round(input.valueAsNumber), 0, 255) : ch2Fine
              input.value = String(next)
              if (next !== ch2Fine) updateModule(single.id, { ch2Fine: next })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        {addrError && (
          <p className="flex items-center gap-1 text-[11px] text-danger">
            <AlertCircle size={12} className="shrink-0" />
            {addrError}
          </p>
        )}
      </div>

      {/* Kích thước & Giới hạn */}
      <div className="grid grid-cols-2 gap-2 border-t border-line pt-2.5">
        <label className="space-y-1">
          <span className="flex items-center gap-1 text-[11px] text-[#C2B3A4]">
            Dài max (m)
            <span title="Hành trình thả tối đa của màn, ứng với DMX = 255">
              <HelpCircle size={11} />
            </span>
          </span>
          <input
            type="number"
            step="0.1"
            min="0.2"
            value={single.length}
            onChange={(e) => updateModule(single.id, { length: Number(e.target.value) || 0.2 }, `mod-len-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Rộng 3D (m)</span>
          <input
            type="number"
            step="0.1"
            min="0.2"
            value={single.width}
            onChange={(e) => updateModule(single.id, { width: Number(e.target.value) || 0.2 }, `mod-w-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Min chiều cao (m)</span>
          <input
            type="number"
            step="0.05"
            min="0"
            max={single.maxHeight}
            value={single.minHeight}
            onChange={(e) => updateModule(single.id, { minHeight: Number(e.target.value) || 0 }, `mod-min-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Max chiều cao (m)</span>
          <input
            type="number"
            step="0.05"
            min={single.minHeight}
            max={single.length}
            value={single.maxHeight}
            onChange={(e) => updateModule(single.id, { maxHeight: Number(e.target.value) || 0 }, `mod-max-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="flex items-center gap-1 text-[11px] text-[#C2B3A4]">
            Tốc độ max (cm/s)
            <span title="Vận tốc tối đa của module (mặc định H2 = 120 cm/s). Ứng với CH3 = 255; Timeline đối chiếu thông số này để cảnh báo nếu quá nhanh.">
              <HelpCircle size={11} />
            </span>
          </span>
          <input
            type="number"
            min="10"
            max="500"
            value={single.maxSpeedCms}
            onChange={(e) => updateModule(single.id, { maxSpeedCms: Number(e.target.value) || 120 }, `mod-spd-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="flex items-center gap-1 text-[11px] text-[#C2B3A4]">
            CH3 mặc định
            <span title="CH3 0–255 tuyến tính, 255 = Tốc độ max của module (cm/s). Khuyến nghị CH3=100 ≈ 100/255 × Tốc độ max.">
              <HelpCircle size={11} />
            </span>
          </span>
          <input
            type="number"
            min="1"
            max="255"
            value={single.defaultSpeed}
            onChange={(e) => updateModule(single.id, { defaultSpeed: Number(e.target.value) || 100 }, `mod-ch3-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
          <span className="text-[10px] text-muted tabular-nums">= {ch3ToCms(single.defaultSpeed, single.maxSpeedCms).toFixed(1)} cm/s (255 = {single.maxSpeedCms} cm/s; khuyến nghị CH3=100 ≈ {((100 / 255) * single.maxSpeedCms).toFixed(1)} cm/s)</span>
        </label>
      </div>

      <ChannelMonitor
        key={single.id}
        moduleId={single.id}
        moduleName={single.name}
        live={[ch1, ch2, ch3, ch4]}
        maxSpeedCms={single.maxSpeedCms}
        onPersistCh2={(v) => updateModule(single.id, { ch2Fine: v })}
      />
    </div>
  )
}

/**
 * Giám sát 4 kênh. Chỉ CH2 (fine) nhập được; CH1/CH3/CH4 chỉ hiển thị. "Sent" TEST fine tune: lưu CH2 vào module,
 * gửi xung CH4=77 (SENT_PULSE_MS) rồi CH4 tự về 0; CH1 giữ nguyên, không bị khoá chặn.
 */
function ChannelMonitor({
  moduleId,
  moduleName,
  live,
  maxSpeedCms,
  onPersistCh2,
}: {
  moduleId: string
  moduleName: string
  live: number[]
  maxSpeedCms: number
  onPersistCh2: (ch2: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])
  const shown = draft ?? String(live[1])
  const ch2 = shown.trim() === '' ? NaN : Number(shown)
  const valid = Number.isInteger(ch2) && ch2 >= 0 && ch2 <= 255
  const notify = useAppStore.getState().notify
  const send = async () => {
    if (!valid || phase === 'sending') return
    setPhase('sending')
    onPersistCh2(ch2)
    try {
      const res = await getBridge().command({ type: 'sendFine', id: moduleId, ch2 })
      if (!res.ok) throw new Error(res.message ?? 'Gửi thất bại')
      setDraft(null)
      setPhase('sent')
      notify(`${moduleName}: CH2 = ${ch2}, CH4 77 → 0 (xung ${SENT_PULSE_MS / 1000}s)`, 'success', { title: 'Đã gửi Sent', icon: 'success' })
    } catch (err) {
      setPhase('idle')
      notify((err as Error).message, 'error', { title: 'Sent lỗi', icon: 'error' })
      return
    }
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setPhase('idle'), 1400)
  }
  const cells: Array<{ label: string; value: string; title: string; editable?: boolean }> = [
    { label: 'CH1 Pos', value: String(live[0]), title: 'CH1: vị trí 0–255 (0 → chiều dài tối đa), kẹp theo min–max; Sent không đổi' },
    { label: 'CH2 Fine', value: shown, title: 'CH2: fine tĩnh 0–255, chỉ đổi khi bạn nhập / bấm Sent', editable: true },
    { label: 'CH3 Spd', value: String(live[2]), title: `CH3: tốc độ (${ch3ToCms(live[2], maxSpeedCms).toFixed(0)} cm/s; 255 = ${maxSpeedCms} cm/s)` },
    { label: 'CH4 Lock', value: String(live[3]), title: `CH4: khoá an toàn. Sent phát ${SENT_CH4_PULSE_VALUE} trong ${SENT_PULSE_MS} ms rồi tự về 0` },
  ]
  return (
    <div className="mt-auto space-y-2 border-t border-line pt-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Giám sát 4 kênh DMX</span>
        <span className="flex items-center gap-1.5 text-[11px] text-[#C2B3A4]">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!valid || phase === 'sending'}
            title={`Test fine tune: gửi CH2 = ${valid ? ch2 : '?'}, CH4 ${SENT_CH4_PULSE_VALUE} rồi về 0. Không bị khoá chặn, CH1 giữ nguyên.`}
            aria-live="polite"
            className={`inline-flex h-5 min-w-[46px] cursor-pointer items-center justify-center gap-1 rounded-full px-2 text-[10px] font-semibold whitespace-nowrap transition-all duration-200 disabled:cursor-default disabled:opacity-40 ${
              phase === 'sent'
                ? 'bg-ok/25 text-ok'
                : phase === 'sending'
                  ? 'scale-95 animate-pulse bg-brand/35 text-[#FFD08A]'
                  : 'bg-brand/20 text-[#FFB26B] hover:bg-brand/30'
            }`}
          >
            {phase === 'sent' ? <Check size={11} strokeWidth={3} /> : null}
            {phase === 'sent' ? 'Đã gửi' : phase === 'sending' ? '…' : 'Sent'}
          </button>
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1.5 text-center tabular-nums">
        {cells.map((c) => (
          <label key={c.label} className="min-w-0 rounded-xl bg-black/30 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]" title={c.title}>
            <div className="truncate text-[9.5px] text-muted">{c.label}</div>
            {c.editable ? (
              <input
                type="number"
                min={0}
                max={255}
                step={1}
                value={c.value}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void send()
                }}
                className={`w-full bg-transparent text-center font-semibold outline-none ${valid ? 'text-fg' : 'text-danger'}`}
              />
            ) : (
              <div className="font-semibold text-fg">{c.value}</div>
            )}
          </label>
        ))}
      </div>
      {!valid && <p className="text-[10.5px] text-danger">CH2 phải là số nguyên 0–255.</p>}
    </div>
  )
}
