"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "1rem",
          background: "#0b0b0c",
          color: "#f4f4f5",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            Casper could not start
          </h1>
          <p style={{ color: "#a1a1aa", lineHeight: 1.5 }}>
            A critical page error occurred. Try loading the application again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1rem",
              border: "1px solid #3f3f46",
              borderRadius: "0.375rem",
              padding: "0.5rem 0.75rem",
              background: "#18181b",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
