"use client";

import { GripVerticalIcon } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/shared/lib/utils";

/**
 * Resizable panels — wrapper fino sobre react-resizable-panels (v4:
 * Group / Panel / Separator). Style casada ao design EvilCharts do thread:
 * o handle usa a cor de borda do tema e um grip mono discreto.
 */

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border transition-colors",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        "hover:bg-(--thread-accent-primary) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--thread-accent-primary)",
        "data-[panel-group-orientation=vertical]:h-px data-[panel-group-orientation=vertical]:w-full",
        "data-[panel-group-orientation=vertical]:after:left-0 data-[panel-group-orientation=vertical]:after:h-1 data-[panel-group-orientation=vertical]:after:w-full data-[panel-group-orientation=vertical]:after:translate-x-0 data-[panel-group-orientation=vertical]:after:-translate-y-1/2",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-5 w-3 items-center justify-center rounded-[3px] border bg-(--thread-frame-outer)">
          <GripVerticalIcon className="size-3 text-muted-foreground" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
