// ---------------------------------------------------------------------------
// uploads.js — Upload panel UI, per-file progress/status, and drag-and-drop
// (including recursive folder drops) onto the file list.
// Depends on: state.js, browse.js.
// ---------------------------------------------------------------------------

// ---------- Uploads (panel with per-file status, drag & drop) ----------
const uploadBtn = document.getElementById('uploadBtn');
const uploadPanel = document.getElementById('uploadPanel');
const uploadInput = document.getElementById('uploadInput');
const uploadExplorerBtn = document.getElementById('uploadExplorerBtn');
const uploadClearBtn = document.getElementById('uploadClearBtn');
const uploadList = document.getElementById('uploadList');
const uploadEmpty = document.getElementById('uploadEmpty');
const fileListWrap = document.getElementById('fileListWrap');
const dropOverlay = document.getElementById('dropOverlay');
const uploadItemsMap = {};

function openUploadPanel() { uploadPanel.classList.remove('hidden'); }

uploadBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uploadPanel.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!uploadPanel.contains(e.target) && e.target !== uploadBtn) {
    uploadPanel.classList.add('hidden');
  }
});
uploadExplorerBtn.addEventListener('click', () => uploadInput.click());

function refreshUploadEmptyState() {
  const hasItems = uploadList.querySelector('.upload-item') !== null;
  uploadEmpty.classList.toggle('hidden', hasItems);
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function updateUploadBtnState() {
  const anyActive = Object.values(uploadItemsMap).some(it => !it.el.classList.contains('upload-success')
    && !it.el.classList.contains('upload-failed')
    && !it.el.classList.contains('upload-cancelled'));
  uploadBtn.classList.toggle('uploading', anyActive);
}

function addUploadItem(name, destPath) {
  const id = 'up_' + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'upload-item';
  div.innerHTML = `
    <div class="upload-item-row">
      <div class="upload-item-name">${name}</div>
      <div class="upload-item-actions">
        <button class="upload-cancel-btn" title="Cancel upload">✕</button>
        <button class="upload-open-folder-btn hidden" title="Open containing folder">${FOLDER_ICON_SVG}</button>
      </div>
    </div>
    <div class="upload-item-bar"><div class="upload-item-bar-fill"></div></div>
    <div class="upload-item-status">Starting…</div>
  `;
  uploadList.prepend(div);
  refreshUploadEmptyState();

  const cancelBtn = div.querySelector('.upload-cancel-btn');
  const openFolderBtn = div.querySelector('.upload-open-folder-btn');
  cancelBtn.addEventListener('click', () => {
    const it = uploadItemsMap[id];
    if (it && it.xhr) it.xhr.abort();
  });
  openFolderBtn.addEventListener('click', () => {
    uploadPanel.classList.add('hidden');
    browse(destPath);
  });

  uploadItemsMap[id] = {
    fill: div.querySelector('.upload-item-bar-fill'),
    status: div.querySelector('.upload-item-status'),
    el: div,
    cancelBtn,
    openFolderBtn,
    xhr: null,
    destPath
  };
  updateUploadBtnState();
  return id;
}
function updateUploadProgress(id, pct, speedBytesPerSec, etaSeconds) {
  const it = uploadItemsMap[id];
  if (!it) return;
  it.fill.style.width = pct + '%';
  const speedText = formatSpeed(speedBytesPerSec);
  const etaText = (etaSeconds != null && isFinite(etaSeconds)) ? formatDuration(etaSeconds) + ' left' : '';
  it.status.textContent = [`${pct}%`, speedText, etaText].filter(Boolean).join(' · ');
}
function setUploadStatus(id, status, message) {
  const it = uploadItemsMap[id];
  if (!it) return;
  it.el.classList.add('upload-' + status);
  it.cancelBtn.classList.add('hidden');
  if (status === 'success') {
    it.fill.style.width = '100%';
    it.status.textContent = 'Done';
    it.openFolderBtn.classList.remove('hidden');
  } else if (status === 'failed') {
    it.status.textContent = message || 'Failed';
  } else if (status === 'cancelled') {
    it.status.textContent = 'Cancelled';
  }
  updateUploadBtnState();
}

function clearFinishedUploads() {
  Object.keys(uploadItemsMap).forEach(id => {
    const it = uploadItemsMap[id];
    if (it.el.classList.contains('upload-success') ||
        it.el.classList.contains('upload-failed') ||
        it.el.classList.contains('upload-cancelled')) {
      it.el.remove();
      delete uploadItemsMap[id];
    }
  });
  refreshUploadEmptyState();
  updateUploadBtnState();
}
uploadClearBtn.addEventListener('click', clearFinishedUploads);

function uploadOneFile(file, destPath, displayName) {
  return new Promise((resolve) => {
    const id = addUploadItem(displayName || file.name, destPath);
    const xhr = new XMLHttpRequest();
    uploadItemsMap[id].xhr = xhr;
    xhr.open('POST', '/api/upload');

    let lastLoaded = 0;
    let lastTime = performance.now();
    let smoothedSpeed = 0; // bytes per second, exponential moving average

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.15) {
        const instSpeed = (e.loaded - lastLoaded) / dt;
        smoothedSpeed = smoothedSpeed === 0 ? instSpeed : (smoothedSpeed * 0.7 + instSpeed * 0.3);
        lastLoaded = e.loaded;
        lastTime = now;
      }
      const pct = Math.round((e.loaded / e.total) * 100);
      const remainingBytes = e.total - e.loaded;
      const eta = smoothedSpeed > 0 ? remainingBytes / smoothedSpeed : null;
      updateUploadProgress(id, pct, smoothedSpeed, eta);
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) setUploadStatus(id, 'success');
      else {
        setUploadStatus(id, 'failed');
        if (xhr.status === 401) {
          isAuthenticated = false;
          updateAuthBtn();
          openLoginModal('Log in to upload files');
        }
      }
      resolve();
    };
    xhr.onerror = () => { setUploadStatus(id, 'failed'); resolve(); };
    xhr.onabort = () => { setUploadStatus(id, 'cancelled'); resolve(); };
    const fd = new FormData();
    fd.append('path', destPath);
    fd.append('files', file);
    xhr.send(fd);
  });
}

