# Lex

> A community desktop agent distribution based on
> [Cindy](https://github.com/makecindy/cindy), with an Orca-inspired local CLI workbench.

[简体中文](README.zh-CN.md) · [Download](https://github.com/Ciciy-l/lex/releases) ·
[Website](https://ciciy-l.github.io/lex/) · [Issues](https://github.com/Ciciy-l/lex/issues)

[![CI](https://github.com/Ciciy-l/lex/actions/workflows/ci.yml/badge.svg)](https://github.com/Ciciy-l/lex/actions/workflows/ci.yml)
[![Release](https://github.com/Ciciy-l/lex/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/Ciciy-l/lex/actions/workflows/desktop-release.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Lex keeps Cindy as its application and agent foundation, then adds a desktop-native
CLI workspace: open several Shell, Claude Code, Codex, or Pi sessions beside the chat,
split panes, resize them, preserve their PTY lifecycle, and keep the work inside the
same project window.

Lex is independently maintained and is not affiliated with or endorsed by XD Inc. or
the Cindy project.

The desktop product and distribution are named **Lex**. The inherited assistant
persona and Cindy-backed account/service surfaces continue to use the **Cindy** name
on purpose; this preserves upstream behavior and does not imply that Lex is an official
Cindy build.

## One app, two Cindy service regions

There is only one Lex installer, application identity, user-data profile, version, and
update channel. On the sign-in screen, choose the service region for your Cindy account:

- **Global** for Global Cindy accounts;
- **Mainland China** for Mainland China Cindy accounts;
- organization SSO discovers its home region automatically.

The account choice routes Cindy authentication, subscription, cloud models, voice,
storage, Device Link, and remote-control traffic. It does **not** change the Lex app,
download, or update channel. Saved accounts remember their own region.

## Cindy and Lex responsibilities

| Area | Provider |
| --- | --- |
| Desktop app, CLI workbench, packaging, website, support, updates | Lex community project |
| Account, subscription, hosted models, cloud storage, Device Link, remote services | Cindy official services |
| Source foundation and upstream fixes | Cindy open-source project |

Cindy online services remain subject to Cindy's terms, regional availability, and
service status. Lex does not operate those services or sell a separate subscription.
You can also choose **Skip Sign-In** for local-only agent use; server-backed features
are then unavailable.

## Current status

Lex is in early preview. Versioned GitHub Releases may be unsigned until the project
has configured platform signing. Unsigned packages are useful for testing but may show
Windows SmartScreen, macOS Gatekeeper, or Linux package-manager warnings. Once signing
secrets are configured, the same versioned release and update path automatically emits
signed production artifacts, so existing installations can upgrade normally.

The current scope is **Lex Desktop**. The mobile source remains upstream Cindy code;
Lex Desktop can continue to work with the official Cindy mobile client.

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

`--region=global` now identifies the single Lex build profile. The Cindy account service
region is selected on the login screen. Use an isolated development profile when needed:

```powershell
corepack pnpm restart:desktop:remote --region=global --isolated=dev
```

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) for the full development workflow.

## Releases and updates

- Push a semantic version tag such as `v0.2.0-rc.1` to run the multi-platform release
  workflow.
- A published GitHub Release generates update manifests on the `updates` branch.
- Prereleases update the beta channel; stable releases update the stable channel.
- Signing is selected automatically from configured repository secrets. Missing signing
  credentials produce versioned unsigned preview packages instead of a fake version.

Details are in [docs/RELEASING-LEX.md](docs/RELEASING-LEX.md).

### Cindy Skill Hub compatibility

Skill Hub migration uses two separate manifest fields: released clients keep
using `skillhubApiBaseUrl` (the deprecated XD proxy), while current clients use
`cindySkillHubApiBaseUrl`. The current client deliberately does not fall back to
the legacy field when the new endpoint is absent.


## Keeping up with Cindy

The `upstream-sync` workflow checks Cindy regularly and opens a reviewable sync pull
request. Keep Lex-specific product identity, CLI workbench, and release files separate
where possible; resolve conflicts in favor of Cindy security/fix changes while retaining
Lex's documented product boundaries.

## Privacy and telemetry

Lex keeps Cindy's consent and analytics controls, but Lex release builds do **not** enable
the upstream TapDB reporting path by default. No chat content, file content, or working
directory is sent as product analytics. Signed-in sessions still use Cindy's official
online services and heartbeat according to Cindy's terms and privacy policy.

Diagnostic logs stay local unless you explicitly choose **Upload logs now**. Crash log
upload is a separate opt-in setting and is off by default; both paths also require privacy
consent and a Lex-owned upload destination configured at build time.

## Contributing and support

- Development rules: [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md)
- Support and bug reports: [SUPPORT.en.md](SUPPORT.en.md)
- Private vulnerability reports: [SECURITY.en.md](SECURITY.en.md)
- Pull requests require DCO sign-off (`git commit -s`).

## License and attribution

Source code is licensed under [Apache License 2.0](LICENSE), except where separately
identified. The original Cindy attribution and Lex modification notice are preserved in
[NOTICE](NOTICE); third-party notices and SBOMs are under [docs/legal](docs/legal).

Apache-2.0 does not grant rights to Cindy trademarks, hosted services, model weights,
datasets, or other separately identified materials.
