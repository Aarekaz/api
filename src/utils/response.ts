import type { JsonRecord } from "../types/common";

export function jsonResponse(data: JsonRecord | JsonRecord[], status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function errorResponse(message: string, status: number, details?: unknown): Response {
  if (details) {
    return jsonResponse({ error: message, details }, status);
  }
  return jsonResponse({ error: message }, status);
}

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
