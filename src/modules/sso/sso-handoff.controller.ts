import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { Public } from '../auth/decorators/auth.decorators';
import { resolveClientIp } from '../../common/utils/ip';
import { isAllowedHandoffOrigin, withFrameAncestors } from '../../config/core-web-origin';
import { SsoHandoffDto } from './dto/sso-handoff.dto';
import { HandoffFailure, SsoHandoffService } from './sso-handoff.service';
import { renderHandoffErrorPage, renderHandoffLoadingPage, renderHandoffSuccessPage } from './sso-pages';

/** A refusal that happens before Core is called (no Origin, or SSO not configured). */
type PageFailure = HandoffFailure | 'origin_required' | 'origin_not_allowed';

interface FailureCopy {
  status: number;
  title: string;
  message: string;
  hint?: string;
}

/**
 * The browser-facing half of the WhatsApp Connect SSO handoff.
 *
 * Core embeds Connect in an iframe and auto-submits a form whose `action` is `/sso/handoff` and
 * whose target is that iframe. This endpoint receives the one-time code, exchanges it with Core
 * server-to-server, maps `core_user_id` to an existing Connect account, and only then mints a
 * Connect session. The browser never sees the SSO key, and the code is never placed in a URL.
 *
 * CSRF: this application authenticates with a header (`X-API-Key`) and stores no ambient cookie, so
 * there is no CSRF middleware to exempt and no cookie a cross-site form could ride. The risks a
 * CSRF token would normally address are covered by the controls below — an exact Origin allowlist,
 * a tight per-IP rate limit, strict body validation, and Core's one-time code, which an attacker
 * cannot mint and which cannot be redeemed twice. No global CSRF exemption exists because there is
 * no global CSRF check.
 */
