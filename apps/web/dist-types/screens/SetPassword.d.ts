import { type ReactElement } from 'react';
/**
 * Choosing a password from a set-up link.
 *
 * The public end of the flow an administrator starts on the People screen. It
 * is reachable signed-out by necessity — the whole point is that this person
 * has no way in yet — and the token in the URL is the only thing authorising
 * anything here.
 *
 * The page greets them by name before they type anything. That is not
 * decoration: a link arriving in a chat window with no context is
 * indistinguishable from a phishing attempt, and showing that the server knows
 * who the link was minted for is the cheapest way to make it trustworthy. The
 * server returns nothing else — no email, no role, no permissions — because
 * whoever holds the link is not yet known to be its intended owner.
 */
export declare function SetPassword(): ReactElement;
//# sourceMappingURL=SetPassword.d.ts.map