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
let extensionContext = null; // globalState: the AI agent the user picked
let diagnostics; // vscode.DiagnosticCollection
let output; // vscode.OutputChannel
let statusItem; // vscode.StatusBarItem — finding counts
let agentItem; // vscode.StatusBarItem — always-visible "Send all to Agent" button

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
        mentionAffectedFiles: cfg.get("mentionAffectedFiles", false),
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
        requiredLocation: cfg.get("requiredLocation", "sameFile"),
        sliderSource: check("sliderSource"),
        themeSize: check("themeSize"),
        twigDivision: check("twigDivision"),
        mergeConflicts: check("mergeConflicts"),
        viteConfig: check("viteConfig"),
        bundle: check("bundle"),
        structure: check("structure"),
        lockfile: check("lockfile"),
        templateRefs: check("templateRefs"),
        productCardFetch: check("productCardFetch"),
        themeVisibility: cfg.get("themeVisibility", "public"),
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
        requiredLocation: cfg.requiredLocation,
        sliderSourceCheck: cfg.sliderSource,
        sizeCheck: cfg.themeSize,
        divisionCheck: cfg.twigDivision,
        mergeConflicts: cfg.mergeConflicts,
        viteCheck: cfg.viteConfig,
        bundleCheck: cfg.bundle,
        structureCheck: cfg.structure,
        lockfileCheck: cfg.lockfile,
        templateRefCheck: cfg.templateRefs,
        productCardFetch: cfg.productCardFetch,
        themeVisibility: cfg.themeVisibility,
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
    if (batch.length) {
        diagnostics.set(batch);
        refreshFindingsView();
    }
    entry.counts = reply.counts;
    return { files: batch.length, ms: Date.now() - t0 };
}

function clearEntryDiagnostics(entry) {
    const batch = [...entry.shownFiles].map((f) => [vscode.Uri.file(f), undefined]);
    const pkg = pkgPathOf(entry);
    if (pkg && entry.versionDiags.length) batch.push([vscode.Uri.file(pkg), undefined]);
    if (batch.length) {
        diagnostics.set(batch);
        refreshFindingsView();
    }
    entry.shownFiles.clear();
}

/** After the engine restarted: what is on screen no longer matches any state */
function resetShown() {
    diagnostics.clear();
    refreshFindingsView();
    for (const entry of roots.values()) {
        entry.shownFiles.clear();
        entry.counts = null;
        entry.pending.clear();
        entry.inFlight = false;
    }
}

/**
 * The status bar mirrors what the Problems panel shows for this extension —
 * every severity, informational findings included. Counting only errors and
 * warnings here made the two disagree whenever an Information-level check
 * (hardcoded colors, macro naming) had findings.
 */
