import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { signWebhook } from "../src/webhook_signature.js";
import { MarketplaceLedger, marketplaceEventSchema } from "../src/order_handoff.js";

const occurred_at = "2026-09-21T08:00:00.000Z";

test("signed queue.dlq notifications are acknowledged without queue publication", async () => {
  const secret = "test-webhook-secret-with-at-least-32-characters";
  const port = 32000 + Math.floor(Math.random() * 10000);
  const receiver = spawn(process.execPath, ["--import", "tsx", "src/marketplace_receiver.ts"], {
    env: { ...process.env, PORT: String(port), INFRAI_API_KEY: "test",
      INFRAI_BASE_URL: "http://127.0.0.1:1", WEBHOOK_SECRET: secret, QUEUE_PUSH_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await Promise.race([
      once(receiver.stdout, "data"),
      once(receiver, "exit").then(() => { throw new Error("receiver exited before listening"); })
    ]);
    const body = Buffer.from(JSON.stringify({
      event_id: "evt-dlq", occurred_at, type: "queue.dlq",
      data: { queue: "marketplace-order-events", message_id: "msg-failed" }
    }));
    const send = (signature: string) => fetch(`http://127.0.0.1:${port}/events/platform`, {
      method: "POST", headers: { "content-type": "application/json", "x-infrai-signature": signature }, body
    });
    assert.equal((await send("invalid")).status, 401);
    const response = await send(signWebhook(body, secret));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
  } finally {
    receiver.kill();
    await once(receiver, "exit");
  }
});

test("hands off only an active seller asset to a buyer who accepted updates", () => {
  const ledger = new MarketplaceLedger();
  ledger.apply(marketplaceEventSchema.parse({
    event_id: "evt-asset", occurred_at, type: "seller.asset.updated",
    data: { seller_id: "seller-7", asset_id: "asset-4", status: "active" }
  }));

  const held = ledger.apply(marketplaceEventSchema.parse({
    event_id: "evt-order-held", occurred_at, type: "order.ready_for_handoff",
    data: { order_id: "order-9", seller_id: "seller-7", buyer_id: "buyer-2", asset_id: "asset-4" }
  }));
  assert.deepEqual(held, { state: "held", orderId: "order-9", reason: "buyer_updates_disabled" });

  ledger.apply(marketplaceEventSchema.parse({
    event_id: "evt-buyer", occurred_at, type: "buyer.updates.changed",
    data: { buyer_id: "buyer-2", updates_enabled: true }
  }));
  const handedOff = ledger.apply(marketplaceEventSchema.parse({
    event_id: "evt-order-ready", occurred_at, type: "order.ready_for_handoff",
    data: { order_id: "order-10", seller_id: "seller-7", buyer_id: "buyer-2", asset_id: "asset-4" }
  }));
  assert.deepEqual(handedOff, { state: "handed_off", orderId: "order-10", notifyBuyer: true });
});

test("replaying an event returns its first decision", () => {
  const ledger = new MarketplaceLedger();
  const event = marketplaceEventSchema.parse({
    event_id: "evt-replay", occurred_at, type: "order.ready_for_handoff",
    data: { order_id: "order-11", seller_id: "seller-7", buyer_id: "buyer-2", asset_id: "asset-4" }
  });
  assert.deepEqual(ledger.apply(event), ledger.apply(event));
});
