# S5 SharedTask host wiring source appendix

This is a Lex-local integration by Poker, bounded by v0.1.96-beta f7f265ef2e4316d37a7ce6d4e03006a826e397e4. It completes the host callbacks, capability announcement, exact task probes, topic filtering and trusted stream epoch omitted from the staged S1-S4 implementation. No upstream Git authorship is claimed.

## Selected upstream source

```text
bca321223d8b88aef67b73c5e072a244737790f2
DavidShen <david@xd.com>
2026-09-20T19:58:03+08:00
feat(sharing): share tasks across accounts with unified desktop and mobile flows

Signed-off-by: DavidShen <david@xd.com>

```

Lex-Adaptation: retain current owner/realm checks, existing ordinary remote control, protocol negotiation and fail-closed raw OSS behavior. Stream acceptance is a local callback, not a relay protocol change.
