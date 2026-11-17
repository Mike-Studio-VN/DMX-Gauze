import { useEffect, useState } from 'react'
import { Download, FolderOpen, Network, RefreshCw, RotateCcw, Shield, Sliders, Volume2, X } from 'lucide-react'
import { isValidIPv4 } from '@shared/dmx'
import type { DriverId } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

type SettingsTab = 'network' | 'safety' | 'ltc' | 'project'

export function SettingsModal() {
  const {
    info,
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
  const [tab, setTab] = useState<SettingsTab>('network')
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

  const navItems: Array<{ id: SettingsTab; label: string; icon: typeof Network }> = [
    { id: 'network', label: 'Mạng & DMX Out', icon: Network },
    { id: 'safety', label: 'An toàn & Địa chỉ', icon: Shield },
    { id: 'ltc', label: 'Timecode LTC', icon: Volume2 },
    { id: 'project', label: 'Dự án & Preset', icon: FolderOpen },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div className="kiln-panel grid h-[560px] max-h-[90vh] w-full max-w-[760px] grid-rows-[54px_1fr_58px] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5">
          <div className="flex items-center gap-2.5">
            <Sliders size={16} className="text-[#FFB26B]" />
            <h2 className="text-[15px] font-semibold text-fg">Cài đặt hệ thống</h2>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-semibold tracking-wider text-muted uppercase">
            <span>VI · {out.driver === 'artnet' ? 'ART-NET' : 'MOCK'}</span>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              aria-label="Đóng cài đặt"
              className="cursor-pointer rounded-full p-1.5 text-muted hover:bg-white/10 hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body 2 cột chuẩn settings.png */}
        <div className="grid min-h-0 grid-cols-[195px_1fr]">
          {/* Sidebar trái */}
          <nav className="flex flex-col gap-1 border-r border-line p-2.5">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = tab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-[12.5px] font-medium transition ${
                    active
                      ? 'bg-brand/15 text-[#FFB26B] shadow-[inset_0_0_0_1px_rgba(247,132,46,.38)]'
                      : 'text-[#C2B3A4] hover:bg-white/5 hover:text-fg'
                  }`}
                >
                  <Icon size={15} className={active ? 'text-[#FFB26B]' : 'text-muted'} />
                  {item.label}
                </button>
              )
            })}

            <div className="mt-auto px-3 pb-1 text-[9.5px] leading-relaxed font-medium tracking-wider text-muted uppercase">
              DMX GAUZE ENGINE
              <br />v{info?.version ?? '0.1.0'} · {info?.runtime ?? 'web'}
            </div>
          </nav>

          {/* Nội dung phải */}
          <div className="min-h-0 overflow-y-auto p-5 text-xs">
            {tab === 'network' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                    Mạng & Giao thức xuất DMX
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      pollNow()
                      notify('Đã gửi gói ArtPoll quét Node trên mạng', 'info')
                    }}
                    className="kiln-btn kiln-btn-cue h-7 px-3 text-[11px]"
                  >
                    <RefreshCw size={12} />
                    Quét Node (ArtPoll)
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Giao thức xuất DMX</span>
                    <select
                      value={out.driver}
                      onChange={(e) => updateOutputSettings({ driver: e.target.value as DriverId })}
                      className="kiln-field h-9 w-full px-3 text-xs"
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

                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Tần số gửi (Hz)</span>
                    <input
                      type="number"
                      min="5"
                      max="44"
                      value={out.sendHz}
                      onChange={(e) =>
                        updateOutputSettings({ sendHz: Math.min(44, Math.max(5, Number(e.target.value) || 40)) })
                      }
                      className="kiln-field h-9 w-full px-3 text-xs tabular-nums"
                    />
                  </label>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[#C2B3A4]">Địa chỉ IP đích (Network Address)</span>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => applyIp('255.255.255.255')}
                        className="kiln-chip acc cursor-pointer"
                      >
                        Broadcast (255.255.255.255)
                      </button>
                      <button type="button" onClick={() => applyIp('127.0.0.1')} className="kiln-chip cue cursor-pointer">
                        Localhost (127.0.0.1)
                      </button>
                    </div>
                  </div>
                  <input
                    value={ipText}
                    onChange={(e) => applyIp(e.target.value)}
                    placeholder="255.255.255.255"
                    className={`kiln-field h-9 w-full px-3 font-mono text-[13px] ${
                      ipErr ? 'shadow-[inset_0_0_0_1.5px_var(--danger)]' : ''
                    }`}
                  />
                  {ipErr && <p className="text-danger">{ipErr}</p>}
                </div>

                <div className="grid grid-cols-4 gap-2.5">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Port UDP</span>
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={out.port}
                      onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || 6454 })}
                      className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Net (0–127)</span>
                    <input
                      type="number"
                      min="0"
                      max="127"
                      value={out.net}
                      onChange={(e) =>
                        updateOutputSettings({ net: Math.min(127, Math.max(0, Number(e.target.value) || 0)) })
                      }
                      className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Subnet (0–15)</span>
                    <input
                      type="number"
                      min="0"
                      max="15"
                      value={out.subnet}
                      onChange={(e) =>
                        updateOutputSettings({ subnet: Math.min(15, Math.max(0, Number(e.target.value) || 0)) })
                      }
                      className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Universe (0–15)</span>
                    <input
                      type="number"
                      min="0"
                      max="15"
                      value={out.universe}
                      onChange={(e) =>
                        updateOutputSettings({ universe: Math.min(15, Math.max(0, Number(e.target.value) || 0)) })
                      }
                      className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                    />
                  </label>
                </div>

                <div className="rounded-xl bg-black/30 p-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="mb-1.5 text-[11px] font-medium text-muted">
                    Node Art-Net phản hồi realtime ({nodes.length})
                  </div>
                  {nodes.length === 0 ? (
                    <div className="text-[11px] text-muted">
                      Chưa nhận được ArtPollReply nào. Kiểm tra cùng subnet hoặc firewall nếu dùng thiết bị thật.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {nodes.map((n) => (
                        <div key={n.ip} className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-1.5">
                          <span className="font-medium text-fg">{n.name}</span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-info">{n.ip}</span>
                            <button type="button" onClick={() => applyIp(n.ip)} className="kiln-chip acc cursor-pointer">
                              Chọn IP này
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'safety' && (
              <div className="space-y-4">
                <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">An toàn & Địa chỉ kênh</div>

                <label className="block space-y-1.5">
                  <span className="text-[11px] text-[#C2B3A4]">Giá trị mở khoá CH4 (mặc định 77)</span>
                  <input
                    type="number"
                    min="0"
                    max="255"
                    value={project.settings.lockValue}
                    onChange={(e) => setLockValue(Math.min(255, Math.max(0, Number(e.target.value) || 77)))}
                    className="kiln-field h-9 w-full px-3 text-xs tabular-nums"
                  />
                </label>

                <div className="space-y-2">
                  <span className="block text-[11px] text-[#C2B3A4]">Chế độ gán địa chỉ module</span>
                  {(
                    [
                      ['auto', 'AUTO', 'Tự động gán 4 kênh liên tiếp từ kênh 1'],
                      ['manual', 'MANUAL', 'Nhập thủ công từng module trên Thuộc tính (chặn trùng)'],
                    ] as const
                  ).map(([val, code, desc]) => {
                    const active = project.settings.addressMode === val
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setAddressMode(val)}
                        className={`flex h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3.5 text-left transition ${
                          active
                            ? 'bg-brand/15 text-[#FFB26B] shadow-[inset_0_0_0_1.5px_var(--acc)]'
                            : 'bg-white/[0.045] text-fg shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/[0.08]'
                        }`}
                      >
                        <span className="w-14 text-[10px] font-bold tracking-wider text-muted">{code}</span>
                        <span className="text-[12.5px] font-medium">{desc}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {tab === 'ltc' && (
              <div className="space-y-4">
                <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                  Timecode LTC (Audio Input)
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Thiết bị thu âm (Line-in / USB)</span>
                    <select
                      value={project.settings.ltc.deviceId}
                      onChange={(e) => updateLtcSettings({ deviceId: e.target.value })}
                      className="kiln-field h-9 w-full px-2.5 text-xs"
                    >
                      <option value="">Thiết bị mặc định hệ thống</option>
                      {audioInputs.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Audio Input (${d.deviceId.slice(0, 6)})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Kênh âm thanh</span>
                    <select
                      value={project.settings.ltc.channel}
                      onChange={(e) => updateLtcSettings({ channel: e.target.value as 'left' | 'right' })}
                      className="kiln-field h-9 w-full px-2.5 text-xs"
                    >
                      <option value="left">Trái (Left)</option>
                      <option value="right">Phải (Right)</option>
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Freewheel khi mất tín hiệu (frames)</span>
                    <input
                      type="number"
                      min="0"
                      max="120"
                      value={project.settings.ltc.freewheelFrames}
                      onChange={(e) => updateLtcSettings({ freewheelFrames: Number(e.target.value) || 10 })}
                      className="kiln-field h-9 w-full px-3 text-xs tabular-nums"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Bù trễ (Offset frames)</span>
                    <input
                      type="number"
                      min="-60"
                      max="60"
                      value={project.settings.ltc.offsetFrames}
                      onChange={(e) => updateLtcSettings({ offsetFrames: Number(e.target.value) || 0 })}
                      className="kiln-field h-9 w-full px-3 text-xs tabular-nums"
                    />
                  </label>
                </div>
              </div>
            )}

            {tab === 'project' && (
              <div className="space-y-3">
                <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Quản lý Dự án & Preset</div>

                <button
                  type="button"
                  onClick={() => void openProject()}
                  className="flex h-11 w-full cursor-pointer items-center gap-3 rounded-xl bg-white/[0.045] px-4 text-left text-fg shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/[0.08]"
                >
                  <FolderOpen size={16} className="text-info" />
                  <span className="font-medium">Mở / Nhập file dự án (.json)</span>
                </button>

                <button
                  type="button"
                  onClick={() => void exportProject()}
                  className="flex h-11 w-full cursor-pointer items-center gap-3 rounded-xl bg-white/[0.045] px-4 text-left text-fg shadow-[inset_0_0_0_1px_var(--line)] hover:bg-white/[0.08]"
                >
                  <Download size={16} className="text-[#FFB26B]" />
                  <span className="font-medium">Xuất bản sao dự án (.json)</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    resetPreset()
                    setSettingsOpen(false)
                  }}
                  className="flex h-11 w-full cursor-pointer items-center gap-3 rounded-xl bg-brand/15 px-4 text-left text-[#FFB26B] shadow-[inset_0_0_0_1px_rgba(247,132,46,.38)] hover:bg-brand/25"
                >
                  <RotateCcw size={16} />
                  <span className="font-medium">Khôi phục Preset mẫu (12×1m + 1×3m)</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line px-5 text-xs text-muted">
          <span>Thay đổi được áp dụng và tự động lưu ngay</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                resetPreset()
                setSettingsOpen(false)
              }}
              className="kiln-btn h-8 px-4 text-xs"
            >
              Mặc định
            </button>
            <button type="button" onClick={() => setSettingsOpen(false)} className="kiln-btn kiln-btn-primary h-8 px-5 text-xs">
              Xong
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
