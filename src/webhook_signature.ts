import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyWebhook(rawBody: Buffer, supplied: string, secret: string): boolean {
  const expected = Buffer.from(signWebhook(rawBody, secret));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
