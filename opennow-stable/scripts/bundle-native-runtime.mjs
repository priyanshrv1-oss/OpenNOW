import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const outDir = resolve(repoRoot, 'opennow-stable/resources/bin');
mkdirSync(outDir, { recursive: true });

const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const streamerCandidates = [
  resolve(repoRoot, `opennow-streamer/target/release/opennow-streamer${exeSuffix}`),
  resolve(repoRoot, `opennow-streamer/target/debug/opennow-streamer${exeSuffix}`),
];
const streamer = streamerCandidates.find((p) => existsSync(p));
if (!streamer) {
  throw new Error(`Missing opennow-streamer binary. Build it first: ${streamerCandidates.join(', ')}`);
}
cpSync(streamer, join(outDir, `opennow-streamer${exeSuffix}`));

const ffmpegEnv = process.env.OPENNOW_FFMPEG_BIN;
const ffmpeg = ffmpegEnv || execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
if (!ffmpeg || !existsSync(ffmpeg)) {
  throw new Error('Missing ffmpeg binary. Set OPENNOW_FFMPEG_BIN or ensure ffmpeg is on PATH.');
}
cpSync(ffmpeg, join(outDir, `ffmpeg${exeSuffix}`));
console.log(`Bundled native runtime into ${outDir}`);
