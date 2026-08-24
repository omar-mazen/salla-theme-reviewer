#!/usr/bin/env node
"use strict";
/**
 * Command-line interface — the same engine as the extension, without VS Code.
 * Used directly, from git hooks (pre-commit / pre-push), and in CI.
 *
 * Usage:
 *   node cli.js <path to a theme, or a folder containing several themes> [options]
 *
 * Key options:
 *   --fail-on <error|warning|any|never>   Exit code 1 when findings at/above the
 *                                         level exist (default: never — reports only)
 *   --no-report                           Do not write Markdown reports (hooks mode)
 *   --exclude "p1,p2"                     Exclude path patterns (same forms as the settings)
 *   --no-network                          Skip the npm version check
 *   --no-<check>                          Disable a specific check (see README)
 *
 * Per-project configuration: if <theme>/.vscode/settings.json contains
 * sallaReview.* keys, they are applied automatically, so the editor, git hooks,
 * and CI all enforce identical rules. CLI --no-* flags can only further disable.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const core = require("./lib/salla-review-core.js");
const { checkTwilightVersions } = require("./lib/twilight-version.js");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));

// Values of named options do not count as target paths
const NAMED = ["--reports", "--exclude", "--fail-on"];
const namedValues = new Set();
for (const name of NAMED) {
    const i = args.indexOf(name);
    if (i !== -1 && args[i + 1]) namedValues.add(args[i + 1]);
}
const positional = args.filter((a) => !a.startsWith("--") && !namedValues.has(a));

function namedArg(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}

function listArg(name) {
    const v = namedArg(name);
    if (!v) return [];
    return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}

const target = path.resolve(positional[0] || ".");
const reportsDir = path.resolve(namedArg("--reports") || path.join(process.cwd(), "reports"));
const writeReports = !flags.has("--no-report");
const failOn = namedArg("--fail-on") || "never"; // error | warning | any | never

if (!["error", "warning", "any", "never"].includes(failOn)) {
    console.error(`❌ قيمة غير صالحة لـ --fail-on: ${failOn} (المسموح: error, warning, any, never)`);
    process.exit(2);
}
if (!fs.existsSync(target)) {
    console.error(`❌ المسار غير موجود: ${target}`);
    process.exit(2);
}

const roots = core.findThemeRoots(target);
if (roots.length === 0) {
    console.error(`❌ لا يوجد أي ثيم (twilight.json) تحت: ${target}`);
    process.exit(2);
}

if (writeReports) fs.mkdirSync(reportsDir, { recursive: true });

/** Map sallaReview.* keys from a project's .vscode/settings.json to engine options. */
const SETTINGS_TO_OPTS = {
    "sallaReview.checks.uiText": "uiTextCheck",
    "sallaReview.checks.twigBlocks": "twigSyntaxCheck",
    "sallaReview.checks.jsSyntax": "nodeSyntaxCheck",
    "sallaReview.checks.cssBraces": "cssBracesCheck",
    "sallaReview.checks.scopes": "scopesCheck",
    "sallaReview.checks.security": "securityCheck",
    "sallaReview.checks.customCode": "customCodeCheck",
    "sallaReview.checks.misleadingUx": "misleadingUxHeuristic",
    "sallaReview.checks.requiredHooks": "requiredHooks",
    "sallaReview.checks.requiredComponents": "requiredComponents",
    "sallaReview.checks.sliderSource": "sliderSourceCheck",
    "sallaReview.checks.themeSize": "sizeCheck",
    "sallaReview.checks.twigDivision": "divisionCheck",
    "sallaReview.checks.mergeConflicts": "mergeConflicts",
    "sallaReview.checks.viteConfig": "viteCheck",
    "sallaReview.checks.bundle": "bundleCheck",
    "sallaReview.checks.structure": "structureCheck",
    "sallaReview.checks.twilightManifest": "twilightManifestCheck",
    "sallaReview.checks.cssVariables": "cssVarCheck",
    "sallaReview.checks.colors": "colorCheck",
    "sallaReview.checks.raedParity": "raedParity",
    "sallaReview.checks.customRules": "customRuleCheck",
};

/**
 * Read <root>/.vscode/settings.json (JSONC-tolerant). Returns {} when absent/invalid.
 * Uses the engine's string-aware parser so glob values containing "/**\/" survive.
 */
function loadProjectSettings(root) {
    try {
        return core.parseJsonc(fs.readFileSync(path.join(root, ".vscode", "settings.json"), "utf8")) || {};
    } catch {
        return {};
    }
}

