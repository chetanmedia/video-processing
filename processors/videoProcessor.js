const fetch = require('node-fetch');
const FormData = require('form-data');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const execPromise = promisify(exec);
const { sendWorkoutProcessingNotification } = require('../utils/pushNotifications');
const { uploadWorkoutSourceVideo } = require('../utils/videoStorage');
const { downloadVideo } = require('../utils/videoDownload');
const { stitchVideos } = require('../utils/videoStitcher');
const { ensureIosCompatibleVideo } = require('../utils/videoTranscoder');

const FRAME_SAMPLE_STEP = 3;
const FRAME_SAMPLE_INTERVAL_MS = FRAME_SAMPLE_STEP * 1000;

/**
 * Extract frames from a local video file (no upload).
 */
async function extractFramesFromLocalFile({
  videoPath,
  allFrames,
  thumbnailFrameRef,
  captureThumbnail,
  videoLabel,
  timeOffsetMs = 0,
}) {
  console.log(`📦 Extracting frames from ${videoLabel}...`);
  const { frames, firstFrame } = await extractFrames(videoPath, timeOffsetMs);

  if (captureThumbnail && firstFrame) {
    thumbnailFrameRef.value = firstFrame;
  }

  allFrames.push(...frames);
  console.log(`✅ ${videoLabel} processed: ${frames.length} frames extracted`);
}

/**
 * Process video job
 */
