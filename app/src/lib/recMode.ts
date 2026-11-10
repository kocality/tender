// Record mode for the video: `#/?rec=1` (or `?rec=1` before the hash) switches to the light theme, an 18 px root font
// and hides the debug panels (CSS `[data-rec='1'] .debug-only`). `#/?rec=0` switches it off. The choice is remembered in
// localStorage, which can throw in a private window, so every access is guarded.

const KEY = 'tender:rec';

/** What the URL asks for: `true` / `false`, or `null` when it says nothing. */
export function recFromUrl(hash: string, search = ''): boolean | null {
  const q = hash.indexOf('?');
  const fromHash = new URLSearchParams(q === -1 ? '' : hash.slice(q + 1)).get('rec');
  const value = fromHash ?? new URLSearchParams(search).get('rec');
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function safeStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether record mode is on: the URL wins, otherwise the remembered choice. Remembers a new URL choice. */
export function resolveRec(hash: string, search = '', store: Store | null = safeStore()): boolean {
  const asked = recFromUrl(hash, search);
  try {
    if (asked === true) store?.setItem(KEY, '1');
    else if (asked === false) store?.removeItem(KEY);
    else return store?.getItem(KEY) === '1';
  } catch {
    // storage is optional
  }
  return asked === true;
}

/** Sets or clears the root attributes the stylesheet reads. */
export function applyRec(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) {
    root.dataset.rec = '1';
    root.dataset.theme = 'light';
  } else {
    delete root.dataset.rec;
    delete root.dataset.theme;
  }
}

/** Called once at start-up; follows later hash changes. */
export function startRecMode(): void {
  const sync = () => applyRec(resolveRec(window.location.hash, window.location.search));
  sync();
  window.addEventListener('hashchange', sync);
}
