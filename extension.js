"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("./lib/salla-review-core.js");
const twilightVersion = require("./lib/twilight-version.js");
const raedUpdater = require("./lib/raed-updater.js");

let globalStoragePath = null; // versions cache + the updated Raed manifest
let extensionPath = null; // extension install dir — source for vendored CI files
let diagnostics; // vscode.DiagnosticCollection
let output; // vscode.OutputChannel
let statusItem; // vscode.StatusBarItem

/**
 * Per theme root: the incremental engine state + version-check results (network)
 * + the files currently shown in Problems (so stale ones can be cleared).
 * Map<rootPath, { state, versionIssues, shownFiles: Set<string> }>
 */
const roots = new Map();
const saveTimers = new Map(); // debounce per root

/**
 * Read settings scoped to the project folder (resource scope) — each theme can
 * customize its checks and patterns from its own .vscode/settings.json. The old
 * keys (pre 0.5.0) are read as a fallback so saved preferences are not lost.
 */
function getConfig(scopePath) {
    const scope = scopePath ? vscode.Uri.file(scopePath) : null;
    const cfg = vscode.workspace.getConfiguration("sallaReview", scope);
    const check = (name, legacy) => {
        const v = cfg.get("checks." + name);
        if (typeof v === "boolean") return v;
        if (legacy) {
            const lv = cfg.get(legacy);
            if (typeof lv === "boolean") return lv;
        }
        return true;
    };
    return {
        runOnSave: cfg.get("runOnSave", true),
        scanOnStartup: cfg.get("scanOnStartup", true),
        raedAutoUpdateDays: cfg.get("raedAutoUpdateDays", 7),
        ci: {
            failOn: cfg.get("ci.failOn", "error"),
            preCommitHook: cfg.get("ci.preCommitHook", true),
            prePushHook: cfg.get("ci.prePushHook", true),
            workflow: cfg.get("ci.workflow", true),
        },
        ignoredTexts: cfg.get("ignoredTexts", []),
        exclude: cfg.get("exclude", []),

        uiText: check("uiText"),
        twigBlocks: check("twigBlocks", "twigSyntaxCheck"),
        jsSyntax: check("jsSyntax", "nodeSyntaxCheck"),
        cssBraces: check("cssBraces"),
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
        cssVariables: check("cssVariables", "cssVarCheck"),
        colors: check("colors", "colorCheck"),
        twilightVersion: check("twilightVersion", "twilightVersionCheck"),
        raedParity: check("raedParity", "reportIncludesRaedParity"),
        customRules: check("customRules"),
        customRulesFile: cfg.get("customRulesFile", ""),
    };
}

function severityFor(issue) {
    if (issue.severity === "error") return vscode.DiagnosticSeverity.Error;
    if (issue.severity === "warning") return vscode.DiagnosticSeverity.Warning;
    if (issue.severity === "info") return vscode.DiagnosticSeverity.Information;
    return core.ERROR_TYPES.has(issue.type)
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
}

function issueToDiagnostic(issue) {
    const lineIdx = Math.max(0, (issue.line || 1) - 1);
    const lineText = (issue.lines && issue.lines[lineIdx]) || "";
    const startCol = Math.max(0, lineText.search(/\S/));
    const endCol = Math.max(startCol + 1, lineText.length);
    const range = new vscode.Range(lineIdx, startCol, lineIdx, endCol);

    let message = issue.desc || issue.type;
    if (issue.visible) {
        const v = issue.visible.length > 120 ? issue.visible.slice(0, 117) + "…" : issue.visible;
        message += `: "${v}"`;
    }
    const d = new vscode.Diagnostic(range, message, severityFor(issue));
    d.source = "Salla Review";
    d.code = issue.type;
    return d;
}

function allThemeRoots() {
    const found = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
        found.push(...core.findThemeRoots(folder.uri.fsPath));
    }
    return found;
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

