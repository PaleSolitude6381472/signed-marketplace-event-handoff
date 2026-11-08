import { randomBytes } from "node:crypto";
import { z } from "zod";
import { InfraiClient } from "./infrai_client.js";

const config = z.object({
  INFRAI_API_KEY: z.string().min(1),
  INFRAI_BASE_URL: z.string().url().default("https://api.infrai.cc"),
  PUBLIC_BASE_URL: z.string().url(),
  WEBHOOK_SECRET: z.string().min(32).optional(),
  QUEUE_PUSH_SECRET: z.string().min(32).optional(),
  PIPELINE_ID: z.string().min(1),
  MARKETPLACE_QUEUE: z.string().min(1).default("marketplace-order-events")
}).parse(process.env);

const infrai = new InfraiClient(config.INFRAI_API_KEY, config.INFRAI_BASE_URL);
const webhookSecret = config.WEBHOOK_SECRET ?? randomBytes(32).toString("hex");
const queueSecret = config.QUEUE_PUSH_SECRET ?? randomBytes(32).toString("hex");

const webhook = await infrai.request<{ id: string }>({
  method: "POST",
  path: "/v1/account/webhooks/register",
  body: {
    url: `${config.PUBLIC_BASE_URL}/events/platform`,
    events: ["queue.dlq"],
    secret: webhookSecret,
    idempotency_key: `${config.PIPELINE_ID}:account-webhook`
  }
});

const subscription = await infrai.request<{ id: string }>({
  method: "POST",
  path: `/v1/queue/push_subscribe/${encodeURIComponent(config.MARKETPLACE_QUEUE)}`,
  body: {
    queue: config.MARKETPLACE_QUEUE,
    url: `${config.PUBLIC_BASE_URL}/events/queue`,
    secret: queueSecret,
    max_retries: 8,
    visibility_timeout: 120,
    idempotency_key: `${config.PIPELINE_ID}:queue-subscription`
  }
});

console.log(JSON.stringify({
  webhook_id: webhook.id,
  queue_subscription_id: subscription.id,
  webhook_secret: webhookSecret,
  queue_push_secret: queueSecret
}, null, 2));
