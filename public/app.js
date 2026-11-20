const videoFile = document.querySelector('#videoFile');
const uploadPanel = document.querySelector('#uploadPanel');
const uploadProgress = document.querySelector('#uploadProgress');
const uploadBar = document.querySelector('#uploadBar');
const uploadPercent = document.querySelector('#uploadPercent');
const uploadLabel = document.querySelector('#uploadLabel');
const notice = document.querySelector('#notice');
const workspace = document.querySelector('#workspace');
const preview = document.querySelector('#preview');
const previewAudioPanel = document.querySelector('#previewAudioPanel');
const previewAudioStatus = document.querySelector('#previewAudioStatus');
const previewTrackList = document.querySelector('#previewTrackList');
const previewAudios = new Map();
const videoPlaceholder = document.querySelector('#videoPlaceholder');
const uploadQueuePanel = document.querySelector('#uploadQueuePanel');
const uploadQueueCount = document.querySelector('#uploadQueueCount');
const uploadQueueList = document.querySelector('#uploadQueueList');
const uploadQueueToggle = document.querySelector('#uploadQueueToggle');
const cutsList = document.querySelector('#cutsList');
const trackList = document.querySelector('#trackList');
const clipList = document.querySelector('#clipList');
const exportButton = document.querySelector('#exportButton');
const clips = [];
let activeClipId = null;
let uploading = false;
const uploadQueue = [];
let queueRunning = false;
let uploadQueueExpanded = true;

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatHmsInputs(prefix, seconds) {
  document.querySelector(`#${prefix}Time`).value = formatDurationHms(seconds);
}

