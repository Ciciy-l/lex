package io.github.ciciyl.lex.updater

import androidx.core.content.FileProvider

/** Separate provider identity avoids merging with another library's FileProvider. */
class LexApkFileProvider : FileProvider()
