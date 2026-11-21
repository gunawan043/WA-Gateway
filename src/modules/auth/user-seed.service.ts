import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ApiKeyRole } from './entities/api-key.entity';
import { UsersService } from './users.service';
import { createLogger } from '../../common/services/logger.service';

/**
 * Creates the first dashboard account from `ADMIN_EMAIL` + `ADMIN_PASSWORD`.
 *
 * Runs on `onApplicationBootstrap`, not `onModuleInit`: AuthService seeds the bootstrap API key in
 * `onModuleInit`, and doing this first would leave `api_keys` non-empty before that seed runs, which
 * silently skips the master-key banner and the `data/.api-key` file.
 *
 * Only when `users` is empty, and only when both variables are set. An upgraded deployment keeps
 * working with its API key until the operator adds the two variables and restarts once.
 */
@Injectable()
export class UserSeedService implements OnApplicationBootstrap {
  private readonly logger = createLogger('UserSeedService');

  constructor(private readonly usersService: UsersService) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = process.env.ADMIN_EMAIL?.trim();
    const password = process.env.ADMIN_PASSWORD;

    if (!email && !password) return;

    if (!email || !password) {
      this.logger.warn(
        'ADMIN_EMAIL and ADMIN_PASSWORD must be set together; the first dashboard account was not created',
        { action: 'admin_seed_skipped' },
      );
      return;
    }

    if ((await this.usersService.count()) > 0) return;

    if (password.length < 12) {
      this.logger.warn('ADMIN_PASSWORD is shorter than 12 characters; the first dashboard account was not created', {
        action: 'admin_seed_rejected',
      });
      return;
    }

    await this.usersService.create({
      email,
      name: 'Administrator',
      role: ApiKeyRole.ADMIN,
      password,
    });

    this.logger.warn(
      'Created the first dashboard account from ADMIN_EMAIL. Change its password in the dashboard, then remove ' +
        'ADMIN_PASSWORD from the environment: it is only read while the users table is empty.',
      { action: 'admin_seeded' },
    );
  }
}
