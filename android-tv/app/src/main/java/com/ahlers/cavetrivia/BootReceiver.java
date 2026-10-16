package com.ahlers.cavetrivia;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Opens the scoreboard after the TV boots when "Launch on boot" is on. Disabled in the manifest and only
 * enabled by {@link Prefs#setLaunchOnBoot}. On Android 10+ the system only allows this background
 * activity start when the app holds "Display over other apps" (SYSTEM_ALERT_WINDOW); see FLYNN.md.
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !"android.intent.action.QUICKBOOT_POWERON".equals(a)) return;
        if (!Prefs.launchOnBoot(context)) return;
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try {
            context.startActivity(open);
        } catch (RuntimeException ignored) {
            // Blocked by background-activity-start rules; nothing else to do from a receiver.
        }
    }
}
