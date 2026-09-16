"use strict";

const formatMod = require("../format");
const getType = formatMod.getType || formatMod;

function toStringVal(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function isStream(v) {
  return (
    v &&
    typeof v === "object" &&
    typeof v.pipe === "function" &&
    typeof v.on === "function"
  );
}

function isBlobLike(v) {
  return (
    v &&
    typeof v.arrayBuffer === "function" &&
    (typeof v.type === "string" || typeof v.name === "string")
  );
}

function isPairArrayList(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.every(
      (x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string"
    )
  );
}

module.exports = {
  getType,
  toStringVal,
  isStream,
  isBlobLike,
  isPairArrayList,
};
