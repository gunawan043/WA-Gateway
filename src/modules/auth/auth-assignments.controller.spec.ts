import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthAssignmentsController } from './auth-assignments.controller';
import type { AssignmentsService } from './assignments.service';
import type { AuditService } from '../audit/audit.service';
import type { ApiKey } from './entities/api-key.entity';
import type { RoleAssignment } from './entities/role-assignment.entity';

/**
 * A role grant is a credential change, so every write here must reach the audit trail with the
 * actor and the request context. These tests pin that pairing, plus the two refusals the controller
 * owns: an empty `apiKeyId` on the list and a write with no key behind it.
 */
function makeRow(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: 'as-1',
    apiKeyId: 'key-1',
    userId: null,
    role: 'admin',
    scopeType: 'global',
    scopeId: null,
    source: 'manual',
    validFrom: null,
    validTo: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  } as RoleAssignment;
}

function makeController() {
  const assignments = {
    list: jest.fn().mockResolvedValue([makeRow()]),
    findOne: jest.fn().mockResolvedValue(makeRow({ role: 'viewer' })),
    create: jest.fn().mockResolvedValue(makeRow()),
    update: jest.fn().mockResolvedValue(makeRow({ role: 'operator' })),
    remove: jest.fn().mockResolvedValue(makeRow()),
  };
  const auditService = { logInfo: jest.fn<Promise<void>, [string, Record<string, unknown>]>() };
  const controller = new AuthAssignmentsController(
    assignments as unknown as AssignmentsService,
    auditService as unknown as AuditService,
  );
  const request = { method: 'POST', path: '/api/auth/assignments', clientIp: '203.0.113.9' } as unknown as Request;
  const actor = { id: 'key-9', name: 'Rina' } as ApiKey;
  return { controller, assignments, auditService, request, actor };
}

describe('AuthAssignmentsController.list', () => {
  it('refuses a missing apiKeyId instead of listing every assignment', async () => {
    const { controller, assignments } = makeController();

    await expect(controller.list(undefined)).rejects.toThrow(BadRequestException);
    expect(assignments.list).not.toHaveBeenCalled();
  });

  it('maps the rows to the response shape', async () => {
    const { controller, assignments } = makeController();

    const out = await controller.list('key-1');

    expect(assignments.list).toHaveBeenCalledWith('key-1');
    expect(out).toEqual([
      {
        id: 'as-1',
        apiKeyId: 'key-1',
        userId: null,
        role: 'admin',
        scopeType: 'global',
        scopeId: null,
        source: 'manual',
        validFrom: null,
        validTo: null,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('AuthAssignmentsController.create', () => {
  it('refuses a write with no key behind it', async () => {
    const { controller, assignments, auditService, request } = makeController();

    await expect(controller.create({ apiKeyId: 'key-1', role: 'admin', scopeType: 'global' }, request)).rejects.toThrow(
      BadRequestException,
    );
    expect(assignments.create).not.toHaveBeenCalled();
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('grants and audits the actor, the request context and the grant itself', async () => {
    const { controller, assignments, auditService, request, actor } = makeController();
    const dto = { apiKeyId: 'key-1', role: 'admin', scopeType: 'global' };

    const out = await controller.create(dto, request, actor);

    expect(assignments.create).toHaveBeenCalledWith(dto, actor);
    expect(auditService.logInfo).toHaveBeenCalledTimes(1);
    const [action, context] = auditService.logInfo.mock.calls[0];
    expect(action).toBe('role_assignment_created');
    expect(context).toMatchObject({
      apiKey: actor,
      ipAddress: '203.0.113.9',
      method: 'POST',
      path: '/api/auth/assignments',
    });
    expect(context.metadata as Record<string, unknown>).toMatchObject({
      targetKeyId: 'key-1',
      assignmentId: 'as-1',
      role: 'admin',
    });
    expect(out.id).toBe('as-1');
  });
});

describe('AuthAssignmentsController.update', () => {
  it('refuses a write with no key behind it', async () => {
    const { controller, assignments, request } = makeController();

    await expect(controller.update('as-1', { role: 'operator' }, request)).rejects.toThrow(BadRequestException);
    expect(assignments.update).not.toHaveBeenCalled();
  });

  it('audits both sides of the change', async () => {
    const { controller, assignments, auditService, request, actor } = makeController();

    await controller.update('as-1', { role: 'operator' }, request, actor);

    expect(assignments.findOne).toHaveBeenCalledWith('as-1');
    expect(assignments.update).toHaveBeenCalledWith('as-1', { role: 'operator' }, actor);
    const [action, context] = auditService.logInfo.mock.calls[0];
    expect(action).toBe('role_assignment_updated');
    expect((context.metadata as Record<string, unknown>).before).toMatchObject({ role: 'viewer' });
    expect((context.metadata as Record<string, unknown>).after).toMatchObject({ role: 'operator' });
  });
});

describe('AuthAssignmentsController.remove', () => {
  it('revokes and audits the revoked grant', async () => {
    const { controller, assignments, auditService, request, actor } = makeController();

    await controller.remove('as-1', request, actor);

    expect(assignments.remove).toHaveBeenCalledWith('as-1');
    const [action, context] = auditService.logInfo.mock.calls[0];
    expect(action).toBe('role_assignment_revoked');
    expect(context.apiKey).toBe(actor);
    expect(context.metadata as Record<string, unknown>).toMatchObject({ assignmentId: 'as-1', role: 'admin' });
  });

  it('still revokes when no key is attached to the request', async () => {
    const { controller, assignments } = makeController();

    await controller.remove('as-1', { method: 'DELETE', path: '/api/auth/assignments/as-1' } as Request);

    expect(assignments.remove).toHaveBeenCalledWith('as-1');
  });
});