/** Engine options from the settings (Raed parity is computed only at report time — not here) */
function engineOpts(cfg) {
    return {
        ignoredTexts: cfg.ignoredTexts,
        exclude: cfg.exclude,

        uiTextCheck: cfg.uiText,
        twigSyntaxCheck: cfg.twigBlocks,
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

function entryIssues(entry) {
    return [...core.stateIssues(entry.state), ...entry.versionIssues];
}

/** Re-render the diagnostics of a single root from its state (in memory — fast) */
function renderRoot(root) {
    const entry = roots.get(root);
    if (!entry) return;

    const byFile = new Map();
    for (const issue of entryIssues(entry)) {
        if (!byFile.has(issue.file)) byFile.set(issue.file, []);
        byFile.get(issue.file).push(issueToDiagnostic(issue));
    }

    // Clear files that no longer have issues
    for (const f of entry.shownFiles) {
        if (!byFile.has(f)) diagnostics.delete(vscode.Uri.file(f));
    }
    for (const [file, diags] of byFile) {
        diagnostics.set(vscode.Uri.file(file), diags);
    }
    entry.shownFiles = new Set(byFile.keys());
}

function updateStatusBar() {
    let errors = 0, warnings = 0;
    for (const [, entry] of roots) {
        for (const i of entryIssues(entry)) {
            const sev = severityFor(i);
            if (sev === vscode.DiagnosticSeverity.Error) errors++;
            else if (sev === vscode.DiagnosticSeverity.Warning) warnings++;
        }
    }
    const total = errors + warnings;
    statusItem.text = total > 0 ? `$(warning) Salla: ${errors}🔴 ${warnings}🟡` : "$(check) Salla";
    statusItem.tooltip = total > 0 ? `Salla Review: ${errors} خطأ، ${warnings} تحذير` : "Salla Review: لا توجد مشاكل";
    statusItem.show();
}

/** Full scan of a single root (synchronous, but fast now — no external node processes) */
function fullScanRoot(root, cfg) {
    const prev = roots.get(root);
    const state = core.createThemeState(root, engineOpts(cfg));
    roots.set(root, {
        state,
        versionIssues: prev ? prev.versionIssues : [],
        shownFiles: prev ? prev.shownFiles : new Set(),
    });
    renderRoot(root);
}

/** Twilight versions check (network) — not repeated on every save; 6-hour cache */
async function refreshVersionIssues(root, cfg) {
    const entry = roots.get(root);
    if (!entry || !cfg.twilightVersion || !globalStoragePath) {
        if (entry) entry.versionIssues = [];
        return;
    }
    try {
        entry.versionIssues = await twilightVersion.checkTwilightVersions(entry.state.projectRoot, {
            cacheFile: path.join(globalStoragePath, "twilight-versions-cache.json"),
        });
    } catch {
        entry.versionIssues = [];
    }
    renderRoot(root);
    updateStatusBar();
}

async function scanAll(showSummary) {
    const cfg = getConfig();
    const found = allThemeRoots();
    if (found.length === 0) {
        if (showSummary) {
            vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        }
        return;
    }

    // Remove roots that disappeared
    for (const known of [...roots.keys()]) {
        if (!found.includes(known)) {
            const entry = roots.get(known);
            for (const f of entry.shownFiles) diagnostics.delete(vscode.Uri.file(f));
            roots.delete(known);
        }
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Salla Review" },
        async (progress) => {
            for (const root of found) {
                progress.report({ message: `مراجعة ${slugForRoot(root)}…` });
                // Yield an event-loop tick between roots so we don't freeze other extensions
                await new Promise((r) => setImmediate(r));
                fullScanRoot(root, getConfig(root)); // settings scoped to the project folder
            }
        }
    );
    updateStatusBar();

    // Network check after showing local results (does not delay their display)
    for (const root of found) refreshVersionIssues(root, getConfig(root));

    const summary = [...roots.entries()].map(([root, entry]) => ({
        slug: slugForRoot(root),
        count: entryIssues(entry).length,
    }));
    const withIssues = summary.filter((s) => s.count > 0);
    const clean = summary.filter((s) => s.count === 0);
    const total = withIssues.reduce((a, s) => a + s.count, 0);

    output.clear();
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

async function generateReports() {
    const cfg = getConfig();
    if (roots.size === 0) await scanAll(false);
    if (roots.size === 0) {
        vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        return;
    }

    let firstReport = null;
    for (const [root, entry] of roots) {
        const slug = slugForRoot(root);
        const base = displayBaseForRoot(root);
        // Raed parity is computed only here (not on every scan) — a big saving in scan time
        const parity = cfg.raedParity ? core.compareWithRaed(entry.state.projectRoot) : null;
        const md = core.buildReportMarkdown(slug, entryIssues(entry), parity, base);
        const reportsDir = path.join(base, "reports");
        fs.mkdirSync(reportsDir, { recursive: true });
        const file = path.join(reportsDir, `${slug}-report.md`);
        fs.writeFileSync(file, md, "utf8");
        if (!firstReport) firstReport = file;
    }

    if (firstReport) {
        const doc = await vscode.workspace.openTextDocument(firstReport);
        await vscode.window.showTextDocument(doc, { preview: true });
        await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(firstReport));
        vscode.window.setStatusBarMessage(`Salla Review: تم حفظ ${roots.size} تقرير داخل reports/`, 5000);
    }
}

/** Which root owns this file? */
function rootForFile(p) {
    return [...roots.keys()]
        .filter((r) => p === r || p.startsWith(r + path.sep))
        .sort((a, b) => b.length - a.length)[0];
}

// .json is included so saving the custom rules file re-applies the rules immediately
const RELEVANT_FILE_RE = /\.(twig|js|css|scss|json)$/i;

/** Incremental update for a single file — only the file is re-analyzed, then the cross-file checks run from memory */
function scheduleIncremental(fileFsPath) {
    const cfg = getConfig(fileFsPath);
    if (!cfg.runOnSave) return;
    if (!RELEVANT_FILE_RE.test(fileFsPath)) return;
    // The full engine skip list — includes .salla-review/.githooks/.github/.vscode,
    // so saving vendored CI files never triggers an analysis of them
    if (fileFsPath.split(path.sep).some((s) => core.SKIP_DIRS.has(s))) return;

    const root = rootForFile(fileFsPath);
    if (!root) {
        // A new file may have created a new theme (a new twilight.json)
        if (/twilight(-bundle)?\.json$/i.test(fileFsPath)) scanAll(false);
        return;
    }

    clearTimeout(saveTimers.get(root));
    saveTimers.set(root, setTimeout(() => {
        const entry = roots.get(root);
        if (!entry) return;
        entry.state.opts = engineOpts(cfg); // pick up any settings change
        entry.state.filters = core.compilePathFilters(entry.state.opts);
        const t0 = Date.now();
        core.refreshFileInState(entry.state, fileFsPath);
        renderRoot(root);
        updateStatusBar();
        const count = entryIssues(entry).length;
        vscode.window.setStatusBarMessage(
            `Salla Review: ${slugForRoot(root)} — ${count} ملاحظة (${Date.now() - t0}ms)`,
            3000
        );
    }, 350));
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
        core.setRaedManifestPath(manifest);
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
    const found = allThemeRoots();
    if (found.length === 0) {
        vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        return;
    }
    let root = found[0];
    if (found.length > 1) {
        const pick = await vscode.window.showQuickPick(
            found.map((r) => ({ label: slugForRoot(r), description: r, root: r })),
            { placeHolder: "اختر الثيم الذي تريد تفعيل فحوصات Git/CI له" }
        );
        if (!pick) return;
        root = pick.root;
    }

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
            vscode.window.showInformationMessage(
                `Salla Review: ✅ تم تفعيل فحوصات Git/CI — pre-commit وpre-push مفعّلان، وworkflow جاهز على كل push/PR. ادفع الملفات الجديدة (.salla-review، .githooks، .github) وأخبر الفريق بتنفيذ: git config core.hooksPath .githooks`
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
    const found = allThemeRoots();
    if (found.length === 0) {
        vscode.window.showWarningMessage("Salla Review: لا يوجد أي ثيم (twilight.json) في الـ workspace.");
        return;
    }
    let root = found[0];
    if (found.length > 1) {
        const pick = await vscode.window.showQuickPick(
            found.map((r) => ({ label: slugForRoot(r), description: r, root: r })),
            { placeHolder: "اختر الثيم الذي تريد تحرير قواعده المخصصة" }
        );
        if (!pick) return;
        root = pick.root;
    }

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

function activate(context) {
    diagnostics = vscode.languages.createDiagnosticCollection("salla-review");
    output = vscode.window.createOutputChannel("Salla Review");
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusItem.command = "workbench.actions.view.problems";

    globalStoragePath = context.globalStorageUri.fsPath;
    extensionPath = context.extensionPath;
    try { fs.mkdirSync(globalStoragePath, { recursive: true }); } catch { /* non-fatal */ }

    const storedManifest = raedPaths().manifest;
    if (fs.existsSync(storedManifest)) core.setRaedManifestPath(storedManifest);

    // Watch file create/delete (save covers edits) — incremental update, not a full scan
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{twig,js,css,scss,json}");
    watcher.onDidCreate((uri) => scheduleIncremental(uri.fsPath));
    watcher.onDidDelete((uri) => scheduleIncremental(uri.fsPath));

    context.subscriptions.push(
        diagnostics,
        output,
        statusItem,
        watcher,
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
            diagnostics.clear();
            roots.clear();
            statusItem.hide();
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => scheduleIncremental(doc.uri.fsPath))
    );

    if (getConfig().scanOnStartup) {
        setTimeout(() => scanAll(false), 1500);
    }
    setTimeout(() => maybeAutoUpdateRaed(), 5000);
}

function deactivate() {}

module.exports = { activate, deactivate };
