import ExpoModulesCore

public final class LexServiceWebSocketModule: Module {
  private lazy var transport = LexSocketTransport { [weak self] id, type, fields in
    self?.sendEvent("socketEvent", fields.merging(["id": id, "type": type]) { _, new in new })
  }

  public func definition() -> ModuleDefinition {
    Name("LexServiceWebSocket")
    Events("socketEvent")
    Function("connect") { (id: String, origin: String, url: String, headers: [String: String]) in
      try self.transport.connect(id: id, origin: origin, url: url, headers: headers)
    }
    Function("send") { (id: String, data: String) in try self.transport.send(id: id, data: data) }
    Function("close") { (id: String, code: Int, reason: String) in self.transport.close(id: id, code: code, reason: reason) }
    Function("terminate") { (id: String) in self.transport.terminate(id: id) }
    OnDestroy { self.transport.destroy() }
  }
}
