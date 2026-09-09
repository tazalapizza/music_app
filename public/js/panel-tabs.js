// panel-tabs.js — vertical icon menu switching the lyrics box between its
// three panes (Lyrics / Visualizer / Mixer), plus the visualizer draw loop
// and the mixer's 3-band EQ sliders. Shares the single WebAudio graph set up
// in state.js's ensureAudioGraph() (bassNode/midNode/trebleNode/analyserNode).

const panelTabLyrics = document.getElementById('panelTabLyrics');
const panelTabVisualizer = document.getElementById('panelTabVisualizer');
const panelTabMixer = document.getElementById('panelTabMixer');
const panelTabBtns = { lyrics: panelTabLyrics, visualizer: panelTabVisualizer, mixer: panelTabMixer };

const visualizerPane = document.getElementById('visualizerPane');
const mixerPane = document.getElementById('mixerPane');
const lyricsPane = document.getElementById('lyricsPane');
const panelPanes = { lyrics: lyricsPane, visualizer: visualizerPane, mixer: mixerPane };

let activePanelTab = 'lyrics';

function switchPanelTab(tab) {
  if (tab === activePanelTab) return;
  activePanelTab = tab;
  for (const key in panelTabBtns) {
    panelTabBtns[key].classList.toggle('on', key === tab);
    panelPanes[key].classList.toggle('hidden', key !== tab);
  }
  if (tab === 'visualizer') startVisualizer();
  else stopVisualizer();
}

panelTabLyrics.addEventListener('click', () => switchPanelTab('lyrics'));
panelTabVisualizer.addEventListener('click', () => switchPanelTab('visualizer'));
panelTabMixer.addEventListener('click', () => switchPanelTab('mixer'));

// ---------- Visualizer ----------
const visualizerCanvas = document.getElementById('visualizerCanvas');
const visualizerCtx = visualizerCanvas.getContext('2d');
let visualizerRAF = null;

function resizeVisualizerCanvas() {
  const w = visualizerCanvas.clientWidth, h = visualizerCanvas.clientHeight;
  if (visualizerCanvas.width !== w || visualizerCanvas.height !== h) {
    visualizerCanvas.width = w;
    visualizerCanvas.height = h;
  }
}

// Musical energy concentrates in the first few (linearly-spaced) frequency
// bins, leaving most of a linear layout looking empty on the right - bars
// are instead mapped onto the spectrum log-scaled, like a typical audio
// visualizer, so low/mid/high all get a fair share of the canvas width.
const VISUALIZER_BAR_COUNT = 48;

// Averages the frequency bins (linear index space) falling in [0,1) fraction
// range into VISUALIZER_BAR_COUNT log-scaled buckets, returning one 0..255
// magnitude per bucket.
function logScaleBars(data) {
  const binCount = data.length;
  const bars = new Array(VISUALIZER_BAR_COUNT);
  for (let i = 0; i < VISUALIZER_BAR_COUNT; i++) {
    const binStart = Math.min(binCount - 1, Math.floor(Math.pow(binCount, i / VISUALIZER_BAR_COUNT)));
    const binEnd = Math.max(binStart + 1, Math.min(binCount, Math.ceil(Math.pow(binCount, (i + 1) / VISUALIZER_BAR_COUNT))));
    let sum = 0;
    for (let b = binStart; b < binEnd; b++) sum += data[b];
    bars[i] = sum / (binEnd - binStart);
  }
  return bars;
}

function drawBars(w, h, accent) {
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);
  const bars = logScaleBars(data);
  const barWidth = w / VISUALIZER_BAR_COUNT;
  visualizerCtx.fillStyle = accent;
  for (let i = 0; i < VISUALIZER_BAR_COUNT; i++) {
    const barHeight = (bars[i] / 255) * h;
    visualizerCtx.fillRect(i * barWidth, h - barHeight, barWidth - 1, barHeight);
  }
}

function drawMirrorBars(w, h, accent) {
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);
  const bars = logScaleBars(data);
  const barWidth = w / VISUALIZER_BAR_COUNT;
  const mid = h / 2;
  visualizerCtx.fillStyle = accent;
  for (let i = 0; i < VISUALIZER_BAR_COUNT; i++) {
    const barHalfHeight = (bars[i] / 255) * mid;
    visualizerCtx.fillRect(i * barWidth, mid - barHalfHeight, barWidth - 1, barHalfHeight * 2);
  }
}

// getByteTimeDomainData centers silence at 128 with typical music swinging
// only a few units either side of it - drawn raw, the wave reads as a near-
// flat line hugging the middle. WAVE_GAIN amplifies the deviation from
// center so normal listening levels produce a visible trace instead of
// requiring near-clipping volume to see anything.
const WAVE_GAIN = 3;

