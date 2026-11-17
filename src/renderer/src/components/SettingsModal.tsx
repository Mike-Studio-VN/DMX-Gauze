import { useEffect, useState } from 'react'
import { Download, FolderOpen, Network, RefreshCw, RotateCcw, Shield, Sliders, Volume2, X } from 'lucide-react'
import { isValidIPv4 } from '@shared/dmx'
import { KINET_PORT, SACN_PORT, sacnMulticastIp } from '@shared/protocols'
import { FPS_OPTIONS, formatTc, parseTc } from '@shared/timecode'
import type { DriverId, Fps } from '@shared/types'
import { getBridge } from '../services/bridge'
import { type SettingsTab, useAppStore } from '../store/useAppStore'

export function SettingsModal() {
  const {
    info,
    project,
    snapshot,
    settingsOpen,
    settingsTab,
    setSettingsOpen,
    updateOutputSettings,
    updateLtcSettings,
    updateTimelineSettings,
    setLockValue,
    setAddressMode,
    pollNow,
    exportProject,
    openProject,
    resetPreset,
    notify,
  } = useAppStore()

  const out = project.settings.output
  const tl = project.settings.timeline
  const [ipText, setIpText] = useState(out.ip)
  const [ipErr, setIpErr] = useState<string | null>(null)
  const [startTcText, setStartTcText] = useState(() => formatTc(tl.startTime, tl.fps))
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [serialPorts, setSerialPorts] = useState<string[]>([])

  const refreshSerialPorts = () => {
    void getBridge()
      .listSerialPorts()
      .then((ports) => setSerialPorts(ports))
      .catch(() => {})
  }

  useEffect(() => {
    setIpText(out.ip)
    setIpErr(null)
  }, [out.ip, settingsOpen])

  useEffect(() => {
    setStartTcText(formatTc(tl.startTime, tl.fps))
  }, [tl.startTime, tl.fps, settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    refreshSerialPorts()
    if (!navigator.mediaDevices?.enumerateDevices) return
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

  const applyStartTc = () => {
    const sec = parseTc(startTcText, tl.fps)
    if (sec === null) {
      notify('Timecode không hợp lệ (định dạng hh:mm:ss:ff)', 'warn')
      setStartTcText(formatTc(tl.startTime, tl.fps))
      return
    }
    updateTimelineSettings({ startTime: sec })
  }

  const nodes = snapshot?.status.nodes ?? []

  const navItems: Array<{ id: SettingsTab; label: string; icon: typeof Network }> = [
    { id: 'network', label: 'Mạng & DMX Out', icon: Network },
    { id: 'safety', label: 'An toàn & Địa chỉ', icon: Shield },
    { id: 'ltc', label: 'Timecode LTC', icon: Volume2 },
    { id: 'project', label: 'Dự án & Preset', icon: FolderOpen },
  ]

  const tab = navItems.some((i) => i.id === settingsTab) ? settingsTab : 'network'

  const isSerialDriver = out.driver === 'enttec-pro' || out.driver === 'enttec-mk2' || out.driver === 'serial'
  const isNetworkDriver = !isSerialDriver

  const handleDriverChange = (next: DriverId) => {
    if (next === 'artnet') {
      updateOutputSettings({ driver: 'artnet', port: 6454 })
    } else if (next === 'sacn') {
      updateOutputSettings({
        driver: 'sacn',
        port: SACN_PORT,
        sacnUniverse: out.sacnUniverse ?? Math.max(1, out.universe + 1),
        sacnPriority: out.sacnPriority ?? 100,
        sacnMulticast: out.sacnMulticast ?? true,
      })
    } else if (next === 'kinet') {
      updateOutputSettings({
        driver: 'kinet',
        port: KINET_PORT,
        kinetVersion: out.kinetVersion ?? 2,
        kinetPort: out.kinetPort ?? 1,
      })
    } else if (next === 'enttec-pro' || next === 'enttec-mk2') {
      refreshSerialPorts()
      updateOutputSettings({
        driver: next,
        baudRate: 57600,
        enttecMk2Port: out.enttecMk2Port ?? 1,
      })
    } else if (next === 'serial') {
      refreshSerialPorts()
      updateOutputSettings({
        driver: 'serial',
        baudRate: out.baudRate && out.baudRate > 0 ? out.baudRate : 250000,
        serialFormat: out.serialFormat ?? 'raw',
      })
    } else {
      updateOutputSettings({ driver: 'mock' })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="kiln-panel grid h-[560px] max-h-[90vh] w-full max-w-[760px] grid-rows-[54px_1fr_58px] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5">
          <div className="flex items-center gap-2.5">
            <Sliders size={16} className="text-[#FFB26B]" />
            <h2 className="text-[15px] font-semibold text-fg">Cài đặt hệ thống</h2>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-semibold tracking-wider text-muted uppercase">
            <span>VI · {out.driver.toUpperCase()}</span>
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

        {/* Body */}
        <div className="grid min-h-0 grid-cols-[195px_1fr]">
          <nav className="flex flex-col gap-1 border-r border-line p-2.5">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = tab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSettingsOpen(true, item.id)}
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
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                    Mạng &amp; Giao thức xuất DMX
                  </span>
                  <div className="flex items-center gap-1.5">
                    {out.driver !== 'artnet' && (
                      <button
                        type="button"
                        onClick={() => handleDriverChange('artnet')}
                        title="Ưu tiên dùng giao thức Art-Net LAN"
                        className="kiln-btn h-7 px-2.5 text-[11px] text-[#FFB26B]"
                      >
                        Dùng Art-Net
                      </button>
                    )}
                    {isSerialDriver ? (
                      <button
                        type="button"
                        onClick={() => {
                          refreshSerialPorts()
                          notify('Đã quét lại các cổng USB / Serial trên máy', 'info')
                        }}
                        className="kiln-btn kiln-btn-cue h-7 px-3 text-[11px]"
                      >
                        <RefreshCw size={12} />
                        Quét cổng USB
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          pollNow()
                          notify(
                            out.driver === 'kinet'
                              ? 'Đã gửi gói KiNET Poll quét nguồn đèn'
                              : out.driver === 'sacn'
                                ? 'Đã cập nhật trạng thái đích sACN E1.31'
                                : 'Đã gửi gói ArtPoll quét Node trên mạng',
                            'info',
                          )
                        }}
                        className="kiln-btn kiln-btn-cue h-7 px-3 text-[11px]"
                      >
                        <RefreshCw size={12} />
                        {out.driver === 'kinet' ? 'Quét KiNET' : out.driver === 'sacn' ? 'Kiểm tra sACN' : 'Quét Node (ArtPoll)'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Giao thức xuất DMX (Ưu tiên Art-Net)</span>
                    <select
                      value={out.driver}
                      onChange={(e) => handleDriverChange(e.target.value as DriverId)}
                      className="kiln-field h-9 w-full px-3 text-xs"
                    >
                      <option value="artnet">Art-Net (UDP mạng LAN — Ưu tiên)</option>
                      <option value="sacn">sACN E1.31 (UDP Multicast / Unicast)</option>
                      <option value="kinet">KiNET v1/v2 (Color Kinetics UDP)</option>
                      <option value="enttec-pro">Enttec DMX USB Pro (USB Serial)</option>
                      <option value="enttec-mk2">Enttec DMX USB Pro Mk2 (Dual Port)</option>
                      <option value="serial">Generic Serial / RS-485</option>
                      <option value="mock">Mock (Mô phỏng nội bộ)</option>
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

                {isNetworkDriver && (
                  <>
                    {out.driver === 'sacn' && (
                      <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)]">
                        <div>
                          <div className="font-medium text-fg">Chế độ gửi sACN E1.31</div>
                          <div className="text-[10.5px] text-muted">
                            Multicast tự động dùng dải {sacnMulticastIp(out.sacnUniverse ?? out.universe + 1)}
                          </div>
                        </div>
                        <div className="kiln-seg">
                          <button
                            type="button"
                            onClick={() => updateOutputSettings({ sacnMulticast: true })}
                            className={`kiln-seg-btn h-6 px-2.5 text-[11px] ${out.sacnMulticast !== false ? 'on' : ''}`}
                          >
                            Multicast
                          </button>
                          <button
                            type="button"
                            onClick={() => updateOutputSettings({ sacnMulticast: false })}
                            className={`kiln-seg-btn h-6 px-2.5 text-[11px] ${out.sacnMulticast === false ? 'on' : ''}`}
                          >
                            Unicast IP
                          </button>
                        </div>
                      </div>
                    )}

                    {(out.driver !== 'sacn' || out.sacnMulticast === false) && (
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
                            <button
                              type="button"
                              onClick={() => applyIp('127.0.0.1')}
                              className="kiln-chip cue cursor-pointer"
                            >
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
                    )}

                    {out.driver === 'sacn' ? (
                      <div className="grid grid-cols-3 gap-2.5">
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Port UDP sACN</span>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={out.port || SACN_PORT}
                            onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || SACN_PORT })}
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">sACN Universe (1–63999)</span>
                          <input
                            type="number"
                            min="1"
                            max="63999"
                            value={out.sacnUniverse ?? out.universe + 1}
                            onChange={(e) =>
                              updateOutputSettings({
                                sacnUniverse: Math.min(63999, Math.max(1, Number(e.target.value) || 1)),
                              })
                            }
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Ưu tiên (Priority 0–200)</span>
                          <input
                            type="number"
                            min="0"
                            max="200"
                            value={out.sacnPriority ?? 100}
                            onChange={(e) =>
                              updateOutputSettings({
                                sacnPriority: Math.min(200, Math.max(0, Number(e.target.value) || 100)),
                              })
                            }
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                      </div>
                    ) : out.driver === 'kinet' ? (
                      <div className="grid grid-cols-4 gap-2.5">
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Port UDP KiNET</span>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={out.port || KINET_PORT}
                            onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || KINET_PORT })}
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Phiên bản</span>
                          <select
                            value={out.kinetVersion ?? 2}
                            onChange={(e) => updateOutputSettings({ kinetVersion: Number(e.target.value) as 1 | 2 })}
                            className="kiln-field h-8 w-full px-2 text-xs"
                          >
                            <option value={2}>KiNET v2 (PORT_OUT)</option>
                            <option value={1}>KiNET v1 (DMXOUT)</option>
                          </select>
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Cổng Port (1–16)</span>
                          <input
                            type="number"
                            min="1"
                            max="16"
                            value={out.kinetPort ?? 1}
                            onChange={(e) =>
                              updateOutputSettings({ kinetPort: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })
                            }
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Universe</span>
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
                    ) : (
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
                    )}
                  </>
                )}

                {isSerialDriver && (
                  <div className="space-y-3 rounded-xl bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1.5">
                        <span className="text-[11px] text-[#C2B3A4]">Cổng USB / COM phát hiện</span>
                        <select
                          value={serialPorts.includes(out.serialPort ?? '') ? out.serialPort : ''}
                          onChange={(e) => e.target.value && updateOutputSettings({ serialPort: e.target.value })}
                          className="kiln-field h-8 w-full px-2.5 text-xs"
                        >
                          <option value="">
                            {serialPorts.length === 0 ? 'Không tìm thấy thiết bị USB' : 'Chọn cổng tự động...'}
                          </option>
                          {serialPorts.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="space-y-1.5">
                        <span className="text-[11px] text-[#C2B3A4]">Đường dẫn cổng (COM / /dev/cu.*)</span>
                        <input
                          value={out.serialPort ?? ''}
                          onChange={(e) => updateOutputSettings({ serialPort: e.target.value })}
                          placeholder="vd: COM3 hoặc /dev/cu.usbserial-EN123"
                          className="kiln-field h-8 w-full px-2.5 font-mono text-xs"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1.5">
                        <span className="text-[11px] text-[#C2B3A4]">Baud Rate</span>
                        <select
                          value={out.baudRate ?? (out.driver === 'serial' ? 250000 : 57600)}
                          onChange={(e) => updateOutputSettings({ baudRate: Number(e.target.value) })}
                          className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                        >
                          <option value={57600}>57600 (Enttec Pro / Mk2)</option>
                          <option value={115200}>115200 (USB Serial)</option>
                          <option value={250000}>250000 (Chuẩn DMX512 RS-485)</option>
                        </select>
                      </label>

                      {out.driver === 'enttec-mk2' && (
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Cổng DMX trên Enttec Mk2</span>
                          <select
                            value={out.enttecMk2Port ?? 1}
                            onChange={(e) => updateOutputSettings({ enttecMk2Port: Number(e.target.value) as 1 | 2 })}
                            className="kiln-field h-8 w-full px-2.5 text-xs"
                          >
                            <option value={1}>Port 1 (Label 0x06)</option>
                            <option value={2}>Port 2 (Label 0xA9)</option>
                          </select>
                        </label>
                      )}

                      {out.driver === 'serial' && (
                        <label className="space-y-1.5">
                          <span className="text-[11px] text-[#C2B3A4]">Định dạng khung Serial</span>
                          <select
                            value={out.serialFormat ?? 'raw'}
                            onChange={(e) =>
                              updateOutputSettings({ serialFormat: e.target.value as 'raw' | 'enttec' | 'ascii' })
                            }
                            className="kiln-field h-8 w-full px-2.5 text-xs"
                          >
                            <option value="raw">DMX512 RAW (StartCode 0 + 512 ch)</option>
                            <option value="enttec">Enttec Framing (0x7E ... 0xE7)</option>
                            <option value="ascii">ASCII Text (DMX:c1,c2,...)</option>
                          </select>
                        </label>
                      )}
                    </div>
                  </div>
                )}

                <div className="rounded-xl bg-black/30 p-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="mb-1.5 text-[11px] font-medium text-muted">
                    Thiết bị / Node DMX phản hồi realtime ({nodes.length})
                  </div>
                  {nodes.length === 0 ? (
                    <div className="text-[11px] text-muted">
                      {isSerialDriver
                        ? 'Chọn cổng COM hoặc /dev/cu.* tương ứng với mạch USB-DMX đang cắm.'
                        : out.driver === 'sacn'
                          ? 'sACN E1.31 đang chờ gửi khung đầu tiên.'
                          : out.driver === 'kinet'
                            ? 'Chưa nhận được KiNET PollReply. Kiểm tra IP thiết bị hoặc gửi trực tiếp tới IP PSU.'
                            : 'Chưa nhận được ArtPollReply nào. Kiểm tra cùng subnet hoặc firewall nếu dùng thiết bị thật.'}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {nodes.map((n) => (
                        <div key={n.ip} className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-1.5">
                          <span className="font-medium text-fg">
                            {n.name} <span className="text-[10px] text-muted">· {n.longName}</span>
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-info">{n.ip}</span>
                            {isNetworkDriver && (
                              <button type="button" onClick={() => applyIp(n.ip)} className="kiln-chip acc cursor-pointer">
                                Chọn IP này
                              </button>
                            )}
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
                  Đồng bộ Timecode &amp; LTC Audio
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Tốc độ khung hình (FPS)</span>
                    <select
                      value={tl.fps}
                      onChange={(e) => updateTimelineSettings({ fps: Number(e.target.value) as Fps })}
                      className="kiln-field h-9 w-full px-2.5 text-xs"
                    >
                      {FPS_OPTIONS.map((f) => (
                        <option key={f} value={f}>
                          {f} fps{f === 29.97 ? ' (Drop Frame)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-[#C2B3A4]">Timecode bắt đầu (hh:mm:ss:ff)</span>
                    <input
                      value={startTcText}
                      onChange={(e) => setStartTcText(e.target.value)}
                      onBlur={applyStartTc}
                      onKeyDown={(e) => e.key === 'Enter' && applyStartTc()}
                      placeholder="00:00:00:00"
                      className="kiln-field h-9 w-full px-3 font-mono text-xs tabular-nums"
                    />
                  </label>

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