function updateStatusBar() {
    let errors = 0, warnings = 0, infos = 0;
    for (const entry of roots.values()) {
        if (entry.counts) {
            errors += entry.counts.errors;
            warnings += entry.counts.warnings;
            infos += entry.counts.infos;
        }
        for (const i of entry.versionIssues) {
            const sev = core.issueSeverity(i);
            if (sev === "error") errors++;
            else if (sev === "warning") warnings++;
            else infos++;
        }
    }
    const total = errors + warnings + infos;
    const parts = [`${errors}🔴`, `${warnings}🟡`];
    if (infos) parts.push(`${infos}🔵`);
    statusItem.text = total > 0 ? `$(warning) Salla: ${parts.join(" ")}` : "$(check) Salla";
    statusItem.tooltip = total > 0
        ? `Salla Review: ${errors} خطأ، ${warnings} تحذير، ${infos} معلومة (${total} في لوحة Problems)`
        : "Salla Review: لا توجد مشاكل";
    statusItem.show();

    // The one-click "hand everything to the agent" button — visible whenever
    // there is something to hand over, wherever the user is in the editor.
    if (total > 0) {
        agentItem.text = `$(sparkle) Send ${total} to ${currentAgentLabel || "agent"}`;
        agentItem.tooltip = `Salla Review: send all ${total} findings to ${currentAgentLabel || "the AI agent"}\nTo change the destination: Salla Review: Select AI Agent`;
        agentItem.show();
    } else {
        agentItem.hide();
    }
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
        const ours = context.diagnostics.filter((d) => d.source === "Salla Review");
        for (const d of ours) {
            if (d.code !== "Twig Naming") continue;
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
        // "Send to agent" on every finding — shown on the editor lightbulb and on
        // the row in the Problems panel, so a finding can be handed over without
        // retyping what it says or where it is.
        for (const d of ours) {
            const action = new vscode.CodeAction(
                `🤖 Send this finding (${d.code}) to the agent to fix`,
                vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [d];
            action.command = {
                command: "sallaReview.sendFindingToAgent",
                title: "Send to agent",
                arguments: [document.uri.fsPath, d.range.start.line + 1, d.code, d.message],
            };
            actions.push(action);
        }
        if (ours.length > 1) {
            const action = new vscode.CodeAction(
                `🤖 Send all ${ours.length} findings in this file to the agent`,
                vscode.CodeActionKind.QuickFix
            );
            action.command = {
                command: "sallaReview.sendFileToAgent",
                title: "Send file findings to agent",
                arguments: [document.uri.fsPath],
            };
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

/* =============== Send findings to an AI agent =============== */

/**
 * VS Code has no single "hand this to the agent" API: every assistant registers
 * its own commands. Rather than guessing command ids, the installed extensions
 * are inspected — an extension declares its commands in its own package.json —
 * and the ones that look like "open a chat / start a task" are offered. That
 * way an assistant this extension has never heard of still shows up.
 */
/**
 * Assistants whose command ids are known, with what they actually accept.
 * `acceptsPrompt` is the important part: Copilot's chat command takes the text
 * as an argument and sends it, while Claude Code exposes no command that accepts
 * a prompt at all — the best it can do is open and focus its input, so the task
 * goes to the clipboard and one paste finishes it. Candidate commands are tried
 * in order and only used when actually registered in this window.
 */
const KNOWN_AGENTS = [
    {
        id: /^anthropic\.claude-code$/i,
        label: "Claude Code",
        acceptsPrompt: false,
        commands: ["claude-vscode.focus", "claude-vscode.sidebar.open", "claude-vscode.editor.openLast", "claude-vscode.editor.open", "claude-vscode.newConversation"],
        // Claude Code's own @-mention (alt+K): it reads the focused editor's
        // selection and drops "@path#Lline" into the chat input. Running it once
        // per affected file is how a whole review lands in the conversation.
        // The second id is what terminal mode (claudeCode.useTerminal) binds.
        mentionCommands: ["claude-vscode.insertAtMention", "claude-code.insertAtMentioned"],
        window: /claude/i,
    },
    { id: /^github\.copilot-chat$/i, label: "GitHub Copilot Chat", acceptsPrompt: true, commands: ["workbench.action.chat.open"], window: /copilot|^chat$|chat view/i },
    { id: /^continue\.continue$/i, label: "Continue", acceptsPrompt: false, commands: ["continue.focusContinueInput", "continue.continueGUIView.focus"], window: /continue/i },
    { id: /claude-dev|cline/i, label: "Cline", acceptsPrompt: false, commands: ["cline.plusButtonClicked", "claude-dev.plusButtonClicked", "cline.focusChatInput"], window: /cline/i },
    { id: /roo-?cline|roo-?code/i, label: "Roo Code", acceptsPrompt: false, commands: ["roo-cline.plusButtonClicked", "roo-cline.focus"], window: /roo/i },
    { id: /^sourcegraph\.cody-ai$/i, label: "Cody", acceptsPrompt: false, commands: ["cody.chat.newEditorPanel", "cody.chat.focus"], window: /cody/i },
];

/**
 * Which assistants are actually on screen.
 *
 * `extension.isActive` looks like the obvious signal and is not: Claude Code
 * activates on `onStartupFinished`, so it counts as active from the moment the
 * window opens whether or not its chat was ever shown — which is why everything
 * used to go to Claude. The tabs are real evidence: a chat opened in the editor
 * area is a webview tab whose view type and label name its owner, and the
 * focused tab is stronger evidence still.
 */
function openAgentSurfaces() {
    const active = [];
    const open = [];
    let groups = [];
    try { groups = vscode.window.tabGroups.all; } catch { return { active, open }; }
    for (const group of groups) {
        for (const tab of group.tabs || []) {
            const input = tab.input || {};
            const viewType = input.viewType || input.notebookType || "";
            const text = `${viewType} ${tab.label || ""}`.trim();
            if (!text) continue;
            (tab.isActive && group.isActive ? active : open).push(text);
        }
    }
    return { active, open };
}

/** How strongly this assistant appears to be the one on screen */
function visibilityScore(re, surfaces) {
    if (!re) return 0;
    if (surfaces.active.some((t) => re.test(t))) return 300; // the focused chat
    if (surfaces.open.some((t) => re.test(t))) return 150;   // open, not focused
    return 0;
}

/**
 * Anything else that looks like an assistant, by vendor name or by generic
 * wording, so an agent nobody hard-coded still shows up. Kept deliberately wide:
 * a match only makes an extension a *candidate* — it still has to contribute a
 * command that looks like "open a chat", and a running agent outranks it anyway.
 */
const AI_EXTENSION_RE = /claude|copilot|cline|continue|cody|roo-|roocode|gemini|codeium|windsurf|tabnine|aider|amazonq|kilo|augment|cursor|antigravity|chatgpt|openai|codewhisperer|sourcegraph|\bai\b|\bagent\b|\bassistant\b|\bllm\b|gpt/i;
const AGENT_COMMAND_RE = /chat|ask|prompt|agent|task|conversation|compose|session|focus|open/i;
const AGENT_NOISE_RE = /logout|login|update|walkthrough|log|debug|feedback|accept|reject|rename|worktree|install|blur|unread|preference|repositor|pull ?request|diff/i;

function scoreAgentCommand(id, title) {
    let score = 0;
    if (/newconversation|newchat|new-chat|newtask|focuschat|chatinput|plusbutton/i.test(id)) score += 12;
    if (/\bfocus\b/i.test(id)) score += 8;
    if (/chat|conversation|agent|task/i.test(id) || /chat|conversation/i.test(title)) score += 5;
    if (/open|new|start|show/i.test(id)) score += 3;
    if (/sidebar|panel|view/i.test(id)) score += 2;
    if (AGENT_NOISE_RE.test(id) || AGENT_NOISE_RE.test(title)) score -= 20;
    return score;
}

/**
 * Every assistant this window can deliver to, best first. An assistant that is
 * *running* — its chat is open, so VS Code has activated it — outranks one that
 * is merely installed, which is how "the agent that is open" gets chosen without
 * asking anything.
 */
async function detectAgents() {
    const registered = new Set(await vscode.commands.getCommands(true));
    const surfaces = openAgentSurfaces();
    const found = [];

    for (const ext of vscode.extensions.all) {
        if (ext.id.startsWith("vscode.")) continue;
        const pkg = ext.packageJSON || {};
        const name = pkg.displayName || ext.id;
        const known = KNOWN_AGENTS.find((k) => k.id.test(ext.id));

        if (known) {
            const command = known.commands.find((c) => registered.has(c));
            if (command) {
                const visible = visibilityScore(known.window, surfaces);
                found.push({
                    command, label: known.label, detail: command,
                    acceptsPrompt: known.acceptsPrompt,
                    mentionCommand: (known.mentionCommands || []).find((c) => registered.has(c)) || null,
                    visible: visible > 0, focused: visible >= 300,
                    score: 100 + visible,
                });
                continue;
            }
        }
        if (!AI_EXTENSION_RE.test(ext.id) && !AI_EXTENSION_RE.test(name)) continue;
        // Unknown assistant: rank its own commands and take the most chat-like one
        let best = null;
        for (const c of (pkg.contributes && pkg.contributes.commands) || []) {
            if (!c || !registered.has(c.command)) continue;
            const title = typeof c.title === "string" ? c.title : (c.title && c.title.value) || "";
            if (!AGENT_COMMAND_RE.test(c.command) && !AGENT_COMMAND_RE.test(title)) continue;
            const score = scoreAgentCommand(c.command, title);
            if (score > 0 && (!best || score > best.score)) {
                best = { command: c.command, label: name, detail: c.command, score, acceptsPrompt: false };
            }
        }
        if (best) {
            // Match the extension's own name against what is on screen
            const re = new RegExp(String(name).split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            const visible = visibilityScore(re, surfaces);
            found.push({ ...best, visible: visible > 0, focused: visible >= 300, score: best.score + 20 + visible });
        }
    }

    if (registered.has("workbench.action.chat.open") && !found.some((f) => f.command === "workbench.action.chat.open")) {
        const visible = visibilityScore(/copilot|^chat$|chat view/i, surfaces);
        found.push({
            command: "workbench.action.chat.open", label: "VS Code Chat", detail: "workbench.action.chat.open",
            acceptsPrompt: true, visible: visible > 0, focused: visible >= 300, score: 10 + visible,
        });
    }
    found.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command));
    return found;
}

const AGENT_STATE_KEY = "sallaReview.agentCommand";

/**
 * Where a "Send to Agent" button delivers. Nothing is ever asked: an explicit
 * sallaReview.agentCommand wins, then a target the user chose before, then the
 * running assistant. `force` (the "Select AI Agent" command) shows the picker.
 * @returns {Promise<{command,label,acceptsPrompt}|null|undefined>} null = clipboard, undefined = cancelled
 */
async function resolveAgentTarget(force) {
    const registered = new Set(await vscode.commands.getCommands(true));
    const agents = await detectAgents();

    if (!force) {
        const configured = vscode.workspace.getConfiguration("sallaReview").get("agentCommand", "");
        if (configured) {
            if (registered.has(configured)) {
                return agents.find((a) => a.command === configured) || { command: configured, label: configured, acceptsPrompt: true };
            }
            output.appendLine(`⚠️ sallaReview.agentCommand "${configured}" is not registered in this window`);
        }
        // A pinned choice (from "Select AI Agent") wins; otherwise follow the screen
        const pinned = extensionContext.globalState.get(AGENT_STATE_KEY);
        if (pinned && registered.has(pinned)) {
            const known = agents.find((a) => a.command === pinned);
            return known ? { ...known, pinned: true } : { command: pinned, label: pinned, acceptsPrompt: false, pinned: true };
        }
        return agents[0] || null;
    }

    if (!agents.length) {
        vscode.window.showInformationMessage("Salla Review: no AI extension found in this window — tasks will be copied to the clipboard.");
        return null;
    }
    const AUTO = { label: "$(wand) Automatic — follow the open chat", detail: agents[0] ? `Now: ${agents[0].label}` : "", command: "__auto__" };
    const CLIPBOARD = { label: "$(clippy) Clipboard only", detail: "For an agent running in the terminal (the Claude Code CLI, for example)", command: "" };
    const pick = await vscode.window.showQuickPick(
        [
            AUTO,
            ...agents.map((a) => ({
                label: `${a.focused ? "$(circle-filled) " : a.visible ? "$(circle-outline) " : ""}${a.label}`,
                description: a.focused ? "chat in focus" : a.visible ? "chat open" : "installed only",
                detail: a.detail,
                command: a.command,
            })),
            CLIPBOARD,
        ],
        { placeHolder: "Which agent should Salla Review findings go to?" }
    );
    if (!pick) return undefined;
    if (pick.command === "__auto__") {
        await extensionContext.globalState.update(AGENT_STATE_KEY, undefined);
        return agents[0];
    }
    await extensionContext.globalState.update(AGENT_STATE_KEY, pick.command);
    return pick.command ? agents.find((a) => a.command === pick.command) : null;
}

/** Above this many files, mentioning each one costs more than it is worth */
const MAX_MENTIONS = 25;

/**
 * Reference the findings' files inside the agent's chat, the way the user would
 * by selecting a line and pressing alt+K. The mention command reads the focused
 * editor's selection, so each file is briefly opened and its finding line
 * selected; the editor that was in front beforehand is restored afterwards.
 * A location marked `whole` is mentioned without a line range (empty selection).
 * @returns {Promise<Array>} the locations that were actually mentioned
 */
async function mentionLocations(target, locations) {
    if (!target || !target.mentionCommand || !locations || !locations.length) return [];
    const previous = vscode.window.activeTextEditor;
    const previousSelection = previous && previous.selection;
    const mentioned = [];

    for (const loc of locations.slice(0, MAX_MENTIONS)) {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.file));
            const line = Math.min(Math.max(0, (loc.line || 1) - 1), Math.max(0, doc.lineCount - 1));
            const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
            editor.selection = loc.whole
                ? new vscode.Selection(0, 0, 0, 0)
                : new vscode.Selection(line, 0, line, doc.lineAt(line).text.length);
            editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            await vscode.commands.executeCommand(target.mentionCommand);
            mentioned.push(loc);
        } catch (e) {
            output.appendLine(`⚠️ Could not mention ${loc.file}: ${e.message}`);
        }
    }

    if (previous) {
        try {
            const editor = await vscode.window.showTextDocument(previous.document, { preview: false, preserveFocus: false });
            if (previousSelection) editor.selection = previousSelection;
        } catch { /* the original editor is gone — leave things where they are */ }
    }
    return mentioned;
}

