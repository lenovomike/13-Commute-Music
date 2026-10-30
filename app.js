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
    const request = indexedDB.open('commute-music', 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('state')) database.createObjectStore('state');
      if (!database.objectStoreNames.contains('playlists')) database.createObjectStore('playlists', { keyPath: 'id' });
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
  status(`操作失败：${error.message || error}。空间不足时请删除曲目后重试。`);
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
    play.addEventListener('click', () => { activeList = ''; queueCursor = -1; selectTrack(track.id, true).catch(report); });
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除 ${track.name}`);
    remove.addEventListener('click', () => deleteTrack(track.id).catch(report));
    li.append(play, remove);
    $('playlist').append(li);
  }
  renderLists();
  for (const id of ['previous', 'toggle', 'next']) $(id).disabled = !playQueue().length;
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
  return track;
}

function step(offset) {
  const queue = playQueue();
  if (!queue.length) return;
  const index = activeList ? queueCursor : queue.findIndex(item => item.id === currentId);
  queueCursor = index < 0 ? 0 : (index + offset + queue.length) % queue.length;
  selectTrack(queue[queueCursor].id, true).catch(report);
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

    event.target.value = '';
  }
});

$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('toggle').addEventListener('click', () => {
  if (!currentId && playQueue().length) step(1);
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
    lists = await storage('playlists', 'readonly', store => store.getAll());
    const states = await storage('state', 'readonly', store => store.getAllKeys());
    // Read positions in parallel; audio blobs are loaded once for this small prototype.
    await Promise.all(tracks.map(async track => {
      if (states.includes(`position:${track.id}`)) track.position = await storage('state', 'readonly', store => store.get(`position:${track.id}`));
    }));
    const last = await storage('state', 'readonly', store => store.get('lastTrack'));
    render();
    if (tracks.some(track => track.id === last)) await selectTrack(last);
    for (const id of ['files', 'list-name', 'list-text', 'list-file', 'save-list', 'list-select']) $(id).disabled = false;
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


function waitForWorker(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('更新超时，请重试')), 20000);
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('更新未完成，请重试'));
    };
    function finish(error) {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      if (error) reject(error); else resolve();
    }
    worker.addEventListener('statechange', check);
    worker.postMessage({ type: 'SKIP_WAITING' });
    check();
  });
}

$('refresh').onclick = async () => {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = '刷新中…';
  $('refresh-status').textContent = '正在检查并更新应用…';
  try {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      const registration = await navigator.serviceWorker.getRegistration()
        || await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      await registration.update();
      const worker = registration.installing || registration.waiting || registration.active;
      if (worker && worker.state !== 'activated') await waitForWorker(worker);
      // The active worker fetches every shell asset bypassing the HTTP cache,
      // including when the deployed sw.js itself has not changed.
      await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => finish(new Error('刷新超时，请检查网络后重试')), 20000);
        function finish(error) {
          clearTimeout(timer);
          channel.port1.close();
          if (error) reject(error); else resolve();
        }
        channel.port1.onmessage = event => finish(event.data.ok ? null : new Error(event.data.error));
        (registration.active || worker).postMessage({ type: 'REFRESH_SHELL' }, [channel.port2]);
      });
    }
    location.reload();
  } catch (error) {
    $('refresh-status').textContent = `刷新失败：${error.message}。请联网后重试，本地音乐和歌单仍保留。`;
    button.disabled = false;
    button.textContent = '刷新';
  }
};


let lists = [];
let activeList = '';
let queueCursor = -1;
const currentList = () => lists.find(list => list.id === activeList);

function normalize(value) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}
function parts(value) {
  return value.replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i, '')
    .split(/\s+[-–—]\s+|[&、/]|\s+(?:feat\.?|ft\.?)\s+/i).map(normalize).filter(Boolean).sort();
}
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}
function matchEntry(entry) {
  const manual = tracks.find(track => track.id === entry.trackId);
  if (manual) return manual;
  const needle = normalize(entry.text);
  const tokens = parts(entry.text);
  let best = null;
  let score = 0;
  let tied = false;
  for (const track of tracks) {
    const candidates = [track.name, track.title].filter(Boolean);
    let value = 0;
    for (const candidate of candidates) {
      const other = parts(candidate);
      const ordered = tokens.join('');
      const otherOrdered = other.join('');
      value = Math.max(value, similarity(needle, normalize(candidate)), similarity(ordered, otherOrdered));
      // A plain song title can match a filename containing title and artist.
      if (tokens.length === 1 && other.includes(needle)) value = 1;
      if (other.length === 1 && tokens.includes(normalize(candidate))) value = Math.max(value, 0.94);
    }
    if (value > score) { best = track; score = value; tied = false; }
    else if (value === score) tied = true;
  }
  return score >= 0.86 && !tied ? best : null;
}
function playQueue() {
  const list = currentList();
  return list ? list.entries.map(matchEntry).filter(Boolean) : tracks;
}
function renderLists() {
  const select = $('list-select');
  select.replaceChildren(new Option('本地音乐库', ''));
  for (const list of lists) select.add(new Option(list.name, list.id));
  select.value = activeList;
  const list = currentList();
  $('list-items').replaceChildren();
  $('list-actions').hidden = !list;
  if (!list) { $('list-summary').textContent = '选择歌单查看匹配结果，或创建新歌单。'; return; }
  const matches = list.entries.map(matchEntry);
  const count = matches.filter(Boolean).length;
  $('list-summary').textContent = `共 ${list.entries.length} 首 · 已有 ${count} 首 · 缺少 ${list.entries.length - count} 首`;
  $('play-list').disabled = !count;
  $('copy-missing').disabled = count === list.entries.length;
  list.entries.forEach((entry, index) => {
    const track = matches[index];
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${entry.text} · ${track ? '已有' : '缺少'}`;
    label.className = track ? 'available' : 'missing';
    li.append(label);
    if (track) {
      const play = document.createElement('button');
      play.textContent = '播放';
      play.title = `本地文件：${track.name}`;
      play.onclick = () => {
        queueCursor = matches.slice(0, index).filter(Boolean).length;
        selectTrack(track.id, true).catch(report);
      };
      li.append(play);
    }
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = track ? `关联：${track.name}（更改）` : '手动关联 / 上传文件';
    const choice = document.createElement('select');
    choice.setAttribute('aria-label', `为 ${entry.text} 选择本地曲目`);
    choice.add(new Option('选择本地曲目', ''));
    for (const item of tracks) choice.add(new Option(item.name, item.id));
    choice.value = track?.id || '';
    choice.onchange = async () => {
      if (!choice.value) return;
      try { entry.trackId = choice.value; await saveList(list); render(); } catch (error) { report(error); }
    };
    const upload = document.createElement('input');
    upload.type = 'file'; upload.accept = 'audio/*';
    upload.setAttribute('aria-label', `为 ${entry.text} 上传音频`);
    upload.onchange = async () => {
      const file = upload.files[0];
      if (!file) return;
      upload.disabled = true;
      try {
        const added = await addTrack(file, file.name);
        entry.trackId = added.id;
        await saveList(list); render(); status('音频已保存并关联。');
      } catch (error) { report(error); upload.disabled = false; }
    };
    details.append(summary, choice, upload); li.append(details);
    $('list-items').append(li);
  });
}
const saveList = list => storage('playlists', 'readwrite', store => store.put(list));

