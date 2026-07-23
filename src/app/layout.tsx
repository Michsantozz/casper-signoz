import type { Metadata } from "next";
import "./globals.css";
import { Geist, JetBrains_Mono } from "next/font/google";
import { cn } from "@/shared/lib/utils";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { ThemeProvider } from "@/shared/ui/theme-provider";
import { QueryProvider } from "@/shared/ui/QueryProvider";
import { Toaster } from "@/shared/ui/sonner";
import { NotificationBell } from "@/features/notifications";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Casper Agent",
  description: "AI meeting assistant — schedule, record, and summarize your meetings",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("font-sans", geist.variable, jetbrainsMono.variable)}
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
            <TooltipProvider>{children}</TooltipProvider>
            {/* Global notification bell — self-contained, only shown when signed in. */}
            <NotificationBell />
            <Toaster />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
