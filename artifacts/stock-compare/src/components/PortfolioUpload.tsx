import { useRef, useState } from 'react'
import { Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UploadResult {
  snapshotId?: number
  positionCount?: number
  optionCount?: number
  orderCount?: number
  lastUpdated: string | null
  fileCount: number
  formats: string[]
}

interface Props {
  onSuccess?: (result: UploadResult) => void
}

type Status = 'idle' | 'uploading' | 'success' | 'error'

// Extract YYYY-MM-DD from filename e.g. "Robinhood Full Export — 2026-06-17 15:05.csv"
function extractDateFromFilename(name: string): string | null {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

// Compact "Import CSV" button — styled like the Generate Today's Brief CTA, scaled down.
// Accepts multiple files at once (e.g. holdings + recent txns + cumulative txns +
// ticker-earnings-summary from one export run) — each file is POSTed independently;
// the backend content-sniffs which of the three formats it is and ingests accordingly.
export function PortfolioUpload({ onSuccess }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  async function uploadOne(file: File): Promise<{ format: string; data: Record<string, unknown> }> {
    const text = await file.text()
    const res = await fetch('/api/portfolio/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message ?? `${file.name}: upload failed (${res.status})`)
    return { format: data.format ?? 'unknown', data }
  }

  async function upload(files: File[]) {
    setStatus('uploading')
    setError(null)

    try {
      let lastResult: { format: string; data: Record<string, unknown> } | null = null
      const formats: string[] = []
      for (const file of files) {
        const result = await uploadOne(file)
        formats.push(result.format)
        if (result.format === 'holdings') lastResult = result
      }

      const uploadResult: UploadResult = {
        snapshotId:    lastResult?.data.snapshotId as number | undefined,
        positionCount: lastResult?.data.positionCount as number | undefined,
        optionCount:   lastResult?.data.optionCount as number | undefined,
        orderCount:    lastResult?.data.orderCount as number | undefined,
        lastUpdated:   extractDateFromFilename(files[0].name),
        fileCount:     files.length,
        formats,
      }
      setStatus('success')
      onSuccess?.(uploadResult)
      if (inputRef.current) inputRef.current.value = ''
      setTimeout(() => setStatus(s => (s === 'success' ? 'idle' : s)), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error — could not reach server.')
      setStatus('error')
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    upload(Array.from(files))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  const label = status === 'uploading' ? 'Importing…'
    : status === 'success' ? 'Imported'
    : status === 'error' ? 'Retry'
    : 'Import CSV'

  const Icon = status === 'uploading' ? Loader2
    : status === 'success' ? CheckCircle2
    : status === 'error' ? AlertCircle
    : Upload

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        multiple
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={status === 'uploading'}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        title="Drop holdings / transactions / ticker-earnings CSVs (one or several at once) or click to browse"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-60',
          status === 'error'
            ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
          dragging && 'ring-2 ring-primary/60',
        )}
      >
        <Icon className={cn('w-3.5 h-3.5', status === 'uploading' && 'animate-spin')} />
        {label}
      </button>
      {status === 'error' && error && (
        <p className="absolute right-0 top-full mt-1 text-[11px] text-destructive whitespace-nowrap z-10">{error}</p>
      )}
    </div>
  )
}
