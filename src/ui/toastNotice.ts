import type { ToastRecovery } from './errorNotices';
export const TOAST_LIMIT = 5;
// White for information, green for success, orange for warnings, red for errors.
export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface ToastNotice {
  readonly id: string;
  readonly message: string;
  readonly kind: ToastKind;
  readonly recovery?: readonly ToastRecovery[];
}