module.exports = async function processVideoJob(job, supabase) {
  const { workoutId, videoUrl, videoUrls, videoFiles, userId, caption, source, displayUrl, openAIKey } = job.data;
  
  // Support both file uploads and URLs
  const hasFiles = videoFiles && videoFiles.length > 0;
  const hasUrls = videoUrls || videoUrl;
  
  const files = hasFiles ? videoFiles : [];
  const urls = hasUrls ? (videoUrls || [videoUrl]) : [];
  const expectedVideoCount = files.length + urls.length;
  
  console.log(`🎬 Starting video processing for workout ${workoutId} with ${expectedVideoCount} video(s) (${files.length} uploaded, ${urls.length} URLs)`);
  job.progress(10);

  try {
    const allFrames = [];
    const thumbnailFrameRef = { value: null };
    const localVideoPaths = [...files];

    for (let i = 0; i < urls.length; i++) {
      console.log(`📥 Downloading video ${i + 1}/${urls.length}...`);
      const videoPath = await downloadVideo(urls[i], source);
      localVideoPaths.push(videoPath);
      job.progress(10 + (i + 1) * 15 / Math.max(urls.length, 1));
    }

    const totalVideos = localVideoPaths.length;
    console.log(`📊 Collected ${totalVideos} local video file(s) for processing`);

    let playbackUploadPath = null;
    if (totalVideos > 0) {
      let sourcePath = localVideoPaths[0];
      if (totalVideos > 1) {
        const stitchedPath = path.join('/tmp', `stitched_${workoutId}_${Date.now()}.mp4`);
        sourcePath = await stitchVideos(localVideoPaths, stitchedPath);
      } else {
        const compatiblePath = path.join('/tmp', `playback_${workoutId}_${Date.now()}.mp4`);
        sourcePath = await ensureIosCompatibleVideo(localVideoPaths[0], compatiblePath);
      }

      playbackUploadPath = sourcePath;
    }

    for (let i = 0; i < localVideoPaths.length; i++) {
      let timeOffsetMs = 0;
      for (let j = 0; j < i; j += 1) {
        timeOffsetMs += await getVideoDurationMs(localVideoPaths[j]);
      }

      await extractFramesFromLocalFile({
        videoPath: localVideoPaths[i],
        allFrames,
        thumbnailFrameRef,
        captureThumbnail: i === 0,
        videoLabel: `video ${i + 1}/${totalVideos}`,
        timeOffsetMs,
      });
      job.progress(25 + (i + 1) * 25 / Math.max(totalVideos, 1));
    }

    let permanentVideoUrls = [];
    if (playbackUploadPath) {
      const playbackUrl = await uploadWorkoutSourceVideo(supabase, {
        localPath: playbackUploadPath,
        userId,
        workoutId,
        index: 'stitched',
      });

      if (playbackUrl) {
        permanentVideoUrls = [playbackUrl];
      }
    }

    for (const localPath of localVideoPaths) {
      if (localPath !== playbackUploadPath && fs.existsSync(localPath)) {
        await unlink(localPath).catch(() => {});
      }
    }
    if (playbackUploadPath && fs.existsSync(playbackUploadPath)) {
      await unlink(playbackUploadPath).catch(() => {});
    }
    const thumbnailFrame = thumbnailFrameRef.value;

    if (allFrames.length === 0) {
      throw new Error('No frames extracted from any video');
    }
    
    console.log(`📊 Total frames from ${totalVideos} video(s): ${allFrames.length}`);

    // Step 3: Extract text from frames using OpenAI Vision
    console.log('🔍 Step 3: Extracting text from frames...');
    const frameTexts = await extractTextFromFrames(allFrames, openAIKey);
    job.progress(75);

    if (!frameTexts.length) {
      throw new Error('No text extracted from video frames');
    }

    const extractedText = frameTexts.map((frame) => frame.text).join('\n\n');

    // Step 4: Parse workout with AI
    console.log('🤖 Step 4: Parsing workout with AI...');
    const workoutData = await parseWorkoutWithAI(caption, extractedText, openAIKey);
    workoutData.exercises = assignExerciseMarkersFromFrames(
      workoutData.exercises,
      frameTexts,
    );
    console.log(
      `📍 Assigned video markers for ${workoutData.exercises.filter((exercise) => exercise.videoStartMs != null).length}/${workoutData.exercises.length} frame-detected exercises`,
    );
    job.progress(90);

    // Step 5: Update workout in database
    console.log('💾 Step 5: Updating workout in database...');
    const finalDisplayUrl = (source === 'TikTok' && thumbnailFrame) ? thumbnailFrame : displayUrl;
    
    await updateWorkout(supabase, workoutId, {
      exercises: workoutData.exercises,
      name: workoutData.name,
      duration: workoutData.duration,
      difficulty: workoutData.difficulty,
      notes: workoutData.notes + '\n\n[Enhanced with video frame analysis]',
      displayUrl: finalDisplayUrl,
      status: 'completed',
      ...(permanentVideoUrls.length > 0
        ? {
            videoUrl: permanentVideoUrls[0],
            storedVideoUrls: permanentVideoUrls,
          }
        : {}),
    });

    job.progress(100);
    console.log(`✅ Workout ${workoutId} processed successfully`);

    // Send push notification to user
    try {
      await sendWorkoutProcessingNotification(
        supabase,
        userId,
        workoutData.name || 'Your workout',
        true,
        workoutId
      );
    } catch (notifError) {
      // Don't fail the job if notification fails
      console.warn('⚠️ Failed to send notification:', notifError.message);
    }

    return {
      success: true,
      workoutId,
      exercises: workoutData.exercises.length,
    };

  } catch (error) {
    console.error(`❌ Error processing workout ${workoutId}:`, error.message);

    // Check if it's a rate limit error
    const isRateLimitError = error.message.includes('429');
    
    if (isRateLimitError) {
      // For rate limits: keep status as processing, don't throw (prevents retry)
      console.log(`⏳ Rate limit hit for workout ${workoutId}, marking for manual retry`);
      await updateWorkout(supabase, workoutId, {
        status: 'processing', // Keep as processing
        notes: '⏳ Hit API rate limit. Please wait 1-2 minutes and check back.',
      });
      // Don't throw - this prevents Bull from retrying
      return { success: false, error: 'Rate limit - no auto retry' };
    } else {
      // Mark workout as permanently failed for other errors
      await updateWorkout(supabase, workoutId, {
        status: 'failed',
        processingError: error.message,
      });
      
      // Send failure notification to user
      try {
        await sendWorkoutProcessingNotification(
          supabase,
          userId,
          'Workout',
          false,
          workoutId
        );
      } catch (notifError) {
        console.warn('⚠️ Failed to send failure notification:', notifError.message);
      }
      
      // Throw to mark job as failed
      throw error;
    }
  }
};

/**
 * Read video duration in milliseconds via ffprobe.
 */
async function getVideoDurationMs(videoPath) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const seconds = parseFloat(String(stdout).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return 0;
    }
    return Math.round(seconds * 1000);
  } catch (error) {
    console.warn(`⚠️ Could not read duration for ${videoPath}:`, error.message);
    return 0;
  }
}

/**
 * Extract frames from video using local FFmpeg.
 * Returns sampled frames every FRAME_SAMPLE_STEP seconds with timestamps.
 */
