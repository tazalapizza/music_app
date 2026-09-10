// recommendations.js — Recommendations panel pane (desktop only, via the
// .lyrics-box-wrap display:none on mobile in responsive.css). Fetches
// similar-track suggestions for the current track from /api/recommendations
// (server-side Last.fm proxy, see server.js) and renders them as a simple
// list. Depends on: state.js, selection.js (api()), playback.js.

const recommendationsListEl = document.getElementById('recommendationsList');
const recommendationsEmptyEl = document.getElementById('recommendationsEmpty');

let recommendationsTrackPath = null;

function renderRecommendations(tracks) {
  recommendationsListEl.innerHTML = '';
  const hasTracks = !!(tracks && tracks.length);
  recommendationsEmptyEl.classList.toggle('hidden', hasTracks);
  if (!hasTracks) return;
  tracks.forEach((t) => {
    const row = document.createElement('a');
    row.className = 'recommendation-row';
    const fallbackUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artist} ${t.title} "topic"`)}`;
    row.href = fallbackUrl;
    row.target = '_blank';
    row.rel = 'noopener';
    row.addEventListener('click', (e) => {
      e.preventDefault();
      openYoutubeLinkForTrack(t.artist, t.title, fallbackUrl);
    });
    if (t.image) {
      const img = document.createElement('img');
      img.className = 'recommendation-art';
      img.src = t.image;
      img.alt = '';
      row.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'recommendation-art-icon';
      icon.textContent = '🎵';
      row.appendChild(icon);
    }
    const text = document.createElement('div');
    text.className = 'recommendation-text';
    const titleEl = document.createElement('div');
    titleEl.className = 'recommendation-title';
    titleEl.textContent = t.title;
    text.appendChild(titleEl);
    const artistEl = document.createElement('div');
    artistEl.className = 'recommendation-artist';
    artistEl.textContent = t.album ? `${t.artist} — ${t.album}` : t.artist;
    text.appendChild(artistEl);
    row.appendChild(text);
    recommendationsListEl.appendChild(row);
  });
}

// Resolves the actual YouTube video for a track via the server-side lookup,
// so the recommendations panel opens the real song rather than a search
// page. The lookup is awaited BEFORE opening the tab, since redirecting an
// already-open tab is unreliable across browsers (notably mobile Safari).
async function openYoutubeLinkForTrack(artist, title, fallbackUrl) {
  let url = fallbackUrl;
  try {
    const data = await api(`/api/youtube-link?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
    if (data.found) url = data.url;
  } catch {
    // fall back to the search link
  }
  window.open(url, '_blank', 'noopener');
  await navigator.clipboard?.writeText(url).catch(() => {});
  if (settings.openUploadManagerOnRecommendationClick) openDownloadModal();
}

async function loadRecommendationsForTrack(trackPath) {
  recommendationsTrackPath = trackPath;
  renderRecommendations(null);
  try {
    const data = await api(`/api/recommendations?path=${encodeURIComponent(trackPath)}`);
    if (recommendationsTrackPath !== trackPath) return; // a newer track started before this resolved
    renderRecommendations(data.tracks);
  } catch {
    if (recommendationsTrackPath !== trackPath) return;
    renderRecommendations(null);
  }
}
