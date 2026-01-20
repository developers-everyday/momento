
import { NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';

// HACK: ffmpeg-static might return a bad path (e.g. /ROOT/...) in some environments.
// We check if the exported path exists; if not, we force a resolution to node_modules.
import { existsSync } from 'fs';

let safeFfmpegPath = ffmpegInstaller;
// Standard local node_modules location
const localFfmpegPath = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg');

// If the default path doesn't exist but the local one does, use the local one
if ((!safeFfmpegPath || !existsSync(safeFfmpegPath)) && existsSync(localFfmpegPath)) {
    console.log(`ffmpeg-static invalid path: ${safeFfmpegPath}. Falling back to: ${localFfmpegPath}`);
    safeFfmpegPath = localFfmpegPath;
} else if (!safeFfmpegPath) {
    // Fallback for very weird cases
    safeFfmpegPath = require('ffmpeg-static');
}

if (safeFfmpegPath) {
    ffmpeg.setFfmpegPath(safeFfmpegPath);
    console.log(`...Set ffmpeg path to: ${safeFfmpegPath}...`);
}


// 1. Config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TEMP_DIR = path.join(process.cwd(), 'public/temp');

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        console.log(`Received file: ${file.name}, size: ${file.size}, type: ${file.type}`);

        // 2. Save Uploaded File Locally
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.mkdir(TEMP_DIR, { recursive: true });
        // Sanitize filename to avoid issues
        const safeName = file.name.replace(/[^a-z0-9.]/gi, '_');
        const filePath = path.join(TEMP_DIR, safeName);
        await fs.writeFile(filePath, buffer);

        // 3. Send to ElevenLabs Scribe v2
        // 2.5 Extract Audio from Video
        const audioPath = filePath.replace(path.extname(filePath), '.mp3');
        console.log(`...Extracting audio to ${audioPath}...`);

        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .toFormat('mp3')
                .on('end', () => resolve(true))
                .on('error', (err) => reject(err))
                .save(audioPath);
        });

        const audioBuffer = await fs.readFile(audioPath);
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        console.log(`...Audio extraction complete. Size: ${audioBuffer.length}...`);

        // 3. Send to ElevenLabs Scribe v2
        console.log(`...Sending audio to Scribe v2...`);

        const formDataEleven = new FormData();
        formDataEleven.append('file', audioBlob, 'audio.mp3');
        formDataEleven.append('model_id', 'scribe_v2'); // Ensure this ID is correct for v2
        formDataEleven.append('tag_audio_events', 'true'); // Critical for finding laughter
        formDataEleven.append('diarize', 'true');
        // formDataEleven.append('language_code', 'eng'); // Optional based on user input, defaulting implies detection or English

        console.log("...Sending to Scribe v2...");

        // We need to handle the case where the API key is missing
        if (!ELEVENLABS_API_KEY) {
            throw new Error("ELEVENLABS_API_KEY is not set");
        }

        const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
            },
            body: formDataEleven,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ElevenLabs API failed with status ${response.status}: ${errorText}`);
        }

        const transcript = await response.json();
        const transcriptPath = path.join(TEMP_DIR, 'transcript.json');
        await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 2));
        console.log(`...Scribe analysis complete. Saved to ${transcriptPath}...`);

        // 4. Find Laughter Events
        interface TimeRange { start: number; end: number; }
        const funnyMoments: TimeRange[] = [];

        // Logic based on Scribe V2 response structure
        // Looking for explicit laughter events
        // IN Scribe v2, events might be interleaved in 'words' or in 'audio_events'
        const events = transcript.audio_events || transcript.words;

        if (events) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            events.forEach((event: any) => {
                // Check for explicit 'laughter' type OR 'audio_event' with laughter text
                const isLaughterType = event.type === 'laughter';
                const isAudioEventLaugh = event.type === 'audio_event' && event.text?.toLowerCase().includes('laugh');

                if (isLaughterType || isAudioEventLaugh) {
                    console.log(`Found laughter: ${event.start} - ${event.end}`);
                    funnyMoments.push({ start: event.start, end: event.end });
                }
            });
        }

        if (funnyMoments.length === 0) {
            console.log("No laughter found in audio_events. Checking words as fallback...");
            // Optional: check words if needed, but audio_events should cover it
        }

        // Fallback logic for demo if no laughter found (or mocked for testing)
        // if (funnyMoments.length === 0) {
        //      console.log("No laughter found, using demo range");
        //      funnyMoments.push({ start: 10, end: 15 }); 
        // }

        // 5. Cut the Video (The "Momento" Logic)
        const generatedClips = [];

        for (let i = 0; i < funnyMoments.length; i++) {
            const moment = funnyMoments[i];

            // Logic: 45s setup + laughter + 2s buffer. Ensure non-negative start.
            // Adjusting logic: The user wants "shorts".
            // Maybe center the laughter or end with it?
            // User logic: "45s setup + laughter + 2s buffer"
            // This implies: Start = (LaughterStart - 45), End = (LaughterEnd + 2)

            const startTime = Math.max(0, moment.start - 45);
            const duration = (moment.end - startTime) + 2;

            const outputName = `momento_clip_${Date.now()}_${i}.mp4`;
            const outputPath = path.join(TEMP_DIR, outputName);

            await new Promise((resolve, reject) => {
                ffmpeg(filePath)
                    .setStartTime(startTime)
                    .setDuration(duration)
                    .output(outputPath)
                    .on('end', () => resolve(true))
                    .on('error', (err) => {
                        console.error("FFmpeg error:", err);
                        reject(err);
                    })
                    .run();
            });

            // Return path relative to public so it can be served
            generatedClips.push(`/temp/${outputName}`);
        }

        return NextResponse.json({
            success: true,
            clips: generatedClips,
            transcript: transcript
        });

    } catch (error) {
        console.error("Processing Error:", error);
        // Cast error to get message safely
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: 'Processing failed: ' + errorMessage }, { status: 500 });
    }
}
