import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { t } from '../i18n';
import { spring } from './shell/Brand';

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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
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
      <motion.div
        ref={panelRef}
        initial={variant === 'drawer' ? { x: 48, opacity: 0.4 } : { opacity: 0, y: 16, scale: 0.97 }}
        animate={variant === 'drawer' ? { x: 0, opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={variant === 'drawer' ? { type: 'spring', stiffness: 380, damping: 38 } : spring}
        className={`modal ${variant === 'drawer' ? 'modal-drawer' : ''} ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
      >
        {title !== undefined && (
          <div className="modal-header">
            <div className="modal-title">{title}</div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Close')}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
