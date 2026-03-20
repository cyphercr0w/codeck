import { useState, useEffect, useRef } from 'preact/hooks';
import { activeSessionId } from '../state/store';
import { apiFetch } from '../api';
import { sendTerminalInput } from '../terminal';

interface UploadOverlayProps {
  file: File | null;
  onDone: () => void;
}

type UploadState = 'preview' | 'uploading' | 'done' | 'error';

function getUploadType(file: File): 'image' | 'video' | 'text' | 'file' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('text/') || file.name.endsWith('.txt')) return 'text';
  return 'file';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function UploadOverlay({ file, onDone }: UploadOverlayProps) {
  const [state, setState] = useState<UploadState>('preview');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const uploadType = file ? getUploadType(file) : 'file';

  useEffect(() => {
    if (!file) return;
    if (uploadType === 'image' || uploadType === 'video') {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
  }, [file]);

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
      let data: string;
      if (uploadType === 'text') {
        data = await fileToText(file);
      } else {
        data = await fileToBase64(file);
      }

      const res = await apiFetch('/api/files/upload', {
        method: 'POST',
        body: JSON.stringify({
          data,
          mimeType: file.type || 'application/octet-stream',
          fileName: file.name || undefined,
          type: uploadType,
        }),
        signal: abortRef.current.signal,
      });

      const result = await res.json();
      if (!result.success) {
        setError(result.error || 'Upload failed');
        setState('error');
        return;
      }

      sendTerminalInput(sessionId, result.filePath + ' ');
      setState('done');
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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleCancel();
      if (e.key === 'Enter' && state === 'preview') handleUpload();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state, file]);

  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
  const sizeKB = (file.size / 1024).toFixed(0);
  const sizeLabel = file.size >= 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  const typeLabels: Record<string, string> = {
    image: 'Image',
    video: 'Video',
    text: 'Text file',
    file: 'File',
  };

  return (
    <div class="image-upload-overlay" onClick={handleCancel}>
      <div class="image-upload-content" onClick={(e) => e.stopPropagation()}>
        {/* Preview */}
        {previewUrl && uploadType === 'image' && (
          <div class="image-upload-preview">
            <img src={previewUrl} alt="Upload preview" />
          </div>
        )}
        {previewUrl && uploadType === 'video' && (
          <div class="image-upload-preview">
            <video src={previewUrl} controls style="max-width: 100%; max-height: 200px; border-radius: 6px" />
          </div>
        )}
        {uploadType === 'text' && (
          <div class="upload-text-preview">
            <span class="upload-text-badge">TXT</span>
            <span class="upload-text-chars">{file.size.toLocaleString()} chars</span>
          </div>
        )}

        <div class="image-upload-info">
          <span class="image-upload-name">{file.name || `clipboard-${uploadType}`}</span>
          <span class="image-upload-size">{typeLabels[uploadType]} &middot; {sizeLabel}</span>
        </div>

        {state === 'preview' && (
          <div class="image-upload-actions">
            <button class="btn-secondary" onClick={handleCancel}>Cancel</button>
            <button class="btn-primary" onClick={handleUpload}>
              {uploadType === 'text' ? 'Upload as .txt' : 'Send to terminal'}
            </button>
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
