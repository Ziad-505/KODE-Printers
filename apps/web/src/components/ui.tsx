import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  KODE_MARK_ASPECT,
  KODE_MARK_PATH,
  KODE_MARK_VIEWBOX,
  type PrinterStatus,
  type Severity,
} from '@kode/shared';
import { usePresence } from '../lib/presence.js';

/**
 * The primitive layer.
 *
 * Small, unopinionated, and styled entirely through the classes in
 * `components.css`. Nothing here reaches for the network or the router, so a
 * screen can be read top to bottom without chasing behaviour into a component.
 */

/* ─────────────────────────────────────────────────────────────── the mark ── */

/**
 * The KODE K.
 *
 * Inline SVG rather than an `<img>`: it inherits `currentColor`, so one
 * component serves the rail glyph, the sign-in lockup and the empty-state mark
 * without three assets to keep in sync.
 *
 * `fillRule="evenodd"` is not optional — the mark is two glyphs each with a
 * hairline inner channel, and under the default nonzero rule those channels
 * fill in and it becomes a blob.
 */
export function KodeMark({ size = 32, title }: { size?: number; title?: string }): ReactElement {
  return (
    <svg
      viewBox={KODE_MARK_VIEWBOX}
      width={size}
      height={size / KODE_MARK_ASPECT}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <path d={KODE_MARK_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

export function KodeWordmark(): ReactElement {
  return (
    <span className="row" style={{ gap: 'var(--space-3)' }}>
      <span style={{ color: 'var(--kode-blue-bright)' }}>
        <KodeMark size={26} title="KODE" />
      </span>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 900,
          fontSize: 'var(--text-lg)',
          letterSpacing: '-0.02em',
        }}
      >
        Printer
      </span>
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────── button ── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps): ReactElement {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'lg' ? 'btn--lg' : size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    !children ? 'btn--icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled ?? loading} {...rest}>
      {loading ? <Spinner size={15} /> : icon}
      {children}
    </button>
  );
}

/**
 * A link that looks like a button.
 *
 * A separate component rather than a polymorphic `as` prop on `Button`: a
 * navigation and an action are different things to a screen reader and to a
 * keyboard, and collapsing them into one component is how anchors end up
 * rendered as `<button>` and lose middle-click, "open in new tab" and the
 * browser's own focus semantics.
 */
export function buttonClasses(
  variant: ButtonVariant = 'secondary',
  size: 'sm' | 'md' | 'lg' = 'md',
  block = false,
): string {
  return [
    'btn',
    `btn--${variant}`,
    size === 'lg' ? 'btn--lg' : size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function Spinner({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'spin 0.8s linear infinite' }}
      role="presentation"
    >
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ───────────────────────────────────────────────────────────────── surfaces ── */

export function Card({
  children,
  interactive,
  className,
  ...rest
}: { children: ReactNode; interactive?: boolean; className?: string } & Record<
  string,
  unknown
>): ReactElement {
  return (
    <div
      className={['card', interactive ? 'card--interactive' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  // `| undefined` is explicit because `exactOptionalPropertyTypes` otherwise
  // rejects the ordinary React pattern of passing a possibly-undefined
  // expression into an optional prop.
  eyebrow?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode | undefined;
}): ReactElement {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="kode-eyebrow">{eyebrow}</div> : null}
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? (
        <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────────── status ── */

export function StatusDot({ status }: { status: PrinterStatus }): ReactElement {
  return <span className={`status-dot status-dot--${status}`} aria-hidden="true" />;
}

const STATUS_LABEL: Record<PrinterStatus, string> = {
  online: 'Ready',
  degraded: 'Attention',
  offline: 'Offline',
  unknown: 'Unknown',
};

/**
 * The status of a printer, said in words.
 *
 * `label` is passed in rather than derived here, because the translation from
 * IPP keywords to English lives in `lib/plain.ts` and must not be duplicated.
 * This component used to render `reasons[0].replace(/-/g, ' ')`, which is how
 * "media empty" reached a receptionist's screen.
 */
export function StatusBadge({
  status,
  label,
}: {
  status: PrinterStatus;
  label?: string | undefined;
}): ReactElement {
  return (
    <span className={`badge badge--${status}`}>
      <StatusDot status={status} />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'accent' | 'info' | 'online' | 'degraded' | 'offline';
}): ReactElement {
  return <span className={`badge${tone === 'default' ? '' : ` badge--${tone}`}`}>{children}</span>;
}

/* ──────────────────────────────────────────────────────────────────── field ── */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input className="input" {...props} />;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /**
   * Set when the device has not confirmed it supports this option.
   * §B7.3: showing a control that silently does nothing is worse than not
   * showing it, so unverified options are disabled with an explanation rather
   * than presented as working.
   */
  unavailable?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label: string;
}): ReactElement {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={value === option.value}
          disabled={Boolean(option.unavailable)}
          title={option.unavailable}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}): ReactElement {
  return (
    <label className="switch">
      <input
        type="checkbox"
        className="kode-visually-hidden"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch__track" />
      <span className="switch__thumb" />
      <span>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{label}</span>
        {hint ? (
          <span className="field__hint" style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────── modal ── */

/**
 * Page-scroll locking, counted rather than saved and restored.
 *
 * Each modal used to snapshot `document.body.style.overflow` on open and put it
 * back on close. With one modal that works. With two — the link dialog opening
 * as the create dialog closes, which is the ordinary path through People — the
 * second one snapshots the `hidden` the first had already set, and restores
 * *that*, leaving the page permanently unscrollable with no dialog on screen.
 *
 * A depth counter has no such failure: the lock lifts when the last dialog
 * closes and not before.
 */
let scrollLocks = 0;
let scrollWasSetTo = '';

function lockScroll(): void {
  if (scrollLocks === 0) {
    scrollWasSetTo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}

function unlockScroll(): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = scrollWasSetTo;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  // Kept mounted for the length of the leave animation. See `usePresence`.
  const { mounted, state } = usePresence(open);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // Focus moves into the dialog so a keyboard user is not left behind it, and
    // the body is locked so a phone does not scroll the page under the sheet.
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    lockScroll();

    return () => {
      document.removeEventListener('keydown', onKey);
      unlockScroll();
      previous?.focus();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      className="overlay"
      data-state={state}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal"
        data-state={state}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal__header">
          <h2 className="card__title">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── toasts ── */

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...toast, id }]);
    // Errors stay longer: they usually carry something the user has to read and
    // act on, while a success is just confirmation.
    const ttl = toast.tone === 'error' ? 9000 : 5000;
    window.setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, ttl);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`} data-state="open">
            <div style={{ minWidth: 0 }}>
              <div className="toast__title">{toast.title}</div>
              {toast.body ? <div className="toast__body">{toast.body}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/* ───────────────────────────────────────────────────────────────── feedback ── */

export function Skeleton({
  height = 20,
  width = '100%',
}: {
  height?: number;
  width?: string;
}): ReactElement {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="empty">
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <div className="empty__title">{title}</div>
      {body ? <p style={{ maxWidth: '44ch' }}>{body}</p> : null}
      {action}
    </div>
  );
}

/**
 * A caveat shown alongside a figure.
 *
 * §B8.5 and DEC-06 both require limitations to travel with the numbers. This is
 * the component that carries them, and it is deliberately quiet — an alarming
 * banner would read as "something is broken" when the correct reading is "this
 * figure has a known boundary".
 */
export function Note({
  children,
  severity = 'info',
}: {
  children: ReactNode;
  severity?: Severity;
}): ReactElement {
  return (
    <div className={`note${severity === 'critical' ? ' note--critical' : ''}`} role="note">
      <span aria-hidden="true">{severity === 'critical' ? '⚠' : 'ⓘ'}</span>
      <span>{children}</span>
    </div>
  );
}

export function Stat({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: string;
}): ReactElement {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {meta ? <div className="stat__meta">{meta}</div> : null}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────── icons ── */

const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const CloseIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const PrintIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <path d="M6 14h12v7H6z" />
  </svg>
);

export const FleetIcon = (): ReactElement => (
  <svg {...iconProps}>
    <rect x="3" y="4" width="8" height="7" rx="1.5" />
    <rect x="13" y="4" width="8" height="7" rx="1.5" />
    <rect x="3" y="13" width="8" height="7" rx="1.5" />
    <rect x="13" y="13" width="8" height="7" rx="1.5" />
  </svg>
);

export const ScanIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M3 12h18" />
  </svg>
);

export const HistoryIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const InsightIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-5 3.5 3L20 6" />
  </svg>
);

export const AdminIcon = (): ReactElement => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const BellIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

export const UploadIcon = (): ReactElement => (
  <svg {...iconProps} width={28} height={28}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5M12 3v13" />
  </svg>
);

export const QrIcon = (): ReactElement => (
  <svg {...iconProps}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM18 18h3v3h-3z" />
  </svg>
);

export const CheckIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const HomeIcon = (): ReactElement => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20h14V9.5" />
    <path d="M10 20v-6h4v6" />
  </svg>
);

export const PeopleIcon = (): ReactElement => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
  </svg>
);
