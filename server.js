const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const { execFile } = require('child_process');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- CONFIG ----
const MUSIC_ROOT = process.env.MUSIC_ROOT || path.join(__dirname, 'music');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.opus', '.aac', '.wma']);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PLAYLISTS_FILE)) fs.writeFileSync(PLAYLISTS_FILE, '{}');
if (!fs.existsSync(MUSIC_ROOT)) fs.mkdirSync(MUSIC_ROOT, { recursive: true });

// ---- LOGGING: warnings/errors also get appended to a plain-text file in
// DATA_DIR (already bind-mounted to the host via docker-compose), so you can
// check `./data/server-issues.log` directly without needing `docker logs`. ----
const ISSUES_LOG_FILE = path.join(DATA_DIR, 'server-issues.log');
function logIssue(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.warn(line);
  try { fs.appendFileSync(ISSUES_LOG_FILE, line + '\n'); } catch {}
}

process.on('uncaughtException', (err) => {
  logIssue(`UNCAUGHT EXCEPTION (server may need a restart): ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  logIssue(`UNHANDLED PROMISE REJECTION: ${err && err.stack || err}`);
});

// ---- AUTH: single shared password gates write access; browsing/streaming stays open to everyone ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> expiry timestamp

if (!ADMIN_PASSWORD) {
  logIssue('SECURITY WARNING: ADMIN_PASSWORD is not set - all write actions (upload, delete, rename, move, playlists) are locked out until it is configured. Set ADMIN_PASSWORD in docker-compose.yml and restart.');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (isValidSession(cookies.session)) return next();
  logIssue(`Blocked write attempt without a valid session: ${req.method} ${req.originalUrl} from ${req.ip}`);
  res.status(401).json({ error: 'Log in to make changes' });
}

// Brute-force protection: after too many failed attempts from an IP within a
// window, lock that IP out of /api/login for a cooldown period.
const loginAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;   // failures older than this don't count toward the limit
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;  // lockout duration once the limit is hit

function checkLoginLockout(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return null;
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) return entry.lockedUntil - now;
  if (entry.lockedUntil && now >= entry.lockedUntil) { loginAttempts.delete(ip); return null; }
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return null; }
  return null;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    entry = { count: 0, firstAttempt: now, lockedUntil: null };
  }
  entry.count++;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
    logIssue(`Login lockout: ${ip} hit ${LOGIN_MAX_ATTEMPTS} failed attempts, locked out for ${LOGIN_LOCKOUT_MS / 60000} minutes`);
  }
  loginAttempts.set(ip, entry);
}

// Periodic cleanup so this map doesn't grow unbounded over a long uptime.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if ((!entry.lockedUntil || now > entry.lockedUntil) && now - entry.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000).unref();

app.post('/api/login', (req, res) => {
  const remaining = checkLoginLockout(req.ip);
  if (remaining) {
    const mins = Math.ceil(remaining / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Server has no ADMIN_PASSWORD configured - see docker-compose.yml' });
  }
  const supplied = Buffer.from(String((req.body && req.body.password) || ''));
  const expected = Buffer.from(ADMIN_PASSWORD);
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!valid) {
    recordFailedLogin(req.ip);
    logIssue(`Failed login attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Incorrect password' });
  }
  loginAttempts.delete(req.ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session) sessions.delete(cookies.session);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
  res.json({ ok: true });
});

app.get('/api/auth-status', (req, res) => {
  const cookies = parseCookies(req);
  res.json({ authenticated: isValidSession(cookies.session), authConfigured: !!ADMIN_PASSWORD });
});

// ---- SAFETY: resolve + confine all paths inside MUSIC_ROOT ----
function safeResolve(relPath) {
  const target = path.normalize(path.join(MUSIC_ROOT, relPath || ''));
  if (!target.startsWith(path.normalize(MUSIC_ROOT))) {
    throw new Error('Path escapes music root');
  }
  return target;
}

function isAudio(filename) {
  return AUDIO_EXT.has(path.extname(filename).toLowerCase());
}

