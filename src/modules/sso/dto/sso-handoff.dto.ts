import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';

/**
 * The form body Core's page posts into Connect.
 *
 * The browser sends this as `application/x-www-form-urlencoded`, so every value arrives as a
 * string; `@ToStrictString()` keeps a number or an object from being coerced into one and passing
 * `@IsString()`. The code is opaque to Connect: only Core can say whether it is valid.
 */
export class SsoHandoffDto {
  @ApiProperty({
    description: 'One-time handoff code issued by ALIM Core. Never accepted as proof on its own.',
    example: 'h_9f1c2a443c554c1e9c1f2b7d8e6a5f01',
  })
  @ToStrictString()
  @IsString()
  @MinLength(1)
  @MaxCodePoints(512)
  code!: string;

  @ApiPropertyOptional({
    description: 'Opaque state Core issued with the code. Forwarded unchanged; never interpreted.',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(512)
  state?: string;
}
