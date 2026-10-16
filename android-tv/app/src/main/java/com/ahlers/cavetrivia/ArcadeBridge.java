package com.ahlers.cavetrivia;

import android.webkit.JavascriptInterface;

/**
 * Exposed to the page as window.ArcadeTV so the site can detect the TV shell and (later) offer the
 * boot toggle in its own settings. Navigation is locked to the site's host, so only the scoreboard
 * page can reach this. Methods run on a WebView binder thread.
 */
final class ArcadeBridge {
    private final MainActivity activity;

    ArcadeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean isTvApp() {
        return true;
    }

    @JavascriptInterface
    public String version() {
        return BuildConfig.VERSION_NAME;
    }

    @JavascriptInterface
    public boolean getLaunchOnBoot() {
        return Prefs.launchOnBoot(activity);
    }

    @JavascriptInterface
    public void setLaunchOnBoot(final boolean on) {
        activity.runOnUiThread(() -> activity.setLaunchOnBoot(on, false));
    }

    /** Lets the page close the app explicitly (e.g. from a future "Exit" menu item). */
    @JavascriptInterface
    public void exitApp() {
        activity.runOnUiThread(activity::finish);
    }
}
