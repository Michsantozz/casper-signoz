import "@testing-library/jest-dom/vitest"
import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

// jsdom doesn't implement the Web Animations API. Some UI primitives (@base-ui
// ScrollArea) poll `getAnimations()` on a timer; without the method the timer
// throws an uncaught TypeError. Stub it to "no animations in flight" — nothing
// animates in jsdom anyway.
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = function getAnimations() {
    return []
  }
}

// Observers jsdom doesn't ship — inert stubs so mounting components that reach
// for them doesn't throw. None observe anything real in jsdom.
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
    root = null
    rootMargin = ""
    thresholds = []
  } as unknown as typeof IntersectionObserver
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// Component layer runs in jsdom. Unmount the rendered tree after every test so
// DOM state never leaks between cases (Testing Library does not auto-cleanup
// under Vitest's globals-off setup).
afterEach(() => cleanup())
