<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/desktop/src/renderer/assets/login/lex-wordmark-dark.svg">
    <img src="./apps/desktop/src/renderer/assets/login/lex-wordmark.svg" width="210" alt="Lex">
  </picture>
</p>

<p align="center"><strong>A local workspace for conversations, four Agent engines, files, Git, and Workers.</strong></p>

<p align="center">
  Plan in conversation, work with your tools, and keep the result in view.<br>
  Bring Claude Code, Codex, Pi, and OMP together with a local developer workspace.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://ciciy-l.github.io/lex/">Website</a> ·
  <a href="https://github.com/Ciciy-l/lex/releases">Download</a> ·
  <a href="https://github.com/Ciciy-l/lex/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/Ciciy-l/lex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Ciciy-l/lex/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Ciciy-l/lex/actions/workflows/pages.yml"><img alt="Website" src="https://github.com/Ciciy-l/lex/actions/workflows/pages.yml/badge.svg"></a>
  <a href="https://github.com/Ciciy-l/lex/releases"><img alt="Preview release" src="https://img.shields.io/github/v/release/Ciciy-l/lex?include_prereleases&label=preview"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-6f55e8.svg"></a>
</p>

## What is Lex?

Lex is an open-source desktop and mobile workspace for working with AI. Talk through
a task, run an Agent, inspect files and Git changes, and follow Workers from the same
window.

Use Claude Code, Codex, Pi, or OMP for desktop tasks. Switch between the graphical
conversation (GUI) and the engine's native terminal (TUI) while continuing the same
task and history. Files and terminals also support configured SSH hosts.

