import { useEffect, useRef, useState } from 'react'
import mikLogo from './assets/mik-logo.png'
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  Download,
  FilePlus,
  Folder,
  FolderOpen,
  Lock,
  OctagonX,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Redo2,
  RotateCcw,
  Save,
  SaveAll,
  Settings,
  ShieldAlert,
  Square,
  Undo2,
  Unlock,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { ARTNET_PORT, isLoopbackTarget } from '@shared/dmx'
import { IconButton } from './components/IconButton'
import { GauzeTree } from './components/GauzeTree'
import { CollapsedTreeRail } from './components/CollapsedTreeRail'
import { Stage3D } from './components/Stage3D'
import { ControlDeck } from './components/ControlDeck'
import { PropertiesPanel } from './components/PropertiesPanel'
import { SettingsModal } from './components/SettingsModal'
import { useAppStore } from './store/useAppStore'

function Panel({
  title,
  collapsed,
  collapseSide,
  onToggleCollapse,
  children,
}: {
  title?: string
  collapsed?: boolean
  collapseSide?: 'left' | 'right'
  onToggleCollapse?: () => void
  children?: React.ReactNode
}) {
  if (collapsed && onToggleCollapse) {
    const OpenIcon = collapseSide === 'right' ? PanelRightOpen : PanelLeftOpen
    const label = title ?? 'Bảng'
    return (
      <section className="kiln-panel flex min-h-0 flex-col items-center py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          title={`Mở rộng ${label}`}
          aria-label={`Mở rộng ${label}`}
          className="cursor-pointer rounded-full p-1.5 text-info hover:bg-white/10"
        >
          <OpenIcon size={16} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={`Mở rộng ${label}`}
          style={{ writingMode: 'vertical-rl' }}
          className="mt-3 flex-1 cursor-pointer text-[11px] font-semibold tracking-wider text-muted hover:text-fg"
        >
          {label}
        </button>
      </section>
    )
  }

  const CloseIcon = collapseSide === 'right' ? PanelRightClose : PanelLeftClose
  const showHeader = Boolean(title || onToggleCollapse)

  return (
    <section className="kiln-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      {showHeader && (
        <div className="flex h-[42px] shrink-0 items-center justify-between px-4">
          {title ? <h2 className="text-[13.5px] font-semibold text-fg">{title}</h2> : <span />}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={`Thu gọn ${title ?? ''}`}
              aria-label={`Thu gọn ${title ?? ''}`}
              className="cursor-pointer rounded-full p-1 text-muted hover:bg-white/10 hover:text-fg"
            >
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}
      <div className={`min-h-0 min-w-0 flex-1 px-3 pb-3 ${showHeader ? '' : 'pt-3'}`}>{children}</div>
    </section>
  )
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable
}

