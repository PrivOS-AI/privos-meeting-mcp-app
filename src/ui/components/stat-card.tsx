/**
 * History screen's 4 top stat cards (phase-07 § Requirements/Implementation
 * Steps 3). Purely presentational — `history-screen.tsx` supplies the
 * already-computed value string.
 */
import { Icon, type IconName } from './icon.js';

export interface StatCardProps {
  icon: IconName;
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}

export function StatCard({ icon, label, value, tone = 'default' }: StatCardProps) {
  return (
    <div className={`ma-stat-card ma-stat-card--${tone}`}>
      <div className="ma-stat-card__icon">
        <Icon name={icon} size={18} />
      </div>
      <div className="ma-stat-card__body">
        <p className="ma-stat-card__value">{value}</p>
        <p className="ma-stat-card__label">{label}</p>
      </div>
    </div>
  );
}