function drawWave(w, h, accent) {
  const data = new Uint8Array(analyserNode.fftSize);
  analyserNode.getByteTimeDomainData(data);
  visualizerCtx.strokeStyle = accent;
  visualizerCtx.lineWidth = 2;
  visualizerCtx.beginPath();
  const sliceWidth = w / data.length;
  const mid = h / 2;
  for (let i = 0; i < data.length; i++) {
    const deviation = (data[i] - 128) / 128; // -1..1
    const y = mid - Math.max(-1, Math.min(1, deviation * WAVE_GAIN)) * mid;
    if (i === 0) visualizerCtx.moveTo(0, y);
    else visualizerCtx.lineTo(i * sliceWidth, y);
  }
  visualizerCtx.stroke();
}

// logScaleBars' 0..255 magnitudes rarely approach the top of that range at
// normal listening volume, and the base circle only left half the canvas'
// half-dimension for spikes to grow into. A flat multiplier fixed the quiet
// end but clipped every bin already above ~1/gain of max to the same full
// length, pegging half the spikes at max instead of showing variation - a
// sqrt curve boosts quiet bins more than loud ones without a hard ceiling
// below 255, so nothing clips until a bin is genuinely near its true max.
function circularBoost(magnitude0to255) {
  return Math.sqrt(magnitude0to255 / 255);
}

function drawCircular(w, h, accent) {
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);
  const bars = logScaleBars(data);
  const cx = w / 2, cy = h / 2;
  const outerBudget = Math.min(w, h) / 2;
  const radius = outerBudget * 0.3;
  const maxBarLen = outerBudget - radius;
  visualizerCtx.strokeStyle = accent;
  visualizerCtx.lineWidth = Math.max(2, (2 * Math.PI * radius) / VISUALIZER_BAR_COUNT - 2);
  for (let i = 0; i < VISUALIZER_BAR_COUNT; i++) {
    const angle = (i / VISUALIZER_BAR_COUNT) * Math.PI * 2;
    const len = circularBoost(bars[i]) * maxBarLen;
    const x1 = cx + Math.cos(angle) * radius;
    const y1 = cy + Math.sin(angle) * radius;
    const x2 = cx + Math.cos(angle) * (radius + len);
    const y2 = cy + Math.sin(angle) * (radius + len);
    visualizerCtx.beginPath();
    visualizerCtx.moveTo(x1, y1);
    visualizerCtx.lineTo(x2, y2);
    visualizerCtx.stroke();
  }
}

const VISUALIZER_DRAWERS = { bars: drawBars, mirror: drawMirrorBars, wave: drawWave, circular: drawCircular };
let visualizerStyle = settings.visualizerStyle in VISUALIZER_DRAWERS ? settings.visualizerStyle : 'bars';

function drawVisualizerFrame() {
  visualizerRAF = requestAnimationFrame(drawVisualizerFrame);
  resizeVisualizerCanvas();
  const w = visualizerCanvas.width, h = visualizerCanvas.height;
  visualizerCtx.clearRect(0, 0, w, h);
  if (!analyserNode) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#e8e8ea';
  VISUALIZER_DRAWERS[visualizerStyle](w, h, accent);
}

function startVisualizer() {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!visualizerRAF) drawVisualizerFrame();
}
function stopVisualizer() {
  if (visualizerRAF) {
    cancelAnimationFrame(visualizerRAF);
    visualizerRAF = null;
  }
}

// ---------- Visualizer style menu ----------
const visualizerMenuBtn = document.getElementById('visualizerMenuBtn');
const visualizerMenu = document.getElementById('visualizerMenu');

visualizerMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  visualizerMenu.classList.toggle('hidden');
});
document.addEventListener('click', () => visualizerMenu.classList.add('hidden'));

visualizerMenu.querySelectorAll('.visualizer-menu-item').forEach((btn) => {
  if (btn.dataset.style === visualizerStyle) btn.classList.add('on');
  btn.addEventListener('click', () => {
    visualizerStyle = btn.dataset.style;
    settings.visualizerStyle = visualizerStyle;
    saveSettings();
    visualizerMenu.querySelectorAll('.visualizer-menu-item').forEach((b) => b.classList.toggle('on', b === btn));
    visualizerMenu.classList.add('hidden');
  });
});

// ---------- Mixer ----------
const mixerBass = document.getElementById('mixerBass');
const mixerMid = document.getElementById('mixerMid');
const mixerTreble = document.getElementById('mixerTreble');
const mixerBassValue = document.getElementById('mixerBassValue');
const mixerMidValue = document.getElementById('mixerMidValue');
const mixerTrebleValue = document.getElementById('mixerTrebleValue');

