import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  LayoutGrid,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import {
  type ManualMotionBaseline,
  clamp,
  computeManualMotionProgress,
  computeManualWaveLayout,
  computeSharedManualWaveLevel,
  resolveCueButtonBaselines,
} from '@shared/convert'
import { DEFAULT_MOTION_SPEED_CMS, cueSpeedSummary, defaultCueSpeedCms, stepSpeed } from '@shared/timeline'
import type { CueButton, SpeedUnit } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { TimelineEditor } from './TimelineEditor'
import { NumberField } from './DraftInput'

type ManualBtnPhase = 'idle' | 'run'

interface ManualRunState {
  dir: 'up' | 'down'
  phase: ManualBtnPhase
  startedAt: number
  completedAt?: number
  baselines: Record<string, ManualMotionBaseline>
  progress: number
  etaSec: number
}

function WaveCrestSvg({
  edge,
  color,
  rimColor,
  variant,
  className = '',
}: {
  edge: 'top' | 'bottom'
  color: string
  rimColor?: string
  variant: 'front' | 'back'
  className?: string
}) {
  // Chu kỳ 400 (0..800 = 2 chu kỳ) khớp điểm đầu/cuối tại y=18 để trượt -50% mượt không bị giật nối.
  const wavePath =
    edge === 'top'
      ? variant === 'front'
        ? 'M 0 18 Q 100 1, 200 18 T 400 18 Q 500 1, 600 18 T 800 18'
        : 'M 0 18 Q 100 34, 200 18 T 400 18 Q 500 34, 600 18 T 800 18'
      : variant === 'front'
        ? 'M 0 18 Q 100 35, 200 18 T 400 18 Q 500 35, 600 18 T 800 18'
        : 'M 0 18 Q 100 2, 200 18 T 400 18 Q 500 2, 600 18 T 800 18'
  const fillD = edge === 'top' ? `${wavePath} L 800 36 L 0 36 Z` : `${wavePath} L 800 0 L 0 0 Z`

  return (
    <svg
      viewBox="0 0 800 36"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`manual-wave-crest ${edge === 'top' ? 'manual-wave-crest-top' : 'manual-wave-crest-bottom'} ${
        variant === 'front' ? 'manual-wave-drift-a' : 'manual-wave-drift-b'
      } ${className}`}
    >
      <path d={fillD} fill={color} />
      {rimColor && <path d={wavePath} fill="none" stroke={rimColor} strokeWidth="2.2" />}
    </svg>
  )
}

function SharedWaveBackdrop({
  ratio,
  moving,
  backColor,
  frontColor,
  rimColor,
}: {
  ratio: number
  moving: boolean
  backColor: string
  frontColor: string
  rimColor: string
}) {
  // Lớp sóng sau bám sát phần trăm và phủ tràn đáy (-48px); khi ở 100% lớp trước hơi lộ ngọn sóng để thấy rõ hiệu ứng sóng.
  const frontRatio = ratio >= 0.995 ? 0.92 : ratio
  const backLayout = computeManualWaveLayout('up', 'run', clamp(ratio * (moving ? 0.97 : 1), 0, 1))
  const backTransform = ratio >= 0.995 ? 'translate3d(0, -18px, 0)' : backLayout.transform
  const frontLayout = computeManualWaveLayout('up', 'run', frontRatio)

  return (
    <div className="manual-wave-layer" aria-hidden="true">
      <div className="manual-wave-sheet" style={{ transform: backTransform }}>
        <WaveCrestSvg edge="top" variant="back" color={backColor} />
        <div className="manual-wave-fill-body" style={{ background: backColor }} />
      </div>
      <div className="manual-wave-sheet" style={{ transform: frontLayout.transform }}>
        <WaveCrestSvg edge="top" variant="front" color={frontColor} rimColor={rimColor} />
        <div className="manual-wave-fill-body" style={{ background: frontColor }} />
      </div>
    </div>
  )
}

