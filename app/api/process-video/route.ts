
import { NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';
import { existsSync } from 'fs';

// --- FFmpeg Configuration ---
// 1. Try environment variable (useful for Docker/Render if installed systematically)
// 2. Try ffmpeg-static default
// 3. Fallback to local node_modules
let safeFfmpegPath: string | undefined;

if (process.env.FFMPEG_PATH) {
    safeFfmpegPath = process.env.FFMPEG_PATH;
} else if (ffmpegInstaller) {
    safeFfmpegPath = ffmpegInstaller;
}

const localFfmpegPath = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg');

if (safeFfmpegPath && !existsSync(safeFfmpegPath)) {
    // If the primary path fails, check local fallback
    if (existsSync(localFfmpegPath)) {
        console.log(`ffmpeg-static invalid path: ${safeFfmpegPath}. Falling back to: ${localFfmpegPath}`);
        safeFfmpegPath = localFfmpegPath;
    } else {
        // Final fallback: hope it's in PATH
        console.warn(`ffmpeg path ${safeFfmpegPath} not found. Relying on system PATH.`);
        safeFfmpegPath = undefined;
    }
}

if (safeFfmpegPath) {
    ffmpeg.setFfmpegPath(safeFfmpegPath);
    console.log(`...Set ffmpeg path to: ${safeFfmpegPath}...`);
} else {
    console.log("...Using system default ffmpeg...");
}

// 1. Config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Use system temp directory for Render/Cloud compatibility
const TEMP_DIR = os.tmpdir();

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
        // No need to recursive mkdir for system temp, it usually exists.
        // But safeName logic is still good.
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
        formDataEleven.append('model_id', 'scribe_v2');
        formDataEleven.append('tag_audio_events', 'true');
        formDataEleven.append('diarize', 'true');

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

        const events = transcript.audio_events || transcript.words;

        if (events) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            events.forEach((event: any) => {
                const isLaughterType = event.type === 'laughter';
                const isAudioEventLaugh = event.type === 'audio_event' && event.text?.toLowerCase().includes('laugh');

                if (isLaughterType || isAudioEventLaugh) {
                    console.log(`Found laughter: ${event.start} - ${event.end}`);
                    funnyMoments.push({ start: event.start, end: event.end });
                }
            });
        }

        // 5. Cut the Video (The "Momento" Logic)
        const generatedClips = [];

        for (let i = 0; i < funnyMoments.length; i++) {
            const moment = funnyMoments[i];

            // Logic: 45s setup + laughter + 2s buffer. Ensure non-negative start.
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

            // Return API path instead of static file path
            generatedClips.push(`/api/media/${outputName}`);
        }

        return NextResponse.json({
            success: true,
            clips: generatedClips,
            transcript: transcript
        });

    } catch (error) {
        console.error("Processing Error:", error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: 'Processing failed: ' + errorMessage }, { status: 500 });
    }
}
