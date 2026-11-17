import { create } from 'zustand'
import { autoAssign, nextFree, orderedModules, validateAddress } from '@shared/addressing'
import type { AppInfo, SnapshotDto } from '@shared/api'
import { DEFAULT_SPEED, H2_MAX_SPEED_CMS } from '@shared/dmx'
import { createBlankProject, createDefaultProject } from '@shared/preset'
import type {
  Command,
  CommandResult,
  CueButton,
  Layer,
  LtcSettings,
  ModuleCfg,
  OutputSettings,
  Project,
  TimelineKey,
} from '@shared/types'
import { getBridge } from '../services/bridge'

export type ControlTab = 'buttons' | 'manual' | 'timeline'

export interface ToastMsg {
  id: number
  text: string
  kind: 'info' | 'warn' | 'error'
}

interface AppState {
  ready: boolean
  info: AppInfo | null
  project: Project
  projectFilePath: string | null
  dirty: boolean
  collapsedLayers: Record<string, boolean>
  selectedIds: string[]
  snapshot: SnapshotDto | null
  activeTab: ControlTab
  settingsOpen: boolean
  toast: ToastMsg | null

  init: () => Promise<void>
  notify: (text: string, kind?: ToastMsg['kind']) => void
  setActiveTab: (tab: ControlTab) => void
  setSettingsOpen: (open: boolean) => void

  toggleLayerCollapse: (layerId: string) => void
  addLayer: (name: string) => string | null
  renameLayer: (layerId: string, name: string) => void
  removeLayer: (layerId: string) => void

  selectModule: (id: string, opts?: { multi?: boolean; range?: boolean }) => void
  selectLayer: (layerId: string) => void
  selectAll: () => void

  addModule: (layerId: string, opts: { name: string; length: number; width: number; startAddress?: number }) => string | null
  removeModule: (id: string) => void
  duplicateModule: (id: string) => void
  moveModule: (id: string, dir: -1 | 1) => void
  updateModule: (id: string, patch: Partial<ModuleCfg>) => string | null

  setAddressMode: (mode: 'auto' | 'manual') => void
  reAutoAssign: () => void
  updateOutputSettings: (patch: Partial<OutputSettings>) => void
  updateLtcSettings: (patch: Partial<LtcSettings>) => void
  updateTimelineSettings: (patch: Partial<Project['settings']['timeline']>) => void
  setLockValue: (v: number) => void

  saveButton: (btn: CueButton) => void
  deleteButton: (id: string) => void

  addKey: (key: TimelineKey) => void
  updateKey: (id: string, patch: Partial<TimelineKey>) => void
  deleteKey: (id: string) => void

  sendCommand: (cmd: Command) => Promise<CommandResult>
  pollNow: () => void