/**
 * Which of the affected files are worth @-mentioning alongside the task.
 * Every mention opens its file to move the cursor there — that is the only way
 * `insertAtMention` can see it — so a whole-theme send would flash dozens of
 * editors for references the task file already spells out. Once the task file
 * carries the findings, only a single-file send mentions its file; opt back in
 * with `sallaReview.mentionAffectedFiles`.
 */
function mentionableLocations(root, locations, hasTaskFile) {
    const list = locations || [];
    if (!hasTaskFile || list.length <= 1) return list;
    return getConfig(root).mentionAffectedFiles ? list : [];
}

/** Where the findings are written so a mention-only agent can read them */
const AGENT_TASK_REL = path.join(".salla-review", "agent-task.md");

/**
 * Mention-only assistants (Claude Code, Cline, Continue, …) expose no command
 * that accepts text — `insertAtMention` builds `@path#line` from the focused
 * editor and nothing else. Mentioning the affected files therefore hands the
 * agent the code but never the findings. Writing the task to a file and
 * mentioning that file first is what puts the problem descriptions themselves
 * into the chat.
 * @returns {string|null} the file's path, or null if it could not be written
 */
function writeAgentTask(root, prompt) {
    try {
        const base = displayBaseForRoot(root);
        const dir = path.join(base, ".salla-review");
        fs.mkdirSync(dir, { recursive: true });
        // The vendored CI files in this folder are committed on purpose; this
        // scratch file is not — keep it out of the developer's commits.
        const ignore = path.join(dir, ".gitignore");
        const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
        if (!/^agent-task\.md\s*$/m.test(current)) {
            fs.writeFileSync(ignore, `${current.replace(/\s*$/, "")}\nagent-task.md\n`.replace(/^\n/, ""), "utf8");
        }
        const file = path.join(base, AGENT_TASK_REL);
        fs.writeFileSync(file, prompt, "utf8");
        return file;
    } catch (e) {
        output.appendLine(`⚠️ Could not write the task file: ${e.message}`);
        return null;
    }
}

