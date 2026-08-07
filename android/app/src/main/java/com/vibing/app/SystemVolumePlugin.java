package com.vibing.app;

// ---------------------------------------------------------------------------
// SystemVolumePlugin.java — local Capacitor plugin (Android only).
//
// WHY THIS EXISTS: NativeAudioAdapter's setVolume() (see native-audio-
// adapter.js in the web project) controls this app's OWN output gain,
// layered on top of whatever the phone's system volume happens to be - it
// cannot move the actual system volume, and was never meant to. This is a
// separate, complementary control: it reads/writes Android's real
// STREAM_MUSIC volume (the same value the physical volume buttons and every
// other app's "volume" setting share), so the in-app slider can act as a
// skinned, embedded version of the OS's own volume control - the same
// pattern apps like Documents/Spotify use, just done with AudioManager
// directly here since there is no off-the-shelf Capacitor plugin for it.
//
// There is no iOS equivalent of this class. iOS has no API to set system
// volume from code at all (confirmed via Apple's own developer forums) -
// the only sanctioned way is embedding MPVolumeView, a native UI widget
// that manages its own gesture/drag interaction. That is a separate, iOS-
// only native-UI task, not a JS-callable plugin like this one, and is
// intentionally NOT part of this file.
// ---------------------------------------------------------------------------

import android.content.Context;
import android.media.AudioManager;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SystemVolume")
public class SystemVolumePlugin extends Plugin {

    private AudioManager audioManager;
    private BroadcastReceiver volumeReceiver;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);

        // Fires whenever STREAM_MUSIC volume changes for ANY reason -
        // including the physical volume buttons, another app, a Bluetooth
        // headset's own controls, etc. - not just when this plugin's own
        // setVolume() below is called. This is what lets the in-app slider
        // stay live-synced if the user presses the physical buttons while
        // the app is open, matching how a real embedded system control
        // (like MPVolumeView on iOS) behaves.
        volumeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if ("android.media.VOLUME_CHANGED_ACTION".equals(intent.getAction())) {
                    int streamType = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1);
                    if (streamType == AudioManager.STREAM_MUSIC) {
                        JSObject data = new JSObject();
                        data.put("volume", getCurrentVolumeFraction());
                        notifyListeners("volumeChanged", data);
                    }
                }
            }
        };
        getContext().registerReceiver(volumeReceiver, new IntentFilter("android.media.VOLUME_CHANGED_ACTION"));
    }

    @Override
    protected void handleOnDestroy() {
        // Avoid leaking the receiver if the plugin/activity is torn down -
        // registerReceiver() without a matching unregister is a classic
        // Android leak source.
        if (volumeReceiver != null) {
            try { getContext().unregisterReceiver(volumeReceiver); } catch (Exception e) { /* already unregistered */ }
        }
        super.handleOnDestroy();
    }

    private double getCurrentVolumeFraction() {
        int current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (max <= 0) return 0;
        return (double) current / (double) max;
    }

    // getVolume(): returns the current system media volume as a 0..1
    // fraction, matching the convention NativeAudioAdapter.setVolume()
    // already uses (audioEl.volume-style 0..1), so the web-side code can
    // treat both the same way rather than juggling two different scales.
    @PluginMethod
    public void getVolume(PluginCall call) {
        JSObject result = new JSObject();
        result.put("volume", getCurrentVolumeFraction());
        call.resolve(result);
    }

    // setVolume({ volume: 0..1 }): sets the real system media volume.
    // FLAG_SHOW_UI is deliberately omitted - since the app itself already
    // shows a volume slider, the OS's own on-screen volume HUD popping up
    // at the same time would be redundant/visually conflicting. Physical
    // button presses still show the OS HUD as normal; this only affects
    // the HUD's behavior for changes made THROUGH this plugin.
    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (volume == null) {
            call.reject("Missing required 'volume' parameter (expected a number between 0 and 1)");
            return;
        }
        double clamped = Math.max(0.0, Math.min(1.0, volume));
        int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int target = (int) Math.round(clamped * max);
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0 /* no FLAG_SHOW_UI - see above */);
        call.resolve();
    }

    // getMaxSteps(): Android's volume isn't continuous - it has a fixed
    // number of discrete steps (commonly 15, but varies by device/OEM).
    // Exposed in case the web UI ever wants to snap the slider to actual
    // achievable steps rather than showing a smooth 0..1 range that maps
    // to a coarser real value underneath. Not currently consumed by
    // volume-bar-sync.js (see its own comment on this) but provided for
    // completeness/future use.
    @PluginMethod
    public void getMaxSteps(PluginCall call) {
        JSObject result = new JSObject();
        result.put("steps", audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        call.resolve(result);
    }
}