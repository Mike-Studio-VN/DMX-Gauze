import { create } from 'zustand'
import { autoAssign, layerLoopAddress, nextFree, orderedModules, validateAddress } from '@shared/addressing'
import type { AppInfo, SnapshotDto } from '@shared/api'
import { clamp } from '@shared/convert'
import { DEFAULT_SPEED, H2_MAX_SPEED_CMS } from '@shared/dmx'
import { resolveClipStartNoOverlap, syncModuleClipsContinuity } from '@shared/timeline'
import {
  createBlankProject,
  createDefaultProject,
  defaultLayerTransform,
  defaultModuleTransform,
} from '@shared/preset'
import type {
  Command,
  CommandResult,
  CueButton,
  Layer,
  LtcSettings,
  ModuleCfg,
  OutputSettings,
  Project,
  TimelineClip,
  TimelineKey,
} from '@shared/types'
import { getBridge } from '../services/bridge'

export type ControlTab = 'buttons' | 'manual' | 'timeline'
export type FocusScope = 'tree' | 'buttons' | 'timeline'
export type SettingsTab = 'network' | 'safety' | 'ltc' | 'project'

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
  past: Project[]
  future: Project[]
  collapsedLayers: Record<string, boolean>

  focusScope: FocusScope
  selectedIds: string[]
  selectedLayerId: string | null
  selectedButtonId: string | null
  selectedClipId: string | null
  selectedKeyId: string | null
  selectedTimelineLayerId: string | null

  copiedModules: ModuleCfg[]
  copiedButton: CueButton | null
  copiedClips: TimelineClip[]

  snapshot: SnapshotDto | null
  activeTab: ControlTab
  settingsOpen: boolean
  settingsTab: SettingsTab
  toast: ToastMsg | null

  init: () => Promise<void>
  notify: (text: string, kind?: ToastMsg['kind']) => void
  setActiveTab: (tab: ControlTab) => void
  setFocusScope: (scope: FocusScope) => void
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void

  undo: () => void
  redo: () => void

  toggleLayerCollapse: (layerId: string) => void
  toggleLayerVisibility: (layerId: string) => void
  toggleLayerSync: (layerId: string) => void
  toggleModuleVisibility: (moduleId: string) => void
  setModulesDmxLoop: (ids: string[], enabled: boolean) => void
  addLayer: (name: string, opts?: { id?: string }) => string | null
  updateLayer: (layerId: string, patch: Partial<Layer>, coalesceKey?: string) => void
  renameLayer: (layerId: string, name: string) => void
  removeLayer: (layerId: string) => void

  selectModule: (id: string, opts?: { multi?: boolean; range?: boolean }) => void
  selectLayer: (layerId: string) => void
  selectAll: () => void
  selectButton: (id: string | null) => void
  selectTimelineClip: (clipId: string | null, keyId?: string | null) => void
  selectTimelineKey: (keyId: string | null) => void
  selectTimelineLayer: (layerId: string | null) => void

  addModule: (
    layerId: string,
    opts: { id?: string; name: string; length: number; width: number; startAddress?: number; insertAfterId?: string },
  ) => string | null
  removeModule: (id: string) => void
  removeModules: (ids: string[]) => void
  duplicateModule: (id: string) => void
  moveModule: (id: string, dir: -1 | 1) => void
  reorderModule: (dragId: string, targetLayerId: string, targetIndexInLayer: number) => void
  updateModule: (id: string, patch: Partial<ModuleCfg>, coalesceKey?: string) => string | null

  setAddressMode: (mode: 'auto' | 'manual') => void
  reAutoAssign: () => void
  updateOutputSettings: (patch: Partial<OutputSettings>) => void
  updateLtcSettings: (patch: Partial<LtcSettings>) => void
  updateTimelineSettings: (patch: Partial<Project['settings']['timeline']>) => void
  setLockValue: (v: number) => void

  saveButton: (btn: CueButton) => void
  deleteButton: (id: string) => void

  addClip: (clip: TimelineClip) => void
  updateClip: (
    clipId: string,
    patch: Partial<TimelineClip>,
    coalesceKey?: string,
    syncEdge?: 'start' | 'end',
  ) => void
  deleteClip: (clipId: string) => void
  deleteTimelineLayerClips: (layerId: string) => void
  copySelection: () => void
  pasteSelection: (atTime?: number) => void
  deleteSelection: () => void

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

