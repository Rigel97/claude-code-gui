# Claude Code GUI

A futuristic desktop GUI for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — streaming chat, tool-call visualization, line-level diffs, file tree, cross-session search, and a cost dashboard.

一个为 Claude Code CLI 打造的科技感桌面图形界面：流式对话、工具调用可视化、行级 Diff、文件树、跨会话搜索与成本仪表盘。

---

## Features

- **Streaming Chat** — Real-time token-by-token rendering via the CLI's `stream-json` output, with expandable thinking blocks. Immutable state updates + `React.memo` keep long conversations smooth during streaming
- **Tool Call Visualization** — Bash, Read, Write, Edit and other tool calls rendered as collapsible cards with status indicators; sub-agent (`Task`) output nests under its parent call
- **Line-level Diff View** — `Edit` / `Write` / `MultiEdit` calls show red/green diffs with collapsible context (custom LCS diff engine, degrades gracefully on huge files)
- **File Tree Sidebar** — Browse the project directory, click a file to insert an `@path` reference into the input
- **Slash Commands** — Type `/` for quick prompts: `/review`, `/fix`, `/test`, `/commit`, `/clear` and more
- **Message Queue** — Typed messages during a running generation queue up and auto-send when it completes; the queue is dropped on error/abort so it never bleeds into your next instruction
- **Cross-session Search** — `⌘F` / `Ctrl+F` searches all archived sessions plus the current unarchived one, with jump-to-message and highlight
- **Cost Dashboard** — Per-day spending chart (last 14 days, local timezone), token usage totals, and top-spending sessions
- **Context Water Meter** — Live context-window usage in the status bar; turns yellow at 60% and red at 85% to nudge you toward a fresh session
- **Session Persistence** — History, costs and settings survive restarts. Unarchived (interrupted) conversations are preserved as drafts and remain resumable via `--resume`; multi-turn conversations reuse the same CLI session
- **Background Notifications** — System notification with a snippet of your prompt when a task finishes while the window is not focused
- **Interrupt Anytime** — Stop button or `ESC` aborts a running generation; the child process is SIGTERM'd with a SIGKILL fallback (taskkill tree-kill on Windows)
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

1. Click **选择项目目录** to pick a working directory — the CLI will run there
2. Type a message and press `Enter`; `Shift+Enter` for newline
3. Type `/` to open the slash-command palette; `ESC` to interrupt a running task
4. Messages typed while generating join the queue and auto-send on completion
5. `⌘F` / `Ctrl+F` opens cross-session search
6. Switch to the **文件** tab in the sidebar to browse files and insert `@references`
7. Click **TOTAL COST** (bottom-left) to open the cost dashboard

### Permission Modes

In non-interactive (`-p`) mode the CLI needs a permission mode, configurable in **Settings**:

| Mode | Behavior |
|------|----------|
| `bypassPermissions` (default) | All tool calls auto-approved — use only in projects you fully trust |
| `acceptEdits` | File edits auto-approved; shell commands etc. may still be rejected |

## Tech Stack

- **Electron** — main process spawns the CLI with `-p --output-format stream-json --verbose`, parses NDJSON from stdout, forwards events over IPC
  - Process lifecycle is generation-isolated: a new prompt waits for the previous process to fully exit; stale stdout after an abort is discarded
  - Security hardening: context isolation, no nodeIntegration in the renderer, navigation/window-open intercepted so markdown links only ever open externally via the system browser
  - Single-instance lock; a second launch focuses the existing window
- **React 18 + TypeScript** — renderer UI
- **Zustand** — state management. Streaming shards of the same CLI message are merged by `message.id`; different messages never concatenate
- **Persistence** — a small custom JSON store in `userData` with atomic writes (tmp + rename) and content-diffing to skip redundant disk writes; the renderer persists on a 3s throttle with a `beforeunload` flush
- **Tailwind CSS** — dark sci-fi theme
- **Vite** — renderer build; **Vitest** — unit tests

```
src/
├── main/          # Electron main process (CLI runner, IPC, file tree, persistence)
└── renderer/      # React app (chat, diff view, file tree, dashboard, effects)
tests/             # Vitest suites: store state machine, diff engine, runner lifecycle
```

## Testing

35 unit tests cover the trickiest logic, all runnable without a display or a real Claude session:

- `tests/store.test.ts` — message merging by `message.id`, cost accounting, malformed-event hardening, unarchived-conversation protection, immutability guarantees that `React.memo` relies on
- `tests/diff.test.ts` — LCS diff correctness, degenerate fallback for huge inputs, context folding
- `tests/runner.test.js` — real subprocess lifecycle: normal completion, abort-and-resend isolation, SIGKILL fallback, invalid cwd

## Notes

- Model selection is passed through as `--model`; leave it empty to use your CLI default
- Session data is stored locally in `userData/claude-gui-config.json`; nothing is uploaded anywhere
- macOS fully supported; Linux should work out of the box; Windows support is implemented (`.cmd` shim launch via `cmd.exe`, `taskkill` tree-kill) but untested — contributions welcome

## License

MIT
