import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';

/**
 * The submitted slice of the ALIM Core configuration, keyed by environment variable name.
 *
 * Deliberately an open map with `@Allow()`: the field list lives in `alim-core-fields.ts` and is the
 * single authority on which keys exist, so a key added there is accepted here without a second DTO
 * edit. An unknown key is ignored by the service rather than stored, which keeps this endpoint from
 * becoming a way to write arbitrary environment variables.
 */
export class UpdateAlimCoreSettingsDto {
  @ApiProperty({
    description: 'Environment variable name to value. Absent keys are left untouched.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { ALIM_CORE_BASE_URL: 'https://alim.example.id' },
  })
  @Allow()
  values!: Record<string, string>;
}
