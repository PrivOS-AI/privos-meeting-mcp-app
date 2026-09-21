/**
 * Right-hand drawer for the read-only meeting detail — mirrors the live tab's
 * `LiveSidePanel` shell (`.ma-side-panel`) so history detail reads like the
 * meeting tab. Tabs are supplied by the screen already wired to their data
 * (Summary w/ regenerate, Action items, Bookmarks, Speakers w/ edit); this
 * component only owns the tab strip + which section shows.
 */
import { useState, type ReactNode } from 'react';

import { Icon, type IconName } from './icon.js';

export interface DetailSideTab {
  id: string;
  icon: IconName;
  label: string;
  node: ReactNode;
}

export interface MeetingDetailSidePanelProps {
  tabs: DetailSideTab[];
}

export function MeetingDetailSidePanel({ tabs }: MeetingDetailSidePanelProps) {
  const [active, setActive] = useState(tabs[0]?.id);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div className="ma-side-panel">
      <div className="ma-side-panel__tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={current?.id === tab.id}
            className={`ma-side-panel__tab${current?.id === tab.id ? ' ma-side-panel__tab--active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            <Icon name={tab.icon} size={16} />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="ma-side-panel__body">{current?.node}</div>
    </div>
  );
}
