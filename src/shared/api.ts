import type { Command, CommandResult, CoreConfig, Project, Snapshot } from './types'

export interface AppInfo {
  version: string
  platform: string
  runtime: 'electron' | 'web'
}

export interface SnapshotDto extends Omit<Snapshot, 'frame'> {
  frame: number[]
}

export interface GauzeBridge {
  getAppInfo(): Promise<AppInfo>
  loadProject(): Promise<Project>
  saveProject(project: Project): Promise<void>
  exportProject(project: Project): Promise<boolean>
  importProject(): Promise<Project | null>
  configure(cfg: CoreConfig): Promise<void>
  command(cmd: Command): Promise<CommandResult>
  pollNow(): Promise<void>
  onSnapshot(cb: (snap: SnapshotDto) => void): () => void
}
