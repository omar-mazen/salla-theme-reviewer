"use strict";
/**
 * Review engine host — owns the per-theme incremental state and answers plain
 * message objects. It has no dependency on the `vscode` module, so the same
 * code runs either inside a worker thread (lib/review-worker.js, the normal
 * mode) or in-process as a fallback when the worker cannot be started.
 *
 * Replies never carry issue objects (each holds the whole file's lines): only
 * compact per-file diagnostic payloads, sent as a DELTA against what this engine
 * last reported for the root, so the editor touches only the files that changed.
 *
 *   Diag = { line, startCol, endCol, message, severity, code }   (line is 0-based)
 */
const core = require("./salla-review-core.js");

function diagSignature(diags) {
    let s = "";
    for (const d of diags) s += `${d.line}|${d.startCol}|${d.endCol}|${d.severity}|${d.code}|${d.message}\n`;
    return s;
}

function createEngine() {
    /** root -> { state, lastSent: Map<file, signature> } */
    const roots = new Map();

    /** Group the state's issues by file as Diag[] and count severities */
    function diagnose(state) {
        const issues = core.stateIssues(state);
        const byFile = new Map();
        const counts = { errors: 0, warnings: 0, infos: 0, total: issues.length };
        for (const issue of issues) {
            const d = core.diagnosticFieldsFor(issue);
            if (d.severity === "error") counts.errors++;
            else if (d.severity === "warning") counts.warnings++;
            else counts.infos++;
            let arr = byFile.get(issue.file);
            if (!arr) byFile.set(issue.file, (arr = []));
            arr.push(d);
        }
        return { byFile, counts };
    }

    /** Delta against the last reply for this root; `full` = a fresh snapshot (the editor drops what is not listed) */
    function buildReply(root, entry, full, t0, extra) {
        const { byFile, counts } = diagnose(entry.state);
        const changed = [];
        const removed = [];
        if (full) entry.lastSent = new Map();
        for (const [file, diags] of byFile) {
            const sig = diagSignature(diags);
            if (entry.lastSent.get(file) !== sig) {
                changed.push([file, diags]);
                entry.lastSent.set(file, sig);
            }
        }
        for (const file of [...entry.lastSent.keys()]) {
            if (!byFile.has(file)) {
                removed.push(file);
                entry.lastSent.delete(file);
            }
        }
        return {
            root,
            projectRoot: entry.state.projectRoot,
            full,
            changed,
            removed,
            counts,
            files: entry.state.factsByFile.size,
            ms: Date.now() - t0,
            ...extra,
        };
    }

    function applyOpts(entry, opts) {
        if (!opts) return;
        // Pick up settings changes; the rules/projectRoot fields are engine-internal
        const { projectRoot, rulesInfo, customRules } = entry.state.opts;
        entry.state.opts = { ...opts, projectRoot, rulesInfo, customRules };
        entry.state.filters = core.compilePathFilters(entry.state.opts);
    }

    const handlers = {
        async setRaedManifest(msg) {
            core.setRaedManifestPath(msg.path || null);
            return { ok: true };
        },

        async fullScan(msg, hooks) {
            const t0 = Date.now();
            const state = await core.createThemeStateAsync(msg.root, msg.opts || {}, {
                batch: msg.batch || 20,
                onYield: hooks && hooks.onYield ? (done, total) => hooks.onYield(msg.root, done, total) : undefined,
            });
            const entry = { state, lastSent: new Map() };
            roots.set(msg.root, entry);
            return buildReply(msg.root, entry, true, t0);
        },

        /** files: [{ file, liveText }] — liveText null/undefined clears the live buffer (read the disk) */
        async refreshFiles(msg) {
            const t0 = Date.now();
            const entry = roots.get(msg.root);
            if (!entry) return { root: msg.root, missing: true };
            applyOpts(entry, msg.opts);
            for (const { file, liveText } of msg.files || []) {
                core.setFileContent(file, liveText != null ? liveText : null);
                core.refreshFileInState(entry.state, file);
            }
            return buildReply(msg.root, entry, false, t0);
        },

        async setContent(msg) {
            core.setFileContent(msg.file, msg.text != null ? msg.text : null);
            return { ok: true };
        },

        async removeRoot(msg) {
            const entry = roots.get(msg.root);
            roots.delete(msg.root);
            return { root: msg.root, removed: entry ? [...entry.lastSent.keys()] : [] };
        },

        async clear() {
            roots.clear();
            return { ok: true };
        },

        /** Markdown report; extraIssues = issues computed outside the engine (network checks) */
        async report(msg) {
            const entry = roots.get(msg.root);
            if (!entry) return { root: msg.root, missing: true };
            const issues = [...core.stateIssues(entry.state), ...(msg.extraIssues || [])];
            const parity = msg.raedParity ? core.compareWithRaed(entry.state.projectRoot) : null;
            return { root: msg.root, markdown: core.buildReportMarkdown(msg.slug, issues, parity, msg.displayBase) };
        },

        async projectRoot(msg) {
            const entry = roots.get(msg.root);
            return { root: msg.root, projectRoot: entry ? entry.state.projectRoot : null };
        },
    };

    /** @returns {Promise<object>} the reply for one message */
    function handle(msg, hooks) {
        const h = handlers[msg && msg.type];
        if (!h) return Promise.reject(new Error(`unknown engine message: ${msg && msg.type}`));
        return h(msg, hooks);
    }

    return { handle, roots };
}

module.exports = { createEngine, diagSignature };
