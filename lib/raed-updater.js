"use strict";
/**
 * Update the Raed reference directly from GitHub (SallaApp/theme-raed).
 *
 * Raed is updated continuously (Salla's emails always point to the latest PRs),
 * so raed-manifest.json is rebuilt from the current HEAD: <salla-*> components
 * for each Twig file, salla.* tokens and watchElements keys for each JS file,
 * plus the {% hook %} hooks for each file.
 *
 * No unzipping needed: it reads the file tree via the GitHub API and then
 * fetches only the required files (about 70) from raw.githubusercontent.com.
 */
const fs = require("fs");
const path = require("path");
const core = require("./salla-review-core.js");

const REPO = "SallaApp/theme-raed";
const API_HEADERS = {
    Accept: "application/vnd.github+json",
    "User-Agent": "salla-theme-reviewer",
};

async function getJson(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
}

async function getText(url) {
    const res = await fetch(url, { headers: { "User-Agent": API_HEADERS["User-Agent"] } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.text();
}

/** Latest commit on the default branch */
async function getLatestSha() {
    const j = await getJson(`https://api.github.com/repos/${REPO}/commits/HEAD`, API_HEADERS);
    return j.sha;
}

/**
 * Build a new manifest from GitHub and write it to outFile.
 * @returns {Promise<{sha: string, twigCount: number, jsCount: number, raedVersion: string|null}>}
 */
async function updateRaedManifest(outFile, opts = {}) {
    if (typeof fetch !== "function") throw new Error("fetch غير متوفر في هذه البيئة");
    const sha = opts.sha || (await getLatestSha());

    const tree = await getJson(
        `https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`,
        API_HEADERS
    );
    if (tree.truncated) {
        // Theoretical safeguard — Raed's tree is far smaller than the truncation limit
        throw new Error("شجرة الريبو مقتطعة — لا يمكن بناء manifest كامل");
    }

    const paths = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
    const twigRels = paths
        .filter((p) => p.startsWith("src/views/") && p.endsWith(".twig"))
        .filter((p) => !core.isExcludedRaedTwigRel(p))
        .sort();
    const jsRels = paths
        .filter((p) => p.startsWith("src/assets/js/") && p.endsWith(".js"))
        .filter((p) => !core.isExcludedRaedJsRel(p))
        .sort();

    const raw = (rel) => getText(`https://raw.githubusercontent.com/${REPO}/${sha}/${rel}`);

    const manifest = { source: `github:${REPO}`, commit: sha, twig: {}, js: {}, hooks: {} };

    let raedVersion = null;
    try {
        raedVersion = JSON.parse(await raw("package.json")).version || null;
    } catch { /* optional */ }
    if (raedVersion) manifest.raedVersion = raedVersion;

    // Parallel fetching in batches so we don't flood the network
    async function inBatches(rels, fn, batch = 10) {
        for (let i = 0; i < rels.length; i += batch) {
            await Promise.all(rels.slice(i, i + batch).map(fn));
            if (opts.onProgress) opts.onProgress(Math.min(i + batch, rels.length), rels.length);
        }
    }

    await inBatches(twigRels, async (rel) => {
        const src = await raw(rel);
        manifest.twig[rel] = core.extractSallaComponentNamesFromTwigSource(src);
        const hooks = core.extractHooksFromTwigSource(src);
        if (hooks.length) manifest.hooks[rel] = hooks;
    });

    await inBatches(jsRels, async (rel) => {
        const src = await raw(rel);
        manifest.js[rel] = {
            watch: core.extractWatchElementsKeysFromJs(src),
            salla: core.extractSallaApiTokensFromJsSource(src),
        };
    });

    // Stable key order (parallel extraction does not guarantee ordering)
    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    manifest.twig = sortObj(manifest.twig);
    manifest.js = sortObj(manifest.js);
    manifest.hooks = sortObj(manifest.hooks);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2), "utf8");

    return { sha, twigCount: twigRels.length, jsCount: jsRels.length, raedVersion };
}

module.exports = { updateRaedManifest, getLatestSha, REPO };
