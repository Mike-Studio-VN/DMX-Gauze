import { CHANNELS_PER_MODULE, DMX_UNIVERSE_SIZE, addressRange, isValidStartAddress, rangesOverlap } from './dmx'
import type { Layer, ModuleCfg } from './types'

/** Thứ tự module: theo lớp, rồi theo thứ tự trong mảng. */
export function orderedModules(layers: Layer[], modules: ModuleCfg[]): ModuleCfg[] {
  return layers.flatMap((l) => modules.filter((m) => m.layerId === l.id))
}

/** Tự gán địa chỉ liên tiếp từ 1, mỗi module 4 kênh. */
export function autoAssign(layers: Layer[], modules: ModuleCfg[]): ModuleCfg[] {
  const addr = new Map<string, number>()
  let next = 1
  for (const m of orderedModules(layers, modules)) {
    addr.set(m.id, next)
    next += CHANNELS_PER_MODULE
  }
  return modules.map((m) => ({ ...m, startAddress: addr.get(m.id) ?? m.startAddress }))
}

export function findConflict(modules: ModuleCfg[], id: string, start: number): ModuleCfg | null {
  return modules.find((m) => m.id !== id && rangesOverlap(m.startAddress, start)) ?? null
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

/** Module id → tên các module đang trùng địa chỉ. */
export function conflictMap(modules: ModuleCfg[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of modules) {
    for (const b of modules) {
      if (a.id !== b.id && rangesOverlap(a.startAddress, b.startAddress)) {
        out.set(a.id, [...(out.get(a.id) ?? []), b.name])
      }
    }
  }
  return out
}
