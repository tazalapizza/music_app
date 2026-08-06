// ---------------------------------------------------------------------------
// native-audio-adapter.js — native-audio migration adapter (Steps 1-3).
//
// Why this file exists: iOS Safari (and WKWebView, which Capacitor uses
// under the hood) does not support setting <audio>.volume — it's hard-locked
// to the hardware volume. There is no web workaround for this (GainNode was
// tried for ReplayGain and had to be disabled on mobile — see the long
// comment in state.js — because rerouting <audio> through a WebAudio graph
// makes iOS suspend/kill audio far more aggressively in the background).
// The only real fix is native playback via @capgo/capacitor-native-audio,
// which exposes a genuine setVolume() on iOS/Android.
//
// Scope so far:
//   STEP 1 (done): play / pause / resume / track-loading / volume / mute.
//   STEP 2 (done, later revised - see below): native 'track ended'
//     detection and current-time/duration/seek, plus every other
//     audioEl-dependent feature found along the way (mobile full-player
//     seek bar, swipe-to-seek, keyboard seek, synced lyrics x2, MediaSession
//     lock-screen handlers).
//   STEP 3 (done): playback speed (setRate), ReplayGain applied via native
//     volume instead of the WebAudio GainNode graph that had to stay
//     disabled on mobile (see state.js), and lock-screen Now Playing
//     metadata (title/artist/album/art) via notificationMetadata.
//   REVISION (this pass): Step 2 was originally built on a 'stop'-event
//     heuristic for track-end detection and a requestAnimationFrame poll
//     loop (with per-tick getCurrentTime() round-trips) for position
//     tracking, because that's what the plugin's docs surfaced at the time.
//     The plugin actually exposes purpose-built events for both: 'complete'
//     (fires only on natural end-of-track) and 'currentTime' (pushed
//     automatically ~every 100ms during playback). Both are used instead
//     now - see bindNativeListenersOnce, onTimeUpdate, and getCurrentTime.
// NOT yet covered (Step 4): buffered-download progress display - there is
// still no native equivalent for this in the plugin's API at all.
//
// Platform behavior:
//   - Web (PWA in a browser): NativeAudioAdapter delegates straight to
//     audioEl, unchanged from before this file existed.
//   - Native (Capacitor iOS/Android shell): delegates to the
//     @capgo/capacitor-native-audio plugin instead.
//
// Every call site elsewhere in the app should go through NativeAudioAdapter,
// not call audioEl or NativeAudio directly, so the platform branch lives in
// exactly one place.
// ---------------------------------------------------------------------------

