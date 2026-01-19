
'use client';
import { useState } from 'react';

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<string[]>([]);
  const [logs, setLogs] = useState("Waiting for upload...");

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;

    setLoading(true);
    setLogs("Uploading video...");

    const formData = new FormData();
    formData.set('file', e.target.files[0]);

    try {
      const res = await fetch('/api/process-video', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (data.success) {
        setClips(data.clips);
        setLogs(data.clips.length > 0 ? "Momento Analysis Complete! Found funny moments." : "Analysis complete, but no laughter found.");
      } else {
        setLogs("Error processing video: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      setLogs("System Error: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white p-10 flex flex-col items-center">
      <h1 className="text-5xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600">
        Momento
      </h1>
      <p className="text-gray-400 mb-10">AI-Powered Laugh Track Cipher</p>

      {/* Upload Zone */}
      <div className="w-full max-w-xl border-2 border-dashed border-gray-700 rounded-xl p-10 text-center hover:border-purple-500 transition cursor-pointer relative group">
        <input
          type="file"
          onChange={handleUpload}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
          accept="video/*"
        />
        <div className="space-y-2 group-hover:scale-105 transition-transform duration-200">
          <div className="text-4xl">📂</div>
          <p>Drop your podcast/video here</p>
          <p className="text-xs text-gray-500">MP4, MOV supported</p>
        </div>
      </div>

      {/* Status Log */}
      <div className="mt-8 font-mono text-green-400 text-sm h-6">
        {loading && <span className="animate-pulse">⚡ </span>}
        {logs}
      </div>

      {/* Results Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12 w-full max-w-6xl">
        {clips.map((clip, idx) => (
          <div key={idx} className="bg-gray-900 rounded-lg overflow-hidden border border-gray-800 flex flex-col">
            <video controls src={clip} className="w-full aspect-[9/16] object-cover" />
            <div className="p-4 bg-gray-900">
              <h3 className="font-bold text-lg mb-2">Clip #{idx + 1}</h3>
              <a href={clip} download className="text-purple-400 text-sm hover:underline flex items-center gap-1">
                <span>⬇️</span> Download
              </a>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
