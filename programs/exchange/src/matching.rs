//! Price-time-priority matching for a fully on-chain, permissionless order book.
//!
//! Pure and integer-only, so the matching logic is deterministic and unit-tested with no
//! chain. The order book is a bounded, sorted list per side. A resting book is held sorted
//! best-price-first (bids descending, asks ascending); within a price, earlier `seq` wins.
//! Matching walks the opposite side from the best price and fills at the MAKER's price,
//! which is the rule that makes a limit order book fair: you never do worse than your limit,
//! and a resting order always trades at the price it posted.
//!
//! Prices are quote units per share in (0, PRICE_ONE]; PRICE_ONE = 1.0 = certainty.

pub const PRICE_ONE: u64 = 1_000_000; // 1.0 with 6 decimals; also the max valid price
pub const MAX_ORDERS: usize = 64; // bounded depth per side keeps matching inside the CU budget

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid, // buy the outcome, escrow quote (USDC)
    Ask, // sell the outcome, escrow base (outcome tokens)
}

/// One resting order, reduced to what matching needs. The on-chain layer carries the
/// owner and escrow alongside; matching only touches price, size, and time.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Level {
    pub id: u64,
    pub price: u64, // quote per share
    pub size: u64,  // base shares still open
    pub seq: u64,   // time priority: lower is older
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fill {
    pub maker_id: u64,
    pub price: u64, // always the maker's resting price
    pub size: u64,  // base shares traded
}

/// Would a taker on `taker_side` at `price` cross the best resting order on the opposite
/// side? Bids cross asks priced at or below; asks cross bids priced at or above.
fn crosses(taker_side: Side, taker_price: u64, maker_price: u64) -> bool {
    match taker_side {
        Side::Bid => taker_price >= maker_price,
        Side::Ask => taker_price <= maker_price,
    }
}

/// Match an incoming order (`taker_side`, `price`, `size`) against the opposite book, which
/// MUST already be sorted best-first for that side. Returns the fills and the unfilled size
/// that should rest. Fully-filled makers are removed from `opposite`; a partial maker keeps
/// its place with reduced size (time priority preserved).
pub fn match_incoming(
    opposite: &mut Vec<Level>,
    taker_side: Side,
    price: u64,
    mut size: u64,
) -> (Vec<Fill>, u64) {
    let mut fills = Vec::new();
    while size > 0 {
        let best = match opposite.first() {
            Some(o) => *o,
            None => break,
        };
        if !crosses(taker_side, price, best.price) {
            break;
        }
        let traded = size.min(best.size);
        fills.push(Fill { maker_id: best.id, price: best.price, size: traded });
        size -= traded;
        if traded == best.size {
            opposite.remove(0); // maker fully filled
        } else {
            opposite[0].size -= traded; // partial fill keeps its priority
            // size is now 0 (we could not exceed best.size), so the loop ends next check
        }
    }
    (fills, size)
}

