import { describe, expect, it } from 'vitest';
import { codeHashB58, FORBIDDEN_IMPORT_RE, wasmImports } from '../../src/lib/wasm.js';

const te = new TextEncoder();
const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const str = (s: string) => [...leb(te.encode(s).length), ...te.encode(s)];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];

/** A minimal module importing `env.<name>: () -> ()` for each name. */
function moduleImporting(names: string[]): Uint8Array<ArrayBuffer> {
  const types = section(1, [1, 0x60, 0, 0]);
  const imports = section(2, [...leb(names.length), ...names.flatMap((n) => [...str('env'), ...str(n), 0x00, 0x00])]);
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...types, ...imports]);
}

describe('wasm', () => {
  it('flags gas-key and global-contract imports', () => {
    const names = [
      'promise_batch_action_add_gas_key_with_full_access',
      'promise_batch_action_add_gas_key_with_function_call',
      'promise_batch_action_use_global_contract',
      'promise_batch_action_use_global_contract_by_account_id',
      'promise_batch_action_deploy_global_contract',
      'promise_batch_action_add_key_with_full_access',
      'promise_batch_action_add_key_with_function_call',
      'promise_batch_action_deploy_contract',
      'promise_batch_action_delete_account',
      'promise_batch_action_transfer',
      'promise_batch_action_function_call_weight',
      'promise_batch_create',
    ];
    const imports = wasmImports(moduleImporting(names));
    expect(imports.map((i) => i.name)).toEqual(names);
    const forbidden = imports.filter((i) => i.module === 'env' && FORBIDDEN_IMPORT_RE.test(i.name)).map((i) => i.name);
    expect(forbidden).toEqual(names.slice(0, 9));
  });

  it('code hash is base58(sha256)', () => {
    // sha256("") = e3b0c442…b855
    expect(codeHashB58(new Uint8Array())).toBe('GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn');
  });
});
