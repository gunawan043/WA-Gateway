import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { requestContextMiddleware } from './../src/common/middleware/request-context.middleware';

// The first admin is seeded from the environment on the boot that finds no accounts. Set here, at
// module scope, so the seed service reads them when the module is built.
const ADMIN_EMAIL = 'e2e-admin@example.com';
const ADMIN_PASSWORD = 'e2e-admin-password-1234';
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

// supertest types `res.body` as `any`; name the shapes this suite reads so the assertions stay typed.
interface Account {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  apiKeyId: string;
  passwordHash?: string;
}

interface LoginBody {
  token: string;
  expiresAt: string;
  role: string;
  scoped: boolean;
  user: Account;
}

interface MeBody {
  user: Account;
  role: string;
  scoped: boolean;
  keyId: string;
  keyName: string;
}

/**
 * The dashboard sign-in lifecycle against the real application: the seeded account signs in, the
 * session token answers /auth/me and is accepted wherever an API key is, a non-admin account is
 * refused the admin-only routes, and logout makes the token unusable at once.
 */
describe('Dashboard sign-in (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let viewerToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    // Installed by configureApp in production; audit rows take their key from this context.
    app.use(requestContextMiddleware);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('signs the seeded admin in and returns an opaque session token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    const body = res.body as LoginBody;
    token = body.token;
    expect(token).toMatch(/^owa_s1_[0-9a-f]{64}$/);
    expect(body.user).toMatchObject({ email: ADMIN_EMAIL, role: 'admin', isActive: true });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.role).toBe('admin');
    expect(body.scoped).toBe(false);
    expect(typeof body.expiresAt).toBe('string');
  });

  it('answers /auth/me for the token with the account and its linked key', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = res.body as MeBody;
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.role).toBe('admin');
    // One identity, two credentials: the session resolves to the account's own key.
    expect(body.keyId).toBe(body.user.apiKeyId);
    expect(body.keyName).toBe(body.user.name);
  });

  it('creates a viewer account from the session, then refuses it the account list', async () => {
    // Since Fase 1a the account's access comes from `assignments`, not from `role`: a global
    // `analyst` grant is the backfill-equivalent of the old `viewer` role.
    const created = await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('X-API-Key', token)
      .send({
        email: 'e2e-viewer@example.com',
        name: 'E2E Viewer',
        password: 'e2e-viewer-password-1234',
        assignments: [{ role: 'analyst', scopeType: 'global' }],
      })
      .expect(201);

    expect((created.body as Account).role).toBe('viewer');

    // The grants are readable through the listing, which is how the dashboard shows them.
    const list = await request(app.getHttpServer()).get('/api/auth/users').set('X-API-Key', token).expect(200);
    const viewer = (list.body as Array<Account & { roles?: string[]; assignments?: Array<{ role: string }> }>).find(
      user => user.email === 'e2e-viewer@example.com',
    );
    expect(viewer?.role).toBe('viewer');
    expect(viewer?.roles).toEqual(['analyst']);
    expect(viewer?.assignments).toEqual([expect.objectContaining({ role: 'analyst', scopeType: 'global' })]);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'e2e-viewer@example.com', password: 'e2e-viewer-password-1234' })
      .expect(200);
    viewerToken = (login.body as LoginBody).token;

    await request(app.getHttpServer()).get('/api/auth/users').set('Authorization', `Bearer ${viewerToken}`).expect(403);
  });

  it('answers the same refusal for a wrong password and an unknown address', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'not-the-password' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: ADMIN_PASSWORD })
      .expect(401);

    expect((wrong.body as { message: string }).message).toBe((unknown.body as { message: string }).message);
  });

  it('ends the session at logout, so the token is refused at once', async () => {
    await request(app.getHttpServer()).post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);

    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
  });
});
