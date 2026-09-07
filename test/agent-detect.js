"use strict";
/**
 * Which assistant do the "Send to Agent" buttons deliver to?
 *
 * The rule is "whatever agent is open, no questions asked", so this exercises
 * the real detection code from extension.js against realistic extension
 * manifests, with the `vscode` module stubbed — no editor needed.
 * Run:  node test/agent-detect.js
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

let failures = 0;
function assert(cond, label) {
    if (cond) console.log(`  ✅ ${label}`);
    else { failures++; console.error(`  ❌ ${label}`); }
}

/* ---- Extension manifests, shaped like the real ones ---- */

// Claude Code contributes no command that takes a prompt: the best it offers is
// opening/focusing its input, so the task must go through the clipboard.
const CLAUDE = {
    displayName: "Claude Code for VS Code",
    contributes: { commands: [
        { command: "claude-vscode.editor.open", title: "Claude Code: Open in New Tab" },
        { command: "claude-vscode.sidebar.open", title: "Claude Code: Open in Side Bar" },
        { command: "claude-vscode.newConversation", title: "Claude Code: New Conversation" },
        { command: "claude-vscode.focus", title: "Claude Code: Focus input" },
        { command: "claude-vscode.logout", title: "Claude Code: Logout" },
        { command: "claude-vscode.update", title: "Claude Code: Update extension" },
        { command: "claude-vscode.acceptProposedDiff", title: "Claude Code: Accept Proposed Changes" },
    ] },
};
const COPILOT = {
    displayName: "GitHub Copilot Chat",
    contributes: { commands: [
        { command: "github.copilot.chat.cloudSessions.openPullRequestForTask", title: "Open Pull Request" },
        { command: "github.copilot.chat.openUserPreferences", title: "Open User Preferences" },
        { command: "github.copilot.interactiveSession.feedback", title: "Send Chat Feedback" },
    ] },
};
const CLAUDE_COMMANDS = CLAUDE.contributes.commands.map((c) => c.command);
const PRETTIER = { displayName: "Prettier - Code formatter", contributes: { commands: [] } };

/* ---- The smallest vscode surface extension.js touches at load time ---- */

let registered = new Set();
let extensions = [];
let tabs = { active: null, open: [] };
let configured = "";
let remembered = undefined;

const noop = () => {};
const vscodeStub = {
    commands: { getCommands: async () => [...registered], registerCommand: noop, executeCommand: noop },
    extensions: { get all() { return extensions; } },
    workspace: {
        getConfiguration: () => ({ get: (key, def) => (key === "agentCommand" ? configured : def) }),
        createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose: noop }),
        onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop, onDidSaveTextDocument: noop,
        onDidChangeTextDocument: noop, onDidCloseTextDocument: noop, textDocuments: [], workspaceFolders: [],
    },
    window: {
        get tabGroups() {
            return {
                all: [{ isActive: true, tabs: [
                    ...(tabs.active ? [{ isActive: true, label: tabs.active, input: { viewType: "mainThreadWebview-" + tabs.active } }] : []),
                    ...tabs.open.map((t) => ({ isActive: false, label: t, input: { viewType: "mainThreadWebview-" + t } })),
                ] }],
                onDidChangeTabs: noop,
            };
        },
        showInformationMessage: noop, showWarningMessage: noop, showErrorMessage: noop,
        showQuickPick: async () => undefined, setStatusBarMessage: noop,
        createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
        createOutputChannel: () => ({ appendLine: noop, clear: noop, dispose: noop }),
        registerTreeDataProvider: noop, activeTextEditor: undefined,
    },
    languages: {
        createDiagnosticCollection: () => ({ set: noop, delete: noop, clear: noop, get: () => [], forEach: noop, dispose: noop }),
        registerCodeActionsProvider: noop, registerCodeLensProvider: noop,
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    CodeActionKind: { QuickFix: "quickfix" },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    ProgressLocation: { Window: 10 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(l, c) { this.label = l; this.collapsibleState = c; } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose: noop }); } fire() {} },
    Range: class {}, Diagnostic: class {}, CodeLens: class {}, RelativePattern: class {}, MarkdownString: class {},
    Uri: { file: (f) => ({ fsPath: f, scheme: "file" }) },
    env: { clipboard: { writeText: async () => {} } },
};

const origLoad = Module._load;
Module._load = function (request) {
    if (request === "vscode") return vscodeStub;
    return origLoad.apply(this, arguments);
};

const extPath = path.join(__dirname, "..", "extension.js");
const ext = new Module("salla-extension");
ext._compile(
    fs.readFileSync(extPath, "utf8") +
    "\nmodule.exports.__test = { detectAgents, resolveAgentTarget, setContext: (c) => { extensionContext = c; } };\n",
    extPath
);
const { detectAgents, resolveAgentTarget, setContext } = ext.exports.__test;

setContext({ globalState: { get: () => remembered, update: async (_k, v) => { remembered = v; } } });

