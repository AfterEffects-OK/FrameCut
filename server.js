const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createInterface } = require('node:readline');
const { buildRenderArgs } = require('./lib/render');

function addToExecutablePath(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  const entries = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  if (!entries.some(entry => path.resolve(entry || '.') === path.resolve(directory))) {
    process.env.PATH = `${directory}${path.delimiter}${process.env.PATH || ''}`;
  }
}

function configureFfmpegPath() {
  if (process.platform !== 'win32') return;
  const candidates = [
    process.env.FFMPEG_BIN,
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const candidateStat = fs.statSync(candidate);
    if (!candidateStat.isDirectory()) {
      if (path.basename(candidate).toLowerCase() === 'ffmpeg.exe') addToExecutablePath(path.dirname(candidate));
      continue;
    }
    if (fs.existsSync(path.join(candidate, 'ffmpeg.exe'))) {
      addToExecutablePath(candidate);
      return;
    }
  }

  const packageRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packageRoot)) {
    const packageMatches = fs.readdirSync(packageRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.toLowerCase().includes('ffmpeg'))
      .map(entry => path.join(packageRoot, entry.name));
    for (const packageMatch of packageMatches) {
      const bin = findFfmpegBin(packageMatch);
      if (bin) {
        addToExecutablePath(bin);
        return;
      }
    }
  }
}

function findFfmpegBin(directory, depth = 0) {
  if (depth > 5 || !fs.existsSync(directory)) return null;
  if (fs.existsSync(path.join(directory, 'ffmpeg.exe'))) return directory;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const result = findFfmpegBin(path.join(directory, entry.name), depth + 1);
    if (result) return result;
  }
  return null;
}

configureFfmpegPath();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
function chooseTempRoot() {
  if (process.env.TEMP_DIR) return path.resolve(process.env.TEMP_DIR);

  const candidates = new Set([
    path.parse(__dirname).root,
    path.parse(os.tmpdir()).root,
    process.env.SYSTEMDRIVE ? `${process.env.SYSTEMDRIVE}\\` : null
  ].filter(Boolean));

  if (process.platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (fs.existsSync(drive)) candidates.add(drive);
    }
  }

  let selected = path.parse(__dirname).root;
  let largestFree = -1;
  for (const root of candidates) {
    try {
      const disk = fs.statfsSync(root);
      const freeBytes = disk.bfree * disk.bsize;
      if (freeBytes > largestFree) {
        largestFree = freeBytes;
        selected = root;
      }
    } catch {
      // Unavailable drives are ignored.
    }
  }
  return path.join(selected, 'video-cut-editor-temp');
}

