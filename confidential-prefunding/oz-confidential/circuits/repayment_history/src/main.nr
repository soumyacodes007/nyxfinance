use stellar_confidential_lib::poseidon_with_domain;

global DOMAIN_REPAYMENT_LEAF: Field = 40;
global DOMAIN_REPAYMENT_ROOT: Field = 41;
global DOMAIN_REPAYMENT_PROOF_NULLIFIER: Field = 42;

fn repayment_leaf(
    position_id: Field,
    repayment_amount: u128,
    paid_ledger: u32,
    due_ledger: u32,
    leaf_secret: Field,
) -> Field {
    poseidon_with_domain(
        DOMAIN_REPAYMENT_LEAF,
        [
            position_id,
            repayment_amount as Field,
            paid_ledger as Field,
            due_ledger as Field,
            leaf_secret,
        ],
    )
}

fn on_time(paid_ledger: u32, due_ledger: u32) -> u32 {
    if paid_ledger <= due_ledger {
        1
    } else {
        0
    }
}

// Public inputs:
// 0 position_id
// 1 history_root
// 2 threshold
// 3 proof_nullifier
//
// This circuit proves a fixed-size private repayment set has at least
// `threshold` on-time positive repayments without revealing amounts or dates.
fn main(
    position_id: pub Field,
    repayment_amount_0: u128,
    paid_ledger_0: u32,
    due_ledger_0: u32,
    leaf_secret_0: Field,
    repayment_amount_1: u128,
    paid_ledger_1: u32,
    due_ledger_1: u32,
    leaf_secret_1: Field,
    repayment_amount_2: u128,
    paid_ledger_2: u32,
    due_ledger_2: u32,
    leaf_secret_2: Field,
    proof_secret: Field,
    history_root: pub Field,
    threshold: pub u32,
    proof_nullifier: pub Field,
) {
    assert(threshold > 0);
    assert(threshold <= 3);
    assert(repayment_amount_0 > 0);
    assert(repayment_amount_1 > 0);
    assert(repayment_amount_2 > 0);

    let leaf_0 = repayment_leaf(
        position_id,
        repayment_amount_0,
        paid_ledger_0,
        due_ledger_0,
        leaf_secret_0,
    );
    let leaf_1 = repayment_leaf(
        position_id,
        repayment_amount_1,
        paid_ledger_1,
        due_ledger_1,
        leaf_secret_1,
    );
    let leaf_2 = repayment_leaf(
        position_id,
        repayment_amount_2,
        paid_ledger_2,
        due_ledger_2,
        leaf_secret_2,
    );

    assert(leaf_0 != leaf_1);
    assert(leaf_0 != leaf_2);
    assert(leaf_1 != leaf_2);

    let derived_root = poseidon_with_domain(
        DOMAIN_REPAYMENT_ROOT,
        [position_id, leaf_0, leaf_1, leaf_2],
    );
    assert(derived_root == history_root);

    let count = on_time(paid_ledger_0, due_ledger_0)
        + on_time(paid_ledger_1, due_ledger_1)
        + on_time(paid_ledger_2, due_ledger_2);
    assert(count >= threshold);

    let derived_nullifier = poseidon_with_domain(
        DOMAIN_REPAYMENT_PROOF_NULLIFIER,
        [position_id, history_root, threshold as Field, proof_secret],
    );
    assert(derived_nullifier == proof_nullifier);
}
