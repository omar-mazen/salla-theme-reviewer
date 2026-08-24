"use strict";
/**
 * Regression test for the engine:
 *  1) A theme seeded with a violation of every rule → all must be detected with the expected counts.
 *  2) The "gaps" theme → cases the original version used to miss (multi-line texts,
 *     markup inside JS, extra sinks, repeated salla-scopes, multiple URLs…).
 *  3) The reference Raed theme → zero issues (no false positives).
 * Run:  node test/run.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const core = require("../lib/salla-review-core.js");

let failures = 0;
function assert(cond, label) {
    if (cond) {
        console.log(`  ✅ ${label}`);
    } else {
        failures++;
        console.error(`  ❌ ${label}`);
    }
}

function makeTheme(files) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "salla-review-test-"));
    const theme = path.join(tmp, "t");
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(theme, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
    }
    return { theme, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function countByType(issues) {
    const c = {};
    for (const i of issues) c[i.type] = (c[i.type] || 0) + 1;
    return c;
}

/* ==================== 1) A violation of every rule ==================== */

console.log("1) الثيم المزروع بالمخالفات:");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": JSON.stringify({
            name: "bad-theme",
            settings: [
                { id: "primary_color", label: "Primary Color", type: "color" },
                { id: "custom_js_code", label: "Custom JS Code", type: "string", format: "textarea" },
            ],
        }, null, 2),

        "src/views/layouts/master.twig": `<html>
<body>
{% block content %}{% endblock %}
{% if store.scope %}
    <salla-scopes selection="optional"></salla-scopes>
{% endif %}
</body>
</html>`,

        "src/views/components/header/header.twig": `<header>
    <salla-scopes selection="optional"></salla-scopes>
    <h1>{{ store.name }}</h1>
</header>`,

        "src/views/pages/test.twig": `<div class="box">
    <p>Welcome to our amazing store</p>
    <span>{{ product.name }}</span>
    <button aria-label="Close menu">{{ trans('common.close') }}</button>
</div>
{% if theme.settings.get('css_switch') %}
<style>
    {{ theme.settings.get('custom_css_handle') }}
</style>
{% endif %}`,

        "src/assets/js/bad.js": `const el = document.querySelector('#msg');
el.innerHTML = 'Added to cart successfully';
alert('Something went wrong');
console.log('debug message that must be ignored');
fetch('https://tracker.example.com/collect');
fetch('https://cdn.salla.sa/assets/x.json');
localStorage.setItem('auth_token', 'abc');
localStorage.setItem('liked_blogs', '[]');
// fake social proof block
const viewers = Math.floor(Math.random() * 50) + 5;
document.querySelector('.count').textContent = viewers + ' people are watching this product';`,

        "src/assets/js/broken.js": `function foo( {
    return 1;`,

        "src/assets/css/bad.css": `.badge::after { content: 'New offer'; }
.icon::before { content: '\\e970'; }
.unclosed { color: red;`,

        "public/junk.twig": `<p>This public text must NOT be reported</p>`,
    });

    const { issues } = core.analyzeTheme(theme, { raedParity: false, requiredHooks: false, requiredComponents: false, sizeCheck: false });
    const c = countByType(issues);

    assert(c["salla-scopes"] === 1, "salla-scopes في header.twig (×1)");
    assert(c["Custom Code"] === 2, "Custom Code: حقل twilight.json + حقن css_handle (×2)");
    assert(c["UI hard-coded text"] === 4, "نصوص UI ثابتة: twig + innerHTML + alert + css content (×4)");
    assert(c["Security"] === 2, "أمان: fetch خارجي + تخزين auth_token (×2)");
    assert(c["JS Syntax"] === 1, "خطأ JS Syntax (×1)");
    assert(c["CSS/SCSS"] === 1, "أقواس CSS غير متوازنة (×1)");
    assert(c["Misleading UX (Social Proof/Urgency)"] === 2, "بند 5.2: Math.random قرب social proof + عبارة watching this product (×2)");
    assert(!issues.some((i) => i.file.split(path.sep).includes("public")), "استبعاد مجلد public بالكامل");
    assert(!issues.some((i) => (i.desc || "").includes("salla.sa")), "عدم الإبلاغ عن نطاقات سلة");

    const jsSyntax = issues.find((i) => i.type === "JS Syntax");
    assert(jsSyntax && jsSyntax.line >= 1 && jsSyntax.line <= 2, "رقم سطر JS Syntax داخل حدود الملف");

    cleanup();
}

/* ============ 2) The gaps the original version used to miss ============ */

