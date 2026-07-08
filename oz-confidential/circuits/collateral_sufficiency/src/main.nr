use stellar_confidential_lib::{commit, poseidon_with_domain, scalar_mul, H};

mod tests;

global DOMAIN_POSITION_NULLIFIER: Field = 30;

// Collateral sufficiency circuit -- v2 (bound to real on-chain state).
//
// v1 proved only "I know a collateral number >= a credit number". The collateral
// commitment was a free witness, so it proved nothing about a real balance.
//
// v2 binds the proof to the anchor's actual confidential-token account:
//
//   * `c_spend` (public input 0/1) is the anchor's REAL spendable-balance
//     commitment. The `PrefundingCreditLine` contract loads it from the
//     confidential token's `ConfidentialAccount.spendable_balance` and passes it
//     as a public input -- the prover cannot supply an invented commitment.
//   * `Y` (public input 2/3) is the account's spending public key, also loaded
//     from `ConfidentialAccount.spending_key`. Proving `Y = sk * H` for a secret
//     `sk` proves the prover OWNS that account, so a borrower cannot pledge a
//     balance they do not control.
//   * The opened value `collateral_amount` is therefore forced to be the true
//     opening of the real balance (Pedersen binding), and the sufficiency check
//     runs against that real value.
//
// NOTE: this proves the anchor's total spendable balance is sufficient. It is the
// F1/C1 soundness fix. Segregating/encumbering that balance so it cannot be spent
// while the credit is open is the escrow milestone (F2) and is enforced by the
// contract layer, not this circuit.
//
// Public inputs, in canonical order consumed by PrefundingCreditLine:
// 0  c_spend_x               (anchor spendable_balance commitment .x)
// 1  c_spend_y               (anchor spendable_balance commitment .y)
// 2  y_x                     (anchor spending_key .x)
// 3  y_y                     (anchor spending_key .y)
// 4  credit_commitment_x
// 5  credit_commitment_y
// 6  oracle_price_e7
// 7  haircut_bps
// 8  tenor_days
// 9  lock_key
// 10 position_nullifier
//
// Private witnesses:
// - sk                       spending secret; proves ownership, never revealed
// - collateral_amount, collateral_randomness   opening of the real balance commitment
// - credit_amount, credit_randomness           opening of the credit commitment
// - position_secret          prevents third parties from precomputing nullifiers
fn main(
    sk: Field,
    collateral_amount: u128,
    collateral_randomness: Field,
    credit_amount: u128,
    credit_randomness: Field,
    position_secret: Field,
    c_spend_x: pub Field,
    c_spend_y: pub Field,
    y_x: pub Field,
    y_y: pub Field,
    credit_commitment_x: pub Field,
    credit_commitment_y: pub Field,
    oracle_price_e7: pub u128,
    haircut_bps: pub u32,
    tenor_days: pub u32,
    lock_key: pub Field,
    position_nullifier: pub Field,
) {
    assert(credit_amount > 0);
    assert(collateral_amount > 0);

    // Ownership: the prover controls the spending key `Y` of the account whose
    // balance is being pledged. `sk != 0` rules out the identity point.
    assert(sk != 0);
    let y = scalar_mul(sk, H);
    assert(y.x == y_x);
    assert(y.y == y_y);

    // The collateral commitment is the account's REAL spendable balance,
    // supplied by the contract from ledger state. Opening it forces
    // `collateral_amount` to be the true balance value (Pedersen binding).
    let c_spend = commit(collateral_amount as Field, collateral_randomness);
    assert(c_spend.x == c_spend_x);
    assert(c_spend.y == c_spend_y);

    let credit_commitment = commit(credit_amount as Field, credit_randomness);
    assert(credit_commitment.x == credit_commitment_x);
    assert(credit_commitment.y == credit_commitment_y);

    assert(oracle_price_e7 > 0);
    assert(haircut_bps <= 10_000);
    assert(tenor_days > 0);
    assert(tenor_days <= 5);

    // Sufficiency on the REAL balance. u128 multiplication is overflow-checked by
    // Noir, so an overflow makes the proof unsatisfiable rather than wrapping to a
    // false positive.
    let effective_bps = 10_000 - (haircut_bps as u128);
    let collateral_value = collateral_amount * oracle_price_e7 * effective_bps;
    let required_value = credit_amount * 10_000 * 10_000_000;
    assert(collateral_value >= required_value);

    let derived_nullifier = poseidon_with_domain(
        DOMAIN_POSITION_NULLIFIER,
        [
            position_secret,
            c_spend_x,
            c_spend_y,
            credit_commitment_x,
            credit_commitment_y,
            lock_key,
            tenor_days as Field,
        ],
    );
    assert(derived_nullifier == position_nullifier);
}
