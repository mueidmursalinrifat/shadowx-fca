"use strict";

module.exports = function fcaNXAdapter(options, fcaOptions, callback) {
  if (global._fcanxE2EEAdapter) {
    return callback(null, global._fcanxE2EEAdapter);
  }

  const error = new Error("SHADOWX-FCA E2EE adapter is not initialized");
  if (typeof callback === "function") return callback(error);
  throw error;
};
