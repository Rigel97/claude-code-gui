export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

let enqueueRequest: ((request: ConfirmRequest) => void) | null = null;

/** ConfirmDialogHost 注册后，确认请求进入主题弹层队列。 */
export function registerConfirmHandler(handler: ((request: ConfirmRequest) => void) | null) {
  enqueueRequest = handler;
  return () => { if (enqueueRequest === handler) enqueueRequest = null; };
}

/**
 * 主题化确认入口。App 挂载 ConfirmDialogHost 时使用统一弹层；
 * 组件级测试夹具或主进程外调用未挂载 Host 时回退到原生 confirm。
 */
export function confirmAction(options: ConfirmOptions | string): Promise<boolean> {
  const normalized: ConfirmOptions = typeof options === 'string'
    ? { title: '确认操作', message: options }
    : options;
  if (!enqueueRequest) {
    return Promise.resolve(typeof window === 'undefined' ? false : window.confirm(normalized.message));
  }
  return new Promise(resolve => {
    enqueueRequest!({ ...normalized, id: Date.now() + Math.random(), resolve });
  });
}
