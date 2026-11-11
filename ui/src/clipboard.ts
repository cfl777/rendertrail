/**
 * Copy text from inside the host's sandboxed iframe. The Clipboard API needs the host to allow
 * clipboard-write, so fall back to a hidden textarea and execCommand; false when both fail (the
 * card then shows the text to copy by hand).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not allowed here; try the older way.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
