import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alert-events.js';


export function registerAlertEventTools(server) {
  server.tool(
    'webhook_health',
    'Read the local TradingView webhook receiver heartbeat and durable queue counts without changing state.',
    {},
    async () => {
      const result = await core.health();
      return jsonResult(result, !result.success);
    },
  );

  server.tool(
    'alert_event_wait',
    'Wait up to 55 seconds for one unacknowledged TradingView webhook event matching an approved plan ID or exact alert message. This never acknowledges the event or changes TradingView.',
    {
      alert_plan_id: z.string().optional().describe('Approved alert plan ID embedded in a JSON webhook message'),
      messages: z.array(z.string()).max(64).optional().describe('Exact approved alert messages; use for deterministic text alerts'),
      after: z.string().optional().describe('Only return events received after this ISO-8601 timestamp'),
      timeout_seconds: z.coerce.number().min(0).max(55).optional().describe('Long-wait duration; default 30, maximum 55'),
    },
    async (args) => {
      const result = await core.wait(args);
      return jsonResult(result, !result.success);
    },
  );

  server.tool(
    'alert_event_ack',
    'Acknowledge one durable webhook event only after its trading decision has been journaled. Idempotent for an already acknowledged event.',
    { event_id: z.string().describe('SHA-256 event ID returned by alert_event_wait') },
    async (args) => {
      const result = await core.ack(args);
      return jsonResult(result, !result.success);
    },
  );
}
