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

import { SendMessageDto } from '../dto/send-message.dto';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { AiChatService } from '../services/ai-chat.service';

/**
 * AI Chat controller — exposes REST endpoints for conversational AI
 * support. All routes are prefixed with `ai-chat`.
 *
 * NOTE: Authentication is intentionally omitted for now. In production
 * this controller should be gated by `AdminJwtAuthGuard` or a dedicated
 * user token guard.
 *
 * The `getTariffs` and `getFaq` tool calls are exercised through
 * the AiChatService function-calling loop and do not need direct
 * controller-level wiring.
 */
@ApiTags('ai-chat')
@UseGuards(AdminJwtAuthGuard)
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
