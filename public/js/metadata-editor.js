// ---------------------------------------------------------------------------
// metadata-editor.js — The metadata editor modal (tag fields, album art
// browsing/upload/delete, lyrics editing), plus global keyboard shortcuts
// and confirmAction(). Guards itself with META_EDITOR_AVAILABLE in case
// index.html/style.css are out of date relative to this file.
// Depends on: state.js, selection.js, playback.js, settings-auth-toast-lyrics.js.
// ---------------------------------------------------------------------------

// ---------- Metadata editor ----------
const META_FIELDS = ['title', 'artist', 'albumartist', 'album', 'year', 'track', 'disc'];
const KEEP_MULTI = '--- keep multiple values ---';

let metaEditState = null;
// {
//   files: [{ path, name, newName, orig:{title,artist,album,year,track,disc}, vals:{...same}, hasArt, art:{action:'keep'|'delete'|'set', data?, mime?} }],
//   idx, group
// }

const metaOverlay = document.getElementById('metaOverlay');
const metaGroupWrap = document.getElementById('metaGroupWrap');
const metaGroupChk = document.getElementById('metaGroupChk');
const metaFileCounter = document.getElementById('metaFileCounter');
const metaPrevBtn = document.getElementById('metaPrevBtn');
const metaNextBtn = document.getElementById('metaNextBtn');
const metaFilename = document.getElementById('metaFilename');
const metaArtImg = document.getElementById('metaArtImg');
const metaArtPlaceholder = document.getElementById('metaArtPlaceholder');
const metaArtSplit = document.getElementById('metaArtSplit');
const metaArtOldImg = document.getElementById('metaArtOldImg');
const metaArtOldPlaceholder = document.getElementById('metaArtOldPlaceholder');
const metaArtNewImg = document.getElementById('metaArtNewImg');
const metaArtUploadBtn = document.getElementById('metaArtUploadBtn');
const metaArtDeleteBtn = document.getElementById('metaArtDeleteBtn');
const metaArtKeepBtn = document.getElementById('metaArtKeepBtn');
const metaArtPrevBtn = document.getElementById('metaArtPrevBtn');
const metaArtNextBtn = document.getElementById('metaArtNextBtn');
const metaArtIndex = document.getElementById('metaArtIndex');
const metaArtBroadcastWrap = document.getElementById('metaArtBroadcastWrap');
const metaArtBroadcastChk = document.getElementById('metaArtBroadcastChk');
const metaArtChangedCount = document.getElementById('metaArtChangedCount');
const metaArtInput = document.getElementById('metaArtInput');
const metaArtStatus = document.getElementById('metaArtStatus');
const metaCancelBtn = document.getElementById('metaCancelBtn');
const metaApplyBtn = document.getElementById('metaApplyBtn');
const metaFetchMetaBtn = document.getElementById('metaFetchMetaBtn');
const metaFetchMobileSlot = document.getElementById('metaFetchMobileSlot');
const metaLyricsLrclibBtnEl = document.getElementById('metaLyricsLrclibBtn');

// Fetch metadata sits left of LRCLIB on desktop (same row), but moves below
// the album art buttons, centered on its own, on mobile — the two spots
// are different flex containers so the node itself has to move, not just
// its styling. Same matchMedia breakpoint as the rest of the mobile layout
// (responsive.css's 780px cutoff / MOBILE_BREAKPOINT in layout-init.js).
if (metaFetchMetaBtn && metaFetchMobileSlot && metaLyricsLrclibBtnEl) {
  const META_FETCH_MOBILE_QUERY = window.matchMedia('(max-width: 780px)');
  const placeMetaFetchBtn = () => {
    if (META_FETCH_MOBILE_QUERY.matches) {
      metaFetchMobileSlot.appendChild(metaFetchMetaBtn);
    } else {
      metaLyricsLrclibBtnEl.parentElement.insertBefore(metaFetchMetaBtn, metaLyricsLrclibBtnEl);
    }
  };
  placeMetaFetchBtn();
  META_FETCH_MOBILE_QUERY.addEventListener('change', placeMetaFetchBtn);
}