const NativeAudioAdapter = (() => {
  // Capacitor.isNativePlatform() is provided by @capacitor/core, loaded
  // before this file (see index.html script order). Falls back to false
  // if Capacitor hasn't loaded for some reason, so the app still works as
  // a plain web page.
  const isNative = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || false;

  // Single fixed assetId: this app only ever plays one track at a time
  // (see queue/queueIndex in state.js), so there's no need for the
  // multi-asset bookkeeping NativeAudio's API is built to support.
  const ASSET_ID = 'current-track';

  let NativeAudio = null; // lazily bound to window.Capacitor.Plugins.NativeAudio on first native use
  let configured = false;
  let currentSrc = null;   // last src passed to load(), for isLoaded()/idempotency checks
  let currentVolume = 1;   // 0..1, mirrors audioEl.volume's range regardless of platform
  let currentMuted = false;
  let nativePlaying = false; // NativeAudio has no synchronous .paused - tracked manually
  let cachedDuration = NaN; // seconds; kept fresh by the currentTime event below (it carries duration isn't included, so this still comes from load()'s getDuration() call, but is also corrected opportunistically if a later call surfaces a better value)
  let liveCurrentTime = 0;  // seconds; kept fresh by the 'currentTime' event, pushed ~every 100ms while playing - see bindNativeListenersOnce
  let listenersBound = false;
  const endedCallbacks = []; // playback.js registers its 'track finished' handler here on native
  const playStartedCallbacks = []; // fired from play() on native - the equivalent of audioEl's 'play' event, for consumers with no other native hook
  const timeUpdateCallbacks = []; // fired on every native 'currentTime' event - the equivalent of audioEl's 'timeupdate' event

  function getPlugin() {
    if (!NativeAudio) {
      NativeAudio = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeAudio;
    }
    return NativeAudio;
  }

  // REVISED: earlier versions of this adapter approximated "track ended" by
  // watching the general-purpose 'stop' event (fired for pauses too, so it
  // needed a fragile nativePlaying flag to disambiguate) and polled position
  // via repeated getCurrentTime() round-trips on a requestAnimationFrame
  // loop. NativeAudio actually exposes purpose-built events for both: a
  // 'complete' event that fires ONLY on natural end-of-track (no ambiguity
  // with pause/stop), and a 'currentTime' event pushed automatically by the
  // native side roughly every 100ms during playback (no round-trip needed
  // per tick, no risk of the poll loop drifting out of sync with actual
  // native playback rate/seeks). Both are strictly better than what they
  // replace and are used instead everywhere in this file now.
  function bindNativeListenersOnce() {
    if (listenersBound) return;
    const plugin = getPlugin();
    if (!plugin || !plugin.addListener) return;
    listenersBound = true;

    plugin.addListener('complete', () => {
      nativePlaying = false;
      endedCallbacks.forEach(cb => { try { cb(); } catch {} });
    });

    plugin.addListener('currentTime', (event) => {
      if (typeof event.currentTime === 'number') liveCurrentTime = event.currentTime;
      timeUpdateCallbacks.forEach(cb => { try { cb(); } catch {} });
    });
  }

  // Registers a callback for "the current track finished playing on its
  // own" - the native equivalent of audioEl's 'ended' event. No-op on web;
  // playback.js's own audioEl 'ended' listener already covers that path.
  function onEnded(cb) {
    endedCallbacks.push(cb);
  }

  // Registers a callback for "playback just started on native" - the
  // equivalent of audioEl's 'play' event for consumers (MediaSession
  // handlers, etc.) that used to piggyback on it. No-op on web; those
  // consumers already have a real audioEl 'play' listener there.
  function onPlayStarted(cb) {
    playStartedCallbacks.push(cb);
  }

  // Registers a callback fired on every native currentTime tick (~100ms
  // while playing) - the equivalent of audioEl's 'timeupdate' event. This
  // is what the seek bar, fpSeekBar, synced lyrics, and MediaSession
  // position reporting all subscribe to on native, replacing the shared
  // requestAnimationFrame poll loop the previous version of this file used.
  function onTimeUpdate(cb) {
    timeUpdateCallbacks.push(cb);
  }

  async function ensureConfigured() {
    if (configured) return;
    configured = true;
    const plugin = getPlugin();
    if (!plugin) return;
    bindNativeListenersOnce();
    await plugin.configure({
      focus: true,
      background: true,       // keep playing when app is backgrounded/screen locked
      ignoreSilent: true,     // this is a music player, not a sound-effect; play through the silent switch like Music/Spotify do
      showNotification: true  // lock-screen/Control Center Now Playing - also required for background playback to be reliable on iOS
    });
  }

  // Loads a new track. Mirrors the old `audioEl.src = ...; audioEl.play()`
  // shape used throughout playback.js, but async since NativeAudio's
  // preload/play round-trips to native code.
  //
  // STEP 3: `meta` is optional lock-screen/Control Center Now Playing info
  // ({title, artist, album, artworkUrl}) - passed straight through to
  // NativeAudio's notificationMetadata, which only actually renders since
  // configure() sets showNotification: true (see ensureConfigured above).
  // Omitted or partial fields are fine; NativeAudio falls back to generic
  // display for whatever's missing.
  async function load(streamUrl, meta) {
    currentSrc = streamUrl;
    cachedDuration = NaN;
    liveCurrentTime = 0;
    if (!isNative()) {
      audioEl.src = streamUrl;
      return;
    }
    const plugin = getPlugin();
    if (!plugin) return; // shouldn't happen on native, but don't hard-crash playback if it does
    await ensureConfigured();
    // unload() is safe to call even if nothing is loaded under this
    // assetId yet (first track of the session) - NativeAudio no-ops on an
    // unknown assetId rather than throwing, per its docs.
    try { await plugin.unload({ assetId: ASSET_ID }); } catch {}
    nativePlaying = false;
    const preloadOpts = {
      assetId: ASSET_ID,
      assetPath: streamUrl,
      isUrl: true,
      // STEP 3 FIX: this previously ignored replayGainFactor entirely, so a
      // track loaded while ReplayGain was actively boosting/attenuating the
      // *previous* track would briefly start at the wrong volume until the
      // next explicit setVolume()/setReplayGainFactor() call corrected it.
      volume: currentMuted ? 0 : currentVolume * replayGainFactor
    };
    if (meta && (meta.title || meta.artist || meta.album || meta.artworkUrl)) {
      preloadOpts.notificationMetadata = meta;
    }
    await plugin.preload(preloadOpts);
    // Duration isn't known until the native side has actually opened the
    // file/stream - fetch it once right after preload rather than lazily on
    // first getDuration() call, so the seek bar's "total time" is ready as
    // soon as playback starts instead of showing 0:00 for the first poll
    // tick. Best-effort: if this fails (e.g. slow network), getDuration()
    // below will simply keep returning NaN until a later poll succeeds.
    try {
      const { duration } = await plugin.getDuration({ assetId: ASSET_ID });
      if (typeof duration === 'number' && isFinite(duration) && duration > 0) {
        cachedDuration = duration;
      }
    } catch {}
  }

  async function play() {
    if (!isNative()) return audioEl.play();
    const plugin = getPlugin();
    if (!plugin) return;
    nativePlaying = true; // set before the await, so paused() reads correctly the instant play() is called, matching audioEl's synchronous behavior as closely as possible
    await plugin.play({ assetId: ASSET_ID });
    playStartedCallbacks.forEach(cb => { try { cb(); } catch {} });
  }

  async function pause() {
    if (!isNative()) return audioEl.pause();
    const plugin = getPlugin();
    if (!plugin) return;
    // Set false *before* calling the plugin so a 'complete' event that
    // might already be in flight isn't misattributed - complete only fires
    // on natural end-of-track now (see bindNativeListenersOnce), so this is
    // mostly precautionary, but keeps paused() correct the instant pause()
    // is called either way.
    nativePlaying = false;
    await plugin.pause({ assetId: ASSET_ID });
  }

  function paused() {
    if (!isNative()) return audioEl.paused;
    return !nativePlaying;
  }

  // Current playback position, in seconds - mirrors audioEl.currentTime's
  // unit and, on native, its synchronous feel too: liveCurrentTime is kept
  // fresh by the 'currentTime' event (~100ms cadence) rather than fetched
  // per-call, so this is a plain synchronous read on both platforms now
  // (no promise, no round-trip - a real simplification over Step 2's
  // polling version, which had to be async to await a native call).
  function getCurrentTime() {
    if (!isNative()) return audioEl.currentTime;
    return liveCurrentTime;
  }

  // Duration in seconds. Returns the cached value from load() when
  // available (near-instant, matches audioEl.duration's synchronous feel)
  // and NaN otherwise - callers already guard on `!isFinite(duration)`
  // throughout playback.js, so NaN correctly short-circuits those the same
  // way an unset audioEl.duration would.
  function getDuration() {
    if (!isNative()) return audioEl.duration;
    return cachedDuration;
  }

  async function seekTo(seconds) {
    if (!isNative()) {
      audioEl.currentTime = seconds;
      return;
    }
    const plugin = getPlugin();
    if (!plugin) return;
    liveCurrentTime = seconds; // update immediately rather than waiting for the next ~100ms currentTime event tick
    try {
      await plugin.setCurrentTime({ assetId: ASSET_ID, time: seconds });
    } catch {}
  }

  // Volume: the one capability that doesn't work at all in iOS Safari/
  // WKWebView and is the entire reason this adapter exists. 0..1 in, to
  // match audioEl.volume's convention - NativeAudio itself wants 0..1 too
  // (its docs say "between 0.1 and 1.0"; true 0 is passed through as-is for
  // mute rather than clamped up, since AVAudioPlayer accepts 0 fine even
  // though the plugin's own type comment undersells that).
  //
  // STEP 3: replayGainFactor composes with the user's slider volume rather
  // than replacing it - effective native volume is always
  // userVolume * replayGainFactor (or 0 if muted), computed in one place
  // (applyEffectiveVolume) so setVolume/setMuted/setReplayGainFactor can't
  // drift out of sync with each other. This is the native counterpart to
  // the WebAudio GainNode graph in state.js, which had to stay disabled on
  // mobile because rerouting <audio> through WebAudio made iOS suspend/kill
  // background audio far more aggressively - NativeAudio's setVolume has no
  // such downside, since it's not a WebAudio graph at all.
  let replayGainFactor = 1;

  async function applyEffectiveVolume() {
    if (!isNative()) {
      audioEl.volume = currentMuted ? 0 : currentVolume; // ReplayGain stays on the separate GainNode graph on web, unchanged - see state.js
      return;
    }
    const plugin = getPlugin();
    if (!plugin) return;
    const effective = currentMuted ? 0 : currentVolume * replayGainFactor;
    try {
      await plugin.setVolume({ assetId: ASSET_ID, volume: effective });
    } catch {
      // No track loaded yet (e.g. volume slider touched before first play) -
      // currentVolume/replayGainFactor are still recorded and will be
      // applied via the `volume:` option on the next preload().
    }
  }

  async function setVolume(v) {
    currentVolume = v;
    await applyEffectiveVolume();
  }

  async function setMuted(m) {
    currentMuted = m;
    await applyEffectiveVolume();
  }

  function muted() {
    if (!isNative()) return audioEl.muted;
    return currentMuted;
  }

  // STEP 3: native counterpart to applyReplayGain()'s gainNode.gain.value
  // assignment in state.js. Takes the already-computed linear factor (state.js
  // does the dB-to-linear math and the RG_MAX_BOOST_DB clamping - this just
  // applies whatever factor it's given) rather than duplicating that logic
  // here, so the boost cap and dB conversion stay defined in exactly one
  // place regardless of platform.
  async function setReplayGainFactor(factor) {
    replayGainFactor = (typeof factor === 'number' && isFinite(factor)) ? factor : 1;
    if (isNative()) await applyEffectiveVolume();
    // On web this intentionally does nothing - state.js's applyReplayGain()
    // still drives gainNode.gain.value directly there, unchanged.
  }

  // STEP 3: playback speed. NativeAudio's rate range (0.5-2.0) matches this
  // app's `speeds` array (state.js) exactly, so no clamping/mapping needed.
  async function setRate(rate) {
    if (!isNative()) {
      audioEl.playbackRate = rate;
      return;
    }
    const plugin = getPlugin();
    if (!plugin) return;
    try {
      await plugin.setRate({ assetId: ASSET_ID, rate });
    } catch {
      // No track loaded yet - harmless no-op; the next preload() should
      // arguably carry the rate too, but AssetPlayOptions doesn't expose a
      // rate field, unlike volume. In practice this only matters for the
      // brief window before the first track of a session loads, since
      // setRate() is re-called on every track change anyway (see
      // playCurrent() in playback.js) - a session's chosen speed reapplies
      // correctly from the second track onward even if the very first call
      // here happened to race an empty player.
    }
  }

  return { isNative, load, play, pause, paused, setVolume, setMuted, muted, setReplayGainFactor, setRate, getCurrentTime, getDuration, seekTo, onEnded, onPlayStarted, onTimeUpdate };
})();
