import type { LtcFrame } from '@shared/ltc'
import type { LtcReceptionStatus } from '../store/useAppStore'

export const ltcStatusLabels: Record<LtcReceptionStatus, string> = {
  off: 'Tắt',
  waiting: 'Đang chờ tín hiệu',
  lock: 'Đã khóa (Lock)',
  freewheel: 'Chạy trớn (Freewheel)',
  lost: 'Mất tín hiệu',
}

export function formatReceivedLtc(frame: LtcFrame): string {
  const [h, m, s, f] = [frame.h, frame.m, frame.s, frame.f].map((n) => String(n).padStart(2, '0'))
  return `${h}:${m}:${s}${frame.df ? ';' : ':'}${f}`
}

export function ltcInputError(error: unknown): string {
  switch (error instanceof Error || error instanceof DOMException ? error.name : '') {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Chưa có quyền micrô. Cho phép DMX Gauze truy cập micrô trong cài đặt hệ thống, rồi thử lại.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Không tìm thấy thiết bị thu đã chọn. Kiểm tra kết nối hoặc chọn thiết bị khác.'
    case 'NotReadableError':
    case 'AbortError':
      return 'Không mở được thiết bị thu. Kiểm tra thiết bị, đóng ứng dụng đang dùng micrô rồi thử lại.'
    default:
      return 'Không mở được ngõ thu LTC. Kiểm tra thiết bị và quyền micrô, rồi thử lại.'
  }
}
