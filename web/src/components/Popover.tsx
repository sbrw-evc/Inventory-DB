import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  anchor: RefObject<HTMLElement | null> | DOMRect | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
  /** Match the anchor's width at least. */
  matchWidth?: boolean;
  offset?: number;
}

/** A floating panel positioned below its anchor; closes on outside click and Escape. */
export function Popover({ anchor, onClose, children, align = 'start', className, matchWidth, offset = 4 }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth?: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor instanceof DOMRect ? anchor : anchor?.current?.getBoundingClientRect();
      if (!rect) return;
      const el = ref.current;
      const w = el?.offsetWidth ?? 240;
      const h = el?.offsetHeight ?? 200;
      let left = align === 'end' ? rect.right - w : rect.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = rect.bottom + offset;
      if (top + h > window.innerHeight - 8 && rect.top - h - offset > 8) top = rect.top - h - offset;
      top = Math.max(8, Math.min(top, window.innerHeight - Math.min(h, window.innerHeight - 16) - 8));
      setPos({ top, left, minWidth: matchWidth ? rect.width : undefined });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, align, matchWidth, offset]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (!(anchor instanceof DOMRect) && anchor?.current?.contains(target)) return;
      // Clicks inside a popover/modal opened after (on top of) this one shouldn't close it.
      const el = target instanceof Element ? target : target.parentElement;
      const layer = el?.closest('.popover, .modal-backdrop');
      if (layer && ref.current && ref.current.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        const all = document.querySelectorAll('.popover');
        if (all[all.length - 1] === ref.current) {
          e.preventDefault();
          e.stopPropagation();
          closeRef.current();
        }
      }
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className ?? ''}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: pos?.minWidth, visibility: pos ? 'visible' : 'hidden' }}
      // Portals bubble React events to their owner; keep them inside the popover.
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Button + popover pair. */
export function Dropdown({
  label,
  buttonClassName = 'tb-btn',
  children,
  align,
  className,
  disabled,
  title,
  active,
}: {
  label: ReactNode;
  buttonClassName?: string;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
  disabled?: boolean;
  title?: string;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${buttonClassName} ${open || active ? 'is-active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)} align={align} className={className}>
          {children(() => setOpen(false))}
        </Popover>
      )}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button type="button" className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="menu-item-icon">{icon}</span>
      <span className="menu-item-label">{children}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
    </button>
  );
}

export const MenuDivider = () => <div className="menu-divider" />;
