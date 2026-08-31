"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const core = require("./lib/salla-review-core.js");
const twilightVersion = require("./lib/twilight-version.js");
const raedUpdater = require("./lib/raed-updater.js");

let globalStoragePath = null; // versions cache + the updated Raed manifest
let extensionPath = null; // extension install dir — source for vendored CI files
let diagnostics; // vscode.DiagnosticCollection
let output; // vscode.OutputChannel
let statusItem; // vscode.StatusBarItem

/**
 * Per theme root. Nothing heavy lives on this thread: the engine state (facts,
 * file lines, issues) is owned by the review worker; the extension host keeps
 * only what it needs to render — which files currently show diagnostics, the
 * severity counts, the network (version) findings, and the pending refreshes.
 *
 * Map<root, {
 *   projectRoot, shownFiles: Set<file>, counts, versionIssues, versionDiags,
 *   pending: Map<file, TextDocument|null>, timer, inFlight, watcher
 * }>
 */
const roots = new Map();
/** Files whose unsaved editor buffer is registered with the engine (normalized keys) */
const liveFiles = new Set();

const SAVE_DEBOUNCE_MS = 350;
const LIVE_DEBOUNCE_MS = 1000;
const MAX_WORKER_RESTARTS = 3;

function fileKey(p) {
    return process.platform === "win32" ? String(p).toLowerCase() : String(p);
}

/* =============== Settings (cached per workspace folder) =============== */

/**
 * Resource-scoped settings resolve per workspace folder, so one read per folder
 * is enough. The cache is dropped on any sallaReview.* change. Previously every
 * keystroke and every watcher event rebuilt the whole object (~35 lookups).
 */
const configCache = new Map(); // folder fsPath ("" = no folder) -> cfg

function getConfig(scopePath) {
    const folder = scopePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scopePath)) : undefined;
    const key = folder ? folder.uri.fsPath : "";
    let cfg = configCache.get(key);
    if (!cfg) {
        cfg = readConfig(folder ? folder.uri : null);
        configCache.set(key, cfg);
    }
    return cfg;
}

/**
 * Read settings scoped to the project folder (resource scope) — each theme can
 * customize its checks and patterns from its own .vscode/settings.json. The old
 * keys (pre 0.5.0) are read as a fallback so saved preferences are not lost.
 */
function readConfig(scopeUri) {
    const cfg = vscode.workspace.getConfiguration("sallaReview", scopeUri);
    const check = (name, legacy, def = true) => {
        const v = cfg.get("checks." + name);
        if (typeof v === "boolean") return v;
        if (legacy) {
            const lv = cfg.get(legacy);
            if (typeof lv === "boolean") return lv;
        }
        return def;
    };
    return {
        runOnSave: cfg.get("runOnSave", true),
        runOnType: cfg.get("runOnType", false),
        scanOnStartup: cfg.get("scanOnStartup", true),
        raedAutoUpdateDays: cfg.get("raedAutoUpdateDays", 7),
        ci: {
            failOn: cfg.get("ci.failOn", "error"),
            preCommitHook: cfg.get("ci.preCommitHook", false),
            prePushHook: cfg.get("ci.prePushHook", false),
            workflow: cfg.get("ci.workflow", true),
        },
        ignoredTexts: cfg.get("ignoredTexts", []),
        exclude: cfg.get("exclude", []),

        uiText: check("uiText"),
        twigBlocks: check("twigBlocks", "twigSyntaxCheck"),
        twigNaming: check("twigNaming"),
        jsSyntax: check("jsSyntax", "nodeSyntaxCheck"),
        cssBraces: check("cssBraces", null, false),
        scopes: check("scopes"),
        security: check("security"),
        customCode: check("customCode"),
        misleadingUx: check("misleadingUx", "misleadingUxHeuristic"),
        requiredHooks: check("requiredHooks"),
        requiredComponents: check("requiredComponents"),
        sliderSource: check("sliderSource"),
        themeSize: check("themeSize"),
        twigDivision: check("twigDivision"),
        mergeConflicts: check("mergeConflicts"),
        viteConfig: check("viteConfig"),
        bundle: check("bundle"),
        structure: check("structure"),
        twilightManifest: check("twilightManifest", "twilightManifestCheck"),
        cssVariables: check("cssVariables", "cssVarCheck", false),
        colors: check("colors", "colorCheck", false),
        twilightVersion: check("twilightVersion", "twilightVersionCheck"),
        raedParity: check("raedParity", "reportIncludesRaedParity"),
        customRules: check("customRules"),
        customRulesFile: cfg.get("customRulesFile", ""),
    };
}

