// ---------------------------------------------------------------------------
// layout-init.js — Resizable column/sidebar/lyrics-panel layout persistence,
// and app initialization (reading the URL hash, loading playlists, rendering
// the initial queue). Must load LAST.
// Depends on: everything above.
// ---------------------------------------------------------------------------

// ---------- Resizable layout (column widths + sidebar width) ----------
const COL_MIN_WIDTHS = { title: 80, artist: 60, album: 60, duration: 50, size: 50 };
const SIDEBAR_MIN = 220;
// For each border, which two columns it controls: the left neighbor and the right neighbor.
// A null left neighbor means "Name" (the flexible column), which isn't a settable variable —
// shrinking/growing the right neighbor alone lets Name silently absorb the difference,
// and this is the only border where that happens (dragging it never moves any other border).
const RESIZE_PAIRS = {
  title:    { left: null,      right: 'title' },
  artist:   { left: 'title',   right: 'artist' },
  album:    { left: 'artist',  right: 'album' },
  duration: { left: 'album',   right: 'duration' },
  size:     { left: 'duration', right: 'size' }
};

function loadLayout() {
  try {
    const raw = localStorage.getItem('musicapp-layout');
    if (!raw) return;
    const layout = JSON.parse(raw);
    if (layout.sidebarW) {
      document.documentElement.style.setProperty('--sidebar-w', layout.sidebarW + 'px');
    }
    if (layout.lyricsH) {
      document.documentElement.style.setProperty('--lyrics-h', layout.lyricsH + 'px');
    }
    if (layout.cols) {
      Object.entries(layout.cols).forEach(([col, w]) => {
        fileListWrap.style.setProperty(`--col-${col}-w`, w + 'px');
      });
    }
  } catch {}
}
function saveLayout() {
  try {
    const style = getComputedStyle(fileListWrap);
    const cols = {};
    ['title', 'artist', 'album', 'duration', 'size'].forEach(col => {
      cols[col] = parseInt(style.getPropertyValue(`--col-${col}-w`), 10);
    });
    const sidebarW = parseInt(getComputedStyle(document.getElementById('sidebar')).width, 10);
    const lyricsH = parseInt(getComputedStyle(document.getElementById('lyricsBox')).getPropertyValue('--lyrics-h')) || 280;
    localStorage.setItem('musicapp-layout', JSON.stringify({ cols, sidebarW, lyricsH }));
  } catch {}
}

