# Local validator for the multi-outcome (NegRisk) suite: the fischio-multi program plus
# the real cloned txoracle program and daily-roots accounts.
$bin = "$env:USERPROFILE\agave-2.3.3\solana-release\bin"
$mint = & "$bin\solana-keygen.exe" pubkey day1\devnet-wallet.json
& "$bin\solana-test-validator.exe" --reset --ledger test-ledger-multi --mint $mint `
  --bpf-program 8zVnp7ivs5fSdmjYFHTLChrSzbKnDeKX6mj5nuP1CAgg target\sbf-solana-solana\release\fischio_multi.so `
  --bpf-program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J test-fixtures\txoracle.so `
  --account FNLRxCxRf3idEDyixYg8uHj9xEVJSuqHvStxwRHf7k6e test-fixtures\roots-20636.json `
  --account 69SexUQvQ9uNpyx6bgDLVoQ5uKkbn3uRxZXCJ5KVZ7QL test-fixtures\roots-20635.json `
  --account BcLwqHJehs8ut8ycRo6NhCGsrtmRnkZbFMm273SdcPGe test-fixtures\roots-20634.json `
  --rpc-port 8899 --quiet