/** Engine options from the settings (Raed parity is computed only at report time — not here) */
function engineOpts(cfg) {
    return {
        ignoredTexts: cfg.ignoredTexts,
        exclude: cfg.exclude,

        uiTextCheck: cfg.uiText,
        twigSyntaxCheck: cfg.twigBlocks,
        twigNamingCheck: cfg.twigNaming,
        nodeSyntaxCheck: cfg.jsSyntax,
        cssBracesCheck: cfg.cssBraces,
        scopesCheck: cfg.scopes,
        securityCheck: cfg.security,
        customCodeCheck: cfg.customCode,
        misleadingUxHeuristic: cfg.misleadingUx,
        requiredHooks: cfg.requiredHooks,
        requiredComponents: cfg.requiredComponents,
        sliderSourceCheck: cfg.sliderSource,
        sizeCheck: cfg.themeSize,
        divisionCheck: cfg.twigDivision,
        mergeConflicts: cfg.mergeConflicts,
        viteCheck: cfg.viteConfig,
        bundleCheck: cfg.bundle,
        structureCheck: cfg.structure,
        twilightManifestCheck: cfg.twilightManifest,
        cssVarCheck: cfg.cssVariables,
        colorCheck: cfg.colors,
        customRuleCheck: cfg.customRules,
        customRulesFile: cfg.customRulesFile || undefined,
    };
}

/* =============== Review engine client (worker thread, in-process fallback) =============== */

/**
 * All analysis runs in lib/review-worker.js on its own thread; this thread only
 * posts small messages and renders the replies. If the worker dies it is
 * restarted (a few times), then the same engine code runs in-process as a
 * last resort — still chunked, so the editor never freezes.
 */
const engine = (() => {
    let worker = null;
    let inline = null; // in-process fallback engine
    let nextId = 1;
    let restarts = 0;
    let manifestPath = null;
    const pending = new Map(); // id -> {resolve, reject}

    function spawn() {
        const w = new Worker(path.join(__dirname, "lib", "review-worker.js"), {
            resourceLimits: { maxOldGenerationSizeMb: 2048 },
        });
        w.on("message", (m) => {
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.ok) p.resolve(m.result);
            else p.reject(Object.assign(new Error(m.result && m.result.message), { stack: m.result && m.result.stack }));
        });
        w.on("error", (e) => { if (worker === w) died(`error: ${e && e.message}`); });
        w.on("exit", (code) => { if (worker === w) died(`exit ${code}`); });
        worker = w;
        if (manifestPath) post({ type: "setRaedManifest", path: manifestPath }).catch(() => { /* logged by died() */ });
    }

    function died(reason) {
        worker = null;
        for (const p of pending.values()) p.reject(new Error(`review engine restarted (${reason})`));
        pending.clear();
        restarts++;
        if (restarts > MAX_WORKER_RESTARTS) {
            inline = require("./lib/review-engine.js").createEngine();
            if (manifestPath) inline.handle({ type: "setRaedManifest", path: manifestPath });
            output.appendLine(`⚠️ review worker stopped (${reason}) — running the engine in-process from now on`);
        } else {
            output.appendLine(`⚠️ review worker stopped (${reason}) — restarting (${restarts}/${MAX_WORKER_RESTARTS})`);
        }
        // Everything on screen came from the lost state — start over
        resetShown();
        scanAll(false);
    }

    function post(msg) {
        if (inline) return inline.handle(msg);
        if (!worker) {
            try {
                spawn();
            } catch (e) {
                // Worker threads unavailable (packaging/runtime problem) — same engine, in-process
                inline = require("./lib/review-engine.js").createEngine();
                if (manifestPath) inline.handle({ type: "setRaedManifest", path: manifestPath });
                output.appendLine(`⚠️ could not start the review worker (${e && e.message}) — running the engine in-process`);
                return inline.handle(msg);
            }
        }
        return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ ...msg, id });
        });
    }

    return {
        request: post,
        setRaedManifest(p) {
            manifestPath = p;
            if (worker || inline) post({ type: "setRaedManifest", path: p }).catch(() => { /* logged by died() */ });
        },
        dispose() {
            const w = worker;
            worker = null;
            if (w) w.terminate();
        },
    };
})();

/* =============== Rendering (delta only) =============== */

const SEVERITY = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(d) {
    const diag = new vscode.Diagnostic(
        new vscode.Range(d.line, d.startCol, d.line, d.endCol),
        d.message,
        SEVERITY[d.severity] || vscode.DiagnosticSeverity.Warning
    );
    diag.source = "Salla Review";
    diag.code = d.code;
    return diag;
}

function newEntry() {
    return {
        projectRoot: null,
        shownFiles: new Set(),
        counts: null,
        versionIssues: [],
        versionDiags: [],
        pending: new Map(),
        timer: null,
        inFlight: false,
        watcher: null,
    };
}