document.querySelectorAll('.col-resize-handle').forEach(handle => {
  const pair = RESIZE_PAIRS[handle.dataset.col];
  handle.addEventListener('click', (e) => e.stopPropagation());
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const style = getComputedStyle(fileListWrap);
    const startRight = parseInt(style.getPropertyValue(`--col-${pair.right}-w`), 10);
    const startLeft = pair.left ? parseInt(style.getPropertyValue(`--col-${pair.left}-w`), 10) : null;
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    function onMove(ev) {
      const delta = ev.clientX - startX;
      if (pair.left === null) {
        // Only this border's right column changes; Name (flexible) absorbs the rest —
        // this never shifts any other border.
        const newRight = Math.max(COL_MIN_WIDTHS[pair.right], startRight - delta);
        fileListWrap.style.setProperty(`--col-${pair.right}-w`, newRight + 'px');
      } else {
        // Grow the left neighbor and shrink the right neighbor by the same amount —
        // every other column (including Name and everything beyond the right neighbor)
        // stays exactly where it is.
        const newLeft = Math.max(COL_MIN_WIDTHS[pair.left], startLeft + delta);
        const newRight = Math.max(COL_MIN_WIDTHS[pair.right], startRight - delta);
        fileListWrap.style.setProperty(`--col-${pair.left}-w`, newLeft + 'px');
        fileListWrap.style.setProperty(`--col-${pair.right}-w`, newRight + 'px');
      }
    }
    function onUp() {
      handle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});

const sidebarResizeHandle = document.getElementById('sidebarResizeHandle');
const sidebarEl = document.getElementById('sidebar');
sidebarResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = sidebarEl.getBoundingClientRect().width;
  sidebarResizeHandle.classList.add('resizing');
  document.body.style.cursor = 'col-resize';
  function onMove(ev) {
    const delta = ev.clientX - startX;
    const maxWidth = window.innerWidth - 200; // keep the file list from being squeezed to nothing
    const newWidth = Math.min(maxWidth, Math.max(SIDEBAR_MIN, startWidth - delta));
    document.documentElement.style.setProperty('--sidebar-w', newWidth + 'px');
  }
  function onUp() {
    sidebarResizeHandle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveLayout();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

loadLayout();

const lyricsResizeHandle = document.getElementById('lyricsResizeHandle');
lyricsResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = lyricsBoxEl.getBoundingClientRect().height;
  lyricsResizeHandle.classList.add('resizing');
  lyricsBoxEl.classList.add('no-transition');
  document.body.style.cursor = 'row-resize';
  function onMove(ev) {
    const delta = ev.clientY - startY;
    const maxHeight = window.innerHeight - 220; // keep the file list from being squeezed to nothing
    const newHeight = Math.min(maxHeight, Math.max(120, startHeight - delta));
    document.documentElement.style.setProperty('--lyrics-h', newHeight + 'px');
    // No redraw needed: drawBlurBackground already sized the canvas for
    // this exact maximum (window.innerHeight - 220 + player bar height),
    // so dragging within that range just reveals more/less of the same
    // fixed artwork via CSS, the same way open/close does.
  }
  function onUp() {
    lyricsResizeHandle.classList.remove('resizing');
    lyricsBoxEl.classList.remove('no-transition');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveLayout();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ---------- Init ----------
const initialHash = decodeURIComponent((location.hash || '#').slice(1));
if (initialHash.startsWith('artist=')) {
  const n = initialHash.slice(7);
  history.replaceState({ view: 'artist', name: n }, '', location.hash);
  openLibrary('artist', n, { skipHistory: true });
} else if (initialHash.startsWith('album=')) {
  const n = initialHash.slice(6);
  history.replaceState({ view: 'album', name: n }, '', location.hash);
  openLibrary('album', n, { skipHistory: true });
} else {
  history.replaceState({ path: initialHash }, '', location.hash || '#');
  browse(initialHash, { skipHistory: true });
}
loadPlaylists();
renderQueue();

// ---------------------------------------------------------------------------
// Mobile app shell: bottom nav (Files / Queue / Playlists), full-screen
// sidebar overlay, and the compact/expandable player bar. All of this is a
// no-op above the 780px breakpoint — the CSS simply doesn't show these
// elements on desktop, so none of the classes toggled here affect desktop
// layout.
// ---------------------------------------------------------------------------
const appEl = document.querySelector('.app');
const bottomNav = document.getElementById('bottomNav');

function setMobileTab(tab) {
  appEl.classList.remove('mobile-tab-files', 'mobile-tab-queue', 'mobile-tab-playlists');
  appEl.classList.add('mobile-tab-' + tab);
  bottomNav.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mobileTab === tab);
  });
  // Reuse the existing (desktop) sidebar tab-switching logic so the correct
  // panel (queue vs playlists) is shown inside the sidebar overlay.
  if (tab === 'queue' || tab === 'playlists') {
    const sidebarTabBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (sidebarTabBtn && !sidebarTabBtn.classList.contains('active')) sidebarTabBtn.click();
  }
}
bottomNav.querySelectorAll('.bottom-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.mobileTab;
    // While the full player is open, every nav tap first closes it back
    // down to the mini player, then still performs its normal tab action
    // below (switch tabs, or Files' "go home" shortcut) — except Files'
    // go-home shortcut specifically never fires in this case: with the
    // player open, "Files already being the active tab underneath" isn't
    // a deliberate second tap on an already-visible Files view the way it
    // is normally, so it shouldn't be read as "take me home" — just show
    // Files.
    const wasExpanded = playerBarEl.classList.contains('expanded');
    if (wasExpanded) togglePlayerExpanded(false);
    // Tapping Files while already on the Files tab (and the player wasn't
    // just collapsed by this same tap) acts like the desktop breadcrumb's
    // "Home" link (browse('')) — a second, deliberate tap means "take me
    // back to the top", not "do nothing since I'm already here".
    // Queue/Playlists don't have an equivalent "home" concept, so this
    // only applies to Files.
    if (!wasExpanded && tab === 'files' && appEl.classList.contains('mobile-tab-files')) {
      browse('');
      return;
    }
    setMobileTab(tab);
  });
});
document.getElementById('sidebarCloseBtn').addEventListener('click', () => setMobileTab('files'));
setMobileTab('files');

// Keep .app's has-player class in sync with the player bar's own visibility
// so the file list / sidebar can reserve exactly the right amount of bottom
// padding (nav only, vs nav + player bar) without duplicating that logic.
// Also: the first time the bar goes from hidden to visible (a track just
// started playing) on mobile, open it full screen automatically rather
// than leaving the person to notice and tap the mini strip.
let wasPlayerHidden = playerBarEl.classList.contains('hidden');
const playerBarObserver = new MutationObserver(() => {
  const isHidden = playerBarEl.classList.contains('hidden');
  appEl.classList.toggle('has-player', !isHidden);
  if (wasPlayerHidden && !isHidden && window.matchMedia('(max-width: 780px)').matches) {
    togglePlayerExpanded(true);
  }
  wasPlayerHidden = isHidden;
});
playerBarObserver.observe(playerBarEl, { attributes: true, attributeFilter: ['class'] });
appEl.classList.toggle('has-player', !playerBarEl.classList.contains('hidden'));