/// Insert a resting order into its own side, keeping best-first order with time priority on
/// ties. Returns false if the book is at capacity (the caller rejects the order).
pub fn insert_resting(book: &mut Vec<Level>, side: Side, order: Level) -> bool {
    if book.len() >= MAX_ORDERS {
        return false;
    }
    let pos = book.iter().position(|o| match side {
        // better price first; equal price, older (smaller seq) first
        Side::Bid => o.price < order.price || (o.price == order.price && o.seq > order.seq),
        Side::Ask => o.price > order.price || (o.price == order.price && o.seq > order.seq),
    });
    match pos {
        Some(i) => book.insert(i, order),
        None => book.push(order),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asks(v: &[(u64, u64, u64)]) -> Vec<Level> {
        // (id, price, size), pre-sorted ascending by price for the ask book
        v.iter().map(|&(id, price, size)| Level { id, price, size, seq: id }).collect()
    }

    #[test]
    fn bid_fully_crosses_one_ask() {
        let mut book = asks(&[(1, 600_000, 100)]); // ask 100 @ 0.60
        let (fills, rest) = match_incoming(&mut book, Side::Bid, 650_000, 100);
        assert_eq!(fills, vec![Fill { maker_id: 1, price: 600_000, size: 100 }]);
        assert_eq!(rest, 0);
        assert!(book.is_empty());
    }

    #[test]
    fn taker_pays_the_maker_price_not_its_own() {
        // bidder willing to pay 0.65 crosses a 0.60 ask: they trade at 0.60, the maker price
        let mut book = asks(&[(1, 600_000, 50)]);
        let (fills, _) = match_incoming(&mut book, Side::Bid, 650_000, 50);
        assert_eq!(fills[0].price, 600_000);
    }

    #[test]
    fn walks_the_book_best_price_first() {
        let mut book = asks(&[(1, 600_000, 40), (2, 610_000, 40), (3, 700_000, 40)]);
        let (fills, rest) = match_incoming(&mut book, Side::Bid, 650_000, 100);
        // fills 40@0.60, 40@0.61, then stops (0.70 ask is above the 0.65 limit); 20 rests
        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0], Fill { maker_id: 1, price: 600_000, size: 40 });
        assert_eq!(fills[1], Fill { maker_id: 2, price: 610_000, size: 40 });
        assert_eq!(rest, 20);
        assert_eq!(book.len(), 1); // only the 0.70 ask remains
    }

    #[test]
    fn partial_fill_of_a_maker_keeps_its_priority() {
        let mut book = asks(&[(1, 600_000, 100)]);
        let (fills, rest) = match_incoming(&mut book, Side::Bid, 600_000, 30);
        assert_eq!(fills[0].size, 30);
        assert_eq!(rest, 0);
        assert_eq!(book[0].size, 70); // 70 still resting, same order
    }

    #[test]
    fn no_cross_when_prices_do_not_meet() {
        let mut book = asks(&[(1, 700_000, 100)]);
        let (fills, rest) = match_incoming(&mut book, Side::Bid, 600_000, 100);
        assert!(fills.is_empty());
        assert_eq!(rest, 100); // nothing traded; all of it would rest
    }

    #[test]
    fn ask_crosses_bids_from_the_highest() {
        // bid book sorted descending: 0.55 then 0.50
        let mut bids = vec![
            Level { id: 1, price: 550_000, size: 60, seq: 1 },
            Level { id: 2, price: 500_000, size: 60, seq: 2 },
        ];
        let (fills, rest) = match_incoming(&mut bids, Side::Ask, 520_000, 100);
        // sell at 0.52: crosses the 0.55 bid (60), stops at 0.50 (below limit); 40 rests
        assert_eq!(fills, vec![Fill { maker_id: 1, price: 550_000, size: 60 }]);
        assert_eq!(rest, 40);
    }

    #[test]
    fn insert_keeps_price_then_time_priority() {
        let mut book: Vec<Level> = vec![];
        assert!(insert_resting(&mut book, Side::Bid, Level { id: 1, price: 500_000, size: 10, seq: 1 }));
        assert!(insert_resting(&mut book, Side::Bid, Level { id: 2, price: 600_000, size: 10, seq: 2 }));
        assert!(insert_resting(&mut book, Side::Bid, Level { id: 3, price: 600_000, size: 10, seq: 3 }));
        // best bid (0.60) first; among equal 0.60, the older seq (id 2) before id 3
        assert_eq!(book[0].id, 2);
        assert_eq!(book[1].id, 3);
        assert_eq!(book[2].id, 1);
    }

    #[test]
    fn book_rejects_when_full() {
        let mut book: Vec<Level> = (0..MAX_ORDERS as u64)
            .map(|i| Level { id: i, price: 500_000, size: 1, seq: i })
            .collect();
        assert!(!insert_resting(&mut book, Side::Bid, Level { id: 999, price: 900_000, size: 1, seq: 999 }));
    }
}
