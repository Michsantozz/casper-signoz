import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-(--thread-frame-outer) px-4 font-sans text-foreground">
      <section className="w-full max-w-md rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>404 · not found</span>
          <span>casper</span>
        </div>
        <div className="flex flex-col gap-4 rounded-[5px] border bg-background p-6 text-center">
          <div>
            <h1 className="text-lg font-semibold">Page not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This link may be invalid, expired, or revoked.
            </p>
          </div>
          <Link
            href="/"
            className="self-center rounded-[5px] border bg-background px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            return home
          </Link>
        </div>
      </section>
    </main>
  );
}
