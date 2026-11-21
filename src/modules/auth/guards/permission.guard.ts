import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiKey } from '../entities/api-key.entity';
import { PERMISSIONS_KEY, PUBLIC_KEY } from '../decorators/auth.decorators';
import { PermissionService, type ResourceRef } from '../permission.service';
import type { Permission } from '../permissions';

/**
 * Enforces `@RequirePermission`. Registered as an `APP_GUARD` after ApiKeyGuard, because it reads
 * `request.apiKey` — the key ApiKeyGuard already resolved, fenced and attached (docs/35 §35.5.5).
 *
 * A handler with no permission metadata is untouched, so every route that still carries
 * `@RequireRole` keeps exactly its old behaviour. A route that does carry metadata is judged by the
 * assignment's permissions, and a 403 names the permission, not the role, so the response does not
 * leak the role structure.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();
    const apiKey = request.apiKey;
    if (!apiKey) {
      throw new ForbiddenException('API key is required');
    }

    const resource = resourceFrom(request);
    await this.permissions.assert(apiKey, required, resource);
    return true;
  }
}

/**
 * The object a route names, when it names one. A handler that names none is judged on the kind of
 * action alone; the service that lists rows must still filter them through `scope()`.
 */
function resourceFrom(request: Request): ResourceRef | undefined {
  const params = request.params ?? {};
  const value = (name: string): string | undefined => {
    const raw = params[name];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  };
  const resource: ResourceRef = {
    sessionId: value('sessionId'),
    divisionId: value('divisionId'),
    chatId: value('chatId') ?? value('groupId') ?? value('contactId'),
  };
  const named = Object.values(resource).some(entry => entry !== undefined);
  return named ? resource : undefined;
}
