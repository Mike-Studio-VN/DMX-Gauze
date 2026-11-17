import { CHANNELS_PER_MODULE, DMX_UNIVERSE_SIZE, addressRange, isValidStartAddress, rangesOverlap } from './dmx'
import type { Layer, ModuleCfg } from './types'

/** Thứ tự module: theo lớp, rồi theo thứ tự trong mảng. */
export function orderedModules(layers: Layer[], modules: ModuleCfg[]): ModuleCfg[] {
  return layers.flatMap((l) => modules.filter((m) => m.layerId === l.id))
}

/** Kiểm tra hai module có được phép dùng chung đúng 4 kênh qua mode Loop DMX trong cùng Layer không. */
export function isAllowedDmxLoopPair(a: Pick<ModuleCfg, 'id' | 'layerId' | 'startAddress' | 'dmxLoop'>, b: Pick<ModuleCfg, 'id' | 'layerId' | 'startAddress' | 'dmxLoop'>): boolean {
  return (
    a.id !== b.id &&
    a.layerId === b.layerId &&
    a.startAddress === b.startAddress &&
    (Boolean(a.dmxLoop) || Boolean(b.dmxLoop))
  )
}

/** Địa chỉ DMX chung (4 kênh) của một Layer khi bật Loop DMX cho module. */
export function layerLoopAddress(modules: ModuleCfg[], layerId: string, excludeId?: string): number {
  const inLayer = modules.filter((m) => m.layerId === layerId && m.id !== excludeId)
  const anchor = inLayer.find((m) => !m.dmxLoop) ?? inLayer[0]
  return anchor?.startAddress ?? 1
}

/** Tự gán địa chỉ liên tiếp từ 1, mỗi module 4 kênh; module bật Loop DMX dùng chung 4 kênh của Layer. */
export function autoAssign(layers: Layer[], modules: ModuleCfg[]): ModuleCfg[] {
  const addr = new Map<string, number>()
  let next = 1
  for (const layer of layers) {
    const layerMods = modules.filter((m) => m.layerId === layer.id)
    const normalMods = layerMods.filter((m) => !m.dmxLoop)
    let layerBase = normalMods[0] ? next : undefined
    for (const m of normalMods) {
      addr.set(m.id, next)
      next += CHANNELS_PER_MODULE
    }
    const loopMods = layerMods.filter((m) => m.dmxLoop)
    if (loopMods.length > 0) {
      if (layerBase === undefined) {
        layerBase = next
        next += CHANNELS_PER_MODULE
      }
      for (const m of loopMods) {
        addr.set(m.id, layerBase)
      }
    }
  }
  return modules.map((m) => ({ ...m, startAddress: addr.get(m.id) ?? m.startAddress }))
}

export function findConflict(modules: ModuleCfg[], id: string, start: number): ModuleCfg | null {
  const target = modules.find((m) => m.id === id)
  const probe = {
    id,
    layerId: target?.layerId ?? '',
    startAddress: start,
    dmxLoop: target?.dmxLoop,
  }
  return modules.find((m) => m.id !== id && rangesOverlap(m.startAddress, start) && !isAllowedDmxLoopPair(probe, m)) ?? null
}

/** null nếu hợp lệ, ngược lại là thông báo lỗi (tiếng Việt). */
export function validateAddress(modules: ModuleCfg[], id: string, start: number): string | null {
  if (!Number.isInteger(start)) return 'Địa chỉ phải là số nguyên'
  if (!isValidStartAddress(start)) return `Địa chỉ hợp lệ: 1–${DMX_UNIVERSE_SIZE - CHANNELS_PER_MODULE + 1}`
  const c = findConflict(modules, id, start)
  if (c) {
    const [a, b] = addressRange(c.startAddress)
    return `Trùng kênh ${a}–${b} với "${c.name}"`
  }
  return null
}

/** Địa chỉ trống đầu tiên đủ chỗ cho 4 kênh. */
export function nextFree(modules: ModuleCfg[], excludeId?: string): number | null {
  const others = modules.filter((m) => m.id !== excludeId)
  for (let a = 1; isValidStartAddress(a); a += 1) {
    if (!others.some((m) => rangesOverlap(m.startAddress, a))) return a
  }
  return null
}

/** Module id → tên các module đang trùng địa chỉ (bỏ qua các module hợp lệ trong cùng Loop DMX). */
export function conflictMap(modules: ModuleCfg[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of modules) {
    for (const b of modules) {
      if (a.id !== b.id && rangesOverlap(a.startAddress, b.startAddress) && !isAllowedDmxLoopPair(a, b)) {
        out.set(a.id, [...(out.get(a.id) ?? []), b.name])
      }
    }
  }
  return out
}
