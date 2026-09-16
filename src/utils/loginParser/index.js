"use strict";

const { parseAndCheckLogin } = require("./parseAndCheckLogin");
const { cleanXssi, makeParsable } = require("./textUtils");

module.exports = {
  parseAndCheckLogin,
  cleanXssi,
  makeParsable
};
