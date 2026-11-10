/**
 * 共享控件原语：页面操作 32px，紧凑操作 28px；导航与数据不冒充操作按钮。
 * 所有变体使用相同盒模型，文字、图标与菜单项各自对齐。
 */
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:cursor-not-allowed disabled:opacity-40';
const BASE = `inline-flex h-8 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-xs leading-none transition-colors ${FOCUS}`;
const SMALL = `inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs leading-none transition-colors ${FOCUS}`;
const SECONDARY = 'border-border-light bg-bg-light/60 text-text-secondary hover:border-text-muted/50 hover:bg-bg-lighter hover:text-text-primary';
const PRIMARY = 'border-accent-cyan/60 bg-accent-cyan text-bg-deepest hover:border-accent-cyan hover:bg-accent-cyan/85';
const DANGER = 'border-accent-red/30 bg-accent-red/5 text-accent-red hover:border-accent-red/60 hover:bg-accent-red/15';
const GHOST = 'border-transparent bg-transparent text-text-secondary hover:bg-bg-light hover:text-text-primary';

export const BUTTON = `${BASE} ${SECONDARY}`;
export const BUTTON_PRIMARY = `${BASE} ${PRIMARY}`;
export const BUTTON_DANGER = `${BASE} ${DANGER}`;
export const BUTTON_GHOST = `${BASE} ${GHOST}`;
export const BUTTON_SM = `${SMALL} ${SECONDARY}`;
export const BUTTON_SM_PRIMARY = `${SMALL} ${PRIMARY}`;
export const BUTTON_SM_DANGER = `${SMALL} ${DANGER}`;
export const BUTTON_SM_GHOST = `${SMALL} ${GHOST}`;
export const BUTTON_ACTIVE = 'border-border-light bg-bg-lighter text-text-primary';

export const ICON_BUTTON = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-light hover:bg-bg-light hover:text-text-primary ${FOCUS}`;
export const ICON_BUTTON_SM = `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-text-muted transition-colors hover:bg-bg-lighter hover:text-text-primary ${FOCUS}`;
export const MENU_ITEM = `flex min-h-8 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs leading-5 text-text-secondary transition-colors hover:bg-bg-light hover:text-text-primary ${FOCUS}`;
export const MENU_ITEM_DANGER = `flex min-h-8 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs leading-5 text-accent-red transition-colors hover:bg-accent-red/10 ${FOCUS}`;
export const MENU_LABEL = 'px-3 pb-1 pt-2 text-xs font-medium text-text-muted';
export const POPOVER_PANEL = 'z-50 rounded-xl border border-border-light bg-bg-deep p-1.5 shadow-2xl';

export const BUTTON_GROUP = 'inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-bg-deepest/40 p-1';
export const SEGMENT = `inline-flex h-8 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-xs text-text-secondary transition-colors hover:bg-bg-light hover:text-text-primary ${FOCUS}`;
export const SEGMENT_ACTIVE = 'bg-bg-lighter text-text-primary';
export const PAGE_TAB = `inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap border-b-2 px-3 text-xs transition-colors ${FOCUS}`;
export const PAGE_TAB_ACTIVE = 'border-accent-cyan text-text-primary';
export const PAGE_TAB_IDLE = 'border-transparent text-text-muted hover:border-border-light hover:text-text-primary';
export const NAV_ITEM = `flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm text-text-secondary transition-colors hover:bg-bg-light hover:text-text-primary ${FOCUS}`;
export const NAV_ITEM_ACTIVE = 'bg-bg-lighter text-text-primary';
export const SELECT = `h-8 min-w-0 rounded-lg border border-border-light bg-bg-deepest px-2.5 text-xs leading-none text-text-primary outline-none transition-colors focus:border-accent-cyan/60 ${FOCUS}`;
export const INPUT = 'w-full min-w-0 rounded-lg border border-border-light bg-bg-deepest px-3 py-2 text-sm leading-relaxed text-text-primary outline-none transition-colors focus:border-accent-cyan/60 disabled:opacity-50';
export const CARD = 'rounded-xl border border-border bg-bg-deep';
