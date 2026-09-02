/**
 * Desde Bridge — DOM event simulation
 *
 * Extracted verbatim from `comment-bridge.ts`. Pure: fires a full realistic
 * pointer/mouse/click sequence on an element so flow playback and screenshot
 * replay drive the app the way a real user would. Browser globals only.
 */

export function simulateClick(el: HTMLElement): void {
  if (el.tagName === "INPUT") {
    const triggerWrapper = el.closest(".popover-trigger-wrapper") as HTMLElement | null
    if (triggerWrapper) {
      el = triggerWrapper
    }
  }

  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2

  const shared = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y }

  const downPointer: PointerEventInit = { ...shared, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }
  const upPointer: PointerEventInit = { ...shared, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }
  const downMouse: MouseEventInit = { ...shared, button: 0, buttons: 1, detail: 1 }
  const upMouse: MouseEventInit = { ...shared, button: 0, buttons: 0, detail: 1 }
  const clickOpts: MouseEventInit = { ...shared, button: 0, buttons: 0, detail: 1 }

  el.dispatchEvent(new PointerEvent("pointerover", downPointer))
  el.dispatchEvent(new MouseEvent("mouseover", downMouse))
  el.dispatchEvent(new PointerEvent("pointerenter", { ...downPointer, bubbles: false }))
  el.dispatchEvent(new MouseEvent("mouseenter", { ...downMouse, bubbles: false }))
  el.focus()
  el.dispatchEvent(new PointerEvent("pointerdown", downPointer))
  el.dispatchEvent(new MouseEvent("mousedown", downMouse))
  el.dispatchEvent(new PointerEvent("pointerup", upPointer))
  el.dispatchEvent(new MouseEvent("mouseup", upMouse))
  el.dispatchEvent(new MouseEvent("click", clickOpts))
}
