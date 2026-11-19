import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { LTC_FPS_OPTIONS, formatTc, parseTc, realFps, resolveLtcFps } from '@shared/timecode'
import type { LtcFps } from '@shared/types'
import { formatReceivedLtc, ltcStatusLabels } from '../services/ltcInput'
import type { useAppStore } from '../store/useAppStore'
import { KilnSelect } from './KilnSelect'

type LtcPanelState = Pick<ReturnType<typeof useAppStore.getState>,
  'project' | 'ltcActive' | 'ltcDropFrame' | 'ltcReception' | 'setLtcActive' |
  'retryLtcInput' | 'updateLtcSettings' | 'updateTimelineSettings' | 'notify'>

const sectionClass = 'min-w-0 space-y-3 rounded-xl border border-line bg-black/20 p-3'
const headingClass = 'text-[11px] font-semibold tracking-wide text-[#FFB26B] uppercase'
const fieldLabel = 'text-[11px] leading-4 text-[#C2B3A4]'
const fieldClass = 'kiln-field h-9 w-full min-w-0 px-3 text-xs tabular-nums'

export function LtcSettingsPanel({ state }: { state: LtcPanelState }) {
  const {
    project, ltcActive, ltcDropFrame, ltcReception, setLtcActive, retryLtcInput,
    updateLtcSettings, updateTimelineSettings, notify,
  } = state
  const { timeline, ltc } = project.settings
  const ltcFps = resolveLtcFps(timeline.fps, ltc.fps)
  const timelineFps = ltcActive ? ltcFps : timeline.fps
  const dropFrame = ltcActive ? ltcDropFrame : undefined
  const formatStart = () => formatTc(timeline.startTime, timelineFps, dropFrame)
  const [startText, setStartText] = useState(formatStart)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    setStartText(formatTc(timeline.startTime, timelineFps, dropFrame))
  }, [timeline.startTime, timelineFps, dropFrame])

  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) {
      setDeviceError('Không thể liệt kê thiết bị thu trên hệ thống này.')
      return
    }
    let current = true
    setDeviceError(null)
    void media.enumerateDevices().then((devices) => {
      if (current) setAudioInputs(devices.filter((device) => device.kind === 'audioinput'))
    }).catch(() => {
      if (current) setDeviceError('Không tải được danh sách thiết bị thu. Kiểm tra quyền micrô rồi làm mới.')
    })
    const onDeviceChange = () => setRefresh((version) => version + 1)
    media.addEventListener?.('devicechange', onDeviceChange)
    return () => {
      current = false
      media.removeEventListener?.('devicechange', onDeviceChange)
    }
  }, [refresh, ltcReception.inputOpen])

  const applyStart = () => {
    // Merely focusing and leaving a rounded timecode must not quantize the saved start time.
    if (startText === formatStart()) return
    const seconds = parseTc(startText, timelineFps, dropFrame)
    if (seconds === null) {
      notify('Timecode không hợp lệ (hh:mm:ss:ff).', 'warn')
      setStartText(formatStart())
      return
    }
    updateTimelineSettings({ startTime: seconds })
  }

  const status = ltcActive && ltcReception.status === 'off' ? 'waiting' : ltcReception.status
  const signal = ltcReception.signalLevel
  const estimate = status === 'lock' || status === 'waiting' ? ltcReception.detectedFps : null
  // Frame labels cannot distinguish 30 from 29.97 non-drop.
  const mismatch = estimate !== null && estimate !== ltcFps && !(estimate === 30 && ltcFps === 29.97)
  const configuredDeviceMissing = ltc.deviceId !== '' &&
    !audioInputs.some((device) => device.deviceId === ltc.deviceId)
  const deviceListWarning = deviceError ?? (audioInputs.length === 0
    ? 'Chưa thấy thiết bị thu. Kiểm tra kết nối và quyền micrô.'
    : configuredDeviceMissing && audioInputs.some((device) => device.deviceId)
      ? 'Thiết bị đã lưu không có trong danh sách hiện tại.'
      : null)
  const frameMs = (frames: number) => Math.round((frames / realFps(ltcFps)) * 1000)

  return (
    <div className="min-w-0 space-y-3">
      <section className={sectionClass} aria-labelledby="ltc-source-heading">
        <h3 id="ltc-source-heading" className={headingClass}>Nguồn timecode</h3>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            role="switch"
            aria-label="Nhận timecode (LTC)"
            aria-checked={ltcActive}
            onClick={() => setLtcActive(!ltcActive)}
            className={`kiln-btn gap-2 px-3 py-1.5 text-left text-[11px] ${ltcActive ? 'kiln-btn-primary' : 'text-fg'}`}
          >
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${ltcActive ? 'bg-current' : 'bg-muted'}`} />
            Nhận timecode (LTC)
          </button>
          <span
            role="status"
            className={`select-none rounded-full px-2 py-1 text-[11px] font-medium ${
              status === 'lock' ? 'bg-ok/15 text-ok'
                : status === 'lost' ? 'bg-danger/15 text-danger'
                  : status === 'off' ? 'bg-white/5 text-muted' : 'bg-warn/15 text-warn'
            }`}
          >
            {ltcStatusLabels[status]}
          </span>
        </div>
        <div className="grid gap-2 min-[680px]:grid-cols-2">
          <div className="kiln-readout min-w-0">
            <div className="text-[11px]">{status === 'lost' || status === 'freewheel' ? 'Timecode nhận gần nhất' : 'Timecode nhận được'}</div>
            <output aria-live="off" className="font-mono text-sm tabular-nums">
              {ltcReception.frame ? formatReceivedLtc(ltcReception.frame) : '—'}
            </output>
          </div>
          <div className="kiln-readout flex min-w-0 flex-col justify-center gap-1">
            <div className="flex flex-wrap justify-between gap-x-2 text-[11px]">
              <span>Mức tín hiệu</span><span className="tabular-nums">{signal}%</span>
            </div>
            <div role="meter" aria-label="Mức tín hiệu LTC" aria-valuemin={0} aria-valuemax={100} aria-valuenow={signal}
              className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-brand" style={{ width: `${signal}%` }} />
            </div>
          </div>
        </div>
        {ltcReception.waitingForPosition && (
          <p role="status" className="text-[11px] text-warn">Đang giữ Timeline cho đến khi nguồn mới bắt kịp playhead.</p>
        )}
      </section>

      <section className={sectionClass} aria-labelledby="ltc-device-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="ltc-device-heading" className={headingClass}>Thiết bị</h3>
          <button type="button" onClick={() => setRefresh((version) => version + 1)} className="kiln-btn gap-1.5 px-2 py-1 text-[11px]">
            <RefreshCw size={12} /> Làm mới danh sách
          </button>
        </div>
        <div className="grid gap-3 min-[680px]:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <div className={fieldLabel}>Thiết bị thu âm</div>
            <KilnSelect
              ariaLabel="Thiết bị thu âm"
              value={ltc.deviceId}
              options={[
                { value: '', label: 'Thiết bị mặc định hệ thống' },
                ...(configuredDeviceMissing ? [{ value: ltc.deviceId, label: 'Thiết bị đã lưu (chưa thấy)', disabled: true }] : []),
                ...audioInputs.filter((device) => device.deviceId).map((device) => ({
                  value: device.deviceId,
                  label: device.label || `Thiết bị thu (${device.deviceId.slice(0, 6)})`,
                })),
              ]}
              onChange={(deviceId) => updateLtcSettings({ deviceId })}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <div className={fieldLabel}>Kênh âm thanh</div>
            <KilnSelect ariaLabel="Kênh âm thanh" value={ltc.channel}
              options={[{ value: 'left', label: 'Trái' }, { value: 'right', label: 'Phải' }]}
              onChange={(channel) => updateLtcSettings({ channel: channel === 'right' ? 'right' : 'left' })}
            />
          </div>
        </div>
        {ltcReception.error ? (
          <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-danger/10 p-2">
            <p role="alert" className="min-w-0 grow basis-52 text-[11px] text-danger">{ltcReception.error}</p>
            <button type="button" onClick={retryLtcInput} className="kiln-btn px-2 py-1 text-[11px]">Thử lại</button>
          </div>
        ) : deviceListWarning && <p role="status" className="text-[11px] text-warn">{deviceListWarning}</p>}
      </section>

      <section className={sectionClass} aria-labelledby="ltc-fps-heading">
        <h3 id="ltc-fps-heading" className={headingClass}>Khung hình</h3>
        <div className="min-w-0 space-y-1">
          <div className={fieldLabel}>Tốc độ khung LTC In</div>
          <KilnSelect ariaLabel="Tốc độ khung LTC In" tabular value={ltc.fps === undefined ? 'auto' : String(ltc.fps)}
            options={[
              { value: 'auto', label: `Theo Timeline (${resolveLtcFps(timeline.fps)} fps)` },
              ...LTC_FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })),
            ]}
            onChange={(fps) => updateLtcSettings({ fps: fps === 'auto' ? undefined : Number(fps) as LtcFps })}
          />
          <p className="kiln-readout text-[11px]">Timeline sẽ dùng {ltcFps} fps khi bật LTC. Theo Timeline dùng 30 fps nếu FPS đã lưu là 40, 50 hoặc 60.</p>
        </div>
        <div className="kiln-readout text-[11px]">
          <span>FPS Timeline · </span>
          <output aria-label="Tốc độ khung hình Timeline" className="font-semibold tabular-nums">{timelineFps} fps</output>
          {ltcActive ? <span> · Đang link theo LTC (đã khóa)</span> : <span> · Chỉnh ở thanh công cụ Timeline</span>}
        </div>
        {estimate !== null && (
          <p role={mismatch ? 'status' : undefined} className={mismatch ? 'text-[11px] text-warn' : 'kiln-readout text-[11px]'}>
            Ước lượng từ tín hiệu {estimate === 30 ? '29.97 NDF hoặc 30' : estimate} fps
            {mismatch ? ` · Khác FPS đã chọn (${ltcFps} fps).` : '.'}
          </p>
        )}
      </section>

      <section className={sectionClass} aria-labelledby="ltc-advanced-heading">
        <h3 id="ltc-advanced-heading" className={headingClass}>Nâng cao</h3>
        <label className="block space-y-1">
          <span className={fieldLabel}>Timecode bắt đầu</span>
          <input value={startText} onChange={(e) => setStartText(e.target.value)} onBlur={applyStart}
            onKeyDown={(e) => e.key === 'Enter' && applyStart()} placeholder="00:00:00:00"
            aria-label="Timecode bắt đầu" className={`${fieldClass} font-mono`} />
          <span className="kiln-readout block text-[11px]">Mốc bắt đầu khi chạy Timeline thủ công (hh:mm:ss:ff).</span>
        </label>
        <div className="grid gap-3 min-[680px]:grid-cols-2">
          <label className="block min-w-0 space-y-1">
            <span className={fieldLabel}>Bù trễ (khung)</span>
            <input type="number" min="-60" max="60" value={ltc.offsetFrames}
              aria-label="Bù trễ (khung)" className={fieldClass}
              onChange={(e) => updateLtcSettings({ offsetFrames: Number(e.target.value) || 0 })} />
            <span className="kiln-readout block text-[11px]">{frameMs(ltc.offsetFrames)} ms · Dịch mốc timecode nhận vào.</span>
          </label>
          <label className="block min-w-0 space-y-1">
            <span className={fieldLabel}>Chạy trớn (khung)</span>
            <input type="number" min="0" max="120" value={ltc.freewheelFrames}
              aria-label="Chạy trớn (khung)" className={fieldClass}
              onChange={(e) => {
                if (Number.isFinite(e.target.valueAsNumber)) updateLtcSettings({ freewheelFrames: e.target.valueAsNumber })
              }} />
            <span className="kiln-readout block text-[11px]">{frameMs(ltc.freewheelFrames)} ms · Chạy tiếp khi tín hiệu gián đoạn, sau đó giữ module.</span>
          </label>
        </div>
      </section>
    </div>
  )
}
