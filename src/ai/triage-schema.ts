import { z } from 'zod';

// Split out from triage.ts on purpose: triage.ts also imports the `ai`
// SDK and ./model (createOpenAI, process.env, Node builtins) for the
// actual model-calling logic, none of which the frontend's isolated
// tsc program (web/tsconfig.json, no "node" in its types, DOM-only lib)
// can resolve. src/lib/ai-feed.ts and the AI feed API's wire-shape types
// (src/routes/ai-feed-types.ts, type-imported by the frontend via the
// @server/* path mapping) only ever need EmailTriage's *shape* — keeping
// it in its own dependency-light file (only zod) means resolving it never
// drags the model-calling machinery along for type-checking.

// Zod's z.iso.datetime() embeds a large regex `pattern` in the JSON Schema
// it generates for schema-locked structured output — confirmed by testing
// to be exactly what breaks Ollama's grammar compiler ("Failed to
// initialize samplers: failed to parse grammar") on a schema with this
// much other structure around it. A .refine() enforces the identical
// ISO-8601 check at parse time without ever appearing in the JSON Schema
// sent to the model, sidestepping the crash entirely — confirmed by
// testing too.
const isoDateTime = z
  .string()
  .refine((val) => !Number.isNaN(Date.parse(val)) && /^\d{4}-\d{2}-\d{2}T/.test(val), {
    message: 'must be an ISO 8601 date-time string',
  });

// What the model actually produces. emailId is deliberately NOT here — the
// call is always scoped to exactly one email (see triage.ts's
// buildPrompt), so the app already knows which email this is about and
// stitches emailId on after the call returns, rather than asking the
// model to echo back a fact it was never in a position to get right or
// wrong.
//
// No .optional() fields anywhere on purpose: an LLM generating JSON is
// trying to complete a shape it's been shown, one token at a time —
// omitting a key is an unnatural act for that process (it produced
// explicit `null` instead, in testing), where writing *something* is the
// path of least resistance. Every field here is always required, with an
// explicit value standing in for "no" / "none" instead of relying on
// absence to mean that. suspicious carries its reason the same way
// draftReply carries its subject/body — only present in the branch where
// it's meaningful, never a dangling optional next to a boolean.
export const modelDecisionSchema = z.object({
  // Exactly one — what happens to this email's visibility right now.
  visibility: z.discriminatedUnion('type', [
    z.object({ type: z.literal('feed') }),
    z.object({ type: z.literal('snooze'), until: isoDateTime }),
    z.object({ type: z.literal('filtered') }),
  ]),
  // True only for the rare "uncertain about an editorial newsletter"
  // case — see triage.ts's INSTRUCTIONS. The app checks a per-sender
  // preference store before ever reaching this field: an already-resolved
  // sender's mail never triggers a repeat ask, and a "hide" sender's mail
  // skips the model entirely, so this field only matters the first time a
  // given sender's editorial content shows up.
  checkSenderPreference: z.boolean(),
  unsubscribeCandidate: z.boolean(),
  draftReply: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('draft'), subject: z.string(), body: z.string() }),
  ]),
  suspicious: z.discriminatedUnion('type', [
    z.object({ type: z.literal('no') }),
    z.object({ type: z.literal('yes'), reason: z.string() }),
  ]),
});

export type ModelDecisionOutput = z.infer<typeof modelDecisionSchema>;

// The full record persisted to the AI feed store — model output plus the
// one fact the app already had before ever calling the model.
export interface EmailTriage extends ModelDecisionOutput {
  emailId: string;
}
