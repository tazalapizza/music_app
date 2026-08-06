// ---------------------------------------------------------------------------
// layout-init.js — Resizable column/sidebar/lyrics-panel layout persistence,
// and app initialization (reading the URL hash, loading playlists, rendering
// the initial queue). Must load LAST.
// Depends on: everything above.
// ---------------------------------------------------------------------------

// ---------- iOS PWA cold-start viewport/safe-area recheck ----------
// On iOS standalone launch, env(safe-area-inset-*) values (used for
// --safe-top/--safe-bottom in base.css) can be stale or briefly wrong until
// a geometry change forces WebKit to recompute them — the same class of bug
// that affects 100dvh (see base.css/topbar.css, which intentionally use
// 100vh instead for exactly this reason). Left unaddressed, this is what
// produced a visible gap between the bottom nav and the actual screen edge
// only in PWA/standalone mode. This block is the belt-and-suspenders fix:
// nudge the viewport-fit meta tag off and back on (forces a recalculation
// without needing the user to rotate the device), then re-check on a couple
// of short delays and on any later resize/orientation change.
if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
  const forceSafeAreaRecalc = () => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.getAttribute('content');
    if (!original || !original.includes('viewport-fit=cover')) return;
    meta.setAttribute('content', original.replace('viewport-fit=cover', 'viewport-fit=auto'));
    requestAnimationFrame(() => {
      meta.setAttribute('content', original);
    });
  };
  forceSafeAreaRecalc();
  // Staggered rechecks: no single moment is reliably "the right one" right
  // after cold start, so this covers a spread rather than picking one delay.
  setTimeout(forceSafeAreaRecalc, 100);
  setTimeout(forceSafeAreaRecalc, 500);
  setTimeout(forceSafeAreaRecalc, 1000);
  window.addEventListener('orientationchange', () => setTimeout(forceSafeAreaRecalc, 300));
}

// ---------- Generic overflow marquee (site-wide) ----------
// Reusable equivalent of the player bar's hand-built startMarquee()
// (playback.js) — that one exists for its own two elements (title, and the
// single-line file-path fallback when there's no artist/album); this one
// covers every other truncated text spot in the app, including the
// player's artist/album lines, which each get their own independent entry
// here so they scroll separately rather than as one glued block.
//
// Targets are given as [selector, wrapWhole] pairs:
//   wrapWhole: true  → the selector's own text becomes the scrolling span
//                       (wrapped in one automatically if it's plain text).
//   wrapWhole: false → the selector already contains exactly the element
//                       meant to scroll (e.g. .cell-text inside
//                       .file-title) — that child is used directly rather
//                       than double-wrapping.
const MARQUEE_TARGETS = [
  ['.lib-name', true],
  ['.album-card-name', true],
  ['.file-name', true],
  ['.file-title .cell-text, .file-artist .cell-text, .file-album .cell-text', false],
  ['.meta-field-dropdown-item', true],
  ['.upload-item-name', true],
  ['.queue-item .row-title, .playlist-item .row-title, .queue-item .row-subtitle, .playlist-item .row-subtitle', true],
  ['.playlist-name', true],
  ['.mini-player-title', true],
  ['.fp-title', true],
  ['.fp-upcoming-title', true],
  // Artist/album line pairs, each line its own independent target - see
  // .pb-link-line in player.css for why they must not share one target.
  ['.mini-player-subtitle .pb-link-line, .fp-subtitle .pb-link-line, .fp-upcoming-subtitle .pb-link-line, #trackPath .pb-link-line', true],
];

function ensureMarqueeSpan(el, wrapWhole) {
  if (wrapWhole) {
    if (!el.classList.contains('marquee-generic')) {
      el.classList.add('marquee-generic');
    }
    // Plain-text element (or one with simple inline content like the
    // queue-item's icon-free text span) — wrap its current contents in a
    // single span the CSS can translate. Guards against re-wrapping an
    // already-wrapped element (idempotent across re-renders that reuse
    // the same DOM node) by checking for a single existing span child.
    if (el.children.length === 1 && el.children[0].tagName === 'SPAN' && !el.children[0].children.length) {
      return { container: el, span: el.children[0] };
    }
    const span = document.createElement('span');
    span.append(...el.childNodes);
    el.appendChild(span);
    return { container: el, span };
  }
  // wrapWhole === false: the selector points directly at an element that
  // is itself already the "span" (e.g. .cell-text, which already sits
  // inside its own clipping parent like .file-title — see filelist.css).
  // Marking the *parent* as the marquee container and animating .cell-text
  // itself, rather than double-wrapping — .cell-text has its own
  // overflow:hidden for the static-ellipsis state, and the parent is
  // what's actually fixed-width, so it's the correct clipping box for the
  // scrolling state too.
  const container = el.parentElement;
  if (!container) return null;
  container.classList.add('marquee-generic-inline');
  return { container, span: el };
}