async function openMetadataEditor(items) {
  if (!META_EDITOR_AVAILABLE) {
    alert('The metadata editor UI failed to load (index.html/style.css appear out of date on this server). Please redeploy them alongside app.js.');
    return;
  }
  if (!isAuthenticated) {
    openLoginModal('Log in to edit metadata', () => openMetadataEditor(items));
    return;
  }
  const audioItems = items.filter(i => i.isAudio);
  if (!audioItems.length) return;
  let data;
  try {
    data = await api('/api/edit-meta/get', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: audioItems.map(i => i.path) })
    });
  } catch (err) {
    alert('Could not load metadata: ' + err.message);
    return;
  }
  metaEditState = {
    files: data.files.map(f => {
      const orig = {
        title: f.title || '',
        artist: f.artist || '',
        album: f.album || '',
        albumartist: f.albumartist || '',
        year: f.year ? String(f.year) : '',
        track: f.track ? String(f.track) : '',
        disc: f.disc ? String(f.disc) : ''
      };
      return {
        path: f.path, name: f.name, newName: f.name,
        orig, vals: { ...orig },
        origLyrics: f.lyrics || '', lyricsVal: f.lyrics || '',
        hasArt: f.hasArt,
        art: { action: 'keep' }
      };
    }),
    idx: 0,
    group: audioItems.length > 1
  };
  metaEditState.uniqueArts = await computeUniqueArts(metaEditState.files);
  metaEditState.artBroadcast = false;
  metaEditState.artBrowseIdx = 0;
  renderMetaEditor();
  metaOverlay.classList.remove('hidden');
}

