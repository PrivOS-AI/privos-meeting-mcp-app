/**
 * Every icon under `assets/icons` inlined as raw SVG markup at build time.
 * `?raw` avoids a network request per icon — required in the opaque `srcdoc`
 * iframe, which cannot fetch sibling asset URLs.
 *
 * `import.meta.glob` keys are typed as plain `string` by Vite, so they cannot
 * drive a literal `IconName` union on their own. `ICON_NAMES` below is the
 * source of truth for the type; it must stay in sync with the files under
 * `assets/icons/` (a dev-time console warning fires if it ever drifts).
 */
const iconModules = import.meta.glob('../assets/icons/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function fileNameToIconName(path: string): string {
  return path.replace('../assets/icons/', '').replace(/\.svg$/, '');
}

// Every icon ships with a hardcoded `#080D0F` ink stroke/fill. Rewrite it to
// `currentColor` so icons follow the surrounding text color and flip with the
// theme (white on the dark canvas, navy on the gold button, white on brand
// buttons) instead of staying near-black and vanishing in dark mode.
const markupByName: Record<string, string> = Object.fromEntries(
  Object.entries(iconModules).map(([path, svg]) => [fileNameToIconName(path), svg.replace(/#080D0F/gi, 'currentColor')]),
);

export const ICON_NAMES = [
  'add',
  'alert-circle',
  'arrow-download',
  'arrow-export',
  'arrow-left',
  'arrow-up-down',
  'bell',
  'bookmark',
  'bookmark-add',
  'bot',
  'calendar',
  'chat',
  'checkbox-checked',
  'checkbox-unchecked',
  'checkmark',
  'checkmark-circle',
  'chevron-down',
  'chevron-right',
  'clock',
  'copy',
  'document',
  'edit',
  'file-text',
  'filter',
  'globe',
  'history',
  'lightbulb',
  'microphone',
  'microphone-off',
  'more',
  'pause',
  'person-multiple',
  'pin',
  'play',
  'record',
  'record-stop',
  'search',
  'settings',
  'share',
  'shield-keyhole',
  'sparkle',
  'star',
  'text-font-size',
  'translate',
  'volume',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** The exact set of icon names available, for callers that need to list them. */
export function listIconNames(): readonly IconName[] {
  return ICON_NAMES;
}

export interface IconProps {
  name: IconName;
  /** Square size in px. Defaults to 20. */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 20, className }: IconProps) {
  const markup = markupByName[name];
  if (markup === undefined && import.meta.env.DEV) {
    // Signals a drift between ICON_NAMES and the actual assets/icons files.
    console.warn(`[Icon] "${name}" has no matching file under assets/icons/.`);
  }

  return (
    <span
      className={className ? `ma-icon ${className}` : 'ma-icon'}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup ?? '' }}
    />
  );
}
