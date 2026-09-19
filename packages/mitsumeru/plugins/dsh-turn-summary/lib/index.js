/**
 * Host half — deliberately empty.
 *
 * Everything this plugin renders is already on the Client:
 *
 *   - the turn's own bounds and steps come from `TurnLocation`, which the
 *     `conversation.chat.turnTail` owner hands every entry as an owner prop;
 *   - the tool breakdown and the turn's token accounting come from the Chat
 *     snapshot through the `useChat` standard prop.
 *
 * So there is nothing for the Host to measure or publish. The export exists
 * because `dsh.bundle.patch` mounts a real plugin row, and a Host-side setting
 * (say, a collapse-by-default preference) would live here later.
 */
export function apply() {}
