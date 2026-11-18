import { useEffect, useState } from 'react'
import { ArrowRight, FolderClock, FolderOpen, Plus } from 'lucide-react'
import type { StartupBridge, StartupProjectChoice } from '@shared/api'
import logo from '../../../build/icon.png'

const projectActions = [
  { id: 'recent', label: 'Mở project gần đây', subtitle: 'Bản tự động lưu gần nhất', Icon: FolderClock },
  { id: 'new', label: 'Tạo project mới', subtitle: 'Bắt đầu với một màn', Icon: Plus },
  { id: 'open', label: 'Mở file project', subtitle: 'Chọn file JSON trên máy', Icon: FolderOpen },
] as const

export function StartupScreen({ bridge }: { bridge: StartupBridge }) {
  const [hasRecent, setHasRecent] = useState<boolean | null>(null)
  const [pending, setPending] = useState<StartupProjectChoice | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const startedAt = performance.now()
    void bridge.hasRecentProject().catch(() => false).then((available) => {
      if (!active) return
      timer = setTimeout(() => setHasRecent(available), Math.max(0, 450 - (performance.now() - startedAt)))
    })
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

  if (hasRecent === null) {
    return (
      <main className="grid h-full place-content-center justify-items-center gap-3 bg-panel">
        <img src={logo} alt="" className="size-[76px]" />
        <h1 className="text-[26px] font-semibold tracking-tight">DMX Gauze</h1>
        <p role="status" className="flex items-center gap-2 text-xs text-muted">
          <span aria-hidden="true" className="size-3 animate-spin rounded-full border-2 border-brand/20 border-t-brand motion-reduce:animate-none" />
          Đang khởi động…
        </p>
      </main>
    )
  }

  return (
    <main className="h-full overflow-y-auto bg-panel px-6 py-5">
      <header className="mb-4 flex items-center gap-3 border-b border-line pb-4">
        <img src={logo} alt="" className="size-12 shrink-0" />
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">DMX Gauze</h1>
          <p className="text-xs text-muted">Chọn project để bắt đầu</p>
        </div>
      </header>

      <div className="grid gap-2">
        {projectActions.map(({ id, label, subtitle, Icon }) => (
          <button
            key={id}
            type="button"
            disabled={pending !== null || (id === 'recent' && !hasRecent)}
            onClick={() => void choose(id)}
            className="group flex w-full items-center gap-3 rounded-xl border border-line bg-panel-2 px-3.5 py-2.5 text-left transition enabled:cursor-pointer enabled:hover:border-brand/55 enabled:hover:bg-brand/10 disabled:opacity-45 motion-reduce:transition-none"
          >
            <Icon size={18} aria-hidden="true" className="shrink-0 text-brand" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">{label}</span>
              <span className="block text-[11px] text-muted">
                {id === 'recent' && !hasRecent ? 'Chưa có bản tự động lưu' : subtitle}
              </span>
            </span>
            <ArrowRight size={15} aria-hidden="true" className="shrink-0 text-muted group-enabled:group-hover:text-brand" />
          </button>
        ))}
      </div>

      {pending && <p role="status" className="mt-3 text-xs text-muted">Đang chuẩn bị project…</p>}
      {error && <p role="alert" className="mt-3 break-words text-xs text-danger">{error}</p>}
    </main>
  )
}
