import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  FolderPlus,
  Layers,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { conflictMap } from '@shared/addressing'
import { addressRange } from '@shared/dmx'
import type { Layer, ModuleCfg } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

type ContextMenuState =
  | { kind: 'layer'; x: number; y: number; layer: Layer }
  | { kind: 'module'; x: number; y: number; mod: ModuleCfg }
  | null

export function GauzeTree() {
  const {
    project,
    selectedIds,
    selectedLayerId,
    collapsedLayers,
    snapshot,
    toggleLayerCollapse,
    toggleLayerVisibility,
    toggleModuleVisibility,
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
    reorderModule,
    updateModule,
    setAddressMode,
    reAutoAssign,
    notify,
  } = useAppStore()

  const [createKind, setCreateKind] = useState<'none' | 'layer' | 'module'>('none')
  const [newLayerName, setNewLayerName] = useState('')
  const [targetLayerId, setTargetLayerId] = useState('')
  const [newName, setNewName] = useState('')
  const [newLen, setNewLen] = useState('1')
  const [newAddr, setNewAddr] = useState('')
  const [formErr, setFormErr] = useState<string | null>(null)

  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null)
  const [renamingModId, setRenamingModId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const [draggedModId, setDraggedModId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ layerId: string; index: number } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const conflicts = conflictMap(project.modules)
  const isAuto = project.settings.addressMode === 'auto'

  const openCreateLayer = () => {
    setFormErr(null)
    setNewLayerName(`Lớp ${project.layers.length + 1}`)
    setCreateKind(createKind === 'layer' ? 'none' : 'layer')
  }

  const openCreateModule = (preferLayerId?: string) => {
    setFormErr(null)
    const selectedMod = project.modules.find((m) => m.id === selectedIds[0])
    setTargetLayerId(preferLayerId ?? selectedLayerId ?? selectedMod?.layerId ?? project.layers[0]?.id ?? '')
    setNewName('')
    setNewAddr('')
    setCreateKind(preferLayerId ? 'module' : createKind === 'module' ? 'none' : 'module')
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
    <div className="relative flex h-full flex-col gap-2">
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
          onClick={() => openCreateModule()}
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

      {/* Danh sách Layer & Module (hỗ trợ kéo thả & chuột phải) */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {project.layers.map((layer) => {
          const mods = project.modules.filter((m) => m.layerId === layer.id)
          const collapsed = Boolean(collapsedLayers[layer.id])
          const layerVisible = layer.visible ?? true
          const layerSelected = selectedLayerId === layer.id
          const isDropLayerHeader = dropTarget?.layerId === layer.id && dropTarget.index === mods.length

          return (
            <div
              key={layer.id}
              className={`space-y-1 rounded-lg transition ${isDropLayerHeader ? 'bg-info/10 ring-1 ring-info' : ''}`}
              onDragOver={(e) => {
                if (!draggedModId) return
                e.preventDefault()
                setDropTarget({ layerId: layer.id, index: mods.length })
              }}
              onDrop={(e) => {
                e.preventDefault()
                const modId = draggedModId || e.dataTransfer.getData('application/x-gauze-module')
                if (modId && dropTarget) {
                  reorderModule(modId, dropTarget.layerId, dropTarget.index)
                }
                setDraggedModId(null)
                setDropTarget(null)
              }}
            >
              <div
                onContextMenu={(e) => {
                  e.preventDefault()
                  selectLayer(layer.id)
                  setCtxMenu({ kind: 'layer', x: e.clientX, y: e.clientY, layer })
                }}
                className={`group flex items-center justify-between gap-1 rounded-md px-1 py-0.5 transition ${
                  layerSelected ? 'bg-info/15 ring-1 ring-info/50' : 'hover:bg-panel-2/60'
                } ${!layerVisible ? 'opacity-50' : ''}`}
              >
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
                      title="Bấm chọn Layer (chỉnh Transform 3D) hoặc chuột phải để thêm/sửa/ẩn/xoá"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs font-semibold text-info hover:underline"
                    >
                      <Layers size={13} className="shrink-0" aria-hidden />
                      <span className="truncate">{layer.name}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted">({mods.length})</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => toggleLayerVisibility(layer.id)}
                    title={layerVisible ? 'Ẩn Layer trên 3D' : 'Hiện Layer trên 3D'}
                    className={`cursor-pointer rounded p-1 transition ${
                      layerVisible
                        ? 'text-muted opacity-0 group-hover:opacity-100 hover:bg-line hover:text-fg'
                        : 'text-warn opacity-100 hover:bg-line'
                    }`}
                  >
                    {layerVisible ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingLayerId(layer.id)
                      setRenameText(layer.name)
                    }}
                    title="Đổi tên layer"
                    className="cursor-pointer rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line hover:text-fg"
                  >
                    <Edit3 size={12} />
                  </button>
                  {project.layers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLayer(layer.id)}
                      title="Xoá layer"
                      className="cursor-pointer rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-danger/20 hover:text-danger"
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
                      Kéo thả module vào đây hoặc chuột phải để thêm
                    </div>
                  ) : (
                    mods.map((m, idx) => {
                      const selected = !selectedLayerId && selectedIds.includes(m.id)
                      const st = snapshot?.modules[m.id]
                      const [chStart, chEnd] = addressRange(m.startAddress)
                      const conflictWith = conflicts.get(m.id)
                      const modVisible = m.visible ?? true
                      const isDropBefore = dropTarget?.layerId === layer.id && dropTarget.index === idx

                      return (
                        <div
                          key={m.id}
                          draggable
                          onDragStart={(e) => {
                            setDraggedModId(m.id)
                            e.dataTransfer.effectAllowed = 'copyMove'
                            e.dataTransfer.setData('application/x-gauze-module', m.id)
                            e.dataTransfer.setData('text/plain', m.id)
                          }}
                          onDragEnd={() => {
                            setDraggedModId(null)
                            setDropTarget(null)
                          }}
                          onDragOver={(e) => {
                            if (!draggedModId || draggedModId === m.id) return
                            e.preventDefault()
                            e.stopPropagation()
                            const rect = e.currentTarget.getBoundingClientRect()
                            const after = e.clientY - rect.top > rect.height / 2
                            setDropTarget({ layerId: layer.id, index: after ? idx + 1 : idx })
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            const modId = draggedModId || e.dataTransfer.getData('application/x-gauze-module')
                            if (modId && dropTarget) {
                              reorderModule(modId, dropTarget.layerId, dropTarget.index)
                            }
                            setDraggedModId(null)
                            setDropTarget(null)
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            selectModule(m.id)
                            setCtxMenu({ kind: 'module', x: e.clientX, y: e.clientY, mod: m })
                          }}
                          onClick={(e) => selectModule(m.id, { multi: e.metaKey || e.ctrlKey, range: e.shiftKey })}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              selectModule(m.id)
                            }
                          }}
                          title="Kéo thả để đổi vị trí/đổi Layer hoặc kéo vào Timeline · Chuột phải để sửa/ẩn/xoá"
                          className={`group flex cursor-pointer items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs transition ${
                            isDropBefore ? 'border-t-2 border-t-brand' : ''
                          } ${
                            selected
                              ? 'border-brand bg-brand/15 text-fg'
                              : 'border-transparent bg-panel-2/60 text-fg/85 hover:border-line hover:bg-panel-2'
                          } ${!modVisible || !layerVisible ? 'opacity-45' : ''} ${
                            draggedModId === m.id ? 'opacity-40' : ''
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
                              {renamingModId === m.id ? (
                                <input
                                  autoFocus
                                  value={renameText}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => setRenameText(e.target.value)}
                                  onBlur={() => {
                                    if (renameText.trim()) updateModule(m.id, { name: renameText.trim() })
                                    setRenamingModId(null)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      if (renameText.trim()) updateModule(m.id, { name: renameText.trim() })
                                      setRenamingModId(null)
                                    } else if (e.key === 'Escape') {
                                      setRenamingModId(null)
                                    }
                                  }}
                                  className="min-w-0 flex-1 rounded border border-brand bg-bg px-1 py-0.5 text-xs text-fg"
                                />
                              ) : (
                                <span className="truncate font-medium">{m.name}</span>
                              )}
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
                            className="ml-1 flex items-center gap-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => toggleModuleVisibility(m.id)}
                              title={modVisible ? 'Ẩn Module' : 'Hiện Module'}
                              className={`cursor-pointer rounded p-1 transition ${
                                modVisible
                                  ? 'text-muted opacity-0 group-hover:opacity-100 hover:bg-line hover:text-fg'
                                  : 'text-warn opacity-100 hover:bg-line'
                              }`}
                            >
                              {modVisible ? <Eye size={12} /> : <EyeOff size={12} />}
                            </button>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveModule(m.id, -1)}
                              title="Đưa lên"
                              className="cursor-pointer rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line hover:text-fg disabled:opacity-30"
                            >
                              <ArrowUp size={12} />
                            </button>
                            <button
                              type="button"
                              disabled={idx === mods.length - 1}
                              onClick={() => moveModule(m.id, 1)}
                              title="Đưa xuống"
                              className="cursor-pointer rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line hover:text-fg disabled:opacity-30"
                            >
                              <ArrowDown size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => duplicateModule(m.id)}
                              title="Nhân bản module"
                              className="cursor-pointer rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line hover:text-fg"
                            >
                              <Copy size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeModule(m.id)}
                              title="Xoá module"
                              className="cursor-pointer rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-danger/20 hover:text-danger"
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

      {/* Menu Chuột Phải cho Layer / Module */}
      {ctxMenu && (
        <div
          role="menu"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: Math.min(ctxMenu.y, window.innerHeight - 210),
          }}
          className="fixed z-50 w-48 overflow-hidden rounded-ui border border-info/40 bg-panel py-1 text-xs shadow-2xl"
        >
          {ctxMenu.kind === 'layer' ? (
            <>
              <button
                type="button"
                onClick={() => openCreateModule(ctxMenu.layer.id)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                <Plus size={13} className="text-brand" />
                Thêm Module vào lớp
              </button>
              <button
                type="button"
                onClick={openCreateLayer}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                <FolderPlus size={13} className="text-info" />
                Thêm Layer mới
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenamingLayerId(ctxMenu.layer.id)
                  setRenameText(ctxMenu.layer.name)
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                <Edit3 size={13} className="text-muted" />
                Sửa tên Layer
              </button>
              <button
                type="button"
                onClick={() => toggleLayerVisibility(ctxMenu.layer.id)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                {(ctxMenu.layer.visible ?? true) ? <EyeOff size={13} className="text-warn" /> : <Eye size={13} className="text-ok" />}
                {(ctxMenu.layer.visible ?? true) ? 'Ẩn Layer' : 'Hiện Layer'}
              </button>
              {project.layers.length > 1 && (
                <>
                  <div className="my-1 border-t border-line" />
                  <button
                    type="button"
                    onClick={() => removeLayer(ctxMenu.layer.id)}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/15"
                  >
                    <Trash2 size={13} />
                    Xoá Layer
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setRenamingModId(ctxMenu.mod.id)
                  setRenameText(ctxMenu.mod.name)
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                <Edit3 size={13} className="text-info" />
                Đổi tên Module
              </button>
              <button
                type="button"
                onClick={() => duplicateModule(ctxMenu.mod.id)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                <Copy size={13} className="text-brand" />
                Nhân bản Module
              </button>
              <button
                type="button"
                onClick={() => toggleModuleVisibility(ctxMenu.mod.id)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-panel-2"
              >
                {(ctxMenu.mod.visible ?? true) ? <EyeOff size={13} className="text-warn" /> : <Eye size={13} className="text-ok" />}
                {(ctxMenu.mod.visible ?? true) ? 'Ẩn Module' : 'Hiện Module'}
              </button>
              <div className="my-1 border-t border-line" />
              <button
                type="button"
                onClick={() => removeModule(ctxMenu.mod.id)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/15"
              >
                <Trash2 size={13} />
                Xoá Module
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
