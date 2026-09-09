// ---------------------------------------------------------------------------
// playback.js — Queue primitives, play/pause/next/prev, the marquee text
// scroller, player bar, album-art accent-color extraction and the blurred
// background mosaic, and the seek bar.
// Depends on: state.js, selection.js, browse.js, filelist.js.
// ---------------------------------------------------------------------------

// ---------- Playback ----------
// Incremented on every playCurrent() call - lets async work scheduled by
// one call (getMeta() below, most importantly) recognize when a LATER
// playCurrent() call has already superseded it, so a slow/delayed response
// for an old track can't overwrite the DOM with stale metadata after a
// newer track has already taken over. Without this, clicking track i then
// quickly clicking track i+1 could let i's getMeta() response resolve
// AFTER i+1's playCurrent() already ran, incorrectly showing i's
// title/artist while i+1 (or whichever the audio engine actually loaded)
// is what's really playing - exactly the "wrong metadata, right audio"
// symptom this was built to fix.
let playCurrentGeneration = 0;

// #playPauseBtn holds two overlaid SVG icons (.icon-play / .icon-pause,
// see index.html) rather than a text glyph — this toggles which one shows
// instead of setting textContent, which would otherwise wipe them out.
function setPlayPauseIcon(playing) {
  const btn = document.getElementById('playPauseBtn');
  const playIcon = btn.querySelector('.icon-play');
  const pauseIcon = btn.querySelector('.icon-pause');
  if (playIcon) playIcon.classList.toggle('hidden', playing);
  if (pauseIcon) pauseIcon.classList.toggle('hidden', !playing);
}
function resetQueue(tracks) {
  queue = tracks;
  originalQueue = [...tracks];
  shuffled = false;
  updateShuffleBtnState();
}
function pushToQueue(track) {
  queue.push(track);
  originalQueue.push(track);
}
function removeFromQueueAt(index) {
  const track = queue[index];
  queue.splice(index, 1);
  const oIdx = originalQueue.indexOf(track);
  if (oIdx !== -1) originalQueue.splice(oIdx, 1);
}
function syncOriginalQueueIfUnshuffled() {
  if (!shuffled) originalQueue = [...queue];
}

function playSingle(path) {
  if (getCurrentTrackPath() === path) return;
  resetQueue([{ path, name: fileNameOf(path) }]);
  queueIndex = 0;
  playCurrent();
  renderQueue();
}

// Shared by handleSongClick/handleLibrarySongClick below: if the clicked
// track is already in the queue, just jump to it; otherwise start playing
// it immediately (no queue needed for that - just the one track) and build
// the rest of the queue (via tracksFn(), folder listing or library view
// depending on context) in the background, splicing it in once ready. The
// tracksFn() fetch itself can be genuinely slow for a large folder (see
// handleSongClick's /api/browse call below, which stats every file and
// walks every subfolder for its counts) - awaiting it before playCurrent()
// meant clicking a song sat on that entire fetch before any audio started,
// same class of problem playFolder()/fillFolderQueueInBackground() already
// solved for the "play whole folder" button.
function handleSongClickWithTracks(item, tracksFn) {
  const idx = queue.findIndex(t => t.path === item.path);
  if (idx !== -1) {
    if (idx === queueIndex) return; // already playing this exact track
    queueIndex = idx;
    playCurrent();
    return;
  }
  resetQueue([{ path: item.path, name: item.name }]);
  queueIndex = 0;
  playCurrent();
  renderQueue();
  (async () => {
    const tracks = await tracksFn();
    // The user may have already skipped away (played something else,
    // cleared the queue) by the time this resolves - don't clobber
    // whatever's playing now with a stale fetch's tracks.
    if (!(queue.length === 1 && queue[0].path === item.path && queueIndex === 0)) return;
    const clickedIndex = tracks.findIndex(t => t.path === item.path);
    resetQueue(tracks.length ? tracks : [{ path: item.path, name: item.name }]);
    queueIndex = clickedIndex >= 0 ? clickedIndex : 0;
    renderQueue();
  })();
}

// Not in the queue: enqueue every song in the clicked track's containing
// folder (not subfolders) and play this one.
function handleSongClick(item) {
  return handleSongClickWithTracks(item, async () => {
    const folder = dirNameOf(item.path);
    const { items } = await api(`/api/browse?path=${encodeURIComponent(folder)}`);
    return items.filter(i => i.isAudio).map(f => ({ path: f.path, name: f.name }));
  });
}

// Not in the queue: enqueue every song in the current artist/album library
// view and play this one.
function handleLibrarySongClick(item) {
  return handleSongClickWithTracks(item, () => lastFetchedItems.map(f => ({ path: f.path, name: f.name })));
}

async function playFolder(item) {
  // The full recursive listing (listAudioRecursive on the server, behind
  // /api/expand) is proportional to folder size — for a large/deeply
  // nested folder that's a multi-second wait before anything could play,
  // even after parallelizing the server's own directory walk. Since the
  // user just wants to *hear something* the moment they click, this
  // fetches a single file via the much cheaper /api/expand/first (stops at
  // the first audio file found instead of enumerating the whole subtree)
  // and starts playing that immediately, while the full listing continues
  // in the background and backfills the rest of the queue once it's
  // ready — see fillFolderQueueInBackground below.
  const firstResult = await api(`/api/expand/first?path=${encodeURIComponent(item.path)}`);
  if (!firstResult.file) { renderQueue(); return; } // empty folder
  const firstTrack = { path: firstResult.file, name: fileNameOf(firstResult.file) };
  resetQueue([firstTrack]);
  queueIndex = 0;
  playCurrent();
  renderQueue();
  fillFolderQueueInBackground(item, firstTrack);
}

// Loads the rest of a folder's tracks after playFolder() above has already
// started the first one playing, then splices them in around it — shuffled
// (folders start shuffled by default; see playFolder), with the track
// that's already playing left in place rather than restarted, and
// everything else randomized around it.
//
// Two stages: first /api/expand/limit, a fast approximate-order fetch from
// the server's in-memory library index (near-instant, no filesystem walk -
// see its own comment in server.js), gets a first batch of real tracks into
// the queue right away instead of leaving it stuck at just the one playing
// track for however long the full recursive listing takes on a large
// folder. Then /api/expand, the full authoritative recursive walk, replaces
// it with the complete, correctly-ordered list once that's ready. Both
// stages go through the same staleness guard, so if the user has already
// skipped away by the time either resolves, neither clobbers whatever's
// actually playing now.
async function fillFolderQueueInBackground(item, firstTrack) {
  const stillOnThisFolder = () => queue.length >= 1 && queue[0].path === firstTrack.path && queueIndex === 0;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  let quickOrder = null; // paths in the order stage 1 displayed them, if it ran

  try {
    const { files: quickFiles } = await api(`/api/expand/limit?path=${encodeURIComponent(item.path)}&limit=${currentChunkSize() === Infinity ? 50 : currentChunkSize()}`);
    // Only worth showing if it actually got more than just the track
    // already playing - an empty/single-file result (e.g. index not warmed
    // up yet for this folder) isn't an improvement over the current state,
    // so skip straight to the full listing below rather than render a
    // pointless intermediate queue update.
    if (quickFiles.length > 1 && stillOnThisFolder()) {
      const rest = shuffle(quickFiles.filter(f => f !== firstTrack.path));
      const quickTracks = [firstTrack, ...rest.map(f => ({ path: f, name: fileNameOf(f) }))];
      quickOrder = quickTracks.map(t => t.path);
      resetQueue(quickTracks);
      queueIndex = 0;
      shuffled = true;
      updateShuffleBtnState();
      renderQueue();
    }
  } catch {
    // Fast path failing entirely is fine - the full listing below is what
    // actually matters, this was purely a head start.
  }

  const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
  // The user may have already skipped away from the folder entirely
  // (played something else, cleared the queue) by the time this resolves —
  // don't clobber whatever's playing now with a stale folder's tracks.
  if (!stillOnThisFolder()) return;

  let tracks;
  if (quickOrder) {
    // Keep the order stage 1 already showed for every track it displayed -
    // re-shuffling everything here would visibly reshuffle/replace rows the
    // user is already looking at. Only the tracks stage 1's approximate
    // index didn't have yet are new here; those get shuffled in on their
    // own and appended, so the queue grows rather than jumps around.
    const filesSet = new Set(files);
    const stillPresent = quickOrder.filter(p => filesSet.has(p));
    const known = new Set(stillPresent);
    const newFiles = shuffle(files.filter(f => !known.has(f)));
    tracks = [...stillPresent, ...newFiles].map(f => ({ path: f, name: fileNameOf(f) }));
  } else {
    const rest = shuffle(files.filter(f => f !== firstTrack.path));
    tracks = [firstTrack, ...rest.map(f => ({ path: f, name: fileNameOf(f) }))];
  }

  resetQueue(tracks);
  queueIndex = 0;
  if (tracks.length > 1) {
    shuffled = true;
    updateShuffleBtnState();
  }
  renderQueue();
}

