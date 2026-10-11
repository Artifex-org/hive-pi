import type { AssistantMessage } from "@earendil-works/pi-ai";

export type AideUsageCharge = Pick<AssistantMessage, "provider" | "model" | "usage">;
type Consumer = (charge: AideUsageCharge) => boolean;
interface UsageMailbox {
	pending: Map<string, AideUsageCharge[]>;
	owners: Map<string, Consumer>;
	metrics: Map<string, AideUsageCharge[]>;
	requests: Map<string, object>;
}
const SLOT = Symbol.for("hive.orchestrator-aide.deferred-usage.v3");

/** Pi/jiti replace module state on session switch/reload. Only usage metadata
 * crosses this process-owned, native-session-UUID-keyed boundary. An active
 * replacement collects late arrivals immediately; an inactive owner collects
 * on resume. Process exit still loses uncollected charges. */
export function aideUsageMailbox(): UsageMailbox {
	const owner = globalThis as typeof globalThis & { [SLOT]?: UsageMailbox };
	return owner[SLOT] ??= { pending: new Map(), owners: new Map(), metrics: new Map(), requests: new Map() };
}

/** Cancellation is not settlement: locks survive runtime replacement. */
export function holdAideRequest(id: string, owner: object): (() => void) | undefined {
	const requests = aideUsageMailbox().requests;
	if (requests.has(id)) return;
	requests.set(id, owner);
	return () => { if (requests.get(id) === owner) requests.delete(id); };
}

/** Returns true only when an active, origin-matching consumer accepted it. */
export function deliverAideUsage(id: string, charge: AideUsageCharge): boolean {
	const box = aideUsageMailbox();
	if (box.owners.get(id)?.(charge)) return true;
	const pending = box.pending.get(id) ?? [];
	pending.push(charge); box.pending.set(id, pending);
	return false;
}

export function ownAideUsage(id: string, consumer: Consumer): () => void {
	const box = aideUsageMailbox();
	box.owners.set(id, consumer);
	const pending = box.pending.get(id) ?? [];
	box.pending.delete(id);
	for (const charge of pending) deliverAideUsage(id, charge);
	// Old shutdown/reload cleanup must never unregister a replacement owner.
	return () => { if (box.owners.get(id) === consumer) box.owners.delete(id); };
}
