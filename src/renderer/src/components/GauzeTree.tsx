import { useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  FolderPlus,
  Layers,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { conflictMap } from '@shared/addressing'
import { addressRange } from '@shared/dmx'
import { useAppStore } from '../store/useAppStore'

export function GauzeTree() {
  const {
    project,
    selectedIds,
    collapsedLayers,
    snapshot,
    toggleLayerCollapse,
    addLayer,
    renameLayer,
    removeLayer,
    selectModule,
    selectLayer,
    selectAll,
    addModule,
    removeModule,
    duplicateModule,
    moveModule,
    setAddressMode,
    reAutoAssign,
    notify,
  } = useAppStore()

  // Tách 2 chế độ form riêng: tạo Layer vs tạo Module
  const [createKind, setCreateKind] = useState<'none' | 'layer' | 'module'>('none')
  const [newLayerName, setNewLayerName] = useState('')
  const [targetLayerId, setTargetLayerId] = useState('')
  const [newName, setNewName] = useState('')
  const [newLen, setNewLen] = useState('1')
  const [newAddr, setNewAddr] = useState('')
  const [formErr, setFormErr] = useState<string | null>(null)
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const conflicts = conflictMap(project.modules)
  const isAuto = project.settings.addressMode === 'auto'

  const openCreateLayer = () => {
    setFormErr(null)
    setNewLayerName(`Lớp ${project.layers.length + 1}`)
    setCreateKind(createKind === 'layer' ? 'none' : 'layer')
  }

  const openCreateModule = () => {
    setFormErr(null)
    const selectedMod = project.modules.find((m) => m.id === selectedIds[0])
    setTargetLayerId(selectedMod?.layerId ?? project.layers[0]?.id ?? '')
    setNewName('')
    setNewAddr('')
    setCreateKind(createKind === 'module' ? 'none' : 'module')
  }

  const handleAddLayer = () => {
    const err = addLayer(newLayerName)
    if (err) {
      setFormErr(err)
      return
    }
    setFormErr(null)
    setCreateKind('none')
  }

  const handleAddModule = () => {
    const layerId = targetLayerId || project.layers[0]?.id
    if (!layerId) {
      setFormErr('Hãy tạo ít nhất 1 layer trước')
      return
    }
    const len = Number(newLen) || 1
    const addr = !isAuto && newAddr.trim() ? Number(newAddr) : undefined
    const err = addModule(layerId, { name: newName, length: len, width: len >= 2 ? 3 : 1, startAddress: addr })
    if (err) {
      setFormErr(err)
      return
    }
    setFormErr(null)
    setNewName('')
    setNewAddr('')
    setCreateKind('none')
  }

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Thanh chọn & chế độ DMX */}
      <div className="flex items-center justify-between gap-1 border-b border-line pb-2">
        <button
          type="button"
          onClick={selectAll}
          title="Chọn tất cả module màn"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-panel-2 px-2 py-1 text-xs text-info hover:bg-line"
        >
          <CheckSquare size={14} aria-hidden />
          Chọn hết ({project.modules.length})
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setAddressMode(isAuto ? 'manual' : 'auto')
              notify(isAuto ? 'Đã chuyển sang gán địa chỉ thủ công' : 'Đã bật tự động gán địa chỉ từ kênh 1', 'info')
            }}
            title="Auto: tự gán 4 kênh liên tiếp từ 1. Thủ công: nhập từng module trên Thuộc tính"
            className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium ${
              isAuto ? 'bg-brand/20 text-brand' : 'bg-panel-2 text-muted hover:text-fg'
            }`}
          >
            {isAuto ? 'Auto DMX' : 'Thủ công'}
          </button>
          <button
            type="button"
            onClick={reAutoAssign}
            title="Sắp xếp lại địa chỉ liên tiếp từ kênh 1 cho toàn bộ module"
            className="cursor-pointer rounded-md bg-panel-2 p-1.5 text-muted hover:bg-line hover:text-fg"
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
      </div>

      {/* 2 nút tách biệt: Tạo Layer và Tạo Module */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={openCreateLayer}
          title="Tạo một Layer (lớp màn) mới"
          className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition ${
            createKind === 'layer'
              ? 'border-info bg-info/15 text-info'
              : 'border-line bg-panel-2 text-fg hover:border-info/60'
          }`}
        >
          <FolderPlus size={14} aria-hidden />
          + Layer
        </button>
        <button
          type="button"
          onClick={openCreateModule}
          title="Tạo một Module màn mới và chọn Layer chứa"
          className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition ${
            createKind === 'module'
              ? 'border-brand bg-brand/15 text-brand'
              : 'border-line bg-panel-2 text-fg hover:border-brand/60'
          }`}
        >
          <Plus size={14} aria-hidden />
          + Module
        </button>
      </div>

      {/* Form Tạo Layer */}
      {createKind === 'layer' && (
        <div className="space-y-1.5 rounded-lg border border-info/50 bg-panel-2 p-2 text-xs">
          <div className="font-medium text-info">Tạo Layer mới</div>
          <input
            value={newLayerName}
            onChange={(e) => setNewLayerName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddLayer()}
            placeholder="Tên layer (vd: Lớp giữa)"
            className="w-full rounded border border-line bg-bg px-2 py-1 text-fg"
          />
          {formErr && <p className="text-[11px] text-danger">{formErr}</p>}
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setCreateKind('none')}
              className="cursor-pointer rounded px-2 py-1 text-muted hover:text-fg"
            >
              Huỷ
            </button>
            <button
              type="button"
              onClick={handleAddLayer}
              className="cursor-pointer rounded bg-info px-2.5 py-1 font-medium text-slate-950"
            >
              Tạo Layer
            </button>
          </div>
        </div>
      )}

      {/* Form Tạo Module */}
      {createKind === 'module' && (
        <div className="space-y-1.5 rounded-lg border border-brand/50 bg-panel-2 p-2 text-xs">
          <div className="font-medium text-brand">Tạo Module mới</div>
          <label className="block text-[11px] text-muted">
            Thuộc Layer
            <select
              value={targetLayerId}
              onChange={(e) => setTargetLayerId(e.target.value)}
              className="mt-0.5 w-full rounded border border-line bg-bg px-2 py-1 text-fg"
            >
              {project.layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddModule()}
            placeholder="Tên module (vd: Trước 13)"
            className="w-full rounded border border-line bg-bg px-2 py-1 text-fg"
          />
          <div className="flex gap-1.5">
            <label className="flex-1 text-[11px] text-muted">
              Dài (m)
              <input
                type="number"
                step="0.5"
                min="0.2"
                value={newLen}
                onChange={(e) => setNewLen(e.target.value)}
                className="mt-0.5 w-full rounded border border-line bg-bg px-2 py-1 text-fg"
              />
            </label>
            {!isAuto && (
              <label className="flex-1 text-[11px] text-muted">
                Kênh đầu
                <input
                  type="number"
                  min="1"
                  max="509"
                  value={newAddr}
                  onChange={(e) => setNewAddr(e.target.value)}
                  placeholder="Auto"
                  className="mt-0.5 w-full rounded border border-line bg-bg px-2 py-1 text-fg"
                />
              </label>
            )}
          </div>
          {formErr && <p className="text-[11px] text-danger">{formErr}</p>}
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setCreateKind('none')}
              className="cursor-pointer rounded px-2 py-1 text-muted hover:text-fg"
            >
              Huỷ
            </button>
            <button
              type="button"
              onClick={handleAddModule}
              className="cursor-pointer rounded bg-brand px-2.5 py-1 font-medium text-brand-fg"
            >
              Tạo Module
            </button>
          </div>
        </div>
      )}

      {/* Danh sách Layer & Module */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {project.layers.map((layer) => {
          const mods = project.modules.filter((m) => m.layerId === layer.id)
          const collapsed = Boolean(collapsedLayers[layer.id])

          return (
            <div key={layer.id} className="space-y-1">
              <div className="group flex items-center justify-between gap-1 rounded-md px-1 py-0.5 hover:bg-panel-2/60">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleLayerCollapse(layer.id)}
                    title={collapsed ? 'Mở rộng layer' : 'Thu gọn layer'}
                    aria-label={collapsed ? `Mở rộng ${layer.name}` : `Thu gọn ${layer.name}`}
                    className="cursor-pointer rounded p-0.5 text-muted hover:bg-line hover:text-fg"
                  >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>

                  {renamingLayerId === layer.id ? (
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onBlur={() => {
                        renameLayer(layer.id, renameText)
                        setRenamingLayerId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          renameLayer(layer.id, renameText)
                          setRenamingLayerId(null)
                        } else if (e.key === 'Escape') {
                          setRenamingLayerId(null)
                        }
                      }}
                      className="min-w-0 flex-1 rounded border border-info bg-bg px-1.5 py-0.5 text-xs text-fg"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => selectLayer(layer.id)}
                      title="Bấm để chọn toàn bộ module trong lớp này"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs font-semibold text-info hover:underline"
                    >
                      <Layers size={13} className="shrink-0" aria-hidden />
                      <span className="truncate">{layer.name}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted">({mods.length})</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingLayerId(layer.id)
                      setRenameText(layer.name)
                    }}
                    title="Đổi tên layer"
                    className="cursor-pointer rounded p-1 text-muted hover:bg-line hover:text-fg"
                  >
                    <Edit3 size={12} />
                  </button>
                  {project.layers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLayer(layer.id)}
                      title="Xoá layer"
                      className="cursor-pointer rounded p-1 text-muted hover:bg-danger/20 hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>

              {!collapsed && (
                <div className="space-y-1 pl-2">
                  {mods.length === 0 ? (
                    <div className="rounded border border-dashed border-line px-2 py-1.5 text-[11px] text-muted">
                      Chưa có module nào
                    </div>
                  ) : (
                    mods.map((m, idx) => {
                      const selected = selectedIds.includes(m.id)
                      const st = snapshot?.modules[m.id]
                      const [chStart, chEnd] = addressRange(m.startAddress)
                      const conflictWith = conflicts.get(m.id)

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
                          className={`group flex cursor-pointer items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs transition ${
                            selected
                              ? 'border-brand bg-brand/15 text-fg'
                              : 'border-transparent bg-panel-2/60 text-fg/85 hover:border-line hover:bg-panel-2'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`size-2 shrink-0 rounded-full ${
                                  conflictWith
                                    ? 'bg-danger'
                                    : st?.moving
                                      ? 'animate-pulse bg-brand'
                                      : 'bg-info/70'
                                }`}
                                title={
                                  conflictWith
                                    ? `Trùng kênh DMX với: ${conflictWith.join(', ')}`
                                    : st?.moving
                                      ? 'Đang di chuyển'
                                      : 'Đang dừng'
                                }
                              />
                              <span className="truncate font-medium">{m.name}</span>
                              {conflictWith && (
                                <AlertTriangle
                                  size={12}
                                  className="shrink-0 text-danger"
                                  aria-label="Trùng kênh DMX"
                                />
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted tabular-nums">
                              <span>
                                CH {chStart}–{chEnd}
                              </span>
                              <span>·</span>
                              <span>
                                {(st?.pos ?? 0).toFixed(2)}/{m.length}m
                              </span>
                            </div>
                          </div>

                          <div
                            className="ml-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveModule(m.id, -1)}
                              title="Đưa lên"
                              className="cursor-pointer rounded p-1 text-muted hover:bg-line hover:text-fg disabled:opacity-30"
                            >
                              <ArrowUp size={12} />
                            </button>
                            <button
                              type="button"
                              disabled={idx === mods.length - 1}
                              onClick={() => moveModule(m.id, 1)}
                              title="Đưa xuống"
                              className="cursor-pointer rounded p-1 text-muted hover:bg-line hover:text-fg disabled:opacity-30"
                            >
                              <ArrowDown size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => duplicateModule(m.id)}
                              title="Nhân bản module"
                              className="cursor-pointer rounded p-1 text-muted hover:bg-line hover:text-fg"
                            >
                              <Copy size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeModule(m.id)}
                              title="Xoá module"
                              className="cursor-pointer rounded p-1 text-muted hover:bg-danger/20 hover:text-danger"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
