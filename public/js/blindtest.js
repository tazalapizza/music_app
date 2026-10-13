// blindtest.js — "Guess the song" game, shown in the desktop panel's pane or in
// the mobile Blind test tab (the same views move between them). Plays a clip of each
// queued track through its own Audio element rather than the main player, so
// nothing else in the UI (player bar, lyrics, media session, accent colors)
// can give the answer away.

const BT_FADE_MS = 1500;

const btSetupEl = document.getElementById('btSetup');
const btGameEl = document.getElementById('btGame');
const btFinishedEl = document.getElementById('btFinished');
const btQueueInfoEl = document.getElementById('btQueueInfo');
const btStartBtn = document.getElementById('btStartBtn');
const btCounterEl = document.getElementById('btCounter');
const btArtWrapEl = document.getElementById('btArtWrap');
const btArtEl = document.getElementById('btArt');
const btMysteryEl = document.getElementById('btMystery');
const btAnswerTitleEl = document.getElementById('btAnswerTitle');
const btAnswerArtistEl = document.getElementById('btAnswerArtist');
const btProgressFillEl = document.getElementById('btProgressFill');
const btCountdownEl = document.getElementById('btCountdown');
const btPauseBtn = document.getElementById('btPauseBtn');
const btRevealBtn = document.getElementById('btRevealBtn');
const btNextBtn = document.getElementById('btNextBtn');

const btMobileQuery = window.matchMedia('(max-width: 780px)');

let bt = null; // active session, null when no blind test is running

function btShowView(view) {
  btSetupEl.classList.toggle('hidden', view !== btSetupEl);
  btGameEl.classList.toggle('hidden', view !== btGameEl);
  btFinishedEl.classList.toggle('hidden', view !== btFinishedEl);
}

// Shuffled queue; the currently playing song is placed anywhere but first,
// since the player has just given it away.
function btShuffledTracks() {
  const out = queue.filter((_, i) => i !== queueIndex);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.length && queue[queueIndex]) {
    out.splice(1 + Math.floor(Math.random() * out.length), 0, queue[queueIndex]);
  }
  return out;
}

function renderBlindTestSetup() {
  if (bt) return;
  const n = btShuffledTracks().length;
  btQueueInfoEl.textContent = n ? `${n} song${n === 1 ? '' : 's'} in queue` : 'No songs in the queue : add some first';
  btStartBtn.disabled = n === 0;
  btShowView(btSetupEl);
}

function btSegmentValue(groupId) {
  return document.querySelector(`#${groupId} button.on`).dataset.value;
}
const BT_MIN_SEC = 1;
const BT_MAX_SEC = 60;

function btNumberInput(id) {
  const input = document.getElementById(id);
  const v = parseInt(input.value, 10);
  return Number.isFinite(v) ? Math.min(BT_MAX_SEC, Math.max(BT_MIN_SEC, v)) : Number(input.dataset.default);
}
const BT_CHEVRON_UP_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"></polyline></svg>';
const BT_CHEVRON_DOWN_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

document.querySelectorAll('#blindTestPane .bt-number input').forEach((input) => {
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });
  input.addEventListener('change', () => { input.value = btNumberInput(input.id); });
  const stepper = document.createElement('span');
  stepper.className = 'bt-stepper';
  for (const [step, svg, title] of [[1, BT_CHEVRON_UP_SVG, 'Increase'], [-1, BT_CHEVRON_DOWN_SVG, 'Decrease']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = svg;
    btn.addEventListener('click', () => {
      input.value = Math.min(BT_MAX_SEC, Math.max(BT_MIN_SEC, btNumberInput(input.id) + step));
    });
    stepper.appendChild(btn);
  }
  input.after(stepper);
});
document.querySelectorAll('#blindTestPane .bt-segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
  });
});

// ---------- Audio ----------
// One element reused for every song, like the main player: phones only let an
// element start playing on its own once a tap has started it (see btStart).
const btAudio = new Audio();
btAudio.preload = 'auto';
const BT_SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
let btFadeTimer = null;

function btFade(to, ms) {
  clearInterval(btFadeTimer);
  const from = btAudio.volume;
  const t0 = performance.now();
  // setInterval rather than rAF so fades still finish if the tab is hidden.
  return new Promise((resolve) => {
    btFadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      btAudio.volume = from + (to - from) * k;
      if (k === 1) { clearInterval(btFadeTimer); resolve(); }
    }, 30);
  });
}

function btStopAudio() {
  clearInterval(btFadeTimer);
  btAudio.onloadedmetadata = btAudio.onerror = btAudio.onended = null;
  btAudio.pause();
  btAudio.removeAttribute('src');
  btAudio.load();
}

