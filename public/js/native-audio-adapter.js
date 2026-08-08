// ---------------------------------------------------------------------------
// native-audio-adapter.js — native-audio migration adapter.
//
// PLUGIN SWITCH (this version): migrated from @capgo/capacitor-native-audio
// to @mediagrid/capacitor-native-audio. Root cause: Cap-go's plugin loads
// audio files fully INTO MEMORY before playback can start (confirmed
// directly in its own docs, worded identically across every version:
// "This method will load more optimized audio files for background into
// memory" - and its own tagline describes it as built for "short audio
// files... for games and apps", i.e. sound effects, not long-form streamed
// music). For large remote files (FLAC especially) and slower connections
// (confirmed on 4G), this meant a real, user-visible multi-second delay
// before any audio started - effectively no different from downloading the
// whole file first. Cap-go's plugin has no progressive-streaming mode for
// plain MP3/FLAC-over-HTTP; the only genuine streaming path it exposes is
// HLS/m3u8, which our backend does not produce.
//
// @mediagrid/capacitor-native-audio is built on Android's Media3/ExoPlayer
// (via a proper MediaSessionService, not a custom notification hack) and
// iOS's AVPlayer - both stream progressively over HTTP by design, for any
// format they support, no HLS/segmenting required server-side. This is a
// genuine architectural fix, not a workaround.
//
// PUBLIC API IS UNCHANGED from the previous (Cap-go-backed) version of this
// file on purpose: isNative, load, play, pause, paused, setVolume, setMuted,
// muted, setReplayGainFactor, setRate, getCurrentTime, getDuration, seekTo,
// onEnded, onPlayStarted, onTimeUpdate - every other file in this app
// (playback.js, controls.js, layout-init.js, metadata-editor.js,
// settings-auth-toast-lyrics.js, queue-playlists.js, state.js) calls these
// exact same function names and needs ZERO changes as a result of this
// plugin swap. Only the internals below changed.
//
// ONE REAL REGRESSION, called out honestly: mediagrid has no pushed
// currentTime-style event (Cap-go's plugin did, ~every 100ms). This version
// brings back a lightweight polling loop for getCurrentTime() while
// playing, similar to what an early revision of the Cap-go-backed adapter
// used before that plugin's real push event was discovered. Polling
// interval is 250ms (vs the old 100ms push cadence) - a reasonable
// trade-off between UI smoothness and native round-trip volume; the seek
// bar/timer will feel very slightly less fluid than before but not
// noticeably choppy.
//
// Why this file exists in the first place: iOS Safari (and WKWebView, which
// Capacitor uses under the hood) does not support setting <audio>.volume -
// it's hard-locked to the hardware volume. There is no web workaround for
// this (GainNode was tried for ReplayGain and had to be disabled on mobile
// - see the long comment in state.js - because rerouting <audio> through a
// WebAudio graph makes iOS suspend/kill audio far more aggressively in the
// background). The only real fix is native playback, which exposes a
// genuine setVolume() on iOS/Android regardless of which plugin provides it.
//
// Platform behavior:
//   - Web (PWA in a browser): NativeAudioAdapter delegates straight to
//     audioEl, unchanged from before this file existed.
//   - Native (Capacitor iOS/Android shell): delegates to
//     @mediagrid/capacitor-native-audio instead.
//
// Every call site elsewhere in the app should go through NativeAudioAdapter,
// not call audioEl or AudioPlayer directly, so the platform branch lives in
// exactly one place.
//
// STATUS NOTE: this file's play/pause/load/timers/metadata were verified
// correct on-device. Confirmed fixes on top of that baseline:
//   - seekTo() rounds its time value to a whole second before sending it to
//     the plugin. CONFIRMED root cause via the plugin's own GitHub
//     discussions (#51): both platforms' native seek() implementations
//     read timeInSeconds via a strict integer coercion (Android:
//     presumably similar to iOS's `call.getInt("timeInSeconds")`, which
//     returns nil/null for ANY non-whole-number value, however few decimal
//     places it has) - this is the plugin maintainer's own documented
//     workaround ("we round to an int on the JS side"), not a guess.
//   - load() now only calls create() ONCE per session (the first track);
//     every later track change uses changeAudioSource() instead of
//     destroy()+create(). CONFIRMED root cause via direct inspection of
//     the plugin's iOS AudioSource.swift source: destroy() never
//     invalidates the audioReadyObservation KVO observation (only
//     changeAudioSource() does), which - since that observation's closure
//     captures `self` - creates a permanent Swift retain cycle on every
//     destroy()+create() cycle. This matches a real, still-open upstream
//     bug (discussion #48) describing this exact symptom on this exact
//     "repeatedly switch one primary streamed track" usage pattern. Fixed
//     entirely on our side by avoiding the leaky code path, without
//     needing an upstream plugin fix. See load()'s own comment for the
//     full mechanism.
//
// SEPARATELY (in playback.js, not this file): a confirmed real race was
// found and fixed where setRate() fired synchronously right after
// kicking off load() (not awaited), landing on native mid-transition and
// crashing with a null Player - moved to run only after load() resolves.
// See playback.js's own playCurrent() comments.
// ---------------------------------------------------------------------------

