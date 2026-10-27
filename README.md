# Claude Code GUI

A futuristic desktop GUI for [Claude Code CLI](https://code.claude.com/docs/en/overview) — multi-tab parallel conversations, image input, streaming chat, a cinematic 3D Agent execution observatory, tool-call visualization, line-level diffs, file tree, cross-session search, a token usage dashboard, AI session naming, a Git changes panel, a TodoWrite progress panel, a file previewer, a project management center with LLM-powered project recognition, an optional live video background, and an interactive whale-girl companion.

---

## Features

- **Multi-tab Parallel Conversations** — Run several sessions side by side in one window; each tab has fully isolated state (messages, queue, context meter, input draft) and its own CLI process. Background tabs keep streaming and auto-continue their message queues
- **Streaming Chat** — Real-time token-by-token rendering via the CLI's `stream-json` output, with expandable thinking blocks. Immutable state updates + `React.memo` keep long conversations smooth during streaming
- **Image Input** — Paste screenshots (⌘V) straight into the input; they are saved to a temp dir and attached as `@path` references. Drag-and-drop of files works too
- **Copy Anything** — All message content (replies, thinking, tool output) is selectable; hover any message for a one-click copy button below its final reply; standard Edit menu roles make ⌘C/⌘A reliable on macOS
- **Tool Call Visualization** — Bash, Read, Write, Edit and other tool calls rendered as collapsible cards with status indicators; sub-agent (`Task`/`Agent`) output nests under its parent call
- **3D Agent Execution Observatory** — Open **Agent 执行空间** for a lazy-loaded Three.js command center built around the real execution graph:
  - **Stable, relationship-driven layout** — a central orchestrator, permanent sub-agent sectors, DAG-ranked tool layers, a lower artifact lane, and a separate task rail. Independent calls stay on the same parallel level instead of being turned into a fake serial chain. Slots are collision-aware and retained across status updates, filters, replay, and node additions/removals
  - **Live, historical, and clearly labeled demo data** — real CLI stream/status events, tool results, file operations, sub-agent relationships, retries, approvals, failures, and completion states; historical replay follows event order. DEMO is always marked as simulated, LIVE never invents missing nodes or metrics, and unknown values remain `—`
  - **Readable relationship semantics** — distinct call/delegation/dependency/read/write/retry links, directional particles only on active paths, real upstream/downstream highlighting, and subdued unrelated nodes. Main-agent calls retain their root edge and late events cannot regress a completed run back to running
  - **Purposeful motion and material detail** — a layered metallic/glass core, independent orbital mechanisms, subtle active pulses, spawn/completion feedback, hover/selection feedback, and smooth camera flights instead of force-directed node jitter
  - **Complex-task controls** — branch collapse/expand, smart density with an explicit hidden-node count, full-node mode, type/status/agent filters, node search, detail inspector, label collision avoidance, fit/reset/top/zoom controls, automatic quality scaling, and a real event timeline with replay
- **TodoWrite Progress Panel** — The CLI's `TodoWrite` calls are surfaced as a live checklist under the tab bar: progress bar, per-item status, and the current in-progress task at a glance; the list is rebuilt when reopening an archived session
- **Line-level Diff View** — `Edit` / `Write` / `MultiEdit` calls show red/green diffs with collapsible context (custom LCS diff engine, degrades gracefully on huge files)
- **File Tree Sidebar** — Browse the project directory, click a file to insert an `@path` reference into the input; hover a file and hit the 👁 button to preview it
- **File Previewer** — Modal preview with syntax-highlighted text (512KB cap, binary detection, truncation notice) and inline image preview (png/jpg/gif/webp/bmp/ico)
- **Git Changes Panel** — A fourth sidebar tab showing the current branch and working-tree changes (`M`/`A`/`D`/`?`/staged badges); files Claude touched in the active session get an ✨AI badge, click an entry to expand its unified diff, and revert single files via a confirmed `git checkout --`
- **Project Management Center** — A dedicated view that turns your conversation history into trackable long-term projects:
  - **LLM semantic recognition** (default) — sends bounded excerpts of your local history (GUI sessions + `~/.claude/projects` JSONL) to the model you already use via Claude Code, after an explicit scope/privacy/budget confirmation dialog; the model's output is then **locally verified against real evidence** — every project field and task must cite real source quotes, "completed" requires matching structured Todo/Task records, actual file outputs require successful write tools during that task's execution, and dependencies require recorded `TaskUpdate` edges. Unverifiable claims are downgraded to "pending confirmation" rather than silently trusted
  - **Local rules mode** (opt-in, zero upload) — conservative regex/structure-based recognition; short Q&A and trivial edits never become projects
  - **Review gate** — candidates are never auto-created; you select, edit, associate-with-existing, or reject each one before anything is written to disk
  - **Project overview** — statuses (not started / in progress / completed) with counts, filtering, and search; project status is derived from task states plus your explicit goal acceptance, never from "the session ended"
  - **Project detail** — background/constraints/decisions/deliverables, related files (preview / reveal in Finder), task list with per-task status editing and full audit trail back to the original conversations
  - **Workflow view** — a DAG flowchart of tasks with real dependency edges (branch/merge supported), node details with inputs/outputs, zoom/pan, and viewport culling for large projects; node states always match task states
  - **Persistence** — projects live in `userData/claude-gui-projects.json` (atomic writes, version-checked, refuses to overwrite externally corrupted files); re-recognition associates with existing projects by same-directory + real-source overlap instead of duplicating
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
- **Live Video Background** (opt-in) — Set any local video (mp4/webm/mov/m4v/ogv) as the animated window backdrop from **Settings → Dynamic Video Background**. Played muted, looping, and cover-fitted; a darkening overlay keeps text readable while the particle network keeps floating on top. Served through a custom privileged `bgmedia://` protocol with HTTP Range streaming (seek-friendly, memory-friendly) and a single-path whitelist — the protocol only ever serves the one file you picked, video never leaves your machine. Pauses automatically when the window is hidden, and silently falls back to the default background if the file is moved or deleted
- **Claude Code Whale Girl** — Replaces the old bunny/cat/bear pet with an interactive, draggable mascot adapted from [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume). Reacts to this GUI's Claude Code sessions (working, tool type, completion, errors), with original artwork, dialogue, feeding, games, growth, achievements, weather effects, and optional local speech. Settings are available from the GUI's **Settings → 鲸鱼娘** section or the mascot's context menu

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
npm run dist        # macOS .dmg + .zip installers in release/
npm run pack        # unpacked app only (faster, for debugging)
```

`npm run pack` writes and ad-hoc signs `release/mac-arm64/Claude GUI.app`. Use `npm run dist` when you also need updated DMG/ZIP installers; running `pack` alone does not replace older installer archives.

## Usage

1. Click the project-directory button (on the welcome screen or in the sidebar) to pick a working directory — new conversation tabs snapshot it (already-running tabs are unaffected)
2. Hit **＋** in the tab bar to open a new conversation tab; tasks in different tabs run in parallel
3. Type a message and press `Enter`; `Shift+Enter` for newline; paste screenshots with ⌘V; type `/` for slash commands; `ESC` interrupts the active tab only
4. Messages typed while generating join that tab's queue and auto-send on completion
5. `⌘F` / `Ctrl+F` searches across all open tabs and archived sessions
6. Click a session in the sidebar to open it as a tab (already-open sessions just activate); hover for rename / export / delete
7. Click **TOKENS** (bottom-left) to open the usage dashboard; hover the context meter for details, click the 📦 icon next to it to compact the session
8. Open the **Git** sidebar tab to review what Claude changed this session (✨AI badge) and revert single files; click 👁 in the file tree to preview a file
9. Open **项目管理中心** (sidebar) to recognize, review, and track long-term projects from your history. Pick the recognition mode (LLM semantic / local rules), confirm the send scope and budget when prompted, then review candidates before any project is created. Click a project for background, tasks, files, and the dependency workflow view
10. Open **Agent 执行空间** (sidebar) to inspect the 3D execution graph. **实时** uses real live/history data; **演示** uses the explicitly labeled fixture. Drag to rotate, use the wheel to zoom, click a node for its real upstream/downstream path and output, click a branch to focus or collapse it, and use the timeline to replay events. **Space** pauses/resumes scene animation, **R** resets the camera, **F** focuses the selected node/core, and **Esc** clears dialogs/selection
11. The whale girl floats inside the app window. Click to interact, drag to reposition, or right-click for feeding, games, and settings. Use **Settings → 鲸鱼娘** to control dialogue, effects, tool poses, weather, and opt-in local speech
12. Want an animated backdrop? Open **Settings → Dynamic Video Background**, pick a local video file, and toggle it on/off anytime; low-bitrate loopable clips are recommended to keep power draw minimal

### Whale Girl: scope and privacy

The mascot follows Claude Code sessions launched **inside this GUI**, including background tabs; it does not follow Claude Code in another terminal, IDE, or the standalone Claude desktop app. The bridge passes tool names and aggregate activity/status counts to the mascot, not prompt text, tool arguments, or tool output. Optional keyword sensing from the original Harness plugin is disabled in this integration.

Mascot interactions, growth, achievements, and preferences are stored locally under `whale-moe:*` in the app's renderer storage; they are separate from the GUI's session history and do not migrate from DeepSeek Harness. Weather makes requests to Open-Meteo only after you enter a city; local speech uses the OS speech engine and is off by default. The original DeepSeek-specific balance proxy and MiMo TTS integration are not available. The mascot lives **within the GUI window**, not in a system-wide transparent overlay. Its original bar/side display modes depend on Harness-specific layout anchors and are not supported here; use the default floating mode. Local speech currently covers mascot interaction lines only.

### Project recognition: privacy, cost, and verification

LLM recognition sends conversation excerpts (user/assistant text, whitelisted tool summaries — never thinking blocks, file contents, or full tool output) to the model service configured in your Claude Code CLI. Before anything is sent, a consent dialog shows the data volume, sample excerpts, and a per-run budget cap. The snapshot is frozen at consent time and single-use. Canceled, timed-out, or failed runs may still have incurred API costs. Model explanations are never trusted blindly: task statuses, actual file outputs, and dependencies must be backed by locally verified structured evidence, and everything else is marked "pending confirmation". The local rules mode recognizes projects entirely offline with no upload and no cost.

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
- **Three.js + @react-three/fiber** — lazy-loaded 3D execution scene, instanced node rendering, metallic/glass materials, bounded particles, post-processing, and quality degradation
- **Tailwind CSS** — dark sci-fi theme
- **Vite** — renderer build; **Vitest** — unit tests

```
src/
├── main/          # Electron main process (CLI runner pool, IPC, file tree, persistence, projects backend)
└── renderer/      # React app, whale status bridge, and public/whale/ artwork + scripts
tests/             # Vitest suites: store state machine, diff engine, runner, whale bridge,
                   # agent graph/layout, projects backend/LLM validation, analyzer CLI contract, and browser E2E
```

## Testing

371 tests cover the trickiest logic, all runnable without a display or a real Claude session (the optional end-to-end and browser-UI tests are skipped by default):

- `tests/store.test.ts` — message merging by `message.id`, per-tab state isolation & event routing, background queue continuation, close-tab draft archiving, hydrate migration from the legacy single-session format, malformed-event hardening, immutability guarantees that `React.memo` relies on
- `tests/diff.test.ts` — LCS diff correctness, degenerate fallback for huge inputs, context folding
- `tests/runner.test.js` — real subprocess lifecycle: normal completion, abort-and-resend isolation, SIGKILL fallback, invalid cwd, and parallel multi-runner generation with per-conversation event tagging
- `tests/whale.test.ts` — Claude Code-to-mascot status mapping, privacy boundary and completion/abort handling
- `tests/projects-backend.test.js` — project recognition rules (short-Q&A filtering, dedup, cwd scoping), confirmation gating, atomic persistence, task status/dependency validation, edited-fields protection on re-recognition
- `tests/projects-llm.test.js` — LLM analysis contract: citation validation (fabricated quotes rejected), status/IO/dependency grounding in real local evidence, cross-batch grouping, cancel/budget handling
- `tests/projects-analyzer.test.js` — the tool-free Claude CLI invocation: stdin-only prompts, disabled tools/MCP/skills/session persistence, timeout/cancel process-group kill, malformed output rejection
- `tests/projects-llm-backend.test.js` — consent gating, single-use frozen snapshots, early-cancel race, no silent rules fallback
- `tests/project-store.test.ts` / `tests/project-model.test.ts` — renderer store gating and workflow DAG layout
- `tests/agent-model.test.ts` — real CLI event adaptation, root/delegation/file edges, tool results, terminal-state protection, bounded history, and replay without future-data leakage
- `tests/agent-layout.test.ts` — stable DAG ranks, parallel-versus-serial semantics, collision-free positions, node additions/removals, and upstream/downstream highlighting
- `tests/e2e-partial.test.ts` — opt-in (`RUN_E2E=1`) real Claude CLI tool-loop verification, including streaming deltas, deduplication, tool output, activity, and duration
- `tests/project-ui.test.ts` — opt-in (`RUN_PROJECT_UI=1`) real-browser E2E over an isolated history fixture and mocked model

Run the optional real CLI test with `RUN_E2E=1 npx vitest run tests/e2e-partial.test.ts`. It launches the actual Claude CLI and may incur API costs. Additional type/build checks are available as `npm run typecheck` and `npm run build`.

## Notes

- Model selection is passed through as `--model`; leave it empty to use your CLI default
- Session data is stored locally in `userData/claude-gui-config.json`; project data in `userData/claude-gui-projects.json`; nothing is uploaded anywhere unless you explicitly confirm an LLM recognition run
- LLM project recognition uses your Claude Code CLI credentials and may incur API costs; the consent dialog enforces a per-run budget cap
- macOS is the tested packaging target; Linux and Windows are not verified for this whale integration. The existing CLI Windows `.cmd` shim and `taskkill` handling remain in place

## License

The GUI is MIT-licensed. Whale artwork and original mascot scripts are adapted from [Sutera-Diffusus/dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume) (MIT); its original copyright notice and license are preserved in [`src/renderer/public/whale/LICENSE`](src/renderer/public/whale/LICENSE).
