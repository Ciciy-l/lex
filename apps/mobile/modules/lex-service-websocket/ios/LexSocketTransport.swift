import Foundation

/// Dedicated bearer transport. DeviceLinkClient owns protocol and reconnects.
final class LexSocketTransport: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  struct Failure: Error { let code: String }
  private let emit: (String, String, [String: Any]) -> Void
  private let lock = NSRecursiveLock()
  private var sockets: [String: URLSessionWebSocketTask] = [:]
  private var destroyed = false
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 15
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()

  init(emit: @escaping (String, String, [String: Any]) -> Void) { self.emit = emit }

  static func validate(origin: String, url: String) throws -> URL {
    guard let service = URLComponents(string: origin), let host = service.host, !host.isEmpty,
      service.user == nil, service.password == nil, service.query == nil, service.fragment == nil,
      service.percentEncodedPath.isEmpty || service.percentEncodedPath == "/"
    else { throw Failure(code: "INVALID_SERVICE_ORIGIN") }
    var allowed = service.scheme == "https"
    #if DEBUG
    let loopback = host == "localhost" || host == "[::1]" || host == "::1" ||
      host.range(of: #"^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$"#, options: .regularExpression) != nil
    allowed = allowed || (service.scheme == "http" && loopback)
    #endif
    guard allowed else { throw Failure(code: "INVALID_SERVICE_ORIGIN") }
    let secure = service.scheme == "https"
    guard let target = URLComponents(string: url), let resolved = target.url,
      target.scheme == (secure ? "wss" : "ws"), target.host == host,
      (target.port ?? (secure ? 443 : 80)) == (service.port ?? (secure ? 443 : 80)),
      target.user == nil, target.password == nil, target.query == nil, target.fragment == nil,
      target.percentEncodedPath == "/api/device-link/ws"
    else { throw Failure(code: "INVALID_SOCKET_ORIGIN") }
    return resolved
  }

  func connect(id: String, origin: String, url: String, headers: [String: String]) throws {
    let target = try Self.validate(origin: origin, url: url)
    guard id.range(of: #"^[a-zA-Z0-9_-]{1,80}$"#, options: .regularExpression) != nil
    else { throw Failure(code: "INVALID_SOCKET") }
    guard headers.count <= 1, headers.allSatisfy({ key, value in
      key.lowercased() == "authorization" && !value.unicodeScalars.contains { $0.value == 10 || $0.value == 13 }
    }) else { throw Failure(code: "INVALID_HEADERS") }
    lock.lock(); defer { lock.unlock() }
    guard !destroyed, sockets[id] == nil else { throw Failure(code: "INVALID_SOCKET") }
    var request = URLRequest(url: target)
    request.httpShouldHandleCookies = false
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let task = session.webSocketTask(with: request)
    // Matches device-link-protocol MAX_FRAME_BYTES, including legacy frames.
    task.maximumMessageSize = 2 * 1024 * 1024
    sockets[id] = task
    task.resume()
    receive(task)
  }

  func send(id: String, data: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard let task = sockets[id] else { throw Failure(code: "SOCKET_CLOSED") }
    guard data.utf8.count <= task.maximumMessageSize else { throw Failure(code: "PAYLOAD_TOO_LARGE") }
    task.send(.string(data)) { [weak self, weak task] error in
      if error != nil, let task { self?.fail(task) }
    }
  }

  func close(id: String, code: Int, reason: String) {
    lock.lock(); defer { lock.unlock() }
    guard let task = sockets.removeValue(forKey: id) else { return }
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
    task.cancel(with: closeCode, reason: Data(reason.utf8.prefix(123)))
    emit(id, "close", ["code": code, "reason": reason])
  }

  func terminate(id: String) {
    lock.lock(); defer { lock.unlock() }
    guard let task = sockets.removeValue(forKey: id) else { return }
    task.cancel()
    emit(id, "close", ["code": 1006, "reason": "terminated"])
  }

  func destroy() {
    lock.lock(); defer { lock.unlock() }
    guard !destroyed else { return }
    destroyed = true
    let tasks = Array(sockets.values)
    sockets.removeAll()
    tasks.forEach { $0.cancel() }
    session.invalidateAndCancel()
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self, weak task] result in
      guard let self, let task else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      guard let id = self.id(for: task) else { return }
      switch result {
      case .success(.string(let text)):
        self.emit(id, "message", ["data": text])
        self.receive(task)
      case .success(.data): self.fail(task)
      case .failure:
        if task.closeCode != .invalid { self.finish(task, code: task.closeCode.rawValue) }
        else { self.fail(task) }
      @unknown default: self.fail(task)
      }
    }
  }

  private func id(for task: URLSessionTask) -> String? { sockets.first { $0.value === task }?.key }

  private func fail(_ task: URLSessionTask, status: Int? = nil) {
    lock.lock(); defer { lock.unlock() }
    guard let id = id(for: task) else { return }
    sockets.removeValue(forKey: id)
    task.cancel()
    // Never expose NSError, response bodies, URLs, headers or credentials to JS/logs.
    let code = status ?? (task.response as? HTTPURLResponse)?.statusCode ?? 0
    emit(id, "error", ["message": "WebSocket handshake failed (HTTP \(code))"])
    emit(id, "close", ["code": 1006, "reason": "connection failed"])
  }

  private func finish(_ task: URLSessionWebSocketTask, code: Int) {
    lock.lock(); defer { lock.unlock() }
    guard let id = id(for: task) else { return }
    sockets.removeValue(forKey: id)
    emit(id, "close", ["code": code, "reason": ""])
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    lock.lock(); defer { lock.unlock() }
    if let id = id(for: webSocketTask) { emit(id, "open", [:]) } else { webSocketTask.cancel() }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    finish(webSocketTask, code: closeCode.rawValue)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if error != nil { fail(task) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
    fail(task, status: response.statusCode)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    // Only system TLS trust evaluation. No shared password/client-certificate lookup or prompt.
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
      completionHandler(.performDefaultHandling, nil)
    } else { completionHandler(.cancelAuthenticationChallenge, nil) }
  }
}
