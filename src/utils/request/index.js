"use strict";

const { jar, client } = require("./client");
const { cleanGet, get, post, postFormData } = require("./methods");
const { makeDefaults } = require("./defaults");
const { setProxy } = require("./proxy");

module.exports = {
  cleanGet,
  get,
  post,
  postFormData,
  jar,
  setProxy,
  makeDefaults,
  client,
};
