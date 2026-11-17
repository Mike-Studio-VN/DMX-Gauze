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
  Play,
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
}: {
  icon: typeof ArrowUp
  label: string
  hint: string
  onClick: () => void
  variant?: 'brand' | 'info' | 'danger' | 'ghost'
}) {
  const cls =
    variant === 'brand'
      ? 'kiln-btn kiln-btn-primary'
      : variant === 'info'
        ? 'kiln-btn kiln-btn-cue'
        : variant === 'danger'
          ? 'kiln-btn kiln-btn-danger'
          : 'kiln-btn'

  return (
    <motion.button
      type="button"
      title={hint}
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 520, damping: 28 }}
      className={`h-10 px-3.5 text-xs ${cls}`}
    >
      <Icon size={15} aria-hidden />
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
            className="kiln-field h-8 min-w-36 flex-1 px-3 text-xs"
          />
          <select
            value={editing.speedUnit}
            onChange={(e) => setEditing({ ...editing, speedUnit: e.target.value as SpeedUnit })}
            className="kiln-field h-8 px-2.5 text-xs"
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
            className="kiln-field h-8 w-20 px-2.5 text-xs tabular-nums"
          />
          <button type="button" onClick={() => setEditing(null)} className="kiln-btn h-8 px-3 text-xs">
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
            className="kiln-btn kiln-btn-primary h-8 px-3.5 text-xs"
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
              className="kiln-btn kiln-btn-cue h-6 px-2.5 text-[11px]"
            >
              Chọn hết
            </button>
            <button
              type="button"
              onClick={() => setEditing({ ...editing, steps: [] })}
              className="kiln-btn h-6 px-2.5 text-[11px]"
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
              className="kiln-btn h-6 px-2.5 text-[11px] text-[#FFB26B]"
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
              <div key={layer.id} className="kiln-layer space-y-2 p-2.5">
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
                    <span className="text-[11px] text-[#C2B3A4]">Cả layer (m):</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={layerVal}
                      onChange={(e) => setLayerHeights({ ...layerHeights, [layer.id]: e.target.value })}
                      className="kiln-field h-6 w-16 px-2 text-right text-xs tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => applyLayerHeight(layer.id, Number(layerVal) || 0)}
                      className="kiln-btn kiln-btn-cue h-6 px-2.5 text-[11px]"
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
                        className={`flex items-center justify-between gap-1.5 rounded-xl px-2 py-1 transition ${
                          checked
                            ? 'bg-black/30 shadow-[inset_0_0_0_1px_rgba(247,132,46,.45)]'
                            : 'bg-black/15 opacity-60 shadow-[inset_0_0_0_1px_var(--line)]'
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
                          className="kiln-field h-6 w-14 px-1.5 text-right text-xs tabular-nums"
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
        <button type="button" onClick={openNew} className="kiln-btn kiln-btn-primary h-7 px-3 text-xs">
          <Plus size={13} />
          Tạo nút
        </button>
      </div>

      {/* Thẻ nút theo cấu trúc Clip tách bar + body của Kiln */}
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
              whileTap={{ scale: 0.96 }}
              onClick={() => selectButton(b.id)}
              onDoubleClick={() => {
                setLayerHeights({})
                setEditing(b)
              }}
              className={`kiln-clip group flex flex-col ${active ? 'sel' : ''}`}
            >
              <button
                type="button"
                onClick={() => fire(b)}
                className="clip-bar flex h-[24px] w-full cursor-pointer items-center gap-1.5 px-2.5 text-left text-[11px] font-semibold"
              >
                <Play size={10} fill="currentColor" className="shrink-0" />
                <span className="truncate">{b.name}</span>
              </button>

              <div className="clip-body flex flex-1 items-center justify-between px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => fire(b)}
                  className="min-w-0 flex-1 cursor-pointer text-left text-[11px] text-[#C2B3A4]"
                >
                  <div className="truncate">{summary}</div>
                  <div className={`text-[10px] ${active ? 'text-[#FFB26B]' : 'text-muted'}`}>
                    {b.speedValue} {b.speedUnit === 'sec' ? 'giây' : 'cm/s'}
                  </div>
                </button>
                <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setLayerHeights({})
                      setEditing(b)
                    }}
                    title="Sửa nút (F2)"
                    className="cursor-pointer rounded-full p-1 text-muted hover:bg-white/10 hover:text-fg"
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
                    className="cursor-pointer rounded-full p-1 text-muted hover:bg-danger/20 hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
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
          Áp dụng cho <strong className="text-[#FFB26B]">{selectedIds.length}</strong> module đang chọn · Phím{' '}
          <span className="kiln-kbd">Space</span> = Dừng tất cả
        </span>

        <div className="flex items-center gap-2">
          <div className="kiln-seg">
            <button
              type="button"
              onClick={() => {
                setUnit('cms')
                setVal(47)
              }}
              className={`kiln-seg-btn h-[22px] px-2.5 text-[11px] ${unit === 'cms' ? 'on-warm' : ''}`}
            >
              cm/s
            </button>
            <button
              type="button"
              onClick={() => {
                setUnit('sec')
                setVal(4)
              }}
              className={`kiln-seg-btn h-[22px] px-2.5 text-[11px] ${unit === 'sec' ? 'on-warm' : ''}`}
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
            className="kiln-field h-7 w-20 px-2.5 text-xs tabular-nums"
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

      <div className="flex items-center gap-2 rounded-2xl bg-black/25 px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--line)]">
        <span className="text-[#C2B3A4]">Đặt nhanh độ cao (m):</span>
        <input
          type="number"
          step="0.1"
          min="0"
          value={targetM}
          onChange={(e) => setTargetM(Number(e.target.value) || 0)}
          className="kiln-field h-7 w-20 px-2.5 text-xs tabular-nums"
        />
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          onClick={() => sendCommand({ type: 'move', ids: selectedIds, target: targetM, speed: speedSpec })}
          className="kiln-btn kiln-btn-primary h-7 px-3.5 text-xs"
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
      <div className="flex items-center">
        <div className="kiln-seg">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = activeTab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`kiln-seg-btn ${active ? 'on' : ''}`}
              >
                <Icon size={13} aria-hidden />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeTab === 'buttons' && <ModeButtons />}
        {activeTab === 'manual' && <ModeManual />}
        {activeTab === 'timeline' && <TimelineEditor />}
      </div>
    </div>
  )
}