function ManualProgressButton({
  dir,
  label,
  hint,
  phase,
  waveRatio,
  waveMoving,
  progress,
  etaSec,
  speedText,
  unitLabel,
  onClick,
}: {
  dir: 'up' | 'down'
  label: string
  hint: string
  phase: ManualBtnPhase
  waveRatio: number
  waveMoving: boolean
  progress: number
  etaSec: number
  speedText: string
  unitLabel: string
  onClick: () => void
}) {
  const Icon = dir === 'up' ? ArrowUp : ArrowDown
  const wavePct = Math.round(clamp(waveRatio, 0, 1) * 100)
  const movePct = Math.round(clamp(progress, 0, 1) * 100)
  const etaText = movePct >= 100 ? '0s' : `${Math.max(1, Math.ceil(etaSec))}s`
  const isUp = dir === 'up'
  const isRunning = phase === 'run'
  const statusText = isRunning
    ? `${isUp ? 'Đang chạy lên' : 'Đang chạy xuống'} · ${wavePct}% · ${etaText}`
    : isUp ? 'Chạm để chạy lên' : 'Chạm để chạy xuống'

  const backColor = isUp ? 'rgba(42, 92, 168, 0.56)' : 'rgba(164, 60, 8, 0.42)'
  const frontColor = isUp ? 'rgba(68, 138, 244, 0.70)' : 'rgba(202, 82, 12, 0.56)'
  const rimColor = isUp ? 'rgba(174, 214, 255, 0.52)' : 'rgba(255, 224, 180, 0.35)'

  return (
    <button
      type="button"
      title={hint}
      aria-label={`${label} (${speedText} ${unitLabel})`}
      onClick={onClick}
      data-state={isRunning || waveMoving ? 'run' : 'idle'}
      data-active={isRunning || undefined}
      data-wave-pct={wavePct}
      className={`manual-card ${isUp ? 'manual-card-up' : 'manual-card-down'}`}
    >
      <SharedWaveBackdrop
        ratio={waveRatio}
        moving={isRunning || waveMoving}
        backColor={backColor}
        frontColor={frontColor}
        rimColor={rimColor}
      />

      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] leading-tight font-bold">{label}</div>
          <div className="manual-card-detail mt-0.5 truncate text-[11px]" title={statusText}>{statusText}</div>
        </div>
        <span className="manual-card-badge">{wavePct}%</span>
      </div>

      <div className="relative z-10 flex items-center justify-center py-0.5">
        <span className="manual-card-icon-ring">
          <Icon size={20} strokeWidth={2.2} className="manual-card-arrow" aria-hidden="true" />
        </span>
      </div>

      <div className="relative z-10 flex min-w-0 items-baseline gap-1 tabular-nums">
        <span className="min-w-0 truncate text-[20px] leading-none font-bold">{speedText}</span>
        <span className="manual-card-detail shrink-0 whitespace-nowrap text-[11px] font-medium">{unitLabel}</span>
      </div>
    </button>
  )
}

function ManualStopButton({
  hint,
  unitLabel,
  waveRatio,
  waveMoving,
  onClick,
}: {
  hint: string
  unitLabel: string
  waveRatio: number
  waveMoving: boolean
  onClick: () => void
}) {
  const wavePct = Math.round(clamp(waveRatio, 0, 1) * 100)
  return (
    <button
      type="button"
      title={hint}
      aria-label="Dừng module đang chọn"
      onClick={onClick}
      data-state={waveMoving ? 'run' : 'idle'}
      data-wave-pct={wavePct}
      className="manual-card manual-card-stop"
    >
      <SharedWaveBackdrop
        ratio={waveRatio}
        moving={waveMoving}
        backColor="rgba(116, 44, 40, 0.56)"
        frontColor="rgba(164, 66, 60, 0.62)"
        rimColor="rgba(255, 168, 158, 0.42)"
      />

      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] leading-tight font-bold">Dừng</div>
          <div className="manual-card-detail mt-0.5 truncate text-[11px]" title="Dừng module chọn">Dừng module chọn</div>
        </div>
        <span className="manual-card-badge">{wavePct}%</span>
      </div>

      <div className="relative z-10 flex items-center justify-center py-0.5">
        <span className="manual-card-icon-ring">
          <span className="h-3.5 w-3.5 rounded-[3.5px] bg-current" aria-hidden="true" />
        </span>
      </div>

      <div className="relative z-10 flex items-baseline gap-1 tabular-nums">
        <span className="text-[20px] leading-none font-bold">0</span>
        <span className="manual-card-detail shrink-0 whitespace-nowrap text-[11px] font-medium">{unitLabel}</span>
      </div>
    </button>
  )
}

