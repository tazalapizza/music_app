// ---------------------------------------------------------------------------
// controls.js — Loop, shuffle, playback speed, and volume/mute controls,
// plus the player bar's 'open folder' and 'delete track' buttons.
// Depends on: state.js, playback.js.
// ---------------------------------------------------------------------------

// ---------- Loop / Shuffle / Speed / Volume / Folder / Delete ----------
const loopBtn = document.getElementById('loopBtn');
const REPEAT_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
function updateLoopBtn() {
  const map = {
    off: { label: '', active: false, title: 'Loop: off (click to loop all)' },
    all: { label: '', active: true,  title: 'Loop: all (click to loop one)' },
    one: { label: '1', active: true,  title: 'Loop: one (click to turn off)' }
  };
  const s = map[loopMode];
  loopBtn.innerHTML = `${REPEAT_ICON_SVG}${s.label ? `<span class="loop-label">${s.label}</span>` : ''}`;
  loopBtn.title = s.title;
  loopBtn.classList.toggle('active-state', s.active);
}
loopBtn.addEventListener('click', () => {
  loopMode = loopMode === 'off' ? 'all' : (loopMode === 'all' ? 'one' : 'off');
  updateLoopBtn();
});
updateLoopBtn();

function updateShuffleBtnState() {
  document.getElementById('shuffleBtn').classList.toggle('active-state', shuffled);
  document.getElementById('shuffleQueueBtn').classList.toggle('active-state', shuffled);
}

function toggleShuffle() {
  if (queue.length < 2) return;
  const current = queueIndex >= 0 ? queue[queueIndex] : null;

  if (!shuffled) {
    // Turning ON: snapshot the current order as the baseline, then shuffle.
    originalQueue = [...queue];
    const rest = current ? queue.filter((_, i) => i !== queueIndex) : queue.slice();
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    if (current) {
      queue = [current, ...rest];
      queueIndex = 0;
    } else {
      queue = rest;
    }
    shuffled = true;
  } else {
    // Turning OFF: restore the original (pre-shuffle) order.
    queue = [...originalQueue];
    queueIndex = current ? queue.indexOf(current) : -1;
    shuffled = false;
  }
  updateShuffleBtnState();
  renderQueue();
  scrollToPlayingQueueRow();
}
document.getElementById('shuffleBtn').addEventListener('click', toggleShuffle);
document.getElementById('shuffleQueueBtn').addEventListener('click', toggleShuffle);

document.getElementById('clearQueueBtn').addEventListener('click', () => {
  queue = [];
  originalQueue = [];
  shuffled = false;
  updateShuffleBtnState();
  queueIndex = -1;
  hidePlayerBar();
  document.getElementById('trackName').querySelector('span').textContent = '';
  document.getElementById('trackPath').querySelector('span').textContent = '';
  renderQueue();
});

document.getElementById('closePlayerBtn').addEventListener('click', () => {
  hidePlayerBar();
});

const speedBtn = document.getElementById('speedBtn');
const speedMenu = document.getElementById('speedMenu');
function updateSpeedBtn() { speedBtn.textContent = speeds[speedIndex] + 'x'; }

function renderSpeedMenu() {
  speedMenu.innerHTML = '';
  speeds.forEach((sp, i) => {
    const btn = document.createElement('button');
    btn.textContent = sp + 'x';
    btn.className = i === speedIndex ? 'active' : '';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speedIndex = i;
      NativeAudioAdapter.setRate(speeds[speedIndex]);
      updateSpeedBtn();
      speedMenu.classList.add('hidden');
    });
    speedMenu.appendChild(btn);
  });
}

speedBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  renderSpeedMenu();
  speedMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!speedMenu.contains(e.target) && e.target !== speedBtn) {
    speedMenu.classList.add('hidden');
  }
});
updateSpeedBtn();

const volumeBar = document.getElementById('volumeBar');
const muteBtn = document.getElementById('muteBtn');
const muteIconOn = document.getElementById('muteIconOn');
const muteIconOff = document.getElementById('muteIconOff');
function setMuteIcon(isMuted) {
  muteIconOn.classList.toggle('hidden', isMuted);
  muteIconOff.classList.toggle('hidden', !isMuted);
}
function updateVolumeBarFill() {
  volumeBar.style.setProperty('--volume-pct', volumeBar.value + '%');
}
// The volume slider has two possible backends now:
//   - Android: SystemVolumeAdapter - the REAL device system volume (same
//     value the physical buttons move), via a small local Capacitor plugin
//     (SystemVolumePlugin.java). This is what makes the slider behave like
//     Documents/Spotify's embedded volume control, per the user's request.
//   - iOS and web: NativeAudioAdapter's app-level volume, unchanged from
//     the original native-audio migration (see native-audio-adapter.js).
//     iOS has no code-level API to set system volume at all (confirmed via
//     Apple's own developer forums) - the only sanctioned mechanism is
//     embedding MPVolumeView, a native UI widget with its own gesture
//     handling, which is a separate native-Swift task, not something this
//     JS slider can drive. Until that's built, iOS keeps the same
//     app-level-gain behavior it's had since Step 1.
//
// NativeAudioAdapter.setVolume() is NOT removed or bypassed when
// SystemVolumeAdapter is active - it stays wired up (currently at its
// neutral 1.0 default from the user's perspective) since it's what
// ReplayGain uses to attenuate individual tracks (see state.js's
// applyReplayGain). System volume and app-level gain are complementary,
// stacked controls, not alternatives to each other - see the project's
// volume-architecture notes for the full reasoning.
const useSystemVolume = SystemVolumeAdapter.isSupported();