function formatDb(db) { return (db > 0 ? '+' : '') + db + ' dB'; }

mixerBass.value = settings.eqBass;
mixerMid.value = settings.eqMid;
mixerTreble.value = settings.eqTreble;
mixerBassValue.textContent = formatDb(settings.eqBass);
mixerMidValue.textContent = formatDb(settings.eqMid);
mixerTrebleValue.textContent = formatDb(settings.eqTreble);

mixerBass.addEventListener('input', () => {
  setEQBand('bass', Number(mixerBass.value));
  mixerBassValue.textContent = formatDb(Number(mixerBass.value));
});
mixerMid.addEventListener('input', () => {
  setEQBand('mid', Number(mixerMid.value));
  mixerMidValue.textContent = formatDb(Number(mixerMid.value));
});
mixerTreble.addEventListener('input', () => {
  setEQBand('treble', Number(mixerTreble.value));
  mixerTrebleValue.textContent = formatDb(Number(mixerTreble.value));
});

// ---------- Speed ----------
// Shares the same underlying rate as the player bar's discrete speedBtn
// (state.js's speeds/speedIndex) through the single setPlaybackSpeed()
// choke point (state.js), so this slider, the discrete menu, and the
// mobile cycle button can never drift out of sync with each other.
const mixerSpeed = document.getElementById('mixerSpeed');
const mixerSpeedValue = document.getElementById('mixerSpeedValue');

function formatSpeed(rate) { return rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0') + 'x'; }

// Called by state.js's setPlaybackSpeed() after every rate change, from
// whichever UI triggered it, so this slider reflects speed changes made via
// the player bar's speed button/menu too, not just its own input.
function syncMixerSpeedUI(rate) {
  mixerSpeed.value = rate;
  mixerSpeedValue.textContent = formatSpeed(rate);
}
syncMixerSpeedUI(speeds[speedIndex]);
// The slider's range is 0-2 (rather than the more useful 0.25-2) purely so
// 1x sits at its exact visual midpoint, matching the EQ sliders' centered
// 0dB thumb - 0x itself would freeze playback via rate rather than actually
// pausing it, so it's floored here to 0.25x.
mixerSpeed.addEventListener('input', () => setPlaybackSpeed(Math.max(0.25, Number(mixerSpeed.value))));

// ---------- Pitch ----------
// preservesPitch is a plain <audio> element property (web only - no
// equivalent exposed by the native plugin) that the browser uses internally
// to keep pitch constant across playbackRate changes - it isn't a knob we
// can retune to an arbitrary independent pitch, since that combination
// (unchanged speed, shifted pitch) isn't part of the exposed API at all.
// Turning it off here instead routes audio through
// ensurePitchStretchNode()'s vendored SignalsmithStretch worklet (see
// state.js), which does real independent pitch-shifting - the semitone
// slider only has an effect while preserve pitch is off.
const mixerPreservePitch = document.getElementById('mixerPreservePitch');
const mixerPitch = document.getElementById('mixerPitch');
const mixerPitchValue = document.getElementById('mixerPitchValue');

function formatSemitones(st) { return (st > 0 ? '+' : '') + st + ' st'; }
mixerPitchValue.textContent = formatSemitones(settings.pitchSemitones);
mixerPitch.value = settings.pitchSemitones;

function applyPreservePitch(preserve) {
  audioEl.preservesPitch = preserve;
  audioEl.mozPreservesPitch = preserve;
  audioEl.webkitPreservesPitch = preserve;
  mixerPitch.disabled = preserve;
  // Skip on initial load when preserve is already true: ensureAudioGraph()
  // already wires trebleNode straight to analyserNode by default, so
  // there's nothing to switch - calling this would otherwise load the
  // pitch-stretch worklet's WASM on every page load even for users who
  // never touch the pitch control.
  if (!preserve || pitchStretchNodePromise) setPitchStretchActive(!preserve);
}
mixerPreservePitch.checked = settings.preservePitch;
applyPreservePitch(settings.preservePitch);
mixerPreservePitch.addEventListener('change', () => {
  settings.preservePitch = mixerPreservePitch.checked;
  saveSettings();
  applyPreservePitch(mixerPreservePitch.checked);
});

mixerPitch.addEventListener('input', () => {
  const semitones = Number(mixerPitch.value);
  settings.pitchSemitones = semitones;
  saveSettings();
  mixerPitchValue.textContent = formatSemitones(semitones);
  if (pitchStretchNode) pitchStretchNode.schedule({ semitones });
});

if (NativeAudioAdapter.isNative()) {
  mixerPreservePitch.disabled = true;
  mixerPreservePitch.closest('.mixer-pitch-toggle').title = 'Not available during native playback';
  mixerPitch.disabled = true;
}
