import { setupServer } from "msw/node"

// No handlers registered at build time — tests add them ad-hoc if needed.
export const server = setupServer()