function pkgPathOf(entry) {
    return entry.projectRoot ? path.join(entry.projectRoot, "package.json") : null;
}

/**
 * Apply an engine reply: only the files whose diagnostics changed are touched,
 * in ONE DiagnosticCollection.set() call (the array overload batches them into a
 * single message to the renderer). Previously every issue of every file was
 * rebuilt and re-set on each save — one message per file.
 */
function applyReply(root, reply) {
    const entry = roots.get(root);
    if (!entry) return { files: 0, ms: 0 };
    const t0 = Date.now();
    if (reply.projectRoot) entry.projectRoot = reply.projectRoot;
    const pkg = pkgPathOf(entry);
    const pkgKey = pkg ? fileKey(pkg) : null;

    const batch = [];
    const changed = new Set();
    for (const [file, diags] of reply.changed) {
        changed.add(file);
        let list = diags.map(toDiagnostic);
        if (pkgKey && fileKey(file) === pkgKey) list = list.concat(entry.versionDiags);
        batch.push([vscode.Uri.file(file), list]);
        entry.shownFiles.add(file);
    }
    const removed = reply.full ? [...entry.shownFiles].filter((f) => !changed.has(f)) : reply.removed;
    for (const file of removed) {
        const keepVersion = pkgKey && fileKey(file) === pkgKey && entry.versionDiags.length;
        batch.push([vscode.Uri.file(file), keepVersion ? entry.versionDiags : undefined]);
        entry.shownFiles.delete(file);
    }
    if (batch.length) diagnostics.set(batch);
    entry.counts = reply.counts;
    return { files: batch.length, ms: Date.now() - t0 };
}

function clearEntryDiagnostics(entry) {
    const batch = [...entry.shownFiles].map((f) => [vscode.Uri.file(f), undefined]);
    const pkg = pkgPathOf(entry);
    if (pkg && entry.versionDiags.length) batch.push([vscode.Uri.file(pkg), undefined]);
    if (batch.length) diagnostics.set(batch);
    entry.shownFiles.clear();
}

/** After the engine restarted: what is on screen no longer matches any state */
function resetShown() {
    diagnostics.clear();
    for (const entry of roots.values()) {
        entry.shownFiles.clear();
        entry.counts = null;
        entry.pending.clear();
        entry.inFlight = false;
    }
}

function updateStatusBar() {
    let errors = 0, warnings = 0;
    for (const entry of roots.values()) {
        if (entry.counts) {
            errors += entry.counts.errors;
            warnings += entry.counts.warnings;
        }
        for (const i of entry.versionIssues) {
            if (core.issueSeverity(i) === "error") errors++;
            else warnings++;
        }
    }
    const total = errors + warnings;
    statusItem.text = total > 0 ? `$(warning) Salla: ${errors}🔴 ${warnings}🟡` : "$(check) Salla";
    statusItem.tooltip = total > 0 ? `Salla Review: ${errors} خطأ، ${warnings} تحذير` : "Salla Review: لا توجد مشاكل";
    statusItem.show();
}

function entryTotal(entry) {
    return (entry.counts ? entry.counts.total : 0) + entry.versionIssues.length;
}

/* =============== Quick fixes (auto-fix from Problems panel / 💡) =============== */

/**
 * "Twig Naming" findings embed the bad and the corrected name in a stable message
 * format — parsed here (diagnostic objects don't round-trip custom fields reliably).
 * The whole-file edit is built lazily in resolveCodeAction, not on every cursor move.
 */
const TWIG_NAMING_MSG_RE = /"([A-Za-z_][A-Za-z0-9_]*)".*?التصحيح:\s*"([a-z0-9_]+)"/;