function readHmsInputs(prefix) {
  const value = document.querySelector(`#${prefix}Time`).value.trim();
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{1,3})$/.exec(value);
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function formatDurationHms(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(total);
  const milliseconds = Math.round((total - whole) * 1000);
  let adjusted = whole + (milliseconds >= 1000 ? 1 : 0);
  const normalizedMilliseconds = milliseconds >= 1000 ? 0 : milliseconds;
  const hours = Math.floor(adjusted / 3600);
  const minutes = Math.floor((adjusted % 3600) / 60);
  const secs = adjusted % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(normalizedMilliseconds).padStart(3, '0')}`;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
}

function activeClip() {
  return clips.find(clip => clip.media.id === activeClipId) || null;
}

function totalDuration() {
  return clips.reduce((clipTotal, clip) => clipTotal +
    clip.cuts.reduce((cutTotal, cut) => cutTotal + cut.end - cut.start, 0), 0);
}

function updateExportSummary() {
  document.querySelector('#outputDuration').textContent = formatClock(totalDuration());
  exportButton.disabled = uploading || clips.length === 0 ||
    clips.some(clip => clip.cuts.length === 0);
  document.querySelector('#clipCount').textContent = `${clips.length}本`;
}

function renderClipList() {
  clipList.replaceChildren();
  if (clips.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'clip-empty';
    empty.textContent = '動画ファイルを追加すると、ここに連結順で表示されます。';
    clipList.append(empty);
  }

  clips.forEach((clip, index) => {
    const row = document.createElement('div');
    row.className = `clip-row${clip.media.id === activeClipId ? ' active' : ''}`;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'clip-select';
    select.addEventListener('click', () => selectClip(clip.media.id));

    const number = document.createElement('span');
    number.className = 'clip-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const description = document.createElement('span');
    description.className = 'clip-description';
    const name = document.createElement('strong');
    name.textContent = clip.media.filename;
    const length = clip.cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);
    const details = document.createElement('small');
    details.textContent = `${formatClock(length)} 使用 · ${clip.cuts.length}区間`;
    description.append(name, details);
    select.append(number, description);

    const actions = document.createElement('span');
    actions.className = 'clip-actions';
    const up = createClipAction('↑', '上へ移動', index === 0, () => moveClip(index, -1));
    const down = createClipAction('↓', '下へ移動', index === clips.length - 1, () => moveClip(index, 1));
    const remove = createClipAction('×', '動画を削除', false, () => removeClip(index));
    remove.classList.add('remove');
    actions.append(up, down, remove);
    row.append(select, actions);
    clipList.append(row);
  });
  updateExportSummary();
}

function createClipAction(text, label, disabled, callback) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'clip-action';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.disabled = disabled;
  button.addEventListener('click', callback);
  return button;
}

function moveClip(index, offset) {
  const destination = index + offset;
  if (destination < 0 || destination >= clips.length) return;
  [clips[index], clips[destination]] = [clips[destination], clips[index]];
  renderClipList();
}

function removeClip(index) {
  const [removed] = clips.splice(index, 1);
  fetch(`/api/media/${removed.media.id}`, { method: 'DELETE' })
    .then(response => response.json().then(body => {
      if (!response.ok) throw new Error(body.error || '一時ファイルを削除できませんでした。');
      showNotice(`${removed.media.filename} と関連する一時ファイルを削除しました。`);
    }))
    .catch(error => showNotice(error.message, true));
  if (removed.media.id === activeClipId) {
    const next = clips[Math.min(index, clips.length - 1)];
    activeClipId = next ? next.media.id : null;
    if (next) displayClip(next);
    else {
      preview.removeAttribute('src');
      preview.load();
      workspace.classList.add('hidden');
    }
  }
  renderClipList();
  if (clips.length === 0) showNotice('動画を追加してください。');
}

function selectClip(id) {
  const clip = clips.find(item => item.media.id === id);
  if (!clip) return;
  activeClipId = id;
  displayClip(clip);
  renderClipList();
}

function displayClip(clip) {
  workspace.classList.remove('hidden');
  preview.src = `/api/media/${clip.media.id}/file`;
  preview.muted = true;
  preview.volume = 1;
  preview.load();
  document.querySelector('#mediaName').textContent = clip.media.filename;
  document.querySelector('#mediaInfo').textContent =
    `${clip.media.width || '?'} × ${clip.media.height || '?'} · ${clip.media.videoCodec || '動画'} · ${clip.media.audioTracks.length} 音声トラック`;
  document.querySelector('#durationPill').textContent = formatClock(clip.media.duration);
  formatHmsInputs('cutStart', 0);
  formatHmsInputs('cutEnd', clip.media.duration);
  renderCuts();
  renderTracks();
  previewTrackList.replaceChildren();
  previewAudios.clear();
  previewAudioPanel.classList.remove('hidden');
  previewAudioStatus.textContent = '音声を生成中';
  preparePreviewAudio(clip);
  videoPlaceholder.classList.remove('hidden');
}

function renderCuts() {
  cutsList.replaceChildren();
  const clip = activeClip();
  if (!clip) return;
  if (clip.cuts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.textContent = 'この動画から書き出す範囲を追加してください。';
    cutsList.append(empty);
  }
  clip.cuts.forEach((cut, index) => {
    const row = document.createElement('div');
    row.className = 'cut-row';
    const number = document.createElement('span');
    number.className = 'cut-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const times = document.createElement('span');
    times.className = 'cut-times';
    times.textContent = `${formatDurationHms(cut.start)} – ${formatDurationHms(cut.end)}`;
    const length = document.createElement('span');
    length.className = 'cut-duration';
    length.textContent = `${(cut.end - cut.start).toFixed(1)} 秒`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-cut';
    remove.setAttribute('aria-label', `${index + 1}番目の区間を削除`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      clip.cuts.splice(index, 1);
      renderCuts();
      renderClipList();
    });
    row.append(number, times, length, remove);
    cutsList.append(row);
  });
  updateExportSummary();
}

function renderTracks() {
  trackList.replaceChildren();
  const clip = activeClip();
  if (!clip) return;
  clip.media.audioTracks.forEach(track => {
    const label = document.createElement('label');
    label.className = 'track-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(track.index);
    checkbox.checked = clip.audioTracks.includes(track.index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && !clip.audioTracks.includes(track.index)) {
        clip.audioTracks.push(track.index);
      } else {
        clip.audioTracks = clip.audioTracks.filter(index => index !== track.index);
      }
      preparePreviewAudio(clip);
    });
    const title = document.createElement('span');
    title.className = 'track-title';
    const name = document.createElement('strong');
    name.textContent = track.title
      ? `${track.title}${track.default ? '（既定）' : ''}`
      : `音声トラック ${track.number}${track.default ? '（既定）' : ''}`;
    const details = document.createElement('small');
    details.textContent = [track.language, track.codec.toUpperCase()].filter(Boolean).join(' · ');
    title.append(name, details);
    const channels = document.createElement('span');
    channels.className = 'track-channel';
    channels.textContent = `${track.channels} ch`;
    label.append(checkbox, title, channels);
    trackList.append(label);
  });
  if (!clip.media.audioTracks.length) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.textContent = '音声トラックがありません。この動画は無音で連結します。';
    trackList.append(empty);
  }
}

async function preparePreviewAudio(clip) {
  previewTrackList.replaceChildren();
  previewAudios.forEach(audio => {
    audio.pause();
    audio.removeAttribute('src');
  });
  previewAudios.clear();

  if (!clip.audioTracks.length) {
    previewAudioStatus.textContent = '無音';
    return;
  }
  previewAudioPanel.classList.remove('hidden');
  previewAudioStatus.textContent = '生成中 0%';
  try {
    const response = await fetch(`/api/media/${clip.media.id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: clip.audioTracks })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'プレビュー音声を開始できませんでした。');
    previewAudioStatus.textContent = '';
    await Promise.all(body.jobs.map(async previewJob => {
      const track = clip.media.audioTracks.find(item => item.index === previewJob.track);
      const row = document.createElement('div');
      row.className = 'preview-track';
      const name = document.createElement('span');
      name.className = 'preview-track-name';
      name.textContent = track.title
        ? track.title
        : `音声トラック ${track.number}`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      const conversion = document.createElement('div');
      conversion.className = 'preview-track-conversion';
      const conversionLabel = document.createElement('span');
      conversionLabel.className = 'conversion-label';
      conversionLabel.textContent = '変換中 0%';
      const conversionBar = document.createElement('progress');
      conversionBar.max = 100;
      conversionBar.value = 0;
      conversion.append(conversionLabel, conversionBar);
      row.append(name, audio, conversion);
      previewTrackList.append(row);
      previewAudios.set(previewJob.track, audio);

      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (activeClipId !== clip.media.id) return;
        const statusResponse = await fetch(`/api/media/${clip.media.id}/preview/${previewJob.id}/status`);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || '生成状態を取得できませんでした。');
        if (status.status === 'error') throw new Error(status.error);
        const trackPercentage = Math.round(status.progress * 100);
        conversionLabel.textContent = `変換中 ${trackPercentage}%`;
        conversionBar.value = trackPercentage;
        if (status.status === 'done') {
          audio.src = `/api/media/${clip.media.id}/preview/${previewJob.id}/file`;
          audio.load();
          conversionLabel.textContent = 'MP3変換完了';
          conversionBar.value = 100;
          return;
        }
      }
    }));
  } catch (error) {
    previewAudioStatus.textContent = '生成失敗';
    showNotice(error.message, true);
  }
}

