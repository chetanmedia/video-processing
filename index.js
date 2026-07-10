const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({ 
  dest: '/tmp/uploads/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Debug: Log environment variables (without exposing full values)
console.log('🔍 Environment Check:');
console.log('  SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('  SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '❌ Missing');
console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  APIFY_TOKEN:', process.env.APIFY_TOKEN ? '✅ Set' : '❌ Missing');
console.log('  REDIS_URL:', process.env.REDIS_URL ? '✅ Set' : '❌ Missing');

// Initialize Supabase client
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ERROR: Missing required environment variables!');
  console.error('   Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Railway dashboard');
  console.error('   Go to: Railway Dashboard → Your Service → Variables tab');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Bull queue
const videoQueue = new Queue('video-processing', process.env.REDIS_URL || 'redis://localhost:6379', {
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times for rate limits
    backoff: {
      type: 'exponential',
      delay: 60000, // Start with 1 minute delay (rate limits reset per minute)
    },
    removeOnComplete: true, // Clean up completed jobs
    removeOnFail: false, // Keep failed jobs for debugging
  },
});

// Import job processor
const processVideoJob = require('./processors/videoProcessor');
const { stitchAndStoreWorkoutVideo } = require('./utils/stitchAndStoreWorkoutVideo');
const workoutOpenAi = require('./utils/workoutOpenAi');
const apifyCaption = require('./utils/apifyCaption');

// Process jobs with concurrency
// Process up to N jobs simultaneously (configurable via env var)
const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY || '5', 10);
console.log(`📊 Queue concurrency set to: ${CONCURRENCY}`);

videoQueue.process(CONCURRENCY, async (job) => {
  console.log(`🎬 Processing job ${job.id}...`);
  return await processVideoJob(job, supabase);
});

// Job event handlers
videoQueue.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

videoQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Secure import API (OpenAI + Apify keys stay server-side) ---

app.post('/api/validate-workout', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing required field: text' });
    }

    const result = await workoutOpenAi.validateWorkoutContent(text);
    res.json(result);
  } catch (error) {
    console.error('❌ validate-workout failed:', error.message);
    res.status(500).json({ error: 'Failed to validate workout content', message: error.message });
  }
});

app.post('/api/parse-workout', async (req, res) => {
  try {
    const { text, predictDifficulty } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing required field: text' });
    }

    const workout = await workoutOpenAi.parseWorkoutWithAI(text);
    if (predictDifficulty && workout.exercises?.length > 0 && !workout.difficulty) {
      try {
        workout.difficulty = await workoutOpenAi.predictDifficulty(workout);
      } catch (difficultyError) {
        console.warn('⚠️ Difficulty prediction failed:', difficultyError.message);
      }
    }

    res.json({ workout });
  } catch (error) {
    console.error('❌ parse-workout failed:', error.message);
    res.status(500).json({ error: 'Failed to parse workout', message: error.message });
  }
});

app.post('/api/extract-caption', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing required field: url' });
    }

    const extracted = await apifyCaption.extractCaption(url);
    res.json({ extracted });
  } catch (error) {
    console.error('❌ extract-caption failed:', error.message);
    res.status(500).json({ error: 'Failed to extract caption', message: error.message });
  }
});

app.post('/api/extract-image-text', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({ error: 'Missing required field: imageUrl' });
    }

    const text = await workoutOpenAi.extractTextFromImage(imageUrl);
    res.json({ text });
  } catch (error) {
    console.error('❌ extract-image-text failed:', error.message);
    res.status(500).json({ error: 'Failed to extract image text', message: error.message });
  }
});

app.post('/api/extract-frame-text', async (req, res) => {
  try {
    const { frameUrl } = req.body;
    if (!frameUrl || typeof frameUrl !== 'string') {
      return res.status(400).json({ error: 'Missing required field: frameUrl' });
    }

    const text = await workoutOpenAi.extractTextFromFrame(frameUrl);
    res.json({ text });
  } catch (error) {
    console.error('❌ extract-frame-text failed:', error.message);
    res.status(500).json({ error: 'Failed to extract frame text', message: error.message });
  }
});