async function extractFrames(videoPath, timeOffsetMs = 0) {
  // Check if file exists
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  
  const stats = fs.statSync(videoPath);
  console.log(`📹 Video file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  
  // Create output directory for frames
  const framesDir = path.join('/tmp', `frames_${Date.now()}`);
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }
  
  console.log('🎞️ Extracting frames with local FFmpeg...');
  
  try {
    // Extract 1 frame per second using FFmpeg
    // -i: input file
    // -vf fps=1: extract 1 frame per second
    // -q:v 2: high quality (1-31, lower is better)
    const command = `ffmpeg -i "${videoPath}" -vf fps=1 -q:v 2 "${framesDir}/frame_%04d.png"`;
    
    console.log(`🔧 FFmpeg command: ${command}`);
    
    const { stdout, stderr } = await execPromise(command, {
      timeout: 120000, // 2 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for command output
    });
    
    console.log('✅ FFmpeg extraction complete');
    if (stderr) {
      console.log('📋 FFmpeg output:', stderr.substring(0, 200)); // Log first 200 chars of stderr
    }
    
    // Read all frame files
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.png'))
      .sort();
    
    if (frameFiles.length === 0) {
      throw new Error('No frames extracted from video');
    }
    
    console.log(`📸 Found ${frameFiles.length} frames`);
    
    // Convert frames to base64
    const frames = [];
    let firstFrame = null;
    
    for (let i = 0; i < frameFiles.length; i += FRAME_SAMPLE_STEP) {
      const framePath = path.join(framesDir, frameFiles[i]);
      const imageBuffer = fs.readFileSync(framePath);
      const base64 = imageBuffer.toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;
      const timeMs = timeOffsetMs + i * 1000;
      frames.push({ dataUrl, timeMs });

      if (i === 0) {
        firstFrame = dataUrl;
      }
    }
    
    // Cleanup frames directory
    for (const file of frameFiles) {
      await unlink(path.join(framesDir, file));
    }
    fs.rmdirSync(framesDir);
    
    console.log(`✅ Extracted ${frames.length} frames from ${frameFiles.length} total (every ${FRAME_SAMPLE_STEP} seconds)`);
    return { frames, firstFrame };
    
  } catch (error) {
    // Cleanup on error
    if (fs.existsSync(framesDir)) {
      try {
        const files = fs.readdirSync(framesDir);
        for (const file of files) {
          await unlink(path.join(framesDir, file));
        }
        fs.rmdirSync(framesDir);
      } catch (cleanupError) {
        console.warn('⚠️ Cleanup error:', cleanupError.message);
      }
    }
    
    console.error('❌ FFmpeg error details:', {
      message: error.message,
      code: error.code,
      killed: error.killed,
      signal: error.signal,
      stderr: error.stderr?.substring(0, 500), // Log first 500 chars
      stdout: error.stdout?.substring(0, 500)
    });
    
    if (error.killed && error.signal === 'SIGTERM') {
      throw new Error('FFmpeg processing timeout (exceeded 2 minutes)');
    }
    throw new Error(`FFmpeg error: ${error.message}`);
  }
}

/**
 * Extract text from video frames using OpenAI Vision.
 * Preserves the timestamp of each sampled frame.
 */
async function extractTextFromFrames(frames, openAIKey) {
  const frameTexts = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const imageUrl = typeof frame === 'string' ? frame : frame.dataUrl;
    const timeMs = typeof frame === 'string' ? i * FRAME_SAMPLE_INTERVAL_MS : frame.timeMs;

    console.log(`📝 Processing frame ${i + 1}/${frames.length} @ ${timeMs}ms...`);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAIKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all visible text from this workout video frame. Include exercise names, rep counts, set counts, durations, and any other text visible on screen. Return only the extracted text, nothing else.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                  detail: 'low',
                },
              },
            ],
          }],
          max_tokens: 500,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices[0]?.message?.content || '';
        if (text.trim().length > 0) {
          frameTexts.push({ timeMs, text: text.trim() });
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.warn(`⚠️ Frame ${i + 1} API error (${response.status}):`, errorData.error?.message || response.statusText);
      }
    } catch (error) {
      console.warn(`⚠️ Error processing frame ${i + 1}:`, error.message);
    }
  }

  console.log(`✅ Extracted text from ${frameTexts.length}/${frames.length} frames`);
  return frameTexts;
}

function normalizeExerciseMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findFirstFrameForExercise(exerciseName, frameTexts) {
  const normalizedName = normalizeExerciseMatchText(exerciseName);
  if (!normalizedName) {
    return null;
  }

  const tokens = normalizedName.split(' ').filter((token) => token.length > 2);
  for (const frame of frameTexts) {
    const haystack = normalizeExerciseMatchText(frame.text);
    if (!haystack) {
      continue;
    }

    if (haystack.includes(normalizedName)) {
      return frame;
    }

    if (tokens.length > 0 && tokens.every((token) => haystack.includes(token))) {
      return frame;
    }
  }

  return null;
}

/**
 * Pin each frame-detected exercise to the first sampled frame where it appears.
 */
function assignExerciseMarkersFromFrames(exercises, frameTexts) {
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return exercises;
  }

  let fallbackMs = 0;

  const withMarkers = exercises.map((exercise) => {
    const matchedFrame = findFirstFrameForExercise(exercise?.name, frameTexts);
    const videoStartMs = matchedFrame?.timeMs ?? fallbackMs;

    if (!matchedFrame) {
      fallbackMs += FRAME_SAMPLE_INTERVAL_MS;
    }

    return {
      ...exercise,
      videoStartMs,
      videoMarkerAttached: true,
    };
  });

  return withMarkers.map((exercise, index) => {
    const nextExercise = withMarkers
      .slice(index + 1)
      .find((item) => item.videoStartMs != null && item.videoStartMs > exercise.videoStartMs);
    if (!nextExercise) {
      return exercise;
    }

    return {
      ...exercise,
      videoEndMs: nextExercise.videoStartMs,
    };
  });
}

/**
 * Parse workout using OpenAI
 */
async function parseWorkoutWithAI(caption, extractedText, openAIKey) {
  const cleanedCaption = String(caption || '')
    .replace(/FITSAVER_EXTRACT_FROM_VIDEO/g, '')
    .trim();
  const combinedText = `CAPTION AND VIDEO TRANSCRIPT:
${cleanedCaption || '(none)'}

=== EXTRACTED FROM VIDEO FRAMES ===
${extractedText}

Use the video frames as the source of truth for the exercise list, reps, and order.
Use the caption/transcript to fill missing names, rounds, rest, or notes.
Do not invent exercises that are not in the frames or caption.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'You are a fitness expert. Build the workout from the video frames plus the caption/transcript. Prefer on-screen exercise text from frames. Use the caption/transcript for extra context. Ignore FITSAVER_EXTRACT_FROM_VIDEO placeholders. Do not invent exercises. Return ONLY a valid JSON object with this structure: {"name": "workout name", "exercises": [{"name": "exercise", "reps": "10", "sets": "3", "notes": ""}], "duration": "45 min", "difficulty": "Intermediate", "notes": "any additional notes"}. Do not include any explanation or markdown.',
      }, {
        role: 'user',
        content: combinedText,
      }],
      max_tokens: 2000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.error?.message || errorData.message || response.statusText;
    console.error(`❌ OpenAI API error (${response.status}):`, errorMessage);
    throw new Error(`OpenAI API error: ${response.status} - ${errorMessage}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content || '';
  
  // Parse JSON response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse workout data from AI response');
  }

  const workoutData = JSON.parse(jsonMatch[0]);
  
  // Validate structure
  if (!workoutData.exercises || !Array.isArray(workoutData.exercises)) {
    throw new Error('Invalid workout structure from AI');
  }

  return workoutData;
}

/**
 * Update workout in Supabase
 */
async function updateWorkout(supabase, workoutId, updates) {
  const updateData = {};

  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.exercises) updateData.exercises = updates.exercises;
  if (updates.name) updateData.name = updates.name;
  if (updates.duration) updateData.duration = updates.duration;
  if (updates.difficulty) updateData.difficulty = updates.difficulty;
  if (updates.notes) updateData.notes = updates.notes;
  if (updates.displayUrl) updateData.display_url = updates.displayUrl;
  if (updates.videoUrl) updateData.video_url = updates.videoUrl;
  if (updates.storedVideoUrls) updateData.stored_video_urls = updates.storedVideoUrls;
  if (updates.processingError) updateData.processing_error = updates.processingError;

  if (Object.keys(updateData).length === 0) {
    return;
  }

  const { error } = await supabase
    .from('workouts')
    .update(updateData)
    .eq('id', workoutId);

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  console.log(`✅ Workout ${workoutId} updated in database`);
}
