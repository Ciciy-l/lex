import Foundation
import XCTest
@testable import LexServiceTransport

final class LexSocketTransportTests: XCTestCase {
  private final class Events {
    let condition = NSCondition()
    var values: [(String, String, [String: Any])] = []
    func append(_ id: String, _ type: String, _ fields: [String: Any]) {
      condition.lock(); defer { condition.unlock() }
      values.append((id, type, fields)); condition.broadcast()
    }
    func next(_ type: String, timeout: TimeInterval = 5) throws -> [String: Any] {
      condition.lock(); defer { condition.unlock() }
      let deadline = Date().addingTimeInterval(timeout)
      while true {
        if let index = values.firstIndex(where: { $0.1 == type }) { return values.remove(at: index).2 }
        if !condition.wait(until: deadline) { throw NSError(domain: "Missing \(type)", code: 1) }
      }
    }
  }
  private func origin(_ key: String) throws -> String {
    let raw = try XCTUnwrap(ProcessInfo.processInfo.environment["LEX_WS_TEST_ORIGINS"])
    let origins = try JSONDecoder().decode([String: String].self, from: Data(raw.utf8))
    return try XCTUnwrap(origins[key])
  }
  private func connect(_ transport: LexSocketTransport, _ origin: String, id: String = "socket") throws {
    try transport.connect(id: id, origin: origin, url: origin.replacingOccurrences(of: "http", with: "ws") + "/api/device-link/ws",
                          headers: ["Authorization": "Bearer invalid-fixture"])
  }

  func testOriginAndHeaderBoundaries() throws {
    _ = try LexSocketTransport.validate(origin: "https://a.test", url: "wss://a.test:443/api/device-link/ws")
    _ = try LexSocketTransport.validate(origin: "https://a.test:7443", url: "wss://a.test:7443/api/device-link/ws")
    for (origin, url) in [
      ("https://a.test", "wss://b.test/api/device-link/ws"),
      ("https://a.test", "wss://a.test:444/api/device-link/ws"),
      ("https://a.test", "wss://a.test/api/device-link/ws?token=x"),
      ("https://a.test", "wss://a.test/%61pi/device-link/ws"),
      ("https://a.test/admin", "wss://a.test/api/device-link/ws"),
      ("https://user@a.test", "wss://a.test/api/device-link/ws"),
      ("http://a.test", "ws://a.test/api/device-link/ws"),
    ] { XCTAssertThrowsError(try LexSocketTransport.validate(origin: origin, url: url)) }
    let transport = LexSocketTransport { _, _, _ in XCTFail("Invalid input must not emit") }
    defer { transport.destroy() }
    for headers in [["Cookie": "ambient=invalid"], ["Authorization": "Bearer invalid\r\nCookie: invalid"]] {
      XCTAssertThrowsError(try transport.connect(id: "invalid", origin: "https://a.test", url: "wss://a.test/api/device-link/ws", headers: headers))
    }
    #if DEBUG
    _ = try LexSocketTransport.validate(origin: "http://127.0.0.1:3101", url: "ws://127.0.0.1:3101/api/device-link/ws")
    #else
    XCTAssertThrowsError(try LexSocketTransport.validate(origin: "http://127.0.0.1:3101", url: "ws://127.0.0.1:3101/api/device-link/ws"))
    #endif
  }

  func testInvalidCertificateNeverSendsBearer() throws {
    let events = Events()
    let live = LexSocketTransport(emit: events.append)
    defer { live.destroy() }
    try connect(live, origin("tls"))
    XCTAssertEqual(try events.next("error")["message"] as? String, "WebSocket handshake failed (HTTP 0)")
    XCTAssertEqual(try events.next("close")["code"] as? Int, 1006)
  }

  #if DEBUG
  func testRedirectsNeverReachTarget() throws {
    for code in [301, 302, 303, 307, 308] {
      let events = Events()
      let live = LexSocketTransport(emit: events.append)
      defer { live.destroy() }
      try connect(live, origin("redirect\(code)"))
      XCTAssertEqual(try events.next("error")["message"] as? String, "WebSocket handshake failed (HTTP \(code))")
      XCTAssertEqual(try events.next("close")["code"] as? Int, 1006)
    }
  }

  func test401PreservesAuthClassification() throws {
    let events = Events()
    let transport = LexSocketTransport(emit: events.append)
    defer { transport.destroy() }
    try connect(transport, origin("unauthorized"))
    XCTAssertEqual(try events.next("error")["message"] as? String, "WebSocket handshake failed (HTTP 401)")
    XCTAssertEqual(try events.next("close")["code"] as? Int, 1006)
  }

  func testCookiesMessagesAndClose() throws {
    let service = try origin("echo")
    let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "ambient", .value: "invalid-fixture"]))
    HTTPCookieStorage.shared.setCookie(cookie)
    defer { HTTPCookieStorage.shared.deleteCookie(cookie) }
    let events = Events()
    let transport = LexSocketTransport(emit: events.append)
    defer { transport.destroy() }
    try connect(transport, service)
    _ = try events.next("open")
    XCTAssertEqual(try events.next("message")["data"] as? String, "fixture-frame")
    try transport.send(id: "socket", data: "v1-frame")
    XCTAssertEqual(try events.next("message")["data"] as? String, "reply:v1-frame")
    XCTAssertThrowsError(try transport.send(id: "socket", data: String(repeating: "x", count: 2 * 1024 * 1024 + 1)))
    transport.close(id: "socket", code: 1000, reason: "done")
    XCTAssertEqual(try events.next("close")["code"] as? Int, 1000)
    XCTAssertThrowsError(try transport.send(id: "socket", data: "closed"))
  }

  func testTerminationAndDestroySuppressLateEvents() throws {
    let events = Events()
    let transport = LexSocketTransport(emit: events.append)
    try connect(transport, origin("echo"))
    _ = try events.next("open")
    transport.terminate(id: "socket")
    XCTAssertEqual(try events.next("close")["code"] as? Int, 1006)
    transport.destroy()
    XCTAssertThrowsError(try connect(transport, origin("echo")))
    XCTAssertThrowsError(try events.next("close", timeout: 0.2))
    XCTAssertThrowsError(try events.next("error", timeout: 0.2))
  }
  #endif
}
