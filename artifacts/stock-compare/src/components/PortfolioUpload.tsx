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

export function PortfolioUpload({ onSuccess }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  async function upload(file: File) {
    setStatus('uploading')
    setError(null)
    setResult(null)

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
      setResult(uploadResult)
      setStatus('success')
      onSuccess?.(uploadResult)
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

  function reset() {
    setStatus('idle')
    setResult(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div
      className={cn(
        'relative flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors',
        dragging
          ? 'border-primary/60 bg-primary/5'
          : 'border-border bg-card',
      )}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
      />

      {/* Icon */}
      <div className="shrink-0">
        {status === 'uploading' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {status === 'success'   && <CheckCircle2 className="h-4 w-4 text-green-500" />}
        {status === 'error'     && <AlertCircle className="h-4 w-4 text-destructive" />}
        {status === 'idle'      && <Upload className="h-4 w-4 text-muted-foreground" />}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        {status === 'idle' && (
          <p className="text-xs text-muted-foreground">
            Drop a Robinhood CSV or{' '}
            <button
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => inputRef.current?.click()}
            >
              browse
            </button>
          </p>
        )}
        {status === 'uploading' && (
          <p className="text-xs text-muted-foreground animate-pulse">Importing…</p>
        )}
        {status === 'success' && result && (
          <div>
            <p className="text-xs text-green-500 font-medium">
              Imported — {result.positionCount} positions, {result.optionCount} options
            </p>
            {result.lastUpdated && (
              <p className="text-xs text-muted-foreground/70">
                Last updated: {result.lastUpdated}
              </p>
            )}
          </div>
        )}
        {status === 'error' && (
          <p className="text-xs text-destructive truncate">{error}</p>
        )}
      </div>

      {/* Reset after done */}
      {(status === 'success' || status === 'error') && (
        <button
          onClick={reset}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {status === 'success' ? 'Upload another' : 'Retry'}
        </button>
      )}
    </div>
  )
}
