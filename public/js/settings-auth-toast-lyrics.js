// ---------------------------------------------------------------------------
// settings-auth-toast-lyrics.js — showModal() helper, the Settings panel,
// authentication (login/logout), toast notifications, and the lyrics panel
// (LRC parsing, sync, scroll modes).
// Depends on: state.js, playback.js.
// ---------------------------------------------------------------------------

// ---------- Settings panel ----------
const settingsOverlay = document.getElementById('settingsOverlay');
const seekBackInput = document.getElementById('seekBackInput');
const seekForwardInput = document.getElementById('seekForwardInput');
const skipDeleteConfirmInput = document.getElementById('skipDeleteConfirmInput');
const rememberVolumeInput = document.getElementById('rememberVolumeInput');
const hideNonMusicInput = document.getElementById('hideNonMusicInput');
const replayGainInput = document.getElementById('replayGainInput');
const maxItemsLoadInput = document.getElementById('maxItemsLoadInput');

function openSettings() {
  seekBackInput.value = settings.seekBack;
  seekForwardInput.value = settings.seekForward;
  skipDeleteConfirmInput.checked = settings.skipDeleteConfirm;
  rememberVolumeInput.checked = settings.rememberVolume;
  hideNonMusicInput.checked = settings.hideNonMusic;
  replayGainInput.checked = settings.replayGainEnabled;
  maxItemsLoadInput.value = settings.maxItemsLoad;
  settingsOverlay.classList.remove('hidden');
}
function closeSettings() {
  const back = parseInt(seekBackInput.value, 10);
  const fwd = parseInt(seekForwardInput.value, 10);
  settings.seekBack = isFinite(back) && back > 0 ? back : DEFAULT_SETTINGS.seekBack;
  settings.seekForward = isFinite(fwd) && fwd > 0 ? fwd : DEFAULT_SETTINGS.seekForward;
  settings.skipDeleteConfirm = skipDeleteConfirmInput.checked;
  settings.rememberVolume = rememberVolumeInput.checked;
  const hideNonMusicChanged = settings.hideNonMusic !== hideNonMusicInput.checked;
  settings.hideNonMusic = hideNonMusicInput.checked;
  settings.replayGainEnabled = replayGainInput.checked;
  const maxItemsLoadRaw = parseInt(maxItemsLoadInput.value, 10);
  const newMaxItemsLoad = isFinite(maxItemsLoadRaw) && maxItemsLoadRaw >= 0 ? maxItemsLoadRaw : DEFAULT_SETTINGS.maxItemsLoad;
  const maxItemsLoadChanged = settings.maxItemsLoad !== newMaxItemsLoad;
  settings.maxItemsLoad = newMaxItemsLoad;
  saveSettings();
  settingsOverlay.classList.add('hidden');
  if (hideNonMusicChanged) {
    if (isSearching) performSearch(searchInput.value.trim());
    else browse(currentPath, { keepSort: true });
  } else if (maxItemsLoadChanged) {
    // Re-render whatever's currently visible so the new chunk size (or
    // unlimited, for 0) takes effect immediately rather than only on the
    // next navigation.
    if (isSearching) performSearch(searchInput.value.trim());
    else if (libraryView) openLibrary(libraryView.type, libraryView.name, { skipHistory: true, keepSort: true });
    else renderFileList(lastFetchedItems);
    renderQueue();
    renderPlaylists();
  }
  const track = queue[queueIndex];
  if (track) getMeta(track.path).then(meta => applyReplayGain(meta.replayGainDb));
}

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

document.getElementById('resetLayoutBtn').addEventListener('click', () => {
  localStorage.removeItem('musicapp-layout');
  document.documentElement.style.removeProperty('--sidebar-w');
  document.documentElement.style.removeProperty('--lyrics-h');
  ['title', 'artist', 'album', 'duration', 'size'].forEach(col => {
    fileListWrap.style.removeProperty(`--col-${col}-w`);
  });
  showToast('Layout reset to default');
});

document.getElementById('rebuildLibraryBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const settingsCogIcon = document.getElementById('settingsCogIcon');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  settingsCogIcon.classList.add('spinning');
  try {
    await api('/api/library/rebuild', { method: 'POST' });
    showToast('Library metadata updated');
  } catch (err) {
    showToast(err.message || 'Failed to update library metadata');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update library metadata';
    settingsCogIcon.classList.remove('spinning');
  }
});

// ---------- Authentication ----------
const authBtn = document.getElementById('authBtn');
const loginOverlay = document.getElementById('loginOverlay');
const loginInput = document.getElementById('loginInput');
const loginError = document.getElementById('loginError');