console.log("\n2) الحالات التي كانت تفوت سابقاً:");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"gaps"}',

        // Text alone on a separate line — the case the user reported
        "src/views/pages/bare.twig": `<div>
    </div>
    نص عربي وحده في سطر
    {% if x %}
</div>`,

        // Text spanning lines inside a multi-line tag
        "src/views/pages/multiline.twig": `<button
    type="button"
    class="btn"
>
    اشتر الآن
</button>`,

        // Tailwind classes containing ">" inside an attribute — must not produce a false positive
        "src/views/pages/tailwind.twig": `<div class="[&>*]:relative [&>div]:mt-2" style="--x: 1">
    {{ product.name }}
</div>`,

        // Markup inside JS containing UI text (rule 1 requires reporting it)
        "src/assets/js/markup.js": `el.innerHTML = '<p>مرحبا بك</p>';
box.insertAdjacentHTML('beforeend', '<span>تمت الإضافة</span>');
$(node).html('نص جي كويري');
salla.notify.success('تم الحفظ');
loader.innerHTML = '<salla-loading size="32"></salla-loading>';
icon.innerHTML = '<i class="sicon-cart"></i>';`,

        // Multi-line template
        "src/assets/js/tpl.js": `card.innerHTML = \`
    <div class="card">
        <h3>عنوان ثابت</h3>
    </div>
\`;`,

        // Two external domains on a single line
        "src/assets/js/net.js": `init(fetch('https://a.example.com/x'), fetch('https://b.example.com/y'));`,

        // salla-scopes: twice in the header + duplicated in master
        "src/views/layouts/master.twig": `<html><body>
<salla-scopes selection="optional"></salla-scopes>
<salla-scopes selection="mandatory"></salla-scopes>
</body></html>`,
        "src/views/components/header/header.twig": `<header>
<salla-scopes></salla-scopes>
<div>x</div>
<salla-scopes></salla-scopes>
</header>`,

        // Two brace errors within a single file
        "src/assets/css/two.css": `.a { color: red; }}
.b { color: blue; }}`,

        // A key containing "code" but it's a discount coupon — must not count as Custom Code
        "src/views/pages/coupon.twig": `<style>
{% if theme.settings.get('coupon_code') %}.x{color:red}{% endif %}
</style>`,
    });

    const { issues } = core.analyzeTheme(theme, { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false });
    const ui = issues.filter((i) => i.type === "UI hard-coded text");
    const text = (t) => ui.some((i) => (i.visible || "").includes(t));
    const inFile = (f) => issues.filter((i) => path.basename(i.file) === f);

    assert(text("نص عربي وحده في سطر"), "نص في سطر مستقل بين وسمين (بلاغ المستخدم)");
    assert(text("اشتر الآن"), "نص داخل وسم متعدد الأسطر");
    assert(text("مرحبا بك"), "نص داخل markup في innerHTML");
    assert(text("تمت الإضافة"), "نص عبر insertAdjacentHTML");
    assert(text("نص جي كويري"), "نص عبر jQuery .html()");
    assert(text("تم الحفظ"), "نص عبر salla.notify");
    assert(text("عنوان ثابت"), "نص داخل قالب نصي متعدد الأسطر");

    assert(!ui.some((i) => i.file.endsWith("tailwind.twig")), "أصناف Tailwind بـ [&>*] لا تُنتج إنذاراً خاطئاً");
    assert(!ui.some((i) => (i.visible || "").includes("salla-loading")), "مكوّن salla-* داخل innerHTML مُتجاهَل");
    assert(!ui.some((i) => (i.visible || "").includes("sicon")), "عنصر أيقونة فارغ مُتجاهَل");

    assert(inFile("header.twig").length === 2, "الإبلاغ عن كل ظهور لـ salla-scopes في الهيدر (2)");
    assert(inFile("master.twig").some((i) => (i.desc || "").includes("مكرّر")), "اكتشاف تكرار salla-scopes في master.twig");
    assert(inFile("net.js").length === 2, "الإبلاغ عن كل نطاق خارجي في السطر نفسه (2)");
    assert(inFile("two.css").length === 2, "الإبلاغ عن كل خطأ أقواس في ملف CSS (2)");
    assert(inFile("coupon.twig").filter((i) => i.type === "Custom Code").length === 0, "coupon_code ليس Custom Code");

    cleanup();
}

/* =============== 3) salla-scopes missing from master =============== */

console.log("\n3) salla-scopes مفقود من master.twig:");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"noscopes"}',
        "src/views/layouts/master.twig": `<html><body>{% block content %}{% endblock %}</body></html>`,
    });
    const { issues } = core.analyzeTheme(theme, { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false });
    assert(
        issues.some((i) => i.type === "salla-scopes" && (i.desc || "").includes("غير موجود")),
        "الإبلاغ عن غياب salla-scopes من master.twig"
    );
    cleanup();
}

/* ========= 3.5) Checks distilled from the actual rejection emails ========= */

console.log("\n3.5) فحوصات مراسلات الرفض:");
{
    const HOOKS_OK = `{% hook 'product.single.before_product_info' %}
{% hook 'product.single.before_customer_reviews' %}
{% hook 'product.single.before_product_recommendations' %}
{% hook 'product.single.after_product_recommendations' %}`;

    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"mails"}',
        // Hooks: single is missing two hooks, index is complete
        "src/views/pages/product/single.twig": `<div>{{ product.name }}</div>
{% hook 'product.single.before_product_info' %}
{% hook 'product.single.before_customer_reviews' %}`,
        "src/views/pages/product/index.twig": `{% hook 'product.index.before_products_group_with_filter' %}
{% hook 'product.index.after_products_group_with_filter' %}
{% hook 'product.index.after_testimonials' %}`,
        // page-single.twig doesn't exist at all → missing-file issue
        // Components: the header has only salla-user-menu
        "src/views/components/header/header.twig": `<header><salla-user-menu></salla-user-menu></header>`,
        // Fake engagement phrase without Math.random (as in the emails: master.twig)
        "src/views/layouts/master.twig": `<html><body>
{% if store.scope %}<salla-scopes></salla-scopes>{% endif %}
<span>3 أشخاص يشاهدون هذا المنتج الآن</span>
</body></html>`,
        // Unsafe Twig division + a safe one
        "src/views/pages/div.twig": `{% set cat_count = categories|length %}
{% set w = 100 / cat_count %}`,
        "src/views/pages/div-safe.twig": `{% set base_count = items|length %}
{% set w = 100 / max(1, base_count) %}`,
        // salla-products-slider building source-value manually (PR 581)
        "src/views/pages/slider.twig": `<salla-products-slider
    source="selected"
    source-value="[{{ products|map(p => p.id)|join(',') }}]">
</salla-products-slider>`,
        // A merge conflict marker inside public (as in the actual email)
        "public/product-card.js": `line1
<<<<<<< HEAD
const a = 1;
=======
const a = 2;
>>>>>>> feature
`,
        // Vite in a classic theme — must not be checked (a bundle-only check)
        "package.json": '{"name":"t","devDependencies":{"vite":"^5.0.0"}}',
    });

    const { issues } = core.analyzeTheme(theme, { raedParity: false, nodeSyntaxCheck: false, sizeCheck: false });
    const byType = (t) => issues.filter((i) => i.type === t);
    const descHas = (t, s) => byType(t).some((i) => (i.desc || "").includes(s));

    assert(descHas("Twilight Hooks", "product.single.before_product_recommendations")
        && !descHas("Twilight Hooks", "product.single.before_customer_reviews'"), "هوكس ناقصة في single.twig تُكتشف والموجودة لا تُذكر");
    assert(!byType("Twilight Hooks").some((i) => i.file.endsWith("index.twig")), "index.twig كاملة الهوكس — لا بلاغ");
    assert(descHas("Twilight Hooks", "page-single.twig"), "ملف page-single.twig المفقود يُبلَّغ عنه");
    assert(!descHas("Twilight Components", "salla-user-menu"), "salla-user-menu موجود — لا بلاغ");
    assert(descHas("Twilight Components", "salla-cart-coupons"), "salla-cart-coupons مفقود — بلاغ");
    assert(byType("Misleading UX (Social Proof/Urgency)").some((i) => i.severity === "error"), "عبارة «يشاهدون هذا المنتج» = خطأ صريح بدون Math.random");
    assert(byType("Twig Division").length === 1 && byType("Twig Division")[0].file.endsWith("div.twig"), "قسمة غير آمنة تُكتشف والمؤمّنة بـ max() لا");
    assert(descHas("Twilight Components", "pull/581"), "salla-products-slider ببناء يدوي → مرجع PR 581");
    assert(byType("Merge Conflict").length === 2 && byType("Merge Conflict")[0].file.includes("public"), "علامتا تعارض دمج داخل public تُكتشفان");
    assert(byType("Vite Config").length === 0, "ثيم كلاسيكي مع vite: لا فحص Vite (للمجموعات فقط)");

    cleanup();
}

