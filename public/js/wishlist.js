// wishlist.js — shared list of songs friends suggest adding. The same view
// lives in the desktop modal (topbar Wishlist button) or the mobile Wishlist
// tab, moved between them like the blind test views. Submissions don't wait
// on each other: the inputs clear right away and each one shows as a pending
// row until the server (which looks up links' title/artist) answers.

const wishlistOverlay = document.getElementById('wishlistOverlay');
const wishlistModal = document.getElementById('wishlistModal');
const wishlistView = document.getElementById('wishlistView');
const wlForm = document.getElementById('wlForm');
const wlLinkInput = document.getElementById('wlLinkInput');
const wlTitleInput = document.getElementById('wlTitleInput');
const wlArtistInput = document.getElementById('wlArtistInput');
const wlHint = document.getElementById('wlHint');
const wlCount = document.getElementById('wlCount');
const wlList = document.getElementById('wlList');

const wlMobileQuery = window.matchMedia('(max-width: 780px)');

let wishes = [];
let wlPending = []; // labels of submissions still waiting on the server
let wlMode = 'link';

async function loadWishlist() {
  try {
    wishes = await api('/api/wishlist');
    renderWishlist();
  } catch (err) {
    showToast('Could not load the wishlist: ' + err.message);
  }
}

function wlRow(primary, secondary, extraClass) {
  const row = document.createElement('div');
  row.className = 'wl-item' + (extraClass ? ' ' + extraClass : '');
  const text = document.createElement('div');
  text.className = 'wl-item-text';
  const a = document.createElement('div');
  a.className = 'wl-item-title';
  a.textContent = primary;
  const b = document.createElement('div');
  b.className = 'wl-item-artist';
  b.textContent = secondary;
  text.append(a, b);
  row.appendChild(text);
  return row;
}

function renderWishlist() {
  wlList.replaceChildren();
  for (const label of wlPending) wlList.appendChild(wlRow(label, 'Adding…', 'pending'));
  for (const w of [...wishes].reverse()) {
    const row = wlRow(w.title || w.url || 'Unknown title', w.artist || (w.title ? 'Unknown artist' : ''));
    if (w.url) {
      const link = document.createElement('a');
      link.className = 'wl-item-btn';
      link.href = w.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Open link';
      link.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
      row.appendChild(link);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wl-item-btn';
    del.title = 'Remove from wishlist';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    del.addEventListener('click', () => removeWish(w.id));
    row.appendChild(del);
    wlList.appendChild(row);
  }
  wlCount.textContent = wishes.length ? `${wishes.length} song${wishes.length === 1 ? '' : 's'} wished` : 'No wishes yet';
}

async function removeWish(id) {
  try {
    const res = await api(`/api/wishlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
    wishes = res.wishlist;
    renderWishlist();
  } catch (err) {
    showToast(err.message);
  }
}

async function submitWish(body, label) {
  wlPending.push(label);
  renderWishlist();
  try {
    const res = await api('/api/wishlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    wishes = res.wishlist;
    const parts = [];
    if (res.added) parts.push(res.added === 1 ? 'Wish added' : `${res.added} wishes added`);
    if (res.duplicates) parts.push(`${res.duplicates} already wished`);
    if (res.invalid.length) parts.push(`${res.invalid.length} link${res.invalid.length === 1 ? '' : 's'} not recognized`);
    showToast(parts.join(', '));
  } catch (err) {
    showToast(err.message);
  } finally {
    wlPending.splice(wlPending.indexOf(label), 1);
    renderWishlist();
  }
}

// Splits on whitespace and also between links pasted back to back, since
// text inputs drop the newlines of a multi-line paste.
function wlParseLinks(text) {
  return text.match(/https?:\/\/\S+?(?=https?:\/\/|\s|$)/g) || [];
}

wlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (wlMode === 'link') {
    const links = wlParseLinks(wlLinkInput.value);
    if (!links.length) {
      if (wlLinkInput.value.trim()) showToast('No link found. To type a song name, switch to Manual');
      return;
    }
    wlLinkInput.value = '';
    wlLinkInput.focus();
    submitWish({ links }, links.length === 1 ? links[0] : `${links.length} links`);
  } else {
    const title = wlTitleInput.value.trim();
    const artist = wlArtistInput.value.trim();
    if (!title && !artist) return;
    wlTitleInput.value = '';
    wlArtistInput.value = '';
    wlTitleInput.focus();
    submitWish({ title, artist }, [title, artist].filter(Boolean).join(' · '));
  }
});

function setWishMode(mode) {
  wlMode = mode;
  document.querySelectorAll('#wlMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  wlLinkInput.classList.toggle('hidden', mode !== 'link');
  wlTitleInput.classList.toggle('hidden', mode !== 'manual');
  wlArtistInput.classList.toggle('hidden', mode !== 'manual');
  wlHint.textContent = mode === 'link'
    ? 'Several links at once: separate them with spaces'
    : 'Title or artist can be left empty';
  (mode === 'link' ? wlLinkInput : wlTitleInput).focus();
}
document.querySelectorAll('#wlMode button').forEach((b) => {
  b.addEventListener('click', () => setWishMode(b.dataset.mode));
});

function openWishlist() {
  wishlistOverlay.classList.remove('hidden');
  loadWishlist();
  (wlMode === 'link' ? wlLinkInput : wlTitleInput).focus();
}
function closeWishlist() {
  wishlistOverlay.classList.add('hidden');
}
document.getElementById('wishlistBtn').addEventListener('click', openWishlist);
document.getElementById('wishlistCloseBtn').addEventListener('click', closeWishlist);
wishlistOverlay.addEventListener('click', (e) => {
  if (e.target === wishlistOverlay) closeWishlist();
});
wishlistOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeWishlist();
});

function wlPlaceView() {
  if (wlMobileQuery.matches) {
    closeWishlist();
    document.getElementById('mobileWishlistPanel').appendChild(wishlistView);
  } else {
    wishlistModal.prepend(wishlistView);
  }
}
wlPlaceView();
wlMobileQuery.addEventListener('change', wlPlaceView);
