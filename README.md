# Claude Code GUI

A futuristic desktop GUI for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — streaming chat, tool-call visualization, line-level diffs, file tree, and a cost dashboard.

一个为 Claude Code CLI 打造的科技感桌面图形界面：流式对话、工具调用可视化、行级 Diff、文件树与成本仪表盘。

---

## Features

- **Streaming Chat** — Real-time token-by-token rendering via the CLI's `stream-json` output, with expandable thinking blocks
- **Tool Call Visualization** — Bash, Read, Write, Edit and other tool calls rendered as collapsible cards with status indicators
- **Line-level Diff View** — `Edit` / `Write` / `MultiEdit` calls show red/green diffs with collapsible context (custom LCS diff engine)
- **File Tree Sidebar** — Browse the project directory, click a file to insert an `@path` reference into the input
- **Slash Commands** — Type `/` for quick prompts: `/review`, `/fix`, `/test`, `/commit`, `/clear` and more
- **Cost Dashboard** — Per-day spending chart (last 14 days), token usage totals, and top-spending sessions
- **Session Persistence** — History, costs and settings survive restarts; multi-turn conversations reuse the same CLI session
- **Interrupt Anytime** — Stop button or `ESC` to abort a running generation
- **Cyberpunk UI** — Particle network background, scan lines, glow effects (Tailwind CSS)

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

## Usage

1. Click **选择项目目录** to pick a working directory — the CLI will run there
2. Type a message and press `Enter`; `Shift+Enter` for newline
3. Type `/` to open the slash-command palette; `ESC` to interrupt a running task
4. Switch to the **文件** tab in the sidebar to browse files and insert `@references`
5. Click **TOTAL COST** (bottom-left) to open the cost dashboard

### Permission Modes

In non-interactive (`-p`) mode the CLI needs a permission mode, configurable in **Settings**:

| Mode | Behavior |
|------|----------|
| `bypassPermissions` (default) | All tool calls auto-approved — use only in projects you fully trust |
| `acceptEdits` | File edits auto-approved; shell commands etc. may still be rejected |

## Tech Stack

- **Electron** — main process spawns the CLI with `-p --output-format stream-json --verbose`, parses NDJSON from stdout, forwards events over IPC
- **React 18 + TypeScript** — renderer UI
- **Zustand** — state management with debounced persistence (electron-store)
- **Tailwind CSS** — dark sci-fi theme
- **Vite** — renderer build

```
src/
├── main/          # Electron main process (CLI runner, IPC, file tree, persistence)
└── renderer/      # React app (chat, diff view, file tree, dashboard, effects)
```

## Notes

- Model selection is passed through as `--model`; leave it empty to use your CLI default
- Session data is stored locally via electron-store; nothing is uploaded anywhere
- macOS, Linux and Windows (untested on Windows — contributions welcome)

## License

MIT