// ---------- Player bar title/path marquee ----------
// Hand-built rather than routed through the generic runMarqueeClock system
// (layout-init.js): title and path here are a tight, always-scrolling pair
// with their own dedicated sync group, whereas the generic system is built
// around many independent/hover-gated targets sharing looser page-wide or
// isolated-root groups. Both systems could in principle be unified (the
// title/path markup already has the right shape - a lone <span> child - for
// the generic system's own wrapping), but that would change which elements
// this pair syncs its cycle with, so it's being left separate for now
// rather than folded in without being able to verify the result.
const MARQUEE_SPEED = 40;   // px per second, same for both lines
const MARQUEE_GAP = 40;     // px of blank space before text reappears
const MARQUEE_HOLD = 1000;  // ms held at the start position each cycle
let marqueeRAF = null;
let marqueeToken = 0;

function stopMarquee() {
  if (marqueeRAF) cancelAnimationFrame(marqueeRAF);
  marqueeRAF = null;
  marqueeToken++;
}

function startMarquee(nameSpan, pathSpan) {
  stopMarquee();
  // reset position before measuring
  nameSpan.style.transform = 'translateX(0)';
  if (pathSpan) pathSpan.style.transform = 'translateX(0)';

  // Guards against a stale pending measurement winning a race if
  // startMarquee() is called again before this call's own
  // requestAnimationFrame callback has fired (stopMarquee() above only
  // cancels an already-running frame() loop via marqueeRAF, not a still-
  // pending initial measurement callback, since that callback doesn't get
  // assigned to marqueeRAF until it actually runs).
  const token = ++marqueeToken;
  requestAnimationFrame(() => {
    if (token !== marqueeToken) return; // superseded by a newer startMarquee() call
    const nameWrap = nameSpan.closest('.marquee-wrap');
    const nameOverflow = nameSpan.scrollWidth - nameWrap.clientWidth;
    const nameDist = nameOverflow > 0 ? nameSpan.scrollWidth - nameWrap.clientWidth + MARQUEE_GAP : 0;

    // pathSpan is null when it holds the stacked artist/album lines (see
    // applyMeta in playback.js) - those truncate independently via CSS
    // (.pb-link-line's own overflow:hidden/ellipsis) rather than being
    // measured/scrolled here. text-overflow:ellipsis is purely visual and
    // doesn't shrink an element's own scrollWidth, so measuring the
    // container span in that mode would still read as "overflowing" even
    // though it's already correctly truncated - motion here would be
    // spurious, not a fix for anything actually cut off. Skipping the
    // measurement entirely (rather than measuring and getting 0 some other
    // way) is what keeps the two stacked lines truly independent: nothing
    // here ever transforms them as one shared unit.
    const pathWrap = pathSpan ? pathSpan.closest('.marquee-wrap') : null;
    const pathOverflow = pathSpan ? pathSpan.scrollWidth - pathWrap.clientWidth : 0;
    const pathDist = pathOverflow > 0 ? pathSpan.scrollWidth - pathWrap.clientWidth + MARQUEE_GAP : 0;

    if (nameDist === 0 && pathDist === 0) return; // nothing overflows, stay put

    const nameDur = (nameDist / MARQUEE_SPEED) * 1000;
    const pathDur = (pathDist / MARQUEE_SPEED) * 1000;
    const maxDur = Math.max(nameDur, pathDur);
    const cycle = MARQUEE_HOLD + maxDur;

    let start = null;
    function frame(ts) {
      if (token !== marqueeToken) return; // superseded — stop silently
      if (start === null) start = ts;
      const t = (ts - start) % cycle;

      const applyPos = (span, dist, dur) => {
        if (!span) return;
        if (dist === 0 || t < MARQUEE_HOLD) {
          span.style.transform = 'translateX(0)';
          return;
        }
        const elapsedMove = t - MARQUEE_HOLD;
        if (elapsedMove >= dur) {
          span.style.transform = 'translateX(0)'; // finished its own pass, wait here for the other
        } else {
          const x = -(elapsedMove / 1000) * MARQUEE_SPEED;
          span.style.transform = `translateX(${x}px)`;
        }
      };

      applyPos(nameSpan, nameDist, nameDur);
      applyPos(pathSpan, pathDist, pathDur);

      marqueeRAF = requestAnimationFrame(frame);
    }
    marqueeRAF = requestAnimationFrame(frame);
  });
}

// ---------- Player bar visibility ----------
const playerBarEl = document.getElementById('playerBar');
function showPlayerBar() { playerBarEl.classList.remove('hidden'); document.querySelector('.lyrics-box-wrap').classList.remove('hidden'); }

// Measures #playerBar's COLLAPSED height specifically - used as the base
// term of drawBlurBackground's one shared height ceiling (see the long
// comment there). Reading playerBarEl.getBoundingClientRect() directly
// would return whichever height it currently has, which on mobile varies
// between the collapsed strip and the expanded full player - using that
// live value as the ceiling's base is exactly the "recompute per-state"
// bug that comment warns against, since it would make the canvas get
// resized (and re-shuffled) every time the user expands or collapses.
//
// Collapsed height is cached after the first successful measurement and
// reused from then on, rather than re-measured on every draw - it only
// actually changes on a real layout change (window resize, orientation
// change, crossing the mobile breakpoint), which the existing 'resize'
// listener already triggers a redraw for anyway (see below), so the cache
// gets refreshed there. If #playerBar happens to be expanded (mobile full
// player open) at the moment this first runs, its rect is skipped in favor
// of the CSS-computed collapsed height instead of caching a wrong value.
let cachedCollapsedPlayerBarH = null;
function collapsedPlayerBarHeight() {
  const isExpanded = playerBarEl.classList.contains('expanded');
  if (!isExpanded) {
    const h = playerBarEl.getBoundingClientRect().height || 0;
    if (h > 0) cachedCollapsedPlayerBarH = h;
    return cachedCollapsedPlayerBarH || h;
  }
  if (cachedCollapsedPlayerBarH != null) return cachedCollapsedPlayerBarH;
  // No cached value yet and currently expanded (e.g. page loaded straight
  // into the expanded state) - briefly toggle the class off to measure the
  // real collapsed height, then restore it. This runs at most once per
  // page load in this specific edge case.
  playerBarEl.classList.remove('expanded');
  const h = playerBarEl.getBoundingClientRect().height || 0;
  playerBarEl.classList.add('expanded');
  cachedCollapsedPlayerBarH = h;
  return h;
}

function hidePlayerBar() {
  playerBarEl.classList.add('hidden');
  playerArtTrackPath = null; // invalidate any in-flight updatePlayerArt fetch for the track that was playing
  // Closing the player should mean "nothing is playing" as far as the
  // rest of the UI is concerned — getCurrentTrackPath() (used by the file
  // list's .playing highlight) reads queueIndex, not the player bar's own
  // visibility, so without this the highlight stayed on whatever track
  // was last playing even after the player was explicitly closed.
  queueIndex = -1;

  // Fade out the global background
  document.documentElement.style.setProperty('--blur-opacity', '0');
  // Nothing's playing/visible - #playerBar's own fallback fill (mobile
  // only, see responsive.css) should be fully opaque so it's in the
  // correct state if/when the player reopens, matching applyBlurColors'
  // no-art branch.
  document.documentElement.style.setProperty('--player-fallback-opacity', '1');
  
  const lbWrap = document.querySelector('.lyrics-box-wrap');
  lbWrap.classList.add('hidden');
  lbWrap.classList.remove('open');
  document.getElementById('lyricsBox').classList.remove('open');
  lyricsBoxOpen = false;
  stopMarquee();
  NativeAudioAdapter.pause();
  audioEl.removeAttribute('src'); // web path only; harmless no-op on native (audioEl isn't the active player there)
  setPlayPauseIcon(false);
  seekBarEl.value = 0;
  seekBarEl.style.setProperty('--played-pct', '0%'); 
  seekBarEl.style.setProperty('--buffered-pct', '0%');
  // Same reasoning as the equivalent reset in playCurrent(): #fpSeekBar
  // only mirrors #seekBar via timeupdate/loadedmetadata, neither of which
  // fires once playback has actually stopped.
  const fpSeekBarStopEl = document.getElementById('fpSeekBar');
  if (fpSeekBarStopEl) {
    fpSeekBarStopEl.value = 0;
    fpSeekBarStopEl.style.setProperty('--played-pct', '0%');
    fpSeekBarStopEl.style.setProperty('--buffered-pct', '0%');
  }
  const artImg = document.getElementById('playerArt');
  const artIcon = document.getElementById('playerArtIcon');
  artImg.classList.add('hidden');
  artImg.removeAttribute('src');
  artIcon.classList.remove('hidden');
  updatePlayingHighlight();
  updateQueuePlayingIndicator(); // also clears the queue row + playlist row/header highlight (see its own comment)
}

