'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FONT_PATH = 'C:/Windows/Fonts/arial.ttf';

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function findFont() {
  const candidates = [
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/calibri.ttf'
  ];
  for (const p of candidates) {
    if (fileExists(p)) return p;
  }
  return null;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}\n${stderr}`));
    });
  });
}

async function ensureIdleVideo(options = {}) {
  const os = require('os');
  const outputDir = options.outputDir || os.tmpdir();
  const idleVideoPath = path.join(outputDir, 'player-idle.mp4');

  if (fileExists(idleVideoPath)) return idleVideoPath;

  const font = findFont();
  if (!font) {
    throw new Error('No suitable font found for idle video text overlay');
  }

  const text = options.text || 'No Active Schedule';
  const fontSize = options.fontSize || 72;
  const width = options.width || 1920;
  const height = options.height || 1080;
  const duration = options.duration || 5;

  const fontPathEsc = font.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const textEsc = text.replace(/'/g, "\\'");
  const vf = `drawtext=text='${textEsc}':fontcolor=white:fontsize=${fontSize}:fontfile='${fontPathEsc}':x=(w-text_w)/2:y=(h-text_h)/2`;

  const args = [
    '-f', 'lavfi',
    '-i', `color=c=black:s=${width}x${height}:d=${duration}`,
    '-vf', vf,
    '-pix_fmt', 'yuv420p',
    '-an',
    '-t', String(duration),
    '-y',
    idleVideoPath
  ];

  await runFfmpeg(args);
  return idleVideoPath;
}

module.exports = { ensureIdleVideo };
