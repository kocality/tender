import { pathToFileURL } from "node:url";
import { accessKey, intentsPublicKeys } from "./lib/chain.js";
import { parseCommon } from "./lib/cli.js";
import { publicKeyOf, resolveKey } from "./lib/keys.js";
import { fromUnits } from "./lib/units.js";

const usage = `usage:
  tsx scripts/keys.ts where --account <id> [--network mainnet] [--public-key ed25519:...]   # key file path and public key (never the secret)
  tsx scripts/keys.ts allowance --account <id> --public-key ed25519:... [--network]          # access key kind and allowance in NEAR
  tsx scripts/keys.ts intents-keys --account <id> [--network]                                # intents.near public_keys_of`;

export async function main(argv: string[]): Promise<number> {
  const { common, values, positionals } = parseCommon(argv, { account: { type: "string" }, "public-key": { type: "string" } });
  const account = values.account as string | undefined;
  const pk = values["public-key"] as string | undefined;
  const sub = positionals[0];
  if (!account || !sub) {
    console.error(usage);
    return 2;
  }
  try {
    if (sub === "where") {
      const k = resolveKey(common.network, account, { publicKey: pk });
      console.log(`${account} (${common.network}) key source: ${k.source}\npublic key: ${publicKeyOf(k.privateKey)}`);
      return 0;
    }
    if (sub === "allowance") {
      if (!pk) throw new Error("--public-key is required");
      const k = await accessKey(common.network, account, pk);
      if (!k) console.log(`${account} has no access key ${pk} on ${common.network}`);
      else if (k.kind === "full") console.log(`${pk}: full access (no allowance)`);
      else {
        console.log(`${pk}: function-call receiver=${k.receiver} methods=${(k.methods ?? []).join(",") || "(any)"} allowance=${k.allowance === null ? "unlimited" : `${fromUnits(k.allowance, 24)} NEAR`}`);
      }
      return 0;
    }
    if (sub === "intents-keys") {
      const intents = process.env.INTENTS_CONTRACT_ID ?? "intents.near";
      const keys = await intentsPublicKeys(common.network, intents, account);
      console.log(keys.length ? `${intents} public keys of ${account}:\n${keys.join("\n")}` : `${intents} has no public key for ${account}`);
      return 0;
    }
    console.error(usage);
    return 2;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
