# mtcute ownership rules

These rules apply to this directory.

- `MtcuteProcessClientOwner` is the only long-lived session owner. Keep the
  factory-to-owner `WeakMap`; do not introduce a pool, a second owner, or
  direct client construction from adapters.
- `createMtcuteBaseClient` is allowed outside the owner only for the one-shot
  pre-runtime session bootstrap. Its caller must destroy it before creating
  `MtcuteTelegramService`.
- Keep the auth store separate from the application database and preserve its
  `0600` file mode. Never log API hashes, sessions, auth-store contents, or
  message bodies from this layer.
- Preserve bounded connect/reconnect, request retry/timeout, and flood-wait
  behavior. Lifecycle changes need tests for concurrent facades, failed or
  timed-out connect, idempotent disconnect, and idempotent destroy.
- Keep `../mtcute-client.ts` as the stable public barrel. Add implementation to
  the focused module that owns the behavior.
- Transport-specific mtcute objects must be normalized before crossing the
  `TelegramGateway` boundary.
