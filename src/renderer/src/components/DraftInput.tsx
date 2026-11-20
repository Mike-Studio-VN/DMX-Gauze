import { useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { clamp } from '@shared/convert'

type InputProps = Omit<ComponentPropsWithoutRef<'input'>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown'>

interface DraftInputProps<T> extends InputProps {
  value: string
  parse: (draft: string) => T | null
  onCommit: (value: T) => void
  onDraftChange?: () => void
  onSettled?: () => void
  stepOnArrow?: boolean
}

export function DraftInput<T>({
  value, parse, onCommit, onDraftChange, onSettled, stepOnArrow, onFocus, onMouseDown, onMouseUp, ...props
}: DraftInputProps<T>) {
  const [draft, setDraft] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const mouseFocusing = useRef(false)

  const edit = (raw: string) => {
    draftRef.current = raw
    setDraft(raw)
    onDraftChange?.()
  }

  const finish = (commit: boolean) => {
    const raw = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (commit && raw !== null && raw !== value && raw.trim()) {
      const parsed = parse(raw)
      if (parsed !== null) onCommit(parsed)
    }
  }

  return (
    <input
      {...props}
      type="text"
      value={draft ?? value}
      onMouseDown={(event) => {
        const input = event.currentTarget
        mouseFocusing.current = event.button === 0 && !props.readOnly && !props.disabled &&
          input.ownerDocument.activeElement !== input
        onMouseDown?.(event)
      }}
      onMouseUp={(event) => {
        if (mouseFocusing.current) event.preventDefault()
        mouseFocusing.current = false
        onMouseUp?.(event)
      }}
      onFocus={(event) => {
        if (props.readOnly || props.disabled) return
        event.currentTarget.select()
        onFocus?.(event)
      }}
      onChange={(event) => {
        if (props.readOnly || props.disabled) return
        edit(event.currentTarget.value)
      }}
      onBlur={() => {
        mouseFocusing.current = false
        finish(!props.disabled && !props.readOnly)
        onSettled?.()
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || props.readOnly || props.disabled) return
        if (stepOnArrow && props.step !== 'any' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          // Reuse native step alignment and precision without constraining what can be typed.
          const control = event.currentTarget.ownerDocument.createElement('input')
          control.type = 'number'
          if (props.min !== undefined) control.min = String(props.min)
          if (props.max !== undefined) control.max = String(props.max)
          if (props.step !== undefined) control.step = String(props.step)
          const number = parseDraftNumber(draft ?? value)
          if (number !== null) control.value = String(number)
          if (event.key === 'ArrowUp') control.stepUp()
          else control.stepDown()
          event.preventDefault()
          event.stopPropagation()
          edit(control.value)
          return
        }
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        finish(event.key === 'Enter')
        onSettled?.()
      }}
    />
  )
}

export function parseDraftNumber(raw: string): number | null {
  const normalized = raw.trim().replace(',', '.')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

interface NumberFieldProps extends Omit<DraftInputProps<number>, 'value' | 'parse' | 'stepOnArrow'> {
  value: number | string | null | undefined
  integer?: 'round' | 'truncate' | 'reject'
}

export function NumberField({ value, min, max, integer, ...props }: NumberFieldProps) {
  return (
    <DraftInput
      {...props}
      min={min}
      max={max}
      inputMode="decimal"
      stepOnArrow
      value={value == null ? '' : String(value)}
      parse={(raw) => {
        const num = parseDraftNumber(raw)
        if (num === null) return null
        const rounded = integer === 'round' ? Math.round(num) : integer === 'truncate' ? Math.trunc(num) : num
        const bounded = clamp(rounded, min === undefined ? -Infinity : Number(min), max === undefined ? Infinity : Number(max))
        return integer === 'reject' && !Number.isInteger(bounded) ? null : bounded
      }}
    />
  )
}
