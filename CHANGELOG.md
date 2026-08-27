# Changelog

## 1.1.0

New check: **Twig variable naming (snake_case)** — Salla's reviewer rejects
camelCase Twig variables ("The `sectionId` variable should be in lower case,
use _ as a separator"), so the extension now catches them before submission:

- Checked at every declaration site: `{% set %}` names (single, multiple, and
  block form), `{% for %}` loop targets, and `{% macro %}` names and arguments.
- Reported as **errors** (documented rejection reason) — they block the CI gate.
- Every finding suggests the corrected name (`columnsMobile` → `columns_mobile`)
  and offers a **Quick Fix** (💡 / Ctrl+.) that renames the variable to its
  snake_case form across the whole file.
- Toggle: `sallaReview.checks.twigNaming` · CLI: `--no-twig-naming`.
- Comments and `{% verbatim %}` content are ignored; snake_case and `_private`
  names are never reported.

## 1.0.2

False-positive fixes for the Hardcoded Color and CSS Variables checks, verified
against 19 real themes:

- **Hardcoded Color** no longer reports HEX values that serve as defaults or
  fallbacks inside Twig expressions — `theme.settings.get('id', '#fff')`,
  ternaries such as `x is not empty ? x : '#fff'`, and `|default('#fff')`.
  A plain literal like `{% set c = '#fff' %}` is still reported.
- **Hardcoded Color** no longer reports Tailwind palette classes behind
  `@apply` (e.g. `@apply border-gray-200`) — they resolve through the tailwind
  config, which themes point at their CSS variables.
- **CSS Variables** no longer mistakes BEM-style class names for variable
  definitions (`.card--title:hover`, `&--modifier:before`, `.--class-name:focus`).
- **CSS Variables** no longer reports `var(--x, fallback)` usages as
  "used but undefined" — the fallback covers the undefined case by design.
  Fallback-less `var(--x)` is still checked.
- **CSS Variables** no longer reports a variable as unused when a Twig template
  overrides it through an inline `style="--x: {{ … }}"` attribute — that is the
  theming-API pattern (default in SCSS, merchant value injected from Twig).
- `--mm-*` (mmenu library) added to the platform-variable exemptions.
- The extension now ships editor defaults that silence VS Code's built-in
  `Unknown at rule @apply` (unknownAtRules) warnings for CSS/SCSS — those come
  from the built-in validator, not from this extension, and are noise in
  Tailwind-based themes.

## 1.0.1

Maintenance release — no rule or behaviour changes; republished for the VS Code
Marketplace.

## 1.0.0 — First stable release

Salla Theme Reviewer checks a Twilight theme against the rules Salla's review team
applies, before submission. The rule set was built from Salla's internal review tool
plus the analysis of 123 real rejection emails (Nov 2025 – Aug 2026).

**What it does**

- **21 built-in checks** — hardcoded UI texts, Twig block balance and unsafe division,
  JS/CSS syntax, `salla-scopes` placement, required hooks and components, theme
  structure, Twilight package freshness, `twilight.json` integrity, CSS variables,
  security, merchant custom code, fake engagement, theme size, hardcoded colors, and
  component-bundle checks.
- **Custom rules** — define your own in `salla-rules.json` when Salla introduces a rule
  this extension does not cover yet; they are enforced exactly like built-in checks.
- **Instant feedback** — full scan ≈ 0.4 s, incremental re-check on save ≈ 65 ms, never
  blocking the editor.
- **Commit / push / merge gates** — one command scaffolds git hooks and a GitHub Actions
  workflow that reports like Salla's own TwilightCI, with inline annotations and a check
  summary. GitHub notifies the commit author when a check fails.
- **One configuration everywhere** — every check has a checkbox, all settings are
  per-project via the theme's `.vscode/settings.json`, and the editor, hooks, and CI all
  read the same file.
- Severity reflects reality: documented rejection reasons are errors and block the gates;
  advisory findings never masquerade as a passing check.

Verified by a 128-assertion regression suite, including a zero-false-positive guard
against the official `theme-raed` reference.


## 0.10.0
- **Custom rules.** Define your own review rules in `salla-rules.json` when Salla
  introduces a rule this extension does not cover yet — `forbid` / `require` patterns
  with your own severity, file scope, and message. The editor, git hooks, and CI all
  enforce them like built-in checks, and saving the file re-applies them instantly.
  New command: **Salla Review: Edit Custom Rules**. Authoring mistakes are reported on
  the rules file itself.
- Fixed: values containing a comment-like sequence (such as the glob
  `src/views/**/*.twig`) were corrupted when reading JSONC files — this affected
  custom rules and `sallaReview.exclude` read from a project's settings by the CLI.

## 0.9.3
- Removed the `sallaReview.include` setting and `--include` flag — `exclude` covers
  the real use case with less confusion. Existing `include` values are ignored.

## 0.9.2
- Fixed: saving a file inside an always-skipped folder (`.salla-review/`, `.githooks/`,
  `node_modules/`, …) triggered an analysis of it — the vendored engine could flag its
  own npm-registry call as a Security finding. The incremental save path now honors the
  same skip list as full scans.

## 0.9.1
- **Severity truth:** findings that are documented rejection reasons are now errors and
  fail the CI check — hardcoded UI texts, missing required components, unsafe Twig
  division, requests to unapproved external domains, and `theme.settings.get()` of
  undefined settings. Previously they were warnings, so a theme that would be rejected
  could still show a passing check.
- The CI summary no longer says "passed" when warnings exist — it reads
  "No blocking errors, but N warnings — review them before submitting".
- Single-theme runs no longer print the multi-theme roll-up lists.

## 0.9.0
- New **Git & CI Checker** settings section: choose which gates "Setup Git & CI Checks"
  generates (pre-commit hook, pre-push hook, GitHub workflow) and which finding level
  blocks (`error` / `warning` / `any`).
- Marketplace release preparation: publisher **omar-mazen**, MIT license, user-focused
  documentation.

## 0.8.0
- TwilightCI-style CI output: the generated workflow posts a named check table in the run
  summary ("X of 9 checks failed · commit …") with What-to-fix details and per-check fix
  hints, plus inline error/warning annotations on the exact lines in the Files changed
  view. GitHub notifies the commit author automatically on failure.
- New **Theme Structure** check: the `public/` build output directory must exist and be
  non-empty in the repository.

## 0.7.0
- Commit / push / merge gates: **Setup Git & CI Checks** scaffolds a self-contained engine
  copy, pre-commit and pre-push hooks, and a GitHub Actions workflow into the theme
  repository.
- CLI: `--fail-on` exit-code gate, `--no-report`, and automatic loading of the project's
  `.vscode/settings.json` so the editor, hooks, and CI enforce identical rules.

## 0.6.0
- All settings, commands, and documentation in English with self-explanatory descriptions.
  Diagnostics and reports intentionally remain Arabic to match Salla's review language.

## 0.5.x
- A checkbox for every check (21 toggles) with matching CLI flags.
- Per-project include/exclude patterns: folder paths, globs, bare names, and regex.
- Settings organized into collapsible categories; bundle checks limited to bundle projects.

## 0.4.x
- Performance overhaul: in-process syntax checking and an incremental engine — full scan
  ≈ 0.4 s, saves ≈ 65 ms, the editor never blocks.
- New checks: Twig block balance, twilight.json integrity, CSS variables, hardcoded colors.

## 0.3.0
- Checks distilled from the analysis of 123 real rejection emails: Twilight package
  version window, required hooks and components, fake-engagement phrases, theme size,
  unsafe Twig division, merge-conflict markers, and bundle checks.
- Raed reference auto-updates from GitHub.

## 0.2.0
- Document-wide text extraction (multi-line and bare-line texts, markup-embedded JS
  strings, additional UI sinks); removed early-exit behaviors that hid findings.

## 0.1.0
- Initial release: Salla's review rules as a VS Code extension, with a regression suite.
