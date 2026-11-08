import { z } from "zod";

const eventBase = {
  event_id: z.string().min(1),
  occurred_at: z.string().datetime()
};

export const marketplaceEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("seller.asset.updated"),
    data: z.object({
      seller_id: z.string().min(1),
      asset_id: z.string().min(1),
      status: z.enum(["active", "paused"])
    })
  }),
  z.object({
    ...eventBase,
    type: z.literal("buyer.updates.changed"),
    data: z.object({
      buyer_id: z.string().min(1),
      updates_enabled: z.boolean()
    })
  }),
  z.object({
    ...eventBase,
    type: z.literal("order.ready_for_handoff"),
    data: z.object({
      order_id: z.string().min(1),
      seller_id: z.string().min(1),
      buyer_id: z.string().min(1),
      asset_id: z.string().min(1)
    })
  })
]);

export type MarketplaceEvent = z.infer<typeof marketplaceEventSchema>;
export type HandoffDecision =
  | { state: "recorded"; eventId: string }
  | { state: "handed_off"; orderId: string; notifyBuyer: true }
  | { state: "held"; orderId: string; reason: "asset_not_active" | "buyer_updates_disabled" };

export class MarketplaceLedger {
  private readonly assetStatus = new Map<string, "active" | "paused">();
  private readonly buyerUpdates = new Map<string, boolean>();
  private readonly processed = new Map<string, HandoffDecision>();

  apply(event: MarketplaceEvent): HandoffDecision {
    const previous = this.processed.get(event.event_id);
    if (previous) return previous;

    let decision: HandoffDecision;
    if (event.type === "seller.asset.updated") {
      this.assetStatus.set(`${event.data.seller_id}:${event.data.asset_id}`, event.data.status);
      decision = { state: "recorded", eventId: event.event_id };
    } else if (event.type === "buyer.updates.changed") {
      this.buyerUpdates.set(event.data.buyer_id, event.data.updates_enabled);
      decision = { state: "recorded", eventId: event.event_id };
    } else {
      const assetKey = `${event.data.seller_id}:${event.data.asset_id}`;
      if (this.assetStatus.get(assetKey) !== "active") {
        decision = { state: "held", orderId: event.data.order_id, reason: "asset_not_active" };
      } else if (this.buyerUpdates.get(event.data.buyer_id) !== true) {
        decision = { state: "held", orderId: event.data.order_id, reason: "buyer_updates_disabled" };
      } else {
        decision = { state: "handed_off", orderId: event.data.order_id, notifyBuyer: true };
      }
    }

    this.processed.set(event.event_id, decision);
    return decision;
  }
}
