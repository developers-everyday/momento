
import { NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';

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

        // 2. Save Uploaded File Locally
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.mkdir(TEMP_DIR, { recursive: true });
        // Sanitize filename to avoid issues
        const safeName = file.name.replace(/[^a-z0-9.]/gi, '_');
        const filePath = path.join(TEMP_DIR, safeName);
        await fs.writeFile(filePath, buffer);

        // 3. Send to ElevenLabs Scribe v2
        // NOTE: This assumes Scribe v2 uses the standard S2T endpoint with specific model parameters.
        const formDataEleven = new FormData();
        formDataEleven.append('file', new Blob([buffer]), file.name);
        formDataEleven.append('model_id', 'scribe_v2'); // Ensure this ID is correct for v2
        formDataEleven.append('tag_audio_events', 'true'); // Critical for finding laughter
        formDataEleven.append('diarize', 'true');
        // formDataEleven.append('language_code', 'eng'); // Optional based on user input, defaulting implies detection or English

        console.log("...Sending to Scribe v2...");

        // We need to handle the case where the API key is missing
        if (!ELEVENLABS_API_KEY) {
            throw new Error("ELEVENLABS_API_KEY is not set");
        }

        const scribeResponse = await axios.post(
            'https://api.elevenlabs.io/v1/speech-to-text',
            formDataEleven,
            {
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'multipart/form-data'
                }
            }
        );

        const transcript = scribeResponse.data;
        console.log("...Scribe analysis complete...");

        // 4. Find Laughter Events
        // Assuming structure contains audio_events or words with tags
        // This logic depends on exact Scribe v2 JSON structure. 
        // Generally, look for type: "laughter"
        interface TimeRange { start: number; end: number; }
        const funnyMoments: TimeRange[] = [];

        // PSEUDO-CODE logic adapted for likely response structure
        // If Scribe returns distinct events:
        if (transcript.audio_events) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            transcript.audio_events.forEach((event: any) => {
                if (event.type === 'laughter') {
                    funnyMoments.push({ start: event.start, end: event.end });
                }
            });
        } else {
            // Fallback: search in words if audio_events isn't top level
            // This is a heuristic.
            // Also checking words for "[laughter]" text if applicable
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