function uploadSingleFile(file, onProgress) {
  return (async () => {
    const startResponse = await fetch('/api/media/upload/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size })
    });
    const start = await startResponse.json();
    if (!startResponse.ok) throw new Error(start.error || `${file.name} を追加できませんでした。`);

    const chunkSize = 16 * 1024 * 1024;
    let uploaded = 0;
    for (let chunkIndex = 0, offset = 0; offset < file.size; chunkIndex += 1, offset += chunkSize) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
      const chunkResponse = await fetch('/api/media/upload/chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Id': start.id,
          'X-Chunk-Index': String(chunkIndex)
        },
        body: chunk
      });
      const chunkResult = await chunkResponse.json();
      if (!chunkResponse.ok) throw new Error(chunkResult.error || `${file.name} の送信に失敗しました。`);
      uploaded = chunkResult.received;
      if (onProgress) onProgress(Math.round(uploaded / file.size * 100));
    }

    const completeResponse = await fetch('/api/media/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: start.id })
    });
    const media = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(media.error || `${file.name} を解析できませんでした。`);
    return media;
  })();
}

async function uploadFiles(files) {
  if (files.length === 0) return;
  uploadQueueExpanded = true;
  uploadQueue.push(...[...files].map(file => ({
    file,
    status: 'waiting',
    progress: 0
  })));
  renderUploadQueue();
  showNotice(uploadQueue.length > 1
    ? `${uploadQueue.length}件を順番に追加します。`
    : '動画を追加キューに登録しました。');
  processUploadQueue();
}

