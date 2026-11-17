import { useEffect, useRef, useState } from 'react'
import {
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
  Redo2,
  RotateCcw,
  Save,
  SaveAll,
  Settings,
  Undo2,
  Unlock,
  Wifi,
  WifiOff,
} from 'lucide-react'
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
  title: string
  collapsed?: boolean
  collapseSide?: 'left' | 'right'
  onToggleCollapse?: () => void
  children?: React.ReactNode
}) {
  if (collapsed && onToggleCollapse) {
    const OpenIcon = collapseSide === 'right' ? PanelRightOpen : PanelLeftOpen
    return (
      <section className="kiln-panel flex min-h-0 flex-col items-center py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          title={`Mở rộng ${title}`}
          aria-label={`Mở rộng ${title}`}
          className="cursor-pointer rounded-full p-1.5 text-info hover:bg-white/10"
        >
          <OpenIcon size={16} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={`Mở rộng ${title}`}
          style={{ writingMode: 'vertical-rl' }}
          className="mt-3 flex-1 cursor-pointer text-[11px] font-semibold tracking-wider text-muted hover:text-fg"
        >
          {title}
        </button>
      </section>
    )
  }

  const CloseIcon = collapseSide === 'right' ? PanelRightClose : PanelLeftClose

  return (
    <section className="kiln-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex h-[42px] shrink-0 items-center justify-between px-4">
        <h2 className="text-[13.5px] font-semibold text-fg">{title}</h2>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={`Thu gọn ${title}`}
            aria-label={`Thu gọn ${title}`}
            className="cursor-pointer rounded-full p-1 text-muted hover:bg-white/10 hover:text-fg"
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>
      <div className="min-h-0 min-w-0 flex-1 px-3 pb-3">{children}</div>
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
  const fileLabel = projectFilePath ? projectFilePath.split(/[\\/]/).pop() : 'Chưa lưu'

  const statusMeta = (() => {
    if (!st || st.state === 'idle') return { chip: 'kiln-chip', dot: 'bg-muted', text: 'Đang khởi tạo...', icon: Wifi }
    if (st.state === 'error') {
      return { chip: 'kiln-chip danger', dot: 'bg-danger', text: st.message ?? 'Lỗi mạng', icon: WifiOff }
    }
    if (st.state === 'lost') return { chip: 'kiln-chip danger', dot: 'bg-danger', text: 'Mất kết nối Node', icon: WifiOff }
    if (st.state === 'online') {
      return {
        chip: 'kiln-chip ok',
        dot: 'bg-ok',
        text: `Trực tuyến · ${st.nodes.length} Node · ${st.sendHz}Hz`,
        icon: Wifi,
      }
    }
    return {
      chip: 'kiln-chip warn',
      dot: 'bg-warn',
      text: `Đang gửi (${st.sendHz}Hz) · Chưa thấy Node`,
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
              <span
                style={{ background: 'var(--acc-grad)' }}
                className="grid size-7 place-items-center rounded-[9px] text-sm font-bold text-brand-fg shadow-[inset_0_1px_0_rgba(255,255,255,.45)]"
              >
                G
              </span>
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
                      {out.driver === 'artnet' ? 'Art-Net' : 'Mock'} · U{out.universe}
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
                    setSettingsOpen(true)
                  }}
                  className="mx-2 flex h-9 w-[calc(100%-16px)] cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-[12.5px] text-fg hover:bg-white/8"
                >
                  <Settings size={15} className="text-muted" />
                  <span className="flex-1">Cài đặt hệ thống</span>
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
                  <span>v{info?.version ?? '0.1.0'}</span>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={`Giao thức: ${out.driver.toUpperCase()} · Đích: ${out.ip}:${out.port} · Universe ${out.universe}. Bấm để mở Cài đặt mạng`}
            className={`${statusMeta.chip} h-7 cursor-pointer px-3 text-[11px]`}
          >
            <span className={`size-1.5 rounded-full ${statusMeta.dot}`} />
            <StatusIcon size={13} aria-hidden />
            <span>{statusMeta.text}</span>
            <span className="font-mono opacity-80">· {out.ip}</span>
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
            <span className="font-bold">E-STOP</span>
          </IconButton>

          <IconButton
            icon={Settings}
            iconOnly
            label="Cài đặt mạng DMX & Hệ thống"
            onClick={() => setSettingsOpen(true)}
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
              title="Cây màn"
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
            title="Kéo để chỉnh chiều rộng Cây màn"
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

            <Panel title="Điều khiển">
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
            {out.driver === 'artnet' ? 'Art-Net UDP' : 'Mock'} · Net {out.net} · Sub {out.subnet} · Uni {out.universe}
          </span>
          <span>·</span>
          <span>Ctrl+Z / Ctrl+Y Hoàn tác · Ctrl+C / Ctrl+V / Delete</span>
        </div>
        <span>
          v{info?.version ?? '0.1.0'} · {info?.runtime ?? 'web'}
        </span>
      </footer>

      {toast && (
        <div
          role="status"
          className="kiln-panel fixed right-5 bottom-8 z-50 flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium shadow-2xl"
        >
          <span
            className={`size-2 rounded-full ${
              toast.kind === 'error' ? 'bg-danger' : toast.kind === 'warn' ? 'bg-warn' : 'bg-info'
            }`}
          />
          <span
            className={
              toast.kind === 'error' ? 'text-danger' : toast.kind === 'warn' ? 'text-warn' : 'text-fg'
            }
          >
            {toast.text}
          </span>
        </div>
      )}

      <SettingsModal />
    </div>
  )
}
