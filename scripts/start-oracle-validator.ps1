# Local validator for the optimistic oracle suite. Only the oracle program is needed; it
# does not depend on TxLINE, since it resolves by dispute and bond, not by proof.
$bin = "$env:USERPROFILE\agave-2.3.3\solana-release\bin"
$mint = & "$bin\solana-keygen.exe" pubkey day1\devnet-wallet.json
& "$bin\solana-test-validator.exe" --reset --ledger test-ledger-oracle --mint $mint `
  --bpf-program HUXM89x5Uxex2XfTh58i2xXzroeULgtuq7w3tT7zzYpJ target\sbf-solana-solana\release\fischio_oracle.so `
  --rpc-port 8899 --quiet
