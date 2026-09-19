/**
 * Host half — deliberately empty.
 *
 * The card is a Client surface and its numbers are already on the Client: the
 * turn's file-tool nodes carry the exact arguments each mutation applied
 * (`write` content, `edit` old/new strings, a patch body), which is enough to
 * count the lines that changed without asking the Host to snapshot anything.
 *
 * That is the point of this half existing at all rather than reading the
 * `workspaceChanges` service: the Host's recorder announces a summary per
 * top-level turn, but it can legitimately announce nothing (see README), and a
 * card that depends on it disappears in exactly those turns.
 */
export function apply() {}
