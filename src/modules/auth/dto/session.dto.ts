import { ApiProperty } from '@nestjs/swagger';
import { ApiKeyRole } from '../entities/api-key.entity';
import { UserResponseDto } from './user.dto';

export class LoginResponseDto {
  @ApiProperty({
    description:
      'Opaque session token. Send it as `Authorization: Bearer <token>`. It is shown once and never stored in plaintext.',
  })
  token!: string;

  @ApiProperty({ description: 'When the token stops working', type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ description: 'The signed-in account', type: UserResponseDto })
  user!: UserResponseDto;

  @ApiProperty({ description: 'Role resolved for this session', enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiProperty({ description: 'Whether the linked key is scoped to selected sessions' })
  scoped!: boolean;

  @ApiProperty({ description: 'Engine the gateway is running', example: 'baileys' })
  engineType!: string;
}

export class MeResponseDto {
  @ApiProperty({ description: 'The signed-in account', type: UserResponseDto, nullable: true })
  user?: UserResponseDto | null;

  @ApiProperty({ description: 'Role resolved for this credential', enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiProperty({ description: 'Whether the credential is scoped to selected sessions' })
  scoped!: boolean;

  @ApiProperty({ description: 'Engine the gateway is running', example: 'baileys' })
  engineType!: string;

  @ApiProperty({ description: 'The API key id behind this credential' })
  keyId!: string;

  @ApiProperty({ description: 'The API key name behind this credential' })
  keyName!: string;
}
