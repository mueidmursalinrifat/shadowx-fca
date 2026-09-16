"use strict";

const EventEmitter = require("events");
const { MessengerContext } = require("./MessengerContext");
const { createFcaClient } = require("./createFcaClient");

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emitIf(bot, channel, payload) {
  if (bot.listenerCount(channel) > 0) bot.emit(channel, payload);
}

function emitGatewayEvents(bot, event) {
  emitIf(bot, "update", event);
  emitIf(bot, "raw", event);
  const t = event.type;
  if (!t) return;
  if (t === "message" || t === "message_reply") {
    emitIf(bot, "message", event);
    emitIf(bot, "messageCreate", event);
  }
  if (t === "message_reply") {
    emitIf(bot, "message_reply", event);
  } else if (t !== "message") {
    emitIf(bot, t, event);
  }
  switch (t) {
    case "message_reaction": emitIf(bot, "messageReactionAdd", event); break;
    case "message_unsend": emitIf(bot, "messageDelete", event); break;
    case "typ": emitIf(bot, event.isTyping ? "typingStart" : "typingStop", event); break;
    case "event": emitIf(bot, "threadUpdate", event); break;
    case "ready":
      emitIf(bot, "ready", event);
      emitIf(bot, "shardReady", event);
      break;
  }
}

class MessengerBot extends EventEmitter {
  constructor(api, options = {}) {
    super();
    const cap = options.maxEventListeners ?? 64;
    this.setMaxListeners(cap === 0 ? 0 : cap);
    this.api = api;
    this._commandPrefix = options.commandPrefix || "/";
    this._enableComposer = options.enableComposer !== false;
    this._stopOnSignals = options.stopOnSignals || false;
    this._middlewares = [];
    this._catchHandler = null;
    this._facade = null;
    this._mqtt = null;
    this._listening = false;
    this._signalsBound = false;
    this._onStopSignal = null;
  }

  get commandPrefix() { return this._commandPrefix; }
  set commandPrefix(value) { this._commandPrefix = value || "/"; }

  get client() {
    if (!this._facade) this._facade = createFcaClient(this.api);
    return this._facade;
  }

  use(middleware) {
    this._middlewares.push(middleware);
    return this;
  }

  command(name, handler) {
    const n = name.toLowerCase();
    this.use(async (ctx, next) => {
      const text = ctx.text;
      if (!text) { await next(); return; }
      const prefix = escapeRegex(this._commandPrefix);
      const re = new RegExp(`^${prefix}${escapeRegex(n)}(?:\\s|$)`, "i");
      if (re.test(text)) { await handler(ctx); return; }
      await next();
    });
    return this;
  }

  hears(trigger, handler) {
    const match = typeof trigger === "string"
      ? (text) => text.toLowerCase().includes(trigger.toLowerCase())
      : (text) => trigger.test(text);
    this.use(async (ctx, next) => {
      const text = ctx.text;
      if (!text) { await next(); return; }
      if (match(text)) { await handler(ctx); return; }
      await next();
    });
    return this;
  }

  catch(handler) {
    this._catchHandler = handler;
    return this;
  }

  startListening() {
    if (this._listening) return this;
    if (typeof this.api.listenMqtt !== "function") {
      throw new Error("listenMqtt is not available on API");
    }
    const mqtt = this.api.listenMqtt();
    this._mqtt = mqtt;
    this._listening = true;
    mqtt.on("message", (event) => {
      emitGatewayEvents(this, event);
      this._enqueueComposerIfNeeded(event);
    });
    mqtt.on("error", (err) => this.emit("error", err));
    return this;
  }

  async launch(opts = {}) {
    this.startListening();
    const bind = opts.stopOnSignals ?? this._stopOnSignals;
    if (bind) this._attachStopSignals();
    return this;
  }

  _attachStopSignals() {
    if (this._signalsBound) return;
    this._signalsBound = true;
    this._onStopSignal = () => {
      this.stop().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once("SIGINT", this._onStopSignal);
    process.once("SIGTERM", this._onStopSignal);
  }

  _detachStopSignals() {
    if (!this._signalsBound || !this._onStopSignal) return;
    process.off("SIGINT", this._onStopSignal);
    process.off("SIGTERM", this._onStopSignal);
    this._signalsBound = false;
    this._onStopSignal = null;
  }

  async stop() {
    this._detachStopSignals();
    if (!this._mqtt) return;
    const mqtt = this._mqtt;
    if (typeof mqtt.stopListeningAsync === "function") {
      await mqtt.stopListeningAsync();
    } else if (typeof mqtt.stopListening === "function") {
      mqtt.stopListening();
    }
    if (typeof mqtt.removeAllListeners === "function") mqtt.removeAllListeners();
    this._mqtt = null;
    this._listening = false;
  }

  _enqueueComposerIfNeeded(event) {
    if (!this._enableComposer || this._middlewares.length === 0) return;
    if (event.type !== "message" && event.type !== "message_reply") return;
    const ctx = new MessengerContext(this, event);
    queueMicrotask(() => { this._runComposer(ctx); });
  }

  async _runComposer(ctx) {
    const dispatch = async (index) => {
      if (index >= this._middlewares.length) return;
      const mw = this._middlewares[index];
      await mw(ctx, () => dispatch(index + 1));
    };
    try {
      await dispatch(0);
    } catch (err) {
      if (this._catchHandler) this._catchHandler(err, ctx);
      else this.emit("error", err);
    }
  }

  static async connect(credentials, options = {}) {
    const login = require("../../module/login");
    const {
      autoListen = true,
      enableComposer = true,
      commandPrefix = "/",
      stopOnSignals = false,
      maxEventListeners = 64,
      ...fcaOptions
    } = options;

    return new Promise((resolve, reject) => {
      login(credentials, fcaOptions, (err, api) => {
        if (err) return reject(err);
        const bot = new MessengerBot(api, { enableComposer, commandPrefix, stopOnSignals, maxEventListeners });
        if (autoListen) {
          bot.launch({ stopOnSignals }).then(() => resolve(bot)).catch(reject);
        } else {
          if (stopOnSignals) bot._attachStopSignals();
          resolve(bot);
        }
      });
    });
  }
}

function createMessengerBot(credentials, options) {
  return MessengerBot.connect(credentials, options);
}

module.exports = { MessengerBot, createMessengerBot };
