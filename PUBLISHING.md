# Publishing to the VS Code Marketplace

Maintainer notes — this file is excluded from the packaged extension.

## One-time setup

1. **Create the publisher** at https://marketplace.visualstudio.com/manage
   — sign in with a Microsoft account and create publisher id **`omarmazen`**
   (must match `"publisher"` in package.json exactly; ids cannot contain spaces).
2. **Create a Personal Access Token** at https://dev.azure.com
   (any organization) → User settings → Personal access tokens →
   *New Token* → Organization: **All accessible organizations**,
   Scopes: **Marketplace → Manage**.
3. Log in once: `npx @vscode/vsce login omarmazen` (paste the PAT).

## Before each publish

- Bump `"version"` in package.json and add a CHANGELOG.md entry.
- Run the suite: `npm test` (all assertions must pass).
- Recommended for the listing: add a 128×128 `icon.png` and set `"icon": "icon.png"`,
  and add a `"repository"` field pointing to the GitHub repo once it is public.

## Publish

```bash
npx @vscode/vsce publish          # packages and uploads the current version
# or upload a .vsix manually from the manage page:
npx @vscode/vsce package
```

The Marketplace listing renders README.md as the main page and CHANGELOG.md as the
Changelog tab. LICENSE is picked up automatically.

## Technical documentation

Architecture, the engine API, and development/testing docs live in the project history
and the source itself:

- `lib/salla-review-core.js` — the engine: all checks, the facts model, incremental
  state (`createThemeState` / `refreshFileInState` / `stateIssues`), path filters,
  report builder. Every check honors an `opts.*Check !== false` gate.
- `lib/twilight-version.js` — async npm registry check (6-hour cache).
- `lib/raed-updater.js` — rebuilds `lib/raed-manifest.json` from SallaApp/theme-raed
  HEAD via the GitHub tree API (`npm run update-raed`).
- `templates/` — sources for the scaffolded hooks and workflow
  (`{{THEME_DIR}}` / `{{FAIL_ON}}` placeholders).
- `test/run.js` — the regression suite (107 assertions), including a
  zero-false-positive guard against the reference theme. Run after any engine change.
