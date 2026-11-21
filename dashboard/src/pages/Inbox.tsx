import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Loader2, MessageSquare, Search, Send, StickyNote, Trash2, UserPlus } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useAddInboxNoteMutation,
  useAgentsQuery,
  useDeleteInboxNoteMutation,
  useDivisionsQuery,
  useInboxConversationQuery,
  useInboxQuery,
  useInboxThreadQuery,
  useSendInboxReplyMutation,
  useSessionsQuery,
  useUpdateInboxMutation,
} from '../hooks/queries';
import type { InboxAssigneeFilter, InboxConversation, InboxStatus } from '../services/api';
import './Inbox.css';

type StatusTab = InboxStatus | 'all';

const STATUS_TABS: StatusTab[] = ['open', 'pending', 'resolved', 'all'];

function formatTime(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/**
 * The first-response badge: red once the window is overdue (or the sweeper flagged it), amber with
 * the minutes left while it is still running, and nothing at all when no target applies.
 */
function SlaBadge({ conversation }: { conversation: InboxConversation }) {
  const { t } = useTranslation();
  if (!conversation.slaDueAt) return null;
  const remaining = Math.ceil((new Date(conversation.slaDueAt).getTime() - Date.now()) / 60_000);
  const breached = conversation.slaBreachedAt !== null || remaining <= 0;
  return (
    <span className={`inbox-sla ${breached ? 'is-breached' : 'is-due'}`}>
      {breached ? t('inbox.sla.breached') : t('inbox.sla.remaining', { value: remaining })}
    </span>
  );
}

/**
 * Team inbox: the session's chats on the left, one conversation's assignment, status and internal
 * notes on the right. The chat list itself comes from the engine; only the inbox fields are stored,
 * so a chat that was never touched simply shows as open and unassigned.
 */
export function Inbox() {
  const { t } = useTranslation();
  const toast = useToast();
  const { keyId, keyName, canWrite } = useRole();
  useDocumentTitle(t('inbox.title'));

  const { data: sessions = [], isLoading: sessionsLoading } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<StatusTab>('open');
  const [assignee, setAssignee] = useState<InboxAssigneeFilter>('all');
  const [division, setDivision] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedChatId, setSelectedChatId] = useState('');

  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(session => session.status === 'ready') ?? sessions[0];
    setSessionId(ready.id);
  }, [sessionId, sessions]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = useMemo(
    () => ({
      status: status === 'all' ? undefined : status,
      assignee,
      division: division === 'all' ? undefined : division,
      q: debouncedSearch || undefined,
    }),
    [status, assignee, division, debouncedSearch],
  );

  const conversations = useInboxQuery(sessionId, params);
  const detail = useInboxConversationQuery(sessionId, selectedChatId);
  const { data: agents = [] } = useAgentsQuery();
  const { data: divisions = [] } = useDivisionsQuery(sessionId);
  const thread = useInboxThreadQuery(sessionId, selectedChatId, canWrite);
  const updateConversation = useUpdateInboxMutation(sessionId);
  const sendReply = useSendInboxReplyMutation(sessionId);
  const addNote = useAddInboxNoteMutation(sessionId);
  const deleteNote = useDeleteInboxNoteMutation(sessionId);

  const [noteDraft, setNoteDraft] = useState('');
  const [replyDraft, setReplyDraft] = useState('');

  // A new session invalidates the selection: the chat belongs to the previous session.
  useEffect(() => {
    setSelectedChatId('');
    setNoteDraft('');
    setReplyDraft('');
  }, [sessionId]);

  const rows = conversations.data ?? [];
  const active = detail.data;

  const applyUpdate = (data: { status?: InboxStatus; assigneeKeyId?: string | null; divisionId?: string | null }) => {
    if (!selectedChatId) return;
    updateConversation.mutate(
      { chatId: selectedChatId, data },
      {
        onSuccess: () => toast.success(t('inbox.updated')),
        onError: error => toast.error(error instanceof Error ? error.message : t('inbox.updateFailed')),
      },
    );
  };

  const submitNote = () => {
    const body = noteDraft.trim();
    if (!body || !selectedChatId) return;
    addNote.mutate(
      { chatId: selectedChatId, body },
      {
        onSuccess: () => {
          setNoteDraft('');
          toast.success(t('inbox.noteAdded'));
        },
        onError: error => toast.error(error instanceof Error ? error.message : t('inbox.updateFailed')),
      },
    );
  };

  const submitReply = () => {
    const text = replyDraft.trim();
    if (!text || !selectedChatId) return;
    sendReply.mutate(
      { chatId: selectedChatId, text },
      {
        onSuccess: () => {
          setReplyDraft('');
          toast.success(t('inbox.detail.replySent'));
        },
        onError: error => toast.error(error instanceof Error ? error.message : t('inbox.detail.replyFailed')),
      },
    );
  };

  const removeNote = (noteId: string) => {
    if (!window.confirm(t('inbox.confirmDeleteNote'))) return;
    deleteNote.mutate(
      { chatId: selectedChatId, noteId },
      {
        onSuccess: () => toast.success(t('inbox.noteDeleted')),
        onError: error => toast.error(error instanceof Error ? error.message : t('inbox.updateFailed')),
      },
    );
  };

  return (
    <div className="inbox-page">
      <PageHeader
        title={t('inbox.title')}
        subtitle={t('inbox.subtitle')}
        actions={
          <select
            className="inbox-session-select"
            value={sessionId}
            onChange={event => setSessionId(event.target.value)}
            aria-label={t('inbox.session')}
            disabled={sessionsLoading}
          >
            {sessions.length === 0 && <option value="">{t('inbox.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {!sessionId && !sessionsLoading ? (
        <div className="inbox-empty-page">
          <MessageSquare size={32} />
          <p>{t('inbox.empty.selectSession')}</p>
        </div>
      ) : (
        <div className="inbox-workspace">
          <section className="inbox-list" aria-label={t('inbox.conversations')}>
            <div className="inbox-list-toolbar">
              <div className="inbox-search">
                <Search size={16} />
                <input
                  type="search"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder={t('inbox.searchPlaceholder')}
                />
              </div>
              <select
                value={assignee}
                onChange={event => setAssignee(event.target.value)}
                aria-label={t('inbox.assignee.label')}
              >
                <option value="all">{t('inbox.assignee.all')}</option>
                <option value="me">{t('inbox.assignee.me')}</option>
                <option value="unassigned">{t('inbox.assignee.unassigned')}</option>
              </select>
              <select
                value={division}
                onChange={event => setDivision(event.target.value)}
                aria-label={t('inbox.division.label')}
              >
                <option value="all">{t('inbox.division.all')}</option>
                <option value="unassigned">{t('inbox.division.unassigned')}</option>
                {divisions.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="inbox-tabs" role="tablist">
              {STATUS_TABS.map(tab => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={status === tab}
                  className={status === tab ? 'is-active' : ''}
                  onClick={() => setStatus(tab)}
                >
                  {t(`inbox.status.${tab}`)}
                </button>
              ))}
            </div>

            {conversations.isLoading ? (
              <div className="inbox-list-state">
                <Loader2 className="animate-spin" size={22} />
              </div>
            ) : conversations.isError ? (
              <div className="inbox-list-state inbox-error">
                <AlertCircle size={20} />
                <span>{t('inbox.error.load')}</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="inbox-list-state">
                <p>{t('inbox.empty.title')}</p>
                <span>{t('inbox.empty.body')}</span>
              </div>
            ) : (
              <ul className="inbox-conversation-list">
                {rows.map(row => (
                  <li key={row.chatId}>
                    <button
                      type="button"
                      className={`inbox-conversation ${row.chatId === selectedChatId ? 'is-active' : ''}`}
                      onClick={() => setSelectedChatId(row.chatId)}
                    >
                      <span className="inbox-avatar" aria-hidden="true">
                        {(row.name || row.chatId).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="inbox-conversation-body">
                        <span className="inbox-conversation-top">
                          <strong>{row.name || row.chatId}</strong>
                          <time>{formatTime(row.timestamp)}</time>
                        </span>
                        <span className="inbox-conversation-preview">{row.lastMessage || t('inbox.noMessages')}</span>
                        <span className="inbox-conversation-meta">
                          <span className={`inbox-status inbox-status-${row.status}`}>
                            {t(`inbox.status.${row.status}`)}
                          </span>
                          {row.assigneeName ? (
                            <span className="inbox-assignee">{row.assigneeName}</span>
                          ) : (
                            <span className="inbox-assignee inbox-unassigned">{t('inbox.unassigned')}</span>
                          )}
                          {row.divisionName && <span className="inbox-division">{row.divisionName}</span>}
                          <SlaBadge conversation={row} />
                          {row.unreadCount > 0 && <span className="inbox-unread">{row.unreadCount}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="inbox-detail" aria-live="polite">
            {!selectedChatId ? (
              <div className="inbox-detail-empty">
                <MessageSquare size={28} />
                <p>{t('inbox.detail.selectPrompt')}</p>
              </div>
            ) : detail.isLoading ? (
              <div className="inbox-detail-empty">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : detail.isError || !active ? (
              <div className="inbox-detail-empty inbox-error">
                <AlertCircle size={22} />
                <p>{t('inbox.error.load')}</p>
              </div>
            ) : (
              <>
                <header className="inbox-detail-header">
                  <div>
                    <h2>{active.name || active.chatId}</h2>
                    <code>{active.chatId}</code>
                    <SlaBadge conversation={active} />
                  </div>
                  <div className="inbox-detail-actions">
                    {(['open', 'pending', 'resolved'] as InboxStatus[]).map(next => (
                      <button
                        key={next}
                        type="button"
                        className={active.status === next ? 'is-active' : ''}
                        disabled={updateConversation.isPending || active.status === next}
                        onClick={() => applyUpdate({ status: next })}
                      >
                        <Check size={14} />
                        {t(`inbox.status.${next}`)}
                      </button>
                    ))}
                  </div>
                </header>

                <div className="inbox-assignment">
                  <span className="inbox-field-label">{t('inbox.detail.assignee')}</span>
                  <span className="inbox-current-assignee">{active.assigneeName ?? t('inbox.unassigned')}</span>
                  <select
                    value={active.assigneeKeyId ?? ''}
                    disabled={updateConversation.isPending}
                    onChange={event => applyUpdate({ assigneeKeyId: event.target.value || null })}
                    aria-label={t('inbox.detail.assignee')}
                  >
                    <option value="">{t('inbox.unassigned')}</option>
                    {keyId && <option value={keyId}>{t('inbox.assignToMe', { name: keyName ?? '' })}</option>}
                    {agents
                      .filter(agent => agent.id !== keyId)
                      .map(agent => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="inbox-assignment">
                  <span className="inbox-field-label">{t('inbox.detail.division')}</span>
                  <span className="inbox-current-assignee">
                    {active.divisionName ?? t('inbox.division.unassigned')}
                  </span>
                  <select
                    value={active.divisionId ?? ''}
                    disabled={updateConversation.isPending}
                    onChange={event => applyUpdate({ divisionId: event.target.value || null })}
                    aria-label={t('inbox.detail.division')}
                  >
                    <option value="">{t('inbox.division.unassigned')}</option>
                    {divisions.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>

                <section className="inbox-thread">
                  <h3>
                    <MessageSquare size={16} />
                    {t('inbox.detail.thread')}
                  </h3>

                  {thread.isLoading ? (
                    <div className="inbox-thread-state">
                      <Loader2 className="animate-spin" size={20} />
                    </div>
                  ) : thread.isError ? (
                    <p className="inbox-notes-empty">{t('inbox.error.load')}</p>
                  ) : (thread.data?.messages ?? []).length === 0 ? (
                    <p className="inbox-notes-empty">{t('inbox.detail.noMessages')}</p>
                  ) : (
                    <ul className="inbox-thread-list">
                      {(thread.data?.messages ?? []).map(item => (
                        <li key={item.id} className={item.direction === 'outgoing' ? 'is-out' : 'is-in'}>
                          <p>
                            {item.type === 'text' ? item.body : t('inbox.detail.mediaMessage', { type: item.type })}
                          </p>
                          <time>
                            {new Date(item.timestamp ? item.timestamp * 1000 : item.createdAt).toLocaleString()}
                          </time>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="inbox-reply-composer">
                    <textarea
                      value={replyDraft}
                      onChange={event => setReplyDraft(event.target.value)}
                      placeholder={t('inbox.detail.replyPlaceholder')}
                      maxLength={4000}
                      rows={2}
                      disabled={!canWrite}
                      aria-label={t('inbox.detail.replyPlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={submitReply}
                      disabled={!canWrite || !replyDraft.trim() || sendReply.isPending}
                    >
                      {sendReply.isPending ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
                      {t('inbox.detail.send')}
                    </button>
                  </div>
                </section>

                <section className="inbox-notes">
                  <h3>
                    <StickyNote size={16} />
                    {t('inbox.detail.notes')}
                  </h3>

                  {active.notes.length === 0 ? (
                    <p className="inbox-notes-empty">{t('inbox.detail.noNotes')}</p>
                  ) : (
                    <ul>
                      {active.notes.map(note => (
                        <li key={note.id}>
                          <div className="inbox-note-head">
                            <strong>{note.authorName}</strong>
                            <time>{new Date(note.createdAt).toLocaleString()}</time>
                            <button
                              type="button"
                              className="inbox-note-delete"
                              onClick={() => removeNote(note.id)}
                              aria-label={t('inbox.detail.deleteNote')}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <p>{note.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="inbox-note-composer">
                    <textarea
                      value={noteDraft}
                      onChange={event => setNoteDraft(event.target.value)}
                      placeholder={t('inbox.detail.notePlaceholder')}
                      maxLength={5000}
                      rows={3}
                    />
                    <button type="button" onClick={submitNote} disabled={!noteDraft.trim() || addNote.isPending}>
                      <UserPlus size={15} />
                      {t('inbox.detail.addNote')}
                    </button>
                  </div>
                </section>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
