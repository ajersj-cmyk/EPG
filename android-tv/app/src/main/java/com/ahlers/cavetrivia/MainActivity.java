package com.ahlers.cavetrivia;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.util.Calendar;

/**
 * Thin, memory-light Android TV shell ("Cave Trivia") around the live Ahlers Arcade scoreboard.
 *
 * One WebView, no extra libraries. D-pad / OK reach the page natively; BACK, MENU and the media keys
 * are routed to the site's arcadeNav (BACK closes Gamecast / menu / settings first and only offers to
 * exit when nothing is open). Network failures show an arcade-style offline screen with auto-retry.
 * A fresh WebView shows the neon logo ("LOADING SCOREBOARD") until the page first paints.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "ArcadeTV";

    /** Asks the site to close whatever is open. Returns 'handled', 'idle' (nothing open) or 'none' (no arcadeNav). */
    private static final String JS_BACK =
            "(function(){try{if(typeof navBack!=='function')return 'none';"
            + "try{if(typeof navTouch==='function')navTouch();}catch(e){}"
            + "return navBack()?'handled':'idle';}catch(e){return 'err';}})()";

    private static final long[] RETRY_STEPS_MS = {5000, 10000, 20000, 30000, 60000};
    private static final long EXIT_DIALOG_TIMEOUT_MS = 15000;
    private static final long NIGHTLY_CHECK_MS = 10 * 60 * 1000L;
    private static final int NIGHTLY_HOUR = 4;
    private static final long LOADING_MAX_MS = 25000; // never leave the logo up longer than this

    private final Handler ui = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView web;
    private LinearLayout offline;
    private LinearLayout loading;
    private TextView offlineDetail;
    private TextView offlineCountdown;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private AlertDialog exitDialog;

    private String siteUrl;
    private String siteHost;
    private boolean mainFrameFailed;
    private boolean started;
    private boolean pendingReload;
    private int retryIndex;
    private long retryAt;
    private long lastLoadAt;
    private int backToken;
    private long recentCrashAt;
    private int recentCrashes;
    private ConnectivityManager.NetworkCallback netCallback;
    private long lastBackAt;
    private Object backCallback; // OnBackInvokedCallback on API 33+ (kept untyped so API 24 never loads the class)

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        siteUrl = getString(R.string.site_url);
        siteHost = Uri.parse(siteUrl).getHost();

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        w.setBackgroundDrawableResource(android.R.color.black);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect on debug builds only
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        buildOfflineScreen();
        createWebView();
        loadSite();
        registerNetworkCallback();
        registerBackCallback();
        ui.postDelayed(nightly, NIGHTLY_CHECK_MS);
    }

    /**
     * Android 13+ routes BACK through OnBackInvokedCallback (and apps targeting 16+ no longer get
     * KEYCODE_BACK / onBackPressed), so register one; older versions use the key path in dispatchKeyEvent.
     */
    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT < 33) return;
        OnBackInvokedCallback cb = this::onBackKeyDebounced;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
        backCallback = cb;
    }

    private void onBackKeyDebounced() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastBackAt < 250) return; // same press seen via both the key and the callback path
        lastBackAt = now;
        onBackKey();
    }

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        if (web == null) { // torn down while in the background to give memory back
            createWebView();
            loadSite();
        } else if (pendingReload) {
            loadSite();
        }
        pendingReload = false;
        web.onResume();
        web.resumeTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
    }

    @Override
    protected void onStop() {
        started = false;
        if (web != null) {
            web.onPause();
            web.pauseTimers(); // stops the page's polling/rotation timers while another app is in front
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (exitDialog != null) exitDialog.dismiss();
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((OnBackInvokedCallback) backCallback);
        }
        unregisterNetworkCallback();
        destroyWebView();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent); // singleTask: relaunch from the launcher just brings the running scoreboard forward
    }

    /** Low-RAM handling: trim caches while visible; drop the whole WebView (and its renderer) once hidden. */
    @Override
    @SuppressWarnings("deprecation")
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        Log.i(TAG, "onTrimMemory " + level + " started=" + started);
        if (web == null) return;
        if (!started && level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) {
            destroyWebView(); // recreated in onStart
        } else if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            web.clearCache(false); // in-memory cache only; disk cache keeps reloads fast
            web.evaluateJavascript("try{window.dispatchEvent(new Event('arcade-lowmem'))}catch(e){}", null);
        }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        if (web != null && !started) destroyWebView();
        else if (web != null) web.clearCache(false);
    }

    // ------------------------------------------------------------------ WebView

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.setKeepScreenOn(true);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) {
            // Let the system reclaim the renderer first when we're not visible.
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);              // localStorage: the site's settings persist
        s.setMediaPlaybackRequiresUserGesture(false); // background video / clips autoplay
        s.setCacheMode(WebSettings.LOAD_DEFAULT);  // honour HTTP caching (GitHub Pages sends max-age=600)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE); // https site; block risky http subresources
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                        // ignore system font scale: the layout is vh-based
        s.setSupportMultipleWindows(false);        // target=_blank loads stay in this single WebView
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + " CaveTriviaTV/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new ArcadeBridge(this), "ArcadeTV");
        web.setWebViewClient(new ArcadeClient());
        web.setWebChromeClient(new ArcadeChrome());
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.requestFocus();
        showLoading(); // a new WebView is blank until the page paints: show the logo instead of black
    }

    private void destroyWebView() {
        if (web == null) return;
        WebView old = web;
        web = null;
        pendingReload = false;
        root.removeView(old);
        old.stopLoading();
        old.setWebChromeClient(null);
        old.setWebViewClient(new WebViewClient());
        old.removeJavascriptInterface("ArcadeTV");
        old.loadUrl("about:blank");
        old.destroy();
        Log.i(TAG, "WebView destroyed");
    }

    private void loadSite() {
        if (web == null) return;
        cancelRetry();
        mainFrameFailed = false;
        lastLoadAt = SystemClock.elapsedRealtime();
        web.loadUrl(siteUrl);
    }

    private final class ArcadeClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            Uri u = request.getUrl();
            if (siteHost != null && siteHost.equalsIgnoreCase(u.getHost())) return false;
            // Kiosk stays on the scoreboard; anything else (e.g. a YouTube link) goes to the app that owns it.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException | SecurityException ignored) {
                Log.i(TAG, "blocked navigation to " + u);
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameFailed = false;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (view == web && !mainFrameFailed && !"about:blank".equals(url)) hideLoading();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (mainFrameFailed || "about:blank".equals(url)) return;
            retryIndex = 0;
            hideLoading();
            hideOffline();
            if (customView == null && view.getVisibility() == View.VISIBLE) view.requestFocus();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return; // the page already handles its own API failures
            mainFrameFailed = true;
            showOffline(String.valueOf(error.getDescription()));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!request.isForMainFrame() || response.getStatusCode() < 400) return;
            mainFrameFailed = true;
            showOffline("HTTP " + response.getStatusCode());
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Renderer crashed or was killed for memory: rebuild instead of letting the app die.
            Log.w(TAG, "renderer gone, crashed=" + (Build.VERSION.SDK_INT >= 26 && detail.didCrash()));
            long now = SystemClock.elapsedRealtime();
            if (now - recentCrashAt > 60000) recentCrashes = 0;
            recentCrashAt = now;
            recentCrashes++;
            if (view == web) {
                destroyWebView();
                if (started) {
                    createWebView();
                    if (recentCrashes > 3) { mainFrameFailed = true; showOffline("Scoreboard keeps crashing"); }
                    else loadSite();
                }
            } else {
                view.destroy();
            }
            return true;
        }
    }

    private final class ArcadeChrome extends WebChromeClient {
        private Bitmap blankPoster;

        @Override
        public Bitmap getDefaultVideoPoster() {
            // Avoid the grey "play" poster flashing before autoplay video starts.
            if (blankPoster == null) blankPoster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            return blankPoster;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customViewCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            if (web != null) web.setVisibility(View.INVISIBLE);
            view.requestFocus();
        }

        @Override
        public void onHideCustomView() {
            exitCustomView();
        }
    }

    private void exitCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        if (web != null) { web.setVisibility(View.VISIBLE); web.requestFocus(); }
    }

    // ------------------------------------------------------------------ keys

    @Override
    @SuppressLint("GestureBackNavigation") // BACK also goes through OnBackInvokedCallback on 33+, see registerBackCallback
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        boolean up = e.getAction() == KeyEvent.ACTION_UP;

        if (code == KeyEvent.KEYCODE_BACK) {
            if (up && !e.isCanceled()) onBackKeyDebounced();
            return true;
        }
        if (offlineVisible()) {
            if (isOkKey(code)) { if (up) retryNow(); return true; }
            return true; // nothing behind the offline screen is useful
        }
        if (customView != null || web == null) return super.dispatchKeyEvent(e);

        String key = null;
        int jsCode = 0;
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                key = "MediaPlayPause"; jsCode = 179; break;   // arcadeNav: pause / resume rotation
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                key = "ArrowRight"; jsCode = 39; break;        // next slide / next game
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                key = "ArrowLeft"; jsCode = 37; break;
            case KeyEvent.KEYCODE_MENU:
                key = "ContextMenu"; jsCode = 93; break;       // opens the site's settings
            default:
                break;
        }
        if (key != null) {
            if (down && e.getRepeatCount() == 0) sendKeyToPage(key, jsCode);
            return true;
        }
        // D-pad, OK/Enter and everything else go to the page natively (arcadeNav handles them).
        if (down && !web.hasFocus()) web.requestFocus();
        return super.dispatchKeyEvent(e);
    }

    private static boolean isOkKey(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_BUTTON_A;
    }

    private void sendKeyToPage(String key, int keyCode) {
        String js = "(function(k,c){var t=document.activeElement||document.body;"
                + "function f(type){var e=new KeyboardEvent(type,{key:k,code:k,bubbles:true,cancelable:true});"
                + "try{Object.defineProperty(e,'keyCode',{get:function(){return c}});Object.defineProperty(e,'which',{get:function(){return c}});}catch(x){}"
                + "t.dispatchEvent(e);}"
                + "f('keydown');f('keyup');})('" + key + "'," + keyCode + ")";
        web.evaluateJavascript(js, null);
    }

    /** BACK goes to the site first; only when nothing is open there do we offer to leave. */
    private void onBackKey() {
        if (customView != null) { exitCustomView(); return; }
        if (web == null || offlineVisible()) { showExitDialog(); return; }
        final int token = ++backToken;
        final Runnable fallback = () -> { if (token == backToken) { backToken++; showExitDialog(); } };
        ui.postDelayed(fallback, 700); // page hung / not loaded: don't trap the user
        web.evaluateJavascript(JS_BACK, result -> {
            if (token != backToken) return;
            backToken++;
            ui.removeCallbacks(fallback);
            String r = result == null ? "" : result.replace("\"", "");
            if ("handled".equals(r)) return;
            if ("none".equals(r) && web != null && web.canGoBack()) { web.goBack(); return; }
            showExitDialog();
        });
    }

    private void showExitDialog() {
        if (exitDialog != null && exitDialog.isShowing()) return;
        final String[] items = {
                "Keep watching",
                "Exit Cave Trivia",
                "Reload scoreboard",
                "Launch on boot: " + (Prefs.launchOnBoot(this) ? "ON" : "OFF"),
        };
        exitDialog = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Press BACK again to exit")
                .setItems(items, (d, which) -> {
                    if (which == 1) finish();
                    else if (which == 2) { mainFrameFailed = false; retryIndex = 0; loadSite(); }
                    else if (which == 3) setLaunchOnBoot(!Prefs.launchOnBoot(this), true);
                })
                .create();
        exitDialog.setCanceledOnTouchOutside(false);
        // BACK on the dialog cancels it (key path or OnBackInvokedCallback, depending on the Android version):
        // that's the second BACK, so leave. Picking an item or the 15 s timeout only dismisses.
        exitDialog.setOnCancelListener(d -> finish());
        exitDialog.setOnDismissListener(d -> {
            ui.removeCallbacks(dismissExitDialog);
            applyImmersive();
            if (web != null && !offlineVisible()) web.requestFocus();
        });
        exitDialog.show();
        ui.postDelayed(dismissExitDialog, EXIT_DIALOG_TIMEOUT_MS); // kiosk: never leave the dialog up
    }

    private final Runnable dismissExitDialog = () -> { if (exitDialog != null && exitDialog.isShowing()) exitDialog.dismiss(); };

    void setLaunchOnBoot(boolean on, boolean fromDialog) {
        Prefs.setLaunchOnBoot(this, on);
        String msg = "Launch on boot " + (on ? "ON" : "OFF");
        if (on && Build.VERSION.SDK_INT >= 29 && !Settings.canDrawOverlays(this)) {
            // Android 10+ needs "Display over other apps" for a boot-time launch. Many TV builds hide that
            // screen; FLYNN.md has the one-line adb alternative.
            msg += "\nAllow 'Display over other apps' for Cave Trivia so it can start at boot";
            if (fromDialog) {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException | SecurityException ignored) {
                    msg += " (adb: appops set " + getPackageName() + " SYSTEM_ALERT_WINDOW allow)";
                }
            }
        }
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    // ------------------------------------------------------------------ offline screen

    private void buildOfflineScreen() {
        int splash = getResources().getColor(R.color.arcade_splash, getTheme());

        // Loading screen (below the offline screen): logo + "LOADING SCOREBOARD...". Never focusable, so keys
        // still reach the WebView underneath.
        loading = new LinearLayout(this);
        loading.setOrientation(LinearLayout.VERTICAL);
        loading.setGravity(Gravity.CENTER);
        loading.setBackgroundColor(splash);
        loading.setFocusable(false);
        loading.setVisibility(View.GONE);
        loading.addView(logo(380));
        TextView lt = label(getString(R.string.loading), 20, Color.rgb(255, 176, 0), true);
        lt.setAlpha(0.85f);
        loading.addView(lt);
        root.addView(loading, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER);
        offline.setBackgroundColor(splash);
        offline.setFocusable(true);
        offline.setVisibility(View.GONE);

        offline.addView(logo(260));
        TextView title = label("SIGNAL LOST", 64, Color.rgb(255, 0, 127), true);
        title.setShadowLayer(24, 0, 0, Color.rgb(255, 0, 127));
        offline.addView(title);
        offlineDetail = label("", 22, Color.rgb(200, 200, 220), false);
        offline.addView(offlineDetail);
        offlineCountdown = label("", 30, Color.rgb(255, 230, 0), true);
        offline.addView(offlineCountdown);
        offline.addView(label("OK = retry now   \u00B7   BACK = exit", 20, Color.rgb(150, 150, 170), false));
        root.addView(offline, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** The neon "Cave Trivia" wordmark (drawable-xhdpi/logo_wordmark.webp, 300x125 dp native). */
    private ImageView logo(int widthDp) {
        ImageView iv = new ImageView(this);
        iv.setImageResource(R.drawable.logo_wordmark);
        iv.setAdjustViewBounds(true);
        iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
        iv.setContentDescription(getString(R.string.app_name));
        int w = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, widthDp, getResources().getDisplayMetrics());
        iv.setLayoutParams(new LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT));
        return iv;
    }

    private void showLoading() {
        if (loading == null) return;
        loading.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideLoadingRunnable);
        ui.postDelayed(hideLoadingRunnable, LOADING_MAX_MS);
    }

    private void hideLoading() {
        ui.removeCallbacks(hideLoadingRunnable);
        if (loading != null && loading.getVisibility() != View.GONE) loading.setVisibility(View.GONE);
    }

    private final Runnable hideLoadingRunnable = this::hideLoading;

    private TextView label(String text, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(Typeface.MONOSPACE, bold ? Typeface.BOLD : Typeface.NORMAL);
        t.setGravity(Gravity.CENTER);
        t.setLetterSpacing(0.08f);
        int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 8, getResources().getDisplayMetrics());
        t.setPadding(pad, pad, pad, pad);
        return t;
    }

    private boolean offlineVisible() {
        return offline != null && offline.getVisibility() == View.VISIBLE;
    }

    private void showOffline(String why) {
        Log.w(TAG, "main frame failed: " + why);
        hideLoading();
        offlineDetail.setText(isOnline() ? "Can't reach the scoreboard (" + why + ")" : "No network connection");
        offline.setVisibility(View.VISIBLE);
        offline.requestFocus();
        if (web != null) web.stopLoading();
        scheduleRetry();
    }

    private void hideOffline() {
        cancelRetry();
        if (!offlineVisible()) return;
        offline.setVisibility(View.GONE);
        if (web != null) web.requestFocus();
    }

    private void scheduleRetry() {
        cancelRetry();
        long delay = RETRY_STEPS_MS[Math.min(retryIndex, RETRY_STEPS_MS.length - 1)];
        retryIndex++;
        retryAt = SystemClock.elapsedRealtime() + delay;
        ui.post(countdown);
    }

    private void cancelRetry() {
        ui.removeCallbacks(countdown);
        retryAt = 0;
    }

    private void retryNow() {
        cancelRetry();
        offlineCountdown.setText("RECONNECTING\u2026");
        if (web == null) createWebView();
        loadSite();
    }

    private final Runnable countdown = new Runnable() {
        @Override
        public void run() {
            if (!offlineVisible() || retryAt == 0) return;
            long left = retryAt - SystemClock.elapsedRealtime();
            if (left <= 0) {
                if (!started) { pendingReload = true; return; }
                retryNow();
                return;
            }
            offlineCountdown.setText("RETRYING IN " + ((left + 999) / 1000) + "s");
            ui.postDelayed(this, Math.min(1000, left));
        }
    };

    // ------------------------------------------------------------------ network + housekeeping

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        Network n = cm.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void registerNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                // Network is back: retry soon instead of waiting out the backoff.
                ui.postDelayed(() -> { if (offlineVisible() && started) { retryIndex = 0; retryNow(); } }, 1500);
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (RuntimeException e) {
            netCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null || netCallback == null) return;
        try { cm.unregisterNetworkCallback(netCallback); } catch (RuntimeException ignored) {}
        netCallback = null;
    }

    /** A 24/7 kiosk page slowly accumulates memory; reload once a night (~4 AM) to start fresh. */
    private final Runnable nightly = new Runnable() {
        @Override
        public void run() {
            int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
            long sinceLoad = SystemClock.elapsedRealtime() - lastLoadAt;
            if (hour == NIGHTLY_HOUR && sinceLoad > 6 * 3600 * 1000L && web != null && started && !offlineVisible()) {
                Log.i(TAG, "nightly reload");
                loadSite();
            }
            ui.postDelayed(this, NIGHTLY_CHECK_MS);
        }
    };

    @SuppressWarnings("deprecation")
    private void applyImmersive() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }
}
