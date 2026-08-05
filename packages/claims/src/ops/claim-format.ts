//! Shared, operator-readable formatting for a claim in Slack messages, so the
//! pending-review ping, the approval ping, and the dispense-success ping all render
//! the SAME useful summary: asset type, ARIO amount (token/vault) or ArNS name (ANT),
//! the FULL Solana destination, and who proved ownership. Pure (unit-testable).

/** Integer mARIO -> human ARIO decimal string (trailing zeros trimmed). */
export function marioToArioStr(mario: string): string {
  const ONE = 1_000_000n;
  const m = BigInt(mario);
  const whole = m / ONE;
  const frac = (m % ONE).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export interface ClaimSummary {
  assetType: string; // 'token' | 'vault' | 'ant'
  amountMario: string | null; // token/vault mARIO; null for ANT
  antName: string | null; // ArNS name (ANT), if known
  antMint: string | null; // ANT mint (fallback when no name)
  claimant: string; // Solana destination (full — operators must see the whole address)
  protocol: number; // 0 arweave, 1 ethereum
  sourceAddress: string; // the identity that proved ownership
}

/** "Token — 5 ARIO" / "Vault — N ARIO" / "ANT — ArNS “name”" (or mint fallback). */
export function assetDescriptor(c: Pick<ClaimSummary, "assetType" | "amountMario" | "antName" | "antMint">): string {
  if (c.assetType === "ant") {
    const id = c.antName
      ? `ArNS “${c.antName}”`
      : c.antMint
        ? `mint ${c.antMint.slice(0, 6)}…${c.antMint.slice(-4)}`
        : "ANT";
    return `ANT — ${id}`;
  }
  const amt = c.amountMario ? `${marioToArioStr(c.amountMario)} ARIO` : "(amount n/a)";
  return `${c.assetType === "vault" ? "Vault" : "Token"} — ${amt}`;
}

/** The shared body bullet lines: what · to · from. */
export function claimSummaryLines(c: ClaimSummary): string {
  const proto = c.protocol === 1 ? "Ethereum" : "Arweave";
  const src =
    c.sourceAddress.length > 16 ? `${c.sourceAddress.slice(0, 8)}…${c.sourceAddress.slice(-6)}` : c.sourceAddress;
  return [`• ${assetDescriptor(c)}`, `• To: ${c.claimant}`, `• From: ${src} (${proto})`].join("\n");
}

/** True for ANTs, which are dispatched via the operator /admin panel, not the worker. */
export function isAnt(assetType: string): boolean {
  return assetType === "ant";
}

// ---------------------------------------------------------------------------
// Slack message composers (pure — the CLI/API/worker import these). All three
// render the SAME claim summary so an operator reads one consistent format.
// ---------------------------------------------------------------------------

/** 🟡 A claim just landed in `pending_review` — the operator must approve it. */
export function composePendingReviewSlackMessage(c: ClaimSummary & { claimId: string }): { text: string } {
  const extra = isAnt(c.assetType) ? " — then build + sign the batch in /admin" : "";
  return {
    text: `🟡 New claim awaiting approval\n${claimSummaryLines(c)}\n• Approve: \`dispatch:approve ${c.claimId}\`${extra}`,
  };
}

/** ✅ An operator approved a claim (next: worker dispenses, or /admin for ANTs). */
export function composeApprovalSlackMessage(claimId: string, approvedBy: string, c: ClaimSummary): { text: string } {
  const next = isAnt(c.assetType)
    ? "• Next: build + sign the batch in /admin"
    : "• Dispensing now — the worker will transfer + confirm on-chain";
  return {
    text: `✅ Claim ${claimId.slice(0, 8)} approved by ${approvedBy}\n${claimSummaryLines(c)}\n${next}`,
  };
}

/** ✅ A token/vault claim finished dispensing on-chain (worker success). */
export function composeDispensedSlackMessage(
  claimId: string,
  c: ClaimSummary,
  signature: string,
  cluster: "solana-mainnet" | "solana-devnet" | string,
): { text: string } {
  const suffix = cluster === "solana-devnet" ? "?cluster=devnet" : "";
  return {
    text:
      `💸 Dispensed — claim ${claimId.slice(0, 8)}\n${claimSummaryLines(c)}\n` +
      `• tx: https://explorer.solana.com/tx/${signature}${suffix}`,
  };
}