const MAX_HISTORY = 50
let saveTimer: ReturnType<typeof setTimeout> | null = null
let unsubSnap: (() => void) | null = null
let lastCoalesceKey = ''
let lastCoalesceAt = 0

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

function mirrorLayerClips(
  clips: TimelineClip[],
  modules: ModuleCfg[],
  layerId: string,
  sourceModuleId?: string,
): TimelineClip[] {
  const layerMods = modules.filter((m) => m.layerId === layerId)
  if (layerMods.length <= 1) return clips
  const leadId =
    (sourceModuleId && layerMods.some((m) => m.id === sourceModuleId) ? sourceModuleId : undefined) ??
    layerMods.find((m) => clips.some((c) => c.moduleId === m.id))?.id ??
    layerMods[0].id
  const leadClips = clips.filter((c) => c.moduleId === leadId).sort((a, b) => a.startTime - b.startTime)
  const otherLayerClips = clips.filter((c) => !layerMods.some((m) => m.id === c.moduleId))
  const mirrored: TimelineClip[] = [...leadClips]
  for (const m of layerMods) {
    if (m.id === leadId) continue
    for (const lc of leadClips) {
      mirrored.push({
        ...structuredClone(lc),
        id: `clip-sync-${m.id}-${lc.id}`,
        layerId,
        moduleId: m.id,
        keyframes: lc.keyframes.map((k, kIdx) => ({
          ...k,
          id: `kf-sync-${m.id}-${lc.id}-${kIdx}`,
          height: clamp(k.height, m.minHeight, m.maxHeight),
        })),
      })
    }
  }
  return [...otherLayerClips, ...mirrored].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
}