/* ============== 3.6) Theme size + bundle checks ============== */

console.log("\n3.6) حجم الثيم والمجموعات (Bundles):");
{
    // A theme whose size exceeds 1MB (a 1.5MB binary image)
    const { theme, cleanup } = makeTheme({ "twilight.json": '{"name":"big"}' });
    fs.writeFileSync(path.join(theme, "public.png"), Buffer.alloc(1_500_000, 7));
    const { issues } = core.analyzeTheme(theme, { raedParity: false, requiredHooks: false, requiredComponents: false });
    assert(issues.some((i) => i.type === "Theme Size"), "ثيم بأصول 1.5MB → تحذير الحجم (حد 1MB)");
    cleanup();
}
{
    const { theme, cleanup } = makeTheme({
        "twilight-bundle.json": JSON.stringify({
            name: { ar: "مجموعة", en: "Bundle" },
            components: [{ settings: [{ id: "main_title", multilanguage: true }] }],
        }),
        "package.json": '{"name":"b","devDependencies":{"vite":"^5.0.0"}}',
        "src/components/comp.ts": `console.log('debug');
render(unsafeHTML(cfg.main_title));`,
    });
    const { issues } = core.analyzeTheme(theme, { raedParity: false, nodeSyntaxCheck: false });
    const byType = (t) => issues.filter((i) => i.type === t);
    assert(byType("Bundle i18n").length === 1, "multilanguage بدون localizedString → بلاغ i18n");
    assert(byType("Bundle Quality").some((i) => (i.desc || "").includes("console.log")), "console.log في مصدر المجموعة → بلاغ");
    assert(byType("Bundle Quality").some((i) => (i.desc || "").includes("unsafeHTML")), "unsafeHTML → بلاغ");
    assert(byType("Bundle Quality").some((i) => (i.desc || "").includes("dist/")), "غياب dist/ → بلاغ");
    assert(byType("Vite Config").length === 1, "مجموعة مع vite بلا vite.config → بلاغ (الفحص للمجموعات)");
    cleanup();
}
{
    // A clean bundle: localizedString present + dist + no console
    const { theme, cleanup } = makeTheme({
        "twilight-bundle.json": JSON.stringify({ components: [{ settings: [{ id: "t", multilanguage: true }] }] }),
        "src/utils/localizedString.ts": "export function localizedString(v){return v}",
        "src/comp.ts": "import {localizedString} from './utils/localizedString';",
        "dist/comp.js": "// built",
    });
    const { issues } = core.analyzeTheme(theme, { raedParity: false, nodeSyntaxCheck: false });
    assert(!issues.some((i) => i.type.startsWith("Bundle")), "مجموعة سليمة (localizedString + dist) → صفر بلاغات Bundle");
    cleanup();
}

/* ========= 3.7) twilight.json structural checks + colors + CSS variables ========= */

console.log("\n3.7) twilight.json الهيكلية والألوان ومتغيرات CSS:");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": JSON.stringify({
            name: "manifest-theme",
            settings: [
                { id: "used_setting", type: "string" },
                { id: "unused_setting", type: "string" },
                { id: "dc9c49", type: "static", format: "line" },
                { id: "bad id!", type: "string" },
                { type: "number", label: "no id here" },
                { id: "coll", type: "collection", fields: [{ id: "coll.child", type: "number" }] },
            ],
            components: [
                {
                    key: "k1", title: { ar: "مكوّن" }, path: "home.exists",
                    fields: [
                        { id: "used_field", type: "string" },
                        { id: "unused_field", type: "string" },
                        { id: "static1", type: "static" },
                    ],
                },
                { key: "k2", title: { ar: "مفقود" }, path: "home.missing", fields: [] },
            ],
        }, null, 2),
        "src/views/pages/page.twig": `<div>{{ theme.settings.get('used_setting') }}
{{ theme.settings.get('ghost_setting') }}</div>`,
        "src/views/components/home/exists.twig": `<div>{{ component.used_field }}</div>`,
    });

    const { issues } = core.analyzeTheme(theme, {
        raedParity: false, nodeSyntaxCheck: false,
        requiredHooks: false, requiredComponents: false, sizeCheck: false, colorCheck: false, cssVarCheck: false,
    });
    const man = issues.filter((i) => i.type === "Twilight Manifest");
    const descHas = (s) => man.some((i) => (i.desc || "").includes(s));

    assert(descHas('"unused_setting"'), "إعداد معرّف وغير مستخدم → بلاغ");
    assert(!descHas('"used_setting"'), "الإعداد المستخدم لا يُبلَّغ عنه");
    assert(!descHas('"dc9c49"'), "حقول static معفاة من فحص عدم الاستخدام");
    assert(descHas("ghost_setting"), "theme.settings.get لإعداد غير معرّف → بلاغ");
    assert(descHas('"bad id!"'), "id بمسافة/رمز غير مسموح → بلاغ");
    assert(descHas("حقل بدون id"), "حقل بلا id → بلاغ");
    assert(!descHas('"coll.child"'), "أبناء المجموعات (بالنقطة) ids صالحة");
    assert(descHas('"home.missing"'), "مسار مكوّن لملف غير موجود → بلاغ");
    assert(descHas('"unused_field"'), "حقل مكوّن غير مستخدم في ملفه → بلاغ");
    assert(!descHas('"used_field"'), "حقل المكوّن المستخدم (component.x) لا يُبلَّغ");

    cleanup();
}
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"colors"}',
        "src/views/pages/c.twig": `<div class="bg-red-500 text-[11px]" style="color: #a1b2c3">
    <span style="color: var(--x, #fff)">{{ p }}</span>
    <svg><path fill="#123456"/></svg>
</div>`,
        "src/assets/styles/c.scss": `.a { color: #FF0000; }
.b { color: var(--main, #eee); }`,
        "src/assets/js/c.js": `el.style.background = '#00ff00';`,
    });
    const { issues } = core.analyzeTheme(theme, {
        raedParity: false, nodeSyntaxCheck: false,
        requiredHooks: false, requiredComponents: false, sizeCheck: false, cssVarCheck: false, twilightManifestCheck: false,
    });
    const colors = issues.filter((i) => i.type === "Hardcoded Color");
    const at = (f) => colors.filter((i) => i.file.endsWith(f));
    assert(at("c.twig").length === 1 && (at("c.twig")[0].desc || "").includes("#a1b2c3"), "hex + bg-red-500 في twig (سطر واحد) — وsvg وfallback مستثنيان");
    assert((at("c.twig")[0].desc || "").includes("bg-red-500"), "صنف Tailwind اللوني مذكور في البلاغ");
    assert(at("c.scss").length === 1, "hex في scss يُبلَّغ وfallback داخل var() لا");
    assert(at("c.js").length === 1, "hex في JS يُبلَّغ");
    assert(colors.every((i) => i.severity === "info"), "الألوان بدرجة معلومات (لا تحذير)");
    cleanup();
}
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"vars"}',
        // Defined in twig (style attr) + <style> + used in scss and js
        "src/views/layouts/master.twig": `<body style="--defined-in-attr: 10px">
<style>:root { --defined-in-style: red; --never-used: blue; }</style>
</body>`,
        "src/assets/styles/v.scss": `.a { width: var(--defined-in-attr); color: var(--defined-in-style); }
.b { color: var(--ghost-var); }
.c { color: var(--tw-ring-color); }`,
        "src/assets/js/v.js": `el.style.setProperty('--js-var', '1');
const x = getComputedStyle(el).getPropertyValue('--js-var');`,
    });
    const { issues } = core.analyzeTheme(theme, {
        raedParity: false, nodeSyntaxCheck: false,
        requiredHooks: false, requiredComponents: false, sizeCheck: false, colorCheck: false, twilightManifestCheck: false,
    });
    const vars = issues.filter((i) => i.type === "CSS Variables");
    const descHas = (s) => vars.some((i) => (i.desc || "").includes(s));
    assert(descHas("--never-used"), "متغير معرّف وغير مستخدم → بلاغ");
    assert(!descHas("--defined-in-attr") && !descHas("--defined-in-style"), "التعريف في twig (attr أو style) يُحتسب للاستخدام في scss");
    assert(descHas("--ghost-var"), "متغير مستخدم وغير معرّف → بلاغ");
    assert(!descHas("--tw-ring-color"), "متغيرات المنصة/tailwind مستثناة");
    assert(!descHas("--js-var"), "setProperty في JS يُحتسب تعريفاً وgetPropertyValue استخداماً");
    cleanup();
}

