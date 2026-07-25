import type { Metadata } from "next";

export { ResetPasswordPage } from "./ui/ResetPasswordPage";

// Metadata mora aqui (módulo server) — o componente é "use client" e não pode
// exportá-la. O shell em app/ reexporta componente + metadata juntos.
export const metadata: Metadata = {
  title: "Reset password | Casper Agent",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};
