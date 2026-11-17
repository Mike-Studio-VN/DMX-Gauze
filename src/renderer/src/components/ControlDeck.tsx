import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Clock,
  Edit3,
  LayoutGrid,
  Plus,
  SlidersHorizontal,
  Square,
  Trash2,
} from 'lucide-react'
import { clamp } from '@shared/convert'
import type { CueButton, ModuleCfg, SpeedUnit } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { TimelineEditor } from './TimelineEditor'

function ActionBtn({
  icon: Icon,
  label,
  hint,
  onClick,
  variant = 'ghost',
  active = false,
}: {
  icon: typeof ArrowUp
  label: string
  hint: string
  onClick: () => void
  variant?: 'brand' | 'info' | 'danger' | 'ghost'
  active?: boolean
}) {
  const cls =
    variant === 'brand'
      ? 'bg-brand text-brand-fg hover:brightness-110'
      : variant === 'info'
        ? 'bg-info text-slate-950 hover:brightness-110'
        : variant === 'danger'
          ? 'bg-danger text-black hover:brightness-110'
          : active
            ? 'border border-brand bg-brand/20 text-brand'
            : 'border border-line bg-panel-2 text-fg hover:bg-line'

  return (
    <motion.button
      type="button"
      title={hint}
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.93 }}
      transition={{ type: 'spring', stiffness: 520, damping: 28 }}
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-ui px-3.5 text-xs font-semibold ${cls}`}
    >
      <Icon size={16} aria-hidden />
      <span>{label}</span>
    </motion.button>
  )
}

function ModeButtons() {
  const { project, snapshot, selectedButtonId, selectButton, saveButton, deleteButton, sendCommand, notify } =
    useAppStore()
  const [editing, setEditing] = useState<CueButton | null>(null)
  const [layerHeights, setLayerHeights] = useState<Record<string, string>>({})
  const [lastFired, setLastFired] = useState<string | null>(null)

  // Hỗ trợ Enter/F2 để sửa nút đang chọn
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return
      if (e.key === 'F2' && selectedButtonId && !editing) {
        const found = project.buttons.find((b) => b.id === selectedButtonId)
        if (found) {
          e.preventDefault()
          setLayerHeights({})
          setEditing(found)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedButtonId, editing, project.buttons])

  const fire = async (b: CueButton) => {
    selectButton(b.id)
    setLastFired(b.id)
    for (const s of b.steps) {
      const res = await sendCommand({
        type: 'move',
        ids: [s.moduleId],
        target: s.position,
        speed: { unit: b.speedUnit, value: b.speedValue },
      })
      if (!res.ok) break
    }
  }

  const openNew = () => {
    setLayerHeights({})
    setEditing({
      id: `cue-${Date.now()}`,
      name: `Cảnh ${project.buttons.length + 1}`,
      steps: project.modules.map((m) => ({
        moduleId: m.id,
        position: Number((snapshot?.modules[m.id]?.pos ?? 0).toFixed(2)),
      })),
      speedUnit: 'sec',
      speedValue: 4,
    })
  }

  const toggleModule = (m: ModuleCfg) => {
    if (!editing) return
    const exists = editing.steps.some((s) => s.moduleId === m.id)
    const steps = exists
      ? editing.steps.filter((s) => s.moduleId !== m.id)
      : [
          ...editing.steps,
          { moduleId: m.id, position: Number((snapshot?.modules[m.id]?.pos ?? m.minHeight).toFixed(2)) },
        ]
    setEditing({ ...editing, steps })
  }

  const setModuleHeight = (m: ModuleCfg, rawPos: number) => {
    if (!editing) return
    const pos = clamp(rawPos, m.minHeight, m.maxHeight)
    const exists = editing.steps.some((s) => s.moduleId === m.id)
    const steps = exists
      ? editing.steps.map((s) => (s.moduleId === m.id ? { ...s, position: pos } : s))
      : [...editing.steps, { moduleId: m.id, position: pos }]
    setEditing({ ...editing, steps })
  }

  const toggleLayerInButton = (layerId: string) => {
    if (!editing) return
    const mods = project.modules.filter((m) => m.layerId === layerId)
    const modIds = new Set(mods.map((m) => m.id))
    const allSelected = mods.length > 0 && mods.every((m) => editing.steps.some((s) => s.moduleId === m.id))
    if (allSelected) {
      setEditing({ ...editing, steps: editing.steps.filter((s) => !modIds.has(s.moduleId)) })
      return
    }
    const nextSteps = [...editing.steps]
    for (const m of mods) {
      if (!nextSteps.some((s) => s.moduleId === m.id)) {
        nextSteps.push({ moduleId: m.id, position: Number((snapshot?.modules[m.id]?.pos ?? m.minHeight).toFixed(2)) })
      }
    }
    setEditing({ ...editing, steps: nextSteps })
  }

  const applyLayerHeight = (layerId: string, heightM: number) => {
    if (!editing) return
    const mods = project.modules.filter((m) => m.layerId === layerId)
    const modMap = new Map(mods.map((m) => [m.id, m]))
    const rest = editing.steps.filter((s) => !modMap.has(s.moduleId))
    const added = mods.map((m) => ({
      moduleId: m.id,
      position: Number(clamp(heightM, m.minHeight, m.maxHeight).toFixed(2)),
    }))
    setEditing({ ...editing, steps: [...rest, ...added] })
  }

  if (editing) {
    const stepMap = new Map(editing.steps.map((s) => [s.moduleId, s.position]))

    return (
      <div className="flex h-full flex-col gap-2 overflow-hidden text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="Tên nút điều khiển"
            className="min-w-36 flex-1 rounded border border-line bg-bg px-2.5 py-1.5 text-fg"
          />
          <select
            value={editing.speedUnit}
            onChange={(e) => setEditing({ ...editing, speedUnit: e.target.value as SpeedUnit })}
            className="rounded border border-line bg-bg px-2 py-1.5 text-fg"
          >
            <option value="sec">Theo giây (s)</option>
            <option value="cms">Theo tốc độ (cm/s)</option>
          </select>
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={editing.speedValue}
            onChange={(e) => setEditing({ ...editing, speedValue: Math.max(0.1, Number(e.target.value) || 1) })}
            className="w-20 rounded border border-line bg-bg px-2 py-1.5 text-fg tabular-nums"
          />
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="cursor-pointer rounded border border-line px-2.5 py-1.5 text-muted hover:text-fg"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={() => {
              if (editing.steps.length === 0) {
                notify('Chọn ít nhất 1 layer hoặc module cho nút này', 'warn')
                return
              }
              saveButton(editing)
              setEditing(null)
            }}
            className="cursor-pointer rounded bg-brand px-3 py-1.5 font-semibold text-brand-fg"
          >
            Lưu nút ({editing.steps.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
          <span>Chọn theo Layer (gán nhanh cả lớp) hoặc từng Module và đặt chiều cao (m)</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                setEditing({
                  ...editing,
                  steps: project.modules.map((m) => ({
                    moduleId: m.id,
                    position: Number((stepMap.get(m.id) ?? snapshot?.modules[m.id]?.pos ?? 0).toFixed(2)),
                  })),
                })
              }
              className="cursor-pointer rounded bg-panel-2 px-2 py-0.5 text-info hover:bg-line"
            >
              Chọn hết
            </button>
            <button
              type="button"
              onClick={() => setEditing({ ...editing, steps: [] })}
              className="cursor-pointer rounded bg-panel-2 px-2 py-0.5 text-muted hover:bg-line hover:text-fg"
            >
              Bỏ chọn
            </button>
            <button
              type="button"
              onClick={() =>
                setEditing({
                  ...editing,
                  steps: editing.steps.map((s) => ({
                    ...s,
                    position: Number((snapshot?.modules[s.moduleId]?.pos ?? s.position).toFixed(2)),
                  })),
                })
              }
              className="cursor-pointer rounded bg-panel-2 px-2 py-0.5 text-brand hover:bg-line"
            >
              Lấy vị trí 3D hiện tại
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {project.layers.map((layer) => {
            const mods = project.modules.filter((m) => m.layerId === layer.id)
            const selectedCount = mods.filter((m) => stepMap.has(m.id)).length
            const allChecked = mods.length > 0 && selectedCount === mods.length
            const layerVal = layerHeights[layer.id] ?? '1'

            return (
              <div key={layer.id} className="space-y-1.5 rounded-lg border border-line bg-panel-2/40 p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-2 font-semibold text-info">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() => toggleLayerInButton(layer.id)}
                      className="accent-brand"
                    />
                    <span>{layer.name}</span>
                    <span className="text-[11px] font-normal text-muted">
                      ({selectedCount}/{mods.length})
                    </span>
                  </label>

                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted">Cả layer (m):</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={layerVal}
                      onChange={(e) => setLayerHeights({ ...layerHeights, [layer.id]: e.target.value })}
                      className="w-16 rounded border border-line bg-bg px-1.5 py-0.5 text-right text-fg tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => applyLayerHeight(layer.id, Number(layerVal) || 0)}
                      className="cursor-pointer rounded bg-info/20 px-2 py-0.5 text-[11px] font-medium text-info hover:bg-info/30"
                    >
                      Áp dụng
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                  {mods.map((m) => {
                    const checked = stepMap.has(m.id)
                    const pos = stepMap.get(m.id) ?? 0
                    return (
                      <div
                        key={m.id}
                        className={`flex items-center justify-between gap-1.5 rounded border px-2 py-1 ${
                          checked ? 'border-brand/50 bg-panel-2' : 'border-line/60 bg-bg/40 opacity-65'
                        }`}
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleModule(m)}
                            className="shrink-0 accent-brand"
                          />
                          <span className="truncate" title={`${m.name} (${m.minHeight}–${m.maxHeight}m)`}>
                            {m.name}
                          </span>
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          min={m.minHeight}
                          max={m.maxHeight}
                          value={pos}
                          onChange={(e) => setModuleHeight(m, Number(e.target.value) || 0)}
                          className="w-14 rounded border border-line bg-bg px-1 py-0.5 text-right text-fg tabular-nums"
                        />
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

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Bấm nút để chạy · Ctrl+C / Ctrl+V sao chép · F2 sửa · Delete xoá</span>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-brand px-2.5 py-1 font-semibold text-brand-fg"
        >
          <Plus size={14} />
          Tạo nút
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
        {project.buttons.map((b) => {
          const active = lastFired === b.id || selectedButtonId === b.id
          const stepIds = new Set(b.steps.map((s) => s.moduleId))
          const fullLayers = project.layers.filter((l) => {
            const mods = project.modules.filter((m) => m.layerId === l.id)
            return mods.length > 0 && mods.every((m) => stepIds.has(m.id))
          })
          const summary =
            fullLayers.length === 1 && stepIds.size === project.modules.filter((m) => m.layerId === fullLayers[0].id).length
              ? fullLayers[0].name
              : `${b.steps.length} màn`

          return (
            <motion.div
              key={b.id}
              whileTap={{ scale: 0.95 }}
              onClick={() => selectButton(b.id)}
              onDoubleClick={() => {
                setLayerHeights({})
                setEditing(b)
              }}
              className={`group relative flex flex-col justify-between rounded-ui border p-2.5 transition ${
                active ? 'border-brand bg-brand/15' : 'border-line bg-panel-2/70 hover:border-info/60'
              }`}
            >
              <button type="button" onClick={() => fire(b)} className="flex-1 cursor-pointer text-left">
                <div className="truncate text-sm font-semibold text-fg">{b.name}</div>
                <div className="mt-1 truncate text-[11px] text-muted">
                  {summary} · {b.speedValue} {b.speedUnit === 'sec' ? 'giây' : 'cm/s'}
                </div>
              </button>
              <div className="mt-2 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setLayerHeights({})
                    setEditing(b)
                  }}
                  title="Sửa nút (F2)"
                  className="cursor-pointer rounded p-1 text-muted hover:bg-line hover:text-fg"
                >
                  <Edit3 size={12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteButton(b.id)
                  }}
                  title="Xoá nút (Delete)"
                  className="cursor-pointer rounded p-1 text-muted hover:bg-danger/20 hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function ModeManual() {
  const { selectedIds, sendCommand } = useAppStore()
  const [unit, setUnit] = useState<SpeedUnit>('cms')
  const [val, setVal] = useState(47)
  const [targetM, setTargetM] = useState(0.5)

  const speedSpec = { unit, value: Math.max(0.1, val) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault()
        void sendCommand({ type: 'stop', ids: 'all' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sendCommand])

  return (
    <div className="flex h-full flex-col justify-between gap-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted">
          Áp dụng cho <strong className="text-brand">{selectedIds.length}</strong> module đang chọn · Phím{' '}
          <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 text-[10px]">Space</kbd> = Dừng tất cả
        </span>

        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-line bg-bg">
            <button
              type="button"
              onClick={() => {
                setUnit('cms')
                setVal(47)
              }}
              className={`cursor-pointer px-2.5 py-1 ${unit === 'cms' ? 'bg-info font-semibold text-slate-950' : 'text-muted'}`}
            >
              cm/s
            </button>
            <button
              type="button"
              onClick={() => {
                setUnit('sec')
                setVal(4)
              }}
              className={`cursor-pointer px-2.5 py-1 ${unit === 'sec' ? 'bg-info font-semibold text-slate-950' : 'text-muted'}`}
            >
              Giây
            </button>
          </div>
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={val}
            onChange={(e) => setVal(Number(e.target.value) || 1)}
            aria-label="Giá trị tốc độ hoặc số giây"
            className="w-20 rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
          />
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2">
        <ActionBtn
          icon={ArrowUpToLine}
          label="Về 0"
          hint="Thu màn hoàn toàn về vị trí 0 m"
          onClick={() => sendCommand({ type: 'move', ids: selectedIds, target: 'zero', speed: speedSpec })}
        />
        <ActionBtn
          icon={ArrowUp}
          label="Lên (Min)"
          hint="Di chuyển lên giới hạn Min đã cài"
          variant="info"
          onClick={() => sendCommand({ type: 'move', ids: selectedIds, target: 'min', speed: speedSpec })}
        />
        <ActionBtn
          icon={Square}
          label="Dừng"
          hint="Dừng ngay và giữ nguyên vị trí hiện tại (Space)"
          variant="danger"
          onClick={() => sendCommand({ type: 'stop', ids: selectedIds })}
        />
        <ActionBtn
          icon={ArrowDown}
          label="Xuống (Max)"
          hint="Di chuyển xuống giới hạn Max đã cài"
          variant="brand"
          onClick={() => sendCommand({ type: 'move', ids: selectedIds, target: 'max', speed: speedSpec })}
        />
        <ActionBtn
          icon={ArrowDownToLine}
          label="Dài Max"
          hint="Thả hết chiều dài tối đa của màn"
          onClick={() => sendCommand({ type: 'move', ids: selectedIds, target: 'length', speed: speedSpec })}
        />
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2/60 px-3 py-1.5">
        <span className="text-muted">Đặt nhanh độ cao (m):</span>
        <input
          type="number"
          step="0.1"
          min="0"
          value={targetM}
          onChange={(e) => setTargetM(Number(e.target.value) || 0)}
          className="w-20 rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
        />
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          onClick={() => sendCommand({ type: 'move', ids: selectedIds, target: targetM, speed: speedSpec })}
          className="cursor-pointer rounded bg-brand px-3 py-1 font-semibold text-brand-fg"
        >
          Chạy tới {targetM}m
        </motion.button>
      </div>
    </div>
  )
}

export function ControlDeck() {
  const { activeTab, setActiveTab } = useAppStore()

  const tabs = [
    { id: 'buttons' as const, label: 'Mode 1 · Nút sẵn', icon: LayoutGrid },
    { id: 'manual' as const, label: 'Mode 2 · Thủ công', icon: SlidersHorizontal },
    { id: 'timeline' as const, label: 'Mode 3 · Timeline', icon: Clock },
  ]

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1 border-b border-line pb-2">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                active ? 'bg-brand text-brand-fg' : 'bg-panel-2 text-muted hover:text-fg'
              }`}
            >
              <Icon size={14} aria-hidden />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1">
        {activeTab === 'buttons' && <ModeButtons />}
        {activeTab === 'manual' && <ModeManual />}
        {activeTab === 'timeline' && <TimelineEditor />}
      </div>
    </div>
  )
}
