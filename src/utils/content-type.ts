/** The file extension for an uploaded image's Content-Type ("bin" when unknown). */
export function fileExtensionForContentType(contentType: string): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpg";
  }
  if (normalized === "image/png") {
    return "png";
  }
  if (normalized === "image/webp") {
    return "webp";
  }
  if (normalized === "image/avif") {
    return "avif";
  }
  return "bin";
}
