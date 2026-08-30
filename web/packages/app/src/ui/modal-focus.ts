/** Keyboard ownership for the two system dialogs. Escape is intentionally not handled here. */
export interface ModalFocus {
  setVisible(visible: boolean): void;
}

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableChildren(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (item) => item.closest('[hidden]') === null,
  );
}

export function createModalFocus(root: HTMLElement, initial: HTMLElement): ModalFocus {
  let restoreFocus: HTMLElement | null = null;
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || root.hidden) return;
    const focusable = focusableChildren(root);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return {
    setVisible(visible) {
      if (visible === !root.hidden) return;
      if (visible) {
        restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        root.hidden = false;
        initial.focus();
      } else {
        root.hidden = true;
        if (restoreFocus?.isConnected) restoreFocus.focus();
        restoreFocus = null;
      }
    },
  };
}
