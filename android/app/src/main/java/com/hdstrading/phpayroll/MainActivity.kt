package com.hdstrading.phpayroll

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File

/**
 * Single-activity wrapper that hosts the fully-offline payroll web app in a
 * WebView. It adds native handling for the two things a WebView cannot do on
 * its own: picking a file for the DTR / backup upload, and saving/printing
 * exports (CSV, JSON, and PDF payslips/reports).
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>

    // Held so the off-screen print WebView is not garbage-collected mid-print.
    private var printWebViewRef: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result: ActivityResult ->
            val cb = fileChooserCallback
            fileChooserCallback = null
            if (cb == null) return@registerForActivityResult
            cb.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
        }

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // enables localStorage persistence
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val intent = params?.createIntent()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "*/*"
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }
                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    toast("Cannot open file picker: ${e.message}")
                    false
                }
            }
        }
        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(WebAppBridge(), "AndroidBridge")
        webView.loadUrl("file:///android_asset/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun toast(msg: String) {
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    }

    /** Methods callable from JavaScript as `window.AndroidBridge.*`. */
    inner class WebAppBridge {

        /** Save a base64-encoded (UTF-8) file to the device's Downloads. */
        @JavascriptInterface
        fun saveBase64File(name: String, base64: String, mime: String) {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            runOnUiThread {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val values = ContentValues().apply {
                            put(MediaStore.Downloads.DISPLAY_NAME, name)
                            put(MediaStore.Downloads.MIME_TYPE, mime)
                            put(MediaStore.Downloads.IS_PENDING, 1)
                        }
                        val resolver = contentResolver
                        val uri = resolver.insert(
                            MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
                        ) ?: throw Exception("Could not create file")
                        resolver.openOutputStream(uri)?.use { it.write(bytes) }
                        values.clear()
                        values.put(MediaStore.Downloads.IS_PENDING, 0)
                        resolver.update(uri, values, null, null)
                    } else {
                        // API 26–28: write to the app-specific Downloads dir
                        // (no runtime storage permission required).
                        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                        val file = File(dir, name)
                        file.outputStream().use { it.write(bytes) }
                    }
                } catch (e: Exception) {
                    toast("Save failed: ${e.message}")
                }
            }
        }

        /** Print (or Save-as-PDF) an HTML document via the OS print framework. */
        @JavascriptInterface
        fun printHtml(title: String, base64Html: String) {
            val html = String(Base64.decode(base64Html, Base64.DEFAULT), Charsets.UTF_8)
            runOnUiThread {
                val printer = WebView(this@MainActivity)
                printer.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        val jobName = if (title.isBlank()) "PH Payroll" else title
                        val printManager = getSystemService(PRINT_SERVICE) as PrintManager
                        val adapter = view.createPrintDocumentAdapter(jobName)
                        printManager.print(
                            jobName,
                            adapter,
                            PrintAttributes.Builder().build()
                        )
                        printWebViewRef = null
                    }
                }
                printer.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                printWebViewRef = printer
            }
        }
    }
}
