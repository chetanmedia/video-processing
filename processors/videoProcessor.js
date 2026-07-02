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

/**
 * Extract frames from a local video file (no upload).
 */
async function extractFramesFromLocalFile({
  videoPath,
  allFrames,
  thumbnailFrameRef,
  captureThumbnail,
  videoLabel,
}) {
  console.log(`📦 Extracting frames from ${videoLabel}...`);
  const { frames, firstFrame } = await extractFrames(videoPath);

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

    let playbackUrl = null;
    if (totalVideos > 0) {
      let uploadPath = localVideoPaths[0];
      if (totalVideos > 1) {
        const stitchedPath = path.join('/tmp', `stitched_${workoutId}_${Date.now()}.mp4`);
        await stitchVideos(localVideoPaths, stitchedPath);
        uploadPath = stitchedPath;
      }

      playbackUrl = await uploadWorkoutSourceVideo(supabase, {
        localPath: uploadPath,
        userId,
        workoutId,
        index: 'stitched',
      });

      if (uploadPath !== localVideoPaths[0] && fs.existsSync(uploadPath)) {
        await unlink(uploadPath).catch(() => {});
      }

      if (playbackUrl) {
        await updateWorkout(supabase, workoutId, {
          videoUrl: playbackUrl,
          storedVideoUrls: [playbackUrl],
        });
      }
    }

    for (let i = 0; i < localVideoPaths.length; i++) {
      await extractFramesFromLocalFile({
        videoPath: localVideoPaths[i],
        allFrames,
        thumbnailFrameRef,
        captureThumbnail: i === 0,
        videoLabel: `video ${i + 1}/${totalVideos}`,
      });
      job.progress(25 + (i + 1) * 25 / Math.max(totalVideos, 1));
      await unlink(localVideoPaths[i]).catch(() => {});
    }

    const permanentVideoUrls = playbackUrl ? [playbackUrl] : [];
    const thumbnailFrame = thumbnailFrameRef.value;

    if (allFrames.length === 0) {
      throw new Error('No frames extracted from any video');
    }
    
    console.log(`📊 Total frames from ${totalVideos} video(s): ${allFrames.length}`);

    // Step 3: Extract text from frames using OpenAI Vision
    console.log('🔍 Step 3: Extracting text from frames...');
    const extractedText = await extractTextFromFrames(allFrames, openAIKey);
    job.progress(75);

    if (!extractedText || extractedText.length === 0) {
      throw new Error('No text extracted from video frames');
    }

    // Step 4: Parse workout with AI
    console.log('🤖 Step 4: Parsing workout with AI...');
    const workoutData = await parseWorkoutWithAI(caption, extractedText, openAIKey);
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
        true
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
          false
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
 * Extract frames from video using local FFmpeg
 */
async function extractFrames(videoPath) {
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
    
    for (let i = 0; i < frameFiles.length; i += 3) { // Take every 3rd frame (3 second intervals)
      const framePath = path.join(framesDir, frameFiles[i]);
      const imageBuffer = fs.readFileSync(framePath);
      const base64 = imageBuffer.toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;
      frames.push(dataUrl);
      
      // Save first frame as thumbnail
      if (i === 0) {
        firstFrame = dataUrl;
      }
    }
    
    // Cleanup frames directory
    for (const file of frameFiles) {
      await unlink(path.join(framesDir, file));
    }
    fs.rmdirSync(framesDir);
    
    console.log(`✅ Extracted ${frames.length} frames from ${frameFiles.length} total (every 3 seconds)`);
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
 * Extract text from video frames using OpenAI Vision
 */
async function extractTextFromFrames(frames, openAIKey) {
  const allTexts = [];

  for (let i = 0; i < frames.length; i++) {
    console.log(`📝 Processing frame ${i + 1}/${frames.length}...`);

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
                  url: frames[i],
                  detail: 'low', // Low = 85 tokens, High = 25k tokens per image!
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
          allTexts.push(text.trim());
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.warn(`⚠️ Frame ${i + 1} API error (${response.status}):`, errorData.error?.message || response.statusText);
      }
    } catch (error) {
      console.warn(`⚠️ Error processing frame ${i + 1}:`, error.message);
    }
  }

  const combinedText = allTexts.join('\n\n');
  console.log(`✅ Extracted text from ${allTexts.length}/${frames.length} frames`);
  
  return combinedText;
}

/**
 * Parse workout using OpenAI
 */
async function parseWorkoutWithAI(caption, extractedText, openAIKey) {
  const combinedText = `${caption}\n\n=== EXTRACTED FROM VIDEO FRAMES ===\n${extractedText}`;

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
        content: 'You are a fitness expert. Extract workout information from the text and return ONLY a valid JSON object with this structure: {"name": "workout name", "exercises": [{"name": "exercise", "reps": "10", "sets": "3", "notes": ""}], "duration": "45 min", "difficulty": "Intermediate", "notes": "any additional notes"}. Do not include any explanation or markdown.',
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