/** The target shown on the status bar button — refreshed when the tabs change */
let currentAgentLabel = "";

async function refreshAgentLabel() {
    let label = "";
    try {
        const target = await resolveAgentTarget(false);
        label = target ? target.label : "clipboard";
    } catch { label = ""; }
    if (label !== currentAgentLabel) {
        currentAgentLabel = label;
        updateStatusBar();
    }
}

/**
 * @param filter {} = the whole theme, {file} = one file, {file,line,code} = one finding
 */
async function sendToAgent(root, filter, label) {
    const entry = roots.get(root);
    if (!entry) return;
    let reply;
    try {
        reply = await engine.request({
            type: "agentPrompt",
            root,
            displayBase: displayBaseForRoot(root),
            slug: slugForRoot(root),
            extraIssues: entry.versionIssues,
            ...filter,
        });
    } catch (e) {
        vscode.window.showErrorMessage(`Salla Review: could not prepare the task — ${e.message}`);
        return;
    }
    if (reply.missing || !reply.count) {
        vscode.window.showInformationMessage(`Salla Review: nothing to send${label ? ` (${label})` : ""}.`);
        return;
    }

    // Always on the clipboard first: most assistants expose no command that takes
    // a prompt, so a paste is what finishes the handover.
    await vscode.env.clipboard.writeText(reply.prompt);

    const target = await resolveAgentTarget(false);
    if (target === undefined) return; // the picker was dismissed

    if (target) {
        // Mention-only agents get the findings as a file, mentioned first, so the
        // chat carries the problem text and not just file names. Mentioning the
        // affected files too costs an editor flash each — the mention command
        // reads the *focused* editor — and the task file already names every file
        // with its line, so it is only worth it for a single file.
        const taskFile = target.acceptsPrompt ? null : writeAgentTask(root, reply.prompt);
        const locations = mentionableLocations(root, reply.locations, !!taskFile);
        const list = taskFile ? [{ file: taskFile, whole: true }, ...locations] : locations;
        const done = await mentionLocations(target, list);
        const taskMentioned = !!taskFile && done.some((l) => l.file === taskFile);
        const mentioned = done.filter((l) => l.file !== taskFile).length;
        const extra = Math.max(0, locations.length - mentioned);

        // Assistants that accept the text as an argument get it directly; the
        // rest are opened and focused, with the task already on the clipboard.
        const shapes = target.acceptsPrompt
            ? [[{ query: reply.prompt }], [reply.prompt], []]
            : [[]];
        for (const args of shapes) {
            try {
                await vscode.commands.executeCommand(target.command, ...args);
                const sent = target.acceptsPrompt && args.length > 0;
                const files = mentioned ? ` — ${mentioned} file(s) mentioned${extra ? ` (+${extra} skipped)` : ""}` : "";
                const task = taskMentioned ? ` + ${AGENT_TASK_REL}` : "";
                const paste = sent || taskMentioned ? "" : " — task on the clipboard, paste it with Ctrl+V";
                output.appendLine(`🤖 ${reply.count} finding(s) → ${target.label} (${target.command})${files}${task}${paste}`);
                vscode.window.showInformationMessage(
                    sent
                        ? `Salla Review: sent ${reply.count} finding(s) to ${target.label}.`
                        : taskMentioned
                            ? `Salla Review: ${reply.count} finding(s) with their details${mentioned ? ` and ${mentioned} file(s)` : ""} are in the ${target.label} chat — press Enter to send.`
                            : mentioned
                                ? `Salla Review: ${mentioned} file(s) added to the ${target.label} chat — paste the ${reply.count} finding(s) with Ctrl+V.`
                                : `Salla Review: ${reply.count} finding(s) ready — paste them into ${target.label} with Ctrl+V.`,
                    "Change agent"
                ).then((p) => { if (p === "Change agent") vscode.commands.executeCommand("sallaReview.selectAgent"); });
                return;
            } catch { /* try the next shape */ }
        }
        output.appendLine(`⚠️ ${target.command} failed — the task is on the clipboard`);
    }

    const pick = await vscode.window.showInformationMessage(
        `Salla Review: a task to fix ${reply.count} finding(s) is on the clipboard — paste it into the agent.`,
        "Open as a file",
        "Select agent"
    );
    if (pick === "Open as a file") {
        const doc = await vscode.workspace.openTextDocument({ content: reply.prompt, language: "markdown" });
        await vscode.window.showTextDocument(doc, { preview: true });
    } else if (pick === "Select agent") {
        await resolveAgentTarget(true);
    }
}

