import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for a knowledge-base search.
 *
 * Exists because the route used to declare its body inline as
 * `{ query: string }`. An inline type is erased at compile time and carries no
 * `class-validator` metadata, so the global `ValidationPipe` had nothing to
 * validate against and passed the body through untouched — `query` could arrive
 * as a number, an object, or a megabyte of text, and the first thing to notice
 * would be whatever the knowledge search did with it. Every other body on this
 * controller had a DTO; this was the one that did not.
 */
export class SearchKnowledgeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  public query!: string;
}
