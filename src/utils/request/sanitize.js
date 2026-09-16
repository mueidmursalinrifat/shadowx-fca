"use strict";

function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F\r\n]/g, "").trim();
}

function sanitizeHeaderName(name) {
  if (!name || typeof name !== "string") return "";
  return name.replace(/[^\x21-\x7E]/g, "").trim();
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    const sanitizedKey = sanitizeHeaderName(key);
    if (!sanitizedKey) continue;

    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === "object") continue;
    if (typeof value === "function") continue;

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) continue;
        } catch {
          // continue with normal sanitization
        }
      }
    }

    const sanitizedValue = sanitizeHeaderValue(value);
    if (sanitizedValue !== "") {
      sanitized[sanitizedKey] = sanitizedValue;
    }
  }
  return sanitized;
}

module.exports = {
  sanitizeHeaderValue,
  sanitizeHeaderName,
  sanitizeHeaders,
};
