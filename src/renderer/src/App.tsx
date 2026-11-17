import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Download,
  FilePlus,
  FolderOpen,
  Lock,
  OctagonX,
  Save,
  SaveAll,
  Settings,
  Unlock,
  Wifi,
  WifiOff,
} from 'lucide-react'
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
  const {
    ready,
    info,
    project,
    projectFilePath,
    dirty,
    snapshot,
    toast,
    init,
    setSettingsOpen,
    sendCommand,
    newProject,
    openProject,
    saveCurrentProject,
    saveAsProject,
    exportProject,
  } = useAppStore()

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  // Đóng menu Project khi click ra ngoài hoặc bấm Escape, và hỗ trợ Cmd/Ctrl+S
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (e.shiftKey) void saveAsProject()
        else void saveCurrentProject()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, saveCurrentProject, saveAsProject])

  const st = snapshot?.status
  const locked = snapshot?.locked ?? true
  const out = project.settings.output
  const fileLabel = projectFilePath ? projectFilePath.split(/[\\/]/).pop() : 'Chưa lưu'

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
          {/* Bấm vào tên app để mở menu Project */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              title="Menu dự án: New, Open, Save, Save As, Settings, Xuất file"
              className={`flex cursor-pointer items-center gap-2.5 rounded-ui px-1.5 py-1 transition hover:bg-panel-2 ${
                menuOpen ? 'bg-panel-2' : ''
              }`}
            >
              <span className="grid size-9 place-items-center rounded-ui bg-brand font-bold text-brand-fg">G</span>
              <span className="text-left">
                <span className="flex items-center gap-1 text-base leading-tight font-semibold">
                  DMX Gauze
                  <ChevronDown size={15} className={`text-muted transition ${menuOpen ? 'rotate-180' : ''}`} />
                </span>
                <span className="block text-[11px] leading-tight text-muted">
                  {fileLabel}
                  {dirty ? ' *' : ''}
                </span>
              </span>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute top-full left-0 z-50 mt-2 w-60 overflow-hidden rounded-ui border border-info/40 bg-panel py-1.5 text-xs shadow-2xl"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void newProject()
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-panel-2"
                >
                  <FilePlus size={15} className="text-info" />
                  <span className="flex-1">Dự án mới (New)</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void openProject()
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-panel-2"
                >
                  <FolderOpen size={15} className="text-info" />
                  <span className="flex-1">Mở file... (Open)</span>
                </button>

                <div className="my-1 border-t border-line" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void saveCurrentProject()
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-panel-2"
                >
                  <Save size={15} className="text-brand" />
                  <span className="flex-1">Lưu (Save)</span>
                  <kbd className="text-[10px] text-muted">Ctrl+S</kbd>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void saveAsProject()
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-panel-2"
                >
                  <SaveAll size={15} className="text-brand" />
                  <span className="flex-1">Lưu thành... (Save As)</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void exportProject()
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-panel-2"
                >
                  <Download size={15} className="text-muted" />
                  <span className="flex-1">Xuất file project</span>
                </button>

                <div className="my-1 border-t border-line" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setSettingsOpen(true)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-panel-2"
                >
                  <Settings size={15} className="text-muted" />
                  <span className="flex-1">Cài đặt (Settings)</span>
                </button>
              </div>
            )}
          </div>

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
