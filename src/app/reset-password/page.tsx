import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reset password | Casper Agent",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

// Route shell — page logic lives in the FSD `_pages` layer.
export { ResetPasswordPage as default } from "@/_pages/reset-password";