@ApiTags('sso')
@Controller('sso')
export class SsoHandoffController {
  constructor(
    private readonly handoff: SsoHandoffService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The page the Core embed can load while the form POST is in flight. A browser keeps this
   * document on screen until the POST response arrives, so the person sees a Connect-owned loading
   * state instead of a blank frame. It creates nothing and accepts no code.
   *
   * Someone who opens this URL directly — or presses Enter on it, or reloads the frame — reaches the
   * same page and gets an honest answer: the flow only starts from Core. It deliberately does not
   * borrow the POST's `code_required` refusal, because that refusal is a 4xx for a broken exchange,
   * whereas this is a page render for a person with nothing wrong to point at.
   */
  @Get('handoff')
  @Public()
  @ApiExcludeEndpoint()
  loading(@Res() res: Response): void {
    this.prepareDocument(res);
    res
      .status(200)
      .type('html')
      .send(renderHandoffLoadingPage({ nonce: this.nonce(res), coreOrigin: this.coreOrigin() }));
  }

  @Post('handoff')
  @Public()
  @HttpCode(200)
  // Per IP, deliberately tighter than the global tiers: a handoff is a one-shot event, and a loop
  // of guesses is worth far less throughput than a message.
  @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Complete a WhatsApp Connect SSO handoff',
    description:
      'Receives the one-time code ALIM Core issued for the embedded Connect page, exchanges it with ' +
      'Core server-to-server, maps core_user_id to an existing Connect account and starts a Connect ' +
      'session. The code is accepted only in the form body; it is never read from the query string ' +
      'or a URL. A browser receives the success page; a client that asks for application/json ' +
      'receives the outcome without the session token.',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiProduces('text/html', 'application/json')
  @ApiResponse({ status: 200, description: 'Handoff accepted and a Connect session was issued' })
  @ApiResponse({ status: 400, description: 'Missing or malformed code (code_required, invalid_payload)' })
  @ApiResponse({
    status: 403,
    description: 'Origin not allowed, permission revoked, audience/scope mismatch, or identity not mapped',
  })
  @ApiResponse({ status: 409, description: 'The one-time code was already used' })
  @ApiResponse({ status: 410, description: 'The one-time code expired' })
  @ApiResponse({ status: 422, description: 'The code is missing from the request (code_required)' })
  @ApiResponse({ status: 429, description: 'Too many handoff attempts from this address' })
  @ApiResponse({ status: 502, description: 'Connect could not verify the handoff with ALIM Core' })
  @ApiResponse({ status: 503, description: 'SSO is not configured on this deployment' })
  @ApiResponse({ status: 504, description: 'ALIM Core timed out while redeeming the code' })
  async receive(@Body() dto: SsoHandoffDto, @Req() request: Request, @Res() res: Response): Promise<void> {
    const wantsJson = this.wantsJson(request);

    // 1. SSO must be configured at all. A missing origin or key disables the feature; it never
    //    falls back to accepting whatever the browser sent.
    if (!this.coreOrigin() || !this.isConfigured()) {
      this.fail(res, 'not_configured', wantsJson);
      return;
    }

    // 2. The request must come from the configured Core origin. Checked before any exchange so a
    //    foreign page cannot use this endpoint as an oracle for codes it guessed.
    if (!isAllowedHandoffOrigin(request.headers.origin, request.headers.referer, this.coreOrigin())) {
      this.fail(
        res,
        request.headers.origin || request.headers.referer ? 'origin_not_allowed' : 'origin_required',
        wantsJson,
      );
      return;
    }

    // 3. A request with no code is refused here rather than at the validation pipe, which would
    //    answer a bare "Bad Request" that names nothing. `code_required` is the documented status
    //    for it, and nothing reaches Core.
    if (!dto.code || dto.code.trim() === '') {
      this.fail(res, 'code_required', wantsJson);
      return;
    }

    // 4. Exchange, map and issue. The service never writes a session before all three succeed.
    const trustedProxies = this.config.get<string[]>('security.trustedProxies') ?? [];
    const result = await this.handoff.complete({
      code: dto.code,
      state: dto.state,
      ipAddress: resolveClientIp(request, trustedProxies),
      userAgent: request.headers['user-agent'],
    });

    if (!result.ok) {
      this.fail(res, result.reason, wantsJson);
      return;
    }

    // 5. The token is delivered only inside the HTML page, written to sessionStorage, and the
    //    document is replaced. JSON callers get the outcome but never the token.
    if (wantsJson) {
      res.status(200).json({ ok: true, userId: result.userId, expiresAt: result.expiresAt });
      return;
    }

    this.prepareDocument(res);
    res
      .status(200)
      .type('html')
      .send(renderHandoffSuccessPage({ nonce: this.nonce(res), coreOrigin: this.coreOrigin(), token: result.token }));
  }

  private coreOrigin(): string | null {
    return this.config.get<string | null>('connect.sso.coreWebOrigin') ?? null;
  }

  private isConfigured(): boolean {
    const baseUrl = this.config.get<string>('connect.sso.coreBaseUrl') ?? '';
    const apiKey = this.config.get<string>('connect.sso.apiKey') ?? '';
    return baseUrl !== '' && apiKey !== '';
  }

  /** A client that explicitly prefers JSON gets JSON; a browser form navigation gets HTML. */
  private wantsJson(request: Request): boolean {
    const accept = (request.headers.accept ?? '').toLowerCase();
    return accept.includes('application/json') && !accept.includes('text/html');
  }

  private nonce(res: Response): string {
    const locals = res.locals as { cspNonce?: unknown };
    return typeof locals.cspNonce === 'string' && locals.cspNonce !== ''
      ? locals.cspNonce
      : randomBytes(18).toString('base64url');
  }

  /**
   * Headers every handoff document carries: no caching, no referrer, no indexing — and the one
   * place where framing is widened.
   *
   * The global CSP/nosniff/frameguard stack is installed once for the whole application, so the only
   * way to let Core frame the handoff document is to narrow that policy here, on these responses
   * alone, rather than relaxing it for the dashboard and API. `frame-ancestors` is rewritten to name
   * the configured Core origin exactly (never a wildcard, never `*`), and `X-Frame-Options` is
   * dropped because it cannot express a second origin and older Safari would honour it over CSP and
   * refuse the embed. With no Core origin configured nothing is relaxed: the response keeps the
   * application default, so an unconfigured deployment refuses every embedder.
   */
  private prepareDocument(res: Response): void {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    const coreOrigin = this.coreOrigin();
    if (!coreOrigin) return;

    const csp = res.getHeader('Content-Security-Policy');
    if (typeof csp === 'string') {
      res.setHeader('Content-Security-Policy', withFrameAncestors(csp, coreOrigin));
    }
    res.removeHeader('X-Frame-Options');
  }

  private fail(res: Response, reason: PageFailure, wantsJson: boolean): void {
    const copy = FAILURE_COPY[reason];
    if (wantsJson) {
      res.status(copy.status).json({ ok: false, code: reason, message: copy.message });
      return;
    }
    this.prepareDocument(res);
    res
      .status(copy.status)
      .type('html')
      .send(
        renderHandoffErrorPage({
          nonce: this.nonce(res),
          coreOrigin: this.coreOrigin(),
          title: copy.title,
          message: copy.message,
          hint: copy.hint,
        }),
      );
  }
}

/**
 * The person-readable outcome of every refusal. `status` is what a JSON caller and a monitoring
 * probe see; the copy is what the page shows. Neither carries the code, the key or Core's context.
 */
const FAILURE_COPY: Record<PageFailure, FailureCopy> = {
  not_configured: {
    status: 503,
    title: 'SSO belum aktif',
    message: 'Integrasi masuk dari ALIM Core belum dikonfigurasi pada server ini.',
    hint: 'Hubungi administrator ALIM Connect.',
  },
  origin_required: {
    status: 403,
    title: 'Permintaan tidak dikenali',
    message: 'Permintaan masuk harus berasal dari halaman ALIM Core yang terdaftar.',
    hint: 'Buka WhatsApp Connect dari menu di ALIM Core.',
  },
  origin_not_allowed: {
    status: 403,
    title: 'Asal permintaan tidak diizinkan',
    message: 'Halaman ini bukan ALIM Core yang diizinkan untuk membuka WhatsApp Connect.',
    hint: 'Buka WhatsApp Connect dari menu di ALIM Core.',
  },
  invalid_key: {
    status: 502,
    title: 'Verifikasi gagal',
    message: 'ALIM Connect tidak dapat memverifikasi permintaan ke ALIM Core.',
    hint: 'Hubungi administrator ALIM Connect.',
  },
  insufficient_scope: {
    status: 502,
    title: 'Verifikasi gagal',
    message: 'Kredensial integrasi ALIM Connect tidak memiliki cakupan yang diperlukan.',
    hint: 'Hubungi administrator ALIM Connect.',
  },
  contract_mismatch: {
    status: 502,
    title: 'Verifikasi gagal',
    message: 'Jawaban ALIM Core tidak sesuai dengan kontrak yang diharapkan.',
    hint: 'Hubungi administrator ALIM Connect.',
  },
  core_error: {
    status: 502,
    title: 'Verifikasi gagal',
    message: 'ALIM Core menolak permintaan verifikasi.',
    hint: 'Coba lagi dari ALIM Core. Bila berulang, hubungi administrator.',
  },
  audience_mismatch: {
    status: 403,
    title: 'Handoff bukan untuk Connect',
    message: 'Kode ini diterbitkan untuk aplikasi lain, bukan WhatsApp Connect.',
    hint: 'Buka WhatsApp Connect dari menu di ALIM Core.',
  },
  scope_mismatch: {
    status: 403,
    title: 'Cakupan tidak sesuai',
    message: 'Kode ini tidak memiliki cakupan WhatsApp Connect yang diperlukan.',
    hint: 'Buka WhatsApp Connect dari menu di ALIM Core.',
  },
  user_inactive: {
    status: 403,
    title: 'Akun ALIM Core tidak aktif',
    message: 'Akun ALIM Core Anda sedang tidak aktif, sehingga tidak dapat membuka WhatsApp Connect.',
    hint: 'Hubungi administrator ALIM Core.',
  },
  permission_revoked: {
    status: 403,
    title: 'Akses dicabut',
    message: 'Akses Anda ke WhatsApp Connect telah dicabut di ALIM Core.',
    hint: 'Hubungi administrator ALIM Core bila ini tidak disengaja.',
  },
  code_not_found: {
    status: 400,
    title: 'Handoff tidak valid',
    message: 'Kode handoff tidak dikenali oleh ALIM Core.',
    hint: 'Mulai lagi dari halaman WhatsApp Connect di ALIM Core.',
  },
  code_already_used: {
    status: 409,
    title: 'Handoff sudah dipakai',
    message: 'Kode handoff ini sudah pernah digunakan dan tidak dapat dipakai lagi.',
    hint: 'Muat ulang halaman WhatsApp Connect di ALIM Core untuk mendapatkan kode baru.',
  },
  code_expired: {
    status: 410,
    title: 'Handoff kedaluwarsa',
    message: 'Kode handoff sudah kedaluwarsa.',
    hint: 'Muat ulang halaman WhatsApp Connect di ALIM Core untuk mendapatkan kode baru.',
  },
  code_required: {
    status: 422,
    title: 'Kode handoff tidak dikirim',
    message: 'Permintaan tidak menyertakan kode handoff.',
    hint: 'Buka WhatsApp Connect dari menu di ALIM Core.',
  },
  invalid_payload: {
    status: 400,
    title: 'Handoff tidak valid',
    message: 'Permintaan handoff tidak lengkap atau tidak sesuai.',
    hint: 'Buka WhatsApp Connect dari menu di ALIM Core.',
  },
  core_unreachable: {
    status: 502,
    title: 'ALIM Core tidak dapat dihubungi',
    message: 'ALIM Connect tidak dapat menghubungi ALIM Core untuk memverifikasi handoff.',
    hint: 'Coba lagi beberapa saat lagi.',
  },
  core_timeout: {
    status: 504,
    title: 'ALIM Core tidak merespons',
    message: 'ALIM Core tidak merespons tepat waktu saat memverifikasi handoff.',
    hint: 'Coba lagi beberapa saat lagi.',
  },
  identity_not_mapped: {
    status: 403,
    title: 'Identitas belum dipetakan',
    message: 'Akun ALIM Core Anda belum dipetakan ke akun ALIM Connect.',
    hint: 'Hubungi administrator ALIM Connect untuk memetakan akun Anda. Akun tidak dibuat otomatis.',
  },
  account_disabled: {
    status: 403,
    title: 'Akun Connect dinonaktifkan',
    message: 'Akun ALIM Connect untuk pengguna ini sedang dinonaktifkan.',
    hint: 'Hubungi administrator ALIM Connect.',
  },
  session_issue_failed: {
    status: 500,
    title: 'Sesi gagal dibuat',
    message: 'ALIM Connect tidak dapat membuat sesi untuk Anda.',
    hint: 'Coba lagi dari ALIM Core.',
  },
};
