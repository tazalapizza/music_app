const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const { execFile } = require('child_process');
const crypto = require('crypto');
const NodeID3 = require('node-id3');
const { LRUCache } = require('lru-cache');

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

// Periodic cleanup so this map doesn't grow unbounded over a long uptime -
// isValidSession() only removes an entry when that specific token is
// checked again, so an abandoned expired token would otherwise sit here
// forever. Mirrors the loginAttempts janitor below.
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

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
// Subdirectories are recursed into concurrently (Promise.all) rather than
// one at a time — a folder with many nested subfolders previously paid for
// every subfolder's readdir sequentially, one full round-trip after
// another, which is what made "play folder" on a large/deeply-nested
// library feel like it hung for several seconds before the first track
// even started. Sibling entries have no ordering dependency on each other,
// so there's nothing lost by kicking them all off at once; the recursive
// re-sort below restores the original per-directory ordering afterward
// exactly as before.
async function listAudioRecursive(relPath) {
  const full = safeResolve(relPath);
  const stat = await fsp.stat(full);
  if (stat.isFile()) {
    return isAudio(relPath) ? [relPath] : [];
  }
  const entries = (await fsp.readdir(full, { withFileTypes: true }))
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const perEntryResults = await Promise.all(entries.map(async e => {
    const childRel = path.join(relPath, e.name);
    if (e.isDirectory()) return listAudioRecursive(childRel);
    return isAudio(e.name) ? [childRel] : [];
  }));
  return perEntryResults.flat();
}

// Fast path for the first N tracks of a folder, so the client can start
// filling the queue immediately instead of waiting for listAudioRecursive
// (below) to walk the entire subtree - for a large/deeply-nested folder that
// full walk can take long enough that the queue sits at just the one
// already-playing track the whole time.
//
// Reads from libIndex (the persisted, in-memory library index - see
// "LIBRARY INDEX" further down) the same way pickRandomIndexedFile() does
// for /api/expand/first: filtering already-loaded keys by path prefix
// touches no filesystem, so this resolves near-instantly regardless of
// folder size.
//
// Selection is a random sample across every matching path, NOT "the first N
// alphabetically" - an alphabetical slice systematically favors whichever
// subfolder happens to sort first (e.g. a multi-disc album's CD1 would fill
// the entire batch before CD2 ever got a single track in), which then stayed
// biased even after the client shuffles this batch, since shuffling only
// reorders whichever tracks were already selected - it can't introduce
// tracks that were never included in the first place. A random sample here
// is what the client-side shuffle actually assumes it's working with: an
// unbiased cross-section of the folder, not a biased one in random order.
// Falls back to returning everything (still shuffled) if there are fewer
// matching paths than the requested limit, same end result as before just
// via a different (equivalent, since sampling all of a small pool is the
// same as taking all of it) code path.
//
// The full /api/expand call the client makes afterward is still what
// determines the final, authoritative full listing and its real order -
// this is only ever a temporary head start.
//
// Falls back to an empty result (not an error) if the index has nothing
// under this folder yet (e.g. no scan since server start) - the caller
// already has to handle the full /api/expand response regardless, so an
// empty fast-path result just means no head start this time.
app.get('/api/expand/limit', async (req, res) => {
  try {
    const rel = req.query.path || '';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 500));
    const prefix = rel ? rel.replace(/[\\/]+$/, '') + path.sep : '';
    const matching = Object.keys(libIndex).filter(p => !prefix || p.startsWith(prefix));
    let files;
    if (matching.length <= limit) {
      files = matching;
    } else {
      // Partial Fisher-Yates: only shuffle as many positions as needed to
      // fill `limit`, rather than shuffling (and sorting) the entire
      // possibly-huge matching set just to take a slice of it.
      for (let i = 0; i < limit; i++) {
        const j = i + Math.floor(Math.random() * (matching.length - i));
        [matching[i], matching[j]] = [matching[j], matching[i]];
      }
      files = matching.slice(0, limit);
    }
    res.json({ files });
  } catch (err) {
    logIssue(`GET /api/expand/limit?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

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

// Finds a single audio file under a folder as fast as possible, for "play
// folder" to start audible playback immediately instead of waiting on the
// full recursive listing (see listAudioRecursive above) — that full walk
// is unavoidably proportional to folder size, so for a folder with
// thousands of files across many subfolders it's the entire multi-second
// delay between the click and any sound.
//
// Preferred path: pick uniformly at random from libIndex, the in-memory
// (and disk-persisted) full-library metadata map keyed by relative path —
// see "LIBRARY INDEX" below. Filtering its already-loaded keys by path
// prefix touches no filesystem at all, so this resolves essentially
// instantly regardless of folder size, and gives an actually-random first
// track rather than always the alphabetically-first one. libIndex is read
// directly here (not through ensureLibraryIndex(), which can await a full
// rescan if dirty) precisely because that potential rescan wait is exactly
// what this needs to avoid; a slightly-stale index is fine for "give me
// any playable file right now."
//
// Fallback: if the index has no entries under this folder yet (e.g.
// nothing has triggered a library scan since server start, or the folder
// was created since), fall back to a live filesystem search that stops at
// the first audio file found instead of enumerating the whole subtree.
function pickRandomIndexedFile(relPath) {
  const prefix = relPath ? relPath.replace(/[\\/]+$/, '') + path.sep : '';
  const candidates = Object.keys(libIndex).filter(p => !prefix || p.startsWith(prefix));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function findFirstAudioFile(relPath) {
  const full = safeResolve(relPath);
  const stat = await fsp.stat(full);
  if (stat.isFile()) return isAudio(relPath) ? relPath : null;
  const entries = (await fsp.readdir(full, { withFileTypes: true }))
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (!e.isDirectory() && isAudio(e.name)) return path.join(relPath, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findFirstAudioFile(path.join(relPath, e.name));
      if (found) return found;
    }
  }
  return null;
}

app.get('/api/expand/first', async (req, res) => {
  try {
    const rel = req.query.path || '';
    const indexed = pickRandomIndexedFile(rel);
    const file = indexed || await findFirstAudioFile(rel);
    res.json({ file });
  } catch (err) {
    logIssue(`GET /api/expand/first?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---- SEARCH: recursively find folders/files whose name matches the query ----
const SEARCH_PAGE_SIZE = 200;
const SEARCH_HARD_CAP = 5000; // bounds worst-case traversal time on a huge library / generic query

// Directory structure (names/nesting) isn't tracked by libIndex, so folder
// matches and folder counts still require a real readdir walk. Audio file
// matches, however, are resolved from libIndex (size, no stat() needed)
// instead of touching the filesystem per match - this is the expensive part
// for large libraries since it used to mean a stat() call for every hit.
async function searchRecursive(relPath, needle, ctx, idx) {
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
          const indexed = idx[childRel];
          if (indexed) size = indexed.size;
          else { try { size = (await fsp.stat(path.join(full, e.name))).size; } catch {} }
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
      await searchRecursive(childRel, needle, ctx, idx);
    }
  }
}

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ items: [], hasMore: false });
    const scope = req.query.scope || '';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const idx = await ensureLibraryIndex();
    const ctx = { results: [], matchedCount: 0, offset, stop: false, hardCapped: false };
    await searchRecursive(scope, q, ctx, idx);
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
// Entries are small (a few strings/numbers), so capping by entry count is
// enough here - unlike artCache, which caps by byte size.
const metaCache = new LRUCache({ max: 20000 }); // relPath -> { mtimeMs, data }

