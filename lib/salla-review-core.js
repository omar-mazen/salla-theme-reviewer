"use strict";
/**
 * Salla Theme Review — Core Analyzer
 *
 * Faithfully ported from review-themes.js (the internal reference tool) with only
 * the following differences:
 *  - Issues are collected as objects (issues[]) instead of Markdown text directly,
 *    so they can be used in VS Code Diagnostics and in generating the report in
 *    the same reference format.
 *  - node_modules, .git, and public are skipped while walking the files (the
 *    original project scanned themes downloaded from the API, without node_modules).
 *  - Raed parity relies on raed-manifest.json (pre-generated from THEME-Raed-basic)
 *    instead of reading the Raed folder at runtime.
 *  - The node --check step works inside VS Code via ELECTRON_RUN_AS_NODE=1.
 *  - New addition: a heuristic check for rule 5.2 "misleading marketing" —
 *    Math.random near social-proof/urgency words. Needs human confirmation.
 *
 * The complete review rules are in: Reivew_Rules.md
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The usual rejection text for the salla-scopes issue (so it appears in the report)
const SALLA_SCOPES_REJECTION_HEADER_ONLY =
    "عنصر salla-scopes موجود في header.twig (يجب أن يكون في master.twig فقط).";
const SALLA_SCOPES_REJECTION_IN_BOTH =
    "عنصر salla-scopes موجود في header.twig و master.twig (يجب أن يكون في master.twig فقط).";

/** Issue types that mean an outright rejection (shown as Error in VS Code) */
const ERROR_TYPES = new Set([
    "salla-scopes", "Custom Code", "JS Syntax", "CSS/SCSS",
    "Merge Conflict", "Twilight Version", "Twilight Hooks", "Twig Syntax", "Theme Structure",
    // Documented rejection reasons from the 123-email analysis — a passing check
    // while these exist would be misleading:
    "UI hard-coded text", "Twilight Components", "Twig Division",
]);

/** Directories that are never walked into */
// Tooling folders are never theme code: .salla-review is the vendored CI engine
// (its own sources would otherwise be scanned and flag themselves), .githooks and
// .github are the generated gates, .vscode is editor config.
const SKIP_DIRS = new Set(["node_modules", ".git", "public", ".svn", ".hg", ".salla-review", ".githooks", ".github", ".vscode"]);

/* ============================ General helpers ============================ */

function walkFiles(dir) {
    const stack = [dir];
    const files = [];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                stack.push(p);
            } else if (e.isFile()) files.push(p);
        }
    }
    return files;
}

function isUnderPublic(absPath, baseDir) {
    return path
        .relative(baseDir, absPath)
        .split(path.sep)
        .includes("public");
}

function isReviewable(absPath, baseDir) {
    if (isUnderPublic(absPath, baseDir)) return false;
    const lower = absPath.toLowerCase();
    return lower.endsWith(".twig") || lower.endsWith(".js") || lower.endsWith(".css") || lower.endsWith(".scss");
}

function readLines(fileAbs) {
    return fs.readFileSync(fileAbs, "utf8").split(/\r?\n/);
}

function readFileIfExists(abs) {
    try {
        if (!fs.existsSync(abs)) return null;
        return fs.readFileSync(abs, "utf8");
    } catch {
        return null;
    }
}

function normalizeRel(p) {
    return String(p ?? "").replaceAll("\\", "/");
}

/* ====================== Rules 1+2: hard-coded texts ====================== */

function looksLikeUi(text) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    // We only count "translatable" UI texts: they must contain letters (Arabic/English)
    if (!/[A-Za-zء-ي]/.test(t)) return false;
    if (/^[a-z0-9_./-]+$/.test(t) && !/[ ؀-ۿ]/.test(t)) return false;
    return true;
}

