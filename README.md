# Fitboard Video Processor - Railway Server

Server-side video processing for Fitboard app using Bull queue and OpenAI Vision API.

## Quick Deploy to Railway

1. Go to [railway.app](https://railway.app) and create account
2. Click "New Project" → "Empty Project"
3. Add Redis: Click "+ New" → "Database" → "Add Redis"
4. Add Server: Click "+ New" → "GitHub Repo" → Connect this folder
5. Add environment variables (see below)
6. Deploy!

## Environment Variables

```
OPENAI_API_KEY=sk-proj-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
REDIS_URL=redis://... (Railway provides automatically)
```

## API Endpoints

- `POST /api/process-video` - Submit video processing job
- `GET /api/job-status/:jobId` - Get job status
- `GET /health` - Health check

## Local Development

```bash
npm install
npm run dev
```

Server runs on http://localhost:3000
