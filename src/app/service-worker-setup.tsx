"use client";

import { useEffect } from "react";

// Installs the service worker (public/sw.js) that shows the "You're offline"
// page. Browsers without service workers simply skip it.
export function ServiceWorkerSetup() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      // updateViaCache "none": always check the server for a newer sw.js.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // Not fatal: the app works the same, just without the offline page.
      });
  }, []);

  return null;
}
