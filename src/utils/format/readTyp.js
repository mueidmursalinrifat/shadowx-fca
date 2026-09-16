"use strict";

const { formatID } = require("./utils");

function formatReadReceipt(event) {
  return {
    reader: event.reader.toString(),
    time: event.time,
    threadID: formatID((event.thread_fbid || event.reader).toString()),
    type: "read_receipt",
  };
}

function formatRead(event) {
  return {
    threadID: formatID(
      (
        (event.chat_ids && event.chat_ids[0]) ||
        (event.thread_fbids && event.thread_fbids[0])
      ).toString(),
    ),
    time: event.timestamp,
    type: "read",
  };
}

function formatTyp(event) {
  return {
    isTyping: !!event.st,
    from: event.from.toString(),
    threadID: formatID(
      (event.to || event.thread_fbid || event.from).toString(),
    ),
    fromMobile: event.hasOwnProperty("from_mobile") ? event.from_mobile : true,
    userID: (event.realtime_viewer_fbid || event.from).toString(),
    type: "typ",
  };
}

module.exports = {
  formatReadReceipt,
  formatRead,
  formatTyp,
};
