---
phase: 05-cwd-display
plan: 02
status: complete
---

## Summary: CwdBar Preact Component

### What was built

1. **CwdBar component** (`media/components/composer/CwdBar.tsx`) — Preact component showing folder icon (inline SVG) + folder name above the Composer input. Uses `getCwd()` for full path (with fallback to `workspaceFolders[0]`) and `getWorkspaceFolderName()` for display name. Hidden when `showCwdBar` signal is false. Full path shown as tooltip via `title` attribute.

2. **CSS styles** (`media/styles/composer.css`) — Added `.cwd-bar`, `.cwd-icon`, and `.cwd-name` classes with flex layout, 11px font, text overflow ellipsis handling, and secondary text color.

3. **Composer integration** (`media/components/composer/Composer.tsx`) — Imported and rendered `<CwdBar />` between `<AttachedFiles>` and `<div class="composer-input-row">`.

### Requirements covered

- **CWD-01**: Folder icon + folder name visible above Composer input
- **CWD-02**: Full absolute path as tooltip on hover
- **CWD-03**: Hidden when `iflow.showStatusBar` is false (via `showCwdBar` signal from Plan 01)
- **CWD-04**: Reactive updates when conversation switches or CWD changes

### Verification

- `npm run compile` — passed
- `npm run test:unit` — 340 passing, 4 pending, 0 failing

### Commits

1. `36c50d8` — feat(cwd): add CwdBar component with folder icon, name, and tooltip
