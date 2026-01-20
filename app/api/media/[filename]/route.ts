import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force dynamic to prevent Next.js from caching this route
export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ filename: string }> }
) {
    // Await params as required in Next 15+ (or recent 14 versions)
    const { filename } = await params;

    if (!filename) {
        return NextResponse.json({ error: 'Filename is required' }, { status: 400 });
    }

    // Security: Prevent directory traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(os.tmpdir(), safeFilename);

    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    try {
        const fileBuffer = fs.readFileSync(filePath);

        // Determine content type
        const ext = path.extname(safeFilename).toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === '.mp4') contentType = 'video/mp4';
        if (ext === '.mp3') contentType = 'audio/mpeg';
        if (ext === '.json') contentType = 'application/json';

        return new NextResponse(fileBuffer, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Content-Length': fileBuffer.length.toString(),
                'Cache-Control': 'public, max-age=3600',
            },
        });
    } catch (error) {
        console.error('Error serving file:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