/** The theme that owns the active editor, or the only theme in the workspace */
function activeRoot() {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === "file") {
        const root = rootForFile(active.document.uri.fsPath);
        if (root) return root;
    }
    return roots.size === 1 ? [...roots.keys()][0] : null;
}

async function pickScannedRoot(placeHolder) {
    if (roots.size === 0) {
        vscode.window.showWarningMessage("Salla Review: لم تُراجَع أي ثيم بعد — نفّذ «Review Themes» أولاً.");
        return null;
    }
    const here = activeRoot();
    if (here) return here;
    const pick = await vscode.window.showQuickPick(
        [...roots.keys()].map((r) => ({ label: slugForRoot(r), description: r, root: r })),
        { placeHolder }
    );
    return pick ? pick.root : null;
}

/* =============== Findings panel (the Send to Agent buttons) =============== */

/**
 * VS Code's built-in Problems panel takes no extension buttons — there is no
 * menu contribution point for it — so the findings are mirrored into a view of
 * our own, next to Problems, where every row can carry a "Send to Agent" action:
 * on a single finding, on a whole file, and on everything from the title bar.
 *
 * The rows are read straight back out of the DiagnosticCollection, so this view
 * needs no state of its own and can never disagree with the Problems panel.
 */
const findingsChanged = new vscode.EventEmitter();

