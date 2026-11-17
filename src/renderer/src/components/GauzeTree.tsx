import { useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Copy,
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
    snapshot,
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

  const [addingLayer, setAddingLayer] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newLen, setNewLen] = useState('1')
  const [newAddr, setNewAddr] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)

  const conflicts = conflictMap(project.modules)
  const isAuto = project.settings.addressMode === 'auto'

  const handleAdd = (layerId: string) => {
    const len = Number(newLen) || 1
    const addr = !isAuto && newAddr.trim() ? Number(newAddr) : undefined
    const err = addModule(layerId, { name: newName, length: len, width: len >= 2 ? 3 : 1, startAddress: addr })
    if (err) {
      setAddErr(err)
      return
    }
    setAddErr(null)
    setNewName('')
    setNewAddr('')
    setAddingLayer(null)
  }

  return (
    <div className="flex h-full flex-col gap-2">
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

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {project.layers.map((layer) => {
          const mods = project.modules.filter((m) => m.layerId === layer.id)
          return (
            <div key={layer.id} className="space-y-1">
              <div className="flex items-center justify-between px-1">
                <button
                  type="button"
                  onClick={() => selectLayer(layer.id)}
                  title="Bấm để chọn toàn bộ module trong lớp này"
                  className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-info hover:underline"
                >
                  <Layers size={14} aria-hidden />
                  <span>{layer.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddingLayer(addingLayer === layer.id ? null : layer.id)
                    setAddErr(null)
                  }}
                  title="Thêm module màn vào lớp này"
                  className="cursor-pointer rounded p-1 text-muted hover:bg-panel-2 hover:text-brand"
                >
                  <Plus size={14} aria-hidden />
                </button>
              </div>

              {addingLayer === layer.id && (
                <div className="space-y-1.5 rounded-lg border border-brand/50 bg-panel-2 p-2 text-xs">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
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
                  {addErr && <p className="text-[11px] text-danger">{addErr}</p>}
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setAddingLayer(null)}
                      className="cursor-pointer rounded px-2 py-1 text-muted hover:text-fg"
                    >
                      Huỷ
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAdd(layer.id)}
                      className="cursor-pointer rounded bg-brand px-2.5 py-1 font-medium text-brand-fg"
                    >
                      Thêm
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                {mods.map((m, idx) => {
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
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted tabular-nums">
                          <span>CH {chStart}–{chEnd}</span>
                          <span>·</span>
                          <span>{(st?.pos ?? 0).toFixed(2)}/{m.length}m</span>
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
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