volumeBar.addEventListener('input', (e) => {
  const frac = e.target.value / 100;
  if (useSystemVolume) {
    SystemVolumeAdapter.setVolume(frac);
  } else {
    NativeAudioAdapter.setVolume(frac);
    NativeAudioAdapter.setMuted(false);
  }
  setMuteIcon(e.target.value == 0);
  updateVolumeBarFill();
});
muteBtn.addEventListener('click', () => {
  if (useSystemVolume) {
    // No separate "system mute" concept exposed here - mute is
    // implemented as "remember the current level, drop to 0, restore on
    // unmute" so the mute button behaves the same way regardless of which
    // backend is active, rather than needing two different mental models.
    if (volumeBar.dataset.preMuteValue) {
      const restored = volumeBar.dataset.preMuteValue;
      delete volumeBar.dataset.preMuteValue;
      volumeBar.value = restored;
      SystemVolumeAdapter.setVolume(restored / 100);
      setMuteIcon(false);
    } else {
      volumeBar.dataset.preMuteValue = volumeBar.value;
      volumeBar.value = 0;
      SystemVolumeAdapter.setVolume(0);
      setMuteIcon(true);
    }
    updateVolumeBarFill();
  } else {
    NativeAudioAdapter.setMuted(!NativeAudioAdapter.muted());
    setMuteIcon(NativeAudioAdapter.muted());
  }
});

if (useSystemVolume) {
  // Initial sync: reflect the device's actual current volume in the
  // slider on load, rather than showing some default/stale value that
  // doesn't match reality until the user first touches the slider.
  SystemVolumeAdapter.getVolume().then(vol => {
    if (vol === null) return;
    volumeBar.value = Math.round(vol * 100);
    setMuteIcon(vol === 0);
    updateVolumeBarFill();
  });
  // Live sync: if the user presses the PHYSICAL volume buttons while the
  // app is open, reflect that in the slider too - this is what makes the
  // in-app control feel like a real embedded system control rather than
  // an independent one that silently drifts out of sync the moment
  // hardware buttons are used.
  SystemVolumeAdapter.onVolumeChanged((vol) => {
    volumeBar.value = Math.round(vol * 100);
    setMuteIcon(vol === 0);
    updateVolumeBarFill();
  });
}
updateVolumeBarFill();

document.getElementById('openFolderBtn').addEventListener('click', () => {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  const track = queue[queueIndex];
  const folder = track.path.includes('/') ? track.path.slice(0, track.path.lastIndexOf('/')) : '';
  browse(folder);
});

document.getElementById('deleteTrackBtn').addEventListener('click', async () => {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  const track = queue[queueIndex];
  if (!confirmAction(`Delete "${track.name}"? This cannot be undone.`)) return;
  // Stop playback and detach the source *before* the delete request goes out.
  // Otherwise, deleting a file that's actively streaming can make the
  // browser fire 'ended' while the API call is still in flight, which
  // races playNext() against this handler's own queueIndex/queue updates
  // below and can leave queueIndex pointing at the wrong track.
  NativeAudioAdapter.pause();
  audioEl.removeAttribute('src'); // web path only; harmless no-op on native
  audioEl.load();
  await api('/api/delete', {
    method: 'DELETE', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path: track.path }),
    retryOnAuth: false
  });
  const removedRow = [...queuePanel.querySelectorAll('.queue-item')].find(row => Number(row.dataset.index) === queueIndex);
  removeFromQueueAt(queueIndex);
  if (queueIndex >= queue.length) queueIndex = queue.length - 1;
  if (queueIndex >= 0) {
    playCurrent();
  } else {
    hidePlayerBar();
    document.getElementById('trackName').querySelector('span').textContent = '';
    document.getElementById('trackPath').querySelector('span').textContent = '';
  }
  if (removedRow) removeQueueRowAt(removedRow); else renderQueue();
  const trackFolder = track.path.includes('/') ? track.path.slice(0, track.path.lastIndexOf('/')) : '';
  if (currentPath === trackFolder) {
    browse(currentPath, { keepSort: true });
  }
});