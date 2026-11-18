import { useEffect, useState } from 'react'
import { ArrowRight, FolderClock, FolderOpen, Minus, Plus, Square, X } from 'lucide-react'
import type { StartupBridge, StartupProjectChoice } from '@shared/api'
import logo from '../../../build/icon.png'
import './startup.css'

const projectActions = [
  { id: 'recent', label: 'Mở project gần đây', subtitle: 'Bản tự động lưu gần nhất', Icon: FolderClock },
  { id: 'new', label: 'Tạo project mới', subtitle: 'Bắt đầu với một màn', Icon: Plus },
  { id: 'open', label: 'Mở file project', subtitle: 'Chọn file JSON trên máy', Icon: FolderOpen },
] as const

const windowControls = [
  { action: 'minimize', label: 'Thu nhỏ', Icon: Minus },
  { action: 'toggle-maximize', label: 'Phóng to hoặc khôi phục', Icon: Square },
  { action: 'close', label: 'Đóng', Icon: X },
] as const

export function StartupScreen({ bridge }: { bridge: StartupBridge }) {
  const [hasRecent, setHasRecent] = useState<boolean | null>(null)
  const [logoSettled, setLogoSettled] = useState(false)
  const [splashElapsed, setSplashElapsed] = useState(false)
  const [pending, setPending] = useState<StartupProjectChoice | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void bridge.hasRecentProject().catch(() => false).then((available) => {
      if (active) setHasRecent(available)
    })
    // Let fast launches show the splash briefly. This delay does not advance progress.
    const timer = setTimeout(() => setSplashElapsed(true), 450)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [bridge])

  const choose = async (choice: StartupProjectChoice) => {
    setPending(choice)
    setError('')
    try {
      if (await bridge.chooseProject(choice)) return
    } catch (err) {
      const action = choice === 'new' ? 'Không tạo được project' : 'Không mở được project'
      const detail = (err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')
      setError(`${action}. ${detail}`)
    }
    setPending(null)
  }

  // The renderer's logo and the main process's autosave check are independent work.
  const progress = (logoSettled ? 50 : 0) + (hasRecent === null ? 0 : 50)
  if (progress < 100 || !splashElapsed) {
    return (
      <main className="startup startup-splash">
        <div className="startup-drag" aria-hidden="true" />
        <section className="startup-splash-content" aria-labelledby="splash-title">
          <img
            className="startup-splash-logo"
            src={logo}
            alt=""
            onLoad={() => setLogoSettled(true)}
            onError={() => setLogoSettled(true)}
          />
          <h1 id="splash-title">DMX Gauze</h1>
          <p className="startup-subtitle">Chọn project để bắt đầu</p>
          <p className="startup-loading" id="startup-loading">Đang khởi động...</p>
          <div className="startup-progress">
            <progress aria-labelledby="startup-loading" max={100} value={progress} />
            <span aria-hidden="true">{progress}%</span>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="startup startup-picker">
      <div className="startup-titlebar">
        <div className="startup-drag" aria-hidden="true" />
        <div className="startup-window-controls">
          {windowControls.map(({ action, label, Icon }) => (
            <button
              key={action}
              type="button"
              aria-label={label}
              title={label}
              data-action={action}
              onClick={() => void bridge.windowAction(action)}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <div className="startup-projects">
        <header className="startup-header">
          <img src={logo} alt="" />
          <div>
            <h1>DMX Gauze</h1>
            <p className="startup-subtitle">Chọn project để bắt đầu</p>
          </div>
        </header>

        <div className="startup-actions" aria-busy={pending !== null}>
          {projectActions.map(({ id, label, subtitle, Icon }) => (
            <button
              key={id}
              type="button"
              disabled={pending !== null || (id === 'recent' && !hasRecent)}
              onClick={() => void choose(id)}
              className="startup-card"
            >
              <Icon className="startup-card-icon" size={25} strokeWidth={1.9} aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <span className="startup-subtitle">
                  {id === 'recent' && !hasRecent ? 'Chưa có bản tự động lưu' : subtitle}
                </span>
              </span>
              <ArrowRight className="startup-card-arrow" size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
        </div>

        {pending && <p role="status" className="startup-message startup-subtitle">Đang chuẩn bị project…</p>}
        {error && <p role="alert" className="startup-message text-danger">{error}</p>}
      </div>
    </main>
  )
}
