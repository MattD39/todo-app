import { ImageResponse } from "next/og";
import { AppIconArt } from "@/components/app-icon-art";

// The iPhone home-screen icon (180×180 is Apple's size). Next.js serves it at
// /apple-icon and adds the <link rel="apple-touch-icon"> tag for us.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<AppIconArt size={size.width} />, size);
}
