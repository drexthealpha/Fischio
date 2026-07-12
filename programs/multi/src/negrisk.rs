//! Pure accounting model for a multi-outcome (NegRisk) market, used to prove solvency
//! before the on-chain program moves any money.
//!
//! A market has N mutually-exclusive outcomes; exactly one resolves YES. Each outcome i
//! has its own YES_i and NO_i tokens. 1 collateral splits into 1 YES_i + 1 NO_i. The
//! capital-efficient primitive is `convert`: burning NO on a subset S of outcomes is
//! identically worth (|S|-1) collateral plus YES on every outcome NOT in S. That identity
//! is why holding NO on many outcomes needs far less collateral than the naive sum.
//!
//! Solvency guarantee, proven by the property test: for EVERY possible winner w, the vault
//! always covers the total payout (YES_w plus every other outcome's NO). split, merge, and
//! convert each leave that slack unchanged, so a market can never resolve insolvent.

pub const MAX_OUTCOMES: usize = 16;

#[derive(Clone)]
pub struct Ledger {
    pub n: usize,
    pub vault: u128,
    pub yes: [u128; MAX_OUTCOMES],
    pub no: [u128; MAX_OUTCOMES],
}

impl Ledger {
    pub fn new(n: usize) -> Self {
        Self { n, vault: 0, yes: [0; MAX_OUTCOMES], no: [0; MAX_OUTCOMES] }
    }

    /// 1 collateral -> 1 YES_i + 1 NO_i.
    pub fn split(&mut self, i: usize, amt: u128) {
        self.vault += amt;
        self.yes[i] += amt;
        self.no[i] += amt;
    }

    /// Burn 1 YES_i + 1 NO_i -> 1 collateral.
    pub fn merge(&mut self, i: usize, amt: u128) -> bool {
        if self.yes[i] < amt || self.no[i] < amt || self.vault < amt {
            return false;
        }
        self.yes[i] -= amt;
        self.no[i] -= amt;
        self.vault -= amt;
        true
    }

    /// NegRisk convert: burn `amt` NO on each outcome in `set` (size k >= 2), receive
    /// (k-1)*amt collateral and `amt` YES on every outcome not in `set`.
    pub fn convert(&mut self, set: &[usize], amt: u128) -> bool {
        let k = set.len();
        if k < 2 || k > self.n {
            return false;
        }
        for &i in set {
            if i >= self.n || self.no[i] < amt {
                return false;
            }
        }
        let release = (k as u128 - 1) * amt;
        if self.vault < release {
            return false;
        }
        for &i in set {
            self.no[i] -= amt;
        }
        for j in 0..self.n {
            if !set.contains(&j) {
                self.yes[j] += amt;
            }
        }
        self.vault -= release;
        true
    }

    /// The payout owed if outcome `w` wins: YES_w pays 1 each, and every OTHER outcome's
    /// NO pays 1 each (those outcomes did not happen).
    pub fn payout_if(&self, w: usize) -> u128 {
        let mut p = self.yes[w];
        for i in 0..self.n {
            if i != w {
                p += self.no[i];
            }
        }
        p
    }

    /// Solvency slack for the worst-case winner. Must never be negative.
    pub fn min_slack(&self) -> i128 {
        let mut worst = i128::MAX;
        for w in 0..self.n {
            let s = self.vault as i128 - self.payout_if(w) as i128;
            if s < worst {
                worst = s;
            }
        }
        worst
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // deterministic LCG so the property test is reproducible
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 16
        }
        fn range(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[test]
    fn convert_identity_holds_for_full_set() {
        // split 1 unit on all 4 outcomes, then convert all NO -> (4-1) collateral back
        let mut l = Ledger::new(4);
        for i in 0..4 {
            l.split(i, 100);
        }
        assert_eq!(l.vault, 400);
        assert!(l.convert(&[0, 1, 2, 3], 100));
        // burned all NO, minted no YES (complement empty), released 3*100
        assert_eq!(l.vault, 100);
        for i in 0..4 {
            assert_eq!(l.no[i], 0);
        }
        assert!(l.min_slack() >= 0, "solvent after full convert");
    }

    #[test]
    fn convert_partial_set_mints_complement_yes() {
        let mut l = Ledger::new(4);
        for i in 0..4 {
            l.split(i, 100);
        }
        // convert NO on {0,1}: release (2-1)*50 = 50, mint 50 YES on {2,3}
        assert!(l.convert(&[0, 1], 50));
        assert_eq!(l.no[0], 50);
        assert_eq!(l.no[1], 50);
        assert_eq!(l.yes[2], 150);
        assert_eq!(l.yes[3], 150);
        assert_eq!(l.vault, 350);
        assert!(l.min_slack() >= 0);
    }

    #[test]
    fn redemption_is_always_covered() {
        let mut l = Ledger::new(5);
        for i in 0..5 {
            l.split(i, 1000);
        }
        l.convert(&[0, 1, 2], 400);
        // whichever outcome wins, the vault covers the payout
        for w in 0..5 {
            assert!(l.vault >= l.payout_if(w), "winner {w} payout must be covered");
        }
    }

    #[test]
    fn solvency_holds_across_random_operations() {
        // hammer the ledger with thousands of random split/merge/convert ops; solvency
        // must hold after every single one
        let mut rng = Rng(0x1234_5678_9abc_def0);
        for outcomes in 2..=8usize {
            let mut l = Ledger::new(outcomes);
            for _ in 0..2000 {
                match rng.range(3) {
                    0 => {
                        let i = rng.range(outcomes as u64) as usize;
                        l.split(i, 1 + rng.range(1000) as u128);
                    }
                    1 => {
                        let i = rng.range(outcomes as u64) as usize;
                        l.merge(i, 1 + rng.range(1000) as u128);
                    }
                    _ => {
                        // random subset of size >= 2
                        let mut set: Vec<usize> = (0..outcomes).collect();
                        // shuffle-ish: rotate and truncate
                        let cut = 2 + rng.range((outcomes - 1) as u64) as usize;
                        for a in 0..outcomes {
                            let b = rng.range(outcomes as u64) as usize;
                            set.swap(a, b);
                        }
                        set.truncate(cut.min(outcomes));
                        l.convert(&set, 1 + rng.range(500) as u128);
                    }
                }
                assert!(l.min_slack() >= 0, "insolvent after op with {outcomes} outcomes");
            }
        }
    }
}
