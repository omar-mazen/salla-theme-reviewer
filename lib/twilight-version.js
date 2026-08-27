"use strict";
/**
 * Check Twilight package versions against the npm registry.
 *
 * Salla's rule (from rejection emails, ~22 messages): the allowed limit is being
 * at most five versions behind the latest. The gap is counted as the number of
 * published versions between them (the way Salla counts it: "الفارق: 137 إصدارات"),
 * not as a semver number difference.
 *
 * Requires network; results are cached (6 hours) and the check is silently
 * skipped when offline.
 */
const fs = require("fs");
const path = require("path");

const MAX_VERSIONS_BEHIND = 5;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const PACKAGES = [
    "@salla.sa/twilight",
    "@salla.sa/twilight-components",
    "@salla.sa/twilight-tailwind-theme",
];

async function fetchVersionList(pkg) {
    // The abbreviated format is much smaller than the full document
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
        headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) throw new Error(`npm registry ${res.status}`);
    const json = await res.json();
    // Key order in the registry matches publish order
    return Object.keys(json.versions || {});
}

function readCache(cacheFile) {
    try {
        const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (Date.now() - c.fetchedAt < CACHE_TTL_MS) return c.data;
    } catch { /* no cache */ }
    return null;
}

function writeCache(cacheFile, data) {
    try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), data }), "utf8");
    } catch { /* the cache is optional */ }
}

/** All version lists for the three packages — from the cache or the network */
async function getVersionLists(cacheFile) {
    const cached = cacheFile && readCache(cacheFile);
    if (cached) return cached;
    const data = {};
    for (const pkg of PACKAGES) {
        data[pkg] = await fetchVersionList(pkg);
    }
    if (cacheFile) writeCache(cacheFile, data);
    return data;
}

function cleanVersion(v) {
    return String(v || "").replace(/^[~^>=<\s]+/, "").trim();
}

function findDepLine(pkgLines, pkgName) {
    const idx = pkgLines.findIndex((l) => l.includes(`"${pkgName}"`));
    return idx === -1 ? 1 : idx + 1;
}

/**
 * Twilight versions check for a project.
 * @returns {Promise<Array>} an array of issues with the same shape as analyzeTheme issues
 */
async function checkTwilightVersions(projectRoot, opts = {}) {
    const issues = [];
    if (typeof fetch !== "function") return issues; // environment without fetch

    const pkgPath = path.join(projectRoot, "package.json");
    let pkgRaw;
    if (opts.pkgRaw != null) {
        pkgRaw = String(opts.pkgRaw); // live editor buffer (may be ahead of disk)
    } else {
        try {
            pkgRaw = fs.readFileSync(pkgPath, "utf8");
        } catch {
            return issues; // no package.json — nothing to check
        }
    }
    let pkg;
    try {
        pkg = JSON.parse(pkgRaw);
    } catch {
        return issues;
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const used = PACKAGES.filter((p) => p in deps);
    if (used.length === 0) return issues;

    let lists;
    try {
        lists = await getVersionLists(opts.cacheFile);
    } catch {
        return issues; // no network — skip silently
    }

    const pkgLines = pkgRaw.split(/\r?\n/);
    for (const name of used) {
        const versions = lists[name] || [];
        if (!versions.length) continue;
        const latest = versions[versions.length - 1];
        const current = cleanVersion(deps[name]);
        const idx = versions.indexOf(current);
        if (idx === -1) continue; // unknown version (workspace:*, git, etc.) — don't guess
        const behind = versions.length - 1 - idx;
        if (behind <= MAX_VERSIONS_BEHIND) continue;
        issues.push({
            type: "Twilight Version",
            file: pkgPath,
            line: findDepLine(pkgLines, name),
            desc: `إصدار ${name} قديم: الحالي ${current} والأحدث ${latest} — الفارق ${behind} إصدارًا ويتجاوز الحد المسموح (${MAX_VERSIONS_BEHIND} إصدارات). حدّث ثم نفّذ npm run prod وارفع الأصول`,
            lines: pkgLines,
        });
    }
    return issues;
}

module.exports = { checkTwilightVersions, PACKAGES, MAX_VERSIONS_BEHIND };