let justEnded = false; // true after the last track ends with nothing queued to follow

function playCurrent() {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  justEnded = false;
  playCurrentGeneration++;
  const myGeneration = playCurrentGeneration;
  const track = queue[queueIndex];
  // STEP 3: pass along cached title/artist/album/art (when already warm -
  // see the metaCache lookup and its own long comment further below) so
  // the lock-screen/Control Center Now Playing display is correct from the
  // very first preload() call rather than showing nothing/generic info
  // until some later update. NativeAudio's preload() is the only call that
  // accepts notificationMetadata at all (no separate "update metadata on an
  // already-loaded track" API exists) - so when metadata ISN'T cached yet
  // (a track played for the first time this session), the lock screen will
  // show generic/no info for this track rather than retroactively
  // correcting itself once getMeta() resolves below. A real gap, not
  // silently ignored: revisit if this turns out to be common enough to
  // matter (the cache warms up fast in practice - see metaCache's own
  // prefetching elsewhere in the app - so most skips within a session
  // should already hit the cached branch).
  const cachedMetaForLoad = metaCache[track.path];
  const loadMeta = cachedMetaForLoad ? {
    title: cachedMetaForLoad.title || track.name,
    artist: cachedMetaForLoad.artist || undefined,
    album: cachedMetaForLoad.album || undefined,
    artworkUrl: cachedMetaForLoad.hasArt ? (getOfflineArtUrl(track.path) || `${location.origin}/api/art?path=${encodeURIComponent(track.path)}`) : undefined
  } : { title: track.name };
  // STEP 2 FIX: on native, play() must not fire until preload() has actually
  // resolved (NativeAudio has no internal queueing of "play as soon as
  // ready" the way a browser's <audio> element does - calling play() before
  // preload() finishes is a real race, not just a cosmetic one). load()
  // itself is still not awaited here, so the rest of playCurrent()'s
  // synchronous UI reset (seek bar, marquee, art) isn't held up by a native
  // round-trip - safePlay() is chained onto the same promise instead,
  // deliberately not awaited either, so playCurrent() itself stays
  // synchronous end-to-end exactly as it was before this file existed. On
  // web, load() resolves synchronously in practice (plain audioEl.src
  // assignment, no real async work), so this preserves the exact previous
  // timing there.
  // BUG FIX (found via Logcat): NativeAudio's Android implementation parses
  // assetPath as a URI and requires an explicit scheme (http/https/file) -
  // a server-relative path like "/api/stream?path=..." has no scheme at
  // all, which is exactly what threw "unexpected URI scheme 'null'" here.
  // audioEl.src on web tolerates a relative path fine (the browser resolves
  // it against the page's own origin automatically), which is why this
  // wasn't caught until testing on native specifically. Using
  // location.origin here matches what the artworkUrl above already did
  // correctly.
  const streamUrl = getOfflineStreamUrl(track.path) || `${location.origin}/api/stream?path=${encodeURIComponent(track.path)}`;
  NativeAudioAdapter.load(streamUrl, loadMeta)
    .then(() => {
      // Stale-response guard: if the user clicked another track while this
      // one's (potentially slow, native-round-trip) load() was still in
      // flight, a newer playCurrent() call has already fired its own
      // load()/safePlay() for the track that should actually be playing
      // now. Calling safePlay() here anyway would resume/restart playback
      // using THIS call's now-outdated context, racing against - or
      // outright overriding - whichever track the user actually clicked
      // last. This mirrors the same staleness problem the getMeta()
      // callback below has, just for playback itself rather than just the
      // displayed metadata - see playCurrentGeneration's own comment.
      if (myGeneration !== playCurrentGeneration) return;
      // BUG FIX: setRate() used to fire synchronously right after this
      // load() call was kicked off (NOT awaited - see the comment on the
      // load() call itself for why), completely unsequenced against
      // load()'s own destroy()/create() cycle. Confirmed via Logcat: this
      // let setRate() land on native mid-transition - sometimes hitting
      // the OLD track's now-destroyed player (setRate on a null Player ->
      // NullPointerException crash), sometimes racing the NEW track's
      // still-in-progress create() (the following setVolume call then
      // failed too: "Audio source with ID current-track was not found").
      // Moved here, inside load()'s .then(), so it only ever runs once
      // the new track's create()/initialize() cycle has fully completed -
      // same ordering guarantee safePlay() already relies on.
      NativeAudioAdapter.setRate(speeds[speedIndex]);
      safePlay();
    })
    .catch(err => {
      // A failed load() (e.g. native preload() rejecting - see
      // native-audio-adapter.js) previously vanished silently here: nothing
      // caught it, so safePlay() never ran, but nothing reset the UI back
      // to a "not playing" state either - the play/pause icon stayed
      // wherever setPlayPauseIcon last visually put it, timer stuck at
      // 0:00, with no visible error or way to tell what happened. This
      // still doesn't attempt a retry (a real gap - a flaky network blip
      // on one track currently just fails that track), but at minimum
      // surfaces the failure and leaves the UI in a state that matches
      // reality instead of lying that playback is active.
      console.error('[playCurrent] failed to load track:', track.path, err);
      // Same staleness guard as the .then() above - an old, now-superseded
      // call's failure shouldn't be allowed to reset the play/pause icon
      // out from under whatever track is actually current now.
      if (myGeneration !== playCurrentGeneration) return;
      setPlayPauseIcon(false);
    });
  nativeCurrentTimeSec = 0;
  nativeDurationSec = NaN;
  seekBarEl.value = 0;
  seekBarEl.style.setProperty('--played-pct', '0%'); seekBarEl.style.setProperty('--buffered-pct', '0%');
  // #fpSeekBar (mobile full player) only mirrors #seekBar inside
  // updateFpTimeDisplay, which runs on the audio element's own
  // timeupdate/loadedmetadata events — those don't fire until the new
  // track has actually started loading/playing, so without this it kept
  // showing the previous track's position for a beat after switching.
  // Resetting it here directly, synchronously alongside the real bar,
  // closes that gap instead of waiting on playback to catch up.
  const fpSeekBarEl = document.getElementById('fpSeekBar');
  if (fpSeekBarEl) {
    fpSeekBarEl.value = 0;
    fpSeekBarEl.style.setProperty('--played-pct', '0%');
    fpSeekBarEl.style.setProperty('--buffered-pct', '0%');
  }
  // STEP 2: on native, safePlay() is already chained onto NativeAudioAdapter
  // .load()'s promise above (to avoid the play-before-preload-finishes race)
  // - calling it again here unconditionally would double-fire play() on
  // native. On web, load() has no real async work to wait for, so calling
  // it directly here (as before) keeps playback starting exactly as
  // promptly as it always did.
  if (!NativeAudioAdapter.isNative()) safePlay();
  showPlayerBar();
  const nameEl = document.getElementById('trackName');
  const pathEl = document.getElementById('trackPath');

  // Applies resolved metadata (title + "Artist • Album" pb-link spans) to
  // the name/path elements, then (re)starts the marquee against whatever
  // text ended up in place. Shared between the cached-synchronous path and
  // the getMeta().then() path below so the DOM-building logic (and the
  // marquee timing relative to it) isn't duplicated or drifted apart.
  function applyMeta(meta) {
    nameEl.querySelector('span').textContent = meta.title || track.name;
    const pathSpan = pathEl.querySelector('span');
    const hasTwoLines = !!(meta.artist || meta.album);
    // Drives .track-path span.track-path-lines in player.css: that span
    // needs to behave as a normal block box (stretching to #trackPath's
    // real width) in two-line mode, instead of its usual inline-block
    // content-sizing, so .pb-link-line children actually get a real width
    // boundary to overflow against - see that rule's own comment for why.
    pathSpan.classList.toggle('track-path-lines', hasTwoLines);
    if (hasTwoLines) {
      // Artist and album render on their own line each (rather than one
      // "Artist • Album" line) so pathEl.innerHTML — mirrored verbatim
      // into #miniPlayerSubtitle/#fpSubtitle by layout-init.js — carries
      // that same two-line structure everywhere it's reused. Each line
      // independently ellipsis-truncates via CSS (.pb-link-line in
      // player.css) - startMarquee() below is passed null for the path
      // span in this mode instead of trying to scroll the two-line block
      // as one unit, which used to move both lines together whenever
      // either one overflowed (a transform on the shared container moves
      // every child with it - there's no way to marquee just one of two
      // stacked children). Matches the approach already used on mobile
      // (see responsive.css) for the same stacked-pair case.
      pathSpan.innerHTML = '';
      if (meta.artist) {
        const line = document.createElement('div');
        line.className = 'pb-link-line';
        const a = document.createElement('span');
        a.className = 'pb-link';
        a.textContent = meta.artist;
        a.addEventListener('click', () => openLibrary('artist', meta.artist, { preferExt: track.path.split('.').pop().toLowerCase() }));
        line.appendChild(a);
        pathSpan.appendChild(line);
      }
      if (meta.album) {
        const line = document.createElement('div');
        line.className = 'pb-link-line';
        const al = document.createElement('span');
        al.className = 'pb-link';
        al.textContent = meta.album;
        al.addEventListener('click', () => openLibrary('album', meta.album, { preferExt: track.path.split('.').pop().toLowerCase() }));
        line.appendChild(al);
        pathSpan.appendChild(line);
      }
    } else {
      pathSpan.textContent = track.path;
    }
    startMarquee(nameEl.querySelector('span'), hasTwoLines ? null : pathSpan);
    // pathSpan.innerHTML/textContent above wipes any marquee wrapper the
    // generic system (scanMarquees/MARQUEE_TARGETS, layout-init.js)
    // previously created around #trackPath .pb-link-line - that system is
    // what actually measures/animates the two-line artist/album case now
    // (see the comment above), since startMarquee() only handles the
    // single-line fallback here. The generic MutationObserver would
    // eventually re-wrap/re-measure on its own 120ms debounce, but calling
    // it explicitly here - same as every other place in the app that
    // rebuilds marquee-target content (syncMiniPlayerText, syncFpTitle,
    // syncFpUpcoming) - re-measures immediately against the real, current
    // text instead of depending on that timing. No root argument (unlike
    // those other call sites, which scope to their own container) because
    // the #trackPath .pb-link-line selector is ID-anchored - querying
    // FROM pathEl itself (#trackPath) would require #trackPath to be a
    // descendant of itself, which never matches; this needs an ancestor
    // of #trackPath as the scan root, and document is the simplest correct
    // one (verified: querying from pathEl's own parent, or document,
    // finds both lines; querying from pathEl itself finds zero).
    if (hasTwoLines) scanMarquees();
  }

  // Metadata for this track may already be cached (re-visiting a track,
  // a folder that already prefetched metadata, or switching tracks fast
  // enough that a previous getMeta() call already populated it) — in that
  // case apply the real title/artist/album immediately instead of first
  // showing the raw filename and swapping it out a moment later, which is
  // what caused a visible flash/flicker when skipping tracks quickly.
  // Only fall back to the filename placeholder when nothing is cached yet.
  const cachedMeta = metaCache[track.path];
  if (cachedMeta) {
    applyMeta(cachedMeta);
  } else {
    nameEl.querySelector('span').textContent = track.name;
    pathEl.querySelector('span').textContent = track.path;
    startMarquee(nameEl.querySelector('span'), pathEl.querySelector('span'));
  }
  updatePlayerArt(track.path);
  updatePlayingHighlight();
  loadLyricsForTrack(track.path);
  getMeta(track.path).then(meta => {
    // Stale-response guard: if a newer playCurrent() call has already run
    // since this fetch started, applying this (old) metadata now would
    // overwrite whatever the current track's own applyMeta() already
    // wrote - silently showing the wrong title/artist for what's actually
    // playing. See playCurrentGeneration's own comment for the full story.
    if (myGeneration !== playCurrentGeneration) return;
    // If metadata was already cached above, applyMeta() (and its
    // startMarquee() call) already ran synchronously with the same data —
    // calling it again here would race startMarquee()'s own pending
    // requestAnimationFrame measurement callback against this second call
    // (stopMarquee() only cancels an already-running frame loop, not a
    // still-pending initial measurement), which could leave the marquee
    // measuring stale/placeholder text and silently exiting instead of
    // ever animating the real title. applyReplayGain still needs to run
    // every time regardless.
    if (!cachedMeta) {
      applyMeta(meta);
      // NEW: retroactively correct the lock-screen/notification metadata
      // now that it's known - this track wasn't cached at load() time, so
      // NativeAudioAdapter.load() had nothing but a generic title to give
      // the notification. See native-audio-adapter.js's updateMetadata()
      // for the full story on why this was previously impossible.
      NativeAudioAdapter.updateMetadata({
        title: meta.title || track.name,
        artist: meta.artist,
        album: meta.album,
        artworkUrl: meta.hasArt ? `${location.origin}/api/art?path=${encodeURIComponent(track.path)}` : undefined
      });
    }
    applyReplayGain(meta.replayGainDb);
  });
  setPlayPauseIcon(true);
  updateQueuePlayingIndicator();
  const playingEl = queuePanel.querySelector('.queue-item.playing');
  if (playingEl) playingEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Finds the single most representative accent color in an image, by
// downsampling it onto a tiny canvas and picking the most common color among
// its more saturated pixels. A photo/cover that's mostly a soft, barely-
// tinted background (cream, fog, pale gradients) can still have a real
// accent color - a logo, a stripe, a face - that's small in area but is
// clearly "the" color a person would name if asked. So rather than just
// averaging every pixel (which a large bland background would dominate),
// only pixels clearing a firm saturation bar are considered, with the bar
// progressively relaxed until enough pixels qualify - falling back to every
// pixel (unweighted) only if the art is genuinely near-grayscale throughout.
function extractAccentColor(imgEl) {
  const size = 32; // small sample grid is plenty for this
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, size, size);

  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch (e) {
    // Canvas may be tainted (e.g. cross-origin without CORS headers)
    return null;
  }

  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue; // skip transparent pixels
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (lightness < 20 || lightness > 235) continue; // skip near-black/near-white
    const sat = max === min ? 0 : (max - min) / (255 - Math.abs(2 * lightness - 255));
    pixels.push({ r, g, b, sat });
  }
  if (!pixels.length) return null;

  const MIN_QUALIFYING_PIXELS = Math.max(8, pixels.length * 0.03);
  let pool = [];
  for (const threshold of [0.18, 0.12, 0.07, 0]) {
    pool = pixels.filter(p => p.sat >= threshold);
    if (pool.length >= MIN_QUALIFYING_PIXELS || threshold === 0) break;
  }
  if (!pool.length) pool = pixels; // last resort: every pixel, unfiltered

  // Bucket into a coarse 4-bit-per-channel grid and take the most common one.
  const buckets = new Map();
  for (const { r, g, b } of pool) {
    const key = `${r >> 4}_${g >> 4}_${b >> 4}`;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.n += 1;
    buckets.set(key, bucket);
  }
  let best = null;
  for (const b of buckets.values()) {
    if (!best || b.n > best.n) best = b;
  }
  if (!best) return null;
  return `rgb(${Math.round(best.r / best.n)}, ${Math.round(best.g / best.n)}, ${Math.round(best.b / best.n)})`;
}

