const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRenderArgs } = require('../lib/render');

test('builds ordered video and mixed audio segments from multiple files', () => {
  const args = buildRenderArgs({
    clips: [
      {
        path: 'first.mp4',
        videoIndex: 0,
        audioTracks: [1, 2],
        cuts: [{ start: 3, end: 8 }, { start: 12, end: 15 }]
      },
      {
        path: 'second.mov',
        videoIndex: 1,
        audioTracks: [0],
        cuts: [{ start: 1, end: 4 }]
      }
    ],
    outputPath: 'output.mp4',
    width: 1920,
    height: 1080
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.deepEqual(args.slice(0, 5), ['-hide_banner', '-y', '-i', 'first.mp4', '-i']);
  assert.equal(args[5], 'second.mov');
  assert.match(graph, /\[0:0\]trim=start=3\.000000:end=8\.000000/);
  assert.match(graph, /\[0:1\]atrim=start=3\.000000:end=8\.000000/);
  assert.match(graph, /\[0:2\]atrim=start=3\.000000:end=8\.000000/);
  assert.match(graph, /amix=inputs=2/);
  assert.match(graph, /\[1:1\]trim=start=1\.000000:end=4\.000000/);
  assert.match(graph, /\[1:0\]atrim=start=1\.000000:end=4\.000000/);
  assert.match(graph, /scale=1920:1080/);
  assert.match(graph, /concat=n=3:v=1:a=1/);
  assert.equal(args[args.indexOf('-map') + 1], '[outv]');
});

test('creates silent audio for a clip without selected audio tracks', () => {
  const args = buildRenderArgs({
    clips: [{
      path: 'silent.mp4',
      videoIndex: 0,
      audioTracks: [],
      cuts: [{ start: 0, end: 2 }]
    }],
    outputPath: 'output.mp4',
    width: 1280,
    height: 720
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=duration=2\.000000/);
  assert.doesNotMatch(graph, /amix=/);
  assert.match(graph, /concat=n=1:v=1:a=1/);
});
