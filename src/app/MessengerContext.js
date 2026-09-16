"use strict";

class MessengerContext {
  constructor(bot, event) {
    this.bot = bot;
    this.event = event;
  }

  get threadID() { return this.event.threadID; }
  get senderID() { return this.event.senderID; }
  get messageID() { return this.event.messageID; }
  get body() { return this.event.body; }
  get message() { return this.event; }

  get text() {
    return (this.event.body ?? "").trim();
  }

  reply(payload, callback) {
    const tid = this.event.threadID;
    if (tid == null) throw new Error("MessengerContext.reply: threadID is missing");
    return this.bot.api.sendMessage(payload, tid, callback);
  }

  async replyAsync(payload) {
    const r = this.reply(payload);
    if (r && typeof r.then === "function") return r;
    return Promise.resolve(r);
  }
}

module.exports = { MessengerContext };
