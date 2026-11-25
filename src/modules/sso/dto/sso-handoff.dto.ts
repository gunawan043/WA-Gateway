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
 *
 * `code` is optional to the validator on purpose. A missing code is a normal, expected event — the
 * frame reloads, the form is submitted empty, someone opens the URL by hand — and the global
 * validation pipe turns a failed `@IsString()` into a bare "Bad Request" that names nothing. Letting
 * the value reach the handler means the person gets the `code_required` page explaining that the
 * flow starts from ALIM Core. The handler refuses an absent code before doing anything else, so this
 * cannot be used to reach Core with an empty exchange.
 */
export class SsoHandoffDto {
  @ApiPropertyOptional({
    description: 'One-time handoff code issued by ALIM Core. Never accepted as proof on its own.',
    example: 'h_9f1c2a443c554c1e9c1f2b7d8e6a5f01',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MinLength(1)
  @MaxCodePoints(512)
  code?: string;

  @ApiPropertyOptional({
    description: 'Opaque state Core issued with the code. Forwarded unchanged; never interpreted.',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(512)
  state?: string;
}
