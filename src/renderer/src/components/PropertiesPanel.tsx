import { useEffect, useState } from 'react'
import { AlertCircle, Eye, EyeOff, HelpCircle, Layers, Lock, RotateCcw, Unlock } from 'lucide-react'
import { CH, addressRange } from '@shared/dmx'
import { ch3ToCms } from '@shared/convert'
import { defaultLayerTransform, defaultModuleTransform } from '@shared/preset'
import type { Transform3D } from '@shared/types'
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
    <div className="space-y-2.5 border-t border-line pt-3">
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
          ['position', 'Vị trí (m)', 0.1],
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
                    value={disabled ? 0 : Number(tf[field][i].toFixed(2))}
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

export function PropertiesPanel() {
  const {
    project,
    selectedIds,
    selectedLayerId,
    snapshot,
    updateLayer,
    toggleLayerVisibility,
    updateModule,
    setAddressMode,
    notify,
  } = useAppStore()

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

  // Đang chọn Layer
  if (activeLayer) {
    const tf = activeLayer.transform ?? defaultLayerTransform(activeLayerIdx)
    const visible = activeLayer.visible ?? true
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="kiln-chip acc">
            <Layers size={11} />
            Layer
          </span>
          <button
            type="button"
            onClick={() => toggleLayerVisibility(activeLayer.id)}
            className="kiln-btn h-7 px-2.5 text-[11px]"
          >
            {visible ? <Eye size={12} className="text-ok" /> : <EyeOff size={12} className="text-warn" />}
            {visible ? 'Đang hiện' : 'Đang ẩn'}
          </button>
        </div>

        <label className="space-y-1">
          <span className="text-[11px] text-[#C2B3A4]">Tên Layer</span>
          <input
            value={activeLayer.name}
            onChange={(e) => updateLayer(activeLayer.id, { name: e.target.value }, `layer-name-${activeLayer.id}`)}
            className="kiln-field h-8 w-full px-3 text-[12.5px] font-medium"
          />
        </label>

        <TransformEditor
          tf={tf}
          onChange={(nextTf) => updateLayer(activeLayer.id, { transform: nextTf }, `layer-tf-${activeLayer.id}`)}
          onReset={() => updateLayer(activeLayer.id, { transform: defaultLayerTransform(activeLayerIdx) })}
        />

        <p className="border-t border-line pt-3 text-[11px] text-muted">
          Toàn bộ module trong lớp này giữ cạnh trên dính vào thanh truss của Layer và di chuyển/xoay/scale theo Layer.
        </p>
      </div>
    )
  }

  if (selected.length === 0) {
    return <p className="text-xs text-muted">Chọn một Layer hoặc Module bên Layers để chỉnh thông số.</p>
  }

  if (!single) {
    const first = selected[0]
    return (
      <div className="space-y-3 overflow-y-auto pr-0.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="kiln-chip acc">Đang chọn {selected.length} module</span>
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

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto pr-0.5 text-xs">
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

      {/* Địa chỉ DMX */}
      <div className="space-y-1.5 border-t border-line pt-2.5">
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
        </div>

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

      <TransformEditor
        tf={modTf}
        lockY
        onChange={(nextTf) => updateModule(single.id, { transform: nextTf }, `mod-tf-${single.id}`)}
        onReset={() => updateModule(single.id, { transform: defaultModuleTransform() })}
      />

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
