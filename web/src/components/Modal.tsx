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
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const backdrop = panelRef.current?.parentElement;
      if (!backdrop) return;
      // Only the top-most layer closes; a popover or modal opened above this one handles Escape itself.
      const layers = document.querySelectorAll('.modal-backdrop, .popover');
      if (layers[layers.length - 1] !== backdrop) return;
      e.preventDefault();
      closeRef.current();
    };
    // Capture phase: React handlers inside the modal stop propagation of bubbling key events.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