// container → { span, distance } for every element currently measured as
// overflowing, regardless of whether it's actively scrolling right now —
// the shared clock below decides who actually participates each cycle
// (hover-filtered on desktop, everyone on mobile).
const overflowingMarquees = new Map();

function measureMarquee(container, span) {
  const overflow = span.scrollWidth - container.clientWidth;
  if (overflow > 4) {
    // Small gap so the text fully clears the box before looping back.
    overflowingMarquees.set(container, { span, distance: overflow + 24 });
    // No CSS rule reads this - it's a devtools-inspection marker only, for
    // checking whether a given element was actually measured as
    // overflowing (vs. currently animating, which is .marquee-active).
    container.classList.add('marquee-overflowing');
  } else {
    overflowingMarquees.delete(container);
    container.classList.remove('marquee-overflowing');
    container.style.transform = '';
    if (span) span.style.transform = '';
  }
}

function scanMarquees(root = document) {
  MARQUEE_TARGETS.forEach(([selector, wrapWhole]) => {
    root.querySelectorAll(selector).forEach(el => {
      const result = ensureMarqueeSpan(el, wrapWhole);
      if (!result) return;
      measureMarquee(result.container, result.span);
    });
  });
}

// ---------- Shared marquee clock ----------
// Every visible, currently-active marquee must start scrolling at the same
// moment, hold at the end together, and only loop back to the start once
// every one of them has finished — not each on its own independent timer.
// A per-element CSS animation can't express "wait for the slowest one" (see
// the comment in base.css), so this drives every element's transform
// directly from one requestAnimationFrame loop instead.
const MARQUEE_SPEED_PX_S = 40;   // matches the player bar's own MARQUEE_SPEED, for a consistent feel
const MARQUEE_START_HOLD = 800;  // ms every element sits at its start position before the group moves
const MARQUEE_END_HOLD = 800;    // ms every element sits at its finished position once the slowest one arrives

// #trackPath .pb-link-line (desktop artist/album lines) scrolls
// continuously even on a hover-capable device, matching the player bar's
// title (startMarquee() in playback.js, which has no hover gating) instead
// of the hover-to-read default used for every other target below.
const ALWAYS_SCROLL_SELECTOR = '#trackPath .pb-link-line';

function activeMarqueeEntries() {
  // On desktop (hover-capable), only elements currently under the pointer
  // scroll — matches the "static ellipsis at rest, hover to read" intent.
  // On touch, there's no hover concept, so everything overflowing and
  // actually rendered participates automatically. ALWAYS_SCROLL_SELECTOR
  // is exempt from the hover requirement either way.
  const isHoverCapable = window.matchMedia('(hover: hover)').matches;
  const entries = [];
  overflowingMarquees.forEach(({ span, distance }, container) => {
    if (container.getClientRects().length === 0) return; // detached or display:none somewhere up the tree
    if (isHoverCapable && !container.matches(':hover') && !container.matches(ALWAYS_SCROLL_SELECTOR)) return;
    entries.push({ container, span, distance });
  });
  return entries;
}

// Roots that run their own independent clock instead of the shared
// page-wide one - e.g. the full player shouldn't sit waiting on some
// unrelated file name elsewhere on the page just because both happened to
// be active at once; #fullPlayer is a self-contained overlay. Add more
// roots here for other isolated panels that need the same treatment.
const ISOLATED_MARQUEE_ROOTS = [
  document.getElementById('fullPlayer'),
].filter(Boolean);

// Map<Element|null, entry[]> - key is the matched isolated root, or null
// for the shared group. Each key gets its own independent cycle timing.
function partitionEntriesByRoot(entries) {
  const groups = new Map([[null, []], ...ISOLATED_MARQUEE_ROOTS.map(r => [r, []])]);
  for (const entry of entries) {
    const root = ISOLATED_MARQUEE_ROOTS.find(r => r.contains(entry.container)) || null;
    groups.get(root).push(entry);
  }
  return groups;
}

// Toggles `className` on whatever's currently active, diffed against last
// frame's set - only touches elements whose membership actually changed,
// not every element every frame. onLeave lets a caller do extra cleanup
// (e.g. resetting a transform) for elements that just became inactive.
function diffActiveSet(previous, current, className, onLeave) {
  previous.forEach(el => {
    if (!current.has(el)) {
      el.classList.remove(className);
      if (onLeave) onLeave(el);
    }
  });
  current.forEach(el => { if (!previous.has(el)) el.classList.add(className); });
  return current;
}

