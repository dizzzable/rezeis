import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';

import { SearchKnowledgeDto } from '../dto/search-knowledge.dto';
import { SendMessageDto } from '../dto/send-message.dto';
import {
  AiChatService,
  type ConversationRecord,
  type MessageRecord,
} from '../services/ai-chat.service';

/**
 * AI Chat controller — exposes REST endpoints for conversational AI
 * support. All routes are prefixed with `ai-chat`.
 *
 * Permission model
 *   `settings:edit`, declared on the class so every route inherits it. That is
 *   the gate `AdminAiConfigController` and `AdminAiInstructionController`
 *   already carry: configuring the assistant and driving it are one feature and
 *   share one permission rather than drifting apart.
 *
 *   Admin JWT alone was not enough here for two reasons that outlive the
 *   current lack of a frontend caller:
 *     - `POST message` spends the operator's money — it calls the configured
 *       OpenAI-compatible endpoint with the stored API key, in a tool-calling
 *       loop that can issue several completions per request.
 *     - the transcript routes read and write stored conversations, and every
 *       admin holding `settings:edit` reaches all of them.
 *
 * Whose conversation is it
 *   The signed-in admin's. Every route below takes its subject from
 *   `@CurrentAdmin()` and none from the request.
 *
 *   Four routes used to name the subject themselves — `userId` in the body of
 *   `POST message` and `POST conversations`, in the path of
 *   `GET conversations/:userId`, and nothing at all on
 *   `GET conversations/:conversationId/messages`, which returned any
 *   transcript to anyone who named it. Ids were minted as
 *   `conv_${Date.now()}_${counter}`, so naming one took no knowledge. The
 *   assistant's persona reads as customer support, which is presumably why the
 *   parameter existed; but the only surface that ever reached it is this
 *   admin-gated controller, so the only identity a request here proves is the
 *   one in the JWT. Anything else was the caller asserting who they were.
 *
 * The `getTariffs` and `getFaq` tool calls are exercised through
 * the AiChatService function-calling loop and do not need direct
 * controller-level wiring.
 */
@ApiTags('ai-chat')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'edit')
@Controller('ai-chat')
export class AiChatController {
  public constructor(private readonly aiChatService: AiChatService) {}

  /**
   * Sends a message to the AI assistant and returns its reply.
   * Optionally supply a `conversationId` to continue an existing chat — one
   * this admin owns; any other answers 404.
   */
  @Post('message')
  @ApiOperation({ summary: 'Send a message to the AI chat assistant' })
  public async sendMessage(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Body() body: SendMessageDto,
  ): Promise<{ reply: string; conversationId: string }> {
    return this.aiChatService.generateResponse(
      admin.id,
      body.message,
      body.conversationId,
    );
  }

  /**
   * Creates a new conversation owned by the signed-in admin.
   *
   * Takes no body. It used to take `{ userId }`, which is what let a caller
   * file a conversation under somebody else's name.
   */
  @Post('conversations')
  @ApiOperation({ summary: 'Create a new AI chat conversation' })
  public createConversation(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): { id: string } {
    return { id: this.aiChatService.createConversation(admin.id).id };
  }

  /**
   * Lists the signed-in admin's own conversations.
   *
   * Was `GET conversations/:userId`. The segment is gone rather than
   * validated: with the owner read from the JWT there is nothing for a caller
   * to say, and a path parameter that must equal the token reads like a choice
   * long after it has stopped being one.
   */
  @Get('conversations')
  @ApiOperation({ summary: "List the signed-in admin's AI chat conversations" })
  public listConversations(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): ConversationRecord[] {
    return this.aiChatService.listConversations(admin.id);
  }

  /**
   * Gets the full message history for a conversation the signed-in admin owns.
   * Unknown, evicted and someone else's are one answer: 404.
   */
  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Get message history for a conversation' })
  public getConversationMessages(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Param('conversationId') conversationId: string,
  ): MessageRecord[] {
    return this.aiChatService.getHistory(admin.id, conversationId);
  }

  /**
   * Searches the knowledge base.
   *
   * The body is a DTO rather than an inline shape for a reason worth stating:
   * an inline type is erased at compile time, so the global `ValidationPipe`
   * had no metadata to check and let the body through as it arrived.
   */
  @Post('search')
  @ApiOperation({ summary: 'Search the knowledge base' })
  public async searchKnowledge(
    @Body() body: SearchKnowledgeDto,
  ): Promise<{ result: string }> {
    const result = await this.aiChatService.searchKnowledge(body.query);
    return { result };
  }
}
