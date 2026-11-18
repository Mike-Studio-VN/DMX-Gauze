import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface KilnSelectOption {
  value: string
  label: string
  description?: string
  badge?: string
  group?: string
  icon?: ReactNode
  disabled?: boolean
}

export interface KilnSelectProps {
  value: string
  options: KilnSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  placeholder?: string
  size?: 'sm' | 'md'
  tabular?: boolean
  defaultOpen?: boolean
  disabled?: boolean
}

interface MenuCoords {
  left: number
  top: number
  width: number
  maxHeight: number
  openUp: boolean
}

export function KilnSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Chọn...',
  size = 'md',
  tabular = false,
  defaultOpen = false,
  disabled = false,
}: KilnSelectProps) {
  const [menuOpen, setOpen] = useState(defaultOpen)
  const open = menuOpen && !disabled
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const [coords, setCoords] = useState<MenuCoords | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  )
  const hasRichRows = useMemo(
    () => options.some((o) => Boolean(o.icon) || Boolean(o.description)),
    [options],
  )

  const groupedSections = useMemo(() => {
    const sections: Array<{ group?: string; items: Array<{ opt: KilnSelectOption; idx: number }> }> = []
    const byGroup = new Map<string | undefined, Array<{ opt: KilnSelectOption; idx: number }>>()
    options.forEach((opt, idx) => {
      const key = opt.group
      let bucket = byGroup.get(key)
      if (!bucket) {
        bucket = []
        byGroup.set(key, bucket)
        sections.push({ group: key, items: bucket })
      }
      bucket.push({ opt, idx })
    })
    return sections
  }, [options])

  const updateCoords = () => {
    const el = triggerRef.current
    if (!el || typeof window === 'undefined') return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const spaceAbove = rect.top - 12
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow
    const maxHeight = Math.max(140, Math.min(340, openUp ? spaceAbove : spaceBelow))
    setCoords({
      left: rect.left,
      top: openUp ? rect.top - 6 : rect.bottom + 6,
      width: rect.width,
      maxHeight,
      openUp,
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    updateCoords()
  }, [open, options.length])

  useEffect(() => {
    if (disabled) {
      setOpen(false)
      return
    }
    if (!open || typeof window === 'undefined') return
    const selectedIdx = options.findIndex((o) => o.value === value && !o.disabled)
    setHighlightIdx(selectedIdx >= 0 ? selectedIdx : 0)

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onReposition = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      updateCoords()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [disabled, open, options, value])

  const choose = (opt: KilnSelectOption) => {
    if (disabled || opt.disabled) return
    onChange(opt.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const moveHighlight = (step: 1 | -1) => {
    if (options.length === 0) return
    let next = highlightIdx
    for (let i = 0; i < options.length; i += 1) {
      next = (next + step + options.length) % options.length
      if (!options[next]?.disabled) {
        setHighlightIdx(next)
        return
      }
    }
  }

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
      } else {
        moveHighlight(e.key === 'ArrowDown' ? 1 : -1)
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (open && highlightIdx >= 0 && options[highlightIdx]) {
        e.preventDefault()
        choose(options[highlightIdx])
      }
    }
  }

  const heightCls = size === 'sm' ? 'h-8 px-2.5' : 'h-9 px-3'

  const menuNode = open ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      style={
        coords
          ? {
              position: 'fixed',
              left: coords.left,
              top: coords.top,
              minWidth: Math.max(coords.width, hasRichRows ? 260 : coords.width),
              maxWidth: Math.max(coords.width, 360),
              maxHeight: coords.maxHeight,
              transform: coords.openUp ? 'translateY(-100%)' : undefined,
            }
          : undefined
      }
      className="kiln-select-menu z-[90] overflow-y-auto rounded-2xl bg-[#120D09]/98 p-1.5 shadow-[0_22px_50px_rgba(0,0,0,0.82),inset_0_0_0_1px_var(--line2)] backdrop-blur-md"
    >
      {groupedSections.map((section, secIdx) => (
        <div key={section.group ?? `sec-${secIdx}`} className={secIdx > 0 && section.group ? 'mt-1.5' : undefined}>
          {section.group && (
            <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--t3)] uppercase">
              {section.group}
            </div>
          )}
          <div className="space-y-0.5">
            {section.items.map(({ opt, idx }) => {
              const isSelected = opt.value === value
              const isHighlighted = idx === highlightIdx
              return (
                <button
                  key={`${opt.value}-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => choose(opt)}
                  className={`flex w-full items-center gap-2.5 rounded-xl text-left transition ${
                    hasRichRows ? 'px-2.5 py-2' : 'px-2.5 py-1.5'
                  } ${
                    opt.disabled
                      ? 'cursor-not-allowed opacity-45'
                      : 'cursor-pointer'
                  } ${
                    isSelected
                      ? 'bg-[rgba(247,132,46,0.12)] shadow-[inset_0_0_0_1px_rgba(247,132,46,0.52)]'
                      : isHighlighted
                        ? 'bg-white/[0.07]'
                        : 'hover:bg-white/[0.05]'
                  }`}
                >
                  {opt.icon && (
                    <span
                      aria-hidden="true"
                      className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                        isSelected
                          ? 'bg-[rgba(247,132,46,0.22)] text-[#FFB26B]'
                          : 'bg-white/[0.06] text-[var(--t3)]'
                      }`}
                    >
                      {opt.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`truncate font-semibold ${hasRichRows ? 'text-[12.5px]' : 'text-xs'} ${
                          tabular ? 'tabular-nums' : ''
                        } ${isSelected ? 'text-[#FFB26B]' : 'text-[var(--t1)]'}`}
                      >
                        {opt.label}
                      </span>
                      {opt.badge && (
                        <span className="shrink-0 rounded-md bg-white/[0.1] px-1.5 py-0.5 text-[10px] font-semibold text-[#D2C2B3]">
                          {opt.badge}
                        </span>
                      )}
                    </span>
                    {opt.description && (
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--t3)]">
                        {opt.description}
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <Check size={14} className="ml-auto shrink-0 text-[#FFB26B]" aria-hidden="true" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  ) : null

  const canPortal =
    coords !== null &&
    typeof Element !== 'undefined' &&
    typeof document !== 'undefined' &&
    document.body instanceof Element

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
        className={`kiln-field flex w-full items-center gap-2 text-left text-xs transition ${heightCls} ${disabled ? 'cursor-default' : 'cursor-pointer'} ${
          open ? '!bg-[#1b130f] !shadow-[inset_0_0_0_1.5px_var(--acc)]' : !disabled ? 'hover:bg-white/[0.04]' : ''
        }`}
      >
        {selectedOption?.icon && (
          <span
            aria-hidden="true"
            className={`shrink-0 ${open ? 'text-[#FFB26B]' : 'text-[var(--t2)]'}`}
          >
            {selectedOption.icon}
          </span>
        )}
        <span
          className={`min-w-0 flex-1 truncate font-medium ${tabular ? 'tabular-nums' : ''} ${
            selectedOption && !disabled ? 'text-[var(--t1)]' : 'text-[var(--t3)]'
          }`}
        >
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-[var(--t3)] transition-transform duration-150 ${
            open ? 'rotate-180 text-[#FFB26B]' : ''
          }`}
        />
      </button>
      {menuNode && (canPortal ? createPortal(menuNode, document.body) : menuNode)}
    </div>
  )
}