// ---- BROWSE: list folder contents ----
async function getFolderCounts(fullDirPath) {
  try {
    const subEntries = await fsp.readdir(fullDirPath, { withFileTypes: true });
    let songs = 0, folders = 0;
    for (const se of subEntries) {
      if (se.name.startsWith('.')) continue;
      if (se.isDirectory()) folders++;
      else if (isAudio(se.name)) songs++;
    }
    return { songs, folders };
  } catch {
    return { songs: 0, folders: 0 };
  }
}

app.get('/api/browse', async (req, res) => {
  try {
    const rel = req.query.path || '';
    const full = safeResolve(rel);
    const entries = await fsp.readdir(full, { withFileTypes: true });
    const items = await Promise.all(entries
      .filter(e => !e.name.startsWith('.'))
      .map(async e => {
        const entryRel = path.join(rel, e.name);
        let size = null;
        let counts = null;
        if (e.isFile()) {
          try { size = (await fsp.stat(path.join(full, e.name))).size; } catch {}
        } else if (e.isDirectory()) {
          counts = await getFolderCounts(path.join(full, e.name));
        }
        return {
          name: e.name,
          path: entryRel,
          isDir: e.isDirectory(),
          isAudio: e.isFile() && isAudio(e.name),
          size,
          counts
        };
      }));
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    res.json({ path: rel, items });
  } catch (err) {
    logIssue(`GET /api/browse?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---- Recursively list all audio files under a folder (for "add folder to queue/playlist") ----
async function listAudioRecursive(relPath) {
  const full = safeResolve(relPath);
  const stat = await fsp.stat(full);
  if (stat.isFile()) {
    return isAudio(relPath) ? [relPath] : [];
  }
  let results = [];
  const entries = await fsp.readdir(full, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (e.name.startsWith('.')) continue;
    const childRel = path.join(relPath, e.name);
    if (e.isDirectory()) {
      results = results.concat(await listAudioRecursive(childRel));
    } else if (isAudio(e.name)) {
      results.push(childRel);
    }
  }
  return results;
}

app.get('/api/expand', async (req, res) => {
  try {
    const rel = req.query.path || '';
    const files = await listAudioRecursive(rel);
    res.json({ files });
  } catch (err) {
    logIssue(`GET /api/expand?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---- SEARCH: recursively find folders/files whose name matches the query ----
const SEARCH_PAGE_SIZE = 200;
const SEARCH_HARD_CAP = 5000; // bounds worst-case traversal time on a huge library / generic query

async function searchRecursive(relPath, needle, ctx) {
  if (ctx.stop) return;
  const full = safeResolve(relPath);
  let entries;
  try {
    entries = await fsp.readdir(full, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (ctx.stop) return;
    if (e.name.startsWith('.')) continue;
    const childRel = path.join(relPath, e.name);
    const isDir = e.isDirectory();
    if (e.name.toLowerCase().includes(needle)) {
      ctx.matchedCount++;
      if (ctx.matchedCount > ctx.offset && ctx.results.length < SEARCH_PAGE_SIZE) {
        let size = null;
        let counts = null;
        if (!isDir) {
          try { size = (await fsp.stat(path.join(full, e.name))).size; } catch {}
        } else {
          counts = await getFolderCounts(path.join(full, e.name));
        }
        ctx.results.push({
          name: e.name,
          path: childRel,
          isDir,
          isAudio: !isDir && isAudio(e.name),
          size,
          counts
        });
      }
      if (ctx.matchedCount >= SEARCH_HARD_CAP) {
        ctx.stop = true;
        ctx.hardCapped = true;
        return;
      }
    }
    if (isDir) {
      await searchRecursive(childRel, needle, ctx);
    }
  }
}

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ items: [], hasMore: false });
    const scope = req.query.scope || '';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const ctx = { results: [], matchedCount: 0, offset, stop: false, hardCapped: false };
    await searchRecursive(scope, q, ctx);
    const hasMore = ctx.hardCapped || (ctx.matchedCount - offset) > ctx.results.length;
    res.json({ items: ctx.results, hasMore });
  } catch (err) {
    logIssue(`GET /api/search?q=${req.query.q || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---- STREAM audio with range support ----
app.get('/api/stream', async (req, res) => {
  try {
    const rel = req.query.path;
    const full = safeResolve(rel);
    const stat = await fsp.stat(full);
    const range = req.headers.range;
    const mimeMap = { '.mp3':'audio/mpeg', '.flac':'audio/flac', '.m4a':'audio/mp4',
                       '.ogg':'audio/ogg', '.wav':'audio/wav', '.opus':'audio/opus',
                       '.aac':'audio/aac', '.wma':'audio/x-ms-wma' };
    const mime = mimeMap[path.extname(full).toLowerCase()] || 'application/octet-stream';

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunkSize = (end - start) + 1;
      const stream = fs.createReadStream(full, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(full).pipe(res);
    }
  } catch (err) {
    logIssue(`GET /api/stream?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(404).end();
  }
});

// ---- METADATA (title/artist/duration) + ALBUM ART ----
const metaCache = new Map(); // relPath -> { mtimeMs, data }

async function readMeta(rel) {
  const full = safeResolve(rel);
  const stat = await fsp.stat(full);
  const cached = metaCache.get(rel);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const mm = await import('music-metadata');
  let data;
  try {
    const parsed = await mm.parseFile(full, { duration: true, skipCovers: false });
    const rg = parsed.common.replaygain_track_gain;
    data = {
      title: parsed.common.title || path.basename(rel, path.extname(rel)),
      artist: parsed.common.artist || parsed.common.albumartist || '',
      album: parsed.common.album || '',
      duration: parsed.format.duration || null,
      hasArt: !!(parsed.common.picture && parsed.common.picture.length),
      replayGainDb: (rg && typeof rg.dB === 'number') ? rg.dB : null
    };
  } catch {
    data = { title: path.basename(rel, path.extname(rel)), artist: '', album: '', duration: null, hasArt: false, replayGainDb: null };
  }
  metaCache.set(rel, { mtimeMs: stat.mtimeMs, data });
  return data;
}

// ---- REPLAYGAIN: check on upload, measure + write tags if missing ----
const RG_TARGET_LUFS = -14.0;
const RG_MAX_PEAK_DBTP = -1.0;
const RG_TOLERANCE = 0.05;

function runFfmpeg(args) {
  return new Promise((resolve) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Extracts the leading numeric value from a tag string like "+2.34 dB" or "-14.00 LUFS".
function parseTagNumber(value) {
  if (!value) return null;
  const token = String(value).trim().split(/\s+/)[0];
  const v = parseFloat(token);
  return isNaN(v) ? null : v;
}

// Reads whatever gain/peak/loudness tags already exist, tolerantly matching
// either REPLAYGAIN_* (mp3/flac/m4a/ogg) or R128_TRACK_GAIN (Opus's native
// loudness tag) — mirrors get_existing_loudness_tags in normalize_songs.py.
async function getExistingReplayGainTags(full) {
  const found = {};
  try {
    const mm = await import('music-metadata');
    const parsed = await mm.parseFile(full, { duration: false, skipCovers: true });
    if (typeof parsed.common.replaygain_track_gain?.dB === 'number') {
      found.gain = `${parsed.common.replaygain_track_gain.dB} dB`;
    }
    if (typeof parsed.common.replaygain_track_peak?.dB === 'number') {
      found.peak = `${parsed.common.replaygain_track_peak.dB} dB`;
    } else if (typeof parsed.common.replaygain_track_peak?.ratio === 'number') {
      found.peak = `${parsed.common.replaygain_track_peak.ratio}`;
    }
    for (const entries of Object.values(parsed.native || {})) {
      for (const tag of entries) {
        const id = (tag.id || '').toUpperCase();
        const val = typeof tag.value === 'string' ? tag.value : (tag.value?.text || String(tag.value ?? ''));
        if (!found.gain && (id.includes('REPLAYGAIN_TRACK_GAIN') || id.includes('R128_TRACK_GAIN'))) found.gain = val;
        if (!found.peak && id.includes('REPLAYGAIN_TRACK_PEAK')) found.peak = val;
        if (!found.loudness && id.includes('REPLAYGAIN_TRACK_LOUDNESS')) found.loudness = val;
      }
    }
  } catch {}
  return found;
}

// Mirrors is_gain_consistent(): the applied gain can legitimately be lower
// than TARGET_LUFS - loudness (clamped by the peak ceiling) but never higher.
// Catches stale tags left by a different TARGET_LUFS or corrupted values.
function isGainConsistent(existing) {
  const gain = parseTagNumber(existing.gain);
  const loudness = parseTagNumber(existing.loudness);
  if (gain === null || loudness === null) return false;
  const expectedRawGain = RG_TARGET_LUFS - loudness;
  return gain <= expectedRawGain + RG_TOLERANCE;
}

async function needsReplayGainProcessing(full) {
  const existing = await getExistingReplayGainTags(full);
  if (!(existing.gain && existing.peak && existing.loudness)) return true;
  return !isGainConsistent(existing);
}

async function measureLoudnessAndPeak(full) {
  const { stderr } = await runFfmpeg(['-nostats', '-i', full, '-vn', '-filter_complex', '[0:a:0]ebur128=peak=true', '-f', 'null', '-']);
  let integratedLufs = null;
  let truePeakDb = null;
  for (const line of stderr.split('\n')) {
    if (line.includes('I:') && line.includes('LUFS')) {
      const parts = line.trim().split(/\s+/);
      const idx = parts.indexOf('LUFS');
      if (idx > 0) {
        const v = parseFloat(parts[idx - 1]);
        if (!isNaN(v)) integratedLufs = v;
      }
    }
    if (line.includes('Peak:') || line.includes('True peak:')) {
      const parts = line.trim().split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        if (['dBFS', 'dBTP', 'dB'].includes(parts[i]) && i > 0) {
          const v = parseFloat(parts[i - 1]);
          if (!isNaN(v)) truePeakDb = v;
        }
      }
    }
  }
  if (integratedLufs === null) return null;
  if (truePeakDb === null) truePeakDb = 0.0;
  const rawGain = RG_TARGET_LUFS - integratedLufs;
  const maxAllowedGain = RG_MAX_PEAK_DBTP - truePeakDb;
  const safeGain = Math.min(rawGain, maxAllowedGain);
  return { lufs: integratedLufs, peak: truePeakDb, gain: safeGain };
}

async function writeReplayGainTags(full, gain, peak, lufs) {
  const ext = path.extname(full).toLowerCase();
  const gainStr = `${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB`;
  const peakStr = `${peak.toFixed(2)} dB`;
  const lufsStr = `${lufs.toFixed(2)} LUFS`;
  const tmp = path.join(path.dirname(full), `.rgtmp_${Date.now()}${ext}`);
  const args = ['-y', '-loglevel', 'error', '-i', full, '-map', '0:a', '-c:a', 'copy'];
  if (ext === '.mp3') args.push('-id3v2_version', '3');
  args.push(
    '-metadata', `REPLAYGAIN_TRACK_GAIN=${gainStr}`,
    '-metadata', `REPLAYGAIN_TRACK_PEAK=${peakStr}`,
    '-metadata', `REPLAYGAIN_TRACK_LOUDNESS=${lufsStr}`,
    tmp
  );
  const { err } = await runFfmpeg(args);
  if (!err) {
    await fsp.rename(tmp, full);
    await fixPerms(full);
    return true;
  }
  try { await fsp.unlink(tmp); } catch {}
  return false;
}

// Best-effort: never let tagging failures break an upload.
async function ensureReplayGainTags(full) {
  try {
    if (!AUDIO_EXT.has(path.extname(full).toLowerCase())) return;
    if (!(await needsReplayGainProcessing(full))) return;
    const measurement = await measureLoudnessAndPeak(full);
    if (!measurement) {
      logIssue(`ReplayGain: loudness measurement failed for ${full} (ffmpeg produced no usable reading)`);
      return;
    }
    const ok = await writeReplayGainTags(full, measurement.gain, measurement.peak, measurement.lufs);
    if (!ok) {
      logIssue(`ReplayGain: failed to write tags to ${full}`);
      return;
    }
    if (path.extname(full).toLowerCase() === '.m4a') {
      // ffmpeg's generic -metadata write for MP4 freeform atoms isn't as
      // reliable as mutagen's explicit atom construction (which is why the
      // reference Python script special-cases m4a) — verify it actually took.
      const verify = await getExistingReplayGainTags(full);
      if (!(verify.gain && verify.peak && verify.loudness)) {
        logIssue(`ReplayGain: wrote tags to ${full} but could not verify them on re-read (m4a freeform-atom tagging can be unreliable via ffmpeg)`);
      }
    }
  } catch (err) {
    logIssue(`ReplayGain: unexpected error tagging ${full}: ${err.message}`);
  }
}

// ---- LIBRARY INDEX: full-library metadata for artist/album browsing ----
// Persisted to disk and updated incrementally (only files whose mtime changed
// get re-parsed), so the first scan is the only slow one.
const LIB_INDEX_FILE = path.join(DATA_DIR, 'library-index.json');
let libIndex = {};
let libIndexDirty = true;
let libScanPromise = null;
try { libIndex = JSON.parse(fs.readFileSync(LIB_INDEX_FILE, 'utf8')); } catch {}

function markLibraryDirty() { libIndexDirty = true; }

async function walkAudioFiles(rel, out) {
  const full = safeResolve(rel);
  let entries;
  try { entries = await fsp.readdir(full, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = path.join(rel, e.name);
    if (e.isDirectory()) await walkAudioFiles(childRel, out);
    else if (isAudio(e.name)) out.push(childRel);
  }
}

async function ensureLibraryIndex() {
  if (!libIndexDirty) return libIndex;
  if (libScanPromise) return libScanPromise;
  libScanPromise = (async () => {
    try {
      const files = [];
      await walkAudioFiles('', files);
      const next = {};
      const mm = await import('music-metadata');
      for (const rel of files) {
        try {
          const st = await fsp.stat(safeResolve(rel));
          const prev = libIndex[rel];
          if (prev && prev.mtimeMs === st.mtimeMs) { next[rel] = prev; continue; }
          const entry = {
            mtimeMs: st.mtimeMs, size: st.size,
            title: path.basename(rel, path.extname(rel)),
            artist: '', albumartist: '', album: '', year: null, duration: null, hasArt: false
          };
          try {
            const parsed = await mm.parseFile(safeResolve(rel), { duration: true, skipCovers: false });
            entry.title = parsed.common.title || entry.title;
            entry.artist = parsed.common.artist || '';
            entry.albumartist = parsed.common.albumartist || '';
            entry.album = parsed.common.album || '';
            entry.year = parsed.common.year || null;
            entry.duration = parsed.format.duration || null;
            entry.hasArt = !!(parsed.common.picture && parsed.common.picture.length);
          } catch {}
          next[rel] = entry;
        } catch {}
      }
      libIndex = next;
      libIndexDirty = false;
      try { fs.writeFileSync(LIB_INDEX_FILE, JSON.stringify(libIndex)); }
      catch (e) { logIssue(`library index save failed: ${e.message}`); }
      return libIndex;
    } finally {
      libScanPromise = null;
    }
  })();
  return libScanPromise;
}

function libSongItem(rel, e) {
  return { path: rel, name: path.basename(rel), isDir: false, isAudio: true, size: e.size };
}

app.get('/api/library/artist', async (req, res) => {
  try {
    const rawName = (req.query.name || '').trim();
    const name = rawName.toLowerCase();
    if (!name) return res.status(400).json({ error: 'name required' });
    const idx = await ensureLibraryIndex();
    const matches = [];
    for (const [rel, e] of Object.entries(idx)) {
      if ((e.artist || '').toLowerCase() === name || (e.albumartist || '').toLowerCase() === name) {
        matches.push({ rel, e });
      }
    }
    matches.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    const albumsMap = new Map();
    let totalDuration = 0, totalSize = 0;
    for (const { rel, e } of matches) {
      totalDuration += e.duration || 0;
      totalSize += e.size || 0;
      if (e.album) {
        const key = e.album.toLowerCase();
        if (!albumsMap.has(key)) {
          albumsMap.set(key, { name: e.album, year: e.year || null, artPath: e.hasArt ? rel : null });
        } else {
          const a = albumsMap.get(key);
          if (!a.artPath && e.hasArt) a.artPath = rel;
          if (!a.year && e.year) a.year = e.year;
        }
      }
    }
    res.json({
      name: rawName,
      songs: matches.map(({ rel, e }) => libSongItem(rel, e)),
      totalSongs: matches.length,
      totalDuration,
      totalSize,
      albums: [...albumsMap.values()].sort((a, b) => (a.year || 0) - (b.year || 0) || a.name.localeCompare(b.name))
    });
  } catch (err) {
    logIssue(`GET /api/library/artist?name=${req.query.name || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/library/album', async (req, res) => {
  try {
    const rawName = (req.query.name || '').trim();
    const name = rawName.toLowerCase();
    if (!name) return res.status(400).json({ error: 'name required' });
    const idx = await ensureLibraryIndex();
    const matches = [];
    for (const [rel, e] of Object.entries(idx)) {
      if ((e.album || '').toLowerCase() === name) matches.push({ rel, e });
    }
    matches.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    const artists = new Set();
    let totalDuration = 0, totalSize = 0, year = null, artPath = null;
    for (const { rel, e } of matches) {
      totalDuration += e.duration || 0;
      totalSize += e.size || 0;
      if (e.artist) artists.add(e.artist);
      if (!year && e.year) year = e.year;
      if (!artPath && e.hasArt) artPath = rel;
    }
    res.json({
      name: rawName,
      songs: matches.map(({ rel, e }) => libSongItem(rel, e)),
      totalSongs: matches.length,
      totalDuration,
      totalSize,
      artists: [...artists].sort((a, b) => a.localeCompare(b)),
      year,
      artPath
    });
  } catch (err) {
    logIssue(`GET /api/library/album?name=${req.query.name || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/meta', async (req, res) => {
  try {
    const rel = req.query.path;
    const data = await readMeta(rel);
    res.json(data);
  } catch (err) {
    logIssue(`GET /api/meta?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/art', async (req, res) => {
  try {
    const rel = req.query.path;
    const full = safeResolve(rel);
    const mm = await import('music-metadata');
    const parsed = await mm.parseFile(full, { duration: false, skipCovers: false });
    const pic = parsed.common.picture && parsed.common.picture[0];
    if (!pic) return res.status(404).end();
    res.writeHead(200, { 'Content-Type': pic.format, 'Cache-Control': 'public, max-age=86400' });
    res.end(pic.data);
  } catch (err) {
    logIssue(`GET /api/art?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(404).end();
  }
});

// ---- FILE MANAGEMENT ----
// ---- Move/rename that survives crossing filesystem boundaries (e.g. /tmp -> a mounted volume) ----
async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const stat = await fsp.stat(src);
    if (stat.isDirectory()) {
      await fsp.cp(src, dest, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    }
  }
  await fixPerms(dest);
}

// Make files/folders we create or move readable+writable by group/other too.
// Without this, files end up owned by whatever user the Node process runs as
// (root by default in this image) with restrictive mode bits, so any other
// process/user — e.g. an external script editing tags on the host — gets
// "permission denied" even though it can see the file.
async function fixPerms(target) {
  try {
    const stat = await fsp.stat(target);
    await fsp.chmod(target, stat.isDirectory() ? 0o777 : 0o666);
  } catch {}
}

app.post('/api/mkdir', requireAuth, async (req, res) => {
  try {
    const full = safeResolve(path.join(req.body.path || '', req.body.name));
    await fsp.mkdir(full, { recursive: true });
    await fixPerms(full);
    res.json({ ok: true });
  } catch (err) {
    logIssue(`POST /api/mkdir (${req.body.path || ''}/${req.body.name || ''}) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rename', requireAuth, async (req, res) => {
  try {
    const oldFull = safeResolve(req.body.path);
    const newFull = safeResolve(path.join(path.dirname(req.body.path), req.body.newName));
    await moveFile(oldFull, newFull);
    markLibraryDirty();
    res.json({ ok: true });
  } catch (err) {
    logIssue(`POST /api/rename (${req.body.path}) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/move', requireAuth, async (req, res) => {
  try {
    const src = safeResolve(req.body.path);
    const dest = safeResolve(path.join(req.body.destFolder, path.basename(req.body.path)));
    await moveFile(src, dest);
    markLibraryDirty();
    res.json({ ok: true });
  } catch (err) {
    logIssue(`POST /api/move (${req.body.path} -> ${req.body.destFolder}) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/delete', requireAuth, async (req, res) => {
  try {
    const full = safeResolve(req.body.path);
    await fsp.rm(full, { recursive: true, force: true });
    markLibraryDirty();
    res.json({ ok: true });
  } catch (err) {
    logIssue(`DELETE /api/delete (${req.body.path}) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

const upload = multer({ dest: '/tmp/musicapp-uploads' });
app.post('/api/upload', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const destFolder = req.body.path || '';
    const destFull = safeResolve(destFolder);
    await fsp.mkdir(destFull, { recursive: true });
    await fixPerms(destFull);
    for (const f of req.files) {
      const target = path.join(destFull, f.originalname);
      await moveFile(f.path, target);
      await ensureReplayGainTags(target);
      metaCache.delete(path.join(destFolder, f.originalname));
    }
    markLibraryDirty();
    res.json({ ok: true });
  } catch (err) {
    logIssue(`POST /api/upload (to ${req.body.path || ''}) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---- PLAYLISTS ----
function loadPlaylists() {
  return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
}
function savePlaylists(data) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/playlists', (req, res) => {
  res.json(loadPlaylists());
});

app.post('/api/playlists/:name', requireAuth, async (req, res) => {
  try {
    const playlists = loadPlaylists();
    const name = req.params.name;
    if (!playlists[name]) playlists[name] = [];
    let filesToAdd = req.body.files || [];
    const folders = req.body.folders || [];
    for (const folder of folders) {
      const expanded = await listAudioRecursive(folder);
      filesToAdd = filesToAdd.concat(expanded);
    }
    playlists[name] = playlists[name].concat(filesToAdd);
    savePlaylists(playlists);
    res.json({ ok: true, playlist: playlists[name] });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name} (add) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/playlists/:name', requireAuth, (req, res) => {
  try {
    const playlists = loadPlaylists();
    delete playlists[req.params.name];
    savePlaylists(playlists);
    res.json({ ok: true });
  } catch (err) {
    logIssue(`DELETE /api/playlists/${req.params.name} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/playlists/:name/rename', requireAuth, (req, res) => {
  try {
    const playlists = loadPlaylists();
    const oldName = req.params.name;
    const newName = (req.body.newName || '').trim();
    if (!newName) return res.status(400).json({ error: 'newName is required' });
    if (!(oldName in playlists)) return res.status(404).json({ error: 'Playlist not found' });
    const tracks = playlists[oldName];
    delete playlists[oldName];
    playlists[newName] = (playlists[newName] || []).concat(tracks);
    savePlaylists(playlists);
    res.json({ ok: true, playlist: playlists[newName] });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name}/rename failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/playlists/:name/remove', requireAuth, (req, res) => {
  try {
    const playlists = loadPlaylists();
    const name = req.params.name;
    if (playlists[name]) {
      playlists[name] = playlists[name].filter(f => f !== req.body.file);
      savePlaylists(playlists);
    }
    res.json({ ok: true, playlist: playlists[name] || [] });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name}/remove failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/playlists/:name/reorder', requireAuth, (req, res) => {
  try {
    const playlists = loadPlaylists();
    const name = req.params.name;
    if (!(name in playlists)) return res.status(404).json({ error: 'Playlist not found' });
    const from = Number(req.body.from);
    const to = Number(req.body.to);
    const list = playlists[name];
    if (!Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || from >= list.length || to < 0 || to >= list.length) {
      return res.status(400).json({ error: 'from/to must be valid indices into the playlist' });
    }
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    savePlaylists(playlists);
    res.json({ ok: true, playlist: list });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name}/reorder failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3838;
app.listen(PORT, () => console.log(`Music app running on port ${PORT}, serving ${MUSIC_ROOT}`));