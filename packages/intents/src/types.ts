export type TokenAmounts = Record<string, string>; // amounts are decimal strings (C4)

export interface TransferIntent {
  intent: 'transfer';
  receiver_id: string;
  tokens: TokenAmounts;
  memo?: string;
  msg?: string;
  min_gas?: string;
}

export interface DefusePayload {
  signer_id: string;
  verifying_contract: string;
  deadline: string; // RFC 3339, whole seconds: "…:SS.000Z"
  nonce: string; // base64 of the 32-byte versioned nonce
  intents: TransferIntent[];
}

export type MultiPayload =
  | { standard: 'erc191'; payload: string; signature: string } // "secp256k1:<b58 65 B>"
  | { standard: 'raw_ed25519'; payload: string; public_key: string; signature: string } // "ed25519:<b58>"
  | {
      standard: 'nep413';
      payload: { message: string; nonce: string; recipient: string; callbackUrl?: string };
      public_key: string;
      signature: string;
    };

export type IntentsErrorKind =
  | 'insufficient_balance'
  | 'invalid_signature'
  | 'public_key_not_registered'
  | 'deadline_expired'
  | 'deadline_gt_nonce'
  | 'nonce_used'
  | 'nonce_expired'
  | 'invalid_nonce'
  | 'invalid_salt'
  | 'wrong_verifying_contract'
  | 'other';
