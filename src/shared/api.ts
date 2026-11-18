import type { Command, CommandResult, CoreConfig, Project, Snapshot } from './types'

export interface AppInfo {
  version: string
  platform: string
  runtime: 'electron' | 'web'
}

export interface SnapshotDto extends Omit<Snapshot, 'frame'> {
  frame: number[]
}

export interface ProjectFileResult {
  project: Project
  filePath: string | null
}

export interface SaveFileResult {
  saved: boolean
  filePath: string | null
}

export interface GauzeBridge {
  getAppInfo(): Promise<AppInfo>
  loadProject(): Promise<ProjectFileResult>
  saveProject(project: Project): Promise<void>
  clearCurrentFile(): Promise<void>
  openProjectFile(): Promise<ProjectFileResult | null>
  saveProjectFile(project: Project): Promise<SaveFileResult>
  saveProjectAs(project: Project): Promise<SaveFileResult>
  exportProject(project: Project): Promise<boolean>
  configure(cfg: CoreConfig): Promise<void>
  command(cmd: Command): Promise<CommandResult>
  pollNow(): Promise<void>
  listSerialPorts(): Promise<string[]>
  onSnapshot(cb: (snap: SnapshotDto) => void): () => void
}

export type StartupProjectChoice = 'recent' | 'new' | 'open'

export interface StartupBridge {
  hasRecentProject(): Promise<boolean>
  chooseProject(choice: StartupProjectChoice): Promise<boolean>
}
