import { ImageResponse } from "next/og";
import { AppIconArt } from "@/components/app-icon-art";

// The icon for browser tabs and the app manifest. Next.js turns this file into
// a PNG at /icon and adds the <link rel="icon"> tag for us.
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<AppIconArt size={size.width} rounded />, size);
}