// Converts "rgb(r, g, b)" to an {h, s, l} triple (h in degrees, s/l in 0-1).
function rgbStringToHsl(rgbStr) {
  const m = rgbStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return null;
  const r = parseInt(m[1], 10) / 255, g = parseInt(m[2], 10) / 255, b = parseInt(m[3], 10) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = 0; s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}

// Clamps a color's lightness/saturation so it stays legible as text/icon fills
// and thin UI accents against this app's dark chrome (page bg ~#12-#1a, panels
// ~#26-#2a), regardless of how light, dark, or washed-out the source art is.
function makeAccentColor(rgbStr) {
  const hsl = rgbStringToHsl(rgbStr);
  if (!hsl) return '#e8e8ea';
  let { h, s, l } = hsl;
  // Near-grayscale AND weakly-saturated source colors (muddy fog, dull fabric,
  // desaturated shadows) have an unreliable hue — small sampling differences
  // can swing it across the color wheel, and even when the hue is "real" it's
  // faint enough that boosting it hard fabricates a color the art doesn't
  // actually read as. Bail out to a neutral white/grey instead of inventing
  // or amplifying a hue when there isn't a strong one to work with.
  if (s < 0.14) return '#e8e8ea';
  // Too dark to read against the dark UI, and too light loses definition/feels washed out.
  l = Math.min(0.72, Math.max(0.5, l));
  // For art with a real, reasonably confident color, nudge saturation up just
  // enough to read clearly as "a color" without overpowering a muted source,
  // and cap it so a highly saturated source color doesn't come across too
  // vivid/harsh as a thin UI accent.
  s = Math.min(0.5, Math.max(0.28, s));
  return `hsl(${h.toFixed(1)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%)`;
}

