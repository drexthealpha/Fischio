# Local validator for the market suite: the fischio-market program plus the real cloned
# txoracle program and daily-roots accounts. Genesis-funds the day1 wallet so tests have SOL.
$bin = "$env:USERPROFILE\agave-2.3.3\solana-release\bin"
$mint = & "$bin\solana-keygen.exe" pubkey day1\devnet-wallet.json
& "$bin\solana-test-validator.exe" --reset --ledger test-ledger-market --mint $mint `
  --bpf-program AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ target\sbf-solana-solana\release\fischio_market.so `
  --bpf-program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J test-fixtures\txoracle.so `
  --account FNLRxCxRf3idEDyixYg8uHj9xEVJSuqHvStxwRHf7k6e test-fixtures\roots-20636.json `
  --account 69SexUQvQ9uNpyx6bgDLVoQ5uKkbn3uRxZXCJ5KVZ7QL test-fixtures\roots-20635.json `
  --account BcLwqHJehs8ut8ycRo6NhCGsrtmRnkZbFMm273SdcPGe test-fixtures\roots-20634.json `
  --rpc-port 8899 --quiet
