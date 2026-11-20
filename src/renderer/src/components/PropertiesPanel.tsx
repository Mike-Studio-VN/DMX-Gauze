import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NumberField } from './DraftInput'
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
import { ch1Range, ch1ToPos, ch3ToCms, clamp, cmsToCh3, speedCap, stepPositionM } from '@shared/convert'
import { CH, H2_MAX_SPEED_CMS, MODULE_MAX_SPEED_LIMIT_CMS, SENT_CH4_PULSE_VALUE, SENT_PULSE_MS, addressRange } from '@shared/dmx'
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
  fitDefaultMotionDuration,
  fullCurvePath,
  heightToPercent,
  insertClipKeyframe,
  mapKeyframesToPts,
  removeClipKeyframe,
  resolveClipBoundsNoOverlap,
  cmsToSeconds,
  cueRepDistanceCm,
  cueSpeedView,
  speedStoredFromInput,
  storedSpeedAsCms,
  speedDisplayValue,
  heightRange,
  keyframeCh1,
  keyframeHeightDisplay,
  keyframeHeightFromInput,
  momentSpeedValue,
  representativeSegmentIndex,
  resolveClipSegmentSpeed,
  segmentDistCm,
  segmentPath,
  updateClipEndTime,
  updateClipKeyframeHeight,
  updateClipKeyframeTimelineTime,
  updateClipStartTime,
} from '@shared/timeline'
import type { ClipKeyframe, CueButton, CueStep, Layer, ModuleCfg, TimelineClip, Transform3D } from '@shared/types'
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
                  <NumberField
                    step={step}
                    min={field === 'scale' ? 0.1 : undefined}
                    disabled={disabled}
                    value={Number(tf[field][i].toFixed(2))}
                    onCommit={(value) => updateAxis(field, i as 0 | 1 | 2, value)}
                    className="min-w-0 flex-1 bg-transparent text-right text-[11.5px] text-fg tabular-nums outline-none"
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
            <span className="kiln-readout truncate text-[10px] font-semibold tabular-nums">
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
  const pUnit = clip.speedView ?? clip.speedUnit ?? 'cms'
  const pCap = speedCap(mod)

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

  // Cột tốc độ (bên phải độ cao): chỉ Manual sửa được. Sửa MỘT ô = đổi giá trị tốc độ CHUNG của moment theo đơn vị đang
  // chọn (cm/s | s | CH3), lưu nguyên số nhập và hiển thị lại ở mọi hàng. Auto và moment cũ: chỉ đọc.
  const commitSpeedCell = (raw: number) => {
    if (!Number.isFinite(raw) || clip.speedMode !== 'manual') return
    const v = pUnit === 'ch3' ? clamp(Math.round(raw), 1, 255) : pUnit === 'cms' ? clamp(raw, 1, pCap) : Math.max(0.05, raw)
    onUpdate({ speedMode: 'manual', speedUnit: pUnit, speedValue: v, speedView: pUnit }, `momspd-${clip.id}`)
  }

  // Độ cao các điểm: lưu NGUYÊN theo đơn vị nhập (m hoặc CH1); menu m|CH1 chỉ đổi hiển thị cho tới khi sửa ô.
  const hUnit = clip.positionUnit ?? 'm'
  const [hLo, hHi] = heightRange(mod, hUnit)
  const hLabel = hUnit === 'ch1' ? 'CH1' : 'm'
  const commitHeight = (kfId: string, raw: number) => {
    const { height, ch1 } = keyframeHeightFromInput(raw, hUnit, mod)
    const { keyframes, syncEdge } = updateClipKeyframeHeight(clip, kfId, height, ch1)
    onUpdate({ keyframes }, `kfh-${kfId}`, syncEdge)
  }
  const speedPanels = momentSpeedPanels({ clip, sorted, mod, onUpdate })

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
            <NumberField
              step="0.1"
              min={bounds.minStart}
              max={Number.isFinite(maxStartTime) ? maxStartTime : undefined}
              aria-label="Thời điểm bắt đầu (s)"
              key={clip.id}
              value={clip.startTime}
              onCommit={commitStartTime}
              className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
            />
            <span className="shrink-0 text-[10px] text-muted">s</span>
          </label>

          <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
            <span className="shrink-0 text-[10px] text-muted">Kết thúc</span>
            <NumberField
              step="0.1"
              min={minEndTime}
              max={Number.isFinite(bounds.maxEnd) ? Number(bounds.maxEnd.toFixed(2)) : undefined}
              aria-label="Thời điểm kết thúc (s)"
              key={clip.id}
              value={endTime}
              onCommit={commitEndTime}
              className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
            />
            <span className="shrink-0 text-[10px] text-muted">s</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10.5px]">
          <span className="kiln-readout tabular-nums">Độ dài: {clip.duration.toFixed(2)}s</span>
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

        <p className="text-[10.5px] text-muted">
          Độ cao hợp lệ: {hUnit === 'ch1' ? `${hLo}–${hHi} (CH1, ≈ ${ch1ToPos(hLo, mod.length).toFixed(2)}–${ch1ToPos(hHi, mod.length).toFixed(2)} m)` : `${hLo.toFixed(2)}–${hHi.toFixed(2)} m`} (tự kẹp)
        </p>
        {speedPanels?.modeBar}
        <div className="flex items-center gap-1.5">
        <div className="kiln-seg min-w-0 flex-1" role="group" aria-label="Đơn vị độ cao">
          {(['m', 'ch1'] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={hUnit === u}
              title="Chỉ đổi cách hiển thị: độ cao đã lưu không bị quy đổi cho tới khi bạn sửa ô"
              onClick={() => {
                if (u !== hUnit) onUpdate({ positionUnit: u === 'ch1' ? 'ch1' : undefined }, `momh-${clip.id}`)
              }}
              className={`kiln-seg-btn h-7 min-w-0 flex-1 px-1 text-[11px] ${hUnit === u ? 'on' : ''}`}
            >
              {u === 'm' ? 'm' : 'CH1'}
            </button>
          ))}
        </div>
          {speedPanels?.unitBar}
        </div>
        <div className="space-y-1.5">
          {sorted.map((kf, idx) => {
            const active = selectedKeyId === kf.id
            const timelineTime = Number((clip.startTime + kf.offset).toFixed(4))
            const hShown = keyframeHeightDisplay(kf, hUnit, mod)
            const storedCh1 = keyframeCh1(kf, mod)

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
                <label className="kiln-field flex min-w-0 flex-1 items-center gap-0.5 px-1">
                  <NumberField
                    step={hUnit === 'ch1' ? 1 : '0.01'}
                    min={hLo}
                    max={hHi}
                    integer={hUnit === 'ch1' ? 'round' : undefined}
                    aria-label={`Độ cao P${idx + 1} (${hLabel})`}
                    title={
                      hUnit === 'ch1'
                        ? `Độ cao (CH1), hợp lệ ${hLo}–${hHi}${storedCh1 === undefined ? ' · đang hiển thị quy đổi từ m, sửa ô để lưu theo CH1' : ''}`
                        : `Độ cao (m), hợp lệ ${hLo.toFixed(2)}–${hHi.toFixed(2)} m${storedCh1 !== undefined ? ' · đang hiển thị quy đổi từ CH1, sửa ô để lưu theo m' : ''}`
                    }
                    key={`${kf.id}-${hUnit}`}
                    value={hShown}
                    onFocus={() => onSelectKey(kf.id)}
                    onCommit={(value) => commitHeight(kf.id, value)}
                    className={`w-full min-w-0 bg-transparent text-right text-[11px] tabular-nums outline-none ${
                      active ? 'font-semibold text-[#FFD08A]' : 'text-[#FFB26B]'
                    }`}
                  />
                  <span className="text-[10px] text-muted">{hLabel}</span>
                </label>
                <span className="text-muted">·</span>
                {pUnit === 'sec' && clip.speedMode !== 'manual' ? (
                  <label className="kiln-field flex min-w-0 flex-1 items-center gap-0.5 px-1">
                    <NumberField
                      step="0.1"
                      min={bounds.minStart}
                      max={Number.isFinite(bounds.maxEnd) ? bounds.maxEnd : undefined}
                      title="Thời gian của điểm trên Timeline (s)"
                      value={timelineTime}
                      onFocus={() => onSelectKey(kf.id)}
                      onCommit={(value) => commitTimelineTime(kf.id, value)}
                      className={`w-full min-w-0 bg-transparent text-right text-[11px] tabular-nums outline-none ${
                        active ? 'font-semibold text-fg' : 'text-fg'
                      }`}
                    />
                    <span className="text-[10px] text-muted">s</span>
                  </label>
                ) : (
                  (() => {
                    const segIn = idx > 0 ? resolveClipSegmentSpeed(clip, sorted[idx - 1], kf, mod) : null
                    // Manual + đã lưu CH3: hiện đúng CH3 đã nhập (không quy đổi qua cm/s).
                    const exactCh3 = clip.speedMode === 'manual' && clip.speedUnit === 'ch3' && pUnit === 'ch3' && clip.speedValue !== undefined
                    // Manual + giây: mỗi đoạn đi trong N s (giá trị chung, không đổi theo hàng).
                    const exactSec = clip.speedMode === 'manual' && clip.speedUnit === 'sec' && pUnit === 'sec' && clip.speedValue !== undefined
                    const shownVal =
                      segIn === null
                        ? '—'
                        : exactCh3
                          ? String(clamp(Math.round(clip.speedValue as number), 1, 255))
                          : exactSec
                            ? String(clip.speedValue)
                            : pUnit === 'cms'
                              ? String(Number(segIn.cms.toFixed(1)))
                              : pUnit === 'sec'
                                ? String(Number((cmsToSeconds(segmentDistCm(mod, sorted[idx - 1].height, kf.height), segIn.cms) ?? 0).toFixed(2)))
                                : String(cmsToCh3(segIn.cms, pCap))
                    const editableCell = segIn !== null && clip.speedMode === 'manual'
                    const label = pUnit === 'cms' ? 'cm/s' : pUnit === 'sec' ? 's' : 'CH3'
                    const cellTitle =
                      segIn === null
                        ? 'Điểm đầu chưa có đoạn vào'
                        : clip.speedMode === undefined
                          ? `${label} của đoạn đi tới điểm này (chỉ đọc: chọn Auto/Manual để áp cho cả moment)`
                          : clip.speedMode === 'manual'
                            ? `${label} của đoạn đi tới điểm này. Sửa = đổi giá trị chung của moment (áp mọi đoạn)`
                            : `${label} của đoạn đi tới điểm này: tự tính, chỉ đọc (chọn Manual để nhập)`
                    return (
                      <label className="kiln-field flex min-w-0 flex-1 items-center gap-0.5 px-1" title={cellTitle}>
                        <NumberField
                          key={pUnit}
                          readOnly={!editableCell}
                          tabIndex={editableCell ? 0 : -1}
                          step={1}
                          min={1}
                          max={pUnit === 'ch3' ? 255 : pUnit === 'cms' ? pCap : undefined}
                          integer={pUnit === 'ch3' ? 'round' : undefined}
                          aria-label={`${label} tới P${idx + 1}`}
                          value={shownVal}
                          onFocus={() => onSelectKey(kf.id)}
                          onCommit={(value) => commitSpeedCell(value)}
                          className={`w-full min-w-0 bg-transparent text-right text-[11px] tabular-nums outline-none ${
                            active ? 'font-semibold text-fg' : 'text-fg'
                          }`}
                        />
                        <span className="text-[10px] text-muted">{label}</span>
                      </label>
                    )
                  })()
                )}
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

      {speedPanels?.notes}
    </div>
  )
}

/**
 * TỐC ĐỘ MOMENT: một cài đặt cho toàn bộ N đoạn. Hai nhóm nút LUÔN hiện: Auto | Manual và cm/s | s | CH3 (đơn vị cũng
 * quyết định cột trong CÁC ĐIỂM). Auto: ô giá trị chỉ đọc (giá trị tự tính theo đơn vị đang chọn); Manual: nhập được
 * (cm/s = cùng tốc độ, s = mỗi đoạn đi trong N giây, CH3 = cùng CH3). Đoạn đại diện để đổi đơn vị = đoạn dài nhất.
 */
function momentSpeedPanels({
  clip,
  sorted,
  mod,
  onUpdate,
}: {
  clip: TimelineClip
  sorted: ClipKeyframe[]
  mod: ModuleCfg
  onUpdate: (patch: Partial<TimelineClip>, coalesceKey?: string) => void
}): { modeBar: ReactNode; unitBar: ReactNode; notes: ReactNode } | null {
  if (sorted.length < 2) return null
  const cap = speedCap(mod)
  const segs = sorted.slice(0, -1).map((p1, i) => {
    const p2 = sorted[i + 1]
    return { p1, p2, dist: segmentDistCm(mod, p1.height, p2.height), dt: p2.offset - p1.offset, res: resolveClipSegmentSpeed(clip, p1, p2, mod) }
  })
  const repIdx = representativeSegmentIndex(segs.map((s) => s.dist)) // đoạn dài nhất (đầu tiên nếu hoà)
  const rep = segs[repIdx]
  const legacy = clip.speedMode === undefined
  const mode = clip.speedMode
  const unit = clip.speedView ?? clip.speedUnit ?? 'cms' // menu đang chọn (chỉ hiển thị)
  const storedUnit = clip.speedUnit ?? 'cms'
  const clearPointSpeeds = sorted.map((k) => ({ ...k, speedMode: undefined, manualSpeedCms: undefined }))
  const apply = (patch: Partial<TimelineClip>) => onUpdate({ ...patch, keyframes: clearPointSpeeds }, `momspd-${clip.id}`)
  const repCms = rep.res.cms
  // Giá trị tương đương theo đơn vị cho đoạn đại diện (quãng 0 → null với đơn vị giây).
  const valueFor = (u: 'cms' | 'sec' | 'ch3', cms: number): number | null => momentSpeedValue(u, cms, rep.dist, cap)
  const setMode = (m: 'auto' | 'manual') => {
    if (m === mode) return
    if (m === 'auto') apply({ speedMode: 'auto', speedUnit: undefined, speedValue: undefined, speedView: unit })
    else apply({ speedMode: 'manual', speedUnit: unit, speedValue: valueFor(unit, repCms) ?? Number(repCms.toFixed(1)), speedView: unit })
  }
  // Đổi menu CHỈ đổi cách hiển thị: giá trị đã lưu (speedUnit + speedValue) không bị quy đổi/ghi đè cho tới khi sửa ô.
  const setUnit = (u: 'cms' | 'sec' | 'ch3') => {
    if (u !== unit) onUpdate({ speedView: u }, `momunit-${clip.id}`)
  }
  const over = segs.some((s) => s.res.mode === 'manual' && s.res.overMax)
  const slow = segs.filter((s) => s.res.mode === 'manual' && s.res.tooSlow)
  const cmsLabel = storedUnit === 'ch3' ? `${ch3ToCms(clamp(Math.round(clip.speedValue ?? 0), 1, 255), cap).toFixed(1)} cm/s` : null
  return {
    modeBar: (
      <div className="space-y-1.5">
      <div className="kiln-seg" role="group" aria-label="Chế độ tốc độ moment">
        {(['auto', 'manual'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`kiln-seg-btn h-7 flex-1 px-2.5 text-[11px] ${mode === m ? 'on' : ''}`}>
            {m === 'auto' ? 'Auto' : 'Manual'}
          </button>
        ))}
      </div>
      {legacy && <p className="text-[10.5px] text-muted">Moment cũ: đang dùng tốc độ theo từng điểm. Chọn Auto/Manual để áp cho cả moment.</p>}
      </div>
    ),
    unitBar: (
      <div className="kiln-seg min-w-0 flex-1" role="group" aria-label="Kiểu nhập tốc độ">
        {(['cms', 'sec', 'ch3'] as const).map((u) => (
          <button key={u} type="button" aria-pressed={unit === u} onClick={() => setUnit(u)} className={`kiln-seg-btn h-7 min-w-0 flex-1 px-1 text-[11px] ${unit === u ? 'on' : ''}`}>
            {u === 'cms' ? 'cm/s' : u === 'sec' ? 's' : 'CH3'}
          </button>
        ))}
      </div>
    ),
    notes: (
      <div className="space-y-1.5 border-t border-line pt-2.5">
      {mode === 'auto' && (
        <div className="space-y-0.5 text-[10.5px] text-muted tabular-nums">
          <div>Mọi {segs.length} đoạn tự tính từ quãng đường / thời gian giữa các điểm.</div>
          <div>
            Đoạn P{repIdx + 1}→P{repIdx + 2}: {rep.res.autoCms.toFixed(1)} cm/s · CH3 {cmsToCh3(rep.res.autoCms, cap)}
          </div>
        </div>
      )}
      {mode === 'manual' && (
        <div className="space-y-1">
          <div className="text-[10.5px] text-muted tabular-nums">
            {storedUnit === 'cms' && `Đã lưu: mọi đoạn ${clip.speedValue ?? '—'} cm/s`}
            {storedUnit === 'ch3' && `Đã lưu: mọi đoạn CH3 ${clip.speedValue ?? '—'} ≈ ${cmsLabel} (255 = ${cap} cm/s)`}
            {storedUnit === 'sec' && `Đã lưu: mỗi đoạn đi trong ${clip.speedValue ?? '—'} s (cm/s = quãng ÷ s; không dời điểm)`}
            {unit !== storedUnit && ' · đang hiển thị quy đổi tạm, sửa ô để lưu theo đơn vị đang chọn'}
          </div>
          <div className="text-[10.5px] text-muted tabular-nums">
            Đại diện P{repIdx + 1}→P{repIdx + 2} ({rep.dist.toFixed(1)} cm): {rep.res.cms.toFixed(1)} cm/s · {cmsToSeconds(rep.dist, rep.res.cms)?.toFixed(2) ?? '—'} s · CH3 {cmsToCh3(rep.res.cms, cap)}
          </div>
          <div className="text-[10px] text-muted">255 = {cap} cm/s; khuyến nghị CH3=100 ≈ {((100 / 255) * cap).toFixed(1)} cm/s</div>
        </div>
      )}
      {over && (
        <p className="flex items-start gap-1 text-[10.5px] text-warn">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          Có đoạn vượt tốc độ tối đa {cap} cm/s: đã kẹp.
        </p>
      )}
      {slow.length > 0 && (
        <p className="flex items-start gap-1 text-[10.5px] text-warn">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          {slow.length}/{segs.length} đoạn quá chậm, không kịp tới đích đúng giờ (vd P{segs.indexOf(slow[0]) + 1}→P{segs.indexOf(slow[0]) + 2}: cần {(slow[0].dist / slow[0].res.cms).toFixed(2)}s, có {slow[0].dt.toFixed(2)}s).
        </p>
      )}

      </div>
    ),
  }
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
  const heightUnit = btn.positionUnit ?? 'm'
  const [globalHeight, setGlobalHeight] = useState('1')
  const stepById = new Map(btn.steps.map((s) => [s.moduleId, s]))
  const refMod = modules[0] ?? { minHeight: 0, maxHeight: 1, length: 1 }
  const refMax = modules.find((m) => m.id === btn.steps[0]?.moduleId)?.maxSpeedCms ?? modules[0]?.maxSpeedCms ?? H2_MAX_SPEED_CMS
  const repDist = cueRepDistanceCm(btn.steps, modules, (id) => snapshotModules[id]?.pos)
  const speedView = cueSpeedView(btn)
  const speedShown = speedDisplayValue(speedView, btn.speedUnit, btn.speedValue, repDist, refMax)

  // Giá trị lưu GIỮ NGUYÊN theo đơn vị nhập (step.unit); đổi menu m/CH1 chỉ đổi hiển thị cho tới khi sửa ô. CH1 = round(m ÷ length × 255).
  const mToCh1 = (m: number, length: number) => clamp(Math.round((m / Math.max(0.001, length)) * 255), 0, 255)
  const stepDisplay = (step: CueStep, m: ModuleCfg): number =>
    (step.unit ?? 'm') === heightUnit
      ? step.position
      : heightUnit === 'ch1'
        ? mToCh1(stepPositionM(step, m.length), m.length)
        : Number(stepPositionM(step, m.length).toFixed(3))
  const storeFromInput = (raw: number, m: ModuleCfg): CueStep => {
    if (heightUnit === 'ch1') {
      const [lo, hi] = ch1Range(m)
      return { moduleId: m.id, position: clamp(Math.round(raw), lo, hi), unit: 'ch1' }
    }
    return { moduleId: m.id, position: Number(clamp(raw, m.minHeight, m.maxHeight).toFixed(2)) }
  }
  const currentStep = (m: ModuleCfg): CueStep =>
    storeFromInput(heightUnit === 'ch1' ? mToCh1(snapshotModules[m.id]?.pos ?? m.minHeight, m.length) : (snapshotModules[m.id]?.pos ?? m.minHeight), m)
  const switchHeightUnit = (nextUnit: 'm' | 'ch1') => {
    if (nextUnit === heightUnit) return
    const cur = Number(globalHeight)
    if (Number.isFinite(cur)) {
      setGlobalHeight(nextUnit === 'ch1' ? String(mToCh1(cur, refMod.length)) : String(Number(ch1ToPos(clamp(Math.round(cur), 0, 255), refMod.length).toFixed(4))))
    }
    onSave({ ...btn, positionUnit: nextUnit === 'ch1' ? 'ch1' : undefined })
  }

  const toggleModule = (m: ModuleCfg) => {
    const exists = btn.steps.some((s) => s.moduleId === m.id)
    const steps = exists ? btn.steps.filter((s) => s.moduleId !== m.id) : [...btn.steps, currentStep(m)]
    onSave({ ...btn, steps })
  }

  const setModuleHeight = (m: ModuleCfg, rawPos: number) => {
    const next = storeFromInput(rawPos, m)
    const exists = btn.steps.some((s) => s.moduleId === m.id)
    const steps = exists ? btn.steps.map((s) => (s.moduleId === m.id ? next : s)) : [...btn.steps, next]
    onSave({ ...btn, steps }, `cue-mod-${btn.id}-${m.id}`)
  }

  const toggleLayerInButton = (layerId: string) => {
    const mods = modules.filter((m) => m.layerId === layerId)
    const modIds = new Set(mods.map((m) => m.id))
    const allChecked = mods.length > 0 && mods.every((m) => stepById.has(m.id))
    if (allChecked) {
      onSave({ ...btn, steps: btn.steps.filter((s) => !modIds.has(s.moduleId)) })
      return
    }
    const nextSteps = [...btn.steps]
    for (const m of mods) {
      if (!nextSteps.some((s) => s.moduleId === m.id)) nextSteps.push(currentStep(m))
    }
    onSave({ ...btn, steps: nextSteps })
  }

  const applyAllSelectedLayersHeight = (rawVal: number) => {
    const modById = new Map(modules.map((m) => [m.id, m]))
    if (btn.steps.length > 0) {
      const steps = btn.steps.map((s) => {
        const m = modById.get(s.moduleId)
        return m ? storeFromInput(rawVal, m) : s
      })
      onSave({ ...btn, steps })
      return
    }
    onSave({ ...btn, steps: modules.map((m) => storeFromInput(rawVal, m)) })
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
        <span className="text-[11px] text-[#C2B3A4]">Tốc độ / thời lượng chạy</span>
        <div className="flex items-center gap-2">
          <div className="kiln-seg flex-1" role="group" aria-label="Đơn vị tốc độ nút Cue">
            {(
              [
                ['cms', 'cm/s'],
                ['sec', 's'],
                ['ch3', 'CH3'],
              ] as const
            ).map(([unit, label]) => (
              <button
                key={unit}
                type="button"
                aria-pressed={speedView === unit}
                title="Chỉ đổi cách hiển thị: giá trị đã lưu không bị quy đổi cho tới khi bạn sửa ô"
                onClick={() => {
                  if (unit !== speedView) onSave({ ...btn, speedView: unit })
                }}
                className={`kiln-seg-btn h-7 flex-1 px-2.5 text-[11px] ${speedView === unit ? 'on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>

          <NumberField
            key={`${btn.id}-${speedView}`}
            min={speedView === 'ch3' ? 1 : 0.1}
            max={speedView === 'ch3' ? 255 : undefined}
            step={speedView === 'ch3' ? 1 : '0.5'}
            integer={speedView === 'ch3' ? 'round' : undefined}
            aria-label={`Giá trị tốc độ nút Cue (${speedView === 'cms' ? 'cm/s' : speedView === 'sec' ? 's' : 'CH3'})`}
            value={speedShown}
            onCommit={(v) => {
              if (v === speedShown) return
              onSave({ ...btn, speedUnit: speedView, speedValue: speedStoredFromInput(speedView, v), speedView, autoSpeedLimitCms: undefined }, `cue-spd-${btn.id}`)
            }}
            className="kiln-field h-8 w-24 px-3 text-right text-xs tabular-nums"
          />
        </div>
        {(btn.speedUnit === 'ch3' || speedView === 'ch3') && (
          <p className="text-[10.5px] text-muted tabular-nums">
            255 = {refMax} cm/s (module đầu tiên của cue)
            {storedSpeedAsCms(btn.speedUnit, btn.speedValue, repDist, refMax) !== null &&
              ` · đã lưu ≈ ${Number(storedSpeedAsCms(btn.speedUnit, btn.speedValue, repDist, refMax)!.toFixed(1))} cm/s`}
          </p>
        )}
        {speedView !== btn.speedUnit && (
          <p className="text-[10.5px] text-muted">
            Đã lưu theo {btn.speedUnit === 'cms' ? 'cm/s' : btn.speedUnit === 'sec' ? 's' : 'CH3'}; đang hiển thị quy đổi tạm, sửa ô để lưu theo đơn vị đang chọn.
          </p>
        )}
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
                  steps: modules.map((m) => stepById.get(m.id) ?? currentStep(m)),
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

          <div className="kiln-seg" role="group" aria-label="Đơn vị vị trí">
            {(
              [
                ['m', 'm'],
                ['ch1', 'CH1'],
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
            <NumberField
              step={heightUnit === 'ch1' ? '1' : '0.1'}
              integer={heightUnit === 'ch1' ? 'round' : undefined}
              min="0"
              max={heightUnit === 'ch1' ? '255' : undefined}
              aria-label={`Chiều cao áp dụng cho các layer (${heightUnit === 'ch1' ? 'CH1' : 'm'})`}
              value={globalHeight}
              key={`${btn.id}-${heightUnit}`}
              onCommit={(value) => setGlobalHeight(String(value))}
              className="w-full min-w-0 border-0 bg-transparent text-center text-xs text-fg tabular-nums outline-none"
            />
            <button
              type="button"
              onClick={() => switchHeightUnit(heightUnit === 'm' ? 'ch1' : 'm')}
              title="Đổi đơn vị m / CH1"
              className="shrink-0 cursor-pointer pl-1 text-[11px] font-medium text-muted hover:text-fg"
            >
              {heightUnit === 'ch1' ? 'CH1' : 'm'}
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
            const selectedCount = mods.filter((m) => stepById.has(m.id)).length
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
                  <span className="kiln-readout text-[11px] tabular-nums">
                    {selectedCount}/{mods.length}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {mods.map((m) => {
                    const checked = stepById.has(m.id)
                    const step = stepById.get(m.id)
                    const pos = step ? stepPositionM(step, m.length) : m.minHeight
                    const [minCh1, maxCh1] = ch1Range(m)
                    const displayVal = step ? stepDisplay(step, m) : heightUnit === 'ch1' ? mToCh1(m.minHeight, m.length) : m.minHeight
                    return (
                      <div
                        key={m.id}
                        className={`flex h-8 items-center justify-between gap-2 rounded-full px-2.5 transition ${
                          checked
                            ? 'bg-black/35 shadow-[inset_0_0_0_1.5px_#f7842e]'
                            : 'bg-black/15 shadow-[inset_0_0_0_1px_var(--line)]'
                        }`}
                      >
                        <label className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 ${checked ? '' : 'text-muted'}`}>
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
                        {heightUnit === 'ch1' && (
                          <span className="shrink-0 text-[10px] text-muted tabular-nums" title="Vị trí tương đương theo mét">
                            ≈{pos.toFixed(2)}m
                          </span>
                        )}
                        <div className="kiln-field flex h-6 w-20 items-center rounded-full px-2">
                          <NumberField
                            step={heightUnit === 'ch1' ? '1' : '0.1'}
                            min={heightUnit === 'ch1' ? minCh1 : m.minHeight}
                            max={heightUnit === 'ch1' ? maxCh1 : m.maxHeight}
                            aria-label={`${m.name} (${heightUnit === 'ch1' ? 'CH1' : 'm'})`}
                            integer={heightUnit === 'ch1' ? 'round' : undefined}
                            value={displayVal}
                            key={`${btn.id}-${heightUnit}`}
                            onCommit={(value) => setModuleHeight(m, value)}
                            className="w-full min-w-0 border-0 bg-transparent text-center text-[11.5px] text-fg tabular-nums outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => switchHeightUnit(heightUnit === 'm' ? 'ch1' : 'm')}
                            title="Đổi đơn vị m / CH1"
                            className="shrink-0 cursor-pointer pl-0.5 text-[10.5px] font-medium text-muted hover:text-fg"
                          >
                            {heightUnit === 'ch1' ? 'CH1' : 'm'}
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

  const [addrError, setAddrError] = useState<string | null>(null)
  const [layerPresetDur, setLayerPresetDur] = useState(4)
  const [waveAmplitudeCm, setWaveAmplitudeCm] = useState(DEFAULT_ALTERNATING_WAVE_AMPLITUDE_CM)
  const [waveFirstUp, setWaveFirstUp] = useState<'odd' | 'even'>('odd')
  const [layerStagger, setLayerStagger] = useState(0.35)
  const [draftModField, setDraftModField] = useState<{ key: string; raw: string } | null>(null)
  const [groupModError, setGroupModError] = useState<string | null>(null)

  useEffect(() => {
    if (single) {
      setAddrError(null)
    }
  }, [single?.id, single?.startAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trang cấu hình nút Cue (Custom): chọn Layer/Module & chiều cao trực tiếp trên panel Thông số
  if (activeButton) {
    return (
      <CueButtonEditor
        key={activeButton.id}
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
              <NumberField
                step="0.1"
                min="0"
                placeholder={commonStart === null ? '—' : undefined}
                aria-label="Thời điểm bắt đầu nhóm (s)"
                key={groupKey}
                value={commonStart}
                onCommit={(startTime) => updateSelectedClipsTiming({ startTime })}
                className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none placeholder:text-muted/60"
              />
              <span className="shrink-0 text-[10px] text-muted">s</span>
            </label>

            <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
              <span className="shrink-0 text-[10px] text-muted">Kết thúc</span>
              <NumberField
                step="0.1"
                min={Math.max(...selectedClips.map((c) => Number((c.startTime + 0.4).toFixed(2))))}
                placeholder={commonEnd === null ? '—' : undefined}
                aria-label="Thời điểm kết thúc nhóm (s)"
                key={groupKey}
                value={commonEnd}
                onCommit={(endTime) => updateSelectedClipsTiming({ endTime })}
                className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none placeholder:text-muted/60"
              />
              <span className="shrink-0 text-[10px] text-muted">s</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10.5px]">
            <span className="kiln-readout tabular-nums">
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
        key={activeClip.id}
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
                <span className="kiln-readout text-[10px] tabular-nums">
                  {playheadTime.toFixed(2)}s · {layerMods.length} mod
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
                  <span className="shrink-0 text-[10px] text-muted">Thời lượng tối thiểu</span>
                  <NumberField
                    step="0.2"
                    min="0.4"
                    value={layerPresetDur}
                    onCommit={setLayerPresetDur}
                    className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
                  />
                  <span className="shrink-0 text-[10px] text-muted">s</span>
                </label>

                <label className="kiln-field flex h-7 min-w-0 items-center gap-1 px-2">
                  <span className="shrink-0 text-[10px] text-muted">Lệch sóng</span>
                  <NumberField
                    step="0.05"
                    min="0"
                    value={layerStagger}
                    onCommit={setLayerStagger}
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
                    <NumberField
                      min="0"
                      step="1"
                      value={waveAmplitudeCm}
                      onCommit={setWaveAmplitudeCm}
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

    const reportModBatchError = (err: string | null) => {
      setGroupModError(err)
      if (err) notify(err, 'warn')
    }

    const commitModBatch = (key: string, fn: (raw: string) => string | null) => {
      if (draftModField?.key !== `${modGroupKey}:${key}`) return
      const raw = draftModField.raw
      setDraftModField(null)
      if (!raw.trim()) return
      reportModBatchError(fn(raw))
    }

    const renderNumField = (
      fieldKey: string,
      label: string,
      commonVal: number | null,
      opts: { step?: string; min?: string; max?: string; onCommit: (num: number) => string | null },
    ) => {
      const fullKey = `${modGroupKey}:${fieldKey}`
      return (
        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">{label}</span>
          <NumberField
            step={opts.step}
            min={opts.min}
            max={opts.max}
            placeholder={commonVal === null ? '—' : undefined}
            aria-label={label}
            key={fullKey}
            value={commonVal}
            onCommit={(value) => reportModBatchError(opts.onCommit(value))}
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
                  return (
                    <label key={ax} className="kiln-field flex h-7 items-center gap-1 px-2">
                      <span className="text-[10px] font-semibold text-muted">{ax}</span>
                      <NumberField
                        step={step}
                        disabled={disabled}
                        placeholder={commonAxis === null ? '—' : undefined}
                        aria-label={`${label} ${ax}`}
                        key={tfKey}
                        min={field === 'scale' ? 0.1 : undefined}
                        value={commonAxis}
                        onCommit={(value) => reportModBatchError(updateModulesBatch(selectedIdsList, {
                          transformAxis: { field, index: idx as 0 | 1 | 2, value },
                        }))}
                        className="min-w-0 flex-1 bg-transparent text-right text-[11.5px] text-fg tabular-nums outline-none placeholder:text-muted/60"
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
            <NumberField
              min="1"
              max="509"
              disabled={isAuto}
              placeholder={commonAddr === null ? '—' : undefined}
              aria-label="Địa chỉ DMX bắt đầu nhóm"
              key={modGroupKey}
              integer="truncate"
              value={commonAddr}
              onCommit={(value) => reportModBatchError(updateModulesBatch(selectedIdsList, { startAddressBase: value }))}
              className="kiln-field h-8 w-24 px-2.5 text-xs tabular-nums placeholder:text-muted/60"
            />
            <span className="kiln-readout text-[11px] tabular-nums">
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
            max: String(MODULE_MAX_SPEED_LIMIT_CMS),
            onCommit: (v) => updateModulesBatch(selectedIdsList, { maxSpeedCms: v }),
          })}
          {renderNumField('defaultSpeed', 'CH3 mặc định', commonDefSpd, {
            min: '1',
            max: '255',
            onCommit: (v) => updateModulesBatch(selectedIdsList, { defaultSpeed: v }),
          })}
        </div>
        {selected.some((m) => m.maxSpeedCms > H2_MAX_SPEED_CMS) && (
          <p className="text-[10px] text-warn">Có module vượt spec H2 ({H2_MAX_SPEED_CMS} cm/s): chỉ dùng khi test.</p>
        )}

        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold tracking-wide text-muted uppercase">Giám sát 4 kênh DMX</span>
            <span className="kiln-readout tabular-nums">
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
              <div key={label} className="kiln-readout p-1.5">
                <div className="text-[10px] text-muted">{label}</div>
                <div className="font-semibold">{v !== null ? v : '—'}</div>
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
          <NumberField
            min="1"
            max="509"
            disabled={isAuto}
            key={single.id}
            integer="reject"
            value={single.startAddress}
            onCommit={(value) => setAddrError(updateModule(single.id, { startAddress: value }))}
            className={`kiln-field h-7 w-24 px-2.5 text-xs tabular-nums ${
              addrError ? 'shadow-[inset_0_0_0_1.5px_var(--danger)]' : ''
            }`}
          />
          <span className="kiln-readout px-2 text-[11px] tabular-nums">
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
          <NumberField
            key={`${single.id}-fine`}
            min={0}
            max={255}
            step={1}
            value={ch2Fine}
            integer="round"
            onCommit={(value) => updateModule(single.id, { ch2Fine: value })}
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
          <NumberField
            step="0.1"
            min="0.2"
            value={single.length}
            key={single.id}
            max={500}
            onCommit={(length) => updateModule(single.id, { length }, `mod-len-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Rộng 3D (m)</span>
          <NumberField
            step="0.1"
            min="0.2"
            value={single.width}
            key={single.id}
            max={500}
            onCommit={(width) => updateModule(single.id, { width }, `mod-w-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Min chiều cao (m)</span>
          <NumberField
            step="0.05"
            min="0"
            max={single.maxHeight}
            value={single.minHeight}
            key={single.id}
            onCommit={(minHeight) => updateModule(single.id, { minHeight }, `mod-min-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Max chiều cao (m)</span>
          <NumberField
            step="0.05"
            min={single.minHeight}
            max={single.length}
            value={single.maxHeight}
            key={single.id}
            onCommit={(maxHeight) => updateModule(single.id, { maxHeight }, `mod-max-${single.id}`)}
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
          <NumberField
            min="10"
            max={MODULE_MAX_SPEED_LIMIT_CMS}
            value={single.maxSpeedCms}
            key={single.id}
            onCommit={(maxSpeedCms) => updateModule(single.id, { maxSpeedCms }, `mod-spd-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
          {single.maxSpeedCms > H2_MAX_SPEED_CMS && (
            <span className="block text-[10px] text-warn">Vượt spec H2 ({H2_MAX_SPEED_CMS} cm/s): chỉ dùng khi test.</span>
          )}
        </label>

        <label className="space-y-1">
          <span className="flex items-center gap-1 text-[11px] text-[#C2B3A4]">
            CH3 mặc định
            <span title="CH3 0–255 tuyến tính, 255 = Tốc độ max của module (cm/s). Khuyến nghị CH3=100 ≈ 100/255 × Tốc độ max.">
              <HelpCircle size={11} />
            </span>
          </span>
          <NumberField
            min="1"
            max="255"
            value={single.defaultSpeed}
            key={single.id}
            integer="round"
            onCommit={(defaultSpeed) => updateModule(single.id, { defaultSpeed }, `mod-ch3-${single.id}`)}
            className="kiln-field h-7 w-full px-2.5 text-xs tabular-nums"
          />
          <span className="kiln-readout text-[10px] tabular-nums">= {ch3ToCms(single.defaultSpeed, single.maxSpeedCms).toFixed(1)} cm/s (255 = {single.maxSpeedCms} cm/s; khuyến nghị CH3=100 ≈ {((100 / 255) * single.maxSpeedCms).toFixed(1)} cm/s)</span>
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
 * Giám sát 4 kênh. CH1/CH2/CH3 nhập được, CH4 chỉ đọc. "Sent" chỉ để TEST, không bị khoá nào chặn: gửi đúng giá trị đã nhập
 * (không kẹp min/max, không quy đổi); CH4 xung 77 (SENT_PULSE_MS) rồi tự về 0. Ô chưa chốt giá trị dùng số live.
 * CH1 hoặc CH3 khác live ⇒ module CHẠY THẬT: Sent cần bấm 2 lần (xác nhận). "Dừng" = CH3 0 (phanh) giữ CH1 hiện tại.
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
  const [staged, setStaged] = useState<(number | null)[]>([null, null, null])
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [confirming, setConfirming] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])
  const cancelConfirm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirming(false)
  }
  // CH1/CH2/CH3 được chốt trong panel trước, chỉ Sent mới ghi DMX.
  const nums = [0, 1, 2].map((i) => staged[i] ?? live[i])
  const runs = nums[0] !== live[0] || nums[2] !== live[2]
  const notify = useAppStore.getState().notify
  const stageChannel = (i: number, value: number) => {
    cancelConfirm()
    setStaged((values) => values.map((current, index) => index === i ? value : current))
  }
  const dispatch = async (cmd: { ch1?: number; ch2: number; ch3?: number }, persist: boolean, msg: string) => {
    setPhase('sending')
    if (persist) onPersistCh2(cmd.ch2)
    try {
      const res = await getBridge().command({ type: 'sendFine', id: moduleId, ...cmd })
      if (!res.ok) throw new Error(res.message ?? 'Gửi thất bại')
      setStaged([null, null, null])
      setPhase('sent')
      notify(msg, 'success', { title: 'Đã gửi Sent', icon: 'success' })
    } catch (err) {
      setPhase('idle')
      notify((err as Error).message, 'error', { title: 'Sent lỗi', icon: 'error' })
      return
    }
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setPhase('idle'), 1400)
  }
  const send = async () => {
    if (phase === 'sending') return
    if (runs && !confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 6000)
      return
    }
    cancelConfirm()
    const cmd = {
      ch2: nums[1],
      ...(nums[0] !== live[0] ? { ch1: nums[0] } : {}),
      ...(nums[2] !== live[2] ? { ch3: nums[2] } : {}),
    }
    const parts = [cmd.ch1 !== undefined ? `CH1 ${cmd.ch1}` : null, `CH2 ${cmd.ch2}`, cmd.ch3 !== undefined ? `CH3 ${cmd.ch3}` : null].filter(Boolean)
    await dispatch(cmd, true, `${moduleName}: ${parts.join(', ')}; CH4 77 → 0 (xung ${SENT_PULSE_MS / 1000}s)`)
  }
  const stop = () => {
    cancelConfirm()
    void dispatch({ ch1: live[0], ch2: live[1], ch3: 0 }, false, `${moduleName}: Dừng (CH3 0, CH1 giữ ${live[0]}); CH4 77 → 0`)
  }
  const cells: Array<{ label: string; i: number; title: string }> = [
    { label: 'CH1 Pos', i: 0, title: 'CH1: vị trí 0–255 (0 → chiều dài tối đa). Sent gửi đúng số nhập, không kẹp min–max; module chạy thật' },
    { label: 'CH2 Fine', i: 1, title: 'CH2: fine tĩnh 0–255, chỉ đổi khi bạn nhập / bấm Sent' },
    { label: 'CH3 Spd', i: 2, title: `CH3: tốc độ 0–255 (0 = phanh), ${ch3ToCms(nums[2], maxSpeedCms).toFixed(0)} cm/s; 255 = ${maxSpeedCms} cm/s` },
  ]
  return (
    <div className="sticky bottom-0 z-10 mt-auto space-y-2 border-t border-line bg-[var(--glass)] pt-2.5 pb-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Giám sát 4 kênh DMX</span>
        <span className="flex items-center gap-1.5 text-[11px] text-[#C2B3A4]">
          <button
            type="button"
            onClick={() => void send()}
            disabled={phase === 'sending'}
            title={`Test: gửi CH1/CH2/CH3 đã nhập, CH4 ${SENT_CH4_PULSE_VALUE} rồi về 0. Không bị khoá chặn. CH1/CH3 khác live ⇒ module chạy thật.`}
            aria-live="polite"
            className={`inline-flex h-5 min-w-[46px] cursor-pointer items-center justify-center gap-1 rounded-full px-2 text-[10px] font-semibold whitespace-nowrap transition-all duration-200 disabled:cursor-default disabled:opacity-40 ${
              phase === 'sent'
                ? 'bg-ok/25 text-ok'
                : phase === 'sending'
                  ? 'scale-95 animate-pulse bg-brand/35 text-[#FFD08A]'
                  : confirming
                    ? 'bg-warn/25 text-warn'
                    : 'bg-brand/20 text-[#FFB26B] hover:bg-brand/30'
            }`}
          >
            {phase === 'sent' ? <Check size={11} strokeWidth={3} /> : null}
            {phase === 'sent' ? 'Đã gửi' : phase === 'sending' ? '…' : confirming ? 'Xác nhận' : 'Sent'}
          </button>
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1.5 text-center tabular-nums">
        {cells.map((c) => (
          <label key={c.label} className="kiln-field min-w-0 p-1.5" title={c.title}>
            <div className="truncate text-[9.5px] text-muted">{c.label}</div>
            <NumberField
              min={0}
              max={255}
              step={1}
              integer="reject"
              value={nums[c.i]}
              onDraftChange={cancelConfirm}
              onCommit={(value) => stageChannel(c.i, value)}
              className="w-full bg-transparent text-center font-semibold text-fg outline-none"
            />
          </label>
        ))}
        <div className="kiln-readout min-w-0 p-1.5" title={`CH4: khoá an toàn, chỉ đọc. Sent phát ${SENT_CH4_PULSE_VALUE} trong ${SENT_PULSE_MS} ms rồi tự về 0`}>
          <div className="truncate text-[9.5px] text-muted">CH4 Lock</div>
          <div className="font-semibold">{live[3]}</div>
        </div>
      </div>
      {confirming ? (
        <div className="space-y-1">
          <p className="flex items-start gap-1 text-[10.5px] text-warn">
            <AlertTriangle size={11} className="mt-px shrink-0" />
            Module sẽ chạy thật tới CH1={nums[0]} với CH3={nums[2]} (≈{ch3ToCms(nums[2], maxSpeedCms).toFixed(0)} cm/s), kể cả khi đang khoá. Bấm Xác nhận để gửi.
          </p>
          <button type="button" onClick={cancelConfirm} className="cursor-pointer text-[10.5px] text-muted underline hover:text-fg">
            Huỷ
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={stop}
          disabled={phase === 'sending'}
          title="Phanh tại chỗ: gửi CH3 = 0, giữ CH1 hiện tại (kể cả khi đang khoá)"
          className="cursor-pointer text-[10.5px] text-muted underline hover:text-fg disabled:cursor-default disabled:opacity-40"
        >
          Dừng (CH3 = 0)
        </button>
      )}
    </div>
  )
}
