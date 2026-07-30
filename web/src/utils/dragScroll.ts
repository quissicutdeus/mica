/**
 * Attaches mouse & touch drag-to-scroll functionality to a container element.
 * Recursively delegates drag scrolling to whichever scrollable child element is under the cursor.
 */
export function enableDragScroll(container: HTMLElement): () => void {
  let isPointerDown = false;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialScrollTop = 0;
  let initialScrollLeft = 0;
  let activeScrollableElement: HTMLElement | null = null;

  function findScrollableParent(target: HTMLElement | null): HTMLElement | null {
    let curr: HTMLElement | null = target;
    while (curr && curr !== container) {
      const style = window.getComputedStyle(curr);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollableY = (overflowY === "auto" || overflowY === "scroll") && curr.scrollHeight > curr.clientHeight;
      const isScrollableX = (overflowX === "auto" || overflowX === "scroll") && curr.scrollWidth > curr.clientWidth;

      if (isScrollableY || isScrollableX) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  function handlePointerDown(e: MouseEvent) {
    if (e.button !== 0) return; // Only left click drag

    const target = e.target as HTMLElement;
    // Don't drag scroll if interacting with form inputs or buttons directly
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable
    ) {
      return;
    }

    const scrollable = findScrollableParent(target);
    if (!scrollable) return;

    activeScrollableElement = scrollable;
    isPointerDown = true;
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;
    initialScrollTop = scrollable.scrollTop;
    initialScrollLeft = scrollable.scrollLeft;

    window.addEventListener("mousemove", handlePointerMove, { passive: false });
    window.addEventListener("mouseup", handlePointerUp, { capture: true, once: true });
  }

  function handlePointerMove(e: MouseEvent) {
    if (!isPointerDown || !activeScrollableElement) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    if (!isDragging && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
      isDragging = true;
    }

    if (isDragging) {
      e.preventDefault();
      activeScrollableElement.scrollTop = initialScrollTop - deltaY;
      activeScrollableElement.scrollLeft = initialScrollLeft - deltaX;
    }
  }

  function handlePointerUp(e: MouseEvent) {
    if (isDragging) {
      // Prevent click trigger on drag release
      const captureClick = (clickEvent: MouseEvent) => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
      };
      window.addEventListener("click", captureClick, { capture: true, once: true });
    }

    isPointerDown = false;
    isDragging = false;
    activeScrollableElement = null;
    window.removeEventListener("mousemove", handlePointerMove);
  }

  container.addEventListener("mousedown", handlePointerDown);

  return () => {
    container.removeEventListener("mousedown", handlePointerDown);
    window.removeEventListener("mousemove", handlePointerMove);
  };
}
