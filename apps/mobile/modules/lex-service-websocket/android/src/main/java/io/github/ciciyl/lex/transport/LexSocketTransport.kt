package io.github.ciciyl.lex.transport

import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/** Dedicated bearer transport, separate from RN's redirects, cookies and interceptors. */
internal class LexSocketTransport(private val emit: (String, String, Map<String, Any>) -> Unit) {
  private class Connection { @Volatile var socket: WebSocket? = null }
  private val sockets = ConcurrentHashMap<String, Connection>()
  private val client = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).cookieJar(CookieJar.NO_COOKIES).build()

  fun connect(id: String, origin: String, url: String, headers: Map<String, String>) {
    require(id.matches(Regex("[a-zA-Z0-9_-]{1,80}"))) { "INVALID_SOCKET" }
    validate(origin, url)
    require(headers.keys.all { it.equals("Authorization", true) }) { "INVALID_HEADERS" }
    val connection = Connection()
    require(sockets.putIfAbsent(id, connection) == null) { "INVALID_SOCKET" }
    try {
      val request = Request.Builder().url(url)
      headers.forEach { (name, value) -> request.header(name, value) }
      val socket = client.newWebSocket(request.build(), object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) {
          if (sockets[id] === connection) emit(id, "open", emptyMap()) else ws.cancel()
        }
        override fun onMessage(ws: WebSocket, text: String) {
          if (sockets[id] === connection) emit(id, "message", mapOf("data" to text))
        }
        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
          if (sockets.remove(id, connection)) emit(id, "close", mapOf("code" to code, "reason" to reason))
        }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
        override fun onFailure(ws: WebSocket, error: Throwable, response: Response?) {
          if (!sockets.remove(id, connection)) return
          // Exception and response bodies can contain credential-bearing URLs or headers.
          emit(id, "error", mapOf("message" to ("WebSocket handshake failed (HTTP " + (response?.code ?: 0) + ")")))
          emit(id, "close", mapOf("code" to 1006, "reason" to "connection failed"))
        }
      })
      connection.socket = socket
      // A failure/cancel may arrive before newWebSocket returns. Never resurrect it.
      if (sockets[id] !== connection) socket.cancel()
    } catch (error: Throwable) {
      sockets.remove(id, connection)
      throw IllegalStateException("SOCKET_CONNECT_FAILED")
    }
  }
  fun send(id: String, data: String) {
    require(sockets[id]?.socket?.send(data) == true) { "SOCKET_CLOSED" }
  }
  fun close(id: String, code: Int, reason: String) {
    val connection = sockets.remove(id) ?: return
    if (connection.socket?.close(code, reason) != true) connection.socket?.cancel()
    emit(id, "close", mapOf("code" to code, "reason" to reason))
  }
  fun terminate(id: String) {
    val connection = sockets.remove(id) ?: return
    connection.socket?.cancel()
    emit(id, "close", mapOf("code" to 1006, "reason" to "terminated"))
  }
  fun destroy() {
    val old = sockets.values.toList(); sockets.clear()
    old.forEach { it.socket?.cancel() }
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
  }
  internal companion object {
    fun validate(origin: String, url: String) {
      val service = URI(origin); val target = URI(url)
      val loopback = service.host == "localhost" || service.host == "[::1]" || service.host == "::1" ||
        service.host?.matches(Regex("127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}")) == true
      require(service.scheme == "https" || (BuildConfig.DEBUG && service.scheme == "http" && loopback)) { "INVALID_SERVICE_ORIGIN" }
      require(service.host != null && service.rawUserInfo == null && service.rawQuery == null && service.rawFragment == null &&
        (service.rawPath.isNullOrEmpty() || service.rawPath == "/")) { "INVALID_SERVICE_ORIGIN" }
      require(target.scheme == (if (service.scheme == "https") "wss" else "ws") &&
        target.host == service.host && port(target) == port(service) && target.rawUserInfo == null &&
        target.rawQuery == null && target.rawFragment == null && target.rawPath == "/api/device-link/ws") { "INVALID_SOCKET_ORIGIN" }
    }
    private fun port(uri: URI): Int = if (uri.port != -1) uri.port else if (uri.scheme == "https" || uri.scheme == "wss") 443 else 80
  }
}
