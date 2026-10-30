'use strict';

const $ = id => document.getElementById(id);
const audio = $('audio');
let db;
let tracks = [];
let currentId = null;
let objectUrl = null;
let selection = 0;
let lastSave = 0;
let importing = false;
const status = message => { $('status').textContent = message; };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('commute-music', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('tracks', { keyPath: 'id' });
      request.result.createObjectStore('state');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => status('数据库升级被其他标签页阻止，请关闭其他页面再重试。');
  });
}

// Resolve only after commit, so a successful import really is stored offline.
function storage(store, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error('数据库事务中止'));
    transaction.onerror = () => {}; // onabort reports the final transaction failure
  });
}

function report(error) {
  console.error(error);
  status(`操作失败：${error.message || error}。空间不足时请删除曲目；URL 导入失败时请检查网络、HTTPS 和 CORS。`);
}

function persistPosition() {
  if (!db || !currentId || audio.readyState === 0 || !Number.isFinite(audio.currentTime)) return;
  const track = tracks.find(item => item.id === currentId);
  if (!track) return;
  track.position = audio.currentTime;
  // Only write the small position record, never rewrite the audio blob while playing.
  storage('state', 'readwrite', store => store.put(track.position, `position:${track.id}`)).catch(report);
}

function render() {
  $('playlist').replaceChildren();
  $('empty').hidden = tracks.length > 0;
  for (const track of tracks) {
    const li = document.createElement('li');
    if (track.id === currentId) li.className = 'current';
    const play = document.createElement('button');
    play.textContent = `${track.id === currentId ? '▶ ' : ''}${track.name}`;
    play.addEventListener('click', () => selectTrack(track.id, true).catch(report));
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除 ${track.name}`);
    remove.addEventListener('click', () => deleteTrack(track.id).catch(report));
    li.append(play, remove);
    $('playlist').append(li);
  }
  for (const id of ['previous', 'toggle', 'next']) $(id).disabled = !tracks.length;
}

async function selectTrack(id, autoplay = false) {
  const track = tracks.find(item => item.id === id);
  if (!track) return;
  persistPosition();
  const token = ++selection;
  audio.pause();
  currentId = null; // pause events for the old source must not save into the new track
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(track.blob);
  currentId = id;
  $('now-playing').textContent = track.name;
  audio.src = objectUrl;
  audio.onloadedmetadata = () => {
    if (token !== selection) return;
    const position = track.position || 0;
    audio.currentTime = Number.isFinite(audio.duration) ? Math.min(position, Math.max(0, audio.duration - 0.1)) : position;
    updateMediaPosition();
  };
  render();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: '通勤离线音乐' });
  }
  const saved = storage('state', 'readwrite', store => store.put(id, 'lastTrack')).catch(report);
  // Call play immediately within the user's interaction for mobile autoplay policies.
  if (autoplay) {
    try { await audio.play(); } catch (error) {
      if (token === selection) status(`无法开始播放：${error.message}。请点击播放器播放按钮，或检查音频格式。`);
    }
  }
  await saved;
}

async function deleteTrack(id) {
  await storage('tracks', 'readwrite', store => store.delete(id));
  if (id === currentId) {
    ++selection;
    audio.pause();
    currentId = null;
    audio.removeAttribute('src');
    audio.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    $('now-playing').textContent = '尚未选择曲目';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
    await storage('state', 'readwrite', store => store.delete('lastTrack'));
  }
  tracks = tracks.filter(track => track.id !== id);
  await storage('state', 'readwrite', store => store.delete(`position:${id}`));
  render();
  status('曲目已删除。');
}

async function addTrack(blob, name) {
  if (!blob.size) throw new Error('音频文件为空');
  const track = { id: crypto.randomUUID(), name, blob, position: 0 };
  await storage('tracks', 'readwrite', store => store.add(track));
  tracks.push(track);
  render();
}

function step(offset) {
  if (!tracks.length) return;
  const index = tracks.findIndex(track => track.id === currentId);
  const next = index < 0 ? 0 : (index + offset + tracks.length) % tracks.length;
  selectTrack(tracks[next].id, true).catch(report);
}

function updateMediaPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate,
      position: Math.max(0, Math.min(audio.currentTime, audio.duration)) });
  } catch (_) { /* Partial Media Session implementations may reject position updates. */ }
}

$('files').addEventListener('change', async event => {
  if (importing) return;
  const files = [...event.target.files];
  importing = true;
  $('files').disabled = true;
  $('add-url').disabled = true;
  let count = 0;
  try {
    for (const file of files) {
      status(`正在保存：${file.name}`);
      await addTrack(file, file.name);
      count++;
    }
    status(`已保存 ${count} 首曲目，可离线播放。`);
  } catch (error) { report(error); }
  finally {
    importing = false;
    $('files').disabled = false;
    $('add-url').disabled = false;
    event.target.value = '';
  }
});

$('url-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (importing) return;
  importing = true;
  $('add-url').disabled = true;
  $('files').disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const url = new URL($('url').value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 HTTP/HTTPS 音频地址');
    status('正在下载音频，请保持页面打开…');
    const response = await fetch(url.href, { mode: 'cors', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (/^(text\/|application\/(json|xhtml))/.test(blob.type)) throw new Error('地址返回了网页或文本，而非音频');
    const filename = url.pathname.split('/').pop() || 'URL 音频';
    let name = filename;
    try { name = decodeURIComponent(filename); } catch (_) { /* Keep malformed URL names readable. */ }
    await addTrack(blob, name);
    $('url').value = '';
    status('下载并保存完成，可离线播放。');
  } catch (error) { report(error); }
  finally {
    clearTimeout(timeout);
    importing = false;
    $('add-url').disabled = false;
    $('files').disabled = false;
  }
});

$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('toggle').addEventListener('click', () => {
  if (!currentId && tracks.length) selectTrack(tracks[0].id, true).catch(report);
  else if (audio.paused) audio.play().catch(report);
  else audio.pause();
});
audio.addEventListener('timeupdate', () => {
  if (Date.now() - lastSave > 2000) { persistPosition(); lastSave = Date.now(); }
  updateMediaPosition();
});
audio.addEventListener('pause', () => {
  persistPosition();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('play', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('seeked', () => { persistPosition(); updateMediaPosition(); });
audio.addEventListener('ended', () => {
  const track = tracks.find(item => item.id === currentId);
  if (track) {
    track.position = 0;
    storage('state', 'readwrite', store => store.put(0, `position:${track.id}`)).catch(report);
  }
  // selectTrack saves the outgoing position; reset it before switching.
  audio.currentTime = 0;
  step(1);
});
audio.addEventListener('error', () => status('无法解码音频：请确认文件有效，且此浏览器支持该音频格式。'));
document.addEventListener('visibilitychange', () => { if (document.hidden) persistPosition(); });
window.addEventListener('pagehide', persistPosition);

if ('mediaSession' in navigator) {
  const actions = {
    play: () => { if (currentId) audio.play().catch(report); else step(1); },
    pause: () => audio.pause(),
    previoustrack: () => step(-1), nexttrack: () => step(1),
    seekbackward: details => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); },
    seekforward: details => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + (details.seekOffset || 10)); },
    seekto: details => { if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime; }
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* Unsupported action. */ }
  }
}

async function init() {
  try {
    db = await openDatabase();
    db.onversionchange = () => { db.close(); status('数据库版本发生变化，请刷新页面。'); };
    tracks = await storage('tracks', 'readonly', store => store.getAll());
    const states = await storage('state', 'readonly', store => store.getAllKeys());
    // Read positions in parallel; audio blobs are loaded once for this small prototype.
    await Promise.all(tracks.map(async track => {
      if (states.includes(`position:${track.id}`)) track.position = await storage('state', 'readonly', store => store.get(`position:${track.id}`));
    }));
    const last = await storage('state', 'readonly', store => store.get('lastTrack'));
    render();
    if (tracks.some(track => track.id === last)) await selectTrack(last);
    for (const id of ['files', 'url', 'add-url']) $(id).disabled = false;
    status(last && currentId ? '已恢复上次曲目和播放位置，点击播放继续。' : '音乐库已就绪。');
  } catch (error) { report(error); }
}

async function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offline-status').textContent = '离线应用外壳不可用：请通过 localhost 或 HTTPS 打开。';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = '应用外壳已缓存，可断网重新打开。音频需先导入。';
  } catch (error) {
    $('offline-status').textContent = `应用外壳缓存失败：${error.message}`;
  }
}
init();
registerWorker();
