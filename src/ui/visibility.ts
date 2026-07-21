/**
 * DOM work in extension settings should stop while SillyTavern's inline drawer
 * is collapsed. Checking ancestors matters because the child sections keep
 * their own `open` state while the outer drawer is hidden.
 */
export function isElementRendered(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }

  const view = element.ownerDocument.defaultView;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (view?.getComputedStyle) {
      const style = view.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') {
        return false;
      }
    }
  }

  // A collapsed inline drawer normally resolves to display:none above. The
  // geometry check also catches zero-layout containers during drawer closing.
  return Array.from(element.getClientRects()).some((rectangle) => (
    rectangle.width > 0 && rectangle.height > 0
  ));
}