// ---------- Expandable player bar (mobile) ----------
const miniPlayerEl = document.getElementById('miniPlayer');
function togglePlayerExpanded(force) {
  const willExpand = typeof force === 'boolean' ? force : !playerBarEl.classList.contains('expanded');
  playerBarEl.classList.toggle('expanded', willExpand);
  // #playerBar is actually a CHILD of .player-blur-group (see index.html),
  // not a sibling — CSS can't select a parent based on a child's class,
  // so the parent needs its own .expanded toggle here too, to pick up its
  // own transform rule (see responsive.css) independently of #playerBar's
  // (which no longer has a transform of its own — see the comments there
  // on why duplicating it broke the whole player down to just the blur).
  document.querySelector('.player-blur-group').classList.toggle('expanded', willExpand);
}
// Tapping anywhere on the mini player (art/title/subtitle) opens the full
// player — except its own buttons, which have their own actions.
miniPlayerEl.addEventListener('click', (e) => {
  if (e.target.closest('.mini-player-btn')) return;
  if (window.matchMedia('(max-width: 780px)').matches) togglePlayerExpanded(true);
});

// ---------- Swipe to expand/collapse (mobile) ----------
// Mirrors the collapse/expand gesture from Documents by Readdle's mini
// video player: swipe down on the full-screen player to shrink it to the
// mini bar, swipe up on the mini bar to bring it back to full screen. The
// player follows the finger while dragging rather than only reacting once
// the gesture finishes, then settles open/closed based on distance +
// velocity — dragging a little and letting go snaps back to where it
// started, same as the system sheets this is meant to feel like.
(function setupPlayerSwipe() {
  const DRAG_DISTANCE_THRESHOLD = 70;  // px of vertical travel to count as a real swipe
  const DRAG_VELOCITY_THRESHOLD = 0.5; // px/ms — a fast flick commits even if travel was short
  const blurGroupEl = document.querySelector('.player-blur-group');
  let startY = null;
  let startTime = 0;
  let dragging = false;

  function isMobile() { return window.matchMedia('(max-width: 780px)').matches; }

  function onPointerDown(e) {
    if (!isMobile()) return;
    // Let range sliders, buttons, and the lyrics scroll area handle their
    // own touch/drag behavior untouched — only bare background/art/text
    // areas of the bar start a swipe.
    if (e.target.closest('input[type="range"], button, #lyricsContent, .lyrics-box-wrap')) return;
    startY = e.clientY;
    startTime = performance.now();
    dragging = true;
    playerBarEl.classList.add('dragging');
    blurGroupEl.classList.add('dragging');
  }
  function onPointerMove(e) {
    if (!dragging || startY === null) return;
    const delta = e.clientY - startY;
    const expanded = playerBarEl.classList.contains('expanded');
    // Only resist/translate in the direction that makes sense for the
    // current state: expanded can only be dragged down (revealing the mini
    // strip's resting position from above), collapsed can only be dragged
    // up (revealing the expanded sheet from below). Dragging the "wrong"
    // way is a no-op rather than fighting the resting position.
    const clamped = expanded ? Math.max(0, delta) : Math.min(0, delta);
    // --drag-offset is added on top of whichever resting transform the
    // .expanded class (or its absence) already puts on the element — see
    // responsive.css, where both states' transform: translateY(...) end
    // with "+ var(--drag-offset, 0px))". This composes instead of
    // clobbering, so a drag starting from either resting state tracks the
    // finger continuously rather than jumping.
    playerBarEl.style.setProperty('--drag-offset', clamped + 'px');
    // #playerBar no longer has a transform of its own — .player-blur-group
    // (its parent) is the only element that actually moves, via its own
    // transform reading this same custom property (see responsive.css).
    // Setting it on playerBarEl above is inert (harmless, but nothing
    // reads it there); this call on the parent is the one that matters.
    blurGroupEl.style.setProperty('--drag-offset', clamped + 'px');
  }
  function onPointerUp(e) {
    if (!dragging || startY === null) return;
    dragging = false;
    playerBarEl.classList.remove('dragging');
    playerBarEl.style.removeProperty('--drag-offset');
    blurGroupEl.classList.remove('dragging');
    blurGroupEl.style.removeProperty('--drag-offset');
    const delta = (e.clientY ?? startY) - startY;
    const elapsed = Math.max(1, performance.now() - startTime);
    const velocity = Math.abs(delta) / elapsed;
    const expanded = playerBarEl.classList.contains('expanded');
    startY = null;
    if (expanded && delta > 0 && (delta > DRAG_DISTANCE_THRESHOLD || velocity > DRAG_VELOCITY_THRESHOLD)) {
      togglePlayerExpanded(false);
    } else if (!expanded && delta < 0 && (-delta > DRAG_DISTANCE_THRESHOLD || velocity > DRAG_VELOCITY_THRESHOLD)) {
      togglePlayerExpanded(true);
    }
    // Otherwise: didn't clear the threshold — removing --drag-offset above
    // snaps it back to the current resting state, animated by the
    // transition in responsive.css (suppressed only during .dragging).
    // reset above — CSS transition on .player-bar handles the animation.
  }

  playerBarEl.addEventListener('pointerdown', onPointerDown);
  playerBarEl.addEventListener('pointermove', onPointerMove);
  playerBarEl.addEventListener('pointerup', onPointerUp);
  playerBarEl.addEventListener('pointercancel', onPointerUp);
})();

