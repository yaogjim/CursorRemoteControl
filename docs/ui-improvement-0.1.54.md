# Web UI Improvement — Version 0.1.54

## User Feedback
User reported two issues after testing v0.1.52:
1. Multiple windows are hard to distinguish (horizontal pill-style bar, visually identical to session tabs)
2. Sessions are not displayed in reverse chronological order (newest on top)

## Solution
Replaced the horizontal window bar + session bar with:
1. **Context Bar** — Always visible breadcrumb showing "Window › Session" with window count
2. **Drawer** — Full-height slide-up panel listing all windows and their sessions

## Design Decisions (User Confirmed)
- **Session ordering**: Use `state.chatTabs` array order directly (assumes Cursor already orders newest first)
- **Drawer behavior**: Auto-close after window switch to return user to main interface
- **New Chat button**: Only show in context bar for current window, simplify interaction

## Implementation
### Files Modified
- `src/client/index.html` — Replace `window-bar` + `tab-bar` with `context-bar` + drawer structure
- `src/client/styles.css` — Add context bar, drawer, window card, and session list styles
- `src/client/app.js` — Rewrite `renderWindows()` + `renderTabs()` → `renderWindowsAndSessions()`
- `.vscodeignore` — Exclude `prototype/` directory from VSIX package

### Key Features
1. **Context Bar** (40px height)
   - Blue-bordered window indicator (icon + title)
   - Window count badge (only shown when multiple windows exist)
   - Current session title with status dot
   - Chevron indicator (▾ closed, ▴ open)
   - New Chat button (+ icon)

2. **Drawer** (50% viewport height, 40% on mobile)
   - Window cards with:
     - Window icon, project name, workspace path
     - "CURRENT" badge for active window, "SWITCH" for others
   - Sessions list (only for current window):
     - Vertical list with 40px row height
     - Status dot (yellow=Running, green=Completed, grey=Idle)
     - Session title + status text
     - Active session highlighted with blue left border
   - Non-current windows show collapsed state: "Tap to switch — sessions load after switching"

3. **Interaction Flow**
   - Click context bar → open drawer
   - Click window header → switch window + close drawer
   - Click session row → switch session + close drawer
   - Click overlay or × button → close drawer
   - New Chat button only affects current window

## Data Constraints
- No `createdAt`/`updatedAt` in `ChatTab` interface
- `state.chatTabs` array order is used directly (no sorting logic)
- Only current window's sessions are available from server
- "12m ago" relative time in prototype is demonstration only (not implemented in 0.1.54)

## Build Output
- Package: `releases/cursor-remote-0.1.54.vsix` (2.0 MB, 23 files)
- TypeScript compilation: ✓ Pass
- Extension build: ✓ Pass
- VSIX verification: ✓ Pass

## Testing Recommendation
1. Install `cursor-remote-0.1.54.vsix` in Cursor/VS Code
2. Open 2-3 Cursor windows with different projects
3. Create multiple chat sessions in each window
4. Check context bar shows current window + session correctly
5. Click context bar to open drawer
6. Verify current window sessions are listed vertically
7. Switch between windows and verify drawer closes automatically
8. Click session rows to switch sessions

## Next Steps (if needed)
- Add localStorage persistence for session first-seen timestamps
- Display relative time (e.g., "12m ago") in session list
- Add session count badge for non-current windows (requires server protocol change)