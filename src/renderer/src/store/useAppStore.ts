import { create } from 'zustand'
import { autoAssign, layerLoopAddress, nextFree, orderedModules, validateAddress } from '@shared/addressing'
import type { AppInfo, SnapshotDto } from '@shared/api'
import { clamp } from '@shared/convert'
import { DEFAULT_SPEED, H2_MAX_SPEED_CMS, isValidStartAddress, rangesOverlap } from '@shared/dmx'
import { resolveOutputSettingsPatch } from '@shared/protocols'
import {
  type CurvePresetId,
  LAYER_MOTION_PRESETS,
  type LayerMotionOptions,
  type LayerMotionPresetId,
  buildLayerMotionClips,
  buildMultiClipShiftPatch,
  buildPresetPatchForClips,
  buildTimingPatchForSelectedClips,
  defaultMotionDuration,
  resolveClipStartNoOverlap,
  syncModuleClipsContinuity,
} from '@shared/timeline'
import {
  createBlankProject,
  createDefaultProject,
  defaultLayerTransform,
  defaultModuleTransform,
  DEFAULT_PROJECT_NAME,
  normalizeProjectName,
} from '@shared/preset'
import type {
  Command,
  CommandResult,
  CueButton,
  Fps,
  Layer,
  LtcSettings,
  ModuleCfg,
  OutputSettings,
  Project,
  TimelineClip,
  TimelineKey,
  Transform3D,
} from '@shared/types'
import { getBridge } from '../services/bridge'

export type ControlTab = 'buttons' | 'manual' | 'timeline'
export type FocusScope = 'tree' | 'buttons' | 'timeline'
export type SettingsTab = 'network' | 'safety' | 'ltc' | 'notifications'
export type ToastKind = 'info' | 'success' | 'warn' | 'error'
export type ToastIcon =
  | 'info'
  | 'success'
  | 'warn'
  | 'error'
  | 'running'
  | 'stopped'
  | 'estop'
  | 'disconnected'
  | 'connected'
  | 'save'

export interface ToastMsg {
  id: number
  title: string
  text: string
  kind: ToastKind
  icon: ToastIcon
}

export interface NotificationSettings {
  enabled: boolean
  durationMs: number
  kinds: Record<ToastKind, boolean>
}

const NOTIF_STORAGE_KEY = 'dmx-gauze-notifications-v1'

const DEFAULT_NOTIF_SETTINGS: NotificationSettings = {
  enabled: true,
  durationMs: 3500,
  kinds: {
    info: true,
    success: true,
    warn: true,
    error: true,
  },
}

function loadNotificationSettings(): NotificationSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(NOTIF_STORAGE_KEY) : null
    if (!raw) return structuredClone(DEFAULT_NOTIF_SETTINGS)
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      durationMs:
        typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)
          ? clamp(Math.round(parsed.durationMs), 1500, 15000)
          : 3500,
      kinds: {
        info: parsed.kinds?.info !== false,
        success: parsed.kinds?.success !== false,
        warn: parsed.kinds?.warn !== false,
        error: parsed.kinds?.error !== false,
      },
    }
  } catch {
    return structuredClone(DEFAULT_NOTIF_SETTINGS)
  }
}

function saveNotificationSettings(cfg: NotificationSettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(cfg))
    }
  } catch {
    /* ignore */
  }
}

