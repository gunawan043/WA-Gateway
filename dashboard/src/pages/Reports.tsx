import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BarChart3, Loader2 } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '../components/PageHeader';
import { useDivisionsQuery, useInboxReportQuery, useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './Reports.css';

const DAY_MS = 86_400_000;
const RANGES = [7, 30, 90] as const;

const tooltipStyles = {
  contentStyle: { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)' },
  labelStyle: { color: 'var(--text-primary)' },
  itemStyle: { color: 'var(--text-primary)' },
};

/**
 * First-response and SLA metrics for the session's inbox.
 *
 * Read-only, and deliberately not polled: these numbers move when people answer customers, not on a
 * timer, so the range and division controls are what trigger a refetch.
 */
export function Reports() {
  const { t } = useTranslation();
  useDocumentTitle(t('reports.title'));

  const { data: sessions = [], isLoading: sessionsLoading } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [division, setDivision] = useState('all');

  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(session => session.status === 'ready') ?? sessions[0];
    setSessionId(ready.id);
  }, [sessionId, sessions]);

  // The window is fixed per range choice, so the query key does not change on every render.
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const divisions = useDivisionsQuery(sessionId);
  const report = useInboxReportQuery(sessionId, {
    ...range,
    division: division === 'all' ? undefined : division,
  });

  const data = report.data;
  const status = (report.error as (Error & { status?: number }) | null)?.status;
  const divisionLabel = (id: string | null, name: string | null) =>
    name ?? (id ? id : t('reports.division.unassigned'));
  const minutes = (value: number | null) =>
    value === null ? t('reports.noValue') : t('reports.minutes', { value: Math.round(value * 10) / 10 });
  const percent = (value: number | null) =>
    value === null ? t('reports.noValue') : t('reports.percent', { value: Math.round(value * 1_000) / 10 });

  const byDivision = (data?.byDivision ?? []).map(row => ({
    name: divisionLabel(row.divisionId, row.divisionName),
    conversations: row.conversations,
    breached: row.slaBreached,
  }));
  const daily = (data?.daily ?? []).map(row => ({
    ...row,
    label: row.date.slice(5),
  }));

  return (
    <div className="reports-page">
      <PageHeader
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
        actions={
          <select
            className="reports-session-select"
            value={sessionId}
            onChange={event => setSessionId(event.target.value)}
            aria-label={t('reports.session')}
            disabled={sessionsLoading}
          >
            {sessions.length === 0 && <option value="">{t('reports.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {!sessionId && !sessionsLoading ? (
        <div className="reports-empty">
          <BarChart3 size={32} />
          <p>{t('reports.empty.selectSession')}</p>
        </div>
      ) : (
        <>
          <div className="reports-filters">
            <div className="reports-range" role="group" aria-label={t('reports.range.label')}>
              {RANGES.map(value => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={days === value}
                  className={`reports-range-tab ${days === value ? 'active' : ''}`}
                  onClick={() => setDays(value)}
                >
                  {t(`reports.range.days${value}`)}
                </button>
              ))}
            </div>
            <select
              value={division}
              onChange={event => setDivision(event.target.value)}
              aria-label={t('reports.division.label')}
            >
              <option value="all">{t('reports.division.all')}</option>
              <option value="unassigned">{t('reports.division.unassigned')}</option>
              {(divisions.data ?? []).map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          {report.isLoading ? (
            <div className="reports-empty">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : report.isError ? (
            <div className="reports-empty reports-error">
              <AlertCircle size={22} />
              <p>{status === 403 ? t('reports.error.forbidden') : (report.error as Error).message}</p>
            </div>
          ) : !data || data.totals.conversations === 0 ? (
            <div className="reports-empty">
              <BarChart3 size={28} />
              <p>{t('reports.empty.none')}</p>
            </div>
          ) : (
            <>
              <section className="reports-cards" aria-label={t('reports.title')}>
                <div className="report-card">
                  <span>{t('reports.cards.conversations')}</span>
                  <strong>{data.totals.conversations}</strong>
                  <small>{t('reports.cards.awaiting', { value: data.totals.awaitingFirstResponse })}</small>
                </div>
                <div className="report-card">
                  <span>{t('reports.cards.avgResponse')}</span>
                  <strong>{minutes(data.totals.avgFirstResponseMinutes)}</strong>
                </div>
                <div className="report-card">
                  <span>{t('reports.cards.compliance')}</span>
                  <strong>{percent(data.totals.slaComplianceRate)}</strong>
                  <small>{t('reports.cards.eligible', { value: data.totals.slaEligible })}</small>
                </div>
                <div className={`report-card ${data.totals.slaBreached > 0 ? 'is-alert' : ''}`}>
                  <span>{t('reports.cards.breached')}</span>
                  <strong>{data.totals.slaBreached}</strong>
                </div>
              </section>

              <div className="reports-charts">
                <section className="report-chart-card">
                  <h2>{t('reports.charts.byDivision')}</h2>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={byDivision} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                      <Tooltip {...tooltipStyles} />
                      <Bar
                        dataKey="conversations"
                        name={t('reports.charts.conversations')}
                        fill="#25d366"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </section>

                <section className="report-chart-card">
                  <h2>{t('reports.charts.daily')}</h2>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={daily} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                      <defs>
                        <linearGradient id="reportConversations" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#25d366" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#25d366" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                      <Tooltip {...tooltipStyles} />
                      <Area
                        type="monotone"
                        dataKey="conversations"
                        name={t('reports.charts.conversations')}
                        stroke="#25d366"
                        fill="url(#reportConversations)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </section>
              </div>

              <section className="reports-agents" aria-label={t('reports.agents.title')}>
                <h2>{t('reports.agents.title')}</h2>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t('reports.agents.name')}</th>
                      <th scope="col">{t('reports.agents.conversations')}</th>
                      <th scope="col">{t('reports.agents.resolved')}</th>
                      <th scope="col">{t('reports.agents.avgResponse')}</th>
                      <th scope="col">{t('reports.agents.breached')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byAgent.map(row => (
                      <tr key={row.assigneeKeyId ?? 'unassigned'}>
                        <td>{row.assigneeName ?? t('reports.agents.unassigned')}</td>
                        <td>{row.conversations}</td>
                        <td>{row.resolved}</td>
                        <td>{minutes(row.avgFirstResponseMinutes)}</td>
                        <td>{row.slaBreached}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