const blurGroup = document.querySelector('.player-blur-group');
const blurWrap = document.querySelector('.player-blur-bg');
const blurCanvas = document.getElementById('playerBlurCanvas');
const blurCtx = blurCanvas ? blurCanvas.getContext('2d') : null;
// How far the canvas overhangs each side of the visible panel, in CSS px.
// Needs to be comfortably more than the blur radius (50px, see
// .player-blur-bg's filter) - CSS filter:blur()'s radius argument behaves
// like a Gaussian standard deviation, not a hard cutoff, so its visible
// falloff actually extends to roughly 2-3x the stated radius before it's
// negligible. The previous value here (70px, under 1.5x the 50px radius)
// left the blur's own tail still meaningfully non-negligible right at the
// panel's true visible edge, softening/fading the color exactly at the
// boundary - which reads as a translucent/darkened edge even though the
// canvas underneath is fully opaque there (verified by direct pixel
// alpha readback). 150px (3x the radius) gives the kernel a full patch of
// real painted pixels to sample at every point up to the true edge, so
// there's no falloff tail left inside the visible area at all.
const BLUR_CANVAS_OVERSCAN = 150;
// Width the canvas was actually last drawn for (set inside
// drawBlurBackground), compared against by the ResizeObserver further
// down this file so a redraw only happens when the container's real
// width has actually changed since the last draw.
let lastDrawnBlurWidth = null;