const DEFAULT_TITLES: Record<ToastKind, string> = {
  info: 'Thông báo',
  success: 'Thành công',
  warn: 'Cảnh báo',
  error: 'Lỗi hệ thống',
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
  lastFiredButtonId: string | null
  lastFiredButtonBaselines: Record<string, { start: number; goal: number }>
  selectedClipId: string | null
  selectedClipIds: string[]
  selectedKeyId: string | null
  selectedTimelineLayerId: string | null

  copiedModules: ModuleCfg[]
  copiedButton: CueButton | null
  copiedClips: TimelineClip[]

  snapshot: SnapshotDto | null
  activeTab: ControlTab
  playheadTime: number
  ltcActive: boolean
  ltcDropFrame: boolean | undefined
  settingsOpen: boolean
  settingsTab: SettingsTab
  toast: ToastMsg | null
  notificationSettings: NotificationSettings

  init: () => Promise<void>
  notify: (text: string, kind?: ToastKind, opts?: { title?: string; icon?: ToastIcon }) => void
  dismissToast: () => void
  updateNotificationSettings: (patch: Partial<NotificationSettings>) => void
  setActiveTab: (tab: ControlTab) => void
  setFocusScope: (scope: FocusScope) => void
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void

  undo: () => void
  redo: () => void

  toggleLayerCollapse: (layerId: string) => void
  toggleLayerVisibility: (layerId: string) => void
  toggleLayerSync: (layerId: string) => void
  syncLayerFromModule: (layerId: string, moduleId: string) => void
  toggleModuleVisibility: (moduleId: string) => void
  setModulesDmxLoop: (ids: string[], enabled: boolean) => void
  addLayer: (name: string, opts?: { id?: string }) => string | null
  updateLayer: (layerId: string, patch: Partial<Layer>, coalesceKey?: string) => void
  renameLayer: (layerId: string, name: string) => void
  removeLayer: (layerId: string) => void

  selectModule: (id: string, opts?: { multi?: boolean; range?: boolean }) => void
  selectLayer: (layerId: string) => void
  selectAll: () => void
  deselectAll: () => void
  selectButton: (id: string | null) => void
  setLastFiredButton: (id: string | null, baselines?: Record<string, { start: number; goal: number }>) => void
  moveButtonToSlot: (buttonId: string, targetSlot: number) => void
  selectTimelineClip: (clipId: string | null, keyId?: string | null) => void
  selectTimelineClips: (clipIds: string[], opts?: { additive?: boolean }) => void
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
  renameProject: (name: string) => void
  updateModule: (id: string, patch: Partial<ModuleCfg>, coalesceKey?: string) => string | null
  updateModulesBatch: (
    ids: string[],
    patch: {
      nameBase?: string
      layerId?: string
      length?: number
      width?: number
      minHeight?: number
      maxHeight?: number
      maxSpeedCms?: number
      defaultSpeed?: number
      startAddressBase?: number
      resetTransform?: boolean
      transformAxis?: {
        field: keyof Transform3D
        index: 0 | 1 | 2
        value: number
      }
    },
  ) => string | null

  setAddressMode: (mode: 'auto' | 'manual') => void
  reAutoAssign: () => void
  updateOutputSettings: (patch: Partial<OutputSettings>) => void
  updateLtcSettings: (patch: Partial<LtcSettings>) => void
  updateTimelineSettings: (patch: Partial<Project['settings']['timeline']>) => void
  setLockValue: (v: number) => void

  saveButton: (btn: CueButton, coalesceKey?: string) => void
  deleteButton: (id: string) => void

  addClip: (clip: TimelineClip) => void
  updateClip: (
    clipId: string,
    patch: Partial<TimelineClip>,
    coalesceKey?: string,
    syncEdge?: 'start' | 'end',
  ) => void
  deleteClip: (clipId: string) => void
  applyPresetToSelectedClips: (opts: { presetId?: CurvePresetId; curveMode?: 'smooth' | 'linear' }) => boolean
  updateSelectedClipsTiming: (opts: { startTime?: number; endTime?: number }) => boolean
  moveSelectedClipsByDelta: (
    origStarts: ReadonlyMap<string, number>,
    rawDeltaSec: number,
    coalesceKey?: string,
    snapFps?: Fps,
  ) => number | null
  deleteTimelineLayerClips: (layerId: string) => void
  setPlayheadTime: (time: number) => void
  setLtcActive: (active: boolean) => void
  setLtcDropFrame: (dropFrame: boolean | undefined) => void
  applyLayerMotionPreset: (
    layerId: string,
    presetId: LayerMotionPresetId,
    opts?: LayerMotionOptions,
  ) => number
  copySelection: () => void
  pasteSelection: (atTime?: number) => void
  deleteSelection: () => void

  addKey: (key: TimelineKey) => void
  updateKey: (id: string, patch: Partial<TimelineKey>) => void
  deleteKey: (id: string) => void

  sendCommand: (cmd: Command, opts?: { quietWarnings?: boolean; source?: ControlTab }) => Promise<CommandResult>
  holdTimelineTargets: () => void
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
let toastTimer: ReturnType<typeof setTimeout> | null = null
let unsubSnap: (() => void) | null = null
let lastCoalesceKey = ''
let lastCoalesceAt = 0
let lastToastSig = ''
let lastToastAt = 0

function reportSaveError(err: unknown): void {
  useAppStore.getState().notify(`Không lưu được dự án: ${(err as Error).message}`, 'error', { title: 'Lỗi lưu', icon: 'error' })
}

function persistAndSync(project: Project): void {
  const b = getBridge()
  void b.configure({
    modules: project.modules,
    output: project.settings.output,
    lockValue: project.settings.lockValue,
  })
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    b.saveProject(project).catch((err: unknown) => reportSaveError(err))
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
  const timelineCommandedIds = new Set<string>()
  const applyProject = (next: Project, opts?: { coalesceKey?: string; dirty?: boolean; extra?: Partial<AppState> }) => {
    const state = get()
    const now = Date.now()
    const coalesced = Boolean(opts?.coalesceKey && opts.coalesceKey === lastCoalesceKey && now - lastCoalesceAt < 450)
    lastCoalesceKey = opts?.coalesceKey ?? ''
    lastCoalesceAt = now

    const validClipIds = new Set((next.clips ?? []).map((c) => c.id))
    const prunedClipIds = (opts?.extra?.selectedClipIds ?? state.selectedClipIds).filter((id) => validClipIds.has(id))
    const nextClipId =
      opts?.extra?.selectedClipId !== undefined
        ? opts.extra.selectedClipId
        : state.selectedClipId && validClipIds.has(state.selectedClipId)
          ? state.selectedClipId
          : (prunedClipIds[0] ?? null)

    const past = coalesced ? state.past : [...state.past.slice(-(MAX_HISTORY - 1)), state.project]
    set({
      project: next,
      past,
      future: [],
      dirty: opts?.dirty ?? true,
      ...opts?.extra,
      selectedClipIds: prunedClipIds,
      selectedClipId: nextClipId,
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
    lastFiredButtonId: null,
    lastFiredButtonBaselines: {},
    selectedClipId: null,
    selectedClipIds: [],
    selectedKeyId: null,
    selectedTimelineLayerId: null,

    copiedModules: [],
    copiedButton: null,
    copiedClips: [],

    snapshot: null,
    activeTab: 'timeline',
    playheadTime: 0,
    ltcActive: false,
    ltcDropFrame: undefined,
    settingsOpen: false,
    settingsTab: 'network',
    toast: null,
    notificationSettings: loadNotificationSettings(),

    setPlayheadTime(time) {
      if (!Number.isFinite(time)) return
      const next = Math.max(0, Number(time.toFixed(4)))
      if (get().playheadTime !== next) set({ playheadTime: next })
    },
    setLtcActive(active) {
      if (get().ltcActive !== active) set({ ltcActive: active, ltcDropFrame: undefined })
    },
    setLtcDropFrame(dropFrame) {
      if (get().ltcDropFrame !== dropFrame) set({ ltcDropFrame: dropFrame })
    },

    notify(text, kind = 'info', opts) {
      const cfg = get().notificationSettings
      if (!cfg.enabled || !cfg.kinds[kind]) return
      const title = opts?.title ?? DEFAULT_TITLES[kind]
      const icon: ToastIcon = opts?.icon ?? kind
      const sig = `${kind}|${title}|${text}`
      const now = Date.now()
      if (sig === lastToastSig && now - lastToastAt < 800) return
      lastToastSig = sig
      lastToastAt = now

      const id = now
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: { id, title, text, kind, icon } })
      const dur = clamp(Math.round(cfg.durationMs), 1500, 15000)
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null })
      }, dur)
    },

    dismissToast() {
      if (toastTimer) {
        clearTimeout(toastTimer)
        toastTimer = null
      }
      set({ toast: null })
    },

    updateNotificationSettings(patch) {
      const cur = get().notificationSettings
      const next: NotificationSettings = {
        enabled: patch.enabled ?? cur.enabled,
        durationMs:
          patch.durationMs !== undefined && Number.isFinite(patch.durationMs)
            ? clamp(Math.round(patch.durationMs), 1500, 15000)
            : cur.durationMs,
        kinds: patch.kinds ? { ...cur.kinds, ...patch.kinds } : cur.kinds,
      }
      saveNotificationSettings(next)
      set({ notificationSettings: next })
    },

    async init() {
      const b = getBridge()
      if (unsubSnap) unsubSnap()
      let prevState: string | null = null
      let prevMsg: string | null = null
      unsubSnap = b.onSnapshot((snapshot) => {
        set({ snapshot })
        const st = snapshot.status
        if (st.state === 'error' && (prevState !== 'error' || (st.message && st.message !== prevMsg))) {
          get().notify(st.message ?? 'Lỗi kết nối đầu ra DMX / Serial', 'error', {
            title: 'Lỗi kết nối DMX',
            icon: 'error',
          })
        } else if (st.state === 'lost' && prevState !== 'lost') {
          get().notify(st.message ?? 'Mất phản hồi từ thiết bị DMX', 'warn', {
            title: 'Mất kết nối DMX',
            icon: 'disconnected',
          })
        } else if (
          st.state === 'online' &&
          (prevState === 'lost' || prevState === 'error' || prevState === 'searching')
        ) {
          get().notify(`Đã kết nối ${st.driver.toUpperCase()} (${st.sendHz} Hz)`, 'success', {
            title: 'Kết nối DMX sẵn sàng',
            icon: 'connected',
          })
        }
        prevState = st.state
        prevMsg = st.message
      })
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

    setActiveTab: (activeTab) => {
      if (get().activeTab === 'timeline' && activeTab !== 'timeline') get().holdTimelineTargets()
      set((s) => ({
        activeTab,
        focusScope: activeTab === 'buttons' ? 'buttons' : activeTab === 'timeline' ? 'timeline' : 'tree',
        selectedButtonId:
          activeTab === 'buttons' ? (s.selectedButtonId ?? s.project.buttons[0]?.id ?? null) : s.selectedButtonId,
      }))
    },
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
      const { project, selectedIds } = get()
      const target = project.layers.find((l) => l.id === layerId)
      if (!target) return
      const nextSync = !(target.syncLayer ?? false)
      const selectedInLayer = selectedIds.find((id) =>
        project.modules.some((m) => m.id === id && m.layerId === layerId),
      )
      const sourceMod = selectedInLayer ? project.modules.find((m) => m.id === selectedInLayer) : undefined
      const layers = project.layers.map((l) => (l.id === layerId ? { ...l, syncLayer: nextSync } : l))
      const clips = nextSync
        ? mirrorLayerClips(project.clips ?? [], project.modules, layerId, selectedInLayer)
        : (project.clips ?? [])
      applyProject({ ...project, layers, clips })
      get().notify(
        nextSync
          ? sourceMod
            ? `Đã bật Sync Layer "${target.name}" theo "${sourceMod.name}"`
            : `Đã bật Sync Layer "${target.name}" — các module chạy giống hệt nhau`
          : `Đã tắt Sync Layer "${target.name}"`,
        'info',
      )
    },

    syncLayerFromModule(layerId, moduleId) {
      const { project } = get()
      const layer = project.layers.find((l) => l.id === layerId)
      const mod = project.modules.find((m) => m.id === moduleId && m.layerId === layerId)
      if (!layer || !mod) return
      const layers = project.layers.map((l) => (l.id === layerId ? { ...l, syncLayer: true } : l))
      const clips = mirrorLayerClips(project.clips ?? [], project.modules, layerId, moduleId)
      applyProject({ ...project, layers, clips })
      get().notify(`Đã đồng bộ Layer "${layer.name}" theo "${mod.name}"`, 'info')
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
            selectedClipIds: [],
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
          selectedClipIds: [],
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
        selectedClipIds: [],
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
        selectedClipIds: [],
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
        selectedClipIds: [],
        selectedKeyId: null,
        selectedTimelineLayerId: null,
        focusScope: 'tree',
      })
    },

    deselectAll() {
      set({
        selectedIds: [],
        selectedLayerId: null,
        selectedClipId: null,
        selectedClipIds: [],
        selectedKeyId: null,
        selectedTimelineLayerId: null,
        focusScope: 'tree',
      })
    },

    selectButton: (selectedButtonId) => set({ selectedButtonId, focusScope: 'buttons' }),
    setLastFiredButton: (lastFiredButtonId, lastFiredButtonBaselines = {}) =>
      set({ lastFiredButtonId, lastFiredButtonBaselines }),

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
        selectedClipIds: selectedClipId && clip ? [selectedClipId] : [],
        selectedKeyId: preservedKey,
        selectedTimelineLayerId: null,
        ...(clip ? { selectedLayerId: null, selectedIds: [clip.moduleId] } : {}),
        focusScope: 'timeline',
      })
    },

    selectTimelineClips(clipIds, opts) {
      const clips = get().project.clips ?? []
      const clipMap = new Map(clips.map((c) => [c.id, c]))
      const baseIds = opts?.additive ? get().selectedClipIds : []
      const nextSet = new Set(baseIds.filter((id) => clipMap.has(id)))
      for (const id of clipIds) {
        if (clipMap.has(id)) nextSet.add(id)
      }
      const nextIds = [...nextSet]
      const modIds = [...new Set(nextIds.map((id) => clipMap.get(id)!.moduleId))]
      set({
        selectedClipIds: nextIds,
        selectedClipId: nextIds[0] ?? null,
        selectedKeyId: null,
        selectedTimelineLayerId: null,
        ...(nextIds.length > 0 ? { selectedLayerId: null, selectedIds: modIds } : {}),
        focusScope: 'timeline',
      })
    },

    selectTimelineKey: (selectedKeyId) => set({ selectedKeyId }),

    selectTimelineLayer(selectedTimelineLayerId) {
      if (!selectedTimelineLayerId) {
        set({
          selectedTimelineLayerId: null,
          selectedClipId: null,
          selectedClipIds: [],
          selectedKeyId: null,
          focusScope: 'timeline',
        })
        return
      }
      const ids = get().project.modules.filter((m) => m.layerId === selectedTimelineLayerId).map((m) => m.id)
      set({
        selectedTimelineLayerId,
        selectedClipId: null,
        selectedClipIds: [],
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

    renameProject(name) {
      const { project } = get()
      const next = normalizeProjectName(name)
      if (next !== (project.name ?? DEFAULT_PROJECT_NAME)) applyProject({ ...project, name: next })
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
        merged.length = Math.min(500, Math.max(0.2, merged.length))
        merged.width = Math.min(500, Math.max(0.2, merged.width))
        merged.maxHeight = Math.min(merged.length, Math.max(0, merged.maxHeight))
        merged.minHeight = Math.min(merged.maxHeight, Math.max(0, merged.minHeight))
        merged.maxSpeedCms = Math.min(10000, Math.max(10, merged.maxSpeedCms))
        if (merged.ch2Fine !== undefined) merged.ch2Fine = Math.min(255, Math.max(0, Math.round(merged.ch2Fine) || 0))
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
      const nextLayerId = patch.layerId
      const clips =
        nextLayerId && nextLayerId !== current.layerId
          ? (project.clips ?? []).map((c) => (c.moduleId === id ? { ...c, layerId: nextLayerId } : c))
          : project.clips
      applyProject({ ...project, modules, clips }, { coalesceKey })
      return null
    },

    updateModulesBatch(ids, patch) {
      const { project } = get()
      const idSet = new Set(ids)
      const selectedMods = project.modules.filter((m) => idSet.has(m.id))
      if (selectedMods.length === 0) return null

      if (patch.layerId !== undefined && !project.layers.some((l) => l.id === patch.layerId)) {
        return 'Layer không tồn tại'
      }

      const assignedNames = new Map<string, string>()
      if (patch.nameBase !== undefined) {
        const trimmed = patch.nameBase.trim()
        if (!trimmed) return 'Tên module không được để trống'
        const taken = new Set(
          project.modules.filter((m) => !idSet.has(m.id)).map((m) => m.name.trim().toLowerCase()),
        )
        if (selectedMods.length === 1) {
          if (taken.has(trimmed.toLowerCase())) return `Tên "${trimmed}" đã tồn tại`
          assignedNames.set(selectedMods[0].id, trimmed)
        } else {
          let seq = 1
          for (const m of selectedMods) {
            let candidate = `${trimmed} ${seq}`
            while (taken.has(candidate.toLowerCase())) {
              seq += 1
              candidate = `${trimmed} ${seq}`
            }
            taken.add(candidate.toLowerCase())
            assignedNames.set(m.id, candidate)
            seq += 1
          }
        }
      }

      const assignedAddrs = new Map<string, number>()
      if (patch.startAddressBase !== undefined) {
        if (project.settings.addressMode !== 'manual') {
          return 'Chỉ nhập địa chỉ tay khi chế độ Địa chỉ là Thủ công'
        }
        const base = Math.trunc(patch.startAddressBase)
        if (!Number.isFinite(patch.startAddressBase) || base < 1 || base > 509) {
          return 'Địa chỉ DMX phải từ 1 đến 509'
        }
        let nextCandidate = base
        const loopAddrByLayer = new Map<string, number>()
        let probeMods = project.modules.map((m) => ({
          ...m,
          layerId: idSet.has(m.id) && patch.layerId !== undefined ? patch.layerId : m.layerId,
        }))
        for (const m of selectedMods) {
          const effLayer = patch.layerId ?? m.layerId
          let addr: number
          if (m.dmxLoop && loopAddrByLayer.has(effLayer)) {
            addr = loopAddrByLayer.get(effLayer)!
          } else {
            addr = nextCandidate
            nextCandidate += 4
            if (m.dmxLoop) loopAddrByLayer.set(effLayer, addr)
          }
          if (addr < 1 || addr > 509) {
            return 'Địa chỉ DMX vượt quá giới hạn 512 kênh'
          }
          const err = validateAddress(probeMods, m.id, addr)
          if (err) return err
          assignedAddrs.set(m.id, addr)
          probeMods = probeMods.map((pm) => (pm.id === m.id ? { ...pm, startAddress: addr } : pm))
        }
      }

      let modules = project.modules.map((m) => {
        if (!idSet.has(m.id)) return m
        const merged: ModuleCfg = {
          ...m,
          ...(assignedNames.has(m.id) ? { name: assignedNames.get(m.id)! } : {}),
          ...(patch.layerId !== undefined ? { layerId: patch.layerId } : {}),
          ...(assignedAddrs.has(m.id) ? { startAddress: assignedAddrs.get(m.id)! } : {}),
          ...(patch.length !== undefined ? { length: patch.length } : {}),
          ...(patch.width !== undefined ? { width: patch.width } : {}),
          ...(patch.minHeight !== undefined ? { minHeight: patch.minHeight } : {}),
          ...(patch.maxHeight !== undefined ? { maxHeight: patch.maxHeight } : {}),
          ...(patch.maxSpeedCms !== undefined ? { maxSpeedCms: patch.maxSpeedCms } : {}),
          ...(patch.defaultSpeed !== undefined ? { defaultSpeed: patch.defaultSpeed } : {}),
        }
        if (patch.resetTransform) {
          merged.transform = defaultModuleTransform()
        } else if (patch.transformAxis) {
          const { field, index, value } = patch.transformAxis
          const baseTf = merged.transform ? { ...merged.transform } : defaultModuleTransform()
          const arr: [number, number, number] = [...baseTf[field]]
          arr[index] = field === 'scale' ? Math.max(0.1, value || 0.1) : value || 0
          if (field === 'position' && index === 1) arr[1] = 0
          merged.transform = { ...baseTf, [field]: arr }
        }
        if (merged.transform) {
          merged.transform = {
            ...merged.transform,
            position: [merged.transform.position[0], 0, merged.transform.position[2]],
          }
        }
        merged.length = Math.min(500, Math.max(0.2, merged.length))
        merged.width = Math.min(500, Math.max(0.2, merged.width))
        merged.maxHeight = Math.min(merged.length, Math.max(0, merged.maxHeight))
        merged.minHeight = Math.min(merged.maxHeight, Math.max(0, merged.minHeight))
        merged.maxSpeedCms = Math.min(10000, Math.max(10, merged.maxSpeedCms))
        merged.defaultSpeed = Math.min(255, Math.max(1, Math.round(merged.defaultSpeed)))
        return merged
      })

      if (patch.layerId !== undefined && project.settings.addressMode === 'auto') {
        modules = autoAssign(project.layers, modules)
      }

      const clips =
        patch.layerId !== undefined
          ? (project.clips ?? []).map((c) => (idSet.has(c.moduleId) ? { ...c, layerId: patch.layerId! } : c))
          : project.clips

      applyProject({ ...project, modules, clips })
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
        settings: {
          ...project.settings,
          output: resolveOutputSettingsPatch(project.settings.output, patch),
        },
      })
    },

    updateLtcSettings(patch) {
      const { project } = get()
      const nextLtc: LtcSettings = { ...project.settings.ltc, ...patch }
      nextLtc.freewheelFrames = clamp(nextLtc.freewheelFrames, 0, 600)
      nextLtc.offsetFrames = clamp(nextLtc.offsetFrames, -600, 600)
      if ('fps' in patch && patch.fps === undefined) {
        delete nextLtc.fps
      }
      applyProject({
        ...project,
        settings: { ...project.settings, ltc: nextLtc },
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

    saveButton(btn, coalesceKey) {
      const { project } = get()
      const exists = project.buttons.some((b) => b.id === btn.id)
      const buttons = exists ? project.buttons.map((b) => (b.id === btn.id ? btn : b)) : [...project.buttons, btn]
      applyProject({ ...project, buttons }, { coalesceKey, extra: { selectedButtonId: btn.id, focusScope: 'buttons' } })
    },

    deleteButton(id) {
      const { project, selectedButtonId, lastFiredButtonId, lastFiredButtonBaselines } = get()
      applyProject(
        { ...project, buttons: project.buttons.filter((b) => b.id !== id) },
        {
          extra: {
            selectedButtonId: selectedButtonId === id ? null : selectedButtonId,
            lastFiredButtonId: lastFiredButtonId === id ? null : lastFiredButtonId,
            lastFiredButtonBaselines: lastFiredButtonId === id ? {} : lastFiredButtonBaselines,
          },
        },
      )
    },

    moveButtonToSlot(buttonId, targetSlot) {
      if (!Number.isInteger(targetSlot) || targetSlot < 0) return
      const { project } = get()
      const slotMap = new Map<number, string>()
      const effSlot = new Map<string, number>()
      const unslotted: string[] = []
      for (const b of project.buttons) {
        if (b.slotIndex !== undefined && b.slotIndex >= 0 && !slotMap.has(b.slotIndex)) {
          slotMap.set(b.slotIndex, b.id)
          effSlot.set(b.id, b.slotIndex)
        } else {
          unslotted.push(b.id)
        }
      }
      for (const id of unslotted) {
        let idx = 0
        while (slotMap.has(idx)) idx += 1
        slotMap.set(idx, id)
        effSlot.set(id, idx)
      }
      const sourceSlot = effSlot.get(buttonId)
      if (sourceSlot === undefined || sourceSlot === targetSlot) return
      const occupantId = slotMap.get(targetSlot)
      const nextButtons = project.buttons.map((b) => {
        const cur = effSlot.get(b.id) ?? 0
        if (b.id === buttonId) return { ...b, slotIndex: targetSlot }
        if (occupantId && b.id === occupantId) return { ...b, slotIndex: sourceSlot }
        return b.slotIndex === cur ? b : { ...b, slotIndex: cur }
      })
      applyProject({ ...project, buttons: nextButtons })
    },

    addClip(clip) {
      const { project } = get()
      const existing = project.clips ?? []
      const sameMod = existing.filter((c) => c.moduleId === clip.moduleId).sort((a, b) => a.startTime - b.startTime)
      const layer = project.layers.find((l) => l.id === clip.layerId)
      const affected = project.modules.filter((m) => m.id === clip.moduleId || (layer?.syncLayer && m.layerId === layer.id))
      const points = [...clip.keyframes].sort((a, b) => a.offset - b.offset)
      let duration = clip.duration
      let nextClip: TimelineClip
      for (;;) {
        const startTime = resolveClipStartNoOverlap(sameMod, duration, clip.startTime)
        const prev = [...sameMod].reverse().find((c) => c.startTime + c.duration <= startTime + 1e-3)
        const next = sameMod.find((c) => c.startTime >= startTime + duration - 1e-3)
        const keyframes = points.map((k) => ({ ...k, offset: duration === clip.duration ? k.offset : k.offset / clip.duration * duration }))
        if (keyframes.length > 0 && prev && prev.keyframes.length > 0) {
          const prevSorted = [...prev.keyframes].sort((a, b) => a.offset - b.offset)
          keyframes[0].height = prevSorted[prevSorted.length - 1].height
        }
        if (keyframes.length > 1 && next && next.keyframes.length > 0) {
          const nextSorted = [...next.keyframes].sort((a, b) => a.offset - b.offset)
          keyframes[keyframes.length - 1].height = nextSorted[0].height
        }
        nextClip = { ...clip, startTime, duration, keyframes }
        if (clip.autoSpeedLimitCms === undefined) break
        const required = Math.max(duration, ...affected.map((mod) => defaultMotionDuration(nextClip, mod)))
        if (required <= duration) break
        duration = required
      }
      let clips = syncModuleClipsContinuity([...existing, nextClip], clip.moduleId)
      if (layer?.syncLayer) {
        clips = mirrorLayerClips(clips, project.modules, layer.id, clip.moduleId)
      }
      applyProject(
        { ...project, clips },
        {
          extra: {
            selectedClipId: clip.id,
            selectedClipIds: [clip.id],
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
      applyProject({ ...project, clips }, { extra: { selectedClipId: null, selectedClipIds: [] } })
      get().notify('Đã xoá toàn bộ clip trong layer trên Timeline', 'info')
    },

    applyPresetToSelectedClips(opts) {
      const { project, selectedClipIds } = get()
      const nextClips = buildPresetPatchForClips(project.clips ?? [], project.modules, selectedClipIds, opts)
      if (!nextClips) {
        if (opts.presetId) get().notify('Không đủ chỗ để áp dụng mẫu sóng ở tốc độ Auto mặc định', 'warn')
        return false
      }
      applyProject({ ...project, clips: nextClips })
      return true
    },

    updateSelectedClipsTiming(opts) {
      const { project, selectedClipIds } = get()
      const nextClips = buildTimingPatchForSelectedClips(project.clips ?? [], selectedClipIds, opts)
      if (!nextClips) {
        get().notify('Không thể cập nhật: thời gian vượt biên hoặc chồng chéo moment khác', 'warn')
        return false
      }
      applyProject({ ...project, clips: nextClips })
      return true
    },

    moveSelectedClipsByDelta(origStarts, rawDeltaSec, coalesceKey, snapFps) {
      const { project, selectedClipIds } = get()
      const res = buildMultiClipShiftPatch(project.clips ?? [], selectedClipIds, rawDeltaSec, origStarts, snapFps)
      if (!res) return null
      applyProject({ ...project, clips: res.clips }, { coalesceKey })
      return res.delta
    },

    applyLayerMotionPreset(layerId, presetId, opts) {
      const { project, playheadTime, activeTab, notify } = get()
      const alternating = presetId === 'alternating-wave'
      if (alternating && activeTab !== 'timeline') return 0
      const layer = project.layers.find((l) => l.id === layerId)
      if (!layer) return 0
      const layerMods = project.modules.filter((m) => m.layerId === layerId)
      if (alternating && layerMods.length > 0) {
        const hasSharedAddress = layerMods.some((mod) =>
          mod.dmxLoop || !isValidStartAddress(mod.startAddress) || project.modules.some((other) =>
            other.id !== mod.id && rangesOverlap(mod.startAddress, other.startAddress),
          ),
        )
        if (layer.syncLayer || hasSharedAddress) {
          notify('Sóng so le cần tắt Sync Layer và dùng địa chỉ DMX riêng cho từng module', 'warn')
          return 0
        }
      }
      const duration = opts?.duration ?? 4
      const staggerSec = opts?.staggerSec ?? 0.35
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(staggerSec) || staggerSec < 0) {
        get().notify('Thời lượng hoặc độ lệch sóng không hợp lệ', 'warn')
        return 0
      }
      const amplitudeCm = opts?.amplitudeCm
      if (presetId === 'alternating-wave' && amplitudeCm !== undefined && (!Number.isFinite(amplitudeCm) || amplitudeCm < 0)) {
        get().notify('Biên độ sóng so le không hợp lệ', 'warn')
        return 0
      }
      const created = buildLayerMotionClips({
        layerId,
        modules: project.modules,
        existingClips: project.clips ?? [],
        presetId,
        startTime: playheadTime,
        duration,
        staggerSec,
        amplitudeCm,
        firstUp: opts?.firstUp,
      })
      if (created.length === 0) {
        get().notify('Layer chưa có module nào để tạo hiệu ứng', 'warn')
        return 0
      }
      // Giữ nguyên toàn bộ clip cũ; không gọi syncModuleClipsContinuity để tránh sửa ngầm moment khác.
      const clips = [...(project.clips ?? []), ...created]
      // Tắt syncLayer để mỗi module chạy đúng hành trình/stagger riêng khi phát Timeline.
      const layers = layer.syncLayer
        ? project.layers.map((l) => (l.id === layerId ? { ...l, syncLayer: false } : l))
        : project.layers
      // Nếu layer đang bật Loop DMX (dùng chung kênh), tách Loop DMX và đảm bảo mỗi module có địa chỉ DMX hợp lệ, không trùng.
      const hasLoop = layerMods.some((m) => m.dmxLoop)
      let modules = project.modules
      if (hasLoop) {
        const unlooped = project.modules.map((m) => (m.layerId === layerId ? { ...m, dmxLoop: false } : m))
        if (project.settings.addressMode === 'auto') {
          const reassigned = autoAssign(layers, unlooped)
          if (reassigned.some((m) => !isValidStartAddress(m.startAddress))) {
            get().notify('Không đủ 512 kênh DMX để tách Loop DMX cho các module trong layer', 'error')
            return 0
          }
          modules = reassigned
        } else {
          const working = unlooped.map((m) => ({ ...m }))
          const settledInLayer: ModuleCfg[] = []
          const otherLayerMods = working.filter((m) => m.layerId !== layerId)
          for (const mod of working) {
            if (mod.layerId !== layerId) continue
            const conflict = [...otherLayerMods, ...settledInLayer].some((p) =>
              rangesOverlap(p.startAddress, mod.startAddress),
            )
            if (conflict) {
              const free = nextFree(working, mod.id)
              if (free === null) {
                get().notify('Không đủ kênh DMX trống (Universe 0) để tách Loop DMX cho hiệu ứng độc lập', 'error')
                return 0
              }
              mod.startAddress = free
            }
            settledInLayer.push(mod)
          }
          if (settledInLayer.some((m) => validateAddress(working, m.id, m.startAddress) !== null)) {
            get().notify('Xung đột địa chỉ DMX khi tách Loop DMX trong layer', 'error')
            return 0
          }
          modules = working
        }
      }
      applyProject(
        { ...project, layers, modules, clips },
        {
          extra: {
            selectedClipId: created[0].id,
            selectedClipIds: alternating ? created.map((clip) => clip.id) : [created[0].id],
            selectedKeyId: null,
            selectedLayerId: null,
            selectedTimelineLayerId: null,
            selectedIds: alternating ? created.map((clip) => clip.moduleId) : [created[0].moduleId],
            focusScope: 'timeline',
          },
        },
      )
      const label = LAYER_MOTION_PRESETS.find((p) => p.id === presetId)?.label ?? presetId
      get().notify(`Đã tạo ${created.length} moment "${label}" dài ${created[0].duration}s tại ${created[0].startTime.toFixed(2)}s`, 'info')
      return created.length
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
        if (s.selectedClipIds.length > 1) {
          const delSet = new Set(s.selectedClipIds)
          const remaining = (s.project.clips ?? []).filter((c) => !delSet.has(c.id))
          applyProject(
            { ...s.project, clips: remaining },
            { extra: { selectedClipId: null, selectedClipIds: [], selectedKeyId: null } },
          )
          s.notify(`Đã xoá ${delSet.size} clip`, 'info')
        } else if (s.selectedClipId) {
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

    holdTimelineTargets() {
      if (timelineCommandedIds.size === 0) return
      const ids = [...timelineCommandedIds]
      timelineCommandedIds.clear()
      // The IDs already include any peers expanded when the move was sent.
      void getBridge().command({ type: 'stop', ids })
    },

    async sendCommand(cmd, opts) {
      if (opts?.source && get().activeTab !== opts.source) return { ok: false }
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
      if (effectiveCmd.type === 'move') {
        for (const id of effectiveCmd.ids) {
          if (opts?.source === 'timeline') timelineCommandedIds.add(id)
          else timelineCommandedIds.delete(id)
        }
      } else if (effectiveCmd.type === 'stop' && Array.isArray(effectiveCmd.ids)) {
        for (const id of effectiveCmd.ids) timelineCommandedIds.delete(id)
      } else if (effectiveCmd.type === 'stop' || effectiveCmd.type === 'estop' || (effectiveCmd.type === 'lock' && effectiveCmd.locked)) {
        timelineCommandedIds.clear()
      }
      const res = await getBridge().command(effectiveCmd)
      if (!res.ok && res.message) {
        get().notify(res.message, 'error', { title: 'Không thể thực thi', icon: 'error' })
      } else if (!opts?.quietWarnings && res.warnings?.length) {
        get().notify(res.warnings[0], 'warn', { title: 'Giới hạn an toàn', icon: 'warn' })
      } else if (res.ok) {
        if (effectiveCmd.type === 'estop') {
          get().notify('Đã dừng khẩn cấp và khoá toàn bộ đầu ra DMX', 'error', {
            title: 'E-Stop kích hoạt',
            icon: 'estop',
          })
        } else if (effectiveCmd.type === 'stop' && effectiveCmd.ids === 'all') {
          get().notify('Đã dừng toàn bộ chuyển động hiện tại', 'info', {
            title: 'Đã dừng',
            icon: 'stopped',
          })
        } else if (effectiveCmd.type === 'lock') {
          get().notify(
            effectiveCmd.locked ? 'Hệ thống đã chuyển sang chế độ khoá an toàn' : 'Đã mở khoá điều khiển đầu ra DMX',
            effectiveCmd.locked ? 'info' : 'success',
            { title: effectiveCmd.locked ? 'Khoá an toàn' : 'Mở khoá DMX', icon: effectiveCmd.locked ? 'stopped' : 'running' },
          )
        }
      }
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
      let res
      try {
        res = await getBridge().saveProjectFile(get().project)
      } catch (err) {
        reportSaveError(err)
        return
      }
      if (res.saved) {
        set({ projectFilePath: res.filePath, dirty: false })
        get().notify('Đã lưu file dự án hiện tại', 'success', { title: 'Lưu dự án', icon: 'save' })
      }
    },

    async saveAsProject() {
      let res
      try {
        res = await getBridge().saveProjectAs(get().project)
      } catch (err) {
        reportSaveError(err)
        return
      }
      if (res.saved) {
        set({ projectFilePath: res.filePath, dirty: false })
        get().notify('Đã lưu dự án sang file mới', 'success', { title: 'Lưu thành file mới', icon: 'save' })
      }
    },

    async exportProject() {
      const ok = await getBridge().exportProject(get().project)
      if (ok) get().notify('Đã xuất file dự án thành công', 'success', { title: 'Xuất dự án', icon: 'save' })
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