// Resolves once the track is loaded and seeked to its start point, or null if it fails to load.
function btLoad(track, session) {
  getMeta(track.path);
  clearInterval(btFadeTimer);
  btAudio.onended = null;
  btAudio.volume = 0;
  return new Promise((resolve) => {
    btAudio.onloadedmetadata = () => {
      let startAt = 0;
      if (session.random) {
        const room = btAudio.duration - session.clipSec - session.revealSec;
        if (isFinite(room) && room > 0) startAt = Math.random() * room;
      }
      btAudio.currentTime = startAt;
      resolve({ track, elapsed: 0 });
    };
    btAudio.onerror = () => resolve(null);
    btAudio.src = getOfflineStreamUrl(track.path) || `/api/stream?path=${encodeURIComponent(track.path)}`;
  });
}

// ---------- Session flow ----------
function btStart() {
  const tracks = btShuffledTracks();
  if (!tracks.length) return;
  if (!NativeAudioAdapter.paused()) {
    NativeAudioAdapter.pause();
    setPlayPauseIcon(false);
  }
  bt = {
    tracks,
    clipSec: btNumberInput('btClipInput'),
    revealSec: btNumberInput('btRevealInput'),
    gapSec: btNumberInput('btGapInput'),
    accentBefore: document.documentElement.style.getPropertyValue('--accent-color'),
    random: btSegmentValue('btStartGroup') === 'random',
    index: -1,
    cur: null,
    phase: 'loading', // 'loading' | 'guess' | 'reveal' | 'gap'
    gapEnd: 0,
    skipGap: null,
    paused: false,
    revealAt: 0,
    tick: setInterval(btTick, 100)
  };
  // Start the element inside this tap so later songs may start without one.
  clearInterval(btFadeTimer);
  btAudio.src = BT_SILENT_WAV;
  btAudio.play().catch(() => {});
  document.body.classList.add('blindtest-active');
  if (!btMobileQuery.matches && !lyricsBoxOpen) toggleLyricsBox();
  btShowView(btGameEl);
  btPlay(0);
}

async function btPlay(i) {
  const session = bt;
  session.index = i;
  session.phase = 'loading';
  session.paused = false;
  btRenderGame();
  const clip = await btLoad(session.tracks[i], session);
  if (bt !== session) return;
  if (!clip) {
    if (i + 1 < session.tracks.length) btPlay(i + 1);
    else btFinish();
    return;
  }
  session.cur = clip;
  session.phase = 'guess';
  btAudio.onended = () => {
    if (bt !== session || session.cur !== clip) return;
    if (session.phase === 'guess') {
      btReveal();
      setTimeout(() => { if (bt === session && session.cur === clip) btAdvance(); }, session.revealSec * 1000);
    } else if (session.phase === 'reveal') {
      btAdvance();
    }
  };
  btAudio.play().catch(() => {});
  btFade(audioEl.volume, BT_FADE_MS);
  btRenderGame();
}

// The current song fades out during the gapSec pause, then the next one starts.
async function btAdvance() {
  const session = bt;
  if (!session || session.phase === 'loading') return;
  if (session.phase === 'gap') { session.skipGap(); return; }
  if (session.index + 1 >= session.tracks.length) { btFinish(); return; }
  if (session.cur) {
    session.cur = null;
    session.phase = 'gap';
    session.paused = false;
    session.gapEnd = performance.now() + session.gapSec * 1000;
    btRenderGame();
    btFade(0, Math.min(BT_FADE_MS, session.gapSec * 1000)).then(() => btAudio.pause());
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, session.gapEnd - performance.now());
      session.skipGap = () => { clearTimeout(timer); resolve(); };
    });
    if (bt !== session) return;
  }
  btPlay(session.index + 1);
}

async function btReveal() {
  const session = bt;
  if (!session || session.phase !== 'guess') return;
  const clip = session.cur;
  session.phase = 'reveal';
  session.revealAt = clip.elapsed;
  btRenderGame();
  const meta = await getMeta(clip.track.path);
  if (bt !== session || session.cur !== clip) return;
  btAnswerTitleEl.textContent = meta.title || clip.track.name;
  btAnswerArtistEl.textContent = meta.artist || 'Unknown artist';
  if (meta.hasArt) {
    btArtEl.src = getOfflineArtUrl(clip.track.path) || `/api/art?path=${encodeURIComponent(clip.track.path)}`;
    btArtEl.onload = () => {
      if (bt !== session || session.cur !== clip) return;
      btArtEl.classList.remove('hidden');
      btSetAccent(extractAccentColor(btArtEl));
    };
    btArtEl.onerror = () => { if (bt === session && session.cur === clip) btSetAccent(null); };
    btArtWrapEl.classList.add('revealed');
  } else {
    btMysteryEl.textContent = '♪';
    btSetAccent(null);
  }
}

