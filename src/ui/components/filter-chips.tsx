/**
 * History screen's filter-chip row (phase-07 § Requirements: "Tất cả / Có
 * action item / Đã bookmark / Của tôi"). Generic over the chip value type so
 * `history-screen.tsx` owns the actual option set/labels.
 */
export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  options: readonly FilterChipOption<T>[];
  value: T;
  onChange(value: T): void;
}

export function FilterChips<T extends string>({ options, value, onChange }: FilterChipsProps<T>) {
  return (
    <div className="ma-filter-chips" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`ma-filter-chips__chip${option.value === value ? ' ma-filter-chips__chip--active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