// Fetches each file's art and dedupes by exact byte content (the common case:
// every track in an album sharing one identical embedded cover) rather than
// by which file it came from, so the browse list only shows genuinely
// distinct images.
async function computeUniqueArts(files) {
  const candidates = files.filter(f => f.hasArt);
  await Promise.all(candidates.map(async (f) => {
    try {
      const res = await fetch(`/api/art?path=${encodeURIComponent(f.path)}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      f.origArtData = dataUrl.split(',')[1];
      f.origArtMime = blob.type || 'image/jpeg';
    } catch {
      f.origArtData = null; // treat as unreadable rather than fail the whole editor
    }
  }));
  const seen = new Set();
  const results = [];
  for (const f of candidates) {
    if (!f.origArtData || seen.has(f.origArtData)) continue;
    seen.add(f.origArtData);
    results.push({ data: f.origArtData, mime: f.origArtMime });
  }
  return results;
}

function closeMetaEditor() {
  metaOverlay.classList.add('hidden');
  metaEditState = null;
  closeMetaFieldDropdown();
}

function renderMetaEditor() {
  const state = metaEditState;
  if (!state) return;
  const n = state.files.length;

  metaGroupWrap.style.display = n > 1 ? '' : 'none';
  metaApplyBtn.textContent = n > 1 ? 'Apply all' : 'Apply';
  document.getElementById('metaField-title').closest('.meta-row').classList.toggle('hidden', state.group);
  document.getElementById('metaField-track').closest('.meta-row').classList.toggle('hidden', state.group);
  document.getElementById('metaLyricsRow').classList.toggle('hidden', state.group);
  metaFetchMetaBtn.classList.toggle('hidden', state.group);
  closeMetaFetchResults();
  if (!state.group) {
    document.getElementById('metaFieldLyrics').value = state.files[state.idx].lyricsVal || '';
  }
  metaGroupChk.checked = state.group;
  metaFileCounter.textContent = n === 1 ? '' : (state.group ? `${n} files` : `${state.idx + 1} / ${n}`);

  const metaFileNavEl = document.querySelector('.meta-file-nav');
  const metaFilenameSingleRow = document.getElementById('metaFilenameSingleRow');
  const metaFilenameSingle = document.getElementById('metaFilenameSingle');

  if (n === 1) {
    metaFileNavEl.style.display = 'none';
    metaFilenameSingleRow.classList.remove('hidden');
    metaFilenameSingle.value = state.files[0].newName;
  } else if (state.group) {
    metaFileNavEl.style.display = 'none';
    metaFilenameSingleRow.classList.add('hidden');
  } else {
    metaFileNavEl.style.display = '';
    metaFilenameSingleRow.classList.add('hidden');
    const showNav = n > 1;
    metaPrevBtn.style.visibility = showNav ? 'visible' : 'hidden';
    metaNextBtn.style.visibility = showNav ? 'visible' : 'hidden';
    metaFilename.value = state.files[state.idx].newName;
    metaFilename.disabled = false;
  }

  const showValueList = state.group && state.files.length > 1;
  closeMetaFieldDropdown();
  META_FIELDS.forEach(field => {
    const input = document.getElementById(`metaField-${field}`);
    const datalist = document.getElementById(`dl-${field}`);
    const arrowBtn = document.querySelector(`.meta-field-arrow-btn[data-field="${field}"]`);
    const uniqueVals = [...new Set(state.files.map(f => f.orig[field]).filter(v => v !== ''))];
    let optionsHtml = uniqueVals.map(v => `<option value="${v}"></option>`).join('');
    if (state.group) optionsHtml = `<option value="${KEEP_MULTI}"></option>` + optionsHtml;
    datalist.innerHTML = optionsHtml;
    arrowBtn.disabled = !showValueList;

    if (state.group) {
      const allSame = state.files.every(f => f.vals[field] === state.files[0].vals[field]);
      input.value = allSame ? state.files[0].vals[field] : KEEP_MULTI;
    } else {
      input.value = state.files[state.idx].vals[field];
    }
  });

  renderMetaArt();
}

function closeMetaFieldDropdown() {
  const existing = document.querySelector('.meta-field-dropdown');
  if (existing) existing.remove();
}

function toggleMetaFieldDropdown(field, btn) {
  const already = btn.parentElement.querySelector('.meta-field-dropdown');
  closeMetaFieldDropdown();
  if (already) return; // was already open on this field — just close it

  const state = metaEditState;
  const uniqueVals = [...new Set(state.files.map(f => f.orig[field]).filter(v => v !== ''))];
  const options = [KEEP_MULTI, ...uniqueVals];

  const dropdown = document.createElement('div');
  dropdown.className = 'meta-field-dropdown';
  dropdown.innerHTML = options.map((v, i) =>
    `<div class="meta-field-dropdown-item${i === 0 ? ' keep-multi' : ''}" data-i="${i}">${v}</div>`
  ).join('');
  dropdown.querySelectorAll('.meta-field-dropdown-item').forEach(el => {
    el.addEventListener('click', () => {
      const val = options[Number(el.dataset.i)];
      const input = document.getElementById(`metaField-${field}`);
      input.value = val;
      if (val !== KEEP_MULTI) {
        state.files.forEach(f => { f.vals[field] = val; });
      }
      closeMetaFieldDropdown();
    });
  });
  btn.parentElement.appendChild(dropdown);
}

function navigateMetaArt(delta) {
  const state = metaEditState;
  const list = state.uniqueArts;
  if (!list || list.length < 2) return;
  state.artBrowseIdx = (state.artBrowseIdx + delta + list.length) % list.length;
  if (state.group && !state.artBroadcast) {
    // Browsing only — nothing is committed until "Use this image" is checked.
    renderMetaArt();
    return;
  }
  const chosen = list[state.artBrowseIdx];
  setArtAction({ action: 'set', data: chosen.data, mime: chosen.mime });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.meta-field-arrow-btn')) return;
  if (e.target.closest('.meta-field-dropdown')) return;
  closeMetaFieldDropdown();
  if (e.target.closest('#metaFetchMetaBtn') || e.target.closest('.meta-fetch-results')) return;
  closeMetaFetchResults();
});

document.querySelectorAll('.meta-field-arrow-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    toggleMetaFieldDropdown(btn.dataset.field, btn);
  });
});
metaArtPrevBtn.addEventListener('click', () => navigateMetaArt(-1));
metaArtNextBtn.addEventListener('click', () => navigateMetaArt(1));
metaArtBroadcastChk.addEventListener('change', () => {
  if (!metaEditState) return;
  const wasChecked = metaEditState.artBroadcast;
  const nowChecked = metaArtBroadcastChk.checked;
  metaEditState.artBroadcast = nowChecked;
  if (wasChecked && !nowChecked) {
    // Unchecked: undo whatever was broadcast.
    metaEditState.files.forEach(f => { f.art = { action: 'keep' }; });
  } else if (!wasChecked && nowChecked) {
    // Checked: commit whatever image is currently being browsed/previewed to every file.
    const list = metaEditState.uniqueArts;
    if (list && list.length) {
      const chosen = list[metaEditState.artBrowseIdx] || list[0];
      metaEditState.files.forEach(f => { f.art = resolveArtForFile(f, { action: 'set', data: chosen.data, mime: chosen.mime }); });
    }
  }
  renderMetaArt();
});

function showSingleArt(src) {
  metaArtSplit.classList.add('hidden');
  if (src) {
    metaArtImg.src = src;
    metaArtImg.classList.remove('hidden');
    metaArtPlaceholder.classList.add('hidden');
  } else {
    metaArtImg.classList.add('hidden');
    metaArtImg.removeAttribute('src');
    metaArtPlaceholder.classList.remove('hidden');
  }
}

function showSplitArt(oldSrc, newSrc) {
  metaArtImg.classList.add('hidden');
  metaArtPlaceholder.classList.add('hidden');
  metaArtSplit.classList.remove('hidden');
  if (oldSrc) {
    metaArtOldImg.src = oldSrc;
    metaArtOldImg.classList.remove('hidden');
    metaArtOldPlaceholder.classList.add('hidden');
  } else {
    metaArtOldImg.classList.add('hidden');
    metaArtOldImg.removeAttribute('src');
    metaArtOldPlaceholder.classList.remove('hidden');
  }
  metaArtNewImg.src = newSrc;
}

function renderMetaArt() {
  const state = metaEditState;
  const multiFile = state.files.length > 1;

  // The broadcast checkbox only makes sense (and is only shown) while editing fields as a group.
  const showChk = state.group && multiFile;
  metaArtBroadcastWrap.classList.toggle('hidden', !showChk);
  metaArtBroadcastChk.checked = state.artBroadcast;

  // Upload/Delete need a clear single target: either the current file (ungrouped),
  // or "all files" explicitly opted into (grouped + checked).
  const controlsEnabled = !state.group || state.artBroadcast;
  metaArtUploadBtn.disabled = !controlsEnabled;
  metaArtDeleteBtn.disabled = !controlsEnabled;
  // Reset is also enabled whenever there's something pending to clear, even if
  // grouped+unchecked (e.g. leftover edits from individual mode before regrouping).
  const anyPending = state.files.some(f => f.art.action !== 'keep');
  metaArtKeepBtn.disabled = !(controlsEnabled || anyPending);

  metaArtStatus.textContent = '';
  metaArtChangedCount.textContent = '';
  let displayedData = null; // base64 of whatever's actually shown right now, used below to sync the counter

  // Always show how many files currently have a pending change (excludes files
  // whose "change" already matches their original), across the whole selection —
  // stays useful as an overview even while only viewing one file at a time.
  {
    const n = state.files.filter(f => {
      if (f.art.action === 'delete') return f.hasArt;
      if (f.art.action === 'set') return f.art.data !== f.origArtData;
      return false;
    }).length;
    if (n > 0) metaArtChangedCount.textContent = `${n} image${n === 1 ? '' : 's'} changed`;
  }

  if (state.group && state.artBroadcast) {
    // Broadcasting: one plain preview representing the shared choice.
    const allDelete = state.files.every(f => f.art.action === 'delete');
    if (allDelete) {
      metaArtStatus.textContent = 'Will be removed';
      showSingleArt(null);
    } else {
      const setFile = state.files.find(f => f.art.action === 'set');
      if (setFile) {
        showSingleArt(`data:${setFile.art.mime};base64,${setFile.art.data}`);
        displayedData = setFile.art.data;
      } else {
        const withArt = state.files.find(f => f.hasArt);
        showSingleArt(withArt ? `/api/art?path=${encodeURIComponent(withArt.path)}` : null);
        displayedData = withArt ? withArt.origArtData : null;
      }
    }
  } else if (state.group && !state.artBroadcast) {
    // Grouped but not committed yet: shows whatever's currently browsed as a live
    // preview only — nothing is written to any file until the checkbox is checked.
    if (state.uniqueArts && state.uniqueArts.length > 0) {
      const preview = state.uniqueArts[state.artBrowseIdx] || state.uniqueArts[0];
      showSingleArt(`data:${preview.mime};base64,${preview.data}`);
      displayedData = preview.data;
    } else {
      showSingleArt(null);
    }
  } else {
    // Ungrouped: editing this one file. A pending new image shows old (gray) vs new side by side.
    const f = state.files[state.idx];
    if (f.art.action === 'set') {
      const oldSrc = f.hasArt ? `/api/art?path=${encodeURIComponent(f.path)}` : null;
      showSplitArt(oldSrc, `data:${f.art.mime};base64,${f.art.data}`);
      displayedData = f.art.data;
    } else if (f.art.action === 'delete') {
      metaArtStatus.textContent = 'Will be removed';
      showSingleArt(null);
    } else {
      showSingleArt(f.hasArt ? `/api/art?path=${encodeURIComponent(f.path)}` : null);
      displayedData = f.hasArt ? f.origArtData : null;
    }
  }

  // Browsing arrows always work, regardless of the checkbox. The counter reflects
  // whatever image is ACTUALLY on screen right now (not just wherever browsing last
  // left off), so it stays accurate across switching files or group/individual mode.
  const showNav = state.uniqueArts && state.uniqueArts.length > 1;
  document.querySelector('.meta-art-nav').classList.toggle('hidden', !showNav);
  if (showNav) {
    const idx = displayedData != null ? state.uniqueArts.findIndex(a => a.data === displayedData) : -1;
    if (idx !== -1) {
      state.artBrowseIdx = idx; // keep the pointer in sync so the next arrow click continues from here
      metaArtIndex.textContent = `${idx + 1} / ${state.uniqueArts.length}`;
    } else {
      metaArtIndex.textContent = `– / ${state.uniqueArts.length}`;
    }
  }
}

function resolveArtForFile(f, newArt) {
  // Browsing/broadcasting back to exactly what a file already has isn't a real
  // change — treat it as 'keep' rather than a redundant 'set' (avoids showing
  // a split/old-vs-new comparison for two identical images).
  if (newArt.action === 'set' && newArt.data === f.origArtData) {
    return { action: 'keep' };
  }
  return { ...newArt };
}

function setArtAction(newArt) {
  if (!metaEditState) return;
  const state = metaEditState;
  if (state.group && state.artBroadcast) {
    state.files.forEach(f => { f.art = resolveArtForFile(f, newArt); });
  } else {
    const f = state.files[state.idx];
    f.art = resolveArtForFile(f, newArt);
  }
  renderMetaArt();
}

// Guards against a mismatched deployment (app.js updated without the matching
// index.html/style.css): if the modal markup isn't present, skip wiring it up
// entirely and warn loudly, instead of throwing on a null element and taking
// down every script that runs after this point (queue, browsing, playback...).
const META_EDITOR_AVAILABLE = !!(metaOverlay && metaGroupWrap && metaGroupChk && metaFileCounter &&
  metaPrevBtn && metaNextBtn && metaFilename && metaArtImg && metaArtPlaceholder &&
  metaArtSplit && metaArtOldImg && metaArtOldPlaceholder && metaArtNewImg &&
  metaArtUploadBtn && metaArtDeleteBtn && metaArtKeepBtn && metaArtPrevBtn && metaArtNextBtn && metaArtIndex &&
  metaArtBroadcastWrap && metaArtBroadcastChk && metaArtChangedCount && metaArtInput && metaArtStatus &&
  metaCancelBtn && metaApplyBtn && metaFetchMetaBtn && metaFetchMobileSlot &&
  document.getElementById('metaLyricsRow') &&
  document.getElementById('metaFilenameSingleRow') && document.getElementById('metaFilenameSingle') &&
  document.getElementById('metaFieldLyrics') && document.getElementById('metaLyricsFetchBtn') &&
  document.getElementById('metaLyricsDeleteBtn') && document.getElementById('metaLyricsLrclibBtn') &&
  META_FIELDS.every(f => document.getElementById(`metaField-${f}`) && document.getElementById(`dl-${f}`)));

if (!META_EDITOR_AVAILABLE) {
  console.error('Metadata editor UI not found in this page (index.html/style.css out of date vs app.js) — "Edit metadata" will be unavailable until they are redeployed together.');
}

if (META_EDITOR_AVAILABLE) {
META_FIELDS.forEach(field => {
  const input = document.getElementById(`metaField-${field}`);
  input.addEventListener('input', () => {
    if (!metaEditState) return;
    const val = input.value;
    if (metaEditState.group) {
      if (val === KEEP_MULTI) return; // explicit "no change" selection
      metaEditState.files.forEach(f => { f.vals[field] = val; });
    } else {
      metaEditState.files[metaEditState.idx].vals[field] = val;
    }
  });
});

metaFilename.addEventListener('input', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.files[metaEditState.idx].newName = metaFilename.value;
});

document.getElementById('metaFilenameSingle').addEventListener('input', (e) => {
  if (!metaEditState || metaEditState.files.length !== 1) return;
  metaEditState.files[0].newName = e.target.value;
});

const metaFieldLyrics = document.getElementById('metaFieldLyrics');
const metaLyricsFetchBtn = document.getElementById('metaLyricsFetchBtn');
const metaLyricsDeleteBtn = document.getElementById('metaLyricsDeleteBtn');
const metaLyricsLrclibBtn = document.getElementById('metaLyricsLrclibBtn');

metaFieldLyrics.addEventListener('input', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.files[metaEditState.idx].lyricsVal = metaFieldLyrics.value;
});

metaLyricsLrclibBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  const f = metaEditState.files[metaEditState.idx];
  const title = (f.vals.title || '').trim();
  const artist = (f.vals.artist || '').trim();
  const query = title && artist ? `${title} - ${artist}` : (title || f.name.replace(/\.[^./]+$/, ''));
  window.open(`https://lrclib.net/search/${encodeURIComponent(query)}`, '_blank', 'noopener');
});

metaLyricsDeleteBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.files[metaEditState.idx].lyricsVal = '';
  metaFieldLyrics.value = '';
});

metaLyricsFetchBtn.addEventListener('click', async () => {
  if (!metaEditState || metaEditState.group) return;
  const f = metaEditState.files[metaEditState.idx];
  metaLyricsFetchBtn.disabled = true;
  metaLyricsFetchBtn.textContent = 'Fetching...';
  try {
    const data = await api('/api/lyrics/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path })
    });
    if (data.found) {
      f.lyricsVal = data.lyrics;
      metaFieldLyrics.value = data.lyrics;
    } else {
      showToast('No matching lyrics found');
    }
  } catch (err) {
    showToast(err.message || 'Failed to fetch lyrics');
  } finally {
    metaLyricsFetchBtn.disabled = false;
    metaLyricsFetchBtn.textContent = 'Fetch lyrics';
  }
});

function closeMetaFetchResults() {
  const existing = document.querySelector('.meta-fetch-results');
  if (existing) existing.remove();
}

metaFetchMetaBtn.addEventListener('click', async () => {
  if (!metaEditState || metaEditState.group) return;
  const f = metaEditState.files[metaEditState.idx];
  closeMetaFetchResults();
  metaFetchMetaBtn.disabled = true;
  metaFetchMetaBtn.style.width = metaFetchMetaBtn.offsetWidth + 'px';
  metaFetchMetaBtn.textContent = 'Fetching...';
  try {
    const data = await api('/api/edit-meta/lookup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path })
    });
    if (!data.results || !data.results.length) {
      showToast('No matching metadata found');
      return;
    }
    const dropdown = document.createElement('div');
    dropdown.className = 'meta-fetch-results';
    dropdown.innerHTML = data.results.map((r, i) => {
      const sub = [r.album, r.year].filter(Boolean).join(' • ');
      const art = r.artThumbUrl
        ? `<img class="meta-fetch-result-art" src="${r.artThumbUrl}" alt="">`
        : `<div class="meta-fetch-result-art meta-fetch-result-art-placeholder"></div>`;
      return `<div class="meta-fetch-result-item" data-i="${i}">
        ${art}
        <div class="meta-fetch-result-text">
          <div class="meta-fetch-result-title">${r.title} — ${r.artist}</div>
          <div class="meta-fetch-result-sub">${sub}</div>
        </div>
      </div>`;
    }).join('');
    dropdown.querySelectorAll('.meta-fetch-result-item').forEach(el => {
      el.addEventListener('click', async () => {
        const r = data.results[Number(el.dataset.i)];
        if (r.title) { f.vals.title = r.title; document.getElementById('metaField-title').value = r.title; }
        if (r.artist) { f.vals.artist = r.artist; document.getElementById('metaField-artist').value = r.artist; }
        if (r.album) { f.vals.album = r.album; document.getElementById('metaField-album').value = r.album; }
        if (r.year) { f.vals.year = r.year; document.getElementById('metaField-year').value = r.year; }
        if (r.track) { f.vals.track = String(r.track); document.getElementById('metaField-track').value = String(r.track); }
        closeMetaFetchResults();
        if (r.releaseId) {
          try {
            const art = await api(`/api/edit-meta/lookup-art?releaseId=${encodeURIComponent(r.releaseId)}`);
            if (metaEditState && metaEditState.files[metaEditState.idx] === f) {
              setArtAction({ action: 'set', data: art.data, mime: art.mime });
            }
          } catch {} // no cover art available - leave existing art untouched
        }
      });
    });
    metaFetchMetaBtn.parentElement.insertAdjacentElement('afterend', dropdown);
  } catch (err) {
    showToast(err.message || 'Failed to fetch metadata');
  } finally {
    metaFetchMetaBtn.disabled = false;
    metaFetchMetaBtn.textContent = 'Fetch metadata';
    metaFetchMetaBtn.style.width = '';
  }
});

