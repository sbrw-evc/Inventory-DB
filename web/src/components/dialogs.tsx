import { useState, useSyncExternalStore } from 'react';
import { Modal } from './Modal';

type Pending =
  | { kind: 'confirm'; id: number; title: string; message?: string; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; id: number; title: string; label?: string; initial?: string; placeholder?: string; confirmLabel?: string; resolve: (v: string | null) => void };

let stack: Pending[] = [];
let ids = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    stack = [...stack, { kind: 'confirm', id: ids++, ...opts, resolve }];
    emit();
  });
}

export function promptDialog(opts: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    stack = [...stack, { kind: 'prompt', id: ids++, ...opts, resolve }];
    emit();
  });
}

function close(id: number) {
  stack = stack.filter((p) => p.id !== id);
  emit();
}

function PromptBody({ p }: { p: Extract<Pending, { kind: 'prompt' }> }) {
  const [value, setValue] = useState(p.initial ?? '');
  const submit = () => {
    if (!value.trim()) return;
    p.resolve(value.trim());
    close(p.id);
  };
  const cancel = () => {
    p.resolve(null);
    close(p.id);
  };
  return (
    <Modal
      title={p.title}
      onClose={cancel}
      width={420}
      footer={
        <>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
            {p.confirmLabel ?? 'Save'}
          </button>
        </>
      }
    >
      {p.label && <label className="field-label">{p.label}</label>}
      <input
        className="input"
        autoFocus
        value={value}
        placeholder={p.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
    </Modal>
  );
}

export function DialogHost() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => stack,
  );
  return (
    <>
      {list.map((p) =>
        p.kind === 'prompt' ? (
          <PromptBody key={p.id} p={p} />
        ) : (
          <Modal
            key={p.id}
            title={p.title}
            width={420}
            onClose={() => {
              p.resolve(false);
              close(p.id);
            }}
            footer={
              <>
                <button
                  className="btn"
                  onClick={() => {
                    p.resolve(false);
                    close(p.id);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={`btn ${p.danger ? 'btn-danger' : 'btn-primary'}`}
                  autoFocus
                  onClick={() => {
                    p.resolve(true);
                    close(p.id);
                  }}
                >
                  {p.confirmLabel ?? 'Confirm'}
                </button>
              </>
            }
          >
            {p.message && <p className="muted">{p.message}</p>}
          </Modal>
        ),
      )}
    </>
  );
}
