import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro, JetBrains_Mono } from "next/font/google";


import "./globals.css";
import { ThemeScript } from "@/components/shell/theme-script";

/**
 * The root layout does almost nothing on purpose.
 *
 * It sets up fonts, the theme script and the document shell — and nothing that
 * needs a session, because it also wraps the sign-in and sign-up screens. The
 * application chrome and the access checks live in `(app)/layout.tsx`.
 */

const sans = Be_Vietnam_Pro({
  variable: "--font-be-vietnam",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin", "vietnamese"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "GOP_IMPORT",
  description: "Bulk product publishing for WooCommerce",
};

export const viewport: Viewport = {
  /**
   * THE ONE EXCEPTION to "no colour literals outside the design system": this
   * becomes a `<meta name="theme-color">` tag, which the browser reads before
   * any CSS exists, so `var(--canvas)` would resolve to nothing. These two must
   * stay in step with `--canvas` for each theme in globals.css.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fd" },
    { media: "(prefers-color-scheme: dark)", color: "#14161f" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>

      <body>
        <ThemeScript />
        {children}</body>
    </html>
  );
}