metaGroupChk.addEventListener('change', () => {
  if (!metaEditState) return;
  metaEditState.group = metaGroupChk.checked;
  if (metaEditState.group) {
    metaEditState.artBroadcast = false;
  }
  renderMetaEditor();
});
metaPrevBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.idx = (metaEditState.idx - 1 + metaEditState.files.length) % metaEditState.files.length;
  renderMetaEditor();
});
metaNextBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.idx = (metaEditState.idx + 1) % metaEditState.files.length;
  renderMetaEditor();
});

metaArtUploadBtn.addEventListener('click', () => metaArtInput.click());
metaArtInput.addEventListener('change', async () => {
  const file = metaArtInput.files[0];
  metaArtInput.value = '';
  if (!file) return;
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    metaArtStatus.textContent = 'Only JPEG/PNG images are supported';
    return;
  }
  const dataUrl = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  setArtAction({ action: 'set', data: dataUrl.split(',')[1], mime: file.type });
});
metaArtDeleteBtn.addEventListener('click', () => setArtAction({ action: 'delete' }));
metaArtKeepBtn.addEventListener('click', () => {
  const state = metaEditState;
  if (!state) return;
  if (state.group) {
    state.files.forEach(f => { f.art = { action: 'keep' }; });
  } else {
    state.files[state.idx].art = { action: 'keep' };
  }
  if (state.artBroadcast) state.artBroadcast = false;
  renderMetaArt();
});

