# Changelog

## 1.8.1

### False positives found by testing against 20 shipped themes

Running the new checks over twenty real Salla themes surfaced four ways they
reported problems that were not there. Every fix is covered by a regression test.

- **Dot-notation template paths.** Twilight addresses templates as
  `{% extends "layouts.master" %}`, not with slashes — 864 uses to 1 across the
  20 themes. The new reference check only understood slash paths and reported
  **698 non-existent problems**; both forms (and the hybrid
  `components.custom.button.twig`) now resolve. The same resolver backs the
  include-following added in 1.6.0, which therefore never worked on a real
  theme either.
- A path concatenated at render time (`{% include "pages." ~ name %}`) is no
  longer reported: the operator sits outside the quotes, so the captured
  fragment ends on a separator.
- **`limit` / `json_encode` are required only of section-driven components.**
  Checklist §8 describes the homepage sections; a listing wired to a fixed
  source (`source="latest"`, `source="wishlist"`) or to a single page id on a
  brand or category page is a different, legitimate usage.
- **`salla-order-totals-card` is an order-page component.** The checklist text
  groups it under "Cart", but 18 of the 20 themes place it in
  `customer/orders/single.twig` and none in `cart.twig`.
- `theme.settings.get("id", fallback)` on an undefined setting is now a warning
  saying the value always falls back and the merchant gets no control — not an
  error claiming it "returns empty", which was untrue whenever a default is passed.

Two findings independently reproduced live rejection emails: an unclosed
`{% block %}` at `loyalty.twig:36`, and «يشاهد هذا المنتج» in `twilight.json`
together with `src/locales/ar.json` — the same files Salla quoted.


## 1.8.0

### Salla's publishing acceptance checklist, implemented

The official checklist names requirements the extension did not cover. Each item
below cites its section.

- **Broken template references (§7).** Every static `{% include %}`, `{% embed %}`,
  `{% extends %}`, `{% import %}` and `include()` must point at a Twig file that
  exists — a typo renders an empty page. Paths resolve the way Twig does: from
  `src/views`, then relative to the including file. Reported as an error.
- **Product card performance (§9).** `salla.product.getDetails()` inside a card or
  product-list template fires one request per card while the list renders. Salla
  permits the call only after a customer interaction — a Quick View, or a popup
  opened by a click.
- **Product lists and sliders (§8).** The check now covers `salla-products-list`
  as well as `salla-products-slider`, and reports `source-value` passed without
  `json_encode` and a component wired to a section with no `limit`, alongside the
  existing map/join finding.
- **Required components (§3), rebuilt from the checklist.** `master.twig` now
  requires `salla-offer-modal`, `salla-login-modal`, `salla-search` and
  `salla-add-product-toast`; the header keeps `salla-cart-summary` and
  `salla-user-menu`; cart, orders, thank-you and product-options gained the
  components the checklist lists. Pages the checklist marks *as applicable*
  (product page, category filters, orders index, account, loyalty) are checked
  only when the theme actually has them, and report as warnings — a theme with no
  wallet page is never told to add `salla-wallet`.
- **`document.cookie` is now an error (§5)** — the checklist forbids it outright
  rather than asking for review.
- **Public vs private submissions (§1, §6).** New `sallaReview.themeVisibility`:
  a private theme gets the 2 MB packed limit instead of 1 MB, and hardcoded UI
  text drops to a warning (Salla may exempt private themes, though translation
  support stays best practice).

CLI flags `--no-template-refs` and `--no-product-card` disable the two new
checks; both are on by default and need no network.

## 1.7.0

### Three more rejection reasons the checks used to miss

From four fresh rejection emails.

- **Rejected wording is now looked for outside code.** «يشاهد هذا المنتج» was
  quoted from `twilight.json` (a setting label) and from `ar.json` (a locale
  file) in three separate rejections, while the check only ever read Twig and
  JS — so it saw none of them. JSON files are now scanned: `twilight.json`,
  locale files and any other theme JSON. Generated lockfiles
  (`package-lock.json`, `*-lock.json`) stay out, and the custom-rules file is
  exempt so a rule that *forbids* a phrase is not reported for containing it.
  Unresolved merge-conflict markers inside JSON are caught for the same reason —
  those files were previously never opened at all.
- **The identifier behind the feature is reported too.** A phrase can be
  translated away while the setting driving a live-viewer counter stays, so keys
  such as `live_viewers_enabled`, `viewers_count` and `watching_now` are flagged
  as a warning. Deliberately narrow: `viewed_products`, `reviewers` and
  `review_count` are legitimate and are left alone.
