# Claude Code GUI

A futuristic desktop GUI for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — multi-tab parallel conversations, image input, streaming chat, tool-call visualization, line-level diffs, file tree, cross-session search, a token usage dashboard, AI session naming, a Git changes panel, a TodoWrite progress panel, a file previewer, and an interactive token-fed pet.

---

## Features

- **Multi-tab Parallel Conversations** — Run several sessions side by side in one window; each tab has fully isolated state (messages, queue, context meter, input draft) and its own CLI process. Background tabs keep streaming and auto-continue their message queues
- **Streaming Chat** — Real-time token-by-token rendering via the CLI's `stream-json` output, with expandable thinking blocks. Immutable state updates + `React.memo` keep long conversations smooth during streaming
- **Image Input** — Paste screenshots (⌘V) straight into the input; they are saved to a temp dir and attached as `@path` references. Drag-and-drop of files works too
- **Copy Anything** — All message content (replies, thinking, tool output) is selectable; hover any message for a one-click copy button below its final reply; standard Edit menu roles make ⌘C/⌘A reliable on macOS
- **Tool Call Visualization** — Bash, Read, Write, Edit and other tool calls rendered as collapsible cards with status indicators; sub-agent (`Task`/`Agent`) output nests under its parent call
- **TodoWrite Progress Panel** — The CLI's `TodoWrite` calls are surfaced as a live checklist under the tab bar: progress bar, per-item status, and the current in-progress task at a glance; the list is rebuilt when reopening an archived session
- **Line-level Diff View** — `Edit` / `Write` / `MultiEdit` calls show red/green diffs with collapsible context (custom LCS diff engine, degrades gracefully on huge files)
- **File Tree Sidebar** — Browse the project directory, click a file to insert an `@path` reference into the input; hover a file and hit the 👁 button to preview it
- **File Previewer** — Modal preview with syntax-highlighted text (512KB cap, binary detection, truncation notice) and inline image preview (png/jpg/gif/webp/bmp/ico)
- **Git Changes Panel** — A fourth sidebar tab showing the current branch and working-tree changes (`M`/`A`/`D`/`?`/staged badges); files Claude touched in the active session get an ✨AI badge, click an entry to expand its unified diff, and revert single files via a confirmed `git checkout --`
- **Slash Commands** — Type `/` for quick prompts: `/review`, `/fix`, `/test`, `/commit`, `/clear` and more
- **Message Queue** — Typed messages during a running generation queue up and auto-send when it completes, per tab; failed turns drop their queue so it never bleeds into your next instruction
- **Cross-session Search** — `⌘F` / `Ctrl+F` searches all open tabs plus archived sessions; jump-to-message routes to the right tab and highlights the hit
- **Token Usage Dashboard** — Per-day usage chart (last 14 days, local timezone) with input/output breakdown, totals, and top-consuming sessions
- **Context Water Meter + One-click Compact** — Real context-window usage from the CLI's zero-cost `/context` query, shown as absolute values (`19K/200K`) with free-space and autocompact-buffer details on hover; click the archive icon next to it to compact a session when it runs high
- **Failed Retry & Session Rename** — A retry button on the latest failed message removes that turn and resends it; rename sessions inline from the sidebar
- **AI Session Naming** — After a session's first completed turn, a low-cost background CLI call generates a concise title in the conversation's language; manually renamed sessions are never overwritten
- **Session Pinning** — Pin favorite sessions to the top of the sidebar (📌); pinned entries survive the session-limit trimming
- **Session Persistence** — Tabs (including input drafts), history and settings survive restarts. Interrupted conversations are archived as drafts and remain resumable via `--resume`
- **Background Notifications** — System notification with a snippet of your prompt when a task finishes while the window is not focused
- **Interrupt Anytime** — Stop button or `ESC` aborts the active tab's generation (other tabs keep running); the child process is SIGTERM'd with a SIGKILL fallback (taskkill tree-kill on Windows)
- **Cyberpunk UI** — Particle network background that speeds up while generating, scan lines, glow effects (Tailwind CSS)
- **Token Pet** — A hand-drawn SVG companion in the sidebar: bunny / cat / bear, click to morph. Evolves through 4 levels with cumulative token usage; bounces while generating, sleeps when idle. Poke it for chatter, tickle it (5 pokes/second) into a laughing roll, feed it (🥕/🐟/🍪 per species) until it's stuffed and chubby, or grab and throw it — it springs back home. It sweats when a tab's context runs high, tilts its head on errors, wears a nightcap after midnight, dozes off on long runs — and on an empty conversation tab it moves to the welcome-screen stage to roam around freely

