# API for Cursor — Windows

A native **Windows desktop app** that runs a local **OpenAI-compatible API** backed by
**Cursor's Composer models**. Point any OpenAI-compatible coding agent — OpenCode, Codex,
Cline, Kilo Code, pi, VS Code — at `http://127.0.0.1:8787/v1` and use Cursor's Composer
through it.

This is the **Windows port** of the macOS "API for Cursor" app. For macOS, the original
project, and the Cloudflare Worker, see **[standardagents/composer-api](https://github.com/standardagents/composer-api)** (MIT). See [Credits](#credits).

> Built with [Tauri 2](https://v2.tauri.app/) (Rust + WebView2 + React). Lives in the system
> tray, stores your Cursor key in the Windows Credential Manager, and supports one-click agent
> setup and in-app auto-update.

| | |
|---|---|
| Download | **[Latest release](../../releases/latest)** (`.exe` installer) |
| Default base URL | `http://127.0.0.1:8787/v1` (loopback only) |
| Models | `composer-2.5`, `composer-2.5-fast` |
| Requirements | Windows 10/11 x64 + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Win11) |
| License | MIT — © Standard Agents (see [LICENSE](LICENSE)) |

---

## Install

1. Download **`API-for-Cursor-<version>-x64-setup.exe`** from the **[Releases page](../../releases/latest)**.
2. Run it. The build isn't EV-signed yet, so **SmartScreen** may warn → **More info → Run anyway**.
3. It installs to `%ProgramFiles%\API for Cursor\` and launches into the **system tray** (look in
   the hidden-icons overflow `^` near the clock).

## Quick start

1. Click the **tray icon** → paste your **Cursor API key** (`crsr_…`) → **Save**.
2. Click **Stop → Start** once so the server picks up the key, and wait **~10–15 s** on first
   launch (the SDK bridge has a cold start).
3. Point any OpenAI client at `http://127.0.0.1:8787/v1` with model `composer-2.5`, **or** click
   **Configure** next to an agent to wire it up automatically.

```powershell
# verify it's alive
Invoke-RestMethod http://127.0.0.1:8787/health
```

## Point an OpenAI-compatible client at it

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` — use **`127.0.0.1`**, not `localhost` |
| API key | your Cursor key (`crsr_…`), or `cursor-local` if you saved it in the app |
| Model | `composer-2.5` or `composer-2.5-fast` |

Endpoints: `GET /v1/models`, `POST /v1/chat/completions` (stream + non-stream), `POST /v1/responses`, `GET /health`.

> **Claude Code is not supported** — it speaks Anthropic's Messages API, while this is an
> OpenAI-compatible API. (An Anthropic-compatible endpoint is on the [Roadmap](#roadmap).)

## Configure agents (one-click)

In **Configure Agents**, click an agent to write its config (pointing it at the local API).
Re-running is idempotent and backs up any changed file.

| Agent | Config (Windows) |
|---|---|
| OpenCode | `%USERPROFILE%\.config\opencode\opencode.json` |
| Codex | `%USERPROFILE%\.codex\config.toml` (+ `cursorapi*.config.toml`) |
| VS Code | `%APPDATA%\<Code\|Code - Insiders\|VSCodium\|Cursor\|Windsurf>\User\chatLanguageModels.json` |
| Cline | `%USERPROFILE%\.cline\data\globalState.json` + `secrets.json` |
| Kilo Code | `%USERPROFILE%\.config\kilo\kilo.jsonc` |
| pi | `%USERPROFILE%\.pi\agent\models.json` |

For OpenCode, select the model **`cursorapi/composer-2.5`** after configuring.

## How it works (short version)

The Rust backend runs **two local processes**: a Bun **API server** (`/v1/*`, port 8787) and a
**Node SDK bridge** that drives `@cursor/sdk` against Cursor's backend. Chat works with **only
your Cursor key** — no backend secrets. Full architecture, the build, and complete
troubleshooting live in **[`windows-app/README.md`](windows-app/README.md)**.

## Troubleshooting (highlights)

| Symptom | Fix |
|---|---|
| Right after launch: connection fails | The bridge has a ~10–15 s cold start; wait and retry. |
| Client "can't reach the URL" but PowerShell can | Use `http://127.0.0.1:8787/v1` (not `localhost`/IPv6). |
| `401 unauthorized` | Key invalid/revoked, or saved after the server started — **Stop → Start**. |
| `Cursor SDK bridge run timed out` | Occasional transient SDK stall; **retry** (see [Known issues](CHANGELOG.md)). |
| SmartScreen blocks the installer | **More info → Run anyway** (unsigned build). |

Full table + verification commands: [`windows-app/README.md`](windows-app/README.md#troubleshooting).

## Build from source

```powershell
cd windows-app
bun install
bun run tauri dev          # develop
# or build the installer — see windows-app/README.md "Build from source"
```

The Windows app builds on the repo's `worker/` (OpenAI shaping) and
`scripts/cursor-sdk-local-agent-bridge.mjs` (the bridge), so build from a full checkout. Full
instructions: [`windows-app/README.md`](windows-app/README.md#build-from-source).

## Roadmap

- **Native compatibility with more harnesses** — first-class setup for more agents (Aider,
  Continue, Roo Code, Zed) and an **Anthropic-compatible endpoint** so **Claude Code** can use
  Composer (today the API is OpenAI-only).
- **Linux build** — Tauri targets Linux; ship an AppImage/`.deb` reusing the same Node SDK-bridge
  runtime.
- **Reliability** — transparent auto-retry for transient bridge stalls (so the occasional
  `Cursor SDK bridge run timed out` self-recovers without a manual retry), plus a bridge
  readiness wait to remove the first-request cold-start failure.
- **Polish** — EV code-signing to remove the SmartScreen warning; auto-restart the server when
  the API key is saved (so no manual Stop → Start).

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Highlights: **0.1.1** fixed multi-turn chat timing out with
session-reusing clients (e.g. OpenCode).

## Credits

This is the Windows port of the macOS **API for Cursor** app by **Standard Agents**:
**[standardagents/composer-api](https://github.com/standardagents/composer-api)** (MIT). That
project provides the macOS app, the Cloudflare Worker + OpenAI-compatibility layer (`worker/`),
and the `@cursor/sdk` bridge (`scripts/cursor-sdk-local-agent-bridge.mjs`) that this app bundles
and runs. This repository adds the `windows-app/` Tauri 2 desktop app and the Windows release
pipeline.

Backed by [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) and Cursor's Composer
models. Licensed under MIT — see [LICENSE](LICENSE) (© 2026 Standard Agents).
