use stellar_confidential_lib::{commit, poseidon_with_domain};

global DOMAIN_POSITION_NULLIFIER: Field = 30;

// Public inputs, in canonical order consumed by PrefundingCreditLine:
// 0  collateral_commitment_x
// 1  collateral_commitment_y
// 2  credit_commitment_x
// 3  credit_commitment_y
// 4  oracle_price_e7
// 5  haircut_bps
// 6  tenor_days
// 7  lock_key
// 8  position_nullifier
//
// Private witnesses:
// - hidden collateral and requested credit amounts
// - Pedersen randomness for both commitments
// - position_secret, which prevents third parties from precomputing nullifiers
fn main(
    collateral_amount: u128,
    collateral_randomness: Field,
    credit_amount: u128,
    credit_randomness: Field,
    position_secret: Field,
    collateral_commitment_x: pub Field,
    collateral_commitment_y: pub Field,
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

    let collateral_commitment = commit(collateral_amount as Field, collateral_randomness);
    assert(collateral_commitment.x == collateral_commitment_x);
    assert(collateral_commitment.y == collateral_commitment_y);

    let credit_commitment = commit(credit_amount as Field, credit_randomness);
    assert(credit_commitment.x == credit_commitment_x);
    assert(credit_commitment.y == credit_commitment_y);

    assert(oracle_price_e7 > 0);
    assert(haircut_bps <= 10_000);
    assert(tenor_days > 0);
    assert(tenor_days <= 5);

    let effective_bps = 10_000 - (haircut_bps as u128);
    let collateral_value = collateral_amount * oracle_price_e7 * effective_bps;
    let required_value = credit_amount * 10_000 * 10_000_000;
    assert(collateral_value >= required_value);

    let derived_nullifier = poseidon_with_domain(
        DOMAIN_POSITION_NULLIFIER,
        [
            position_secret,
            collateral_commitment_x,
            collateral_commitment_y,
            credit_commitment_x,
            credit_commitment_y,
            lock_key,
            tenor_days as Field,
        ],
    );
    assert(derived_nullifier == position_nullifier);
}
