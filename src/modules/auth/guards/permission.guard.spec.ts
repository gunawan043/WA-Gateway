import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { PERMISSIONS_KEY } from '../decorators/auth.decorators';
import type { ApiKey } from '../entities/api-key.entity';
import type { PermissionService, ResourceRef } from '../permission.service';

/**
 * The guard is the only place `@RequirePermission` becomes a decision. It must be inert on a route
 * without the metadata (every `@RequireRole` route keeps working), pass the route's resource to the
 * resolver, and refuse with the permission name rather than the role.
 */
describe('PermissionGuard', () => {
  const assert = jest.fn();
  const permissions = { assert } as unknown as PermissionService;
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  const guard = new PermissionGuard(reflector, permissions);

  const apiKey = { id: 'k1' } as ApiKey;

  const context = (params: Record<string, string> = {}): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ apiKey, params }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    assert.mockReset().mockResolvedValue(undefined);
    (reflector.getAllAndOverride as jest.Mock).mockReset();
  });

  it('does nothing on a handler without permission metadata', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key: string) =>
      key === PERMISSIONS_KEY ? undefined : false,
    );
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(assert).not.toHaveBeenCalled();
  });

  it('does nothing on a public handler even if it carried metadata', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key: string) =>
      key === PERMISSIONS_KEY ? ['role.assign'] : true,
    );
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(assert).not.toHaveBeenCalled();
  });

  it('passes the route’s session, division and chat to the resolver', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key: string) =>
      key === PERMISSIONS_KEY ? ['inbox.assign'] : false,
    );
    await guard.canActivate(context({ sessionId: 's1', divisionId: 'd1' }));

    expect(assert).toHaveBeenCalledWith(apiKey, ['inbox.assign'], {
      sessionId: 's1',
      divisionId: 'd1',
      chatId: undefined,
    } satisfies ResourceRef);
  });

  it('sends no resource when the route names none', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key: string) =>
      key === PERMISSIONS_KEY ? ['role.read'] : false,
    );
    await guard.canActivate(context());
    expect(assert).toHaveBeenCalledWith(apiKey, ['role.read'], undefined);
  });

  it('propagates the resolver’s refusal', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key: string) =>
      key === PERMISSIONS_KEY ? ['role.assign'] : false,
    );
    assert.mockRejectedValueOnce(new ForbiddenException('Missing permission: role.assign'));
    await expect(guard.canActivate(context())).rejects.toThrow('Missing permission: role.assign');
  });

  it('refuses when no key was attached', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key: string) =>
      key === PERMISSIONS_KEY ? ['role.read'] : false,
    );
    const anonymous = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ params: {} }) }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(anonymous)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
