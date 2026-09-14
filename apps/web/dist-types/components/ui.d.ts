import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react';
import { type PrinterStatus, type Severity } from '@kode/shared';
/**
 * The primitive layer.
 *
 * Small, unopinionated, and styled entirely through the classes in
 * `components.css`. Nothing here reaches for the network or the router, so a
 * screen can be read top to bottom without chasing behaviour into a component.
 */
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
export declare function KodeMark({ size, title }: {
    size?: number;
    title?: string;
}): ReactElement;
export declare function KodeWordmark(): ReactElement;
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: 'sm' | 'md' | 'lg';
    block?: boolean;
    loading?: boolean;
    icon?: ReactNode;
}
export declare function Button({ variant, size, block, loading, icon, children, className, disabled, ...rest }: ButtonProps): ReactElement;
/**
 * A link that looks like a button.
 *
 * A separate component rather than a polymorphic `as` prop on `Button`: a
 * navigation and an action are different things to a screen reader and to a
 * keyboard, and collapsing them into one component is how anchors end up
 * rendered as `<button>` and lose middle-click, "open in new tab" and the
 * browser's own focus semantics.
 */
export declare function buttonClasses(variant?: ButtonVariant, size?: 'sm' | 'md' | 'lg', block?: boolean): string;
export declare function Spinner({ size }: {
    size?: number;
}): ReactElement;
export declare function Card({ children, interactive, className, ...rest }: {
    children: ReactNode;
    interactive?: boolean;
    className?: string;
} & Record<string, unknown>): ReactElement;
export declare function PageHeader({ eyebrow, title, subtitle, actions, }: {
    eyebrow?: string | undefined;
    title: string;
    subtitle?: string | undefined;
    actions?: ReactNode | undefined;
}): ReactElement;
export declare function StatusDot({ status }: {
    status: PrinterStatus;
}): ReactElement;
/**
 * The status of a printer, said in words.
 *
 * `label` is passed in rather than derived here, because the translation from
 * IPP keywords to English lives in `lib/plain.ts` and must not be duplicated.
 * This component used to render `reasons[0].replace(/-/g, ' ')`, which is how
 * "media empty" reached a receptionist's screen.
 */
export declare function StatusBadge({ status, label, }: {
    status: PrinterStatus;
    label?: string | undefined;
}): ReactElement;
export declare function Badge({ children, tone, }: {
    children: ReactNode;
    tone?: 'default' | 'accent' | 'info' | 'online' | 'degraded' | 'offline';
}): ReactElement;
export declare function Field({ label, hint, error, children, }: {
    label: string;
    hint?: string;
    error?: string;
    children: (id: string) => ReactNode;
}): ReactElement;
export declare function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactElement;
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
export declare function Segmented<T extends string>({ value, options, onChange, label, }: {
    value: T;
    options: ReadonlyArray<SegmentedOption<T>>;
    onChange: (value: T) => void;
    label: string;
}): ReactElement;
export declare function Switch({ checked, onChange, label, hint, }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    hint?: string;
}): ReactElement;
export declare function Modal({ open, onClose, title, children, footer, }: {
    open: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    footer?: ReactNode;
}): ReactElement | null;
export interface Toast {
    id: number;
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    body?: string;
}
interface ToastContextValue {
    push: (toast: Omit<Toast, 'id'>) => void;
}
export declare function ToastProvider({ children }: {
    children: ReactNode;
}): ReactElement;
export declare function useToast(): ToastContextValue;
export declare function Skeleton({ height, width, }: {
    height?: number;
    width?: string;
}): ReactElement;
export declare function EmptyState({ icon, title, body, action, }: {
    icon?: ReactNode;
    title: string;
    body?: string;
    action?: ReactNode;
}): ReactElement;
/**
 * A caveat shown alongside a figure.
 *
 * §B8.5 and DEC-06 both require limitations to travel with the numbers. This is
 * the component that carries them, and it is deliberately quiet — an alarming
 * banner would read as "something is broken" when the correct reading is "this
 * figure has a known boundary".
 */
export declare function Note({ children, severity, }: {
    children: ReactNode;
    severity?: Severity;
}): ReactElement;
export declare function Stat({ label, value, meta, tone, }: {
    label: string;
    value: ReactNode;
    meta?: ReactNode;
    tone?: string;
}): ReactElement;
export declare const CloseIcon: () => ReactElement;
export declare const PrintIcon: () => ReactElement;
export declare const FleetIcon: () => ReactElement;
export declare const ScanIcon: () => ReactElement;
export declare const HistoryIcon: () => ReactElement;
export declare const InsightIcon: () => ReactElement;
export declare const AdminIcon: () => ReactElement;
export declare const BellIcon: () => ReactElement;
export declare const UploadIcon: () => ReactElement;
export declare const QrIcon: () => ReactElement;
export declare const CheckIcon: () => ReactElement;
export declare const HomeIcon: () => ReactElement;
export declare const PeopleIcon: () => ReactElement;
export {};
//# sourceMappingURL=ui.d.ts.map