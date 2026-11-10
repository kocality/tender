import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

/** NEAR code_hash: base58(sha256(wasm)), not hex. */
export const codeHashB58 = (bytes: Uint8Array): string => bs58.encode(sha256(bytes));

export function wasmImports(bytes: Uint8Array<ArrayBuffer>): WebAssembly.ModuleImportDescriptor[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(bytes));
}

/**
 * Host functions that could add keys, redeploy or delete the account, including the newer gas-key and
 * global-contract families (P-11). Any `env` import matching this fails verify.
 */
export const FORBIDDEN_IMPORT_RE =
  /^promise_batch_action_(add_key_|add_gas_key_|deploy_contract$|use_global_contract|deploy_global_contract|delete_account$)/;