const SEVERITY_ICON = [
    ["error", "errorForeground"],
    ["warning", "editorWarning.foreground"],
    ["info", "editorInfo.foreground"],
    ["question", "editorInfo.foreground"],
];

const findingsProvider = {
    onDidChangeTreeData: findingsChanged.event,

    getChildren(node) {
        if (!node) {
            const files = [];
            diagnostics.forEach((uri, diags) => {
                if (diags.length) files.push({ kind: "file", uri, diags: [...diags].sort((a, b) => a.range.start.line - b.range.start.line) });
            });
            files.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
            return files;
        }
        if (node.kind === "file") return node.diags.map((d) => ({ kind: "finding", uri: node.uri, diag: d }));
        return [];
    },

    getTreeItem(node) {
        if (node.kind === "file") {
            const item = new vscode.TreeItem(path.basename(node.uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
            const root = rootForFile(node.uri.fsPath);
            const dir = path.dirname(root ? path.relative(root, node.uri.fsPath) : node.uri.fsPath);
            item.description = `${node.diags.length}${dir && dir !== "." ? " — " + core.normalizeRel(dir) : ""}`;
            item.resourceUri = node.uri;
            item.iconPath = vscode.ThemeIcon.File;
            item.contextValue = "sallaFile";
            item.tooltip = node.uri.fsPath;
            return item;
        }
        const d = node.diag;
        const [icon, color] = SEVERITY_ICON[d.severity] || SEVERITY_ICON[3];
        const item = new vscode.TreeItem(d.message, vscode.TreeItemCollapsibleState.None);
        item.description = `${d.code} · Ln ${d.range.start.line + 1}`;
        item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        item.contextValue = "sallaFinding";
        item.tooltip = new vscode.MarkdownString(`**${d.code}**\n\n${d.message}`);
        item.command = {
            command: "vscode.open",
            title: "Open",
            arguments: [node.uri, { selection: d.range }],
        };
        return item;
    },
};

function refreshFindingsView() {
    findingsChanged.fire();
    codeLensChanged.fire();
}

/* =============== "Send to agent" button inside the editor =============== */

const codeLensChanged = new vscode.EventEmitter();

/**
 * One clickable "🤖 Send to agent" above each line that has findings — the
 * in-editor equivalent of the button in the panel.
 */
const agentCodeLensProvider = {
    onDidChangeCodeLenses: codeLensChanged.event,
    provideCodeLenses(document) {
        if (document.uri.scheme !== "file") return [];
        if (!getConfig(document.uri.fsPath).agentCodeLens) return [];
        const diags = diagnostics.get(document.uri) || [];
        if (!diags.length) return [];
        const byLine = new Map();
        for (const d of diags) {
            const line = d.range.start.line;
            if (!byLine.has(line)) byLine.set(line, []);
            byLine.get(line).push(d);
        }
        const lenses = [];
        for (const [line, list] of byLine) {
            const one = list.length === 1;
            lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
                command: "sallaReview.sendFindingToAgent",
                title: one ? `🤖 Send to agent (${list[0].code})` : `🤖 Send ${list.length} findings to agent`,
                arguments: one
                    ? [document.uri.fsPath, line + 1, list[0].code, list[0].message]
                    : [document.uri.fsPath, line + 1],
            }));
        }
        return lenses;
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

// .json is included so saving the custom rules file re-applies the rules immediately;
// the lockfiles are watched so a pnpm/npm/yarn install clears the mismatch findings.
const RELEVANT_FILE_RE = /(?:\.(twig|js|css|scss|json)|[\\/](?:pnpm-lock\.yaml|yarn\.lock))$/i;

/**
 * One watcher per theme root, scoped so unrelated folders cost nothing.
 *
 * Change events matter as much as create/delete: a file edited on disk by
 * anything other than this editor — an AI agent, a git checkout or stash, a
 * formatter run from the terminal, npm/pnpm rewriting a lockfile — fires no
 * onDidSaveTextDocument, so without this the Problems panel kept showing
 * findings for code that no longer existed until the window was reloaded.
 */
function ensureWatcher(entry, root) {
    if (entry.watcher) return;
    const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), "**/{*.twig,*.js,*.css,*.scss,*.json,pnpm-lock.yaml,yarn.lock}")
    );
    w.onDidCreate((uri) => onDiskChange(uri.fsPath));
    w.onDidChange((uri) => onDiskChange(uri.fsPath));
    w.onDidDelete((uri) => onDiskChange(uri.fsPath));
    entry.watcher = w;
}