// Many tracks in an album folder typically embed the exact same cover art.
// Rather than each track's row fetching/parsing/serving that image
// independently (same bytes, N separate requests), readMeta() also computes
// a content hash of the embedded art, and the client groups tracks sharing a
// hash onto one shared /api/art-by-hash URL - browsers dedupe repeated
// requests to the same URL, so the image loads once instead of N times.
//
// artHashIndex is just a *hint* (hash -> a path last known to carry that
// art), not a source of truth: it's rebuilt opportunistically as files are
// read, capped in size, and never persisted. If the specific file it points
// to is later deleted/moved/retagged, /api/art-by-hash re-resolves using the
// fallback path the client sends alongside the hash (see that endpoint) -
// so a stale hint degrades to "one extra file read", never a broken image.
const artHashIndex = new LRUCache({ max: 20000 }); // hash -> relPath

function hashArtBuffer(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// ---- Concurrency limiter for metadata parsing ----
// music-metadata is called with skipCovers:false in readMeta() below,
// because artHash (the dedup key that lets many tracks sharing one embedded
// cover all point at a single /api/art-by-hash URL) can only be computed
// from the actual decoded picture bytes. That means every readMeta() call
// on a track with embedded art briefly holds that full image (often
// several MB, sometimes much more for high-res/uncompressed covers) in
// memory for the duration of the parse.
//
// /api/meta/batch parses up to META_BATCH_LIMIT paths via Promise.all - if
// that ran fully unbounded, a single batch for a large folder could hold
// hundreds of these image buffers in memory simultaneously (500 tracks x a
// few MB each is a multi-hundred-MB to multi-GB transient spike), and nothing
// stops multiple such batches - from multiple tabs, or the queue vs. the
// folder browser vs. a playlist all prefetching around the same time - from
// piling up concurrently on top of each other. On a host without a memory
// limit set (see docker-compose.yml), that's enough to trigger an OOM kill
// of the whole container, which is indistinguishable from "the server just
// restarted" from the outside.
//
// This runs every readMeta() parse (regardless of caller - single /api/meta
// requests, batch requests, from any tab) through one shared pool capped at
// a fixed number of concurrent parses, process-wide, so peak memory from
// this specific workload stays bounded no matter how many requests ask for
// it at once.
const META_PARSE_CONCURRENCY = 8;
let metaParseActive = 0;
const metaParseWaiters = [];
async function withMetaParseSlot(fn) {
  if (metaParseActive >= META_PARSE_CONCURRENCY) {
    await new Promise(resolve => metaParseWaiters.push(resolve));
  }
  metaParseActive++;
  try {
    return await fn();
  } finally {
    metaParseActive--;
    const next = metaParseWaiters.shift();
    if (next) next();
  }
}

async function readMeta(rel) {
  const full = safeResolve(rel);
  const stat = await fsp.stat(full);
  const cached = metaCache.get(rel);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const mm = await import('music-metadata');
  let data;
  try {
    const parsed = await withMetaParseSlot(() => mm.parseFile(full, { duration: true, skipCovers: false }));
    const rg = parsed.common.replaygain_track_gain;
    const pic = parsed.common.picture && parsed.common.picture[0];
    let artHash = null;
    if (pic && pic.data && pic.data.length) {
      artHash = hashArtBuffer(pic.data);
      artHashIndex.set(artHash, rel); // opportunistic hint, see comment above artHashIndex
    }
    data = {
      title: parsed.common.title || path.basename(rel, path.extname(rel)),
      artist: parsed.common.artist || parsed.common.albumartist || '',
      album: parsed.common.album || '',
      duration: parsed.format.duration || null,
      hasArt: !!(parsed.common.picture && parsed.common.picture.length),
      artHash,
      replayGainDb: (rg && typeof rg.dB === 'number') ? rg.dB : null
    };
  } catch {
    data = { title: path.basename(rel, path.extname(rel)), artist: '', album: '', duration: null, hasArt: false, artHash: null, replayGainDb: null };
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

// Handles both "N" and "N/total" formats - music-metadata usually parses
// track/disc numbers into a clean integer, but some tag formats (or slightly
// malformed ones) leak the raw "N/total" string through instead.
function parseTrackOrDiscNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const m = String(value).trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

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
          const discOk = prev && (prev.disc === null || typeof prev.disc === 'number');
          if (prev && prev.mtimeMs === st.mtimeMs && discOk) { next[rel] = prev; continue; }
          const entry = {
            mtimeMs: st.mtimeMs, size: st.size,
            title: path.basename(rel, path.extname(rel)),
            artist: '', albumartist: '', album: '', year: null, duration: null, hasArt: false,
            track: null, disc: null
          };
          try {
            // skipCovers:true here (unlike readMeta() above) - this scan only
            // needs hasArt as a boolean, never the actual picture bytes, so
            // there's no reason to decode/hold potentially large embedded
            // images in memory for every track in the entire library during a
            // full scan.
            const parsed = await withMetaParseSlot(() => mm.parseFile(safeResolve(rel), { duration: true, skipCovers: true }));
            entry.title = parsed.common.title || entry.title;
            entry.artist = parsed.common.artist || '';
            entry.albumartist = parsed.common.albumartist || '';
            entry.album = parsed.common.album || '';
            entry.year = parsed.common.year || null;
            entry.duration = parsed.format.duration || null;
            entry.hasArt = !!(parsed.common.picture && parsed.common.picture.length);
            entry.track = parseTrackOrDiscNumber(parsed.common.track && parsed.common.track.no);
            entry.disc = parseTrackOrDiscNumber(parsed.common.disk && parsed.common.disk.no);
          } catch {}
          next[rel] = entry;
        } catch {}
      }
      libIndex = next;
      libIndexDirty = false;
      // Write to a temp file then rename over the real one - rename is atomic
      // on POSIX, so a crash mid-write can't leave library-index.json
      // truncated/corrupted, and using the async fs API here (vs the previous
      // writeFileSync) avoids blocking the event loop while the JSON for a
      // large library is serialized and flushed to disk.
      try {
        const tmpFile = `${LIB_INDEX_FILE}.tmp`;
        await fsp.writeFile(tmpFile, JSON.stringify(libIndex));
        await fsp.rename(tmpFile, LIB_INDEX_FILE);
      }
      catch (e) { logIssue(`library index save failed: ${e.message}`); }
      return libIndex;
    } finally {
      libScanPromise = null;
    }
  })();
  return libScanPromise;
}

