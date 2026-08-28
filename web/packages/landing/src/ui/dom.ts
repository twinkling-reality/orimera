/**
 * A four-line element helper.
 *
 * The overlay is written as real DOM rather than as an HTML string because the canvas is
 * invisible to screen readers, so the overlay IS the accessibility surface
 * (interaction-model.md 2.6, 9). Every path on this page is a real focusable `button` or `a` with
 * a real accessible name, and building them as elements is what keeps that from drifting.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
