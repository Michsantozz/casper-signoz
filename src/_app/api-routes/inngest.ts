import { createServe } from "@mastra/inngest";
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";

// Endpoint discovered by inngest-cli (pnpm dev:inngest -u .../api/inngest).
// Exposes the meeting workflows with their crons (auto-schedule, reconcile).
const serveNext = createServe(serve);
type InngestHandlers = ReturnType<typeof serveNext>;

let handlers: InngestHandlers | undefined;

async function getHandlers() {
  if (!handlers) {
    const { mastra } = await import("@/mastra");
    handlers = serveNext({ mastra, inngest });
  }
  return handlers;
}

export const GET: InngestHandlers["GET"] = async (...args) => {
  const currentHandlers = await getHandlers();
  return currentHandlers.GET(...args);
};

export const POST: InngestHandlers["POST"] = async (...args) => {
  const currentHandlers = await getHandlers();
  return currentHandlers.POST(...args);
};

export const PUT: InngestHandlers["PUT"] = async (...args) => {
  const currentHandlers = await getHandlers();
  return currentHandlers.PUT(...args);
};
