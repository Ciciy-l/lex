package app.cindy.credentials

import android.content.ContextWrapper
import java.io.File
import org.junit.Test

/** A fresh Lex/guest client has no official installation or vault to cancel. */
class MobileCredentialLifecycleTest {
  private class NoCredentialStorage : ContextWrapper(null) {
    override fun getFilesDir(): File = error("Cleanup accessed credential storage")
    override fun getNoBackupFilesDir(): File = error("Cleanup accessed credential storage")
  }

  @Test fun unusedClientCloseResetAndDestroyNeverInitializeCredentialStorage() {
    val client = MobileCredentialClient(NoCredentialStorage(), { null }) {
      error("No session exists to invalidate")
    }
    client.close()
    client.reset()
    client.destroy()
  }
}
