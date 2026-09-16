"use strict";

const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const jar = new CookieJar();
const client = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    timeout: 60000,
    validateStatus: (s) => s >= 200 && s < 600,
    maxRedirects: 5,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  })
);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  jar,
  client,
  delay,
};