async function handleUploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  openUploadPanel();
  await Promise.all(files.map(f => uploadOneFile(f, currentPath)));
  browse(currentPath, { keepSort: true });
}

function joinRel(base, name) { return base ? `${base}/${name}` : name; }

// Recursively walk a dropped FileSystemEntry (file or directory), collecting
// every file found plus a marker for every directory (so empty folders are
// still created), each tagged with its path relative to the dropped root.
function readEntryRecursive(entry, relBase) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => resolve([{ type: 'file', file, relDir: relBase }]),
        () => resolve([])
      );
    } else if (entry.isDirectory) {
      const relDir = joinRel(relBase, entry.name);
      const reader = entry.createReader();
      const readAllEntries = () => new Promise((res) => {
        let all = [];
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (!batch.length) { res(all); return; }
            all = all.concat(batch);
            readBatch();
          }, () => res(all));
        };
        readBatch();
      });
      readAllEntries().then(async (children) => {
        const results = [{ type: 'dir', relDir }];
        for (const child of children) {
          results.push(...(await readEntryRecursive(child, relDir)));
        }
        resolve(results);
      });
    } else {
      resolve([]);
    }
  });
}

async function handleDroppedEntries(entries) {
  openUploadPanel();
  let all = [];
  for (const entry of entries) {
    all = all.concat(await readEntryRecursive(entry, ''));
  }

  // Create every folder (including empty leaves) first. mkdir is recursive
  // so this also creates any missing parents in one shot.
  const dirs = all.filter(r => r.type === 'dir').map(r => r.relDir);
  for (const rel of dirs) {
    try {
      await api('/api/mkdir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name: rel })
      });
    } catch {}
  }

  // Then upload all files into their corresponding subfolder.
  const fileEntries = all.filter(r => r.type === 'file');
  await Promise.all(fileEntries.map(r => {
    const destPath = currentPath ? joinRel(currentPath, r.relDir) : r.relDir;
    const displayName = joinRel(r.relDir, r.file.name);
    return uploadOneFile(r.file, destPath, displayName);
  }));

  browse(currentPath, { keepSort: true });
}

uploadInput.addEventListener('change', (e) => {
  handleUploadFiles(e.target.files);
  e.target.value = '';
});

// ---- Drag and drop onto the file list ----
let dragDepth = 0;
fileListWrap.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  dropOverlay.classList.remove('hidden');
});
fileListWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
});
fileListWrap.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});
fileListWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');

  const items = e.dataTransfer.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = Array.from(items)
      .map(it => (it.kind === 'file' ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (entries.length) {
      if (entries.some(en => en.isDirectory)) {
        handleDroppedEntries(entries);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleUploadFiles(e.dataTransfer.files);
      }
      return;
    }
  }
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    handleUploadFiles(e.dataTransfer.files);
  }
});

// ---------- Modal helper ----------
function showModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalInput.value = defaultValue;
    modalOverlay.classList.remove('hidden');
    modalInput.focus();
    modalInput.select();
    const cleanup = () => {
      modalOverlay.classList.add('hidden');
      document.getElementById('modalOk').onclick = null;
      document.getElementById('modalCancel').onclick = null;
      modalInput.removeEventListener('keydown', onKeydown);
    };
    const doOk = () => {
      const val = modalInput.value.trim();
      cleanup();
      resolve(val || null);
    };
    const doCancel = () => {
      cleanup();
      resolve(null);
    };
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); doOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
    }
    modalInput.addEventListener('keydown', onKeydown);
    document.getElementById('modalOk').onclick = doOk;
    document.getElementById('modalCancel').onclick = doCancel;
  });
}

