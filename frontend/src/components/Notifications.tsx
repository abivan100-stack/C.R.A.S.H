import { SEV, isSeverity } from '../domain/constants.ts';
import type { ReportNotification } from '../app/useDataset.ts';
import { Icon } from './Icon.tsx';

interface Props {
  open: boolean;
  unread: number;
  items: readonly ReportNotification[];
  onToggle: () => void;
  onClear: () => void;
}

function relativeTime(datetime: string): string {
  const then = new Date(datetime.replace(' ', 'T')).getTime();
  if (!Number.isFinite(then)) return datetime;
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Live feed of shared citizen reports, matching the legacy bell + panel. */
export function Notifications({ open, unread, items, onToggle, onClear }: Props): JSX.Element {
  return (
    <div className="notify-wrap">
      <button
        className="icon-btn notify-bell"
        type="button"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="bell" size={16} />
        {unread > 0 ? <span className="notify-badge">{unread}</span> : null}
      </button>
      {open ? (
        <div className="notify-panel" role="dialog" aria-label="Recent reports">
          <div className="notify-head">
            <span className="notify-title">Recent reports</span>
            <button className="notify-clear" type="button" onClick={onClear}>Clear</button>
          </div>
          <div className="notify-list">
            {items.length === 0 ? (
              <div className="notify-empty">No reports yet</div>
            ) : (
              items.map((n) => {
                const severity = isSeverity(n.severity) ? n.severity : 'slight';
                return (
                  <div className="notify-row unread" key={n.id}>
                    <span className="notify-dot" style={{ background: SEV[severity].color }} />
                    <span className="notify-row-main">
                      <span className="notify-row-text">
                        {SEV[severity].label} crash - {n.area}
                      </span>
                    </span>
                    <span className="notify-time">{relativeTime(n.datetime)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
