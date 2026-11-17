import { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, ArrowLeft, Eye, EyeOff, HelpCircle, Layers, Link2, Lock, Plus, RotateCcw, Trash2, Unlock } from 'lucide-react'
import { layerLoopAddress } from '@shared/addressing'
import { ch3ToCms } from '@shared/convert'
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
  heightToPercent,
  insertClipKeyframe,
  percentToHeight,
  removeClipKeyframe,
  resolveClipBoundsNoOverlap,
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
          <span className="text-[11px] font-semibold tracking-wide text-[#FFB26B] uppercase">
            Các điểm ({sorted.length})
          </span>
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
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 transition ${
                  active
                    ? 'bg-brand/15 shadow-[inset_0_0_0_1.5px_var(--acc)]'
                    : 'bg-black/30 shadow-[inset_0_0_0_1px_var(--line)]'
                }`}
              >
                <span className="w-6 shrink-0 text-[10.5px] font-semibold text-info">K{idx + 1}</span>
                <label className="flex min-w-0 flex-1 items-center gap-0.5">
                  <input
                    type="number"
                    step="0.1"
                    min={bounds.minStart}
                    max={Number.isFinite(bounds.maxEnd) ? bounds.maxEnd : undefined}
                    title="Thời gian của điểm trên Timeline (s)"
                    value={draftTime?.id === kf.id ? draftTime.raw : timelineTime}
                    onFocus={() => setDraftTime({ id: kf.id, raw: String(timelineTime) })}
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
                    className="w-full min-w-0 bg-transparent text-right text-[11px] text-fg tabular-nums outline-none"
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
                    onFocus={() => setDraftPct({ id: kf.id, raw: String(pct) })}
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
                    className="w-full min-w-0 bg-transparent text-right text-[11px] text-[#FFB26B] tabular-nums outline-none"
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
