import { describe, expect, it } from "vitest";
import {
  isDesktopInput,
  parseRemoteDesktopRequest,
  REMOTE_DESKTOP_CHANNEL,
  isDesktopPermission,
  remoteDesktopVideoSettingsWire,
} from "../remoteDesktop";
import { REMOTE_INVOKE_ALLOWLIST, PUSH_FORWARD_ALLOWLIST } from "../allowlist";
describe("remote desktop wire boundary", () => {
  it("preserves legacy stop and accepts only a boolean explicit lock request", () => {
    expect(parseRemoteDesktopRequest({ op: "stop", lease: "a" })).toEqual({ op: "stop", lease: "a" });
    expect(parseRemoteDesktopRequest({ op: "stop", lease: "a", lockScreen: true })).toEqual({ op: "stop", lease: "a", lockScreen: true });
    for (const lockScreen of ["true", 1, null, {}])
      expect(() => parseRemoteDesktopRequest({ op: "stop", lease: "a", lockScreen })).toThrow("INVALID_REQUEST");
  });
  it("accepts old starts and validates the optional recovery flag", () => {
    expect(parseRemoteDesktopRequest({ op: "start", displayId: "1" })).toEqual({
      op: "start",
      displayId: "1",
    });
    expect(
      parseRemoteDesktopRequest({
        op: "start",
        displayId: "1",
        resume: true,
      }),
    ).toEqual({ op: "start", displayId: "1", resume: true });
    for (const resume of ["", 1, null])
      expect(() =>
        parseRemoteDesktopRequest({ op: "start", displayId: "1", resume }),
      ).toThrow("INVALID_REQUEST");
  });
  it("limits permission actions to status and the dedicated guide", () => {
    expect(
      parseRemoteDesktopRequest({ op: "permissions", action: "guide" }),
    ).toEqual({ op: "permissions", action: "guide" });
    expect(() =>
      parseRemoteDesktopRequest({ op: "permissions", action: "openExternal" }),
    ).toThrow();
    expect(isDesktopPermission("accessibility")).toBe(true);
    expect(isDesktopPermission("https://example.com")).toBe(false);
    expect(isDesktopPermission("fullDiskAccess")).toBe(false);
  });
  it("adds only a business invoke channel, never a broadcast", () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(REMOTE_DESKTOP_CHANNEL)).toBe(true);
    expect(PUSH_FORWARD_ALLOWLIST.has(REMOTE_DESKTOP_CHANNEL)).toBe(false);
  });
  it.each([
    { kind: "move", x: NaN, y: 0 },
    { kind: "move", x: -1, y: 0 },
    { kind: "button", x: 0, y: 0, button: 5, down: true },
    { kind: "key", code: "shell", down: true },
    { kind: "text", text: "a".repeat(4097) },
    { kind: "scroll", dx: 1, dy: Infinity },
  ])("rejects malformed input %j", (value) => {
    expect(isDesktopInput(value)).toBe(false);
  });
  it("bounds batches, SDP, and sequence numbers", () => {
    expect(() =>
      parseRemoteDesktopRequest({
        op: "input",
        lease: "a",
        sequence: -1,
        events: [],
      }),
    ).toThrow();
    expect(() =>
      parseRemoteDesktopRequest({
        op: "input",
        lease: "a",
        sequence: 1,
        events: Array(65).fill({ kind: "release" }),
      }),
    ).toThrow();
    expect(() =>
      parseRemoteDesktopRequest({
        op: "offer",
        lease: "a",
        sdp: "x".repeat(64001),
      }),
    ).toThrow();
  });
  describe("video quality tiers", () => {
    const offer = (settings: unknown) =>
      parseRemoteDesktopRequest({ op: "offer", lease: "a", sdp: "s", settings });
    it("keeps only the tier, so hosts own the concrete encoder budget", () => {
      for (const quality of ["auto", "saver", "hd"] as const)
        expect(
          offer(remoteDesktopVideoSettingsWire({ fps: 60, quality, audio: true })),
        ).toMatchObject({
          settings: { fps: quality === "saver" ? 30 : 60, quality, audio: true },
        });
      expect(
        offer({ fps: 30, quality: "hd", bitrate: 20_000_000, audio: false }),
      ).toEqual({
        op: "offer",
        lease: "a",
        sdp: "s",
        settings: { fps: 30, quality: "hd", audio: false },
      });
    });
    it("maps bitrate-only settings from older viewers onto tiers", () => {
      for (const [bitrate, quality] of [
        [0, "auto"],
        [2_000_000, "saver"],
        [8_000_000, "hd"],
        [20_000_000, "hd"],
      ] as const)
        expect(offer({ fps: 30, bitrate, audio: false })).toMatchObject({
          settings: { fps: 30, quality, audio: false },
        });
    });
    it("sends a legacy bitrate that older hosts accept, also for unknown future tiers", () => {
      expect(
        [ "auto", "saver", "hd" ].map(
          (quality) =>
            remoteDesktopVideoSettingsWire({
              fps: 30,
              quality: quality as "auto" | "saver" | "hd",
              audio: false,
            }).bitrate,
        ),
      ).toEqual([0, 2_000_000, 20_000_000]);
      expect(
        offer({ fps: 30, quality: "ultra", bitrate: 20_000_000, audio: false }),
      ).toMatchObject({ settings: { quality: "hd" } });
      // Older hosts ignore `quality`, so Saver's 30 fps cap travels in `fps`.
      expect(
        remoteDesktopVideoSettingsWire({ fps: 60, quality: "saver", audio: false }),
      ).toEqual({ fps: 30, quality: "saver", audio: false, bitrate: 2_000_000 });
      expect(
        remoteDesktopVideoSettingsWire({ fps: 60, quality: "auto", audio: false }).fps,
      ).toBe(60);
    });
    it.each([
      { fps: 30, audio: false },
      { fps: 30, quality: "ultra", audio: false },
      { fps: 30, bitrate: 5_000_000, audio: false },
      { fps: 24, quality: "auto", audio: false },
      { fps: 30, quality: "auto", audio: "yes" },
      null,
    ])("rejects invalid settings %j", (settings) => {
      expect(() => offer(settings)).toThrow("INVALID_REQUEST");
    });
  });
});
