# Releasing Lex

Lex has two desktop packaging paths:

- **Versioned release (recommended)**: `desktop-release-auto` is triggered by a
  `v*` tag or manually with a SemVer version. Its default `auto` mode checks the
  complete signing configuration. If every required credential exists, it builds
  a signed/notarized release; otherwise it deliberately builds a versioned
  unsigned release. Both modes create the same normal GitHub Release and update
  manifest, so early testing builds can update normally.
- **Local preview artifact**: `desktop-preview-unsigned` remains available for
  ad-hoc branch testing. It produces a short-lived, versionless `0.0.0` Actions
  Artifact only; it does not enter the public update channel.

Versioned unsigned releases are clearly labelled in their Release title and
notes. Windows packages are unsigned; macOS apps use ad-hoc signing and their
DMG container is unsigned, so first installation can trigger SmartScreen or
Gatekeeper warnings. The updater still verifies SHA-256 and can apply the
separately labelled `Auto-Update.zip` archives.

## Before the first release

The versioned packager uses `config/log-upload.json` when it is available. The
file is intentionally not committed. Add its JSON contents as the repository
secret `LEX_LOG_UPLOAD_CONFIG_JSON` before enabling production log upload. When
that secret is absent, log upload stays disabled without changing the package's
signing mode; no fake credentials are accepted.

Configure these repository secrets before enabling signed releases:

- `LEX_WIN_SIGN_CMD` — a Windows Authenticode signing command template;
- `LEX_APPLE_ID`, `LEX_APPLE_TEAM_ID`, `LEX_APPLE_SIGN_IDENTITY`, and
  `LEX_APPLE_APP_PASSWORD` — Developer ID signing/notarization identity;
- `LEX_MACOS_CERT_P12_BASE64` and `LEX_MACOS_CERT_PASSWORD` — the base64
  encoded Developer ID Application `.p12` and its import password. The
  workflow imports this certificate into an ephemeral macOS keychain before
  packaging; the private key is never written to the repository.

`LEX_LOG_UPLOAD_CONFIG_JSON` is optional and independent from signing. Configure
it only after Lex has its own reviewed upload destination and privacy policy.

In `auto` mode, a missing or partial set of signing secrets selects the unsigned
path. Use manual `mode: signed` when you want a hard failure instead. Keep
certificates and passwords in GitHub Secrets (or an environment-protected
secret), never in the repository. Once a signed release exists, the workflow
locks the channel against later unsigned releases; restore the credentials or
use a new repository/channel if a signed build must be rebuilt.

To create the certificate secret locally, export the Developer ID Application
certificate as a password-protected `.p12` from Keychain Access, then encode it
without line wrapping:

```bash
base64 -i Lex-Developer-ID.p12 | tr -d '\\n'
```

## Build a draft

Use a new SemVer tag, including prerelease suffixes such as `v0.1.0-rc.1`:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.1.0-rc.1 -m "Lex v0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

The workflow builds the same clearly named asset set with or without signing:

- `Lex-<version>-Windows-x64-Setup.exe` and its `Auto-Update.zip`;
- `Lex-<version>-macOS-Apple-Silicon.dmg` and its `Auto-Update.zip`;
- `Lex-<version>-macOS-Intel.dmg` and its `Auto-Update.zip`;
- `Lex-<version>-Linux-x64.deb`.

The DMG files are the manual macOS install surface: users mount the image and
drag `Lex.app` into Applications. The ZIP files are intentionally labelled
`Auto-Update` because they are consumed by the in-app updater, not selected for
a fresh manual install. A DMG does not replace signing or notarization; unsigned
releases still show the expected Gatekeeper warning.

Linux arm64 is intentionally not included until a native arm64 runner is
enabled. Every package job runs on its target operating system because the
repository contains native modules (`better-sqlite3`, `node-pty`, `sharp`, and
`sqlite-vec`). The publish job uploads installers, hotfix archives, and a
`SHA256SUMS.txt` file to the draft Release.

## Promote safely

Review the draft assets and CI logs first. For unsigned releases, verify the
warning text and install on a test machine. Publish the release only after the
assets are acceptable. The `release.published` event then generates the update
manifest automatically.

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
`git push lex <branch>` for Lex. A fresh clone of Lex will normally use `origin`
for Lex; add the `cindy-upstream` remote there as shown above.

The old Cindy Fork can remain as a backup; it is not used by the sync workflow.

## Automatic updates

The release workflow creates a reviewed draft. After it is published,
`lex-updates.yml` downloads the published assets (signed or unsigned), computes
SHA-256 metadata, and publishes platform manifests to the `updates` branch. The
desktop updater reads
`https://raw.githubusercontent.com/Ciciy-l/lex/updates/manifest-<platform>.json`;
the endpoint is Lex-owned and does not share Cindy's app update channel. During
this bootstrap phase, the manifest carries absolute, pinned CLI-runtime asset
URLs from the frozen Cindy CDN; mirror those large binaries to a Lex-owned
bucket before declaring the runtime distribution fully independent.

Publish a release only after the draft assets have been reviewed. Then verify the
upgrade chain `unsigned v0.1.0-rc.1 → unsigned v0.1.0-rc.2 → signed v0.1.0` on
each supported desktop platform. The updater compares SemVer, not signing mode,
so a later signed package can replace an earlier unsigned/ad-hoc package. Do not
reuse a tag or replace assets in-place. A Cindy installation does not see Lex
manifests (and vice versa) because the endpoint/update branches are separate.
Prerelease tags are published to the beta manifest; enable Lex's beta update
channel on the test device before testing an `rc` upgrade. If you want every
early tester to follow the default release channel, use ordinary increasing
versions such as `v0.1.0`, `v0.1.1`, and `v0.1.2` instead.
