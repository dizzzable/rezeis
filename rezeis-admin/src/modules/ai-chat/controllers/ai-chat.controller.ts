import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';

import { SendMessageDto } from '../dto/send-message.dto';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { AiChatService } from '../services/ai-chat.service';

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
 *     - `GET conversations/:conversationId/messages` reads a transcript by id
 *       with no ownership check, and ids are minted as
 *       `conv_${Date.now()}_${counter}`, which is guessable by construction.
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
   * Optionally supply a `conversationId` to continue an existing chat.
   */
  @Post('message')
  @ApiOperation({ summary: 'Send a message to the AI chat assistant' })
  public async sendMessage(
    @Body() body: SendMessageDto,
  ): Promise<{ reply: string; conversationId: string }> {
    return this.aiChatService.generateResponse(
      body.userId,
      body.message,
      body.conversationId,
    );
  }

  /**
   * Creates a new conversation for a given user.
   */
  @Post('conversations')
  @ApiOperation({ summary: 'Create a new AI chat conversation' })
  public createConversation(
    @Body() body: CreateConversationDto,
  ): { id: string; userId: string } {
    const conversation = this.aiChatService.createConversation(body.userId);
    return { id: conversation.id, userId: conversation.userId };
  }

  /**
   * Lists all conversations for a user.
   */
  @Get('conversations/:userId')
  @ApiOperation({ summary: 'List all conversations for a user' })
  public listConversations(
    @Param('userId') userId: string,
  ) {
    return this.aiChatService.listConversations(userId);
  }

  /**
   * Gets the full message history for a conversation.
   */
  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Get message history for a conversation' })
  public getConversationMessages(
    @Param('conversationId') conversationId: string,
  ) {
    return this.aiChatService.getHistory(conversationId);
  }

  /**
   * Searches the knowledge base.
   */
  @Post('search')
  @ApiOperation({ summary: 'Search the knowledge base' })
  public async searchKnowledge(
    @Body() body: { query: string },
  ): Promise<{ result: string }> {
    const result = await this.aiChatService.searchKnowledge(body.query);
    return { result };
  }
}
