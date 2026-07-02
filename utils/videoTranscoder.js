const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);

const IOS_COMPATIBLE_VIDEO_CODECS = new Set(['h264']);

async function getVideoCodec(filePath) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${filePath}"`,
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim().toLowerCase();
  } catch (error) {
    console.warn('⚠️ Could not detect video codec:', error.message);
    return null;
  }
}

/**
 * Ensure a local MP4 can play in iOS AVPlayer (H.264 + AAC, faststart).
 * Instagram often serves VP9-in-MP4, which expo-av rejects on iOS.
 */
async function ensureIosCompatibleVideo(inputPath, preferredOutputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error(`Video file not found: ${inputPath}`);
  }

  const codec = await getVideoCodec(inputPath);
  const outputPath =
    preferredOutputPath || path.join('/tmp', `ios_compat_${Date.now()}.mp4`);

  if (codec && IOS_COMPATIBLE_VIDEO_CODECS.has(codec)) {
    if (outputPath === inputPath) {
      return inputPath;
    }

    try {
      await execPromise(
        `ffmpeg -y -i "${inputPath}" -c copy -movflags +faststart "${outputPath}"`,
        { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      );

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
        console.log('✅ H.264 video remuxed with faststart for iOS playback');
        return outputPath;
      }
    } catch (error) {
      console.warn('⚠️ Faststart remux failed, using original H.264 file:', error.message);
    }

    return inputPath;
  }

  console.log(
    `🔄 Transcoding ${codec || 'unknown'} video to H.264 for iOS playback...`,
  );

  await execPromise(
    `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart "${outputPath}"`,
    { timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
  );

  if (!fs.existsSync(outputPath)) {
    throw new Error('Transcoded video file was not created');
  }

  const stats = fs.statSync(outputPath);
  if (stats.size < 1024) {
    throw new Error('Transcoded video file is too small');
  }

  console.log(`✅ iOS-compatible video ready: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  return outputPath;
}

module.exports = {
  ensureIosCompatibleVideo,
  getVideoCodec,
};