Lex is independently maintained and is not affiliated with or endorsed by XD Inc. or
the Cindy project. It builds on the open-source [Cindy](https://github.com/makecindy/cindy)
client. The desktop product, website, installer, and update channel are
**Lex**. Cindy-backed accounts and online services deliberately retain the **Cindy**
name.

## The workspace today

| Area | What you can do |
| --- | --- |
| **Content tabs** | Open terminals, files, the browser, Worker conversations, and the Git workspace (Git Graph / Review) beside your conversation. |
| **GUI / TUI** | Start a local task directly in TUI, switch views with its history, and explicitly send a new message after stopping a generation. Available advanced features vary by engine and view. |
| **Saved drafts** | Keep task and new-task drafts separate. Saved text, attachments, and image annotations restore after a desktop restart; sending or discarding clears the draft. |
| **CLI launch** | Use the `+` menu to start Claude Code, Codex, Pi, OMP, or an installed local Shell in a dedicated tab. Shell choices are detected from the computer instead of being hard-coded. |
| **Terminal layout** | Split panes, resize or drag them into place, rename tabs, search output, and temporarily maximize the pane that needs attention. |
| **Long-running work** | Hide a pane, switch tabs, or collapse the workspace without terminating its PTY. Stopping a process remains an explicit action. |
| **Files** | Browse the project tree, single-click to preview, double-click to keep a file open, and automatically keep a preview once it is edited. |
| **Project context** | Navigate background tasks and collaboration Workers, and open detailed views in the content area. |
| **Git workspace** | For local projects, open one Git workspace from the tool rail. It defaults to Git Graph; switch to Review in the same tab to inspect local commit relationships, staged or unstaged changes, commit diffs, and selected-commit comparisons. Git Graph and its comparisons are read-only; Review retains its existing guarded change actions. |

Lex continues to support Cindy plugins, Skill Hub resources, and `.cindy` files so the
existing Cindy community ecosystem remains useful.

## 0.1.7-rc.2 preview

This preview improves ordinary GUI/TUI sending and task recovery across Claude Code,
Codex, Pi, and OMP, preserves saved drafts across desktop restarts, fixes Pi's normal
idle exit reporting, and improves OMP's cumulative usage display. See the
[release notes](release-notices/0.1.7-rc.2.md) for details. RC updates remain beta-only;
the website's default downloads continue to select the published stable release.

OMP native sessions temporarily disable automatic recap to avoid the observed idle
disconnect. Explicit TUI settings can re-enable it. `/btw`, `/omfg`, and other auxiliary
concurrency remain unverified. GUI/TUI features are not identical. This release's
interactive checks used a dedicated simulated model on Windows; they do not establish
live-provider or macOS/Linux acceptance. Draft recovery applies to saved edits; the
last edits not yet saved are not guaranteed to survive a hard interruption.

## Coming soon

Lex's self-hosted relay service is in development. Stay tuned.

## Download and install

Lex currently ships as an **early preview**. Choose the manual installer for your
platform from [GitHub Releases](https://github.com/Ciciy-l/lex/releases):

| Platform | Manual installation file |
| --- | --- |
| Windows x64 | `Lex-…-Windows-x64-Setup.exe` |
| macOS Apple Silicon | `Lex-…-macOS-Apple-Silicon.dmg` |
| macOS Intel | `Lex-…-macOS-Intel.dmg` |
| Linux x64 | `Lex-…-Linux-x64.deb` |
| Android | `Lex-…-Android.apk` (when present in the published release) |

Files ending in `Auto-Update.zip` are resources for Lex's in-app updater, not the
recommended manual installer.

Early RC packages may be unsigned. Windows SmartScreen, macOS Gatekeeper, or a Linux
package manager may therefore show a warning. Signing status and release stability are
separate: a signed RC is still a prerelease. To receive RC updates in the app, enable
the **beta** update channel; the stable channel does not receive prereleases.

### First run on desktop

1. Install Lex and open it.
2. Sign in with a Cindy account, or choose **Skip Sign-In** for local-only use.
3. Open the project directory you want to work in.
4. Select `+` to start a CLI, Shell, or browser; open collaboration from the
   workspace tool area when you need Workers.

## One app, two Cindy service regions

Each platform has one Lex edition and installation identity; service regions do not split downloads. The account selected at sign-in determines the Cindy service region:

- **Global** for Global Cindy accounts;
- **Mainland China** for Mainland China Cindy accounts;
- organization SSO discovers its home region automatically.

This selection routes Cindy authentication, subscription, hosted models, voice,
storage, Device Link, and remote-control traffic. It does not change the Lex download
or update channel. Skipping sign-in leaves Cindy server-backed features unavailable.

## Lex and Cindy responsibilities

| Area | Provider |
| --- | --- |
| Desktop workspace, installer, website, support, and updates | Lex community project |
| Account, subscription, hosted models, cloud storage, Device Link, and remote services | Cindy official services |
| Source foundation and upstream fixes | Cindy open-source project |

Cindy online services remain subject to Cindy's own terms, regional availability, and
support. Lex does not operate those services or sell a separate subscription. The
release pipeline covers **Lex Desktop and Lex Mobile for Android**. Scan the QR on the
[mobile download page](https://ciciy-l.github.io/lex/#mobile-download) for published APKs.
Android requires Cindy sign-in to connect to your desktop; it does not run desktop
Agent engines locally. Choose Global or Mainland China at login, matching the account
and service region used on your computer. Lex Mobile keeps its own package and signing
identity. Builds with the APK updater check Lex Releases automatically; download is
manual and Android confirms installation. The first updater-enabled APK must be
installed manually once. RC/stable channels are independent of the login region;
EAS/self-host JS OTA stays disabled. iOS is not available yet; it needs a
TestFlight/App Store channel.

Lex follows its own roadmap. Upstream security and compatibility fixes are adopted
selectively; weekly automatic upstream synchronization is disabled.

## Privacy and telemetry

- Lex release builds do **not** enable the upstream TapDB reporting path by default.
- Product analytics do not include chat content, file content, or working-directory
  contents.
- Diagnostic logs stay local unless you explicitly choose **Upload logs now**.
- Automatic crash-log upload is a separate opt-in setting and is off by default.

Signing in and using an online Agent still sends the traffic required by the selected
Cindy service and model provider. Those services follow their own terms and privacy
policies.

## Run from source

Requirements: Node.js 22.x, pnpm 10.x, Git, and Git LFS.

```powershell
git clone https://github.com/Ciciy-l/lex.git
cd lex
git lfs pull
corepack enable
corepack pnpm install
corepack pnpm restart:desktop:remote --region=global
```

The restart command uses the isolated `dev` profile by default, keeping development
data away from the production profile. When running several worktrees in parallel, use
`--isolated=@worktree` to give each checkout its own sandbox.

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) for the complete development workflow.

## Releases and upstream sync

- Prereleases update only the beta channel; stable Releases update both the stable and beta channels so RC installs can graduate.
- Signing is selected from configured repository secrets without creating a separate
  installer identity or release flow.
- The `upstream-sync` workflow runs on explicit maintainer request and opens a
  reviewable sync PR. Security, stability, and compatibility fixes are adopted
  selectively; weekly automatic synchronization is disabled.

Maintainer instructions live in [docs/RELEASING-LEX.md](docs/RELEASING-LEX.md).

## Contributing and support

- Development rules: [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md)
- Support and bug reports: [SUPPORT.en.md](SUPPORT.en.md)
- Private vulnerability reports: [SECURITY.en.md](SECURITY.en.md)
- Pull requests require DCO sign-off (`git commit -s`).

## License and attribution

Source code is licensed under the [Apache License 2.0](LICENSE), except where separately
identified. Original Cindy attribution and the Lex modification notice are preserved
in [NOTICE](NOTICE); third-party notices and SBOMs are under [docs/legal](docs/legal).

Apache-2.0 does not grant rights to Cindy trademarks, hosted services, model weights,
datasets, or other separately identified materials.