/**
 * A file changed on disk. Normally the on-disk content is what we analyze; the
 * exception is a file the user is editing live (runOnType) whose buffer is still
 * dirty — there the buffer stays authoritative, otherwise the findings would
 * jump to line numbers the editor is not showing.
 */
function onDiskChange(fsPath) {
    const dirtyDoc = liveFiles.has(fileKey(fsPath))
        ? vscode.workspace.textDocuments.find(
            (d) => d.uri.scheme === "file" && d.isDirty && fileKey(d.uri.fsPath) === fileKey(fsPath))
        : undefined;
    scheduleIncremental(fsPath, dirtyDoc);
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
    refreshFindingsView();
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
    agentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    agentItem.command = "sallaReview.sendAllToAgent";

    extensionContext = context;
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
        agentItem,
        markerWatcher,
        { dispose: () => { for (const root of [...roots.keys()]) removeRoot(root); engine.dispose(); } },
        // Every file kind: the rename fix is Twig-only, but "send to agent" is
        // offered on findings in JS, CSS, twilight.json and package.json too.
        vscode.languages.registerCodeActionsProvider(
            { scheme: "file" },
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
        vscode.window.registerTreeDataProvider("sallaReview.findings", findingsProvider),
        vscode.languages.registerCodeLensProvider({ scheme: "file" }, agentCodeLensProvider),
        vscode.commands.registerCommand("sallaReview.sendFindingToAgent", (file, line, code, message) => {
            const root = rootForFile(file);
            if (root) sendToAgent(root, { file, line, code, message }, code);
        }),
        // The ✨ button on a row of the Salla Review panel: a finding or a whole file
        vscode.commands.registerCommand("sallaReview.sendNodeToAgent", (node) => {
            if (!node || !node.uri) return;
            const file = node.uri.fsPath;
            const root = rootForFile(file);
            if (!root) return;
            if (node.kind === "finding") {
                const d = node.diag;
                sendToAgent(root, { file, line: d.range.start.line + 1, code: d.code, message: d.message }, d.code);
            } else {
                sendToAgent(root, { file }, path.basename(file));
            }
        }),
        vscode.commands.registerCommand("sallaReview.selectAgent", async () => {
            const chosen = await resolveAgentTarget(true);
            if (chosen) vscode.window.showInformationMessage(`Salla Review: findings will go to ${chosen.label}`);
            else if (chosen === null) vscode.window.showInformationMessage("Salla Review: tasks will be copied to the clipboard.");
            refreshAgentLabel();
        }),
        // Opening or focusing a chat changes where the button points
        vscode.window.tabGroups.onDidChangeTabs(() => refreshAgentLabel()),
        vscode.commands.registerCommand("sallaReview.sendFileToAgent", async (file) => {
            const target = file || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath);
            if (!target) {
                vscode.window.showWarningMessage("Salla Review: افتح ملفاً أولاً.");
                return;
            }
            const root = rootForFile(target);
            if (!root) {
                vscode.window.showWarningMessage("Salla Review: هذا الملف ليس ضمن ثيم مُراجَع.");
                return;
            }
            sendToAgent(root, { file: target }, path.basename(target));
        }),
        vscode.commands.registerCommand("sallaReview.sendAllToAgent", async () => {
            if (roots.size === 0) await scanAll(false);
            const root = await pickScannedRoot("Pick the theme whose findings should go to the agent");
            if (root) sendToAgent(root, {}, slugForRoot(root));
        }),
        vscode.commands.registerCommand("sallaReview.clear", () => {
            for (const root of [...roots.keys()]) removeRoot(root);
            diagnostics.clear();
            liveFiles.clear();
            statusItem.hide();
            agentItem.hide();
            refreshFindingsView();
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("sallaReview")) {
                configCache.clear();
                codeLensChanged.fire(); // agentCodeLens may have been toggled
            }
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

    refreshAgentLabel();
    if (getConfig().scanOnStartup) {
        setTimeout(() => scanAll(false), 1500);
    }
    setTimeout(() => maybeAutoUpdateRaed(), 5000);
}

function deactivate() {
    engine.dispose();
}

module.exports = { activate, deactivate };
