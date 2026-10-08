import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { DESKTOP_TRANSFORM_SCRIPT } from "../geometry";
import { remoteDesktopViewerHtml } from "../viewerHtml";

const desktopTransform = vm.runInNewContext(
  `(${DESKTOP_TRANSFORM_SCRIPT})`,
) as (
  vw: number,
  vh: number,
  dw: number,
  dh: number,
  zoom: number,
  fx: number,
  fy: number,
  fillHeight?: boolean,
) => {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  maxZoom: number;
};

function viewer(rtc = false) {
  const messages: Array<{
    type: string;
    epoch: string;
    sequence: number;
    events?: Array<{ kind: string; code?: string }>;
  }> = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const documentListeners: Record<string, (event: unknown) => void> = {};
  const windowListeners: Record<string, (event: unknown) => void> = {};
  const elements = Object.fromEntries(
    [
      "stage",
      "keyboard-input",
      "image",
      "video",
      "cursor",
      "cursor-image",
      "mouse-buttons",
      "mouse-left",
      "mouse-right",
      "mouse-middle",
      "mouse-wheel",
      "mouse-wheel-grip",
      "mouse-up",
      "mouse-down",
    ].map((id) => [
      id,
      {
        clientWidth: 400,
        clientHeight: 600,
        style: {} as Record<string, string>,
        addEventListener: (name: string, handler: (e: unknown) => void) => {
          listeners[`${id}:${name}`] = handler;
        },
        value: "",
        focus() {},
        blur() {},
        setSelectionRange() {},
        setAttribute() {},
        setPointerCapture() {},
        removeAttribute() {},
        play: async () => {},
      },
    ]),
  );
  const intervals: Array<() => void> = [];
  const frames = new Map<number, () => void>();
  let id = 0;
  const dataChannel = { readyState: "open", bufferedAmount: 0, send: vi.fn(), close() {} };
  class Peer {
    connectionState = "connected";
    localDescription = { sdp: "offer" };
    iceGatheringState = "complete";
    createDataChannel() { return dataChannel; }
    addTransceiver() {}
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {}
    async getStats() { return new Map(); }
    close() {}
  }
  let now = 0;
  const source = remoteDesktopViewerHtml("#fff", "#111").match(
    /<script>([\s\S]*)<\/script>/,
  )![1];
  vm.runInNewContext(source, {
    RTCPeerConnection: Peer,
    Date: { now: () => now },
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    document: {
      getElementById: (key: string) => elements[key],
      addEventListener: (key: string, fn: (e: unknown) => void) => {
        documentListeners[key] = fn;
      },
      body: { style: {} },
      documentElement: { style: { setProperty() {} } },
    },
    window: {
      RTCPeerConnection: rtc ? Peer : undefined,
      ReactNativeWebView: {
        postMessage: (text: string) => messages.push(JSON.parse(text)),
      },
      addEventListener: (key: string, fn: (e: unknown) => void) => {
        windowListeners[key] = fn;
      },
    },
    ResizeObserver: class {
      observe() {}
    },
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => {
      frames.set(++id, fn);
      return id;
    },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  });
  return {
    dataChannel,
    messages,
    elements,
    send: (message: object) =>
      windowListeners.message({ data: JSON.stringify(message) }),
    flush: () => intervals.forEach((fn) => fn()),
    frame: (elapsed = 16) => {
      now += elapsed;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn());
    },
    pointer: (type: string, pointerId: number, x: number, y: number) =>
      listeners[`stage:${type}`]({
        type,
        pointerId,
        clientX: x,
        clientY: y,
        preventDefault() {},
      }),
    mouse: (name: string, type: string, y = 0, target = `mouse-${name}`) =>
      listeners[`mouse-${name}:${type}`]({
        type,
        pointerId: 9,
        clientY: y,
        target: { id: target },
        detail: 1,
        preventDefault() {},
      }),
    ack: () => {
      const last = messages.filter((m) => m.type === "input").at(-1);
      if (last)
        windowListeners.message({
          data: JSON.stringify({
            type: "ack",
            epoch: last.epoch,
            sequence: last.sequence,
          }),
        });
    },
    blur: () => windowListeners.blur({}),
    key: (type: string, code: string) =>
      documentListeners[type]({ code, preventDefault() {} }),
  };
}