/* ==================== 3.75) Twig block balance ==================== */

console.log("\n3.75) توازن بلوكات Twig (if/for/macro/…):");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"blocks"}',
        // if without endif
        "src/views/pages/unclosed.twig": `<div>
{% if product.has_stock %}
    <p>{{ product.name }}</p>
</div>`,
        // endfor without for
        "src/views/pages/unopened.twig": `<div>
{% endfor %}
</div>`,
        // A close that does not match the opener
        "src/views/pages/mismatch.twig": `{% if a %}
{% endfor %}
{% endif %}`,
        // An unclosed inner block detected by the outer block's close
        "src/views/pages/inner.twig": `{% for item in items %}
{% if item.x %}
{% endfor %}`,
        // macro without endmacro
        "src/views/pages/macro.twig": `{% macro badge(text) %}
<span>{{ text }}</span>`,
        // All the valid forms — must not produce any report
        "src/views/pages/ok.twig": `{% set title = 'x' %}
{% block seo_title page.title %}
{% set content %}<b>hi</b>{% endset %}
{% block body %}
{% for p in products %}
    {% if p.ok %}<i>1</i>{% elseif p.x %}<i>2</i>{% else %}<i>3</i>{% endif %}
{% else %}
    {# for-else #}
{% endfor %}
{% endblock %}
{% verbatim %}{% if literal_not_parsed %}{% endverbatim %}
{% hook 'product.single.before_product_info' %}
{%- if tight -%}<u>t</u>{%- endif -%}`,
    });

    const { issues } = core.analyzeTheme(theme, {
        raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false,
        sizeCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false,
    });
    const tw = issues.filter((i) => i.type === "Twig Syntax");
    const inFile = (f) => tw.filter((i) => path.basename(i.file) === f);

    assert(inFile("unclosed.twig").length === 1 && inFile("unclosed.twig")[0].line === 2, "if بلا endif → بلاغ على سطر الفتح");
    assert(inFile("unopened.twig").length === 1 && (inFile("unopened.twig")[0].desc || "").includes("endfor"), "endfor بلا for → بلاغ");
    assert(inFile("mismatch.twig").some((i) => (i.desc || "").includes("لا يطابق")), "endfor يقفل if → بلاغ عدم تطابق");
    assert(inFile("inner.twig").some((i) => (i.desc || "").includes("{% if %}") && i.line === 2), "if داخلي غير مغلق يُرصد عند endfor الخارجي");
    assert(inFile("macro.twig").length === 1 && (inFile("macro.twig")[0].desc || "").includes("macro"), "macro بلا endmacro → بلاغ");
    assert(inFile("ok.twig").length === 0, "الصيغ السليمة كلها (set=، block بقيمة، for-else، verbatim، hook، {%- -%}) بلا بلاغات");
    assert(tw.every((i) => core.ERROR_TYPES.has(i.type)), "Twig Syntax بدرجة خطأ (رفض)");

    cleanup();
}

/* ==================== 3.8) The incremental engine ==================== */

