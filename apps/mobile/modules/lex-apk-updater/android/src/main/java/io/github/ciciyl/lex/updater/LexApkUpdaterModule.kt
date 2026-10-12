package io.github.ciciyl.lex.updater

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** No arbitrary file, URL, package or signing identity is accepted from the UI. */
class LexApkUpdaterModule : Module() {
  private val epoch = AtomicLong(0)
  private val downloading = AtomicBoolean(false)
  @Volatile private var connection: HttpURLConnection? = null
  private val context get() = requireNotNull(appContext.reactContext) { "UNAVAILABLE" }
  private val packageName = "io.github.ciciyl.lex"

  override fun definition() = ModuleDefinition {
    Name("LexApkUpdater")
    Events("progress")
    Function("cancel") { epoch.incrementAndGet(); connection?.disconnect(); Unit }
    AsyncFunction("installed") {
      require(context.packageName == packageName) { "WRONG_PACKAGE" }
      val info = installedInfo()
      mapOf("version" to info.versionName, "versionCode" to code(info), "packageName" to info.packageName)
    }
    AsyncFunction("download") Coroutine { target: Map<String, Any> ->
      withContext(Dispatchers.IO) { download(target) }
    }
    AsyncFunction("install") Coroutine { target: Map<String, Any> ->
      val current = epoch.get()
      val apk = withContext(Dispatchers.IO) { verify(target) }
      withContext(Dispatchers.Main) {
        require(current == epoch.get()) { "CANCELLED" }
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
          "permission-required"
        } else {
          val uri = FileProvider.getUriForFile(context, "$packageName.lex.updates", apk)
          context.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
          })
          "installer-opened"
        }
      }
    }
    AsyncFunction("canInstall") {
      Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
    }
    AsyncFunction("openPermissionSettings") {
      require(context.packageName == packageName) { "WRONG_PACKAGE" }
      if (Build.VERSION.SDK_INT >= 26) context.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    OnDestroy { epoch.incrementAndGet(); connection?.disconnect() }
  }

  private fun text(target: Map<String, Any>, key: String) = target[key] as? String ?: error("INVALID_METADATA")
  private fun number(target: Map<String, Any>, key: String): Long {
    val value = (target[key] as? Number)?.toDouble() ?: error("INVALID_METADATA")
    require(value.isFinite() && value > 0 && value == value.toLong().toDouble()) { "INVALID_METADATA" }
    return value.toLong()
  }
  private fun file(target: Map<String, Any>): File {
    require(context.packageName == packageName && text(target, "packageName") == packageName) { "WRONG_PACKAGE" }
    val sha = text(target, "sha256")
    require(Regex("[a-f0-9]{64}").matches(sha)) { "INVALID_METADATA" }
    val directory = File(context.cacheDir, "lex-apk-updates")
    require(directory.isDirectory || directory.mkdirs()) { "STORAGE_UNAVAILABLE" }
    return File(directory, "$sha.apk")
  }
  @Suppress("DEPRECATION")
  private fun flags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  @Suppress("DEPRECATION")
  private fun installedInfo() = context.packageManager.getPackageInfo(packageName, flags())
  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  @Suppress("DEPRECATION")
  private fun certificates(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }?.toSet() ?: emptySet()
  }
  @Suppress("DEPRECATION")
  private fun verify(target: Map<String, Any>): File {
    val apk = file(target)
    require(apk.isFile && apk.length() == number(target, "size")) { "SIZE_MISMATCH" }
    val digest = MessageDigest.getInstance("SHA-256")
    apk.inputStream().buffered().use { stream ->
      val buffer = ByteArray(128 * 1024)
      while (true) { val count = stream.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
    }
    require(hex(digest.digest()) == text(target, "sha256")) { "CHECKSUM_MISMATCH" }
    val info = context.packageManager.getPackageArchiveInfo(apk.absolutePath, flags()) ?: error("INVALID_APK")
    val installed = installedInfo()
    require(info.packageName == packageName) { "WRONG_PACKAGE" }
    require(info.versionName == text(target, "version") && code(info) == number(target, "versionCode") && code(info) > code(installed)) { "WRONG_VERSION" }
    val signer = certificates(info)
    require(signer.size == 1 && signer == certificates(installed) && signer.single() == text(target, "certificateSha256")) { "SIGNATURE_MISMATCH" }
    return apk
  }

  private fun openDownload(url: String): HttpURLConnection {
    var uri = URI(url)
    require(uri.host == "github.com" && uri.path.startsWith("/Ciciy-l/lex/releases/download/") && uri.path.endsWith("-Android.apk")) { "INVALID_URL" }
    repeat(5) {
      require(uri.scheme == "https" && uri.rawUserInfo == null && (uri.port == -1 || uri.port == 443) && uri.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")) { "INVALID_URL" }
      if (uri.host == "github.com") require(uri.path.startsWith("/Ciciy-l/lex/releases/download/")) { "INVALID_URL" }
      val conn = uri.toURL().openConnection() as HttpURLConnection
      connection = conn
      conn.instanceFollowRedirects = false
      conn.connectTimeout = 15000
      conn.readTimeout = 30000
      conn.setRequestProperty("Accept", "application/octet-stream")
      val status = conn.responseCode
      if (status in listOf(301, 302, 303, 307, 308)) {
        val location = conn.getHeaderField("Location") ?: error("DOWNLOAD_FAILED")
        conn.disconnect()
        uri = uri.resolve(location)
      } else {
        if (status != 200) { conn.disconnect(); error("DOWNLOAD_FAILED") }
        return conn
      }
    }
    error("DOWNLOAD_FAILED")
  }

  private fun download(target: Map<String, Any>): Boolean {
    require(downloading.compareAndSet(false, true)) { "BUSY" }
    val current = epoch.incrementAndGet()
    var partial: File? = null
    try {
      val apk = file(target)
      val expected = number(target, "size")
      require(expected <= 8L * 1024 * 1024 * 1024) { "INVALID_METADATA" }
      if (apk.exists()) {
        try { verify(target); require(current == epoch.get()) { "CANCELLED" }; return true }
        catch (error: Exception) { apk.delete(); if (current != epoch.get()) throw error }
      }
      apk.parentFile?.listFiles()?.forEach { if (it.isFile) it.delete() }
      require((apk.parentFile?.usableSpace ?: 0) >= expected + 16 * 1024 * 1024) { "STORAGE_UNAVAILABLE" }
      val part = File(apk.parentFile, apk.name + ".part")
      partial = part
      val conn = openDownload(text(target, "file"))
      require(current == epoch.get()) { "CANCELLED" }
      var received = 0L
      var lastEvent = 0L
      conn.inputStream.buffered().use { input -> part.outputStream().buffered().use { output ->
        val buffer = ByteArray(128 * 1024)
        while (true) {
          require(current == epoch.get()) { "CANCELLED" }
          val count = input.read(buffer)
          if (count < 0) break
          received += count
          require(received <= expected) { "SIZE_MISMATCH" }
          output.write(buffer, 0, count)
          val now = android.os.SystemClock.elapsedRealtime()
          if (now - lastEvent >= 250 || received == expected) {
            lastEvent = now
            sendEvent("progress", mapOf("sha256" to text(target, "sha256"), "received" to received, "total" to expected))
          }
        }
      } }
      require(current == epoch.get()) { "CANCELLED" }
      require(received == expected && part.renameTo(apk)) { "DOWNLOAD_FAILED" }
      try { verify(target) } catch (error: Exception) { apk.delete(); throw error }
      require(current == epoch.get()) { "CANCELLED" }
      return true
    } finally {
      partial?.delete()
      connection?.disconnect()
      connection = null
      downloading.set(false)
    }
  }
}
