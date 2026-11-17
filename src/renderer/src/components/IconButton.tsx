import { motion } from 'motion/react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  icon: LucideIcon
  label: string // tooltip + aria-label
  onClick?: () => void
  variant?: 'brand' | 'ghost' | 'danger'
  iconOnly?: boolean
  children?: ReactNode
}

const styles = {
  brand: 'kiln-btn kiln-btn-primary',
  ghost: 'kiln-btn',
  danger: 'kiln-btn kiln-btn-danger',
}

/** Nút icon dạng pill chuẩn Kiln, có tooltip (title) và animation nhấn. */
export function IconButton({ icon: Icon, label, onClick, variant = 'ghost', iconOnly = false, children }: Props) {
  return (
    <motion.button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={`${iconOnly ? 'h-[34px] w-[34px] px-0' : 'h-8 px-3.5'} text-xs ${styles[variant]}`}
    >
      <Icon size={16} aria-hidden />
      {children}
    </motion.button>
  )
}