console.log("\n3.8) المحرك التزايدي (refreshFileInState):");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"inc","settings":[{"id":"s1","type":"string"}]}',
        "src/views/pages/a.twig": `<p>{{ theme.settings.get('s1') }}</p>`,
    });
    const opts = { nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false, colorCheck: false, structureCheck: false };
    const state = core.createThemeState(theme, opts);
    assert(core.stateIssues(state).length === 0, "الحالة الابتدائية نظيفة");

    // Add a hard-coded text and save — it must appear by updating the file alone
    const a = path.join(theme, "src/views/pages/a.twig");
    fs.writeFileSync(a, `<p>{{ theme.settings.get('s1') }}</p>\n<p>نص ثابت جديد</p>`, "utf8");
    core.refreshFileInState(state, a);
    let issues = core.stateIssues(state);
    assert(issues.some((i) => i.type === "UI hard-coded text" && (i.visible || "").includes("نص ثابت جديد")), "التحديث التزايدي يلتقط مخالفة جديدة في الملف المحفوظ");

    // Fix it — it must disappear
    fs.writeFileSync(a, `<p>{{ theme.settings.get('s1') }}</p>`, "utf8");
    core.refreshFileInState(state, a);
    issues = core.stateIssues(state);
    assert(!issues.some((i) => i.type === "UI hard-coded text"), "إصلاح الملف يزيل مشكلته بعد تحديثه وحده");

    // Remove the usage of s1 — the cross-file (unused) check must pick it up from memory
    fs.writeFileSync(a, `<p>ثابت</p>`, "utf8");
    core.refreshFileInState(state, a);
    issues = core.stateIssues(state);
    assert(issues.some((i) => i.type === "Twilight Manifest" && (i.desc || "").includes('"s1"')), "الفحص العابر (إعداد غير مستخدم) يتحدث تزايدياً");

    // Delete the file from disk
    fs.rmSync(a);
    core.refreshFileInState(state, a);
    issues = core.stateIssues(state);
    assert(!issues.some((i) => i.file === a), "حذف الملف يزيل مشاكله من الحالة");

    cleanup();
}

/* ========== 3.85) Incremental refresh must honor SKIP_DIRS (vendored engine bug) ========== */

console.log(String.fromCharCode(10) + "3.85) الحفظ داخل المجلدات المستثناة دائماً:");
{
    // Reproduces the reported bug: the vendored engine in .salla-review/ contains a
    // legitimate fetch to registry.npmjs.org; saving it must NOT create Security findings.
    const { theme, cleanup } = makeTheme({
        'twilight.json': '{"name":"skipdirs"}',
        'public/ok.js': '// built',
        'src/views/pages/a.twig': '<div>{{ product.name }}</div>',
        '.salla-review/lib/twilight-version.js': 'const res = await fetch(' + String.fromCharCode(96) + 'https://registry.npmjs.org/x' + String.fromCharCode(96) + ');',
    });
    const opts = { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false };
    const state = core.createThemeState(theme, opts);
    assert(core.stateIssues(state).length === 0, 'الفحص الكامل لا يمس .salla-review/');
    // Simulate the on-save incremental path on the vendored file
    core.refreshFileInState(state, path.join(theme, '.salla-review/lib/twilight-version.js'));
    const after = core.stateIssues(state);
    assert(after.length === 0 && !after.some((i) => i.type === 'Security'),
        'حفظ ملف داخل .salla-review لا يولّد أي بلاغ (كان يعلّم fetch الخاص بالمحرك نفسه)');
    cleanup();
}
/* ==================== 3.9) Disable toggles + path include/exclude ==================== */

console.log("\n3.9) مفاتيح تعطيل الفحوصات:");
{
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"toggles","settings":[{"id":"ghost","type":"string"}]}',
        "src/views/pages/t.twig": `<p>نص ثابت</p>
{% if x %}
<style>{{ theme.settings.get('custom_css_handle') }}</style>`,
        "src/assets/js/t.js": `el.innerHTML = 'نص';
fetch('https://evil.example.com/x');
el.style.color = '#ff0000';`,
        "src/assets/css/t.css": `.a { color: red; }}`,
    });
    const base = { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false };

    const all = core.analyzeTheme(theme, base).issues;
    const has = (issues, t) => issues.some((i) => i.type === t);
    assert(has(all, "UI hard-coded text") && has(all, "Twig Syntax") && has(all, "Security")
        && has(all, "Custom Code") && has(all, "CSS/SCSS") && has(all, "Hardcoded Color")
        && has(all, "Twilight Manifest"), "كل الفحوصات تعمل افتراضياً");

    const off = core.analyzeTheme(theme, {
        ...base,
        uiTextCheck: false, twigSyntaxCheck: false, securityCheck: false, customCodeCheck: false,
        cssBracesCheck: false, colorCheck: false, twilightManifestCheck: false, cssVarCheck: false,
        scopesCheck: false, divisionCheck: false, misleadingUxHeuristic: false, mergeConflicts: false,
        viteCheck: false, bundleCheck: false, sliderSourceCheck: false, structureCheck: false,
    }).issues;
    assert(off.length === 0, "تعطيل كل المفاتيح = صفر بلاغات (كل ميزة لها مفتاح مستقل)");

    const onlyUi = core.analyzeTheme(theme, {
        ...base,
        twigSyntaxCheck: false, securityCheck: false, customCodeCheck: false, cssBracesCheck: false,
        colorCheck: false, twilightManifestCheck: false, cssVarCheck: false, scopesCheck: false,
        structureCheck: false,
    }).issues;
    assert(onlyUi.length > 0 && onlyUi.every((i) => i.type === "UI hard-coded text"), "تعطيل انتقائي: تبقى نصوص UI فقط");
    cleanup();
}

