#!/usr/bin/env python3
"""
Approve a Hyperliquid builder address to charge up to `max_fee_rate` on
your fills. Signs and submits with your wallet's private key.

Run:
  export HL_PRIVATE_KEY=0x...     # paste at terminal prompt, not in scripts
  export HL_NETWORK=mainnet       # or testnet
  export HL_BUILDER_ADDRESS=0x1CD2B147EfE092c3BdE0B474bCE3Bd33ae3dbB37
  export HL_MAX_FEE_RATE="0.001"  # 0.001 = 10 bps (HL perp cap)
  python scripts/approve_builder_fee.py

Then verify with:
  curl -s https://api.hyperliquid.xyz/info \
    -H 'Content-Type: application/json' \
    -d '{"type":"maxBuilderFee","user":"<your wallet>","builder":"<builder addr>"}'
"""
from __future__ import annotations

import os
import sys

try:
    from eth_account import Account
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils import constants
except ImportError:
    sys.stderr.write(
        "Missing deps. Install with:\n"
        "  pip install hyperliquid-python-sdk eth-account\n"
    )
    sys.exit(1)


def main() -> int:
    pk = os.environ.get("HL_PRIVATE_KEY")
    if not pk:
        sys.stderr.write("HL_PRIVATE_KEY is not set. Export it in your shell first.\n")
        return 2
    if not pk.startswith("0x"):
        pk = "0x" + pk

    network = os.environ.get("HL_NETWORK", "mainnet").lower()
    if network == "mainnet":
        base_url = constants.MAINNET_API_URL
    elif network == "testnet":
        base_url = constants.TESTNET_API_URL
    else:
        sys.stderr.write(f"HL_NETWORK must be 'mainnet' or 'testnet' (got {network!r})\n")
        return 2

    builder = os.environ.get("HL_BUILDER_ADDRESS")
    if not builder:
        sys.stderr.write("HL_BUILDER_ADDRESS is not set.\n")
        return 2
    builder = builder.lower()

    max_fee_rate = os.environ.get("HL_MAX_FEE_RATE", "0.001")  # 10 bps default
    # HL expects the rate as a decimal *string* with a trailing '%'-style scaling:
    # the SDK helper accepts a raw decimal string like "0.001" (= 0.1% = 10 bps).
    # If you want 5 bps, use "0.0005". The on-chain HL hard cap for perps is 10 bps.

    wallet = Account.from_key(pk)
    print(f"Signer wallet  : {wallet.address}")
    print(f"Builder address: {builder}")
    print(f"Max fee rate   : {max_fee_rate}  (0.001 = 10 bps)")
    print(f"Network        : {network}  ({base_url})")
    print()

    exchange = Exchange(wallet, base_url=base_url)

    # Method name has varied across SDK versions; try the common ones.
    fn = (
        getattr(exchange, "approve_builder_fee", None)
        or getattr(exchange, "approveBuilderFee", None)
    )
    if fn is None:
        sys.stderr.write(
            "Your hyperliquid-python-sdk version doesn't expose approve_builder_fee.\n"
            "Upgrade with: pip install --upgrade hyperliquid-python-sdk\n"
        )
        return 3

    # HL wants the rate as a percent string like "0.1%" (= 10 bps), not "0.001".
    as_percent = f"{float(max_fee_rate) * 100:g}%"
    print(f"Submitting as percent: {as_percent}")
    try:
        result = fn(builder, as_percent)
    except Exception as e:  # pragma: no cover - depends on SDK version
        sys.stderr.write(f"approve_builder_fee raised: {e}\n")
        return 4

    print("HL response:")
    print(result)

    status = (result or {}).get("status") if isinstance(result, dict) else None
    if status and status != "ok":
        sys.stderr.write(f"\nHL returned non-ok status: {status}\n")
        return 5
    print("\nDone. Verify with the curl below (substitute your wallet + builder):")
    print(
        f"  curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' "
        f"-d '{{\"type\":\"maxBuilderFee\",\"user\":\"{wallet.address}\","
        f"\"builder\":\"{builder}\"}}'"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