export function ModeButtons(props: {
  overrideState?: Partial<ReturnType<typeof useAppStore.getState>>
}) {
  const storeState = useAppStore()
  const {
    project,
    snapshot,
    selectedButtonId,
    lastFiredButtonId,
    lastFiredButtonBaselines,
    selectedIds,
    selectButton,
    setLastFiredButton,
    moveButtonToSlot,
    saveButton,
    deleteButton,
    sendCommand,
  } = props.overrideState ? { ...storeState, ...props.overrideState } : storeState
  const [draggedButtonId, setDraggedButtonId] = useState<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null)
  const cueRun = useRef(0)

  useEffect(() => () => { cueRun.current += 1 }, [])

  const buildCueBaselines = (b: CueButton, previous?: Record<string, ManualMotionBaseline> | null) =>
    resolveCueButtonBaselines(b.steps, project.modules, snapshot, previous)

  const fire = async (b: CueButton) => {
    const run = ++cueRun.current
    selectButton(b.id)
    const isResumingSameCue = lastFiredButtonId === b.id
    const baselines = buildCueBaselines(b, isResumingSameCue ? lastFiredButtonBaselines : null)
    setLastFiredButton(b.id, baselines)
    for (const s of b.steps) {
      if (cueRun.current !== run) break
      // Cue luôn Manual: tốc độ của module này = riêng của bước (nếu có) hoặc tốc độ chung của cue; không còn giới hạn auto.
      const eff = stepSpeed(b, s)
      let speedVal = eff.value
      if (eff.unit === 'sec' && isResumingSameCue) {
        const base = baselines[s.moduleId]
        const curPos = snapshot?.modules[s.moduleId]?.pos ?? base?.start
        if (base && curPos !== undefined) {
          const span = Math.abs(base.goal - base.start)
          const left = Math.abs(base.goal - curPos)
          if (span >= 0.005 && left > 0.008 && left < span - 0.005) {
            speedVal = Math.max(0.1, Number((eff.value * (left / span)).toFixed(2)))
          }
        }
      }
      const res = await sendCommand({
        type: 'move',
        ids: [s.moduleId],
        // CH1 nhập thẳng → target {ch1} (đúng byte, kẹp theo min–max); CH3 nhập thẳng → unit 'ch3' (đúng byte, 1..255).
        target: s.unit === 'ch1' ? { ch1: s.position } : s.position,
        speed: { unit: eff.unit, value: speedVal },
      }, { source: 'buttons' })
      if (!res.ok) break
    }
  }

  const pauseCue = async (b: CueButton) => {
    cueRun.current += 1
    const ids = b.steps.map((s) => s.moduleId)
    if (ids.length > 0) await sendCommand({ type: 'stop', ids }, { source: 'buttons' })
  }

  const totalSlots = Math.max(8, Math.ceil((Math.max(project.buttons.length, ...project.buttons.map((b, i) => (b.slotIndex ?? i) + 1)) + 1) / 4) * 4)
  const slotMap = new Map<number, CueButton>()
  const unslotted: CueButton[] = []
  for (const b of project.buttons) {
    if (b.slotIndex !== undefined && !slotMap.has(b.slotIndex)) {
      slotMap.set(b.slotIndex, b)
    } else {
      unslotted.push(b)
    }
  }
  for (const b of unslotted) {
    let idx = 0
    while (slotMap.has(idx)) idx += 1
    slotMap.set(idx, b)
  }

  const createNewCue = () => {
    const chosenMods =
      selectedIds.length > 0 ? project.modules.filter((m) => selectedIds.includes(m.id)) : project.modules
    const targetMods = chosenMods.length > 0 ? chosenMods : project.modules
    let nextSlot = 0
    while (slotMap.has(nextSlot)) nextSlot += 1
    const btn: CueButton = {
      id: `cue-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name: `Cue ${project.buttons.length + 1}`,
      steps: targetMods.map((m) => ({
        moduleId: m.id,
        position: Number((snapshot?.modules[m.id]?.pos ?? m.minHeight).toFixed(2)),
      })),
      speedUnit: 'cms',
      speedValue: defaultCueSpeedCms(targetMods),
      autoSpeedLimitCms: DEFAULT_MOTION_SPEED_CMS,
      slotIndex: nextSlot,
      loop: false,
    }
    saveButton(btn)
    selectButton(btn.id)
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Bấm thanh tiêu đề để xem &amp; sửa · Kéo thanh tiêu đề để đổi vị trí · Bấm phần thân để chạy Cue</span>
        <button type="button" onClick={createNewCue} className="kiln-btn kiln-btn-primary h-7 px-3 text-xs">
          <Plus size={13} />
          Tạo Cue
        </button>
      </div>

      {/* Lưới 4 cột tỷ lệ 16:9 đúng layout Cue Pad: bấm bar xem/sửa, kéo bar đổi chỗ, bấm body chạy DMX */}
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 content-start gap-2.5 overflow-y-auto pr-1 sm:grid-cols-4">
        {Array.from({ length: totalSlots }, (_, slotIdx) => {
          const isDropTarget = dragOverSlot === slotIdx && draggedButtonId !== null
          const slotDragProps = {
            onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
              if (!draggedButtonId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOverSlot !== slotIdx) setDragOverSlot(slotIdx)
            },
            onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOverSlot((cur) => (cur === slotIdx ? null : cur))
              }
            },
            onDrop: (e: React.DragEvent<HTMLDivElement>) => {
              e.preventDefault()
              const srcId = draggedButtonId || e.dataTransfer.getData('text/plain')
              setDraggedButtonId(null)
              setDragOverSlot(null)
              if (srcId) moveButtonToSlot(srcId, slotIdx)
            },
          }

          const b = slotMap.get(slotIdx)
          if (!b) {
            return (
              <div
                key={`empty-slot-${slotIdx}`}
                {...slotDragProps}
                className={`cue-pad-slot rounded-[12px] transition ${
                  isDropTarget ? 'ring-2 ring-[var(--acc)] ring-offset-1 ring-offset-[#0a0706]' : ''
                }`}
              >
                <div aria-hidden="true" className="cue-pad cue-pad-empty text-left">
                  <div className="cue-pad-bar" />
                  <div className="cue-pad-body" />
                </div>
              </div>
            )
          }

          const isBarSelected = selectedButtonId === b.id
          const isBodyActive = lastFiredButtonId === b.id
          const isPrevSelected = isBodyActive && !isBarSelected
          const isCueMoving = isBodyActive && b.steps.some((s) => snapshot?.modules[s.moduleId]?.moving)
          const cueProgress = isBodyActive
            ? computeManualMotionProgress(
                Object.keys(lastFiredButtonBaselines ?? {}).length > 0
                  ? lastFiredButtonBaselines
                  : buildCueBaselines(b),
                project.modules,
                snapshot,
              ).progress
            : 0
          const cueProgressPct = Math.round(clamp(cueProgress, 0, 1) * 100)
          const stepIds = new Set(b.steps.map((s) => s.moduleId))
          const matchedLayers = project.layers.filter((l) => {
            const mods = project.modules.filter((m) => m.layerId === l.id)
            return mods.length > 0 && mods.some((m) => stepIds.has(m.id))
          })
          const fullLayers = project.layers.filter((l) => {
            const mods = project.modules.filter((m) => m.layerId === l.id)
            return mods.length > 0 && mods.every((m) => stepIds.has(m.id))
          })
          const centerSummary =
            fullLayers.length === 1 && stepIds.size === project.modules.filter((m) => m.layerId === fullLayers[0].id).length
              ? fullLayers[0].name
              : matchedLayers.length > 0
                ? matchedLayers.map((l) => l.name).join(' + ')
                : `${b.steps.length} modules`
          const leftFooter = `${b.steps.length} MODULES`
          const speedSum = cueSpeedSummary(b)
          const rightFooter =
            speedSum === null
              ? 'NHIỀU TỐC ĐỘ'
              : speedSum.unit === 'sec'
                ? `${speedSum.value}S`
                : speedSum.unit === 'ch3'
                  ? `CH3 ${speedSum.value}`
                  : `${speedSum.value} CM/S`
          const barIconColor = isBarSelected
            ? 'text-[#f3f7ff] hover:bg-white/15'
            : isPrevSelected
              ? 'text-[#dce9ff] hover:bg-white/15'
              : 'text-white/75 hover:bg-white/10'

          return (
            <div
              key={b.id}
              {...slotDragProps}
              className={`cue-pad-slot rounded-[12px] transition ${
                isDropTarget ? 'ring-2 ring-[var(--acc)] ring-offset-1 ring-offset-[#0a0706]' : ''
              }`}
            >
              <div
                className={`cue-pad group${isBodyActive ? ' active' : ''}${isBarSelected ? ' bar-selected' : ''}${isPrevSelected ? ' cue-pad-prev' : ''}${
                  draggedButtonId === b.id ? ' opacity-55' : ''
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    setDraggedButtonId(b.id)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', b.id)
                  }}
                  onDragEnd={() => {
                    setDraggedButtonId(null)
                    setDragOverSlot(null)
                  }}
                  onClick={() => selectButton(b.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      selectButton(b.id)
                    }
                  }}
                  title="Bấm để xem & chỉnh sửa nút Cue · Kéo thả sang ô khác để đổi vị trí"
                  aria-label={`Xem và chỉnh sửa nút ${b.name}`}
                  className="cue-pad-bar cursor-grab active:cursor-grabbing"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (isCueMoving) void pauseCue(b)
                        else void fire(b)
                      }}
                      title={isCueMoving ? 'Tạm dừng Cue' : 'Chạy Cue'}
                      aria-label={isCueMoving ? `Tạm dừng ${b.name}` : `Phát ${b.name}`}
                      className={`inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition ${barIconColor}`}
                    >
                      {isCueMoving ? (
                        <Pause size={17} fill="currentColor" strokeWidth={2.2} />
                      ) : (
                        <Play size={17} fill="currentColor" strokeWidth={2} className="translate-x-[0.5px]" />
                      )}
                    </button>
                    <span className="min-w-0 truncate font-sans" title={b.name}>{b.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (lastFiredButtonId === b.id) setLastFiredButton(null)
                        deleteButton(b.id)
                      }}
                      title="Xoá nút (Delete)"
                      aria-label={`Xoá nút ${b.name}`}
                      className={`cursor-pointer rounded p-1.5 opacity-0 transition group-hover:opacity-100 ${
                        isBarSelected
                          ? 'text-[#f3f7ff] hover:bg-white/15'
                          : isPrevSelected
                            ? 'text-[#dce9ff] hover:bg-white/15'
                            : 'text-white/75 hover:bg-danger/30 hover:text-danger'
                      }`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void fire(b)}
                  title="Bấm vào phần thân để chạy Cue và gửi lệnh DMX"
                  aria-label={`Chạy nút ${b.name}`}
                  className="cue-pad-body cursor-pointer text-left transition-transform active:scale-[0.985]"
                >
                  <div className="flex min-h-0 w-full min-w-0 flex-1 items-center justify-center overflow-hidden px-2 text-center">
                    <span
                      title={centerSummary}
                      className={`min-w-0 truncate text-[10.5px] font-medium ${
                        isBodyActive ? 'font-semibold text-[#c9dcfa]' : 'text-[var(--t3)]'
                      }`}
                    >
                      {centerSummary}
                    </span>
                  </div>
                  <div
                    role={isBodyActive ? 'progressbar' : undefined}
                    aria-valuemin={isBodyActive ? 0 : undefined}
                    aria-valuemax={isBodyActive ? 100 : undefined}
                    aria-valuenow={isBodyActive ? cueProgressPct : undefined}
                    data-cue-progress={isBodyActive ? cueProgressPct : undefined}
                    className={`relative flex w-full items-center justify-between gap-1 overflow-hidden px-2.5 py-1.5 text-[10px] font-semibold tracking-[0.1em] uppercase tabular-nums ${
                      isBodyActive ? 'bg-[#091529]/85 text-[#eff5ff]' : 'bg-black/60 text-[#D7CFC7]'
                    }`}
                  >
                    {isBodyActive && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-[#2860ba] to-[#448af4] transition-[width] duration-75 ease-out"
                        style={{ width: `${cueProgressPct}%` }}
                      />
                    )}
                    <span className="relative z-10 min-w-0 truncate">{leftFooter}</span>
                    <span className="relative z-10 min-w-0 truncate tracking-[0.08em]" title={rightFooter}>{rightFooter}</span>
                  </div>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ModeManual(props: {
  overrideState?: Partial<ReturnType<typeof useAppStore.getState>>
}) {
  const storeState = useAppStore()
  const { project, snapshot, selectedIds, sendCommand, notify } = props.overrideState
    ? { ...storeState, ...props.overrideState }
    : storeState
  const [unit, setUnit] = useState<SpeedUnit>('cms')
  const [val, setVal] = useState(47)
  const [runState, setRunState] = useState<ManualRunState | null>(null)
  const lastMove = useRef<{ target: 'min' | 'max'; ids: string[] } | null>(null)
  const isMoving = Object.values(snapshot?.modules ?? {}).some((mod) => mod.moving)

  const speedSpec = { unit, value: Math.max(0.1, val) }
  const speedText = Number.isInteger(val) ? String(val) : String(Number(val.toFixed(1)))
  const unitLabel = unit === 'cms' ? 'cm/s' : 'giây'
  const sharedWave = computeSharedManualWaveLevel(selectedIds, project.modules, snapshot)

  const runManual = async (cmd: { type: 'move'; target: 'min' | 'max' } | { type: 'stop' }) => {
    if (selectedIds.length === 0) {
      notify('Chưa chọn module nào để điều khiển', 'warn')
      return
    }
    if (cmd.type === 'stop') {
      setRunState(null)
      await sendCommand({ type: 'stop', ids: selectedIds }, { source: 'manual' })
      return
    }
    const dir: 'up' | 'down' = cmd.target === 'min' ? 'up' : 'down'
    const baselines: Record<string, ManualMotionBaseline> = {}
    for (const id of selectedIds) {
      const mod = project.modules.find((m) => m.id === id)
      if (!mod) continue
      const start = snapshot?.modules[id]?.pos ?? 0
      const goal = cmd.target === 'min' ? mod.minHeight : Math.min(mod.length, mod.maxHeight)
      baselines[id] = { start, goal }
    }
    const res = await sendCommand({ type: 'move', ids: selectedIds, target: cmd.target, speed: speedSpec }, { source: 'manual' })
    if (!res.ok) {
      setRunState(null)
      return
    }
    lastMove.current = { target: cmd.target, ids: selectedIds }
    const initial = computeManualMotionProgress(baselines, project.modules, snapshot)
    setRunState({
      dir,
      phase: 'run',
      startedAt: performance.now(),
      baselines,
      progress: initial.progress,
      etaSec: initial.etaSec,
    })
  }

  useEffect(() => {
    if (!runState || runState.phase !== 'run') return
    const res = computeManualMotionProgress(runState.baselines, project.modules, snapshot)
    const elapsed = performance.now() - runState.startedAt

    if (res.reached) {
      const now = performance.now()
      const completedAt = runState.completedAt ?? now
      if (!runState.completedAt || runState.progress < 1) {
        const tFill = window.setTimeout(() => {
          setRunState((cur) =>
            cur?.phase === 'run' && cur.dir === runState.dir
              ? { ...cur, progress: 1, etaSec: 0, completedAt: cur.completedAt ?? now }
              : cur,
          )
        }, 0)
        return () => window.clearTimeout(tFill)
      }
      const minShownMs = Math.max(0, 260 - elapsed)
      const holdFullMs = Math.max(0, 420 - (now - completedAt))
      const tEnd = window.setTimeout(() => {
        setRunState((cur) => (cur?.phase === 'run' && cur.dir === runState.dir ? null : cur))
      }, Math.max(minShownMs, holdFullMs))
      return () => window.clearTimeout(tEnd)
    }

    if (elapsed >= 260 && (!res.anyMoving || snapshot?.locked)) {
      const t = window.setTimeout(() => {
        setRunState((cur) => (cur?.phase === 'run' && cur.dir === runState.dir ? null : cur))
      }, 0)
      return () => window.clearTimeout(t)
    }

    if (Math.abs(runState.progress - res.progress) > 0.002 || Math.abs(runState.etaSec - res.etaSec) > 0.05) {
      const t = window.setTimeout(() => {
        setRunState((cur) =>
          cur?.phase === 'run' && cur.dir === runState.dir
            ? { ...cur, progress: res.progress, etaSec: res.etaSec }
            : cur,
        )
      }, 0)
      return () => window.clearTimeout(t)
    }

    if (elapsed < 260) {
      const t = window.setTimeout(() => {
        setRunState((cur) => (cur?.phase === 'run' && cur.dir === runState.dir ? { ...cur } : cur))
      }, Math.max(20, 270 - elapsed))
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [runState, snapshot, project.modules])

  const onSpace = useEffectEvent((e: KeyboardEvent) => {
    if (e.code !== 'Space' || (e.target as HTMLElement)?.closest?.('input, select, textarea, [contenteditable="true"]')) {
      return
    }
    e.preventDefault()
    if (e.repeat) return
    if (isMoving) {
      setRunState(null)
      void sendCommand({ type: 'stop', ids: 'all' }, { source: 'manual' })
    } else if (lastMove.current?.ids === selectedIds) {
      void runManual({ type: 'move', target: lastMove.current.target })
    } else {
      notify('Chọn Lên hoặc Xuống để bắt đầu điều khiển', 'warn')
    }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onSpace(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted">
          Áp dụng cho <strong className="text-[#FFB26B]">{selectedIds.length}</strong> module đang chọn ·{' '}
          {isMoving ? 'space để dừng' : 'space để chạy'}
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
          <NumberField
            min="0.1"
            step="0.5"
            value={val}
            onCommit={setVal}
            aria-label="Giá trị tốc độ hoặc số giây"
            className="kiln-field h-8 w-16 rounded-full px-2.5 text-center text-xs font-semibold tabular-nums"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-2 sm:px-6">
        <div className="mx-auto grid w-full min-w-0 max-w-[930px] grid-cols-3 gap-2 sm:w-[84%] sm:gap-4">
          <ManualProgressButton
            dir="up"
            label="Lên"
            hint="Di chuyển lên giới hạn Min đã cài"
            phase={runState?.dir === 'up' ? runState.phase : 'idle'}
            waveRatio={sharedWave.ratio}
            waveMoving={sharedWave.moving}
            progress={runState?.dir === 'up' ? runState.progress : 0}
            etaSec={runState?.dir === 'up' ? runState.etaSec : 0}
            speedText={speedText}
            unitLabel={unitLabel}
            onClick={() => void runManual({ type: 'move', target: 'min' })}
          />
          <ManualStopButton
            hint="Dừng ngay và giữ nguyên vị trí hiện tại"
            unitLabel={unitLabel}
            waveRatio={sharedWave.ratio}
            waveMoving={sharedWave.moving}
            onClick={() => void runManual({ type: 'stop' })}
          />
          <ManualProgressButton
            dir="down"
            label="Xuống"
            hint="Di chuyển xuống giới hạn Max đã cài"
            phase={runState?.dir === 'down' ? runState.phase : 'idle'}
            waveRatio={sharedWave.ratio}
            waveMoving={sharedWave.moving}
            progress={runState?.dir === 'down' ? runState.progress : 0}
            etaSec={runState?.dir === 'down' ? runState.etaSec : 0}
            speedText={speedText}
            unitLabel={unitLabel}
            onClick={() => void runManual({ type: 'move', target: 'max' })}
          />
        </div>
      </div>
    </div>
  )
}

export function ControlDeck() {
  const { activeTab, setActiveTab } = useAppStore()

  const tabs = [
    { id: 'timeline' as const, label: 'Timeline', hint: 'Lập trình sóng & keyframe theo thời gian', icon: Clock },
    { id: 'manual' as const, label: 'Manual', hint: 'Điều khiển thủ công trực tiếp', icon: SlidersHorizontal },
    { id: 'buttons' as const, label: 'Custom', hint: 'Nút cue tuỳ chỉnh nhanh', icon: LayoutGrid },
  ]

  const modeTabs = (
    <div className="kiln-seg">
      {tabs.map((t) => {
        const Icon = t.icon
        const active = activeTab === t.id
        return (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            onClick={() => setActiveTab(t.id)}
            className={`kiln-seg-btn ${active ? 'on' : ''}`}
          >
            <Icon size={13} aria-hidden />
            {t.label}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-2">
      {activeTab !== 'timeline' && <div className="flex items-center">{modeTabs}</div>}

      <div className="min-h-0 flex-1">
        {activeTab === 'buttons' && <ModeButtons />}
        {activeTab === 'manual' && <ModeManual />}
        {activeTab === 'timeline' && <TimelineEditor modeTabs={modeTabs} />}
      </div>
    </div>
  )
}
