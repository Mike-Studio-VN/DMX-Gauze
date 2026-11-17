import { defaultLayerTransform, defaultModuleTransform } from './preset'
import type { Layer, ModuleCfg, Transform3D } from './types'

export const MODULE_GAP = 0.08
export const DEG2RAD = Math.PI / 180

/** Tính toạ độ X cơ sở (cục bộ theo Layer) cho từng module trong các layer. */
export function computeModuleBasePositions(layers: Layer[], modules: ModuleCfg[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const layer of layers) {
    const mods = modules.filter((m) => m.layerId === layer.id)
    const totalWidth = mods.reduce((acc, m) => acc + m.width, 0) + Math.max(0, mods.length - 1) * MODULE_GAP
    let cursor = -totalWidth / 2
    for (const mod of mods) {
      out.set(mod.id, cursor + mod.width / 2)
      cursor += mod.width + MODULE_GAP
    }
  }
  return out
}

function rotateX(v: [number, number, number], rad: number): [number, number, number] {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
}

function rotateY(v: [number, number, number], rad: number): [number, number, number] {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
}

function rotateZ(v: [number, number, number], rad: number): [number, number, number] {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
}

/** Áp dụng Transform3D (thứ tự Scale -> Euler XYZ -> Position, khớp với Three.js Object3D). */
export function transformPointByTransform3D(
  tf: Transform3D,
  localPt: [number, number, number],
): [number, number, number] {
  let p: [number, number, number] = [
    localPt[0] * tf.scale[0],
    localPt[1] * tf.scale[1],
    localPt[2] * tf.scale[2],
  ]
  p = rotateZ(p, tf.rotation[2] * DEG2RAD)
  p = rotateY(p, tf.rotation[1] * DEG2RAD)
  p = rotateX(p, tf.rotation[0] * DEG2RAD)
  return [
    Number((p[0] + tf.position[0]).toFixed(3)),
    Number((p[1] + tf.position[1]).toFixed(3)),
    Number((p[2] + tf.position[2]).toFixed(3)),
  ]
}

/** Biến đổi ngược từ World Position về toạ độ cục bộ trong hệ quy chiếu của Transform3D. */
export function inverseTransformPointByTransform3D(
  tf: Transform3D,
  worldPt: [number, number, number],
): [number, number, number] {
  let p: [number, number, number] = [
    worldPt[0] - tf.position[0],
    worldPt[1] - tf.position[1],
    worldPt[2] - tf.position[2],
  ]
  p = rotateX(p, -tf.rotation[0] * DEG2RAD)
  p = rotateY(p, -tf.rotation[1] * DEG2RAD)
  p = rotateZ(p, -tf.rotation[2] * DEG2RAD)
  const sx = Math.abs(tf.scale[0]) > 1e-6 ? tf.scale[0] : 1
  const sy = Math.abs(tf.scale[1]) > 1e-6 ? tf.scale[1] : 1
  const sz = Math.abs(tf.scale[2]) > 1e-6 ? tf.scale[2] : 1
  return [p[0] / sx, p[1] / sy, p[2] / sz]
}

/** Trả về World Position [X, Y, Z] của điểm treo module trong không gian 3D chung. */
export function getModuleWorldPosition(
  layer: Layer,
  layerIndex: number,
  mod: ModuleCfg,
  baseX: number,
): [number, number, number] {
  const ltf = layer.transform ?? defaultLayerTransform(layerIndex)
  const mtf = mod.transform ?? defaultModuleTransform()
  return transformPointByTransform3D(ltf, [baseX + mtf.position[0], 0, mtf.position[2]])
}

/** Quy đổi World Position mong muốn của module sang offset cục bộ [dx, 0, dz] lưu trong mod.transform.position. */
export function worldPositionToModuleOffset(
  layer: Layer,
  layerIndex: number,
  baseX: number,
  desiredWorld: [number, number, number],
): [number, number, number] {
  const ltf = layer.transform ?? defaultLayerTransform(layerIndex)
  const local = inverseTransformPointByTransform3D(ltf, desiredWorld)
  return [Number((local[0] - baseX).toFixed(3)), 0, Number(local[2].toFixed(3))]
}

export interface VisibilityNode {
  visible: boolean
  parent?: VisibilityNode | null
}

/** Chỉ trả về true khi bản thân node 3D và mọi ancestor (Module/Layer group) đều visible. */
export function isObjectEffectivelyVisible(node: VisibilityNode | null | undefined): boolean {
  let cur: VisibilityNode | null | undefined = node
  while (cur) {
    if (!cur.visible) return false
    cur = cur.parent
  }
  return true
}

/** Lấy hit đầu tiên trong kết quả raycast mà toàn bộ chuỗi ancestor đang hiển thị. */
export function pickFirstVisibleHit<T extends { object: VisibilityNode }>(hits: readonly T[]): T | null {
  for (const hit of hits) {
    if (isObjectEffectivelyVisible(hit.object)) return hit
  }
  return null
}
