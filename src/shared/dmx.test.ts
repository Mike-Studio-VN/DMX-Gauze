import { describe, expect, it } from 'vitest'
import { addressRange, isValidStartAddress, rangesOverlap } from './dmx'

describe('dmx addressing', () => {
  it('module chiếm 4 kênh liên tiếp', () => {
    expect(addressRange(1)).toEqual([1, 4])
    expect(addressRange(45)).toEqual([45, 48])
  })

  it('giới hạn địa chỉ trong universe', () => {
    expect(isValidStartAddress(1)).toBe(true)
    expect(isValidStartAddress(509)).toBe(true)
    expect(isValidStartAddress(510)).toBe(false)
    expect(isValidStartAddress(0)).toBe(false)
    expect(isValidStartAddress(1.5)).toBe(false)
  })

  it('phát hiện chồng lấn dải kênh', () => {
    expect(rangesOverlap(1, 5)).toBe(false)
    expect(rangesOverlap(1, 4)).toBe(true)
    expect(rangesOverlap(5, 2)).toBe(true)
  })
})