export function App() {
  const {
    ready,
    info,
    project,
    projectFilePath,
    dirty,
    past,
    future,
    activeTab,
    snapshot,
    toast,
    dismissToast,
    init,
    undo,
    redo,
    copySelection,
    pasteSelection,
    deleteSelection,
    setSettingsOpen,
    sendCommand,
    newProject,
    openProject,
    saveCurrentProject,
    saveAsProject,
    exportProject,
    resetPreset,
  } = useAppStore()

  const [menuOpen, setMenuOpen] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [leftWidth, setLeftWidth] = useState(() => Number(localStorage.getItem('gauze-w-left')) || 268)
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('gauze-w-right')) || 300)
  const [bottomHeight, setBottomHeight] = useState(() => Number(localStorage.getItem('gauze-h-bot')) || 276)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const startResize = (kind: 'left' | 'right' | 'bottom', e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const initLeft = leftWidth
    const initRight = rightWidth
    const initBottom = bottomHeight

    const onMove = (ev: PointerEvent) => {
      if (kind === 'left') {
        const w = Math.min(440, Math.max(200, initLeft + (ev.clientX - startX)))
        setLeftWidth(w)
        localStorage.setItem('gauze-w-left', String(Math.round(w)))
      } else if (kind === 'right') {
        const w = Math.min(460, Math.max(230, initRight - (ev.clientX - startX)))
        setRightWidth(w)
        localStorage.setItem('gauze-w-right', String(Math.round(w)))
      } else {
        const h = Math.min(520, Math.max(185, initBottom - (ev.clientY - startY)))
        setBottomHeight(h)
        localStorage.setItem('gauze-h-bot', String(Math.round(h)))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (mod && key === 's') {
        e.preventDefault()
        if (e.shiftKey) void saveAsProject()
        else void saveCurrentProject()
        return
      }
      if (mod && key === 'n') {
        e.preventDefault()
        void newProject()
        return
      }
      if (mod && key === 'o') {
        e.preventDefault()
        void openProject()
        return
      }

      if (isTypingTarget(e.target)) return

      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        redo()
      } else if (mod && key === 'c') {
        e.preventDefault()
        copySelection()
      } else if (mod && key === 'v') {
        e.preventDefault()
        pasteSelection()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [
    menuOpen,
    newProject,
    openProject,
    saveCurrentProject,
    saveAsProject,
    undo,
    redo,
    copySelection,
    pasteSelection,
    deleteSelection,
  ])

  const st = snapshot?.status
  const locked = snapshot?.locked ?? true
  const out = project.settings.output
  const artNetLoopback = out.driver === 'artnet' && out.port === ARTNET_PORT && isLoopbackTarget(out.ip)
  const statusTarget = artNetLoopback ? '' : ` · Đích: ${out.ip}:${out.port}`
  const fileLabel = projectFilePath ? projectFilePath.split(/[\\/]/).pop() : 'Chưa lưu'
  const driverShortLabel: Record<string, string> = {
    artnet: 'Art-Net',
    sacn: 'sACN E1.31',
    kinet: 'KiNET',
    'enttec-pro': 'Enttec Pro',
    'enttec-mk2': 'Enttec Mk2',
    serial: 'Serial DMX',
    mock: 'Mock',
  }
  const activeDriverName = driverShortLabel[out.driver] ?? out.driver

  const statusMeta = (() => {
    if (!st || st.state === 'idle') return { chip: 'kiln-chip', dot: 'bg-muted', text: 'Khởi tạo', icon: Wifi }
    if (st.state === 'error') {
      return { chip: 'kiln-chip danger', dot: 'bg-danger', text: 'Lỗi mạng', icon: WifiOff }
    }
    if (st.state === 'lost') return { chip: 'kiln-chip danger', dot: 'bg-danger', text: 'Mất Node', icon: WifiOff }
    if (st.state === 'online') {
      return {
        chip: 'kiln-chip ok',
        dot: 'bg-ok',
        text: `${st.nodes.length} Node · ${st.sendHz}Hz`,
        icon: Wifi,
      }
    }
    if (st.state === 'sending') {
      return { chip: 'kiln-chip', dot: 'bg-muted', text: `Đang gửi · ${st.sendHz}Hz`, icon: Wifi }
    }
    return {
      chip: 'kiln-chip warn',
      dot: 'bg-warn',
      text: `Chờ Node · ${st.sendHz}Hz`,
      icon: Wifi,
    }
  })()

  const StatusIcon = statusMeta.icon

  return (
    <div className="flex h-full flex-col gap-2 bg-bg p-2.5">
      {/* Topbar phẳng theo Kiln */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 px-1.5">
        <div className="flex flex-wrap items-center gap-3">
          {/* Brand + Project Menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              title="Menu dự án: New, Open, Save, Save As, Settings, Xuất file"
              className="flex cursor-pointer items-center gap-2.5 rounded-xl px-1.5 py-1 transition hover:bg-white/5"
            >
              <img
                src={mikLogo}
                alt="MIK"
                className="size-7 shrink-0 object-contain"
              />
              <span className="text-left">
                <span className="flex items-center gap-1 text-[13px] leading-tight font-semibold text-fg">
                  DMX Gauze
                  <ChevronDown size={13} className={`text-muted transition ${menuOpen ? 'rotate-180' : ''}`} />
                </span>
                <span className="block text-[10.5px] leading-tight text-muted">
                  {fileLabel}
                  {dirty ? ' *' : ''}
                </span>
              </span>
            </button>

            {/* Dropdown Project Menu chuẩn Kiln */}
            {menuOpen && (
              <div
                role="menu"
                className="kiln-panel absolute top-full left-0 z-50 mt-2 w-[300px] overflow-hidden py-1 text-xs shadow-2xl"
              >
                <div className="flex h-10 items-center gap-2 px-4 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
                  <Folder size={13} />
                  <span>Dự án hiện tại</span>
                  <span className={`ml-auto ${dirty ? 'kiln-chip acc' : 'kiln-chip ok'}`}>
                    <span className={`size-1.5 rounded-full ${dirty ? 'bg-brand' : 'bg-ok'}`} />
                    {dirty ? 'Chưa lưu' : 'Đã lưu'}
                  </span>
                </div>

                <div className="mx-3 mb-1.5 rounded-xl bg-black/30 px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="truncate text-[14px] font-semibold text-fg">
                    {projectFilePath ? fileLabel : 'DMX Gauze Stage'}
                  </div>
                  <div className="mt-1.5 flex justify-between text-[10.5px] text-muted">
                    <span>
                      {project.layers.length} lớp · {project.modules.length} module
                    </span>
                    <span>
                      {activeDriverName} · {out.driver === 'sacn' ? `U${out.sacnUniverse ?? out.universe + 1}` : `U${out.universe}`}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void newProject()
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <FilePlus size={15} className="text-muted" />
                  <span className="flex-1">Dự án mới (New)</span>
                  <span className="kiln-kbd">Ctrl+N</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void openProject()
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <FolderOpen size={15} className="text-muted" />
                  <span className="flex-1">Mở dự án… (Open)</span>
                  <span className="kiln-kbd">Ctrl+O</span>
                </button>

                <div className="mx-3 my-1.5 border-t border-line" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void saveCurrentProject()
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <Save size={15} className="text-muted" />
                  <span className="flex-1">Lưu dự án (Save)</span>
                  <span className="kiln-kbd">Ctrl+S</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void saveAsProject()
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <SaveAll size={15} className="text-muted" />
                  <span className="flex-1">Lưu thành… (Save As)</span>
                  <span className="kiln-kbd">Ctrl+Shift+S</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void exportProject()
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <Download size={15} className="text-muted" />
                  <span className="flex-1">Xuất file project</span>
                </button>

                <div className="mx-3 my-1.5 border-t border-line" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setSettingsOpen(true, 'network')
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <Settings size={15} className="text-[#FFB26B]" />
                  <span className="flex-1">Cài đặt</span>
                </button>

                <div className="mx-3 my-1.5 border-t border-line" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    resetPreset()
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-[#FFB26B] hover:bg-brand/15"
                >
                  <RotateCcw size={15} />
                  <span className="flex-1">Nạp lại mẫu Demo (12×1m + 1×3m)</span>
                </button>

                <div className="mt-1.5 flex h-9 items-center justify-between border-t border-line px-4 text-[9.5px] font-semibold tracking-widest text-muted uppercase">
                  <span>DMX GAUZE ENGINE</span>
                  <span>v{info?.version ?? '1.0.5'}</span>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'network')}
            title={`Trạng thái: ${st?.state ?? 'idle'} · Giao thức: ${out.driver.toUpperCase()}${statusTarget} · Universe ${out.universe}. Bấm để mở Cài đặt hệ thống (tab DMX)`}
            className={`${statusMeta.chip} h-7 cursor-pointer px-2.5 text-[11px]`}
          >
            <span className={`size-1.5 rounded-full ${statusMeta.dot}`} />
            <StatusIcon size={12} aria-hidden />
            <span>{statusMeta.text}</span>
          </button>

          {st?.warning && <span className="kiln-chip warn h-6">{st.warning}</span>}
        </div>

        <div className="flex items-center gap-2">
          <div className="kiln-seg">
            <button
              type="button"
              disabled={past.length === 0}
              onClick={undo}
              title="Hoàn tác (Ctrl+Z)"
              aria-label="Hoàn tác"
              className="flex h-[26px] w-7 cursor-pointer items-center justify-center rounded-full text-fg hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              disabled={future.length === 0}
              onClick={redo}
              title="Làm lại (Ctrl+Y)"
              aria-label="Làm lại"
              className="flex h-[26px] w-7 cursor-pointer items-center justify-center rounded-full text-fg hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
            >
              <Redo2 size={14} />
            </button>
          </div>

          <IconButton
            icon={locked ? Lock : Unlock}
            label={locked ? `Mở khoá an toàn (gửi CH4 = ${project.settings.lockValue})` : 'Khoá an toàn (CH4 = 0)'}
            variant={locked ? 'ghost' : 'brand'}
            onClick={() => void sendCommand({ type: 'lock', locked: !locked })}
          >
            <span>{locked ? 'Đang khoá' : 'Đã mở khoá'}</span>
          </IconButton>

          <IconButton
            icon={OctagonX}
            label="Dừng khẩn cấp (E-Stop): khoá CH4=0 và dừng toàn bộ"
            variant="danger"
            onClick={() => void sendCommand({ type: 'estop' })}
          >
            <span className="font-bold">Stop</span>
          </IconButton>

          <IconButton
            icon={Settings}
            iconOnly
            label="Cài đặt hệ thống"
            onClick={() => setSettingsOpen(true, 'network')}
          />
        </div>
      </header>

      {ready ? (
        <main
          style={{
            gridTemplateColumns: `${leftCollapsed ? '48px 0px' : `${leftWidth}px 8px`} minmax(0, 1fr) ${
              rightCollapsed ? '0px 44px' : `8px ${rightWidth}px`
            }`,
          }}
          className="grid min-h-0 min-w-0 flex-1"
        >
          {leftCollapsed ? (
            <CollapsedTreeRail onExpand={() => setLeftCollapsed(false)} />
          ) : (
            <Panel
              title="Layers"
              collapsed={false}
              collapseSide="left"
              onToggleCollapse={() => setLeftCollapsed(true)}
            >
              <GauzeTree />
            </Panel>
          )}

          {/* Thanh kéo chiều rộng cột trái */}
          <div
            role="separator"
            aria-orientation="vertical"
            title="Kéo để chỉnh chiều rộng Layers"
            onPointerDown={(e) => !leftCollapsed && startResize('left', e)}
            className={`group flex items-center justify-center ${
              leftCollapsed ? 'pointer-events-none opacity-0' : 'cursor-col-resize'
            }`}
          >
            <span className="h-10 w-1 rounded-full bg-white/10 transition group-hover:h-16 group-hover:bg-brand" />
          </div>

          <div
            style={{
              gridTemplateRows: `minmax(0, 1fr) 8px ${
                activeTab === 'timeline' ? Math.max(bottomHeight, 305) : bottomHeight
              }px`,
            }}
            className="grid min-h-0 min-w-0"
          >
            <Panel title="Mô phỏng 3D">
              <Stage3D />
            </Panel>

            {/* Thanh kéo chiều cao giữa 3D và Điều khiển */}
            <div
              role="separator"
              aria-orientation="horizontal"
              title="Kéo để chỉnh chiều cao Mô phỏng 3D & Điều khiển"
              onPointerDown={(e) => startResize('bottom', e)}
              className="group flex cursor-row-resize items-center justify-center"
            >
              <span className="h-1 w-14 rounded-full bg-white/10 transition group-hover:w-24 group-hover:bg-brand" />
            </div>

            <Panel>
              <ControlDeck />
            </Panel>
          </div>

          {/* Thanh kéo chiều rộng cột phải */}
          <div
            role="separator"
            aria-orientation="vertical"
            title="Kéo để chỉnh chiều rộng Thuộc tính"
            onPointerDown={(e) => !rightCollapsed && startResize('right', e)}
            className={`group flex items-center justify-center ${
              rightCollapsed ? 'pointer-events-none opacity-0' : 'cursor-col-resize'
            }`}
          >
            <span className="h-10 w-1 rounded-full bg-white/10 transition group-hover:h-16 group-hover:bg-brand" />
          </div>

          <Panel
            title="Thuộc tính"
            collapsed={rightCollapsed}
            collapseSide="right"
            onToggleCollapse={() => setRightCollapsed((v) => !v)}
          >
            <PropertiesPanel />
          </Panel>
        </main>
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted">Đang tải dự án...</div>
      )}

      {/* Status bar phẳng theo Kiln */}
      <footer className="flex h-6 shrink-0 items-center justify-between px-2 text-[11px] text-muted">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${st?.state === 'online' ? 'bg-ok' : 'bg-warn'}`} />
            {activeDriverName} ·{' '}
            {['enttec-pro', 'enttec-mk2', 'serial'].includes(out.driver)
              ? out.serialPort || 'Chưa chọn cổng COM/USB'
              : out.driver === 'sacn'
                ? `Uni ${out.sacnUniverse ?? out.universe + 1} · ${out.sacnMulticast !== false ? 'Multicast' : out.ip}`
                : `Net ${out.net} · Sub ${out.subnet} · Uni ${out.universe}`}
          </span>
          <span>·</span>
          <span>Ctrl+Z / Ctrl+Y Hoàn tác · Ctrl+C / Ctrl+V / Delete</span>
        </div>
        <span>
          v{info?.version ?? '1.0.5'} · {info?.runtime ?? 'web'}
        </span>
      </footer>

      {toast && (
        <div
          role="status"
          aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
          className="fixed top-16 right-5 z-50 flex w-[340px] max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-[18px] bg-[#16100C]/95 px-3.5 py-2.5 shadow-[0_14px_34px_rgba(0,0,0,0.6),inset_0_0_0_1px_rgba(255,206,160,0.14)] backdrop-blur-md"
        >
          <span
            aria-hidden="true"
            className={`flex size-9 shrink-0 items-center justify-center rounded-full shadow-sm ${
              toast.kind === 'error'
                ? 'bg-gradient-to-br from-[#FF9B8E] via-[#FF7D6E] to-[#C83E30] text-[#1C0E04]'
                : toast.kind === 'warn'
                  ? 'bg-gradient-to-br from-[#FFE0A6] via-[#FFCB72] to-[#E08E26] text-[#1C0E04]'
                  : toast.kind === 'success'
                    ? 'bg-gradient-to-br from-[#A6F2C7] via-[#7FDDA8] to-[#3AA36C] text-[#092114]'
                    : 'bg-gradient-to-br from-[#FFC590] via-[#FF9442] to-[#E56A14] text-[#1C0E04]'
            }`}
          >
            {(() => {
              switch (toast.icon) {
                case 'estop':
                  return <OctagonX size={17} strokeWidth={2.3} />
                case 'error':
                  return <ShieldAlert size={17} strokeWidth={2.2} />
                case 'warn':
                  return <AlertTriangle size={17} strokeWidth={2.2} />
                case 'disconnected':
                  return <WifiOff size={16} strokeWidth={2.2} />
                case 'connected':
                  return <Wifi size={16} strokeWidth={2.2} />
                case 'running':
                  return <Play size={16} strokeWidth={2.3} />
                case 'stopped':
                  return <Square size={15} strokeWidth={2.3} />
                case 'save':
                  return <Save size={16} strokeWidth={2.2} />
                case 'success':
                  return <CheckCircle2 size={17} strokeWidth={2.2} />
                default:
                  return <Bell size={16} strokeWidth={2.2} />
              }
            })()}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12.5px] leading-snug font-semibold text-fg">{toast.title}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] font-medium tracking-wider text-muted">NOW</span>
                <button
                  type="button"
                  onClick={dismissToast}
                  aria-label="Đóng thông báo"
                  className="cursor-pointer rounded-full p-0.5 text-muted hover:bg-white/10 hover:text-fg"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-[#C2B3A4]">{toast.text}</p>
          </div>
        </div>
      )}

      <SettingsModal />
    </div>
  )
}
