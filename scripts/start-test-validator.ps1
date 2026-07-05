# Local validator with cloned devnet oracle state:
#  - txoracle program (dumped ELF) at its devnet address
#  - wc_settle at its declared address (no deploy rent needed)
#  - daily scores roots accounts for epoch days 20635/20636 (the saved real proofs)
$bin = "$env:USERPROFILE\.local\share\solana\install\active_release\bin"
& "$bin\solana-test-validator.exe" --reset --quiet `
  --ledger .test-ledger `
  --bpf-program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J test-fixtures\txoracle.so `
  --bpf-program FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb target\deploy\wc_settle.so `
  --account 69SexUQvQ9uNpyx6bgDLVoQ5uKkbn3uRxZXCJ5KVZ7QL test-fixtures\roots-20635.json `
  --account FNLRxCxRf3idEDyixYg8uHj9xEVJSuqHvStxwRHf7k6e test-fixtures\roots-20636.json