  newProject: () => Promise<void>
  openProject: () => Promise<void>
  saveCurrentProject: () => Promise<void>
  saveAsProject: () => Promise<void>
  exportProject: () => Promise<void>
  resetPreset: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let unsubSnap: (() => void) | null = null

function persistAndSync(project: Project): void {
  const b = getBridge()
  void b.configure({
    modules: project.modules,
    output: project.settings.output,
    lockValue: project.settings.lockValue,
  })
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void b.saveProject(project)
  }, 250)
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  project: createDefaultProject(),
  projectFilePath: null,
  dirty: false,
  collapsedLayers: {},
  selectedIds: ['m-front-1'],
  snapshot: null,
  activeTab: 'manual',
  settingsOpen: false,
  toast: null,

  notify(text, kind = 'info') {
    const id = Date.now()
    set({ toast: { id, text, kind } })
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null })
    }, 3500)
  },

  async init() {
    const b = getBridge()
    if (unsubSnap) unsubSnap()
    unsubSnap = b.onSnapshot((snapshot) => set({ snapshot }))
    const [info, loaded] = await Promise.all([b.getAppInfo(), b.loadProject()])
    await b.configure({
      modules: loaded.project.modules,
      output: loaded.project.settings.output,
      lockValue: loaded.project.settings.lockValue,
    })
    set({
      ready: true,
      info,
      project: loaded.project,
      projectFilePath: loaded.filePath,
      dirty: false,
      selectedIds: loaded.project.modules[0] ? [loaded.project.modules[0].id] : [],
    })
  },

  setActiveTab: (activeTab) => set({ activeTab }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  toggleLayerCollapse(layerId) {
    const cur = get().collapsedLayers
    set({ collapsedLayers: { ...cur, [layerId]: !cur[layerId] } })
  },

  addLayer(name) {
    const trimmed = name.trim()
    if (!trimmed) return 'Nhập tên layer mới'
    const { project, collapsedLayers } = get()
    const layer: Layer = {
      id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name: trimmed,
    }
    const next = { ...project, layers: [...project.layers, layer] }
    set({ project: next, dirty: true, collapsedLayers: { ...collapsedLayers, [layer.id]: false } })
    persistAndSync(next)
    return null
  },

  renameLayer(layerId, name) {
    const trimmed = name.trim()
    if (!trimmed) return
    const { project } = get()
    const next = {
      ...project,
      layers: project.layers.map((l) => (l.id === layerId ? { ...l, name: trimmed } : l)),
    }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  removeLayer(layerId) {
    const { project, selectedIds } = get()
    if (project.layers.length <= 1) {
      get().notify('Cần giữ lại ít nhất 1 layer', 'warn')
      return
    }
    const modsInLayer = project.modules.filter((m) => m.layerId === layerId)
    const remainingMods = project.modules.filter((m) => m.layerId !== layerId)
    if (modsInLayer.length > 0 && remainingMods.length === 0) {
      get().notify('Không thể xoá layer duy nhất đang chứa module', 'warn')
      return
    }
    const layers = project.layers.filter((l) => l.id !== layerId)
    const modules = project.settings.addressMode === 'auto' ? autoAssign(layers, remainingMods) : remainingMods
    const next = { ...project, layers, modules }
    const nextSel = selectedIds.filter((id) => modules.some((m) => m.id === id))
    set({ project: next, dirty: true, selectedIds: nextSel.length ? nextSel : [modules[0].id] })
    persistAndSync(next)
  },

  selectModule(id, opts) {
    const { project, selectedIds } = get()
    if (opts?.range && selectedIds.length > 0) {
      const ordered = orderedModules(project.layers, project.modules).map((m) => m.id)
      const a = ordered.indexOf(selectedIds[selectedIds.length - 1])
      const b = ordered.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        set({ selectedIds: ordered.slice(lo, hi + 1) })
        return
      }
    }
    if (opts?.multi) {
      const exists = selectedIds.includes(id)
      const next = exists ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
      set({ selectedIds: next.length ? next : [id] })
      return
    }
    set({ selectedIds: [id] })
  },

  selectLayer(layerId) {
    const ids = get().project.modules.filter((m) => m.layerId === layerId).map((m) => m.id)
    if (ids.length) set({ selectedIds: ids })
  },

  selectAll() {
    set({ selectedIds: get().project.modules.map((m) => m.id) })
  },

  addModule(layerId, opts) {
    const { project, collapsedLayers } = get()
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const addr = opts.startAddress ?? nextFree(project.modules)
    if (addr === null) return 'Hết kênh trống trong Universe 0 (tối đa 512 kênh)'
    if (project.settings.addressMode === 'manual') {
      const err = validateAddress(project.modules, id, addr)
      if (err) return err
    }
    const mod: ModuleCfg = {
      id,
      name: opts.name.trim() || `Màn ${project.modules.length + 1}`,
      layerId,
      length: Math.max(0.2, opts.length),
      width: Math.max(0.2, opts.width),
      minHeight: 0,
      maxHeight: Math.max(0.2, opts.length),
      startAddress: addr,
      maxSpeedCms: H2_MAX_SPEED_CMS,
      defaultSpeed: DEFAULT_SPEED,
    }
    let modules = [...project.modules, mod]
    if (project.settings.addressMode === 'auto') modules = autoAssign(project.layers, modules)
    const next = { ...project, modules }
    set({
      project: next,
      dirty: true,
      selectedIds: [id],
      collapsedLayers: { ...collapsedLayers, [layerId]: false },
    })
    persistAndSync(next)
    return null
  },

  removeModule(id) {
    const { project, selectedIds } = get()
    if (project.modules.length <= 1) {
      get().notify('Cần giữ lại ít nhất 1 module màn', 'warn')
      return
    }
    let modules = project.modules.filter((m) => m.id !== id)
    if (project.settings.addressMode === 'auto') modules = autoAssign(project.layers, modules)
    const next = { ...project, modules }
    const nextSel = selectedIds.filter((x) => x !== id)
    set({ project: next, dirty: true, selectedIds: nextSel.length ? nextSel : [modules[0].id] })
    persistAndSync(next)
  },

  duplicateModule(id) {
    const { project } = get()
    const src = project.modules.find((m) => m.id === id)
    if (!src) return
    const free = nextFree(project.modules)
    if (free === null) {
      get().notify('Không đủ kênh trống trong Universe 0', 'error')
      return
    }
    const newId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const copy: ModuleCfg = { ...src, id: newId, name: `${src.name} (bản sao)`, startAddress: free }
    let modules = [...project.modules, copy]
    if (project.settings.addressMode === 'auto') modules = autoAssign(project.layers, modules)
    const next = { ...project, modules }
    set({ project: next, dirty: true, selectedIds: [newId] })
    persistAndSync(next)
  },

  moveModule(id, dir) {
    const { project } = get()
    const list = [...project.modules]
    const idx = list.findIndex((m) => m.id === id)
    if (idx < 0) return
    const layerId = list[idx].layerId
    const sameLayer = list.map((m, i) => (m.layerId === layerId ? i : -1)).filter((i) => i >= 0)
    const posInLayer = sameLayer.indexOf(idx)
    const targetPos = posInLayer + dir
    if (targetPos < 0 || targetPos >= sameLayer.length) return
    const swapIdx = sameLayer[targetPos]
    ;[list[idx], list[swapIdx]] = [list[swapIdx], list[idx]]
    const modules = project.settings.addressMode === 'auto' ? autoAssign(project.layers, list) : list
    const next = { ...project, modules }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  updateModule(id, patch) {
    const { project } = get()
    if (patch.startAddress !== undefined) {
      const err = validateAddress(project.modules, id, patch.startAddress)
      if (err) return err
    }
    let modules = project.modules.map((m) => {
      if (m.id !== id) return m
      const merged = { ...m, ...patch }
      merged.length = Math.max(0.2, merged.length)
      merged.width = Math.max(0.2, merged.width)
      merged.maxHeight = Math.min(merged.length, Math.max(0, merged.maxHeight))
      merged.minHeight = Math.min(merged.maxHeight, Math.max(0, merged.minHeight))
      merged.maxSpeedCms = Math.max(10, merged.maxSpeedCms)
      merged.defaultSpeed = Math.min(255, Math.max(1, Math.round(merged.defaultSpeed)))
      return merged
    })
    if (patch.layerId && project.settings.addressMode === 'auto') {
      modules = autoAssign(project.layers, modules)
    }
    const next = { ...project, modules }
    set({ project: next, dirty: true })
    persistAndSync(next)
    return null
  },

  setAddressMode(addressMode) {
    const { project } = get()
    const modules = addressMode === 'auto' ? autoAssign(project.layers, project.modules) : project.modules
    const next = { ...project, modules, settings: { ...project.settings, addressMode } }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  reAutoAssign() {
    const { project } = get()
    const modules = autoAssign(project.layers, project.modules)
    const next = { ...project, modules, settings: { ...project.settings, addressMode: 'auto' as const } }
    set({ project: next, dirty: true })
    persistAndSync(next)
    get().notify('Đã tự động gán lại địa chỉ liên tiếp từ kênh 1', 'info')
  },

  updateOutputSettings(patch) {
    const { project } = get()
    const next: Project = {
      ...project,
      settings: { ...project.settings, output: { ...project.settings.output, ...patch } },
    }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  updateLtcSettings(patch) {
    const { project } = get()
    const next: Project = {
      ...project,
      settings: { ...project.settings, ltc: { ...project.settings.ltc, ...patch } },
    }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  updateTimelineSettings(patch) {
    const { project } = get()
    const next: Project = {
      ...project,
      settings: { ...project.settings, timeline: { ...project.settings.timeline, ...patch } },
    }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  setLockValue(lockValue) {
    const { project } = get()
    const next = { ...project, settings: { ...project.settings, lockValue } }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  saveButton(btn) {
    const { project } = get()
    const exists = project.buttons.some((b) => b.id === btn.id)
    const buttons = exists ? project.buttons.map((b) => (b.id === btn.id ? btn : b)) : [...project.buttons, btn]
    const next = { ...project, buttons }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  deleteButton(id) {
    const { project } = get()
    const next = { ...project, buttons: project.buttons.filter((b) => b.id !== id) }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  addKey(key) {
    const { project } = get()
    const keys = [...project.keys, key].sort((a, b) => a.time - b.time)
    const next = { ...project, keys }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  updateKey(id, patch) {
    const { project } = get()
    const keys = project.keys.map((k) => (k.id === id ? { ...k, ...patch } : k)).sort((a, b) => a.time - b.time)
    const next = { ...project, keys }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  deleteKey(id) {
    const { project } = get()
    const next = { ...project, keys: project.keys.filter((k) => k.id !== id) }
    set({ project: next, dirty: true })
    persistAndSync(next)
  },

  async sendCommand(cmd) {
    const res = await getBridge().command(cmd)
    if (!res.ok && res.message) get().notify(res.message, 'error')
    else if (res.warnings?.length) get().notify(res.warnings[0], 'warn')
    return res
  },

  pollNow() {
    void getBridge().pollNow()
  },

  async newProject() {
    const blank = createBlankProject(get().project.settings)
    await getBridge().clearCurrentFile()
    set({
      project: blank,
      projectFilePath: null,
      dirty: true,
      collapsedLayers: {},
      selectedIds: blank.modules[0] ? [blank.modules[0].id] : [],
    })
    persistAndSync(blank)
    get().notify('Đã tạo dự án mới', 'info')
  },

  async openProject() {
    try {
      const loaded = await getBridge().openProjectFile()
      if (!loaded) return
      set({
        project: loaded.project,
        projectFilePath: loaded.filePath,
        dirty: false,
        collapsedLayers: {},
        selectedIds: loaded.project.modules[0] ? [loaded.project.modules[0].id] : [],
      })
      persistAndSync(loaded.project)
      get().notify('Đã mở dự án', 'info')
    } catch (err) {
      get().notify(`Không mở được file: ${(err as Error).message}`, 'error')
    }
  },

  async saveCurrentProject() {
    const res = await getBridge().saveProjectFile(get().project)
    if (res.saved) {
      set({ projectFilePath: res.filePath, dirty: false })
      get().notify('Đã lưu dự án', 'info')
    }
  },

  async saveAsProject() {
    const res = await getBridge().saveProjectAs(get().project)
    if (res.saved) {
      set({ projectFilePath: res.filePath, dirty: false })
      get().notify('Đã lưu dự án sang file mới', 'info')
    }
  },

  async exportProject() {
    const ok = await getBridge().exportProject(get().project)
    if (ok) get().notify('Đã xuất file dự án', 'info')
  },

  resetPreset() {
    const def = createDefaultProject()
    void getBridge().clearCurrentFile()
    set({
      project: def,
      projectFilePath: null,
      dirty: false,
      collapsedLayers: {},
      selectedIds: def.modules[0] ? [def.modules[0].id] : [],
    })
    persistAndSync(def)
    get().notify('Đã khôi phục preset mặc định (12×1m + 1×3m)', 'info')
  },
}))
