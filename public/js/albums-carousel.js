// ---------------------------------------------------------------------------
// albums-carousel.js — Mobile landscape-only "album carousel" view: a
// horizontal strip of every album's art (see landscape-albums.css for the
// orientation media query that shows/hides this in place of the normal
// phone layout). Tapping an album opens its info + song list; tapping a
// song plays it using the same queue/playback machinery as everywhere else
// in the app (resetQueue/playCurrent, from playback.js), so the real player
// bar, mini player, lyrics, etc. all keep working normally underneath -
// this view just doesn't surface any of them itself (per spec: no player
// bar/seek here, only the playing song's title turning the accent color).
//
// Depends on: state.js, selection.js (api, fileNameOf, getMeta), browse.js
// (formatLongDuration, MUSIC_NOTE_PLACEHOLDER), filelist.js (formatSize),
// playback.js (resetQueue, playCurrent, renderQueue, getCurrentTrackPath).
// Must load LAST (after layout-init.js) since it only reacts to state those
// files own; nothing here is a dependency of anything else.
// ---------------------------------------------------------------------------

const landscapeAlbumsEl = document.getElementById('landscapeAlbums');
const landscapeAlbumsStripEl = document.getElementById('landscapeAlbumsStrip');
const landscapeAlbumsAlphabetEl = document.getElementById('landscapeAlbumsAlphabet');
const landscapeAlbumInfoEl = document.getElementById('landscapeAlbumInfo');
const landscapeAlbumSongsEl = document.getElementById('landscapeAlbumSongs');
const landscapeAlbumBackBtn = document.getElementById('landscapeAlbumBack');

let landscapeAlbumsList = null;      // cached [{name, year, artPath, songCount}], fetched once per session
let landscapeAlbumsLoadPromise = null;
let landscapeOpenAlbumName = null;   // album currently shown in the detail panel, or null
let landscapeOpenAlbumSongs = null;  // that album's song list (for playing), or null
let landscapeHasEnteredOnce = false; // guards the "jump to current song's album" behavior to once per rotation-in

// A phone's own screen doesn't change between portrait/landscape without a
// real rotation, so this only needs to run on the matches-change edge, not
// continuously - but matchMedia's own listener already only fires on edges,
// so no extra debouncing is needed here.
//
// MUST stay byte-for-byte in sync with the media query in
// landscape-albums.css (the CSS decides whether this view is actually
// visible; this JS decides when to fetch/render/reset its state) - see
// that file's header comment for why max-height: 780px (not max-width) is
// the right check here: a phone's short edge stays ~390-430px in either
// orientation, and 780px is this app's one existing phone-vs-not number
// (see responsive.css), just checked against the axis that's short right
// now instead of always width.
const LANDSCAPE_ALBUMS_QUERY = window.matchMedia('(orientation: landscape) and (max-height: 780px) and (hover: none) and (pointer: coarse)');

async function ensureLandscapeAlbumsList() {
  if (landscapeAlbumsList) return landscapeAlbumsList;
  if (!landscapeAlbumsLoadPromise) {
    landscapeAlbumsLoadPromise = api('/api/library/albums')
      .then(data => {
        // Sorted alphabetically (case/diacritic-insensitive) so the A-Z
        // quick-scroll bar's letter-to-index mapping actually lines up
        // with what's on screen - whatever order the API returns otherwise
        // isn't guaranteed to be alphabetical.
        landscapeAlbumsList = [...data.albums].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return landscapeAlbumsList;
      })
      .catch(() => { landscapeAlbumsLoadPromise = null; return []; });
  }
  return landscapeAlbumsLoadPromise;
}