// ---------- Mini player: mirrors the real player, forwards clicks ----------
// #miniPlayer is a fully independent element (see index.html) — it has its
// own art/title/subtitle and its own prev/play/next/close buttons with
// distinct IDs, so nothing here shares DOM or CSS with the full player.
// Buttons simply forward clicks to the real ones; text/art are kept in
// sync via MutationObserver on the real elements, one-directionally.
const miniPrevBtn = document.getElementById('miniPrevBtn');
const miniPlayPauseBtn = document.getElementById('miniPlayPauseBtn');
const miniNextBtn = document.getElementById('miniNextBtn');
const miniCloseBtn = document.getElementById('miniCloseBtn');
const realPrevBtn = document.getElementById('prevBtn');
const realPlayPauseBtn = document.getElementById('playPauseBtn');
const realNextBtn = document.getElementById('nextBtn');
const realCloseBtn = document.getElementById('closePlayerBtn');

// Play/pause icon swap: the real #playPauseBtn's content is plain text
// ('▶' or '⏸', set in playback.js) rather than these SVG icons, so mirror
// the *state* (which glyph is currently showing) and toggle two overlaid
// SVGs accordingly, instead of copying textContent into a button that no
// longer has a text node to receive it.
function syncPlayPauseIcon(btn) {
  const isPlaying = !realPlayPauseBtn.querySelector('.icon-pause').classList.contains('hidden');
  btn.querySelector('.icon-play').classList.toggle('hidden', isPlaying);
  btn.querySelector('.icon-pause').classList.toggle('hidden', !isPlaying);
}

miniPrevBtn.addEventListener('click', () => realPrevBtn.click());
miniNextBtn.addEventListener('click', () => realNextBtn.click());
miniCloseBtn.addEventListener('click', () => realCloseBtn.click());
miniPlayPauseBtn.addEventListener('click', () => realPlayPauseBtn.click());
new MutationObserver(() => syncPlayPauseIcon(miniPlayPauseBtn))
  .observe(realPlayPauseBtn, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
syncPlayPauseIcon(miniPlayPauseBtn);

// Art + title/artist mirror: copy from the real elements whenever they
// change, rather than re-deriving from queue/queueIndex — this way the
// mini player always shows exactly what the full player shows, with no
// separate logic to keep in sync with playback.js.
const miniPlayerArt = document.getElementById('miniPlayerArt');
const miniPlayerArtIcon = document.getElementById('miniPlayerArtIcon');
const miniPlayerTitle = document.getElementById('miniPlayerTitle');
const miniPlayerSubtitle = document.getElementById('miniPlayerSubtitle');
const realPlayerArt = document.getElementById('playerArt');
const realPlayerArtIcon = document.getElementById('playerArtIcon');
const realTrackName = document.getElementById('trackName');
const realTrackPath = document.getElementById('trackPath');

function syncMiniPlayerArt() {
  if (realPlayerArt.classList.contains('hidden')) {
    miniPlayerArt.classList.add('hidden');
    miniPlayerArtIcon.classList.remove('hidden');
  } else {
    miniPlayerArt.src = realPlayerArt.src;
    miniPlayerArt.classList.remove('hidden');
    miniPlayerArtIcon.classList.add('hidden');
  }
}
function syncMiniPlayerText() {
  miniPlayerTitle.textContent = realTrackName.textContent;
  // innerHTML (not textContent) preserves the .pb-link artist/album spans
  // real #trackPath may contain (see playback.js) — cloned nodes don't
  // carry their original listeners, so each .pb-link here gets its own,
  // proxying a click to the corresponding real link by position (artist
  // is always first if present, then album — see playback.js) rather than
  // by text, which could collide if an artist and album share a name.
  miniPlayerSubtitle.innerHTML = realTrackPath.innerHTML;
  const realLinks = realTrackPath.querySelectorAll('.pb-link');
  miniPlayerSubtitle.querySelectorAll('.pb-link').forEach((link, i) => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      if (realLinks[i]) realLinks[i].click();
      setMobileTab('files');
    });
  });
}
new MutationObserver(syncMiniPlayerArt).observe(realPlayerArt, { attributes: true, attributeFilter: ['class', 'src'] });
new MutationObserver(syncMiniPlayerText).observe(realTrackName, { childList: true, characterData: true, subtree: true });
new MutationObserver(syncMiniPlayerText).observe(realTrackPath, { childList: true, characterData: true, subtree: true });
syncMiniPlayerArt();
syncMiniPlayerText();

// Closing the player (✕) should always drop back to the collapsed bar and,
// if the sidebar overlay happened to be open, back to the file list makes
// more sense than staring at an empty queue/playlist pane.
document.getElementById('closePlayerBtn').addEventListener('click', () => {
  togglePlayerExpanded(false);
});