const NativeAudioAdapter = (() => {
  // Capacitor.isNativePlatform() is provided by @capacitor/core, loaded
  // before this file (see index.html script order). Falls back to false
  // if Capacitor hasn't loaded for some reason, so the app still works as
  // a plain web page.
  const isNative = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || false;

  // TEMPORARY DIAGNOSTIC (remove once the iOS "audio doesn't start, no
  // error" investigation is resolved): checks whether the native
  // AudioPlayer plugin bridge actually exists at all. If it doesn't,
  // every call in this file silently no-ops via its own `if (!plugin)
  // return;` guards - meaning "nothing happens, no visible error" is
  // EXACTLY what you'd see if this plugin failed to link into the native
  // build (a known Capacitor 8 + SPM risk flagged in this project's
  // codemagic.yaml), even though the Codemagic build itself reports
  // success (SPM linking issues don't fail compilation, only runtime
  // plugin availability). Uses a plain alert() rather than console.log
  // specifically because it needs to be visible with NO Xcode/Console.app
  // access at all - just opening the app.
  if (isNative()) {
    setTimeout(() => {
      const pluginExists = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioPlayer);
      if (!pluginExists) {
        alert('[DIAGNOSTIC] window.Capacitor.Plugins.AudioPlayer is MISSING. The native AudioPlayer plugin did not load - this points at an iOS SPM plugin-linking issue (the build succeeds, but the plugin never reaches the JS bridge). See codemagic.yaml\'s own comment on this known Capacitor 8 + SPM risk.');
      }
    }, 1000); // small delay so this runs after Capacitor's own plugin registration has had a chance to complete
  }

  // Single fixed audioId: this app only ever plays one track at a time
  // (see queue/queueIndex in state.js), so there's no need for the
  // multi-source bookkeeping mediagrid's API is built to support (it's
  // designed for cases like "primary track + separate looping background
  // music" playing simultaneously, which this app never does).
  // useForNotification: true is REQUIRED to be set on create() for this
  // audioId - mediagrid treats exactly one source as "the primary track"
  // that drives the lock-screen/notification, and ours always is one.
  const AUDIO_ID = 'current-track';

  let AudioPlayer = null; // lazily bound to window.Capacitor.Plugins.AudioPlayer on first native use
  let created = false;    // whether create()+initialize() has been called at least once for AUDIO_ID - destroy() then create() again is the "load a new track" cycle, mirroring the old unload()+preload()
  let currentVolume = 1;   // 0..1, mirrors audioEl.volume's range regardless of platform
  let currentMuted = false;
  let nativePlaying = false; // mediagrid has no synchronous "is playing" getter exposed without an async round-trip (isPlaying() is async) - tracked manually here, same pattern the previous adapter used
  let cachedDuration = NaN; // seconds; fetched via getDuration() once the track reports ready (onAudioReady), then cached
  let liveCurrentTime = 0;  // seconds; kept fresh by the polling loop below (see pollLoop) since mediagrid has no pushed time event
  let listenersBound = false;
  let replayGainFactor = 1;
  const endedCallbacks = []; // playback.js registers its 'track finished' handler here on native
  const playStartedCallbacks = []; // fired from play() on native - the equivalent of audioEl's 'play' event, for consumers with no other native hook
  const timeUpdateCallbacks = []; // fired on every poll tick while playing - the equivalent of audioEl's 'timeupdate' event

  function getPlugin() {
    if (!AudioPlayer) {
      AudioPlayer = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioPlayer;
    }
    return AudioPlayer;
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

  // Registers a callback fired on every poll tick (~250ms) while playing -
  // the equivalent of audioEl's 'timeupdate' event. This is what the seek
  // bar, fpSeekBar, synced lyrics, and MediaSession position reporting all
  // subscribe to on native.
  function onTimeUpdate(cb) {
    timeUpdateCallbacks.push(cb);
  }

  // POLLING LOOP: the one real architectural difference from the previous
  // (Cap-go-backed) adapter - see this file's header comment for why.
  // Runs only while nativePlaying is true; stops itself otherwise rather
  // than polling uselessly while paused/stopped. 250ms interval, a
  // deliberate middle ground - fast enough that the seek bar still feels
  // responsive, slow enough to not spam native round-trips every frame the
  // way a requestAnimationFrame-driven poll would.
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!nativePlaying) { stopPolling(); return; }
      const plugin = getPlugin();
      if (!plugin) return;
      try {
        const { currentTime } = await plugin.getCurrentTime({ audioId: AUDIO_ID });
        if (typeof currentTime === 'number') liveCurrentTime = currentTime;
      } catch {
        // Track may have been destroyed/swapped mid-poll (a new load() in
        // flight) - just skip this tick rather than throwing, the next
        // tick (or the next track's own poll start) will self-correct.
      }
      timeUpdateCallbacks.forEach(cb => { try { cb(); } catch {} });
    }, 250);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function bindNativeListenersOnce() {
    if (listenersBound) return;
    const plugin = getPlugin();
    if (!plugin || !plugin.onAudioEnd) return;
    listenersBound = true;

    // onAudioEnd fires only on genuine natural end-of-track (mirrors
    // Cap-go's 'complete' event's documented behavior) - no equivalent of
    // the false-completion-during-seek/load bug that plugin had, since
    // mediagrid's seek()/create() don't appear to internally stop/restart
    // in a way that triggers this callback spuriously (not otherwise
    // documented as a risk, and architecturally less likely given ExoPlayer/
    // AVPlayer's own seek semantics don't tear down the player instance to
    // seek the way the previous plugin's setCurrentTime() apparently did on
    // Android - see this file's git history / the old seekTo() comments for
    // that saga). If a similar spurious-firing issue turns up in practice
    // on this plugin, the same transitionInFlight-style guard pattern used
    // before can be reapplied here.
    plugin.onAudioEnd({ audioId: AUDIO_ID }, () => {
      nativePlaying = false;
      stopPolling();
      endedCallbacks.forEach(cb => { try { cb(); } catch {} });
    });

    // REAL GAP CLOSED (found on a careful re-read of the plugin's full
    // docs): without this, pausing/resuming from the lock screen or
    // notification's transport controls never updated nativePlaying at
    // all - our own play()/pause() are the only things that were ever
    // touching that variable, so an external pause left the app's own
    // play/pause icon still showing "playing" while nothing was audible.
    //
    // Per the docs' own caveat: "On Android, this also gets fired when
    // your app changes the state... due to a limitation of not knowing
    // where the state change came from" - so this WILL also fire for our
    // own play()/pause()/seekTo() calls, not just external ones. That's
    // fine here: syncing nativePlaying + start/stopPolling to whatever the
    // native side reports is correct regardless of the change's origin,
    // it just means this can run redundantly alongside our own explicit
    // state updates in play()/pause() - which is harmless (both paths
    // agree), not a conflict.
    if (plugin.onPlaybackStatusChange) {
      plugin.onPlaybackStatusChange({ audioId: AUDIO_ID }, (result) => {
        const isPlayingNow = result && result.status === 'playing';
        if (isPlayingNow === nativePlaying) return; // already in sync, avoid redundant start/stopPolling churn
        nativePlaying = isPlayingNow;
        if (isPlayingNow) {
          startPolling();
          playStartedCallbacks.forEach(cb => { try { cb(); } catch {} });
        } else {
          stopPolling();
        }
      });
    }
  }

  // Loads a new track. Mirrors the old `audioEl.src = ...; audioEl.play()`
  // shape used throughout playback.js, but async since mediagrid's
  // create()/initialize()/changeAudioSource() round-trip to native code.
  //
  // `meta` is optional lock-screen/Control Center Now Playing info
  // ({title, artist, album, artworkUrl}) - mapped to mediagrid's
  // albumTitle/artistName/friendlyTitle/artworkSource fields. Omitted or
  // partial fields are fine.
  //
  // MEMORY LEAK FIX (found by reading the plugin's actual iOS Swift source
  // directly - AudioSource.swift): the original version of this function
  // called destroy() then create() for every track change. destroy() never
  // invalidates audioReadyObservation (the KVO observation set up by
  // observeAudioReady() to detect AVPlayerItem readiness) - only
  // changeAudioSource() does that, via an explicit
  // `audioReadyObservation?.invalidate()` call absent from destroy().
  // Since that KVO observation's closure captures `self` (the AudioSource
  // instance), never invalidating it creates a genuine, permanent Swift
  // retain cycle - removing the AudioSource from the plugin's internal
  // dictionary (which destroy()'s caller does) does NOT break this cycle,
  // since the observation and the AudioSource keep each other alive
  // indefinitely regardless. This matches a real, still-open upstream bug
  // report (mediagrid/capacitor-native-audio discussion #48) describing
  // this exact symptom on this exact usage pattern (repeatedly
  // destroying/creating a single "primary" streamed track) - confirmed via
  // direct source inspection, not speculation.
  //
  // FIX: only call create() ONCE per session, for the very first track.
  // Every subsequent track change uses changeAudioSource() instead, which
  // correctly invalidates the old KVO observation before setting up a new
  // one - using the plugin's own already-correct code path instead of the
  // leaky one. changeAudioSource() doesn't accept metadata/volume/rate in
  // the same call (unlike create()), so those are now applied via
  // separate follow-up calls (changeMetadata(), setVolume()) every load()
  // regardless of whether this is the first track or a later one - this
  // was already true for metadata in the previously-uncached case (see
  // updateMetadata()), so this isn't a new pattern, just applied more
  // consistently now.
  async function load(streamUrl, meta) {
    cachedDuration = NaN;
    liveCurrentTime = 0;
    stopPolling();
    if (!isNative()) {
      audioEl.src = streamUrl;
      return;
    }
    const plugin = getPlugin();
    if (!plugin) return; // shouldn't happen on native, but don't hard-crash playback if it does
    nativePlaying = false;

    if (!created) {
      // First track of the session: create() must run exactly once -
      // changeAudioSource() (used for every later track) requires an
      // existing source to change, it can't create the first one.
      const createParams = {
        audioId: AUDIO_ID,
        audioSource: streamUrl,
        useForNotification: true, // this is always the app's one primary/foreground track - see AUDIO_ID's own comment
        isBackgroundMusic: false,
        loop: false,
        // These default to true/5s already per the plugin's own documented
        // defaults, but set explicitly here for clarity, using this app's
        // own configured seek intervals (settings.seekBack/seekForward,
        // already used for keyboard/swipe-to-seek elsewhere - see
        // metadata-editor.js and layout-init.js) so the lock-screen/
        // notification seek buttons match whatever the user has set
        // in-app, rather than silently using the plugin's own 5s default.
        showSeekBackward: true,
        showSeekForward: true,
        seekBackwardTime: settings.seekBack,
        seekForwardTime: settings.seekForward
      };
      if (meta) {
        if (meta.title) createParams.friendlyTitle = meta.title;
        if (meta.artist) createParams.artistName = meta.artist;
        if (meta.album) createParams.albumTitle = meta.album;
        if (meta.artworkUrl) createParams.artworkSource = meta.artworkUrl;
      }
      try {
        await plugin.create(createParams);
        created = true;
      } catch (err) {
        console.error('[NativeAudioAdapter] create() failed for', streamUrl, err);
        throw err; // still reject - callers (playCurrent's .then(safePlay)) should not proceed as if a track loaded when it didn't
      }
      // BUG FIX (confirmed via Logcat: on the very first track of a
      // session only, pressing pause was instead seeking to 0 and
      // resuming playback - traced to handleTrackEndedNaturally() in
      // playback.js firing spuriously, via NativeAudioAdapter's own
      // onEnded() callback, meaning onAudioEnd was misfiring on session
      // start). Root cause: bindNativeListenersOnce() - which registers
      // onAudioEnd and onPlaybackStatusChange - used to run via
      // ensureConfigured() BEFORE this create() call, meaning it
      // registered a listener for an audioId that didn't exist on the
      // native side YET. Whatever the native implementation does with a
      // listener registered against a not-yet-existing audio source
      // apparently isn't safe (likely binds to nothing, or to a stale/
      // default state that then fires once the real source is created a
      // moment later). This only ever affected the FIRST track of a
      // session, since bindNativeListenersOnce() only runs once
      // (listenersBound guard) - every later track already has a
      // validly-bound listener from here on. Fixed by binding the
      // listeners only AFTER create() has succeeded, so onAudioEnd is
      // always registered against a genuinely-existing audioId.
      bindNativeListenersOnce();
    } else {
      // Every subsequent track: swap the source on the SAME AudioSource
      // instance rather than destroying and recreating it - see this
      // function's own header comment for why this is the actual leak fix.
      try {
        await plugin.changeAudioSource({ audioId: AUDIO_ID, source: streamUrl });
      } catch (err) {
        console.error('[NativeAudioAdapter] changeAudioSource() failed for', streamUrl, err);
        throw err;
      }
      // changeAudioSource() doesn't take metadata inline (unlike create()) -
      // apply it as a separate call, same mechanism already used for the
      // previously-uncached-metadata case (see updateMetadata() and its
      // call site in playback.js).
      if (meta) {
        try {
          await plugin.changeMetadata({
            audioId: AUDIO_ID,
            friendlyTitle: meta.title,
            artistName: meta.artist,
            albumTitle: meta.album,
            artworkSource: meta.artworkUrl
          });
        } catch {}
      }
    }

    // initialize() actually prepares/buffers the audio - registering
    // onAudioReady BEFORE calling it, per the plugin's own documented
    // ordering requirement ("Should be called after callbacks are
    // registered"), so this promise doesn't resolve before the native side
    // has actually signaled readiness.
    //
    // NOTE: initialize() is called for BOTH the first-track (create) path
    // and every later (changeAudioSource) path - confirmed necessary by
    // re-reading the plugin's own README usage examples, which always
    // call initialize() once per prepared source regardless of how that
    // source's audioSource was set. changeAudioSource() in the Swift
    // source also re-runs its own readiness observation internally
    // (observeAudioReady() is called again inside changeAudioSource()),
    // consistent with this.
    await new Promise((resolve, reject) => {
      let settled = false;
      plugin.onAudioReady({ audioId: AUDIO_ID }, async () => {
        if (settled) return;
        settled = true;
        try {
          const { duration } = await plugin.getDuration({ audioId: AUDIO_ID });
          if (typeof duration === 'number' && isFinite(duration) && duration > 0) {
            cachedDuration = duration;
          }
        } catch {}
        // Apply the currently-set volume now that the source exists -
        // neither create() nor changeAudioSource() has a volume field, so
        // this has to be a separate explicit call rather than passed inline.
        try {
          await plugin.setVolume({ audioId: AUDIO_ID, volume: currentMuted ? 0 : currentVolume * replayGainFactor });
        } catch {}
        resolve();
      });
      plugin.initialize({ audioId: AUDIO_ID }).catch((err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  async function play() {
    if (!isNative()) return audioEl.play();
    const plugin = getPlugin();
    if (!plugin) return;
    nativePlaying = true; // set before the await, so paused() reads correctly the instant play() is called, matching audioEl's synchronous behavior as closely as possible
    await plugin.play({ audioId: AUDIO_ID });
    startPolling();
    playStartedCallbacks.forEach(cb => { try { cb(); } catch {} });
  }

  async function pause() {
    if (!isNative()) return audioEl.pause();
    const plugin = getPlugin();
    if (!plugin) return;
    nativePlaying = false;
    stopPolling();
    await plugin.pause({ audioId: AUDIO_ID });
  }

  function paused() {
    if (!isNative()) return audioEl.paused;
    return !nativePlaying;
  }

  // Current playback position, in seconds - mirrors audioEl.currentTime's
  // unit. Reads the polling loop's last-known value synchronously (no
  // round-trip per call) - see this file's header comment on why polling
  // is used here instead of a pushed event.
  function getCurrentTime() {
    if (!isNative()) return audioEl.currentTime;
    return liveCurrentTime;
  }

  // Duration in seconds. Returns the cached value fetched once the track
  // reported ready (near-instant reads afterward, matches audioEl.duration's
  // synchronous feel) and NaN otherwise - callers already guard on
  // `!isFinite(duration)` throughout playback.js, so NaN correctly
  // short-circuits those the same way an unset audioEl.duration would.
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
    liveCurrentTime = seconds; // update immediately rather than waiting for the next poll tick
    // CONFIRMED root cause (via the plugin's own GitHub discussion #51,
    // reported by another user and acknowledged by the maintainer): the
    // native seek() implementations on both platforms require timeInSeconds
    // to genuinely be a whole-number integer, not any float/double however
    // clean it looks (92.1 fails identically to 61.39711015319824 - it's
    // not about decimal-digit COUNT, it's about being non-integer at all).
    // iOS's implementation reads it via `call.getInt("timeInSeconds")`,
    // which returns nil for any non-integer value; Android's presumably
    // does the analogous thing given the identical crash signature there.
    // The maintainer's own stated practice: "we round to an int on the JS
    // side" - exactly what this does. Sub-second seek precision is not
    // meaningfully perceptible for a music player, so this loses nothing
    // in practice.
    const roundedSeconds = Math.round(seconds);
    try {
      await plugin.seek({ audioId: AUDIO_ID, timeInSeconds: roundedSeconds });
    } catch (err) {
      console.error('[NativeAudioAdapter] seek() failed for', roundedSeconds, err);
    }
    // Unlike the previous plugin, mediagrid's seek() is a dedicated method
    // (not implemented as a stop/replay-with-offset side effect of play())
    // - no evidence of it interrupting playback or misfiring onAudioEnd,
    // so none of the previous adapter's transitionInFlight-guard/
    // play-with-seek workarounds are carried over here. If seeking is ever
    // observed to misbehave in testing, that's the first place to
    // reintroduce a similar guard.
  }

  // Volume: the one capability that doesn't work at all in iOS Safari/
  // WKWebView and is the entire reason this adapter exists. 0..1 in, to
  // match audioEl.volume's convention and mediagrid's own documented range
  // ("a decimal less than or equal to 1.00").
  //
  // replayGainFactor composes with the user's slider volume rather than
  // replacing it - effective native volume is always
  // userVolume * replayGainFactor (or 0 if muted), computed in one place
  // (applyEffectiveVolume) so setVolume/setMuted/setReplayGainFactor can't
  // drift out of sync with each other. This is the native counterpart to
  // the WebAudio GainNode graph in state.js, which had to stay disabled on
  // mobile because rerouting <audio> through WebAudio made iOS suspend/kill
  // background audio far more aggressively - native setVolume has no such
  // downside, since it's not a WebAudio graph at all.
  async function applyEffectiveVolume() {
    if (!isNative()) {
      audioEl.volume = currentMuted ? 0 : currentVolume; // ReplayGain stays on the separate GainNode graph on web, unchanged - see state.js
      return;
    }
    const plugin = getPlugin();
    if (!plugin || !created) return; // nothing created yet - currentVolume/replayGainFactor are still recorded and applied once load() creates a source (see load()'s own setVolume call)
    const effective = currentMuted ? 0 : currentVolume * replayGainFactor;
    try {
      await plugin.setVolume({ audioId: AUDIO_ID, volume: effective });
    } catch {}
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

  // Native counterpart to applyReplayGain()'s gainNode.gain.value
  // assignment in state.js. Takes the already-computed linear factor
  // (state.js does the dB-to-linear math and the RG_MAX_BOOST_DB clamping -
  // this just applies whatever factor it's given) rather than duplicating
  // that logic here, so the boost cap and dB conversion stay defined in
  // exactly one place regardless of platform.
  async function setReplayGainFactor(factor) {
    replayGainFactor = (typeof factor === 'number' && isFinite(factor)) ? factor : 1;
    if (isNative()) await applyEffectiveVolume();
    // On web this intentionally does nothing - state.js's applyReplayGain()
    // still drives gainNode.gain.value directly there, unchanged.
  }

  // Playback speed. mediagrid's rate is a plain multiplier (1 = normal,
  // 0.5 = half speed, 1.5 = 1.5x) with no documented min/max clamp, unlike
  // the previous plugin's stated 0.5-2.0 range - this app's own `speeds`
  // array (state.js) stays within a sane range regardless, so no
  // additional clamping was added here.
  async function setRate(rate) {
    if (!isNative()) {
      audioEl.playbackRate = rate;
      return;
    }
    const plugin = getPlugin();
    if (!plugin || !created) return; // no source created yet - harmless no-op; setRate() is re-called on every track change anyway (see playCurrent() in playback.js), so a session's chosen speed reapplies correctly from the second track onward even if the very first call here happened to race an empty player
    try {
      await plugin.setRate({ audioId: AUDIO_ID, rate });
    } catch {}
  }

  // NEW (found on a careful re-read of the plugin's full docs): closes a
  // real gap noted honestly since Step 3 of the original native-audio
  // migration - when a track's metadata wasn't already cached at load()
  // time (a track played for the first time this session), the lock-screen
  // notification had to show generic/no title info and previously had NO
  // way to correct itself once the real metadata finished loading a moment
  // later, since the old plugin (@capgo/capacitor-native-audio) had no
  // "update metadata on an already-loaded track" API at all - only
  // preload()'s one-time notificationMetadata option.
  // @mediagrid/capacitor-native-audio's changeMetadata() (added 1.1.0)
  // does exactly this. Wired up in playback.js's getMeta().then() callback
  // - see that file's own comment for where.
  async function updateMetadata(meta) {
    if (!isNative() || !created) return;
    const plugin = getPlugin();
    if (!plugin || !plugin.changeMetadata) return;
    const params = { audioId: AUDIO_ID };
    if (meta.title) params.friendlyTitle = meta.title;
    if (meta.artist) params.artistName = meta.artist;
    if (meta.album) params.albumTitle = meta.album;
    if (meta.artworkUrl) params.artworkSource = meta.artworkUrl;
    try {
      await plugin.changeMetadata(params);
    } catch {}
  }

  return { isNative, load, play, pause, paused, setVolume, setMuted, muted, setReplayGainFactor, setRate, getCurrentTime, getDuration, seekTo, onEnded, onPlayStarted, onTimeUpdate, updateMetadata };
})();