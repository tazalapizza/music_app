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
// Both platforms are now backed by a small local Capacitor plugin sharing
// the same JS-facing shape (getVolume/setVolume/getMaxSteps/'volumeChanged'),
// but via very different native mechanisms, because the two OSes expose
// completely different capabilities here:
//   - Android: SystemVolumePlugin.java wraps AudioManager directly - a
//     conventional "read/write a value" API.
//   - iOS: SystemVolumePlugin.swift has no such API to wrap (confirmed via
//     Apple's own developer forums: there is no code-level way to set
//     system volume on iOS, period). Instead it installs a hidden
//     MPVolumeView purely to gain access to system volume at all, then
//     drives that view's internal UISlider programmatically - see that
//     file's own header comment for the full mechanism. The JS-facing
//     result is identical (same method names, same 0..1 convention), so
//     this file doesn't need to know or care which mechanism is behind it.
//   - Web (plain browser): no system-volume access exists in any browser
//     API, for sandboxing reasons unrelated to either native platform's
//     restrictions. Falls back to NativeAudioAdapter's app-level volume so
//     the slider still does SOMETHING sensible rather than nothing.
// ---------------------------------------------------------------------------

const SystemVolumeAdapter = (() => {
  const isNative = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || false;

  let plugin = null;
  function getPlugin() {
    if (!plugin) {
      plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemVolume;
    }
    return plugin;
  }

  // True on both Android and iOS now that both have a registered
  // SystemVolume plugin (SystemVolumePlugin.java / SystemVolumePlugin.swift
  // respectively) - see this file's header comment for how the two differ
  // under the hood despite sharing this one JS surface. False on plain web,
  // where callers (controls.js) should fall back to NativeAudioAdapter's
  // app-level volume instead.
  function isSupported() {
    return isNative() && !!getPlugin();
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