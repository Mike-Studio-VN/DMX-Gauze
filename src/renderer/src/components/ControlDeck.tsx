import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Clock,
  Edit3,
  LayoutGrid,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Trash2,
} from 'lucide-react'
import { LtcDecoder } from '@shared/ltc'
import { FPS_OPTIONS, formatTc, parseTc, tcToSeconds } from '@shared/timecode'
import { TimelineRunner } from '@shared/timeline'
import type { CueButton, Fps, SpeedUnit, TimelineKey } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

function ActionBtn({
  icon: Icon,
  label,
  hint,
  onClick,
  variant = 'ghost',
  active = false,
}: {
  icon: typeof Play
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
  const { project, snapshot, saveButton, deleteButton, sendCommand } = useAppStore()
  const [editing, setEditing] = useState<CueButton | null>(null)
  const [lastFired, setLastFired] = useState<string | null>(null)

  const fire = async (b: CueButton) => {
    setLastFired(b.id)
    for (const s of b.steps) {
      await sendCommand({
        type: 'move',
        ids: [s.moduleId],
        target: s.position,
        speed: { unit: b.speedUnit, value: b.speedValue },
      })
    }
  }

  const openNew = () => {
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

  if (editing) {
    return (
      <div className="flex h-full flex-col gap-2 overflow-y-auto pr-1 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="Tên nút điều khiển"
            className="min-w-40 flex-1 rounded border border-line bg-bg px-2.5 py-1.5 text-fg"
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
              saveButton(editing)
              setEditing(null)
            }}
            className="cursor-pointer rounded bg-brand px-3 py-1.5 font-semibold text-brand-fg"
          >
            Lưu nút
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
          {project.modules.map((m) => {
            const step = editing.steps.find((s) => s.moduleId === m.id)
            return (
              <label key={m.id} className="flex items-center justify-between gap-2 rounded border border-line bg-panel-2/70 px-2 py-1">
                <span className="truncate">{m.name}</span>
                <input
                  type="number"
                  step="0.1"
                  min={m.minHeight}
                  max={m.maxHeight}
                  value={step?.position ?? 0}
                  onChange={(e) => {
                    const pos = Number(e.target.value) || 0
                    const exists = editing.steps.some((s) => s.moduleId === m.id)
                    const steps = exists
                      ? editing.steps.map((s) => (s.moduleId === m.id ? { ...s, position: pos } : s))
                      : [...editing.steps, { moduleId: m.id, position: pos }]
                    setEditing({ ...editing, steps })
                  }}
                  className="w-16 rounded border border-line bg-bg px-1.5 py-0.5 text-right text-fg tabular-nums"
                />
              </label>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Bấm nút để chạy cấu hình đã lưu (animation xác nhận)</span>
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
          const active = lastFired === b.id
          return (
            <motion.div
              key={b.id}
              whileTap={{ scale: 0.95 }}
              className={`group relative flex flex-col justify-between rounded-ui border p-2.5 transition ${
                active ? 'border-brand bg-brand/15' : 'border-line bg-panel-2/70 hover:border-info/60'
              }`}
            >
              <button type="button" onClick={() => fire(b)} className="flex-1 cursor-pointer text-left">
                <div className="truncate text-sm font-semibold text-fg">{b.name}</div>
                <div className="mt-1 text-[11px] text-muted">
                  {b.steps.length} màn · {b.speedValue} {b.speedUnit === 'sec' ? 'giây' : 'cm/s'}
                </div>
              </button>
              <div className="mt-2 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => setEditing(b)}
                  title="Sửa nút"
                  className="cursor-pointer rounded p-1 text-muted hover:bg-line hover:text-fg"
                >
                  <Edit3 size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => deleteButton(b.id)}
                  title="Xoá nút"
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

function ModeTimeline() {
  const { project, snapshot, updateTimelineSettings, addKey, deleteKey, sendCommand, notify } = useAppStore()
  const fps = project.settings.timeline.fps
  const [time, setTime] = useState(project.settings.timeline.startTime)
  const [playing, setPlaying] = useState(false)
  const [ltcActive, setLtcActive] = useState(false)
  const [ltcStatus, setLtcStatus] = useState<'off' | 'lock' | 'freewheel' | 'lost'>('off')
  const [tcInput, setTcInput] = useState(formatTc(project.settings.timeline.startTime, fps))

  const runnerRef = useRef(new TimelineRunner())
  const timeRef = useRef(time)
  timeRef.current = time
  const keysRef = useRef(project.keys)
  keysRef.current = project.keys

  const maxTime = Math.max(20, ...project.keys.map((k) => k.time + 5))

  // Đồng hồ nội bộ khi Play
  useEffect(() => {
    if (!playing || ltcActive) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const next = Math.min(maxTime, timeRef.current + dt)
      setTime(next)
      const cmds = runnerRef.current.update(next, keysRef.current)
      for (const c of cmds) void sendCommand(c)
      if (next >= maxTime) setPlaying(false)
      else raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, ltcActive, maxTime, sendCommand])

  // Nhận LTC Audio Input qua Web Audio API
  useEffect(() => {
    if (!ltcActive) {
      setLtcStatus('off')
      return
    }
    let stopped = false
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let lastFrameAt = 0

    const startLtc = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: project.settings.ltc.deviceId ? { deviceId: { exact: project.settings.ltc.deviceId } } : true,
        })
        if (stopped) return
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const proc = ctx.createScriptProcessor(2048, 2, 1)
        const dec = new LtcDecoder(
          ctx.sampleRate,
          (f) => {
            lastFrameAt = performance.now()
            setLtcStatus('lock')
            const sec = tcToSeconds(f, fps) + project.settings.ltc.offsetFrames / fps
            setTime(sec)
            const cmds = runnerRef.current.update(sec, keysRef.current)
            for (const c of cmds) void sendCommand(c)
          },
          fps === 29.97 ? 30 : fps,
        )
        proc.onaudioprocess = (ev) => {
          const chIdx = project.settings.ltc.channel === 'right' && ev.inputBuffer.numberOfChannels > 1 ? 1 : 0
          dec.push(ev.inputBuffer.getChannelData(chIdx))
        }
        src.connect(proc)
        proc.connect(ctx.destination)
        setLtcStatus('lost')
      } catch (err) {
        notify(`Không mở được ngõ âm thanh LTC: ${(err as Error).message}`, 'error')
        setLtcActive(false)
      }
    }
    void startLtc()

    const watch = setInterval(() => {
      if (!lastFrameAt) return
      const gapMs = performance.now() - lastFrameAt
      const fwMs = (project.settings.ltc.freewheelFrames / fps) * 1000
      if (gapMs > fwMs) setLtcStatus('lost')
      else if (gapMs > 80) setLtcStatus('freewheel')
    }, 80)

    return () => {
      stopped = true
      clearInterval(watch)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [ltcActive, fps, project.settings.ltc, sendCommand, notify])

  const applyStartTc = () => {
    const sec = parseTc(tcInput, fps)
    if (sec === null) {
      notify('Timecode không hợp lệ (định dạng hh:mm:ss:ff)', 'warn')
      return
    }
    updateTimelineSettings({ startTime: sec })
    runnerRef.current.reset()
    setTime(sec)
  }

  const addKeyAtCurrent = () => {
    const targets: Record<string, number> = {}
    for (const m of project.modules) {
      targets[m.id] = Number((snapshot?.modules[m.id]?.pos ?? 0).toFixed(2))
    }
    const key: TimelineKey = { id: `k-${Date.now()}`, time: Number(time.toFixed(2)), targets }
    addKey(key)
    notify(`Đã tạo Key tại ${formatTc(time, fps)}`, 'info')
  }

  return (
    <div className="flex h-full flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-bg px-2.5 py-1 font-mono text-base font-bold text-brand tabular-nums">
            {formatTc(time, fps)}
          </span>

          <ActionBtn
            icon={playing ? Pause : Play}
            label={playing ? 'Tạm dừng' : 'Chạy'}
            hint="Chạy timeline bằng đồng hồ nội bộ"
            variant="brand"
            onClick={() => {
              setLtcActive(false)
              setPlaying(!playing)
            }}
          />
          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              runnerRef.current.reset()
              setTime(project.settings.timeline.startTime)
            }}
            title="Về timecode bắt đầu"
            className="cursor-pointer rounded-md border border-line bg-panel-2 p-2 text-muted hover:text-fg"
          >
            <RotateCcw size={14} />
          </button>

          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              setLtcActive(!ltcActive)
            }}
            title="Nhận xung LTC từ ngõ vào âm thanh (Line-in / USB Audio)"
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-medium ${
              ltcActive ? 'border-ok bg-ok/15 text-ok' : 'border-line bg-panel-2 text-muted hover:text-fg'
            }`}
          >
            {ltcActive ? <Mic size={14} /> : <MicOff size={14} />}
            LTC {ltcStatus === 'lock' ? '· Đã khoá' : ltcStatus === 'freewheel' ? '· Freewheel' : ltcActive ? '· Chờ tín hiệu' : 'Tắt'}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={tcInput}
            onChange={(e) => setTcInput(e.target.value)}
            onBlur={applyStartTc}
            title="Timecode bắt đầu (hh:mm:ss:ff)"
            className="w-24 rounded border border-line bg-bg px-2 py-1 font-mono text-fg"
          />
          <select
            value={fps}
            onChange={(e) => updateTimelineSettings({ fps: Number(e.target.value) as Fps })}
            title="Khung hình / giây (FPS)"
            className="rounded border border-line bg-bg px-2 py-1 text-fg"
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addKeyAtCurrent}
            title="Lưu vị trí hiện tại của các màn thành 1 Key tại timecode này"
            className="inline-flex cursor-pointer items-center gap-1 rounded bg-info px-2.5 py-1 font-semibold text-slate-950"
          >
            <Plus size={14} />
            Tạo Key
          </button>
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={maxTime}
        step={0.04}
        value={time}
        onChange={(e) => {
          const t = Number(e.target.value)
          runnerRef.current.reset()
          setTime(t)
        }}
        className="w-full accent-brand"
      />

      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto pb-1">
        {project.keys.map((k, idx) => (
          <div
            key={k.id}
            onClick={() => {
              runnerRef.current.reset()
              setTime(k.time)
            }}
            className="flex min-w-36 cursor-pointer flex-col justify-between rounded-lg border border-line bg-panel-2/70 p-2 hover:border-brand"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-info">Key {idx + 1}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteKey(k.id)
                }}
                className="cursor-pointer text-muted hover:text-danger"
                title="Xoá Key"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="font-mono text-xs text-brand tabular-nums">{formatTc(k.time, fps)}</div>
            <div className="text-[11px] text-muted">{Object.keys(k.targets).length} module</div>
          </div>
        ))}
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
        {activeTab === 'timeline' && <ModeTimeline />}
      </div>
    </div>
  )
}
