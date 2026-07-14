# Runbook 03 — Hot-float refill (cold → hot)

**Trigger:** a `float-low` alert (available hot float below the refill threshold,
default 20% of the cap), or `reserves-shortfall`, or a `float-over-cap`.

The hot dispenser ATA holds a bounded float (default cap **500k ARIO**, ~1% of
liabilities). When claims draw it down, top it up from the **cold** authority /
reserve. The hot key's worst-case loss is the float + the ANTs, never the pool —
this bound only holds if you keep the float small and top up manually.

## Decision

Read the live float:
```bash
yarn --silent ops:metrics | jq '.snapshot.float, {alerts: .alerts}'
# balanceMario / availableMario / capMario / refillNeeded / overCap
```

| Signal | Action |
|---|---|
| `refillNeeded: true` (available < threshold) | **top up** (below) |
| `overCap: true` (balance > cap) | **sweep** the excess back to cold (reverse transfer) |
| `reserves-shortfall` critical | top up enough that reserves ≥ liabilities, and freeze if you can't cover |

## Top-up procedure (4-eyes)

1. **Compute the amount.** Target the float back to ~cap, but never exceed it:
   `topUp = capMario − balanceMario` (leave headroom; do not overshoot the cap or
   you trip `float-over-cap`). Sanity-check against the outstanding liability
   (`yarn --silent ops:metrics | jq '.snapshot.liabilities'`).
2. **Two operators.** One prepares, one reviews the destination = the **treasury
   ATA** (the ATA of `TREASURY_ADDRESS` for `ARIO_MINT`) and the amount. A wrong
   destination here is a fund loss.
3. **Transfer from cold.** The cold source is the migration authority / cold
   reserve (Bitwarden 4-eyes, → Squads per ADR-026). Sign an SPL transfer of
   `topUp` mARIO from the cold ATA to the treasury ATA. (Use the authority's
   normal signing path — this service does **not** hold the cold key.)
4. **Verify on-chain.** Re-read the float:
   ```bash
   yarn --silent ops:metrics | jq '.snapshot.float'
   # balanceMario back near cap; refillNeeded=false; overCap=false
   ```
5. **Audit.** Record the transfer tx signature + operators in the ops log. (The
   top-up is a cold-side action; it is not a claim, so it is not in the service
   audit_log — keep an external 4-eyes record.)

## Sweep-excess procedure (over-cap)

If the hot balance somehow exceeds the cap (operator overfunded, or a top-up
overshot): transfer the excess (`balanceMario − capMario`) from the treasury ATA
back to the cold reserve, signed by the treasury key. Do this promptly — the
whole point of the cap is to bound the hot key's blast radius.

## Notes

- **Never** raise the cap to avoid refilling. The cap is a security control, not a
  convenience knob. If claim volume genuinely needs a bigger float, that is an
  operator decision reviewed against the compromise-blast-radius, not an on-call
  reflex.
- Refills are **manual by design** — there is no auto-drain from cold. A
  compromised service must not be able to pull from the cold pool.
- The worker also logs `REFILL NEEDED` each tick when the float is low; the
  `ops:metrics` cron is the primary pager.
