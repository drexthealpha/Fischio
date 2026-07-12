# Local validator for the exchange (CLOB) suite. Only the exchange program is needed;
# the order book trades any two SPL mints, so no oracle is required here.
$bin = "$env:USERPROFILE\agave-2.3.3\solana-release\bin"
$mint = & "$bin\solana-keygen.exe" pubkey day1\devnet-wallet.json
& "$bin\solana-test-validator.exe" --reset --ledger test-ledger-exchange --mint $mint `
  --bpf-program 7PtxtGEGwBsSNRcRDsP4pedkQkzpGLZNv92Ndc9WwgrE target\sbf-solana-solana\release\fischio_exchange.so `
  --rpc-port 8899 --quiet
