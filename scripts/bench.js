"use strict";
/**
 * Engine benchmark — no VS Code needed.
 *   node scripts/bench.js <theme-dir> [--file <path-inside-theme>] [--runs 5] [--all-checks]
 *
 * Prints the full-scan time (sync and chunked/async), the incremental refresh
 * time for one file (default: the largest twig file), and the round-trip through
 * the worker thread as the editor uses it. Run it before and after engine
 * changes to keep the numbers honest.
 */
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const core = require("../lib/salla-review-core.js");

const args = process.argv.slice(2);
const target = path.resolve(args.find((a) => !a.startsWith("--")) || ".");
const flag = (name, def) => {
    const i = args.indexOf(name);
    return i === -1 ? def : args[i + 1];
};
const runs = Number(flag("--runs", 5));
const allChecks = args.includes("--all-checks");

const roots = core.findThemeRoots(target);
if (roots.length === 0) {
    console.error(`no theme (twilight.json) under ${target}`);
    process.exit(2);
}
const root = roots[0];
// The noisy checks are off by default in the editor; --all-checks turns them on for a worst case
const opts = allChecks ? { cssVarCheck: true, colorCheck: true, cssBracesCheck: true } : { cssVarCheck: false, colorCheck: false, cssBracesCheck: false };

const ms = (t) => `${t.toFixed(1)} ms`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
async function time(fn) { const t0 = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t0) / 1e6; }

(async () => {
    console.log(`theme: ${root}${allChecks ? " (all checks on)" : ""}`);

    // Full scan (sync — what the CLI / git hooks run)
    let state = null;
    const full = [];
    for (let i = 0; i < runs; i++) full.push(await time(() => { state = core.createThemeState(root, opts); }));
    const issues = core.stateIssues(state);
    console.log(`full scan (sync):      median ${ms(median(full))}  (${state.factsByFile.size} files, ${issues.length} findings)`);

    // Full scan (chunked — what the worker runs)
    const fullAsync = [];
    for (let i = 0; i < runs; i++) fullAsync.push(await time(async () => { await core.createThemeStateAsync(root, opts); }));
    console.log(`full scan (chunked):   median ${ms(median(fullAsync))}`);

    // Incremental refresh of one file (cross checks from memory)
    let file = flag("--file", null);
    if (file) file = path.resolve(root, file);
    else {
        let best = null;
        for (const f of state.factsByFile.keys()) {
            if (!f.endsWith(".twig")) continue;
            const size = fs.statSync(f).size;
            if (!best || size > best.size) best = { f, size };
        }
        file = best ? best.f : [...state.factsByFile.keys()][0];
    }
    const inc = [];
    for (let i = 0; i < runs * 4; i++) inc.push(await time(() => { core.refreshFileInState(state, file); core.stateIssues(state); }));
    console.log(`refresh one file:      median ${ms(median(inc))}  (${path.relative(root, file)})`);

    // Round-trip through the worker thread, as the editor does it
    const worker = new Worker(path.join(__dirname, "..", "lib", "review-worker.js"));
    let id = 0;
    const pending = new Map();
    worker.on("message", (m) => { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.result.message)); });
    const request = (msg) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); worker.postMessage({ ...msg, id }); });

    let reply;
    const wfull = await time(async () => { reply = await request({ type: "fullScan", root, opts }); });
    console.log(`worker full scan:      ${ms(wfull)}  (engine ${reply.ms} ms, ${reply.changed.length} files with findings sent)`);
    const winc = [];
    for (let i = 0; i < runs * 4; i++) {
        winc.push(await time(async () => { reply = await request({ type: "refreshFiles", root, files: [{ file, liveText: null }], opts }); }));
    }
    console.log(`worker refresh:        median ${ms(median(winc))}  (delta: ${reply.changed.length} changed, ${reply.removed.length} removed)`);
    await worker.terminate();
})().catch((e) => { console.error(e); process.exit(1); });