function renderUploadQueue() {
  uploadQueueList.replaceChildren();
  uploadQueuePanel.classList.toggle('hidden', uploadQueue.length === 0);
  uploadQueueCount.textContent = `${uploadQueue.length}件`;
  uploadQueueToggle.textContent = uploadQueueExpanded ? '▲ 閉じる' : '▼ 開く';
  uploadQueueToggle.setAttribute('aria-expanded', String(uploadQueueExpanded));
  uploadQueueList.classList.toggle('hidden', !uploadQueueExpanded);
  uploadQueue.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `upload-queue-row ${item.status}`;
    const number = document.createElement('span');
    number.className = 'upload-queue-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'upload-queue-name';
    name.textContent = item.file.name;
    const status = document.createElement('span');
    status.className = 'upload-queue-status';
    status.textContent = item.status === 'uploading'
      ? `アップロード中 ${item.progress}%`
      : item.status === 'complete'
        ? '完了'
        : item.status === 'error'
          ? '失敗'
          : '待機中';
    const progress = document.createElement('progress');
    progress.className = 'upload-queue-progress';
    progress.max = 100;
    progress.value = item.progress;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'upload-queue-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${item.file.name}をキューから削除`);
    remove.disabled = item.status === 'uploading';
    remove.addEventListener('click', () => {
      const queuedIndex = uploadQueue.indexOf(item);
      if (queuedIndex >= 0) {
        uploadQueue.splice(queuedIndex, 1);
        renderUploadQueue();
      }
    });
    row.append(number, name, status, progress, remove);
    uploadQueueList.append(row);
  });
}

uploadQueueToggle.addEventListener('click', () => {
  uploadQueueExpanded = !uploadQueueExpanded;
  renderUploadQueue();
});

async function processUploadQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (uploadQueue.some(item => item.status === 'waiting')) {
    const batchItems = uploadQueue.filter(item => item.status === 'waiting');
    batchItems.forEach(item => { item.status = 'uploading'; });
    renderUploadQueue();
    const batch = batchItems.map(item => item.file);
    if (clips.length + batch.length > 100) {
      showNotice('連結できる動画は最大100本です。', true);
      continue;
    }
    uploading = true;
    uploadPanel.classList.add('uploading');
    uploadProgress.classList.remove('hidden');
    try {
    const progress = new Array(batch.length).fill(0);
    const uploadPromises = batch.map((file, index) => {
      uploadLabel.textContent = `${batch.length}本を並行で追加中`;
      showNotice(`${batch.length}本の動画をローカルサーバーへ転送しています。`);
      return uploadSingleFile(file, percentage => {
        progress[index] = percentage;
        batchItems[index].progress = percentage;
        renderUploadQueue();
        const overall = Math.round(progress.reduce((sum, value) => sum + value, 0) / batch.length);
        uploadBar.value = overall;
        uploadPercent.textContent = `${overall}%`;
      });
    });

    const mediaItems = await Promise.allSettled(uploadPromises);
    let failed = 0;
    const successfulMedia = [];
    mediaItems.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successfulMedia.push(result.value);
        batchItems[index].status = 'complete';
        batchItems[index].progress = 100;
      } else {
        failed += 1;
        batchItems[index].status = 'error';
        batchItems[index].progress = 0;
        showNotice(`${batch[index].name}: ${result.reason.message}`, true);
      }
    });
    renderUploadQueue();

    for (const media of successfulMedia) {
      const defaultTrack = media.audioTracks.find(track => track.default);
      clips.push({
        media,
        cuts: [{ start: 0, end: media.duration }],
        defaultCut: true,
        audioTracks: defaultTrack ? [defaultTrack.index] : []
      });
      if (!activeClipId) {
        activeClipId = media.id;
        displayClip(clips[0]);
      }
      renderClipList();
    }
    if (failed === 0) {
      showNotice(`${successfulMedia.length}本の動画を一度に追加しました。順番を確認し、必要なら入れ替えてください。`);
    } else if (successfulMedia.length > 0) {
      showNotice(`${successfulMedia.length}本を追加しました。失敗は${failed}本です。`);
    }
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      uploading = false;
      uploadPanel.classList.remove('uploading');
      uploadProgress.classList.add('hidden');
      videoFile.disabled = false;
      videoFile.value = '';
      updateExportSummary();
    }
    setTimeout(() => {
      batchItems.forEach(item => {
        const index = uploadQueue.indexOf(item);
        if (index >= 0) uploadQueue.splice(index, 1);
      });
      renderUploadQueue();
    }, 1500);
  }
  queueRunning = false;
}

