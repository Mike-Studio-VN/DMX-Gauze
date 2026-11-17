import { motion } from 'motion/react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  icon: LucideIcon
  label: string // tooltip + aria-label
  onClick?: () => void
  variant?: 'brand' | 'ghost' | 'danger'
  children?: ReactNode
}

const styles = {
  brand: 'bg-brand text-brand-fg hover:brightness-110',
  ghost: 'bg-panel-2 text-fg hover:bg-line',
  danger: 'bg-danger text-black hover:brightness-110',
}

/** Nút icon có tooltip (title) và animation nhấn: co nhẹ khi bấm. */
export function IconButton({ icon: Icon, label, onClick, variant = 'ghost', children }: Props) {
  return (
    <motion.button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={`inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-ui px-3 font-medium ${styles[variant]}`}
    >
      <Icon size={20} aria-hidden />
      {children}
    </motion.button>
  )
}
