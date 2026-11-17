import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Layers, PanelLeftOpen, Plus, X } from 'lucide-react'
import { addressRange } from '@shared/dmx'
import { useAppStore } from '../store/useAppStore'

export function CollapsedTreeRail({ onExpand }: { onExpand: () => void }) {
  const {
    project,
    selectedIds,
    selectedLayerId,
    snapshot,
    selectLayer,
    selectModule,
    toggleLayerVisibility,
    toggleModuleVisibility,
    addLayer,
    addModule,
  } = useAppStore()

  const [openLayerId, setOpenLayerId] = useState<string | null>(null)
  const [addingMod, setAddingMod] = useState(false)
  const [modName, setModName] = useState('')
  const [modLen, setModLen] = useState('1')
  const [addErr, setAddErr] = useState<string | null>(null)

  const [addingLayer, setAddingLayer] = useState(false)
  const [layerName, setLayerName] = useState('')

  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!openLayerId && !addingLayer) return
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenLayerId(null)
        setAddingLayer(false)
        setAddingMod(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenLayerId(null)
        setAddingLayer(false)
        setAddingMod(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openLayerId, addingLayer])

  const openLayer = openLayerId ? project.layers.find((l) => l.id === openLayerId) ?? null : null
  const openLayerMods = openLayer ? project.modules.filter((m) => m.layerId === openLayer.id) : []

  const handleQuickAddModule = () => {
    if (!openLayer) return
    const len = Number(modLen) || 1
    const err = addModule(openLayer.id, { name: modName, length: len, width: len >= 2 ? 3 : 1 })
    if (err) {
      setAddErr(err)
      return
    }
    setAddErr(null)
    setModName('')
    setAddingMod(false)
  }

  const handleQuickAddLayer = () => {
    const err = addLayer(layerName)
    if (!err) {
      setLayerName('')
      setAddingLayer(false)
    }
  }

  return (
    <div ref={containerRef} className="kiln-panel relative flex min-h-0 flex-col items-center gap-2 py-2.5">
      <button
        type="button"
        onClick={onExpand}
        title="Mở rộng Layers"
        aria-label="Mở rộng Layers"
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl bg-white/[0.06] text-info shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/10"
      >
        <PanelLeftOpen size={15} />
      </button>

      <div className="w-6 border-t border-line" />

      {/* Các nút Layer đánh số 1, 2, 3... giống ảnh mẫu */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto px-1">
        {project.layers.map((layer, idx) => {
          const isPopover = openLayerId === layer.id
          const isLayerSel = selectedLayerId === layer.id
          const hasSelectedMod = project.modules.some(
            (m) => m.layerId === layer.id && selectedIds.includes(m.id),
          )
          const active = isPopover || isLayerSel || hasSelectedMod
          const visible = layer.visible ?? true

          return (
            <button
              key={layer.id}
              type="button"
              onClick={() => {
                setAddingLayer(false)
                setAddingMod(false)
                setOpenLayerId((cur) => (cur === layer.id ? null : layer.id))
              }}
              title={`${layer.name} — Bấm để bật/tắt bảng chọn nhanh`}
              className={`flex h-10 w-8 cursor-pointer flex-col items-center justify-center rounded-[10px] text-[10px] font-bold transition ${
                active
                  ? 'bg-brand/15 text-[#FFB26B] shadow-[inset_0_0_0_1.5px_var(--acc)]'
                  : 'bg-white/[0.045] text-[#C2B3A4] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/[0.09] hover:text-fg'
              } ${!visible ? 'opacity-45' : ''}`}
            >
              <Layers size={13} />
              <span className="mt-0.5 leading-none">{idx + 1}</span>
            </button>
          )
        })}

        <button
          type="button"
          onClick={() => {
            setOpenLayerId(null)
            setLayerName(`Lớp ${project.layers.length + 1}`)
            setAddingLayer((v) => !v)
          }}
          title="Thêm Layer mới"
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-[10px] transition ${
            addingLayer
              ? 'bg-info/20 text-info shadow-[inset_0_0_0_1px_var(--cue)]'
              : 'bg-white/[0.04] text-muted shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/10 hover:text-fg'
          }`}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Popover nổi bên cạnh khi bấm vào một Layer trên thanh thu gọn */}
      {openLayer && (
        <div className="kiln-panel absolute top-2 left-full z-50 ml-2 w-[268px] overflow-hidden p-3 text-xs shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => selectLayer(openLayer.id)}
              title="Bấm để chọn toàn bộ Layer chỉnh Transform 3D"
              className="truncate text-[11px] font-bold tracking-wider text-fg uppercase hover:text-[#FFB26B]"
            >
              {openLayer.name}
            </button>
            <button
              type="button"
              onClick={() => setOpenLayerId(null)}
              aria-label="Đóng bảng nhỏ"
              className="cursor-pointer rounded-full p-1 text-muted hover:bg-white/10 hover:text-fg"
            >
              <X size={13} />
            </button>
          </div>

          <div className="max-h-60 space-y-1 overflow-y-auto pr-0.5">
            {openLayerMods.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-2.5 py-2 text-[11px] text-muted">
                Chưa có module trong lớp này
              </div>
            ) : (
              openLayerMods.map((m) => {
                const selected = selectedIds.includes(m.id)
                const visible = m.visible ?? true
                const [chStart, chEnd] = addressRange(m.startAddress)
                const pos = snapshot?.modules[m.id]?.pos ?? 0
                return (
                  <div
                    key={m.id}
                    onClick={(e) => selectModule(m.id, { multi: e.metaKey || e.ctrlKey, range: e.shiftKey })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        selectModule(m.id)
                      }
                    }}
                    className={`kiln-tree-row flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 ${
                      selected ? 'sel' : ''
                    } ${!visible ? 'opacity-45' : ''}`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        className={`size-2 shrink-0 rounded-full ${
                          selected ? 'bg-brand shadow-[0_0_0_3px_rgba(247,132,46,.22)]' : 'bg-info/70'
                        }`}
                      />
                      <span className={`truncate font-medium ${selected ? 'text-[#FFB26B]' : 'text-fg'}`}>
                        {m.name}
                      </span>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted tabular-nums">
                      CH{chStart}-{chEnd} · {pos.toFixed(1)}m
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleModuleVisibility(m.id)
                      }}
                      title={visible ? 'Ẩn Module' : 'Hiện Module'}
                      className="cursor-pointer rounded-full p-1 text-muted hover:bg-white/10 hover:text-fg"
                    >
                      {visible ? <Eye size={12} /> : <EyeOff size={12} className="text-warn" />}
                    </button>
                  </div>
                )
              })
            )}
          </div>

          {addingMod && (
            <div className="mt-2 space-y-1.5 rounded-xl bg-black/35 p-2 shadow-[inset_0_0_0_1px_var(--line2)]">
              <input
                autoFocus
                value={modName}
                onChange={(e) => setModName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleQuickAddModule()}
                placeholder="Tên module mới..."
                className="kiln-field h-7 w-full px-2 text-xs"
              />
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step="0.5"
                  min="0.2"
                  value={modLen}
                  onChange={(e) => setModLen(e.target.value)}
                  className="kiln-field h-7 w-16 px-2 text-xs"
                />
                <span className="text-[11px] text-muted">mét</span>
                <button
                  type="button"
                  onClick={handleQuickAddModule}
                  className="kiln-btn kiln-btn-primary ml-auto h-7 px-2.5 text-[11px]"
                >
                  Thêm
                </button>
              </div>
              {addErr && <p className="text-[10.5px] text-danger">{addErr}</p>}
            </div>
          )}

          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => {
                setAddErr(null)
                setAddingMod((v) => !v)
              }}
              className="kiln-btn h-8 text-[11.5px]"
            >
              <Plus size={13} />
              Module
            </button>
            <button
              type="button"
              onClick={() => toggleLayerVisibility(openLayer.id)}
              className={`kiln-btn h-8 text-[11.5px] ${
                (openLayer.visible ?? true) ? 'kiln-btn-cue' : 'border-warn/50 text-warn'
              }`}
            >
              {(openLayer.visible ?? true) ? <Eye size={13} /> : <EyeOff size={13} />}
              {(openLayer.visible ?? true) ? 'Đang hiện' : 'Đang ẩn'}
            </button>
          </div>
        </div>
      )}

      {/* Popover tạo nhanh Layer mới khi bấm + */}
      {addingLayer && (
        <div className="kiln-panel absolute bottom-2 left-full z-50 ml-2 w-56 space-y-2 p-3 text-xs shadow-2xl">
          <div className="font-semibold text-info">Tạo Layer mới</div>
          <input
            autoFocus
            value={layerName}
            onChange={(e) => setLayerName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleQuickAddLayer()}
            placeholder="Tên layer..."
            className="kiln-field h-8 w-full px-2.5 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setAddingLayer(false)} className="kiln-btn h-7 px-2.5 text-[11px]">
              Huỷ
            </button>
            <button
              type="button"
              onClick={handleQuickAddLayer}
              className="kiln-btn kiln-btn-cue h-7 px-3 text-[11px]"
            >
              Tạo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