export const useAppStore = create<AppState>((set, get) => {
  const applyProject = (next: Project, opts?: { coalesceKey?: string; dirty?: boolean; extra?: Partial<AppState> }) => {
    const state = get()
    const now = Date.now()
    const coalesced = Boolean(opts?.coalesceKey && opts.coalesceKey === lastCoalesceKey && now - lastCoalesceAt < 450)
    lastCoalesceKey = opts?.coalesceKey ?? ''
    lastCoalesceAt = now

    const past = coalesced ? state.past : [...state.past.slice(-(MAX_HISTORY - 1)), state.project]
    set({
      project: next,
      past,
      future: [],
      dirty: opts?.dirty ?? true,
      ...opts?.extra,
    })
    persistAndSync(next)
  }

  return {
    ready: false,
    info: null,
    project: createDefaultProject(),
    projectFilePath: null,
    dirty: false,
    past: [],
    future: [],
    collapsedLayers: {},

    focusScope: 'timeline',
    selectedIds: ['m-front-1'],
    selectedLayerId: null,
    selectedButtonId: null,
    selectedClipId: null,
    selectedKeyId: null,
    selectedTimelineLayerId: null,

    copiedModules: [],
    copiedButton: null,
    copiedClips: [],

    snapshot: null,
    activeTab: 'timeline',
    settingsOpen: false,
    settingsTab: 'network',
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
        past: [],
        future: [],
        selectedIds: loaded.project.modules[0] ? [loaded.project.modules[0].id] : [],
      })
    },

    setActiveTab: (activeTab) =>
      set({
        activeTab,
        focusScope: activeTab === 'buttons' ? 'buttons' : activeTab === 'timeline' ? 'timeline' : 'tree',
      }),
    setFocusScope: (focusScope) => set({ focusScope }),
    setSettingsOpen: (settingsOpen, tab) =>
      set((s) => ({
        settingsOpen,
        settingsTab: tab ?? s.settingsTab,
      })),

    undo() {
      const { past, future, project, selectedIds } = get()
      if (past.length === 0) return
      const prev = past[past.length - 1]
      const nextPast = past.slice(0, -1)
      const validIds = selectedIds.filter((id) => prev.modules.some((m) => m.id === id))
      set({
        project: prev,
        past: nextPast,
        future: [project, ...future.slice(0, MAX_HISTORY - 1)],
        dirty: true,
        selectedIds: validIds.length ? validIds : prev.modules[0] ? [prev.modules[0].id] : [],
      })
      persistAndSync(prev)
      get().notify('Đã hoàn tác (Ctrl+Z)', 'info')
    },

    redo() {
      const { past, future, project, selectedIds } = get()
      if (future.length === 0) return
      const next = future[0]
      const nextFuture = future.slice(1)
      const validIds = selectedIds.filter((id) => next.modules.some((m) => m.id === id))
      set({
        project: next,
        past: [...past.slice(-(MAX_HISTORY - 1)), project],
        future: nextFuture,
        dirty: true,
        selectedIds: validIds.length ? validIds : next.modules[0] ? [next.modules[0].id] : [],
      })
      persistAndSync(next)
      get().notify('Đã làm lại (Ctrl+Y)', 'info')
    },

    toggleLayerCollapse(layerId) {
      const cur = get().collapsedLayers
      set({ collapsedLayers: { ...cur, [layerId]: !cur[layerId] } })
    },

    toggleLayerVisibility(layerId) {
      const { project } = get()
      const next = {
        ...project,
        layers: project.layers.map((l) => (l.id === layerId ? { ...l, visible: !(l.visible ?? true) } : l)),
      }
      applyProject(next)
    },

    toggleLayerSync(layerId) {
      const { project } = get()
      const target = project.layers.find((l) => l.id === layerId)
      if (!target) return
      const nextSync = !(target.syncLayer ?? false)
      const layers = project.layers.map((l) => (l.id === layerId ? { ...l, syncLayer: nextSync } : l))
      const clips = nextSync
        ? mirrorLayerClips(project.clips ?? [], project.modules, layerId)
        : (project.clips ?? [])
      applyProject({ ...project, layers, clips })
      get().notify(
        nextSync
          ? `Đã bật Sync Layer "${target.name}" — các module chạy giống hệt nhau`
          : `Đã tắt Sync Layer "${target.name}"`,
        'info',
      )
    },

    toggleModuleVisibility(moduleId) {
      const { project } = get()
      const next = {
        ...project,
        modules: project.modules.map((m) => (m.id === moduleId ? { ...m, visible: !(m.visible ?? true) } : m)),
      }
      applyProject(next)
    },

    addLayer(name, opts) {
      const trimmed = name.trim()
      if (!trimmed) return 'Nhập tên layer mới'
      const { project, collapsedLayers } = get()
      const layer: Layer = {
        id: opts?.id ?? `layer-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        name: trimmed,
        visible: true,
        transform: defaultLayerTransform(project.layers.length),
      }
      const next = { ...project, layers: [...project.layers, layer] }
      applyProject(next, {
        extra: {
          collapsedLayers: { ...collapsedLayers, [layer.id]: false },
          selectedLayerId: layer.id,
          selectedIds: [],
          selectedClipId: null,
          selectedKeyId: null,
          selectedTimelineLayerId: null,
          focusScope: 'tree',
        },
      })
      return null
    },

    updateLayer(layerId, patch, coalesceKey) {
      const { project } = get()
      const next = {
        ...project,
        layers: project.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
      }
      applyProject(next, { coalesceKey })
    },

    renameLayer(layerId, name) {
      const trimmed = name.trim()
      if (!trimmed) return
      const cur = get().project.layers.find((l) => l.id === layerId)
      if (!cur || cur.name === trimmed) return
      get().updateLayer(layerId, { name: trimmed })
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
      const clips = (project.clips ?? []).filter((c) => c.layerId !== layerId && modules.some((m) => m.id === c.moduleId))
      const next = { ...project, layers, modules, clips }
      const nextSel = selectedIds.filter((id) => modules.some((m) => m.id === id))
      applyProject(next, {
        extra: {
          selectedIds: nextSel.length ? nextSel : [modules[0].id],
          selectedLayerId: null,
        },
      })
    },

    selectModule(id, opts) {
      const { project, selectedIds } = get()
      if (opts?.range && selectedIds.length > 0) {
        const ordered = orderedModules(project.layers, project.modules).map((m) => m.id)
        const a = ordered.indexOf(selectedIds[selectedIds.length - 1])
        const b = ordered.indexOf(id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          set({
            selectedIds: ordered.slice(lo, hi + 1),
            selectedLayerId: null,
            selectedClipId: null,
            selectedKeyId: null,
            selectedTimelineLayerId: null,
            focusScope: 'tree',
          })
          return
        }
      }
      if (opts?.multi) {
        const exists = selectedIds.includes(id)
        const next = exists ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
        set({
          selectedIds: next.length ? next : [id],
          selectedLayerId: null,
          selectedClipId: null,
          selectedKeyId: null,
          selectedTimelineLayerId: null,
          focusScope: 'tree',
        })
        return
      }
      set({
        selectedIds: [id],
        selectedLayerId: null,
        selectedClipId: null,
        selectedKeyId: null,
        selectedTimelineLayerId: null,
        focusScope: 'tree',
      })
    },

    selectLayer(layerId) {
      const ids = get().project.modules.filter((m) => m.layerId === layerId).map((m) => m.id)
      set({
        selectedLayerId: layerId,
        selectedIds: ids,
        selectedClipId: null,
        selectedKeyId: null,
        selectedTimelineLayerId: null,
        focusScope: 'tree',
      })
    },

    selectAll() {
      set({
        selectedIds: get().project.modules.map((m) => m.id),
        selectedLayerId: null,
        selectedClipId: null,
        selectedKeyId: null,
        selectedTimelineLayerId: null,
        focusScope: 'tree',
      })
    },

    selectButton: (selectedButtonId) => set({ selectedButtonId, focusScope: 'buttons' }),

    selectTimelineClip(selectedClipId, keyId) {
      const clip = selectedClipId ? (get().project.clips ?? []).find((c) => c.id === selectedClipId) : null
      const preservedKey =
        keyId !== undefined
          ? keyId
          : selectedClipId && get().selectedClipId === selectedClipId
            ? get().selectedKeyId
            : null
      set({
        selectedClipId,
        selectedKeyId: preservedKey,
        selectedTimelineLayerId: null,
        ...(clip ? { selectedLayerId: null, selectedIds: [clip.moduleId] } : {}),
        focusScope: 'timeline',
      })
    },

    selectTimelineKey: (selectedKeyId) => set({ selectedKeyId }),

    selectTimelineLayer(selectedTimelineLayerId) {
      if (!selectedTimelineLayerId) {
        set({ selectedTimelineLayerId: null, selectedClipId: null, selectedKeyId: null, focusScope: 'timeline' })
        return
      }
      const ids = get().project.modules.filter((m) => m.layerId === selectedTimelineLayerId).map((m) => m.id)
      set({
        selectedTimelineLayerId,
        selectedClipId: null,
        selectedKeyId: null,
        selectedLayerId: selectedTimelineLayerId,
        selectedIds: ids,
        focusScope: 'timeline',
      })
    },

    addModule(layerId, opts) {
      const { project, collapsedLayers } = get()
      const id = opts.id ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
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
        visible: true,
        transform: defaultModuleTransform(),
        length: Math.max(0.2, opts.length),
        width: Math.max(0.2, opts.width),
        minHeight: 0,
        maxHeight: Math.max(0.2, opts.length),
        startAddress: addr,
        maxSpeedCms: H2_MAX_SPEED_CMS,
        defaultSpeed: DEFAULT_SPEED,
      }
      const afterIdx = opts.insertAfterId
        ? project.modules.findIndex((m) => m.id === opts.insertAfterId && m.layerId === layerId)
        : -1
      let modules = [...project.modules]
      if (afterIdx >= 0) modules.splice(afterIdx + 1, 0, mod)
      else modules.push(mod)
      if (project.settings.addressMode === 'auto') modules = autoAssign(project.layers, modules)
      const next = { ...project, modules }
      applyProject(next, {
        extra: {
          selectedIds: [id],
          selectedLayerId: null,
          selectedClipId: null,
          selectedKeyId: null,
          selectedTimelineLayerId: null,
          collapsedLayers: { ...collapsedLayers, [layerId]: false },
        },
      })
      return null
    },

    removeModule(id) {
      get().removeModules([id])
    },

    removeModules(ids) {
      const { project, selectedIds } = get()
      const delSet = new Set(ids)
      const remaining = project.modules.filter((m) => !delSet.has(m.id))
      if (remaining.length < 1) {
        get().notify('Cần giữ lại ít nhất 1 module màn', 'warn')
        return
      }
      const modules = project.settings.addressMode === 'auto' ? autoAssign(project.layers, remaining) : remaining
      const clips = (project.clips ?? []).filter((c) => !delSet.has(c.moduleId))
      const next = { ...project, modules, clips }
      const nextSel = selectedIds.filter((x) => !delSet.has(x))
      applyProject(next, {
        extra: {
          selectedIds: nextSel.length ? nextSel : [modules[0].id],
          selectedLayerId: null,
        },
      })
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
      const copy: ModuleCfg = {
        ...structuredClone(src),
        id: newId,
        name: `${src.name} (bản sao)`,
        startAddress: free,
      }
      let modules = [...project.modules, copy]
      if (project.settings.addressMode === 'auto') modules = autoAssign(project.layers, modules)
      const next = { ...project, modules }
      applyProject(next, { extra: { selectedIds: [newId], selectedLayerId: null } })
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
      applyProject({ ...project, modules })
    },

    reorderModule(dragId, targetLayerId, targetIndexInLayer) {
      const { project, collapsedLayers } = get()
      const dragged = project.modules.find((m) => m.id === dragId)
      if (!dragged) return

      const without = project.modules.filter((m) => m.id !== dragId)
      const updatedDragged: ModuleCfg = { ...dragged, layerId: targetLayerId }

      const rebuilt: ModuleCfg[] = []
      for (const layer of project.layers) {
        const layerMods = without.filter((m) => m.layerId === layer.id)
        if (layer.id === targetLayerId) {
          const clampIdx = Math.max(0, Math.min(layerMods.length, targetIndexInLayer))
          layerMods.splice(clampIdx, 0, updatedDragged)
        }
        rebuilt.push(...layerMods)
      }

      const modules = project.settings.addressMode === 'auto' ? autoAssign(project.layers, rebuilt) : rebuilt
      // Cập nhật layerId của các clip gắn với module vừa kéo sang layer mới
      const clips = (project.clips ?? []).map((c) => (c.moduleId === dragId ? { ...c, layerId: targetLayerId } : c))
      applyProject(
        { ...project, modules, clips },
        {
          extra: {
            selectedIds: [dragId],
            selectedLayerId: null,
            collapsedLayers: { ...collapsedLayers, [targetLayerId]: false },
          },
        },
      )
    },

    updateModule(id, patch, coalesceKey) {
      const { project } = get()
      const current = project.modules.find((m) => m.id === id)
      if (!current) return null
      if (patch.startAddress !== undefined) {
        const probeMods =
          patch.dmxLoop !== undefined ? project.modules.map((m) => (m.id === id ? { ...m, dmxLoop: patch.dmxLoop } : m)) : project.modules
        const err = validateAddress(probeMods, id, patch.startAddress)
        if (err) return err
      }
      let modules = project.modules.map((m) => {
        if (m.id !== id) return m
        const merged = { ...m, ...patch }
        if (patch.dmxLoop === true && patch.startAddress === undefined) {
          merged.startAddress = layerLoopAddress(project.modules, merged.layerId, id)
        }
        if (merged.transform) {
          // Cạnh trên module luôn dính vào Layer nên giữ Y cục bộ = 0
          merged.transform = {
            ...merged.transform,
            position: [merged.transform.position[0], 0, merged.transform.position[2]],
          }
        }
        merged.length = Math.max(0.2, merged.length)
        merged.width = Math.max(0.2, merged.width)
        merged.maxHeight = Math.min(merged.length, Math.max(0, merged.maxHeight))
        merged.minHeight = Math.min(merged.maxHeight, Math.max(0, merged.minHeight))
        merged.maxSpeedCms = Math.max(10, merged.maxSpeedCms)
        merged.defaultSpeed = Math.min(255, Math.max(1, Math.round(merged.defaultSpeed)))
        return merged
      })
      if ((patch.layerId || patch.dmxLoop !== undefined) && project.settings.addressMode === 'auto') {
        modules = autoAssign(project.layers, modules)
      } else if (patch.dmxLoop === false && project.settings.addressMode === 'manual') {
        const mod = modules.find((m) => m.id === id)
        if (mod && validateAddress(modules, id, mod.startAddress)) {
          const free = nextFree(modules, id)
          if (free !== null) modules = modules.map((m) => (m.id === id ? { ...m, startAddress: free } : m))
        }
      }
      applyProject({ ...project, modules }, { coalesceKey })
      return null
    },

    setModulesDmxLoop(ids, enabled) {
      const { project } = get()
      if (ids.length === 0) return
      const idSet = new Set(ids)
      let modules = project.modules.map((m) => {
        if (!idSet.has(m.id)) return m
        return {
          ...m,
          dmxLoop: enabled,
          startAddress: enabled ? layerLoopAddress(project.modules, m.layerId, m.id) : m.startAddress,
        }
      })
      if (project.settings.addressMode === 'auto') {
        modules = autoAssign(project.layers, modules)
      } else if (!enabled) {
        for (const id of ids) {
          const mod = modules.find((m) => m.id === id)
          if (mod && validateAddress(modules, id, mod.startAddress)) {
            const free = nextFree(modules, id)
            if (free !== null) modules = modules.map((m) => (m.id === id ? { ...m, startAddress: free } : m))
          }
        }
      }
      applyProject({ ...project, modules })
      get().notify(
        enabled ? `Đã bật Loop DMX dùng chung 4 kênh cho ${ids.length} module` : `Đã tắt Loop DMX cho ${ids.length} module`,
        'info',
      )
    },

    setAddressMode(addressMode) {
      const { project } = get()
      const modules = addressMode === 'auto' ? autoAssign(project.layers, project.modules) : project.modules
      applyProject({ ...project, modules, settings: { ...project.settings, addressMode } })
    },

    reAutoAssign() {
      const { project } = get()
      const modules = autoAssign(project.layers, project.modules)
      applyProject({ ...project, modules, settings: { ...project.settings, addressMode: 'auto' as const } })
      get().notify('Đã tự động gán lại địa chỉ liên tiếp từ kênh 1', 'info')
    },

    updateOutputSettings(patch) {
      const { project } = get()
      applyProject({
        ...project,
        settings: { ...project.settings, output: { ...project.settings.output, ...patch } },
      })
    },

    updateLtcSettings(patch) {
      const { project } = get()
      applyProject({
        ...project,
        settings: { ...project.settings, ltc: { ...project.settings.ltc, ...patch } },
      })
    },

    updateTimelineSettings(patch) {
      const { project } = get()
      applyProject({
        ...project,
        settings: { ...project.settings, timeline: { ...project.settings.timeline, ...patch } },
      })
    },

    setLockValue(lockValue) {
      const { project } = get()
      applyProject({ ...project, settings: { ...project.settings, lockValue } })
    },

    saveButton(btn) {
      const { project } = get()
      const exists = project.buttons.some((b) => b.id === btn.id)
      const buttons = exists ? project.buttons.map((b) => (b.id === btn.id ? btn : b)) : [...project.buttons, btn]
      applyProject({ ...project, buttons }, { extra: { selectedButtonId: btn.id } })
    },

    deleteButton(id) {
      const { project, selectedButtonId } = get()
      applyProject(
        { ...project, buttons: project.buttons.filter((b) => b.id !== id) },
        { extra: { selectedButtonId: selectedButtonId === id ? null : selectedButtonId } },
      )
    },

    addClip(clip) {
      const { project } = get()
      const existing = project.clips ?? []
      const sameMod = existing.filter((c) => c.moduleId === clip.moduleId).sort((a, b) => a.startTime - b.startTime)
      const safeStart = resolveClipStartNoOverlap(sameMod, clip.duration, clip.startTime)
      const prev = [...sameMod].reverse().find((c) => c.startTime + c.duration <= safeStart + 1e-3)
      const next = sameMod.find((c) => c.startTime >= safeStart + clip.duration - 1e-3)
      const kfs = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
      if (kfs.length > 0 && prev && prev.keyframes.length > 0) {
        const prevSorted = [...prev.keyframes].sort((a, b) => a.offset - b.offset)
        kfs[0] = { ...kfs[0], height: prevSorted[prevSorted.length - 1].height }
      }
      if (kfs.length > 1 && next && next.keyframes.length > 0) {
        const nextSorted = [...next.keyframes].sort((a, b) => a.offset - b.offset)
        kfs[kfs.length - 1] = { ...kfs[kfs.length - 1], height: nextSorted[0].height }
      }
      const nextClip: TimelineClip = { ...clip, startTime: safeStart, keyframes: kfs }
      let clips = syncModuleClipsContinuity([...existing, nextClip], clip.moduleId)
      const layer = project.layers.find((l) => l.id === clip.layerId)
      if (layer?.syncLayer) {
        clips = mirrorLayerClips(clips, project.modules, layer.id, clip.moduleId)
      }
      applyProject(
        { ...project, clips },
        {
          extra: {
            selectedClipId: clip.id,
            selectedKeyId: null,
            selectedTimelineLayerId: null,
            selectedLayerId: null,
            selectedIds: [clip.moduleId],
            focusScope: 'timeline',
          },
        },
      )
    },

    updateClip(clipId, patch, coalesceKey, syncEdge) {
      const { project } = get()
      const existing = project.clips ?? []
      const target = existing.find((c) => c.id === clipId)
      if (!target) return
      const updated = existing.map((c) => (c.id === clipId ? { ...c, ...patch } : c))
      let clips =
        patch.keyframes !== undefined || patch.startTime !== undefined || patch.duration !== undefined
          ? syncModuleClipsContinuity(
              updated,
              target.moduleId,
              syncEdge ? { clipId, edge: syncEdge } : undefined,
            )
          : updated
      const layer = project.layers.find((l) => l.id === target.layerId)
      if (layer?.syncLayer) {
        clips = mirrorLayerClips(clips, project.modules, layer.id, target.moduleId)
      }
      applyProject({ ...project, clips }, { coalesceKey })
    },

    deleteClip(clipId) {
      const { project, selectedClipId } = get()
      const target = (project.clips ?? []).find((c) => c.id === clipId)
      let clips = (project.clips ?? []).filter((c) => c.id !== clipId)
      if (target) {
        const layer = project.layers.find((l) => l.id === target.layerId)
        if (layer?.syncLayer) {
          clips = mirrorLayerClips(clips, project.modules, layer.id, target.moduleId)
        }
      }
      applyProject(
        { ...project, clips },
        {
          extra: {
            selectedClipId: selectedClipId === clipId ? null : selectedClipId,
            selectedKeyId: selectedClipId === clipId ? null : get().selectedKeyId,
          },
        },
      )
    },

    deleteTimelineLayerClips(layerId) {
      const { project } = get()
      const clips = (project.clips ?? []).filter((c) => c.layerId !== layerId)
      applyProject({ ...project, clips }, { extra: { selectedClipId: null } })
      get().notify('Đã xoá toàn bộ clip trong layer trên Timeline', 'info')
    },

    copySelection() {
      const s = get()
      if (s.focusScope === 'buttons') {
        const btn = s.project.buttons.find((b) => b.id === s.selectedButtonId)
        if (btn) {
          set({ copiedButton: structuredClone(btn) })
          s.notify(`Đã sao chép nút "${btn.name}" (Ctrl+V để dán)`, 'info')
        }
        return
      }
      if (s.focusScope === 'timeline') {
        const clips = s.project.clips ?? []
        if (s.selectedClipId) {
          const clip = clips.find((c) => c.id === s.selectedClipId)
          if (clip) {
            set({ copiedClips: [structuredClone(clip)] })
            s.notify('Đã sao chép clip Timeline', 'info')
          }
          return
        }
        if (s.selectedTimelineLayerId) {
          const layerClips = clips.filter((c) => c.layerId === s.selectedTimelineLayerId)
          if (layerClips.length > 0) {
            set({ copiedClips: structuredClone(layerClips) })
            s.notify(`Đã sao chép ${layerClips.length} clip của layer`, 'info')
          }
          return
        }
      }
      // Mặc định copy module đang chọn trong Cây màn
      const mods = s.project.modules.filter((m) => s.selectedIds.includes(m.id))
      if (mods.length > 0) {
        set({ copiedModules: structuredClone(mods) })
        s.notify(`Đã sao chép ${mods.length} module`, 'info')
      }
    },

    pasteSelection(atTime) {
      const s = get()
      if (s.focusScope === 'buttons') {
        if (!s.copiedButton) return
        const copy: CueButton = {
          ...structuredClone(s.copiedButton),
          id: `cue-${Date.now()}`,
          name: `${s.copiedButton.name} (sao chép)`,
        }
        s.saveButton(copy)
        s.notify(`Đã dán nút "${copy.name}"`, 'info')
        return
      }
      if (s.focusScope === 'timeline') {
        if (s.copiedClips.length === 0) return
        const minStart = Math.min(...s.copiedClips.map((c) => c.startTime))
        const targetTime = atTime ?? minStart + 1
        const delta = targetTime - minStart
        const targetLayer = s.selectedTimelineLayerId
        let accClips = [...(s.project.clips ?? [])]
        const pastedIds: string[] = []
        const affectedModIds = new Set<string>()
        for (let idx = 0; idx < s.copiedClips.length; idx++) {
          const c = s.copiedClips[idx]
          let layerId = c.layerId
          let moduleId = c.moduleId
          if (targetLayer && targetLayer !== c.layerId) {
            layerId = targetLayer
            const sameMod = s.project.modules.find((m) => m.layerId === targetLayer)
            if (sameMod) moduleId = sameMod.id
          }
          const sameModClips = accClips.filter((x) => x.moduleId === moduleId)
          const safeStart = resolveClipStartNoOverlap(sameModClips, c.duration, c.startTime + delta)
          const newId = `clip-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`
          accClips.push({
            ...structuredClone(c),
            id: newId,
            layerId,
            moduleId,
            startTime: safeStart,
          })
          pastedIds.push(newId)
          affectedModIds.add(moduleId)
        }
        for (const mId of affectedModIds) {
          accClips = syncModuleClipsContinuity(accClips, mId)
        }
        applyProject({ ...s.project, clips: accClips }, { extra: { selectedClipId: pastedIds[0] ?? null } })
        s.notify(`Đã dán ${pastedIds.length} clip vào Timeline`, 'info')
        return
      }
      // Paste modules vào layer đang chọn
      if (s.copiedModules.length === 0) return
      const targetLayerId =
        s.selectedLayerId ??
        s.project.modules.find((m) => m.id === s.selectedIds[0])?.layerId ??
        s.project.layers[0]?.id
      if (!targetLayerId) return
      let curMods = [...s.project.modules]
      const addedIds: string[] = []
      for (const src of s.copiedModules) {
        const free = nextFree(curMods)
        if (free === null) {
          s.notify('Hết kênh trống Universe 0', 'error')
          break
        }
        const newId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        curMods.push({
          ...structuredClone(src),
          id: newId,
          layerId: targetLayerId,
          name: `${src.name} (sao chép)`,
          startAddress: free,
        })
        addedIds.push(newId)
      }
      if (addedIds.length === 0) return
      if (s.project.settings.addressMode === 'auto') curMods = autoAssign(s.project.layers, curMods)
      applyProject({ ...s.project, modules: curMods }, { extra: { selectedIds: addedIds } })
      s.notify(`Đã dán ${addedIds.length} module`, 'info')
    },

    deleteSelection() {
      const s = get()
      if (s.focusScope === 'buttons') {
        if (s.selectedButtonId) {
          s.deleteButton(s.selectedButtonId)
          s.notify('Đã xoá nút', 'info')
        }
        return
      }
      if (s.focusScope === 'timeline') {
        if (s.selectedClipId) {
          s.deleteClip(s.selectedClipId)
          s.notify('Đã xoá clip', 'info')
        } else if (s.selectedTimelineLayerId) {
          s.deleteTimelineLayerClips(s.selectedTimelineLayerId)
        }
        return
      }
      if (s.selectedLayerId) {
        s.removeLayer(s.selectedLayerId)
      } else if (s.selectedIds.length > 0) {
        s.removeModules(s.selectedIds)
      }
    },

    addKey(key) {
      const { project } = get()
      const keys = [...project.keys, key].sort((a, b) => a.time - b.time)
      applyProject({ ...project, keys })
    },

    updateKey(id, patch) {
      const { project } = get()
      const keys = project.keys.map((k) => (k.id === id ? { ...k, ...patch } : k)).sort((a, b) => a.time - b.time)
      applyProject({ ...project, keys })
    },

    deleteKey(id) {
      const { project } = get()
      applyProject({ ...project, keys: project.keys.filter((k) => k.id !== id) })
    },

    async sendCommand(cmd) {
      let effectiveCmd = cmd
      if ((cmd.type === 'move' || cmd.type === 'stop') && Array.isArray(cmd.ids)) {
        const { project } = get()
        const expanded = new Set(cmd.ids)
        for (const id of cmd.ids) {
          const mod = project.modules.find((m) => m.id === id)
          if (!mod) continue
          const layer = project.layers.find((l) => l.id === mod.layerId)
          if (layer?.syncLayer) {
            for (const peer of project.modules) {
              if (peer.layerId === layer.id) expanded.add(peer.id)
            }
          }
          for (const peer of project.modules) {
            if (
              peer.id !== mod.id &&
              peer.layerId === mod.layerId &&
              peer.startAddress === mod.startAddress &&
              (mod.dmxLoop || peer.dmxLoop)
            ) {
              expanded.add(peer.id)
            }
          }
        }
        effectiveCmd = { ...cmd, ids: [...expanded] }
      }
      const res = await getBridge().command(effectiveCmd)
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
        past: [],
        future: [],
        collapsedLayers: {},
        selectedIds: blank.modules[0] ? [blank.modules[0].id] : [],
        selectedLayerId: null,
        selectedClipId: null,
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
          past: [],
          future: [],
          collapsedLayers: {},
          selectedIds: loaded.project.modules[0] ? [loaded.project.modules[0].id] : [],
          selectedLayerId: null,
          selectedClipId: null,
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
        past: [],
        future: [],
        collapsedLayers: {},
        selectedIds: def.modules[0] ? [def.modules[0].id] : [],
        selectedLayerId: null,
        selectedClipId: null,
      })
      persistAndSync(def)
      get().notify('Đã khôi phục preset mặc định (12×1m + 1×3m)', 'info')
    },
  }
})
