// ---------------------------------------------------------------------------
// playback.js — Queue primitives, play/pause/next/prev, the marquee text
// scroller, player bar, album-art accent-color extraction and the blurred
// background mosaic, and the seek bar.
// Depends on: state.js, selection.js, browse.js, filelist.js.
// ---------------------------------------------------------------------------

// ---------- Playback ----------
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

async function handleSongClick(item) {
  const idx = queue.findIndex(t => t.path === item.path);
  if (idx !== -1) {
    if (idx === queueIndex) return; // already playing this exact track
    queueIndex = idx;
    playCurrent();
    return;
  }
  // Not in the queue: enqueue every song in its containing folder (not subfolders) and play this one.
  const folder = dirNameOf(item.path);
  const { items } = await api(`/api/browse?path=${encodeURIComponent(folder)}`);
  const tracks = items.filter(i => i.isAudio).map(f => ({ path: f.path, name: f.name }));
  const clickedIndex = tracks.findIndex(t => t.path === item.path);
  resetQueue(tracks.length ? tracks : [{ path: item.path, name: item.name }]);
  queueIndex = clickedIndex >= 0 ? clickedIndex : 0;
  playCurrent();
  renderQueue();
}

function handleLibrarySongClick(item) {
  const idx = queue.findIndex(t => t.path === item.path);
  if (idx !== -1) {
    if (idx === queueIndex) return; // already playing this exact track
    queueIndex = idx;
    playCurrent();
    return;
  }
  // Not in the queue: enqueue every song in this artist/album view and play this one.
  const tracks = lastFetchedItems.map(f => ({ path: f.path, name: f.name }));
  const clickedIndex = tracks.findIndex(t => t.path === item.path);
  resetQueue(tracks.length ? tracks : [{ path: item.path, name: item.name }]);
  queueIndex = clickedIndex >= 0 ? clickedIndex : 0;
  playCurrent();
  renderQueue();
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
async function fillFolderQueueInBackground(item, firstTrack) {
  const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
  // The user may have already skipped away from the folder entirely
  // (played something else, cleared the queue) by the time this resolves —
  // don't clobber whatever's playing now with a stale folder's tracks.
  if (!(queue.length === 1 && queue[0].path === firstTrack.path)) return;
  const rest = files.filter(f => f !== firstTrack.path).map(f => ({ path: f, name: fileNameOf(f) }));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const tracks = [firstTrack, ...rest];
  resetQueue(tracks);
  queueIndex = 0;
  if (tracks.length > 1) {
    shuffled = true;
    updateShuffleBtnState();
  }
  renderQueue();
}

// ---------- Synced marquee (title + file name scroll at same speed, hold, wait for both) ----------
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
  pathSpan.style.transform = 'translateX(0)';

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
    const pathWrap = pathSpan.closest('.marquee-wrap');
    const nameOverflow = nameSpan.scrollWidth - nameWrap.clientWidth;
    const pathOverflow = pathSpan.scrollWidth - pathWrap.clientWidth;

    const nameDist = nameOverflow > 0 ? nameSpan.scrollWidth - nameWrap.clientWidth + MARQUEE_GAP : 0;
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
  
  const lbWrap = document.querySelector('.lyrics-box-wrap');
  lbWrap.classList.add('hidden');
  lbWrap.classList.remove('open');
  document.getElementById('lyricsBox').classList.remove('open');
  lyricsBoxOpen = false;
  stopMarquee();
  audioEl.pause();
  audioEl.removeAttribute('src');
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
}

let justEnded = false; // true after the last track ends with nothing queued to follow

