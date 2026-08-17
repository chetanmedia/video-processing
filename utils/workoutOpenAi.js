const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

function getOpenAiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }
  return key;
}

function cleanJsonContent(content) {
  return content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

async function chatCompletion(body) {
  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOpenAiKey()}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function normalizeHashtags(hashtags) {
  if (!Array.isArray(hashtags)) return [];
  return [...new Set(
    hashtags
      .map((tag) => {
        if (typeof tag !== 'string') return '';
        const value = tag.trim();
        if (!value) return '';
        return value.startsWith('#') ? value : `#${value}`;
      })
      .filter(Boolean),
  )];
}

function hashtagsFromText(text) {
  const value = String(text || '');
  const hashed = value.match(/#[\w]+/g) || [];
  const lineMatch = value.match(/Hashtags:\s*(.+)/i);
  const fromLine = lineMatch?.[1]
    ? lineMatch[1]
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => token && token !== '[object Object]')
        .map((token) => (token.startsWith('#') ? token : `#${token}`))
    : [];
  return [...hashed, ...fromLine];
}

function captionForValidation(text) {
  return String(text || '')
    .replace(/FITSAVER_EXTRACT_FROM_VIDEO/g, '')
    .replace(/\[object Object\]/g, '')
    .replace(/^Hashtags:\s*.+$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasFitnessSignal(caption, tags) {
  const blob = `${caption} ${tags.join(' ')}`;
  return /FITSAVER_EXTRACT_FROM_VIDEO|#?(fitness|workout|gymgirl|gym|hiit|pilates|yoga|cardio|crossfit|exercise|coreworkout|deepcore|strength|bodyweight)|(\d+\s*min(ute)?s?\s+workouts?)/i.test(
    blob,
  );
}

function isClearlyNotWorkout(caption, tags) {
  const blob = `${caption} ${tags.join(' ')}`;
  if (hasFitnessSignal(caption, tags)) return false;
  return /#?(recipe|recipes|foodie|ootd|fashion|makeup|skincare|travelgram|bookstagram)\b/i.test(blob);
}

async function validateWorkoutContent(text, hashtags) {
  const raw = String(text || '');
  const caption = captionForValidation(raw);
  const tags = normalizeHashtags([
    ...normalizeHashtags(hashtags),
    ...hashtagsFromText(raw),
  ]);

  console.log('🧠 Validate workout content:', {
    captionPreview: caption.slice(0, 160),
    captionLength: caption.length,
    hashtagCount: tags.length,
    hashtags: tags.slice(0, 12),
  });

  // Video imports and incomplete scrapes must not be blocked here.
  if (/FITSAVER_EXTRACT_FROM_VIDEO/i.test(raw) || hasFitnessSignal(caption, tags)) {
    return { isWorkout: true, reason: 'Fitness caption, hashtags, or video import' };
  }

  if (isClearlyNotWorkout(caption, tags)) {
    return { isWorkout: false, reason: 'Caption and hashtags are not workout related' };
  }

  // Ambiguous social captions (promo, challenge, truncated OG) go through.
  // Parse + video processing decide whether there is a real workout.
  return { isWorkout: true, reason: 'Caption is ambiguous; will check parse/video' };
}

async function parseWorkoutWithAI(text) {
  const content = await chatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a professional fitness trainer and workout expert. Parse workout information from any source (captions, image text, comments, hashtags) and return structured JSON. Be thorough and extract ALL exercises mentioned.',
      },
      {
        role: 'user',
        content: `Parse the following workout data and extract ALL exercises, reps, sets, and instructions.

WORKOUT DATA:
${text}

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "name": "Descriptive workout name (e.g., Full Body HIIT, Leg Day)",
  "exercises": [
    {
      "name": "Exercise name",
      "reps": "Number of reps or duration (e.g., '20 reps', '40 seconds', '40s')",
      "sets": "Number of sets for THIS specific exercise if mentioned per-exercise (e.g., '3 sets of 10 squats' -> sets: '3')",
      "notes": "Specific instructions for this exercise (optional)"
    }
  ],
  "notes": "CRITICAL: If the workout says 'Complete X sets' or 'X rounds' for ALL exercises, include this here (e.g., 'Complete 5 sets' or '4 rounds total'). Also include rest periods and other instructions.",
  "duration": "Total workout duration if mentioned (e.g., '30 minutes')",
  "difficulty": "Beginner/Intermediate/Advanced if mentioned or can be inferred"
}

IMPORTANT:
- Extract EVERY exercise that is explicitly written in the source
- Include exact reps/time for each exercise
- If individual exercises have sets mentioned (e.g., "3 sets of 10 squats"), put it in that exercise's sets field
- If there's a global "Complete X sets/rounds" instruction for the ENTIRE workout, include it in the notes field
- Preserve rest periods in notes
- Clean up exercise names (proper capitalization)
- If time is shown as "x 40s", convert to "40 seconds"
- NEVER invent or guess exercises that are not written in the source
- If the source contains FITSAVER_EXTRACT_FROM_VIDEO, or has no specific exercise names with reps/time, return "exercises": [] and name "Imported Workout"`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  });

  return JSON.parse(cleanJsonContent(content));
}

async function predictDifficulty(workout) {
  const content = await chatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: `Based on this workout, determine the difficulty level. Return ONLY one word: Beginner, Intermediate, or Advanced.

Workout: ${workout.name}
Exercises: ${workout.exercises.map((e) => `${e.name} - ${e.reps}`).join(', ')}

Consider:
- Number of exercises
- Exercise complexity
- Duration/intensity
- Required fitness level

Return ONLY: Beginner, Intermediate, or Advanced`,
      },
    ],
    temperature: 0.1,
    max_tokens: 10,
  });

  return content.trim();
}

async function extractTextFromImage(imageUrl) {
  const content = await chatCompletion({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This is a fitness workout image from Instagram, TikTok, or Facebook. Read and extract ALL visible text from the image including:\n- Exercise names\n- Number of reps or duration (seconds/minutes)\n- Number of sets or rounds\n- Any instructions or notes\n\nReturn ONLY the extracted text, preserve the format as much as possible.',
          },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: 'high',
            },
          },
        ],
      },
    ],
    max_tokens: 1500,
    temperature: 0.1,
  });

  return content.trim();
}

async function extractTextFromFrame(frameUrl) {
  const content = await chatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract all visible text from this workout video frame. Include exercise names, rep counts, set counts, durations, and any other text visible on screen. Return only the extracted text, nothing else.',
          },
          {
            type: 'image_url',
            image_url: {
              url: frameUrl,
              detail: 'low',
            },
          },
        ],
      },
    ],
    max_tokens: 500,
  });

  return content.trim();
}

module.exports = {
  validateWorkoutContent,
  parseWorkoutWithAI,
  predictDifficulty,
  extractTextFromImage,
  extractTextFromFrame,
};
