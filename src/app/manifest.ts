import type { MetadataRoute } from "next";

// The web app manifest: tells phones the app's name, colours and icon, and that it
// should open full-screen (no browser bars) when launched from the home screen.
// Next.js serves it at /manifest.webmanifest and links it from every page.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "To-Do",
    short_name: "To-Do",
    description: "A personal to-do list with categories, recurring tasks and a calendar.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f1f4f0",
    theme_color: "#f1f4f0",
    icons: [{ src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
