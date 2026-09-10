// ---------------------------------------------------------------------------
// download-modal.js — "Upload manager" modal: pick a local file, choose a
// destination folder via a browsable tree, upload it (progress tracked
// inline in the modal), then open the full metadata editor for the
// uploaded file so its tags/art/lyrics can be set.
// Depends on: state.js (FOLDER_ICON_SVG), selection.js (api()),
// metadata-editor.js (openMetadataEditor), browse.js (browse).
// ---------------------------------------------------------------------------

const downloadOverlay = document.getElementById('downloadOverlay');
const downloadFileInput = document.getElementById('downloadFileInput');
const downloadFileBtn = document.getElementById('downloadFileBtn');
const downloadFileBtnLabel = document.getElementById('downloadFileBtnLabel');
const downloadFolderPath = document.getElementById('downloadFolderPath');
const downloadFolderTree = document.getElementById('downloadFolderTree');
const downloadProgressRow = document.getElementById('downloadProgressRow');
const downloadProgressFill = document.getElementById('downloadProgressFill');
const downloadProgressDetails = document.getElementById('downloadProgressDetails');
const downloadStatus = document.getElementById('downloadStatus');
const downloadCancelBtn = document.getElementById('downloadCancelBtn');
const downloadApplyBtn = document.getElementById('downloadApplyBtn');
const uploadManagerBtn = document.getElementById('uploadManagerBtn');

uploadManagerBtn.addEventListener('click', () => {
  uploadPanel.classList.add('hidden');
  openDownloadModal();
});

downloadFileBtn.addEventListener('click', () => downloadFileInput.click());
downloadFileInput.addEventListener('change', () => {
  const file = downloadFileInput.files[0];
  downloadFileBtnLabel.textContent = file ? file.name : 'Browse files';
});

let downloadSelectedFolder = '';

function setDownloadStatus(msg, isError) {
  downloadStatus.textContent = msg || '';
  downloadStatus.classList.toggle('error', !!isError);
}

function setDownloadProgress(pct) {
  downloadProgressRow.classList.toggle('hidden', pct == null);
  downloadProgressFill.style.width = (pct || 0) + '%';
  if (pct == null) downloadProgressDetails.textContent = '';
}

