import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
  /** Drawer slides in from the right instead of centering. */
  variant?: 'center' | 'drawer';
}

export function Modal({ title, onClose, children, footer, width = 520, className, variant = 'center' }: ModalProps) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Let inner popovers/editors consume Escape first.
        if (e.defaultPrevented) return;
        const stack = document.querySelectorAll('.modal-backdrop');
        if (stack[stack.length - 1] === panelRef.current?.parentElement) {
          e.stopPropagation();
          closeRef.current();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className={`modal-backdrop ${variant === 'drawer' ? 'modal-backdrop-drawer' : ''}`}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      // Portals bubble React events to their owner (e.g. a grid cell); keep them inside the modal.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
    >
      <div
        ref={panelRef}
        className={`modal ${variant === 'drawer' ? 'modal-drawer' : ''} ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
      >
        {title !== undefined && (
          <div className="modal-header">
            <div className="modal-title">{title}</div>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
