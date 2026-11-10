import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useDialogBehavior } from './useDialogBehavior';
import { registerConfirmHandler, type ConfirmRequest } from '../utils/confirm';
import { BUTTON, BUTTON_DANGER, BUTTON_PRIMARY } from './controls';

export { confirmAction } from '../utils/confirm';
export type { ConfirmOptions } from '../utils/confirm';

export function ConfirmDialogHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const queueRef = useRef<ConfirmRequest[]>([]);
  queueRef.current = queue;
  const current = queue[0] ?? null;

  useEffect(() => {
    return registerConfirmHandler(request => setQueue(items => [...items, request]));
  }, []);

  const resolve = (confirmed: boolean) => {
    if (!current) return;
    current.resolve(confirmed);
    setQueue(items => items.slice(1));
  };

  // Host 卸载时释放未决确认，避免调用方永久等待；不在卸载期 setState。
  useEffect(() => () => {
    queueRef.current.forEach(item => item.resolve(false));
    queueRef.current = [];
  }, []);

  if (!current) return null;
  return <ConfirmDialogView key={current.id} request={current} onResolve={resolve} />;
}

function ConfirmDialogView({ request, onResolve }: { request: ConfirmRequest; onResolve: (confirmed: boolean) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior({
    open: true,
    dialogRef,
    onRequestClose: () => onResolve(false),
    initialFocusSelector: '[data-confirm-cancel]',
  });
  const danger = request.tone !== 'default';
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-bg-deep shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <span className={`mt-0.5 shrink-0 rounded-lg border p-1.5 ${danger ? 'border-accent-red/30 bg-accent-red/10 text-accent-red' : 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan'}`}>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="text-sm font-semibold text-text-primary">{request.title}</h2>
            <p className="mt-1 text-2xs text-text-dim">请核对对象与后果后再确认。</p>
          </div>
          <button type="button" aria-label="取消并关闭确认" onClick={() => onResolve(false)} className="rounded p-1 text-text-muted transition-colors hover:bg-bg-light hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div id="confirm-dialog-message" className="max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words px-5 py-4 text-xs leading-6 text-text-secondary selectable-text">
          {request.message}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 bg-bg-deepest/40 px-5 py-3">
          <button
            type="button"
            data-confirm-cancel
            onClick={() => onResolve(false)}
            className={BUTTON}
          >
            {request.cancelLabel || '取消'}
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className={`${danger ? BUTTON_DANGER : BUTTON_PRIMARY} font-medium`}
          >
            {request.confirmLabel || '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
