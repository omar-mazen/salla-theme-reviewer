"use strict";
/**
 * Worker-thread entry: runs the review engine off the extension-host thread so
 * scans never block the editor, other extensions (Git!), or the window.
 *
 * Protocol: the host posts { id, type, ...payload }; the worker answers
 * { id, ok: true, result } or { id, ok: false, error }. Messages are processed
 * one at a time in arrival order, except that while a full scan of one root is
 * running, requests for OTHER roots (a save in a second theme, a report, a live
 * buffer update) are served at the scan's yield points instead of waiting.
 */
const { parentPort } = require("worker_threads");
const { createEngine } = require("./review-engine.js");

const engine = createEngine();
const queue = [];
let busy = false;

function reply(id, ok, result) {
    parentPort.postMessage({ id, ok, result });
}

async function run(msg, hooks) {
    try {
        reply(msg.id, true, await engine.handle(msg, hooks));
    } catch (e) {
        reply(msg.id, false, { message: String((e && e.message) || e), stack: e && e.stack });
    }
}

/** Requests that are cheap and independent of the root being scanned */
function canInterleave(msg, scanningRoot) {
    if (msg.type === "fullScan" || msg.type === "clear") return false;
    return msg.root == null || msg.root !== scanningRoot;
}

const hooks = {
    async onYield(scanningRoot) {
        for (let i = 0; i < queue.length; ) {
            const m = queue[i];
            if (canInterleave(m, scanningRoot)) {
                queue.splice(i, 1);
                await run(m, hooks);
            } else {
                i++;
            }
        }
    },
};

async function pump() {
    if (busy) return;
    busy = true;
    try {
        while (queue.length) {
            await run(queue.shift(), hooks);
        }
    } finally {
        busy = false;
    }
}

parentPort.on("message", (msg) => {
    queue.push(msg);
    pump();
});
