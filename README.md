# Claude Code GUI

A futuristic desktop GUI for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — multi-tab parallel conversations, image input, streaming chat, tool-call visualization, line-level diffs, file tree, cross-session search, and a token usage dashboard.

一个为 Claude Code CLI 打造的科技感桌面图形界面：多标签页并行对话、图片粘贴输入、流式输出、工具调用可视化、行级 Diff、文件树、跨会话搜索与 Token 用量统计。

---

## Features

- **Multi-tab Parallel Conversations** — Run several sessions side by side in one window; each tab has fully isolated state (messages, queue, context meter, input draft) and its own CLI process. Background tabs keep streaming and auto-continue their message queues
- **Streaming Chat** — Real-time token-by-token rendering via the CLI's `stream-json` output, with expandable thinking blocks. Immutable state updates + `React.memo` keep long conversations smooth during streaming
- **Image Input** — Paste screenshots (⌘V) straight into the input; they are saved to a temp dir and attached as `@path` references. Drag-and-drop of files works too
- **Copy Anything** — All message content (replies, thinking, tool output) is selectable; hover any message for a one-click copy button below its final reply; standard Edit menu roles make ⌘C/⌘A reliable on macOS
- **Tool Call Visualization** — Bash, Read, Write, Edit and other tool calls rendered as collapsible cards with status indicators; sub-agent (`Task`/`Agent`) output nests under its parent call
- **Line-level Diff View** — `Edit` / `Write` / `MultiEdit` calls show red/green diffs with collapsible context (custom LCS diff engine, degrades gracefully on huge files)
- **File Tree Sidebar** — Browse the project directory, click a file to insert an `@path` reference into the input
- **Slash Commands** — Type `/` for quick prompts: `/review`, `/fix`, `/test`, `/commit`, `/clear` and more
- **Message Queue** — Typed messages during a running generation queue up and auto-send when it completes, per tab; failed turns drop their queue so it never bleeds into your next instruction
- **Cross-session Search** — `⌘F` / `Ctrl+F` searches all open tabs plus archived sessions; jump-to-message routes to the right tab and highlights the hit
- **Token Usage Dashboard** — Per-day usage chart (last 14 days, local timezone) with input/output breakdown, totals, and top-consuming sessions
- **Context Water Meter + One-click Compact** — Real context-window usage from the CLI's zero-cost `/context` query, shown as absolute values (`19K/200K`) with free-space and autocompact-buffer details on hover; click the archive icon next to it to compact a session when it runs high
- **Failed Retry & Session Rename** — A retry button on the latest failed message removes that turn and resends it; rename sessions inline from the sidebar
- **Session Persistence** — Tabs (including input drafts), history and settings survive restarts. Interrupted conversations are archived as drafts and remain resumable via `--resume`
- **Background Notifications** — System notification with a snippet of your prompt when a task finishes while the window is not focused
- **Interrupt Anytime** — Stop button or `ESC` aborts the active tab's generation (other tabs keep running); the child process is SIGTERM'd with a SIGKILL fallback (taskkill tree-kill on Windows)
- **Cyberpunk UI** — Particle network background that speeds up while generating, scan lines, glow effects (Tailwind CSS)

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

1. Click **选择项目目录** to pick a working directory — new conversation tabs snapshot it (already-running tabs are unaffected)
2. Hit **＋** in the tab bar to open a new conversation tab; tasks in different tabs run in parallel
3. Type a message and press `Enter`; `Shift+Enter` for newline; paste screenshots with ⌘V; type `/` for slash commands; `ESC` interrupts the active tab only
4. Messages typed while generating join that tab's queue and auto-send on completion
5. `⌘F` / `Ctrl+F` searches across all open tabs and archived sessions
6. Click a session in the sidebar to open it as a tab (already-open sessions just activate); hover for rename / export / delete
7. Click **TOKENS** (bottom-left) to open the usage dashboard; hover the context meter for details, click the 📦 icon next to it to compact the session

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

56 unit tests cover the trickiest logic, all runnable without a display or a real Claude session:

- `tests/store.test.ts` — message merging by `message.id`, per-tab state isolation & event routing, background queue continuation, close-tab draft archiving, hydrate migration from the legacy single-session format, malformed-event hardening, immutability guarantees that `React.memo` relies on
- `tests/diff.test.ts` — LCS diff correctness, degenerate fallback for huge inputs, context folding
- `tests/runner.test.js` — real subprocess lifecycle: normal completion, abort-and-resend isolation, SIGKILL fallback, invalid cwd, and parallel multi-runner generation with per-conversation event tagging

## Notes

- Model selection is passed through as `--model`; leave it empty to use your CLI default
- Session data is stored locally in `userData/claude-gui-config.json`; nothing is uploaded anywhere
- macOS fully supported; Linux should work out of the box; Windows support is implemented (`.cmd` shim launch via `cmd.exe`, `taskkill` tree-kill) but untested — contributions welcome

## License

MIT