// FFmpeg check endpoint
app.get('/ffmpeg-check', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execPromise = promisify(exec);
    
    const { stdout, stderr } = await execPromise('ffmpeg -version');
    res.json({ 
      status: 'ok', 
      ffmpeg: 'installed',
      version: stdout.split('\n')[0]
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      ffmpeg: 'not found',
      error: error.message 
    });
  }
});

// Submit video processing job (with file upload for TikTok)
app.post('/api/process-video-upload', upload.array('videos', 10), async (req, res) => {
  try {
    const { workoutId, userId, caption, source, displayUrl } = req.body;
    const uploadedFiles = req.files;

    if (!workoutId || !uploadedFiles || uploadedFiles.length === 0 || !userId) {
      return res.status(400).json({
        error: 'Missing required fields: workoutId, video file(s), userId',
      });
    }

    console.log(`📥 Received video upload for workout ${workoutId} with ${uploadedFiles.length} video(s)`);

    // Store uploaded file paths
    const videoPaths = uploadedFiles.map(file => file.path);

    // Add job to queue with local file paths
    const job = await videoQueue.add({
      workoutId,
      videoFiles: videoPaths, // Local file paths instead of URLs
      userId,
      caption,
      source,
      displayUrl,
      openAIKey: process.env.OPENAI_API_KEY,
    });

    res.json({
      success: true,
      jobId: job.id,
      message: 'Video processing started',
    });
  } catch (error) {
    console.error('❌ Error submitting upload job:', error);
    res.status(500).json({
      error: 'Failed to submit video processing job',
      message: error.message,
    });
  }
});

// Submit video processing job
app.post('/api/process-video', async (req, res) => {
  try {
    const { workoutId, videoUrl, videoUrls, userId, caption, source, displayUrl } = req.body;

    // Support both single videoUrl and multiple videoUrls
    const urls = videoUrls || (videoUrl ? [videoUrl] : []);
    
    if (!workoutId || urls.length === 0 || !userId) {
      return res.status(400).json({
        error: 'Missing required fields: workoutId, videoUrl(s), userId',
      });
    }

    console.log(`📥 Received video processing request for workout ${workoutId} with ${urls.length} video(s)`);

    // Add job to queue
    const job = await videoQueue.add({
      workoutId,
      videoUrls: urls, // Now sending array
      userId,
      caption,
      source,
      displayUrl,
      openAIKey: process.env.OPENAI_API_KEY,
    });

    res.json({
      success: true,
      jobId: job.id,
      message: 'Video processing started',
    });
  } catch (error) {
    console.error('❌ Error submitting job:', error);
    res.status(500).json({
      error: 'Failed to submit video processing job',
      message: error.message,
    });
  }
});

// Stitch carousel clips and store a single playback video (caption imports)
app.post('/api/stitch-and-store-video', async (req, res) => {
  try {
    const { workoutId, userId, videoUrls, source } = req.body;
    const urls = videoUrls || [];

    if (!workoutId || !userId || urls.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: workoutId, userId, videoUrls',
      });
    }

    console.log(`🎬 Stitch-and-store request for workout ${workoutId} (${urls.length} clip(s))`);

    const result = await stitchAndStoreWorkoutVideo(supabase, {
      workoutId,
      userId,
      videoUrls: urls,
      source,
    });

    res.json({
      success: true,
      permanentUrl: result.permanentUrl,
      storedVideoUrls: result.storedVideoUrls,
    });
  } catch (error) {
    console.error('❌ Error stitching/storing video:', error);
    res.status(500).json({
      error: 'Failed to stitch and store video',
      message: error.message,
    });
  }
});

// Get job status
app.get('/api/job-status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await videoQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();

    res.json({
      jobId: job.id,
      status: state,
      progress,
      workoutId: job.data.workoutId,
    });
  } catch (error) {
    console.error('❌ Error getting job status:', error);
    res.status(500).json({
      error: 'Failed to get job status',
      message: error.message,
    });
  }
});

// Get queue stats
app.get('/api/stats', async (req, res) => {
  try {
    const counts = await videoQueue.getJobCounts();
    res.json({
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
    });
  } catch (error) {
    console.error('❌ Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Queue dashboard: http://localhost:${PORT}/admin/queues`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM received, closing server...');
  await videoQueue.close();
  process.exit(0);
});