const quickFixProvider = {
    provideCodeActions(document, _range, context) {
        const actions = [];
        for (const d of context.diagnostics) {
            if (d.source !== "Salla Review" || d.code !== "Twig Naming") continue;
            const m = TWIG_NAMING_MSG_RE.exec(d.message);
            if (!m) continue;
            const [, from, to] = m;
            const action = new vscode.CodeAction(
                `إعادة تسمية "${from}" إلى "${to}" في كامل الملف`,
                vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [d];
            action.isPreferred = true;
            action._rename = { document, from, to };
            actions.push(action);
        }
        return actions;
    },
    resolveCodeAction(action) {
        const r = action._rename;
        if (!r) return action;
        const edit = new vscode.WorkspaceEdit();
        const text = r.document.getText();
        const wordRe = new RegExp("\\b" + r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
        let w;
        while ((w = wordRe.exec(text))) {
            edit.replace(
                r.document.uri,
                new vscode.Range(r.document.positionAt(w.index), r.document.positionAt(w.index + r.from.length)),
                r.to
            );
        }
        action.edit = edit;
        return action;
    },
};

/* =============== Theme roots =============== */

/**
 * Theme discovery through the workspace search service (ripgrep, off the
 * extension host) instead of a synchronous walk of every workspace folder.
 * Honours files.exclude like any other search.
 */
async function discoverThemeRoots() {
    const uris = await vscode.workspace.findFiles(
        "**/{twilight,twilight-bundle}.json",
        "**/{node_modules,public,.git,.salla-review}/**"
    );
    return core.pickTopLevelRoots(uris.map((u) => u.fsPath));
}

function slugForRoot(root) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    if (!folder) return path.basename(root);
    const rel = path.relative(folder.uri.fsPath, root);
    if (!rel) return path.basename(folder.uri.fsPath);
    return rel.split(path.sep)[0];
}

function displayBaseForRoot(root) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    return folder ? folder.uri.fsPath : path.dirname(root);
}

/** Which root owns this file? */
function rootForFile(p) {
    return [...roots.keys()]
        .filter((r) => p === r || p.startsWith(r + path.sep))
        .sort((a, b) => b.length - a.length)[0];
}

async function pickRoot(placeHolder) {
    const found = await discoverThemeRoots();
    if (found.length === 0) {
        vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        return null;
    }
    if (found.length === 1) return found[0];
    const pick = await vscode.window.showQuickPick(
        found.map((r) => ({ label: slugForRoot(r), description: r, root: r })),
        { placeHolder }
    );
    return pick ? pick.root : null;
}

// .json is included so saving the custom rules file re-applies the rules immediately
const RELEVANT_FILE_RE = /\.(twig|js|css|scss|json)$/i;

/** One watcher per theme root for create/delete (saves cover edits); scoped so unrelated folders cost nothing */
function ensureWatcher(entry, root) {
    if (entry.watcher) return;
    const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), "**/*.{twig,js,css,scss,json}"),
        false, true, false
    );
    w.onDidCreate((uri) => scheduleIncremental(uri.fsPath));
    w.onDidDelete((uri) => scheduleIncremental(uri.fsPath));
    entry.watcher = w;
}

function removeRoot(root) {
    const entry = roots.get(root);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.watcher) entry.watcher.dispose();
    clearEntryDiagnostics(entry);
    roots.delete(root);
    engine.request({ type: "removeRoot", root }).catch(() => { /* engine restart — handled there */ });
}

/* =============== Scanning =============== */

async function fullScanRoot(root) {
    let entry = roots.get(root);
    if (!entry) {
        entry = newEntry();
        roots.set(root, entry);
    }
    ensureWatcher(entry, root);
    const slug = slugForRoot(root);
    try {
        const reply = await engine.request({ type: "fullScan", root, opts: engineOpts(getConfig(root)) });
        if (!roots.has(root)) return; // removed meanwhile
        const r = applyReply(root, reply);
        output.appendLine(
            `⏱ scan ${slug}: engine ${reply.ms} ms (${reply.files} files, ${reply.counts.total} findings) — render ${r.files} files ${r.ms} ms`
        );
    } catch (e) {
        output.appendLine(`⚠️ scan ${slug} failed: ${e.message}`);
    }
}

async function scanAll(showSummary) {
    const found = await discoverThemeRoots();
    if (found.length === 0) {
        if (showSummary) {
            vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        }
        return;
    }

    // Remove roots that disappeared
    for (const known of [...roots.keys()]) {
        if (!found.includes(known)) removeRoot(known);
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Salla Review" },
        async (progress) => {
            for (const root of found) {
                progress.report({ message: `مراجعة ${slugForRoot(root)}…` });
                await fullScanRoot(root); // runs in the worker — this thread stays free
            }
        }
    );
    updateStatusBar();

    // Network check after showing local results (does not delay their display)
    for (const root of found) refreshVersionIssues(root);

    const summary = [...roots.entries()].map(([root, entry]) => ({
        slug: slugForRoot(root),
        count: entryTotal(entry),
    }));
    const withIssues = summary.filter((s) => s.count > 0);
    const clean = summary.filter((s) => s.count === 0);
    const total = withIssues.reduce((a, s) => a + s.count, 0);

    output.appendLine(`📋 ملخص المراجعة (${new Date().toLocaleString()})`);
    output.appendLine(" - الثيمات التي بها مشاكل:");
    output.appendLine(withIssues.length ? "   " + withIssues.map((s) => `${s.slug} (${s.count})`).join(", ") : "   (لا يوجد)");
    output.appendLine(" - الثيمات السليمة (بدون مشاكل):");
    output.appendLine(clean.length ? "   " + clean.map((s) => s.slug).join(", ") : "   (لا يوجد)");

    if (showSummary) {
        if (total > 0) {
            const pick = await vscode.window.showWarningMessage(
                `Salla Review: ${total} ملاحظة في ${withIssues.length} ثيم`,
                "عرض المشاكل",
                "توليد التقرير"
            );
            if (pick === "عرض المشاكل") vscode.commands.executeCommand("workbench.actions.view.problems");
            if (pick === "توليد التقرير") vscode.commands.executeCommand("sallaReview.report");
        } else {
            vscode.window.showInformationMessage("Salla Review: ✅ لا توجد مشاكل.");
        }
    }
}

