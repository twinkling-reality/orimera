/**
 * A three-function DOM helper.
 *
 * `landing` has one of these and this package may not import it: the boundary contract keeps the
 * signed-out surface free of everything this package depends on, and inverting that to share
 * twenty lines would put a renderer in the landing page's dependency graph. Duplicating a helper
 * with no rules in it is the cheaper of the two, and it is recorded here so the duplication is a
 * decision rather than an oversight.
 */

type Attributes = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace a node's children in one step, so a re-render cannot leave half the old view behind. */
export function replace(node: Element, children: readonly (Node | string)[]): void {
  clear(node);
  node.append(...children);
}
