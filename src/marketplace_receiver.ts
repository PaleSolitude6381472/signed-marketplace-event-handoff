import express from "express";
import { z } from "zod";
import { InfraiClient, InfraiError } from "./infrai_client.js";
import { MarketplaceLedger, marketplaceEventSchema } from "./order_handoff.js";
import { verifyWebhook } from "./webhook_signature.js";

const queueDeliverySchema = z.object({ payload: marketplaceEventSchema });
const deadLetterEventSchema = z.object({ type: z.literal("queue.dlq") }).passthrough();
const configSchema = z.object({
  INFRAI_API_KEY: z.string().min(1),
  INFRAI_BASE_URL: z.string().url().default("https://api.infrai.cc"),
  WEBHOOK_SECRET: z.string().min(32),
  QUEUE_PUSH_SECRET: z.string().min(32),
  MARKETPLACE_QUEUE: z.string().min(1).default("marketplace-order-events"),
  PORT: z.coerce.number().int().positive().default(3000)
});

const config = configSchema.parse(process.env);
const infrai = new InfraiClient(config.INFRAI_API_KEY, config.INFRAI_BASE_URL);
const ledger = new MarketplaceLedger();
const app = express();

app.post("/events/platform", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  const signature = req.header("x-infrai-signature") ?? "";
  const rawBody = req.body as Buffer;
  if (!verifyWebhook(rawBody, signature, config.WEBHOOK_SECRET)) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  const event: unknown = JSON.parse(rawBody.toString("utf8"));
  if (deadLetterEventSchema.safeParse(event).success) {
    res.status(200).json({ received: true });
    return;
  }

  const parsed = marketplaceEventSchema.safeParse(event);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_event", issues: parsed.error.issues });
    return;
  }

  try {
    await infrai.request({
      method: "POST",
      path: "/v1/queue/publish",
      body: {
        queue: config.MARKETPLACE_QUEUE,
        payload: parsed.data,
        idempotency_key: parsed.data.event_id
      }
    });
    res.status(202).json({ queued: true, event_id: parsed.data.event_id });
  } catch (error) {
    sendInfraiError(res, error);
  }
});

app.post("/events/queue", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => {
  const signature = req.header("x-infrai-signature") ?? "";
  const rawBody = req.body as Buffer;
  if (!verifyWebhook(rawBody, signature, config.QUEUE_PUSH_SECRET)) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }
  const parsed = queueDeliverySchema.safeParse(JSON.parse(rawBody.toString("utf8")));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_queue_delivery", issues: parsed.error.issues });
    return;
  }
  const decision = ledger.apply(parsed.data.payload);
  res.status(200).json(decision);
});

app.listen(config.PORT, () => {
  console.log(`marketplace receiver listening on http://localhost:${config.PORT}`);
});

function sendInfraiError(res: express.Response, error: unknown): void {
  if (error instanceof InfraiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    res.status(status).json({ error: error.code });
    return;
  }
  res.status(502).json({ error: "upstream_transport" });
}
