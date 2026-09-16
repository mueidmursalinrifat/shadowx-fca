"use strict";

function formatCookie(arr, urlBase) {
  return arr[0] + "=" + arr[1] + "; Path=" + arr[3] + "; Domain=" + urlBase + ".com";
}

module.exports = {
  formatCookie,
};
