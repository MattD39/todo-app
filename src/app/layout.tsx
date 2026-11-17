import type { Metadata, Viewport } from "next";
import {
  Atkinson_Hyperlegible,
  Bricolage_Grotesque,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import { ServiceWorkerSetup } from "./service-worker-setup";

// Same three fonts as the old app, loaded by Next.js so they're self-hosted.
const display = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["opsz"],
});

const body = Atkinson_Hyperlegible({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "To-Do",
  description: "A personal to-do list with categories, recurring tasks and a calendar.",
  // How the app behaves once added to an iPhone home screen: its name under the
  // icon, opening full-screen, and a normal status bar (dark text on light mode,
  // light text in dark mode) above the app.
  appleWebApp: {
    capable: true,
    title: "To-Do",
    statusBarStyle: "default",
  },
};

// viewportFit "cover" lets the app draw behind the iPhone notch and home bar;
// globals.css pads content back in with the safe-area insets.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F1F4F0" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1411" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {children}
        <ServiceWorkerSetup />
      </body>
    </html>
  );
}
