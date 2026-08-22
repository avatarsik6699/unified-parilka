/**
 * Fail closed before opening an MTProto session.
 *
 * The flag is intentionally exact: setting it is an operator assertion that
 * every other owner of the same Telegram session has already stopped.
 */
export function assertExclusiveMtprotoOwner(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.BOT_MTPROTO_EXCLUSIVE_OWNER?.trim() !== "true") {
    throw new Error(
      "BOT_MTPROTO_EXCLUSIVE_OWNER must be exactly true after every other MTProto owner for this Telegram session has been stopped.",
    );
  }
}
