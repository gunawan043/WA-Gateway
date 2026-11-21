import { Controller, Get } from '@nestjs/common';
import { ApiProperty, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiKeyRole } from './entities/api-key.entity';
import { RequireRole } from './decorators/auth.decorators';
import { AuthService } from './auth.service';

/** The directory entry the inbox needs: enough to label and assign, nothing about scope or secrets. */
export class AgentDirectoryEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Agen A' })
  name!: string;
}

/**
 * The agent picker behind the team inbox. Agents ARE API keys, but `GET /auth/api-keys` is
 * ADMIN-only and returns scope and usage, which an operator has no business reading. This route
 * exposes only the active keys' id and display name, to every authenticated role.
 *
 * Deliberately reachable by a session-scoped key: an agent confined to one session must still be
 * able to assign a conversation inside it, and this route reads no session data at all. That is why
 * it carries no @RequireUnscopedKey; the global-route fence spec records the decision.
 */
@ApiTags('auth')
@Controller('auth/agents')
export class AuthAgentsController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List active agents (API key id and display name) for assignment pickers' })
  @ApiResponse({ status: 200, description: 'Active keys, id and name only.', type: [AgentDirectoryEntryDto] })
  async findAll(): Promise<AgentDirectoryEntryDto[]> {
    const keys = await this.authService.findAll();
    return keys.filter(key => key.isActive).map(key => ({ id: key.id, name: key.name }));
  }
}
