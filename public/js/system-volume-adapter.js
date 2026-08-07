// ---------------------------------------------------------------------------
// system-volume-adapter.js — controls the DEVICE's real system volume.
//
// This is deliberately separate from native-audio-adapter.js:
//   - NativeAudioAdapter.setVolume() controls this APP's own output gain
//     (used for ReplayGain, muting just this app, etc.) - it was never
//     meant to and cannot move the phone's actual volume.
//   - SystemVolumeAdapter (this file) controls the DEVICE's real system
//     media volume - the same value the physical volume buttons move,
//     shared by every app. This is what makes the in-app slider behave
//     like Documents/Spotify's embedded volume control.
//
// Platform support is asymmetric, and that's an OS restriction, not a
// choice made here:
//   - Android: fully supported via a small local Capacitor plugin
//     (SystemVolumePlugin.java) wrapping AudioManager. See that file's own
//     header comment for why this needed a custom plugin at all.
//   - iOS: NOT supported by this file. iOS has no API to set system volume
//     from code, full stop - not via this plugin, not via any plugin. The
//     only sanctioned mechanism is embedding MPVolumeView, Apple's own
//     native UI widget, which owns its own rendering AND its own drag
//     gesture - it cannot be driven from JS the way this adapter drives
//     Android. That is a separate, native-Swift task, tracked outside this
//     file (see the project's iOS system-volume integration notes).
//   - Web (plain browser): no system-volume access exists in any browser
//     API for the same reasons as iOS, for different underlying reasons
//     (sandboxing). Falls back to NativeAudioAdapter's app-level volume so
//     the slider still does SOMETHING sensible rather than nothing.
// ---------------------------------------------------------------------------

const SystemVolumeAdapter = (() => {
  const isNative = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || false;
  const isAndroid = () => isNative() && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android';

  let plugin = null;
  function getPlugin() {
    if (!plugin) {
      plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemVolume;
    }
    return plugin;
  }

  // True only on Android, where SystemVolumePlugin.java actually exists and
  // is registered. Callers (controls.js) should check this before wiring up
  // system-volume-specific UI, and fall back to NativeAudioAdapter's
  // app-level volume everywhere else (iOS, web) - see this file's own
  // header comment for why those platforms can't support this at all via a
  // JS-callable plugin.
  function isSupported() {
    return isAndroid() && !!getPlugin();
  }

  // Returns a Promise<number> (0..1), matching NativeAudioAdapter.setVolume's
  // convention so calling code can treat both the same way.
  async function getVolume() {
    const p = getPlugin();
    if (!p) return null;
    try {
      const { volume } = await p.getVolume();
      return typeof volume === 'number' ? volume : null;
    } catch {
      return null;
    }
  }

  async function setVolume(v) {
    const p = getPlugin();
    if (!p) return;
    const clamped = Math.max(0, Math.min(1, v));
    try {
      await p.setVolume({ volume: clamped });
    } catch {
      // Swallowed deliberately - a failed system-volume write shouldn't
      // break playback or throw an unhandled rejection into a UI event
      // handler. Worth revisiting with a console.error if this turns out
      // to fail silently often in practice (see the load()-preload()
      // debugging story in native-audio-adapter.js for the pattern to
      // follow if that's needed).
    }
  }

  // Registers a callback fired whenever system volume changes for ANY
  // reason - including the physical volume buttons, another app, a
  // Bluetooth device's own controls, etc. - not just changes made through
  // setVolume() above. This is what lets the in-app slider stay live-synced
  // if the user presses the physical buttons while the app is open.
  function onVolumeChanged(cb) {
    const p = getPlugin();
    if (!p || !p.addListener) return;
    p.addListener('volumeChanged', (event) => {
      if (typeof event.volume === 'number') cb(event.volume);
    });
  }

  return { isSupported, getVolume, setVolume, onVolumeChanged };
})();