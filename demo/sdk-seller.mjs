// A seller agent built with the OFFICIAL A2A SDK (@a2a-js/sdk + Express), not with Pactwire's kit.
// It shows how any existing A2A agent joins Pactwire: publish a signing key in the card,
// and answer Pactwire's "offer" and "job" messages with signed objects.
import express from 'express';
import { AgentCard, Role } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { jsonRpcHandler, restHandler, agentCardHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { createIdentity, identityExtension, signAs } from '../src/agent-kit.mjs';

/** work(task) -> output. Returns { origin, identity, close }. */
export async function startSdkSeller({ port, name, skillId, work }) {
  const origin = `http://127.0.0.1:${port}`;
  const identity = await createIdentity(origin);
  const cardJson = {
    name, description: `${name}: an agent built on the official A2A SDK that sells "${skillId}" through Pactwire.`, version: '1.0.0',
    supportedInterfaces: [
      { url: `${origin}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${origin}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }
    ],
    // CHANGE 1: publish your Pactwire signing key in the card.
    capabilities: { streaming: false, pushNotifications: false, extensions: [identityExtension(identity)] },
    defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{ id: skillId, name: skillId, description: `Paid ${skillId} jobs through Pactwire`, tags: [skillId, 'pactwire'] }]
  };
  const card = AgentCard.fromJSON(cardJson);
  const executor = {
    async execute(ctx, bus) {
      const parts = ctx.userMessage.parts || [];
      const data = parts.find(p => p.content?.$case === 'data')?.content.value || {};
      let reply = { text: `I am ${name}.`, data: undefined };
      if (data.pactwire === 'ping') reply = { text: 'pong', data: { pactwire: 'pong' } };
      // CHANGE 2: accept offers by signing the terms hash.
      if (data.pactwire === 'offer') reply = { text: 'accepted', data: { pactwire: 'accepted', acceptance: await signAs(identity, { action: 'accept', dealId: data.dealId, termsHash: data.termsHash }) } };
      // CHANGE 3: when a paid job arrives, do the work and sign the output.
      if (data.pactwire === 'job') reply = { text: 'delivered', data: { pactwire: 'delivered', delivery: await signAs(identity, { action: 'deliver', dealId: data.dealId, termsHash: data.termsHash, output: await work(data.terms.task) }) } };
      const out = [{ content: { $case: 'text', value: reply.text }, metadata: undefined, filename: '', mediaType: '' }];
      if (reply.data) out.push({ content: { $case: 'data', value: reply.data }, metadata: undefined, filename: '', mediaType: '' });
      bus.publish({ kind: 'message', data: { messageId: crypto.randomUUID(), role: Role.ROLE_AGENT, parts: out, contextId: ctx.contextId, taskId: '', metadata: undefined, extensions: [], referenceTaskIds: [] } });
      bus.finished();
    },
    async cancelTask() {}
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  app.use('/a2a/rest', restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const server = await new Promise(r => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  return { origin, identity, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