// First letter used for both grouping into the A-Z bar and as each album
// card's data-letter (so the bar can highlight whichever letter is
// currently centered). Non-letters (numbers, symbols) bucket under '#',
// same convention as iOS Contacts/Music.
function landscapeAlbumLetter(name) {
  const ch = (name || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : '#';
}

function landscapeAlbumArtHTML(artPath, cls, placeholderCls) {
  return artPath
    ? `<img class="${cls}" loading="lazy" src="/api/art?path=${encodeURIComponent(artPath)}" alt="">`
    : `<div class="${placeholderCls}">🎵</div>`;
}

function renderLandscapeAlbumsStrip() {
  if (!landscapeAlbumsList || !landscapeAlbumsList.length) {
    landscapeAlbumsStripEl.innerHTML = '<div class="landscape-albums-empty">No albums found</div>';
    landscapeAlbumsAlphabetEl.innerHTML = '';
    return;
  }
  landscapeAlbumsStripEl.innerHTML = landscapeAlbumsList.map(a => `
    <div class="landscape-album-card" data-album="${a.name}" data-letter="${landscapeAlbumLetter(a.name)}">
      ${landscapeAlbumArtHTML(a.artPath, 'landscape-album-art', 'landscape-album-art-placeholder')}
      <div class="landscape-album-card-name">${a.name}</div>
      <div class="landscape-album-card-meta">${a.year ? a.year + ' • ' : ''}${a.songCount} song${a.songCount === 1 ? '' : 's'}</div>
    </div>
  `).join('');
  landscapeAlbumsStripEl.querySelectorAll('.landscape-album-card').forEach(el => {
    el.addEventListener('click', () => openLandscapeAlbum(el.dataset.album));
  });
  renderLandscapeAlbumsAlphabet();
  updateLandscapeAlbumsPlayingHighlight();
  updateLandscapeCoverFlow();
}

// Cover flow: tilts/scales/depth-shifts each card by its distance from the
// strip's horizontal center, so the centered album sits flat and full-size
// while neighbors fan away in 3D (classic iTunes cover-flow look) - the
// scroll-snap behavior above already does the paging, this just reacts to
// wherever the strip currently is scrolled to.
let landscapeCoverFlowRAF = null;
function updateLandscapeCoverFlow() {
  landscapeCoverFlowRAF = null;
  const stripRect = landscapeAlbumsStripEl.getBoundingClientRect();
  if (!stripRect.width) return;
  const centerX = stripRect.left + stripRect.width / 2;
  landscapeAlbumsStripEl.querySelectorAll('.landscape-album-card').forEach(card => {
    const cardRect = card.getBoundingClientRect();
    const cardCenterX = cardRect.left + cardRect.width / 2;
    // Normalized by card width (not strip width) so the tilt is consistent
    // regardless of screen size - 1.0 means "one card-width away from center".
    const offset = (cardCenterX - centerX) / cardRect.width;
    const absOffset = Math.abs(offset);
    const clamped = Math.max(-1, Math.min(1, offset));
    // Like the classic iTunes cover-flow effect: the centered cover sits
    // flat and forward; everything else snaps close to a fixed ~45deg tilt
    // (not a shallow gradual one) and recedes further back the farther out
    // it is, with side covers dimmed so the centered one visually pops.
    const rotateY = clamped * -45;
    const translateZ = -Math.min(absOffset, 3) * 60;
    const brightness = 1 - Math.min(absOffset, 1) * 0.4;
    card.style.transform = `translateZ(${translateZ}px) rotateY(${rotateY}deg)`;
    card.style.filter = `brightness(${brightness})`;
    // Cards now overlap tightly (see the negative margin above), so every
    // card's name/meta caption would otherwise collide with its neighbors' -
    // only the centered one's stays legible, same as real cover-flow UIs
    // that show a single caption for whichever cover is focused.
    const nameEl = card.querySelector('.landscape-album-card-name');
    const metaEl = card.querySelector('.landscape-album-card-meta');
    const textOpacity = Math.max(0, 1 - absOffset * 2.5);
    if (nameEl) nameEl.style.opacity = String(textOpacity);
    if (metaEl) metaEl.style.opacity = String(textOpacity);
    card.style.zIndex = String(1000 - Math.round(absOffset * 10));
  });
}
function scheduleLandscapeCoverFlow() {
  if (landscapeCoverFlowRAF) return;
  landscapeCoverFlowRAF = requestAnimationFrame(updateLandscapeCoverFlow);
}
landscapeAlbumsStripEl.addEventListener('scroll', scheduleLandscapeCoverFlow, { passive: true });
window.addEventListener('resize', scheduleLandscapeCoverFlow);

// Builds the full A-Z (+ '#') bar. Letters with no matching album are
// still shown (for a stable, predictable layout like iOS Contacts) but
// dimmed and inert, rather than only rendering the letters actually
// present, which would keep shifting positions as the library changes.
const LANDSCAPE_ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function renderLandscapeAlbumsAlphabet() {
  const present = new Set((landscapeAlbumsList || []).map(a => landscapeAlbumLetter(a.name)));
  landscapeAlbumsAlphabetEl.innerHTML = LANDSCAPE_ALPHABET.map(letter => `
    <div class="landscape-albums-alphabet-letter${present.has(letter) ? '' : ' disabled'}" data-letter="${letter}">${letter}</div>
  `).join('');
}

// Scrolls the carousel to the first card for a given letter. Called both
// on tap and continuously while dragging across the bar.
function jumpToLandscapeAlbumLetter(letter) {
  const card = landscapeAlbumsStripEl.querySelector(`.landscape-album-card[data-letter="${CSS.escape(letter)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
  landscapeAlbumsAlphabetEl.querySelectorAll('.landscape-albums-alphabet-letter').forEach(el => {
    el.classList.toggle('active', el.dataset.letter === letter);
  });
}

// Resolves whichever letter cell a touch/pointer point currently sits
// over, purely from the bar's own layout - same technique iOS Contacts
// uses so a single continuous drag across the index scrubs through the
// whole list without needing to lift and re-tap per letter.
function landscapeAlphabetLetterAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const cell = el && el.closest('.landscape-albums-alphabet-letter');
  return cell ? cell.dataset.letter : null;
}

let landscapeAlphabetScrubbing = false;
let landscapeAlphabetLastLetter = null;
function handleLandscapeAlphabetPoint(clientX, clientY) {
  const letter = landscapeAlphabetLetterAtPoint(clientX, clientY);
  if (!letter || letter === landscapeAlphabetLastLetter) return;
  landscapeAlphabetLastLetter = letter;
  jumpToLandscapeAlbumLetter(letter);
}
landscapeAlbumsAlphabetEl.addEventListener('pointerdown', (e) => {
  landscapeAlphabetScrubbing = true;
  landscapeAlphabetLastLetter = null;
  landscapeAlbumsAlphabetEl.setPointerCapture(e.pointerId);
  handleLandscapeAlphabetPoint(e.clientX, e.clientY);
});
landscapeAlbumsAlphabetEl.addEventListener('pointermove', (e) => {
  if (!landscapeAlphabetScrubbing) return;
  handleLandscapeAlphabetPoint(e.clientX, e.clientY);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => {
  landscapeAlbumsAlphabetEl.addEventListener(evt, () => { landscapeAlphabetScrubbing = false; });
});

// Highlights whichever album card contains the currently-playing track (if
// any), same idea as updatePlayingHighlight() in browse.js but for cards
// instead of file rows. metaCache may not have this path yet (e.g. playback
// started from a context that never rendered a row for it) - getMeta()
// fetches+caches on demand in that case, same fallback every other caller
// of it already relies on.
async function updateLandscapeAlbumsPlayingHighlight() {
  const current = getCurrentTrackPath();
  const currentAlbum = current ? (await getMeta(current)).album : null;
  // The track may have changed again while that fetch was in flight.
  if (current !== getCurrentTrackPath()) return;
  landscapeAlbumsStripEl.querySelectorAll('.landscape-album-card').forEach(card => {
    card.classList.toggle('playing', !!currentAlbum && card.dataset.album === currentAlbum);
  });
}

async function openLandscapeAlbum(name, opts = {}) {
  landscapeOpenAlbumName = name;
  landscapeAlbumsEl.classList.add('detail-open');
  landscapeAlbumInfoEl.innerHTML = '';
  landscapeAlbumSongsEl.innerHTML = '';
  let data;
  try {
    data = await api(`/api/library/album?name=${encodeURIComponent(name)}`);
  } catch {
    landscapeAlbumSongsEl.innerHTML = '<div class="landscape-albums-empty">Couldn\'t load album</div>';
    return;
  }
  // The user may have tapped Back (or a different album) before this
  // resolved - don't clobber whatever's now showing with a stale response.
  if (landscapeOpenAlbumName !== name) return;
  landscapeOpenAlbumSongs = data.songs;

  landscapeAlbumInfoEl.innerHTML = `
    ${landscapeAlbumArtHTML(data.artPath, 'landscape-album-info-art', 'landscape-album-info-art-placeholder')}
    <div class="landscape-album-info-text">
      <div class="landscape-album-info-name">${data.name}</div>
      <div class="landscape-album-info-meta">${(data.artists || []).join(', ')}${data.year ? ` • ${data.year}` : ''} • ${data.totalSongs} song${data.totalSongs === 1 ? '' : 's'} • ${formatLongDuration(data.totalDuration)}</div>
    </div>
  `;

  landscapeAlbumSongsEl.innerHTML = data.songs.map((s, i) => `
    <div class="landscape-album-song-row" data-path="${s.path}">
      <span class="landscape-album-song-track">${s.track || i + 1}</span>
      <span class="landscape-album-song-title">${fileNameOf(s.path)}</span>
      <span class="landscape-album-song-duration"></span>
    </div>
  `).join('');
  landscapeAlbumSongsEl.querySelectorAll('.landscape-album-song-row').forEach(row => {
    row.addEventListener('click', () => playLandscapeAlbumSong(row.dataset.path));
  });
  updateLandscapeAlbumSongsHighlight();

  // Fill in real titles/durations once metadata resolves, same pattern
  // filelist.js uses for regular rows - the row already shows a sane
  // filename-based placeholder above so tapping isn't blocked on this.
  await prefetchMeta(data.songs.map(s => s.path));
  if (landscapeOpenAlbumName !== name) return; // stale again after the await
  data.songs.forEach(s => {
    const meta = metaCache[s.path];
    if (!meta) return;
    const row = landscapeAlbumSongsEl.querySelector(`.landscape-album-song-row[data-path="${CSS.escape(s.path)}"]`);
    if (!row) return;
    row.querySelector('.landscape-album-song-title').textContent = meta.title || fileNameOf(s.path);
    row.querySelector('.landscape-album-song-duration').textContent = formatDuration(meta.duration);
  });

  if (!opts.skipScroll) {
    const card = landscapeAlbumsStripEl.querySelector(`.landscape-album-card[data-album="${CSS.escape(name)}"]`);
    if (card) card.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
  }
}

// Playing a song here plays the whole album as the queue (so next/prev and
// the real player bar work normally once the user leaves this view /
// rotates back), starting at the tapped track - same "play this list
// starting here" pattern as playAllSongs()/handleLibrarySongClick()
// elsewhere, just without jumping to the full player since this view has
// no player bar of its own to show.
function playLandscapeAlbumSong(path) {
  if (!landscapeOpenAlbumSongs) return;
  const idx = landscapeOpenAlbumSongs.findIndex(s => s.path === path);
  if (idx === -1) return;
  const alreadyThisQueue = queue.length === landscapeOpenAlbumSongs.length &&
    queue.every((t, i) => t.path === landscapeOpenAlbumSongs[i].path);
  if (alreadyThisQueue) {
    if (queueIndex === idx) return; // already playing this exact track
    queueIndex = idx;
    playCurrent();
  } else {
    resetQueue(landscapeOpenAlbumSongs.map(s => ({ path: s.path, name: fileNameOf(s.path) })));
    queueIndex = idx;
    // This view intentionally shows/opens no player bar - suppress
    // layout-init.js's usual "auto-expand the full player on first play"
    // behavior for this one transition (see playWholePlaylist in
    // queue-playlists.js for the existing use of this same flag).
    window.suppressNextAutoExpand = true;
    playCurrent();
  }
  renderQueue();
  updateLandscapeAlbumSongsHighlight();
  updateLandscapeAlbumsPlayingHighlight();
}

function updateLandscapeAlbumSongsHighlight() {
  const current = getCurrentTrackPath();
  landscapeAlbumSongsEl.querySelectorAll('.landscape-album-song-row').forEach(row => {
    row.classList.toggle('playing', !!current && row.dataset.path === current);
  });
}

function closeLandscapeAlbumDetail() {
  landscapeAlbumsEl.classList.remove('detail-open');
  landscapeOpenAlbumName = null;
  landscapeOpenAlbumSongs = null;
}
landscapeAlbumBackBtn.addEventListener('click', closeLandscapeAlbumDetail);

// Keep both the carousel's per-card highlight and (if open) the detail
// panel's per-row highlight in sync with whatever's actually playing,
// including songs started from completely outside this view (e.g. the
// queue tab, a folder) - scrolling through the carousel or opening an
// album must never interrupt playback, so this only ever reflects state,
// never drives it.
const landscapeAlbumsHighlightObserver = new MutationObserver(() => {
  if (!LANDSCAPE_ALBUMS_QUERY.matches) return;
  updateLandscapeAlbumsPlayingHighlight();
  if (landscapeOpenAlbumName) updateLandscapeAlbumSongsHighlight();
});
landscapeAlbumsHighlightObserver.observe(playerBarEl, { attributes: true, attributeFilter: ['class'] });

// playerBarEl's class flips (hidden <-> shown) only when a track starts
// playing from a fully-stopped state - the observer above covers that for
// free, but track changes *within* an already-playing queue (next/prev,
// auto-advance, tapping a different queue row) don't touch that class at
// all, since the bar was already visible. There's no existing app-wide
// "track changed" event to hook into instead (every call site just
// mutates queueIndex and calls playCurrent() directly), so this polls
// getCurrentTrackPath() cheaply on a slow interval, but ONLY while this
// view is actually the visible one - a paused/backgrounded phone in
// portrait does zero work here.
let landscapeAlbumsLastHighlightedPath = null;
setInterval(() => {
  if (!LANDSCAPE_ALBUMS_QUERY.matches) return;
  const current = getCurrentTrackPath();
  if (current === landscapeAlbumsLastHighlightedPath) return;
  landscapeAlbumsLastHighlightedPath = current;
  updateLandscapeAlbumsPlayingHighlight();
  if (landscapeOpenAlbumName) updateLandscapeAlbumSongsHighlight();
}, 1000);
async function enterLandscapeAlbumsView() {
  await ensureLandscapeAlbumsList();
  renderLandscapeAlbumsStrip();
  // The strip may have just rendered while this view was still `display:
  // none` (e.g. loaded once already in landscape) - its cards had zero-size
  // rects then, so re-run the layout-dependent cover-flow pass now that
  // it's actually visible.
  requestAnimationFrame(updateLandscapeCoverFlow);

  const current = getCurrentTrackPath();
  if (current && !landscapeHasEnteredOnce) {
    const meta = await getMeta(current);
    if (meta && meta.album && LANDSCAPE_ALBUMS_QUERY.matches) {
      await openLandscapeAlbum(meta.album);
    }
  }
  landscapeHasEnteredOnce = true;
}

LANDSCAPE_ALBUMS_QUERY.addEventListener('change', (e) => {
  if (e.matches) {
    enterLandscapeAlbumsView();
  } else {
    // Leaving landscape entirely resets the "jump to current album" guard,
    // so rotating back in later re-triggers it (e.g. the user switched to
    // a different song while in portrait) rather than only ever firing
    // once per page load.
    landscapeHasEnteredOnce = false;
  }
});
// Cover the case where the app is first loaded already in this orientation
// (e.g. a tablet/phone opened directly in landscape) - the change listener
// above only fires on a later transition, not on initial load.
if (LANDSCAPE_ALBUMS_QUERY.matches) enterLandscapeAlbumsView();