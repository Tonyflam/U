#!/usr/bin/env python3
"""
Move USDC between Hyperliquid spot and perps using a USD class transfer.
Works even when the UI hides the explicit transfer button under unified-account mode.

Run:
  export HL_PRIVATE_KEY=0x...
  export HL_NETWORK=mainnet
  python3 scripts/spot_to_perp.py 50      # transfer 50 USDC spot -> perps
  python3 scripts/spot_to_perp.py -50     # 50 USDC perps -> spot

Verify with:
  curl -s https://api.hyperliquid.xyz/info \
    -H 'Content-Type: application/json' \
    -d '{"type":"clearinghouseState","user":"<your wallet>"}'
"""
from __future__ import annotations

import os
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("Usage: spot_to_perp.py <amount>   (positive = spot->perps, negative = perps->spot)\n")
        return 2
    try:
        amount = float(sys.argv[1])
    except ValueError:
        sys.stderr.write("amount must be a number\n")
        return 2

    pk = os.environ.get("HL_PRIVATE_KEY")
    if not pk:
        sys.stderr.write("HL_PRIVATE_KEY not set\n")
        return 2
    if not pk.startswith("0x"):
        pk = "0x" + pk

    network = os.environ.get("HL_NETWORK", "mainnet").lower()
    base_url = constants.MAINNET_API_URL if network == "mainnet" else constants.TESTNET_API_URL

    wallet = Account.from_key(pk)
    print(f"Wallet : {wallet.address}")
    print(f"Network: {network}")
    print(f"Amount : {amount} USDC ({'spot->perps' if amount > 0 else 'perps->spot'})")

    exchange = Exchange(wallet, base_url=base_url)

    fn = (
        getattr(exchange, "usd_class_transfer", None)
        or getattr(exchange, "usdClassTransfer", None)
    )
    if fn is None:
        sys.stderr.write("SDK has no usd_class_transfer method; upgrade hyperliquid-python-sdk\n")
        return 3

    # SDK signature: usd_class_transfer(amount: float, to_perp: bool)
    to_perp = amount > 0
    abs_amt = abs(amount)
    try:
        result = fn(abs_amt, to_perp)
    except TypeError:
        # older sigs may take (str, bool)
        result = fn(str(abs_amt), to_perp)

    print("Response:", result)
    if isinstance(result, dict) and result.get("status") != "ok":
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
