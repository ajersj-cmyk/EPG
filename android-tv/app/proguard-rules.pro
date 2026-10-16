# The JS bridge is called by name from the page.
-keepclassmembers class com.ahlers.cavetrivia.ArcadeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
