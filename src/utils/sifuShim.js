"use strict";

/*
 * shadowx-fca compatibility shim for fca-sifu API modules.
 *
 * fca-sifu's dispatch modules require a large datastore/models/matrix
 * stack (tools, ghost, revive, ...). shadowx-fca already implements
 * nearly all of that functionality in src/utils, so this shim maps the
 * fca-sifu interface onto the native shadowx-fca implementations and
 * degrades gracefully for the few helpers that have no equivalent.
 */

const nativeUtils = require("./utils");
const format = require("./format");
const logger = require("../../func/logger");

function makeLogger(type) {
	return (msg) => {
		try {
			logger(msg, type);
		}
		catch (_) { }
	};
}

/*
 * Best-effort stand-in for fca-sifu's Shield class. The real one adds
 * human-like delays and anti-suspension heuristics; shadowx-fca has no
 * equivalent, so these are no-ops that preserve the call shape.
 */
function makeNoopChain() {
	const chain = () => chain;
	chain.addSmartDelay = () => chain;
	chain.prepareBeforeMessage = async () => true;
	chain.simulateTyping = async () => true;
	chain.detectSuspensionSignal = () => false;
	return chain;
}

const tools = {
	// logging
	log: makeLogger("info"),
	warn: makeLogger("warn"),
	error: makeLogger("error"),
	success: makeLogger("success"),
	debug: makeLogger("debug"),

	// request/session helpers
	parseAndCheckLogin: nativeUtils.parseAndCheckLogin,
	saveCookies: nativeUtils.saveCookies,
	getAppState: nativeUtils.getAppState,
	get: nativeUtils.get,
	post: nativeUtils.post,
	postFormData: nativeUtils.postFormData,
	getJar: nativeUtils.getJar,
	getHeaders: nativeUtils.getHeaders,
	isReadableStream: nativeUtils.isReadableStream,

	// ids & payloads
	generateOfflineThreadingID: format.generateOfflineThreadingID,
	generateThreadingID: format.generateThreadingID,
	getGUID: format.getGUID,
	getSignatureID: format.getSignatureID,
	generateTimestampRelative: format.generateTimestampRelative,
	decodeClientPayload: format.decodeClientPayload,

	// formatting
	getType: format.getType,
	formatID: format.formatID,
	formatAttachment: format.formatAttachment,
	_formatAttachment: format._formatAttachment,
	formatThread: format.formatThread,
	formatDeltaEvent: format.formatDeltaEvent,
	formatDeltaMessage: format.formatDeltaMessage,
	formatDeltaReadReceipt: format.formatDeltaReadReceipt,
	formatMessage: format.formatMessage,
	getAdminTextMessageType: format.getAdminTextMessageType,
	getFrom: nativeUtils.getFrom,
	arrToForm: nativeUtils.arrToForm,

	// misc
	json: (obj) => {
		try { return JSON.stringify(obj); }
		catch (_) { return "{}"; }
	},
	delay: (ms) => new Promise((r) => setTimeout(r, ms)),
	promisify: (fn) => require("util").promisify(fn),
	windowsUserAgent:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",

	// namespaces that exist in fca-sifu but not here
	globalShield: makeNoopChain(),
	globalAntiSuspension: makeNoopChain(),
	globalValidator: null,
	Validator: null,
	globalMonitor: null,
	Telemetry: null,
	ProductionMonitor: null,
	CycleManager: null,
	TokenRefreshManager: null
};

module.exports = {
	...tools,

	// fca-sifu modules import these by name
	Shield: makeNoopChain,
	globalShield: makeNoopChain(),
	globalAntiSuspension: makeNoopChain()
};
