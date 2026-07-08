use stellar_confidential_lib::{commit, poseidon_with_domain, scalar_mul, H};
use crate::{main, DOMAIN_POSITION_NULLIFIER};

// Builds the nullifier the circuit expects for a given set of bound inputs.
fn nullifier(
    position_secret: Field,
    c_spend_x: Field,
    c_spend_y: Field,
    credit_commitment_x: Field,
    credit_commitment_y: Field,
    lock_key: Field,
    tenor_days: u32,
) -> Field {
    poseidon_with_domain(
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
    )
}

// Happy path: the prover owns the account (Y = sk*H) and its real balance
// commitment opens to enough value after haircut.
#[test]
fn accepts_sufficient_owned_collateral() {
    let sk: Field = 12345;
    let collateral_amount: u128 = 1_000_000;
    let collateral_randomness: Field = 777;
    let credit_amount: u128 = 100;
    let credit_randomness: Field = 888;
    let position_secret: Field = 999;
    let oracle_price_e7: u128 = 10_000_000;
    let haircut_bps: u32 = 2000;
    let tenor_days: u32 = 3;
    let lock_key: Field = 42;

    let y = scalar_mul(sk, H);
    let c_spend = commit(collateral_amount as Field, collateral_randomness);
    let cc = commit(credit_amount as Field, credit_randomness);
    let pn = nullifier(position_secret, c_spend.x, c_spend.y, cc.x, cc.y, lock_key, tenor_days);

    main(
        sk, collateral_amount, collateral_randomness, credit_amount, credit_randomness,
        position_secret, c_spend.x, c_spend.y, y.x, y.y, cc.x, cc.y, oracle_price_e7,
        haircut_bps, tenor_days, lock_key, pn,
    );
}

// Ownership soundness: passing a spending key that does NOT correspond to the
// witness `sk` must fail. This is what stops a borrower pledging someone else's
// balance.
#[test(should_fail)]
fn rejects_wrong_owner() {
    let sk: Field = 12345;
    let collateral_amount: u128 = 1_000_000;
    let collateral_randomness: Field = 777;
    let credit_amount: u128 = 100;
    let credit_randomness: Field = 888;
    let position_secret: Field = 999;
    let oracle_price_e7: u128 = 10_000_000;
    let haircut_bps: u32 = 2000;
    let tenor_days: u32 = 3;
    let lock_key: Field = 42;

    // Y belongs to a different account (sk = 54321), not the witness sk.
    let y = scalar_mul(54321, H);
    let c_spend = commit(collateral_amount as Field, collateral_randomness);
    let cc = commit(credit_amount as Field, credit_randomness);
    let pn = nullifier(position_secret, c_spend.x, c_spend.y, cc.x, cc.y, lock_key, tenor_days);

    main(
        sk, collateral_amount, collateral_randomness, credit_amount, credit_randomness,
        position_secret, c_spend.x, c_spend.y, y.x, y.y, cc.x, cc.y, oracle_price_e7,
        haircut_bps, tenor_days, lock_key, pn,
    );
}

// Sufficiency soundness: a real, owned balance that is too small to cover the
// credit after haircut must fail.
#[test(should_fail)]
fn rejects_insufficient_collateral() {
    let sk: Field = 12345;
    let collateral_amount: u128 = 10; // far too small
    let collateral_randomness: Field = 777;
    let credit_amount: u128 = 100;
    let credit_randomness: Field = 888;
    let position_secret: Field = 999;
    let oracle_price_e7: u128 = 10_000_000;
    let haircut_bps: u32 = 2000;
    let tenor_days: u32 = 3;
    let lock_key: Field = 42;

    let y = scalar_mul(sk, H);
    let c_spend = commit(collateral_amount as Field, collateral_randomness);
    let cc = commit(credit_amount as Field, credit_randomness);
    let pn = nullifier(position_secret, c_spend.x, c_spend.y, cc.x, cc.y, lock_key, tenor_days);

    main(
        sk, collateral_amount, collateral_randomness, credit_amount, credit_randomness,
        position_secret, c_spend.x, c_spend.y, y.x, y.y, cc.x, cc.y, oracle_price_e7,
        haircut_bps, tenor_days, lock_key, pn,
    );
}
