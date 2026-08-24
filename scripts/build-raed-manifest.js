"use strict";
/**
 * Generates lib/raed-manifest.json from the reference Raed theme folder.
 * Usage:  node scripts/build-raed-manifest.js [path to the Raed folder]
 * Default: ../THEME-Raed-basic (relative to the extension folder)
 */
const fs = require("fs");
const path = require("path");
const core = require("../lib/salla-review-core.js");

const raedDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "THEME-Raed-basic"));
const outFile = path.join(__dirname, "..", "lib", "raed-manifest.json");

if (!fs.existsSync(path.join(raedDir, "twilight.json"))) {
    console.error(`❌ مجلد رائد غير صالح (لا يحتوي twilight.json): ${raedDir}`);
    process.exit(1);
}

function walkFilesRelRecursive(baseRoot, subPath, extLower) {
    const dir = path.join(baseRoot, subPath);
    const out = [];
    const stack = [dir];
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
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile() && e.name.toLowerCase().endsWith(extLower)) {
                out.push({ abs: p, rel: core.normalizeRel(path.relative(baseRoot, p)) });
            }
        }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const manifest = { source: "THEME-Raed-basic", twig: {}, js: {} };

let raedVersion = null;
try {
    raedVersion = JSON.parse(fs.readFileSync(path.join(raedDir, "package.json"), "utf8")).version || null;
} catch { /* optional */ }
if (raedVersion) manifest.raedVersion = raedVersion;

const twigList = walkFilesRelRecursive(raedDir, "src/views", ".twig").filter((f) => !core.isExcludedRaedTwigRel(f.rel));
for (const { abs, rel } of twigList) {
    const src = fs.readFileSync(abs, "utf8");
    manifest.twig[rel] = core.extractSallaComponentNamesFromTwigSource(src);
}

const jsList = walkFilesRelRecursive(raedDir, "src/assets/js", ".js").filter((f) => !core.isExcludedRaedJsRel(f.rel));
for (const { abs, rel } of jsList) {
    const src = fs.readFileSync(abs, "utf8");
    manifest.js[rel] = {
        watch: core.extractWatchElementsKeysFromJs(src),
        salla: core.extractSallaApiTokensFromJsSource(src),
    };
}

fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2), "utf8");
console.log(`✅ تم توليد ${outFile}`);
console.log(`   twig files: ${Object.keys(manifest.twig).length}, js files: ${Object.keys(manifest.js).length}${raedVersion ? `, raed v${raedVersion}` : ""}`);