const TEMP_ROOT = chooseTempRoot();
const TEMP_DIR = path.join(TEMP_ROOT, `session-${process.pid}`);
const mediaFiles = new Map();
const jobs = new Map();
const previewJobs = new Map();
const uploadSessions = new Map();

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(Object.assign(new Error('リクエストが大きすぎます。'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('JSONの形式が正しくありません。'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeFilename(filename) {
  const base = path.basename(filename || 'video.mp4').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return base || 'video.mp4';
}

function videoContentType(filename) {
  return {
    '.avi': 'video/x-msvideo',
    '.m2ts': 'video/mp2t',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mts': 'video/mp2t',
    '.webm': 'video/webm'
  }[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function disposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function runProbe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      filePath
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new Error(`ffprobeを起動できません。FFmpegをインストールし、PATHを確認してください。 (${error.message})`)));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`動画情報を読み取れませんでした。${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('ffprobeの出力を解析できませんでした。'));
      }
    });
  });
}

function mediaResponse(id, entry) {
  const streams = entry.probe.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audioTracks = streams.filter(stream => stream.codec_type === 'audio').map((stream, index) => ({
    index: stream.index,
    number: index + 1,
    codec: stream.codec_name || 'unknown',
    channels: stream.channels || 0,
    channelLayout: stream.channel_layout || '',
    language: (stream.tags && stream.tags.language) || '',
    title: (stream.tags && stream.tags.title) || '',
    default: Boolean(stream.disposition && stream.disposition.default)
  }));
  return {
    id,
    filename: entry.filename,
    duration: Number(entry.probe.format && entry.probe.format.duration) || Number(video && video.duration) || 0,
    width: video && video.width,
    height: video && video.height,
    videoIndex: video && video.index,
    videoCodec: video && video.codec_name,
    audioTracks
  };
}

function startPreview(job, entry, trackIndexes) {
  const outputPath = path.join(TEMP_DIR, `${job.id}.mp3`);
  job.outputPath = outputPath;
  const trackIndex = trackIndexes[0];
  const args = [
    '-hide_banner',
    '-y',
    '-i', entry.path,
    '-map', `0:${trackIndex}`,
    '-vn',
    '-codec:a', 'libmp3lame',
    '-b:a', '192k',
    '-progress', 'pipe:1',
    '-nostats',
    outputPath
  ];
  const child = spawn('ffmpeg', args, { windowsHide: true });
  job.child = child;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const progress = createInterface({ input: child.stdout });
  progress.on('line', line => {
    const [key, value] = line.split('=');
    if (key === 'out_time_ms') {
      job.progress = Math.min(0.99, Number(value) / 1_000_000 / job.duration);
    } else if (key === 'progress' && value === 'end') {
      job.progress = 1;
    }
  });
  child.on('error', error => {
    job.status = 'error';
    job.error = `ffmpegを起動できません。 (${error.message})`;
  });
  child.on('close', code => {
    job.child = null;
    if (code === 0) {
      job.status = 'done';
      job.progress = 1;
    } else {
      job.status = 'error';
      job.error = `プレビュー音声を生成できませんでした。${stderr.slice(-3000).trim()}`;
      fsp.unlink(outputPath).catch(() => {});
    }
  });
}

function streamFile(req, res, filePath, filename, contentType) {
  fsp.stat(filePath).then(stat => {
    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) start = Math.max(0, stat.size - Number(match[2]));
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        ...(filename ? { 'Content-Disposition': disposition(filename) } : {})
      });
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        ...(filename ? { 'Content-Disposition': disposition(filename) } : {})
      });
    }
    const source = fs.createReadStream(filePath, { start, end });
    source.on('error', () => res.destroy());
    source.pipe(res);
    if (filename) source.on('end', () => fsp.unlink(filePath).catch(() => {}));
  }).catch(error => {
    if (!res.headersSent) sendJson(res, 404, { error: error.message });
  });
}

function startRender(job, clips, width, height) {
  const outputPath = path.join(TEMP_DIR, `${job.id}.mp4`);
  job.outputPath = outputPath;
  const args = buildRenderArgs({
    outputPath,
    width,
    height,
    clips
  });
  const child = spawn('ffmpeg', args, { windowsHide: true });
  job.child = child;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  const progress = createInterface({ input: child.stdout });
  progress.on('line', line => {
    const [key, value] = line.split('=');
    if (key === 'out_time_ms') {
      job.progress = Math.min(0.99, Number(value) / 1_000_000 / job.duration);
    } else if (key === 'progress' && value === 'end') {
      job.progress = 1;
    }
  });
  child.on('error', error => {
    job.status = 'error';
    job.error = `ffmpegを起動できません。FFmpegをインストールし、PATHを確認してください。 (${error.message})`;
  });
  child.on('close', code => {
    job.child = null;
    if (code === 0) {
      job.status = 'done';
      job.progress = 1;
    } else {
      job.status = 'error';
      job.error = `動画を書き出せませんでした。${stderr.slice(-3000).trim()}`;
      fsp.unlink(outputPath).catch(() => {});
    }
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/media/upload/start') {
    try {
      const request = await readJson(req);
      const filename = safeFilename(request.filename);
      const fileSize = Number(request.size);
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
        sendJson(res, 400, { error: 'ファイルサイズが正しくありません。' });
        return;
      }
      await fsp.mkdir(TEMP_DIR, { recursive: true });
      const disk = await fsp.statfs(TEMP_DIR);
      const freeBytes = disk.bfree * disk.bsize;
      const reserveBytes = 2 * 1024 * 1024 * 1024;
      if (freeBytes - reserveBytes < fileSize) {
        sendJson(res, 507, {
          error: `ディスク空き容量が不足しています。残り約${Math.floor(freeBytes / 1024 / 1024 / 1024)}GBしかありません。不要なファイルを移動または削除してください。`
        });
        return;
      }
      const id = randomUUID();
      const extension = path.extname(filename) || '.video';
      const filePath = path.join(TEMP_DIR, `${id}${extension}`);
      await fsp.open(filePath, 'w').then(handle => handle.close());
      uploadSessions.set(id, { id, filename, filePath, size: fileSize, received: 0 });
      sendJson(res, 201, { id });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/media/upload/chunk') {
    const uploadId = String(req.headers['x-upload-id'] || '');
    const chunkIndex = Number(req.headers['x-chunk-index']);
    const session = uploadSessions.get(uploadId);
    if (!session) {
      sendJson(res, 404, { error: 'アップロードセッションが見つかりません。' });
      return;
    }
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      sendJson(res, 400, { error: 'チャンク番号が正しくありません。' });
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const offset = session.received;
      const handle = await fsp.open(session.filePath, 'r+');
      await handle.write(buffer, 0, buffer.length, offset);
      await handle.close();
      session.received += buffer.length;
      if (session.received > session.size) {
        throw new Error('アップロードされたサイズが元ファイルサイズを超えています。');
      }
      sendJson(res, 200, { received: session.received, size: session.size });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/media/upload/complete') {
    try {
      const request = await readJson(req);
      const session = uploadSessions.get(request.id);
      if (!session) {
        sendJson(res, 404, { error: 'アップロードセッションが見つかりません。' });
        return;
      }
      if (session.received !== session.size) {
        sendJson(res, 400, {
          error: `アップロードが未完了です。${session.received} / ${session.size} bytes`
        });
        return;
      }
      const probe = await runProbe(session.filePath);
      const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
      if (!video) throw new Error('動画ストリームが見つかりません。');
      const entry = {
        id: session.id,
        filename: session.filename,
        path: session.filePath,
        contentType: videoContentType(session.filename),
        probe,
        videoIndex: video.index
      };
      mediaFiles.set(session.id, entry);
      uploadSessions.delete(session.id);
      sendJson(res, 201, mediaResponse(session.id, entry));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/media') {
    const id = randomUUID();
    const filename = safeFilename(decodeURIComponent(req.headers['x-filename'] || 'video.mp4'));
    const extension = path.extname(filename) || '.video';
    const filePath = path.join(TEMP_DIR, `${id}${extension}`);
    try {
      await fsp.mkdir(TEMP_DIR, { recursive: true });
      const fileSize = Number(req.headers['content-length'] || 0);
      if (fileSize > 0) {
        const disk = await fsp.statfs(TEMP_DIR);
        const freeBytes = disk.bfree * disk.bsize;
        const reserveBytes = 2 * 1024 * 1024 * 1024;
        if (freeBytes - reserveBytes < fileSize) {
          req.resume();
          sendJson(res, 507, {
            error: `ディスク空き容量が不足しています。残り約${Math.floor(freeBytes / 1024 / 1024 / 1024)}GBしかありません。不要なファイルを移動または削除してください。`
          });
          return;
        }
      }
      await pipeline(req, fs.createWriteStream(filePath, { flags: 'wx' }));
      const probe = await runProbe(filePath);
      const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
      if (!video) throw new Error('動画ストリームが見つかりません。');
      const entry = {
        id,
        filename,
        path: filePath,
        contentType: videoContentType(filename),
        probe,
        videoIndex: video.index
      };
      mediaFiles.set(id, entry);
      sendJson(res, 201, mediaResponse(id, entry));
    } catch (error) {
      await fsp.unlink(filePath).catch(() => {});
      sendJson(res, error.status || 400, { error: error.message });
    }
    return;
  }

  const fileMatch = /^\/api\/media\/([0-9a-f-]+)\/file$/i.exec(pathname);
  if (req.method === 'GET' && fileMatch) {
    const entry = mediaFiles.get(fileMatch[1]);
    if (!entry) {
      sendJson(res, 404, { error: '動画が見つかりません。再読み込みして再度アップロードしてください。' });
      return;
    }
    streamFile(req, res, entry.path, null, entry.contentType);
    return;
  }

  const deleteMatch = /^\/api\/media\/([0-9a-f-]+)$/i.exec(pathname);
  if (req.method === 'DELETE' && deleteMatch) {
    const entry = mediaFiles.get(deleteMatch[1]);
    if (!entry) {
      sendJson(res, 404, { error: '動画が見つかりません。' });
      return;
    }
    for (const [cacheKey, previewJob] of [...previewJobs.entries()]) {
      if (!cacheKey.startsWith(`${entry.id}:`)) continue;
      if (previewJob.child) previewJob.child.kill();
      previewJobs.delete(cacheKey);
      if (previewJob.outputPath) await fsp.unlink(previewJob.outputPath).catch(() => {});
    }
    mediaFiles.delete(entry.id);
    await fsp.unlink(entry.path).catch(() => {});
    sendJson(res, 200, { deleted: true });
    return;
  }

  const previewPostMatch = /^\/api\/media\/([0-9a-f-]+)\/preview$/i.exec(pathname);
  if (req.method === 'POST' && previewPostMatch) {
    try {
      const entry = mediaFiles.get(previewPostMatch[1]);
      if (!entry) {
        sendJson(res, 404, { error: '動画が見つかりません。再度追加してください。' });
        return;
      }
      const request = await readJson(req);
      if (!Array.isArray(request.tracks) || request.tracks.length === 0) {
        sendJson(res, 400, { error: 'プレビューに使用する音声トラックを選択してください。' });
        return;
      }
      const availableTracks = new Set(entry.probe.streams
        .filter(stream => stream.codec_type === 'audio')
        .map(stream => stream.index));
      if (request.tracks.some(track => !availableTracks.has(track)) ||
          new Set(request.tracks).size !== request.tracks.length) {
        sendJson(res, 400, { error: '音声トラックの指定が正しくありません。' });
        return;
      }
      const jobs = [];
      for (const track of [...request.tracks].sort((a, b) => a - b)) {
        const cacheKey = `${entry.id}:${track}`;
        const existing = [...previewJobs.entries()].find(([key]) => key === cacheKey);
        if (existing) {
          jobs.push({ track, id: existing[1].id });
          continue;
        }
        const job = {
          id: randomUUID(),
          status: 'processing',
          progress: 0,
          duration: mediaResponse(entry.id, entry).duration
        };
        previewJobs.set(cacheKey, job);
        startPreview(job, entry, [track]);
        jobs.push({ track, id: job.id });
      }
      sendJson(res, 202, { jobs });
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
    return;
  }

  const previewStatusMatch = /^\/api\/media\/([0-9a-f-]+)\/preview\/([0-9a-f-]+)\/status$/i.exec(pathname);
  if (req.method === 'GET' && previewStatusMatch) {
    const job = [...previewJobs.values()].find(item => item.id === previewStatusMatch[2]);
    if (!job) {
      sendJson(res, 404, { error: 'プレビュー音声ジョブが見つかりません。' });
      return;
    }
    sendJson(res, 200, { status: job.status, progress: job.progress, error: job.error });
    return;
  }

  const previewFileMatch = /^\/api\/media\/([0-9a-f-]+)\/preview\/([0-9a-f-]+)\/file$/i.exec(pathname);
  if (req.method === 'GET' && previewFileMatch) {
    const job = [...previewJobs.values()].find(item => item.id === previewFileMatch[2]);
    if (!job || job.status !== 'done') {
      sendJson(res, 409, { error: 'プレビュー音声の生成が完了していません。' });
      return;
    }
    streamFile(req, res, job.outputPath, null, 'audio/mpeg');
    return;
  }

  const exportMatch = /^\/api\/export\/([0-9a-f-]+)(\/download)?$/i.exec(pathname);
  if (req.method === 'POST' && pathname === '/api/export') {
    try {
      const request = await readJson(req);
      if (!Array.isArray(request.clips) || request.clips.length === 0 || request.clips.length > 100) {
        sendJson(res, 400, { error: '連結する動画を1〜100本選択してください。' });
        return;
      }
      let totalCuts = 0;
      let totalDuration = 0;
      const renderClips = [];
      for (const clip of request.clips) {
        if (!clip || typeof clip !== 'object' || typeof clip.id !== 'string') {
          sendJson(res, 400, { error: '動画の指定が正しくありません。' });
          return;
        }
        const entry = mediaFiles.get(clip.id);
        if (!entry) {
          sendJson(res, 404, { error: '動画が見つかりません。再度追加してください。' });
          return;
        }
        const duration = mediaResponse(entry.id, entry).duration;
        if (!Array.isArray(clip.cuts) || clip.cuts.length === 0) {
          sendJson(res, 400, { error: `${entry.filename} に書き出す範囲がありません。` });
          return;
        }
        totalCuts += clip.cuts.length;
        if (totalCuts > 500 || clip.cuts.some(cut =>
          !Number.isFinite(cut.start) || !Number.isFinite(cut.end) ||
          cut.start < 0 || cut.end <= cut.start || cut.end > duration
        )) {
          sendJson(res, 400, { error: `${entry.filename} のカット範囲が正しくありません。` });
          return;
        }
        const availableTracks = new Set(entry.probe.streams
          .filter(stream => stream.codec_type === 'audio')
          .map(stream => stream.index));
        if (!Array.isArray(clip.audioTracks) ||
            clip.audioTracks.some(index => !availableTracks.has(index)) ||
            new Set(clip.audioTracks).size !== clip.audioTracks.length) {
          sendJson(res, 400, { error: `${entry.filename} の音声トラック選択が正しくありません。` });
          return;
        }
        totalDuration += clip.cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);
        renderClips.push({
          path: entry.path,
          videoIndex: entry.videoIndex,
          audioTracks: clip.audioTracks,
          cuts: clip.cuts
        });
      }

      const firstClip = mediaFiles.get(request.clips[0].id);
      const firstVideo = mediaResponse(firstClip.id, firstClip);
      const job = {
        id: randomUUID(),
        status: 'processing',
        progress: 0,
        duration: totalDuration,
        filename: 'joined-video.mp4'
      };
      jobs.set(job.id, job);
      startRender(
        job,
        renderClips,
        Math.max(2, (firstVideo.width || 1280) - (firstVideo.width || 1280) % 2),
        Math.max(2, (firstVideo.height || 720) - (firstVideo.height || 720) % 2)
      );
      sendJson(res, 202, { id: job.id });
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && exportMatch) {
    const job = jobs.get(exportMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: '書き出しジョブが見つかりません。' });
      return;
    }
    if (exportMatch[2]) {
      if (job.status !== 'done') {
        sendJson(res, 409, { error: '書き出しが完了していません。' });
        return;
      }
      streamFile(req, res, job.outputPath, job.filename, 'video/mp4');
      jobs.delete(job.id);
      return;
    }
    sendJson(res, 200, {
      status: job.status,
      progress: job.progress,
      error: job.error
    });
    return;
  }

  if (req.method === 'GET') {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.resolve(PUBLIC_DIR, relative);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    try {
      const content = await fsp.readFile(filePath);
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8'
      }[path.extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function main() {
  await fsp.mkdir(TEMP_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.destroy();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`動画カット編集アプリ: http://${HOST}:${PORT}`);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
