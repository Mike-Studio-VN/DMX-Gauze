import { useEffect, useState } from 'react'
import { Download, FolderOpen, Network, RefreshCw, RotateCcw, Shield, Upload, Volume2, X } from 'lucide-react'
import { isValidIPv4 } from '@shared/dmx'
import type { DriverId } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

export function SettingsModal() {
  const {
    project,
    snapshot,
    settingsOpen,
    setSettingsOpen,
    updateOutputSettings,
    updateLtcSettings,
    setLockValue,
    setAddressMode,
    pollNow,
    exportProject,
    openProject,
    resetPreset,
    notify,
  } = useAppStore()

  const out = project.settings.output
  const [ipText, setIpText] = useState(out.ip)
  const [ipErr, setIpErr] = useState<string | null>(null)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    setIpText(out.ip)
    setIpErr(null)
  }, [out.ip, settingsOpen])

  useEffect(() => {
    if (!settingsOpen || !navigator.mediaDevices?.enumerateDevices) return
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => setAudioInputs(list.filter((d) => d.kind === 'audioinput')))
      .catch(() => {})
  }, [settingsOpen])

  if (!settingsOpen) return null

  const applyIp = (nextIp: string) => {
    setIpText(nextIp)
    if (!isValidIPv4(nextIp)) {
      setIpErr('Địa chỉ IPv4 không hợp lệ (vd: 255.255.255.255 hoặc 192.168.1.50)')
      return
    }
    setIpErr(null)
    updateOutputSettings({ ip: nextIp.trim() })
  }

  const nodes = snapshot?.status.nodes ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-ui border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold text-fg">Cài đặt hệ thống & Mạng DMX Out</h2>
          <button
            type="button"
            onClick={() => setSettingsOpen(false)}
            aria-label="Đóng cài đặt"
            className="cursor-pointer rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-xs">
          {/* 1. Network Address DMX Out */}
          <section className="space-y-3 rounded-lg border border-line bg-panel-2/50 p-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-info">
                <Network size={16} />
                Mạng & Giao thức DMX Out
              </h3>
              <button
                type="button"
                onClick={() => {
                  pollNow()
                  notify('Đã gửi gói ArtPoll quét Node trên mạng', 'info')
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded bg-panel px-2.5 py-1 text-info hover:bg-line"
              >
                <RefreshCw size={12} />
                Quét Node (ArtPoll)
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-muted">Giao thức xuất DMX</span>
                <select
                  value={out.driver}
                  onChange={(e) => updateOutputSettings({ driver: e.target.value as DriverId })}
                  className="w-full rounded border border-line bg-bg px-2.5 py-1.5 text-fg"
                >
                  <option value="artnet">Art-Net (UDP mạng LAN)</option>
                  <option value="mock">Mock (Mô phỏng nội bộ)</option>
                  <option value="sacn" disabled>sACN E1.31 (Phase sau)</option>
                  <option value="kinet" disabled>KiNET (Phase sau)</option>
                  <option value="enttec-pro" disabled>Enttec USB Pro (Phase sau)</option>
                  <option value="enttec-mk2" disabled>Enttec USB Pro Mk2 (Phase sau)</option>
                  <option value="serial" disabled>Generic Serial (Phase sau)</option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-muted">Tần số gửi (Hz)</span>
                <input
                  type="number"
                  min="5"
                  max="44"
                  value={out.sendHz}
                  onChange={(e) => updateOutputSettings({ sendHz: Math.min(44, Math.max(5, Number(e.target.value) || 40)) })}
                  className="w-full rounded border border-line bg-bg px-2.5 py-1.5 text-fg tabular-nums"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted">Địa chỉ IP đích (Network Address)</span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyIp('255.255.255.255')}
                    className="cursor-pointer rounded bg-panel px-2 py-0.5 text-[11px] text-brand hover:bg-line"
                  >
                    Broadcast (255.255.255.255)
                  </button>
                  <button
                    type="button"
                    onClick={() => applyIp('127.0.0.1')}
                    className="cursor-pointer rounded bg-panel px-2 py-0.5 text-[11px] text-info hover:bg-line"
                  >
                    Localhost (127.0.0.1)
                  </button>
                </div>
              </div>
              <input
                value={ipText}
                onChange={(e) => applyIp(e.target.value)}
                placeholder="255.255.255.255"
                className={`w-full rounded border bg-bg px-2.5 py-1.5 font-mono text-sm text-fg ${
                  ipErr ? 'border-danger' : 'border-line'
                }`}
              />
              {ipErr && <p className="text-danger">{ipErr}</p>}
            </div>

            <div className="grid grid-cols-4 gap-2">
              <label className="space-y-1">
                <span className="text-muted">Port UDP</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={out.port}
                  onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || 6454 })}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted">Net (0–127)</span>
                <input
                  type="number"
                  min="0"
                  max="127"
                  value={out.net}
                  onChange={(e) => updateOutputSettings({ net: Math.min(127, Math.max(0, Number(e.target.value) || 0)) })}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted">Subnet (0–15)</span>
                <input
                  type="number"
                  min="0"
                  max="15"
                  value={out.subnet}
                  onChange={(e) => updateOutputSettings({ subnet: Math.min(15, Math.max(0, Number(e.target.value) || 0)) })}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted">Universe (0–15)</span>
                <input
                  type="number"
                  min="0"
                  max="15"
                  value={out.universe}
                  onChange={(e) => updateOutputSettings({ universe: Math.min(15, Math.max(0, Number(e.target.value) || 0)) })}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
                />
              </label>
            </div>

            <div className="rounded border border-line bg-bg/70 p-2">
              <div className="mb-1 text-[11px] font-medium text-muted">
                Node Art-Net phản hồi realtime ({nodes.length})
              </div>
              {nodes.length === 0 ? (
                <div className="text-[11px] text-muted">
                  Chưa nhận được ArtPollReply nào. Nếu dùng thiết bị thật, kiểm tra cùng subnet hoặc firewall.
                </div>
              ) : (
                <div className="space-y-1">
                  {nodes.map((n) => (
                    <div key={n.ip} className="flex items-center justify-between rounded bg-panel-2 px-2 py-1">
                      <span className="font-medium text-fg">{n.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-info">{n.ip}</span>
                        <button
                          type="button"
                          onClick={() => applyIp(n.ip)}
                          className="cursor-pointer rounded bg-brand/20 px-1.5 py-0.5 text-[10px] text-brand hover:bg-brand/30"
                        >
                          Chọn IP này
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* 2. An toàn & Địa chỉ */}
          <section className="space-y-2 rounded-lg border border-line bg-panel-2/50 p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Shield size={16} />
              An toàn & Địa chỉ kênh
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-muted">Giá trị mở khoá CH4 (mặc định 77)</span>
                <input
                  type="number"
                  min="0"
                  max="255"
                  value={project.settings.lockValue}
                  onChange={(e) => setLockValue(Math.min(255, Math.max(0, Number(e.target.value) || 77)))}
                  className="w-full rounded border border-line bg-bg px-2.5 py-1.5 text-fg tabular-nums"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted">Chế độ gán địa chỉ module</span>
                <select
                  value={project.settings.addressMode}
                  onChange={(e) => setAddressMode(e.target.value as 'auto' | 'manual')}
                  className="w-full rounded border border-line bg-bg px-2.5 py-1.5 text-fg"
                >
                  <option value="auto">Tự động liên tiếp từ kênh 1</option>
                  <option value="manual">Nhập thủ công từng module (chặn trùng)</option>
                </select>
              </label>
            </div>
          </section>

          {/* 3. LTC Audio Input */}
          <section className="space-y-2 rounded-lg border border-line bg-panel-2/50 p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-info">
              <Volume2 size={16} />
              Timecode LTC (Audio Input)
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-muted">Thiết bị thu âm (Line-in / USB)</span>
                <select
                  value={project.settings.ltc.deviceId}
                  onChange={(e) => updateLtcSettings({ deviceId: e.target.value })}
                  className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg"
                >
                  <option value="">Thiết bị mặc định hệ thống</option>
                  {audioInputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Audio Input (${d.deviceId.slice(0, 6)})`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-muted">Kênh âm thanh</span>
                <select
                  value={project.settings.ltc.channel}
                  onChange={(e) => updateLtcSettings({ channel: e.target.value as 'left' | 'right' })}
                  className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg"
                >
                  <option value="left">Trái (Left)</option>
                  <option value="right">Phải (Right)</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-muted">Freewheel khi mất tín hiệu (frames)</span>
                <input
                  type="number"
                  min="0"
                  max="120"
                  value={project.settings.ltc.freewheelFrames}
                  onChange={(e) => updateLtcSettings({ freewheelFrames: Number(e.target.value) || 10 })}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted">Bù trễ (Offset frames)</span>
                <input
                  type="number"
                  min="-60"
                  max="60"
                  value={project.settings.ltc.offsetFrames}
                  onChange={(e) => updateLtcSettings({ offsetFrames: Number(e.target.value) || 0 })}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-fg tabular-nums"
                />
              </label>
            </div>
          </section>

          {/* 4. Quản lý file dự án */}
          <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2/50 p-3">
            <span className="font-semibold text-fg">Dự án & Preset</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void openProject()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-line bg-bg px-3 py-1.5 text-fg hover:bg-line"
              >
                <FolderOpen size={14} />
                Mở / Nhập JSON
              </button>
              <button
                type="button"
                onClick={() => void exportProject()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-line bg-bg px-3 py-1.5 text-fg hover:bg-line"
              >
                <Download size={14} />
                Xuất JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  resetPreset()
                  setSettingsOpen(false)
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-brand/40 bg-brand/15 px-3 py-1.5 text-brand hover:bg-brand/25"
              >
                <RotateCcw size={14} />
                Khôi phục Preset (12×1m + 1×3m)
              </button>
            </div>
          </section>
        </div>

        <div className="flex justify-end border-t border-line px-4 py-2.5">
          <button
            type="button"
            onClick={() => setSettingsOpen(false)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-ui bg-brand px-4 py-1.5 text-xs font-semibold text-brand-fg"
          >
            <Upload size={14} className="hidden" />
            Xong
          </button>
        </div>
      </div>
    </div>
  )
}
