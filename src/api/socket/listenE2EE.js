"use strict";

var logger = require("../../utils/logger");
var EventEmitter = require("events");

/**
 * listenE2EE — merges E2EE messages into the same event stream as MQTT.
 *
 * Usage (identical to api.listen):
 *   api.listenE2EE(callback)   // Node-style callback(err, event)
 *   api.listenE2EE()           // returns MessageEmitter
 *
 * Combines:
 *   - Regular MQTT messages    (from api.listenMqtt)
 *   - E2EE encrypted messages  (received via SHADOWX-FCA native Noise WebSocket)
 *
 * All events share the same shape (type, senderID, threadID, body, etc.),
 * with E2EE events carrying `isE2EE: true`.
 */
module.exports = function (defaultFuncs, api, ctx) {
    return function listenE2EE(callback) {
        class CombinedEmitter extends EventEmitter {
            stopListening(cb) {
                if (api._mqttEmitter && typeof api._mqttEmitter.stopListening === "function") {
                    api._mqttEmitter.stopListening(cb);
                } else if (typeof cb === "function") {
                    cb([]);
                }
                if (ctx.e2ee && ctx.e2ee.connected) {
                    ctx.e2ee.disconnect().catch(() => {});
                }
            }
            stopListeningAsync() {
                return new Promise(res => this.stopListening(res));
            }
        }

        var emitter = new CombinedEmitter();

        var isCallbackMode = typeof callback === "function";
        var globalCallback = isCallbackMode ? callback : function (err, event) {
            if (err) return emitter.emit("error", err);
            emitter.emit("message", event);
        };

// Start regular MQTT listener
        var mqttEmitter = (api._listenMqttRaw || api.listenMqtt)(globalCallback);
        api._mqttEmitter = mqttEmitter;

// Hook E2EE incoming messages (SHADOWX-FCA native Noise WebSocket)
        var e2ee = api.e2ee || ctx.e2ee;
        if (!e2ee || !e2ee.isConnected()) {
            logger.warn(
                "listenE2EE",
                "E2EE not connected. E2EE messages will not be received. " +
                "Call api.connectE2EE() before listenE2EE() to enable encrypted message reception."
            );
        } else {
            e2ee.onMessage(function (err, event) {
                if (err) return globalCallback(err, null);
                if (!event) return;

                // Filter self-messages unless selfListen is enabled
                if (!ctx.globalOptions.selfListen && event.senderID === ctx.userID) return;

                event.isE2EE = true;
                globalCallback(null, event);
            });

            logger.success("listenE2EE", "Combined MQTT + E2EE (Signal/Noise) listener active.");
        }

        return emitter;
    };
};