function csvRows(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell.trim()); cell = '';
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else cell += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(cell.trim()); rows.push(row);
  return rows.filter(row => row.some(Boolean));
}
function parseList(text, extension = 'txt') {
  text = text.replace(/^\uFEFF/, '');
  if (extension === 'csv') {
    const rows = csvRows(text);
    if (!rows.length) return [];
    const header = rows[0].map(value => value.toLowerCase());
    const title = header.findIndex(value => /^(歌名|歌曲|标题|title|name|song)$/.test(value));
    const artist = header.findIndex(value => /^(歌手|艺人|artist|artists)$/.test(value));
    return (title >= 0 ? rows.slice(1) : rows).map(row => {
      const name = row[title >= 0 ? title : 0];
      const singer = row[artist >= 0 ? artist : title >= 0 ? -1 : 1];
      return name ? name + (singer ? ` - ${singer}` : '') : '';
    }).filter(Boolean);
  }
  const result = []; let info = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (extension === 'm3u' || extension === 'm3u8') {
      if (/^#EXTINF:/i.test(line)) { info = line.slice(line.indexOf(',') + 1).trim(); continue; }
      if (line.startsWith('#')) continue;
      const filename = line.split(/[\\/]/).pop().split(/[?#]/)[0];
      result.push(info || filename.replace(/\.[^.]+$/, '')); info = '';
    } else if (!line.startsWith('#')) result.push(line);
  }
  return result.filter(Boolean);
}
$('list-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const file = $('list-file').files[0];
    const lines = parseList($('list-text').value);
    if (file) lines.push(...parseList(await file.text(), file.name.split('.').pop().toLowerCase()));
    if (!lines.length) throw new Error('请粘贴歌名或选择非空歌单文件');
    const list = { id: crypto.randomUUID(), name: $('list-name').value.trim() || file?.name.replace(/\.[^.]+$/, '') || '未命名歌单', entries: lines.map(text => ({ text })) };
    await saveList(list); lists.push(list); activeList = list.id; queueCursor = -1;
    $('list-form').reset(); render(); status(`已保存歌单「${list.name}」，共 ${lines.length} 首。`);
  } catch (error) { report(error); }
};
$('list-select').onchange = event => { activeList = event.target.value; queueCursor = -1; render(); };
$('play-list').onclick = () => { queueCursor = -1; step(1); };
$('delete-list').onclick = async () => {
  const list = currentList(); if (!list) return;
  try {
    await storage('playlists', 'readwrite', store => store.delete(list.id));
    lists = lists.filter(item => item.id !== list.id); activeList = ''; queueCursor = -1; render(); status('歌单已删除，本地音频仍保留。');
  } catch (error) { report(error); }
};
$('copy-missing').onclick = async () => {
  const text = currentList()?.entries.filter(entry => !matchEntry(entry)).map(entry => entry.text).join('\n');
  if (!text) return;
  try { await navigator.clipboard.writeText(text); status('已复制缺少列表。'); }
  catch (_) {
    $('copy-text').hidden = false; $('copy-text').value = text; $('copy-text').select();
    status('无法自动复制，请长按下方文本手动复制。');
  }
};
init();
registerWorker();