function libSongItem(rel, e) {
  return { path: rel, name: path.basename(rel), isDir: false, isAudio: true, size: e.size, track: e.track, disc: e.disc, album: e.album };
}

app.post('/api/library/rebuild', requireAuth, async (req, res) => {
  try {
    markLibraryDirty();
    const idx = await ensureLibraryIndex();
    res.json({ ok: true, songCount: Object.keys(idx).length });
  } catch (err) {
    logIssue(`POST /api/library/rebuild failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

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

// Lists every distinct album in the library with just enough to render a
// picker/carousel (name, representative art, year, song count) - unlike
// /api/library/album below, this never needs a `name` and returns one row
// per album rather than every song. Used by the mobile landscape "album
// carousel" view (see albums-carousel.js) to populate its horizontal strip
// without asking the client to fetch and dedupe every track in the library
// itself just to find the distinct album set.
app.get('/api/library/albums', async (req, res) => {
  try {
    const idx = await ensureLibraryIndex();
    const albumsMap = new Map();
    for (const [rel, e] of Object.entries(idx)) {
      if (!e.album) continue;
      const key = e.album.toLowerCase();
      let a = albumsMap.get(key);
      if (!a) {
        a = { name: e.album, year: e.year || null, artPath: e.hasArt ? rel : null, songCount: 0 };
        albumsMap.set(key, a);
      }
      a.songCount++;
      if (!a.artPath && e.hasArt) a.artPath = rel;
      if (!a.year && e.year) a.year = e.year;
    }
    const albums = [...albumsMap.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({ albums });
  } catch (err) {
    logIssue(`GET /api/library/albums failed: ${err.message}`);
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

// Batch metadata lookup - used when rendering a folder listing, so the client
// doesn't have to fire one /api/meta request per audio row. Each path is read
// through the same metaCache as the single-path endpoint, so results are
// equally cheap on repeat calls; failures for individual paths don't fail
// the whole batch.
const META_BATCH_LIMIT = 100;
app.post('/api/meta/batch', async (req, res) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths.slice(0, META_BATCH_LIMIT) : [];
    const results = await Promise.all(paths.map(async (rel) => {
      try { return { path: rel, data: await readMeta(rel) }; }
      catch { return { path: rel, data: null }; }
    }));
    const byPath = {};
    for (const { path: rel, data } of results) byPath[rel] = data;
    res.json({ meta: byPath });
  } catch (err) {
    logIssue(`POST /api/meta/batch failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Embedded art can be a few MB per track, so this cache is capped by total
// bytes held rather than entry count. Keyed by path+mtime (like metaCache) so
// a re-tagged/re-embedded file naturally invalidates its old cached art.
const artCache = new LRUCache({
  maxSize: 200 * 1024 * 1024, // 200MB of art bytes across all cached tracks
  sizeCalculation: (entry) => entry.data.length,
});

// Reads (and caches) the embedded art for a given relative path. Returns
// null if the file is missing/unreadable or has no embedded art, rather than
// throwing, so callers (both /api/art and /api/art-by-hash) can fall back
// to another candidate path instead of failing outright.
async function readArtEntry(rel) {
  const full = safeResolve(rel);
  const stat = await fsp.stat(full);
  const cacheKey = `${rel}:${stat.mtimeMs}`;
  let entry = artCache.get(cacheKey);
  if (!entry) {
    const mm = await import('music-metadata');
    const parsed = await mm.parseFile(full, { duration: false, skipCovers: false });
    const pic = parsed.common.picture && parsed.common.picture[0];
    if (!pic) { entry = { missing: true, data: Buffer.alloc(0) }; }
    else { entry = { format: pic.format, data: pic.data }; }
    artCache.set(cacheKey, entry);
  }
  return entry.missing ? null : entry;
}

app.get('/api/art', async (req, res) => {
  try {
    const rel = req.query.path;
    const entry = await readArtEntry(rel);
    if (!entry) return res.status(404).end();
    res.writeHead(200, { 'Content-Type': entry.format, 'Cache-Control': 'public, max-age=86400' });
    res.end(entry.data);
  } catch (err) {
    logIssue(`GET /api/art?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(404).end();
  }
});

// Serves art by content hash rather than by any one track's path, so a group
// of tracks that share identical embedded art can all point at the same URL
// and let the browser fetch/cache it once instead of once per track.
//
// Edge case this exists to handle: the path artHashIndex has on file for
// this hash may no longer be valid (deleted, moved, retagged since). So:
//   1. Try the hinted path from artHashIndex, but verify its art still
//      actually hashes to what was asked for (catches silent retagging,
//      not just deletion).
//   2. If that fails, try the client-supplied `fallback` path - the client
//      always sends the path of some track it currently knows carries this
//      art, from its own just-fetched batch metadata, as a safety net.
//   3. If both fail, 404 - the client's <img onerror> already falls back to
//      the generic note icon, same as a normal missing-art case today.
// Either fallback path also means one extra file read at worst, never a
// broken image just because the original hinted file is gone.
app.get('/api/art-by-hash', async (req, res) => {
  try {
    const hash = req.query.hash;
    const fallbackPath = req.query.fallback;
    if (!hash) return res.status(400).end();

    const hinted = artHashIndex.get(hash);
    if (hinted) {
      try {
        const entry = await readArtEntry(hinted);
        if (entry && hashArtBuffer(entry.data) === hash) {
          res.writeHead(200, { 'Content-Type': entry.format, 'Cache-Control': 'public, max-age=86400' });
          return res.end(entry.data);
        }
      } catch {} // hinted path is gone/unreadable - fall through to fallbackPath
    }

    if (fallbackPath) {
      const entry = await readArtEntry(fallbackPath);
      if (entry && hashArtBuffer(entry.data) === hash) {
        artHashIndex.set(hash, fallbackPath); // refresh the hint so future requests skip straight to a working path
        res.writeHead(200, { 'Content-Type': entry.format, 'Cache-Control': 'public, max-age=86400' });
        return res.end(entry.data);
      }
    }

    res.status(404).end();
  } catch (err) {
    logIssue(`GET /api/art-by-hash?hash=${req.query.hash || ''} failed: ${err.message}`);
    res.status(404).end();
  }
});

// ---- METADATA EDITING ----
// ---- LYRICS ----
// Reads whatever lyrics tag is present, regardless of container format, as a raw
// string (LRC-timestamped or plain). We read the NATIVE tag directly rather than
// music-metadata's parsed common.lyrics, because that field's shape differs by
// format (some containers get auto-split into {text, syncText}, others don't) -
// reading natively gives one consistent raw string we parse ourselves everywhere.
function extractRawLyrics(parsed) {
  for (const entries of Object.values(parsed.native || {})) {
    for (const tag of entries) {
      const id = (tag.id || '').toUpperCase();
      if (!id.includes('LYR') && id !== 'USLT') continue;
      const val = tag.value;
      if (typeof val === 'string' && val) return val;
      if (val && typeof val.text === 'string' && val.text) return val.text;
    }
  }
  return null;
}

app.get('/api/lyrics', async (req, res) => {
  try {
    const rel = req.query.path;
    const full = safeResolve(rel);
    const mm = await import('music-metadata');
    const parsed = await mm.parseFile(full, { duration: false, skipCovers: true });
    res.json({ lyrics: extractRawLyrics(parsed) || '' });
  } catch (err) {
    logIssue(`GET /api/lyrics?path=${req.query.path || ''} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Proxies LRCLIB (https://lrclib.net/docs) so the browser doesn't need CORS
// access and so we can derive the query from the file's own current tags
// rather than trusting arbitrary client-supplied values.
app.post('/api/lyrics/fetch', async (req, res) => {
  try {
    const rel = req.body.path;
    const full = safeResolve(rel);
    const mm = await import('music-metadata');
    const parsed = await mm.parseFile(full, { duration: true, skipCovers: true });
    const title = parsed.common.title || '';
    const artist_name = parsed.common.artist || parsed.common.albumartist || '';
    const album_name = parsed.common.album || '';
    const duration = parsed.format.duration ? Math.round(parsed.format.duration) : null;
    const filenameStem = path.basename(rel, path.extname(rel));
    const headers = { 'User-Agent': 'musicapp/1.0 (self-hosted; https://github.com)' };

    async function tryGet(track_name, artist, album, dur) {
      try {
        const params = new URLSearchParams({ track_name, artist_name: artist });
        if (album) params.set('album_name', album);
        if (dur) params.set('duration', String(dur));
        const r = await fetch(`https://lrclib.net/api/get?${params}`, { headers });
        if (r.ok) {
          const data = await r.json();
          if (data && (data.syncedLyrics || data.plainLyrics)) return data;
        }
      } catch (e) {
        logIssue(`lyrics fetch (get) network error for ${rel}: ${e.message}`);
      }
      return null;
    }

    function durationMismatch(resultDuration, targetDuration) {
      return !!(targetDuration && resultDuration && Math.abs(resultDuration - targetDuration) > 5);
    }

    function scoreResult(result, targetTitle, targetArtist, targetDuration) {
      // Higher is better. Weighted so a lower-priority factor can never
      // outweigh a higher-priority one, matching the requested preference
      // order: title match, then artist match, then close duration.
      // Results more than 5s off in duration never reach this function at
      // all - see bestResult()/durationMismatch().
      let score = 0;
      const resultTitle = (result.trackName || '').trim().toLowerCase();
      const wantedTitle = (targetTitle || '').trim().toLowerCase();
      if (wantedTitle && resultTitle) {
        if (resultTitle === wantedTitle) score += 1000;
        else if (wantedTitle.includes(resultTitle) || resultTitle.includes(wantedTitle)) score += 500;
      }
      const resultArtist = (result.artistName || '').trim().toLowerCase();
      const wantedArtist = (targetArtist || '').trim().toLowerCase();
      if (wantedArtist && resultArtist === wantedArtist) score += 500;
      if (targetDuration && result.duration) {
        const diff = Math.abs(result.duration - targetDuration);
        if (diff <= 1) score += 200;
        else if (diff <= 3) score += 100;
        else score += 40;
      }
      return score;
    }

    function bestResult(results, targetTitle, targetArtist, targetDuration) {
      let usable = results.filter(r => r && (r.syncedLyrics || r.plainLyrics));
      usable = usable.filter(r => !durationMismatch(r.duration, targetDuration));
      if (!usable.length) return null;
      usable.sort((a, b) => scoreResult(b, targetTitle, targetArtist, targetDuration) - scoreResult(a, targetTitle, targetArtist, targetDuration));
      return usable[0];
    }

    async function trySearch(track_name, artist, targetDuration) {
      try {
        const params = new URLSearchParams({ track_name });
        if (artist) params.set('artist_name', artist);
        const r = await fetch(`https://lrclib.net/api/search?${params}`, { headers });
        if (r.ok) {
          const results = await r.json();
          if (Array.isArray(results) && results.length) {
            const data = bestResult(results, track_name, artist, targetDuration);
            if (data) return data;
          }
        }
      } catch (e) {
        logIssue(`lyrics fetch (search) network error for ${rel}: ${e.message}`);
      }
      return null;
    }

    // Progressive fallback - real-world tags are often incomplete. Each step
    // only runs if the previous one found nothing. Requests are sequential
    // (awaited one at a time), per LRCLIB's own API guidance. /api/get is a
    // signature lookup, so it always returns the same canonical record for
    // a given track regardless of which fields are dropped - dropping
    // fields only helps it match at all, it can't surface an alternate,
    // synced release. So once a GET hits, the loop stops (no point re-
    // querying for the same record) but keeps an unsynced hit as a
    // fallback and still lets SEARCH run afterwards, since search can
    // return a different, synced release of the same track.
    let data = null;
    let matchedVia = null;
    if (title && artist_name) {
      const getRungs = [
        ['get:track+artist+album+duration', album_name, duration],
        ['get:track+artist+album', album_name, null],
        ['get:track+artist+duration', null, duration],
        ['get:track+artist', null, null]
      ];
      for (const [via, album, dur] of getRungs) {
        if (via === 'get:track+artist+album' && !album_name) continue;
        const result = await tryGet(title, artist_name, album, dur);
        if (result) { data = result; matchedVia = via; break; }
      }
    }
    if (!data || !data.syncedLyrics) {
      let searched = null;
      let searchedVia = null;
      if (title) {
        searched = await trySearch(title, artist_name, duration);
        searchedVia = 'search:track+artist';
      }
      if (!searched && !data) {
        searched = await trySearch(filenameStem, null, duration);
        searchedVia = 'search:filename';
      }
      if (searched && (!data || searched.syncedLyrics)) { data = searched; matchedVia = searchedVia; }
    }

    if (!data) {
      return res.json({ found: false });
    }
    res.json({
      found: true,
      lyrics: data.syncedLyrics || data.plainLyrics,
      synced: !!data.syncedLyrics,
      matchedVia
    });
  } catch (err) {
    logIssue(`POST /api/lyrics/fetch failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});


// Looks up tag metadata on MusicBrainz from a filename (parsed as "Artist -
// Title") and the file's own duration, since that's often all a stray
// download has going for it. Duration is used to rank/filter candidates
// (recordings vary in length across releases/remasters), same idea as the
// LRCLIB duration matching above.
function parseArtistTitleFromFilename(name) {
  const stem = path.basename(name, path.extname(name));
  const idx = stem.indexOf(' - ');
  if (idx === -1) return { artist: '', title: stem.trim() };
  return { artist: stem.slice(0, idx).trim(), title: stem.slice(idx + 3).trim() };
}

function scoreMbResult(recording, targetDuration) {
  let score = Number(recording.score) || 0;
  if (targetDuration && recording.length) {
    const diff = Math.abs(Math.round(recording.length / 1000) - targetDuration);
    if (diff <= 1) score += 200;
    else if (diff <= 3) score += 100;
    else if (diff <= 8) score += 40;
  }
  return score;
}

app.post('/api/edit-meta/lookup', requireAuth, async (req, res) => {
  try {
    const rel = req.body.path;
    const full = safeResolve(rel);
    const mm = await import('music-metadata');
    const parsed = await mm.parseFile(full, { duration: true, skipCovers: true });
    const duration = parsed.format.duration ? Math.round(parsed.format.duration) : null;
    const { artist, title } = parseArtistTitleFromFilename(rel);
    if (!title) return res.json({ results: [] });

    const query = artist
      ? `recording:"${title}" AND artist:"${artist}"`
      : `recording:"${title}"`;
    const params = new URLSearchParams({ query, fmt: 'json', limit: '10' });
    const headers = { 'User-Agent': 'musicapp/1.0 (self-hosted; https://github.com)' };

    // MusicBrainz enforces a strict ~1 req/sec rate limit per IP and answers
    // over-limit requests with 503 (not a "no results" response) - retry a
    // couple of times with backoff rather than surfacing that as "not found".
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(`https://musicbrainz.org/ws/2/recording?${params}`, { headers });
      if (r.status !== 503) break;
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
    if (!r.ok) return res.json({ results: [] });
    const data = await r.json();
    const recordings = Array.isArray(data.recordings) ? data.recordings : [];

    const results = recordings
      .map(rec => {
        const release = (rec.releases && rec.releases[0]) || null;
        return {
          title: rec.title || '',
          artist: (rec['artist-credit'] || []).map(a => a.name).join(', '),
          album: release ? release.title || '' : '',
          releaseId: release ? release.id : null,
          year: release && release.date ? release.date.slice(0, 4) : '',
          track: release && release.media && release.media[0] && release.media[0].track
            ? release.media[0].track[0].number : '',
          durationSec: rec.length ? Math.round(rec.length / 1000) : null,
          score: scoreMbResult(rec, duration)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Cover Art Archive lookups are one HTTP round-trip per release, so only
    // done for the (already trimmed) top 5, in parallel, and never allowed to
    // fail the whole lookup - a missing/slow cover just means no thumbnail.
    await Promise.all(results.map(async (result) => {
      if (!result.releaseId) return;
      try {
        const artRes = await fetch(`https://coverartarchive.org/release/${result.releaseId}/front-250`, { headers, redirect: 'follow' });
        if (artRes.ok) result.artThumbUrl = artRes.url;
      } catch {}
    }));

    res.json({ results, queried: { artist, title, duration } });
  } catch (err) {
    logIssue(`POST /api/edit-meta/lookup failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Downloads a Cover Art Archive image server-side and hands it back as
// base64 so the browser can embed it via setArtAction() the same way as an
// uploaded file - CAA doesn't reliably send CORS headers, so a client-side
// fetch() of the image can't be trusted to work.
app.get('/api/edit-meta/lookup-art', requireAuth, async (req, res) => {
  try {
    const releaseId = req.query.releaseId;
    if (!/^[0-9a-f-]{36}$/i.test(releaseId || '')) return res.status(400).json({ error: 'invalid releaseId' });
    const headers = { 'User-Agent': 'musicapp/1.0 (self-hosted; https://github.com)' };
    const artRes = await fetch(`https://coverartarchive.org/release/${releaseId}/front`, { headers, redirect: 'follow' });
    if (!artRes.ok) return res.status(404).json({ error: 'not found' });
    const mime = artRes.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await artRes.arrayBuffer());
    res.json({ data: buf.toString('base64'), mime });
  } catch (err) {
    logIssue(`GET /api/edit-meta/lookup-art failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/edit-meta/get', async (req, res) => {
  try {
    const paths = req.body.paths || [];
    const mm = await import('music-metadata');
    // Promise.all + map preserves result order to match `paths`, regardless
    // of which file finishes parsing first - needed since this maps 1:1 back
    // to the selected tracks in the batch editor UI.
    const files = await Promise.all(paths.map(async (rel) => {
      try {
        const full = safeResolve(rel);
        const parsed = await mm.parseFile(full, { duration: true, skipCovers: false });
        return {
          path: rel,
          name: path.basename(rel),
          title: parsed.common.title || '',
          artist: parsed.common.artist || '',
          album: parsed.common.album || '',
          year: parsed.common.year || '',
          track: parseTrackOrDiscNumber(parsed.common.track && parsed.common.track.no) ?? '',
          disc: parseTrackOrDiscNumber(parsed.common.disk && parsed.common.disk.no) ?? '',
          lyrics: extractRawLyrics(parsed) || '',
          hasArt: !!(parsed.common.picture && parsed.common.picture.length)
        };
      } catch {
        return { path: rel, name: path.basename(rel), title: '', artist: '', album: '', year: '', track: '', disc: '', lyrics: '', hasArt: false };
      }
    }));
    res.json({ files });
  } catch (err) {
    logIssue(`POST /api/edit-meta/get failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Builds a FLAC picture block (the payload of a Vorbis METADATA_BLOCK_PICTURE
// comment) for embedding art into ogg/opus, which ffmpeg can't do via an
// attached-pic stream. All fields big-endian per spec.
function buildFlacPictureBlock(image, mime) {
  const mimeBuf = Buffer.from(mime, 'ascii');
  const buf = Buffer.alloc(4 + 4 + mimeBuf.length + 4 + 4 * 4 + 4 + image.length);
  let o = 0;
  buf.writeUInt32BE(3, o); o += 4;                 // type 3 = front cover
  buf.writeUInt32BE(mimeBuf.length, o); o += 4;
  mimeBuf.copy(buf, o); o += mimeBuf.length;
  buf.writeUInt32BE(0, o); o += 4;                 // description length (empty)
  buf.writeUInt32BE(0, o); o += 4;                 // width (0 = unknown, allowed)
  buf.writeUInt32BE(0, o); o += 4;                 // height
  buf.writeUInt32BE(0, o); o += 4;                 // color depth
  buf.writeUInt32BE(0, o); o += 4;                 // colors used
  buf.writeUInt32BE(image.length, o); o += 4;
  image.copy(buf, o);
  return buf;
}

const EDIT_TAG_KEYS = { title: 'title', artist: 'artist', album: 'album', year: 'date', track: 'track', disc: 'disc' };

async function writeMetadataEdits(full, tags, art) {
  const ext = path.extname(full).toLowerCase();
  const dir = path.dirname(full);
  const isOggFamily = ext === '.ogg' || ext === '.opus';
  const isMp3 = ext === '.mp3';
  const artAction = art && art.action;
  let artTmp = null;

  // Must be captured BEFORE ffmpeg's remux, which converts a real USLT frame
  // into a TXXX form that NodeID3.read() can no longer see afterward.
  let existingLyricsBeforeRemux;
  if (isMp3 && (!tags || tags.lyrics === undefined)) {
    try {
      const mm = await import('music-metadata');
      const parsed = await mm.parseFile(full, { duration: false, skipCovers: true });
      existingLyricsBeforeRemux = extractRawLyrics(parsed) || '';
    } catch { /* nothing to preserve if unreadable */ }
  }

  const buildArgs = (keepArtStream) => {
    const args = ['-y', '-loglevel', 'error', '-i', full];
    if (artAction === 'set' && !isOggFamily) {
      args.push('-i', artTmp, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v:0', 'attached_pic');
    } else if (artAction === 'delete' || (artAction === 'set' && isOggFamily)) {
      args.push('-map', '0:a', '-c', 'copy');
    } else {
      args.push('-map', keepArtStream ? '0' : '0:a', '-c', 'copy');
    }
    if (isMp3) args.push('-id3v2_version', '3');
    // mp3 text tags are handled entirely via node-id3 below, not ffmpeg: ffmpeg's
    // ID3 round-trip silently rewrites a real USLT lyrics frame into a TXXX
    // frame that node-id3 (and a fresh read) then can't recognize or clean up,
    // leaving stale lyrics behind even after they're explicitly cleared.
    if (!isMp3) {
      for (const [k, v] of Object.entries(tags || {})) {
        if (k === 'lyrics') continue;
        args.push('-metadata', `${EDIT_TAG_KEYS[k]}=${v}`);
      }
      if (tags && tags.lyrics !== undefined) {
        args.push('-metadata', `lyrics=${tags.lyrics}`);
      }
    }
    if (isOggFamily && artAction === 'delete') args.push('-metadata', 'METADATA_BLOCK_PICTURE=');
    if (isOggFamily && artAction === 'set') {
      const block = buildFlacPictureBlock(Buffer.from(art.data, 'base64'), art.mime);
      args.push('-metadata', `METADATA_BLOCK_PICTURE=${block.toString('base64')}`);
    }
    return args;
  };

  try {
    if (artAction === 'set' && !isOggFamily) {
      artTmp = path.join(dir, `.arttmp_${Date.now()}${art.mime === 'image/png' ? '.png' : '.jpg'}`);
      await fsp.writeFile(artTmp, Buffer.from(art.data, 'base64'));
    }
    const tmp = path.join(dir, `.metatmp_${Date.now()}${ext}`);
    let result = await runFfmpeg([...buildArgs(true), tmp]);
    if (result.err) {
      // A corrupted existing art stream can break -map 0; retry without it
      // (this drops broken art but salvages the tag edit - logged for visibility).
      try { await fsp.unlink(tmp); } catch {}
      result = await runFfmpeg([...buildArgs(false), tmp]);
      if (!result.err) logIssue(`edit-meta: ${full} required dropping its art stream to write tags (stream was unreadable)`);
    }
    if (result.err) {
      try { await fsp.unlink(tmp); } catch {}
      return { ok: false, error: (result.stderr || 'ffmpeg write failed').split('\n')[0] };
    }
    await fsp.rename(tmp, full);
    await fixPerms(full);

    if (isMp3) {
      try {
        // Read the CURRENT state (post-remux, post-art-embed) via node-id3's own
        // reader, so re-including it in a full-replace write doesn't lose it.
        const current = NodeID3.read(full) || {};
        const finalTags = {};
        const setIfPresent = (key, tagKey, transform) => {
          const v = (tags && tags[tagKey] !== undefined) ? tags[tagKey] : current[key];
          if (v !== undefined && v !== null && v !== '') finalTags[key] = transform ? transform(v) : v;
        };
        setIfPresent('title', 'title');
        setIfPresent('artist', 'artist');
        setIfPresent('album', 'album');
        setIfPresent('year', 'year');
        setIfPresent('trackNumber', 'track', String);
        setIfPresent('partOfSet', 'disc', String);
        if (current.image) finalTags.image = current.image; // preserve whatever art was just embedded
        const lyricsVal = (tags && tags.lyrics !== undefined)
          ? tags.lyrics
          : (existingLyricsBeforeRemux !== undefined ? existingLyricsBeforeRemux : ((current.unsynchronisedLyrics && current.unsynchronisedLyrics.text) || ''));
        if (lyricsVal) finalTags.unsynchronisedLyrics = { language: 'eng', text: lyricsVal };

        const ok = NodeID3.write(finalTags, full);
        if (ok !== true) {
          logIssue(`edit-meta: NodeID3.write failed for ${full}: ${ok}`);
          return { ok: false, error: 'failed to write mp3 tags' };
        }
        await fixPerms(full);
      } catch (e) {
        logIssue(`edit-meta: failed to write mp3 tags for ${full}: ${e.message}`);
        return { ok: false, error: 'failed to write mp3 tags' };
      }
    }
    return { ok: true };
  } finally {
    if (artTmp) { try { await fsp.unlink(artTmp); } catch {} }
  }
}

app.post('/api/edit-meta/apply', requireAuth, async (req, res) => {
  try {
    const edits = req.body.edits || [];
    const results = [];
    for (const e of edits) {
      try {
        const full = safeResolve(e.path);
        const hasTags = e.tags && Object.keys(e.tags).length > 0;
        const hasArt = e.art && e.art.action && e.art.action !== 'keep';
        if (hasTags || hasArt) {
          const r = await writeMetadataEdits(full, e.tags || {}, e.art || null);
          if (!r.ok) {
            logIssue(`edit-meta apply failed for ${e.path}: ${r.error}`);
            results.push({ path: e.path, ok: false, error: r.error });
            continue;
          }
        }
        let newPath = null;
        if (e.newName && e.newName !== path.basename(e.path)) {
          const destRel = path.join(path.dirname(e.path), e.newName);
          const destFull = safeResolve(destRel);
          await moveFile(full, destFull);
          // keep playlists.json pointing at the renamed file
          const playlists = loadPlaylists();
          let changed = false;
          for (const name of Object.keys(playlists)) {
            playlists[name] = playlists[name].map(p => {
              if (p === e.path) { changed = true; return destRel; }
              return p;
            });
          }
          if (changed) await savePlaylists(playlists);
          newPath = destRel;
        }
        metaCache.delete(e.path);
        if (newPath) metaCache.delete(newPath);
        results.push({ path: e.path, ok: true, ...(newPath ? { newPath } : {}) });
      } catch (err) {
        logIssue(`edit-meta apply failed for ${e.path}: ${err.message}`);
        results.push({ path: e.path, ok: false, error: err.message });
      }
    }
    markLibraryDirty();
    res.json({ results });
  } catch (err) {
    logIssue(`POST /api/edit-meta/apply failed: ${err.message}`);
    res.status(400).json({ error: err.message });
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

// Client uploads one file per request (see uploadOneFile in app.js), so
// files:1 also guards against something other than the app's own UI posting
// a large multi-file batch directly at this endpoint. 500MB comfortably
// covers even large lossless FLACs while still bounding worst-case disk/
// memory use per request.
const upload = multer({
  dest: '/tmp/musicapp-uploads',
  limits: { fileSize: 500 * 1024 * 1024, files: 1 }
});
app.post('/api/upload', requireAuth, (req, res, next) => {
  upload.array('files')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (500MB max)'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Only one file per upload request is allowed'
        : err.message;
      logIssue(`POST /api/upload (to ${(req.body && req.body.path) || ''}) rejected: ${msg}`);
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
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
async function savePlaylists(data) {
  const tmpFile = `${PLAYLISTS_FILE}.tmp`;
  await fsp.writeFile(tmpFile, JSON.stringify(data, null, 2));
  await fsp.rename(tmpFile, PLAYLISTS_FILE);
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
    await savePlaylists(playlists);
    res.json({ ok: true, playlist: playlists[name] });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name} (add) failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/playlists/:name', requireAuth, async (req, res) => {
  try {
    const playlists = loadPlaylists();
    delete playlists[req.params.name];
    await savePlaylists(playlists);
    res.json({ ok: true });
  } catch (err) {
    logIssue(`DELETE /api/playlists/${req.params.name} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/playlists/:name/rename', requireAuth, async (req, res) => {
  try {
    const playlists = loadPlaylists();
    const oldName = req.params.name;
    const newName = (req.body.newName || '').trim();
    if (!newName) return res.status(400).json({ error: 'newName is required' });
    if (!(oldName in playlists)) return res.status(404).json({ error: 'Playlist not found' });
    const tracks = playlists[oldName];
    delete playlists[oldName];
    playlists[newName] = (playlists[newName] || []).concat(tracks);
    await savePlaylists(playlists);
    res.json({ ok: true, playlist: playlists[newName] });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name}/rename failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/playlists/:name/remove', requireAuth, async (req, res) => {
  try {
    const playlists = loadPlaylists();
    const name = req.params.name;
    if (playlists[name]) {
      playlists[name] = playlists[name].filter(f => f !== req.body.file);
      await savePlaylists(playlists);
    }
    res.json({ ok: true, playlist: playlists[name] || [] });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name}/remove failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/playlists/:name/reorder', requireAuth, async (req, res) => {
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
    await savePlaylists(playlists);
    res.json({ ok: true, playlist: list });
  } catch (err) {
    logIssue(`POST /api/playlists/${req.params.name}/reorder failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3838;
app.listen(PORT, () => console.log(`Music app running on port ${PORT}, serving ${MUSIC_ROOT}`));