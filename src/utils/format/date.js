"use strict";

var NUM_TO_MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
var NUM_TO_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(date) {
  var d = date.getUTCDate();
  d = d >= 10 ? d : "0" + d;
  var h = date.getUTCHours();
  h = h >= 10 ? h : "0" + h;
  var m = date.getUTCMinutes();
  m = m >= 10 ? m : "0" + m;
  var s = date.getUTCSeconds();
  s = s >= 10 ? s : "0" + s;
  return (
    NUM_TO_DAY[date.getUTCDay()] +
    ", " +
    d +
    " " +
    NUM_TO_MONTH[date.getUTCMonth()] +
    " " +
    date.getUTCFullYear() +
    " " +
    h +
    ":" +
    m +
    ":" +
    s +
    " GMT"
  );
}

module.exports = {
  NUM_TO_MONTH,
  NUM_TO_DAY,
  formatDate,
};