/** Twilight versions check (network, this thread) — not repeated on every save; 6-hour cache */
async function refreshVersionIssues(root) {
    const entry = roots.get(root);
    if (!entry || !entry.projectRoot) return;
    const cfg = getConfig(root);
    if (!cfg.twilightVersion || !globalStoragePath) {
        entry.versionIssues = [];
    } else {
        try {
            // If package.json is open with unsaved edits, check the live buffer, not the disk
            const pkgPath = pkgPathOf(entry);
            const openDoc = vscode.workspace.textDocuments.find(
                (d) => d.uri.scheme === "file" && d.isDirty && fileKey(d.uri.fsPath) === fileKey(pkgPath)
            );
            entry.versionIssues = await twilightVersion.checkTwilightVersions(entry.projectRoot, {
                cacheFile: path.join(globalStoragePath, "twilight-versions-cache.json"),
                pkgRaw: openDoc ? openDoc.getText() : undefined,
            });
        } catch {
            entry.versionIssues = [];
        }
    }
    if (!roots.has(root)) return;
    entry.versionDiags = entry.versionIssues.map((i) => toDiagnostic(core.diagnosticFieldsFor(i)));
    renderVersionDiags(entry);
    updateStatusBar();
}

/** package.json shows the engine's findings for that file plus the version findings from here */
function renderVersionDiags(entry) {
    const pkg = pkgPathOf(entry);
    if (!pkg) return;
    const uri = vscode.Uri.file(pkg);
    const fromEngine = (diagnostics.get(uri) || []).filter((d) => d.code !== "Twilight Version");
    const all = fromEngine.concat(entry.versionDiags);
    diagnostics.set(uri, all.length ? all : undefined);
}

/* =============== Incremental refresh =============== */

/**
 * Queue a file for an incremental refresh of its theme. `liveDoc` set = an
 * as-you-type refresh (the buffer is read when the debounce fires, not now);
 * otherwise (save, create, delete, close) the engine reads the disk again.
 */
function scheduleIncremental(fileFsPath, liveDoc) {
    // Cheapest checks first — this runs for every watcher event and keystroke
    if (!RELEVANT_FILE_RE.test(fileFsPath)) return;
    // The full engine skip list — includes .salla-review/.githooks/.github/.vscode,
    // so saving vendored CI files never triggers an analysis of them
    if (fileFsPath.split(path.sep).some((s) => core.SKIP_DIRS.has(s))) return;

    const root = rootForFile(fileFsPath);
    if (!root) {
        // A new file may have created a new theme (a new twilight.json)
        if (!liveDoc && /twilight(-bundle)?\.json$/i.test(fileFsPath)) scanAll(false);
        return;
    }
    const cfg = getConfig(fileFsPath);
    if (liveDoc ? !cfg.runOnType : !cfg.runOnSave) return;
    if (liveDoc) liveFiles.add(fileKey(fileFsPath));
    else liveFiles.delete(fileKey(fileFsPath));
    queueRefresh(root, fileFsPath, liveDoc || null);
}

function queueRefresh(root, file, liveDoc) {
    const entry = roots.get(root);
    if (!entry) return;
    entry.pending.set(file, liveDoc);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushRefresh(root), liveDoc ? LIVE_DEBOUNCE_MS : SAVE_DEBOUNCE_MS);
}