console.log("\n3.10) تضمين/استثناء المسارات:");
{
    const files = {
        "twilight.json": '{"name":"filters"}',
        "src/views/pages/keep.twig": `<p>نص في ملف مفحوص</p>`,
        "src/views/components/custom/skip.twig": `<p>نص في مجلد مستثنى</p>`,
        "src/assets/js/lib.min.js": `el.innerHTML = 'نص في ملف مصغّر';`,
        "vendor/x.twig": `<p>نص في vendor</p>`,
        "public/pc.js": `<<<<<<< HEAD\nx\n>>>>>>> b\n`,
    };
    const base = { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false };

    // 1) Exclude: a folder by its path + regex + bare name
    {
        const { theme, cleanup } = makeTheme(files);
        const { issues } = core.analyzeTheme(theme, {
            ...base,
            exclude: ["src/views/components/custom", "/\\.min\\.js$/", "vendor"],
        });
        const uiFiles = issues.filter((i) => i.type === "UI hard-coded text").map((i) => path.basename(i.file));
        assert(uiFiles.includes("keep.twig"), "الملف غير المستثنى يُفحص");
        assert(!uiFiles.includes("skip.twig"), "استثناء مجلد بمساره يعمل");
        assert(!uiFiles.includes("lib.min.js"), "استثناء regex ‏(/\\.min\\.js$/) يعمل");
        assert(!uiFiles.includes("x.twig"), "استثناء اسم مجرد (vendor) يعمل");
        assert(issues.some((i) => i.type === "Merge Conflict"), "تعارضات public تبقى مفحوصة مع الاستثناءات الأخرى");
        cleanup();
    }
    // 2) An exclude that applies to public as well
    {
        const { theme, cleanup } = makeTheme(files);
        const { issues } = core.analyzeTheme(theme, { ...base, exclude: ["public"] });
        assert(!issues.some((i) => i.type === "Merge Conflict"), "استثناء public يوقف فحص تعارضاته");
        cleanup();
    }
    // 3) A leftover include value (removed feature) is ignored — everything still scans
    {
        const { theme, cleanup } = makeTheme(files);
        const { issues } = core.analyzeTheme(theme, { ...base, include: ["src/views/pages/**"] });
        const uiFiles = issues.filter((i) => i.type === "UI hard-coded text").map((i) => path.basename(i.file));
        assert(uiFiles.includes("keep.twig") && uiFiles.includes("skip.twig"),
            "قيمة include قديمة تُتجاهَل بأمان (الميزة أزيلت)");
        cleanup();
    }
    // 4) Regex exclude + the incremental update respects the exclude
    {
        const { theme, cleanup } = makeTheme(files);
        const opts = { ...base, exclude: ["/skip\\.twig$/"] };
        const state = core.createThemeState(theme, opts);
        let ui = core.stateIssues(state).filter((i) => i.type === "UI hard-coded text");
        assert(ui.some((i) => i.file.endsWith("keep.twig")) && !ui.some((i) => i.file.endsWith("skip.twig")),
            "استثناء regex لملف واحد يعمل");
        // Saving the excluded file does not bring it back
        core.refreshFileInState(state, path.join(theme, "src/views/components/custom/skip.twig"));
        ui = core.stateIssues(state).filter((i) => i.type === "UI hard-coded text");
        assert(!ui.some((i) => i.file.endsWith("skip.twig")), "التحديث التزايدي يحترم الاستثناء");
        cleanup();
    }
    // 5) Excluding the required-hooks file = intentional ignore, not a "missing file"
    {
        const { theme, cleanup } = makeTheme({
            "twilight.json": '{"name":"hooks-excl"}',
            "src/views/pages/product/single.twig": `<div>بلا هوكس إطلاقاً</div>`,
        });
        const withHooks = { raedParity: false, nodeSyntaxCheck: false, requiredComponents: false, sizeCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false, uiTextCheck: false };
        const flagged = core.analyzeTheme(theme, withHooks).issues.filter((i) => i.type === "Twilight Hooks");
        assert(flagged.some((i) => i.file.endsWith("single.twig")), "بدون استثناء: هوكس الملف الناقصة تُرصد");
        const excluded = core.analyzeTheme(theme, { ...withHooks, exclude: ["src/views/pages/product"] })
            .issues.filter((i) => i.type === "Twilight Hooks" && (i.desc || "").includes("product/single"));
        assert(excluded.length === 0, "استثناء الملف الموجود يتجاهله بدل الإبلاغ عنه كمفقود");
        cleanup();
    }
}

/* ==================== 3.11) CLI gate: exit codes + project settings ==================== */

console.log("\n3.11) بوابة CLI (fail-on) وإعدادات المشروع:");
{
    const { execFileSync } = require("child_process");
    const cliPath = path.join(__dirname, "..", "cli.js");
    const runCli = (cwdTheme, extra) => {
        try {
            execFileSync(process.execPath, [cliPath, cwdTheme, "--no-report", "--no-network", "--no-parity", ...extra], { stdio: "pipe" });
            return 0;
        } catch (e) {
            return e.status;
        }
    };

    // Theme with one error-severity finding (merge conflict) and one warning (UI text)
    const { theme, cleanup } = makeTheme({
        "twilight.json": '{"name":"gate"}',
        "src/views/pages/a.twig": `<p>نص ثابت</p>`,
        "src/views/pages/b.twig": `<<<<<<< HEAD
x
>>>>>>> y
<div></div>`,
    });
    const quiet = ["--no-colors", "--no-cssvars", "--no-manifest", "--no-hooks", "--no-components", "--no-size", "--no-twig-blocks", "--no-structure"];

    assert(runCli(theme, quiet) === 0, "الافتراضي (fail-on never): خروج 0 رغم وجود مشاكل");
    assert(runCli(theme, [...quiet, "--fail-on", "error"]) === 1, "fail-on error: خروج 1 عند وجود خطأ (تعارض دمج)");
    cleanup();

    // Warning-only theme (document.cookie is a warning-severity finding)
    const w = makeTheme({
        "twilight.json": '{"name":"warn"}',
        "public/ok.js": "// built",
        "src/assets/js/c.js": "const v = document.cookie;",
    });
    assert(runCli(w.theme, [...quiet, "--fail-on", "error"]) === 0, "fail-on error: التحذير وحده لا يفشل");
    assert(runCli(w.theme, [...quiet, "--fail-on", "warning"]) === 1, "fail-on warning: التحذير يفشل");
    w.cleanup();

    // Project settings auto-load: .vscode/settings.json disables the UI text check
    const s2 = makeTheme({
        "twilight.json": '{"name":"cfg"}',
        ".vscode/settings.json": `{
  // per-project config (JSONC)
  "sallaReview.checks.uiText": false,
}`,
        "src/views/pages/a.twig": `<p>نص ثابت</p>`,
    });
    assert(runCli(s2.theme, [...quiet, "--fail-on", "warning"]) === 0,
        "‎.vscode/settings.json يعطّل فحص النصوص → CLI يحترمه (توحيد المحرر/الهوكس/CI)");
    s2.cleanup();
}

/* ==================== 3.12) Theme structure + GitHub CI mode ==================== */

