package com.ahlers.cavetrivia;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

/** Tiny wrapper around the app's only setting. The boot receiver is disabled while the toggle is off. */
final class Prefs {
    private static final String FILE = "arcade_tv";
    private static final String KEY_BOOT = "launch_on_boot";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static boolean launchOnBoot(Context c) {
        return sp(c).getBoolean(KEY_BOOT, false);
    }

    static void setLaunchOnBoot(Context c, boolean on) {
        sp(c).edit().putBoolean(KEY_BOOT, on).apply();
        c.getPackageManager().setComponentEnabledSetting(
                new ComponentName(c, BootReceiver.class),
                on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP);
    }
}