function stripHtmlEntities(input) {
    return String(input ?? "")
        .replace(/&[a-zA-Z]+;/g, " ")
        .replace(/&#\d+;/g, " ")
        .replace(/&#x[0-9a-fA-F]+;/g, " ");
}

function stripHtmlTags(input) {
    return String(input ?? "").replace(/<[^>]*>/g, " ");
}

function stripTemplateExpressions(input) {
    // Remove ${...} because it is not static text but dynamic values
    return String(input ?? "").replace(/\$\{[\s\S]*?\}/g, " ");
}

function normalizeUiCandidate(input) {
    return stripHtmlEntities(stripTemplateExpressions(stripHtmlTags(input)))
        .replace(/\\u\{[0-9a-fA-F]+\}/g, " ")
        .replace(/\\u[0-9a-fA-F]{4}/g, " ")
        .replace(/\\x[0-9a-fA-F]{2}/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// UI texts ignored by default (not reported) — merged with the user's settings
const DEFAULT_IGNORED_UI_TEXTS = ["order summary"];

let IGNORED_UI_TEXTS = new Set(DEFAULT_IGNORED_UI_TEXTS);

function setIgnoredUiTexts(extra) {
    IGNORED_UI_TEXTS = new Set([
        ...DEFAULT_IGNORED_UI_TEXTS,
        ...(Array.isArray(extra) ? extra : []).map((t) => String(t).replace(/\s+/g, " ").trim().toLowerCase()),
    ]);
}

function isIgnoredUiText(text) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    return IGNORED_UI_TEXTS.has(t);
}

function stripTwigInlineComments(line) {
    return line.replace(/\{#.*?#\}/g, "");
}

function stripTwigComments(lines) {
    // Remove Twig comments {# ... #} including multi-line blocks
    const out = [];
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (inBlock) {
            const end = line.indexOf("#}");
            if (end !== -1) {
                inBlock = false;
                line = " ".repeat(end + 2) + line.slice(end + 2);
            } else {
                out.push("");
                continue;
            }
        }
        while (true) {
            const start = line.indexOf("{#");
            if (start === -1) break;
            const end = line.indexOf("#}", start + 2);
            if (end === -1) {
                inBlock = true;
                line = line.slice(0, start);
                break;
            }
            line = line.slice(0, start) + " " + line.slice(end + 2);
        }
        out.push(line);
    }
    return out;
}

/**
 * Replaces the matched region with spaces while preserving lines and offsets
 * (so line numbers stay correct after masking).
 */
function maskRegions(src, regex) {
    return String(src).replace(regex, (m) => m.replace(/[^\n]/g, " "));
}

/** Index of each line's start — to convert an offset into a line number */
function buildLineStarts(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === "\n") starts.push(i + 1);
    }
    return starts;
}

function lineAtIndex(lineStarts, idx) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

/**
 * Mask everything that is not UI text: comments, script/style/svg/noscript/video/audio
 * tags with their content, the exempted attributes, and Twig expressions.
 * The result has exactly the same length as the source.
 */
function maskTwigNonText(src) {
    let s = String(src);
    s = maskRegions(s, /\{#[\s\S]*?#\}/g);
    s = maskRegions(s, /<script\b[\s\S]*?<\/script\s*>/gi);
    s = maskRegions(s, /<style\b[\s\S]*?<\/style\s*>/gi);
    s = maskRegions(s, /<svg\b[\s\S]*?<\/svg\s*>/gi);
    s = maskRegions(s, /<noscript\b[\s\S]*?<\/noscript\s*>/gi);
    s = maskRegions(s, /<video\b[\s\S]*?<\/video\s*>/gi);
    s = maskRegions(s, /<audio\b[\s\S]*?<\/audio\s*>/gi);
    // Tags opened without a close (rare) — mask to the end of the file so their content doesn't leak
    s = maskRegions(s, /<(script|style|svg|noscript)\b[\s\S]*$/gi);
    s = maskRegions(s, /\b(?:aria-label|alt|title|placeholder)\s*=\s*(["'])[\s\S]*?\1/gi);
    s = maskRegions(s, /\{%[\s\S]*?%\}/g);
    s = maskRegions(s, /\{\{[\s\S]*?\}\}/g);
    return s;
}

/** Text that looks like program code rather than UI text */
function looksLikeCodeNotUi(rawText) {
    if (/^(document|window|function|const|let|var|=>|\(\)|addEventListener|querySelector|getElementById|classList|setTimeout|setInterval|new\s+\w+)/i.test(rawText)) {
        return true;
    }
    if (/(document|window)\.(addEventListener|querySelector|getElementById|createElement|getElementsBy|setAttribute|classList|innerHTML|textContent)/i.test(rawText)) {
        return true;
    }
    return false;
}

const VISUALLY_HIDDEN_RE = /\b(hidden|sr-only|visually-hidden|screen-reader-only)\b/i;

function isVisuallyHiddenTag(tagFrag) {
    if (!tagFrag || !VISUALLY_HIDDEN_RE.test(tagFrag)) return false;
    const classAttr = tagFrag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
    const classVal = classAttr ? classAttr[1] : "";
    const tagWithoutClass = tagFrag.replace(/\bclass\s*=\s*["'][^"']*["']/gi, "");
    return VISUALLY_HIDDEN_RE.test(classVal) || VISUALLY_HIDDEN_RE.test(tagWithoutClass);
}

/**
 * Extract UI texts from Twig — operates on the **whole document**, not line by
 * line, so it catches texts spanning multiple lines and texts sitting alone on
 * a separate line (the original version required `>text<` within the same line,
 * so it missed them).
 */
function extractTwigTexts(lines) {
    const src = Array.isArray(lines) ? lines.join("\n") : String(lines);
    const masked = maskTwigNonText(src);
    const lineStarts = buildLineStarts(masked);
    const out = [];

    // We split the document on tags: whatever lies between one tag and the next
    // is a text node. The tag regex skips quoted values so it doesn't end at a
    // ">" inside an attribute (e.g. Tailwind classes: class="[&>*]:relative").
    const tagRe = /<(?:[^>"']|"[^"<]*"|'[^'<]*')*>/g;
    const segments = [];
    let last = 0;
    let prevTag = "";
    let m;
    while ((m = tagRe.exec(masked))) {
        if (m.index > last) {
            segments.push({ start: last, text: masked.slice(last, m.index), openTag: prevTag });
        }
        prevTag = m[0];
        last = m.index + m[0].length;
    }
    if (last < masked.length) {
        segments.push({ start: last, text: masked.slice(last), openTag: prevTag });
    }

    for (const seg of segments) {
        const firstIdx = seg.text.search(/\S/);
        if (firstIdx === -1) continue;

        const rawText = seg.text.replace(/\s+/g, " ").trim();
        if (!rawText) continue;

        if (/\btrans\s*\(/i.test(rawText) || /\|\s*trans\b/i.test(rawText)) continue;
        if (rawText.includes("~")) continue;
        if (isVisuallyHiddenTag(seg.openTag)) continue;
        if (looksLikeCodeNotUi(rawText)) continue;

        const visible = normalizeUiCandidate(rawText);
        if (!visible) continue;
        if (!looksLikeUi(visible)) continue;
        if (isIgnoredUiText(visible)) continue;

        out.push({ line: lineAtIndex(lineStarts, seg.start + firstIdx), text: visible });
    }
    return out;
}

function stripJsComments(lines) {
    const out = [];
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (inBlock) {
            const end = line.indexOf("*/");
            if (end !== -1) {
                inBlock = false;
                line = " ".repeat(end + 2) + line.slice(end + 2);
            } else {
                out.push("");
                continue;
            }
        }
        while (true) {
            const start = line.indexOf("/*");
            if (start === -1) break;
            const end = line.indexOf("*/", start + 2);
            if (end === -1) {
                inBlock = true;
                line = line.slice(0, start);
                break;
            }
            line = line.slice(0, start) + " " + line.slice(end + 2);
        }
        // Fix over the original: don't treat "//" as a comment when preceded by ":" (e.g. https://)
        // — the original tool truncated URLs, so the security check failed on any URL.
        let idx = line.indexOf("//");
        while (idx > 0 && line[idx - 1] === ":") idx = line.indexOf("//", idx + 2);
        if (idx !== -1) line = line.slice(0, idx);
        out.push(line);
    }
    return out;
}

function shouldIgnoreJs(str, fullLine) {
    if (/\bconsole\.(log|error|warn|info|debug)\b/.test(fullLine)) return true;
    if (str.includes("<salla-")) return true;
    if (/\bsalla\.lang(\.get)?\s*\(/.test(fullLine)) return true;
    if (/\$\{.*salla\.lang(\.get)?\s*\(/.test(fullLine)) return true;

    if (/^<[a-z]+[^>]*>\s*<\/[a-z]+>$/i.test(str.trim())) return true;
    if (/^<[a-z]+[^>]*class\s*=\s*["'][^"']*["'][^>]*>\s*<\/[a-z]+>$/i.test(str.trim())) return true;
    if (/^<[a-z]+[^>]*>\s*<\/[a-z]+>$/i.test(str.trim())) return true;
    if (/^<i\s+class\s*=\s*["'][^"']*["'][^>]*>\s*<\/i>$/i.test(str.trim())) return true;
    if (/^<svg[^>]*>[\s\S]*<\/svg>$/i.test(str.trim())) return true;

    const trimmed = str.trim();
    if (/^`?\s*<[a-z]+[^>]*>\s*<\/[a-z]+>\s*`?$/i.test(trimmed)) return true;
    if (/^<i\s+class\s*=\s*["'][^"']*\$\{[^}]+\}[^"']*["'][^>]*>\s*<\/i>$/i.test(trimmed)) return true;
    if (/^`?\s*<i\s+class\s*=\s*["'][^"']*\$\{[^}]+\}[^"']*["'][^>]*>\s*<\/i>\s*`?$/i.test(trimmed)) return true;

    const trimmedStr = str.trim();
    if (/^[`"]?\s*[×*x]\s*\$\{/.test(trimmedStr)) return true;

    return false;
}

/**
 * UI sinks in JS: any string value reaching them gets displayed to the user.
 * Expanded over the original version (which covered only
 * textContent/innerText/innerHTML/alert/toast).
 */
const JS_UI_SINKS = [
    /\b(?:innerHTML|outerHTML|textContent|innerText)\s*=\s*/g,
    /\binsertAdjacentHTML\s*\(\s*['"][^'"]*['"]\s*,\s*/g,
    /\b(?:alert|confirm|prompt)\s*\(\s*/g,
    /\b(?:toast|notify|notification|showToast|showtoast)\s*\(\s*/gi,
    /\b(?:swal|Swal)\.fire\s*\(\s*/g,
    /\bsalla\.notify\.(?:success|error|warning|info|default)\s*\(\s*/g,
    /\bdocument\.write(?:ln)?\s*\(\s*/g,
    /\.html\s*\(\s*/g,
    /\.text\s*\(\s*/g,
];

/**
 * Reads a string literal (' or " or `) starting at the quote mark, across
 * multiple lines, fully skipping ${...} expressions (they are not static text).
 */
function readJsStringLiteral(src, startIdx) {
    const quote = src[startIdx];
    if (quote !== "'" && quote !== '"' && quote !== "`") return null;
    let i = startIdx + 1;
    let out = "";
    while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
            out += src[i + 1] || "";
            i += 2;
            continue;
        }
        if (ch === quote) return { text: out, end: i + 1 };
        // Regular strings do not span lines without a trailing \ at the end of the line
        if (ch === "\n" && quote !== "`") return { text: out, end: i };
        if (quote === "`" && ch === "$" && src[i + 1] === "{") {
            i += 2;
            let depth = 1;
            while (i < src.length && depth > 0) {
                const c = src[i];
                if (c === "\\") { i += 2; continue; }
                if (c === "{") depth++;
                else if (c === "}") depth--;
                i++;
            }
            out += " ";
            continue;
        }
        out += ch;
        i++;
    }
    return { text: out, end: src.length };
}

/**
 * Extract UI texts from JS — operates on the **whole document**, so it supports
 * texts spanning several lines. Unlike the original version, which ignored any
 * string starting with an HTML tag, here we extract the text nodes from inside
 * the markup (rule 1 requires reporting UI texts built inside JS), while bare
 * tags (icons, salla-* components) remain unreported because they contain no
 * text after stripping.
 */
function extractJsUi(lines) {
    const cleanedLines = stripJsComments(Array.isArray(lines) ? lines : String(lines).split(/\r?\n/));
    const src = cleanedLines.join("\n");
    const lineStarts = buildLineStarts(src);
    const out = [];
    const seen = new Set();

    for (const sinkRe of JS_UI_SINKS) {
        sinkRe.lastIndex = 0;
        let m;
        while ((m = sinkRe.exec(src))) {
            let j = m.index + m[0].length;
            while (j < src.length && /\s/.test(src[j])) j++;
            const lit = readJsStringLiteral(src, j);
            if (!lit) continue;

            const line = lineAtIndex(lineStarts, m.index);
            const lineText = cleanedLines[line - 1] || "";
            const norm = String(lit.text).replace(/\s+/g, " ").trim();
            if (!norm) continue;

            // The full call context (may span lines) to check for salla.lang
            const context = src.slice(m.index, lit.end);
            if (/\bsalla\.lang(\.get)?\s*\(/.test(context)) continue;

            const visible = normalizeUiCandidate(norm);
            if (!visible) continue;
            if (!looksLikeUi(visible)) continue;
            if (isIgnoredUiText(visible)) continue;
            if (shouldIgnoreJs(norm, lineText)) continue;

            const key = `${line}|${visible}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ line, text: visible });
        }
    }

    out.sort((a, b) => a.line - b.line);
    return out;
}

function extractCssContent(lines) {
    const out = [];
    const re = /\bcontent\s*:\s*(['"])(.*?)\1\s*;?/g;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m;
        while ((m = re.exec(line))) {
            const norm = String(m[2]).replace(/\s+/g, " ").trim();
            if (!looksLikeUi(norm)) continue;
            if (isIgnoredUiText(norm)) continue;

            if (/^\\[efu][0-9a-fA-F]{3,4}$/.test(norm) || /^\\[0-9a-fA-F]{4,6}$/.test(norm)) continue;
            if (/^\\[0-9a-fA-F]{1,6}$/i.test(norm)) continue;
            if (/^["']?\\[efu0-9a-fA-F]+["']?$/i.test(norm)) continue;

            out.push({ line: i + 1, text: norm });
        }
    }
    return out;
}

/* ====================== Rule 3: programming errors ====================== */

function checkJsSyntax(fileAbs, issues, opts) {
    if (opts && opts.nodeSyntaxCheck === false) return;
    // In-process check via vm.Script (compile only, no execution).
    // The previous version spawned a node --check process per file (~60ms per
    // file × dozens of files = seconds of synchronous freezing of the extension
    // host) — that was why Prettier and Git tools stalled during scans.
    let src;
    try {
        src = fs.readFileSync(fileAbs, "utf8");
    } catch {
        return;
    }
    try {
        new vm.Script(src, { filename: path.basename(fileAbs) });
        return; // valid
    } catch (e) {
        const msg = String((e && (e.stack || e.message)) || "");

        // ES Module files and module-"flavor" errors are not real syntax errors here
        if (/Cannot use import statement|Unexpected token 'export'|export declarations|import declarations|await is only valid|Illegal return statement|ES module|\.mjs/i.test(msg)) return;
        if (/is not defined|Cannot find|Cannot resolve|Module not found/i.test(msg)) return;

        const lines = src.split(/\r?\n/);
        if (lines.length > 0 && /^\s*(import|export)/.test(lines[0])) return;

        // Fix over the original: look first for "filename:number" instead of the first ":N:"
        // in the message (the original picked up numbers from node's internal stack),
        // and clamp the number to the file's length.
        const baseEsc = path.basename(fileAbs).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m =
            msg.match(new RegExp(baseEsc + ":(\\d+)")) ||
            msg.match(/:(\d+):/) ||
            msg.match(/:(\d+)\s*$/m);
        let line = m ? Number(m[1]) : 1;
        if (!Number.isFinite(line) || line < 1 || line > lines.length) line = 1;
        issues.push({
            type: "JS Syntax",
            file: fileAbs,
            line,
            desc: "خطأ تركيب (Syntax) واضح",
            lines,
        });
    }
}

function checkCssBraces(fileAbs, issues) {
    const lines = readLines(fileAbs);
    let balance = 0;
    for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === "{") balance++;
            if (ch === "}") balance--;
        }
        if (balance < 0) {
            issues.push({
                type: "CSS/SCSS",
                file: fileAbs,
                line: i + 1,
                desc: "قوس إغلاق زائد/غير متطابق",
                lines,
            });
            // Reset and continue instead of stopping — so we report every extra brace in the file
            balance = 0;
        }
    }
    if (balance !== 0) {
        issues.push({
            type: "CSS/SCSS",
            file: fileAbs,
            line: 1,
            desc: "أقواس غير متطابقة ({} غير متوازن)",
            lines,
        });
    }
}

/* ========================= Rule 5: security ========================= */

function detectDomain(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function isSallaHost(host) {
    if (!host) return false;
    return host === "salla.dev" || host.endsWith(".salla.dev") || host === "salla.sa" || host.endsWith(".salla.sa") || host.includes("salla");
}

function checkJsSecurity(fileAbs, issues) {
    const raw = readLines(fileAbs);
    const lines = stripJsComments(raw);

    // Expanded beyond fetch/open to cover other sending channels mentioned in rule 5
    const fetchRe =
        /\b(fetch|open|sendBeacon|WebSocket|EventSource|importScripts|axios(?:\.(?:get|post|put|patch|delete|request))?)\s*\(\s*(['"`])(https?:\/\/|\/\/)([^'"`]+)\2/gi;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        fetchRe.lastIndex = 0;
        let m;
        const reportedOnLine = new Set();
        while ((m = fetchRe.exec(line))) {
            const url = (m[3] === "//" ? "https://" : m[3]) + m[4];
            const host = detectDomain(url);
            // Report every external domain on the line (it used to stop at the first)
            if (host && !isSallaHost(host) && !reportedOnLine.has(host)) {
                reportedOnLine.add(host);
                issues.push({
                    type: "Security",
                    file: fileAbs,
                    line: i + 1,
                    severity: "error", // policy violation; cookie/storage checks below stay warnings
                    desc: `طلب إلى نطاق خارجي غير معتمد (${host})`,
                    lines: raw,
                });
            }
        }
    }

    const cookieRe = /\bdocument\.cookie\b/;
    const storageRe = /\b(localStorage|sessionStorage)\.(setItem|getItem|removeItem)\s*\(/;
    const allowedKeys = [
        "liked_blogs", "favorites", "preferences", "theme", "language", "view_mode",
        "cart_state", "sidebar_state", "wishlist", "cart", "salla::wishlist",
        "salla::cart", "salla::", "sidebar", "menu", "navigation",
    ];

    const isAllowedKey = (key) => {
        const k = String(key || "").toLowerCase();
        if (k.startsWith("salla::")) return true;
        return allowedKeys.some((a) => k.includes(a));
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (cookieRe.test(line)) {
            issues.push({
                type: "Security",
                file: fileAbs,
                line: i + 1,
                desc: "استخدام document.cookie (تحقق من عدم تخزين بيانات حساسة)",
                lines: raw,
            });
        }
        if (storageRe.test(line)) {
            const km = line.match(/\b(?:localStorage|sessionStorage)\.setItem\s*\(\s*(['"`])([^'"`]+)\1/);
            const key = km ? km[2] : null;
            if (key && isAllowedKey(key)) continue;
            if (key && /(wishlist|cart|favorite|preference|theme|language|view|sidebar|menu|navigation|ui|state)/i.test(key)) {
                continue;
            }
            const sensitive = key && /(token|auth|password|session|secret|bearer|key|credential)/i.test(key);
            if (sensitive) {
                issues.push({
                    type: "Security",
                    file: fileAbs,
                    line: i + 1,
                    desc: "تخزين بيانات حساسة محتملة في Storage",
                    lines: raw,
                });
            }
        }
    }
}

/* ==================== Rule 4: salla-scopes placement ==================== */

function checkScopes(themeRoot, issues) {
    const files = walkFiles(themeRoot).filter((p) => p.endsWith(".twig") && !isUnderPublic(p, themeRoot));
    const master = files.find((p) => p.endsWith(path.join("src", "views", "layouts", "master.twig")));
    const header = files.find((p) => p.endsWith(path.join("src", "views", "components", "header", "header.twig")));
    const needle = "salla-scopes";
    let masterHas = false;

    /** All line numbers where the element appears (after stripping comments) */
    const occurrences = (fileAbs) => {
        const raw = readLines(fileAbs);
        const cleaned = stripTwigComments(raw).map(stripTwigInlineComments);
        const hits = [];
        for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i].includes(needle)) hits.push(i + 1);
        }
        return { raw, hits };
    };

    let masterHits = [];
    let masterRaw = null;
    if (master && fs.existsSync(master)) {
        const r = occurrences(master);
        masterRaw = r.raw;
        masterHits = r.hits;
        masterHas = masterHits.length > 0;

        // Element repeated within master.twig itself — an actual rejection reason used before
        for (let k = 1; k < masterHits.length; k++) {
            issues.push({
                type: "salla-scopes",
                file: master,
                line: masterHits[k],
                desc: `عنصر salla-scopes مكرّر داخل master.twig (المرة ${k + 1} من ${masterHits.length}) — يجب أن يرد مرة واحدة فقط.`,
                lines: masterRaw,
            });
        }
    }

    if (header && fs.existsSync(header)) {
        const { raw, hits } = occurrences(header);
        // Report **every** occurrence in the header, not only the first
        for (const line of hits) {
            issues.push({
                type: "salla-scopes",
                file: header,
                line,
                desc: masterHas ? SALLA_SCOPES_REJECTION_IN_BOTH : SALLA_SCOPES_REJECTION_HEADER_ONLY,
                lines: raw,
            });
        }
    }

    // Rule 4 requires its presence in master.twig
    if (master && fs.existsSync(master) && !masterHas) {
        issues.push({
            type: "salla-scopes",
            file: master,
            line: 1,
            desc: "عنصر salla-scopes غير موجود في master.twig (البند 4 يوجب وجوده فيه).",
            lines: masterRaw || readLines(master),
        });
    }
}

/* ==================== Rule 5.1: Custom Code ==================== */

/** Tries to find the actual line number of a setting inside twilight.json (an improvement over the original approximation) */
function findSettingLine(rawLines, setting, fallback) {
    const needles = [setting.id, setting.label]
        .filter(Boolean)
        .map((s) => `"${String(s)}"`);
    for (const needle of needles) {
        const idx = rawLines.findIndex((l) => l.includes(needle));
        if (idx !== -1) return idx + 1;
    }
    return fallback;
}

function checkTwilightJson(themeRoot, issues) {
    const twilightFile = path.join(themeRoot, "twilight.json");
    if (!fs.existsSync(twilightFile)) return;

    try {
        const content = fs.readFileSync(twilightFile, "utf8");
        const json = JSON.parse(content);
        const rawLines = content.split(/\r?\n/);

        const suspiciousPatterns = [
            /custom\s*(?:code|js|html|css|script|javascript)/i,
            /(?:code|js|html|css|script|javascript)\s*(?:custom|editor|input|field|area)/i,
            /allow.*custom.*(?:code|js|html|css|script)/i,
            /custom.*(?:code|js|html|css|script)\s*(?:editor|input|field|area)/i,
            /(?:code|html|css|js|script|javascript)\s*editor/i,
            /editor\s*(?:code|html|css|js|script|javascript)/i,
        ];

        if (Array.isArray(json.settings)) {
            for (let i = 0; i < json.settings.length; i++) {
                const setting = json.settings[i];
                const id = String(setting.id || "").toLowerCase();
                const label = String(setting.label || "").toLowerCase();
                const type = String(setting.type || "").toLowerCase();
                const format = String(setting.format || "").toLowerCase();
                const description = String(setting.description || "").toLowerCase();
                const placeholder = String(setting.placeholder || "").toLowerCase();

                const allText = `${id} ${label} ${description} ${placeholder}`.toLowerCase();
                const isBooleanToggleOnly = type === "boolean";

                for (const pattern of suspiciousPatterns) {
                    if (pattern.test(allText)) {
                        if (isBooleanToggleOnly) continue;
                        issues.push({
                            type: "Custom Code",
                            file: twilightFile,
                            line: findSettingLine(rawLines, setting, i + 1),
                            desc: `حقل في twilight.json يسمح بإدخال أكواد مخصصة: "${setting.id || setting.label || "unknown"}"`,
                            lines: rawLines,
                        });
                        break;
                    }
                }

                if ((type === "string" || format === "textarea" || format === "text") &&
                    (format.includes("code") || format.includes("html") || format.includes("css") ||
                     format.includes("js") || format.includes("script") || format.includes("javascript"))) {
                    issues.push({
                        type: "Custom Code",
                        file: twilightFile,
                        line: findSettingLine(rawLines, setting, i + 1),
                        desc: `حقل في twilight.json يسمح بإدخال أكواد مخصصة (type: ${type}, format: ${format}): "${setting.id || setting.label || "unknown"}"`,
                        lines: rawLines,
                    });
                }

                if ((id.includes("custom") || label.includes("custom")) &&
                    (type === "string" || format === "textarea" || format === "text") &&
                    (id.includes("code") || id.includes("html") || id.includes("css") ||
                     id.includes("js") || id.includes("script") ||
                     label.includes("code") || label.includes("html") || label.includes("css") ||
                     label.includes("js") || label.includes("script"))) {
                    issues.push({
                        type: "Custom Code",
                        file: twilightFile,
                        line: findSettingLine(rawLines, setting, i + 1),
                        desc: `حقل في twilight.json يسمح بإدخال أكواد مخصصة: "${setting.id || setting.label || "unknown"}"`,
                        lines: rawLines,
                    });
                }
            }
        }
    } catch {
        // Ignore JSON parsing errors
    }
}

/**
 * Fix over the original: match suspicious settings keys by splitting
 * snake_case/kebab-case into words — the original used \b, which does not catch
 * "css_handle" (the very example of rule 5.1 in the rules).
 */
/** Tokens explicitly denoting a programming/markup language — a strong signal on their own */
const CODE_LANG_TOKENS = new Set(["css", "js", "javascript", "html", "script", "scripts", "handle"]);
/** Generic tokens — "code" alone is ambiguous (e.g. coupon_code), so it needs a second clue */
const CODE_WEAK_TOKENS = new Set(["code", "codes", "snippet", "snippets"]);
const CODE_CONTEXT_TOKENS = new Set(["custom", "advanced", "editor", "raw", "embed", "inject"]);

function isSuspiciousSettingsKey(key) {
    const toks = String(key || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (toks.some((t) => CODE_LANG_TOKENS.has(t))) return true;
    // "code" is accepted only with a contextual clue (custom/advanced/editor…) — to avoid cases like coupon_code
    const hasWeak = toks.some((t) => CODE_WEAK_TOKENS.has(t));
    const hasContext = toks.some((t) => CODE_CONTEXT_TOKENS.has(t));
    return hasWeak && hasContext;
}

/** Check settings injection inside <style>/<script> — for a single Twig file */
function checkCustomCodeFile(file, issues) {
    const raw = readLines(file);
    const cleaned = stripTwigComments(raw).map(stripTwigInlineComments);

    let inStyle = false;
    let inScript = false;

    for (let i = 0; i < cleaned.length; i++) {
        const line = cleaned[i];
        const lower = line.toLowerCase();

        // Openers before the check and closers after it — so single-line forms
        // like <style>{{ theme.settings.get('css_handle') }}</style> are caught
        if (lower.includes("<style")) inStyle = true;
        if (lower.includes("<script")) inScript = true;
        const scanThisLine = inStyle || inScript;
        if (lower.includes("</style")) inStyle = false;
        if (lower.includes("</script")) inScript = false;

        if (!scanThisLine) continue;

        const keyRe = /theme\.settings\.get\s*\(\s*['"]([^'"]+)['"]/gi;
        let m;
        while ((m = keyRe.exec(line))) {
            const key = m[1] || "";
            if (!isSuspiciousSettingsKey(key)) continue;

            issues.push({
                type: "Custom Code",
                file,
                line: i + 1,
                desc: `حقن محتوى إعدادات ثيم مشبوه داخل <style>/<script> عبر المفتاح "${key}" (قد يتيح Custom Code للتاجر)`,
                lines: raw,
            });
        }
    }
}

/** Rule 5.1: a setting that loads external CSS based on store identity — for a single Twig file */
function checkDeveloperPermissionFile(file, issues) {
    const raw = readLines(file);
    const joined = raw.join("\n");
    if (!/theme\.settings\.get\s*\(\s*["']developer_permission/i.test(joined)) return;
    if (!/<link\s[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/i.test(joined)) return;
    const lineIdx = raw.findIndex((l) => /developer_permission/i.test(l));
    if (lineIdx === -1) return;
    issues.push({
        type: "Custom Code",
        file,
        line: lineIdx + 1,
        desc: "إعداد developer_permission يتيح تحميل ملف CSS خارجي ديناميكي (مسار أكواد مخصصة للتاجر حسب البند 5.1)",
        lines: raw,
    });
}

/* ============ Rule 5.2: misleading marketing (new heuristic check) ============ */
// Note: the original internal tool does not check this rule automatically (human review).
// This is a conservative heuristic: Math.random near social-proof/urgency words — needs human confirmation.

const SOCIAL_PROOF_WORDS_RE =
    /(viewers?|watching|viewing|people are|sold|purchased|buyers?|visitors?|left in stock|hurry|only \d+ left|يشاهد|مشاهد|زائر|زوار|اشتر[وى]|تم شراء|مشتري|متبقي|باقي قليل|الطلب مرتفع)/i;

function checkMisleadingUx(fileAbs, issues) {
    const raw = readLines(fileAbs);
    const lower = fileAbs.toLowerCase();
    const cleaned = lower.endsWith(".twig")
        ? stripTwigComments(raw).map(stripTwigInlineComments)
        : stripJsComments(raw);

    const WINDOW = 10;
    for (let i = 0; i < cleaned.length; i++) {
        if (!/\bMath\.random\s*\(/.test(cleaned[i])) continue;
        const from = Math.max(0, i - WINDOW);
        const to = Math.min(cleaned.length - 1, i + WINDOW);
        let hit = false;
        for (let j = from; j <= to; j++) {
            if (SOCIAL_PROOF_WORDS_RE.test(cleaned[j])) {
                hit = true;
                break;
            }
        }
        if (hit) {
            issues.push({
                type: "Misleading UX (Social Proof/Urgency)",
                file: fileAbs,
                line: i + 1,
                desc: "استخدام Math.random() بالقرب من نصوص إثبات اجتماعي/استعجال — رقم غير حقيقي قد يُعرض للعميل (بند 5.2، يحتاج تأكيداً يدوياً)",
                lines: raw,
            });
        }
    }

    // Phrases rejected verbatim in Salla's emails (~9 rejection messages): the phrase's
    // mere presence is a rejection reason, since Salla provides no real-time viewer/buyer
    // data in the first place — no Math.random clue needed.
    for (let i = 0; i < cleaned.length; i++) {
        if (FAKE_ENGAGEMENT_PHRASES_RE.test(cleaned[i])) {
            issues.push({
                type: "Misleading UX (Social Proof/Urgency)",
                file: fileAbs,
                line: i + 1,
                severity: "error",
                desc: "عبارة تفاعل وهمي مرفوضة صراحةً في مراجعات سلة (مثل «يشاهد هذا المنتج») — سلة لا توفر بيانات مشاهدين/مشترين لحظية؛ احذف العبارة أو اربطها بمصدر بيانات حقيقي معتمد",
                lines: raw,
            });
        }
    }
}

/** Phrases that appeared verbatim as rejection reasons in Salla's emails */
const FAKE_ENGAGEMENT_PHRASES_RE =
    /(يشاهد(?:ون)?\s+هذا\s+المنتج|شخص\s+يشاهد|watching\s+this\s+product|are\s+viewing\s+this)/i;

/* ==================== Theme project root + theme discovery ==================== */

/** Project root marker: a classic theme (twilight.json) or a component bundle (twilight-bundle.json) */
function isRootMarker(p) {
    const base = path.basename(p).toLowerCase();
    return base === "twilight.json" || base === "twilight-bundle.json";
}

/** The theme project root (the folder containing twilight.json or twilight-bundle.json); supports slug/hash/ nesting */
function findThemeProjectRoot(slugDirAbs) {
    const files = walkFiles(slugDirAbs).filter((p) => !p.split(path.sep).includes("public"));
    const tw = files.find((p) => path.basename(p).toLowerCase() === "twilight.json")
        || files.find((p) => path.basename(p).toLowerCase() === "twilight-bundle.json");
    return tw ? path.dirname(tw) : slugDirAbs;
}

/** All theme/bundle roots under a folder, ignoring ones nested under a higher root */
function findThemeRoots(baseDir) {
    const roots = [];
    const twFiles = walkFiles(baseDir).filter(
        (p) => isRootMarker(p) && !p.split(path.sep).includes("public")
    );
    for (const tw of twFiles) {
        roots.push(path.dirname(tw));
    }
    roots.sort((a, b) => a.length - b.length);
    // Exclude roots nested inside another root
    const kept = [];
    for (const r of roots) {
        if (!kept.some((k) => r !== k && r.startsWith(k + path.sep))) kept.push(r);
    }
    return kept;
}

/* ==================== Raed parity (via manifest) ==================== */

/** Maximum report lines in the parity section (followed by a summary) */
const RAED_PARITY_MAX_LINES = 180;

/** Common generic platform components — not counted as a "feature" for the Raed comparison */
const EXCLUDED_GENERIC_SALLA_COMPONENTS = new Set(["salla-button"]);

function filterParitySallaTags(tags) {
    return tags.filter((t) => !EXCLUDED_GENERIC_SALLA_COMPONENTS.has(String(t).toLowerCase()));
}

/** Excluded from the Twig comparison: the home page and its components */
function isExcludedRaedTwigRel(rel) {
    const n = normalizeRel(rel);
    if (n === "src/views/pages/index.twig") return true;
    if (n.includes("components/home/")) return true;
    return false;
}

/** Excluded from the JS comparison: the home page script */
function isExcludedRaedJsRel(rel) {
    const n = normalizeRel(rel);
    if (n === "src/assets/js/home.js") return true;
    return false;
}

/** Extract <salla-*> component names from Twig after stripping Twig comments */
function extractSallaComponentNamesFromTwigSource(src) {
    const lines = String(src).split(/\r?\n/);
    const cleaned = stripTwigComments(lines).join("\n");
    const re = /<(salla-[a-z0-9-]+)/gi;
    const set = new Set();
    let m;
    while ((m = re.exec(cleaned))) {
        set.add(m[1]);
    }
    return filterParitySallaTags([...set].sort());
}

/** salla.* tokens from JS after stripping comments */
function extractSallaApiTokensFromJsSource(src) {
    const lines = stripJsComments(String(src).split(/\r?\n/));
    const cleaned = lines.join("\n");
    const re = /\bsalla\.[a-zA-Z0-9_.]+\b/g;
    const set = new Set();
    let m;
    while ((m = re.exec(cleaned))) {
        set.add(m[0]);
    }
    return [...set].sort();
}

/** app.watchElements({ ... }) keys in a JS file */
function extractWatchElementsKeysFromJs(src) {
    const lines = stripJsComments(String(src).split(/\r?\n/));
    const cleaned = lines.join("\n");
    const m = cleaned.match(/app\.watchElements\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (!m) return [];
    const inner = m[1];
    const keys = [];
    const keyRe = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/gm;
    let mm;
    while ((mm = keyRe.exec(inner))) {
        keys.push(mm[1]);
    }
    return [...new Set(keys)].sort();
}

let cachedManifest = undefined;
let manifestOverridePath = null;

/**
 * Set an alternate path for raed-manifest.json (used by the extension after the
 * automatic update from GitHub — the copy stored in globalStorage survives
 * extension upgrades).
 */
function setRaedManifestPath(p) {
    manifestOverridePath = p || null;
    cachedManifest = undefined; // reload on the next request
}

function loadRaedManifest() {
    if (cachedManifest !== undefined) return cachedManifest;
    for (const p of [manifestOverridePath, path.join(__dirname, "raed-manifest.json")]) {
        if (!p) continue;
        try {
            cachedManifest = JSON.parse(fs.readFileSync(p, "utf8"));
            return cachedManifest;
        } catch { /* try the next one */ }
    }
    cachedManifest = null;
    return cachedManifest;
}

/**
 * Comprehensive comparison against Raed: Twig under src/views (excluding home),
 * and JS under src/assets/js (excluding home.js). The reference comes from
 * raed-manifest.json. The output matches the original tool's format.
 */
function compareWithRaed(themeRoot) {
    const manifest = loadRaedManifest();
    if (!manifest || !manifest.twig || !manifest.js) {
        return [
            "- **تعذر المقارنة:** ملف المرجع `raed-manifest.json` غير موجود (أعد توليده عبر scripts/build-raed-manifest.js).",
        ];
    }

    const blocks = [];

    for (const rel of Object.keys(manifest.twig)) {
        const tags = manifest.twig[rel];
        const themeRaw = readFileIfExists(path.join(themeRoot, rel));

        if (themeRaw == null) {
            if (tags.length) {
                blocks.push([
                    `- **\`${rel}\`**`,
                    `  - الملف غير موجود في الثيم؛ في \`THEME-Raed-basic\` يظهر فيه المكوّنات التالية:`,
                    ...tags.map((t) => `  - \`${t}\``),
                ]);
            } else {
                blocks.push([
                    `- **\`${rel}\`**`,
                    `  - الملف غير موجود في الثيم (موجود في المرجع \`THEME-Raed-basic\`).`,
                ]);
            }
            continue;
        }

        const missingTags = tags.filter((tag) => !themeRaw.includes(tag));
        if (missingTags.length) {
            blocks.push([
                `- **\`${rel}\`** — ينقص مكوّنات المنصة مقارنة برائد:`,
                ...missingTags.map((t) => `  - \`${t}\``),
            ]);
        }
    }

    for (const rel of Object.keys(manifest.js)) {
        const entry = manifest.js[rel];
        const themeRaw = readFileIfExists(path.join(themeRoot, rel));

        if (themeRaw == null) {
            blocks.push([`- **\`${rel}\`**`, `  - ملف JS غير موجود في الثيم (موجود في \`THEME-Raed-basic\`).`]);
            continue;
        }

        const themeWatch = extractWatchElementsKeysFromJs(themeRaw);
        const missWatch = entry.watch.filter((k) => !themeWatch.includes(k));
        if (missWatch.length) {
            blocks.push([
                `- **\`${rel}\`** — مفاتيح \`app.watchElements\` الناقصة (معرّفة في رائد):`,
                ...missWatch.map((k) => `  - \`${k}\``),
            ]);
        }

        const missSalla = entry.salla.filter((t) => !themeRaw.includes(t));
        if (missSalla.length) {
            const show = missSalla.slice(0, 25);
            const sallaBlock = [
                `- **\`${rel}\`** — رموز \`salla.*\` ظاهرة في رائد وغير وردت في ملف الثيم:`,
                ...show.map((x) => `  - \`${x}\``),
            ];
            if (missSalla.length > 25) {
                sallaBlock.push(`  - … و**${missSalla.length - 25}** رمزًا إضافيًا`);
            }
            blocks.push(sallaBlock);
        }
    }

    const lines = [];
    for (let i = 0; i < blocks.length; i++) {
        lines.push(...blocks[i]);
        if (i < blocks.length - 1) lines.push("");
    }
    if (lines.length === 0) {
        return [
            "لا توجد فجوات آلية ظاهرة مقارنة بـ `THEME-Raed-basic` في نطاق: قوالب `src/views` (باستثناء الصفحة الرئيسية ومكوّنات `home`)، وملفات `src/assets/js` (باستثناء `home.js`).",
        ];
    }

    if (lines.length > RAED_PARITY_MAX_LINES) {
        const rest = lines.length - RAED_PARITY_MAX_LINES;
        return [
            `> **ملاحظة:** تم اقتصار القائمة على **${RAED_PARITY_MAX_LINES}** سطرًا؛ يوجد **${rest}** سطرًا إضافيًا (أعد تشغيل المراجعة بعد المعالجة أو راجع الفرق يدويًا).`,
            "",
            ...lines.slice(0, RAED_PARITY_MAX_LINES),
        ];
    }
    return lines;
}

/* ============================================================
 * Checks distilled from analyzing 123 actual Salla rejection emails (2025-11 → 2026-08)
 * Each check below corresponds to a recurring rejection reason in the correspondence.
 * ============================================================ */

/**
 * Required hooks (from the rejection emails — referencing Raed PRs 930/933/938).
 * The keys are relative to src/views inside the theme.
 */
const REQUIRED_HOOKS = {
    "pages/product/single.twig": [
        "product.single.before_product_info",
        "product.single.before_customer_reviews",
        "product.single.before_product_recommendations",
        "product.single.after_product_recommendations",
    ],
    "pages/product/index.twig": [
        "product.index.before_products_group_with_filter",
        "product.index.after_products_group_with_filter",
        "product.index.after_testimonials",
    ],
    "pages/page-single.twig": [
        "information_page.information_page",
    ],
};

/**
 * Required components and their expected location (from the rejection emails).
 * The check passes if the component is found in any Twig file in the theme —
 * the location is only indicative.
 */
const REQUIRED_COMPONENTS = {
    "components/header/header.twig": ["salla-user-menu", "salla-cart-summary", "salla-search"],
    "pages/cart.twig": ["salla-cart-coupons", "salla-loyalty-panel", "salla-tiered-offer", "salla-cart-item-offers", "salla-cart-summary-card"],
    "pages/customer/orders/single.twig": ["salla-edit-order-button", "salla-order-totals-card", "salla-order-details", "salla-review-factors-tags"],
    "pages/thank-you.twig": ["salla-next-order-coupon", "salla-order-shipments"],
    "pages/partials/product/options.twig": ["salla-multiple-bundle-product"],
};

function viewsPath(themeRoot, rel) {
    return path.join(themeRoot, "src", "views", ...rel.split("/"));
}

/** Required hooks — the emails reject the theme when they are absent (a deterministic check matching Salla's) */
function checkRequiredHooks(themeRoot, issues) {
    for (const [rel, hooks] of Object.entries(REQUIRED_HOOKS)) {
        const abs = viewsPath(themeRoot, rel);
        const raw = readFileIfExists(abs);
        if (raw == null) {
            issues.push({
                type: "Twilight Hooks",
                file: path.join(themeRoot, "twilight.json"),
                line: 1,
                desc: `الملف src/views/${rel} غير موجود، وهو مطلوب ويجب أن يحتوي الهوكس: ${hooks.join("، ")} — مرجع: PRs رائد 930/933/938`,
                lines: readFileIfExists(path.join(themeRoot, "twilight.json"))?.split(/\r?\n/) || [""],
            });
            continue;
        }
        const cleaned = stripTwigComments(raw.split(/\r?\n/)).join("\n");
        const missing = hooks.filter((h) => !cleaned.includes(h));
        if (missing.length) {
            issues.push({
                type: "Twilight Hooks",
                file: abs,
                line: 1,
                desc: `هوكس مطلوبة غير مضافة في src/views/${rel}: ${missing.map((h) => `{% hook '${h}' %}`).join(" ، ")} — مرجع: https://github.com/SallaApp/theme-raed/pull/930 و933 و938`,
                lines: raw.split(/\r?\n/),
            });
        }
    }
}

/** Required components — a recurring rejection reason in the correspondence */
function checkRequiredComponents(themeRoot, issues) {
    // All <salla-*> usages across the whole theme (the component is accepted in any file)
    const twigFiles = walkFiles(themeRoot).filter((p) => p.toLowerCase().endsWith(".twig") && !isUnderPublic(p, themeRoot));
    let allTwig = "";
    for (const f of twigFiles) {
        const raw = readFileIfExists(f);
        if (raw != null) allTwig += stripTwigComments(raw.split(/\r?\n/)).join("\n") + "\n";
    }

    for (const [rel, comps] of Object.entries(REQUIRED_COMPONENTS)) {
        const abs = viewsPath(themeRoot, rel);
        const fileRaw = readFileIfExists(abs);
        for (const comp of comps) {
            if (allTwig.includes("<" + comp)) continue;
            const anchor = fileRaw != null ? abs : path.join(themeRoot, "twilight.json");
            const anchorLines = fileRaw != null ? fileRaw.split(/\r?\n/) : (readFileIfExists(path.join(themeRoot, "twilight.json"))?.split(/\r?\n/) || [""]);
            issues.push({
                type: "Twilight Components",
                file: anchor,
                line: 1,
                desc: `مكوّن مطلوب غير مضاف: <${comp}> — الموضع المتوقع src/views/${rel}${fileRaw == null ? " (الملف غير موجود)" : ""} — راجع ثيم رائد كمرجع`,
                lines: anchorLines,
            });
        }
    }
}

/** Unresolved Git merge conflict markers — an actual rejection reason (found even inside public/) */
function checkMergeConflicts(themeRoot, issues) {
    // Here specifically we walk including public (the email spotted them in public/product-card.js)
    const stack = [themeRoot];
    const files = [];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name === ".git" || e.name === ".svn" || e.name === ".hg" || e.name === ".salla-review" || e.name === ".githooks" || e.name === ".github" || e.name === ".vscode") continue;
                stack.push(p);
            } else if (e.isFile() && /\.(twig|js|ts|jsx|tsx|css|scss|json|html|md|yml|yaml|txt)$/i.test(e.name)) {
                files.push(p);
            }
        }
    }
    for (const f of files) {
        const raw = readFileIfExists(f);
        if (raw == null || !raw.includes("<<<<<<<")) continue;
        const lines = raw.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (/^(<<<<<<< |>>>>>>> )/.test(lines[i])) {
                issues.push({
                    type: "Merge Conflict",
                    file: f,
                    line: i + 1,
                    desc: "علامة تعارض دمج Git لم تتم معالجتها — يجب حل التعارض قبل رفع الثيم",
                    lines,
                });
            }
        }
    }
}

/** Unsafe Twig division by a variable derived from |length — can cause a DivisionByZeroError */
function checkTwigDivision(fileAbs, issues) {
    const raw = readLines(fileAbs);
    const cleaned = stripTwigComments(raw).map(stripTwigInlineComments);
    const src = cleaned.join("\n");

    // Variables derived from |length
    const lenVars = new Set();
    const setRe = /\bset\s+(\w+)\s*=\s*[^\n]*\|\s*length\b/g;
    let m;
    while ((m = setRe.exec(src))) lenVars.add(m[1]);
    if (lenVars.size === 0) return;

    for (let i = 0; i < cleaned.length; i++) {
        const line = cleaned[i];
        for (const v of lenVars) {
            const divRe = new RegExp("/\\s*" + v + "\\b");
            if (!divRe.test(line)) continue;
            // Safe if wrapped in max() or the file checks the variable beforehand
            if (new RegExp("max\\s*\\(\\s*1\\s*,\\s*" + v + "\\b").test(src)) continue;
            if (new RegExp("\\{%-?\\s*if\\s+" + v + "\\b").test(src)) continue;
            issues.push({
                type: "Twig Division",
                file: fileAbs,
                line: i + 1,
                desc: `قسمة غير آمنة على "${v}" المشتق من |length — قد تسبب DivisionByZeroError إذا كانت القائمة فارغة. استخدم max(1, ${v}) أو تحقق شرطي قبل القسمة`,
                lines: raw,
            });
        }
    }
}

/** Theme size — the general theme limit is 1 MB zipped (rough estimate: text/3 + binaries as-is) */
const TEXT_EXT_RE = /\.(twig|js|ts|jsx|tsx|css|scss|json|html|htm|md|txt|svg|map|yml|yaml|lock|xml)$/i;
const THEME_ZIP_LIMIT = 1024 * 1024;

function estimateZipSize(themeRoot, filters) {
    const stack = [themeRoot];
    let text = 0, binary = 0;
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name === ".git" || e.name === ".salla-review" || e.name === ".githooks" || e.name === ".vscode") continue;
                stack.push(p);
            } else if (e.isFile()) {
                if (!isPathSelected(p, themeRoot, filters)) continue;
                let size = 0;
                try { size = fs.statSync(p).size; } catch { continue; }
                if (TEXT_EXT_RE.test(e.name)) text += size;
                else binary += size;
            }
        }
    }
    return { raw: text + binary, estimate: Math.round(text / 3) + binary };
}

/**
 * Theme structure — mirrors Salla's TwilightCI "Theme structure" check:
 * the public/ directory (built assets) must exist and be non-empty in the
 * submitted repository.
 */
function checkThemeStructure(themeRoot, issues) {
    let ok = false;
    try {
        ok = fs.readdirSync(path.join(themeRoot, "public")).length > 0;
    } catch { /* missing */ }
    if (ok) return;
    const tw = path.join(themeRoot, "twilight.json");
    issues.push({
        type: "Theme Structure",
        file: fs.existsSync(tw) ? tw : themeRoot,
        line: 1,
        desc: "مجلد public غير موجود أو فارغ — يجب بناء الأصول (npm run production) وتضمين مجلد public في المستودع قبل رفع طلب النشر",
        lines: readFileIfExists(tw)?.split(/\r?\n/) || [""],
    });
}

function checkThemeSize(themeRoot, issues, filters) {
    const { raw, estimate } = estimateZipSize(themeRoot, filters);
    if (estimate <= THEME_ZIP_LIMIT) return;
    const mb = (n) => (n / 1024 / 1024).toFixed(2);
    const tw = path.join(themeRoot, "twilight.json");
    issues.push({
        type: "Theme Size",
        file: fs.existsSync(tw) ? tw : themeRoot,
        line: 1,
        desc: `حجم الثيم المقدَّر بعد الضغط ~${mb(estimate)} MB (الملفات الخام ${mb(raw)} MB) يتجاوز حد الثيم العام (1 MB) — تقدير تقريبي؛ قلّل الأصول الكبيرة (صور/خطوط) قبل الرفع`,
        lines: readFileIfExists(tw)?.split(/\r?\n/) || [""],
    });
}

/** Vite themes: a missing vite.config prevents the reviewer from running pnpm dev — an actual rejection reason */
function checkViteConfig(themeRoot, issues) {
    const pkgPath = path.join(themeRoot, "package.json");
    const raw = readFileIfExists(pkgPath);
    if (raw == null) return;
    let pkg;
    try { pkg = JSON.parse(raw); } catch { return; }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const usesVite = "vite" in deps || /\bvite\b/.test(String(pkg.scripts && pkg.scripts.dev || ""));
    if (!usesVite) return;
    const hasConfig = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]
        .some((f) => fs.existsSync(path.join(themeRoot, f)));
    if (hasConfig) return;
    const lines = raw.split(/\r?\n/);
    issues.push({
        type: "Vite Config",
        file: pkgPath,
        line: 1,
        desc: "المشروع يستخدم Vite بدون ملف vite.config.ts/js في الجذر — المراجع لا يستطيع تشغيل pnpm dev (سبب رفض فعلي). أضِف الملف وفعّل sallaTransformPlugin/sallaBuildPlugin/sallaDemoPlugin",
        lines,
    });
}

/** salla-products-slider building source-value manually (map/join) — rejected, reference PR 581 */
function checkProductsSliderSource(fileAbs, issues) {
    const raw = readLines(fileAbs);
    const src = stripTwigComments(raw).join("\n");
    let idx = 0;
    while ((idx = src.indexOf("<salla-products-slider", idx)) !== -1) {
        // Quote-aware scan up to the end of the tag
        let j = idx, quote = null;
        while (j < src.length) {
            const ch = src[j];
            if (quote) { if (ch === quote) quote = null; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ">") break;
            j++;
        }
        const tag = src.slice(idx, j + 1);
        if (/source-value/.test(tag) && /\b(map|join)\s*\(/.test(tag)) {
            const line = src.slice(0, idx).split("\n").length;
            issues.push({
                type: "Twilight Components",
                file: fileAbs,
                line,
                desc: "مكوّن salla-products-slider يبني source-value يدوياً عبر map/join — مرّر source وlimit وsource-value (مع json_encode) مباشرة من بيانات القسم ليجلب المكوّن المنتجات عبر الـ API. مرجع: https://github.com/SallaApp/theme-raed/pull/581",
                lines: raw,
            });
        }
        idx = j + 1;
    }
}

/* ============ Component bundle checks (Twilight Bundles) ============ */
// From bundle rejection emails: multilanguage fields without a central language
// resolution function, console.log in production code, unsafeHTML, and a missing
// up-to-date dist/.

function hasMultilanguageFields(obj) {
    if (Array.isArray(obj)) return obj.some(hasMultilanguageFields);
    if (obj && typeof obj === "object") {
        if (obj.multilanguage === true) return true;
        return Object.values(obj).some(hasMultilanguageFields);
    }
    return false;
}

function checkBundle(themeRoot, issues) {
    const bundlePath = path.join(themeRoot, "twilight-bundle.json");
    const bundleRaw = readFileIfExists(bundlePath);
    if (bundleRaw == null) return;
    const bundleLines = bundleRaw.split(/\r?\n/);

    let bundle = null;
    try { bundle = JSON.parse(bundleRaw); } catch { /* broken JSON — covered elsewhere */ }

    const srcFiles = walkFiles(path.join(themeRoot, "src")).filter((p) => /\.(js|ts|jsx|tsx)$/i.test(p));
    const srcJoined = srcFiles.map((p) => readFileIfExists(p) || "").join("\n");

    // 1) multilanguage without a central language resolution function
    if (bundle && hasMultilanguageFields(bundle) && !/\b(localizedString|resolveText)\b/.test(srcJoined)) {
        issues.push({
            type: "Bundle i18n",
            file: bundlePath,
            line: 1,
            desc: "توجد حقول multilanguage: true بدون دالة مركزية لفك اللغة (localizedString/resolveText) — القيم قد تصل ككائن {ar, en} فتظهر [object Object] أو React error #31. أنشئ src/utils/localizedString واستخدمها في كل مواضع العرض بما فيها alt وaria-label والمجموعات المتداخلة",
            lines: bundleLines,
        });
    }

    // 2) console.log in production code
    for (const f of srcFiles) {
        const raw = readLines(f);
        const cleaned = stripJsComments(raw);
        for (let i = 0; i < cleaned.length; i++) {
            if (/\bconsole\.log\s*\(/.test(cleaned[i])) {
                issues.push({
                    type: "Bundle Quality",
                    file: f,
                    line: i + 1,
                    desc: "console.log داخل كود الإنتاج — يجب حذفه قبل الرفع (سبب رفض فعلي للمجموعات)",
                    lines: raw,
                });
                break; // one per file is enough
            }
        }
        // 3) unsafeHTML — HTML injection risk
        const uIdx = cleaned.findIndex((l) => /\bunsafeHTML\b/.test(l));
        if (uIdx !== -1) {
            issues.push({
                type: "Bundle Quality",
                file: f,
                line: uIdx + 1,
                desc: "استخدام unsafeHTML — يسمح بحقن HTML غير آمن؛ استبدله ببناء Lit/JSX آمن (سبب رفض فعلي)",
                lines: raw,
            });
        }
    }

    // 4) dist/ absent or empty
    const distDir = path.join(themeRoot, "dist");
    let distOk = false;
    try { distOk = fs.readdirSync(distDir).length > 0; } catch { /* does not exist */ }
    if (!distOk) {
        issues.push({
            type: "Bundle Quality",
            file: bundlePath,
            line: 1,
            desc: "مجلد dist/ غير موجود أو فارغ — شغّل pnpm run build وضمّن مخرجات البناء المحدّثة مع المصدر (سبب رفض فعلي)",
            lines: bundleLines,
        });
    }
}

/* ==================== Hard-coded colors (HEX + Tailwind) ==================== */

/* ==================== Twig block balance (if/for/macro/…) ==================== */

/** Paired tags in Twig — every opener needs a {% endX %} */
const TWIG_PAIRED_TAGS = new Set([
    "if", "for", "block", "macro", "set", "embed", "filter", "apply",
    "spaceless", "autoescape", "sandbox", "with", "verbatim", "cache", "trans",
]);

/** Extract all {% ... %} tags with their line numbers from a comment-masked source */
function tokenizeTwigTags(masked, lineStarts) {
    const tags = [];
    const re = /\{%-?\s*([a-zA-Z_][a-zA-Z0-9_]*)([\s\S]*?)%\}/g;
    let m;
    while ((m = re.exec(masked))) {
        tags.push({
            word: m[1],
            rest: m[2].replace(/-\s*$/, "").trim(),
            line: lineAtIndex(lineStarts, m.index),
        });
    }
    return tags;
}

/**
 * Twig block balance check: a block opened without a close, a close without an
 * open, or a close that does not match the last opened block (e.g. endfor closing
 * an if). Handles self-closing forms: {% set x = … %} and {% block title expr %},
 * and ignores {% verbatim %} content.
 */
function checkTwigBlocks(fileAbs, issues) {
    const raw = readLines(fileAbs);
    let src = raw.join("\n");
    src = maskRegions(src, /\{#[\s\S]*?#\}/g);
    // verbatim content is literal text — masked together with its tags (an unclosed verbatim will still be caught below)
    src = maskRegions(src, /\{%-?\s*verbatim\s*-?%\}[\s\S]*?\{%-?\s*endverbatim\s*-?%\}/g);
    const lineStarts = buildLineStarts(src);

    const stack = [];
    for (const tag of tokenizeTwigTags(src, lineStarts)) {
        const w = tag.word;

        if (w.startsWith("end")) {
            const base = w.slice(3);
            if (!TWIG_PAIRED_TAGS.has(base)) continue; // unknown tag — don't guess
            if (stack.length === 0) {
                issues.push({
                    type: "Twig Syntax",
                    file: fileAbs,
                    line: tag.line,
                    desc: `{% ${w} %} بدون بلوك {% ${base} %} مفتوح قبله`,
                    lines: raw,
                });
                continue;
            }
            const top = stack[stack.length - 1];
            if (top.word === base) {
                stack.pop();
                continue;
            }
            // Mismatch: is the required opener deeper in the stack?
            const depthIdx = stack.map((f) => f.word).lastIndexOf(base);
            if (depthIdx === -1) {
                issues.push({
                    type: "Twig Syntax",
                    file: fileAbs,
                    line: tag.line,
                    desc: `{% ${w} %} لا يطابق آخر بلوك مفتوح {% ${top.word} %} (سطر ${top.line})`,
                    lines: raw,
                });
                continue; // don't drain the stack — the top opener is still awaiting its close
            }
            // Close it and report everything above it as unclosed blocks
            for (let i = stack.length - 1; i > depthIdx; i--) {
                const f = stack[i];
                issues.push({
                    type: "Twig Syntax",
                    file: fileAbs,
                    line: f.line,
                    desc: `بلوك {% ${f.word} %} غير مغلق — وصل {% ${w} %} (سطر ${tag.line}) قبل {% end${f.word} %}`,
                    lines: raw,
                });
            }
            stack.length = depthIdx;
            continue;
        }

        if (!TWIG_PAIRED_TAGS.has(w)) continue;

        // Self-closing forms do not open a block:
        if (w === "set" && tag.rest.includes("=")) continue;           // {% set x = … %}
        if (w === "block" && tag.rest.split(/\s+/).filter(Boolean).length > 1) continue; // {% block title expr %}

        stack.push({ word: w, line: tag.line });
    }

    for (const f of stack) {
        issues.push({
            type: "Twig Syntax",
            file: fileAbs,
            line: f.line,
            desc: `بلوك {% ${f.word} %} مفتوح ولم يُغلق بـ {% end${f.word} %} حتى نهاية الملف`,
            lines: raw,
        });
    }
}

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const TAILWIND_COLOR_RE =
    /\b(?:bg|text|border|ring|fill|stroke|from|via|to|placeholder|divide|outline|decoration|accent|caret|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/g;

/** A hex inside a var(--x, #fff) fallback is an accepted pattern — not reported */
function isInsideVarFallback(line, idx) {
    const before = line.slice(0, idx);
    const open = before.lastIndexOf("var(");
    if (open === -1) return false;
    return !before.slice(open).includes(")");
}

/**
 * A hex inside a twig expression that provides a default/fallback for a dynamic
 * value is the accepted pattern, not a hardcoded color:
 *   {{ theme.settings.get('id', '#fff') }}
 *   {% set c = x is not empty ? x : '#fff' %}   /   {{ color|default('#fff') }}
 * Masks those hexes so the color scan skips them.
 */
const TWIG_EXPR_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;
const TWIG_FALLBACK_HINT_RE = /\.get\s*\(|\bdefault\s*\(|\?/;
function maskTwigFallbackColors(src) {
    return src.replace(TWIG_EXPR_RE, (expr) =>
        TWIG_FALLBACK_HINT_RE.test(expr)
            ? expr.replace(/#[0-9a-fA-F]{3,8}\b/g, (h) => " ".repeat(h.length))
            : expr
    );
}

/** Hard-coded colors in twig/js/css/scss — colors must come from the theme's settings/variables */
function checkHardcodedColors(fileAbs, kind, issues) {
    const raw = readLines(fileAbs);
    let scanLines;
    if (kind === "twig") {
        // Mask comments and svg (icon colors are not theme colors)
        let src = raw.join("\n");
        src = maskRegions(src, /\{#[\s\S]*?#\}/g);
        src = maskRegions(src, /<svg\b[\s\S]*?<\/svg\s*>/gi);
        src = maskTwigFallbackColors(src);
        scanLines = src.split("\n");
    } else {
        scanLines = stripJsComments(raw);
    }

    for (let i = 0; i < scanLines.length; i++) {
        const line = scanLines[i];
        const found = [];
        let m;
        HEX_COLOR_RE.lastIndex = 0;
        while ((m = HEX_COLOR_RE.exec(line))) {
            if (isInsideVarFallback(line, m.index)) continue;
            found.push(m[0]);
        }
        // Tailwind utilities behind @apply resolve through the tailwind config's
        // palette (which themes point at their CSS variables) — not reported.
        const applyIdx = line.indexOf("@apply");
        TAILWIND_COLOR_RE.lastIndex = 0;
        while ((m = TAILWIND_COLOR_RE.exec(line))) {
            if (applyIdx !== -1 && m.index > applyIdx) continue;
            found.push(m[0]);
        }

        if (!found.length) continue;
        const show = [...new Set(found)].slice(0, 4).join(" ، ");
        issues.push({
            type: "Hardcoded Color",
            file: fileAbs,
            line: i + 1,
            severity: "info", // info, not warning — usually numerous and must not drown everything out
            desc: `لون ثابت (${show}) — استخدم متغيرات ألوان الثيم/إعدادات التاجر بدل الألوان المكتوبة مباشرة`,
            lines: raw,
        });
    }
}

/* ==================== CSS variables: collecting definitions and usages ==================== */

// Prefixes provided by the platform/libraries — using them without a local definition is not an error
const CSS_VAR_PLATFORM_PREFIXES = ["tw-", "swiper-", "salla-", "s-", "color-", "font-", "anim", "mm-"];

function isPlatformCssVar(name) {
    return CSS_VAR_PLATFORM_PREFIXES.some((p) => name.startsWith(p));
}

const CSS_VAR_DEF_RE = /--([A-Za-z0-9_-]+)\s*:/g;
const CSS_VAR_USE_RE = /var\(\s*--([A-Za-z0-9_-]+)\s*([,)])?/g;
const JS_VAR_SET_RE = /setProperty\(\s*['"`]--([A-Za-z0-9_-]+)/g;
const JS_VAR_GET_RE = /getPropertyValue\(\s*['"`]--([A-Za-z0-9_-]+)/g;

/**
 * `--name:` preceded by an identifier char or selector sigil is a BEM-style
 * class/selector name (`.card--title:hover`, `&--modifier:before`,
 * `.--class-name:focus`), not a custom-property definition.
 */
function isSelectorDoubleDash(line, idx) {
    if (idx === 0) return false;
    return /[A-Za-z0-9_.&#$-]/.test(line[idx - 1]);
}

function collectCssVars(scanSrcLines, facts) {
    for (let i = 0; i < scanSrcLines.length; i++) {
        const line = scanSrcLines[i];
        if (!line.includes("--")) continue;
        let m;
        CSS_VAR_USE_RE.lastIndex = 0;
        while ((m = CSS_VAR_USE_RE.exec(line))) {
            if (!facts.cssVarUses.has(m[1])) facts.cssVarUses.set(m[1], i + 1);
            // var(--x, fallback) works without a definition by design — only
            // fallback-less usages count for the "used but undefined" check.
            if (m[2] !== "," && !facts.cssVarBareUses.has(m[1])) facts.cssVarBareUses.set(m[1], i + 1);
        }
        CSS_VAR_DEF_RE.lastIndex = 0;
        while ((m = CSS_VAR_DEF_RE.exec(line))) {
            // Exclude anything inside var( — that is a usage, not a definition (safeguard)
            if (isInsideVarFallback(line, m.index)) continue;
            if (isSelectorDoubleDash(line, m.index)) continue;
            if (!facts.cssVarDefs.has(m[1])) facts.cssVarDefs.set(m[1], i + 1);
        }
        JS_VAR_SET_RE.lastIndex = 0;
        while ((m = JS_VAR_SET_RE.exec(line))) {
            if (!facts.cssVarDefs.has(m[1])) facts.cssVarDefs.set(m[1], i + 1);
        }
        JS_VAR_GET_RE.lastIndex = 0;
        while ((m = JS_VAR_GET_RE.exec(line))) {
            if (!facts.cssVarUses.has(m[1])) facts.cssVarUses.set(m[1], i + 1);
            if (!facts.cssVarBareUses.has(m[1])) facts.cssVarBareUses.set(m[1], i + 1);
        }
    }
}

/* ==================== Path filters (exclude patterns) ==================== */
/**
 * Per-project exclude patterns via opts.exclude:
 *  - "/regex/"           ← a regular expression applied to the relative path (forward slashes /)
 *  - "src/views/**"      ← glob: * does not cross directories, ** does, ? is a single character
 *  - "vendor"            ← a bare name with no / and no wildcards = any directory/file with that name
 * Matching files and folders are never analyzed.
 */
/** Compile one path pattern (folder path / glob / bare name / /regex/). */
function compilePattern(p) {
    p = String(p == null ? "" : p).trim();
    if (!p) return null;
    if (p.length > 2 && p.startsWith("/") && p.endsWith("/")) {
        try { return { re: new RegExp(p.slice(1, -1)) }; } catch { return null; }
    }
    const norm = p.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    if (!/[*?]/.test(norm) && !norm.includes("/")) return { seg: norm };
    const toRe = (g) =>
        "^" + g.split(/(\*\*\/|\*\*|\*|\?)/).map((t) =>
            t === "**/" ? "(?:.*/)?"
            : t === "**" ? ".*"
            : t === "*" ? "[^/]*"
            : t === "?" ? "."
            : t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ).join("") + "(?:/|$)";
    try { return { re: new RegExp(toRe(norm)), literal: !/[*?]/.test(norm) ? norm : null }; } catch { return null; }
}

function compilePathFilters(opts) {
    const compile = (arr) => (Array.isArray(arr) ? arr : []).map(compilePattern).filter(Boolean);
    return { exclude: compile(opts.exclude) };
}

function matchesFilter(rel, f) {
    return f.seg ? rel.split("/").includes(f.seg) : f.re.test(rel);
}

/** Is this path covered by the scan (i.e. not matched by an exclude pattern)? */
function isPathSelected(fileAbs, rootDir, filters) {
    if (!filters) return true;
    const rel = normalizeRel(path.relative(rootDir, fileAbs));
    return !filters.exclude.some((f) => matchesFilter(rel, f));
}

/* ==================== Custom rules (user-defined) ====================
 * Salla adds review rules faster than any extension can ship. A theme can
 * therefore define its own rules in a committed JSON file (default
 * salla-rules.json at the theme root) — the editor, git hooks, and CI all
 * apply them exactly like the built-in checks.
 *
 * Rule shape (all fields optional except id and one of forbid/require):
 *   {
 *     "id": "no-inline-style",           // required, unique, [A-Za-z0-9_.-]
 *     "name": "No inline styles",        // shown in the finding
 *     "message": "Use classes instead",  // shown in the finding
 *     "severity": "error|warning|info",  // default: warning
 *     "files": "src/views/**\/*.twig",    // path pattern; default: every scanned file
 *     "forbid": "style=",                // regex: every match is reported
 *     "require": "<salla-x",             // regex: must be present
 *     "scope": "file|theme",             // require scope; default: file
 *     "ignoreCase": true,                // default: false
 *     "skipComments": false,             // default: true (comments are ignored)
 *     "docs": "https://…"                // link appended to the message
 *   }
 */

const DEFAULT_RULES_FILE = "salla-rules.json";
const VALID_RULE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const RULE_SEVERITIES = new Set(["error", "warning", "info"]);

/**
 * Tolerant JSON: comments and trailing commas are allowed so rules and settings
 * can be documented in place.
 *
 * The scan is string-aware on purpose. A naive regex strip corrupts real values —
 * the glob "src/views/**\/*.twig" contains "/**\/", which a comment regex happily
 * removes, silently turning the pattern into "src/views*.twig".
 */
function stripJsonc(text) {
    const s = String(text);

    // Pass 1: remove comments that are not inside a string
    const noComments = [];
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i], n = s[i + 1];
        if (inStr) {
            noComments.push(c);
            if (c === "\\") { noComments.push(n || ""); i++; }
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; noComments.push(c); continue; }
        if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; noComments.push("\n"); continue; }
        if (c === "/" && n === "*") {
            i += 2;
            while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
            i += 1;
            continue;
        }
        noComments.push(c);
    }

    // Pass 2: drop trailing commas that are not inside a string
    const t = noComments.join("");
    const out = [];
    inStr = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
            out.push(c);
            if (c === "\\") { out.push(t[i + 1] || ""); i++; }
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; out.push(c); continue; }
        if (c === ",") {
            let j = i + 1;
            while (j < t.length && /\s/.test(t[j])) j++;
            if (t[j] === "}" || t[j] === "]") continue;
        }
        out.push(c);
    }
    return out.join("");
}

function parseJsonc(txt) {
    return JSON.parse(stripJsonc(txt));
}

function ruleIssue(file, lines, line, severity, desc, ruleId) {
    return { type: "Custom Rule", file, line, severity, desc, lines, ruleId };
}

/**
 * Read and validate the theme's custom rules.
 * Invalid rules become diagnostics on the rules file itself, so authoring
 * mistakes are visible instead of silently ignored.
 */
function loadCustomRules(themeRoot, opts = {}) {
    const rel = opts.customRulesFile || DEFAULT_RULES_FILE;
    const file = path.join(themeRoot, ...String(rel).split("/"));
    const raw = readFileIfExists(file);
    if (raw == null) return { file, rules: [], issues: [] };

    const lines = raw.split(/\r?\n/);
    const issues = [];
    const lineOf = (needle) => {
        const i = lines.findIndex((l) => l.includes(needle));
        return i === -1 ? 1 : i + 1;
    };

    let doc;
    try {
        doc = parseJsonc(raw);
    } catch (e) {
        issues.push(ruleIssue(file, lines, 1, "error",
            `ملف القواعد المخصصة غير صالح (JSON): ${e.message}`));
        return { file, rules: [], issues };
    }

    const list = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.rules) ? doc.rules : null);
    if (!list) {
        issues.push(ruleIssue(file, lines, 1, "error",
            'ملف القواعد يجب أن يكون مصفوفة قواعد أو كائناً يحتوي المفتاح "rules"'));
        return { file, rules: [], issues };
    }

    const rules = [];
    const seenIds = new Set();
    list.forEach((r, idx) => {
        const at = r && r.id ? lineOf('"' + r.id + '"') : 1;
        const bad = (msg) => issues.push(ruleIssue(file, lines, at, "error", `قاعدة #${idx + 1}: ${msg}`, r && r.id));

        if (!r || typeof r !== "object" || Array.isArray(r)) return bad("يجب أن تكون كائناً");
        if (!r.id || typeof r.id !== "string") return bad('تحتاج المفتاح "id"');
        if (!VALID_RULE_ID_RE.test(r.id)) return bad(`id غير صالح "${r.id}" — المسموح حروف وأرقام و - _ . فقط`);
        if (seenIds.has(r.id)) return bad(`id مكرر "${r.id}"`);
        if (!r.forbid && !r.require) return bad('تحتاج "forbid" أو "require"');
        if (r.severity && !RULE_SEVERITIES.has(r.severity)) {
            return bad(`severity غير صالحة "${r.severity}" — المسموح error أو warning أو info`);
        }

        const flags = "g" + (r.ignoreCase ? "i" : "");
        let forbidRe = null, requireRe = null;
        try { if (r.forbid) forbidRe = new RegExp(r.forbid, flags); }
        catch (e) { return bad(`تعبير "forbid" غير صالح: ${e.message}`); }
        try { if (r.require) requireRe = new RegExp(r.require, flags); }
        catch (e) { return bad(`تعبير "require" غير صالح: ${e.message}`); }

        const filePattern = r.files ? compilePattern(r.files) : null;
        if (r.files && !filePattern) return bad(`نمط "files" غير صالح: ${r.files}`);

        seenIds.add(r.id);
        rules.push({
            id: r.id,
            name: r.name || r.id,
            message: r.message || "",
            severity: RULE_SEVERITIES.has(r.severity) ? r.severity : "warning",
            filePattern,
            literalFile: filePattern && filePattern.literal ? filePattern.literal : null,
            forbidRe,
            requireRe,
            scope: r.scope === "theme" ? "theme" : "file",
            skipComments: r.skipComments !== false,
            docs: typeof r.docs === "string" ? r.docs : "",
            line: at,
        });
    });

    return { file, rules, issues };
}

function ruleMatchesFile(rule, relPath) {
    if (!rule.filePattern) return true;
    return matchesFilter(relPath, rule.filePattern);
}

function ruleMessage(rule, extra) {
    const parts = [`[${rule.id}] ${rule.name}`];
    if (rule.message) parts.push("— " + rule.message);
    if (extra) parts.push("— " + extra);
    if (rule.docs) parts.push("— " + rule.docs);
    return parts.join(" ");
}

/** Text to scan: comments masked (line numbers preserved) unless the rule opts out. */
function ruleScanText(rule, raw, kind) {
    if (!rule.skipComments) return raw.join("\n");
    if (kind === "twig") return maskRegions(raw.join("\n"), /\{#[\s\S]*?#\}/g);
    if (kind === "js" || kind === "css") return stripJsComments(raw).join("\n");
    return raw.join("\n");
}

/**
 * Apply the custom rules to a single file.
 * Returns the ids of theme-scope "require" rules this file satisfies, so the
 * cross-file pass can tell whether any file in the theme satisfied them.
 */
function checkCustomRulesFile(fileAbs, themeRoot, kind, rules, issues) {
    const satisfied = new Set();
    if (!rules || rules.length === 0) return satisfied;
    const rel = normalizeRel(path.relative(themeRoot, fileAbs));
    const applicable = rules.filter((r) => ruleMatchesFile(r, rel));
    if (applicable.length === 0) return satisfied;

    let raw;
    try { raw = readLines(fileAbs); } catch { return satisfied; }

    for (const rule of applicable) {
        const text = ruleScanText(rule, raw, kind);
        const starts = buildLineStarts(text);

        if (rule.forbidRe) {
            rule.forbidRe.lastIndex = 0;
            let m, count = 0;
            while ((m = rule.forbidRe.exec(text))) {
                if (m[0] === "") { rule.forbidRe.lastIndex++; continue; } // guard: zero-length match
                issues.push(ruleIssue(fileAbs, raw, lineAtIndex(starts, m.index), rule.severity,
                    ruleMessage(rule, `المطابقة: "${String(m[0]).slice(0, 60)}"`), rule.id));
                if (++count >= 50) break; // one rule cannot flood a single file
            }
        }

        if (rule.requireRe) {
            rule.requireRe.lastIndex = 0;
            const found = rule.requireRe.test(text);
            if (found) {
                satisfied.add(rule.id);
            } else if (rule.scope === "file") {
                issues.push(ruleIssue(fileAbs, raw, 1, rule.severity,
                    ruleMessage(rule, "النمط المطلوب غير موجود في هذا الملف"), rule.id));
            }
        }
    }
    return satisfied;
}

/**
 * Cross-file part of the custom rules:
 *  - theme-scope "require" rules satisfied by no file at all
 *  - rules targeting a literal path that the per-file pass never sees
 *    (a missing file, or a non-scanned type such as twilight.json)
 */
function checkCustomRulesTheme(themeRoot, rulesInfo, factsByFile, issues) {
    const { file: rulesFile, rules } = rulesInfo;
    if (!rules || rules.length === 0) return;
    const rulesLines = readFileIfExists(rulesFile)?.split(/\r?\n/) || [""];

    const scannedRel = new Set();
    const satisfiedIds = new Set();
    for (const [f, entry] of factsByFile) {
        scannedRel.add(normalizeRel(path.relative(themeRoot, f)));
        for (const id of entry.facts.customRuleHits || []) satisfiedIds.add(id);
    }

    for (const rule of rules) {
        // A literal target the per-file pass never reached (missing file, or a
        // type that is not scanned such as twilight.json / package.json).
        if (rule.literalFile && !scannedRel.has(rule.literalFile)) {
            const abs = path.join(themeRoot, ...rule.literalFile.split("/"));
            const raw = readFileIfExists(abs);
            if (raw == null) {
                if (rule.requireRe) {
                    issues.push(ruleIssue(rulesFile, rulesLines, rule.line, rule.severity,
                        ruleMessage(rule, `الملف المطلوب غير موجود: ${rule.literalFile}`), rule.id));
                }
                continue;
            }
            const lines = raw.split(/\r?\n/);
            const kind = /\.twig$/i.test(abs) ? "twig" : /\.(js|ts|css|scss)$/i.test(abs) ? "js" : "other";
            const text = ruleScanText(rule, lines, kind);
            const starts = buildLineStarts(text);
            if (rule.forbidRe) {
                rule.forbidRe.lastIndex = 0;
                let m, count = 0;
                while ((m = rule.forbidRe.exec(text))) {
                    if (m[0] === "") { rule.forbidRe.lastIndex++; continue; }
                    issues.push(ruleIssue(abs, lines, lineAtIndex(starts, m.index), rule.severity,
                        ruleMessage(rule, `المطابقة: "${String(m[0]).slice(0, 60)}"`), rule.id));
                    if (++count >= 50) break;
                }
            }
            if (rule.requireRe) {
                rule.requireRe.lastIndex = 0;
                if (rule.requireRe.test(text)) satisfiedIds.add(rule.id);
                else if (rule.scope === "file") {
                    issues.push(ruleIssue(abs, lines, 1, rule.severity,
                        ruleMessage(rule, "النمط المطلوب غير موجود في هذا الملف"), rule.id));
                }
            }
        }

        // Theme-scope requirement satisfied by no file anywhere
        if (rule.requireRe && rule.scope === "theme" && !satisfiedIds.has(rule.id)) {
            issues.push(ruleIssue(rulesFile, rulesLines, rule.line, rule.severity,
                ruleMessage(rule, "النمط المطلوب غير موجود في أي ملف من نطاق القاعدة"), rule.id));
        }
    }
}

/* ==================== Facts engine — the foundation of incremental scanning ==================== */
/**
 * Per file: issues scoped to the file itself + "facts" needed by the cross-file
 * checks (CSS variables, used settings, components, hooks…). When a single file
 * is saved, only that file is re-analyzed and then the cross-file checks are
 * rerun from memory — no re-reading of the whole theme.
 */

const SETTINGS_GET_RE = /(?:theme\s*\.\s*)?settings\s*\.\s*get\s*\(\s*['"]([^'"]+)['"]/g;
const COMPONENT_REF_RE = /\b(?:component|c)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;

function collectFileFacts(fileAbs, opts) {
    const lower = fileAbs.toLowerCase();
    const kind = lower.endsWith(".twig") ? "twig"
        : lower.endsWith(".js") ? "js"
        : (lower.endsWith(".css") || lower.endsWith(".scss")) ? "css"
        : "other";

    const issues = [];
    const facts = {
        kind,
        customRuleHits: new Set(), // theme-scope "require" rules satisfied by this file
        settingsUsed: new Map(),   // id -> line
        cssVarDefs: new Map(),     // name -> line
        cssVarUses: new Map(),     // name -> line (any usage, including var(--x, fallback))
        cssVarBareUses: new Map(), // name -> line (usages without a fallback — must be defined)
        sallaComponents: new Set(),
        componentRefs: new Set(),  // component.x / c.x inside twig files
        hooks: new Set(),
    };
    if (kind === "other") return { issues, facts };

    // User-defined rules run alongside the built-in checks
    if (opts.customRules && opts.customRules.length) {
        for (const id of checkCustomRulesFile(fileAbs, opts.projectRoot || path.dirname(fileAbs), kind, opts.customRules, issues)) {
            facts.customRuleHits.add(id);
        }
    }

    let raw;
    try {
        raw = readLines(fileAbs);
    } catch {
        return { issues, facts };
    }
    const joined = raw.join("\n");

    // Merge conflict markers — for all file kinds
    if ((opts.mergeConflicts !== false) && joined.includes("<<<<<<<")) {
        for (let i = 0; i < raw.length; i++) {
            if (/^(<<<<<<< |>>>>>>> )/.test(raw[i])) {
                issues.push({
                    type: "Merge Conflict",
                    file: fileAbs,
                    line: i + 1,
                    desc: "علامة تعارض دمج Git لم تتم معالجتها — يجب حل التعارض قبل رفع الثيم",
                    lines: raw,
                });
            }
        }
    }

    if (kind === "twig") {
        const cleaned = stripTwigComments(raw).map(stripTwigInlineComments);

        if (opts.uiTextCheck !== false) {
            for (const h of extractTwigTexts(raw)) {
                issues.push({ type: "UI hard-coded text", file: fileAbs, line: h.line, visible: h.text, desc: "نص واجهة ثابت", lines: raw });
            }
        }
        if (opts.misleadingUxHeuristic !== false) checkMisleadingUx(fileAbs, issues);
        if (opts.divisionCheck !== false) checkTwigDivision(fileAbs, issues);
        if (opts.twigSyntaxCheck !== false) checkTwigBlocks(fileAbs, issues);
        if (opts.sliderSourceCheck !== false) checkProductsSliderSource(fileAbs, issues);
        if (opts.customCodeCheck !== false) {
            checkCustomCodeFile(fileAbs, issues);
            checkDeveloperPermissionFile(fileAbs, issues);
        }

        const cleanedJoined = cleaned.join("\n");
        let m;
        SETTINGS_GET_RE.lastIndex = 0;
        while ((m = SETTINGS_GET_RE.exec(cleanedJoined))) {
            if (!facts.settingsUsed.has(m[1])) {
                facts.settingsUsed.set(m[1], cleanedJoined.slice(0, m.index).split("\n").length);
            }
        }
        COMPONENT_REF_RE.lastIndex = 0;
        while ((m = COMPONENT_REF_RE.exec(cleanedJoined))) facts.componentRefs.add(m[1]);
        const compRe = /<(salla-[a-z0-9-]+)/gi;
        while ((m = compRe.exec(cleanedJoined))) facts.sallaComponents.add(m[1].toLowerCase());
        for (const h of extractHooksFromTwigSource(joined)) facts.hooks.add(h);
        collectCssVars(cleaned, facts);
        // Custom properties set through inline style="…" attributes are override
        // hooks feeding merchant values into stylesheet defaults — count them as
        // usages too, so the pattern is not reported as an unused variable.
        {
            const styleAttrRe = /style\s*=\s*("[^"]*"|'[^']*')/gi;
            const twigLineStarts = buildLineStarts(cleanedJoined);
            let sm;
            while ((sm = styleAttrRe.exec(cleanedJoined))) {
                const body = sm[1];
                const defRe = /--([A-Za-z0-9_-]+)\s*:/g;
                let dm;
                while ((dm = defRe.exec(body))) {
                    if (isSelectorDoubleDash(body, dm.index)) continue;
                    if (!facts.cssVarUses.has(dm[1])) {
                        facts.cssVarUses.set(dm[1], lineAtIndex(twigLineStarts, sm.index + dm.index));
                    }
                }
            }
        }
        if (opts.colorCheck !== false) checkHardcodedColors(fileAbs, "twig", issues);
    } else if (kind === "js") {
        if (opts.uiTextCheck !== false) {
            for (const h of extractJsUi(raw)) {
                issues.push({ type: "UI hard-coded text", file: fileAbs, line: h.line, visible: h.text, desc: "نص واجهة ثابت", lines: raw });
            }
        }
        checkJsSyntax(fileAbs, issues, opts);
        if (opts.securityCheck !== false) checkJsSecurity(fileAbs, issues);
        if (opts.misleadingUxHeuristic !== false) checkMisleadingUx(fileAbs, issues);

        const cleaned = stripJsComments(raw);
        const cleanedJoined = cleaned.join("\n");
        let m;
        SETTINGS_GET_RE.lastIndex = 0;
        while ((m = SETTINGS_GET_RE.exec(cleanedJoined))) {
            if (!facts.settingsUsed.has(m[1])) {
                facts.settingsUsed.set(m[1], cleanedJoined.slice(0, m.index).split("\n").length);
            }
        }
        collectCssVars(cleaned, facts);
        if (opts.colorCheck !== false) checkHardcodedColors(fileAbs, "js", issues);
    } else if (kind === "css") {
        if (opts.uiTextCheck !== false) {
            for (const h of extractCssContent(raw)) {
                issues.push({ type: "UI hard-coded text", file: fileAbs, line: h.line, visible: h.text, desc: "نص واجهة ثابت داخل content", lines: raw });
            }
        }
        if (opts.cssBracesCheck !== false) checkCssBraces(fileAbs, issues);
        collectCssVars(stripJsComments(raw), facts);
        if (opts.colorCheck !== false) checkHardcodedColors(fileAbs, "css", issues);
    }

    return { issues, facts };
}

/* ==================== twilight.json structural checks ==================== */

const VALID_ID_RE = /^[A-Za-z0-9_.-]+$/;

function collectDefinedSettings(json) {
    // { topLevel: Map(id -> {type, static}), all: Set(all ids, including nested ones) }
    const topLevel = new Map();
    const all = new Set();
    const flat = [];

    function walkFields(arr, depth, ownerLabel) {
        if (!Array.isArray(arr)) return;
        for (const f of arr) {
            if (!f || typeof f !== "object") continue;
            flat.push({ field: f, depth, ownerLabel });
            if (f.id) {
                all.add(String(f.id));
                if (depth === 0) topLevel.set(String(f.id), { type: String(f.type || "").toLowerCase() });
            }
            if (Array.isArray(f.fields)) walkFields(f.fields, depth + 1, f.id || ownerLabel);
        }
    }
    walkFields(json.settings, 0, "settings");
    return { topLevel, all, flat };
}

/**
 * Structural checks for twilight.json (user request):
 *  - every field must have an id, and the id may only use letters/digits and - _ . (no spaces)
 *  - every component's path points to an existing twig file
 *  - ids defined but unused / used but undefined (via theme.settings.get)
 *  - component fields unused inside the component's file (component.x / c.x)
 */
function checkTwilightManifest(themeRoot, factsByFile, issues) {
    const twPath = path.join(themeRoot, "twilight.json");
    const rawStr = readFileIfExists(twPath);
    if (rawStr == null) return;
    let json;
    try {
        json = JSON.parse(rawStr);
    } catch {
        return; // broken JSON — not this check's concern
    }
    const twLines = rawStr.split(/\r?\n/);
    const lineOf = (needle, fallback = 1) => {
        const i = twLines.findIndex((l) => l.includes(needle));
        return i === -1 ? fallback : i + 1;
    };
    const push = (line, desc, severity) =>
        issues.push({ type: "Twilight Manifest", file: twPath, line, desc, lines: twLines, ...(severity ? { severity } : {}) });

    const { topLevel, all, flat } = collectDefinedSettings(json);

    // 1) Every field must have an id + id validity
    for (const { field } of flat) {
        if (!field.id) {
            push(lineOf(`"${field.label || field.format || field.type || ""}"`),
                `حقل بدون id (type: ${field.type || "?"}${field.format ? ", format: " + field.format : ""}) — كل حقل يجب أن يحتوي id`, "error");
        } else if (!VALID_ID_RE.test(String(field.id))) {
            push(lineOf(`"${field.id}"`),
                `id غير صالح: "${field.id}" — المسموح حروف/أرقام و "-" و "_" فقط (بلا مسافات أو رموز)`, "error");
        }
    }
    // Component fields too (id required + validity)
    for (const comp of Array.isArray(json.components) ? json.components : []) {
        const compLabel = (comp.title && (comp.title.en || comp.title.ar)) || comp.key || comp.path || "?";
        const walkComp = (arr, depth) => {
            if (!Array.isArray(arr)) return;
            for (const f of arr) {
                if (!f || typeof f !== "object") continue;
                if (!f.id) {
                    push(lineOf(`"${comp.path || comp.key || ""}"`),
                        `حقل بدون id داخل مكوّن «${compLabel}» (type: ${f.type || "?"})`, "error");
                } else if (!VALID_ID_RE.test(String(f.id))) {
                    push(lineOf(`"${f.id}"`), `id غير صالح داخل مكوّن «${compLabel}»: "${f.id}"`, "error");
                }
                if (Array.isArray(f.fields)) walkComp(f.fields, depth + 1);
            }
        };
        walkComp(comp.fields, 0);
    }

    // 2) The component path must point to an existing file: "home.X" → src/views/components/home/X.twig
    for (const comp of Array.isArray(json.components) ? json.components : []) {
        if (!comp.path) continue;
        const relParts = String(comp.path).split(".");
        const compAbs = path.join(themeRoot, "src", "views", "components", ...relParts) + ".twig";
        if (!fs.existsSync(compAbs)) {
            push(lineOf(`"${comp.path}"`),
                `مسار مكوّن لا يشير لملف موجود: "${comp.path}" — المتوقع src/views/components/${relParts.join("/")}.twig`, "error");
            continue;
        }
        // 3) Component fields unused inside its file (component.x / c.x)
        const compFacts = factsByFile.get(compAbs);
        if (compFacts && Array.isArray(comp.fields)) {
            for (const f of comp.fields) {
                if (!f || !f.id) continue;
                const type = String(f.type || "").toLowerCase();
                if (type === "static" || type === "collection") continue; // separators/descriptions; collections are used via their children
                if (String(f.id).includes(".")) continue; // a collection child
                if (!compFacts.facts.componentRefs.has(String(f.id))) {
                    push(lineOf(`"${f.id}"`),
                        `حقل "${f.id}" معرّف في مكوّن «${(comp.title && (comp.title.ar || comp.title.en)) || comp.path}» وغير مستخدم في ملفه (${relParts.join("/")}.twig)`);
                }
            }
        }
    }

    // 4) Settings: used versus defined (every theme.settings.get in the theme)
    const usedEverywhere = new Map(); // id -> {file, line}
    for (const [file, entry] of factsByFile) {
        for (const [id, line] of entry.facts.settingsUsed) {
            if (!usedEverywhere.has(id)) usedEverywhere.set(id, { file, line });
        }
    }

    // Defined but unused (top-level only, and not static)
    for (const [id, info] of topLevel) {
        if (info.type === "static") continue;
        if (usedEverywhere.has(id)) continue;
        push(lineOf(`"${id}"`), `إعداد معرّف في twilight.json وغير مستخدم في أي ملف: "${id}" — احذفه أو استخدمه`);
    }

    // Used but undefined
    for (const [id, loc] of usedEverywhere) {
        if (all.has(id)) continue;
        const relFile = normalizeRel(path.relative(themeRoot, loc.file));
        let lines;
        try { lines = readLines(loc.file); } catch { lines = [""]; }
        issues.push({
            type: "Twilight Manifest",
            file: loc.file,
            line: loc.line,
            desc: `theme.settings.get('${id}') يستخدم إعداداً غير معرّف في twilight.json (في ${relFile}) — سيرجع فارغاً دائماً`,
            lines,
            severity: "error",
        });
    }
}

/* ==================== CSS variables: the cross-file check ==================== */

function checkCssVariables(themeRoot, factsByFile, issues) {
    const defs = new Map(); // name -> {file, line}
    const uses = new Map(); // name -> {file, line}
    const bareUses = new Map(); // name -> {file, line} — usages without a var() fallback
    for (const [file, entry] of factsByFile) {
        for (const [name, line] of entry.facts.cssVarDefs) {
            if (!defs.has(name)) defs.set(name, { file, line });
        }
        for (const [name, line] of entry.facts.cssVarUses) {
            if (!uses.has(name)) uses.set(name, { file, line });
        }
        for (const [name, line] of entry.facts.cssVarBareUses || []) {
            if (!bareUses.has(name)) bareUses.set(name, { file, line });
        }
    }

    const pushAt = (loc, desc) => {
        let lines;
        try { lines = readLines(loc.file); } catch { lines = [""]; }
        issues.push({ type: "CSS Variables", file: loc.file, line: loc.line, desc, lines });
    };

    // Defined but unused — a definition in any file (master, component, or css) counts
    for (const [name, loc] of defs) {
        if (uses.has(name)) continue;
        if (isPlatformCssVar(name)) continue; // may be consumed by the platform/tailwind.config
        pushAt(loc, `متغير CSS معرّف وغير مستخدم: --${name} — احذفه أو استخدمه`);
    }

    // Used but undefined — with the platform/library variables exempted.
    // var(--x, fallback) usages are excluded: the fallback covers the undefined case by design.
    for (const [name, loc] of bareUses) {
        if (defs.has(name)) continue;
        if (isPlatformCssVar(name)) continue;
        pushAt(loc, `متغير CSS مستخدم وغير معرّف في أي ملف: var(--${name}) — عرّفه أو صحّح الاسم`);
    }
}

/* ==================== Cross-file checks (from the facts) ==================== */

/** Required hooks — a version that works from the facts without re-reading */
function checkRequiredHooksFromFacts(themeRoot, factsByFile, issues, filters) {
    for (const [rel, hooks] of Object.entries(REQUIRED_HOOKS)) {
        const abs = viewsPath(themeRoot, rel);
        const entry = factsByFile.get(abs);
        if (!entry) {
            // The file exists but is excluded by the patterns → the user chose to ignore it
            if (fs.existsSync(abs) && !isPathSelected(abs, themeRoot, filters)) continue;
            const tw = path.join(themeRoot, "twilight.json");
            issues.push({
                type: "Twilight Hooks",
                file: tw,
                line: 1,
                desc: `الملف src/views/${rel} غير موجود، وهو مطلوب ويجب أن يحتوي الهوكس: ${hooks.join("، ")} — مرجع: PRs رائد 930/933/938`,
                lines: readFileIfExists(tw)?.split(/\r?\n/) || [""],
            });
            continue;
        }
        const missing = hooks.filter((h) => !entry.facts.hooks.has(h));
        if (missing.length) {
            let lines;
            try { lines = readLines(abs); } catch { lines = [""]; }
            issues.push({
                type: "Twilight Hooks",
                file: abs,
                line: 1,
                desc: `هوكس مطلوبة غير مضافة في src/views/${rel}: ${missing.map((h) => `{% hook '${h}' %}`).join(" ، ")} — مرجع: https://github.com/SallaApp/theme-raed/pull/930 و933 و938`,
                lines,
            });
        }
    }
}

/** Required components — from the union of file facts */
function checkRequiredComponentsFromFacts(themeRoot, factsByFile, issues) {
    const allComponents = new Set();
    for (const [, entry] of factsByFile) {
        for (const c of entry.facts.sallaComponents) allComponents.add(c);
    }
    for (const [rel, comps] of Object.entries(REQUIRED_COMPONENTS)) {
        const abs = viewsPath(themeRoot, rel);
        const exists = factsByFile.has(abs);
        for (const comp of comps) {
            if (allComponents.has(comp)) continue;
            const anchor = exists ? abs : path.join(themeRoot, "twilight.json");
            let lines;
            try { lines = readLines(anchor); } catch { lines = [""]; }
            issues.push({
                type: "Twilight Components",
                file: anchor,
                line: 1,
                desc: `مكوّن مطلوب غير مضاف: <${comp}> — الموضع المتوقع src/views/${rel}${exists ? "" : " (الملف غير موجود)"} — راجع ثيم رائد كمرجع`,
                lines,
            });
        }
    }
}

/** Conflict markers inside public/ only (the other files are checked within their facts) */
function scanPublicConflicts(themeRoot, filters) {
    const issues = [];
    const pub = path.join(themeRoot, "public");
    if (!fs.existsSync(pub)) return issues;
    const stack = [pub];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.isFile() && /\.(js|ts|css|json|html|md|txt)$/i.test(e.name)) {
                let stat;
                try { stat = fs.statSync(p); } catch { continue; }
                if (stat.size > 3 * 1024 * 1024) continue; // huge built files — skip
                if (!isPathSelected(p, themeRoot, filters)) continue;
                const raw = readFileIfExists(p);
                if (raw == null || !raw.includes("<<<<<<<")) continue;
                const lines = raw.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (/^(<<<<<<< |>>>>>>> )/.test(lines[i])) {
                        issues.push({
                            type: "Merge Conflict",
                            file: p,
                            line: i + 1,
                            desc: "علامة تعارض دمج Git لم تتم معالجتها — يجب حل التعارض قبل رفع الثيم",
                            lines,
                        });
                    }
                }
            }
        }
    }
    return issues;
}

function runCrossChecks(projectRoot, factsByFile, opts, cachedSizeIssues, filters) {
    const issues = [];
    const isClassicTheme = fs.existsSync(path.join(projectRoot, "twilight.json"));

    if (isClassicTheme) {
        if (opts.scopesCheck !== false) checkScopes(projectRoot, issues);
        if (opts.customCodeCheck !== false) checkTwilightJson(projectRoot, issues);
        if (opts.twilightManifestCheck !== false) checkTwilightManifest(projectRoot, factsByFile, issues);
        if (opts.requiredHooks !== false) checkRequiredHooksFromFacts(projectRoot, factsByFile, issues, filters);
        if (opts.requiredComponents !== false) checkRequiredComponentsFromFacts(projectRoot, factsByFile, issues);
        if (opts.structureCheck !== false) checkThemeStructure(projectRoot, issues);
        if (opts.sizeCheck !== false) {
            // A stat walk over all files (including public) — computed during the full
            // scan and reused in the incremental update (size doesn't change materially with one save)
            if (cachedSizeIssues) issues.push(...cachedSizeIssues);
            else checkThemeSize(projectRoot, issues);
        }
    }
    // Bundle-only checks — do not apply to classic themes
    const isBundleProject = fs.existsSync(path.join(projectRoot, "twilight-bundle.json"));
    if (isBundleProject) {
        if (opts.viteCheck !== false) checkViteConfig(projectRoot, issues);
        if (opts.bundleCheck !== false) checkBundle(projectRoot, issues);
    }
    if (opts.cssVarCheck !== false) checkCssVariables(projectRoot, factsByFile, issues);
    if (opts.rulesInfo) {
        issues.push(...opts.rulesInfo.issues); // authoring errors in the rules file
        checkCustomRulesTheme(projectRoot, opts.rulesInfo, factsByFile, issues);
    }
    return issues;
}

/* ==================== Theme state (for incremental scanning in the extension) ==================== */

function createThemeState(rootDir, opts = {}) {
    const projectRoot = findThemeProjectRoot(rootDir);
    // Custom rules are read once per scan and shared with every per-file pass
    const rulesInfo = opts.customRuleCheck === false
        ? { file: null, rules: [], issues: [] }
        : loadCustomRules(projectRoot, opts);
    opts = { ...opts, projectRoot, rulesInfo, customRules: rulesInfo.rules };
    const state = {
        projectRoot,
        opts,
        filters: compilePathFilters(opts),
        factsByFile: new Map(), // abs -> {issues, facts}
        publicConflictIssues: [],
        crossIssues: [],
    };
    fullScanState(state);
    return state;
}

function fullScanState(state) {
    setIgnoredUiTexts(state.opts.ignoredTexts || []);
    state.factsByFile.clear();
    const files = walkFiles(state.projectRoot).filter(
        (p) => isReviewable(p, state.projectRoot) && isPathSelected(p, state.projectRoot, state.filters)
    );
    for (const f of files) {
        state.factsByFile.set(f, collectFileFacts(f, state.opts));
    }
    state.publicConflictIssues = state.opts.mergeConflicts !== false
        ? scanPublicConflicts(state.projectRoot, state.filters)
        : [];
    state.sizeIssues = [];
    if (state.opts.sizeCheck !== false && fs.existsSync(path.join(state.projectRoot, "twilight.json"))) {
        checkThemeSize(state.projectRoot, state.sizeIssues, state.filters);
    }
    state.crossIssues = runCrossChecks(state.projectRoot, state.factsByFile, state.opts, state.sizeIssues, state.filters);
}

/**
 * Update a single file within the state (on save): only the file is re-analyzed,
 * then the cross-file checks run from memory — instead of rescanning the whole theme.
 */
/** Is the file inside a directory the engine never scans (tooling, VCS, deps)? */
function isInSkippedDir(fileAbs, baseDir) {
    return path
        .relative(baseDir, fileAbs)
        .split(path.sep)
        .some((seg) => SKIP_DIRS.has(seg));
}

function refreshFileInState(state, fileAbs) {
    setIgnoredUiTexts(state.opts.ignoredTexts || []);

    // Editing the rules file changes every file's outcome — rescan the theme
    if (state.opts.rulesInfo && state.opts.rulesInfo.file &&
        path.resolve(fileAbs) === path.resolve(state.opts.rulesInfo.file)) {
        const fresh = state.opts.customRuleCheck === false
            ? { file: state.opts.rulesInfo.file, rules: [], issues: [] }
            : loadCustomRules(state.projectRoot, state.opts);
        state.opts = { ...state.opts, rulesInfo: fresh, customRules: fresh.rules };
        fullScanState(state);
        return;
    }
    const underPublic = isUnderPublic(fileAbs, state.projectRoot);

    // Files in always-skipped directories (.salla-review, .githooks, node_modules, …)
    // must never be analyzed — the full-scan walk skips them, and the incremental
    // save path must agree, otherwise saving the vendored engine flags its own code
    // (e.g. its npm-registry fetch as a "Security" finding).
    // public/ is special-cased below (conflict markers only), so exempt it here.
    if (!underPublic && isInSkippedDir(fileAbs, state.projectRoot)) {
        state.factsByFile.delete(fileAbs);
        state.publicConflictIssues = state.publicConflictIssues.filter((i) => i.file !== fileAbs);
        state.crossIssues = runCrossChecks(state.projectRoot, state.factsByFile, state.opts, state.sizeIssues, state.filters);
        return;
    }

    // A file excluded by the patterns: remove any prior trace of it and rerun only the cross-file checks
    if (!isPathSelected(fileAbs, state.projectRoot, state.filters)) {
        state.factsByFile.delete(fileAbs);
        state.publicConflictIssues = state.publicConflictIssues.filter((i) => i.file !== fileAbs);
        state.crossIssues = runCrossChecks(state.projectRoot, state.factsByFile, state.opts, state.sizeIssues, state.filters);
        return;
    }

    if (underPublic) {
        if (state.opts.mergeConflicts !== false) {
            state.publicConflictIssues = state.publicConflictIssues.filter((i) => i.file !== fileAbs);
            const raw = readFileIfExists(fileAbs);
            if (raw != null && raw.includes("<<<<<<<")) {
                const lines = raw.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (/^(<<<<<<< |>>>>>>> )/.test(lines[i])) {
                        state.publicConflictIssues.push({
                            type: "Merge Conflict", file: fileAbs, line: i + 1,
                            desc: "علامة تعارض دمج Git لم تتم معالجتها — يجب حل التعارض قبل رفع الثيم",
                            lines,
                        });
                    }
                }
            }
        }
    } else if (fs.existsSync(fileAbs)) {
        if (isReviewable(fileAbs, state.projectRoot)) {
            state.factsByFile.set(fileAbs, collectFileFacts(fileAbs, state.opts));
        }
        // twilight.json / package.json and the like: no facts, but the cross-file checks will pick them up
    } else {
        state.factsByFile.delete(fileAbs);
    }

    state.crossIssues = runCrossChecks(state.projectRoot, state.factsByFile, state.opts, state.sizeIssues, state.filters);
}

function dedupeIssues(issues) {
    const seen = new Set();
    return issues.filter((i) => {
        const k = `${i.type}|${i.file}|${i.line}|${i.desc || ""}|${i.visible || ""}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function stateIssues(state) {
    const all = [];
    for (const [, entry] of state.factsByFile) all.push(...entry.issues);
    all.push(...state.publicConflictIssues);
    all.push(...state.crossIssues);
    return dedupeIssues(all);
}

/* ==================== Main analysis ==================== */

/**
 * Analyze a single theme.
 * @param {string} rootDir the theme folder (or a folder containing the theme nested inside)
 * @param {object} opts { ignoredTexts?: string[], nodeSyntaxCheck?: boolean, raedParity?: boolean, misleadingUxHeuristic?: boolean }
 * @returns {{ projectRoot: string, issues: Array, parityLines: string[] | null }}
 */
function analyzeTheme(rootDir, opts = {}) {
    const state = createThemeState(rootDir, opts);
    const issues = stateIssues(state);
    const parityLines = opts.raedParity === false ? null : compareWithRaed(state.projectRoot);
    return { projectRoot: state.projectRoot, issues, parityLines };
}

/* ==================== Report generation (matching the original tool) ==================== */

function snippet(lines, line) {
    const before = Math.max(1, line - 1);
    const after = Math.min(lines.length, line + 1);
    const out = [];
    for (let i = before; i <= after; i++) {
        out.push(`  - ${i === line ? "👉 " : ""}${i}: ${lines[i - 1]}`);
    }
    return out.join("\n");
}

/**
 * Generate a Markdown report in the same format as the reference reports/<slug>-report.md.
 * @param {string} slug the theme name
 * @param {Array} issues the analyzeTheme results
 * @param {string[] | null} parityLines the Raed parity section
 * @param {string} displayBase paths in the report are relative to this folder
 */
/** Display order of types in the report: most severe first */
const TYPE_ORDER = [
    "salla-scopes",
    "Custom Code",
    "Merge Conflict",
    "Misleading UX (Social Proof/Urgency)",
    "Twilight Version",
    "Twilight Hooks",
    "Theme Structure",
    "Twilight Components",
    "Security",
    "Twig Syntax",
    "JS Syntax",
    "CSS/SCSS",
    "Twig Division",
    "Bundle i18n",
    "Bundle Quality",
    "Vite Config",
    "Theme Size",
    "Twilight Manifest",
    "Custom Rule",
    "CSS Variables",
    "Hardcoded Color",
    "UI hard-coded text",
];

function typeRank(t) {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
}

function buildReportMarkdown(slug, issues, parityLines, displayBase) {
    const sorted = [...issues].sort(
        (a, b) =>
            typeRank(a.type) - typeRank(b.type) ||
            String(a.file).localeCompare(String(b.file)) ||
            a.line - b.line
    );

    // Summary at the top of the report — so it doesn't look "empty" as if the scan had stopped
    const counts = new Map();
    for (const i of sorted) counts.set(i.type, (counts.get(i.type) || 0) + 1);

    const summary = ["### ملخص النتائج", ""];
    if (sorted.length === 0) {
        summary.push("✅ **لم يتم العثور على أي مخالفة.** تم فحص جميع القواعد (0–5.2) بالكامل.", "");
    } else {
        summary.push(
            `**الإجمالي: ${sorted.length} مخالفة** في ${new Set(sorted.map((i) => i.file)).size} ملف.`,
            "",
            "| النوع | العدد | الشدة |",
            "|---|---|---|"
        );
        for (const t of TYPE_ORDER) {
            if (!counts.has(t)) continue;
            summary.push(`| ${t} | ${counts.get(t)} | ${ERROR_TYPES.has(t) ? "🔴 رفض" : "🟡 تنبيه"} |`);
        }
        for (const [t, n] of counts) {
            if (TYPE_ORDER.includes(t)) continue;
            summary.push(`| ${t} | ${n} | ${ERROR_TYPES.has(t) ? "🔴 رفض" : "🟡 تنبيه"} |`);
        }
        summary.push("");
    }

    // Details grouped by type (instead of repeating the heading for every violation)
    const sections = [];
    let currentType = null;
    let idxInType = 0;
    for (const issue of sorted) {
        if (issue.type !== currentType) {
            currentType = issue.type;
            idxInType = 0;
            sections.push(`### ${currentType} (${counts.get(currentType)})`, "");
        }
        idxInType++;
        const fileRel = normalizeRel(path.relative(displayBase, issue.file));
        sections.push(
            `**${idxInType}.**`,
            `- **الملف:** \`${fileRel}\``,
            `- **السطر:** ${issue.line}`,
            ...(issue.visible ? [`- **النص المرئي:** "${issue.visible}"`] : []),
            ...(issue.desc ? [`- **المشكلة:** ${issue.desc}`] : []),
            `- **المقطع المحيط:**\n${snippet(issue.lines, issue.line)}`,
            ""
        );
    }

    const featuresBlock = parityLines
        ? ["## ميزات يحتاج الثيم إلى دعمها", "", ...parityLines, ""].join("\n")
        : "";

    return [`## ${slug}`, "", ...summary, ...sections, featuresBlock].join("\n");
}

/** Extract hook names {% hook '...' %} from Twig source (for building the Raed manifest) */
function extractHooksFromTwigSource(src) {
    const cleaned = stripTwigComments(String(src).split(/\r?\n/)).join("\n");
    const re = /\{%-?\s*hook\s+['"]([^'"]+)['"]/g;
    const set = new Set();
    let m;
    while ((m = re.exec(cleaned))) set.add(m[1]);
    return [...set].sort();
}

/** Effective severity of an issue: explicit override first, then the type default. */
function issueSeverity(issue) {
    if (issue.severity === "error" || issue.severity === "warning" || issue.severity === "info") {
        return issue.severity;
    }
    return ERROR_TYPES.has(issue.type) ? "error" : "warning";
}

module.exports = {
    SKIP_DIRS,
    DEFAULT_RULES_FILE,
    parseJsonc,
    loadCustomRules,
    analyzeTheme,
    createThemeState,
    refreshFileInState,
    stateIssues,
    compilePathFilters,
    isPathSelected,
    buildReportMarkdown,
    findThemeProjectRoot,
    findThemeRoots,
    compareWithRaed,
    snippet,
    ERROR_TYPES,
    issueSeverity,
    REQUIRED_HOOKS,
    REQUIRED_COMPONENTS,
    setRaedManifestPath,
    extractHooksFromTwigSource,
    estimateZipSize,
    // Exported for the raed-manifest.json generation script
    extractSallaComponentNamesFromTwigSource,
    extractSallaApiTokensFromJsSource,
    extractWatchElementsKeysFromJs,
    isExcludedRaedTwigRel,
    isExcludedRaedJsRel,
    normalizeRel,
};
