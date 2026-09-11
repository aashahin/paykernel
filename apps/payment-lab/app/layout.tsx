import type { ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import "./globals.css";

export const metadata = { title: "PayKernel · Payment lab", description: "Test checkout, seller operations, and webhooks across seven payment gateways.", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>
    <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-background focus:p-3">Skip to content</a>
    <header className="border-b bg-card"><nav aria-label="Primary" className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-5 px-5 py-5 sm:px-8">
      <a href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><FlaskConical className="size-5 text-primary" aria-hidden="true" />PayKernel <span className="font-normal text-muted-foreground">/ Lab</span></a>
      <div className="flex items-center gap-5 text-sm font-medium"><a href="/">Checkout</a><a href="/seller">Orders</a><a href="/testing">Tests</a><a href="/setup">Setup</a></div>
    </nav></header>
    <main id="main" className="mx-auto min-h-[75vh] w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12">{children}</main>
    <footer className="mx-auto flex max-w-7xl flex-wrap justify-between gap-3 border-t px-5 py-6 text-xs text-muted-foreground sm:px-8"><span>PayKernel payment lab</span><span>Sandbox and simulation · No live payments</span></footer>
  </body></html>;
}
