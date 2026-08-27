# Salla Theme Reviewer

**Catch Salla review rejections before you submit — right inside VS Code.**

Salla Theme Reviewer analyzes your Twilight theme against the rules Salla's review team
actually applies, built from the analysis of **123 real rejection emails**. Findings appear
in the Problems panel on the exact line, every save re-checks instantly, and one command
turns the same checks into commit, push, and pull-request gates for your whole team.

> Diagnostics and reports are in Arabic on purpose — they match the language of Salla's
> review feedback, so you can compare findings one-to-one with official rejection notes.

- ⚡ Fast: full theme scan ≈ 0.4 s, saving a file re-checks in ≈ 65 ms — never blocks the editor (live as-you-type checking available via `sallaReview.runOnType`)
- 📴 Private: everything runs locally; internet is used only for the npm version check and reference updates
- 🧩 Works with classic themes (`twilight.json`) and component bundles (`twilight-bundle.json`)

---

## Getting Started

1. Open your theme folder in VS Code — the extension activates automatically.
2. Open the **Problems** panel (`Ctrl+Shift+M`) and click any finding to jump to its line.
3. Save a file — it is re-checked instantly.
4. Before submitting: `Ctrl+Shift+P` → **Salla Review: Generate Report** for a shareable
   Markdown report in the reviewers' own format.

The status bar shows `✓ Salla` when your theme is clean, or a live error/warning tally.

---

## What It Checks

Everything below was a real rejection reason. 🔴 blocks approval, 🟡 needs fixing or
review, 🔵 is advisory.

### Texts & translation
| | Check |
|---|---|
| 🔴 | **Hardcoded UI texts** — user-visible strings not going through `trans()` (Twig) or `salla.lang` (JS). Catches multi-line markup, `innerHTML`/`alert`/`salla.notify`/jQuery sinks, and CSS `content:`. Attributes (`alt`, `placeholder`…), comments, hidden elements, and `<salla-*>` markup are never reported |

### Twig
| | Check |
|---|---|
| 🔴 | **Block balance** — `{% if %}` / `{% for %}` / `{% macro %}`… left unclosed, closed without an opener, or mismatched (`endfor` closing an `if`) |
| 🔴 | **Variable naming** — Twig variables must be lower-case snake_case (`sectionId` → `section_id`); checked at `{% set %}`, `{% for %}` targets, and `{% macro %}` names/arguments, with a Quick Fix that renames across the file |
| 🔴 | **Unsafe division** — dividing by a `|length`-derived variable with no `max(1, x)` or `{% if %}` guard (crashes the page on empty lists) |
| 🔴 | **Merge conflict markers** — unresolved `<<<<<<<` in any file, including `public/` |

### Structure & platform requirements
| | Check |
|---|---|
| 🔴 | **salla-scopes placement** — must appear exactly once, in `master.twig` |
| 🔴 | **Required hooks** — the 8 hooks Salla demands in product and page templates |
| 🔴 | **Required components** — the 15 `salla-*` components Salla expects (user menu, cart coupons, order buttons, …) |
| 🔴 | **Theme structure** — the `public/` build output must exist in the repository |
| 🔴 | **Twilight package versions** — `@salla.sa/twilight*` must be within 5 releases of the npm latest |

### twilight.json
| | Check |
|---|---|
| 🔴/🟡 | **Manifest integrity** — every field has a valid id; component paths point to real files; settings defined but never used; `theme.settings.get()` of undefined settings; component fields never used in their component |

### Security & policy
| | Check |
|---|---|
| 🔴/🟡 | **Security** — requests to non-Salla domains (error); `document.cookie` and sensitive storage keys (warnings for review) |
| 🔴 | **Merchant custom code** — settings fields or injections that let the merchant run raw JS/CSS/HTML (automatic rejection) |
| 🔴 | **Fake engagement** — live-viewer/purchase counters Salla explicitly rejects |

### Code quality
| | Check |
|---|---|
| 🔴 | **JS syntax** and **CSS/SCSS brace balance** (brace balance off by default — `sallaReview.checks.cssBraces`) |
| 🟡 | **CSS variables** — defined but never used, or used but never defined (definitions in Twig, CSS, and JS all count). Off by default — `sallaReview.checks.cssVariables` |
| 🔵 | **Hardcoded colors** — HEX values and Tailwind palette classes that should come from theme settings. Off by default — `sallaReview.checks.colors` |
| 🟡 | **Theme size** — estimated compressed size vs. Salla's 1 MB limit |

Bundle projects additionally get: multilanguage fields without a `localizedString` resolver,
`console.log` in production code, `unsafeHTML`, missing `dist/`, and missing `vite.config`.

---

## Your Own Rules

Salla adds review rules faster than any extension can ship. When that happens you do not
have to wait for an update — **define the rule yourself**, and the editor, the git hooks,
and CI enforce it exactly like a built-in check.

Run **Salla Review: Edit Custom Rules**. It creates `salla-rules.json` in your theme
(with a documented template) and opens it. Save the file and the rules apply immediately.
Commit it so your whole team gets them.