const LOCK_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
const UNLOCK_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`;
function updateAuthBtn() {
  if (isAuthenticated) {
    authBtn.innerHTML = UNLOCK_ICON_SVG + 'Log out';
    authBtn.title = 'Log out (currently able to make changes)';
    authBtn.classList.add('logged-in');
  } else {
    authBtn.innerHTML = LOCK_ICON_SVG + 'Log in';
    authBtn.title = 'Log in to make changes';
    authBtn.classList.remove('logged-in');
  }
}

function openLoginModal(message) {
  loginInput.value = '';
  loginError.textContent = message && message !== 'Log in to make changes' ? message : '';
  loginError.classList.toggle('hidden', !loginError.textContent);
  loginOverlay.classList.remove('hidden');
  loginInput.focus();
}
function closeLoginModal() {
  loginOverlay.classList.add('hidden');
}

async function checkAuthStatus() {
  try {
    const status = await api('/api/auth-status');
    isAuthenticated = status.authenticated;
    authConfigured = status.authConfigured;
    updateAuthBtn();
  } catch {}
}

async function submitLogin() {
  const password = loginInput.value;
  if (!password) return;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      isAuthenticated = true;
      updateAuthBtn();
      closeLoginModal();
    } else {
      loginError.textContent = data.error || 'Login failed';
      loginError.classList.remove('hidden');
      loginInput.select();
    }
  } catch {
    loginError.textContent = 'Could not reach the server';
    loginError.classList.remove('hidden');
  }
}

authBtn.addEventListener('click', async () => {
  if (isAuthenticated) {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    isAuthenticated = false;
    updateAuthBtn();
  } else {
    openLoginModal();
  }
});
document.getElementById('loginOk').addEventListener('click', submitLogin);
document.getElementById('loginCancel').addEventListener('click', closeLoginModal);
loginInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitLogin();
  else if (e.key === 'Escape') closeLoginModal();
});
loginOverlay.addEventListener('click', (e) => {
  if (e.target === loginOverlay) closeLoginModal();
});

checkAuthStatus();

// ---------- Toast ----------
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// ---------- Lyrics ----------
let currentLyrics = null; // { synced, lines: [{time, text}] } or null
let lyricsAutoScroll = true;
let lyricsBoxOpen = false;
let lyricsTrackPath = null; // guards against a slow fetch resolving after the track changed again

const lyricsBoxWrap = document.querySelector('.lyrics-box-wrap');
const lyricsBoxEl = document.getElementById('lyricsBox');
const lyricsToggleBtn = document.getElementById('lyricsToggleBtn');
const lyricsContentEl = document.getElementById('lyricsContent');
const lyricsEmptyEl = document.getElementById('lyricsEmpty');
const lyricsLinesEl = document.getElementById('lyricsLines');
const lyricsScrollModeBtn = document.getElementById('lyricsScrollModeBtn');
const lyricsEditBtn = document.getElementById('lyricsEditBtn');
const lyricsFetchEmptyBtn = document.getElementById('lyricsFetchEmptyBtn');

// Parses LRC-style "[mm:ss.xx] text" lines. Lines without a timestamp are kept
// (time: null) so plain/unsynced lyrics still render, just without a highlight.
function parseLRC(raw) {
  if (!raw) return { synced: false, lines: [] };
  const re = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/;
  const lines = [];
  let anyTimed = false;
  for (const rawLine of raw.split('\n')) {
    const m = rawLine.match(re);
    if (m) {
      anyTimed = true;
      const min = parseInt(m[1], 10), sec = parseInt(m[2], 10);
      const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
      lines.push({ time: min * 60 + sec + frac, text: m[4] || '' });
    } else if (rawLine.trim()) {
      lines.push({ time: null, text: rawLine.trim() });
    }
  }
  return { synced: anyTimed, lines };
}

// Fills in missing timestamps (partial/manual sync) by linear interpolation
// between the nearest known timestamps on either side, using the song's
// start (0) and end (duration) as boundary anchors when a run of missing
// lines sits before the first or after the last known timestamp. This is
// purely for display/scroll purposes - it never touches the stored lyrics.
function interpolateLyricsTimes(lines, duration) {
  const known = [];
  lines.forEach((l, i) => { if (l.time !== null) known.push(i); });
  if (known.length === 0) return lines.map(l => ({ ...l }));

  const anchors = [
    { idx: -1, time: 0 },
    ...known.map(i => ({ idx: i, time: lines[i].time })),
    { idx: lines.length, time: duration != null ? duration : lines[known[known.length - 1]].time }
  ];

  const result = lines.map(l => ({ ...l }));
  for (let a = 0; a < anchors.length - 1; a++) {
    const start = anchors[a], end = anchors[a + 1];
    const steps = end.idx - start.idx;
    if (steps <= 1) continue; // no missing lines between these two anchors
    for (let i = start.idx + 1; i < end.idx; i++) {
      const frac = (i - start.idx) / steps;
      result[i].time = start.time + (end.time - start.time) * frac;
    }
  }
  return result;
}

function renderLyricsContent() {
  lyricsLinesEl.innerHTML = '';
  const hasLyrics = currentLyrics && currentLyrics.lines.length > 0;
  lyricsEmptyEl.classList.toggle('hidden', hasLyrics);
  if (!hasLyrics) return;
  currentLyrics.lines.forEach(line => {
    const div = document.createElement('div');
    div.className = 'lyrics-line' + (currentLyrics.synced ? '' : ' unsynced');
    div.textContent = line.text;
    lyricsLinesEl.appendChild(div);
  });
}

async function loadLyricsForTrack(trackPath) {
  lyricsTrackPath = trackPath;
  currentLyrics = null;
  renderLyricsContent();
  try {
    const data = await api(`/api/lyrics?path=${encodeURIComponent(trackPath)}`);
    if (lyricsTrackPath !== trackPath) return; // a newer track started before this resolved
    currentLyrics = data.lyrics ? parseLRC(data.lyrics) : null;
  } catch {
    if (lyricsTrackPath !== trackPath) return;
    currentLyrics = null;
  }
  renderLyricsContent();
}

function updateLyricsSync() {
  if (!currentLyrics || !currentLyrics.lines.length || !lyricsLinesEl.children.length) return;
  // STEP 2: currentTimeSec()/durationSec() - playback.js helpers, audioEl
  // reads on web (unchanged), polled cache on native.
  const t = currentTimeSec();
  const dur = durationSec();

  if (currentLyrics.synced) {
    if (!currentLyrics.interpolatedLines && dur && isFinite(dur)) {
      currentLyrics.interpolatedLines = interpolateLyricsTimes(currentLyrics.lines, dur);
    }
    const syncLines = currentLyrics.interpolatedLines || currentLyrics.lines;
    let activeIdx = -1;
    for (let i = 0; i < syncLines.length; i++) {
      const lineTime = syncLines[i].time;
      if (lineTime !== null && lineTime <= t) activeIdx = i;
    }
    const children = lyricsLinesEl.children;
    for (let i = 0; i < children.length; i++) {
      children[i].classList.toggle('active', i === activeIdx);
    }
    if (lyricsAutoScroll && activeIdx >= 0 && children[activeIdx]) {
      children[activeIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } else if (lyricsAutoScroll && dur && isFinite(dur)) {
    // No per-line timing available - scroll proportionally to overall song progress.
    const scrollable = lyricsContentEl.scrollHeight - lyricsContentEl.clientHeight;
    if (scrollable > 0) lyricsContentEl.scrollTop = (t / dur) * scrollable;
  }
}
audioEl.addEventListener('timeupdate', updateLyricsSync);
// Native has no timeupdate event - piggyback on NativeAudioAdapter's real
// 'currentTime' event instead (see comment on updateFpTimeDisplay in
// layout-init.js).
NativeAudioAdapter.onTimeUpdate(updateLyricsSync);

function toggleLyricsBox() {
  lyricsBoxOpen = !lyricsBoxOpen;
  lyricsBoxWrap.classList.toggle('open', lyricsBoxOpen);
  lyricsBoxEl.classList.toggle('open', lyricsBoxOpen);
  lyricsToggleBtn.title = lyricsBoxOpen ? 'Hide lyrics' : 'Show lyrics';
  // No redraw needed: drawBlurBackground always draws tall enough for the
  // panel's maximum possible height and anchors the canvas to the bottom
  // of its wrapper, so opening/closing the lyrics panel just reveals more
  // or less of the same already-drawn artwork via CSS overflow:hidden.
}
lyricsToggleBtn.addEventListener('click', toggleLyricsBox);

function updateScrollModeBtn() {
  lyricsScrollModeBtn.classList.toggle('on', lyricsAutoScroll);
  lyricsScrollModeBtn.setAttribute('aria-checked', String(lyricsAutoScroll));
  document.querySelector('.lyrics-scroll-toggle-wrap').classList.toggle('on', lyricsAutoScroll);
}
lyricsScrollModeBtn.addEventListener('click', () => {
  lyricsAutoScroll = !lyricsAutoScroll;
  updateScrollModeBtn();
});
updateScrollModeBtn();

lyricsEditBtn.addEventListener('click', () => {
  const track = queue[queueIndex];
  if (!track) return;
  openMetadataEditor([{ path: track.path, name: fileNameOf(track.path), isAudio: true }]);
});

lyricsFetchEmptyBtn.addEventListener('click', async () => {
  const track = queue[queueIndex];
  if (!track) return;
  lyricsFetchEmptyBtn.disabled = true;
  lyricsFetchEmptyBtn.textContent = 'Fetching...';
  try {
    const data = await api('/api/lyrics/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: track.path })
    });
    if (data.found) {
      await api('/api/edit-meta/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: [{ path: track.path, tags: { lyrics: data.lyrics } }] })
      });
      delete metaCache[track.path];
      await loadLyricsForTrack(track.path);
    } else {
      showToast('No matching lyrics found');
    }
  } catch (err) {
    showToast(err.message || 'Failed to fetch lyrics');
  } finally {
    lyricsFetchEmptyBtn.disabled = false;
    lyricsFetchEmptyBtn.textContent = 'Fetch lyrics';
  }
});

