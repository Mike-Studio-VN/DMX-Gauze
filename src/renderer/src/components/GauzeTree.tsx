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
  Link2,
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
    toggleLayerSync,
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
      <div className="flex items-center justify-between gap-1 pb-1">
        <button
          type="button"
          onClick={selectAll}
          title="Chọn tất cả module màn"
          className="kiln-btn kiln-btn-cue h-6 px-2.5 text-[11px]"
        >
          <CheckSquare size={12} aria-hidden />
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
            className={`cursor-pointer ${isAuto ? 'kiln-chip acc h-6' : 'kiln-chip h-6'}`}
          >
            {isAuto ? 'Auto DMX' : 'Thủ công'}
          </button>
          <button
            type="button"
            onClick={reAutoAssign}
            title="Sắp xếp lại địa chỉ liên tiếp từ kênh 1 cho toàn bộ module"
            className="kiln-btn h-6 w-6 px-0 text-muted hover:text-fg"
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        </div>
      </div>

      {/* 2 nút tách biệt: Tạo Layer và Tạo Module */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={openCreateLayer}
          title="Tạo một Layer (lớp màn) mới"
          className={`kiln-btn h-7 text-[11px] ${createKind === 'layer' ? 'kiln-btn-cue' : ''}`}
        >
          <FolderPlus size={13} aria-hidden />
          + Layer
        </button>
        <button
          type="button"
          onClick={() => openCreateModule()}
          title="Tạo một Module màn mới và chọn Layer chứa"
          className={`kiln-btn h-7 text-[11px] ${createKind === 'module' ? 'kiln-btn-primary' : ''}`}
        >
          <Plus size={13} aria-hidden />
          + Module
        </button>
      </div>

      {/* Form Tạo Layer */}
      {createKind === 'layer' && (
        <div className="space-y-2 rounded-2xl bg-black/25 p-2.5 text-xs shadow-[inset_0_0_0_1px_rgba(141,184,255,.35)]">
          <div className="font-semibold text-info">Tạo Layer mới</div>
          <input
            value={newLayerName}
            onChange={(e) => setNewLayerName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddLayer()}
            placeholder="Tên layer (vd: Lớp giữa)"
            className="kiln-field h-8 w-full px-2.5 text-xs"
          />
          {formErr && <p className="text-[11px] text-danger">{formErr}</p>}
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setCreateKind('none')} className="kiln-btn h-6 px-2.5 text-[11px]">
              Huỷ
            </button>
            <button type="button" onClick={handleAddLayer} className="kiln-btn kiln-btn-cue h-6 px-3 text-[11px]">
              Tạo Layer
            </button>
          </div>
        </div>
      )}

      {/* Form Tạo Module */}
      {createKind === 'module' && (
        <div className="space-y-2 rounded-2xl bg-black/25 p-2.5 text-xs shadow-[inset_0_0_0_1px_rgba(247,132,46,.38)]">
          <div className="font-semibold text-[#FFB26B]">Tạo Module mới</div>
          <label className="block text-[11px] text-[#C2B3A4]">
            Thuộc Layer
            <select
              value={targetLayerId}
              onChange={(e) => setTargetLayerId(e.target.value)}
              className="kiln-field mt-1 h-8 w-full px-2 text-xs"
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
            className="kiln-field h-8 w-full px-2.5 text-xs"
          />
          <div className="flex gap-1.5">
            <label className="flex-1 text-[11px] text-[#C2B3A4]">
              Dài (m)
              <input
                type="number"
                step="0.5"
                min="0.2"
                value={newLen}
                onChange={(e) => setNewLen(e.target.value)}
                className="kiln-field mt-1 h-7 w-full px-2 text-xs"
              />
            </label>
            {!isAuto && (
              <label className="flex-1 text-[11px] text-[#C2B3A4]">
                Kênh đầu
                <input
                  type="number"
                  min="1"
                  max="509"
                  value={newAddr}
                  onChange={(e) => setNewAddr(e.target.value)}
                  placeholder="Auto"
                  className="kiln-field mt-1 h-7 w-full px-2 text-xs"
                />
              </label>
            )}
          </div>
          {formErr && <p className="text-[11px] text-danger">{formErr}</p>}
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setCreateKind('none')} className="kiln-btn h-6 px-2.5 text-[11px]">
              Huỷ
            </button>
            <button type="button" onClick={handleAddModule} className="kiln-btn kiln-btn-primary h-6 px-3 text-[11px]">
              Tạo Module
            </button>
          </div>
        </div>
      )}

      {/* Danh sách Layer & Module */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
        {project.layers.map((layer) => {
          const mods = project.modules.filter((m) => m.layerId === layer.id)
          const collapsed = Boolean(collapsedLayers[layer.id])
          const layerVisible = layer.visible ?? true
          const layerSelected = selectedLayerId === layer.id
          const isDropLayerHeader = dropTarget?.layerId === layer.id && dropTarget.index === mods.length

          return (
            <div
              key={layer.id}
              className={`space-y-1 rounded-2xl transition ${isDropLayerHeader ? 'ring-1 ring-info' : ''}`}
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
              {/* Layer header theo ngôn ngữ Kiln (.lh / .lh.sel) */}
              <div
                onClick={() => renamingLayerId !== layer.id && selectLayer(layer.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  selectLayer(layer.id)
                  setCtxMenu({ kind: 'layer', x: e.clientX, y: e.clientY, layer })
                }}
                className={`kiln-layer group flex cursor-pointer items-center justify-between gap-1 px-2 py-1.5 transition ${
                  layerSelected ? 'sel' : ''
                } ${!layerVisible ? 'opacity-45' : ''}`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleLayerCollapse(layer.id)
                    }}
                    title={collapsed ? 'Mở rộng layer' : 'Thu gọn layer'}
                    aria-label={collapsed ? `Mở rộng ${layer.name}` : `Thu gọn ${layer.name}`}
                    className={`cursor-pointer rounded-full p-0.5 ${
                      layerSelected ? 'text-[#1C0E04] hover:bg-black/15' : 'text-muted hover:bg-white/10 hover:text-fg'
                    }`}
                  >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>

                  {renamingLayerId === layer.id ? (
                    <input
                      autoFocus
                      value={renameText}
                      onClick={(e) => e.stopPropagation()}
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
                      className="kiln-field h-6 min-w-0 flex-1 px-1.5 text-xs"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => selectLayer(layer.id)}
                      title="Bấm chọn Layer (chỉnh Transform 3D) hoặc chuột phải để thêm/sửa/ẩn/xoá"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs font-semibold"
                    >
                      <Layers size={13} className={`shrink-0 ${layerSelected ? 'text-[#1C0E04]' : 'text-info'}`} aria-hidden />
                      <span className="truncate">{layer.name}</span>
                      <span
                        className={`shrink-0 text-[10px] font-medium ${
                          layerSelected ? 'text-[#1C0E04]/75' : 'text-muted'
                        }`}
                      >
                        ({mods.length})
                      </span>
                      {layer.syncLayer && (
                        <span
                          title="Sync Layer đang bật: các module chạy giống hệt nhau"
                          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.2 text-[9px] font-bold ${
                            layerSelected ? 'bg-[#1C0E04]/15 text-[#1C0E04]' : 'bg-brand/20 text-[#FFB26B]'
                          }`}
                        >
                          <Link2 size={9} />
                          Sync
                        </span>
                      )}
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleLayerVisibility(layer.id)
                    }}
                    title={layerVisible ? 'Ẩn Layer trên 3D' : 'Hiện Layer trên 3D'}
                    className={`cursor-pointer rounded-full p-1 transition ${
                      layerSelected
                        ? 'text-[#1C0E04]/85 hover:bg-black/15'
                        : layerVisible
                          ? 'text-muted opacity-70 hover:bg-white/10 hover:text-fg hover:opacity-100'
                          : 'text-warn opacity-100 hover:bg-white/10'
                    }`}
                  >
                    {layerVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                </div>
              </div>

              {!collapsed && (
                <div className="space-y-0.5 pl-1.5">
                  {mods.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line px-2.5 py-2 text-[11px] text-muted">
                      Kéo thả module vào đây hoặc chuột phải để thêm
                    </div>
                  ) : (
                    mods.map((m, idx) => {
                      const selected = selectedIds.includes(m.id)
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
                          className={`kiln-tree-row group flex cursor-pointer items-center justify-between px-2.5 py-1.5 text-xs transition ${
                            isDropBefore ? 'border-t-2 border-t-brand' : ''
                          } ${selected ? 'sel' : ''} ${!modVisible || !layerVisible ? 'opacity-45' : ''} ${
                            draggedModId === m.id ? 'opacity-40' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`size-1.5 shrink-0 rounded-full ${
                                  conflictWith
                                    ? 'bg-danger'
                                    : st?.moving
                                      ? 'animate-pulse bg-brand'
                                      : selected
                                        ? 'bg-brand shadow-[0_0_0_3px_rgba(247,132,46,.22)]'
                                        : 'bg-info/70'
                                }`}
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
                                  className="kiln-field h-5 min-w-0 flex-1 px-1.5 text-xs"
                                />
                              ) : (
                                <span className={`truncate font-medium ${selected ? 'text-[#FFB26B]' : 'text-fg'}`}>
                                  {m.name}
                                </span>
                              )}
                              {conflictWith && (
                                <AlertTriangle
                                  size={12}
                                  className="shrink-0 text-danger"
                                  aria-label="Trùng kênh DMX"
                                />
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-muted tabular-nums">
                              <span>
                                CH {chStart}–{chEnd}
                              </span>
                              {m.dmxLoop && (
                                <span
                                  title="Loop DMX: dùng chung 4 kênh"
                                  className="rounded-full bg-info/15 px-1.5 text-[9px] font-semibold text-info"
                                >
                                  Loop
                                </span>
                              )}
                              <span>·</span>
                              <span className={selected ? 'text-[#FFB26B]' : ''}>
                                {(st?.pos ?? 0).toFixed(2)}/{m.length}m
                              </span>
                            </div>
                          </div>

                          <div
                            className="ml-1 flex items-center"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => toggleModuleVisibility(m.id)}
                              title={modVisible ? 'Ẩn Module' : 'Hiện Module'}
                              className={`cursor-pointer rounded-full p-1 transition ${
                                modVisible
                                  ? 'text-muted opacity-70 hover:bg-white/10 hover:text-fg hover:opacity-100'
                                  : 'text-warn opacity-100 hover:bg-white/10'
                              }`}
                            >
                              {modVisible ? <Eye size={13} /> : <EyeOff size={13} />}
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

      {/* Menu Chuột Phải chuẩn Kiln */}
      {ctxMenu && (
        <div
          role="menu"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 205),
            top: Math.min(ctxMenu.y, window.innerHeight - 265),
          }}
          className="kiln-panel fixed z-50 w-48 overflow-hidden py-1.5 text-xs shadow-2xl"
        >
          {ctxMenu.kind === 'layer' ? (
            <>
              <button
                type="button"
                onClick={() => openCreateModule(ctxMenu.layer.id)}
                className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
              >
                <Plus size={13} className="text-[#FFB26B]" />
                Thêm Module vào lớp
              </button>
              <button
                type="button"
                onClick={openCreateLayer}
                className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
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
                className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
              >
                <Edit3 size={13} className="text-muted" />
                Sửa tên Layer
              </button>
              <button
                type="button"
                onClick={() => toggleLayerSync(ctxMenu.layer.id)}
                className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
              >
                <Link2 size={13} className={ctxMenu.layer.syncLayer ? 'text-[#FFB26B]' : 'text-muted'} />
                {ctxMenu.layer.syncLayer ? 'Tắt Sync Layer' : 'Bật Sync Layer (chạy đồng bộ)'}
              </button>
              <button
                type="button"
                onClick={() => toggleLayerVisibility(ctxMenu.layer.id)}
                className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
              >
                {(ctxMenu.layer.visible ?? true) ? <EyeOff size={13} className="text-warn" /> : <Eye size={13} className="text-ok" />}
                {(ctxMenu.layer.visible ?? true) ? 'Ẩn Layer' : 'Hiện Layer'}
              </button>
              {project.layers.length > 1 && (
                <>
                  <div className="mx-3 my-1 border-t border-line" />
                  <button
                    type="button"
                    onClick={() => removeLayer(ctxMenu.layer.id)}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-danger hover:bg-danger/15"
                  >
                    <Trash2 size={13} />
                    Xoá Layer
                  </button>
                </>
              )}
            </>
          ) : (
            (() => {
              const layerMods = project.modules.filter((m) => m.layerId === ctxMenu.mod.layerId)
              const modIdx = layerMods.findIndex((m) => m.id === ctxMenu.mod.id)
              return (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingModId(ctxMenu.mod.id)
                      setRenameText(ctxMenu.mod.name)
                    }}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
                  >
                    <Edit3 size={13} className="text-info" />
                    Đổi tên Module
                  </button>
                  <button
                    type="button"
                    disabled={modIdx <= 0}
                    onClick={() => moveModule(ctxMenu.mod.id, -1)}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp size={13} className="text-muted" />
                    Đưa lên
                  </button>
                  <button
                    type="button"
                    disabled={modIdx === -1 || modIdx >= layerMods.length - 1}
                    onClick={() => moveModule(ctxMenu.mod.id, 1)}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowDown size={13} className="text-muted" />
                    Đưa xuống
                  </button>
                  <button
                    type="button"
                    onClick={() => duplicateModule(ctxMenu.mod.id)}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
                  >
                    <Copy size={13} className="text-[#FFB26B]" />
                    Nhân bản Module
                  </button>
                  <button
                    type="button"
                    onClick={() => updateModule(ctxMenu.mod.id, { dmxLoop: !ctxMenu.mod.dmxLoop })}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
                  >
                    <Link2 size={13} className={ctxMenu.mod.dmxLoop ? 'text-info' : 'text-muted'} />
                    {ctxMenu.mod.dmxLoop ? 'Tắt Loop DMX' : 'Bật Loop DMX (chung 4 kênh)'}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleModuleVisibility(ctxMenu.mod.id)}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-fg hover:bg-white/8"
                  >
                    {(ctxMenu.mod.visible ?? true) ? <EyeOff size={13} className="text-warn" /> : <Eye size={13} className="text-ok" />}
                    {(ctxMenu.mod.visible ?? true) ? 'Ẩn Module' : 'Hiện Module'}
                  </button>
                  <div className="mx-3 my-1 border-t border-line" />
                  <button
                    type="button"
                    onClick={() => removeModule(ctxMenu.mod.id)}
                    className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-danger hover:bg-danger/15"
                  >
                    <Trash2 size={13} />
                    Xoá Module
                  </button>
                </>
              )
            })()
          )}
        </div>
      )}
    </div>
  )
}
