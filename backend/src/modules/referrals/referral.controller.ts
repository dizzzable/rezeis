/**
 * Referral Controller
 * 
 * Handles HTTP requests for referral system
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { ReferralService, ReferralError } from './referral.service.js';
import {
  CreateReferralBody,
  UpdateReferralBody,
  ReferralIdParams,
  ReferralFiltersQuery,
  CreateRuleBody,
  UpdateRuleBody,
  RuleIdParams,
} from './referral.schemas.js';

export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  /**
   * Get all rules
   */
  async getRules(request: FastifyRequest, reply: FastifyReply) {
    void request;
    const rules = await this.referralService.getRules();
    return reply.send({ data: rules });
  }

  /**
   * Get active rules
   */
  async getActiveRules(request: FastifyRequest, reply: FastifyReply) {
    void request;
    const rules = await this.referralService.getActiveRules();
    return reply.send({ data: rules });
  }

  /**
   * Get rule by ID
   */
  async getRuleById(
    request: FastifyRequest<{ Params: RuleIdParams }>,
    reply: FastifyReply
  ) {
    const rule = await this.referralService.getRuleById(request.params.id);
    if (!rule) {
      return reply.status(404).send({ error: 'Rule not found' });
    }
    return reply.send({ data: rule });
  }

  /**
   * Create rule
   */
  async createRule(
    request: FastifyRequest<{ Body: CreateRuleBody }>,
    reply: FastifyReply
  ) {
    try {
      const rule = await this.referralService.createRule({
        ...request.body,
        description: request.body.description ?? '',
      });
      return reply.status(201).send({ data: rule });
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Update rule
   */
  async updateRule(
    request: FastifyRequest<{ Params: RuleIdParams; Body: UpdateRuleBody }>,
    reply: FastifyReply
  ) {
    try {
      const rule = await this.referralService.updateRule(
        request.params.id,
        request.body
      );
      return reply.send({ data: rule });
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Delete rule
   */
  async deleteRule(
    request: FastifyRequest<{ Params: RuleIdParams }>,
    reply: FastifyReply
  ) {
    try {
      await this.referralService.deleteRule(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Get all referrals
   */
  async getReferrals(
    request: FastifyRequest<{ Querystring: ReferralFiltersQuery }>,
    reply: FastifyReply
  ) {
    const result = await this.referralService.getReferrals(request.query);
    return reply.send({
      data: result.data,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    });
  }

  /**
   * Get referral by ID
   */
  async getReferralById(
    request: FastifyRequest<{ Params: ReferralIdParams }>,
    reply: FastifyReply
  ) {
    const referral = await this.referralService.getReferralById(request.params.id);
    if (!referral) {
      return reply.status(404).send({ error: 'Referral not found' });
    }
    return reply.send({ data: referral });
  }

  /**
   * Create referral
   */
  async createReferral(
    request: FastifyRequest<{ Body: CreateReferralBody }>,
    reply: FastifyReply
  ) {
    try {
      const referral = await this.referralService.createReferral(request.body);
      return reply.status(201).send({ data: referral });
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Update referral
   */
  async updateReferral(
    request: FastifyRequest<{ Params: ReferralIdParams; Body: UpdateReferralBody }>,
    reply: FastifyReply
  ) {
    try {
      const referral = await this.referralService.updateReferral(
        request.params.id,
        request.body
      );
      return reply.send({ data: referral });
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Complete referral
   */
  async completeReferral(
    request: FastifyRequest<{ Params: ReferralIdParams }>,
    reply: FastifyReply
  ) {
    try {
      const referral = await this.referralService.completeReferral(request.params.id);
      return reply.send({ data: referral });
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Cancel referral
   */
  async cancelReferral(
    request: FastifyRequest<{ Params: ReferralIdParams; Body: { reason?: string } }>,
    reply: FastifyReply
  ) {
    try {
      const referral = await this.referralService.cancelReferral(
        request.params.id,
        request.body.reason || ''
      );
      return reply.send({ data: referral });
    } catch (error) {
      if (error instanceof ReferralError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  }

  /**
   * Get statistics
   */
  async getStatistics(request: FastifyRequest, reply: FastifyReply) {
    void request;
    const stats = await this.referralService.getStatistics();
    return reply.send({ data: stats });
  }

  /**
   * Get top referrers
   */
  async getTopReferrers(request: FastifyRequest, reply: FastifyReply) {
    void request;
    const referrers = await this.referralService.getTopReferrers(10);
    return reply.send({ data: referrers });
  }
}
