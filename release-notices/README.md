# Lex version notices

Before creating a release tag, copy `template.json` to `<version>.json` in this
directory, set its exact version and publication date, and review its five localized
topic lists. Commit that file in the release source before tagging. Do not derive the
machine-readable notice from a mutable GitHub Release body.

Validate without publishing:

```sh
node scripts/lex-release-notices.mjs v<version>
```

The source uses the existing localized topic payload: `version`, a real ISO calendar
`date`, and `contentByLocale` for zh-CN, zh-TW, en, ja and ko. Each locale requires
a Lex-labelled `intro` and at least one topic with nonblank `title` and `text`.
Optional topic `id`, `emoji` and string-array `contributors` are validated too.

Both release building and update publication reject missing or invalid notices.
The updates workflow checks out the exact release tag, then publishes the notice to
`notice/<platform>/<version>.json` and merges its ascending, deduplicated index for
win32-x64, darwin-arm64, darwin-x64 and linux-x64 in the same updates-branch commit
as the manifests. RC remains beta-only; stable still advances both manifest channels.
Notices themselves are channel-neutral, as required by the existing reader.

Old immutable tags without a versioned notice intentionally fail this gate. Do not
move an existing release tag to repair it; prepare a new release source instead.
The template is not a publishable version and no future release number is reserved here.

## Device identity migration

Packaged Lex resolves `lex-<first 60 characters of raw machine ID>` once for auth,
get-device-id IPC and local identity consumers. Explicit XDT_DEVICE_ID_OVERRIDE is
kept byte-for-byte, including whitespace, and bypasses the packaged migration.
Cindy and unpackaged development keep their existing raw identity unless overridden.

Packaged Lex uses a new `lex_device_v1_` credential-key namespace inside its own
existing userData profile for resource sessions, saved accounts, logout tombstones
and legacy token projections. Old raw-ID credentials are not copied, refreshed,
deleted or revoked: the first launch has no credentials in the new namespace and
requires login once. Later launches reuse the new credentials. No original Cindy
profile or credential is accessed. Local conversations and owner metadata remain.

Device Link obtains its relay identity from the auth access token. A fresh Lex login
therefore registers a different device session from Cindy; no relay protocol or
service endpoint changes are needed. Existing links targeting Cindy's raw ID still
target Cindy, not Lex. Rolling back to an older Lex build restores that older build's
raw-ID behavior and may again conflict with Cindy; the new build does not revoke the
old raw-ID session because that could sign Cindy out.