/** One round-trip per root: every file queued during the debounce window goes in a single message */
async function flushRefresh(root) {
    const entry = roots.get(root);
    if (!entry || entry.inFlight || entry.pending.size === 0) return;
    const files = [...entry.pending].map(([file, doc]) => ({ file, liveText: doc ? doc.getText() : null }));
    entry.pending.clear();
    entry.inFlight = true;
    const slug = slugForRoot(root);
    const t0 = Date.now();
    try {
        const reply = await engine.request({ type: "refreshFiles", root, files, opts: engineOpts(getConfig(root)) });
        if (!roots.has(root)) return;
        if (reply.missing) {
            await fullScanRoot(root); // the engine lost this root (restart) — rebuild it
        } else {
            const r = applyReply(root, reply);
            updateStatusBar();
            // Saving package.json changes the declared @salla.sa/twilight* versions —
            // recompute the Twilight Version findings too (registry lists stay cached 6h).
            if (files.some((f) => path.basename(f.file).toLowerCase() === "package.json")) refreshVersionIssues(root);
            const elapsed = Date.now() - t0;
            vscode.window.setStatusBarMessage(`Salla Review: ${slug} — ${entryTotal(entry)} ملاحظة (${elapsed}ms)`, 3000);
            output.appendLine(
                `⏱ refresh ${slug} (${files.length} file${files.length > 1 ? "s" : ""}): engine ${reply.ms} ms — render ${r.files} files ${r.ms} ms — total ${elapsed} ms`
            );
        }
    } catch (e) {
        output.appendLine(`⚠️ refresh ${slug} failed: ${e.message}`);
    } finally {
        entry.inFlight = false;
        if (entry.pending.size) flushRefresh(root);
    }
}

/* =============== Reports =============== */

async function generateReports() {
    if (roots.size === 0) await scanAll(false);
    if (roots.size === 0) {
        vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        return;
    }

    let firstReport = null;
    for (const [root, entry] of roots) {
        const slug = slugForRoot(root);
        const base = displayBaseForRoot(root);
        // Raed parity is computed only here (not on every scan) — in the worker
        const reply = await engine.request({
            type: "report",
            root,
            slug,
            displayBase: base,
            raedParity: getConfig(root).raedParity,
            extraIssues: entry.versionIssues,
        });
        if (reply.missing) continue;
        const reportsDir = path.join(base, "reports");
        fs.mkdirSync(reportsDir, { recursive: true });
        const file = path.join(reportsDir, `${slug}-report.md`);
        fs.writeFileSync(file, reply.markdown, "utf8");
        if (!firstReport) firstReport = file;
    }

    if (firstReport) {
        const doc = await vscode.workspace.openTextDocument(firstReport);
        await vscode.window.showTextDocument(doc, { preview: true });
        await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(firstReport));
        vscode.window.setStatusBarMessage(`Salla Review: تم حفظ ${roots.size} تقرير داخل reports/`, 5000);
    }
}

/* =============== Updating the Raed reference from GitHub =============== */

function raedPaths() {
    return {
        manifest: path.join(globalStoragePath, "raed-manifest.json"),
        meta: path.join(globalStoragePath, "raed-meta.json"),
    };
}

function readRaedMeta() {
    try {
        return JSON.parse(fs.readFileSync(raedPaths().meta, "utf8"));
    } catch {
        return {};
    }
}

async function updateRaedReference(silent) {
    const { manifest, meta } = raedPaths();
    const prev = readRaedMeta();
    try {
        const sha = await raedUpdater.getLatestSha();
        if (sha === prev.sha && fs.existsSync(manifest)) {
            fs.writeFileSync(meta, JSON.stringify({ sha, checkedAt: Date.now() }), "utf8");
            if (!silent) vscode.window.showInformationMessage(`Salla Review: مرجع رائد محدّث بالفعل (${sha.slice(0, 10)})`);
            return false;
        }
        const r = await raedUpdater.updateRaedManifest(manifest, { sha });
        fs.writeFileSync(meta, JSON.stringify({ sha: r.sha, checkedAt: Date.now(), raedVersion: r.raedVersion }), "utf8");
        engine.setRaedManifest(manifest);
        output.appendLine(`🔄 تم تحديث مرجع رائد → v${r.raedVersion || "?"} (commit ${r.sha.slice(0, 10)})`);
        vscode.window.showInformationMessage(
            `Salla Review: تم تحديث مرجع رائد إلى v${r.raedVersion || "?"} (${r.sha.slice(0, 10)}) — أعد المراجعة لاعتماد المرجع الجديد`,
            "مراجعة الآن"
        ).then((pick) => { if (pick === "مراجعة الآن") scanAll(false); });
        return true;
    } catch (e) {
        output.appendLine(`⚠️ تعذر تحديث مرجع رائد: ${e.message}`);
        if (!silent) vscode.window.showWarningMessage(`Salla Review: تعذر تحديث مرجع رائد — ${e.message}`);
        return false;
    }
}

function maybeAutoUpdateRaed() {
    const days = getConfig().raedAutoUpdateDays;
    if (!days || days <= 0) return;
    const prev = readRaedMeta();
    const ageMs = Date.now() - (prev.checkedAt || 0);
    if (ageMs < days * 24 * 60 * 60 * 1000) return;
    updateRaedReference(true);
}

/* =============== Setup Git & CI checks in the theme repo =============== */

const { execFile } = require("child_process");