function scenario(exts, cmds, onScreen) {
    extensions = exts;
    registered = new Set(cmds);
    tabs = onScreen || { active: null, open: [] };
}

(async () => {
    console.log("اكتشاف وكيل الذكاء الاصطناعي:");

    // Both installed. Claude Code activates on startup (onStartupFinished), so
    // "is the extension active" says nothing — only what is on screen counts.
    const BOTH = [
        { id: "Anthropic.claude-code", isActive: true, packageJSON: CLAUDE },
        { id: "GitHub.copilot-chat", isActive: true, packageJSON: COPILOT },
    ];
    const BOTH_CMDS = [...CLAUDE_COMMANDS, "workbench.action.chat.open"];

    scenario(BOTH, BOTH_CMDS, { active: "Claude Code", open: [] });
    let target = await resolveAgentTarget(false);
    assert(target && target.label === "Claude Code", `المحادثة المفتوحة (Claude Code) تُختار — ${target && target.label}`);
    assert(target.command === "claude-vscode.focus", `يُستخدم أمر تركيز الإدخال — ${target.command}`);
    assert(target.acceptsPrompt === false, "Claude Code لا يقبل نصاً كوسيط → الحافظة + لصق");

    // The reported bug: Copilot's chat is the open one, yet everything went to Claude
    scenario(BOTH, BOTH_CMDS, { active: "Copilot Chat", open: [] });
    target = await resolveAgentTarget(false);
    assert(target && target.label === "GitHub Copilot Chat", `فتح محادثة Copilot يوجّه الإرسال إليها — ${target && target.label}`);
    assert(target.acceptsPrompt === true, "Copilot يستقبل النص مباشرةً كوسيط");

    // Focused beats merely open: both chats on screen, Copilot focused
    scenario(BOTH, BOTH_CMDS, { active: "Copilot Chat", open: ["Claude Code"] });
    target = await resolveAgentTarget(false);
    assert(target && target.label === "GitHub Copilot Chat", `المحادثة المركَّز عليها تتقدّم على المفتوحة فقط — ${target && target.label}`);

    scenario(BOTH, BOTH_CMDS, { active: "header.twig", open: ["Claude Code"] });
    target = await resolveAgentTarget(false);
    assert(target && target.label === "Claude Code", `محادثة مفتوحة (غير مركَّز عليها) تُختار على المثبَّت فقط — ${target && target.label}`);

    // Noise commands (logout/update/accept diff) must never be chosen
    scenario([{ id: "Anthropic.claude-code", isActive: true, packageJSON: CLAUDE }], CLAUDE_COMMANDS);
    const agents = await detectAgents();
    assert(!agents.some((a) => /logout|update|acceptProposedDiff/i.test(a.command)), "أوامر غير ذات صلة (logout/update/diff) مستبعدة");

    // No assistant at all → clipboard, still no prompt
    scenario([{ id: "esbenp.prettier-vscode", isActive: true, packageJSON: PRETTIER }], []);
    assert((await resolveAgentTarget(false)) === null, "بلا إضافة ذكاء اصطناعي → الحافظة");

    // An explicit setting overrides detection
    scenario([{ id: "Anthropic.claude-code", isActive: true, packageJSON: CLAUDE }], [...CLAUDE_COMMANDS, "my.custom.agent"]);
    configured = "my.custom.agent";
    target = await resolveAgentTarget(false);
    assert(target && target.command === "my.custom.agent", "sallaReview.agentCommand يتجاوز الاكتشاف");
    configured = "";

    // A pinned choice overrides what is on screen, and is dropped once it vanishes
    scenario(BOTH, BOTH_CMDS, { active: "Claude Code", open: [] });
    remembered = "workbench.action.chat.open";
    target = await resolveAgentTarget(false);
    assert(target && target.command === "workbench.action.chat.open" && target.pinned,
        "الوكيل المثبَّت يدوياً يتقدّم على المحادثة المفتوحة");
    remembered = "gone.command";
    target = await resolveAgentTarget(false);
    assert(target && target.command === "claude-vscode.focus", "تثبيت لم يعد موجوداً → العودة للاكتشاف التلقائي");
    remembered = undefined;

    // An assistant nobody hard-coded still shows up
    scenario([{ id: "acme.super-ai-agent", isActive: true, packageJSON: {
        displayName: "Super AI Agent",
        contributes: { commands: [{ command: "superai.newChat", title: "Super AI: New Chat" }, { command: "superai.logout", title: "Logout" }] },
    } }], ["superai.newChat", "superai.logout"]);
    target = await resolveAgentTarget(false);
    assert(target && target.command === "superai.newChat", `وكيل غير معروف مسبقاً يُكتشف أيضاً — ${target && target.command}`);

    if (failures) { console.error(`\n❌ فشل ${failures} اختبار`); process.exit(1); }
    console.log("\n✅ كل اختبارات اكتشاف الوكيل ناجحة");
})();
