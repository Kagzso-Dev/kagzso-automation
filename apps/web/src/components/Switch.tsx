/** The on/off switch used in Settings (Sidebar menu, AI call languages). */
export function Switch({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  /** Read by screen readers (the visible text sits next to the switch). */
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-200 ease-in-out-soft disabled:opacity-50 ${
        on ? "bg-gradient-accent shadow-[0_2px_8px_rgba(0,194,255,0.3)]" : "bg-line-strong"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(17,24,39,0.25)] transition-transform duration-[var(--motion-base)] ease-spring ${
          on ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