function execGit(gitArgs, cwd) {
    return new Promise((resolve) => {
        execFile("git", gitArgs, { cwd }, (err, stdout) => {
            resolve(err ? null : String(stdout).trim());
        });
    });
}

/** Files vendored into <theme>/.salla-review/ so hooks and CI need no installs. */
const VENDOR_FILES = [
    ["cli.js", "cli.js"],
    ["lib/salla-review-core.js", "lib/salla-review-core.js"],
    ["lib/twilight-version.js", "lib/twilight-version.js"],
    ["lib/raed-manifest.json", "lib/raed-manifest.json"],
];

/**
 * Scaffold commit/push/merge gates into a theme repository:
 * a vendored engine copy, pre-commit + pre-push hooks, and a GitHub Actions
 * workflow that fails on error-severity findings (gates PR merges when the
 * check is required in branch protection).
 */
async function setupCiChecks() {
    const root = await pickRoot("اختر الثيم الذي تريد تفعيل فحوصات Git/CI له");
    if (!root) return;

    const write = (rel, content, exec) => {
        const abs = path.join(root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        if (exec) { try { fs.chmodSync(abs, 0o755); } catch { /* not needed on Windows */ } }
    };
    const template = (name) => fs.readFileSync(path.join(extensionPath, "templates", name), "utf8");

    try {
        // 1) Vendor the engine (self-contained, zero dependencies)
        for (const [src, dest] of VENDOR_FILES) {
            write(".salla-review/" + dest, fs.readFileSync(path.join(extensionPath, src), "utf8"));
        }
        // Ship the freshest Raed manifest we have (globalStorage copy wins over the packaged one)
        const gsManifest = path.join(globalStoragePath, "raed-manifest.json");
        if (fs.existsSync(gsManifest)) {
            write(".salla-review/lib/raed-manifest.json", fs.readFileSync(gsManifest, "utf8"));
        }
        write(".salla-review/README.md", template("ci-readme.md"));

        // 2) Detect the git repository and the theme's location inside it
        const toplevel = await execGit(["rev-parse", "--show-toplevel"], root);
        // Path of the theme relative to the repo root, "." when they coincide
        const themeDir = toplevel
            ? (path.relative(toplevel, root).split(path.sep).join("/") || ".")
            : ".";

        // 3) Hooks + workflow (written at the repo root when the theme is nested)
        const fileRoot = toplevel || root;
        const writeAt = (rel, content, exec) => {
            const abs = path.join(fileRoot, ...rel.split("/"));
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, "utf8");
            if (exec) { try { fs.chmodSync(abs, 0o755); } catch { /* not needed on Windows */ } }
        };
        const ci = getConfig(root).ci;
        const fill = (t) => t.replaceAll("{{THEME_DIR}}", themeDir).replaceAll("{{FAIL_ON}}", ci.failOn);
        const generated = [];
        if (ci.preCommitHook) { writeAt(".githooks/pre-commit", fill(template("pre-commit")), true); generated.push("pre-commit"); }
        if (ci.prePushHook) { writeAt(".githooks/pre-push", fill(template("pre-push")), true); generated.push("pre-push"); }
        if (ci.workflow) { writeAt(".github/workflows/salla-review.yml", fill(template("salla-review.yml"))); generated.push("workflow"); }

        // 4) Activate the hooks for this clone
        let hooksActivated = false;
        if (toplevel && (ci.preCommitHook || ci.prePushHook)) {
            hooksActivated = (await execGit(["config", "core.hooksPath", ".githooks"], toplevel)) !== null;
        }

        output.appendLine(`🔧 CI setup at ${fileRoot} (theme dir: ${themeDir}, fail-on: ${ci.failOn}, generated: ${generated.join("+") || "engine only"}, hooks ${hooksActivated ? "activated" : "not activated"})`);
        if (!toplevel) {
            vscode.window.showWarningMessage(
                "Salla Review: تم إنشاء ملفات الفحص، لكن المجلد ليس مستودع Git — الهوكس لن تعمل حتى تنفّذ git init ثم تعيد الأمر."
            );
        } else {
            const parts = [];
            if (ci.preCommitHook || ci.prePushHook) {
                parts.push(`هوكس ${[ci.preCommitHook && "pre-commit", ci.prePushHook && "pre-push"].filter(Boolean).join(" و")} مفعّلة`);
            }
            if (ci.workflow) parts.push("workflow جاهز على كل push/PR");
            vscode.window.showInformationMessage(
                `Salla Review: ✅ تم تجهيز فحوصات Git/CI — ${parts.join("، ") || "المحرك فقط"}. ادفع الملفات الجديدة` +
                (hooksActivated ? " وأخبر الفريق بتنفيذ: git config core.hooksPath .githooks" : "")
            );
        }
    } catch (e) {
        vscode.window.showErrorMessage(`Salla Review: فشل تجهيز فحوصات CI — ${e.message}`);
    }
}

