import { useEffect, useState } from 'react'
import { OctagonX, Settings, Wifi } from 'lucide-react'
import { IconButton } from './components/IconButton'
import { DEFAULT_TARGET_IP } from '@shared/dmx'
import type { AppInfo } from '@shared/api'

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
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    const read = window.gauze?.getAppInfo() ?? Promise.resolve<AppInfo>({ version: '0.1.0', platform: 'web', runtime: 'web' })
    read.then(setInfo)
  }, [])

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex items-center justify-between rounded-ui border border-line bg-panel px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-ui bg-brand font-bold text-brand-fg">G</span>
          <h1 className="text-base font-semibold">DMX Gauze</h1>
          <span
            title={`Đích gửi Art-Net: ${DEFAULT_TARGET_IP}`}
            className="inline-flex items-center gap-2 rounded-full bg-panel-2 px-3 py-1 text-xs text-info"
          >
            <Wifi size={14} aria-hidden />
            Chưa kết nối · {DEFAULT_TARGET_IP}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <IconButton icon={OctagonX} label="Dừng khẩn cấp" variant="danger" />
          <IconButton icon={Settings} label="Cài đặt" />
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[260px_1fr_300px] gap-3">
        <Panel title="Cây màn" />
        <div className="grid min-h-0 grid-rows-[1fr_240px] gap-3">
          <Panel title="Mô phỏng 3D" />
          <Panel title="Điều khiển" />
        </div>
        <Panel title="Thuộc tính" />
      </main>

      <footer className="text-right text-xs text-muted">
        v{info?.version} · {info?.runtime}
      </footer>
    </div>
  )
}
