package io.github.ciciyl.lex.transport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LexServiceWebSocketModule : Module() {
  private val transport = LexSocketTransport { id, type, fields ->
    sendEvent("socketEvent", fields + mapOf("id" to id, "type" to type))
  }
  override fun definition() = ModuleDefinition {
    Name("LexServiceWebSocket")
    Events("socketEvent")
    Function("connect") { id: String, origin: String, url: String, headers: Map<String, String> -> transport.connect(id, origin, url, headers) }
    Function("send") { id: String, data: String -> transport.send(id, data) }
    Function("close") { id: String, code: Int, reason: String -> transport.close(id, code, reason) }
    Function("terminate") { id: String -> transport.terminate(id) }
    OnDestroy { transport.destroy() }
  }
}
