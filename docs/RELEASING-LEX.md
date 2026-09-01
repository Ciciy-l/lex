# Releasing Lex

Lex uses a tag-driven GitHub Actions workflow for desktop packages. The current
workflow creates a **draft** GitHub Release; it does not publish a stable
release automatically.

## Before the first release

The versioned packager requires a valid `config/log-upload.json`. The file is
intentionally not committed. Add its JSON contents as the repository secret
`LEX_LOG_UPLOAD_CONFIG_JSON` before running a release. Do not put access keys or
other credentials in it. If Lex should not collect client logs, we must add an
explicit Lex opt-out before shipping rather than using fake Cindy endpoints.

Configure these repository secrets before creating a release:

- `LEX_LOG_UPLOAD_CONFIG_JSON` — the release log-upload JSON;
- `LEX_WIN_SIGN_CMD` — a Windows Authenticode signing command template;
- `LEX_APPLE_ID`, `LEX_APPLE_TEAM_ID`, `LEX_APPLE_SIGN_IDENTITY`, and
  `LEX_APPLE_APP_PASSWORD` — Developer ID signing/notarization identity.
- `LEX_MACOS_CERT_P12_BASE64` and `LEX_MACOS_CERT_PASSWORD` — the base64
  encoded Developer ID Application `.p12` and its import password. The
  workflow imports this certificate into an ephemeral macOS keychain before
  packaging; the private key is never written to the repository.

The workflow fails closed when Windows or macOS signing secrets are missing. Keep
certificates and passwords in GitHub Secrets (or an environment-protected
secret), never in the repository.

To create the certificate secret locally, export the Developer ID Application
certificate as a password-protected `.p12` from Keychain Access, then encode it
without line wrapping:

```bash
base64 -i Lex-Developer-ID.p12 | tr -d '\\n'
```

## Build a draft

Use a SemVer tag, including prerelease suffixes such as `v0.1.0-rc.1`:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.1.0 -m "Lex v0.1.0"
git push origin v0.1.0
```

The workflow builds:

- Windows x64 NSIS installer;
- macOS arm64 and x64 DMG/ZIP artifacts from the macOS runner;
- Linux x64 `.deb`.

Linux arm64 is intentionally not included until a native arm64 runner is
enabled. Every package job runs on its target operating system because the
repository contains native modules (`better-sqlite3`, `node-pty`, `sharp`, and
`sqlite-vec`). The publish job uploads installers, hotfix archives, and a
`SHA256SUMS.txt` file to the draft Release.

## Promote safely

Review the draft assets and CI logs first. Publish the release only after all
platform assets are signed and the update-manifest workflow can fetch them.

## Upstream synchronization

`.github/workflows/upstream-sync.yml` fetches
`makecindy/cindy:main` every Monday and on demand. It merges the result into the
dedicated `sync/cindy-main` branch and opens or updates a PR into Lex `main`.
Merge conflicts create an Issue instead of committing conflict markers. Review
branding, endpoints, updater code, database migrations, native dependencies,
and the Lex CLI workbench before merging. The regular PR CI remains the merge
gate.

For local work, keep separate remotes:

```bash
git remote add cindy-upstream https://github.com/makecindy/cindy.git
git fetch cindy-upstream main
```

In this development checkout, `origin` currently points to Cindy and `lex`
points to the Lex repository, so use `git fetch origin main` for Cindy and
`git push lex <branch>` for Lex. A fresh clone of Lex will normally use
`origin` for Lex; add the `cindy-upstream` remote there as shown above.

The old Cindy Fork can remain as a backup; it is not used by the sync workflow.

## Automatic updates

The release workflow creates a reviewed draft. After it is published,
`lex-updates.yml` downloads the signed assets, computes SHA-256 metadata, and
publishes platform manifests to the `updates` branch. The desktop updater reads
`https://raw.githubusercontent.com/Ciciy-l/lex/updates/manifest-<platform>.json`;
the endpoint is Lex-owned and does not share Cindy's app update channel. During
this bootstrap phase, the manifest carries absolute, pinned CLI-runtime asset
URLs from the frozen Cindy CDN; mirror those large binaries to a Lex-owned
bucket before declaring the runtime distribution fully independent.

Publish a release only after the draft assets have been reviewed. Then verify an
upgrade from `v0.1.0-rc.1` to the next Lex version and confirm that a Cindy
installation does not see Lex manifests (and vice versa).
