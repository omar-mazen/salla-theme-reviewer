# Changelog

## 1.3.0

### Performance — nothing blocks the editor any more

Opening a workspace froze the window for the duration of the startup scan, every
save cost 200 ms+ of extension-host time, and the Git view stalled while any of
it ran. All three had the same cause: the entire analysis ran synchronously on the
extension-host thread (shared with the Git extension), and every refresh
re-rendered the diagnostics of every file in the theme.

- **Review worker thread.** The engine now runs in `lib/review-worker.js` on its
  own thread. The extension host only posts small messages and renders the
  replies, so scans never block the editor, the SCM view, or other extensions.
  If the worker dies it is restarted (up to 3 times), then the same engine runs
  in-process, chunked, as a last resort.
- **Delta diagnostics.** A refresh reports only the files whose findings changed
  (plus the ones that became clean); the editor applies them in one batched
  `DiagnosticCollection.set()` call instead of one message per file. Saving a
  file touches that file only.
- **Engine reads each file once.** Every per-file check now shares one
  in-memory view of the file (raw lines, comment-stripped lines, masked source,
  line index, Twig tags) — previously a Twig file was read from disk ~10 times
  and comment-stripped ~6 times per scan. The cross-file checks (scopes, CSS
  variables, manifest, required hooks/components, bundle checks) never touch the
  disk on an incremental refresh: they read the facts and file lines kept in
  memory, and `twilight.json` is parsed once per scan.
- **One directory walk per full scan** (was six: root discovery, project root,
  file list, scopes, size estimate, public/ conflict scan), with a single stat
  per file; theme discovery goes through the workspace search service
  (ripgrep) instead of a synchronous walk of every workspace folder.
- **`public/` is never touched.** The build output is no longer entered at all —
  not reviewed, not read for merge-conflict markers, not counted in the size
  estimate (previously every built text file up to 3 MB was read on each full
  scan). Only the Theme Structure check still verifies that the folder exists
  and is not empty.
- **Cheaper editor hooks.** Settings are cached per workspace folder (the
  keystroke listener no longer rebuilds ~35 settings per key press), closing a
  clean tab no longer triggers a refresh, and "Save All" produces one engine
  round-trip per theme instead of one per file. The Twig Naming quick fix builds
  its whole-file edit only when the action is actually invoked.
- **Algorithmic fixes.** Line numbers via the shared line index instead of
  `slice().split()` per match; per-line color/variable scans no longer slice the
  line for every match (quadratic on minified single-line CSS); Twig division
  guards evaluated once per variable instead of per line; `stateIssues()` is
  memoized per refresh.
- **Minified/generated assets** vendored under `src/` (`*.min.js`, `*.min.css`, or
  any file with a line longer than 4000 characters) are exempt from the per-line
  UI-text, color, security, and syntax checks; conflict markers, CSS-variable
  facts, and custom rules still apply to them.
- Twilight package versions: the three npm registry lookups run in parallel and
  are shared across themes checked at the same time.
- `⏱` timing lines for every scan and refresh (engine time, files rendered) in
  the **Salla Review** output channel, and `node scripts/bench.js <theme>` for
  measuring the engine outside the editor.
- Removed unreachable code (`checkRequiredHooks`, `checkRequiredComponents`,
  `checkMergeConflicts` — superseded by the facts-based versions).

Measured on a synthetic 346-file theme (Windows, Node 22, engine time only):

| | full scan | save refresh (engine) |
|---|---|---|
| 1.2.0, default checks | 1629 ms — on the editor thread | 41 ms — on the editor thread |
| 1.3.0, default checks | 553 ms — on the worker thread | 5 ms (≈ 6 ms round-trip) |
| 1.2.0, every check on | 2183 ms | 62 ms |
| 1.3.0, every check on | 587 ms | 10 ms (≈ 15 ms round-trip) |

The CLI and git hooks use the same faster engine.

## 1.2.0

### New defaults — noisy checks are now opt-in

The following are **off by default**; enable them per project in
`.vscode/settings.json` (e.g. `"sallaReview.checks.colors": true`):

- `sallaReview.checks.colors` (hardcoded HEX/Tailwind colors)
- `sallaReview.checks.cssBraces` (CSS/SCSS brace balance)
- `sallaReview.checks.cssVariables` (unused/undefined CSS custom properties)
- `sallaReview.ci.preCommitHook` and `sallaReview.ci.prePushHook` — "Setup Git &
  CI Checks" now generates only the GitHub workflow unless the hooks are enabled

The CLI applies the same defaults, so the editor, git hooks, and CI stay in
agreement; `--no-*` flags still only disable.

### Optional live checking

- New setting `sallaReview.runOnType` (default off): re-analyze against the
  unsaved editor buffer after a ~1s typing pause, no save needed — all checks
  work on live content, including the cross-file ones and the Twilight
  package-version check when editing `package.json`. Saving or closing the file
  switches the analysis back to the on-disk content. Off by default because
  per-keystroke re-checks can affect responsiveness on large themes; the default
  on-save mode stays instant (~65ms). When off, the keystroke listener does no
  work at all.

## 1.1.1

- Fixed: after updating the `@salla.sa/twilight*` versions in `package.json`, the
  "outdated Twilight package" error kept showing its stale, pre-edit result until a
  full re-scan or window reload. Saving `package.json` now recomputes the Twilight
  Version findings immediately (the npm registry lists stay cached; only the
  project's declared versions are re-read).

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
