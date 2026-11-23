import { AuthAgentsController } from './auth-agents.controller';
import type { AuthService } from './auth.service';

/**
 * The agent picker reads every key and publishes only the id and name of the active ones. That
 * projection is the whole point of the route: it exists so an operator can label a conversation
 * without the ADMIN-only key list, which would also expose scopes and usage.
 */
describe('AuthAgentsController.findAll', () => {
  const build = (keys: Array<{ id: string; name: string; isActive: boolean; scope?: string; usage?: number }>) => {
    const authService = { findAll: jest.fn().mockResolvedValue(keys) };
    return {
      controller: new AuthAgentsController(authService as unknown as AuthService),
      authService,
    };
  };

  it('returns only active keys, and only their id and name', async () => {
    const { controller, authService } = build([
      { id: 'key-1', name: 'Agen A', isActive: true, scope: 'session:s1', usage: 42 },
      { id: 'key-2', name: 'Agen B', isActive: false },
      { id: 'key-3', name: 'Agen C', isActive: true },
    ]);

    const out = await controller.findAll();

    expect(authService.findAll).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { id: 'key-1', name: 'Agen A' },
      { id: 'key-3', name: 'Agen C' },
    ]);
    // Nothing about scope or usage may reach a VIEWER caller.
    expect(out[0]).not.toHaveProperty('scope');
    expect(out[0]).not.toHaveProperty('usage');
    expect(out[0]).not.toHaveProperty('isActive');
  });

  it('returns an empty list rather than undefined when no key is active', async () => {
    const { controller } = build([{ id: 'key-2', name: 'Agen B', isActive: false }]);

    await expect(controller.findAll()).resolves.toEqual([]);
  });
});
