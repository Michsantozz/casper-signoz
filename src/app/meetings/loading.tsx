export default function MeetingsLoading() {
  return (
    <main
      aria-busy
      aria-label="loading meetings"
      className="flex min-h-dvh items-center justify-center bg-(--thread-frame-outer) px-4"
    >
      <div className="w-full max-w-md rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center gap-2 px-2 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)" />
          loading · meetings
        </div>
        <div className="space-y-3 rounded-[5px] border bg-background p-5">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </main>
  );
}
