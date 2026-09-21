/**
 * Centered icon + title + subtitle placeholder used by every screen in this
 * Phase 1 scaffold. Screens supply their own icon and copy; this component
 * owns only the layout.
 */
import { Icon, type IconName } from './icon.js';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  subtitle: string;
}

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  return (
    <div className="ma-empty">
      <div className="ma-empty__icon">
        <Icon name={icon} size={28} />
      </div>
      <h2 className="ma-empty__title">{title}</h2>
      <p className="ma-empty__subtitle">{subtitle}</p>
    </div>
  );
}
