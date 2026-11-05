/**
 * Twilio Conversations, used only for group texting. One-to-one texts and
 * broadcasts stay on the Messages API, so nothing else depends on this file.
 *
 * Order matters when a group is created: the CRM line joins with the number it
 * speaks from (`projectedAddress`), then each person joins with their own number
 * and no proxy. That is what makes Twilio send a real group text.
 */
import 'server-only';
import twilio from 'twilio';
import type { RequestClient } from 'twilio';

export type GroupTwilio = {
  createConversation(name: string): Promise<string>;
  addWebhook(conversationSid: string, url: string): Promise<void>;
  addCrmLine(conversationSid: string, identity: string, projectedAddress: string): Promise<void>;
  addMember(conversationSid: string, e164: string): Promise<string>;
  removeMember(conversationSid: string, participantSid: string): Promise<void>;
  send(conversationSid: string, identity: string, body: string): Promise<string>;
  close(conversationSid: string): Promise<void>;
  discard(conversationSid: string): Promise<void>;
};

export function groupTwilio(accountSid: string, authToken: string, httpClient?: RequestClient): GroupTwilio {
  const conversations = twilio(accountSid, authToken, httpClient ? { httpClient } : undefined).conversations.v1.conversations;
  return {
    async createConversation(name) {
      return (await conversations.create({ friendlyName: name })).sid;
    },
    async addWebhook(conversationSid, url) {
      await conversations(conversationSid).webhooks.create({
        target: 'webhook',
        'configuration.url': url,
        'configuration.method': 'post',
        'configuration.filters': ['onMessageAdded'],
      });
    },
    async addCrmLine(conversationSid, identity, projectedAddress) {
      await conversations(conversationSid).participants.create({
        identity,
        'messagingBinding.projectedAddress': projectedAddress,
      });
    },
    async addMember(conversationSid, e164) {
      return (await conversations(conversationSid).participants.create({ 'messagingBinding.address': e164 })).sid;
    },
    async removeMember(conversationSid, participantSid) {
      await conversations(conversationSid).participants(participantSid).remove();
    },
    async send(conversationSid, identity, body) {
      return (await conversations(conversationSid).messages.create({ author: identity, body })).sid;
    },
    async close(conversationSid) {
      await conversations(conversationSid).update({ state: 'closed' });
    },
    async discard(conversationSid) {
      await conversations(conversationSid).remove();
    },
  };
}
