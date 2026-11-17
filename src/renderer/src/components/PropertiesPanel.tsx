import { useEffect, useState } from 'react'
import { AlertCircle, HelpCircle, Lock, Unlock } from 'lucide-react'
import { CH, addressRange } from '@shared/dmx'
import { ch3ToCms } from '@shared/convert'
import { useAppStore } from '../store/useAppStore'

export function PropertiesPanel() {
  const { project, selectedIds, snapshot, updateModule, setAddressMode, notify } = useAppStore()
  const selected = project.modules.filter((m) => selectedIds.includes(m.id))
  const single = selected.length === 1 ? selected[0] : null
  const isAuto = project.settings.addressMode === 'auto'

  const [addrInput, setAddrInput] = useState('')
  const [addrError, setAddrError] = useState<string | null>(null)

  useEffect(() => {
    if (single) {
      setAddrInput(String(single.startAddress))
      setAddrError(null)
    }
  }, [single?.id, single?.startAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  if (selected.length === 0) {
    return <p className="text-xs text-muted">Chọn một hoặc nhiều module bên Cây màn để chỉnh thông số.</p>
  }

  if (!single) {
    const first = selected[0]
    return (
      <div className="space-y-4 overflow-y-auto pr-1 text-xs">
        <div className="rounded-lg border border-brand/40 bg-brand/10 p-2.5">
          <div className="font-semibold text-brand">Đang chọn {selected.length} module</div>
          <div className="mt-1 text-muted">Thay đổi bên dưới sẽ áp dụng cho cả {selected.length} module.</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-muted">Min chiều cao (m)</span>
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
              className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg"
            />
          </label>

          <label className="space-y-1">
            <span className="text-muted">Max chiều cao (m)</span>
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
              className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-muted">Tốc độ mặc định (CH3: 1–255)</span>
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
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg"
          />
        </label>
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
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1 text-xs">
      <label className="space-y-1">
        <span className="text-muted">Tên module</span>
        <input
          value={single.name}
          onChange={(e) => updateModule(single.id, { name: e.target.value })}
          className="w-full rounded border border-line bg-bg px-2.5 py-1.5 text-sm font-medium text-fg"
        />
      </label>

      <label className="space-y-1">
        <span className="text-muted">Lớp (Layer)</span>
        <select
          value={single.layerId}
          onChange={(e) => updateModule(single.id, { layerId: e.target.value })}
          className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg"
        >
          {project.layers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-1.5 rounded-lg border border-line bg-panel-2/60 p-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 font-medium text-info">
            Địa chỉ DMX (Universe {project.settings.output.universe})
            <span title="Mỗi module chiếm 4 kênh liên tiếp: Vị trí, Fine tune, Tốc độ, Khoá 77">
              <HelpCircle size={13} className="text-muted" />
            </span>
          </span>
          {isAuto && (
            <button
              type="button"
              onClick={() => setAddressMode('manual')}
              className="cursor-pointer text-[11px] text-brand hover:underline"
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
            className={`w-24 rounded border bg-bg px-2 py-1 text-fg tabular-nums disabled:opacity-60 ${
              addrError ? 'border-danger' : 'border-line'
            }`}
          />
          <span className="text-muted tabular-nums">
            → Kênh {chStart}–{chEnd}
          </span>
        </div>

        {addrError && (
          <p className="flex items-center gap-1 text-[11px] text-danger">
            <AlertCircle size={12} className="shrink-0" />
            {addrError}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="flex items-center gap-1 text-muted">
            Chiều dài max (m)
            <span title="Hành trình thả tối đa của màn, ứng với DMX = 255">
              <HelpCircle size={12} />
            </span>
          </span>
          <input
            type="number"
            step="0.1"
            min="0.2"
            value={single.length}
            onChange={(e) => updateModule(single.id, { length: Number(e.target.value) || 0.2 })}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg tabular-nums"
          />
        </label>

        <label className="space-y-1">
          <span className="text-muted">Bề rộng 3D (m)</span>
          <input
            type="number"
            step="0.1"
            min="0.2"
            value={single.width}
            onChange={(e) => updateModule(single.id, { width: Number(e.target.value) || 0.2 })}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg tabular-nums"
          />
        </label>
      </div>

      <div className="space-y-2 rounded-lg border border-line bg-panel-2/60 p-2.5">
        <div className="font-medium text-fg">Giới hạn chiều cao an toàn</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-muted">Min (m)</span>
            <input
              type="number"
              step="0.05"
              min="0"
              max={single.maxHeight}
              value={single.minHeight}
              onChange={(e) => updateModule(single.id, { minHeight: Number(e.target.value) || 0 })}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted">Max (m)</span>
            <input
              type="number"
              step="0.05"
              min={single.minHeight}
              max={single.length}
              value={single.maxHeight}
              onChange={(e) => updateModule(single.id, { maxHeight: Number(e.target.value) || 0 })}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
            />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-muted">Tốc độ tối đa (cm/s)</span>
          <input
            type="number"
            min="10"
            max="500"
            value={single.maxSpeedCms}
            onChange={(e) => updateModule(single.id, { maxSpeedCms: Number(e.target.value) || 120 })}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg tabular-nums"
          />
        </label>
        <label className="space-y-1">
          <span className="flex items-center gap-1 text-muted">
            CH3 mặc định
            <span title="Giá trị DMX kênh tốc độ mặc định (100 ≈ 47 cm/s)">
              <HelpCircle size={12} />
            </span>
          </span>
          <input
            type="number"
            min="1"
            max="255"
            value={single.defaultSpeed}
            onChange={(e) => updateModule(single.id, { defaultSpeed: Number(e.target.value) || 100 })}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg tabular-nums"
          />
        </label>
      </div>

      <div className="mt-auto space-y-2 rounded-lg border border-line bg-bg/70 p-2.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-info">Giám sát 4 kênh DMX</span>
          <span className="flex items-center gap-1 text-[11px] text-muted tabular-nums">
            {snapshot?.locked ? <Lock size={12} className="text-warn" /> : <Unlock size={12} className="text-ok" />}
            {(st?.pos ?? 0).toFixed(2)}m → {(st?.target ?? 0).toFixed(2)}m
          </span>
        </div>

        <div className="grid grid-cols-4 gap-1.5 text-center tabular-nums">
          <div className="rounded bg-panel-2 p-1.5" title="CH1: Vị trí chính (0-255)">
            <div className="text-[10px] text-muted">CH1 Pos</div>
            <div className="font-semibold text-fg">{ch1}</div>
          </div>
          <div className="rounded bg-panel-2 p-1.5" title="CH2: Fine tune 16-bit (0-255)">
            <div className="text-[10px] text-muted">CH2 Fine</div>
            <div className="font-semibold text-fg">{ch2}</div>
          </div>
          <div className="rounded bg-panel-2 p-1.5" title={`CH3: Tốc độ (${ch3ToCms(ch3, single.maxSpeedCms).toFixed(0)} cm/s)`}>
            <div className="text-[10px] text-muted">CH3 Spd</div>
            <div className="font-semibold text-brand">{ch3}</div>
          </div>
          <div className="rounded bg-panel-2 p-1.5" title="CH4: Safe lock (77 = mở khoá, 0 = khoá)">
            <div className="text-[10px] text-muted">CH4 Lock</div>
            <div className={`font-semibold ${ch4 === project.settings.lockValue ? 'text-ok' : 'text-warn'}`}>
              {ch4}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
