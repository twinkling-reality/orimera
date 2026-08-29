import { el } from './dom.js';

/**
 * The two things that are always on screen, and the state that decides what else is.
 *
 * **The reticle exists because Pointer Lock freezes the cursor.** The specification requires
 * `clientX`/`clientY` to hold constant while locked, so there is no cursor position in the world
 * and screen centre is the only aim point that can exist. Everything the user targets, they
 * target by turning their head.
 *
 * The way in is not discoverable on its own, but the prompt that says so belongs to the Companion
 * panel rather than here: it is one element that moves through "click to look around", "press X",
 * and the conversation itself, so the thing offering to talk is the thing that talked.
 *
 * **Escape is not handled anywhere in this file and must not be.** It has exactly one meaning
 * everywhere in Orimera: release the mouse. The browser owns it, the mode follows from the
 * `pointerlockchange` it causes, and reading the key here would be a bug rather than a shortcut.
 */

export type ShellMode = 'traverse' | 'converse';

export type CompanionSide = 'left' | 'right';

export interface WorldChrome {
  readonly reticle: HTMLElement;
  /** Which side the Companion and its words occupy. Remembered across sessions. */
  companionSide(): CompanionSide;
  toggleCompanionSide(): void;
  setMode(mode: ShellMode): void;
  mode(): ShellMode;
  /** Open or close the World Index. Releases the mouse first, because a summoned panel needs it. */
  toggleIndex(): void;
  indexOpen(): boolean;
}

export function buildWorldChrome(shell: HTMLElement): WorldChrome {
  const reticle = el('div', { class: 'reticle', 'aria-hidden': 'true' });
  let mode: ShellMode = 'converse';
  let open = false;
  shell.setAttribute('data-mode', mode);

  /**
   * Handedness, remembered.
   *
   * A single preference does not earn a settings screen, and a settings screen is more of the
   * interface this surface just had removed. It is stored rather than asked for, because which
   * side of your own screen you want a companion on is not a question worth interrupting anyone
   * with; it is a thing you flip once.
   */
  const SIDE_KEY = 'orimera.companion.side';
  let side: CompanionSide = readSide();
  shell.setAttribute('data-companion-side', side);

  function readSide(): CompanionSide {
    try {
      return window.localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right';
    } catch {
      // Storage can be unavailable outright. A default is a better answer than a broken boot.
      return 'right';
    }
  }

  return {
    reticle,
    companionSide: () => side,
    toggleCompanionSide() {
      side = side === 'right' ? 'left' : 'right';
      shell.setAttribute('data-companion-side', side);
      try {
        window.localStorage.setItem(SIDE_KEY, side);
      } catch {
        // Not remembered this session. The Companion still moves, which is what was asked for.
      }
    },
    mode: () => mode,
    setMode(next) {
      mode = next;
      shell.setAttribute('data-mode', next);
      // Taking the lock closes the index. Leaving it open would put a panel the user cannot
      // click over the world they just entered.
      if (next === 'traverse' && open) {
        open = false;
        shell.removeAttribute('data-index');
      }
    },
    indexOpen: () => open,
    toggleIndex() {
      open = !open;
      if (open) {
        shell.setAttribute('data-index', 'open');
        // Releasing the lock is always allowed. Re-taking it is not, which is why the way back
        // is a click on the world rather than anything this function could do.
        if (document.pointerLockElement !== null) document.exitPointerLock();
      } else {
        shell.removeAttribute('data-index');
      }
    },
  };
}
