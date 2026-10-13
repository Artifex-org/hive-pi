import { createHash } from "node:crypto";

/**
 * The identifier OPERATOR_INPUT_CHANNEL carries for one person-sent message.
 *
 * The bus carries no prose (channels.ts), but the agenda must know WHICH user
 * message the announcement was about: pi keeps separate steer and follow-up
 * queues, so a Hive notice can be consumed between an operator's announcement
 * and their message, and pairing by count would reopen the lifecycle on the
 * notice and quote it as the "new instruction". A digest of the delivered text
 * names the message without carrying it. Whitespace-trimmed on both sides,
 * because that is the only normalisation between the two.
 */
export function operatorInputDigest(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}
