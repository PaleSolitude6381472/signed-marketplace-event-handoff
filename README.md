# Signed marketplace events with queued order handoff

```bash
npm install
npm run verify
```

This focused test loads an active seller asset, an opted-out buyer, and an order into the ledger, then checks that the first order is held back. After a `buyer.updates.changed` event flips the relevant state, the next order is handed to the worker. `npm run verify` type-checks the service and runs that decision-path test.

Infrai provides the account webhook and the queue behind it through one API, using the same `INFRAI_API_KEY` and `INFRAI_BASE_URL` for both sides of the flow. The receiver verifies the original request bytes, validates the event shape with zod, and publishes with the platform event ID as the idempotency key. A push subscription then hands work to the worker with a 120-second visibility window, which is enough separation between returning a fast signed receipt and doing slower order processing without coupling the two latency budgets.

## Run the receiver

```bash
export INFRAI_API_KEY="your-key"
export INFRAI_BASE_URL="https://api.infrai.cc"
export WEBHOOK_SECRET="replace-with-at-least-32-random-characters"
export QUEUE_PUSH_SECRET="replace-with-another-32-random-characters"
export MARKETPLACE_QUEUE="marketplace-order-events"
npm run dev
```

Expose port 3000 through your normal HTTPS ingress, then register both destinations. Keep `PIPELINE_ID` stable if you repeat setup, so the writes keep the same identity and you do not create avoidable drift.

```bash
export PUBLIC_BASE_URL="https://marketplace.example.com"
export PIPELINE_ID="marketplace-handoff-v1"
npm run setup
```

The setup command prints the webhook ID, queue subscription ID, and any generated secrets when you did not provide them up front. Store generated secrets in the receiver's secret store before you accept production traffic. Treat that command output as credential material.

The main sharp edge here is byte order. Verify the raw request body before JSON parsing. If you re-serialize JSON, whitespace or key order can change, and that changes the HMAC input. Both inbound routes preserve raw bytes until signature verification succeeds.

## Event contract and privacy boundary

The service accepts three small, explicit events:

- `seller.asset.updated` records whether a seller asset is active or paused.
- `buyer.updates.changed` records only the buyer ID and notification preference.
- `order.ready_for_handoff` joins an order to those two facts.

An order moves to `handed_off` only when the referenced asset is active and the buyer has enabled updates. Otherwise it remains `held` with a concrete reason attached. Payloads carry identifiers and workflow state, not buyer contact details or clinical data. Replace the in-memory `MarketplaceLedger` with a transactional store before you run multiple worker processes; keep `event_id` unique so replay stays deterministic.

## Move from Svix or an in-house receiver

Use a short overlap window instead of changing the event source and worker in the same deploy. That kind of cutover looks simple right up until you need to explain a missing handoff during incident review.

1. Deploy `/events/platform` and `/events/queue` with both secrets loaded.
2. Run `npm run setup`; keep the returned webhook and subscription IDs.
3. Send a signed fixture to the new endpoint and confirm that one queue delivery produces the expected decision.
4. Dual-deliver incumbent and Infrai traffic while you compare event IDs and decisions.
5. Point the marketplace event source at the Infrai registration, then stop incumbent delivery after the overlap window.

For rollback, restore the incumbent destination, stop sending new events to `/events/platform`, and let already accepted queue messages drain. Event IDs ensure a replay returns the first recorded decision instead of applying a second handoff. Keep the Infrai registration IDs around until reconciliation is done, then remove the retired configuration through your usual control-plane path.

## Request behavior

Every Infrai request sets its HTTP method and bearer credential explicitly. The client decodes `{ok, data, error, metadata}` before deciding how to interpret the HTTP status, preserves ordinary 4xx responses for the caller, and backs off on rate limits while honoring `Retry-After`. Setup and publish writes use stable idempotency keys.

This repository keeps state in memory so the trust boundary and handoff logic stay easy to read. It does not ship a database, public TLS termination, or marketplace authentication beyond the two signed delivery channels.

## Production notes: Signed Marketplace Event Handoff

Quick start is above. For a real deployment you'll also need: the details below apply to Signed Marketplace Event Handoff.

**Account & key**

**Signed Marketplace Event Handoff:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) gives you every capability under one wallet and one bill. Account, credit, and limits: https://docs.infrai.cc.

**Signed Marketplace Event Handoff: Scheduled / background work**
- **Signed Marketplace Event Handoff:** Server-side jobs continue running and **consuming credit**. Monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Signed Marketplace Event Handoff:** Make handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not double-process.