function btSetAccent(rgb) {
  document.documentElement.style.setProperty('--accent-color', rgb ? makeAccentColor(rgb) : '#e8e8ea');
}

function btTogglePause() {
  if (!bt || !bt.cur || bt.phase === 'loading') return;
  bt.paused = !bt.paused;
  if (bt.paused) btAudio.pause();
  else btAudio.play().catch(() => {});
  btPauseBtn.textContent = bt.paused ? 'Resume' : 'Pause';
}

function btEnd() {
  const session = bt;
  if (!session) return;
  bt = null;
  clearInterval(session.tick);
  document.body.classList.remove('blindtest-active');
  document.documentElement.style.setProperty('--accent-color', session.accentBefore || '#e8e8ea');
}

function btStop() {
  btStopAudio();
  btEnd();
  renderBlindTestSetup();
}

function btFinish() {
  const session = bt;
  btEnd();
  btFade(0, BT_FADE_MS).then(btStopAudio);
  const n = session.tracks.length;
  document.getElementById('btFinishedInfo').textContent = `${n} song${n === 1 ? '' : 's'} played`;
  btShowView(btFinishedEl);
}

// ---------- Rendering ----------
function btRenderGame() {
  if (!bt) return;
  btCounterEl.textContent = `Song ${bt.index + 1} / ${bt.tracks.length}`;
  btPauseBtn.textContent = bt.paused ? 'Resume' : 'Pause';
  btPauseBtn.disabled = bt.phase === 'loading' || bt.phase === 'gap';
  btRevealBtn.disabled = bt.phase !== 'guess';
  btNextBtn.disabled = bt.phase === 'loading';
  btGameEl.classList.toggle('revealing', bt.phase === 'reveal');
  if (bt.phase !== 'reveal') {
    btArtWrapEl.classList.remove('revealed');
    btMysteryEl.textContent = '?';
    btArtEl.classList.add('hidden');
    btArtEl.removeAttribute('src');
    btAnswerTitleEl.textContent = '';
    btAnswerArtistEl.textContent = '';
  }
  if (bt.phase === 'loading' || bt.phase === 'gap') {
    btCountdownEl.textContent = bt.phase === 'loading' ? 'Loading…' : `Next song in ${bt.gapSec}s`;
    btProgressFillEl.style.width = '0%';
  }
}

// Counts real playing time rather than reading currentTime, which mobile
// browsers don't reliably report relative to the seeked start point.
function btTick() {
  const now = performance.now();
  const dt = bt && bt.lastTick ? (now - bt.lastTick) / 1000 : 0;
  if (bt) bt.lastTick = now;
  if (bt && bt.phase === 'gap') {
    btCountdownEl.textContent = `Next song in ${Math.max(0, Math.ceil((bt.gapEnd - now) / 1000))}s`;
    return;
  }
  const clip = bt && bt.cur;
  if (!clip || bt.paused || bt.phase === 'loading') return;
  if (!btAudio.paused && btAudio.readyState >= 3) clip.elapsed += dt;
  const elapsed = clip.elapsed;
  if (bt.phase === 'guess') {
    const left = bt.clipSec - elapsed;
    btProgressFillEl.style.width = `${Math.min(100, (elapsed / bt.clipSec) * 100)}%`;
    btCountdownEl.textContent = `${Math.max(0, Math.ceil(left))}s`;
    if (left <= 0) btReveal();
  } else {
    const shown = elapsed - bt.revealAt;
    btProgressFillEl.style.width = '100%';
    const isLast = bt.index + 1 >= bt.tracks.length;
    const untilNext = bt.revealSec - shown + bt.gapSec;
    btCountdownEl.textContent = isLast ? 'Last song' : `Next song in ${Math.max(0, Math.ceil(untilNext))}s`;
    if (shown >= bt.revealSec) btAdvance();
  }
}

btStartBtn.addEventListener('click', btStart);
document.getElementById('btStopBtn').addEventListener('click', btStop);
document.getElementById('btAgainBtn').addEventListener('click', renderBlindTestSetup);
btPauseBtn.addEventListener('click', btTogglePause);
btRevealBtn.addEventListener('click', btReveal);
btNextBtn.addEventListener('click', btAdvance);

// Capture phase so Space/arrows don't reach the main player's shortcuts mid-game.
window.addEventListener('keydown', (e) => {
  if (!bt) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (e.code === 'Space') {
    e.preventDefault();
    e.stopPropagation();
    btTogglePause();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.stopPropagation();
  }
}, true);

function btPlaceViews() {
  const host = document.getElementById(btMobileQuery.matches ? 'mobileBlindTestPanel' : 'blindTestPane');
  host.append(btSetupEl, btGameEl, btFinishedEl);
}
btPlaceViews();
btMobileQuery.addEventListener('change', btPlaceViews);