- **`salla-search` belongs in `layouts/master.twig`, not `header.twig`.**
  Webview mode hides the header and the footer, so a component that lives only
  there is unreachable — "وجودها في الهيدر/الفوتر وحده غير كافٍ". The finding
  now names master.twig, explains why, and links the reference implementation in
  theme-raed. `salla-cart-summary-card` carries its PR reference (962) as well.
- The fake-engagement phrase list gained the other wordings the emails quote
  (`يشاهدون الآن`, `شخصًا يشاهد`, `people are watching`, …).

## 1.6.0

### "Send to Agent" buttons, and delivery to the assistant you actually use

**A Salla Review panel, next to Problems.** VS Code offers extensions no way to
add buttons to its built-in Problems panel — there is no menu contribution point
for it, which is why editors that ship those buttons (Antigravity) do it by
forking the workbench itself. So the findings are mirrored into a view of our
own, in the panel area beside Problems, where every row carries an action:

- ✨ on a single finding → sends that finding.
- ✨ on a file row → sends every finding in that file.
- ✨ in the view's title bar → **Send all to Agent**, the whole theme.

Rows are read straight back out of the diagnostics, so the view can never
disagree with the Problems panel, and clicking one jumps to the line.

**A button in the editor too.** Every line with a finding now shows a
`🤖 أرسل إلى الوكيل` CodeLens above it (`sallaReview.agentCodeLens`, on by
default), so a finding can be handed over without leaving the code. The 💡 Quick
Fix entries and the Command Palette commands from 1.5.0 still work, and the
right-click menu gained *Send This File's Findings to AI Agent*.

**A one-click button in the status bar.** Next to the finding counts:
`✨ أرسل N إلى الوكيل` sends the whole theme, from anywhere in the editor,
without opening a panel first.

**It goes to the chat that is actually open — nothing is asked.** The installed
extensions are inspected (each declares its commands in its own `package.json`),
and the destination follows what is on screen: the focused chat first, then any
open chat, then a merely installed assistant. "Is the extension active" is
deliberately *not* used as the signal — Claude Code activates on
`onStartupFinished`, so it counts as active from the moment the window opens
whether or not its chat was ever shown, which would send everything to Claude
even with Copilot's chat in front of you. Known assistants are addressed through
their real command ids, and anything else is matched generically, so an agent
nobody hard-coded still works. The button in the status bar names its
destination (`✨ أرسل 3 إلى Claude Code`) so it is never a surprise, and
*Salla Review: Select AI Agent* pins one — or restores **تلقائي**, which follows
the open chat again. `sallaReview.agentCommand` still overrides everything.

**The files are referenced in the conversation, for one finding or for all.**
Claude Code's own @-mention (alt+K) reads the focused editor's selection and
drops `@path#Lline` into its chat input. Sending now does exactly that for every
file that has findings — each is briefly opened with its first finding selected,
the mention is inserted, and the editor you were on is restored — so
**Send all to Agent** puts the whole review in the conversation instead of
leaving a clipboard note. One mention per file (capped at 25), and the full
finding text still goes to the clipboard for the paste.

Assistants differ in what they accept, and that difference is handled honestly:

- **Copilot Chat** takes the task as a command argument, so it is sent and the
  chat opens with it already there.
- **Claude Code** contributes no command that accepts a prompt — the most it
  offers is opening and focusing its input — so its input is focused, the task
  is on the clipboard, and the status bar says to press `Ctrl+V`. There is no
  public API to type into another extension's chat; an editor that does this
  seamlessly (Antigravity) ships its own agent.

The task is placed on the clipboard every time regardless, so a terminal agent
such as the Claude Code CLI is always one paste away. `test/agent-detect.js`
covers the ranking against real extension manifests.

## 1.5.0

### Send findings to an AI agent

Any finding can now be handed to a coding assistant as a ready task, instead of
retyping what it says and where it is:

- **On the finding** — the 💡 lightbulb on the line, and the same entry on the
  row in the Problems panel: *"🤖 أرسل هذه الملاحظة إلى الوكيل لإصلاحها"*. When a
  file has several findings, one more action sends them all together.
- **Commands** — *Salla Review: Send This File's Findings to AI Agent* and
  *Send All Findings to AI Agent* (the latter covers every finding in the theme,
  including the network-based Twilight Version ones).

The task is written as markdown: what the theme is, then each finding with its
type, severity, path and line, the message exactly as the editor shows it, the
concrete fix for that check, and the surrounding code fenced in the file's own
language. It also states the ground rules — change only what a finding requires,
keep the rendered output and wording identical — so an agent does not
"fix" a hardcoded string by rewording the page. Paths are relative to the theme,
so nothing machine-specific leaks into the prompt. Every finding type the engine
can emit has fix guidance, enforced by a test.

