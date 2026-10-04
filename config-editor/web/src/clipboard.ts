/**
 * Clipboard helpers. The editor is a real contenteditable (CodeMirror 6), so the
 * browser's native selection handles, magnifier and long-press Cut/Copy/Paste menu
 * all work. These helpers back the explicit toolbar buttons and cover the cases where
 * the async clipboard API is unavailable (plain-http Home Assistant installs, Firefox).
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus?.();
  return ok;
}

/** Returns null when programmatic paste is not possible; the caller then asks the user to paste manually. */
export async function readText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText && window.isSecureContext) return await navigator.clipboard.readText();
  } catch {
    /* permission denied */
  }
  return null;
}
