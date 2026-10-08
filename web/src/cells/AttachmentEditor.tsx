import { useRef, useState } from 'react';
import type { Attachment } from '@shared';
import { platformApi } from '../api/endpoints';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { asAttachments, formatBytes, isImage } from '../lib/format';
import { toastError } from '../lib/toast';

interface Props {
  value: unknown;
  onChange: (value: Attachment[]) => void;
  readOnly?: boolean;
}

/** Attachment list with thumbnails, remove, and upload through POST /files. */
export function AttachmentEditor({ value, onChange, readOnly }: Props) {
  const list = asAttachments(value);
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const upload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setUploading((n) => n + arr.length);
    const added: Attachment[] = [];
    for (const f of arr) {
      try {
        added.push(await platformApi.uploadFile(f));
      } catch (e) {
        toastError(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added.length) onChange([...list, ...added]);
  };

  return (
    <div
      className={`attachment-editor ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDragOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="attachment-grid">
        {list.map((a, i) => (
          <div key={i} className="attachment-card">
            <a href={a.url} target="_blank" rel="noreferrer noopener" className="attachment-preview">
              {isImage(a) ? <img src={a.url} alt={a.title} /> : <Icon name="paperclip" size={22} />}
            </a>
            <div className="attachment-meta">
              <span className="attachment-title" title={a.title}>
                {a.title}
              </span>
              <span className="muted small">{formatBytes(a.size)}</span>
            </div>
            {!readOnly && (
              <button
                type="button"
                className="icon-btn attachment-remove"
                title={t('Remove')}
                onClick={() => onChange(list.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
        {!list.length && <div className="empty-hint">{readOnly ? t('No files') : t('Drop files here or click upload')}</div>}
      </div>
      {!readOnly && (
        <>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = '';
            }}
          />
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={uploading > 0}>
            <Icon name="upload" size={14} /> {uploading ? t('Uploading…') : t('Upload files')}
          </button>
        </>
      )}
    </div>
  );
}
