import { useEffect, useId, useRef, type ReactNode } from 'react'

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** Label of the affirmative button (default "Continue"). */
  confirmLabel?: string;
  /** Label of the cancel button; null renders a single-button notice. */
  cancelLabel?: string | null;
  onConfirm: () => void;
  onCancel?: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one modal surface of the tool: soft-limit confirmations ("this file is
 * large, continue?") and notices that used to be window.alert. Accessible by
 * construction: role dialog with aria-modal, labelled by its title and
 * described by its body, focus moved inside on open (the least destructive
 * button first) and trapped while open, Escape and the backdrop cancel, and
 * focus returns to the control that opened it. Styled from the theme tokens
 * so it follows the light and dark themes. Never window.alert or confirm:
 * those block the worker and look foreign.
 */
export function ConfirmDialog({ open, title, children, confirmLabel = 'Continue', cancelLabel = 'Cancel', onConfirm, onCancel }: ConfirmDialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const dismiss = onCancel ?? onConfirm;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const head = items[0], tail = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === head || !box.current.contains(document.activeElement))) { e.preventDefault(); tail.focus(); }
      else if (!e.shiftKey && (document.activeElement === tail || !box.current.contains(document.activeElement))) { e.preventDefault(); head.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
    // dismiss is re-created per render; the trap only needs re-arming on open/close
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className="dlg-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} ref={box}>
        <h2 id={`${id}-title`}>{title}</h2>
        <div id={`${id}-body`} className="dlg-body">{children}</div>
        <div className="dlg-actions">
          {cancelLabel !== null && <button type="button" onClick={onCancel} data-autofocus="true">{cancelLabel}</button>}
          <button type="button" className="primary" onClick={onConfirm} data-autofocus={cancelLabel === null ? 'true' : undefined}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
