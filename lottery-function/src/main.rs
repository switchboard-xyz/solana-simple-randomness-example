use std::str::FromStr;

pub use switchboard_solana::get_ixn_discriminator;
pub use switchboard_solana::prelude::*;

mod params;
pub use params::*;

pub mod lib;
pub use lib::*;

#[tokio::main(worker_threads = 12)]
async fn main() {
    // First, initialize the runner instance with a freshly generated Gramine keypair
    let runner = FunctionRunner::new_from_cluster(Cluster::Devnet, None).unwrap();

    // parse and validate user provided request params
    let params = ContainerParams::decode(
        &runner
            .function_request_data
            .as_ref()
            .unwrap()
            .container_params,
    )
    .unwrap();

    let lottery = LotteryState::fetch(&runner.client, &params.lottery_key, &params.program_id)
        .await
        .unwrap();

    // Determine the winner
    let winning_index = generate_randomness(0, lottery.tickets.len() as u32 - 1);
    let winner: Pubkey = if lottery.tickets.is_empty() {
        lottery.authority
    } else {
        lottery.tickets.as_slice()[winning_index as usize]
    };

    // IXN DATA:
    // LEN: 40 bytes
    // [0-8]: Anchor Ixn Discriminator
    // [9-40]: Winning Pubkey (32 bytes)
    let mut ixn_data = get_ixn_discriminator("draw_winner").to_vec();
    ixn_data.append(&mut winner.to_bytes().to_vec());

    let request_pubkey = runner.function_request_key.unwrap();

    // ACCOUNTS:
    // 1. Lottery (mut): our user who guessed
    // 2. Escrow (mut):
    // 3. Winner (mut):
    // 4. Switchboard Program
    // 5. Switchboard State
    // 6. Switchboard Function
    // 7. Switchboard Function Request (mut):
    // 8. Enclave Signer (signer): our Gramine generated keypair
    // 9. Switchboard Request Escrow (mut):
    // 10. System Program
    // 11. Token Program
    let draw_winner_ixn = Instruction {
        program_id: params.program_id,
        data: ixn_data,
        accounts: vec![
            AccountMeta::new(params.lottery_key, false),
            AccountMeta::new(lottery.escrow, false),
            AccountMeta::new(winner, false),
            AccountMeta::new_readonly(SWITCHBOARD_ATTESTATION_PROGRAM_ID, false),
            AccountMeta::new_readonly(AttestationProgramState::get_pda(), false),
            AccountMeta::new_readonly(runner.function, false),
            AccountMeta::new(request_pubkey, false),
            AccountMeta::new_readonly(runner.signer, true),
            AccountMeta::new(
                anchor_spl::associated_token::get_associated_token_address(
                    &request_pubkey,
                    &anchor_spl::token::spl_token::native_mint::ID,
                ),
                false,
            ),
            AccountMeta::new_readonly(solana_program::system_program::ID, false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
        ],
    };

    // Then, write your own Rust logic and build a Vec of instructions.
    // Should  be under 700 bytes after serialization
    let ixs: Vec<solana_program::instruction::Instruction> = vec![draw_winner_ixn];

    // Finally, emit the signed quote and partially signed transaction to the functionRunner oracle
    // The functionRunner oracle will use the last outputted word to stdout as the serialized result. This is what gets executed on-chain.
    runner.emit(ixs).await.unwrap();
}

fn generate_randomness(min: u32, max: u32) -> u32 {
    if min == max {
        return min;
    }
    if min > max {
        return generate_randomness(max, min);
    }

    // We add one so its inclusive [min, max]
    let window = (max + 1) - min;

    let mut bytes: [u8; 4] = [0u8; 4];
    Gramine::read_rand(&mut bytes).expect("gramine failed to generate randomness");
    let raw_result: &[u32] = bytemuck::cast_slice(&bytes[..]);

    (raw_result[0] % window) + min
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1. Check when lower_bound is greater than upper_bound
    #[test]
    fn test_generate_randomness_with_flipped_bounds() {
        let min = 100;
        let max = 50;

        let result = generate_randomness(100, 50);
        assert!(result >= max && result < min);
    }

    // 2. Check when lower_bound is equal to upper_bound
    #[test]
    fn test_generate_randomness_with_equal_bounds() {
        let bound = 100;
        assert_eq!(generate_randomness(bound, bound), bound);
    }

    // 3. Test within a range
    #[test]
    fn test_generate_randomness_within_bounds() {
        let min = 100;
        let max = 200;

        let result = generate_randomness(min, max);

        assert!(result >= min && result < max);
    }

    // 4. Test randomness distribution (not truly deterministic, but a sanity check)
    #[test]
    fn test_generate_randomness_distribution() {
        let min = 0;
        let max = 9;

        let mut counts = vec![0; 10];
        for _ in 0..1000 {
            let result = generate_randomness(min, max);
            let index: usize = result as usize;
            counts[index] += 1;
        }

        // Ensure all counts are non-zero (probabilistically should be the case)
        for count in counts.iter() {
            assert!(*count > 0);
        }
    }
}
