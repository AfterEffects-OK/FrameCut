function formatTime(value) {
  return Number(value).toFixed(6);
}

function buildRenderArgs({ clips, outputPath, width, height }) {
  const filters = [];
  const segments = [];
  const args = ['-hide_banner', '-y'];

  clips.forEach(clip => args.push('-i', clip.path));

  clips.forEach((clip, inputIndex) => {
    clip.cuts.forEach((cut, cutIndex) => {
      const duration = cut.end - cut.start;
      const segmentIndex = segments.length;
      const videoLabel = `v${segmentIndex}`;
      filters.push(
        `[${inputIndex}:${clip.videoIndex}]trim=start=${formatTime(cut.start)}:end=${formatTime(cut.end)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[${videoLabel}]`
      );

      const audioLabels = clip.audioTracks.map((trackIndex, trackOffset) => {
        const label = `a${segmentIndex}_${trackOffset}`;
        filters.push(
          `[${inputIndex}:${trackIndex}]atrim=start=${formatTime(cut.start)}:end=${formatTime(cut.end)},asetpts=PTS-STARTPTS[${label}]`
        );
        return `[${label}]`;
      });

      const mixedLabel = `mix${segmentIndex}`;
      const mixFilter = audioLabels.length === 0
        ? `anullsrc=r=48000:cl=stereo,atrim=duration=${formatTime(duration)}`
        : audioLabels.length === 1
          ? `${audioLabels[0]}anull`
          : `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=1`;
      filters.push(
        `${mixFilter},aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${formatTime(duration)},atrim=duration=${formatTime(duration)},asetpts=PTS-STARTPTS[${mixedLabel}]`
      );
      segments.push(`[${videoLabel}][${mixedLabel}]`);
    });
  });

  filters.push(
    `${segments.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`
  );

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    outputPath
  );
  return args;
}

module.exports = { buildRenderArgs };
