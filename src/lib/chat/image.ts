/**
 * Image preparation for chat: validate, decode, resize and re-encode in the
 * browser before upload. Limits mirror
 * supabase/migrations/20261121000100_phase2a_image_messages.sql.
 *
 * Re-encoding also strips EXIF metadata (e.g. phone GPS location).
 */

export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
export const IMAGE_MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // bucket limit
const IMAGE_MAX_INPUT_BYTES = 25 * 1024 * 1024; // refuse to decode anything larger
const IMAGE_MAX_INPUT_PIXELS = 50_000_000;
/**
 * Longest side after resizing. 2048 px keeps small print on product boxes
 * and prescription labels legible while keeping files around 0.2–1 MB.
 */
const MAX_DIMENSION = 2048;
const MIN_DIMENSION_ON_RETRY = 1280;

export type ImageBaseMime = "image/jpeg" | "image/png" | "image/webp";

export type PreparedImage = {
  blob: Blob;
  mime: ImageBaseMime;
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
  originalBytes: number;
};

const EXT: Record<ImageBaseMime, PreparedImage["ext"]> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export class ImagePrepError extends Error {}

function isAllowedType(type: string): type is ImageBaseMime {
  return type === "image/jpeg" || type === "image/png" || type === "image/webp";
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      // Applies the photo's EXIF orientation so portrait shots stay upright.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to <img> decoding (older Safari)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImagePrepError("This image couldn't be opened. Try a different photo.");
  }
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function render(d: Decoded, maxSide: number, mime: ImageBaseMime, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(d.width, d.height));
  const width = Math.max(1, Math.round(d.width * scale));
  const height = Math.max(1, Math.round(d.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImagePrepError("This browser can't prepare images for sending.");
  if (mime === "image/jpeg") {
    // JPEG has no transparency: put transparent PNG areas on white, not black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(d.source, 0, 0, width, height);
  const blob = await encode(canvas, mime, quality);
  canvas.width = canvas.height = 0; // free memory early (iOS)
  return { blob, width, height };
}

/**
 * Validates and compresses one image. Output is WebP when the browser can
 * encode it (sharper text per byte), otherwise JPEG. Throws ImagePrepError
 * with a readable message.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isAllowedType(file.type)) {
    throw new ImagePrepError("Only JPEG, PNG and WebP images can be sent.");
  }
  if (file.size > IMAGE_MAX_INPUT_BYTES) {
    throw new ImagePrepError("This image is too large (over 25 MB). Try a smaller photo.");
  }

  const decoded = await decode(file);
  try {
    if (decoded.width * decoded.height > IMAGE_MAX_INPUT_PIXELS) {
      throw new ImagePrepError("This image's resolution is too high to send.");
    }
    // Screenshots/PNGs with text get a higher quality to keep edges crisp.
    const quality = file.type === "image/png" ? 0.92 : 0.85;
    const attempts: [number, number][] = [
      [MAX_DIMENSION, quality],
      [MAX_DIMENSION, 0.75],
      [MIN_DIMENSION_ON_RETRY, 0.75],
    ];
    for (const [maxSide, q] of attempts) {
      let out = await render(decoded, maxSide, "image/webp", q);
      let mime: ImageBaseMime = "image/webp";
      if (!out.blob || out.blob.type !== "image/webp") {
        // Browser can't encode WebP (it falls back to PNG): use JPEG instead.
        out = await render(decoded, maxSide, "image/jpeg", q);
        mime = "image/jpeg";
      }
      if (!out.blob || out.blob.type !== mime) {
        throw new ImagePrepError("This browser can't prepare images for sending.");
      }
      if (out.blob.size <= IMAGE_MAX_UPLOAD_BYTES) {
        return {
          blob: out.blob,
          mime,
          ext: EXT[mime],
          width: out.width,
          height: out.height,
          originalBytes: file.size,
        };
      }
    }
    throw new ImagePrepError("This image is too detailed to send under 3 MB. Try cropping it.");
  } finally {
    decoded.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
