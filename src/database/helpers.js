"use strict";

/**
 * Shared helpers for database layer (userData, threadData).
 * Keeps validation and payload normalization in one place.
 */

const DB_NOT_INIT = "Database not initialized";

function validateId(value, fieldName = "id") {
  if (value == null) {
    throw new Error(`${fieldName} is required and cannot be undefined`);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Invalid ${fieldName}: must be a string or number`);
  }
  return String(value);
}

function validateData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid data: must be a non-empty object");
  }
}

/**
 * @param {string|string[]|null} keys - "userID" | ["userID","data"] | null
 * @returns {string[]|undefined}
 */
function normalizeAttributes(keys) {
  if (keys == null) return undefined;
  return typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : undefined;
}

/**
 * Normalize payload: accept either { data } or raw object.
 */
function normalizePayload(data, key = "data") {
  return Object.prototype.hasOwnProperty.call(data, key) ? data : { [key]: data };
}

function wrapError(message, cause) {
  return new Error(`${message}: ${cause && cause.message ? cause.message : cause}`);
}

module.exports = {
  DB_NOT_INIT,
  validateId,
  validateData,
  normalizeAttributes,
  normalizePayload,
  wrapError
};
