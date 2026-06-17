import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Upload body for a support attachment. The binary is relayed as base64 in
 * JSON so it can travel over the signed `AdminTransport` (reiwa↔rezeis)
 * without multipart. The decoded bytes are re-validated server-side
 * (allow-list + magic-byte sniff + size cap) — the declared MIME is advisory.
 *
 * `MaxLength` bounds the base64 string at ~24 MB so a 10 MB cap (≈13.3 MB
 * base64) is accepted while an oversized blob is rejected before decoding.
 */
export class UploadAttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public readonly filename!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  public readonly mimeType?: string;

  /** Optional caption shown alongside the file. */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  public readonly content?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(24_000_000)
  public readonly dataBase64!: string;
}
