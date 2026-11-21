import 'reflect-metadata';
import { ApiKeyRole } from './entities/api-key.entity';
import { UserSeedService } from './user-seed.service';
import { UsersService } from './users.service';

/**
 * The seed is the one path that creates an ADMIN without anyone signed in, so its guards matter more
 * than its happy path: half a pair, a short password, or a second boot must all leave the table alone.
 */
describe('UserSeedService', () => {
  const EMAIL = 'admin@example.com';
  const PASSWORD = 'a-long-enough-password';
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };

  let count: jest.Mock;
  let create: jest.Mock;
  let service: UserSeedService;

  beforeEach(() => {
    count = jest.fn().mockResolvedValue(0);
    create = jest.fn().mockResolvedValue({ id: 'user-1' });
    service = new UserSeedService({ count, create } as unknown as UsersService);
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  afterAll(() => {
    if (saved.ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = saved.ADMIN_EMAIL;
    if (saved.ADMIN_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = saved.ADMIN_PASSWORD;
  });

  it('creates the first ADMIN account from the two variables', async () => {
    process.env.ADMIN_EMAIL = `  ${EMAIL} `;
    process.env.ADMIN_PASSWORD = PASSWORD;

    await service.onApplicationBootstrap();

    expect(create).toHaveBeenCalledWith({
      email: EMAIL,
      name: 'Administrator',
      role: ApiKeyRole.ADMIN,
      password: PASSWORD,
    });
  });

  it('does nothing when neither variable is set', async () => {
    await service.onApplicationBootstrap();
    expect(count).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['email only', EMAIL, undefined],
    ['password only', undefined, PASSWORD],
  ])('refuses half a pair (%s)', async (_label, email, password) => {
    if (email) process.env.ADMIN_EMAIL = email;
    if (password) process.env.ADMIN_PASSWORD = password;
    await service.onApplicationBootstrap();
    expect(count).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('never touches an existing table, so a restart cannot reset a changed password', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = PASSWORD;
    count.mockResolvedValue(1);

    await service.onApplicationBootstrap();

    expect(count).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a password under 12 characters', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = 'short-pass1';

    await service.onApplicationBootstrap();

    // It reads the table first (to know whether a seed is needed at all), then refuses the password.
    expect(count).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts exactly 12 characters', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = 'exactly12chr';

    await service.onApplicationBootstrap();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ password: 'exactly12chr' }));
  });

  it('lets a failure from the users service surface instead of pretending the seed ran', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = PASSWORD;
    create.mockRejectedValue(new Error('database is locked'));

    await expect(service.onApplicationBootstrap()).rejects.toThrow('database is locked');
  });
});