// ---------- Mobile Settings: login/logout proxy ----------
// The topbar's real #authBtn is hidden on mobile (see responsive.css) and
// this button in the Settings modal stands in for it. It mirrors #authBtn's
// label/icon/state and forwards clicks to it, so all the actual login/logout
// behavior (in settings-auth-toast-lyrics.js) stays in one place.
const realAuthBtn = document.getElementById('authBtn');
const settingsAuthBtn = document.getElementById('settingsAuthBtn');
function syncSettingsAuthBtn() {
  settingsAuthBtn.innerHTML = realAuthBtn.innerHTML;
  settingsAuthBtn.title = realAuthBtn.title;
  settingsAuthBtn.classList.toggle('logged-in', realAuthBtn.classList.contains('logged-in'));
}
settingsAuthBtn.addEventListener('click', () => {
  // Logging out has no modal of its own, so it can happen right in place.
  // Logging in opens a separate modal — close Settings first so the two
  // overlays don't stack visually.
  if (!realAuthBtn.classList.contains('logged-in')) closeSettings();
  realAuthBtn.click();
});
const authBtnObserver = new MutationObserver(syncSettingsAuthBtn);
authBtnObserver.observe(realAuthBtn, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
syncSettingsAuthBtn();

// ---------- Mobile: shorter search placeholder ----------
// The full "Search folders and files..." placeholder doesn't fit next to
// the new lens icon on a narrow bar; swap in a short one on mobile only.
// Desktop's placeholder (set in index.html) is left completely alone.
const MOBILE_BREAKPOINT = window.matchMedia('(max-width: 780px)');
function applyMobileSearchPlaceholder() {
  searchInput.placeholder = MOBILE_BREAKPOINT.matches ? '' : 'Search folders and files...';
}
MOBILE_BREAKPOINT.addEventListener('change', applyMobileSearchPlaceholder);
applyMobileSearchPlaceholder();

// ---------- Mobile full player: mirrors the real (desktop) player ----------
// Same approach as the mini player: #fullPlayer is a fully independent set
// of elements with real per-row divs (fp-row-art/title/seek/timers/icons/
// volume). Buttons forward clicks to the real desktop elements; text, art,
// active-state highlighting, and slider positions are mirrored one-way via
// MutationObserver/event listeners, so there's exactly one source of truth
// (the real elements) and no logic duplicated.

// ---- Art + title/artist ----
const fpArt = document.getElementById('fpArt');
const fpArtIcon = document.getElementById('fpArtIcon');
const fpTitle = document.getElementById('fpTitle');
const fpSubtitle = document.getElementById('fpSubtitle');
function syncFpArt() {
  if (realPlayerArt.classList.contains('hidden')) {
    fpArt.classList.add('hidden');
    fpArtIcon.classList.remove('hidden');
  } else {
    fpArt.src = realPlayerArt.src;
    fpArt.classList.remove('hidden');
    fpArtIcon.classList.add('hidden');
  }
}
function syncFpTitle() {
  fpTitle.textContent = realTrackName.textContent;
  // Same reasoning as syncMiniPlayerText above: preserve + rewire the
  // .pb-link artist/album spans instead of flattening to plain text.
  fpSubtitle.innerHTML = realTrackPath.innerHTML;
  const realLinks = realTrackPath.querySelectorAll('.pb-link');
  fpSubtitle.querySelectorAll('.pb-link').forEach((link, i) => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      if (realLinks[i]) realLinks[i].click();
      setMobileTab('files');
      togglePlayerExpanded(false);
    });
  });
}
new MutationObserver(syncFpArt).observe(realPlayerArt, { attributes: true, attributeFilter: ['class', 'src'] });
new MutationObserver(syncFpTitle).observe(realTrackName, { childList: true, characterData: true, subtree: true });
new MutationObserver(syncFpTitle).observe(realTrackPath, { childList: true, characterData: true, subtree: true });
syncFpArt();
syncFpTitle();

// ---- Seek bar + split timers ----
// Desktop shows one combined "0:00 / -1:23" string in #timeDisplay (see
// updateSeekDisplay in playback.js, left untouched). Mobile shows the same
// two numbers as separate elements, plus its own seek bar that forwards
// input/change to the real one so dragging it actually seeks playback.
const fpSeekBar = document.getElementById('fpSeekBar');
const fpTimeElapsed = document.getElementById('fpTimeElapsed');
const fpTimeRemaining = document.getElementById('fpTimeRemaining');
function updateFpTimeDisplay() {
  if (!audioEl.duration || !isFinite(audioEl.duration)) return;
  fpTimeElapsed.textContent = formatTime(audioEl.currentTime);
  fpTimeRemaining.textContent = '-' + formatTime(audioEl.duration - audioEl.currentTime);
  if (document.activeElement !== fpSeekBar) fpSeekBar.value = seekBarEl.value;
  // The colored progress line is drawn via a background-gradient keyed off
  // these two custom properties (see player.css), set as inline styles on
  // the real #seekBar by playback.js — mirrored here since #fpSeekBar is a
  // different element and wouldn't otherwise pick them up.
  fpSeekBar.style.setProperty('--played-pct', seekBarEl.style.getPropertyValue('--played-pct') || '0%');
  fpSeekBar.style.setProperty('--buffered-pct', seekBarEl.style.getPropertyValue('--buffered-pct') || '0%');
}
audioEl.addEventListener('timeupdate', updateFpTimeDisplay);
audioEl.addEventListener('loadedmetadata', updateFpTimeDisplay);
fpSeekBar.addEventListener('input', () => {
  seekBarEl.value = fpSeekBar.value;
  seekBarEl.dispatchEvent(new Event('input', { bubbles: true }));
  fpSeekBar.style.setProperty('--played-pct', fpSeekBar.value + '%');
  updateFpTimeDisplay();
});
fpSeekBar.addEventListener('change', () => {
  seekBarEl.dispatchEvent(new Event('change', { bubbles: true }));
});

