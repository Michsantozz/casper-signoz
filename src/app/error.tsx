"use client";

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-(--thread-frame-outer) px-4 font-sans text-foreground">
      <section className="w-full max-w-md rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>runtime · error</span>
          <span>casper</span>
        </div>
        <div className="flex flex-col gap-4 rounded-[5px] border bg-background p-6 text-center">
          <div>
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The page could not be loaded. You can safely try again.
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="self-center rounded-[5px] border bg-background px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            try again
          </button>
        </div>
      </section>
    </main>
  );
}
