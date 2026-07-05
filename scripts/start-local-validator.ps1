# Local validator with the real devnet txoracle program + real daily-roots PDAs cloned.
# Run from repo root. Ledger is wiped each start (--reset) for deterministic tests.
$bin = "$env:USERPROFILE\agave-2.3.3\solana-release\bin"
$mint = & "$bin\solana-keygen.exe" pubkey day1\devnet-wallet.json
& "$bin\solana-test-validator.exe" --reset --ledger test-ledger --mint $mint `
  --bpf-program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J test-fixtures\txoracle.so `
  --account FNLRxCxRf3idEDyixYg8uHj9xEVJSuqHvStxwRHf7k6e test-fixtures\roots-20636.json `
  --account 69SexUQvQ9uNpyx6bgDLVoQ5uKkbn3uRxZXCJ5KVZ7QL test-fixtures\roots-20635.json `
  --account BcLwqHJehs8ut8ycRo6NhCGsrtmRnkZbFMm273SdcPGe test-fixtures\roots-20634.json `
  --quiet