let currentlyActiveSpans = new Set();
// Tracked separately from currentlyActiveSpans because the two live on
// different elements: wrapWhole:true targets need .marquee-active on the
// CONTAINER (its static text-overflow:ellipsis lives there - see
// .marquee-generic.marquee-active in base.css) as well as the span,
// while wrapWhole:false only ever needs it on the span (see
// .marquee-generic-inline > .marquee-active in the same file).
let currentlyActiveContainers = new Set();

// Per-group cycle-start timestamp, keyed the same way partitionEntriesByRoot
// groups entries - each group needs its own independent "when did this
// group's current cycle begin".
const marqueeGroupStarts = new Map();

function runMarqueeClock(ts) {
  const entries = activeMarqueeEntries();

  currentlyActiveSpans = diffActiveSet(
    currentlyActiveSpans, new Set(entries.map(e => e.span)), 'marquee-active',
    span => { span.style.transform = ''; }
  );
  currentlyActiveContainers = diffActiveSet(
    currentlyActiveContainers, new Set(entries.map(e => e.container)), 'marquee-active'
  );

  // Each group (see ISOLATED_MARQUEE_ROOTS/partitionEntriesByRoot above)
  // runs its own "wait for the slowest one" cycle: every element in a
  // group moves at the same speed, so the longest distance in that group
  // sets how long the moving phase lasts - shorter elements arrive early
  // and hold at their own finished position until the group's slowest one
  // catches up, then the whole group loops together. A group with nothing
  // active this frame just clears its own start timestamp.
  const groups = partitionEntriesByRoot(entries);
  groups.forEach((groupEntries, groupKey) => {
    if (groupEntries.length === 0) {
      marqueeGroupStarts.delete(groupKey);
      return;
    }
    if (!marqueeGroupStarts.has(groupKey)) marqueeGroupStarts.set(groupKey, ts);
    const maxDistance = Math.max(...groupEntries.map(e => e.distance));
    const scrollDuration = (maxDistance / MARQUEE_SPEED_PX_S) * 1000;
    const cycle = MARQUEE_START_HOLD + scrollDuration + MARQUEE_END_HOLD;
    const t = (ts - marqueeGroupStarts.get(groupKey)) % cycle;

    groupEntries.forEach(({ span, distance }) => {
      let x = 0;
      if (t >= MARQUEE_START_HOLD) {
        // Clamped to this element's own distance so a short element
        // simply arrives early and holds (rather than overshooting)
        // while the group's shared cycle waits on the slowest one.
        const elapsedMove = Math.min(t - MARQUEE_START_HOLD, scrollDuration);
        x = -Math.min(distance, (elapsedMove / 1000) * MARQUEE_SPEED_PX_S);
      }
      span.style.transform = `translateX(${x}px)`;
    });
  });

  marqueeClockRAF = requestAnimationFrame(runMarqueeClock);
}
let marqueeClockRAF = requestAnimationFrame(runMarqueeClock);

// Elements gain/lose ':hover' outside of any DOM mutation, so the clock
// can't rely solely on the MutationObserver below to know when to start/
// stop a group — mouseenter/mouseleave on the whole document (capture
// phase, since these don't bubble) just needs to keep the RAF loop aware
// that its active set may have changed, which it already re-derives every
// frame via activeMarqueeEntries() — no extra state to sync here beyond
// making sure hover changes are visible to the next frame, which they are
// automatically via :hover in CSS/matches(':hover').

// Re-scan on any DOM change anywhere (file list re-renders on navigation,
// queue/playlist re-render on reorder, uploads list grows, etc.) rather
// than hooking every individual render function across five different
// files — debounced since these can fire in rapid bursts (e.g. an entire
// file list re-rendering row by row).
let marqueeScanTimer = null;
new MutationObserver(() => {
  clearTimeout(marqueeScanTimer);
  marqueeScanTimer = setTimeout(() => scanMarquees(), 120);
}).observe(document.body, { childList: true, subtree: true, characterData: true });

// Column resizing, sidebar resizing, and window resizing all change
// available width without necessarily adding/removing any DOM nodes (so
// the MutationObserver above wouldn't catch them) — re-measure (not
// re-wrap) on those too.
let marqueeResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(marqueeResizeTimer);
  marqueeResizeTimer = setTimeout(() => scanMarquees(), 150);
});