metaCancelBtn.addEventListener('click', closeMetaEditor);
metaOverlay.addEventListener('click', (e) => {
  if (e.target === metaOverlay && !document.body.classList.contains('meta-editor-pending')) closeMetaEditor();
});

async function applyMetaEdits() {
  const state = metaEditState;
  if (!state) return;

  const edits = [];
  for (const f of state.files) {
    const tags = {};
    for (const field of META_FIELDS) {
      const newVal = (f.vals[field] || '').trim();
      const origVal = f.orig[field] || '';
      if (newVal !== origVal) tags[field] = newVal;
    }
    if ((f.lyricsVal || '') !== (f.origLyrics || '')) tags.lyrics = f.lyricsVal || '';
    let art = null;
    if (f.art.action === 'set') art = { action: 'set', data: f.art.data, mime: f.art.mime };
    else if (f.art.action === 'delete' && f.hasArt) art = { action: 'delete' };

    let newName;
    const trimmedName = (f.newName || '').trim();
    if (trimmedName && trimmedName !== f.name) newName = trimmedName;

    if (Object.keys(tags).length === 0 && !art && !newName) continue; // nothing changed for this file
    edits.push({ path: f.path, tags, art, newName });
  }

  if (edits.length === 0) { closeMetaEditor(); return; }

  metaApplyBtn.disabled = true;
  metaApplyBtn.textContent = 'Applying...';
  try {
    const { results } = await api('/api/edit-meta/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits })
    });

    const renameMap = {};
    for (const r of results) {
      delete metaCache[r.path];
      if (r.newPath) { delete metaCache[r.newPath]; renameMap[r.path] = r.newPath; }
    }
    if (Object.keys(renameMap).length) {
      [queue, originalQueue].forEach(list => {
        list.forEach(t => {
          if (renameMap[t.path]) {
            t.path = renameMap[t.path];
            t.name = fileNameOf(t.path);
          }
        });
      });
      renderQueue();
    }

    closeMetaEditor();
    const playingTrack = queue[queueIndex];
    if (playingTrack && edits.some(e => e.path === playingTrack.path || renameMap[e.path] === playingTrack.path)) {
      loadLyricsForTrack(playingTrack.path);
    }
    if (libraryView) openLibrary(libraryView.type, libraryView.name, { skipHistory: true, keepSort: true, preferExt: libraryView.preferExt });
    else if (isSearching) performSearch(searchInput.value.trim());
    else browse(currentPath, { skipHistory: true, keepSort: true });

    const failures = results.filter(r => !r.ok);
    if (failures.length) {
      alert(`${failures.length} file(s) failed to update:\n` + failures.map(f => `${f.path}: ${f.error}`).join('\n'));
    }
  } catch (err) {
    alert('Failed to apply changes: ' + err.message);
  } finally {
    metaApplyBtn.disabled = false;
    metaApplyBtn.textContent = metaEditState && metaEditState.files.length > 1 ? 'Apply all' : 'Apply';
  }
}
metaApplyBtn.addEventListener('click', applyMetaEdits);
} // end META_EDITOR_AVAILABLE guard

