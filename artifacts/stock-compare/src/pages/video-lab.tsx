/** A125 — Video Lab / Reel inbox (side project). Metadata Phase 1. */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { cn } from "@/lib/utils";

type Idea = {
  id: number;
  topic: string;
  hook: string;
  outline: unknown;
  status: string;
  rating: number | null;
  notes: string | null;
  created_at: string;
};

type Video = {
  id: number;
  title: string;
  hook: string | null;
  topic: string | null;
  status: string;
  path: string | null;
  idea_id: number | null;
  rating: number | null;
  notes: string | null;
  created_at: string;
};

export default function VideoLab() {
  const qc = useQueryClient();
  const [topic, setTopic] = useState("");
  const [hook, setHook] = useState("");
  const [upTitle, setUpTitle] = useState("");
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upErr, setUpErr] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{ ideas: Idea[]; videos: Video[]; note?: string }>({
    queryKey: ["video-lab"],
    queryFn: () => fetch("/api/video-lab", { credentials: "include" }).then((r) => {
      if (!r.ok) throw new Error(`video-lab ${r.status}`);
      return r.json();
    }),
  });
  const add = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/video-lab/ideas", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, hook, outline: ["hook", "demo", "CTA"] }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      setTopic("");
      setHook("");
      qc.invalidateQueries({ queryKey: ["video-lab"] });
    },
  });
  const upload = useMutation({
    mutationFn: async () => {
      if (!upFile) throw new Error("pick a file");
      setUpErr(null);
      const buf = await upFile.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const dataBase64 = btoa(binary);
      const r = await fetch("/api/video-lab/videos", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: upTitle || upFile.name,
          filename: upFile.name,
          dataBase64,
          topic: topic || null,
          hook: hook || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? await r.text());
      }
    },
    onSuccess: () => {
      setUpTitle("");
      setUpFile(null);
      qc.invalidateQueries({ queryKey: ["video-lab"] });
    },
    onError: (e: Error) => setUpErr(e.message),
  });
  const gen = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/video-lab/hooks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, save: true }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ source: string; model?: string; error?: string; ideas: { hook: string }[] }>;
    },
    onSuccess: (d) => {
      if (d.ideas?.[0]?.hook) setHook(d.ideas[0].hook);
      qc.invalidateQueries({ queryKey: ["video-lab"] });
    },
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-amber-100/90">
      <TopNav />
      <main className="max-w-5xl mx-auto px-4 py-4 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-[#d4af37]">Video Lab</h1>
          <p className="text-[11px] text-amber-200/50">
            A125 — shorts ideas + reel inbox. Upload mp4 → ~/.fildi/videos/.
          </p>
        </div>

        <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 space-y-2">
          <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Upload short</h2>
          <input
            value={upTitle}
            onChange={(e) => setUpTitle(e.target.value)}
            placeholder="Title"
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[12px]"
          />
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
            onChange={(e) => setUpFile(e.target.files?.[0] ?? null)}
            className="w-full text-[11px] text-amber-200/70"
          />
          <button
            type="button"
            disabled={upload.isPending || !upFile}
            onClick={() => upload.mutate()}
            className="text-[11px] font-semibold text-[#d4af37] disabled:opacity-40"
          >
            {upload.isPending ? "Uploading…" : "Save to disk"}
          </button>
          {upErr ? <p className="text-[10px] text-red-300">{upErr}</p> : null}
        </div>

        <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 space-y-2">
          <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">New idea</h2>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic / niche"
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[12px]"
          />
          <input
            value={hook}
            onChange={(e) => setHook(e.target.value)}
            placeholder="Hook line"
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[12px]"
          />
          <div className="flex flex-wrap gap-3 items-center">
            <button
              type="button"
              disabled={add.isPending || topic.length < 2 || hook.length < 2}
              onClick={() => add.mutate()}
              className="text-[11px] font-semibold text-[#d4af37] disabled:opacity-40"
            >
              Save to backlog
            </button>
            <button
              type="button"
              disabled={gen.isPending || topic.length < 2}
              onClick={() => gen.mutate()}
              className="text-[11px] font-semibold text-sky-300 disabled:opacity-40"
              title="Local Ollama if running; else template hooks"
            >
              {gen.isPending ? "Brainstorming…" : "Brainstorm hooks (Ollama)"}
            </button>
          </div>
          {gen.data?.source ? (
            <p className="text-[9px] text-amber-200/40">
              source={gen.data.source}
              {gen.data.model ? ` · ${gen.data.model}` : ""}
              {gen.data.error ? ` · ${gen.data.error}` : ""}
            </p>
          ) : null}
        </div>

        {isLoading ? (
          <p className="text-[11px] text-amber-200/40">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <section className="rounded-md border border-[#d4af37]/20 overflow-hidden">
              <h3 className="text-[10px] font-semibold text-[#d4af37]/80 uppercase px-3 py-1.5 bg-black border-b border-[#d4af37]/15">
                Ideas ({data?.ideas?.length ?? 0})
              </h3>
              <div className="divide-y divide-zinc-800/80 max-h-[360px] overflow-y-auto">
                {(data?.ideas ?? []).length === 0 ? (
                  <p className="text-[11px] text-amber-200/40 italic px-3 py-2">No ideas yet.</p>
                ) : (
                  data!.ideas.map((i) => (
                    <div key={i.id} className="px-3 py-1.5 text-[11px]">
                      <div className="font-semibold text-white/90">{i.hook}</div>
                      <div className="text-[10px] text-amber-200/40">
                        {i.topic} · {i.status} · {i.created_at.slice(0, 10)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
            <section className="rounded-md border border-[#d4af37]/20 overflow-hidden">
              <h3 className="text-[10px] font-semibold text-[#d4af37]/80 uppercase px-3 py-1.5 bg-black border-b border-[#d4af37]/15">
                Videos ({data?.videos?.length ?? 0})
              </h3>
              <div className="divide-y divide-zinc-800/80 max-h-[360px] overflow-y-auto">
                {(data?.videos ?? []).length === 0 ? (
                  <p className="text-[11px] text-amber-200/40 italic px-3 py-2">
                    No uploads yet.
                  </p>
                ) : (
                  data!.videos.map((v) => (
                    <div key={v.id} className="px-3 py-1.5 text-[11px]">
                      <div className={cn("font-semibold", "text-white/90")}>{v.title}</div>
                      <div className="text-[10px] text-amber-200/40">
                        {v.status} · {v.created_at.slice(0, 10)}
                        {v.path ? ` · ${v.path.replace(/^.*\//, "")}` : ""}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
        {data?.note ? <p className="text-[9px] text-white/30">{data.note}</p> : null}
      </main>
    </div>
  );
}
