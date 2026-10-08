import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, kind: Toast['kind'] = 'info', ttl = 4000) {
  const t = { id: nextId++, kind, text };
  toasts = [...toasts, t].slice(-5);
  emit();
  setTimeout(() => dismissToast(t.id), ttl);
}

export function toastError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  toast(msg || 'Something went wrong', 'error', 6000);
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function Toasts() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