function confirmAction(message) {
  if (settings.skipDeleteConfirm) return true;
  return confirm(message);
}

// ---------- Keyboard shortcuts: left/right arrow seek, space play/pause ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const isSeekBar = e.target.id === 'seekBar';
  if (!isSeekBar && (tag === 'input' || tag === 'textarea' || e.target.isContentEditable)) return;
  const anyModalOpen = [settingsOverlay, metaOverlay, loginOverlay, modalOverlay].some(
    el => el && !el.classList.contains('hidden')
  );
  if (anyModalOpen) return;

  if (e.code === 'Space' || e.key === ' ') {
    if (!playerBarEl.classList.contains('hidden')) {
      e.preventDefault();
      document.getElementById('playPauseBtn').click();
    }
    return;
  }

  if (e.altKey) return;

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? 5 : -5;
    const newValue = Math.max(0, Math.min(100, Number(volumeBar.value) + delta));
    volumeBar.value = newValue;
    volumeBar.dispatchEvent(new Event('input'));
    return;
  }

  // STEP 2: durationSec()/currentTimeSec() are playback.js helpers - on web
  // they're plain audioEl reads (unchanged), on native they read the
  // adapter's polled cache (see the seek-bar section of playback.js). Seeking
  // itself goes through NativeAudioAdapter.seekTo() either way.
  if (!durationSec() || !isFinite(durationSec())) return;

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    NativeAudioAdapter.seekTo(Math.max(0, currentTimeSec() - settings.seekBack));
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    NativeAudioAdapter.seekTo(Math.min(durationSec(), currentTimeSec() + settings.seekForward));
  }
});

// remember volume between sessions, if enabled
// STEP 1: goes through NativeAudioAdapter so the saved volume actually
// takes effect on native too, not just on web - previously this only ever
// touched audioEl.volume, which is correct for web but was a silent no-op
// for the whole point of this app on iOS (see native-audio-adapter.js).
if (settings.rememberVolume) {
  try {
    const savedVol = localStorage.getItem('musicapp-volume');
    if (savedVol !== null) {
      const vol = parseFloat(savedVol);
      NativeAudioAdapter.setVolume(vol);
      volumeBar.value = Math.round(vol * 100);
      updateVolumeBarFill();
    }
  } catch {}
}
volumeBar.addEventListener('change', () => {
  if (settings.rememberVolume) {
    try { localStorage.setItem('musicapp-volume', volumeBar.value / 100); } catch {}
  }
});