/** Flag-derived option values — flags can only disable, never re-enable. */
const flagOpts = {
    raedParity: !flags.has("--no-parity"),
    uiTextCheck: !flags.has("--no-ui-text"),
    twigSyntaxCheck: !flags.has("--no-twig-blocks"),
    nodeSyntaxCheck: !flags.has("--no-syntax"),
    cssBracesCheck: !flags.has("--no-css-braces"),
    scopesCheck: !flags.has("--no-scopes"),
    securityCheck: !flags.has("--no-security"),
    customCodeCheck: !flags.has("--no-custom-code"),
    misleadingUxHeuristic: !flags.has("--no-misleading"),
    requiredHooks: !flags.has("--no-hooks"),
    requiredComponents: !flags.has("--no-components"),
    sliderSourceCheck: !flags.has("--no-slider"),
    sizeCheck: !flags.has("--no-size"),
    divisionCheck: !flags.has("--no-division"),
    mergeConflicts: !flags.has("--no-conflicts"),
    viteCheck: !flags.has("--no-vite"),
    bundleCheck: !flags.has("--no-bundle"),
    structureCheck: !flags.has("--no-structure"),
    twilightManifestCheck: !flags.has("--no-manifest"),
    cssVarCheck: !flags.has("--no-cssvars"),
    colorCheck: !flags.has("--no-colors"),
    customRuleCheck: !flags.has("--no-custom-rules"),
};

/** Effective options for one theme root: defaults ← project settings ← disabling flags. */
function optsForRoot(root) {
    const settings = loadProjectSettings(root);
    const opts = { ...flagOpts };
    for (const [key, opt] of Object.entries(SETTINGS_TO_OPTS)) {
        if (settings[key] === false) opts[opt] = false;
    }
    opts.exclude = [
        ...(Array.isArray(settings["sallaReview.exclude"]) ? settings["sallaReview.exclude"] : []),
        ...listArg("--exclude"),
    ];
    if (Array.isArray(settings["sallaReview.ignoredTexts"])) {
        opts.ignoredTexts = settings["sallaReview.ignoredTexts"];
    }
    if (typeof settings["sallaReview.customRulesFile"] === "string") {
        opts.customRulesFile = settings["sallaReview.customRulesFile"];
    }
    return opts;
}

/* ==================== GitHub Actions integration (--github) ====================
 * Mirrors Salla's TwilightCI experience with native Actions features:
 *  - workflow commands (::error file=..,line=..::msg) become inline annotations
 *    on the commit / "Files changed" view
 *  - $GITHUB_STEP_SUMMARY renders the check table + "What to fix" details page
 * GitHub notifies the commit author automatically when the run fails.
 */
const githubMode = flags.has("--github");

// TwilightCI-style check rows: finding type -> named check
const GH_CHECK_ROWS = [
    ["Twig syntax", ["Twig Syntax", "Twig Division"]],
    ["JS / CSS syntax", ["JS Syntax", "CSS/SCSS"]],
    ["Translations (hardcoded texts)", ["UI hard-coded text"]],
    ["Theme structure", ["Theme Structure", "Twilight Hooks", "Twilight Components", "salla-scopes"]],
    ["Theme configuration (twilight.json)", ["Twilight Manifest"]],
    ["Security & policy", ["Security", "Custom Code", "Misleading UX (Social Proof/Urgency)"]],
    ["Merge conflicts", ["Merge Conflict"]],
    ["Twilight packages", ["Twilight Version"]],
    ["Custom rules", ["Custom Rule"]],
    ["Style quality", ["Hardcoded Color", "CSS Variables", "Theme Size", "Vite Config", "Bundle i18n", "Bundle Quality"]],
];

const GH_FIX_HINTS = {
    "Twig syntax": "Fix the Twig errors at the annotated lines in the Files changed view, then push again.",
    "JS / CSS syntax": "Fix the syntax errors at the annotated lines, then push again.",
    "Translations (hardcoded texts)": "Wrap the annotated strings with trans() in Twig or salla.lang in JS, then push again.",
    "Theme structure": "Add the missing hooks/components and run npm run production so public/ is committed. Reference: theme-raed.",
    "Theme configuration (twilight.json)": "Fix the annotated twilight.json fields (ids, paths, unused/undefined settings), then push again.",
    "Security & policy": "Remove external requests, injected settings, and fake-engagement claims at the annotated lines.",
    "Merge conflicts": "Resolve the conflict markers at the annotated lines and commit the resolved files.",
    "Twilight packages": "npm install @salla.sa/twilight-tailwind-theme @salla.sa/twilight-components @salla.sa/twilight && npm run prod, then push the built assets.",
    "Style quality": "Use theme settings / CSS variables for the annotated values.",
    "Custom rules": "These are your team's own rules from salla-rules.json — fix the annotated lines or adjust the rule.",
};

