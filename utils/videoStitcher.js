const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const execPromise = promisify(exec);
const { ensureIosCompatibleVideo } = require('./videoTranscoder');

/**
 * Concatenate multiple local video files into one MP4 (carousel posts).
 */
async function stitchVideos(inputPaths, outputPath) {
  if (!inputPaths.length) {
    throw new Error('No videos to stitch');
  }

  if (inputPaths.length === 1) {
    return ensureIosCompatibleVideo(inputPaths[0], outputPath);
  }

  const listPath = path.join('/tmp', `concat_${Date.now()}.txt`);
  const listContent = inputPaths
    .map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`)
    .join('\n');

  await writeFile(listPath, listContent);

  try {
    console.log(`🎬 Stitching ${inputPaths.length} carousel videos...`);
    try {
      await execPromise(
        `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`,
        { timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (copyError) {
      console.warn('⚠️ Stream copy stitch failed, re-encoding:', copyError.message);
      await execPromise(
        `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart "${outputPath}"`,
        { timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
      );
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('Stitched video file was not created');
    }

    const stats = fs.statSync(outputPath);
    console.log(`✅ Stitched video ready: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    const iosPath = path.join('/tmp', `ios_${Date.now()}.mp4`);
    const compatiblePath = await ensureIosCompatibleVideo(outputPath, iosPath);
    if (compatiblePath !== outputPath && fs.existsSync(outputPath)) {
      await unlink(outputPath).catch(() => {});
    }
    return compatiblePath;
  } finally {
    await unlink(listPath).catch(() => {});
  }
}

module.exports = {
  stitchVideos,
};
