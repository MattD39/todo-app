"use client";

// Photo to schedule: gets a photo you picked with the 📷 button ready to send.
//
// Phone photos are big (often 4000+ pixels across and several MB), so the
// photo is redrawn here, on your device, at most LONG_EDGE pixels on its
// longest side, as a JPEG. That makes it quick to send and plenty sharp for
// Claude to read a schedule. Redrawing also leaves behind everything hidden in
// the original file, like the GPS location where it was taken: only the
// pixels are sent.
//
// (On iPhone, choosing a photo for a web page already hands over a JPEG, even
// though the camera saves HEIC. A computer browser that can't open a file,
// e.g. a HEIC on Windows, gets the "can't read" message.)

const LONG_EDGE = 2000;
// The server refuses photos over 3 MB; a 2000-pixel JPEG is usually 300–700 KB.
const MAX_SEND_BYTES = 3_000_000;
// Bigger files than this aren't even opened (a phone could run out of memory).
const MAX_PICKED_BYTES = 40_000_000;

export const NOT_A_PHOTO = "That file isn't a photo the app can read. Try a JPEG or PNG photo.";
export const TOO_BIG = "That photo is too big. Try a smaller one.";

// The photo ready to send: a "data:image/jpeg;base64,…" URL. It doubles as the
// preview picture.
export type ReadyPhoto = { dataUrl: string };

// The picked file, shrunk and turned into a JPEG; or a message to show if it
// can't be used.
export async function shrinkPhoto(file: File): Promise<ReadyPhoto | string> {
  if (file.type && !file.type.startsWith("image/")) return NOT_A_PHOTO;
  if (file.size > MAX_PICKED_BYTES) return TOO_BIG;

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      return NOT_A_PHOTO; // not a picture, or a kind this browser can't open
    }
    const { naturalWidth: w, naturalHeight: h } = image;
    if (!w || !h) return NOT_A_PHOTO;

    // Browsers turn the picture the right way up (from the camera's rotation
    // note) when drawing it, so a sideways phone photo comes out upright.
    const scale = Math.min(1, LONG_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const context = canvas.getContext("2d");
    if (!context) return NOT_A_PHOTO;
    context.fillStyle = "#fff"; // see-through parts of a PNG become white, not black
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.85, 0.7, 0.5]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (bytesOf(dataUrl) <= MAX_SEND_BYTES) return { dataUrl };
    }
    return TOO_BIG;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The photo as the server wants it: just the base64 part.
export function base64Of(photo: ReadyPhoto): string {
  return photo.dataUrl.slice(photo.dataUrl.indexOf(",") + 1);
}

// The size of the file a data URL holds.
function bytesOf(dataUrl: string): number {
  return Math.floor((base64Of({ dataUrl }).length * 3) / 4);
}
