import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveNotificationCategory,
  resolveTerminalRouteFor,
} from '../src/modules/bot-map/services/notification-target-resolver';

describe('notification-target-resolver', () => {
  describe('resolveTerminalRouteFor', () => {
    it('routes expiry-related types to /renew', () => {
      assert.equal(resolveTerminalRouteFor('expires_in_3_days'), '/renew');
      assert.equal(resolveTerminalRouteFor('expires_in_1_days'), '/renew');
      assert.equal(resolveTerminalRouteFor('expired'), '/renew');
      assert.equal(resolveTerminalRouteFor('limited'), '/renew');
      assert.equal(resolveTerminalRouteFor('expired_1_day_ago'), '/renew');
    });

    it('routes referral-related types to /referrals', () => {
      assert.equal(resolveTerminalRouteFor('referral_attached'), '/referrals');
      assert.equal(resolveTerminalRouteFor('referral_reward'), '/referrals');
      assert.equal(resolveTerminalRouteFor('referral_qualified'), '/referrals');
    });

    it('routes partner types to /partner', () => {
      assert.equal(resolveTerminalRouteFor('partner_referral_registered'), '/partner');
      assert.equal(resolveTerminalRouteFor('partner_earning'), '/partner');
      assert.equal(resolveTerminalRouteFor('partner.withdrawal_approved'), '/partner');
    });

    it('routes promocode events to /promo', () => {
      assert.equal(resolveTerminalRouteFor('promocode.activated'), '/promo');
      assert.equal(resolveTerminalRouteFor('promocode.depleted'), '/promo');
    });

    it('falls back to /dashboard for unknown types', () => {
      assert.equal(resolveTerminalRouteFor('user_registered'), '/dashboard');
      assert.equal(resolveTerminalRouteFor('node_status'), '/dashboard');
      assert.equal(resolveTerminalRouteFor('mystery_event'), '/dashboard');
    });
  });

  describe('resolveNotificationCategory', () => {
    it('buckets the canonical types into stable groups', () => {
      assert.equal(resolveNotificationCategory('expires_in_3_days'), 'expires');
      assert.equal(resolveNotificationCategory('expired'), 'expires');
      assert.equal(resolveNotificationCategory('expired_1_day_ago'), 'expires');
      assert.equal(resolveNotificationCategory('limited'), 'expires');
      assert.equal(resolveNotificationCategory('referral_reward'), 'referral');
      assert.equal(resolveNotificationCategory('partner.earning'), 'partner');
      assert.equal(resolveNotificationCategory('promocode.activated'), 'promocode');
      assert.equal(resolveNotificationCategory('user_registered'), 'system');
      assert.equal(resolveNotificationCategory('bot_lifetime'), 'system');
      assert.equal(resolveNotificationCategory('access_policy'), 'system');
      assert.equal(resolveNotificationCategory('something_unknown'), 'other');
    });
  });
});