scanMarquees();

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
  // Whatever's inside this tab's panel may have been built/updated while it
  // was hidden (display:none on an ancestor, e.g. via the mobile-tab-*
  // class swap above, or the desktop sidebar tab equivalent this reuses) -
  // a hidden element's scrollWidth/clientWidth both read as 0, so
  // measureMarquee() (see scanMarquees) computed "not overflowing" for
  // everything in it regardless of actual content length, and nothing else
  // re-measures it once it becomes visible: the debounced MutationObserver
  // rescan only fires on content changes, not visibility changes, and
  // there was no tab-switch-specific rescan at all. Re-scanning here, now
  // that the panel is actually visible and has real layout, is what
  // catches every marquee target inside it that measured wrong the first
  // time - .lib-name, .album-card-name, .playlist-name,
  // .upload-item-name, .meta-field-dropdown-item, and the queue/playlist
  // row names were all affected by this, not just one specific panel.
  scanMarquees();
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
// than leaving the person to notice and tap the mini strip — unless the
// caller opted out via window.suppressNextAutoExpand (see playWholePlaylist
// in queue-playlists.js: playing a playlist from the sidebar list should
// start playback and unfold the playlist in place, not jump away to the
// full player).
let wasPlayerHidden = playerBarEl.classList.contains('hidden');
const playerBarObserver = new MutationObserver(() => {
  const isHidden = playerBarEl.classList.contains('hidden');
  appEl.classList.toggle('has-player', !isHidden);
  if (wasPlayerHidden && !isHidden && window.matchMedia('(max-width: 780px)').matches) {
    if (window.suppressNextAutoExpand) {
      window.suppressNextAutoExpand = false;
    } else {
      togglePlayerExpanded(true);
    }
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
  // Expanding reveals the full player's title/subtitle/upcoming-track text
  // for the first time since (or ever since) the current track started —
  // if the track changed while collapsed, .fp-title/.fp-subtitle were
  // re-synced via textContent/innerHTML (see syncFpTitle) while hidden,
  // which wipes any marquee wrapper span and is invisible to the
  // childList/characterData MutationObserver that normally triggers a
  // rescan (that observer does see the change itself, but getClientRects()
  // was still empty at that moment since the full player was hidden, so
  // the resulting measurement found "no overflow" and never marked it
  // active). Re-scanning right on expand catches it now that it's
  // actually visible and measurable.
  if (willExpand) scanMarquees();
  // No redraw of the blur mosaic canvas here on purpose. drawBlurBackground
  // (playback.js) now sizes its canvas against ONE fixed ceiling shared by
  // every surface that reveals it (desktop player bar, desktop bar+lyrics,
  // mobile mini player, mobile full player) - expanding/collapsing changes
  // how much of that canvas is currently revealed (via .player-blur-clip's
  // overflow:hidden), never the canvas's own size or content. Redrawing
  // here would re-shuffle the mosaic's cell placement on every tap for no
  // visual need, which is exactly the "canvas regenerates when it's not
  // supposed to" bug the ceiling was designed to prevent in the first
  // place (see that function's comment) - it was only ever needed here
  // while the mobile ceiling was still wrongly tied to the currently-
  // expanded height instead of the shared one.
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
  // textContent/innerHTML above wipe any marquee wrapper <span>
  // scanMarquees() previously created around these two — re-wrap/re-
  // measure immediately against the new text rather than waiting on the
  // generic debounced observer (which may also be looking at an element
  // that's momentarily hidden, e.g. mid player-bar drag transition).
  scanMarquees(miniPlayerEl);
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

// ReplayGain is a no-op on mobile right now (see REPLAYGAIN_MOBILE_QUERY in
// state.js) — disable the checkbox itself (not just visually, via CSS) so
// it's also unreachable by keyboard/screen reader, matching responsive.css's
// dimmed styling and the hint text under it.
function applyReplayGainMobileDisabled() {
  const input = document.getElementById('replayGainInput');
  if (input) input.disabled = MOBILE_BREAKPOINT.matches;
}
MOBILE_BREAKPOINT.addEventListener('change', applyReplayGainMobileDisabled);
applyReplayGainMobileDisabled();

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
  // textContent/innerHTML above wipe any marquee wrapper <span>
  // scanMarquees() previously created around these two — re-wrap/re-
  // measure immediately (togglePlayerExpanded also triggers a scan on
  // open, but the track can change while already expanded too, which
  // this covers). .fp-row-title is fpTitle/fpSubtitle's shared parent.
  scanMarquees(document.querySelector('.fp-row-title') || document);
}
new MutationObserver(syncFpArt).observe(realPlayerArt, { attributes: true, attributeFilter: ['class', 'src'] });
new MutationObserver(syncFpTitle).observe(realTrackName, { childList: true, characterData: true, subtree: true });
new MutationObserver(syncFpTitle).observe(realTrackPath, { childList: true, characterData: true, subtree: true });
syncFpArt();
syncFpTitle();

// ---- Upcoming track row ----
// Not mirrored from another DOM element like everything else above — the
// current track's own row divs never held "what's next" info to mirror.
// Instead this reads queue/queueIndex directly (the same globals
// playback.js's playCurrent() uses) and reuses the existing getMeta()
// cache, so no metadata fetching logic is duplicated. Re-checked on every
// track change via the same trackName/trackPath observers that already
// fire for that (see syncFpTitle above) — those are a reliable proxy for
// "the current track just changed" regardless of what caused it (next/
// prev/queue click/track ending).
const fpUpcomingRow = document.getElementById('fpUpcomingRow');
const fpUpcomingArt = document.getElementById('fpUpcomingArt');
const fpUpcomingArtIcon = document.getElementById('fpUpcomingArtIcon');
const fpUpcomingTitle = document.getElementById('fpUpcomingTitle');
const fpUpcomingSubtitle = document.getElementById('fpUpcomingSubtitle');
const fpUpcomingDuration = document.getElementById('fpUpcomingDuration');
function syncFpUpcoming() {
  const nextTrack = (queueIndex >= 0 && queueIndex + 1 < queue.length) ? queue[queueIndex + 1] : null;
  if (!nextTrack) {
    fpUpcomingRow.classList.add('hidden');
    return;
  }
  fpUpcomingRow.classList.remove('hidden');
  // Show the filename immediately (matches how playCurrent() shows the
  // current track before its own getMeta() resolves), then upgrade to the
  // real title/artist/album/art/duration once metadata is available.
  fpUpcomingTitle.textContent = nextTrack.name;
  fpUpcomingSubtitle.textContent = '';
  fpUpcomingDuration.textContent = '';
  fpUpcomingArt.classList.add('hidden');
  fpUpcomingArtIcon.classList.remove('hidden');
  getMeta(nextTrack.path).then(meta => {
    // Guard against a race: the queue may have advanced again by the time
    // this resolves (e.g. rapid next-track taps), so only apply it if
    // this is still actually the upcoming track.
    const stillNext = queueIndex >= 0 && queueIndex + 1 < queue.length && queue[queueIndex + 1].path === nextTrack.path;
    if (!stillNext) return;
    fpUpcomingTitle.textContent = meta.title || nextTrack.name;
    // Artist and album on their own line each, same as the now-playing
    // subtitle (see applyMeta in playback.js) rather than one "Artist •
    // Album" line — plain text here since (unlike the now-playing
    // subtitle) this preview row was never a set of clickable .pb-link
    // spans to begin with.
    fpUpcomingSubtitle.innerHTML = '';
    if (meta.artist) {
      const line = document.createElement('div');
      line.className = 'pb-link-line';
      line.textContent = meta.artist;
      fpUpcomingSubtitle.appendChild(line);
    }
    if (meta.album) {
      const line = document.createElement('div');
      line.className = 'pb-link-line';
      line.textContent = meta.album;
      fpUpcomingSubtitle.appendChild(line);
    }
    fpUpcomingDuration.textContent = (typeof meta.duration === 'number') ? formatTime(meta.duration) : '';
    if (meta.hasArt) {
      fpUpcomingArt.src = `/api/art?path=${encodeURIComponent(nextTrack.path)}`;
      fpUpcomingArt.classList.remove('hidden');
      fpUpcomingArtIcon.classList.add('hidden');
    } else {
      fpUpcomingArt.classList.add('hidden');
      fpUpcomingArtIcon.classList.remove('hidden');
    }
    // Setting .textContent directly above wipes any marquee wrapper <span>
    // scanMarquees() previously created around fpUpcomingTitle/Subtitle —
    // the generic MutationObserver does see this and would eventually
    // re-wrap it, but only after its 120ms debounce, and only if the row
    // happens to already be visible at that exact moment. Calling it here
    // directly re-wraps/re-measures immediately against the real,
    // now-current text rather than depending on that timing.
    scanMarquees(fpUpcomingRow);
  });
}
new MutationObserver(syncFpUpcoming).observe(realTrackName, { childList: true, characterData: true, subtree: true });
// Also re-check on any change to which queue row is marked '.playing' —
// updateQueuePlayingIndicator() (queue-playlists.js) sets that class on
// every track change AND on queue reordering/removal, so this catches
// "the next track changed because the queue was reordered" too, not just
// "the current track changed" (which the trackName observer above covers).
new MutationObserver(syncFpUpcoming).observe(queuePanel, { attributes: true, attributeFilter: ['class'], subtree: true });
document.getElementById('fpUpcomingNextBtn').addEventListener('click', (e) => {
  e.stopPropagation(); // don't also trigger the row's own click below
  realNextBtn.click();
});
// Tapping the row itself (art/title/duration, anywhere but the next
// button above) opens the queue tab, same as tapping an artist/album
// pb-link elsewhere in the full player — collapse back to the mini player
// first so the queue is actually visible underneath.
document.querySelector('.fp-upcoming-track').addEventListener('click', () => {
  togglePlayerExpanded(false);
  setMobileTab('queue');
});
syncFpUpcoming();

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

// ---- Slide-to-seek on the full-player art ----
// Mobile-only by construction: #fpArtDragWrap only exists inside
// #fullPlayer, which responsive.css hides entirely outside the mobile
// breakpoint. Desktop's own seek shortcuts (arrow keys) are untouched.
// Dragging the art left reveals the forward circle and, on release, seeks
// +settings.seekForward; dragging right reveals the backward circle and
// seeks -settings.seekBack. The art itself always snaps back to center.
(() => {
  const dragWrap = document.getElementById('fpArtDragWrap');
  const backIndicator = document.getElementById('fpArtSeekBack');
  const backNum = document.getElementById('fpArtSeekBackNum');
  const forwardIndicator = document.getElementById('fpArtSeekForward');
  const forwardNum = document.getElementById('fpArtSeekForwardNum');

  const MAX_DRAG = 40; // px — how far the art can actually slide
  // Fraction of MAX_DRAG the drag must reach before release actually
  // triggers a seek — shared between setIndicators() (visual "will-trigger"
  // feedback) and applySeek() (the actual trigger) so they can't drift out
  // of sync with each other.
  const TRIGGER_THRESHOLD = 0.95;
  let dragging = false;
  let startX = 0;
  let offsetX = 0;
  let pointerId = null;

  function setIndicators(offset) {
    // offset < 0 → art moved left → forward (skip ahead) revealed on the right
    // offset > 0 → art moved right → backward (skip back) revealed on the left
    const revealFrac = Math.min(1, Math.abs(offset) / MAX_DRAG);
    const willTrigger = revealFrac >= TRIGGER_THRESHOLD;
    if (offset < 0) {
      forwardNum.textContent = settings.seekForward;
      forwardIndicator.classList.toggle('visible', revealFrac > 0.15);
      forwardIndicator.classList.toggle('will-trigger', willTrigger);
      backIndicator.classList.remove('visible');
      backIndicator.classList.remove('will-trigger');
    } else if (offset > 0) {
      backNum.textContent = settings.seekBack;
      backIndicator.classList.toggle('visible', revealFrac > 0.15);
      backIndicator.classList.toggle('will-trigger', willTrigger);
      forwardIndicator.classList.remove('visible');
      forwardIndicator.classList.remove('will-trigger');
    } else {
      forwardIndicator.classList.remove('visible');
      backIndicator.classList.remove('visible');
      forwardIndicator.classList.remove('will-trigger');
      backIndicator.classList.remove('will-trigger');
    }
  }

  function resetArt() {
    dragWrap.classList.remove('dragging');
    dragWrap.style.transform = 'translateX(0px)';
    backIndicator.classList.remove('visible', 'will-trigger');
    forwardIndicator.classList.remove('visible', 'will-trigger');
  }

  function applySeek(offset) {
    if (!audioEl.duration || !isFinite(audioEl.duration)) return;
    // Only triggers on a full slide (dragged all the way to MAX_DRAG), not
    // a partial/half slide — small threshold below 1 to comfortably
    // account for the pointer letting go a pixel or two shy of the exact
    // clamp, rather than requiring pixel-perfect precision from the user.
    const revealFrac = Math.abs(offset) / MAX_DRAG;
    if (revealFrac < TRIGGER_THRESHOLD) return;
    if (offset < 0) {
      audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + settings.seekForward);
    } else {
      audioEl.currentTime = Math.max(0, audioEl.currentTime - settings.seekBack);
    }
  }

  dragWrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    offsetX = 0;
    pointerId = e.pointerId;
    dragWrap.setPointerCapture(pointerId);
    dragWrap.classList.add('dragging');
  });

  dragWrap.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const rawDelta = e.clientX - startX;
    offsetX = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, rawDelta));
    dragWrap.style.transform = `translateX(${offsetX}px)`;
    setIndicators(offsetX);
  });

  function endDrag(e) {
    if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
    dragging = false;
    dragWrap.releasePointerCapture(pointerId);
    pointerId = null;
    applySeek(offsetX);
    resetArt();
    offsetX = 0;
  }

  dragWrap.addEventListener('pointerup', endDrag);
  dragWrap.addEventListener('pointercancel', endDrag);
  // Safety net: if the browser revokes pointer capture unexpectedly (e.g.
  // scroll takeover, OS gesture), still resolve the drag instead of leaving
  // the art stuck off-center with dragging=true forever.
  dragWrap.addEventListener('lostpointercapture', (e) => {
    if (dragging && e.pointerId === pointerId) endDrag(e);
  });
})();

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
    // Declaring a fixed 512x512/image-png artwork entry when /api/art
    // actually serves the embedded art as-is (real size, real format —
    // often JPEG, rarely square) was a lie some mobile browsers (notably
    // iOS Safari) silently punish by dropping the whole MediaMetadata
    // object, not just the artwork — which was why nothing showed up in
    // the OS now-playing UI even though playback itself worked fine.
    // sizes:'any' + a type sniffed from the actual <img> response's
    // content-type is honest about what's really being served.
    const artwork = (!realPlayerArt.classList.contains('hidden') && realPlayerArt.src)
      ? [{ src: realPlayerArt.src, sizes: 'any', type: realPlayerArtMime || undefined }]
      : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch (e) {
      // Malformed artwork (e.g. an unreachable/failed image src) can throw
      // rather than just being ignored on some browsers — retry once with
      // no artwork at all so title/artist/album still show.
      try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album }); } catch (e2) {}
    }
  }
  // Tracks the real MIME type of the currently-shown art (set from the
  // actual /api/art response headers below) instead of assuming image/png.
  let realPlayerArtMime = null;
  new MutationObserver(() => {
    if (realPlayerArt.classList.contains('hidden') || !realPlayerArt.src) {
      realPlayerArtMime = null;
      updateMediaSessionMetadata();
      return;
    }
    // Show the card immediately with title/artist/album (no artwork yet)
    // rather than waiting on the HEAD request, then re-apply once the
    // real MIME type is known so artwork isn't declared with a guessed,
    // possibly-wrong type.
    updateMediaSessionMetadata();
    const src = realPlayerArt.src;
    fetch(src, { method: 'HEAD' })
      .then(r => { if (realPlayerArt.src === src) realPlayerArtMime = r.headers.get('Content-Type') || null; })
      .catch(() => { realPlayerArtMime = null; })
      .finally(() => { if (realPlayerArt.src === src) updateMediaSessionMetadata(); });
  }).observe(realPlayerArt, { attributes: true, attributeFilter: ['class', 'src'] });
  new MutationObserver(updateMediaSessionMetadata).observe(realTrackName, { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateMediaSessionMetadata).observe(realTrackPath, { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateMediaSessionMetadata).observe(playerBarEl, { attributes: true, attributeFilter: ['class'] });
  updateMediaSessionMetadata();

  // Each action handler is registered independently so that one action
  // being unsupported/throwing on a given browser (some throw a TypeError
  // for actions they don't implement, rather than silently ignoring the
  // call) can't prevent the rest from registering — previously an early
  // throw here could silently skip previoustrack/nexttrack/seekto/position
  // state entirely depending on registration order.
  function trySetActionHandler(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {
      // Not supported on this browser — skip it, everything else still registers.
    }
  }
  // Wrapped in a function and re-invoked on every 'play' event (not just
  // once at page load) — this is specifically for iOS Safari, where the
  // OS-level MediaRemote bridge that surfaces transport buttons on the
  // lock screen has a long history of being selective (a well-documented
  // WebKit/iOS limitation, not something fixable purely with correct
  // registration code). This is cheap and idempotent, so re-running it
  // every play is harmless even on platforms where it isn't needed.
  //
  // previoustrack/nexttrack vs seekbackward/seekforward: iOS's lock screen
  // only shows one such button pair, and registering both apparently made
  // it choose the generic ±seconds skip over track navigation. Track
  // navigation is more useful for a music app, so seekbackward/seekforward
  // are intentionally left unregistered here — 'seekto' (the scrubber) is
  // a separate action and unaffected, so dragging the lock-screen progress
  // bar still works either way.
  function registerMediaSessionActionHandlers() {
    trySetActionHandler('play', () => { if (audioEl.paused) realPlayPauseBtn.click(); });
    trySetActionHandler('pause', () => { if (!audioEl.paused) realPlayPauseBtn.click(); });
    trySetActionHandler('previoustrack', () => realPrevBtn.click());
    trySetActionHandler('nexttrack', () => realNextBtn.click());
    trySetActionHandler('seekto', (details) => {
      if (details.seekTime == null || !audioEl.duration) return;
      // Some platforms fire 'seekto' continuously while the user is still
      // dragging the OS scrubber (details.seeking === true) rather than
      // only on release — setting currentTime on every intermediate event
      // is fine for a plain <audio> element (no extra buffering cost like
      // <video>), so no special-casing needed there.
      audioEl.currentTime = details.seekTime;
    });
  }
  registerMediaSessionActionHandlers();
  audioEl.addEventListener('play', registerMediaSessionActionHandlers);

  function updateMediaSessionPlaybackState() {
    navigator.mediaSession.playbackState = audioEl.paused ? 'paused' : 'playing';
  }
  audioEl.addEventListener('play', updateMediaSessionPlaybackState);
  audioEl.addEventListener('pause', updateMediaSessionPlaybackState);

  // Position state (duration/position/playbackRate) is what drives iOS's
  // lock-screen progress scrubber — but reporting it also makes iOS
  // synthesize its own auto ±skip buttons in place of previoustrack/
  // nexttrack, regardless of which action handlers are registered. Since
  // track navigation matters more here than a seconds-based skip, this is
  // intentionally left disabled. seekto (dragging the OS scrubber itself)
  // is a separate action and still registered above — only the position
  // *reporting* is off, not seeking.
  const ENABLE_MEDIA_SESSION_POSITION_STATE = false;
  function updateMediaSessionPosition() {
    if (!ENABLE_MEDIA_SESSION_POSITION_STATE) return;
    if (!audioEl.duration || !isFinite(audioEl.duration) || audioEl.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audioEl.duration,
        playbackRate: audioEl.playbackRate || 1,
        // position must be < duration or the OS throws and rejects the
        // whole call, which if it happened on every single timeupdate tick
        // near the end of a track (or on a rounding edge) would mean the OS
        // never received a single valid position/duration pair — and some
        // platforms only enable a draggable scrubber once they have.
        position: Math.min(audioEl.currentTime, audioEl.duration),
      });
    } catch (e) {
      // Stale/inconsistent values during a track-change race — safe to
      // ignore, the next timeupdate tick corrects it.
    }
  }
  audioEl.addEventListener('loadedmetadata', updateMediaSessionPosition);
  audioEl.addEventListener('timeupdate', updateMediaSessionPosition);
  audioEl.addEventListener('ratechange', updateMediaSessionPosition);
  audioEl.addEventListener('seeked', updateMediaSessionPosition);
}

