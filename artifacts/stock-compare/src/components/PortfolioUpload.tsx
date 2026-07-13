import { useRef, useState } from 'react'
import { Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UploadResult {
  snapshotId: number
  positionCount: number
  optionCount: number
  orderCount: number
  lastUpdated: string | null
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
export function PortfolioUpload({ onSuccess }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  async function upload(file: File) {
    setStatus('uploading')
    setError(null)

    try {
      const text = await file.text()
      const res = await fetch('/api/portfolio/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
        credentials: 'include',
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.message ?? `Upload failed (${res.status})`)
        setStatus('error')
        return
      }

      const uploadResult: UploadResult = {
        snapshotId:    data.snapshotId,
        positionCount: data.positionCount,
        optionCount:   data.optionCount,
        orderCount:    data.orderCount,
        lastUpdated:   extractDateFromFilename(file.name),
      }
      setStatus('success')
      onSuccess?.(uploadResult)
      if (inputRef.current) inputRef.current.value = ''
      setTimeout(() => setStatus(s => (s === 'success' ? 'idle' : s)), 3000)
    } catch {
      setError('Network error — could not reach server.')
      setStatus('error')
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    upload(file)
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
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={status === 'uploading'}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        title="Drop a Robinhood CSV or click to browse"
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
