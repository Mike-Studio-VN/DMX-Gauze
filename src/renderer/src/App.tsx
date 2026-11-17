import { useEffect } from 'react'
import { Lock, OctagonX, Settings, Unlock, Wifi, WifiOff } from 'lucide-react'
import { IconButton } from './components/IconButton'
import { GauzeTree } from './components/GauzeTree'
import { Stage3D } from './components/Stage3D'
import { ControlDeck } from './components/ControlDeck'
import { PropertiesPanel } from './components/PropertiesPanel'
import { SettingsModal } from './components/SettingsModal'
import { useAppStore } from './store/useAppStore'

function Panel({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col rounded-ui border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
      </h2>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </section>
  )
}

export function App() {
  const { ready, info, project, snapshot, toast, init, setSettingsOpen, sendCommand } = useAppStore()

  useEffect(() => {
    void init()
  }, [init])

  const st = snapshot?.status
  const locked = snapshot?.locked ?? true
  const out = project.settings.output

  const statusMeta = (() => {
    if (!st || st.state === 'idle') return { dot: 'bg-muted', text: 'Đang khởi tạo...', cls: 'text-muted', icon: Wifi }
    if (st.state === 'error') return { dot: 'bg-danger', text: st.message ?? 'Lỗi mạng', cls: 'text-danger', icon: WifiOff }
    if (st.state === 'lost') return { dot: 'bg-danger', text: 'Mất kết nối Node', cls: 'text-danger', icon: WifiOff }
    if (st.state === 'online') {
      return {
        dot: 'bg-ok',
        text: `Trực tuyến · ${st.nodes.length} Node · ${st.sendHz}Hz`,
        cls: 'text-ok',
        icon: Wifi,
      }
    }
    return {
      dot: 'bg-warn',
      text: `Đang gửi (${st.sendHz}Hz) · Chưa thấy Node`,
      cls: 'text-warn',
      icon: Wifi,
    }
  })()

  const StatusIcon = statusMeta.icon

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex items-center justify-between gap-2 rounded-ui border border-line bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-9 place-items-center rounded-ui bg-brand font-bold text-brand-fg">G</span>
          <h1 className="text-base font-semibold">DMX Gauze</h1>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={`Giao thức: ${out.driver.toUpperCase()} · Đích: ${out.ip}:${out.port} · Universe ${out.universe}. Bấm để mở Cài đặt mạng`}
            className={`inline-flex cursor-pointer items-center gap-2 rounded-full border border-line bg-panel-2 px-3 py-1 text-xs ${statusMeta.cls}`}
          >
            <span className={`size-2 rounded-full ${statusMeta.dot}`} />
            <StatusIcon size={14} aria-hidden />
            <span>{statusMeta.text}</span>
            <span className="font-mono text-muted">· {out.ip}</span>
          </button>

          {st?.warning && (
            <span className="rounded-full bg-warn/15 px-2.5 py-0.5 text-[11px] text-warn">{st.warning}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <IconButton
            icon={locked ? Lock : Unlock}
            label={locked ? `Mở khoá an toàn (gửi CH4 = ${project.settings.lockValue})` : 'Khoá an toàn (CH4 = 0)'}
            variant={locked ? 'ghost' : 'brand'}
            onClick={() => void sendCommand({ type: 'lock', locked: !locked })}
          >
            <span className="text-xs">{locked ? 'Đang khoá' : 'Đã mở khoá'}</span>
          </IconButton>

          <IconButton
            icon={OctagonX}
            label="Dừng khẩn cấp (E-Stop): khoá CH4=0 và dừng toàn bộ"
            variant="danger"
            onClick={() => void sendCommand({ type: 'estop' })}
          >
            <span className="text-xs font-bold">E-STOP</span>
          </IconButton>

          <IconButton icon={Settings} label="Cài đặt mạng DMX & Hệ thống" onClick={() => setSettingsOpen(true)} />
        </div>
      </header>

      {ready ? (
        <main className="grid min-h-0 flex-1 grid-cols-[270px_1fr_300px] gap-3">
          <Panel title="Cây màn">
            <GauzeTree />
          </Panel>

          <div className="grid min-h-0 grid-rows-[1fr_255px] gap-3">
            <Panel title="Mô phỏng 3D">
              <Stage3D />
            </Panel>
            <Panel title="Điều khiển">
              <ControlDeck />
            </Panel>
          </div>

          <Panel title="Thuộc tính">
            <PropertiesPanel />
          </Panel>
        </main>
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted">Đang tải dự án...</div>
      )}

      <footer className="flex items-center justify-between text-xs text-muted">
        <span>
          {out.driver === 'artnet' ? 'Art-Net UDP' : 'Mock'} · Net {out.net} · Sub {out.subnet} · Uni {out.universe}
        </span>
        <span>
          v{info?.version ?? '0.1.0'} · {info?.runtime ?? 'web'}
        </span>
      </footer>

      {toast && (
        <div
          role="status"
          className={`fixed right-5 bottom-8 z-50 rounded-ui border px-3.5 py-2 text-xs font-medium shadow-lg ${
            toast.kind === 'error'
              ? 'border-danger bg-panel text-danger'
              : toast.kind === 'warn'
                ? 'border-warn bg-panel text-warn'
                : 'border-info bg-panel text-info'
          }`}
        >
          {toast.text}
        </div>
      )}

      <SettingsModal />
    </div>
  )
}
