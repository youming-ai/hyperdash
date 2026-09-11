/**
 * Agent key handling — delegated to `@hyperdash/shared-types`.
 *
 * The BE (Workers, WebCrypto) writes these encrypted blobs and this process
 * reads them, so both sides must share one implementation and one byte layout.
 * A local node:crypto copy would risk the two drifting apart and leaving stored
 * keys undecryptable; the shared module is verified round-trip compatible with
 * blobs written by the original node:crypto version.
 */

import { parseEncryptionKey } from '@hyperdash/shared-types';

export {
  decryptAgentKey as decryptKey,
  encryptAgentKey as encryptKey,
} from '@hyperdash/shared-types';

/** Read the 32-byte key from `ENCRYPTION_KEY`; throws when absent or malformed. */
export function getEncryptionKey(): Uint8Array {
  return parseEncryptionKey(process.env.ENCRYPTION_KEY);
}