console.log(String.fromCharCode(10) + "3.12) بنية الثيم ووضع GitHub CI:");
{
    // public/ missing -> error (TwilightCI parity); present -> clean
    const base = { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false, sizeCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false };
    const a = makeTheme({ 'twilight.json': '{"name":"s1"}' });
    const withIssue = core.analyzeTheme(a.theme, base).issues.filter((i) => i.type === 'Theme Structure');
    assert(withIssue.length === 1 && core.issueSeverity(withIssue[0]) === 'error', 'غياب public/ → خطأ Theme Structure');
    a.cleanup();
    const b = makeTheme({ 'twilight.json': '{"name":"s2"}', 'public/app.js': '// built' });
    assert(core.analyzeTheme(b.theme, base).issues.filter((i) => i.type === 'Theme Structure').length === 0, 'وجود public/ غير فارغ → لا بلاغ');
    b.cleanup();

    // --github: annotations on stdout + TwilightCI-style step summary file
    const { execFileSync } = require('child_process');
    const cliPath = path.join(__dirname, '..', 'cli.js');
    const g = makeTheme({
        'twilight.json': '{"name":"gh"}',
        'src/views/pages/a.twig': '<p>نص ثابت</p>' + String.fromCharCode(10) + '{% if x %}',
        'public/ok.js': '// built',
    });
    const sumFile = path.join(g.theme, 'summary.md');
    let stdout = '';
    try {
        stdout = String(execFileSync(process.execPath, [cliPath, g.theme, '--no-report', '--no-network', '--no-parity', '--github',
            '--no-colors', '--no-cssvars', '--no-manifest', '--no-hooks', '--no-components', '--no-size'],
            { env: { ...process.env, GITHUB_STEP_SUMMARY: sumFile, GITHUB_SHA: 'abc1234def' }, stdio: 'pipe' }));
    } catch (e) { stdout = String(e.stdout || ''); }
    assert(/::error file=.*a.twig,line=2/.test(stdout), '--github يطبع ::error annotation بالملف والسطر (بلوك غير مغلق)');
    assert(/::error file=.*a.twig,line=1/.test(stdout), '--github يطبع ::error للنص الثابت (سبب رفض = خطأ)');
    const summary = fs.readFileSync(sumFile, 'utf8');
    assert(/of \d+ checks failed/.test(summary) && summary.includes('commit `abc1234`'), 'الملخص بأسلوب TwilightCI: X of N checks failed + commit');
    assert(summary.includes('| ❌ | Twig syntax |') && summary.includes('| ✅ | Theme structure |'), 'جدول الفحوصات: صف فاشل وصف ناجح');
    assert(summary.includes('What to fix') && summary.includes('How to fix'), 'قسم What to fix مع إرشاد الإصلاح');
    // Severity truth: rejection-reason types must be errors
    for (const t of ['UI hard-coded text', 'Twilight Components', 'Twig Division']) {
        assert(core.ERROR_TYPES.has(t), 'نوع «' + t + '» = خطأ (سبب رفض موثّق)');
    }
    g.cleanup();
}
/* ==================== 3.13) User-defined custom rules ==================== */

console.log(String.fromCharCode(10) + "3.13) القواعد المخصصة للمستخدم:");
{
    const base = { raedParity: false, nodeSyntaxCheck: false, requiredHooks: false, requiredComponents: false,
        sizeCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false,
        uiTextCheck: false, structureCheck: false, twigSyntaxCheck: false };

    // Scenario: Salla announces a new rule the extension does not know yet —
    // the developer writes it themselves and it is enforced immediately.
    const rules = {
        rules: [
            { id: 'no-jquery', name: 'No jQuery', message: 'Use native DOM APIs',
              severity: 'error', files: 'src/assets/js/**', forbid: '\\$\\(' },
            { id: 'needs-new-component', name: 'New required component',
              severity: 'error', files: 'src/views/**', require: '<salla-brand-new', scope: 'theme' },
            { id: 'cart-needs-note', name: 'Cart note', severity: 'warning',
              files: 'src/views/pages/cart.twig', require: 'data-cart-note' },
        ],
    };
    const files = {
        'twilight.json': '{"name":"rules"}',
        'salla-rules.json': JSON.stringify(rules, null, 2),
        'src/assets/js/app.js': '$(document).ready(function(){});',
        'src/views/pages/cart.twig': '<div>cart</div>',
        'src/views/pages/other.twig': '<div>{{ x }}</div>',
    };

    {
        const { theme, cleanup } = makeTheme(files);
        const { issues } = core.analyzeTheme(theme, base);
        const cr = issues.filter((i) => i.type === 'Custom Rule');
        const byId = (id) => cr.filter((i) => i.ruleId === id);

        assert(byId('no-jquery').length === 1 && byId('no-jquery')[0].line === 1 &&
               core.issueSeverity(byId('no-jquery')[0]) === 'error',
            'قاعدة forbid تُبلّغ عن المطابقة بالسطر وبالشدة المحددة');
        assert(byId('needs-new-component').length === 1,
            'قاعدة require بنطاق theme تُبلّغ مرة واحدة عند غيابها من كل الملفات');
        assert(byId('cart-needs-note').length === 1 && byId('cart-needs-note')[0].file.endsWith('cart.twig'),
            'قاعدة require بنطاق file تُبلّغ على الملف المستهدف فقط');
        assert(!cr.some((i) => i.file.endsWith('other.twig')),
            'الملفات خارج نطاق files لا تتأثر');
        assert(byId('no-jquery')[0].desc.includes('[no-jquery]') && byId('no-jquery')[0].desc.includes('Use native DOM APIs'),
            'الرسالة تتضمن معرّف القاعدة ونص الرسالة');
        cleanup();
    }

    // Satisfying the rules clears them
    {
        const fixed = { ...files,
            'src/assets/js/app.js': 'document.addEventListener("DOMContentLoaded", () => {});',
            'src/views/pages/cart.twig': '<div data-cart-note><salla-brand-new></salla-brand-new></div>',
        };
        const { theme, cleanup } = makeTheme(fixed);
        const cr = core.analyzeTheme(theme, base).issues.filter((i) => i.type === 'Custom Rule');
        assert(cr.length === 0, 'استيفاء القواعد يزيل كل البلاغات');
        cleanup();
    }

    // Comments are ignored by default, and skipComments:false opts in
    {
        const withComment = {
            'twilight.json': '{"name":"c"}',
            'salla-rules.json': JSON.stringify({ rules: [
                { id: 'no-todo', files: 'src/**', forbid: 'TODO' },
                { id: 'no-todo-all', files: 'src/**', forbid: 'TODO', skipComments: false },
            ] }),
            'src/assets/js/a.js': '// TODO: later',
        };
        const { theme, cleanup } = makeTheme(withComment);
        const cr = core.analyzeTheme(theme, base).issues.filter((i) => i.type === 'Custom Rule');
        assert(!cr.some((i) => i.ruleId === 'no-todo'), 'التعليقات مُتجاهَلة افتراضياً');
        assert(cr.some((i) => i.ruleId === 'no-todo-all'), 'skipComments:false يفحص داخل التعليقات');
        cleanup();
    }

    // Authoring mistakes surface on the rules file itself
    {
        const bad = {
            'twilight.json': '{"name":"bad"}',
            'salla-rules.json': JSON.stringify({ rules: [
                { name: 'no id here', forbid: 'x' },
                { id: 'bad regex', forbid: 'x' },
                { id: 'dup', forbid: 'x' },
                { id: 'dup', forbid: 'y' },
                { id: 'nothing' },
                { id: 'broken-re', forbid: '([unclosed' },
                { id: 'bad-sev', forbid: 'x', severity: 'critical' },
            ] }),
        };
        const { theme, cleanup } = makeTheme(bad);
        const cr = core.analyzeTheme(theme, base).issues.filter((i) => i.type === 'Custom Rule');
        assert(cr.length === 6 && cr.every((i) => i.file.endsWith('salla-rules.json')),
            'أخطاء تأليف القواعد تظهر على ملف القواعد نفسه (6 أخطاء)');
        assert(cr.every((i) => core.issueSeverity(i) === 'error'), 'أخطاء التأليف بدرجة خطأ');
        cleanup();
    }

    // Invalid JSON is reported, not silently ignored
    {
        const { theme, cleanup } = makeTheme({
            'twilight.json': '{"name":"j"}',
            'salla-rules.json': '{ rules: [ }',
        });
        const cr = core.analyzeTheme(theme, base).issues.filter((i) => i.type === 'Custom Rule');
        assert(cr.length === 1 && cr[0].desc.includes('JSON'), 'ملف قواعد غير صالح يُبلَّغ عنه');
        cleanup();
    }

    // JSONC (comments + trailing commas) is accepted, and the toggle disables everything
    {
        const { theme, cleanup } = makeTheme({
            'twilight.json': '{"name":"jsonc"}',
            'salla-rules.json': '{' + String.fromCharCode(10) +
                '  // my rules' + String.fromCharCode(10) +
                '  "rules": [ { "id": "x", "files": "src/**", "forbid": "BAD" }, ]' + String.fromCharCode(10) + '}',
            'src/assets/js/a.js': 'const s = "BAD";',
        });
        assert(core.analyzeTheme(theme, base).issues.filter((i) => i.type === 'Custom Rule').length === 1,
            'يقبل JSONC (تعليقات وفواصل زائدة)');
        assert(core.analyzeTheme(theme, { ...base, customRuleCheck: false })
            .issues.filter((i) => i.type === 'Custom Rule').length === 0,
            'مفتاح checks.customRules يعطّل القواعد المخصصة');
        cleanup();
    }

    // Regression: a glob containing the comment-like sequence must survive JSONC parsing
    {
        const { theme, cleanup } = makeTheme({
            'twilight.json': '{"name":"glob"}',
            'salla-rules.json': '{' + String.fromCharCode(10) +
                '  // the files glob below contains a comment-like sequence' + String.fromCharCode(10) +
                '  "rules": [{ "id": "g", "files": "src/views/**/*.twig", "forbid": "BADTOKEN" }]' + String.fromCharCode(10) + '}',
            'src/views/pages/deep/a.twig': '<div>BADTOKEN</div>',
            'src/assets/js/b.js': 'const x = "BADTOKEN";',
        });
        const cr = core.analyzeTheme(theme, base).issues.filter((i) => i.type === 'Custom Rule');
        assert(cr.length === 1 && cr[0].file.endsWith('a.twig'),
            'نمط glob يحتوي /**/ لا يتلف أثناء تحليل JSONC (يطابق twig العميق فقط)');
        cleanup();
    }
    // Editing the rules file is picked up by the incremental engine
    {
        const { theme, cleanup } = makeTheme({
            'twilight.json': '{"name":"live"}',
            'salla-rules.json': JSON.stringify({ rules: [] }),
            'src/assets/js/a.js': 'const s = "BAD";',
        });
        const state = core.createThemeState(theme, base);
        assert(core.stateIssues(state).filter((i) => i.type === 'Custom Rule').length === 0, 'لا قواعد بعد = لا بلاغات');
        const rulesPath = path.join(theme, 'salla-rules.json');
        fs.writeFileSync(rulesPath, JSON.stringify({ rules: [{ id: 'x', files: 'src/**', forbid: 'BAD' }] }), 'utf8');
        core.refreshFileInState(state, rulesPath);
        assert(core.stateIssues(state).filter((i) => i.type === 'Custom Rule').length === 1,
            'حفظ ملف القواعد يعيد تطبيقها فوراً على الثيم');
        cleanup();
    }
}
/* ==================== 4) Raed stays clean ==================== */