// ---------------------------------------------------------------------------
// PWA background/foreground lifecycle
//
// Backgrounding a standalone PWA (home-screen icon, not a browser tab) can
// suspend timers and the ReplayGain AudioContext even while the underlying
// <audio> element itself is allowed to keep playing for background audio.
// Coming back from that state was causing three symptoms, all from the same
// root cause — nothing ever re-synced app state with the real <audio>
// element's state on return:
//   1. The play button doing nothing: if replayGainEnabled is on, the OS
//      suspends the AudioContext in the background; only a track change
//      (via applyReplayGain) ever resumed it, not pressing play. Now
//      safePlay() above handles the button-press case, and the resume
//      handler below covers the "already playing, just reveal the UI"
//      case.
//   2. Old + new audio overlapping with a delay: on some browsers,
//      returning to a backgrounded/frozen PWA fires 'pageshow' with
//      event.persisted === true (a bfcache restore) while the previous
//      in-memory <audio> element is still mid-playback. If any code
//      responded to that resume by re-triggering playback (a fresh
//      playCurrent()/play() call), it would start a second, independent
//      playback on top of the first. The handler below deliberately never
//      calls playCurrent() or changes audioEl.src on resume — it only
//      resumes the audio graph and re-reads the existing element's actual
//      state, so there is exactly one <audio> element and one playback
//      instance at all times.
//   3. Play/pause icon or Media Session state drifting from reality after
//      background suspension paused things behind the UI's back.
function resyncPlaybackOnForeground() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  // Source of truth is always the real <audio> element's own paused state
  // — never assume, never re-trigger playback here.
  setPlayPauseIcon(!audioEl.paused);
  if (typeof syncPlayPauseIcon === 'function') {
    const fpBtn = document.getElementById('fpPlayPauseBtn');
    const miniBtn = document.getElementById('miniPlayPauseBtn');
    if (fpBtn) syncPlayPauseIcon(fpBtn);
    if (miniBtn) syncPlayPauseIcon(miniBtn);
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = audioEl.paused ? 'paused' : 'playing';
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resyncPlaybackOnForeground();
});
// visibilitychange alone can be unreliable across bfcache restores on some
// mobile browsers — 'pageshow' with persisted:true specifically indicates a
// bfcache restore rather than a normal load, and needs the same resync
// rather than any fresh-load logic.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) resyncPlaybackOnForeground();
});

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