## Prerequisites

- **Node.js** 18+
- **Claude Code CLI** installed and available in `PATH` (`claude --version` should work)

## Getting Started

```bash
git clone https://github.com/Rigel97/claude-code-gui.git
cd claude-code-gui
npm install
```

**Development mode** (Vite dev server + hot reload):

```bash
npm run dev
```

**Production mode** (build + launch):

```bash
npm start
```

**Run tests**:

```bash
npm test
```

**Package as a distributable** (macOS `.dmg` + `.zip`):

```bash
npm run dist        # outputs to release/
npm run pack        # unpacked app only (faster, for debugging)
```

## Usage

1. Click the project-directory button (on the welcome screen or in the sidebar) to pick a working directory — new conversation tabs snapshot it (already-running tabs are unaffected)
2. Hit **＋** in the tab bar to open a new conversation tab; tasks in different tabs run in parallel
3. Type a message and press `Enter`; `Shift+Enter` for newline; paste screenshots with ⌘V; type `/` for slash commands; `ESC` interrupts the active tab only
4. Messages typed while generating join that tab's queue and auto-send on completion
5. `⌘F` / `Ctrl+F` searches across all open tabs and archived sessions
6. Click a session in the sidebar to open it as a tab (already-open sessions just activate); hover for rename / export / delete
7. Click **TOKENS** (bottom-left) to open the usage dashboard; hover the context meter for details, click the 📦 icon next to it to compact the session
8. Open the **Git** sidebar tab to review what Claude changed this session (✨AI badge) and revert single files; click 👁 in the file tree to preview a file
9. The pet at the bottom of the sidebar is interactive — poke / tickle / feed / throw it; open an empty conversation tab to watch it roam the welcome screen

### Permission Modes

In non-interactive (`-p`) mode the CLI needs a permission mode, configurable in **Settings**:

| Mode | Behavior |
|------|----------|
| `bypassPermissions` (default) | All tool calls auto-approved — use only in projects you fully trust |
| `acceptEdits` | File edits auto-approved; shell commands etc. may still be rejected |

### Custom Endpoints

The model field is passed through verbatim as `--model`, so custom endpoints (GLM, Bedrock, etc.) work by entering the full model ID in **Settings**; leave it empty to follow your CLI default.

## Tech Stack

- **Electron** — main process spawns the CLI with `-p --output-format stream-json --verbose`; a per-tab runner pool runs multiple conversations in parallel, every stream/status event tagged with its `conversationId` for routing; `electronFuses` disables `runAsNode` so the packaged app is immune to `ELECTRON_RUN_AS_NODE` env pollution
  - Security hardening: context isolation, no nodeIntegration in the renderer, navigation/window-open intercepted so markdown links only ever open externally via the system browser
  - Single-instance lock; a second launch focuses the existing window
- **React 18 + TypeScript** — renderer UI
- **Zustand** — state management. Per-conversation isolated state (multi-tab); streaming shards of the same CLI message are merged by `message.id`; events are routed by `conversationId`; different conversations never mix
- **Persistence** — a small custom JSON store in `userData` with atomic writes (tmp + rename) and content-diffing to skip redundant disk writes; the renderer persists on a 3s throttle with a `beforeunload` flush
- **Tailwind CSS** — dark sci-fi theme
- **Vite** — renderer build; **Vitest** — unit tests

```
src/
├── main/          # Electron main process (CLI runner pool, IPC, file tree, persistence)
└── renderer/      # React app (tabs, chat, diff view, file tree, dashboard, effects)
tests/             # Vitest suites: store state machine, diff engine, runner lifecycle
```

## Testing

73 unit tests cover the trickiest logic, all runnable without a display or a real Claude session:

- `tests/store.test.ts` — message merging by `message.id`, per-tab state isolation & event routing, background queue continuation, close-tab draft archiving, hydrate migration from the legacy single-session format, malformed-event hardening, immutability guarantees that `React.memo` relies on
- `tests/diff.test.ts` — LCS diff correctness, degenerate fallback for huge inputs, context folding
- `tests/runner.test.js` — real subprocess lifecycle: normal completion, abort-and-resend isolation, SIGKILL fallback, invalid cwd, and parallel multi-runner generation with per-conversation event tagging

## Notes

- Model selection is passed through as `--model`; leave it empty to use your CLI default
- Session data is stored locally in `userData/claude-gui-config.json`; nothing is uploaded anywhere
- macOS fully supported; Linux should work out of the box; Windows support is implemented (`.cmd` shim launch via `cmd.exe`, `taskkill` tree-kill) but untested — contributions welcome

## License

MIT
