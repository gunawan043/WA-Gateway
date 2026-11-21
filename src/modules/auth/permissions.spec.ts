import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  RESERVED_PERMISSIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  permissionsOfRoles,
} from './permissions';

/**
 * The catalogue is the vocabulary every `@RequirePermission` will use, so its shape is gated: a
 * duplicated name, a role missing from the matrix, or a reserved permission leaking into a role
 * would each make the coverage gate lie about what is wired.
 */
describe('permission catalogue', () => {
  it('has no duplicate names and no overlap with the reserved set', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect(new Set([...PERMISSIONS, ...RESERVED_PERMISSIONS]).size).toBe(
      PERMISSIONS.length + RESERVED_PERMISSIONS.length,
    );
    expect(ALL_PERMISSIONS.size).toBe(PERMISSIONS.length + RESERVED_PERMISSIONS.length);
  });

  it('names every permission as resource.action', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+\.[a-z.]+$/);
    }
  });

  it('gives every one of the eight roles a permission set', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLE_NAMES].sort());
    for (const role of ROLE_NAMES) {
      expect(ROLE_PERMISSIONS[role].size).toBeGreaterThan(0);
    }
  });

  it('grants no role a reserved permission', () => {
    for (const role of ROLE_NAMES) {
      for (const reserved of RESERVED_PERMISSIONS) {
        expect(ROLE_PERMISSIONS[role].has(reserved as never)).toBe(false);
      }
    }
  });

  it('keeps system_admin a superset of every other role', () => {
    for (const role of ROLE_NAMES) {
      const missing = [...ROLE_PERMISSIONS[role]].filter(permission => !ROLE_PERMISSIONS.system_admin.has(permission));
      expect({ role, missing }).toEqual({ role, missing: [] });
    }
  });

  it('matches the matrix in docs/35 §35.3 for the roles the bridge depends on', () => {
    // Spot checks that fail if a row is transcribed into the wrong role.
    expect(ROLE_PERMISSIONS.agent.has('inbox.assign')).toBe(true);
    expect(ROLE_PERMISSIONS.agent.has('team.member.manage')).toBe(false);
    expect(ROLE_PERMISSIONS.team_leader.has('team.member.manage')).toBe(true);
    expect(ROLE_PERMISSIONS.supervisor.has('team.manage')).toBe(false);
    expect(ROLE_PERMISSIONS.connect_admin.has('session.delete')).toBe(false);
    expect(ROLE_PERMISSIONS.system_admin.has('session.delete')).toBe(true);
    expect(ROLE_PERMISSIONS.quality_evaluator.has('message.send')).toBe(false);
    expect(ROLE_PERMISSIONS.campaign_manager.has('campaign.run')).toBe(true);
    expect(ROLE_PERMISSIONS.analyst.has('campaign.run')).toBe(false);
  });

  it('unions permissions across roles without duplicates', () => {
    expect(permissionsOfRoles(['agent', 'quality_evaluator'])).toEqual(
      [...new Set([...ROLE_PERMISSIONS.agent, ...ROLE_PERMISSIONS.quality_evaluator])].sort(),
    );
    expect(permissionsOfRoles([])).toEqual([]);
  });
});
