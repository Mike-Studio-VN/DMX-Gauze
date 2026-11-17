import type { Fps } from './types'

export interface Tc {
  h: number
  m: number
  s: number
  f: number
}

export const FPS_OPTIONS: Fps[] = [24, 25, 29.97, 30]

export function nominalFps(fps: Fps): number {
  return fps === 29.97 ? 30 : fps
}

export function realFps(fps: Fps): number {
  return fps === 29.97 ? 30000 / 1001 : fps
}

export function isDropFrame(fps: Fps): boolean {
  return fps === 29.97
}

export function tcToFrames(tc: Tc, fps: Fps): number {
  const n = nominalFps(fps)
  const base = n * (3600 * tc.h + 60 * tc.m + tc.s) + tc.f
  if (!isDropFrame(fps)) return base
  const totalMin = 60 * tc.h + tc.m
  return base - 2 * (totalMin - Math.floor(totalMin / 10))
}

export function framesToTc(frames: number, fps: Fps): Tc {
  let n = Math.max(0, Math.floor(frames))
  const nom = nominalFps(fps)
  if (isDropFrame(fps)) {
    const d = Math.floor(n / 17982)
    const m = n % 17982
    n += 18 * d + (m >= 2 ? 2 * Math.floor((m - 2) / 1798) : 0)
  }
  return {
    f: n % nom,
    s: Math.floor(n / nom) % 60,
    m: Math.floor(n / (nom * 60)) % 60,
    h: Math.floor(n / (nom * 3600)),
  }
}

export function tcToSeconds(tc: Tc, fps: Fps): number {
  return tcToFrames(tc, fps) / realFps(fps)
}

export function secondsToTc(sec: number, fps: Fps): Tc {
  return framesToTc(Math.round(sec * realFps(fps)), fps)
}

const p2 = (n: number): string => String(n).padStart(2, '0')

export function formatTc(sec: number, fps: Fps): string {
  const t = secondsToTc(sec, fps)
  const sep = isDropFrame(fps) ? ';' : ':'
  return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)}${sep}${p2(t.f)}`
}

/** Nhận "hh:mm:ss:ff", cũng chấp nhận ';' hoặc '.', hoặc chuỗi chữ số liền. null nếu sai. */
export function parseTc(text: string, fps: Fps): number | null {
  const parts = text.trim().split(/[:;.]/)
  let nums: number[]
  if (parts.length === 1 && /^\d{1,8}$/.test(parts[0])) {
    const d = parts[0].padStart(8, '0')
    nums = [d.slice(0, 2), d.slice(2, 4), d.slice(4, 6), d.slice(6, 8)].map(Number)
  } else if (parts.length === 4 && parts.every((p) => /^\d{1,2}$/.test(p))) {
    nums = parts.map(Number)
  } else return null
  const [h, m, s, f] = nums
  if (m > 59 || s > 59 || f >= nominalFps(fps)) return null
  return tcToSeconds({ h, m, s, f }, fps)
}
