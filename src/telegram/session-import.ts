import {
  convertFromGramjsSession,
  convertFromTelethonSession,
} from "@mtcute/convert";

type ConvertedGramjsSession = ReturnType<typeof convertFromGramjsSession>;

/**
 * Structural subset of mtcute's BaseTelegramClient. The high-level
 * TelegramClient wrapper does not expose `.mt`; migration wiring must inspect
 * and import through the base client, then close it before normal startup.
 */
export interface MtcuteSessionImportTarget {
  prepare(): Promise<void>;
  importSession(session: ConvertedGramjsSession, force?: boolean): Promise<void>;
  readonly mt: {
    readonly storage: {
      readonly dcs: {
        fetch(): Promise<{ main: { id: number } } | null>;
      };
      readonly provider: {
        readonly authKeys: {
          get(dcId: number):
            | Uint8Array
            | null
            | PromiseLike<Uint8Array | null>;
        };
      };
    };
  };
}

export type GramjsSessionImportResult =
  | {
      status: "imported";
      forced: boolean;
    }
  | {
      status: "skipped";
      reason: "already_authorized";
      forced: false;
    };

export type MtcuteSessionImportErrorCode =
  | "invalid_source_session"
  | "storage_inspection_failed"
  | "storage_import_failed";

export class MtcuteSessionImportError extends Error {
  readonly name = "MtcuteSessionImportError";

  constructor(
    readonly code: MtcuteSessionImportErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/**
 * Imports the legacy StringSession accepted by the previous GramJS owner into
 * mtcute's own auth storage. GramJS itself also accepts the older
 * Telethon-compatible representation, so migration preserves that behavior.
 *
 * The source secret is converted only after the target storage was inspected.
 * A populated target is never overwritten unless `force: true` is explicitly
 * supplied. The result intentionally contains no session or auth-key material.
 */
export async function importGramjsStringSession(
  target: MtcuteSessionImportTarget,
  gramjsStringSession: string,
  options: { force?: boolean } = {},
): Promise<GramjsSessionImportResult> {
  const force = options.force === true;
  const authorized = await inspectAuthorization(target, force);
  if (authorized && !force) {
    return {
      status: "skipped",
      reason: "already_authorized",
      forced: false,
    };
  }

  if (typeof gramjsStringSession !== "string" || gramjsStringSession.trim() === "") {
    throw new MtcuteSessionImportError(
      "invalid_source_session",
      "GramJS StringSession is missing or empty.",
    );
  }

  let converted: ConvertedGramjsSession;
  try {
    converted = convertLegacyStringSession(gramjsStringSession);
  } catch {
    throw new MtcuteSessionImportError(
      "invalid_source_session",
      "GramJS StringSession could not be converted.",
    );
  }
  if (converted.authKey.byteLength !== 256) {
    throw new MtcuteSessionImportError(
      "invalid_source_session",
      "Converted GramJS session contains an invalid auth key.",
    );
  }

  try {
    await target.importSession(converted, force);
  } catch {
    throw new MtcuteSessionImportError(
      "storage_import_failed",
      "Converted session could not be written to mtcute auth storage.",
    );
  }
  return {
    status: "imported",
    forced: force,
  };
}

function convertLegacyStringSession(
  session: string,
): ConvertedGramjsSession {
  try {
    return convertFromGramjsSession(session);
  } catch {
    // GramJS detects the compact Telethon representation by encoded length.
    // @mtcute/convert's GramJS parser does not, so mirror that compatibility
    // only after native GramJS conversion has failed.
    return convertFromTelethonSession(session);
  }
}

export async function isMtcuteStorageAuthorized(
  target: MtcuteSessionImportTarget,
): Promise<boolean> {
  return inspectAuthorization(target, false);
}

async function inspectAuthorization(
  target: MtcuteSessionImportTarget,
  allowInvalidKeyForForcedReplacement: boolean,
): Promise<boolean> {
  try {
    await target.prepare();
    const primaryDcs = await target.mt.storage.dcs.fetch();
    if (!primaryDcs) {
      return false;
    }
    const authKey = await target.mt.storage.provider.authKeys.get(
      primaryDcs.main.id,
    );
    if (authKey === null) {
      return false;
    }
    if (authKey.byteLength !== 256) {
      if (allowInvalidKeyForForcedReplacement) {
        return true;
      }
      throw new Error("mtcute auth storage contains an invalid auth key.");
    }
    return true;
  } catch (error) {
    throw new MtcuteSessionImportError(
      "storage_inspection_failed",
      "mtcute auth storage could not be inspected.",
      error,
    );
  }
}