/**
 * Open the theme's custom rules file, creating it from the documented template
 * on first use. This is how a developer answers a brand-new Salla rule without
 * waiting for an extension update.
 */
async function editCustomRules() {
    const root = await pickRoot("اختر الثيم الذي تريد تحرير قواعده المخصصة");
    if (!root) return;

    const cfg = getConfig(root);
    const rel = cfg.customRulesFile || core.DEFAULT_RULES_FILE;
    const abs = path.join(root, ...String(rel).split("/"));
    let created = false;
    if (!fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(path.join(extensionPath, "templates", "salla-rules.json"), "utf8"), "utf8");
        created = true;
    }
    const doc = await vscode.workspace.openTextDocument(abs);
    await vscode.window.showTextDocument(doc);
    if (created) {
        vscode.window.showInformationMessage(
            "Salla Review: تم إنشاء ملف القواعد المخصصة — عدّل الأمثلة ثم احفظ لتطبيقها فوراً على الثيم."
        );
    }
}

/* =============== Activation =============== */

function activate(context) {
    diagnostics = vscode.languages.createDiagnosticCollection("salla-review");
    output = vscode.window.createOutputChannel("Salla Review");
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusItem.command = "workbench.actions.view.problems";

    globalStoragePath = context.globalStorageUri.fsPath;
    extensionPath = context.extensionPath;
    try { fs.mkdirSync(globalStoragePath, { recursive: true }); } catch { /* non-fatal */ }

    const storedManifest = raedPaths().manifest;
    if (fs.existsSync(storedManifest)) engine.setRaedManifest(storedManifest);

    // New/removed themes only — per-theme file watchers are created with each root
    const markerWatcher = vscode.workspace.createFileSystemWatcher("**/{twilight,twilight-bundle}.json", false, true, false);
    markerWatcher.onDidCreate((uri) => scheduleIncremental(uri.fsPath));
    markerWatcher.onDidDelete(() => scanAll(false));

    context.subscriptions.push(
        diagnostics,
        output,
        statusItem,
        markerWatcher,
        { dispose: () => { for (const root of [...roots.keys()]) removeRoot(root); engine.dispose(); } },
        vscode.languages.registerCodeActionsProvider(
            { pattern: "**/*.twig" },
            quickFixProvider,
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        ),
        vscode.commands.registerCommand("sallaReview.scan", () => scanAll(true)),
        vscode.commands.registerCommand("sallaReview.report", () => generateReports()),
        vscode.commands.registerCommand("sallaReview.setupCi", () => setupCiChecks()),
        vscode.commands.registerCommand("sallaReview.editCustomRules", () => editCustomRules()),
        vscode.commands.registerCommand("sallaReview.updateRaed", () =>
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: "Salla Review: تحديث مرجع رائد من GitHub…" },
                () => updateRaedReference(false)
            )
        ),
        vscode.commands.registerCommand("sallaReview.clear", () => {
            for (const root of [...roots.keys()]) removeRoot(root);
            diagnostics.clear();
            liveFiles.clear();
            statusItem.hide();
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("sallaReview")) configCache.clear();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            configCache.clear();
            scanAll(false);
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.scheme === "file") scheduleIncremental(doc.uri.fsPath);
        }),
        // Live re-check while typing (opt-in via sallaReview.runOnType). This
        // fires on every keystroke window-wide, so only cached lookups happen
        // here; the buffer text is read when the debounce fires.
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.scheme !== "file" || e.contentChanges.length === 0) return;
            const fsPath = e.document.uri.fsPath;
            if (!RELEVANT_FILE_RE.test(fsPath)) return;
            if (!getConfig(fsPath).runOnType) return;
            scheduleIncremental(fsPath, e.document);
        }),
        // Closing a file whose buffer was registered discards it — analyze the disk
        // state again. Closing a clean tab (the common case) does nothing at all.
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.uri.scheme !== "file") return;
            const fsPath = doc.uri.fsPath;
            if (!liveFiles.delete(fileKey(fsPath))) return;
            const root = rootForFile(fsPath);
            if (root) queueRefresh(root, fsPath, null);
            else engine.request({ type: "setContent", file: fsPath, text: null }).catch(() => { /* engine restart */ });
        })
    );

    if (getConfig().scanOnStartup) {
        setTimeout(() => scanAll(false), 1500);
    }
    setTimeout(() => maybeAutoUpdateRaed(), 5000);
}

function deactivate() {
    engine.dispose();
}

module.exports = { activate, deactivate };
