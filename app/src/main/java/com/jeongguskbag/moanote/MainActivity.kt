package com.jeongguskbag.moanote

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

/**
 * 모아노트: WebView 하나에 노트 화면(assets/www, 웹)을 띄우고, 파일 가져오기·저장·보내기만 안드로이드가 맡는다.
 * - 화면과 엔진은 https://appassets.androidplatform.net/assets/www/ 에서 제공 (WebViewAssetLoader)
 * - 가져온 파일은 /__doc__/current 로 넘겨줌 (큰 파일도 문자열 변환 없이)
 * - 노트는 WebView 의 IndexedDB(앱 전용 저장 공간)에 저장. 인터넷 권한 없음
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private val io = Executors.newSingleThreadExecutor()

    @Volatile private var docBytes: ByteArray = ByteArray(0)
    private var pendingSave: ByteArray? = null
    private var pendingOpen: Pair<Uri, String?>? = null
    private var pageReady = false

    /** 노트로 가져올 파일: HWP·HWPX·PDF·사진 (여러 개 가능) */
    private val importDocs = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNullOrEmpty()) return@registerForActivityResult
        loadUris(uris)
    }

    /** 저장할 때 파일 이름과 형식(MIME)을 함께 넘기는 "다른 이름으로 저장" */
    private class CreateDoc : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.second)
                .putExtra(Intent.EXTRA_TITLE, input.first)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
            if (resultCode == RESULT_OK) intent?.data else null
    }

    private val createDoc = registerForActivityResult(CreateDoc()) { uri ->
        val bytes = pendingSave
        pendingSave = null
        if (uri == null || bytes == null) { js("moaApp.onSaved(false, '')"); return@registerForActivityResult }
        io.execute {
            try {
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: throw IllegalStateException("cannot open output")
                js("moaApp.onSaved(true, ${JSONObject.quote(displayName(uri) ?: "document")})")
            } catch (e: Exception) {
                js("moaApp.onSaved(false, ${JSONObject.quote(e.message ?: e.javaClass.simpleName)})")
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)

        // 상태 표시줄·내비게이션 바·키보드에 화면이 가리지 않게 여백을 줌
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/__doc__/") { _ ->
                WebResourceResponse("application/octet-stream", null, ByteArrayInputStream(docBytes)).apply {
                    responseHeaders = mapOf("Cache-Control" to "no-store")
                }
            }
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.addJavascriptInterface(Host(), "MoaHost")
        web.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    web.url?.endsWith("/www/index.html") == false && web.canGoBack() -> web.goBack()
                    pageReady -> web.evaluateJavascript("moaApp.handleBack()", null)
                    else -> finish()
                }
            }
        })

        handleViewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleViewIntent(intent)
    }

    /** 다른 앱(파일 관리자, 메신저)에서 "열기"·"공유"로 받은 문서를 새 노트로 가져옴 */
    private fun handleViewIntent(intent: Intent?) {
        val uri: Uri? = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri == null) return
        if (pageReady) loadUris(listOf(uri)) else pendingOpen = uri to intent?.type
    }

    /** 파일들을 차례로 읽어 웹으로 넘김 (하나씩: 웹이 읽고 나서 다음 것) */
    private fun loadUris(uris: List<Uri>) {
        io.execute {
            for (uri in uris) {
                try {
                    val out = ByteArrayOutputStream()
                    contentResolver.openInputStream(uri)?.use { input ->
                        val buf = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > MAX_BYTES) throw IllegalStateException(getString(R.string.too_large))
                            out.write(buf, 0, n)
                        }
                    } ?: throw IllegalStateException("cannot read")
                    val name = displayName(uri) ?: "document"
                    val mime = contentResolver.getType(uri) ?: ""
                    val done = java.util.concurrent.CountDownLatch(1)
                    importDone = done
                    docBytes = out.toByteArray()
                    js("moaApp.importFromHost(${JSONObject.quote(name)}, ${JSONObject.quote(mime)})")
                    // 웹이 다 가져올 때까지 기다림 (최대 3분)
                    done.await(180, java.util.concurrent.TimeUnit.SECONDS)
                } catch (e: Exception) {
                    runOnUiThread { toast(getString(R.string.open_failed, e.message ?: e.javaClass.simpleName)) }
                }
            }
        }
    }
    @Volatile private var importDone: java.util.concurrent.CountDownLatch? = null

    private fun displayName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    /** 웹(app.js)에서 window.MoaHost 로 부르는 함수들 */
    inner class Host {
        @JavascriptInterface
        fun onReady() = runOnUiThread {
            pageReady = true
            pendingOpen?.let { pendingOpen = null; loadUris(listOf(it.first)) }
        }

        /** 노트로 가져올 파일 고르기. 형식 이름(MIME)으로 HWP·PDF·사진만 고를 수 있게 함 */
        @JavascriptInterface
        fun importFile() = runOnUiThread { importDocs.launch(IMPORT_MIME_TYPES) }

        /** 웹이 가져오기를 마쳤다고 알림 → 다음 파일 */
        @JavascriptInterface
        fun importFinished() { importDone?.countDown() }

        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String) {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            runOnUiThread {
                pendingSave = bytes
                createDoc.launch(name to mime)
            }
        }

        /** PDF 를 다른 앱(삼성 노트, 카카오톡, 메일…)으로 보냄 */
        @JavascriptInterface
        fun sharePdf(base64: String, name: String) {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            io.execute {
                try {
                    val dir = File(cacheDir, "share").apply { deleteRecursively(); mkdirs() }
                    val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
                    val file = File(dir, safe).apply { writeBytes(bytes) }
                    val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
                    val send = Intent(Intent.ACTION_SEND)
                        .setType("application/pdf")
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .putExtra(Intent.EXTRA_TITLE, safe)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    runOnUiThread { startActivity(Intent.createChooser(send, safe)) }
                } catch (e: Exception) {
                    runOnUiThread { toast(getString(R.string.share_failed, e.message ?: e.javaClass.simpleName)) }
                }
            }
        }

        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }
    }

    override fun onDestroy() {
        web.removeJavascriptInterface("MoaHost")
        web.destroy()
        io.shutdown()
        super.onDestroy()
    }

    private companion object {
        const val MAX_BYTES = 100L * 1024 * 1024
        val IMPORT_MIME_TYPES = arrayOf(
            "application/pdf", "image/*",
            "application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp", "application/hwp",
            "application/hwp+zip", "application/vnd.hancom.hwpx", "application/haansofthwpx", "application/x-hwpx",
            "application/octet-stream", "application/zip",
        )
    }
}
