/** Inline sprite icon from the vendored icon sheet. */
export function Icon({ name, size = 14, className = 'ic' }: { name: string; size?: number; className?: string }): JSX.Element {
  return (
    <svg className={className} width={size} height={size} aria-hidden="true">
      <use href={`./vendor/icons.svg#i-${name}`} />
    </svg>
  );
}