function ghEscape(v) {
    return String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function ghEscapeProp(v) {
    return ghEscape(v).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function ghRelPath(file) {
    const base = process.env.GITHUB_WORKSPACE || process.cwd();
    return path.relative(base, file).split(path.sep).join("/");
}

/** Emit inline annotations. GitHub caps ~10 per severity per step, so we budget. */
function emitAnnotations(issues) {
    const budget = { error: 10, warning: 10, notice: 5 };
    let skipped = 0;
    for (const i of issues) {
        const sev = core.issueSeverity(i);
        const kind = sev === "info" ? "notice" : sev;
        if (budget[kind] <= 0) { skipped++; continue; }
        budget[kind]--;
        const msg = (i.desc || i.type) + (i.visible ? ': "' + i.visible + '"' : "");
        console.log("::" + kind + " file=" + ghEscapeProp(ghRelPath(i.file)) + ",line=" + (i.line || 1) + ",title=" + ghEscapeProp("Salla Review — " + i.type) + "::" + ghEscape(msg));
    }
    if (skipped > 0) {
        console.log("::notice title=Salla Review::" + skipped + " more findings not annotated (GitHub caps annotations) — download the review report artifact for the full list.");
    }
}

/** Build the TwilightCI-style Markdown summary for one theme. */
function buildGithubSummary(slug, issues) {
    const sha = (process.env.GITHUB_SHA || "").slice(0, 7);
    const rows = GH_CHECK_ROWS.map(([name, types]) => {
        const mine = issues.filter((i) => types.includes(i.type));
        const errors = mine.filter((i) => core.issueSeverity(i) === "error");
        const warns = mine.filter((i) => core.issueSeverity(i) === "warning");
        const files = new Set(mine.map((i) => i.file));
        const icon = errors.length ? "❌" : warns.length ? "⚠️" : "✅";
        let result = "passed";
        if (mine.length) {
            const parts = [];
            if (errors.length) parts.push(errors.length + " error" + (errors.length > 1 ? "s" : ""));
            if (warns.length) parts.push(warns.length + " warning" + (warns.length > 1 ? "s" : ""));
            result = parts.join(", ") + " in " + files.size + " file" + (files.size > 1 ? "s" : "");
        }
        return { name, icon, result, errors, warns, mine };
    });

    const failed = rows.filter((r) => r.errors.length).length;
    const attention = rows.filter((r) => !r.errors.length && r.warns.length).length;
    const totalWarns = rows.reduce((a, r) => a + r.warns.length, 0);
    const out = [];
    out.push("## " + (failed ? "❌" : attention ? "⚠️" : "✅") + " Salla Theme Review — " + slug + (sha ? " · commit `" + sha + "`" : ""));
    out.push("");
    // A theme with warnings must never read as a clean pass — warnings are
    // review-relevant findings, only below the blocking threshold.
    out.push(failed
        ? "**" + failed + " of " + rows.length + " checks failed**" + (attention ? " · " + attention + " more with warnings" : "")
        : attention
            ? "**No blocking errors, but " + totalWarns + " warning" + (totalWarns > 1 ? "s" : "") + " in " + attention + " check" + (attention > 1 ? "s" : "") + "** — review them before submitting; Salla reviewers may still flag them."
            : "**All " + rows.length + " checks passed** 🎉");
    out.push("");
    out.push("| | Check | Result |");
    out.push("|---|---|---|");
    for (const r of rows) out.push("| " + r.icon + " | " + r.name + " | " + r.result + " |");
    out.push("");

    const detail = rows.filter((r) => r.errors.length || r.warns.length);
    if (detail.length) {
        out.push("### What to fix");
        out.push("");
        for (const r of detail) {
            out.push("#### " + r.icon + " " + r.name);
            out.push("");
            const byFile = new Map();
            for (const i of r.mine) {
                if (!byFile.has(i.file)) byFile.set(i.file, []);
                byFile.get(i.file).push(i);
            }
            const entries = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
            for (const [f, list] of entries.slice(0, 5)) {
                const first = list[0];
                const msg = (first.desc || first.type) + (first.visible ? ': "' + first.visible + '"' : "");
                out.push("- `" + ghRelPath(f) + "` — " + list.length + " finding" + (list.length > 1 ? "s" : "") + ": " + msg);
            }
            if (entries.length > 5) out.push("- … and " + (entries.length - 5) + " more files");
            out.push("");
            if (GH_FIX_HINTS[r.name]) {
                out.push("**How to fix** — " + GH_FIX_HINTS[r.name]);
                out.push("");
            }
        }
    }

    out.push("### Need a hand?");
    out.push("");
    out.push("- **Re-run this check** — push a new commit, or press *Re-run all checks* at the top of this page.");
    out.push("- **Full report** — download the *salla-review-report* artifact from this run.");
    out.push("- **Documentation** — https://docs.salla.dev/");
    out.push("");
    return out.join(String.fromCharCode(10));
}

function writeGithubSummary(md) {
    const f = process.env.GITHUB_STEP_SUMMARY;
    if (!f) { console.log(md); return; }
    fs.appendFileSync(f, md + String.fromCharCode(10), "utf8");
}

const reviewed = [];
async function main() {
    for (const root of roots) {
        // The name: the topmost theme folder under the target path (supports slug/hash/ nesting)
        const relFromTarget = path.relative(target, root);
        const slug = relFromTarget ? relFromTarget.split(path.sep)[0] : path.basename(target);

        console.log(`🔍 جاري مراجعة: ${slug}...`);
        const opts = optsForRoot(root);
        const { issues, parityLines, projectRoot } = core.analyzeTheme(root, opts);

        // Twilight versions check via npm (skipped with --no-network or when offline)
        if (!flags.has("--no-network")) {
            try {
                issues.push(...await checkTwilightVersions(projectRoot, {
                    cacheFile: path.join(os.tmpdir(), "salla-review-twilight-cache.json"),
                }));
            } catch { /* no network */ }
        }

        if (writeReports) {
            const md = core.buildReportMarkdown(slug, issues, parityLines, target);
            fs.writeFileSync(path.join(reportsDir, `${slug}-report.md`), md, "utf8");
        }

        let errors = 0, warnings = 0, infos = 0;
        for (const i of issues) {
            const s = core.issueSeverity(i);
            if (s === "error") errors++;
            else if (s === "warning") warnings++;
            else infos++;
        }
        reviewed.push({ slug, errors, warnings, infos, count: issues.length });
        if (githubMode) {
            emitAnnotations(issues);
            writeGithubSummary(buildGithubSummary(slug, issues));
        }
        if (issues.length > 0) {
            console.log(`  ⚠️  ${slug}: ${errors} خطأ، ${warnings} تحذير، ${infos} معلومة`);
        } else {
            console.log(`  ✅ ${slug}: لا توجد مشاكل`);
        }
    }

    // The multi-theme roll-up only makes sense for more than one theme —
    // for a single theme its per-theme line already says everything.
    if (reviewed.length > 1) {
        const withIssues = reviewed.filter((t) => t.count > 0).map((t) => t.slug);
        const clean = reviewed.filter((t) => t.count === 0).map((t) => t.slug);
        console.log(`\n✅ انتهت المراجعة. تم مراجعة ${reviewed.length} ثيم${writeReports ? `، والتقارير داخل: ${reportsDir}` : ""}`);
        console.log("\n📋 ملخص الثيمات بعد المراجعة:");
        console.log(" - الثيمات التي بها مشاكل:");
        console.log(withIssues.length ? "   " + withIssues.join(", ") : "   (لا يوجد)");
        console.log(" - الثيمات السليمة (بدون مشاكل):");
        console.log(clean.length ? "   " + clean.join(", ") : "   (لا يوجد)");
    } else if (writeReports) {
        console.log(`\n📄 التقرير: ${path.join(reportsDir, reviewed[0].slug + "-report.md")}`);
    }

    // Gate: non-zero exit for hooks and CI
    const totalErrors = reviewed.reduce((a, t) => a + t.errors, 0);
    const totalWarnings = reviewed.reduce((a, t) => a + t.warnings, 0);
    const totalInfos = reviewed.reduce((a, t) => a + t.infos, 0);
    const gate =
        (failOn === "error" && totalErrors > 0) ||
        (failOn === "warning" && (totalErrors + totalWarnings) > 0) ||
        (failOn === "any" && (totalErrors + totalWarnings + totalInfos) > 0);
    if (gate) {
        console.error(`\n⛔ فشل الفحص (--fail-on ${failOn}): ${totalErrors} خطأ، ${totalWarnings} تحذير، ${totalInfos} معلومة`);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error("❌", e);
    process.exit(2);
});