async function renderDownloadFolderTree(relPath) {
  downloadFolderTree.innerHTML = '';
  let items;
  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(relPath)}`);
    items = data.items.filter(i => i.isDir);
  } catch {
    items = [];
  }
  if (relPath) {
    const up = document.createElement('div');
    up.className = 'download-folder-item';
    up.innerHTML = `${FOLDER_ICON_SVG}<span>..</span>`;
    up.addEventListener('click', () => selectDownloadFolder(dirNameOf(relPath)));
    downloadFolderTree.appendChild(up);
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'download-folder-item';
    row.innerHTML = `${FOLDER_ICON_SVG}<span>${item.name}</span>`;
    row.addEventListener('click', () => selectDownloadFolder(item.path));
    downloadFolderTree.appendChild(row);
  });
}

function selectDownloadFolder(relPath) {
  downloadSelectedFolder = relPath || '';
  downloadFolderPath.textContent = '/' + downloadSelectedFolder;
  renderDownloadFolderTree(downloadSelectedFolder);
}

// Resets the modal's fields (file choice, status, progress) back to a
// clean slate ready for another upload, without touching whether the
// overlay itself is shown - shared by openDownloadModal (opening fresh)
// and the metadata editor's close handlers (staying open, ready for the
// next upload).
function resetDownloadModalForNextUpload() {
  downloadFileInput.value = '';
  downloadFileBtnLabel.textContent = 'Browse files';
  setDownloadStatus('');
  setDownloadProgress(null);
  downloadApplyBtn.disabled = false;
  downloadCancelBtn.disabled = false;
}

// Blanks the metadata editor's fields back to their empty defaults - used
// when showing it locked, ahead of any upload, so it doesn't briefly show
// whatever file was last edited in it.
function resetMetaEditorPreview() {
  metaEditState = null;
  metaFilename.value = '';
  metaFileCounter.textContent = '';
  document.getElementById('metaFilenameSingle').value = '';
  META_FIELDS.forEach(f => {
    const el = document.getElementById('metaField-' + f);
    if (el) el.value = '';
  });
  metaFieldLyrics.value = '';
  metaArtImg.classList.add('hidden');
  metaArtPlaceholder.classList.remove('hidden');
  metaArtSplit.classList.add('hidden');
  metaArtIndex.textContent = '';
  metaArtChangedCount.textContent = '';
  metaArtStatus.textContent = '';
}

// Shows the metadata editor side-by-side with the upload modal right away
// (rather than popping it in only once the upload finishes), but locked
// and blank until there's actually an uploaded file to tag.
function enterMetaEditorPendingState() {
  resetMetaEditorPreview();
  document.body.classList.add('upload-combo-active', 'meta-editor-pending');
  metaOverlay.classList.remove('hidden');
}

function openDownloadModal({ startFolder = '' } = {}) {
  if (document.body.classList.contains('upload-combo-active')) {
    alert('Finish tagging the current upload first (Cancel or Apply) before starting a new one.');
    return;
  }
  resetDownloadModalForNextUpload();
  downloadOverlay.classList.remove('hidden');
  selectDownloadFolder(startFolder || currentPath || '');
  enterMetaEditorPendingState();
}

function closeDownloadModal() {
  downloadOverlay.classList.add('hidden');
  if (document.body.classList.contains('meta-editor-pending')) {
    // Upload was never completed, so the locked metadata editor shown
    // alongside it has nothing to tag - close it too.
    metaOverlay.classList.add('hidden');
    document.body.classList.remove('upload-combo-active', 'meta-editor-pending');
    metaEditState = null;
  }
}

// Once the upload has succeeded and handed off to the metadata editor
// (combo mode), the file is already on disk - "Cancel" at that point would
// orphan the editor with no visible upload panel next to it, so the button
// is disabled for that window (see downloadApplyBtn's handler below, and
// re-enabled in openDownloadModal for the next upload).
downloadCancelBtn.addEventListener('click', closeDownloadModal);

// Uploads via XMLHttpRequest (not fetch) so upload progress events are
// available to drive the modal's own progress bar.
function uploadDownloadFile(file, destFolder) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let uploadDownloadLastLoaded = 0;
    let uploadDownloadLastTime = performance.now();
    let uploadDownloadSmoothedSpeed = 0;
    xhr.open('POST', '/api/upload');
    xhr.upload.addEventListener('progress', (e) => {
      const now = performance.now();
      const dt = (now - uploadDownloadLastTime) / 1000;
      if (dt > 0.15) {
        const instSpeed = (e.loaded - uploadDownloadLastLoaded) / dt;
        uploadDownloadSmoothedSpeed = uploadDownloadSmoothedSpeed === 0 ? instSpeed : (uploadDownloadSmoothedSpeed * 0.7 + instSpeed * 0.3);
        uploadDownloadLastLoaded = e.loaded;
        uploadDownloadLastTime = now;
      }
      if (!e.lengthComputable) return;
      setDownloadProgress(Math.round((e.loaded / e.total) * 100));
      const pct = Math.round((e.loaded / e.total) * 100);
      const eta = uploadDownloadSmoothedSpeed > 0 ? (e.total - e.loaded) / uploadDownloadSmoothedSpeed : null;
      downloadProgressDetails.textContent = [`${pct}%`, formatUploadSpeed(uploadDownloadSmoothedSpeed), eta != null ? `${formatDuration(eta)} left` : ''].filter(Boolean).join(' · ');
    });
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    const fd = new FormData();
    fd.append('path', destFolder);
    fd.append('files', file);
    xhr.send(fd);
  });
}

downloadApplyBtn.addEventListener('click', async () => {
  const file = downloadFileInput.files[0];
  if (!file) { setDownloadStatus('Choose a file first.', true); return; }

  const destFolder = downloadSelectedFolder;
  const destPath = destFolder ? `${destFolder}/${file.name}` : file.name;

  downloadApplyBtn.disabled = true;
  setDownloadProgress(0);
  setDownloadStatus('Uploading…');
  try {
    await uploadDownloadFile(file, destFolder);
    browse(currentPath, { keepSort: true });
    downloadCancelBtn.disabled = true;
    // openMetadataEditor awaits reading the just-uploaded file's tags and
    // embedded art off disk before it fills the (already-visible, still
    // locked) editor in, which can take a noticeable moment - surfacing
    // that wait here (rather than a silent pause) is the fix for the
    // "long delay with no feedback" between upload completion and the
    // editor filling in.
    setDownloadStatus('Loading editor…');
    await openMetadataEditor([{ path: destPath, isAudio: true }]);
    // The editor now has real data - unlock it and lock the upload side
    // instead, since the file is already on disk and re-uploading here
    // would be meaningless until tagging is finished (Cancel or Apply).
    document.body.classList.remove('meta-editor-pending');
    document.body.classList.add('upload-locked');
    setDownloadStatus('Done.');
  } catch (err) {
    setDownloadStatus(err.message || 'Failed', true);
    downloadApplyBtn.disabled = false;
  }
});

// The metadata editor is a separate, independently-used modal (also opened
// directly elsewhere to edit files already in the library) - rather than
// modify its own close logic, just piggyback on its Cancel/Apply buttons to
// end the combo layout whenever that editor closes. The upload modal
// itself stays open, reset and ready for the next upload, instead of
// closing alongside it.
function onMetaEditorClosedDuringCombo() {
  if (!document.body.classList.contains('upload-combo-active')) return;
  document.body.classList.remove('upload-locked');
  resetDownloadModalForNextUpload();
  selectDownloadFolder(downloadSelectedFolder);
  // Stay in combo mode, ready for another upload, with the editor shown
  // locked and blank again rather than closing alongside it.
  enterMetaEditorPendingState();
}
document.addEventListener('metadata-editor-closed', onMetaEditorClosedDuringCombo);