// Deterministic PRNG so the same album art always reshuffles into the same
// layout (no jarring reshuffle if this runs again for the same art).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small stable hash from a string, used as the PRNG seed so the same image
// URL always reshuffles into the same-looking mosaic instead of a different
// random layout on every track change/redraw.
function hashStringToSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// "redmean" weighted Euclidean RGB distance - a cheap, well-known
// approximation of perceptual color difference (weights green more heavily,
// and red/blue depending on overall brightness, since human vision is more
// sensitive to green). Used to order the mosaic's sampled colors so the
// most visually distinct ones come first (see drawBlurBackground).
function colorDistance(c1, c2) {
  const rMean = (c1.r + c2.r) / 2;
  const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

// Groups a color into one of 8 45-degree hue "families" (blue, yellow/gold,
// red, etc), or -1 for grayscale. Used alongside colorDistance so two
// samples aren't both treated as "distinct" just because they're far apart
// in raw RGB terms while still reading as the same basic hue.
const HUE_BUCKET_COUNT = 8;
function hueBucketOf(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return -1;
  let h;
  const d = max - min;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  h *= 60;
  return Math.floor(h / (360 / HUE_BUCKET_COUNT)) % HUE_BUCKET_COUNT;
}

// Builds the blurry background by sampling the album art down to a small
// grid of cells, shuffling which cell's color ends up where, then drawing
// that shuffled grid stretched across the full (oversized, see
// BLUR_CANVAS_OVERSCAN) canvas. The CSS blur filter on .player-blur-bg then
// smooths the blocky shuffled grid into soft, organic-looking color
// regions - since the source pixels are the actual album art, the colors
// and their relative proportions naturally match the art without needing
// separate palette-extraction/shape-drawing logic at all.
//
// The canvas is always drawn at the panel's true MAXIMUM possible height -
// player bar height plus the largest the lyrics panel could ever be
// resized to - never at whatever height happens to be current. Every
// state below that ceiling (lyrics closed, lyrics open at the default
// size, or resized to anything in between) is simply a crop into this one
// fixed-size canvas via .player-blur-clip's overflow:hidden, not a
// separately-computed grid. This sidesteps an entire class of bug from
// earlier attempts: recomputing cell density (or even just the canvas
// size) for whatever height was current meant the render grid either had
// too few rows actually landing inside a short visible window (flat/muddy
// look) or reshuffled into a visibly different pattern on every drag tick
// of the resize handle - including behind the player bar, which should
// never change regardless of the lyrics panel's state.
function drawBlurBackground(sourceImg, seedKey) {
  if (!blurCanvas || !blurCtx || !blurWrap || !blurGroup || !sourceImg) return;
  const visibleW = blurGroup.clientWidth || 1;
  // Recorded so the ResizeObserver below (which watches this same
  // element) can tell a genuine width change from its own echo of the
  // redraw this function is about to perform.
  lastDrawnBlurWidth = visibleW;
  // Draw for the TRUE ceiling of how tall this panel could ever be - not
  // "however tall it happens to be right now". Using the current height
  // (even just when the lyrics panel happens to be open, or - on mobile -
  // when the full player happens to be expanded) means every state change
  // produces a differently-sized, differently-shuffled canvas, which makes
  // the artwork visibly shift/reshuffle on every expand/collapse even
  // though the underlying source art hasn't changed. There is exactly ONE
  // ceiling, shared by every surface that reveals this canvas (desktop
  // player bar, desktop player bar + lyrics panel, mobile mini player,
  // mobile full player) - all four are just different-sized windows onto
  // the same underlying mosaic, the same way opening the lyrics panel on
  // desktop reveals more of the same canvas rather than generating a new
  // one. That ceiling is: the collapsed player bar's own height (fixed,
  // content-driven, identical on desktop and mobile-collapsed) plus the
  // largest the desktop lyrics panel can ever be dragged to (see the
  // matching cap in the lyrics resize handler, window.innerHeight - 220) -
  // mobile's full player never exceeds that same ceiling in practice since
  // it's bounded by the viewport itself, so no separate mobile-only term is
  // needed; using one shared ceiling everywhere is what keeps the mosaic
  // visually identical across every surface, exactly matching how desktop
  // resizing already stays stable.
  //
  // Collapsed height specifically (not whatever #playerBar's height
  // happens to be right now) is read via a dedicated measurement rather
  // than the live element, since #playerBar's own current height varies
  // by state (collapsed strip vs. expanded full player on mobile) and
  // reading it live here would reintroduce exactly the "recompute the
  // ceiling per-state" bug this comment opens with.
  const playerBarH = collapsedPlayerBarHeight();
  const maxLyricsH = window.innerHeight - 220;
  const maxVisibleH = playerBarH + Math.max(0, maxLyricsH);

  const w = visibleW + BLUR_CANVAS_OVERSCAN * 2;
  const h = maxVisibleH + BLUR_CANVAS_OVERSCAN * 2;
  // Both .player-blur-bg (blurWrap, the filtered element) and its canvas
  // child get the same fixed-max-height, overscan-padded, bottom-anchored
  // treatment - not just the canvas. filter: blur() is applied to
  // .player-blur-bg's own box, and overflow:hidden on that same element
  // clips its content down to whatever that box's CURRENT size is BEFORE
  // the filter runs - so if only the canvas got this treatment while
  // .player-blur-bg stayed inset:0 (shrinking with the panel), the filter
  // would still end up running on a short box whenever the lyrics panel
  // was closed, with the blur radius consuming a much larger fraction of
  // that box than when it's tall. That mismatch is what caused the closed
  // state to look meaningfully darker than the open state despite
  // identical underlying pixel content (verified via direct canvas
  // readback) - confirmed to reproduce in both Chromium and Firefox, so
  // it's standard filter behavior to design around, not an engine quirk.
  // .player-blur-clip (the actual outer wrapper, unfiltered) is what
  // reveals only the current visible slice via its own overflow:hidden.
  blurWrap.style.left = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurWrap.style.right = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurWrap.style.bottom = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurWrap.style.top = 'auto';
  blurWrap.style.width = `${w}px`;
  blurWrap.style.height = `${h}px`;

  // #playerBlurCanvas is a CHILD of .player-blur-bg (blurWrap), not a
  // sibling positioned independently against the same reference point -
  // see index.html. blurWrap itself is already the oversized, negatively-
  // offset box (left/right: -OVERSCAN above); the canvas filling it only
  // needs left/bottom: 0 to line up with its parent's edges exactly.
  // Repeating the same "-OVERSCAN" offset here (as this used to) applies
  // it TWICE relative to the page - once from blurWrap's own offset, once
  // again from the canvas's offset within blurWrap - shifting the actual
  // drawing surface an extra OVERSCAN px further than intended. The wrap
  // (and its background-color) still covered the resulting gap at small
  // overscan values, but the canvas itself was never actually reaching
  // one whole edge of its own parent box - that uncovered strip of empty/
  // transparent canvas is exactly what the blur filter was picking up and
  // smearing into a visible fade at the panel's true edge, worse on
  // whichever side the doubled offset pushed the canvas away from.
  blurCanvas.style.left = '0px';
  blurCanvas.style.bottom = '0px';
  blurCanvas.style.top = 'auto';
  blurCanvas.style.width = `${w}px`;
  blurCanvas.style.height = `${h}px`;

  const dpr = window.devicePixelRatio || 1;
  blurCanvas.width = Math.max(1, Math.round(w * dpr));
  blurCanvas.height = Math.max(1, Math.round(h * dpr));
  blurCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  blurCtx.clearRect(0, 0, w, h);

  // Sample the art at a fixed 10x10 grid, independent of the destination
  // panel's shape or size - this always yields 100 distinct sample colors
  // pulled from across the source art.
  const SAMPLE_SIZE = 10;
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = SAMPLE_SIZE;
  sampleCanvas.height = SAMPLE_SIZE;
  const sampleCtx = sampleCanvas.getContext('2d');
  sampleCtx.drawImage(sourceImg, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let cells;
  try {
    cells = sampleCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch (e) {
    // Canvas may be tainted (e.g. cross-origin without CORS headers)
    blurCtx.fillStyle = '#121214';
    blurCtx.fillRect(0, 0, w, h);
    return;
  }
  const samplePixels = [];
  for (let i = 0; i < SAMPLE_SIZE * SAMPLE_SIZE; i++) {
    const o = i * 4;
    samplePixels.push({ r: cells[o], g: cells[o + 1], b: cells[o + 2] });
  }

  // Order the 100 samples so the most visually distinct ones come first -
  // the front of the list is what a small render grid mostly draws from
  // (later cells only get used via repetition, see below), so front-
  // loading distinct colors matters more than a plain random shuffle,
  // which could just as easily cluster several near-identical shades early.
  //
  // Rather than an iterative farthest-point search, this groups samples by
  // hue family first (so "different hue" falls out of the grouping itself,
  // not a per-step check), sorts each group by distance from its own
  // average (pushing each family's most saturated/extreme shade to the
  // front, most washed-out/average-ish ones last), then interleaves the
  // groups round-robin - so consecutive picks in the final order alternate
  // between hue families whenever more than one is present. A seeded
  // rotation of which hue family starts the interleave keeps the same art
  // always producing the same order without every track starting on
  // whichever hue happens to sort first numerically.
  const byHue = new Map(); // hueBucket -> pixel[], -1 for grayscale
  for (const p of samplePixels) {
    const hb = hueBucketOf(p.r, p.g, p.b);
    if (!byHue.has(hb)) byHue.set(hb, []);
    byHue.get(hb).push(p);
  }
  for (const group of byHue.values()) {
    const n = group.length;
    const avg = {
      r: group.reduce((s, p) => s + p.r, 0) / n,
      g: group.reduce((s, p) => s + p.g, 0) / n,
      b: group.reduce((s, p) => s + p.b, 0) / n
    };
    group.sort((a, b) => colorDistance(b, avg) - colorDistance(a, avg));
  }

  // Dark pixels (near-black backgrounds, shadows, dark clothing/hair) tend
  // to be heavily overrepresented in album art - but a hue can genuinely BE
  // dark throughout (deep red/maroon, dark teal) without that making it any
  // less real or important a color; a dark but saturated red dress is a
  // meaningful accent, not "background noise that happens to be reddish".
  // So dark-reduction is applied WITHIN each hue group, not globally across
  // the whole pool before hue grouping - that ordering matters: applying it
  // first (as an earlier version did) meant a hue that happened to run dark
  // got its dark members thinned out by a pass that had no idea those
  // pixels were a specific, real hue worth preserving, and could end up
  // almost entirely eliminated before hue grouping ever got a chance to
  // recognize it as its own distinct color family. Doing it per-hue-group
  // instead only reduces each hue's OWN excess of dark members relative to
  // its own lighter members, never relative to unrelated hues or the
  // image's dark background.
  const DARK_LIGHTNESS_THRESHOLD = 60; // 0-255
  const DARK_EXTRA_REDUCTION = 0.4; // extra factor on top of sqrt, applied only to a group's dark subset
  function lightnessOf(p) { return (Math.max(p.r, p.g, p.b) + Math.min(p.r, p.g, p.b)) / 2; }
  for (const [hb, group] of byHue) {
    const dark = group.filter(p => lightnessOf(p) < DARK_LIGHTNESS_THRESHOLD);
    if (dark.length < 2) continue; // nothing meaningful to thin
    const notDark = group.filter(p => lightnessOf(p) >= DARK_LIGHTNESS_THRESHOLD);
    const keepDark = Math.max(1, Math.round(Math.sqrt(dark.length) * DARK_EXTRA_REDUCTION));
    // dark/notDark both inherit the group's existing furthest-from-average
    // sort order, so trimming dark down to keepDark still keeps that
    // subset's most distinctive (not just first-encountered) members.
    const thinnedDark = keepDark < dark.length ? dark.slice(0, keepDark) : dark;
    byHue.set(hb, notDark.concat(thinnedDark).sort((a, b) => group.indexOf(a) - group.indexOf(b)));
  }

  const rand = mulberry32(hashStringToSeed(seedKey || ''));
  const groups = [...byHue.values()];
  const startOffset = Math.floor(rand() * groups.length);
  const orderedColors = [];
  let idx = 0;
  const totalThinned = groups.reduce((s, g) => s + g.length, 0);
  while (orderedColors.length < totalThinned) {
    const group = groups[(idx + startOffset) % groups.length];
    if (group.length) orderedColors.push(group.shift());
    idx++;
  }
  const uniqueColors = orderedColors.map(c => `rgb(${c.r}, ${c.g}, ${c.b})`);

  // Render grid sized from the (always-tall) canvas itself, targeting a
  // fixed cell size roughly matched to the blur radius (50px, see
  // .player-blur-bg's filter) - no overscan-ratio compensation needed here
  // since we're no longer trying to squeeze enough rows into a short
  // visible window; the canvas is always tall enough for this to work.
  const TARGET_CELL_SIZE = 45; // px
  const renderCols = Math.max(3, Math.round(w / TARGET_CELL_SIZE));
  const renderRows = Math.max(3, Math.round(h / TARGET_CELL_SIZE));
  const totalCells = renderCols * renderRows;

  const colors = [];
  for (let i = 0; i < totalCells; i++) {
    colors.push(uniqueColors[i % uniqueColors.length]);
  }
  // If the render grid needed more cells than there are unique samples
  // (repetition kicked in), shuffle the final list once more so repeated
  // instances of the same color don't cluster together in a visible
  // pattern across the grid.
  if (totalCells > uniqueColors.length) {
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [colors[i], colors[j]] = [colors[j], colors[i]];
    }
  }

  // Draw the grid stretched across the full (oversized) canvas.
  const cellW = w / renderCols;
  const cellH = h / renderRows;
  for (let row = 0; row < renderRows; row++) {
    for (let col = 0; col < renderCols; col++) {
      blurCtx.fillStyle = colors[row * renderCols + col];
      // Slightly overdraw each cell (by half a pixel-ish amount, scaled to
      // cell size) so adjacent cells overlap a hair and there's no thin
      // seam line surviving the blur at cell boundaries.
      blurCtx.fillRect(
        Math.floor(col * cellW) - 1,
        Math.floor(row * cellH) - 1,
        Math.ceil(cellW) + 2,
        Math.ceil(cellH) + 2
      );
    }
  }
}

let lastBlurSourceImg = null;
let lastBlurSeedKey = null;
function redrawBlurForResize() {
  // A real resize can change the collapsed player bar's own height (e.g.
  // orientation change, crossing the mobile breakpoint, resizing a desktop
  // window narrow enough to wrap content) - invalidate the cache so
  // collapsedPlayerBarHeight() re-measures instead of returning a now-stale
  // value from before the resize.
  cachedCollapsedPlayerBarH = null;
  if (lastBlurSourceImg) drawBlurBackground(lastBlurSourceImg, lastBlurSeedKey);
}
window.addEventListener('resize', redrawBlurForResize);
// window 'resize' alone isn't reliable on mobile PWA/native shells:
// .player-blur-group's actual width can settle (viewport units resolving,
// safe-area insets applying, the WebView's own chrome finishing layout)
// AFTER drawBlurBackground's very first call already measured and drew
// against a narrower, not-yet-settled width - all without the window
// itself ever firing a 'resize' event, since window.innerWidth never
// actually changed. That left the canvas permanently drawn narrower than
// the real container, showing raw page content through uncovered strips
// on both sides - visible on every load, not just after some later
// resize. A ResizeObserver watches the actual container box instead of
// the window, so it also catches this "container settled to a different
// width than it first measured at" case - including via the callback
// that fires immediately on observe(), which is exactly the one that
// needs to be caught here rather than skipped, since it can already
// disagree with whatever width the initial drawBlurBackground call used.
if (typeof ResizeObserver !== 'undefined' && blurGroup) {
  new ResizeObserver((entries) => {
    const currentW = Math.round(entries[0].contentRect.width);
    if (currentW === lastDrawnBlurWidth) return; // already drawn for this width
    redrawBlurForResize();
  }).observe(blurGroup);
}

function applyBlurColors(sourceImg, seedKey, accentColor) {
  const root = document.documentElement.style;
  if (!sourceImg || !accentColor) {
    root.setProperty('--blur-opacity', '0');
    // No real mosaic to show (no art, or accent-color extraction failed) -
    // #playerBar's own fallback fill (see responsive.css) needs to be
    // fully opaque here, since there's nothing else behind it to guarantee
    // legible contrast for the controls/text on top, or to fill the
    // near-fullscreen mobile full player with anything other than
    // whatever page content happens to be behind it.
    root.setProperty('--player-fallback-opacity', '1');
    root.setProperty('--accent-color', '#e8e8ea');
    lastBlurSourceImg = null;
    lastBlurSeedKey = null;
    return;
  }
  lastBlurSourceImg = sourceImg;
  lastBlurSeedKey = seedKey;
  drawBlurBackground(sourceImg, seedKey);
  root.setProperty('--blur-opacity', '1');
  // A real mosaic is showing - #playerBar's own fill (mobile only, see
  // responsive.css) should get out of the way entirely so the mosaic's
  // actual sampled colors read through, rather than being muddied by a
  // dark tint sitting on top of it.
  root.setProperty('--player-fallback-opacity', '0');
  // Clamp to a legible lightness/saturation range so the accent color
  // harmonizes with the mosaic background without disappearing on very
  // light or very dark album art.
  root.setProperty('--accent-color', makeAccentColor(accentColor));
}

function updatePlayerArt(trackPath) {
  playerArtTrackPath = trackPath;
  const artImg = document.getElementById('playerArt');
  const artIcon = document.getElementById('playerArtIcon');
  const artUrl = `/api/art?path=${encodeURIComponent(trackPath)}`;

  artImg.classList.add('hidden');
  artIcon.classList.remove('hidden');

  // Temporarily fade out background while the new image loads
  document.documentElement.style.setProperty('--blur-opacity', '0');
  // Same reasoning as applyBlurColors' no-art branch: no mosaic is visible
  // during this loading gap, so the fallback fill needs to be opaque for
  // it. applyBlurColors (called once the new art's colors are extracted,
  // shortly after this) flips it back to 0 if that succeeds.
  document.documentElement.style.setProperty('--player-fallback-opacity', '1');

  // Use a separate offscreen image for color sampling so we don't affect
  // the visible <img>'s crossOrigin/loading behavior.
  const sampleImg = new Image();

  artImg.onload = () => {
    if (playerArtTrackPath !== trackPath) return; // a newer track started before this resolved
    artIcon.classList.add('hidden');
    artImg.classList.remove('hidden');
  };

  sampleImg.onload = () => {
    if (playerArtTrackPath !== trackPath) return; // a newer track started before this resolved
    const accentColor = extractAccentColor(sampleImg);
    applyBlurColors(sampleImg, artUrl, accentColor);
  };

  sampleImg.onerror = () => {
    if (playerArtTrackPath !== trackPath) return;
    // A track with no art shouldn't keep the *previous* track's accent
    // color lingering everywhere it's used (buttons, scrollbars, etc.) —
    // reset it back to the neutral default the same way applyBlurColors()
    // does when called with no image at all.
    applyBlurColors(null, null, null);
  };

  artImg.onerror = () => {
    if (playerArtTrackPath !== trackPath) return;
    artImg.classList.add('hidden');
    artIcon.classList.remove('hidden');
    applyBlurColors(null, null, null);
  };

  artImg.src = artUrl;
  sampleImg.src = artUrl;
}


document.getElementById('playPauseBtn').addEventListener('click', () => {
  if (justEnded) {
    justEnded = false;
    if (loopMode === 'all') {
      queueIndex = 0;
      playCurrent();
    } else {
      NativeAudioAdapter.seekTo(0);
      safePlay();
    }
    return;
  }
  if (NativeAudioAdapter.paused()) {
    safePlay();
  } else {
    NativeAudioAdapter.pause();
    stopSeekLoop();
    setPlayPauseIcon(false);
  }
});

// Wraps NativeAudioAdapter.play() (audioEl.play() on web, NativeAudio.play()
// on native - see native-audio-adapter.js) so the icon only flips to
// "playing" once playback has actually started, and so a suspended
// ReplayGain AudioContext (the
// PWA-background culprit — see the visibility/pageshow handling further
// down) gets resumed first. Without this, coming back from background with
// replayGainEnabled on left the context suspended, so .play() would
// silently produce no audio while the icon claimed it was playing.
function safePlay() {
  // ReplayGain's WebAudio graph (audioCtx/gainNode) only exists on the web
  // path - see state.js. NativeAudioAdapter.isNative() short-circuits this
  // on native, where audioCtx is never created in the first place.
  if (!NativeAudioAdapter.isNative() && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const p = NativeAudioAdapter.play();
  if (p && typeof p.then === 'function') {
    p.then(() => setPlayPauseIcon(true)).catch(() => setPlayPauseIcon(false));
  } else {
    setPlayPauseIcon(true);
  }
}

document.getElementById('nextBtn').addEventListener('click', playNext);
document.getElementById('prevBtn').addEventListener('click', playPrev);

function playNext() {
  if (queueIndex < queue.length - 1) {
    queueIndex++;
    playCurrent();
  } else if (loopMode === 'all' && queue.length) {
    queueIndex = 0;
    playCurrent();
  }
}
function playPrev() {
  if (queueIndex > 0) {
    queueIndex--;
    playCurrent();
  }
}
// STEP 2: shared by both the web audioEl 'ended' listener below and the
// native NativeAudioAdapter.onEnded() callback (registered further down) -
// "a track finished playing on its own" means the same thing on both
// platforms, so the loop/next-track decision lives in exactly one place
// rather than being duplicated per platform and risking drift.
function handleTrackEndedNaturally() {
  if (loopMode === 'one') {
    NativeAudioAdapter.seekTo(0);
    safePlay();
    return;
  }
  const hasNext = queueIndex < queue.length - 1;
  const willLoopAll = loopMode === 'all' && queue.length > 0;
  if (hasNext || willLoopAll) {
    playNext();
  } else {
    justEnded = true;
    setPlayPauseIcon(false);
  }
}
audioEl.addEventListener('ended', handleTrackEndedNaturally);
// Native has no per-element DOM events - NativeAudioAdapter.onEnded()
// registers a callback invoked from the plugin's 'stop' listener (see
// native-audio-adapter.js). This is a no-op on web, so it's safe to always
// call. Registered once, at script-eval time - not per-track - since
// onEnded() just appends to a list, matching addEventListener's semantics.
NativeAudioAdapter.onEnded(handleTrackEndedNaturally);

const seekBarEl = document.getElementById('seekBar');
let seekDragging = false;
let seekRAF = null;

// STEP 2 NOTE: buffered-download progress (the lighter "how much has
// loaded" fill behind the played-position fill) has no equivalent in
// NativeAudio's API at all - it doesn't expose buffer/download state, only
// position and duration. On native this returns 0, which the callers below
// already treat correctly (bufferedPct just floors to playedPct via the
// Math.max in updateSeekBarVisual, so the buffered fill simply tracks the
// played fill instead of showing a separate readahead - not wrong, just
// less informative than on web). Revisit only if NativeAudio adds buffer
// reporting; there's nothing to poll around this today.
function getBufferedEndPercent() {
  if (NativeAudioAdapter.isNative()) return 0;
  if (!audioEl.duration || !isFinite(audioEl.duration) || !audioEl.buffered.length) return 0;
  const t = audioEl.currentTime;
  for (let i = 0; i < audioEl.buffered.length; i++) {
    if (audioEl.buffered.start(i) <= t && t <= audioEl.buffered.end(i)) {
      return (audioEl.buffered.end(i) / audioEl.duration) * 100;
    }
  }
  // Not currently inside a buffered range (e.g. right at the start) — use the first range's end.
  return (audioEl.buffered.end(0) / audioEl.duration) * 100;
}

// currentTimeSec/durationSec: on web these just read audioEl's synchronous
// properties (unchanged from before). On native they mirror the values
// pushed by NativeAudioAdapter's 'currentTime' event (~100ms cadence, see
// onTimeUpdate below) rather than being fetched here, since
// updateSeekBarVisual/updateSeekDisplay are called from several synchronous
// call sites (playCurrent's reset, seek-drag handlers) that can't await a
// round-trip without visibly stalling the UI - this mirrors the same
// tradeoff audioEl itself makes (.currentTime reads whatever the last known
// position was, not a guaranteed-fresh value), just with a pushed event
// standing in for what the browser normally does internally.
let nativeCurrentTimeSec = 0;
let nativeDurationSec = NaN;
function currentTimeSec() { return NativeAudioAdapter.isNative() ? nativeCurrentTimeSec : audioEl.currentTime; }
function durationSec() { return NativeAudioAdapter.isNative() ? nativeDurationSec : audioEl.duration; }

// Every seek (drag, forward/back skip buttons, art slide-to-seek, restart-
// on-previous) should go through this instead of calling
// NativeAudioAdapter.seekTo() directly. On native, nativeCurrentTimeSec -
// which currentTimeSec() reads, and which every seek-target calculation
// in this file is based on (e.g. applySeek()'s "currentTimeSec() +
// settings.seekForward" in layout-init.js) - is ONLY ever refreshed by
// NativeAudioAdapter's pushed 'currentTime' event, which fires on a
// ~100ms cadence WHILE PLAYING (see onTimeUpdate below). While paused,
// nothing pushes that event, so a seek's real effect (the adapter's own
// liveCurrentTime, updated synchronously inside seekTo() - see
// native-audio-adapter.js) never made it back into nativeCurrentTimeSec:
// the timer text and seek bar stayed frozen at the pre-seek position, and
// a second forward/back tap computed its target from that same stale
// base again instead of the just-seeked position - landing on the same
// spot rather than advancing further. Re-reading getCurrentTime()
// immediately after seekTo() and pushing a display refresh closes that
// gap without needing to wait for playback to resume.
function seekToAndSync(seconds) {
  NativeAudioAdapter.seekTo(seconds);
  if (NativeAudioAdapter.isNative()) {
    nativeCurrentTimeSec = NativeAudioAdapter.getCurrentTime();
    updateSeekDisplay();
    if (typeof updateFpTimeDisplay === 'function') updateFpTimeDisplay();
  }
}

function updateSeekBarVisual() {
  const duration = durationSec();
  if (!duration || !isFinite(duration)) return;
  const playedPct = Math.min(100, (currentTimeSec() / duration) * 100);
  const bufferedPct = Math.max(playedPct, Math.min(100, getBufferedEndPercent()));
  seekBarEl.style.setProperty('--played-pct', playedPct + '%');
  seekBarEl.style.setProperty('--buffered-pct', bufferedPct + '%');
}

function updateSeekDisplay() {
  const duration = durationSec();
  if (duration && isFinite(duration)) {
    if (!seekDragging) {
      seekBarEl.value = (currentTimeSec() / duration) * 100;
    }
    updateSeekBarVisual();
    const remaining = duration - currentTimeSec();
    document.getElementById('timeDisplay').textContent =
      `${formatTime(currentTimeSec())} / -${formatTime(remaining)}`;
  }
}

// REVISED: earlier versions of this file drove native time updates with a
// requestAnimationFrame poll loop that round-tripped to
// NativeAudioAdapter.getCurrentTime() every tick. NativeAudioAdapter now
// pushes position updates itself via the plugin's real 'currentTime' event
// (~100ms cadence - see native-audio-adapter.js), so this just mirrors that
// pushed value into nativeCurrentTimeSec/nativeDurationSec and re-runs the
// same updateSeekDisplay used on web - no polling, no per-tick round-trip.
//
// This also replaces the old shared "nativePollSubscribers" mechanism:
// other files (layout-init.js's fpSeekBar mirroring, synced lyrics, etc.)
// now subscribe directly via NativeAudioAdapter.onTimeUpdate(), the same
// event this listener itself is one subscriber of, rather than piggy-
// backing on a poll loop defined here.
// getCurrentTime()/getDuration() are both plain synchronous reads now (see
// their comments in native-audio-adapter.js) - liveCurrentTime is kept
// current by the plugin's pushed 'currentTime' event itself, so there's no
// async round-trip left to wait on here, and this can update
// nativeCurrentTimeSec/nativeDurationSec and call updateSeekDisplay in one
// synchronous pass per event tick (no one-tick lag from an unresolved
// promise, which an earlier .then()-based version of this had).
NativeAudioAdapter.onTimeUpdate(() => {
  if (seekDragging) return;
  nativeCurrentTimeSec = NativeAudioAdapter.getCurrentTime();
  const d = NativeAudioAdapter.getDuration();
  if (typeof d === 'number' && isFinite(d) && d > 0) nativeDurationSec = d;
  updateSeekDisplay();
});

function seekLoop() {
  updateSeekDisplay();
  seekRAF = requestAnimationFrame(seekLoop);
}
// Web-only now: native no longer needs a driving loop of its own (the
// 'currentTime' event above drives updateSeekDisplay directly whenever the
// native side pushes a new tick), so startSeekLoop/stopSeekLoop are no-ops
// on native.
function startSeekLoop() {
  if (NativeAudioAdapter.isNative()) return;
  if (!seekRAF) seekRAF = requestAnimationFrame(seekLoop);
}
function stopSeekLoop() {
  if (NativeAudioAdapter.isNative()) return;
  if (seekRAF) cancelAnimationFrame(seekRAF);
  seekRAF = null;
}

// startSeekLoop/stopSeekLoop are now web-only (see their own comments
// above) - on native, updateSeekDisplay is driven directly by the
// 'currentTime' event subscription further up this file, so there's no
// loop left to start/stop there. Calling these unconditionally alongside
// every adapter play/pause call site is still correct and harmless: they
// simply no-op on native.
audioEl.addEventListener('play', startSeekLoop);
audioEl.addEventListener('pause', stopSeekLoop);
audioEl.addEventListener('ended', stopSeekLoop);
audioEl.addEventListener('timeupdate', updateSeekDisplay); // fallback for the first frame before 'play' fires
audioEl.addEventListener('progress', updateSeekBarVisual); // buffering can progress while paused/loading
audioEl.addEventListener('loadedmetadata', updateSeekBarVisual);

seekBarEl.addEventListener('pointerdown', () => { seekDragging = true; });
seekBarEl.addEventListener('input', (e) => {
  const duration = durationSec();
  if (duration) {
    seekToAndSync((e.target.value / 100) * duration);
  }
});
seekBarEl.addEventListener('change', () => { seekDragging = false; });
function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}