document.querySelector('#markStart').addEventListener('click', () => {
  formatHmsInputs('cutStart', preview.currentTime);
});
document.querySelector('#markEnd').addEventListener('click', () => {
  formatHmsInputs('cutEnd', preview.currentTime);
});
document.querySelector('#addCut').addEventListener('click', () => {
  const clip = activeClip();
  if (!clip) return;
  const start = readHmsInputs('cutStart');
  const end = readHmsInputs('cutEnd');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 ||
      end <= start || end > clip.media.duration) {
    showNotice('開始・終了時刻を確認してください。終了は動画の長さ以内に設定してください。', true);
    return;
  }
  if (clip.defaultCut) {
    clip.cuts = [];
    clip.defaultCut = false;
  }
  if (clip.cuts.some(cut => start < cut.end && end > cut.start)) {
    showNotice('既存の使用区間と重ならないように設定してください。', true);
    return;
  }
  clip.cuts.push({ start, end });
  clip.cuts.sort((left, right) => left.start - right.start);
  renderCuts();
  renderClipList();
  showNotice(`${clip.media.filename} に使用区間を追加しました。`);
});
preview.addEventListener('loadedmetadata', () => videoPlaceholder.classList.add('hidden'));
preview.addEventListener('loadeddata', () => {
  preview.muted = true;
  preview.volume = 1;
});
preview.addEventListener('play', () => {
  preview.muted = true;
  preview.volume = 1;
  previewAudios.forEach(audio => {
    if (audio.src) {
      audio.currentTime = preview.currentTime;
      audio.play().catch(() => {});
    }
  });
});
preview.addEventListener('pause', () => previewAudios.forEach(audio => audio.pause()));
preview.addEventListener('seeked', () => {
  previewAudios.forEach(audio => {
    if (audio.src) audio.currentTime = preview.currentTime;
  });
});
preview.addEventListener('error', () => {
  videoPlaceholder.classList.remove('hidden');
  videoPlaceholder.lastElementChild.textContent = 'プレビューを表示できません。書き出しは可能です。';
});
videoFile.addEventListener('change', () => uploadFiles([...videoFile.files]));

['dragenter', 'dragover'].forEach(eventName => {
  uploadPanel.addEventListener(eventName, event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    uploadPanel.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  uploadPanel.addEventListener(eventName, event => {
    event.preventDefault();
    uploadPanel.classList.remove('drag-over');
  });
});

uploadPanel.addEventListener('drop', event => {
  const files = [...event.dataTransfer.files].filter(file =>
    file.type.startsWith('video/') ||
    /\.(mp4|mov|mkv|webm|mts|m2ts|avi|m4v)$/i.test(file.name)
  );
  if (files.length === 0) {
    showNotice('動画ファイルをドロップしてください。', true);
    return;
  }
  if (files.length !== event.dataTransfer.files.length) {
    showNotice(`${files.length}本の動画を追加します。動画以外のファイルは除外しました。`, false);
  }
  uploadFiles(files);
});

exportButton.addEventListener('click', async () => {
  if (exportButton.disabled) return;
  exportButton.disabled = true;
  document.querySelector('#renderStatus').classList.remove('hidden');
  document.querySelector('#renderLabel').textContent = '連結して書き出し中...';
  document.querySelector('#renderPercent').textContent = '0%';
  document.querySelector('#renderBar').value = 0;
  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips: clips.map(clip => ({
          id: clip.media.id,
          cuts: clip.cuts,
          audioTracks: clip.audioTracks
        }))
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '書き出しを開始できませんでした。');
    await pollExport(body.id);
    window.location.href = `/api/export/${body.id}/download`;
    document.querySelector('#renderLabel').textContent = 'ダウンロードを開始しました';
  } catch (error) {
    document.querySelector('#renderLabel').textContent = error.message;
    showNotice(error.message, true);
  } finally {
    updateExportSummary();
  }
});

async function pollExport(jobId) {
  const startedAt = Date.now();
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(`/api/export/${jobId}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || '書き出しの状態を取得できませんでした。');
    const percentage = Math.round(job.progress * 100);
    document.querySelector('#renderBar').value = percentage;
    document.querySelector('#renderPercent').textContent = `${percentage}%`;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const progress = Math.max(job.progress, 0);
    const remainingSeconds = progress > 0.01
      ? Math.max(0, elapsedSeconds * (1 - progress) / progress)
      : null;
    document.querySelector('#remainingTime').textContent = remainingSeconds === null
      ? '推定残り時間: 計算中'
      : `推定残り時間: ${formatDurationHms(remainingSeconds)}`;
    if (job.status === 'error') throw new Error(job.error);
    if (job.status === 'done') return;
  }
}

renderClipList();