function playCurrent() {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  justEnded = false;
  const track = queue[queueIndex];
  audioEl.src = `/api/stream?path=${encodeURIComponent(track.path)}`;
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
  audioEl.playbackRate = speeds[speedIndex];
  audioEl.play();
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
    if (meta.artist || meta.album) {
      // Artist and album render on their own line each (rather than one
      // "Artist • Album" line) so pathEl.innerHTML — mirrored verbatim
      // into #miniPlayerSubtitle/#fpSubtitle by layout-init.js — carries
      // that same two-line structure everywhere it's reused. Each line is
      // its own block-level .pb-link-line so CSS can ellipsis-truncate it
      // independently; the player-bar's hand-built marquee (startMarquee,
      // below) only scrolls the *first* line horizontally the same way it
      // always scrolled the whole thing, since it has no notion of
      // multi-line content — the second line relies on CSS ellipsis
      // instead, same as every other truncated two-line label in the app.
      pathSpan.innerHTML = '';
      if (meta.artist) {
        const line = document.createElement('div');
        line.className = 'pb-link-line';
        const a = document.createElement('span');
        a.className = 'pb-link';
        a.textContent = meta.artist;
        a.addEventListener('click', () => openLibrary('artist', meta.artist));
        line.appendChild(a);
        pathSpan.appendChild(line);
      }
      if (meta.album) {
        const line = document.createElement('div');
        line.className = 'pb-link-line';
        const al = document.createElement('span');
        al.className = 'pb-link';
        al.textContent = meta.album;
        al.addEventListener('click', () => openLibrary('album', meta.album));
        line.appendChild(al);
        pathSpan.appendChild(line);
      }
    } else {
      pathSpan.textContent = track.path;
    }
    startMarquee(nameEl.querySelector('span'), pathSpan);
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
    // If metadata was already cached above, applyMeta() (and its
    // startMarquee() call) already ran synchronously with the same data —
    // calling it again here would race startMarquee()'s own pending
    // requestAnimationFrame measurement callback against this second call
    // (stopMarquee() only cancels an already-running frame loop, not a
    // still-pending initial measurement), which could leave the marquee
    // measuring stale/placeholder text and silently exiting instead of
    // ever animating the real title. applyReplayGain still needs to run
    // every time regardless.
    if (!cachedMeta) applyMeta(meta);
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
// Needs to be at least the blur radius (50px, see .player-blur-bg's filter)
// so the blur kernel always has real painted pixels to sample from at the
// panel's true edges, instead of mixing in empty transparent space there
// and darkening the edge - which is what caused the "always a dark
// fringe/black background" look before this fix.
const BLUR_CANVAS_OVERSCAN = 70;

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
  // Draw for the TRUE ceiling of how tall this panel could ever be - not
  // "however tall it happens to be right now". Using the current height
  // (even just when the lyrics panel happens to be open) meant every drag
  // of the resize handle produced a differently-sized, differently-
  // shuffled canvas on every tick, which made the artwork behind the
  // player bar visibly shift during a resize even though that portion is
  // never supposed to change. The true ceiling is the player bar's own
  // height (always visible, fixed by its content) plus the largest the
  // lyrics panel can ever be dragged to (see the matching cap in the
  // lyrics resize handler, window.innerHeight - 220).
  const playerBarH = playerBarEl.getBoundingClientRect().height || 0;
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

  blurCanvas.style.left = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurCanvas.style.bottom = `${-BLUR_CANVAS_OVERSCAN}px`;
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
window.addEventListener('resize', () => {
  if (lastBlurSourceImg) drawBlurBackground(lastBlurSourceImg, lastBlurSeedKey);
});

function applyBlurColors(sourceImg, seedKey, accentColor) {
  const root = document.documentElement.style;
  if (!sourceImg || !accentColor) {
    root.setProperty('--blur-opacity', '0');
    root.setProperty('--accent-color', '#e8e8ea');
    lastBlurSourceImg = null;
    lastBlurSeedKey = null;
    return;
  }
  lastBlurSourceImg = sourceImg;
  lastBlurSeedKey = seedKey;
  drawBlurBackground(sourceImg, seedKey);
  root.setProperty('--blur-opacity', '1');
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
      audioEl.currentTime = 0;
      safePlay();
    }
    return;
  }
  if (audioEl.paused) {
    safePlay();
  } else {
    audioEl.pause();
    setPlayPauseIcon(false);
  }
});

// Wraps audioEl.play() so the icon only flips to "playing" once playback
// has actually started, and so a suspended ReplayGain AudioContext (the
// PWA-background culprit — see the visibility/pageshow handling further
// down) gets resumed first. Without this, coming back from background with
// replayGainEnabled on left the context suspended, so .play() would
// silently produce no audio while the icon claimed it was playing.
function safePlay() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const p = audioEl.play();
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
audioEl.addEventListener('ended', () => {
  if (loopMode === 'one') {
    audioEl.currentTime = 0;
    audioEl.play();
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
});

const seekBarEl = document.getElementById('seekBar');
let seekDragging = false;
let seekRAF = null;

function getBufferedEndPercent() {
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

function updateSeekBarVisual() {
  if (!audioEl.duration || !isFinite(audioEl.duration)) return;
  const playedPct = Math.min(100, (audioEl.currentTime / audioEl.duration) * 100);
  const bufferedPct = Math.max(playedPct, Math.min(100, getBufferedEndPercent()));
  seekBarEl.style.setProperty('--played-pct', playedPct + '%');
  seekBarEl.style.setProperty('--buffered-pct', bufferedPct + '%');
}

function updateSeekDisplay() {
  if (audioEl.duration) {
    if (!seekDragging) {
      seekBarEl.value = (audioEl.currentTime / audioEl.duration) * 100;
    }
    updateSeekBarVisual();
    const remaining = audioEl.duration - audioEl.currentTime;
    document.getElementById('timeDisplay').textContent =
      `${formatTime(audioEl.currentTime)} / -${formatTime(remaining)}`;
  }
}

function seekLoop() {
  updateSeekDisplay();
  seekRAF = requestAnimationFrame(seekLoop);
}
function startSeekLoop() { if (!seekRAF) seekRAF = requestAnimationFrame(seekLoop); }
function stopSeekLoop() { if (seekRAF) cancelAnimationFrame(seekRAF); seekRAF = null; }

audioEl.addEventListener('play', startSeekLoop);
audioEl.addEventListener('pause', stopSeekLoop);
audioEl.addEventListener('ended', stopSeekLoop);
audioEl.addEventListener('timeupdate', updateSeekDisplay); // fallback for the first frame before 'play' fires
audioEl.addEventListener('progress', updateSeekBarVisual); // buffering can progress while paused/loading
audioEl.addEventListener('loadedmetadata', updateSeekBarVisual);

seekBarEl.addEventListener('pointerdown', () => { seekDragging = true; });
seekBarEl.addEventListener('input', (e) => {
  if (audioEl.duration) {
    audioEl.currentTime = (e.target.value / 100) * audioEl.duration;
  }
});
seekBarEl.addEventListener('change', () => { seekDragging = false; });
function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}