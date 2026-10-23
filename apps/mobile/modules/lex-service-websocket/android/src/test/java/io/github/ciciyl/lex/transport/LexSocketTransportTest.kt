package io.github.ciciyl.lex.transport

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import okhttp3.tls.HeldCertificate
import okhttp3.tls.HandshakeCertificates
import org.junit.Assert.*
import org.junit.Test
import java.net.CookieHandler
import java.net.CookieManager
import java.net.HttpCookie
import java.net.URI
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class LexSocketTransportTest {
  private data class Event(val type: String, val fields: Map<String, Any>)
  private fun await(queue: LinkedBlockingQueue<Event>, type: String): Event {
    while (true) {
      val event = queue.poll(5, TimeUnit.SECONDS) ?: error("Missing transport event: " + type)
      if (event.type == type) return event
    }
  }
  @Test fun redirectsNeverReachSecondOrigin() {
    val first = MockWebServer(); val target = MockWebServer(); first.start(); target.start()
    try {
      for (status in listOf(301, 302, 303, 307, 308)) {
        first.enqueue(MockResponse().setResponseCode(status).addHeader("Location", target.url("/api/device-link/ws")))
        val queue = LinkedBlockingQueue<Event>()
        val transport = LexSocketTransport { _, type, fields -> queue.add(Event(type, fields)) }
        try {
          transport.connect("redirect_" + status, first.url("/").toString().trimEnd('/'), first.url("/api/device-link/ws").toString().replaceFirst("http", "ws"), mapOf("Authorization" to "Bearer invalid-fixture"))
          val error = await(queue, "error")
          assertEquals("WebSocket handshake failed (HTTP " + status + ")", error.fields["message"])
          await(queue, "close"); assertEquals(0, target.requestCount)
          val sent = first.takeRequest(1, TimeUnit.SECONDS)!!
          assertEquals("Bearer invalid-fixture", sent.getHeader("Authorization")); assertNull(sent.getHeader("Cookie"))
        } finally { transport.destroy() }
      }
    } finally { first.shutdown(); target.shutdown() }
  }
  @Test fun ambientCookiesAreNotSentAndProtocolMessagesStayCompatible() {
    val server = MockWebServer(); server.start(); val original = CookieHandler.getDefault()
    val manager = CookieManager()
    manager.cookieStore.add(URI(server.url("/").toString()), HttpCookie("ambient", "fixture"))
    CookieHandler.setDefault(manager)
    server.enqueue(MockResponse().addHeader("Set-Cookie", "other=fixture").withWebSocketUpgrade(object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send("fixture-frame") }
      override fun onMessage(webSocket: WebSocket, text: String) { webSocket.send("reply:" + text) }
    }))
    val queue = LinkedBlockingQueue<Event>()
    val transport = LexSocketTransport { _, type, fields -> queue.add(Event(type, fields)) }
    try {
      transport.connect("normal", server.url("/").toString().trimEnd('/'), server.url("/api/device-link/ws").toString().replaceFirst("http", "ws"), mapOf("authorization" to "Bearer invalid-fixture"))
      await(queue, "open"); assertEquals("fixture-frame", await(queue, "message").fields["data"])
      transport.send("normal", "v1-frame"); assertEquals("reply:v1-frame", await(queue, "message").fields["data"])
      assertNull(server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("Cookie"))
      transport.close("normal", 1000, "done"); assertEquals(1000, await(queue, "close").fields["code"])
    } finally { transport.destroy(); CookieHandler.setDefault(original); server.shutdown() }
  }
  @Test fun invalidCertificateFailsWithoutDisablingTrustOrReachingRedirectTarget() {
    val server = MockWebServer(); val target = MockWebServer(); target.start()
    val cert = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
    val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
    server.useHttps(tls.sslSocketFactory(), false); server.start()
    server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", target.url("/api/device-link/ws")))
    val queue = LinkedBlockingQueue<Event>()
    val transport = LexSocketTransport { _, type, fields -> queue.add(Event(type, fields)) }
    try {
      transport.connect("tls", server.url("/").toString().trimEnd('/'), server.url("/api/device-link/ws").toString().replaceFirst("http", "ws"), mapOf("authorization" to "Bearer invalid-fixture"))
      assertEquals("WebSocket handshake failed (HTTP 0)", await(queue, "error").fields["message"])
      await(queue, "close"); assertEquals(0, server.requestCount); assertEquals(0, target.requestCount)
    } finally { transport.destroy(); server.shutdown(); target.shutdown() }
  }
  @Test fun handshake401RetainsOnlyClassificationAndNeverBody() {
    val server = MockWebServer(); server.start()
    server.enqueue(MockResponse().setResponseCode(401).setBody("secret-fixture-body"))
    val queue = LinkedBlockingQueue<Event>()
    val transport = LexSocketTransport { _, type, fields -> queue.add(Event(type, fields)) }
    try {
      transport.connect("unauthorized", server.url("/").toString().trimEnd('/'), server.url("/api/device-link/ws").toString().replaceFirst("http", "ws"), emptyMap())
      assertEquals(mapOf("message" to "WebSocket handshake failed (HTTP 401)"), await(queue, "error").fields)
      await(queue, "close")
    } finally { transport.destroy(); server.shutdown() }
  }
  @Test fun anotherOriginOrUnsupportedHeadersAreRejectedBeforeNetwork() {
    val transport = LexSocketTransport { _, _, _ -> error("No event expected") }
    try {
      for ((origin, url) in listOf("https://a.test" to "wss://b.test/api/device-link/ws", "http://a.test" to "ws://a.test/api/device-link/ws", "https://a.test/admin" to "wss://a.test/api/device-link/ws")) {
        try { transport.connect("invalid", origin, url, emptyMap()); fail("Must reject invalid scope") } catch (_: IllegalArgumentException) {}
      }
      try { transport.connect("cookie", "https://a.test", "wss://a.test/api/device-link/ws", mapOf("Cookie" to "fixture")); fail("Must reject ambient headers") } catch (_: IllegalArgumentException) {}
    } finally { transport.destroy() }
  }
}
