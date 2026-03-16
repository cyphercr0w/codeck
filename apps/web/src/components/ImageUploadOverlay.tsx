import { useState, useEffect, useRef } from 'preact/hooks';
import { activeSessionId } from '../state/store';
import { apiFetch } from '../api';
import { sendTerminalInput } from '../terminal';

interface ImageUploadOverlayProps {
  file: File | null;
  onDone: () => void;
}

type UploadState = 'preview' | 'uploading' | 'done' | 'error';

/** Read a File as base64 string (data portion only, no prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:image/png;base64," prefix
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ImageUploadOverlay({ file, onDone }: ImageUploadOverlayProps) {
  const [state, setState] = useState<UploadState>('preview');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Generate preview URL from file
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Reset state when file changes
  useEffect(() => {
    setState('preview');
    setError('');
  }, [file]);

  if (!file) return null;

  async function handleUpload() {
    if (!file) return;
    const sessionId = activeSessionId.value;
    if (!sessionId) {
      setError('No active session');
      setState('error');
      return;
    }

    setState('uploading');
    abortRef.current = new AbortController();

    try {
      const base64 = await fileToBase64(file);

      const res = await apiFetch('/api/files/upload-image', {
        method: 'POST',
        body: JSON.stringify({
          data: base64,
          mimeType: file.type || 'image/png',
          fileName: file.name || undefined,
        }),
        signal: abortRef.current.signal,
      });

      const result = await res.json();
      if (!result.success) {
        setError(result.error || 'Upload failed');
        setState('error');
        return;
      }

      // Inject file path into terminal stdin
      sendTerminalInput(sessionId, result.filePath + ' ');
      setState('done');

      // Auto-close after brief confirmation
      setTimeout(onDone, 400);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || 'Upload failed');
      setState('error');
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
    onDone();
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleCancel();
      if (e.key === 'Enter' && state === 'preview') handleUpload();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state, file]);

  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);

  return (
    <div class="image-upload-overlay" onClick={handleCancel}>
      <div class="image-upload-content" onClick={(e) => e.stopPropagation()}>
        {previewUrl && (
          <div class="image-upload-preview">
            <img src={previewUrl} alt="Upload preview" />
          </div>
        )}

        <div class="image-upload-info">
          <span class="image-upload-name">{file.name || 'clipboard-image.png'}</span>
          <span class="image-upload-size">{sizeMB} MB</span>
        </div>

        {state === 'preview' && (
          <div class="image-upload-actions">
            <button class="btn-secondary" onClick={handleCancel}>Cancel</button>
            <button class="btn-primary" onClick={handleUpload}>Send to terminal</button>
          </div>
        )}

        {state === 'uploading' && (
          <div class="image-upload-status">
            <div class="spinner-sm" />
            <span>Uploading...</span>
          </div>
        )}

        {state === 'done' && (
          <div class="image-upload-status done">
            <span>Sent</span>
          </div>
        )}

        {state === 'error' && (
          <div class="image-upload-status error">
            <span>{error}</span>
            <div class="image-upload-actions">
              <button class="btn-secondary" onClick={handleCancel}>Cancel</button>
              <button class="btn-primary" onClick={handleUpload}>Retry</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