// ---- Transport row: prev/shuffle/play/next/loop mirror + forward ----
function mirrorButton(fpBtn, realBtn, { mirrorContent = false, mirrorActiveState = false } = {}) {
  fpBtn.addEventListener('click', () => realBtn.click());
  if (mirrorContent || mirrorActiveState) {
    const sync = () => {
      if (mirrorContent) fpBtn.innerHTML = realBtn.innerHTML;
      if (mirrorActiveState) fpBtn.classList.toggle('active-state', realBtn.classList.contains('active-state'));
    };
    new MutationObserver(sync).observe(realBtn, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
    sync();
  }
}
mirrorButton(document.getElementById('fpPrevBtn'), realPrevBtn);
mirrorButton(document.getElementById('fpNextBtn'), realNextBtn);
const fpPlayPauseBtn = document.getElementById('fpPlayPauseBtn');
fpPlayPauseBtn.addEventListener('click', () => realPlayPauseBtn.click());
new MutationObserver(() => syncPlayPauseIcon(fpPlayPauseBtn))
  .observe(realPlayPauseBtn, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
syncPlayPauseIcon(fpPlayPauseBtn);
mirrorButton(document.getElementById('fpShuffleBtn'), document.getElementById('shuffleBtn'), { mirrorActiveState: true });

// Loop button: mirrors the real button's icon and active-state, but not
// its label verbatim — desktop shows "Off"/"All"/"One" next to the icon,
// mobile shows nothing for Off/All (icon color via active-state already
// communicates on/off) and just "1" for One, since there's no room for a
// full word at this size.
const fpLoopBtn = document.getElementById('fpLoopBtn');
const realLoopBtn = document.getElementById('loopBtn');
function syncFpLoopBtn() {
  fpLoopBtn.innerHTML = realLoopBtn.innerHTML;
  fpLoopBtn.classList.toggle('active-state', realLoopBtn.classList.contains('active-state'));
}
fpLoopBtn.addEventListener('click', () => realLoopBtn.click());
new MutationObserver(syncFpLoopBtn).observe(realLoopBtn, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
syncFpLoopBtn();

// "Open folder" navigates the file list to the track's containing folder
// (see the real handler in controls.js) — collapse back to the mini
// player and switch to Files afterward so that result is actually
// visible, same as the artist/album links above, instead of leaving the
// user looking at the still-expanded full player over the change.
const realFolderBtn = document.getElementById('openFolderBtn');
document.getElementById('fpFolderBtn').addEventListener('click', () => {
  realFolderBtn.click();
  setMobileTab('files');
  togglePlayerExpanded(false);
});
mirrorButton(document.getElementById('fpDeleteBtn'), document.getElementById('deleteTrackBtn'));

// Speed button: forwarding a click would open the real (invisible) speed
// menu positioned against the real, off-screen .speed-wrap, so instead
// this cycles through the same global `speeds` array and `speedIndex`
// controls.js already maintains, calling its updateSpeedBtn() to keep the
// real button's label/menu state in sync too.
const fpSpeedBtn = document.getElementById('fpSpeedBtn');
const realSpeedBtn = document.getElementById('speedBtn');
fpSpeedBtn.addEventListener('click', () => {
  speedIndex = (speedIndex + 1) % speeds.length;
  audioEl.playbackRate = speeds[speedIndex];
  updateSpeedBtn();
});
new MutationObserver(() => { fpSpeedBtn.textContent = realSpeedBtn.textContent; })
  .observe(realSpeedBtn, { childList: true, characterData: true, subtree: true });
fpSpeedBtn.textContent = realSpeedBtn.textContent;

// ---- Volume row ----
const fpVolumeBar = document.getElementById('fpVolumeBar');
const realVolumeBar = document.getElementById('volumeBar');
function syncFpVolumeBar() {
  fpVolumeBar.value = realVolumeBar.value;
  fpVolumeBar.style.setProperty('--volume-pct', realVolumeBar.style.getPropertyValue('--volume-pct') || (realVolumeBar.value + '%'));
}
syncFpVolumeBar();
fpVolumeBar.addEventListener('input', () => {
  realVolumeBar.value = fpVolumeBar.value;
  realVolumeBar.dispatchEvent(new Event('input', { bubbles: true }));
  fpVolumeBar.style.setProperty('--volume-pct', fpVolumeBar.value + '%');
});
new MutationObserver(syncFpVolumeBar)
  .observe(realVolumeBar, { attributes: true, attributeFilter: ['value', 'style'] });

// ---- Inline lyrics view (replaces the art) ----
// Reuses the exact same lyrics data the desktop panel already fetches and
// keeps current (currentLyrics, lyricsAutoScroll, and the lrclib fetch in
// settings-auth-toast-lyrics.js) rather than re-implementing any of that.
// Since those functions already have a listener bound to the original
// #lyricsLines/#lyricsEmpty DOM before this script runs, the simplest safe
// way to mirror them is to observe that DOM for changes (content) and add
// a second timeupdate listener (active-line highlight + auto-scroll) side
// by side with theirs, rather than intercepting the functions themselves.
const mobileLyricsEmpty = document.getElementById('mobileLyricsEmpty');
const mobileLyricsLines = document.getElementById('mobileLyricsLines');
const fpLyricsBtn = document.getElementById('fpLyricsBtn');
const desktopLyricsLinesEl = document.getElementById('lyricsLines');
const desktopLyricsEmptyEl = document.getElementById('lyricsEmpty');

function mirrorLyricsContent() {
  mobileLyricsLines.innerHTML = '';
  const hasLyrics = desktopLyricsLinesEl.children.length > 0;
  mobileLyricsEmpty.classList.toggle('hidden', hasLyrics);
  Array.from(desktopLyricsLinesEl.children).forEach(src => {
    const div = document.createElement('div');
    div.className = src.className; // carries "lyrics-line" / "unsynced"
    div.textContent = src.textContent;
    mobileLyricsLines.appendChild(div);
  });
}
new MutationObserver(mirrorLyricsContent).observe(desktopLyricsLinesEl, { childList: true, characterData: true, subtree: true });
new MutationObserver(mirrorLyricsContent).observe(desktopLyricsEmptyEl, { attributes: true, attributeFilter: ['class'] });
mirrorLyricsContent();

// Mobile is always auto-scroll (no manual/auto switch exposed), so this
// mirrors the same "active line" highlight desktop's updateLyricsSync
// computes, using the same currentLyrics global it maintains.
audioEl.addEventListener('timeupdate', () => {
  if (!currentLyrics || !currentLyrics.lines.length || !mobileLyricsLines.children.length) return;
  const t = audioEl.currentTime;
  if (!currentLyrics.synced) return; // unsynced lyrics have no per-line active state to mirror
  const syncLines = currentLyrics.interpolatedLines || currentLyrics.lines;
  let activeIdx = -1;
  for (let i = 0; i < syncLines.length; i++) {
    if (syncLines[i].time !== null && syncLines[i].time <= t) activeIdx = i;
  }
  const children = mobileLyricsLines.children;
  for (let i = 0; i < children.length; i++) {
    children[i].classList.toggle('active', i === activeIdx);
  }
  if (activeIdx >= 0 && children[activeIdx]) {
    children[activeIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

fpLyricsBtn.addEventListener('click', () => {
  const showing = document.getElementById('fpArtRow').classList.toggle('showing-lyrics');
  fpLyricsBtn.classList.toggle('active-state', showing);
  fpLyricsBtn.title = showing ? 'Hide lyrics' : 'Show lyrics';
});

// ---- Options button opens the same context menu ----
// Reuses showContextMenu(x, y, item) from queue-playlists.js — the same
// menu used for file rows and queue items (rename/move/delete/add to
// playlist/edit metadata) — built from the currently playing track.
document.getElementById('fpOptionsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  const track = queue[queueIndex];
  // queue entries are plain {path, name} (see playback.js); the context
  // menu keys its options off isAudio/isDir, so mark this one explicitly
  // rather than changing what gets pushed into the queue elsewhere.
  const item = { path: track.path, name: track.name, isAudio: true, isDir: false };
  const rect = e.currentTarget.getBoundingClientRect();
  showContextMenu(rect.right, rect.top, item);
});

// ---------------------------------------------------------------------------
// Media Session API: lock-screen / notification-shade "now playing" card and
// hardware media key support. Not mobile-specific by nature (desktop OSes
// use it too, for media keys and OS-level now-playing widgets), so this
// isn't gated behind the mobile media query — desktop just gets a harmless
// bonus. Metadata is read off the same real elements everything else in
// this file already mirrors from (#trackName/#trackPath/#playerArt), and
// every action proxies to the real button rather than reimplementing
// playback logic, consistent with the rest of this file.
if ('mediaSession' in navigator) {
  function updateMediaSessionMetadata() {
    if (playerBarEl.classList.contains('hidden')) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const title = realTrackName.textContent || 'Unknown title';
    // #trackPath may contain plain text or "Artist • Album" as .pb-link
    // spans (see playback.js) — either way, its combined text content is
    // a reasonable single subtitle line for the few platforms that don't
    // split artist/album separately in their now-playing UI.
    const subtitleParts = [...realTrackPath.querySelectorAll('.pb-link')].map(el => el.textContent);
    const artist = subtitleParts[0] || '';
    const album = subtitleParts[1] || '';
    const artwork = (!realPlayerArt.classList.contains('hidden') && realPlayerArt.src)
      ? [{ src: realPlayerArt.src, sizes: '512x512', type: 'image/png' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
  }
  new MutationObserver(updateMediaSessionMetadata).observe(realTrackName, { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateMediaSessionMetadata).observe(realTrackPath, { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateMediaSessionMetadata).observe(realPlayerArt, { attributes: true, attributeFilter: ['class', 'src'] });
  new MutationObserver(updateMediaSessionMetadata).observe(playerBarEl, { attributes: true, attributeFilter: ['class'] });
  updateMediaSessionMetadata();

  navigator.mediaSession.setActionHandler('play', () => { if (audioEl.paused) realPlayPauseBtn.click(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (!audioEl.paused) realPlayPauseBtn.click(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => realPrevBtn.click());
  navigator.mediaSession.setActionHandler('nexttrack', () => realNextBtn.click());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime == null || !audioEl.duration) return;
    audioEl.currentTime = details.seekTime;
  });
  try {
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      audioEl.currentTime = Math.max(0, audioEl.currentTime - (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      if (!audioEl.duration) return;
      audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + (details.seekOffset || 10));
    });
  } catch (e) {
    // seekbackward/seekforward aren't supported everywhere — metadata and
    // play/pause/next/prev above still work fine without them.
  }

  function updateMediaSessionPlaybackState() {
    navigator.mediaSession.playbackState = audioEl.paused ? 'paused' : 'playing';
  }
  audioEl.addEventListener('play', updateMediaSessionPlaybackState);
  audioEl.addEventListener('pause', updateMediaSessionPlaybackState);

  // Position state drives the lock-screen scrubber and elapsed/remaining
  // time — keeping it roughly in sync (not on every single timeupdate tick)
  // is enough for a smooth-looking lock-screen progress bar.
  function updateMediaSessionPosition() {
    if (!audioEl.duration || !isFinite(audioEl.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audioEl.duration,
        playbackRate: audioEl.playbackRate || 1,
        position: audioEl.currentTime,
      });
    } catch (e) {
      // setPositionState can throw if called with stale/inconsistent
      // values during a track change race — safe to ignore, the next
      // timeupdate tick corrects it.
    }
  }
  audioEl.addEventListener('loadedmetadata', updateMediaSessionPosition);
  audioEl.addEventListener('timeupdate', updateMediaSessionPosition);
  audioEl.addEventListener('ratechange', updateMediaSessionPosition);
}

// ---------------------------------------------------------------------------
// Mobile select mode: a Select button in the topbar toggles between normal
// browsing (each row shows a 3-dot menu button) and select mode (that
// button is replaced by OK + Edit; rows are selected by tapping them,
// which highlights them with the same accent-color .selected style
// desktop's ctrl/shift-click already produces). Reuses the exact same
// selectedItems Map and showMultiContextMenu desktop's ctrl/shift-click +
// right-click already use — this is a new way to populate/act on that
// same state, not a parallel selection system.
window.mobileSelectModeActive = false;
const mobileSelectBtn = document.getElementById('mobileSelectBtn');
const mobileSelectModeGroup = document.getElementById('mobileSelectModeGroup');
const mobileSelectOkBtn = document.getElementById('mobileSelectOkBtn');
const mobileSelectEditBtn = document.getElementById('mobileSelectEditBtn');

// Keeps the Edit button's enabled state in sync with selectedItems —
// called after every row tap while in select mode (see filelist.js).
window.updateMobileSelectModeUI = function updateMobileSelectModeUI() {
  mobileSelectEditBtn.disabled = selectedItems.size === 0;
};

function enterMobileSelectMode() {
  window.mobileSelectModeActive = true;
  appEl.classList.add('mobile-select-mode');
  mobileSelectBtn.classList.add('hidden');
  mobileSelectModeGroup.classList.remove('hidden');
  // Defensive: selection should already be empty here (Select is only
  // ever visible when select mode is off, which per the app's design also
  // guarantees nothing is selected) — clearing again costs nothing and
  // removes any doubt about stale state from, e.g., a prior desktop-style
  // selection somehow surviving. refreshSelectionVisuals() only, not
  // clearSelection(), since the latter would immediately re-trigger the
  // exit hook we're in the middle of overriding.
  selectedItems.clear();
  lastClickedPath = null;
  refreshSelectionVisuals();
  updateMobileSelectModeUI();
}
// Exposed as window.exitMobileSelectMode so selection.js's clearSelection()
// can call it without a load-order dependency on this file (clearSelection
// runs from many places, including before this script has necessarily
// finished registering everything below it).
window.exitMobileSelectMode = function exitMobileSelectMode() {
  if (!window.mobileSelectModeActive) return;
  window.mobileSelectModeActive = false;
  appEl.classList.remove('mobile-select-mode');
  mobileSelectBtn.classList.remove('hidden');
  mobileSelectModeGroup.classList.add('hidden');
};

mobileSelectBtn.addEventListener('click', enterMobileSelectMode);
// OK both ends select mode AND unselects all (clearing the .selected
// highlight on every row) — clearSelection() does the unselecting and
// (via the hook it calls into above) exiting select mode both in one call.
mobileSelectOkBtn.addEventListener('click', () => clearSelection());

mobileSelectEditBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedItems.size === 0) return;
  const items = Array.from(selectedItems.values());
  const rect = e.currentTarget.getBoundingClientRect();
  if (items.length === 1) {
    showContextMenu(rect.left, rect.bottom, items[0]);
  } else {
    showMultiContextMenu(rect.left, rect.bottom, items);
  }
});