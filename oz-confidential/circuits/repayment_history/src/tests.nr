use stellar_confidential_lib::poseidon_with_domain;
use crate::main;

// Domain tags mirror the constants in main.nr (kept literal here so the test is
// an independent check of the encoding, not a re-use of the same globals).
global D_LEAF: Field = 40;
global D_ROOT: Field = 41;
global D_NULL: Field = 42;

fn leaf(position_id: Field, amount: u128, paid: u32, due: u32, secret: Field) -> Field {
    poseidon_with_domain(D_LEAF, [position_id, amount as Field, paid as Field, due as Field, secret])
}

fn root(position_id: Field, l0: Field, l1: Field, l2: Field) -> Field {
    poseidon_with_domain(D_ROOT, [position_id, l0, l1, l2])
}

fn nullifier(position_id: Field, history_root: Field, threshold: u32, proof_secret: Field) -> Field {
    poseidon_with_domain(D_NULL, [position_id, history_root, threshold as Field, proof_secret])
}

// 2 on-time + 1 late repayment, threshold 2 -> accepted.
#[test]
fn accepts_when_threshold_met() {
    let pid: Field = 7;
    let ps: Field = 1234;
    let th: u32 = 2;

    // on-time (paid <= due), on-time, late.
    let l0 = leaf(pid, 100, 10, 20, 111);
    let l1 = leaf(pid, 200, 15, 20, 222);
    let l2 = leaf(pid, 300, 25, 20, 333);
    let r = root(pid, l0, l1, l2);
    let pn = nullifier(pid, r, th, ps);

    main(pid, 100, 10, 20, 111, 200, 15, 20, 222, 300, 25, 20, 333, ps, r, th, pn);
}

// Only 1 on-time repayment but threshold 2 -> must fail the count check.
#[test(should_fail)]
fn rejects_when_threshold_not_met() {
    let pid: Field = 7;
    let ps: Field = 1234;
    let th: u32 = 2;

    // on-time, late, late -> count = 1 < 2.
    let l0 = leaf(pid, 100, 10, 20, 111);
    let l1 = leaf(pid, 200, 25, 20, 222);
    let l2 = leaf(pid, 300, 30, 20, 333);
    let r = root(pid, l0, l1, l2);
    let pn = nullifier(pid, r, th, ps);

    main(pid, 100, 10, 20, 111, 200, 25, 20, 222, 300, 30, 20, 333, ps, r, th, pn);
}

// A tampered root (does not match the leaves) -> must fail the root binding.
#[test(should_fail)]
fn rejects_forged_root() {
    let pid: Field = 7;
    let ps: Field = 1234;
    let th: u32 = 2;

    let r_bad: Field = 999999;
    let pn = nullifier(pid, r_bad, th, ps);

    main(pid, 100, 10, 20, 111, 200, 15, 20, 222, 300, 25, 20, 333, ps, r_bad, th, pn);
}