describe("remote desktop viewport", () => {
  it("drops queued input after its two-second deadline and ignores old ACKs after control resumes", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "events", events: [{ kind: "text", text: "first" }] });
    const first = v.messages.filter((m) => m.type === "input").at(-1)!;
    v.send({ type: "events", events: [{ kind: "text", text: "stale" }] });
    v.frame(2001);
    v.flush();
    expect(v.messages.filter((m) => m.type === "inputOverflow")).toHaveLength(1);
    v.send({ type: "events", events: [{ kind: "text", text: "ignored" }] });
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([{ kind: "text", text: "first" }]);

    v.send({ type: "control", enabled: true });
    v.send({ type: "events", events: [{ kind: "text", text: "fresh" }] });
    v.send({ type: "events", events: [{ kind: "text", text: "next" }] });
    v.send({ type: "ack", epoch: first.epoch, sequence: first.sequence });
    v.flush();
    expect(v.messages.filter((m) => m.type === "input")).toHaveLength(2);
    v.ack();
    v.flush();
    expect(v.messages.filter((m) => m.type === "input")).toHaveLength(3);
  });

  it("holds relay input behind a congested live data channel and drops it if it expires", () => {
    const v = viewer(true);
    v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
    const iceConfig = v.messages.find((m) => m.type === "iceConfig") as { attemptId?: string } | undefined;
    expect(iceConfig?.attemptId).toBeDefined();
    v.send({ type: "iceConfig", epoch: "one", attemptId: iceConfig!.attemptId, iceServers: [] });
    v.send({ type: "control", enabled: true });

    v.dataChannel.bufferedAmount = 16384;
    v.send({ type: "events", events: [{ kind: "text", text: "queued" }] });
    expect(v.dataChannel.send).not.toHaveBeenCalled();
    expect(v.messages.filter((m) => m.type === "input")).toHaveLength(0);
    v.dataChannel.bufferedAmount = 0;
    v.flush();
    expect(v.dataChannel.send).toHaveBeenCalledOnce();
    expect(JSON.parse(v.dataChannel.send.mock.calls[0][0]).events).toEqual([{ kind: "text", text: "queued" }]);

    v.dataChannel.bufferedAmount = 16384;
    v.send({ type: "events", events: [{ kind: "text", text: "expired" }] });
    v.frame(2001);
    v.flush();
    v.dataChannel.bufferedAmount = 0;
    v.flush();
    expect(v.dataChannel.send).toHaveBeenCalledOnce();
    expect(v.messages.filter((m) => m.type === "input")).toHaveLength(0);
    expect(v.messages.filter((m) => m.type === "inputOverflow")).toHaveLength(1);
  });

  it("does not reroute a failed data-channel batch to the relay", () => {
    const v = viewer(true);
    v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
    const iceConfig = v.messages.find((m) => m.type === "iceConfig") as { attemptId?: string } | undefined;
    expect(iceConfig?.attemptId).toBeDefined();
    v.send({ type: "iceConfig", epoch: "one", attemptId: iceConfig!.attemptId, iceServers: [] });
    v.send({ type: "control", enabled: true });
    v.dataChannel.send.mockImplementationOnce(() => { throw new Error("channel closed"); });
    v.send({ type: "events", events: [{ kind: "text", text: "stale" }] });
    v.flush();
    expect(v.dataChannel.send).toHaveBeenCalledOnce();
    expect(v.messages.filter((m) => m.type === "input")).toHaveLength(0);
    expect(v.messages.filter((m) => m.type === "inputOverflow")).toHaveLength(1);
  });

  it.each([
    ["left", 0],
    ["right", 2],
  ] as const)(
    "holds and releases the virtual %s button without adding stage clicks",
    (name, button) => {
      const v = viewer();
      v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
      v.send({ type: "control", enabled: true });
      v.send({ type: "mouseButtons", enabled: true });
      v.mouse(name, "pointerdown");
      v.ack();
      v.pointer("pointerdown", 1, 200, 200);
      v.pointer("pointerup", 1, 200, 200);
      v.mouse(name, "pointerup");
      expect(
        v.messages
          .flatMap((m) => m.events ?? [])
          .filter((e) => e.kind === "button"),
      ).toEqual([
        { kind: "button", button, down: true, x: 0.5, y: 0.5 },
        { kind: "button", button, down: false, x: 0.5, y: 0.5 },
      ]);
    },
  );
  it.each(["pointercancel", "lostpointercapture"])(
    "releases held buttons on %s",
    (end) => {
      const v = viewer();
      v.send({ type: "control", enabled: true });
      v.send({ type: "mouseButtons", enabled: true });
      v.mouse("left", "pointerdown");
      v.ack();
      v.mouse("left", end);
      expect(v.messages.at(-1)?.events?.[0]).toMatchObject({
        kind: "button",
        button: 0,
        down: false,
      });
    },
  );
  it("releases when hidden and prevents input in view-only mode", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("right", "pointerdown");
    v.ack();
    v.send({ type: "mouseButtons", enabled: false });
    expect(v.messages.at(-1)?.events?.[0]).toMatchObject({
      kind: "button",
      button: 2,
      down: false,
    });
    expect(v.elements["mouse-buttons"].style.display).toBe("none");
    v.ack();
    v.send({ type: "control", enabled: false });
    v.send({ type: "mouseButtons", enabled: true });
    const count = v.messages.length;
    v.mouse("left", "pointerdown");
    v.mouse("wheel", "pointerdown", 100);
    v.mouse("wheel", "pointermove", 50);
    v.flush();
    expect(v.messages).toHaveLength(count);
    expect(v.elements["mouse-buttons"].style.display).toBe("none");
  });
  it("scrolls by dragging the wheel and cancels without an extra step", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 100);
    v.frame(300);
    v.mouse("wheel", "pointermove", 80);
    v.flush();
    v.ack();
    v.mouse("wheel", "pointercancel", 80);
    v.mouse("wheel", "pointerup", 80);
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: -24 },
    ]);
  });
  it("taps the combined wheel as middle click without scrolling", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 100);
    v.frame(100);
    v.mouse("wheel", "pointerup", 100);
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "button", button: 1, down: true, x: .5, y: .5 },
      { kind: "button", button: 1, down: false, x: .5, y: .5 },
    ]);
  });
  it("keeps scrolling while held, reverses direction and stops on release", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 100);
    v.mouse("wheel", "pointermove", 90);
    v.flush(); v.ack();
    v.flush(); v.ack(); // No new movement: still scrolls.
    v.mouse("wheel", "pointermove", 124);
    v.flush(); v.ack();
    v.mouse("wheel", "pointermove", 100);
    v.flush(); // Center dead zone stops scrolling.
    v.mouse("wheel", "pointerup", 100);
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: -9 },
      { kind: "scroll", dx: 0, dy: -9 },
      { kind: "scroll", dx: 0, dy: 30 },
    ]);
    expect(v.elements["mouse-wheel-grip"].style.transform).toBe("translateY(0px)");
  });
  it("does not accumulate held wheel ticks while awaiting acknowledgement", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 1000);
    v.mouse("wheel", "pointermove", 990);
    v.flush();
    for (let y = 989; y >= 890; y--) {
      v.mouse("wheel", "pointermove", y);
      v.flush();
    }
    expect(v.messages.some((message) => message.type === "inputOverflow")).toBe(false);
    v.ack();
    v.flush();
    expect(v.messages.flatMap((message) => message.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: -9 },
      { kind: "scroll", dx: 0, dy: -30 },
    ]);
  });
  it("fills landscape height for wide desktops and restores portrait fitting", () => {
    const v = viewer();
    v.elements.stage.clientWidth = 678;
    v.elements.stage.clientHeight = 402;
    v.send({
      type: "init",
      epoch: "landscape",
      width: 2560,
      height: 1080,
      fillHeight: true,
    });
    for (const element of [v.elements.image, v.elements.video]) {
      expect(element.style.height).toBe("402px");
      expect(element.style.top).toBe("0px");
      expect(parseFloat(element.style.width)).toBeGreaterThan(678);
    }
    v.send({ type: "fit" });
    expect(v.elements.image.style.top).toBe("0px");
    v.elements.stage.clientWidth = 400;
    v.elements.stage.clientHeight = 700;
    v.send({ type: "viewport", fillHeight: false });
    expect(v.elements.image.style.width).toBe("400px");
    expect(parseFloat(v.elements.image.style.top)).toBeGreaterThan(0);
  });
  it.each([
    [1, .1], [1, .5], [1, .9], [2, .1], [2, .5], [2, .9],
  ])("keeps landscape scale %sx with minimal horizontal movement for cursor %s", (scale, cursorX) => {
    const v = viewer();
    v.elements.stage.clientWidth = 800;
    v.elements.stage.clientHeight = 400;
    v.send({ type: "init", epoch: "keyboard", width: 1920, height: 1080, fillHeight: true });
    if (scale === 2) {
      v.pointer("pointerdown", 1, 200, 200);
      v.pointer("pointerdown", 2, 400, 200);
      v.pointer("pointermove", 1, 100, 200);
      v.pointer("pointermove", 2, 500, 200);
      v.frame();
      v.frame(40);
      v.pointer("pointerup", 1, 100, 200);
      v.pointer("pointerup", 2, 500, 200);
    }
    v.send({ type: "frame", jpeg: "", cursor: {
      x: cursorX, y: .85, width: 18, height: 18, hotX: 9, hotY: 9,
      visible: true, png: "iVBORw0KGgo=",
    } });
    v.send({ type: "mouseButtons", keyboardOpen: false, bottomInset: 0, leftInset: 50, rightInset: 80 });
    for (let i = 0; i < 30; i++) v.frame();
    const width = v.elements.image.style.width;
    expect(parseFloat(v.elements.image.style.height)).toBeCloseTo(400 * scale);
    // Removing the toolbar before the keyboard has a measured height must not shift the image.
    const originalLeft = v.elements.image.style.left;
    v.send({ type: "mouseButtons", keyboardOpen: true, bottomInset: 0, leftInset: 50, rightInset: 0 });
    expect(parseFloat(v.elements.image.style.left)).toBeCloseTo(parseFloat(originalLeft));
    // Header, computer keyboard, phone keyboard, and closing the keyboard.
    for (const bottomInset of [60, 260, 300, 0]) {
      const previousLeft = parseFloat(v.elements.image.style.left);
      const previousCursorX = previousLeft + cursorX * parseFloat(width);
      const rightInset = bottomInset > 0 ? 0 : 80;
      const expectedCursorX = Math.max(67, Math.min(800 - rightInset - 17, previousCursorX));
      v.send({ type: "mouseButtons", keyboardOpen: bottomInset > 0, bottomInset, leftInset: 50, rightInset });
      v.blur();
      for (let i = 0; i < 30; i++) v.frame();
      const image = v.elements.image.style;
      expect(image.width).toBe(width);
      expect(parseFloat(image.height)).toBeCloseTo(400 * scale);
      expect(parseFloat(image.left) + cursorX * parseFloat(image.width)).toBeCloseTo(expectedCursorX);
      expect(parseFloat(image.left)).toBeCloseTo(previousLeft + expectedCursorX - previousCursorX);
      expect(parseFloat(image.top) + .85 * parseFloat(image.height)).toBeCloseTo((400 - bottomInset) / 2);
    }
  });
  it("does not recenter portrait content for a keyboard overlay message", () => {
    const v = viewer();
    const before = { ...v.elements.image.style };
    v.send({ type: "mouseButtons", keyboardOpen: true, bottomInset: 260 });
    expect(v.elements.image.style).toEqual(before);
  });
  it("preserves horizontal position when the keyboard closes before measurement", () => {
    const v = viewer();
    v.elements.stage.clientWidth = 800;
    v.elements.stage.clientHeight = 400;
    v.send({ type: "init", epoch: "quick-keyboard", width: 1920, height: 1080, fillHeight: true });
    v.send({ type: "mouseButtons", keyboardOpen: false, bottomInset: 0, leftInset: 50, rightInset: 80 });
    const before = { ...v.elements.image.style };
    for (let i = 0; i < 2; i++) {
      v.send({ type: "mouseButtons", keyboardOpen: true, bottomInset: 0, leftInset: 50, rightInset: 0 });
      v.send({ type: "mouseButtons", keyboardOpen: false, bottomInset: 0, leftInset: 50, rightInset: 80 });
      expect(v.elements.image.style).toEqual(before);
      v.blur();
      for (let j = 0; j < 30; j++) v.frame();
      expect(v.elements.image.style).toEqual(before);
    }
  });
  it("initializes when the native engine cannot serialize function source", () => {
    const stringify = vi
      .spyOn(Function.prototype, "toString")
      .mockReturnValue("function () { [native code] }");
    let result: ReturnType<typeof viewer>;
    try {
      result = viewer();
    } finally {
      stringify.mockRestore();
    }
    expect(result.messages[0]).toMatchObject({ type: "ready" });
    expect(result.elements.image.style.width).toBe("400px");
  });
  it("fits without cropping the computer in portrait and landscape", () => {
    for (const [w, h] of [
      [390, 650],
      [760, 300],
      [390, 260],
    ]) {
      const rect = desktopTransform(w, h, 1920, 1080, 1, 0.5, 0.5);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(w);
      expect(rect.y + rect.height).toBeLessThanOrEqual(h);
    }
  });
  it("caps pinch zoom at two viewer points per desktop point", () => {
    for (const [w, h] of [
      [393, 760],
      [852, 340],
    ]) {
      const rect = desktopTransform(w, h, 1512, 982, 100, 0.5, 0.5);
      expect(rect.scale).toBeCloseTo(2);
      expect(rect.width).toBeCloseTo(1512 * 2);
    }
    // A display already shown larger than 2x at fit cannot zoom further.
    const small = desktopTransform(1366, 1024, 400, 320, 5, 0.5, 0.5);
    expect(small.maxZoom).toBe(1);
    expect(small.scale).toBeCloseTo(3.2);
  });
  it("preserves the focus at the viewport center across rotation and keyboard resize", () => {
    for (const [w, h] of [
      [390, 650],
      [760, 300],
      [390, 260],
    ]) {
      const rect = desktopTransform(w, h, 1920, 1080, 5, 0.6, 0.6);
      expect((w / 2 - rect.x) / rect.width).toBeCloseTo(0.6);
      expect((h / 2 - rect.y) / rect.height).toBeCloseTo(0.6);
    }
  });
  it("compiles the actual inline viewer and rejects HTML injection through theme values", () => {
    const html = remoteDesktopViewerHtml(
      "</style><script>alert(1)</script>",
      "#fff",
    );
    expect(html).not.toContain("alert(1)");
    const source = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(source).toBeTruthy();
    expect(() => new vm.Script(source!)).not.toThrow();
  });
  it("keeps ArrowRight and reconnects after a bridge input was left unacknowledged", () => {
    const v = viewer();
    v.send({ type: "init", epoch: "first", width: 1920, height: 1080 });
    v.send({ type: "control", enabled: true });
    v.key("keydown", "ArrowRight");
    v.flush();
    expect(v.messages.at(-1)?.events?.[0]).toEqual({
      kind: "key",
      code: "ArrowRight",
      down: true,
    });
    v.send({ type: "stop" });
    v.send({ type: "init", epoch: "second", width: 1920, height: 1080 });
    v.send({ type: "control", enabled: true });
    v.send({ type: "ack", epoch: "first", sequence: 1 });
    v.key("keydown", "KeyA");
    v.flush();
    expect(v.messages.at(-1)?.epoch).toBe("second");
    expect(v.messages.at(-1)?.events?.[0].code).toBe("KeyA");
  });
  it.each([false, true])(
    "recognizes a small pinch with control=%s",
    (control) => {
      const v = viewer();
      v.send({ type: "control", enabled: control });
      v.pointer("pointerdown", 1, 100, 200);
      v.pointer("pointerdown", 2, 300, 200);
      v.pointer("pointermove", 1, 95, 200);
      v.pointer("pointermove", 2, 305, 200);
      v.frame();
      v.frame(40);
      expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(420);
      v.flush();
      expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([]);
    },
  );
  it("stops a real pinch at 2x and resumes from the new limit after a viewport change", () => {
    const v = viewer();
    const width = () => parseFloat(v.elements.image.style.width);
    v.pointer("pointerdown", 1, 190, 200);
    v.pointer("pointerdown", 2, 210, 200);
    v.pointer("pointermove", 1, 150, 200);
    v.pointer("pointermove", 2, 250, 200);
    v.frame();
    v.frame(40);
    v.pointer("pointermove", 1, 0, 200);
    v.pointer("pointermove", 2, 400, 200);
    v.frame();
    // 400px fit of a 1920px desktop; spreading 20x stops at 2 points per pixel.
    expect(width()).toBeCloseTo(1920 * 2);
    v.pointer("pointerup", 1, 0, 200);
    v.pointer("pointerup", 2, 400, 200);
    // A wider viewport lowers the zoom limit; the picture stays at 2x.
    v.elements.stage.clientWidth = 800;
    v.send({ type: "viewport", fillHeight: false });
    expect(width()).toBeCloseTo(1920 * 2);
    // Pinching in responds immediately instead of first unwinding the old zoom.
    v.pointer("pointerdown", 1, 300, 200);
    v.pointer("pointerdown", 2, 500, 200);
    v.pointer("pointermove", 1, 310, 200);
    v.pointer("pointermove", 2, 490, 200);
    v.frame();
    v.frame(40);
    expect(width()).toBeCloseTo(1920 * 2 * 0.9);
  });
  it("allows one finger to lead a pinch instead of locking into scroll", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    v.pointer("pointermove", 1, 86, 200);
    v.frame();
    v.frame(40);
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(428);
    v.pointer("pointermove", 2, 320, 200);
    v.frame();
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(468);
  });
  it("can turn an initial scroll into a pinch without a zoom jump", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    v.pointer("pointermove", 1, 110, 200);
    v.pointer("pointermove", 2, 310, 200);
    v.frame();
    v.flush();
    expect(v.messages.at(-1)?.events?.[0].kind).toBe("scroll");
    v.pointer("pointermove", 1, 82, 200);
    v.pointer("pointermove", 2, 320, 200);
    v.frame();
    v.frame(40);
    expect(v.elements.image.style.width).toBe("400px");
    v.pointer("pointermove", 1, 72, 200);
    v.pointer("pointermove", 2, 330, 200);
    v.frame();
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(
      (400 * 258) / 238,
    );
  });
  it("does not mistake staggered parallel updates for a pinch", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    for (const delta of [10, 20, 30]) {
      v.pointer("pointermove", 1, 100 + delta, 200);
      v.frame();
      v.pointer("pointermove", 2, 300 + delta, 200);
      v.frame();
    }
    v.frame(60);
    v.flush();
    expect(v.elements.image.style.width).toBe("400px");
    expect(v.messages.at(-1)?.events?.every((e) => e.kind === "scroll")).toBe(
      true,
    );
  });
  it("aims a touch-mode two-finger scroll at the fingers before scrolling", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mode", mode: "touch" });
    v.flush();
    v.ack();
    v.pointer("pointerdown", 1, 100, 250);
    v.pointer("pointerdown", 2, 200, 250);
    v.pointer("pointermove", 1, 100, 230);
    v.pointer("pointermove", 2, 200, 230);
    v.frame();
    v.flush();
    const [move, scroll] = v.messages
      .flatMap((m) => m.events ?? [])
      .filter((e) => e.kind !== "release");
    // A 1920x1080 desktop fits 400x225 inside the 600px-tall stage.
    expect(move).toEqual({
      kind: "move",
      x: expect.closeTo(0.375),
      y: expect.closeTo((230 - 187.5) / 225),
    });
    expect(scroll).toEqual({ kind: "scroll", dx: 0, dy: 20 });
  });
  it("aims a touch-mode scroll that starts in the letterbox once it reaches the desktop", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mode", mode: "touch" });
    v.flush();
    v.ack();
    // The desktop picture spans y 187.5..412.5; start above it.
    v.pointer("pointerdown", 1, 100, 150);
    v.pointer("pointerdown", 2, 200, 150);
    v.pointer("pointermove", 1, 100, 170);
    v.pointer("pointermove", 2, 200, 170);
    v.frame();
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "release" },
    ]);
    v.pointer("pointermove", 1, 100, 200);
    v.pointer("pointermove", 2, 200, 200);
    v.frame();
    v.flush();
    const events = v.messages
      .flatMap((m) => m.events ?? [])
      .filter((e) => e.kind !== "release");
    expect(events).toEqual([
      {
        kind: "move",
        x: expect.closeTo(0.375),
        y: expect.closeTo((200 - 187.5) / 225),
      },
      { kind: "scroll", dx: 0, dy: -30 },
    ]);
  });
  it("keeps the pointer-mode cursor where it is for two-finger scrolls", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 250);
    v.pointer("pointerdown", 2, 200, 250);
    v.pointer("pointermove", 1, 100, 230);
    v.pointer("pointermove", 2, 200, 230);
    v.frame();
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: 20 },
    ]);
  });
  it("carries sub-pixel two-finger scroll distance instead of dropping it", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 250);
    v.pointer("pointerdown", 2, 200, 250);
    v.pointer("pointermove", 1, 100, 240);
    v.pointer("pointermove", 2, 200, 240);
    v.frame();
    for (let i = 1; i <= 6; i++) {
      v.pointer("pointermove", 1, 100, 240 - i * 0.5);
      v.pointer("pointermove", 2, 200, 240 - i * 0.5);
      v.frame();
    }
    v.flush();
    const dys = v.messages
      .flatMap((m) => m.events ?? [])
      .filter((e) => e.kind === "scroll")
      .map((e) => (e as unknown as { dy: number }).dy);
    expect(dys.every(Number.isInteger)).toBe(true);
    expect(dys.reduce((sum, dy) => sum + dy, 0)).toBe(13);
  });
  it("applies the last pinch position before lifting a finger without clicking", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    v.pointer("pointermove", 1, 90, 200);
    v.pointer("pointermove", 2, 310, 200);
    v.frame();
    v.frame(40);
    v.pointer("pointermove", 1, 80, 200);
    v.pointer("pointerup", 2, 340, 200);
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(520);
    v.pointer("pointerup", 1, 80, 200);
    v.frame();
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([]);
  });
  it("recognizes parallel two-finger movement as scrolling, not a pinch", () => {
    const v = viewer();
    v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 200, 200);
    v.pointer("pointermove", 1, 110, 200);
    v.pointer("pointermove", 2, 210, 200);
    v.frame();
    v.pointer("pointermove", 1, 120, 200);
    v.pointer("pointermove", 2, 220, 200);
    v.frame();
    v.flush();
    expect(v.elements.image.style.width).toBe("400px");
    expect(
      v.messages.at(-1)?.events?.every((event) => event.kind === "scroll"),
    ).toBe(true);
  });
});