const raedDir = path.join(__dirname, "..", "..", "THEME-Raed-basic");
const raedAlt = path.join(__dirname, "..", "..", "..", "Themes-Review", "THEME-Raed-basic");
const raed = fs.existsSync(path.join(raedDir, "twilight.json"))
    ? raedDir
    : fs.existsSync(path.join(raedAlt, "twilight.json"))
        ? raedAlt
        : null;

if (raed) {
    console.log("\n4) ثيم رائد المرجعي (يجب أن يكون نظيفاً):");
    const clean = core.analyzeTheme(raed, { raedParity: false, requiredHooks: false, requiredComponents: false, sliderSourceCheck: false, colorCheck: false, cssVarCheck: false, twilightManifestCheck: false });
    if (clean.issues.length) {
        for (const i of clean.issues.slice(0, 10)) {
            console.error(`      ${i.type} | ${path.relative(raed, i.file)}:${i.line} | ${(i.visible || i.desc || "").slice(0, 60)}`);
        }
    }
    assert(clean.issues.length === 0, `صفر إنذارات خاطئة على رائد (وجد: ${clean.issues.length})`);
} else {
    console.log("\n4) (تخطي) مجلد THEME-Raed-basic غير موجود.");
}

/* ==================== 5) Report format ==================== */

console.log("\n5) التقرير:");
{
    const issues = [
        { type: "UI hard-coded text", file: "C:/t/a.twig", line: 2, visible: "نص", desc: "نص واجهة ثابت", lines: ["<p>", "نص", "</p>"] },
        { type: "salla-scopes", file: "C:/t/b.twig", line: 1, desc: "خطأ", lines: ["x"] },
    ];
    const md = core.buildReportMarkdown("demo", issues, null, "C:/t");
    assert(md.includes("### ملخص النتائج"), "التقرير يبدأ بملخص النتائج");
    assert(md.includes("**الإجمالي: 2 مخالفة**"), "الملخص يذكر الإجمالي");
    assert(md.indexOf("salla-scopes") < md.indexOf("UI hard-coded text"), "الأخطر يظهر أولاً");

    const empty = core.buildReportMarkdown("demo", [], null, "C:/t");
    assert(empty.includes("لم يتم العثور على أي مخالفة"), "تقرير نظيف يصرّح بذلك بوضوح");
}

if (failures > 0) {
    console.error(`\n❌ فشل ${failures} اختبار`);
    process.exit(1);
}
console.log("\n✅ كل الاختبارات ناجحة");
