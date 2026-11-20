import { useCallback, type ComponentPropsWithoutRef } from 'react'

type CheckState = 'unchecked' | 'checked' | 'mixed'

/** Also used as the decorative mark on the tree's bulk selection button. */
export function CheckMark({ state }: { state: CheckState }) {
  return (
    <svg className="kiln-check-mark" data-check-state={state} viewBox="0 0 16 16" aria-hidden="true">
      <path className="kiln-check-tick" d="m3.5 8 3 3 6-6" />
      <path className="kiln-check-dash" d="M4 8h8" />
    </svg>
  )
}

type CheckboxProps = Pick<ComponentPropsWithoutRef<'input'>, 'disabled' | 'onChange'> & {
  checked: boolean
  mixed?: boolean
}

export function KilnCheckbox({ checked, mixed = false, disabled, onChange }: CheckboxProps) {
  const setInput = useCallback((input: HTMLInputElement | null) => {
    if (input) input.indeterminate = mixed
  }, [mixed])

  return (
    <span className="kiln-checkbox">
      <input
        ref={setInput}
        type="checkbox"
        checked={checked}
        aria-checked={mixed ? 'mixed' : checked}
        disabled={disabled}
        onChange={onChange}
      />
      <CheckMark state={mixed ? 'mixed' : checked ? 'checked' : 'unchecked'} />
    </span>
  )
}
