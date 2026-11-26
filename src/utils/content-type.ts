const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** The file extension for an uploaded image's Content-Type ("bin" when unknown). */
export function fileExtensionForContentType(contentType: string): string {
  return EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()] ?? "bin";
}
