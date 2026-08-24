"use strict";
/**
 * Update lib/raed-manifest.json from GitHub (SallaApp/theme-raed HEAD).
 * Usage:  node scripts/update-raed-from-github.js
 */
const path = require("path");
const { updateRaedManifest } = require("../lib/raed-updater.js");

const outFile = path.join(__dirname, "..", "lib", "raed-manifest.json");

updateRaedManifest(outFile, {
    onProgress: (done, total) => process.stdout.write(`\r  جلب الملفات: ${done}/${total}   `),
})
    .then((r) => {
        console.log(`\n✅ تم التحديث من رائد${r.raedVersion ? ` v${r.raedVersion}` : ""} (commit ${r.sha.slice(0, 10)})`);
        console.log(`   twig: ${r.twigCount} ملف، js: ${r.jsCount} ملف → ${outFile}`);
    })
    .catch((e) => {
        console.error(`\n❌ فشل التحديث: ${e.message}`);
        process.exit(1);
    });
