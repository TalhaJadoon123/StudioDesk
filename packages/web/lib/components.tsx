import Link from 'next/link';

const NAV = [
  {
    label: 'Studio',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: '◧' },
      { href: '/schedule', label: 'Schedule', icon: '▦' },
      { href: '/members', label: 'Members', icon: '☰' },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/billing', label: 'Billing', icon: '◈' },
      { href: '/reports', label: 'Reports', icon: '◔' },
    ],
  },
];

/** The signed-in shell. Server component; the active link needs `pathname`, so
 *  the highlight is applied by a tiny client child. */
export function AppShell({
  studioName,
  tier,
  children,
}: {
  studioName: string;
  tier: string;
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="truncate">{studioName}</span>
        </div>

        {NAV.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => (
              <Link className="nav-item" href={item.href} key={item.href}>
                <span aria-hidden style={{ width: 14, textAlign: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            ))}
          </div>
        ))}

        <div className="nav-group">
          <div className="nav-label">Account</div>
          <Link className="nav-item" href="/settings">
            <span aria-hidden style={{ width: 14, textAlign: 'center' }}>
              ⚙
            </span>
            Settings
          </Link>
          <Link className="nav-item" href="/">
            <span aria-hidden style={{ width: 14, textAlign: 'center' }}>
              ↩
            </span>
            Marketing site
          </Link>
        </div>

        <div style={{ marginTop: 'auto', paddingTop: 18 }}>
          <span className="badge info">{tier}</span>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}

/** Standard page header. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  );
}

/** A stat tile. */
export function Stat({
  label,
  value,
  meta,
  delta,
}: {
  label: string;
  value: string;
  meta?: string;
  delta?: { value: string; direction: 'up' | 'down' };
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {meta || delta ? (
        <div className="stat-meta">
          {delta ? (
            <span className={`stat-delta ${delta.direction}`}>
              {delta.direction === 'up' ? '▲' : '▼'} {delta.value}
            </span>
          ) : null}
          {meta ? (delta ? ` ${meta}` : meta) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Small inline progress bar for fill rates. */
export function FillBar({ fill }: { fill: number }) {
  const width = Math.min(100, Math.max(0, fill * 100));
  const tone = fill >= 1 ? 'full' : fill >= 0.8 ? 'good' : '';
  return (
    <div className="bar" role="presentation">
      <div className={`bar-fill ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
  children: React.ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
