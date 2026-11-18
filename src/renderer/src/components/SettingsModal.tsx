import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  LayoutGrid,
  Link2,
  Network,
  Radio,
  RefreshCw,
  Shield,
  Sliders,
  Volume2,
  X,
} from 'lucide-react'
import { ARTNET_PORT, isLoopbackTarget, isValidIPv4 } from '@shared/dmx'
import { DMX_TRANSPORT_RATES } from '@shared/dmxTransport'
import { KINET_PORT, SACN_PORT, sacnMulticastIp } from '@shared/protocols'
import {
  FPS_OPTIONS,
  LTC_FPS_OPTIONS,
  formatTc,
  isStandardLtcFps,
  parseTc,
  resolveLtcFps,
} from '@shared/timecode'
import type { DriverId, Fps, LtcFps } from '@shared/types'
import { getBridge } from '../services/bridge'
import { type SettingsTab, useAppStore } from '../store/useAppStore'
import { KilnSelect, type KilnSelectOption } from './KilnSelect'

const dmxRateOptions = DMX_TRANSPORT_RATES.map((hz) => ({
  value: String(hz),
  label: `${hz} FPS · ${Number((1000 / hz).toFixed(2))} ms/frame`,
}))

export function SettingsModal(props: {
  overrideState?: Partial<ReturnType<typeof useAppStore.getState>>
}) {
  const storeState = useAppStore()
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
    resetPreset,
    notificationSettings,
    updateNotificationSettings,
    notify,
  } = props.overrideState ? { ...storeState, ...props.overrideState } : storeState

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
    { id: 'notifications', label: 'Thông báo', icon: Bell },
  ]

  const tab = navItems.some((i) => i.id === settingsTab) ? settingsTab : 'network'

  const isSerialDriver = out.driver === 'enttec-pro' || out.driver === 'enttec-mk2' || out.driver === 'serial'
  const isNetworkDriver = !isSerialDriver

  const driverOptions: KilnSelectOption[] = [
    {
      value: 'artnet',
      label: 'Art-Net',
      badge: 'Ưu tiên',
      description: 'UDP mạng LAN',
      group: 'Mạng LAN',
      icon: <Radio size={15} />,
    },
    {
      value: 'sacn',
      label: 'sACN E1.31',
      description: 'UDP Multicast / Unicast',
      group: 'Mạng LAN',
      icon: <Radio size={15} />,
    },
    {
      value: 'kinet',
      label: 'KiNET v1/v2',
      description: 'Color Kinetics UDP',
      group: 'Mạng LAN',
      icon: <Radio size={15} />,
    },
    {
      value: 'enttec-pro',
      label: 'Enttec DMX USB Pro',
      description: 'USB Serial',
      group: 'USB / Serial',
      icon: <Link2 size={15} />,
    },
    {
      value: 'enttec-mk2',
      label: 'Enttec DMX USB Pro Mk2',
      description: 'Dual Port',
      group: 'USB / Serial',
      icon: <Link2 size={15} />,
    },
    {
      value: 'serial',
      label: 'Generic Serial / RS-485',
      description: 'Cổng nối tiếp',
      group: 'USB / Serial',
      icon: <Link2 size={15} />,
    },
    {
      value: 'mock',
      label: 'Mock',
      description: 'Mô phỏng nội bộ',
      group: 'Thử nghiệm',
      icon: <LayoutGrid size={15} />,
    },
  ]

  const handleDriverChange = (next: DriverId) => {
    if (next === 'artnet') {
      updateOutputSettings({ driver: 'artnet', port: ARTNET_PORT })
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
              <br />v{info?.version ?? '1.1.0'} · {info?.runtime ?? 'web'}
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

                <div className="grid grid-cols-2 items-end gap-3">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex min-h-[18px] items-center justify-between gap-2">
                      <span className="text-[11px] leading-4 text-[#C2B3A4]">Giao thức xuất DMX (Ưu tiên Art-Net)</span>
                    </div>
                    <KilnSelect
                      ariaLabel="Giao thức xuất DMX"
                      value={out.driver}
                      options={driverOptions}
                      onChange={(val) => handleDriverChange(val as DriverId)}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex min-h-[18px] items-center justify-between gap-2">
                      <span className="text-[11px] leading-4 text-[#C2B3A4]">Tần số phát frame DMX</span>
                      <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[10px] leading-none font-semibold text-[#FFB26B]">
                        Đồng bộ file {out.sendHz} Hz
                      </span>
                    </div>
                    <KilnSelect
                      ariaLabel="Tần số phát frame DMX"
                      value={String(out.sendHz)}
                      options={dmxRateOptions}
                      onChange={(val) => updateOutputSettings({ sendHz: Number(val) })}
                      tabular
                    />
                  </div>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Port UDP sACN</span>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={out.port || SACN_PORT}
                            onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || SACN_PORT })}
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">sACN Universe (1–63999)</span>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Ưu tiên (Priority 0–200)</span>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Port UDP KiNET</span>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={out.port || KINET_PORT}
                            onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || KINET_PORT })}
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Phiên bản</span>
                          <KilnSelect
                            ariaLabel="Phiên bản KiNET"
                            size="sm"
                            value={String(out.kinetVersion ?? 2)}
                            options={[
                              { value: '2', label: 'KiNET v2', description: 'PORT_OUT' },
                              { value: '1', label: 'KiNET v1', description: 'DMXOUT' },
                            ]}
                            onChange={(val) => updateOutputSettings({ kinetVersion: Number(val) as 1 | 2 })}
                          />
                        </div>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Cổng Port (1–16)</span>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Universe</span>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Port UDP Art-Net</span>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={out.port || ARTNET_PORT}
                            onChange={(e) => updateOutputSettings({ port: Number(e.target.value) || ARTNET_PORT })}
                            className="kiln-field h-8 w-full px-2.5 text-xs tabular-nums"
                          />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Net (0–127)</span>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Subnet (0–15)</span>
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
                        <label className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Universe (0–15)</span>
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
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] leading-4 text-[#C2B3A4]">Cổng USB / COM phát hiện</span>
                        <KilnSelect
                          ariaLabel="Cổng USB / COM phát hiện"
                          size="sm"
                          value={serialPorts.includes(out.serialPort ?? '') ? (out.serialPort ?? '') : ''}
                          options={[
                            {
                              value: '',
                              label: serialPorts.length === 0 ? 'Không tìm thấy thiết bị USB' : 'Chọn cổng tự động...',
                            },
                            ...serialPorts.map((p) => ({ value: p, label: p })),
                          ]}
                          onChange={(val) => val && updateOutputSettings({ serialPort: val })}
                        />
                      </div>

                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] leading-4 text-[#C2B3A4]">Đường dẫn cổng (COM / /dev/cu.*)</span>
                        <input
                          value={out.serialPort ?? ''}
                          onChange={(e) => updateOutputSettings({ serialPort: e.target.value })}
                          placeholder="vd: COM3 hoặc /dev/cu.usbserial-EN123"
                          className="kiln-field h-8 w-full px-2.5 font-mono text-xs"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] leading-4 text-[#C2B3A4]">Baud Rate</span>
                        <KilnSelect
                          ariaLabel="Baud Rate"
                          size="sm"
                          tabular
                          value={String(out.baudRate ?? (out.driver === 'serial' ? 250000 : 57600))}
                          options={[
                            { value: '57600', label: '57600', description: 'Enttec Pro / Mk2' },
                            { value: '115200', label: '115200', description: 'USB Serial' },
                            { value: '250000', label: '250000', description: 'Chuẩn DMX512 RS-485' },
                          ]}
                          onChange={(val) => updateOutputSettings({ baudRate: Number(val) })}
                        />
                      </div>

                      {out.driver === 'enttec-mk2' && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Cổng DMX trên Enttec Mk2</span>
                          <KilnSelect
                            ariaLabel="Cổng DMX trên Enttec Mk2"
                            size="sm"
                            value={String(out.enttecMk2Port ?? 1)}
                            options={[
                              { value: '1', label: 'Port 1', description: 'Label 0x06' },
                              { value: '2', label: 'Port 2', description: 'Label 0xA9' },
                            ]}
                            onChange={(val) => updateOutputSettings({ enttecMk2Port: Number(val) as 1 | 2 })}
                          />
                        </div>
                      )}

                      {out.driver === 'serial' && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] leading-4 text-[#C2B3A4]">Định dạng khung Serial</span>
                          <KilnSelect
                            ariaLabel="Định dạng khung Serial"
                            size="sm"
                            value={out.serialFormat ?? 'raw'}
                            options={[
                              { value: 'raw', label: 'DMX512 RAW', description: 'StartCode 0 + 512 ch' },
                              { value: 'enttec', label: 'Enttec Framing', description: '0x7E ... 0xE7' },
                              { value: 'ascii', label: 'ASCII Text', description: 'DMX:c1,c2,...' },
                            ]}
                            onChange={(val) =>
                              updateOutputSettings({ serialFormat: val as 'raw' | 'enttec' | 'ascii' })
                            }
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="rounded-xl bg-black/30 p-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="kiln-readout mb-1.5 text-[11px] font-medium">
                    Thiết bị / Node DMX phản hồi realtime ({nodes.length})
                  </div>
                  {snapshot?.status.warning && (
                    <div className="mb-2 flex items-start gap-2 rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn shadow-[inset_0_0_0_1px_rgba(255,203,114,0.3)]">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>{snapshot.status.warning}</span>
                    </div>
                  )}
                  {nodes.length === 0 ? (
                    <div className="text-[11px] text-muted">
                      {isSerialDriver
                        ? 'Chọn cổng COM hoặc /dev/cu.* tương ứng với mạch USB-DMX đang cắm.'
                        : out.driver === 'sacn'
                          ? 'sACN E1.31 đang chờ gửi khung đầu tiên.'
                          : out.driver === 'kinet'
                            ? 'Chưa nhận được KiNET PollReply. Kiểm tra IP thiết bị hoặc gửi trực tiếp tới IP PSU.'
                            : isLoopbackTarget(out.ip)
                              ? 'Chưa nhận được phản hồi Art-Net.'
                              : 'Chưa nhận được ArtPollReply nào. Kiểm tra cùng subnet hoặc firewall nếu dùng thiết bị thật.'}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {nodes.map((n) => (
                        <div key={n.ip} className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-1.5">
                          <span className="kiln-readout font-medium">
                            {n.name} <span className="text-[10px] text-muted">· {n.longName}</span>
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="kiln-readout font-mono">{n.ip}</span>
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

            {tab === 'ltc' && (() => {
              const ltcMatched = isStandardLtcFps(tl.fps)
              const effectiveLtcFps = resolveLtcFps(tl.fps, project.settings.ltc.fps)
              return (
              <div className="space-y-4">
                <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                  Đồng bộ Timecode &amp; LTC Audio
                </div>

                {!ltcMatched && (
                  <div className="flex items-start gap-2 rounded-xl bg-warn/10 px-3 py-2 text-[11px] text-warn shadow-[inset_0_0_0_1px_rgba(255,203,114,0.35)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <div>
                      <div className="font-semibold">Timeline {tl.fps} fps không khớp chuẩn LTC SMPTE</div>
                      <div className="text-[#E7D4B5]">
                        LTC In hỗ trợ 24 / 25 / 29.97 / 30 fps và đang dùng{' '}
                        <strong className="kiln-readout">{effectiveLtcFps} fps</strong>.
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Tốc độ khung hình Timeline (FPS)</span>
                    <KilnSelect
                      ariaLabel="Tốc độ khung hình Timeline"
                      tabular
                      value={String(tl.fps)}
                      options={FPS_OPTIONS.map((f) => ({
                        value: String(f),
                        label: `${f} fps`,
                        badge: f === 29.97 ? 'Drop Frame' : f > 30 ? 'High FPS' : undefined,
                      }))}
                      onChange={(val) => updateTimelineSettings({ fps: Number(val) as Fps })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Tốc độ khung LTC In (chuẩn SMPTE)</span>
                    <KilnSelect
                      ariaLabel="Tốc độ khung LTC In"
                      tabular
                      value={project.settings.ltc.fps !== undefined ? String(project.settings.ltc.fps) : 'auto'}
                      options={[
                        {
                          value: 'auto',
                          label: ltcMatched ? 'Theo Timeline' : 'Giữ rate riêng',
                          badge: `${effectiveLtcFps} fps`,
                        },
                        ...LTC_FPS_OPTIONS.map((f) => ({
                          value: String(f),
                          label: `${f} fps`,
                          badge: f === 29.97 ? 'Drop Frame' : undefined,
                        })),
                      ]}
                      onChange={(val) =>
                        updateLtcSettings({ fps: val === 'auto' ? undefined : (Number(val) as LtcFps) })
                      }
                    />
                  </div>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Timecode bắt đầu (hh:mm:ss:ff)</span>
                    <input
                      value={startTcText}
                      onChange={(e) => setStartTcText(e.target.value)}
                      onBlur={applyStartTc}
                      onKeyDown={(e) => e.key === 'Enter' && applyStartTc()}
                      placeholder="00:00:00:00"
                      className="kiln-field h-9 w-full px-3 font-mono text-xs tabular-nums"
                    />
                  </label>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Thiết bị thu âm (Line-in / USB)</span>
                    <KilnSelect
                      ariaLabel="Thiết bị thu âm"
                      value={project.settings.ltc.deviceId}
                      options={[
                        { value: '', label: 'Thiết bị mặc định hệ thống' },
                        ...audioInputs.map((d) => ({
                          value: d.deviceId,
                          label: d.label || `Audio Input (${d.deviceId.slice(0, 6)})`,
                        })),
                      ]}
                      onChange={(val) => updateLtcSettings({ deviceId: val })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Kênh âm thanh</span>
                    <KilnSelect
                      ariaLabel="Kênh âm thanh"
                      value={project.settings.ltc.channel}
                      options={[
                        { value: 'left', label: 'Trái (Left)' },
                        { value: 'right', label: 'Phải (Right)' },
                      ]}
                      onChange={(val) => updateLtcSettings({ channel: val as 'left' | 'right' })}
                    />
                  </div>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Freewheel khi mất tín hiệu (frames)</span>
                    <input
                      type="number"
                      min="0"
                      max="120"
                      value={project.settings.ltc.freewheelFrames}
                      onChange={(e) => {
                        if (Number.isFinite(e.target.valueAsNumber)) {
                          updateLtcSettings({ freewheelFrames: e.target.valueAsNumber })
                        }
                      }}
                      className="kiln-field h-9 w-full px-3 text-xs tabular-nums"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[11px] leading-4 text-[#C2B3A4]">Bù trễ (Offset frames)</span>
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
              )
            })()}

            {tab === 'notifications' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div>
                    <div className="font-medium text-fg">Hiển thị thông báo pop-up</div>
                    <div className="text-[11px] text-muted">
                      Báo trạng thái kết nối DMX/Serial, E-Stop, lưu/mở dự án và giới hạn an toàn
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={notificationSettings.enabled}
                    onClick={() => updateNotificationSettings({ enabled: !notificationSettings.enabled })}
                    className={`kiln-btn h-7 px-3 text-[11px] ${
                      notificationSettings.enabled ? 'kiln-btn-primary' : 'text-[#C2B3A4]'
                    }`}
                  >
                    {notificationSettings.enabled ? 'Đang bật' : 'Đang tắt'}
                  </button>
                </div>

                <div className="space-y-2 rounded-xl bg-white/[0.03] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[#C2B3A4]">Thời gian tự ẩn</span>
                    <span className="kiln-readout text-[11px] tabular-nums">
                      {(notificationSettings.durationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[2000, 3500, 5000, 8000].map((ms) => (
                      <button
                        key={ms}
                        type="button"
                        onClick={() => updateNotificationSettings({ durationMs: ms })}
                        className={`kiln-btn h-7 px-3 text-[11px] tabular-nums ${
                          notificationSettings.durationMs === ms ? 'kiln-btn-primary' : 'text-[#C2B3A4]'
                        }`}
                      >
                        {(ms / 1000).toFixed(ms === 3500 ? 1 : 0)}s
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 rounded-xl bg-white/[0.03] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="text-[11px] font-medium text-[#C2B3A4]">Loại thông báo hiển thị</div>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ['info', 'Thông tin / Trạng thái'],
                        ['success', 'Thành công / Kết nối'],
                        ['warn', 'Cảnh báo giới hạn'],
                        ['error', 'Lỗi / E-Stop'],
                      ] as const
                    ).map(([kind, label]) => {
                      const active = notificationSettings.kinds[kind]
                      return (
                        <button
                          key={kind}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            updateNotificationSettings({
                              kinds: { ...notificationSettings.kinds, [kind]: !active },
                            })
                          }
                          className={`kiln-btn h-8 justify-between px-3 text-[11px] ${
                            active ? 'kiln-btn-primary' : 'text-[#C2B3A4]'
                          }`}
                        >
                          <span className="truncate">{label}</span>
                          <span>{active ? 'Bật' : 'Tắt'}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      notify('Thông báo thử nghiệm đã được kích hoạt — tự ẩn theo cấu hình.', 'info', {
                        title: 'Xem trước thông báo',
                        icon: 'running',
                      })
                    }
                    className="kiln-btn h-8 px-3.5 text-[11.5px] text-[#FFB26B]"
                  >
                    <Bell size={13} />
                    Thử thông báo
                  </button>
                </div>
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