VS Code has no single "hand this to the agent" API — each assistant registers
its own command — so the target is resolved against the commands actually
present in the window: `sallaReview.agentCommand` if set, otherwise the built-in
chat view (`workbench.action.chat.open`). If neither is available the task is
copied to the clipboard, with a button to open it as a markdown file, which
works with every assistant including terminal ones such as Claude Code.

The prompt is assembled inside the review worker, where the findings and the
file lines already live, so building it costs the editor nothing.

## 1.4.0

### Fixed: stale findings after an edit made outside the editor

Findings for code that no longer existed stayed in the Problems panel until the
window was reloaded, whenever a file was changed by anything other than an
editor save — an AI agent editing files, `git checkout` / `stash` / `pull`, a
formatter or codemod run from the terminal, or `pnpm install` rewriting a
lockfile. The per-theme file watcher was created with change events ignored, so
only `create` and `delete` reached the engine and edits were seen exclusively
through `onDidSaveTextDocument`. It now watches changes as well, and re-checks
the affected files straight away.

A file being edited live (`sallaReview.runOnType`) with unsaved changes keeps
its editor buffer as the source of truth, so an external write cannot make the
findings jump to line numbers the editor is not showing.

Refreshing many files at once — exactly what an agent edit or a branch switch
produces — now runs the cross-file checks **once for the whole batch** instead
of once per file (a 40-file batch: 171 ms → 70 ms, identical results).

### New check: lockfile in sync with package.json

Bumping a dependency — the `@salla.sa/twilight*` packages in particular, which
this extension itself tells you to update — without re-running the package
manager leaves the lockfile behind, and the theme's CI then dies on install
before a single check runs:

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with <ROOT>/package.json
* 2 dependencies are mismatched:
  - @salla.sa/twilight (lockfile: ^2.14.569, manifest: ^2.14.572)
```

`sallaReview.checks.lockfile` (on by default, no network) compares every
dependency declared in `package.json` against the specifier recorded in the
committed lockfile and reports each mismatched package on its own
`package.json` line, as an error — so the editor, the pre-commit and pre-push
hooks, and the generated GitHub workflow all catch it before CI does. Saving the
refreshed lockfile clears the findings immediately.

- Supports `pnpm-lock.yaml` (v5 `specifiers:` and v6/v9 `importers:` layouts),
  `package-lock.json` (v2/v3), and `yarn.lock` (classic and Berry).
- A package declared in `package.json` but absent from the lockfile is reported
  too, with the same fix.
- Lockfile formats that record no specifiers (npm lockfile v1) and unrecognized
  files are skipped silently rather than reported as mismatches.
- The Twilight Version finding now spells out the follow-up: run the install so
  the lockfile moves with the bump, and commit it alongside the built assets.

### Check accuracy

- **`{% set x %}…{% endset %}` capture blocks are no longer read as UI text.**
  The body of a capture block (typically a bundle of CSS custom properties) is a
  value assigned to a variable, not text rendered to the shopper — it used to be
  reported as a hardcoded UI string. The assignment form `{% set x = … %}` is
  unaffected, and colors inside the block are still checked.
- **Default/fallback colors are now reported as hardcoded colors.** A HEX inside
  `theme.settings.get('id', '#fff')`, `x|default('#fff')` or a ternary fallback
  is the color the shopper actually sees whenever the setting is empty, so it
  belongs in a theme variable like any other literal. These were previously
  skipped. Information-level, and the check stays off by default
  (`sallaReview.checks.colors`). `var(--x, #fff)` CSS fallbacks are unchanged.
- **A macro's own name is a recommendation, not an error.** Salla's rejection
  wording covers *variables*; `{% macro searchButton() %}` has not been rejected
  for its name. It is now Information ("recommended: `search_button`") and keeps
  its rename Quick Fix. Macro *arguments* are variables and stay errors.
- **Component fields used in an included template count as used.** A component
  that renders through a partial and passes its twilight fields down
  (`{% include %}`, `{% embed %}`, `{% import %}`, `{% from %}`, `{% use %}`, and
  the `include()` function, followed transitively) no longer produces "field
  defined but never used" for every field. Applies to home components, templates
  and custom sections alike.
- **Required components must be in their own file.** The reviewer reads the file
  itself, so a required `<salla-*>` element placed in a different file — or
  reached only through an `{% include %}` — is a rejection. The check no longer
  accepts the component anywhere in the theme; it must be in the file it is
  mapped to (required hooks already worked this way).
- **The status bar and the Problems panel now agree.** The counter excluded
  Information-level findings while the panel listed them; it now shows
  `errors 🔴 warnings 🟡 infos 🔵` and its tooltip states the panel total.

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
