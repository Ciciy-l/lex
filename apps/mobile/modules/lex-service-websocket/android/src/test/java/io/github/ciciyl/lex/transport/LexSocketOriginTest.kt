package io.github.ciciyl.lex.transport

import org.junit.Assert.*
import org.junit.Test

/** Run on both debug and release variants: the native flag is never supplied by JS. */
class LexSocketOriginTest {
  @Test fun loopbackDependsOnTrustedNativeBuildVariant() {
    val transport = LexSocketTransport { _, _, _ -> error("No network event expected") }
    try {
      if (BuildConfig.DEBUG) {
        LexSocketTransport.validate("http://127.0.0.1:3101", "ws://127.0.0.1:3101/api/device-link/ws")
      } else {
        try {
          transport.connect("release", "http://127.0.0.1:3101", "ws://127.0.0.1:3101/api/device-link/ws", mapOf("Authorization" to "Bearer invalid-fixture"))
          fail("Release native boundary must reject loopback before network")
        } catch (error: IllegalArgumentException) { assertEquals("INVALID_SERVICE_ORIGIN", error.message) }
      }
    } finally { transport.destroy() }
  }
  @Test fun httpsAndCustomPortsRemainValid() {
    LexSocketTransport.validate("https://server.test:7443", "wss://server.test:7443/api/device-link/ws")
    LexSocketTransport.validate("https://server.test", "wss://server.test:443/api/device-link/ws")
  }
}
