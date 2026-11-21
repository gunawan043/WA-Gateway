import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { DIVISION_INBOX_PORT } from './division-inbox.port';
import { DivisionService } from './division.service';

function makeService() {
  const divisions = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    exists: jest.fn().mockResolvedValue(false),
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ id: 'div-1', createdAt: new Date(), updatedAt: new Date(), ...row }),
    ),
    create: jest.fn((row: unknown) => row),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const agents = {
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    save: jest.fn((rows: unknown[]) => Promise.resolve(rows)),
    create: jest.fn((row: unknown) => row),
  };
  const settings = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    create: jest.fn((row: unknown) => row),
  };
  const chatStates = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const sessions = { exists: jest.fn().mockResolvedValue(true) };
  const apiKeys = { find: jest.fn().mockResolvedValue([]) };
  const audit = { logInfo: jest.fn().mockResolvedValue(null) };
  const inboxPort = {
    routeConversation: jest.fn(),
    rearm: jest.fn(),
    clearDivision: jest.fn().mockResolvedValue(undefined),
  };
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === DIVISION_INBOX_PORT) return inboxPort;
      throw new Error(`unexpected token ${String(token)}`);
    }),
  };

  const service = new DivisionService(
    divisions as never,
    agents as never,
    settings as never,
    chatStates as never,
    sessions as never,
    apiKeys as never,
    audit as never,
    moduleRef as never,
  );
  return { service, divisions, agents, settings, chatStates, sessions, apiKeys, audit, inboxPort, moduleRef };
}

describe('DivisionService configuration', () => {
  it('refuses a duplicate name in the same session', async () => {
    const { service, divisions } = makeService();
    divisions.exists.mockResolvedValueOnce(true);

    await expect(service.create('sess-1', { name: 'CS SMP Putra' })).rejects.toBeInstanceOf(ConflictException);
    expect(divisions.save).not.toHaveBeenCalled();
  });

  it('refuses a missing session before writing', async () => {
    const { service, sessions, divisions } = makeService();
    sessions.exists.mockResolvedValueOnce(false);

    await expect(service.create('sess-1', { name: 'CS' })).rejects.toBeInstanceOf(NotFoundException);
    expect(divisions.save).not.toHaveBeenCalled();
  });

  it('refuses the 21st division of a session', async () => {
    const { service, divisions } = makeService();
    divisions.count.mockResolvedValueOnce(20);

    await expect(service.create('sess-1', { name: 'CS' })).rejects.toBeInstanceOf(BadRequestException);
    expect(divisions.save).not.toHaveBeenCalled();
  });

  it('refuses an agent key that is not active', async () => {
    const { service, apiKeys, divisions } = makeService();
    apiKeys.find.mockResolvedValueOnce([{ id: 'key-1', name: 'Agen', isActive: false }]);

    await expect(service.create('sess-1', { name: 'CS', agentKeyIds: ['key-1'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(divisions.save).not.toHaveBeenCalled();
  });

  it('refuses an agent key that does not exist', async () => {
    const { service, apiKeys } = makeService();
    apiKeys.find.mockResolvedValueOnce([]);

    await expect(service.create('sess-1', { name: 'CS', agentKeyIds: ['key-1'] })).rejects.toThrow(/unknown/);
  });

  it('normalises keywords and stores the agents in the order given', async () => {
    const { service, apiKeys, agents } = makeService();
    apiKeys.find.mockResolvedValueOnce([
      { id: 'key-1', name: 'Agen A', isActive: true },
      { id: 'key-2', name: 'Agen B', isActive: true },
    ]);

    const created = await service.create('sess-1', {
      name: '  CS SMP Putra  ',
      keywords: ['SMP-Putra', 'smp putra', 'Putra'],
      agentKeyIds: ['key-2', 'key-1'],
    });

    expect(created.name).toBe('CS SMP Putra');
    expect(created.keywords).toEqual(['smp putra', 'putra']);
    expect(agents.save).toHaveBeenCalledWith([
      expect.objectContaining({ apiKeyId: 'key-2', agentName: 'Agen B' }),
      expect.objectContaining({ apiKeyId: 'key-1', agentName: 'Agen A' }),
    ]);
  });

  it('refuses a keyword made only of digits, which would collide with the menu numbers', async () => {
    const { service } = makeService();

    await expect(service.create('sess-1', { name: 'CS', keywords: ['2'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replaces the whole agent set on update', async () => {
    const { service, divisions, apiKeys, agents } = makeService();
    divisions.findOne.mockResolvedValueOnce({ id: 'div-1', sessionId: 'sess-1', name: 'CS', keywords: [] });
    apiKeys.find.mockResolvedValueOnce([{ id: 'key-9', name: 'Agen Baru', isActive: true }]);

    await service.update('sess-1', 'div-1', { agentKeyIds: ['key-9'] });

    expect(agents.delete).toHaveBeenCalledWith({ divisionId: 'div-1' });
    expect(agents.save).toHaveBeenCalledWith([expect.objectContaining({ apiKeyId: 'key-9' })]);
  });

  it('audits a routing-relevant change and drops the cached context', async () => {
    const { service, divisions, audit } = makeService();
    divisions.find.mockResolvedValueOnce([]);
    divisions.findOne.mockResolvedValueOnce({
      id: 'div-1',
      sessionId: 'sess-1',
      name: 'CS',
      keywords: [],
      sortOrder: 0,
      isActive: true,
    });

    await service.routingContext('sess-1');
    await service.update('sess-1', 'div-1', { isActive: false });
    await service.routingContext('sess-1');

    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.DIVISION_UPDATED,
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
    // Once before the update, once after: the second read is not served by the stale cache.
    expect(divisions.find).toHaveBeenCalledTimes(2);
  });

  it('drops a deleted division from the inbox conversations, keeping the assignee', async () => {
    const { service, divisions, inboxPort, audit } = makeService();
    divisions.findOne.mockResolvedValueOnce({ id: 'div-1', sessionId: 'sess-1', name: 'CS SMP Putra' });

    await service.remove('sess-1', 'div-1');

    expect(inboxPort.clearDivision).toHaveBeenCalledWith('sess-1', 'div-1');
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.DIVISION_DELETED,
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
  });

  it('reports the built-in defaults when the session never saved settings', async () => {
    const { service } = makeService();

    await expect(service.getSettings('sess-1')).resolves.toEqual({
      sessionId: 'sess-1',
      enabled: true,
      menuHeader: null,
      invalidReply: null,
      idleHours: 24,
    });
  });

  it('re-arms a chat with no visible menu, so a stale number cannot resolve', async () => {
    const { service, chatStates } = makeService();

    await service.rearm('sess-1', 'chat-1');

    expect(chatStates.update).toHaveBeenCalledWith(
      { sessionId: 'sess-1', chatId: 'chat-1' },
      expect.objectContaining({ status: 'awaiting', promptedAt: null, menuDivisionIds: null }),
    );
  });
});
