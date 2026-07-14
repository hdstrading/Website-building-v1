# Keep the JavaScript bridge intact so WebView can call into it.
-keepclassmembers class com.hdstrading.phpayroll.MainActivity$WebAppBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