```jsonc
{
  "rules": [
    {
      "id": "no-external-fonts",
      "name": "No external font CDNs",
      "message": "Bundle fonts locally instead of loading them from Google",
      "severity": "error",              // error blocks commits and CI
      "files": "src/views/**/*.twig",
      "forbid": "fonts\\.(googleapis|gstatic)\\.com"
    },
    {
      "id": "require-loyalty-widget",
      "name": "Loyalty widget is now mandatory",
      "files": "src/views/**/*.twig",
      "require": "<salla-loyalty-widget",
      "scope": "theme",                 // must appear in at least one file
      "severity": "error",
      "docs": "https://docs.salla.dev/"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Unique identifier (required) — letters, digits, `-`, `_`, `.` |
| `forbid` | Regular expression — **every match is reported**, with its line |
| `require` | Regular expression that **must be present** |
| `scope` | For `require`: `file` = every matching file must contain it, `theme` = at least one file must |
| `files` | Which files to check — same four pattern forms as `exclude`; default: everything scanned |
| `severity` | `error` (blocks commits/CI) · `warning` · `info` — default `warning` |
| `name`, `message`, `docs` | Shown with the finding so the fix is obvious |
| `ignoreCase` | Match case-insensitively (default `false`) |
| `skipComments` | Ignore matches inside comments (default `true`) |

Mistakes in the rules file — a missing `id`, a duplicate, an invalid regular expression,
malformed JSON — are reported **on the rules file itself**, so a broken rule is never
silently skipped. Comments and trailing commas are allowed.

---

## The Report

**Salla Review: Generate Report** writes `reports/<theme>-report.md` and opens it:
a summary table first (total, count per type, severity), then findings grouped by type —
most severe first — each with file, line, and a context snippet. It also includes a
comparison against the official **theme-raed** reference: platform components and APIs
Raed uses that your theme doesn't.

---

## Commit / Push / Merge Gates

Run **Salla Review: Setup Git & CI Checks** once. It adds to your repository:

| | Gate |
|---|---|
| `.githooks/pre-commit` | Fast local check — blocking findings stop the commit |
| `.githooks/pre-push` | Full check including package versions — stops the push |
| `.github/workflows/salla-review.yml` | Checks every push and pull request on GitHub |

The GitHub check reports like Salla's own TwilightCI: a check table in the run summary
(*"❌ 2 of 9 checks failed · commit `065b8e7`"*) with What-to-fix details, plus inline
annotations on the exact lines in the Files changed view. GitHub notifies the commit
author automatically when the check fails. Require the check in branch protection to
gate merges.

Everything is self-contained — teammates and CI need nothing installed. Commit the
generated files; each teammate runs `git config core.hooksPath .githooks` once after
cloning. Bypass a gate when needed with `--no-verify` or `SALLA_REVIEW_SKIP=1`.

Configure the gates in **Settings → Git & CI Checker**: which hooks and workflow to
generate, and whether `error`, `warning`, or `any` findings block.

---

## Commands

| Command | Action |
|---|---|
| **Salla Review: Review Themes** | Full scan of every theme in the workspace |
| **Salla Review: Generate Report** | Write and open the Markdown report |
| **Salla Review: Edit Custom Rules** | Create/open the theme's own rules file |
| **Salla Review: Setup Git & CI Checks** | Scaffold the commit/push/merge gates |
| **Salla Review: Update Raed Reference** | Refresh the theme-raed reference from GitHub now |
| **Salla Review: Clear Problems** | Remove all diagnostics |

---

## Settings

Open **Settings → Extensions → Salla Review**. Eight collapsible sections: General,
Scan Scope (Exclude), Checks, Twig Checks, Raed Reference Checks, Bundle Projects Only,
Git & CI Checker, and Custom Rules. **Every check has its own checkbox**, and every setting can be set
**per project** in the theme's own `.vscode/settings.json` — commit that file and your
team, the git hooks, and CI all enforce the same rules.

### Excluding files and folders

`sallaReview.exclude` accepts four pattern forms:

| Form | Example | Matches |
|---|---|---|
| Folder path | `src/views/components/custom` | The folder and everything beneath it |
| Glob | `src/**/*.min.js` | `*` within a folder, `**` across folders |
| Bare name | `vendor` | Any folder or file with that name |
| Regex | `/\.min\.(js\|css)$/` | Tested against the relative path |

```jsonc
// <theme>/.vscode/settings.json
{
  "sallaReview.exclude": ["src/views/components/custom", "/\\.min\\.js$/"],
  "sallaReview.checks.colors": true, // opt in to a default-off check
  "sallaReview.ci.failOn": "error"
}
```

`sallaReview.ignoredTexts` whitelists specific strings from the hardcoded-text check.

---

## Command Line

The same engine runs standalone — useful for scripting or reviewing many themes:

```bash
node .salla-review/cli.js <path> [--fail-on error] [--exclude "p1,p2"] [--no-colors] ...
```

Every check has a `--no-*` flag; `--fail-on error|warning|any` sets the exit-code gate;
the project's `.vscode/settings.json` is applied automatically. (The `.salla-review/`
folder appears after running *Setup Git & CI Checks*.)

---

## The Raed Reference

Several checks compare against **theme-raed**, Salla's official reference theme, which
changes frequently. The extension refreshes its reference fingerprint from GitHub
automatically every 7 days (`sallaReview.raedAutoUpdateDays`), or on demand via
**Salla Review: Update Raed Reference**.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No results at all | Open the theme folder itself — activation needs `twilight.json` in the workspace |
| New settings missing after an update | `Ctrl+Shift+P` → **Developer: Reload Window** |
| A legitimate string keeps getting flagged | Add it to `sallaReview.ignoredTexts` |
| Version check never reports | You're offline, or versions are `workspace:*`/git specifiers — the check won't guess |
| Raed comparison unavailable | Run **Salla Review: Update Raed Reference** |

**Good to know:** a clean run is strong evidence, not a guarantee — Salla's reviewers also
perform visual and store-configuration review that no static tool can replace. Twig
*expressions* inside tags and hand-written fake statistics still need human eyes.

---

## Contact

Built by **Omar Mazen**. Questions, bug reports, or a rejection reason the extension
does not catch yet — reach out:

- Email: omar.mazen.mohammed@gmail.com
- LinkedIn: https://www.linkedin.com/in/omar-mazen/
- GitHub: https://github.com/omar-mazen
