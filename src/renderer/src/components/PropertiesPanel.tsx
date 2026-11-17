import { useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, ArrowLeft, Eye, EyeOff, HelpCircle, Layers, Link2, Lock, Plus, RotateCcw, Trash2, Unlock } from 'lucide-react'
import { layerLoopAddress } from '@shared/addressing'
import { ch3ToCms, clamp } from '@shared/convert'
import { CH, addressRange } from '@shared/dmx'
import { defaultLayerTransform, defaultModuleTransform } from '@shared/preset'
import {
  computeModuleBasePositions,
  getModuleWorldPosition,
  worldPositionToModuleOffset,
} from '@shared/stage3d'
import {
  CURVE_PRESETS,
  type CurvePresetId,
  analyzeClipSpeeds,
  buildCurveKeyframes,
  fullCurvePath,
  heightToPercent,
  insertClipKeyframe,
  mapKeyframesToPts,
  percentToHeight,
  removeClipKeyframe,
  resolveClipBoundsNoOverlap,
  segmentPath,
  updateClipKeyframeHeight,
  updateClipKeyframeTimelineTime,
} from '@shared/timeline'
import type { ModuleCfg, TimelineClip, Transform3D } from '@shared/types'
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
      offset: Number((tNorm * clip.duration).toFixed(2)),
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
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Đồ thị Curve</span>
        {activeKf && activeIdx >= 0 ? (
          <span className="text-[10px] font-semibold text-[#FFCB72] tabular-nums">
            K{activeIdx + 1}: {(clip.startTime + activeKf.offset).toFixed(2)}s · {heightToPercent(activeKf.height, mod)}%
          </span>
        ) : (
          <span className="text-[10px] text-muted">Kéo điểm · 2× click thêm</span>
        )}
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
                  <title>{`K${idx + 1}: ${(clip.startTime + kf.offset).toFixed(2)}s · ${heightToPercent(kf.height, mod)}%`}</title>
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
                        K{idx + 1}
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
}: {
  clip: TimelineClip
  allClips: TimelineClip[]
  mod: ModuleCfg
  selectedKeyId: string | null
  onSelectKey: (id: string | null) => void
  onBackToModule: () => void
  onUpdate: (patch: Partial<TimelineClip>, coalesceKey?: string, syncEdge?: 'start' | 'end') => void
  onDelete: () => void
}) {
  const sorted = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
  const sameModClips = allClips.filter((c) => c.moduleId === clip.moduleId)
  const bounds = resolveClipBoundsNoOverlap(sameModClips, clip)
  const issues = analyzeClipSpeeds(clip, mod)
  const bad = issues.find((i) => !i.feasible)
  const [draftTime, setDraftTime] = useState<{ id: string; raw: string } | null>(null)
  const [draftPct, setDraftPct] = useState<{ id: string; raw: string } | null>(null)

  const commitTimelineTime = (kfId: string, rawVal: number) => {
    const patch = updateClipKeyframeTimelineTime(clip, kfId, rawVal, bounds)
    onUpdate(patch, `kf-${kfId}`)
  }

  const commitPercent = (kfId: string, rawPct: number) => {
    const h = percentToHeight(rawPct, mod)
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
    onUpdate({ keyframes: kfs, curveMode })
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
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <label className="kiln-field flex h-7 min-w-[115px] flex-1 items-center gap-1 px-2">
            <span className="shrink-0 text-[10px] text-muted">Bắt đầu</span>
            <input
              type="number"
              step="0.1"
              min="0"
              value={clip.startTime}
              onChange={(e) => onUpdate({ startTime: Math.max(0, Number(e.target.value) || 0) }, `clip-start-${clip.id}`)}
              className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
            />
            <span className="shrink-0 text-[10px] text-muted">s</span>
          </label>

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

        <div className="flex items-center justify-between gap-2 text-[10.5px]">
          <span className="text-muted tabular-nums">Độ dài: {clip.duration.toFixed(2)}s</span>
          {bad ? (
            <span className="kiln-chip danger">
              <AlertTriangle size={10} />
              {bad.requiredCms.toFixed(0)} &gt; {bad.maxSpeedCms} cm/s
            </span>
          ) : (
            <span className="kiln-chip ok">Hợp lệ (≤ {mod.maxSpeedCms} cm/s)</span>
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
        <div className="flex flex-wrap gap-1">
          {CURVE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              title={`Áp dụng đồ thị mẫu "${preset.label}"`}
              className="kiln-btn h-6 gap-1 px-2 text-[10.5px] text-[#C2B3A4] hover:text-fg"
            >
              <svg width="14" height="9" viewBox="0 0 16 10" aria-hidden="true" className="shrink-0">
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
                  K{activeIdx + 1}
                </span>
              ) : null
            })()}
          </div>
          <button
            type="button"
            onClick={() => {
              const { keyframes, newKeyId } = insertClipKeyframe(clip, mod.minHeight, mod.maxHeight)
              onUpdate({ keyframes })
              onSelectKey(newKeyId)
            }}
            title="Thêm điểm mới vào moment"
            className="kiln-btn kiln-btn-cue h-6 px-2.5 text-[10.5px]"
          >
            <Plus size={11} />
            Thêm điểm
          </button>
        </div>

        <div className="space-y-1.5">
          {sorted.map((kf, idx) => {
            const active = selectedKeyId === kf.id
            const timelineTime = Number((clip.startTime + kf.offset).toFixed(2))
            const pct = heightToPercent(kf.height, mod)
            const prevTimelineTime = idx > 0 ? Number((clip.startTime + sorted[idx - 1].offset).toFixed(2)) : bounds.minStart
            const nextTimelineTime =
              idx < sorted.length - 1
                ? Number((clip.startTime + sorted[idx + 1].offset).toFixed(2))
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
                  K{idx + 1}
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
                    step="1"
                    min="0"
                    max="100"
                    title="Độ cao theo phần trăm hành trình (0–100%)"
                    value={draftPct?.id === kf.id ? draftPct.raw : pct}
                    onFocus={() => {
                      onSelectKey(kf.id)
                      setDraftPct({ id: kf.id, raw: String(pct) })
                    }}
                    onChange={(e) => {
                      const raw = e.target.value
                      setDraftPct({ id: kf.id, raw })
                      if (!raw.trim() || raw.endsWith('.')) return
                      const num = Number(raw)
                      if (Number.isFinite(num)) commitPercent(kf.id, num)
                    }}
                    onBlur={() => {
                      if (draftPct?.id === kf.id) {
                        const num = Number(draftPct.raw)
                        if (draftPct.raw.trim() && Number.isFinite(num)) commitPercent(kf.id, num)
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
                  <span className="text-[10px] text-muted">%</span>
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
    </div>
  )
}

export function PropertiesPanel() {
  const {
    project,
    selectedIds,
    selectedLayerId,
    selectedClipId,
    selectedKeyId,
    snapshot,
    updateLayer,
    toggleLayerVisibility,
    toggleLayerSync,
    updateModule,
    setModulesDmxLoop,
    setAddressMode,
    selectTimelineClip,
    selectTimelineKey,
    updateClip,
    deleteClip,
    notify,
  } = useAppStore()

  const activeClip = selectedClipId ? (project.clips ?? []).find((c) => c.id === selectedClipId) ?? null : null
  const activeClipMod = activeClip ? project.modules.find((m) => m.id === activeClip.moduleId) ?? null : null
  const activeLayer = selectedLayerId ? project.layers.find((l) => l.id === selectedLayerId) ?? null : null
  const activeLayerIdx = activeLayer ? project.layers.findIndex((l) => l.id === activeLayer.id) : 0

  const selected = project.modules.filter((m) => selectedIds.includes(m.id))
  const single = !activeLayer && selected.length === 1 ? selected[0] : null
  const isAuto = project.settings.addressMode === 'auto'

  const [addrInput, setAddrInput] = useState('')
  const [addrError, setAddrError] = useState<string | null>(null)

  useEffect(() => {
    if (single) {
      setAddrInput(String(single.startAddress))
      setAddrError(null)
    }
  }, [single?.id, single?.startAddress]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const first = selected[0]
    const allLoop = selected.every((m) => m.dmxLoop)
    return (
      <div className="space-y-3 overflow-y-auto pr-0.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="kiln-chip acc">Đang chọn {selected.length} module</span>
          <button
            type="button"
            onClick={() => setModulesDmxLoop(selected.map((m) => m.id), !allLoop)}
            title="Dùng chung 4 kênh DMX cho các module trong cùng Layer"
            className={`kiln-btn h-7 px-2.5 text-[11px] ${allLoop ? 'kiln-btn-primary' : 'text-[#C2B3A4]'}`}
          >
            <Link2 size={12} />
            {allLoop ? 'Loop DMX: Bật' : 'Loop DMX (4CH)'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
          <label className="space-y-1">
            <span className="text-[11px] text-[#C2B3A4]">Min chiều cao (m)</span>
            <input
              type="number"
              step="0.1"
              min="0"
              defaultValue={first.minHeight}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) {
                  selected.forEach((m) => updateModule(m.id, { minHeight: v }))
                  notify(`Đã đặt Min = ${v}m cho ${selected.length} module`, 'info')
                }
              }}
              className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[11px] text-[#C2B3A4]">Max chiều cao (m)</span>
            <input
              type="number"
              step="0.1"
              min="0.2"
              defaultValue={first.maxHeight}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) {
                  selected.forEach((m) => updateModule(m.id, { maxHeight: v }))
                  notify(`Đã đặt Max = ${v}m cho ${selected.length} module`, 'info')
                }
              }}
              className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
          <label className="space-y-1">
            <span className="text-[11px] text-[#C2B3A4]">Tốc độ tối đa (cm/s)</span>
            <input
              type="number"
              min="10"
              max="500"
              defaultValue={first.maxSpeedCms}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) {
                  selected.forEach((m) => updateModule(m.id, { maxSpeedCms: v }))
                  notify(`Đã đặt tốc độ tối đa = ${v} cm/s`, 'info')
                }
              }}
              className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-[#C2B3A4]">CH3 mặc định</span>
            <input
              type="number"
              min="1"
              max="255"
              defaultValue={first.defaultSpeed}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) {
                  selected.forEach((m) => updateModule(m.id, { defaultSpeed: v }))
                  notify(`Đã đặt CH3 mặc định = ${v}`, 'info')
                }
              }}
              className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
            />
          </label>
        </div>
      </div>
    )
  }

  const st = snapshot?.modules[single.id]
  const [chStart, chEnd] = addressRange(single.startAddress)
  const baseIdx = single.startAddress - 1
  const frame = snapshot?.frame ?? []
  const ch1 = frame[baseIdx + CH.POSITION] ?? 0
  const ch2 = frame[baseIdx + CH.FINE] ?? 0
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
        <span className="text-[11px] text-[#C2B3A4]">Lớp (Layer)</span>
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
            <span title="Mỗi module chiếm 4 kênh liên tiếp: Vị trí, Fine tune, Tốc độ, Khoá 77">
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
            <span title="Vận tốc tối đa motor theo spec (H2 = 120 cm/s). Timeline đối chiếu thông số này để cảnh báo nếu quá nhanh.">
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
            <span title="Giá trị DMX kênh tốc độ mặc định (100 ≈ 47 cm/s)">
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
        </label>
      </div>

      {/* Giám sát 4 kênh DMX */}
      <div className="mt-auto space-y-2 border-t border-line pt-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Giám sát 4 kênh DMX</span>
          <span className="flex items-center gap-1 text-[11px] text-[#C2B3A4] tabular-nums">
            {snapshot?.locked ? <Lock size={11} className="text-warn" /> : <Unlock size={11} className="text-ok" />}
            {(st?.pos ?? 0).toFixed(2)}m → {(st?.target ?? 0).toFixed(2)}m
          </span>
        </div>

        <div className="grid grid-cols-4 gap-1.5 text-center tabular-nums">
          <div className="rounded-xl bg-black/30 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]" title="CH1: Vị trí chính (0-255)">
            <div className="text-[9.5px] text-muted">CH1 Pos</div>
            <div className="font-semibold text-fg">{ch1}</div>
          </div>
          <div className="rounded-xl bg-black/30 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]" title="CH2: Fine tune 16-bit (0-255)">
            <div className="text-[9.5px] text-muted">CH2 Fine</div>
            <div className="font-semibold text-fg">{ch2}</div>
          </div>
          <div className="rounded-xl bg-black/30 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]" title={`CH3: Tốc độ (${ch3ToCms(ch3, single.maxSpeedCms).toFixed(0)} cm/s)`}>
            <div className="text-[9.5px] text-muted">CH3 Spd</div>
            <div className="font-semibold text-[#FFB26B]">{ch3}</div>
          </div>
          <div className="rounded-xl bg-black/30 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]" title="CH4: Safe lock (77 = mở khoá, 0 = khoá)">
            <div className="text-[9.5px] text-muted">CH4 Lock</div>
            <div className={`font-semibold ${ch4 === project.settings.lockValue ? 'text-ok' : 'text-warn'}`}>
              {ch4}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
