"use client";

import { TooltipIconButton } from "@/shared/ui/assistant-ui/tooltip-icon-button";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import {
  AuiIf,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
} from "@assistant-ui/react";
import { ArchiveIcon, PlusIcon, Trash2Icon, MessagesSquareIcon } from "lucide-react";

/**
 * Sidebar list of the user's chat threads (conversations). Styled to match the
 * project's EvilCharts / terminal identity: mono uppercase section header,
 * pulse dot, 5px radii, accent-primary active state. Renders under
 * `AssistantRuntimeProvider` with a remote-thread-list runtime, so
 * `New`/`Trigger`/`Archive`/`Delete` drive the real backend via our
 * RemoteThreadListAdapter.
 */
export const ThreadList: React.FC = () => {
  return (
    <div className="flex h-full flex-col gap-2">
      {/* section header — mono uppercase + status dot */}
      <div className="flex items-center justify-between px-1.5 pt-0.5">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <MessagesSquareIcon className="size-3.5" />
          conversations
        </span>
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
        />
      </div>

      <ThreadListPrimitive.Root className="flex flex-col items-stretch gap-1">
        <ThreadListNew />
        <AuiIf condition={(s) => s.threads.isLoading}>
          <ThreadListSkeleton />
        </AuiIf>
        <AuiIf condition={(s) => !s.threads.isLoading}>
          <ThreadListItems />
        </AuiIf>
      </ThreadListPrimitive.Root>
    </div>
  );
};

const ThreadListNew: React.FC = () => {
  return (
    <ThreadListPrimitive.New
      render={
        <Button
          variant="ghost"
          className="flex items-center justify-start gap-2 rounded-[5px] border border-dashed border-border px-2.5 py-2 font-mono text-[12px] font-normal text-foreground transition-colors hover:border-(--thread-accent-primary) hover:bg-(--thread-accent-primary-soft) hover:text-(--thread-accent-primary)"
        >
          <PlusIcon className="size-4" />
          new chat
        </Button>
      }
    />
  );
};

const ThreadListSkeleton: React.FC = () => {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-[5px] bg-muted/60"
          aria-hidden
        />
      ))}
    </div>
  );
};

const ThreadListItems: React.FC = () => {
  return (
    <ThreadListPrimitive.Items>{() => <ThreadListItem />}</ThreadListPrimitive.Items>
  );
};

const ThreadListItem: React.FC = () => {
  return (
    <ThreadListItemPrimitive.Root className="group flex items-center gap-2 rounded-[5px] border border-transparent transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none data-active:border-border data-active:bg-(--thread-accent-primary-soft)">
      <ThreadListItemPrimitive.Trigger className="flex flex-1 items-center gap-2 truncate px-2.5 py-2 text-left text-sm text-foreground group-data-active:text-(--thread-accent-primary)">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-[1px] bg-muted-foreground/40 group-data-active:bg-(--thread-accent-primary)"
        />
        <ThreadListItemPrimitive.Title fallback="New Chat" />
      </ThreadListItemPrimitive.Trigger>
      <div className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <ThreadListItemPrimitive.Archive
          render={
            <TooltipIconButton
              tooltip="Archive"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArchiveIcon className="size-4" />
            </TooltipIconButton>
          }
        />
        <ThreadListItemPrimitive.Delete
          render={
            <TooltipIconButton
              tooltip="Delete"
              className={cn("text-muted-foreground hover:text-(--thread-accent-secondary)")}
            >
              <Trash2Icon className="size-4" />
            </TooltipIconButton>
          }
        />
      </div>
    </ThreadListItemPrimitive.Root>
  );
};
